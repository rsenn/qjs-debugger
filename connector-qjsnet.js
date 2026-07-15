/**
 * connector-qjsnet.js — plugs a DebuggerServerAdapter into qjs-net.
 *
 * qjs-net's createServer() takes { onConnect, onMessage, onClose, onError }
 * callbacks; this connector produces exactly that object, so usage is:
 *
 *     import { createServer } from 'net';
 *     import { DebuggerServerAdapter } from './server-adapter.js';
 *     import { QjsNetConnector } from './connector-qjsnet.js';
 *
 *     const adapter = new DebuggerServerAdapter();
 *
 *     createServer(`wss://0.0.0.0:8998/ws`, {
 *       mounts: [['/', '.', 'debugger.html']],
 *       ...QjsNetConnector(adapter),
 *     });
 *
 * The connector knows nothing about the debug protocol; it only wraps each
 * qjs-net ws handle into a ClientPort and shovels JSON in/out. Pass a
 * factory function instead of an adapter to get one adapter per connection
 * (one debuggee per browser tab).
 */

export function QjsNetConnector(adapterOrFactory, { onConnect, onMessage, onClose, onError } = {}) {
  const ports = new WeakMap(); /* ws -> { port, adapter, detach } */
  const adapterFor = typeof adapterOrFactory == 'function' ? adapterOrFactory : () => adapterOrFactory;

  return {
    onConnect(ws, req) {
      const adapter = adapterFor(ws, req);

      const port = {
        sendMessage: msg => ws.send(JSON.stringify(msg)),
        close: () => ws.close?.(),
      };

      ports.set(ws, { port, adapter, detach: adapter.attachClient(port) });
      onConnect?.(ws, req);
    },

    onMessage(ws, data) {
      const entry = ports.get(ws);
      if(!entry) return;

      let msg;
      try {
        msg = JSON.parse(data);
      } catch(e) {
        entry.port.sendMessage({
          type: 'error',
          message: `bad JSON: ${e.message}`,
        });
        return;
      }

      entry.adapter.clientMessage(entry.port, msg).catch(error => entry.port.sendMessage({ type: 'error', message: error.message }));
      onMessage?.(ws, data, msg);
    },

    onClose(ws, status) {
      const entry = ports.get(ws);
      if(entry) {
        entry.detach();
        ports.delete(ws);
      }
      onClose?.(ws, status);
    },

    onError(ws, error) {
      const entry = ports.get(ws);
      if(entry) {
        entry.detach();
        ports.delete(ws);
      }
      onError?.(ws, error);
    },
  };
}

//export default QjsNetConnector;
