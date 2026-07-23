/**
 * engine-connection.js — framed protocol messages to/from the QuickJS interpreter.
 *
 * Transport-agnostic: the byte transport is injected (see transport.js for
 * the duck type and the two bundled implementations). Owns exactly one
 * concern: moving framed protocol messages between a transport and JS
 * objects. It does not interpret them — plug a DebugSession (or the server
 * adapter) on top with attachSession()/onmessage.
 *
 * Interface exposed upward (duck type "MessagePort"):
 *     sendMessage(obj)        — frame + transmit one message
 *     onmessage = (obj) => {} — assigned by the owner
 *     onclose   = ()    => {}
 *     close()
 */

import { spawn } from 'child_process';
import { TextDecoder, TextEncoder } from 'textcode';
import { FrameDecoder, frameMessage } from './codec.js';
import { DebugSession } from './session.js';
import { SocketTransport } from './transport.js';

export class EngineConnection {
  #transport = null;
  #decoder;
  #encoder = new TextEncoder();
  #closed = false;

  onmessage = null;
  onclose = null;
  onerror = err => console.log('EngineConnection error:', err.message);

  /** @param transport  a connected transport (see transport.js duck type) */
  constructor(transport) {
    this.#decoder = new FrameDecoder({
      decodeText: bytes => new TextDecoder().decode(bytes),
      onFrame: json => {
        let obj;
        try {
          obj = JSON.parse(json);
        } catch(e) {
          this.onerror?.(new Error(`bad JSON from engine: ${e.message}`));
          return;
        }
        this.onmessage?.(obj);
      },
    });

    if(transport) {
      this.#transport = transport;
      this.#readLoop();
    }
  }

  /** Connect to a 'host:port' address where the engine listens (QUICKJS_DEBUG_LISTEN_ADDRESS). */
  static async connect(address, { transport: Transport = SocketTransport, ...options } = {}) {
    return new EngineConnection(await Transport.connect(address, options));
  }

  /** Listen on 'host:port' for an engine connecting out (QUICKJS_DEBUG_ADDRESS). */
  static async accept(address, { transport: Transport = SocketTransport, ...options } = {}) {
    return new EngineConnection(await Transport.accept(address, options));
  }

  async #readLoop() {
    try {
      for await(const chunk of this.#transport) this.#decoder.push(chunk);
    } catch(err) {
      if(!this.#closed) this.onerror?.(err);
    } finally {
      this.close();
    }
  }

  /* transports may permit only one in-flight send (AsyncSocket:
     "Already a pending write"); chain sends so back-to-back messages
     don't throw */
  #sendq = Promise.resolve();

  sendMessage(msg) {
    if(!this.#transport) throw new Error('EngineConnection: not connected');
    const json = typeof msg == 'string' ? msg : JSON.stringify(msg);
    const byteLength = this.#encoder.encode(json).length;
    const frame = frameMessage(json, byteLength);
    const sent = this.#sendq.then(() => {
      if(!this.#transport) throw new Error('EngineConnection: closed');
      return this.#transport.send(frame);
    });
    this.#sendq = sent.catch(() => {});
    return sent;
  }

  close() {
    if(this.#closed) return;
    this.#closed = true;
    try {
      this.#transport?.close();
    } catch(e) {}
    this.#transport = null;
    this.onclose?.();
  }

  /** Convenience: bind a DebugSession to this connection. */
  attachSession(options) {
    const session = new DebugSession(msg => this.sendMessage(msg), options);
    this.onmessage = msg => session.dispatch(msg);
    const prevClose = this.onclose;
    this.onclose = () => (session.abort('engine connection closed'), prevClose?.());
    return session;
  }
}

/**
 * Spawn a QuickJS interpreter with the debugger armed.
 * listen=true  → engine listens on `address` (QUICKJS_DEBUG_LISTEN_ADDRESS), we connect to it
 * listen=false → engine connects out to `address` (QUICKJS_DEBUG_ADDRESS)
 *
 * The spawn function is injectable for environments where 'child_process'
 * spawn signatures differ — pass options.spawn(file, args, opts).
 */
export function StartEngine(args, address = '127.0.0.1:9901', { listen = true, interpreter = 'qjsm', env = {}, cwd, spawn: doSpawn = spawn } = {}) {
  const childEnv = { ...env };
  childEnv[listen ? 'QUICKJS_DEBUG_LISTEN_ADDRESS' : 'QUICKJS_DEBUG_ADDRESS'] = address;

  const child = doSpawn(interpreter, args, {
    env: childEnv,
    cwd,
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  return { child, address, args };
}

/** One-call helper: spawn engine + connect + attach a session. */
export async function LaunchEngineSession(args, address, options = {}) {
  if(options.listen !== false) {
    const engine = StartEngine(args, address, options);
    const connection = await EngineConnection.connect(engine.address, options);
    const session = connection.attachSession(options);
    return { ...engine, connection, session };
  }

  let engine;
  const connection = await EngineConnection.accept(address, {
    ...options,
    listening: () => (engine = StartEngine(args, address, options)),
  });
  const session = connection.attachSession(options);
  return { ...engine, connection, session };
}

//export default EngineConnection;
