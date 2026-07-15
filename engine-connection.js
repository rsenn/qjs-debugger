/**
 * engine-connection.js — the localhost socket to the QuickJS interpreter.
 *
 * QuickJS-side module (imports 'sockets', 'textcode', 'child_process').
 * Owns exactly one concern: moving framed protocol messages between a TCP
 * socket and JS objects. It does not interpret them — plug a DebugSession
 * (or the server adapter) on top with attachSession()/onmessage.
 *
 * Interface exposed upward (duck type "MessagePort"):
 *     sendMessage(obj)        — frame + transmit one message
 *     onmessage = (obj) => {} — assigned by the owner
 *     onclose   = ()    => {}
 *     close()
 */

import { spawn } from 'child_process';
import { setTimeout } from 'os';
import { AF_INET, AsyncSocket, IPPROTO_TCP, SOCK_STREAM, SockAddr } from 'sockets';
import { TextDecoder, TextEncoder } from 'textcode';
import { FrameDecoder, frameMessage } from './codec.js';
import { DebugSession } from './session.js';

export class EngineConnection {
  #sock = null;
  #decoder;
  #encoder = new TextEncoder();
  #closed = false;

  onmessage = null;
  onclose = null;
  onerror = err => console.log('EngineConnection error:', err.message);

  constructor() {
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
  }

  /** Connect to a 'host:port' address where the engine listens (QUICKJS_DEBUG_LISTEN_ADDRESS). */
  static async connect(address, { retries = 20, delay = 100 } = {}) {
    const conn = new EngineConnection();
    const [host, port] = address.split(':');
    const addr = new SockAddr(AF_INET, host, +port);

    /* the engine needs a moment after spawn before it listens; retry.
       AsyncSocket.connect() resolves with undefined on success and
       rejects (SyscallError) on failure, e.g. ECONNREFUSED. */
    for(let attempt = 0; ; attempt++) {
      const sock = new AsyncSocket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
      let ret;

      try {
        ret = await sock.connect(addr);
      } catch(e) {
        ret = -1;
      }

      if(ret === undefined || ret >= 0) {
        conn.#sock = sock;
        conn.#readLoop();
        return conn;
      }

      sock.close();
      if(attempt >= retries) throw new Error(`EngineConnection: cannot connect to ${address} after ${attempt + 1} attempts`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  static async accept(address) {
    const conn = new EngineConnection();
    const [host, port] = address.split(':');
    const addr = new SockAddr(AF_INET, host, +port);
    const remote = new SockAddr(AF_INET);

    const sock = new AsyncSocket(AF_INET, SOCK_STREAM, IPPROTO_TCP);

    sock.bind(addr);
    sock.listen(5);
    let ret;

    try {
      ret = await sock.accept(remote);
    } catch(e) {
      ret = -1;
    }
    console.log('accepted', ret);

  sock.close();

    if(ret != -1) {
      conn.#sock = ret;
      conn.#readLoop();
      return conn;
    }

    sock.close();
    throw new Error(`EngineConnection: cannot accept at ${address}`);
  }

  async #readLoop() {
    const sock = this.#sock;
    const buf = new ArrayBuffer(65536);

    try {
      for(;;) {
        const r = await sock.recv(buf);
        if(r <= 0) break;
        this.#decoder.push(new Uint8Array(buf, 0, r));
      }
    } catch(err) {
      if(!this.#closed) this.onerror?.(err);
    } finally {
      this.close();
    }
  }

  sendMessage(msg) {
    if(!this.#sock) throw new Error('EngineConnection: not connected');
    const json = typeof msg == 'string' ? msg : JSON.stringify(msg);
    const byteLength = this.#encoder.encode(json).length;
    return this.#sock.send(frameMessage(json, byteLength));
  }

  close() {
    if(this.#closed) return;
    this.#closed = true;
    try {
      this.#sock?.close();
    } catch(e) {}
    this.#sock = null;
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
export function StartEngine(args, address = '127.0.0.1:9901', { listen = true, interpreter = 'qjsm', env = {}, spawn: doSpawn = spawn } = {}) {
  const childEnv = { ...env };
  childEnv[listen ? 'QUICKJS_DEBUG_LISTEN_ADDRESS' : 'QUICKJS_DEBUG_ADDRESS'] = address;

  const child = doSpawn(interpreter, args, {
    env: childEnv,
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

  const connection = EngineConnection.accept(address);
  const engine = StartEngine(args, address, options);
  const session = (await connection).attachSession(options);
  return { ...engine, connection, session };
}

//export default EngineConnection;
