/**
 * session.js — DebugSession: the protocol state machine, and nothing else.
 *
 * Knows the quickjs-debugger message grammar (request/response/event,
 * breakpoints, stopOnException) but has ZERO knowledge of sockets,
 * WebSockets, framing or processes. It talks to the world through exactly
 * two points:
 *
 *   - an injected `send(obj)` function(constructor argument)
 *   - its `dispatch(obj)` method, which the transport owner calls for every
 *     decoded incoming message
 *
 * Because of this it runs unchanged in the browser, in a QuickJS REPL
 * talking TCP to the engine, and inside the server adapter.
 *
 * Environment-free: no imports at all.
 */

export class DebugSession {
  #seq = 0;
  #pending = new Map(); /* request_seq -> { resolve, reject, tid, command } */
  #listeners = new Map(); /* event name -> Set<fn> */
  #waiters = new Map(); /* event name -> resolve[] (one-shot) */
  #send;

  /** Default per-request timeout in ms; 0 disables. */
  timeout = 30000;
  running = false;

  /**
   * @param send     (obj) => void — serialize+transmit one protocol message
   * @param options  { timeout }
   */
  constructor(send, options = {}) {
    if(typeof send != 'function') throw new TypeError('DebugSession: send function required');
    this.#send = send;
    if(options.timeout !== undefined) this.timeout = options.timeout;
  }

  /* ------------------------------------------------------------------ *
   *  events                                                            *
   * ------------------------------------------------------------------ */

  on(name, fn) {
    name = name.toLowerCase();
    let set = this.#listeners.get(name);
    if(!set) this.#listeners.set(name, (set = new Set()));
    set.add(fn);
    return this;
  }

  off(name, fn) {
    this.#listeners.get(name.toLowerCase())?.delete(fn);
    return this;
  }

  once(name, fn) {
    const wrapper = ev => (this.off(name, wrapper), fn(ev));
    return this.on(name, wrapper);
  }

  /** One-shot promise for the next occurrence of an event ('stopped', ...). */
  waitEvent(name) {
    name = name.toLowerCase();
    return new Promise(resolve => {
      let arr = this.#waiters.get(name);
      if(!arr) this.#waiters.set(name, (arr = []));
      arr.push(resolve);
    });
  }

  emit(name, arg) {
    name = name.toLowerCase();

    const set = this.#listeners.get(name);
    if(set) for(let fn of [...set]) fn.call(this, arg);

    const arr = this.#waiters.get(name);
    if(arr) {
      this.#waiters.delete(name);
      for(let resolve of arr) resolve(arg);
    }
  }

  /* ------------------------------------------------------------------ *
   *  inbound                                                           *
   * ------------------------------------------------------------------ */

  /** Entry point for every decoded incoming message. */
  dispatch(msg) {
    switch (msg.type) {
      case 'response': {
        const pending = this.#pending.get(msg.request_seq);

        if(!pending) {
          this.emit('orphan-response', msg);
          break;
        }

        this.#pending.delete(msg.request_seq);
        if(pending.tid !== undefined) globalThis.clearTimeout?.(pending.tid);

        if(msg.success === false) pending.reject(new Error(`request '${pending.command}' (seq #${msg.request_seq}) failed: ${msg.error}`));
        else pending.resolve(msg);
        break;
      }

      case 'event': {
        const { event } = msg;
        const i = event.type.indexOf('Event');
        const name = (i >= 0 ? event.type.slice(0, i) : event.type).toLowerCase();
        this.emit('event', event);
        this.emit(name, event);
        break;
      }

      case 'breakpoints':
        this.emit('breakpoints', msg);
        break;

      default:
        this.emit('message', msg);
        break;
    }
  }

