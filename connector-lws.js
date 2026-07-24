/**
 * connector-lws.js — plugs a DebuggerServerAdapter (and a raw engine
 * connection) into qjs-lws.
 *
 * qjs-lws (lws.so) dispatches per-protocol callbacks as named methods on
 * the protocol descriptor (onEstablished, onReceive, onClosed, onRawAdopt,
 * ...), not the classic numeric-reason `callback(wsi, reason, user, buf)`
 * switch. Two connectors live here:
 *
 *   LWSConnector(adapter, { mode })
 *     A WS protocol descriptor: wraps each wsi into a ClientPort, shovels
 *     messages, knows nothing about the debug protocol itself.
 *
 *         import { createServer } from 'lws.so';
 *         import { DebuggerServerAdapter } from './server-adapter.js';
 *         import { LWSConnector } from './connector-lws.js';
 *
 *         const adapter = new DebuggerServerAdapter();
 *
 *         createServer({
 *           port: 8998,
 *           mounts: [{ mountpoint: '/', protocol: 'debugger', originProtocol: LWSMPRO_NO_MOUNT }],
 *           protocols: [{ name: 'debugger', ...LWSConnector(adapter) }],
 *         });
 *
 *     Three wire encodings, picked with `mode`:
 *       'json'    (default) — one JSON document per WS frame both ways, no
 *                  length framing (WS's own frame boundary replaces it).
 *                  Frames may arrive fragmented; partial text is buffered
 *                  until it parses.
 *       'raw'     — the exact quickjs-debugger wire framing (see codec.js:
 *                  `%08x\n<json>\n`) carried unmodified inside WS frames
 *                  both ways, for clients that speak the engine's native
 *                  protocol instead of a WS-per-message convention.
 *       'browser' — asymmetric: bare JSON in (client -> server), the same
 *                  length-prefixed framing as 'raw' out (server -> client).
 *                  Matches qjs-lws's examples/debugger/demo.js verbatim —
 *                  large outgoing frames (a big variable listing) can
 *                  otherwise land as several separate WS messages, so
 *                  demo.js reassembles them the same way the raw TCP side
 *                  is framed rather than trusting WS message boundaries;
 *                  small client->server commands don't need that.
 *     All three talk to the very same DebuggerServerAdapter (and thus the
 *     very same, single, shared engine connection) through the identical
 *     ClientPort/clientMessage() contract — only the bytes-on-the-wire
 *     differ. The returned descriptor also exposes broadcastBinary(bytes)
 *     to push a raw binary WS message (e.g. a debuggee output channel) to
 *     every currently-attached wsi, bypassing the adapter entirely.
 *
 *   LWSEngineConnector({ onConnect })
 *     A RAW-role protocol descriptor (onRawAdopt/onRawRx/onRawClose) for
 *     accepting the debug target's own TCP connection on an lws-managed
 *     listener instead of a qjs-modules Socket — the "listen-fallback"
 *     mount: LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG lets
 *     one port serve HTTP/WS *and* accept a raw, non-HTTP connection (the
 *     debug target arming itself with QUICKJS_DEBUG_ADDRESS) by sniffing
 *     whether the first bytes look like an HTTP request line. onConnect
 *     receives an EngineConnection-compatible object (sendMessage/
 *     onmessage/onclose/close) ready for DebuggerServerAdapter.attachEngine().
 *
 * Several mounted protocols on one LWSContext (http static files, a
 * callback endpoint, several WS protocols, ...) all dispatch correctly by
 * mountpoint, including with other LWSContexts already running in the same
 * process — *except* WS upgrades from a client that sends no
 * Sec-WebSocket-Protocol header at all: libwebsockets binds those to
 * `vhost->default_protocol_index` (protocols[0]) unconditionally, per
 * RFC 6455 §4.2.2's "the server MAY select one of th[e] [client-offered]
 * subprotocols" — with none offered, mount data is never consulted (see
 * libwebsockets' lws_process_ws_upgrade(), the `!ts.len` branch). So every
 * WS connector here needs its client to request the matching protocol
 * name explicitly (`new WebSocket(url, name)`) whenever it shares a
 * context with other protocols; qjs-lws's own examples/debugger/demo.js
 * already does this (`new WebSocket(url, 'browser')`), so
 * qjs-debugger.js's `server` mode does the same for its own WS protocols.
 */

