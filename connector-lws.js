/**
 * connector-lws.js — plugs a DebuggerServerAdapter into qjs-lws.
 *
 * qjs-lws (lws.so / lws/context.js) dispatches per-protocol callbacks as
 * named methods on the protocol descriptor (onEstablished, onReceive,
 * onClosed, ...), not the classic numeric-reason `callback(wsi, reason,
 * user, buf)` switch — this connector produces one such descriptor:
 *
 *     import { createContext } from 'lws/context.js';
 *     import { LWSMPRO_NO_MOUNT } from 'lws.so';
 *     import { DebuggerServerAdapter } from './server-adapter.js';
 *     import { LWSConnector } from './connector-lws.js';
 *
 *     const adapter = new DebuggerServerAdapter();
 *
 *     const ctx = createContext({
 *       port: 8998,
 *       mounts: [{ mountpoint: '/ws', protocol: 'debugger', originProtocol: LWSMPRO_NO_MOUNT }],
 *       protocols: [{ name: 'debugger', ...LWSConnector(adapter) }],
 *     });
 *
 * Same contract as the qjs-net connector: wraps each wsi into a ClientPort,
 * shovels messages, knows nothing about the debug protocol itself. Two wire
 * encodings, picked with `{ raw }`:
 *
 *   - raw: false (default) — one JSON document per WS frame, no length
 *     framing (WS's own frame boundary replaces it). Frames may arrive
 *     fragmented (WS_WRITE with the FIN bit deferred, or plain TCP
 *     coalescing under lws); partial text is buffered until it parses.
 *   - raw: true — the exact quickjs-debugger wire framing (see codec.js:
 *     `%08x\n<json>\n`) carried unmodified inside WS frames, for clients
 *     that want to speak the engine's native protocol instead of a
 *     WS-per-message convention. Multiple raw frames may share one WS
 *     message or split across several; FrameDecoder handles both.
 *
 * Both encodings talk to the very same DebuggerServerAdapter (and thus the
 * very same, single, shared engine connection) through the identical
 * ClientPort/clientMessage() contract — only the bytes-on-the-wire differ.
 *
 * One protocol per LWSContext: this build's mount -> protocol dispatch
 * always resolves to protocols[0] regardless of which mountpoint matched,
 * so serving both encodings means two contexts (two ports), each with a
 * single protocol entry — see qjs-debugger.js's `server` mode.
 */

import { TextDecoder, TextEncoder } from 'textcode';
import { LWS_WRITE_TEXT } from 'lws.so';
import { frameMessage, FrameDecoder } from './codec.js';

const encoder = new TextEncoder();

export function LWSConnector(adapterOrFactory, { name = 'debugger', raw = false } = {}) {
  const ports = new WeakMap(); /* wsi -> { port, adapter, detach, ...decoder state } */
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
          wsi.write(raw ? frameMessage(json, encoder.encode(json).length) : json, LWS_WRITE_TEXT);
        },
        close: () => wsi.close?.(),
      };

      const entry = { port, adapter, detach: adapter.attachClient(port), partial: '' };
      if(raw)
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

      if(raw) {
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
  };
}

//export default LWSConnector;