  /** Tear down: reject all in-flight requests, e.g. on transport close. */
  abort(reason = 'connection closed') {
    for(let [seq, pending] of this.#pending) {
      if(pending.tid !== undefined) globalThis.clearTimeout?.(pending.tid);
      pending.reject(new Error(`request '${pending.command}' (seq #${seq}) aborted: ${reason}`));
    }
    this.#pending.clear();
    this.emit('aborted', reason);
  }

  /* ------------------------------------------------------------------ *
   *  outbound                                                          *
   * ------------------------------------------------------------------ */

  /** Send a raw protocol message (no response expected). */
  sendMessage(msg) {
    return this.#send(msg);
  }

  /** Send a request and resolve with its response (rejects on timeout / success:false). */
  request(command, args = {}, timeout = this.timeout) {
    const request_seq = ++this.#seq;
    this.#send({ type: 'request', request: { request_seq, command, args } });

    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, command };

      if(timeout > 0 && typeof globalThis.setTimeout == 'function')
        pending.tid = globalThis.setTimeout(() => {
          this.#pending.delete(request_seq);
          reject(new Error(`request '${command}' (seq #${request_seq}) timed out after ${timeout}ms`));
        }, timeout);

      this.#pending.set(request_seq, pending);
    });
  }

  /* ------------------------------------------------------------------ *
   *  protocol surface                                                  *
   * ------------------------------------------------------------------ */

  async stackTrace() {
    return (await this.request('stackTrace')).body;
  }

  async scopes(frameId = 0) {
    return (await this.request('scopes', { frameId })).body;
  }

  /** ref may be a raw variablesReference or [frame, scope] (scope: 0 global, 1 local, 2 closure). */
  async variables(ref = 1, options = {}) {
    if(Array.isArray(ref)) {
      const [frame, scope] = ref;
      ref = (frame << 2) + scope;
    }
    return (await this.request('variables', { variablesReference: ref, ...options })).body;
  }

  async evaluate(expression, frameId = 0) {
    return (await this.request('evaluate', { expression, frameId })).body;
  }

  pause() {
    return this.request('pause');
  }

  stopOnException(stopOnException = true) {
    return this.sendMessage({ type: 'stopOnException', stopOnException });
  }

  /**
   * Set breakpoints for a file (replaces the existing set; numbers are
   * shorthand for { line }). Without `breakpoints`, queries the current set:
   * the engine answers with a seq-less 'breakpoints' message, so the query
   * resolves through a one-shot waiter.
   */
  breakpoints(path, breakpoints) {
    if(breakpoints === undefined) {
      const reply = this.waitEvent('breakpoints');
      this.sendMessage({ type: 'breakpoints', path });
      return reply;
    }

    if(Array.isArray(breakpoints)) breakpoints = breakpoints.map(b => (typeof b == 'number' ? { line: b } : b));

    this.sendMessage({ type: 'breakpoints', breakpoints: { path, breakpoints } });
    return Promise.resolve({ path, breakpoints });
  }

  /* stepping: subscribe to 'stopped' BEFORE sending, so the event can't be
     lost in the gap; resolve with [event, stackTrace] like waitRun() did */
  #step(command) {
    const stopped = this.waitEvent('stopped');
    this.running = true;

    return this.request(command).then(async () => {
      const event = await stopped;
      this.running = false;
      return [event, await this.stackTrace()];
    });
  }

  next() {
    return this.#step('next');
  }

  stepIn() {
    return this.#step('stepIn');
  }

  stepOut() {
    return this.#step('stepOut');
  }

  /** Resume; resolves immediately (use waitEvent('stopped') to await the next stop). */
  async continue() {
    this.running = true;
    return this.request('continue');
  }

  /** Resume and wait for the next stop (breakpoint/exception/pause). */
  async continueUntilStopped() {
    const stopped = this.waitEvent('stopped');
    await this.continue();
    const event = await stopped;
    this.running = false;
    return [event, await this.stackTrace()];
  }
}

Object.assign(DebugSession.prototype, { [Symbol.toStringTag]: 'DebugSession' });

////export default DebugSession;
