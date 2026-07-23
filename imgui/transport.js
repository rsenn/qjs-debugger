/* transport.js — byte/message movers for debugger-client.js.
 *
 * A transport is ANY object with this duck-typed interface:
 *
 *   connected            boolean
 *   send(obj)            serialize + transmit one protocol object
 *   pump()    -> obj[]   non-blocking poll; complete protocol objects received
 *   close()
 *   info()    -> object  key/value pairs for the connection-info panel
 *
 * Implementations:
 *   TcpServerTransport — listens, accepts the debuggee (QUICKJS_DEBUG_ADDRESS=host:port),
 *                        default codec: LengthPrefixedJsonCodec
 *   TcpClientTransport — connects to a waiting debuggee
 *   WebSocketTransport — message-oriented adapter for qjs-lws / qjs-net; this module
 *                        imports neither. Default codec: JsonMessageCodec (no prefix).
 *
 * Built on the Socket/SockAddr classes of qjs-modules' quickjs-sockets.c:
 *
 *   - Sockets stay BLOCKING. recv()/send()/accept() on a nonblocking plain Socket
 *     throw the "wait assert" InternalError (nonblocking I/O is AsyncSocket's
 *     promise-based job, which doesn't fit a per-frame ImGui pump). Instead,
 *     readiness is checked with select(nfds, fds, [], [], 0): a zero timeout and
 *     an fd array that the binding rewrites in place with the ready descriptors.
 *   - accept(sockaddr) requires a SockAddr out-argument and returns the accepted
 *     connection as a new Socket (the peer address lands in the SockAddr).
 *   - recv(arrayBuffer) returns the byte count, 0 on EOF, and throws SyscallError
 *     on hard errors. send(data[, offset]) accepts strings or buffers.
 *   - setsockopt(level, optname, value) wants the value as an array ([1]) or a
 *     buffer — a bare number degrades to 0.
 *   - socket.local / socket.remote return SockAddrs (getsockname/getpeername).
 */

import { Socket, SockAddr, select, AF_INET, SOCK_STREAM, SOL_SOCKET, SO_REUSEADDR } from 'sockets';
import { TextEncoder } from 'textcode';
import { LengthPrefixedJsonCodec, JsonMessageCodec } from './wire-codec.js';

const RECV_CHUNK = 65536;
const utf8 = new TextEncoder();

/* select()-based readiness: returns the subset of fds that are readable now.
 * The binding rewrites the array in place with the ready descriptors. */
function readable(fds) {
  if(fds.length == 0) return [];
  const rfds = [...fds];
  try {
    if(select(Math.max(...fds) + 1, rfds, [], [], 0) <= 0) return [];
  } catch(e) {
    return []; /* EINTR and friends — just try again next frame */
  }
  return rfds;
}

function addrString(sa) {
  try {
    if(sa) return `${sa.addr}:${sa.port}`;
  } catch(e) {}
  return null;
}

class TcpTransportBase {
  codec;
  sock = null; /* connected Socket instance */
  connected = false;
  stats = { bytesIn: 0, bytesOut: 0, msgsIn: 0, msgsOut: 0 };
  onstatechange = null;

  constructor(codec) {
    this.codec = codec ?? new LengthPrefixedJsonCodec();
  }

  send(obj) {
    if(!this.connected) return false;

    const bytes = utf8.encode(this.codec.encode(obj));

    for(let off = 0; off < bytes.length; ) {
      let n;
      try {
        n = this.sock.send(bytes, off);
      } catch(e) {
        this.drop();
        return false;
      }
      if(typeof n != 'number' || n <= 0) {
        this.drop();
        return false;
      }
      off += n;
      this.stats.bytesOut += n;
    }

    this.stats.msgsOut++;
    return true;
  }

  drain() {
    const out = [];

    while(this.connected && readable([this.sock.fd]).length) {
      const ab = new ArrayBuffer(RECV_CHUNK);
      let r;

      try {
        r = this.sock.recv(ab);
      } catch(e) {
        r = 0; /* SyscallError (ECONNRESET, …) — treat as EOF */
      }

      if(typeof r != 'number' || r <= 0) {
        this.drop();
        break;
      }

      this.stats.bytesIn += r;

      for(const msg of this.codec.feed(new Uint8Array(ab, 0, r))) {
        this.stats.msgsIn++;
        out.push(msg);
      }
    }

    return out;
  }

  drop() {
    if(this.sock) {
      try {
        this.sock.close();
      } catch(e) {}
      this.sock = null;
    }
    if(this.connected) {
      this.connected = false;
      this.codec.reset();
      if(this.onstatechange) this.onstatechange(this);
    }
  }

  close() {
    this.drop();
  }

  get fdString() {
    try {
      return this.sock ? String(this.sock.fd) : '-';
    } catch(e) {
      return '-';
    }
  }
}

export class TcpServerTransport extends TcpTransportBase {
  host;
  port;
  #listen = null; /* listening Socket */
  peer = null;

  constructor({ host = '127.0.0.1', port = 6499, codec } = {}) {
    super(codec);
    this.host = host;
    this.port = port;
  }

  get address() {
    return `${this.host}:${this.port}`;
  }

  listen() {
    const sock = new Socket(AF_INET, SOCK_STREAM);
    try {
      sock.setsockopt(SOL_SOCKET, SO_REUSEADDR, [1]); /* value must be array/buffer */
    } catch(e) {}
    sock.bind(new SockAddr(AF_INET, this.host, this.port));
    sock.listen(1);
    this.#listen = sock;
    return this;
  }

