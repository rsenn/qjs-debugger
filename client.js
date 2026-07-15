/**
 * client.js — DebuggerClient: a DebugSession over any WebSocket-shaped thing.
 *
 * Environment-free (no DOM, no qjs-modules imports), so the same file is
 * loaded by the browser UI and by a QuickJS REPL. The decoupling contract
 * is a minimal "Transport" duck type:
 *
 *     transport.send(text)            — transmit one text frame
 *     transport.close?()
 *     events: delivered EITHER via addEventListener('message'/'close'/'error')
 *             OR via assignable onmessage/onclose/onerror
 *
 * Satisfied out of the box by:
 *   - browser WebSocket
 *   - qjs-net client WebSocket / ReconnectingWebSocket (lib/async/websocket.js)
 *   - anything you hand-roll over qjs-lws client connections
 *
 * Wire format on this leg is one JSON document per WS text frame (the
 * server adapter speaks the same); the length-prefixed framing exists only
 * on the engine<->server TCP leg. For a REPL that wants to skip the server
 * and attach straight to the engine's TCP debug port, use
 * EngineConnection.connect(address).attachSession() instead — same
 * DebugSession API, different transport.
 */

import { DebugSession } from './session.js';

export class DebuggerClient extends DebugSession {
  #transport;

  constructor(transport, options = {}) {
    super(msg => transport.send(JSON.stringify(msg)), options);
    this.#transport = transport;

    const onMessage = data => {
      const text = typeof data == 'string' ? data : (data?.data ?? data); /* Event.data vs raw */
      let msg;
      try {
        msg = JSON.parse(typeof text == 'string' ? text : new TextDecoder().decode(text));
      } catch(e) {
        this.emit('protocol-error', new Error(`bad JSON from server: ${e.message}`));
        return;
      }
      this.dispatch(msg);
    };

    const onClose = () => (this.abort('transport closed'), this.emit('close'));
    const onError = err => this.emit('error', err);

    if(typeof transport.addEventListener == 'function') {
      transport.addEventListener('message', onMessage);
      transport.addEventListener('close', onClose);
      transport.addEventListener('error', onError);
    } else {
      transport.onmessage = onMessage;
      transport.onclose = onClose;
      transport.onerror = onError;
    }
  }

  get transport() {
    return this.#transport;
  }

  close() {
    this.#transport.close?.();
  }

  /* ---- server lifecycle commands (handled by DebuggerServerAdapter) ---- */

  start(args, address) {
    return this.sendMessage({ command: 'start', args, address });
  }

  connectEngine(address) {
    return this.sendMessage({ command: 'connect', address });
  }

  /**
   * Connect a WebSocket and resolve with a ready DebuggerClient.
   * Inject the WebSocket implementation for QuickJS:
   *
   *     // browser:
   *     const client = await DebuggerClient.connect('wss://localhost:8998/ws');
   *
   *     // quickjs REPL:
   *     import { WebSocketClient } from './lib/async/websocket.js';
   *     const client = await DebuggerClient.connect(url, { WebSocket: WebSocketClient });
   */
  static connect(url, { WebSocket: WS = globalThis.WebSocket, ...options } = {}) {
    if(!WS) throw new Error('DebuggerClient.connect: no WebSocket implementation (pass options.WebSocket)');

    return new Promise((resolve, reject) => {
      const ws = new WS(url);
      const client = new DebuggerClient(ws, options);

      const onOpen = () => resolve(client);
      const onFail = err => reject(err instanceof Error ? err : new Error(`DebuggerClient: connect to ${url} failed`));

      if(typeof ws.addEventListener == 'function') {
        ws.addEventListener('open', onOpen);
        ws.addEventListener('error', onFail, { once: true });
      } else if('onopen' in ws) {
        ws.onopen = onOpen;
      } else {
        /* transports that are usable immediately (already-open sockets) */
        resolve(client);
      }
    });
  }
}

Object.assign(DebuggerClient.prototype, {
  [Symbol.toStringTag]: 'DebuggerClient',
});

//export default DebuggerClient;
