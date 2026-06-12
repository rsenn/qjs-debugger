/**
 * server-adapter.js — DebuggerServerAdapter.
 *
 * Bridges N clients (browsers, REPLs) onto ONE QuickJS engine. Fixes the
 * old design's seq collision by construction: the adapter's internal
 * DebugSession is the only thing that ever talks to the engine, and it owns
 * the engine-side seq space. Client seqs exist only at the client edge;
 * responses are rewritten back to the originating client's seq.
 *
 * Decoupling contract — a "ClientPort" is anything with:
 *     sendMessage(obj)   — deliver one message to that client
 *     close?()           — optional
 *
 * The web-server connectors (connector-qjsnet.js / connector-lws.js) just
 * wrap their connection handles into ClientPorts and feed inbound messages
 * to adapter.clientMessage(port, obj). The adapter never imports a server.
 *
 * Engine lifecycle is injected the same way: anything with sendMessage /
 * onmessage / onclose / close (EngineConnection satisfies it) can be passed
 * to attachEngine(); launch/connect helpers are optional conveniences.
 */

import { DebugSession } from './session.js';

export class DebuggerServerAdapter {
  #engine = null; /* EngineConnection-like */
  #ports = new Set(); /* attached ClientPorts */
  session = null; /* DebugSession over the engine connection */
  child = null; /* spawned interpreter, if we launched it */

  onstatus = msg => console.log('DebuggerServerAdapter:', msg);

  /**
   * launch/connect are injected, keeping this module environment-free.
   * Wire them from engine-connection.js (or your own transport):
   *
   *     import { EngineConnection, StartEngine } from './engine-connection.js';
   *     new DebuggerServerAdapter({ launch: StartEngine, connect: EngineConnection.connect });
   *
   * Or skip them entirely and call attachEngine() with a ready connection.
   */
  constructor({ launch, connect, timeout } = {}) {
    this.launchFn = launch;
    this.connectFn = connect;
    this.timeout = timeout;
  }

  /* ------------------------------------------------------------------ *
   *  engine side                                                       *
   * ------------------------------------------------------------------ */

  /** Plug in an existing engine connection (duck-typed). */
  attachEngine(connection) {
    this.detachEngine();
    this.#engine = connection;

    this.session = new DebugSession(msg => connection.sendMessage(msg), { timeout: this.timeout });

    connection.onmessage = msg => {
      this.session.dispatch(msg);

      /* fan out everything that is not a response to all clients;
         responses are routed per-request in clientMessage() */
      if(msg.type != 'response') this.broadcast(msg);
    };

    connection.onclose = () => {
      this.session?.abort('engine connection closed');
      this.broadcast({ type: 'event', event: { type: 'terminated' } });
      this.#engine = null;
    };

    return this.session;
  }

  detachEngine() {
    if(!this.#engine) return;
    this.session?.abort('engine detached');
    this.#engine.close?.();
    this.#engine = null;
    this.session = null;
  }

  get connected() {
    return this.#engine != null;
  }

  /** Spawn an interpreter and connect to its debug port. */
  async launch(args, address = '127.0.0.1:9901', options = {}) {
    if(!this.launchFn) throw new Error('DebuggerServerAdapter: no launch function injected (pass { launch: StartEngine })');
    const { child } = this.launchFn(args, address, { listen: true, ...options });
    this.child = child;
    await this.connect(address, options);
    return { child, address, args };
  }

  /** Connect to an already-listening engine. */
  async connect(address, options = {}) {
    if(!this.connectFn) throw new Error('DebuggerServerAdapter: no connect function injected (pass { connect: EngineConnection.connect })');
    const connection = await this.connectFn(address, options);
    this.attachEngine(connection);
    this.onstatus(`connected to engine at ${address}`);
    return this.session;
  }

  /* ------------------------------------------------------------------ *
   *  client side                                                       *
   * ------------------------------------------------------------------ */

  attachClient(port) {
    this.#ports.add(port);
    return () => this.detachClient(port);
  }

  detachClient(port) {
    this.#ports.delete(port);
  }

  broadcast(msg) {
    for(let port of [...this.#ports])
      try {
        port.sendMessage(msg);
      } catch(e) {
        this.detachClient(port);
      }
  }

  get clientCount() {
    return this.#ports.size;
  }

  /**
   * Handle one inbound message from a client. All routing and seq
   * translation lives here — connectors stay protocol-ignorant.
   */
  async clientMessage(port, msg) {
    switch (msg.type ?? msg.command) {
      /* ---- lifecycle commands (from the web UI) ---- */
      case 'start': {
        const { args = [], address, connect = false } = msg;
        try {
          const info = connect ? { address, args, session: await this.connect(address) } : await this.launch(args, address);
          port.sendMessage({ type: 'response', response: { command: 'start', args, address: info.address } });
        } catch(error) {
          port.sendMessage({ type: 'error', command: 'start', message: error.message });
        }
        break;
      }

      case 'connect': {
        try {
          await this.////export default(msg.address);
          port.sendMessage({ type: 'response', response: { command: 'connect', address: msg.address } });
        } catch(error) {
          port.sendMessage({ type: 'error', command: 'connect', message: error.message });
        }
        break;
      }

      /* ---- debug requests: translate client seq <-> session seq ---- */
      case 'request': {
        const { request_seq: clientSeq, command, args } = msg.request;

        if(!this.session) {
          port.sendMessage({ type: 'response', request_seq: clientSeq, success: false, error: 'no engine attached' });
          break;
        }

        try {
          const response = await this.session.request(command, args);
          port.sendMessage({ ...response, request_seq: clientSeq });
        } catch(error) {
          port.sendMessage({ type: 'response', request_seq: clientSeq, success: false, error: error.message });
        }
        break;
      }

      /* ---- seq-less engine messages: pass through verbatim ---- */
      case 'breakpoints':
      case 'stopOnException':
      case 'continue':
        if(this.session) this.session.sendMessage(msg);
        else port.sendMessage({ type: 'error', command: msg.type, message: 'no engine attached' });
        break;

      default:
        port.sendMessage({ type: 'error', message: `unknown message type '${msg.type ?? msg.command}'` });
        break;
    }
  }

  close() {
    this.detachEngine();
    for(let port of [...this.#ports]) port.close?.();
    this.#ports.clear();
  }
}

Object.assign(DebuggerServerAdapter.prototype, { [Symbol.toStringTag]: 'DebuggerServerAdapter' });

//export default DebuggerServerAdapter;
