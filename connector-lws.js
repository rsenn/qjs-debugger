/**
 * connector-lws.js — plugs a DebuggerServerAdapter into qjs-lws.
 *
 * qjs-lws takes a protocols array of { name, callback(wsi, reason, user, buf) }
 * entries; this connector produces one such entry:
 *
 *     import { LWSContext } from 'lws.so';
 *     import { DebuggerServerAdapter } from './server-adapter.js';
 *     import { LWSConnector } from './connector-lws.js';
 *
 *     const adapter = new DebuggerServerAdapter();
 *
 *     const ctx = new LWSContext({
 *       port: 8998,
 *       vhostName: 'localhost',
 *       protocols: [LWSConnector(adapter, { name: 'debugger' })],
 *     });
 *
 * Same contract as the qjs-net connector: wraps each wsi into a ClientPort,
 * shovels JSON, knows nothing about the protocol. WS text frames may be
 * fragmented by libwebsockets, so partial frames are buffered per-wsi until
 * the JSON parses (cheap and dependency-free; if your build exposes
 * lws_is_final_fragment, pass `isFinal(wsi)` to use it instead).
 */

import { TextDecoder } from 'textcode';

/* default LWS_CALLBACK_* values; override via options if your build differs */
const DEFAULT_REASONS = {
  ESTABLISHED: 0,
  CLOSED: 1,
  RECEIVE: 6,
};

export function LWSConnector(adapterOrFactory, { name = 'debugger', reasons = DEFAULT_REASONS, isFinal } = {}) {
  const ports = new Map(); /* wsi -> { port, adapter, detach, partial } */
  const adapterFor = typeof adapterOrFactory == 'function' ? adapterOrFactory : () => adapterOrFactory;

  function handleText(entry, text) {
    /* reassemble fragmented frames: accumulate until JSON parses */
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
    entry.adapter.clientMessage(entry.port, msg).catch(error => entry.port.sendMessage({ type: 'error', message: error.message }));
  }

  return {
    name,

    callback(wsi, reason, user, buf) {
      switch (reason) {
        case reasons.ESTABLISHED: {
          const adapter = adapterFor(wsi);

          const port = {
            sendMessage: msg => wsi.write(JSON.stringify(msg)),
            close: () => wsi.close?.(),
          };

          ports.set(wsi, { port, adapter, detach: adapter.attachClient(port), partial: '' });
          break;
        }

        case reasons.RECEIVE: {
          const entry = ports.get(wsi);
          if(!entry) break;

          const text = typeof buf == 'string' ? buf : new TextDecoder().decode(buf);

          if(typeof isFinal == 'function' && !isFinal(wsi)) {
            entry.partial += text;
            break;
          }

          handleText(entry, text);
          break;
        }

        case reasons.CLOSED: {
          const entry = ports.get(wsi);
          if(entry) {
            entry.detach();
            ports.delete(wsi);
          }
          break;
        }
      }
    },
  };
}

//export default LWSConnector;
