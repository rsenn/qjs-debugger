/* debugger-client.js — protocol session for quickjs-debugger.c.
 *
 * Synchronous-poll sibling of plot-cv's DebuggerDispatcher: identical command
 * surface (stepIn / next / stepOut / continue / pause / evaluate / scopes /
 * variables / stackTrace / breakpoints / stopOnException), but callback-based
 * and pumped once per UI frame — no promises, no event loop required.
 *
 * Fully uncoupled: knows nothing about sockets, framing, ImGui or trees.
 * The transport is any object with { connected, send(obj), pump() -> obj[] }.
 *
 * Protocol facts honoured here (from quickjs-debugger.c):
 *   - scope variablesReference encoding: (frame << 2) | scope; 0=Global 1=Local 2=Closure
 *   - object references are allocated per-pause; ALL refs die on resume
 *   - the debuggee announces pauses via { type:'event', event:{ type:'StoppedEvent',
 *     reason: entry|breakpoint|step|stepIn|stepOut|pause|exception } }
 *   - breakpoints are per-path line lists, replaced wholesale on each sync
 */

export const SCOPE_GLOBAL = 0,
  SCOPE_LOCAL = 1,
  SCOPE_CLOSURE = 2;

export function scopeReference(frame, scope) {
  return (frame << 2) | scope;
}

export class Breakpoint {
  line;
  enabled = true;
  temp = false;
  condition = null;
  ignore = 0;
  hits = 0;

  constructor(line, opts = {}) {
    this.line = line;
    Object.assign(this, opts);
  }
}

export class DebuggerSession {
  transport;

  /* 'detached' | 'running' | 'stopped' | 'terminated' */
  state = 'detached';
  stopReason = '';
  frames = [];
  currentFrame = 0;
  stopGeneration = 0; /* bumped on every accepted stop; variable refs are valid per-generation */
  breakpoints = new Map(); /* path -> Breakpoint[] */
  exceptionBreak = false;

  /* event hooks — assign from the UI */
  onstopped = null; /* (event, frames) — fired only when we actually stay stopped   */
  onresumed = null; /* (why)                                                        */
  onterminated = null; /* ()                                                        */
  onthread = null; /* (event)                                                       */
  onlog = null; /* (dir: '<-'|'->'|'**', text)                                      */

  #seq = 0;
  #pending = new Map(); /* request_seq -> cb(response) */

  constructor(transport) {
    this.transport = transport;
  }

  get connected() {
    return this.transport.connected;
  }

  /* ---- plumbing ---------------------------------------------------------- */