import { TextDecoder, TextEncoder } from 'textcode';
import { LWS_WRITE_BINARY, LWS_WRITE_TEXT } from 'lws.so';
import { frameMessage, FrameDecoder } from './codec.js';

const encoder = new TextEncoder();

export function LWSConnector(adapterOrFactory, { name = 'debugger', mode = 'json' } = {}) {
  const incomingFramed = mode == 'raw';
  const outgoingFramed = mode == 'raw' || mode == 'browser';

  const ports = new Map(); /* wsi -> { port, adapter, detach, ...decoder state } */
  const adapterFor = typeof adapterOrFactory == 'function' ? adapterOrFactory : () => adapterOrFactory;

  function deliver(entry, msg) {
    entry.adapter.clientMessage(entry.port, msg).catch(error => entry.port.sendMessage({ type: 'error', message: error.message }));
  }

  /* text mode: reassemble fragmented WS frames by accumulating until the
     JSON parses (cheap and dependency-free) */
  function handleText(entry, text) {
    const data = entry.partial + text;
    let msg;

    try {
      msg = JSON.parse(data);
    } catch(e) {
      entry.partial = data;
      if(entry.partial.length > 1 << 22) {
        entry.partial = '';
        entry.port.sendMessage({ type: 'error', message: 'oversized/unparseable message dropped' });
      }
      return;
    }

    entry.partial = '';
    deliver(entry, msg);
  }

  return {
    name,

    onEstablished(wsi) {
      const adapter = adapterFor(wsi);

      const port = {
        sendMessage: msg => {
          const json = JSON.stringify(msg);
          wsi.write(outgoingFramed ? frameMessage(json, encoder.encode(json).length) : json, LWS_WRITE_TEXT);
        },
        close: () => wsi.close?.(),
      };

      const entry = { port, adapter, detach: adapter.attachClient(port), partial: '' };
      if(incomingFramed)
        entry.decoder = new FrameDecoder({
          /* codec.js is environment-free: it doesn't assume a global
             TextDecoder (QuickJS has none — only 'textcode' does) */
          decodeText: bytes => new TextDecoder().decode(bytes),
          onFrame: json => {
            let msg;
            try {
              msg = JSON.parse(json);
            } catch(e) {
              entry.port.sendMessage({ type: 'error', message: `bad JSON: ${e.message}` });
              return;
            }
            deliver(entry, msg);
          },
        });

      ports.set(wsi, entry);
    },

    onReceive(wsi, data) {
      const entry = ports.get(wsi);
      if(!entry) return;

      if(incomingFramed) {
        entry.decoder.push(typeof data == 'string' ? encoder.encode(data) : data);
        return;
      }

      handleText(entry, typeof data == 'string' ? data : new TextDecoder().decode(data));
    },

    onClosed(wsi) {
      const entry = ports.get(wsi);
      if(entry) {
        entry.detach();
        ports.delete(wsi);
      }
    },

    /** Push a raw binary WS message to every currently-attached client. */
    broadcastBinary(bytes) {
      for(const wsi of ports.keys())
        try {
          wsi.write(bytes, LWS_WRITE_BINARY);
        } catch(e) {}
    },
  };
}

/**
 * @param onConnect  (connection) => void — connection is EngineConnection-
 *                   compatible: { sendMessage(obj), onmessage, onclose, close() }
 */
export function LWSEngineConnector({ name = 'engine', onConnect } = {}) {
  const connections = new Map(); /* wsi -> connection */

  return {
    name,

    onRawAdopt(wsi) {
      const connection = {
        sendMessage(msg) {
          const json = JSON.stringify(msg);
          wsi.write(frameMessage(json, encoder.encode(json).length));
        },
        onmessage: null,
        onclose: null,
        close: () => wsi.close?.(),
      };

      const decoder = new FrameDecoder({
        decodeText: bytes => new TextDecoder().decode(bytes),
        onFrame: json => {
          let msg;
          try {
            msg = JSON.parse(json);
          } catch(e) {
            return;
          }
          connection.onmessage?.(msg);
        },
      });

      connections.set(wsi, { connection, decoder });
      onConnect?.(connection);
    },

    onRawRx(wsi, data) {
      connections.get(wsi)?.decoder.push(typeof data == 'string' ? encoder.encode(data) : data);
    },

    onRawClose(wsi) {
      const entry = connections.get(wsi);
      if(entry) {
        connections.delete(wsi);
        entry.connection.onclose?.();
      }
    },
  };
}

//export default LWSConnector;