  #tryAccept() {
    if(!this.#listen || this.connected) return;
    if(!readable([this.#listen.fd]).length) return;

    const peerAddr = new SockAddr(AF_INET);
    let conn;
    try {
      conn = this.#listen.accept(peerAddr); /* SockAddr out-arg, returns new Socket */
    } catch(e) {
      return;
    }
    if(!(conn instanceof Socket) && typeof conn?.recv != 'function') return;

    this.sock = conn;
    this.connected = true;
    this.peer = addrString(peerAddr) ?? addrString(conn.remote) ?? 'connected';
    if(this.onstatechange) this.onstatechange(this);
  }

  pump() {
    this.#tryAccept();
    return this.drain();
  }

  close() {
    super.close();
    if(this.#listen) {
      try {
        this.#listen.close();
      } catch(e) {}
      this.#listen = null;
    }
  }

  info() {
    return {
      transport: 'TCP server',
      codec: this.codec.name,
      listen: this.address,
      state: this.connected ? 'connected' : this.#listen ? 'listening' : 'closed',
      peer: this.connected ? this.peer : '-',
      fd: this.connected ? this.fdString : '-',
      'bytes rx/tx': `${this.stats.bytesIn} / ${this.stats.bytesOut}`,
      'msgs rx/tx': `${this.stats.msgsIn} / ${this.stats.msgsOut}`,
    };
  }
}

export class TcpClientTransport extends TcpTransportBase {
  host;
  port;

  constructor({ host = '127.0.0.1', port = 6499, codec } = {}) {
    super(codec);
    this.host = host;
    this.port = port;
  }

  connect() {
    const sock = new Socket(AF_INET, SOCK_STREAM);
    sock.connect(new SockAddr(AF_INET, this.host, this.port));
    this.sock = sock;
    this.connected = true;
    if(this.onstatechange) this.onstatechange(this);
    return this;
  }

  pump() {
    return this.drain();
  }

  info() {
    return {
      transport: 'TCP client',
      codec: this.codec.name,
      remote: `${this.host}:${this.port}`,
      local: addrString(this.sock?.local) ?? '-',
      state: this.connected ? 'connected' : 'closed',
      fd: this.fdString,
      'bytes rx/tx': `${this.stats.bytesIn} / ${this.stats.bytesOut}`,
      'msgs rx/tx': `${this.stats.msgsIn} / ${this.stats.msgsOut}`,
    };
  }
}

/* Message-oriented adapter for WebSocket-style connections (qjs-lws, qjs-net).
 * This module deliberately does NOT import lws.so/net.so — wire it from outside:
 *
 *   const ws = new WebSocketTransport({ url: 'ws://host:port/' });
 *   new LWSContext({ ..., protocols: [{ name: 'debugger',
 *     callback(wsi, reason, user, buf) {
 *       if(reason == 3 / * CLIENT_ESTABLISHED * /) ws.attach(wsi);
 *       else if(reason == 8 / * CLIENT_RECEIVE * /) ws.deliver(buf);
 *       else if(reason == 1 / * CLOSED * /)         ws.detach();
 *     } }] });
 *
 * pump() drains whatever the callbacks queued since last frame. */
export class WebSocketTransport {
  codec;
  url;
  connected = false;
  #wsi = null;
  #queue = [];
  stats = { bytesIn: 0, bytesOut: 0, msgsIn: 0, msgsOut: 0 };
  onstatechange = null;
  service = null; /* optional per-frame service hook, e.g. () => lwsCtx.service?.(0) */

  constructor({ url = '', codec } = {}) {
    this.url = url;
    this.codec = codec ?? new JsonMessageCodec();
  }

  attach(wsi) {
    this.#wsi = wsi;
    this.connected = true;
    if(this.onstatechange) this.onstatechange(this);
  }

  detach() {
    this.#wsi = null;
    this.connected = false;
    this.codec.reset();
    if(this.onstatechange) this.onstatechange(this);
  }

  deliver(buf) {
    for(const msg of this.codec.feed(buf)) {
      this.stats.msgsIn++;
      this.#queue.push(msg);
    }
    this.stats.bytesIn += typeof buf == 'string' ? buf.length : (buf.byteLength ?? 0);
  }

  send(obj) {
    if(!this.connected || !this.#wsi) return false;
    const wire = this.codec.encode(obj);
    const w = this.#wsi.write ?? this.#wsi.send;
    if(typeof w != 'function') return false;
    w.call(this.#wsi, wire);
    this.stats.bytesOut += wire.length;
    this.stats.msgsOut++;
    return true;
  }

  pump() {
    if(typeof this.service == 'function') this.service();
    if(this.#queue.length == 0) return [];
    const out = this.#queue;
    this.#queue = [];
    return out;
  }

  close() {
    try {
      this.#wsi?.close?.();
    } catch(e) {}
    this.detach();
  }

  info() {
    return {
      transport: 'WebSocket',
      codec: this.codec.name,
      url: this.url || '-',
      state: this.connected ? 'connected' : 'detached',
      'bytes rx/tx': `${this.stats.bytesIn} / ${this.stats.bytesOut}`,
      'msgs rx/tx': `${this.stats.msgsIn} / ${this.stats.msgsOut}`,
    };
  }
}