  #log(dir, what) {
    if(this.onlog) this.onlog(dir, typeof what == 'string' ? what : JSON.stringify(what));
  }

  #send(msg) {
    this.#log('->', msg);
    return this.transport.send(msg);
  }

  request(command, args = {}, cb = null) {
    const request_seq = ++this.#seq;
    if(cb) this.#pending.set(request_seq, cb);
    this.#send({ type: 'request', request: { request_seq, command, args } });
    return request_seq;
  }

  /* Call once per frame. Drains the transport and dispatches. */
  pump() {
    for(const msg of this.transport.pump()) {
      this.#log('<-', msg);
      this.#dispatch(msg);
    }
  }

  #dispatch(msg) {
    switch (msg.type) {
      case 'response': {
        const cb = this.#pending.get(msg.request_seq);
        this.#pending.delete(msg.request_seq);
        if(cb) cb(msg);
        break;
      }
      case 'event':
        this.#event(msg.event ?? {});
        break;
      case 'breakpoints':
        break; /* echo of a breakpoint query — informational */
      case 'protocol-error':
        this.#log('**', `codec: ${msg.error}`);
        break;
    }
  }

  #event(event) {
    const kind = String(event.type ?? '');
    if(kind === 'StoppedEvent') this.#stopped(event);
    else if(kind === 'ThreadEvent') {
      if(this.onthread) this.onthread(event);
    } else if(kind === 'terminated') {
      this.state = 'terminated';
      this.#pending.clear();
      if(this.onterminated) this.onterminated();
    }
  }

  /* ---- stop handling, incl. client-side conditional breakpoints ---------- */

  #stopped(event) {
    this.state = 'stopped';
    this.stopReason = event.reason ?? '';
    this.stopGeneration++;
    this.currentFrame = 0;

    this.stackTrace(frames => {
      this.frames = Array.isArray(frames) ? frames : [];

      if(event.reason === 'breakpoint' && this.frames.length) {
        const top = this.frames[0];
        const bp = this.findBreakpoint(top.filename ?? top.file, top.line);

        if(bp) {
          bp.hits++;

          if(bp.temp) this.removeBreakpoint(top.filename ?? top.file, top.line);

          if(bp.ignore >= bp.hits) return this.#autoContinue(`ignore ${bp.hits}/${bp.ignore}`);

          if(bp.condition)
            return this.evaluate(0, bp.condition, body => {
              if(this.#truthy(body)) this.#announceStop(event);
              else this.#autoContinue(`condition false: ${bp.condition}`);
            });
        }
      }

      this.#announceStop(event);
    });
  }

  #announceStop(event) {
    if(this.onstopped) this.onstopped(event, this.frames);
  }

  #autoContinue(why) {
    this.#log('**', `auto-continue (${why})`);
    this.resume();
  }

  #truthy(body) {
    const v = String(body?.result ?? '');
    if(body?.type === 'undefined' || body?.type === 'null') return false;
    return !/^(false|0|null|undefined|NaN|)$/.test(v);
  }

  /* ---- execution control -------------------------------------------------- */

  #step(command) {
    if(this.state !== 'stopped') return false;
    this.state = 'running';
    if(this.onresumed) this.onresumed(command);
    this.request(command);
    return true;
  }

  stepIn() {
    return this.#step('stepIn');
  }
  stepOut() {
    return this.#step('stepOut');
  }
  next() {
    return this.#step('next');
  }
  resume() {
    return this.#step('continue');
  }

  pause() {
    if(this.state !== 'running') return false;
    this.request('pause');
    return true;
  }

  stopOnException(flag = true) {
    this.exceptionBreak = !!flag;
    this.#send({ type: 'stopOnException', stopOnException: this.exceptionBreak });
  }

  /* ---- inspection --------------------------------------------------------- */

  stackTrace(cb) {
    this.request('stackTrace', {}, r => cb(r.body));
  }

  scopes(frameId, cb) {
    this.request('scopes', { frameId }, r => cb(r.body));
  }

  /* variablesReference may be a number or [frame, scope] (dispatcher-compatible). */
  variables(variablesReference, options = {}, cb) {
    if(Array.isArray(variablesReference)) {
      const [frame, scope] = variablesReference;
      variablesReference = scopeReference(frame, scope);
    }
    this.request('variables', { variablesReference, ...options }, r => cb(r.body));
  }

  evaluate(frameId, expression, cb) {
    this.request('evaluate', { frameId, expression }, r => cb(r.body));
  }

  /* ---- breakpoints --------------------------------------------------------- */

  fileBreakpoints(path) {
    let list = this.breakpoints.get(path);
    if(!list) this.breakpoints.set(path, (list = []));
    return list;
  }

  findBreakpoint(path, line) {
    return this.breakpoints.get(path)?.find(b => b.line === line) ?? null;
  }

  toggleBreakpoint(path, line, opts = {}) {
    const list = this.fileBreakpoints(path);
    const i = list.findIndex(b => b.line === line);
    if(i >= 0) list.splice(i, 1);
    else list.push(new Breakpoint(line, opts));
    list.sort((a, b) => a.line - b.line);
    this.syncBreakpoints(path);
    return i < 0;
  }

  removeBreakpoint(path, line) {
    const list = this.fileBreakpoints(path);
    const i = list.findIndex(b => b.line === line);
    if(i >= 0) {
      list.splice(i, 1);
      this.syncBreakpoints(path);
    }
  }

  clearBreakpoints(path = null) {
    if(path !== null) {
      this.breakpoints.set(path, []);
      this.syncBreakpoints(path);
    } else
      for(const p of this.breakpoints.keys()) {
        this.breakpoints.set(p, []);
        this.syncBreakpoints(p);
      }
  }

  syncBreakpoints(path) {
    const lines = this.fileBreakpoints(path)
      .filter(b => b.enabled)
      .map(b => ({ line: b.line }));
    this.#send({ type: 'breakpoints', breakpoints: { path, breakpoints: lines } });
  }

  syncAllBreakpoints() {
    for(const path of this.breakpoints.keys()) this.syncBreakpoints(path);
    if(this.exceptionBreak) this.stopOnException(true);
  }

  /* Run-to-cursor: temporary breakpoint + continue. */
  runToLine(path, line) {
    if(this.state !== 'stopped') return false;
    if(!this.findBreakpoint(path, line)) {
      this.fileBreakpoints(path).push(new Breakpoint(line, { temp: true }));
      this.syncBreakpoints(path);
    }
    return this.resume();
  }

  /* Forget everything tied to a connection (new child / reconnect). */
  resetConnectionState() {
    this.state = this.transport.connected ? 'running' : 'detached';
    this.frames = [];
    this.currentFrame = 0;
    this.stopGeneration++;
    this.#pending.clear();
  }
}
