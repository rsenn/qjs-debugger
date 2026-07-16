/**
 * transport.js — pluggable byte transports for EngineConnection.
 *
 * Transport duck type (consumed by engine-connection.js):
 *     [Symbol.asyncIterator]()  — incoming chunks (Uint8Array | ArrayBuffer);
 *                                 iteration ends on EOF/close
 *     send(data)                — transmit one chunk (string | ArrayBuffer)
 *     close()
 *
 * Every transport class provides the two static openers, both resolving
 * with a connected transport instance:
 *     connect(address, options) — active open to 'host:port'
 *     accept(address, options)  — listen on 'host:port', resolve with the
 *                                 first peer that connects; invokes
 *                                 options.listening() once the listener is
 *                                 bound (spawn the engine there — it
 *                                 connects out without retrying)
 *
 * SocketTransport — AsyncSocket from qjs-modules' 'sockets'
 * StreamTransport — TCPSocketStream / lws raw streams from qjs-lws
 *
 * Both import their backing modules lazily inside the openers, so this
 * module loads (and the other transport stays usable) when only one of
 * qjs-modules / qjs-lws is installed.
 */

function splitAddress(address) {
  const [host, port] = address.split(':');
  return [host, +port];
}

export class SocketTransport {
  #sock;

  constructor(sock) {
    this.#sock = sock;
  }

  static async connect(address, { retries = 20, delay = 100 } = {}) {
    const [{ AF_INET, AsyncSocket, IPPROTO_TCP, SOCK_STREAM, SockAddr }, { setTimeout }] = await Promise.all([import('sockets'), import('os')]);
    const [host, port] = splitAddress(address);
    const addr = new SockAddr(AF_INET, host, port);

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

      if(ret === undefined || ret >= 0) return new SocketTransport(sock);

      sock.close();
      if(attempt >= retries) throw new Error(`SocketTransport: cannot connect to ${address} after ${attempt + 1} attempts`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  static async accept(address, { listening } = {}) {
    const { AF_INET, AsyncSocket, IPPROTO_TCP, SOCK_STREAM, SockAddr, SOL_SOCKET, SO_REUSEADDR, SO_REUSEPORT } = await import('sockets');
    const [host, port] = splitAddress(address);
    const addr = new SockAddr(AF_INET, host, port);
    const remote = new SockAddr(AF_INET);
    const server = new AsyncSocket(AF_INET, SOCK_STREAM, IPPROTO_TCP);

    server.setsockopt(SOL_SOCKET, SO_REUSEADDR, [1]);
    server.setsockopt(SOL_SOCKET, SO_REUSEPORT, [1]);
    server.bind(addr);
    server.listen(5);
    listening?.();

    let sock;
    try {
      sock = await server.accept(remote);
    } finally {
      server.close();
    }

    if(!sock || sock == -1) throw new Error(`SocketTransport: cannot accept at ${address}`);
    return new SocketTransport(sock);
  }

  async *[Symbol.asyncIterator]() {
    const buf = new ArrayBuffer(65536);

    for(;;) {
      const r = await this.#sock.recv(buf);
      if(r <= 0) break;
      yield new Uint8Array(buf, 0, r);
    }
  }

  send(data) {
    if(!this.#sock) throw new Error('SocketTransport: closed');
    return this.#sock.send(data);
  }

  close() {
    try {
      this.#sock?.close();
    } catch(e) {}
    this.#sock = null;
  }
}

Object.assign(SocketTransport.prototype, { [Symbol.toStringTag]: 'SocketTransport' });

export class StreamTransport {
  #close;
  #ctx; /* lws context must stay referenced while the connection lives */
  #readable;
  #writer;

  constructor(close, { readable, writable }, ctx) {
    this.#close = close;
    this.#readable = readable;
    this.#writer = writable.getWriter();
    this.#ctx = ctx;
  }

  static async connect(address, { retries = 20, delay = 100, ...options } = {}) {
    const [{ TCPSocketStream }, { setTimeout }] = await Promise.all([import('tcpsocketstream'), import('os')]);
    const [host, port] = splitAddress(address);

    /* the engine needs a moment after spawn before it listens; retry.
       `opened` rejects on connection error, e.g. ECONNREFUSED */
    for(let attempt = 0; ; attempt++) {
      const sock = new TCPSocketStream({ host, port, ...options });

      try {
        const opened = await sock.opened;
        return new StreamTransport(() => sock.close(), opened);
      } catch(err) {
        try {
          sock.close();
        } catch(e) {}

        if(attempt >= retries) throw new Error(`StreamTransport: cannot connect to ${address} after ${attempt + 1} attempts: ${err.message}`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  static async accept(address, { listening } = {}) {
    const [{ raw, stream }, { createContext }, { LWS_SERVER_OPTION_ONLY_RAW, LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG }] = await Promise.all([
      import('lws/protocols.js'),
      import('lws/context.js'),
      import('lws.so'),
    ]);
    const [, port] = splitAddress(address);

    const adapter = stream({});
    let resolveFirst, rejectFirst;
    const first = new Promise((resolve, reject) => ((resolveFirst = resolve), (rejectFirst = reject)));

    /* no iface: lws treats it as SO_BINDTODEVICE (a device name, not an
       address), so listen on all interfaces; the host part of `address`
       still directs the engine's outgoing connect */
    const ctx = createContext({
      port,
      options: LWS_SERVER_OPTION_ONLY_RAW | LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG,
      listenAcceptRole: 'raw-skt',
      listenAcceptProtocol: 'raw',
      protocols: [
        {
          name: 'raw',
          ...raw({
            open: wsi => {
              if(!wsi.client) resolveFirst({ wsi, session: adapter.session(wsi) });
            },
            message: adapter.message,
            close: adapter.close,
            error: (wsi, message) => {
              adapter.error(wsi, message);
              rejectFirst(new Error(`StreamTransport: cannot accept at ${address}: ${message}`));
            },
          }),
        },
      ],
    });

    /* lws binds during context creation */
    listening?.();

    const { wsi, session } = await first;
    const opened = await session.opened;

    return new StreamTransport(() => wsi.close(), opened, ctx);
  }

  async *[Symbol.asyncIterator]() {
    const reader = this.#readable.getReader();

    try {
      for(;;) {
        const { done, value } = await reader.read();
        if(done) break;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  }

  send(data) {
    if(!this.#writer) throw new Error('StreamTransport: closed');
    return this.#writer.write(data);
  }

  close() {
    try {
      this.#close?.();
    } catch(e) {}
    this.#close = null;
    this.#writer = null;
  }
}

Object.assign(StreamTransport.prototype, { [Symbol.toStringTag]: 'StreamTransport' });
