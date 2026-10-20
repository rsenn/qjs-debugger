/**
 * debugger.js — the headless Debugger model: gdb-style command interpreter
 * and a scriptable API on top of the engine's debugger protocol.
 *
 * ```js
 * import { Debugger } from 'qjs-debugger';
 *
 * const dbg = new Debugger({ interpreter: 'qjsm', quiet: true });
 * dbg.on('stopped', stop => console.log(stop.reason, stop.file, stop.line));
 * await dbg.launch('script.js', ['arg']);        // stops at entry
 * await dbg.break('script.js:3');
 * const stop = await dbg.continue();             // { type: 'stopped', ... }
 * console.log((await dbg.eval('a')).value);
 * await dbg.continue();                          // { type: 'exited', code: 0 }
 * ```
 *
 * All output goes through injected sinks (print, printRaw, emit), so the same
 * class backs the terminal REPL, batch mode, the GUI and library users.
 */
import { readFileSync } from 'fs';
import * as io from 'io';
import * as os from 'os';
import { read as osRead, setReadHandler } from 'os';
import { exists, dirname, join } from 'path';
import { exit, out as stdout } from 'std';
import { TextDecoder } from 'textcode';
import inspect from 'inspect';
import process from 'process';
import { EngineConnection, StartEngine } from './engine-connection.js';
import { SocketTransport } from './transport.js';

/* sockets' AsyncSocket looks its read/write handlers up on the global object */
globalThis.io ??= io;
globalThis.os ??= os;
globalThis.setTimeout ??= os.setTimeout;
globalThis.clearTimeout ??= os.clearTimeout;

/* a request racing the debuggee's death writes to a closed socket: that must
   fail with EPIPE, not kill the debugger */
try {
  os.signal(os.SIGPIPE, () => {});
} catch(e) {}

/* ------------------------------------------------------------------ *
 *  source scanning (simple RegExp, no parser)                         *
 * ------------------------------------------------------------------ */

const KEYWORDS = new Set(['if', 'else', 'for', 'while', 'do', 'switch', 'catch', 'return', 'typeof', 'new', 'function', 'in', 'of', 'case', 'delete', 'void', 'yield', 'await']);

/**
 * Scan one source file for function declarations. Returns a list of
 * { key, line } entries, where key is 'funcName' or
 * 'Class.prototype.methodName' ('Class.methodName' for statics).
 */
function ScanFunctions(text) {
  const entries = [];
  const lines = text.split('\n');
  const add = (key, line) => entries.push({ key, line });

  const reFunc = /(?:^|[\s;(,=])function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/;
  const reAssign = /(?:^|[\s;])([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/;
  const reClass = /\bclass\s+([A-Za-z_$][\w$]*)/;
  const reMethod = /^\s+(static\s+)?(?:async\s+)?(?:get\s+|set\s+)?\*?\s*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*{/;

  let currentClass = null;

  for(let i = 0; i < lines.length; i++) {
    const s = lines[i];
    const line = i + 1;
    let m;

    if((m = s.match(reClass))) currentClass = m[1];

    if((m = s.match(reFunc))) add(m[1], line);
    else if((m = s.match(reAssign))) add(m[1], line);
    else if(currentClass && (m = s.match(reMethod))) {
      const [, isStatic, name] = m;
      if(!KEYWORDS.has(name)) add(currentClass + (isStatic ? '.' : '.prototype.') + name, line);
    }

    /* closing brace at column 0 ends the class body (heuristic) */
    if(currentClass && /^}/.test(s) && !s.includes('{')) currentClass = null;
  }

  return entries;
}

/** Collect relative imports ('./x.js', '../y.js') of a source file. */
function ScanImports(file) {
  const found = [];
  let text;

  try {
    text = readFileSync(file, 'utf-8');
  } catch(e) {
    return found;
  }

  const reImport = /^\s*(?:import|export)\b[^'"]*['"](\.\.?\/[^'"]+)['"]/;

  for(const s of text.split('\n')) {
    const m = s.match(reImport);
    if(m) found.push(join(dirname(file), m[1]));
  }

  return found;
}

/* ------------------------------------------------------------------ *
 *  Debugger                                                           *
 * ------------------------------------------------------------------ */

export class Debugger {
  program = null;
  programArgs = [];
  breakpoints = []; /* { num, file, line, spec } */
  nextBpNum = 1;
  displays = []; /* { num, expr } — printed at every stop */
  nextDisplayNum = 1;
  identifiers = []; /* debuggee identifiers, refreshed at every stop (for completion) */
  valueCounter = 0;
  stopOnException = false;

  child = null;
  connection = null;
  session = null;
  stack = [];
  currentFrame = 0;
  busy = false;
  lastRepeat = null;

  listFile = null;
  listNext = null;

  watches = []; /* { num, expr, last } — software watchpoints, checked by stepping */
  completion = true; /* refresh the identifier cache at every stop (tab completion; off for batch/library) */
  collectState = false; /* fill the 'stopped' record with stack + locals (json mode, library) */
  lastError = null; /* message of the failed command, set by #fail(); null when it succeeded */
  env = null; /* environment for the spawned debuggee (default: our own) */
  stdin = null; /* stdio for the debuggee's stdin: 'inherit' (default), 'ignore' or 'pipe' */
  exitCode = null; /* exit status of the debuggee after 'exited' (128+N for signal N) */
  lastStop = null; /* the most recent 'stopped' / 'exited' record */

  #sourceCache = new Map();
  #closed = null;
  #listeners = new Map();

  print = (...args) => console.log(...args);
  printRaw = (s, stream) => (stdout.puts(s), stdout.flush());
  emit = null; /* (obj) => {} — structured records: 'stopped', 'exited', 'output', 'result' (see doc/json-protocol.md) */
  onEvent = null; /* (kind: 'running' | 'stopped' | 'exited') => {} — for GUI views */
  echoSourceLine = true; /* print the stopped-at source line (off in GUI: the source pane shows it) */
  echoDisplays = true; /* print auto-displays at every stop (off in GUI: the watches pane shows them) */

  constructor({ interpreter = 'qjs', address = '127.0.0.1:9901', listen = true, transport = SocketTransport, quiet = false } = {}) {
    this.interpreter = interpreter;
    this.address = address;
    this.listen = listen; /* true: we accept, engine connects out; false: engine listens, we connect */
    this.transport = transport;
    this.external = false; /* don't spawn the debuggee: wait for (or connect to) a process started elsewhere */
    this.cwd = null; /* engine child's working directory; null: inherit ours */

    if(quiet) {
      /* library use: no text output; everything is reported through on()/emit */
      this.print = () => {};
      this.printRaw = () => {};
      this.collectState = true;
      this.completion = false;
    }
  }

  /* ---------------- events (library API) ---------------- */

  /** Subscribe to 'stopped', 'exited', 'output' or 'result' records; returns the unsubscribe function. */
  on(name, fn) {
    let set = this.#listeners.get(name);
    if(!set) this.#listeners.set(name, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }

  /** Report one structured record to the emit sink and to on() listeners (by its `type`). */
  report(record) {
    this.emit?.(record);
    for(const fn of [...(this.#listeners.get(record.type) ?? [])]) fn(record);
    return record;
  }

  /** Debuggee output: text to printRaw, structured to the 'output' record. */
  #output(data, stream) {
    this.printRaw(data, stream);
    if(this.emit || this.#listeners.has('output')) this.report({ type: 'output', stream, data });
  }

  setProgram(file, args = []) {
    this.program = file;
    this.programArgs = args;
    if(!exists(file)) this.print(`warning: ${file}: No such file.`);
  }

  /* ---------------- command dispatch ---------------- */

  static aliases = {
    b: 'break',
    br: 'break',
    r: 'run',
    c: 'continue',
    cont: 'continue',
    n: 'next',
    s: 'step',
    fin: 'finish',
    bt: 'backtrace',
    where: 'backtrace',
    f: 'frame',
    p: 'print',
    l: 'list',
    i: 'info',
    d: 'delete',
    q: 'quit',
    u: 'up',
  };

  /* name: [method, help, repeatable] */
  static commands = {
    file: ['cmdFile', 'file FILE -- set the program to be debugged', false],
    run: ['cmdRun', 'run -- start the debugged program (r)', false],
    start: ['cmdStart', 'start -- run to a temporary breakpoint on main() (or the first statement)', false],
    starti: ['cmdStarti', 'starti -- run and stop at program entry', false],
    break: ['cmdBreak', 'break [FILE:]LINE | FUNCTION | Class.prototype.method [if EXPR] -- set breakpoint (b)', false],
    tbreak: ['cmdTbreak', 'tbreak LOCATION [if EXPR] -- set a one-shot breakpoint', false],
    watch: ['cmdWatch', 'watch EXPR -- stop when EXPR changes (software watchpoint: checked after every statement)', false],
    delete: ['cmdDelete', 'delete [NUM...] -- delete breakpoints and watchpoints (d)', false],
    catch: ['cmdCatch', 'catch [throw|off] -- stop on exceptions', false],
    continue: ['cmdContinue', 'continue -- resume execution (c)', true],
    next: ['cmdNext', 'next -- step over (n)', true],
    step: ['cmdStep', 'step -- step into (s)', true],
    finish: ['cmdFinish', 'finish -- step out of current function(fin)', true],
    until: ['cmdUntil', 'until [LOCATION] -- run to LOCATION, or to a line past the current one', true],
    backtrace: ['cmdBacktrace', 'backtrace -- print call stack (bt, where)', false],
    frame: ['cmdFrame', 'frame [NUM] -- select stack frame (f)', false],
    up: ['cmdUp', 'up [N] -- select caller frame', true],
    down: ['cmdDown', 'down [N] -- select callee frame', true],
    print: ['cmdPrint', 'print EXPR -- evaluate expression in selected frame (p)', false],
    eval: ['cmdEval', 'eval EXPR -- like print, but the bare value only (no $N)', false],
    call: ['cmdCall', 'call EXPR -- evaluate EXPR (e.g. a function call), print the result unless undefined', false],
    echo: ['cmdEcho', 'echo TEXT -- print TEXT (\\n is a newline); marks positions in batch output', false],
    display: ['cmdDisplay', 'display [EXPR] -- print EXPR at every stop; alone: print all displays', false],
    undisplay: ['cmdUndisplay', 'undisplay [NUM...] -- remove auto-display expressions', false],
    list: ['cmdList', 'list [LOCATION] -- show source (l)', true],
    info: ['cmdInfo', 'info breakpoints|locals|frame|stack|display|source|program', false],
    set: ['cmdSet', 'set args ARG... | set var NAME=EXPR -- set program arguments or a variable', false],
    interrupt: ['cmdInterrupt', 'interrupt -- pause the running program', false],
    kill: ['cmdKill', 'kill -- kill the debugged program', false],
    quit: ['cmdQuit', 'quit [CODE] -- exit the debugger (q)', false],
    help: ['cmdHelp', 'help -- this list', false],
  };

  resolveCommand(word) {
    const { aliases, commands } = Debugger;
    if(aliases[word]) return aliases[word];
    if(commands[word]) return word;
    const matches = Object.keys(commands).filter(name => name.startsWith(word));
    if(matches.length == 1) return matches[0];
    if(matches.length > 1) throw new Error(`Ambiguous command "${word}": ${matches.join(', ')}.`);
    return null;
  }

  /**
   * Tab completion (REPL getCompletions contract: { tab, pos, ctx }).
   * print/display: debuggee identifiers (cached at every stop);
   * break: source file names and function names.
   */
  getCompletions(line, cursorPos) {
    const empty = { tab: [], pos: 0, ctx: {} };
    const before = line.slice(0, cursorPos);
    const m = before.match(/^\s*(\S+)\s+(.*)$/s);
    if(!m) return empty;

    const [, word, rest] = m;
    let name = null;
    try {
      name = this.resolveCommand(word);
    } catch(e) {}

    if(name == 'print' || name == 'display') {
      const im = rest.match(/([A-Za-z_$][\w$]*)$/);
      if(!im) return empty;
      return { tab: this.identifiers.filter(id => id.startsWith(im[1])).sort(), pos: im[1].length, ctx: {} };
    }

    if(name == 'break') return { tab: this.#locationCandidates().filter(c => c.startsWith(rest)).sort(), pos: rest.length, ctx: {} };

    return empty;
  }

  #locationCandidates() {
    const candidates = new Set();

    for(const file of this.#sourceFiles()) {
      candidates.add(file);

      let text;
      try {
        text = readFileSync(file, 'utf-8');
      } catch(e) {
        continue;
      }

      for(const { key } of ScanFunctions(text)) candidates.add(key);
    }

    return [...candidates];
  }

  async execute(line) {
    const [, word, rest = ''] = line.match(/^(\S+)(?:\s+(.*))?$/s);
    this.lastError = null;
    let name;
    try {
      name = this.resolveCommand(word);
    } catch(err) {
      this.lastError = err.message;
      this.report({ type: 'result', command: word, ok: false, error: err.message });
      throw err;
    }

    if(!name) {
      const message = `Undefined command: "${word}".  Try "help".`;
      this.print(message);
      this.report({ type: 'result', command: word, ok: false, error: message });
      this.lastError = message;
      return;
    }

    const [method, , repeatable] = Debugger.commands[name];
    this.lastRepeat = repeatable ? line : null;

    this.busy = true;
    let data;
    try {
      data = await this[method](rest.trim());
    } catch(err) {
      this.lastError = `${err?.message ?? err}`;
      this.report({ type: 'result', command: name, ok: false, error: this.lastError });
      throw err;
    } finally {
      this.busy = false;
    }

    /* every command ends with exactly one 'result' record */
    if(this.lastError !== null) this.report({ type: 'result', command: name, ok: false, error: this.lastError });
    else this.report({ type: 'result', command: name, ok: true, ...data, type: 'result' });
  }

  /** Print an error message (as the REPL always did) and mark the running command as failed. */
  #fail(message) {
    this.print(message);
    this.lastError = message;
  }

  /* ---------------- target lifecycle ---------------- */

  /**
   * launchEngine: low-level start. Spawns (or waits for) the debuggee, connects the
   * session and returns the engine's raw 'entry' stop event; null when the
   * program ended before it. Use launch() for the structured API.
   */
  async launchEngine() {
    this.#sourceCache.clear();
    this.exitCode = null;

    const args = [this.program, ...this.programArgs];

    const spawnEngine = () => {
      const { child } = StartEngine(args, this.address, {
        listen: !this.listen,
        interpreter: this.interpreter,
        env: this.env ?? process.env,
        stdin: this.stdin ?? 'inherit',
        cwd: this.cwd ?? undefined,
      });
      this.child = child;

      forwardOutput(child.stdout, s => this.#output(s, 'stdout'));
      forwardOutput(child.stderr, s => this.#output(s, 'stderr'));
    };

    try {
      if(this.external) {
        /* placeholder so the rest of the model treats us as "running" */
        this.child = { external: true };
        if(this.listen) {
          this.print(`Waiting for a debuggee to connect to ${this.address}`);
          this.print(`  (start it with QUICKJS_DEBUG_ADDRESS=${this.address})`);
          this.connection = await EngineConnection.accept(this.address, { transport: this.transport });
        } else {
          this.connection = await EngineConnection.connect(this.address, { transport: this.transport });
        }
      } else if(this.listen) {
        /* the engine connects out without retrying: spawn it only once
           the transport reports the listener is bound */
        this.connection = await EngineConnection.accept(this.address, { transport: this.transport, listening: spawnEngine });
      } else {
        spawnEngine();
        this.connection = await EngineConnection.connect(this.address, { transport: this.transport });
      }
    } catch(err) {
      this.child?.kill?.();
      this.child = null;
      throw err;
    }

    this.#closed = new Promise(resolve => {
      this.connection.onclose = () => resolve({ closed: true });
    });

    this.session = this.connection.attachSession({ timeout: 0 });

    /* the engine stops at 'entry' as soon as it attaches */
    const entry = await Promise.race([this.session.waitEvent('stopped'), this.#closed]);
    if(entry?.closed) {
      this.#terminated();
      return null;
    }

    if(this.stopOnException) this.session.stopOnException(true);
    for(const file of new Set(this.breakpoints.map(b => b.file))) this.#sendBreakpoints(file);

    return entry;
  }

  /**
   * adopt: take over a debug session somebody else owns (the server adapter's),
   * as if launchEngine() had connected it: the command interpreter works on the
   * shared engine while the owner keeps routing requests and events.
   * Waits for the entry stop; with runToMain, runs on to main() like `start`.
   */
  async adopt(session, { runToMain = false } = {}) {
    this.#sourceCache.clear();
    this.exitCode = null;
    this.child = { external: true };
    this.session = session;
    this.#closed = new Promise(resolve => session.on('aborted', () => resolve({ closed: true })));

    const entry = await Promise.race([session.waitEvent('stopped'), this.#closed]);
    if(entry?.closed) return this.#terminated();

    if(this.stopOnException) session.stopOnException(true);
    for(const file of new Set(this.breakpoints.map(b => b.file))) this.#sendBreakpoints(file);

    const loc = runToMain && this.program && this.#findFunctionIn(this.program, 'main');
    if(!loc) return this.#onStopped(entry, null, false);

    this.stack = await session.stackTrace();
    const bp = { num: this.nextBpNum++, ...loc, spec: 'main', temp: true };
    this.breakpoints.push(bp);
    this.print(`Temporary breakpoint ${bp.num} at ${bp.file}:${bp.line}`);
    this.#sendBreakpoints(bp.file);
    return this.#resume('continue');
  }

  /* signal name -> number, for the 128+N exit status of a killed debuggee */
  static signals = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGABRT: 6, SIGBUS: 7, SIGFPE: 8, SIGKILL: 9, SIGSEGV: 11, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15 };

  #terminated() {
    if(!this.child) return this.lastStop;

    const status = this.child.wait?.();
    const pid = this.child.pid;
    const signal = status?.signalCode ?? null;
    const code = signal != null ? 128 + (typeof signal == 'number' ? signal : (Debugger.signals[signal] ?? 127)) : (status?.exitCode ?? 0);

    drainOutput(this.child.stdout, s => this.#output(s, 'stdout'));
    drainOutput(this.child.stderr, s => this.#output(s, 'stderr'));

    if(this.child.external) this.print('[Debuggee disconnected]');
    else if(signal != null) this.print(`[Inferior (process ${pid}) killed by signal ${signal}]`);
    else if(status?.exitCode) this.print(`[Inferior (process ${pid}) exited with code ${status.exitCode}]`);
    else this.print(`[Inferior (process ${pid}) exited normally]`);

    this.exitCode = this.child.external ? null : code;
    this.connection?.close();
    this.child = this.connection = this.session = null;
    this.stack = [];
    this.currentFrame = 0;
    this.identifiers = [];
    this.onEvent?.('exited');

    const record = { type: 'exited', code, signal, ...(pid !== undefined ? { pid } : {}) };
    this.lastStop = record;
    return this.report(record);
  }

  /**
   * #resumeOnce: send one resuming request and wait for the next stop event
   * (the raw event), or null when the program ended instead.
   */
  async #resumeOnce(command) {
    this.onEvent?.('running');
    const stopped = this.session.waitEvent('stopped');

    try {
      await this.session.request(command);
    } catch(e) {
      /* rejected by session.abort() when the program exits mid-request */
    }

    const ev = await Promise.race([stopped, this.#closed]);
    return ev?.closed ? null : ev;
  }

  /** breakpoints set on the location of frame f */
  #breakpointsAt(f) {
    return this.breakpoints.filter(b => b.file == f?.filename && b.line == f?.line);
  }

  /** whether a value returned by the engine's evaluate counts as true */
  static truthy(body) {
    const v = body?.result ?? body?.value;
    switch (body?.type) {
      case 'undefined':
      case 'null':
        return false;
      case 'boolean':
        return v === true || v == 'true';
      case 'integer':
      case 'float':
        return +v != 0 && v != 'NaN';
      case 'string':
        return v !== '';
      default:
        return true;
    }
  }

  async #conditionHolds(bp) {
    try {
      return Debugger.truthy(await this.session.evaluate(bp.condition, 0));
    } catch(e) {
      this.print(`Error in testing condition for breakpoint ${bp.num}: ${e.message}`);
      return true; /* stop, like gdb */
    }
  }

  /* the watched expression's current text; an exception (out of scope, not yet initialised) leaves the old value */
  async #watchValue(w) {
    try {
      const body = await this.session.evaluate(w.expr, 0);
      const text = `${body?.result ?? body?.value}`;
      if(body?.type == 'object' && /^[A-Za-z]*Error\b/.test(text)) return w.last ?? '<unavailable>';
      return text;
    } catch(e) {
      return w.last ?? '<unavailable>';
    }
  }

  /** the first software watchpoint whose value changed since the last stop, updated in place */
  async #changedWatch() {
    let hit = null;
    for(const w of this.watches) {
      const now = await this.#watchValue(w);
      if(w.last === undefined) w.last = now;
      else if(now !== w.last && !hit) hit = { num: w.num, expr: w.expr, old: w.last, new: now };
      w.last = now;
    }
    return hit;
  }

  /**
   * #nextStop: resume with `command` until a stop worth reporting. Skips
   * breakpoints whose `if` condition is false and, while watchpoints
   * exist, steps statement by statement (`next`) instead of continuing. Returns { ev, watch } or
   * null when the program ended.
   */
  async #nextStop(command) {
    const stepping = command != 'continue';

    for(;;) {
      const watching = this.watches.length > 0;
      const ev = await this.#resumeOnce(watching && !stepping ? 'next' : command);
      if(!ev) return null;

      this.stack = await this.session.stackTrace();
      this.currentFrame = 0;
      const f = this.stack[0];

      if(watching) {
        const watch = await this.#changedWatch();
        if(watch) return { ev: { ...ev, reason: 'watchpoint' }, watch };
      }

      if(ev.reason == 'breakpoint') {
        const hits = this.#breakpointsAt(f);
        let hold = !hits.length;
        for(const bp of hits) if(!bp.condition || (await this.#conditionHolds(bp))) hold = true;
        if(!hold) {
          command = 'continue';
          continue;
        }
      } else if(watching && !stepping && /^step/i.test(ev.reason ?? '')) {
        continue; /* an internal single-step of a watched continue */
      }

      return { ev, watch: null };
    }
  }

  /** resume with `command` and report the next stop or exit; returns its record (null if nothing runs) */
  async #resume(command) {
    if(!this.session) {
      this.#fail('The program is not being run.');
      return null;
    }

    const stop = await this.#nextStop(command);
    if(!stop) return this.#terminated();

    return this.#onStopped(stop.ev, stop.watch);
  }

  /** shape of a frame in records */
  static frameRecord(f, index) {
    return { frame: f.id ?? index, function: f.name ?? null, file: f.filename ?? null, line: f.line ?? null };
  }

  async #locals(frame) {
    try {
      const vars = await this.session.variables([frame, 1]);
      return (vars ?? []).filter(v => /^[A-Za-z_$#]/.test(v.name)).map(v => ({ name: v.name, value: v.value, type: v.type }));
    } catch(e) {
      return [];
    }
  }

  async #onStopped(ev, watch = null, haveStack = true) {
    if(!haveStack) this.stack = await this.session.stackTrace();
    this.currentFrame = 0;

    const f = this.stack[0] ?? {};
    this.listFile = f.filename ?? this.listFile;
    this.listNext = null;

    const reason = /^step/i.test(ev.reason ?? '') ? 'step' : (ev.reason ?? 'unknown');
    let hitBp = null;

    if(reason == 'step') {
      /* stepping: gdb prints just the new source line */
      if(this.echoSourceLine && !this.#printSourceLine(f.filename, f.line)) this.#printFrame(f);
    } else {
      let prefix = '';
      if(reason == 'breakpoint') {
        const bp = this.#breakpointsAt(f)[0];
        if(bp) {
          hitBp = bp;
          prefix = `${bp.temp ? 'Temporary breakpoint' : 'Breakpoint'} ${bp.num}, `;

          if(bp.temp) {
            this.breakpoints = this.breakpoints.filter(b => b !== bp);
            this.#sendBreakpoints(bp.file);
          }
        }
      } else if(reason == 'exception') prefix = 'Stopped on exception, ';
      else if(reason == 'pause') prefix = 'Program interrupted, ';
      else if(reason == 'watchpoint') {
        this.print(`\nWatchpoint ${watch.num}: ${watch.expr}\n\nOld value = ${watch.old}\nNew value = ${watch.new}`);
        prefix = '';
      }

      this.print(`${prefix}${f.name ?? '??'} () at ${f.filename ?? '??'}:${f.line ?? '?'}`);
      if(this.echoSourceLine) this.#printSourceLine(f.filename, f.line);
    }

    if(this.echoDisplays) await this.#showDisplays();

    const record = { type: 'stopped', reason, ...(hitBp ? { breakpoint: hitBp.num } : {}), ...(watch ? { watchpoint: watch } : {}), ...Debugger.frameRecord(f, 0) };

    if(this.collectState) {
      const lines = this.#sourceLines(f.filename);
      if(lines && f.line >= 1 && f.line <= lines.length) record.source = lines[f.line - 1];
      record.stack = this.stack.map(Debugger.frameRecord);
      record.locals = await this.#locals(f.id ?? 0);
      if(this.displays.length) record.displays = await this.#displayValues();
    }

    this.lastStop = record;

    /* fill the completion cache in the background; the prompt need not wait */
    if(this.completion) this.#refreshIdentifiers().catch(() => {});

    this.onEvent?.('stopped');
    return this.report(record);
  }

  async #refreshIdentifiers() {
    if(!this.session || !this.stack.length) {
      this.identifiers = [];
      return;
    }

    const frame = this.stack[this.currentFrame]?.id ?? 0;
    const names = new Set();

    for(const scope of [1, 2, 0] /* local, closure, global */) {
      try {
        const vars = await this.session.variables([frame, scope]);
        for(const v of vars ?? []) if(/^[A-Za-z_$][\w$]*$/.test(v.name)) names.add(v.name);
      } catch(e) {}
    }

    this.identifiers = [...names];
  }

  interrupt() {
    this.session?.request('pause').catch(() => {});
  }

  /* ---------------- breakpoints ---------------- */

  /* the engine scans pc2line forward and expects the list sorted by line */
  #sendBreakpoints(file) {
    this.session?.breakpoints(
      file,
      this.breakpoints
        .filter(b => b.file == file)
        .map(b => ({ line: b.line }))
        .sort((a, b) => a.line - b.line),
    );
  }

  /** Public accessor for GUI views (file picker). */
  sourceFiles() {
    return this.#sourceFiles();
  }

  /** All source files reachable from the program via relative imports. */
  #sourceFiles() {
    const files = [];
    const seen = new Set();
    const queue = [];

    if(this.program) queue.push(this.program);
    for(const f of this.stack) if(f.filename) queue.push(f.filename);

    while(queue.length) {
      const file = queue.shift();
      if(seen.has(file)) continue;
      seen.add(file);
      if(!exists(file)) continue;
      files.push(file);
      queue.push(...ScanImports(file));
    }

    return files;
  }

  /* a function declared as `function f(a) {` breaks on its first body line;
     the declaration line itself also runs when the enclosing scope is entered */
  #entryLine(file, line) {
    const lines = this.#sourceLines(file);
    if(!lines || !/\{\s*$/.test(lines[line - 1] ?? '')) return line;

    for(let n = line; n < lines.length; n++) {
      const text = lines[n].trim();
      /* `let a, b;` without initializers compiles to no code, a breakpoint there never fires */
      if(text && !text.startsWith('//') && !/^(?:let|var)\s+[\w$]+(?:\s*,\s*[\w$]+)*\s*;?\s*(?:\/\/.*)?$/.test(text)) return n + 1;
    }
    return line;
  }

  #findFunctionIn(file, name) {
    let text;
    try {
      text = readFileSync(file, 'utf-8');
    } catch(e) {
      return null;
    }

    for(const { key, line } of ScanFunctions(text)) if(key == name) return { file, line: this.#entryLine(file, line) };
    return null;
  }

  #findFunction(name) {
    const matches = [];

    for(const file of this.#sourceFiles()) {
      let text;
      try {
        text = readFileSync(file, 'utf-8');
      } catch(e) {
        continue;
      }

      for(const { key, line } of ScanFunctions(text)) if(key == name) matches.push({ file, line: this.#entryLine(file, line) });
    }

    /* bare method name: fall back to Class.prototype.name */
    if(!matches.length && !name.includes('.')) {
      const suffix = '.prototype.' + name;
      for(const file of this.#sourceFiles()) {
        let text;
        try {
          text = readFileSync(file, 'utf-8');
        } catch(e) {
          continue;
        }
        for(const { key, line } of ScanFunctions(text)) if(key.endsWith(suffix)) matches.push({ file, line: this.#entryLine(file, line) });
      }
    }

    return matches[0] ?? null;
  }

  resolveLocation(spec) {
    let m;

    if((m = spec.match(/^(.+):(\d+)$/))) return { file: m[1], line: +m[2] };

    if(/^\d+$/.test(spec)) {
      const file = this.stack[this.currentFrame]?.filename ?? this.program;
      if(!file) throw new Error('No default source file.');
      return { file, line: +spec };
    }

    return this.#findFunction(spec);
  }

  /* ---------------- commands ---------------- */

  cmdFile(arg) {
    if(!arg) {
      this.print(this.program ? `Program: ${this.program}` : 'No executable file now.');
      return { program: this.program };
    }
    this.setProgram(arg);
    return { program: this.program };
  }

  async cmdRun(arg) {
    return this.#outcome(await this.#start(arg, true));
  }

  async cmdStart(arg) {
    /* gdb semantics: temporary breakpoint on main() and run. Without a
       main() in the primary source, stop at the first top-level
       statement instead (the entry stop). */
    const loc = this.program && this.#findFunctionIn(this.program, 'main');
    if(!loc) return this.cmdStarti(arg);

    const bp = { num: this.nextBpNum++, ...loc, spec: 'main', temp: true };
    this.breakpoints.push(bp);
    this.print(`Temporary breakpoint ${bp.num} at ${bp.file}:${bp.line}`);
    this.#sendBreakpoints(bp.file);

    return this.#outcome(await this.#start(arg, true));
  }

  async cmdStarti(arg) {
    return this.#outcome(await this.#start(arg, false));
  }

  /** the outcome of a resuming command: the final state as a result payload */
  #outcome(record) {
    if(!record) return {};
    if(record.type == 'exited') return { state: 'exited', code: record.code, signal: record.signal };
    return { state: 'stopped', reason: record.reason, file: record.file, line: record.line, function: record.function };
  }

  async #start(arg, resume) {
    if(!this.program && !this.external) {
      this.#fail('No executable file specified.\nUse the "file" command.');
      return null;
    }

    if(this.session) this.cmdKill('');
    if(arg) this.programArgs = splitArgs(arg);

    if(!this.external) this.print(`Starting program: ${this.interpreter} ${[this.program, ...this.programArgs].join(' ')}`);
    this.onEvent?.('running');

    const entry = await this.launchEngine();
    if(!entry) return this.lastStop;

    if(resume) return this.#resume('continue');
    return this.#onStopped(entry, null, false);
  }

  /** shape of a breakpoint in records */
  static breakpointRecord(b) {
    return { num: b.num, file: b.file, line: b.line, spec: b.spec, ...(b.condition ? { condition: b.condition } : {}), ...(b.temp ? { temp: true } : {}) };
  }

  /**
   * break: set a breakpoint; returns its record, null when the location is unknown
   * (the error is printed and recorded like a failed command).
   *
   * ```js
   * dbg.break('d.js:3');                   // file:line
   * dbg.break('f', { condition: 'a > 5' }) // function name, only when a > 5
   * ```
   */
  break(spec, { condition, temp = false } = {}) {
    if(!spec) {
      const f = this.stack[this.currentFrame];
      if(!f) {
        this.#fail('No default breakpoint location.');
        return null;
      }
      spec = `${f.filename}:${f.line}`;
    }

    const loc = this.resolveLocation(spec);
    if(!loc) {
      this.#fail(`Function "${spec}" not defined.`);
      return null;
    }

    const bp = { num: this.nextBpNum++, ...loc, spec, ...(condition ? { condition } : {}), ...(temp ? { temp: true } : {}) };
    this.breakpoints.push(bp);
    this.print(`${temp ? 'Temporary breakpoint' : 'Breakpoint'} ${bp.num} at ${bp.file}:${bp.line}${condition ? ` if ${condition}` : ''}`);
    this.#sendBreakpoints(bp.file);
    return Debugger.breakpointRecord(bp);
  }

  /** `LOCATION [if EXPR]` split into the break() arguments */
  static parseBreak(arg) {
    const m = arg.match(/^(.*?)\s*\bif\s+(.+)$/s);
    return m ? [m[1].trim(), { condition: m[2].trim() }] : [arg, {}];
  }

  cmdBreak(arg) {
    const [spec, options] = Debugger.parseBreak(arg);
    const breakpoint = this.break(spec, options);
    return breakpoint ? { breakpoint } : undefined;
  }

  cmdTbreak(arg) {
    const [spec, options] = Debugger.parseBreak(arg);
    const breakpoint = this.break(spec, { ...options, temp: true });
    return breakpoint ? { breakpoint } : undefined;
  }

  tbreak(spec, options = {}) {
    return this.break(spec, { ...options, temp: true });
  }

  cmdWatch(arg) {
    if(!arg) {
      this.#fail('Argument required (expression to watch).');
      return;
    }

    const w = { num: this.nextBpNum++, expr: arg, last: undefined };
    this.watches.push(w);
    this.print(`Watchpoint ${w.num}: ${arg}`);

    /* take the initial value now when stopped, else at the first stop */
    if(this.session && this.stack.length) return this.#watchValue(w).then(v => ((w.last = v), { watchpoint: { num: w.num, expr: w.expr, value: v } }));
    return { watchpoint: { num: w.num, expr: w.expr } };
  }

  /** Add or remove a breakpoint at file:line (GUI gutter click). */
  toggleBreakpoint(file, line) {
    const i = this.breakpoints.findIndex(b => b.file == file && b.line == line);

    if(i >= 0) {
      const [bp] = this.breakpoints.splice(i, 1);
      this.print(`Deleted breakpoint ${bp.num}`);
    } else {
      const bp = { num: this.nextBpNum++, file, line, spec: `${file}:${line}` };
      this.breakpoints.push(bp);
      this.print(`Breakpoint ${bp.num} at ${bp.file}:${bp.line}`);
    }

    this.#sendBreakpoints(file);
  }

  cmdDelete(arg) {
    let doomed;

    if(!arg) {
      doomed = this.breakpoints;
      this.breakpoints = [];
    } else {
      const nums = arg.split(/[\s,]+/).map(Number);
      doomed = this.breakpoints.filter(b => nums.includes(b.num));
      this.breakpoints = this.breakpoints.filter(b => !nums.includes(b.num));
    }

    for(const file of new Set(doomed.map(b => b.file))) this.#sendBreakpoints(file);

    const nums = arg ? arg.split(/[\s,]+/).map(Number) : null;
    const gone = this.watches.filter(w => !nums || nums.includes(w.num));
    this.watches = this.watches.filter(w => !gone.includes(w));

    return { deleted: [...doomed, ...gone].map(b => b.num) };
  }

  cmdCatch(arg) {
    this.stopOnException = arg != 'off';
    this.session?.stopOnException(this.stopOnException);
    this.print(`Catchpoint on exceptions ${this.stopOnException ? 'enabled' : 'disabled'}.`);
    return { catch: this.stopOnException };
  }

  /* resuming API: each returns the 'stopped' or 'exited' record */
  continue() {
    return this.#resume('continue');
  }

  next() {
    return this.#resume('next');
  }

  step() {
    return this.#resume('stepIn');
  }

  finish() {
    return this.#resume('stepOut');
  }

  async cmdContinue() {
    return this.#outcome(await this.continue());
  }

  async cmdNext() {
    return this.#outcome(await this.next());
  }

  async cmdStep() {
    return this.#outcome(await this.step());
  }

  async cmdFinish() {
    return this.#outcome(await this.finish());
  }

  /**
   * until: run to LOCATION (a temporary breakpoint plus continue); without
   * one, `next` until the line is past the current one or the frame changed,
   * which steps out of loop back-jumps.
   */
  async until(spec) {
    if(!this.session) {
      this.#fail('The program is not being run.');
      return null;
    }

    if(spec) {
      if(!this.tbreak(spec)) return null;
      return this.continue();
    }

    const start = this.stack[0];
    const depth = this.stack.length;
    for(;;) {
      const stop = await this.#nextStop('next');
      if(!stop) return this.#terminated();

      const f = this.stack[0];
      if(/^step/i.test(stop.ev.reason ?? '') && !stop.watch && this.stack.length == depth && f.filename == start.filename && f.line <= start.line) continue;
      return this.#onStopped(stop.ev, stop.watch);
    }
  }

  async cmdUntil(arg) {
    return this.#outcome(await this.until(arg));
  }

  /** the call stack of the last stop, as records */
  backtrace() {
    return this.stack.map(Debugger.frameRecord);
  }

  cmdBacktrace() {
    if(!this.#requireStopped()) return;
    for(const f of this.stack) this.#printFrame(f);
    return { stack: this.backtrace() };
  }

  cmdFrame(arg) {
    if(!this.#requireStopped()) return;

    if(arg) {
      const n = +arg;
      if(!(n >= 0 && n < this.stack.length)) {
        this.#fail('No such frame.');
        return;
      }
      this.currentFrame = n;
    }

    return this.#showFrame();
  }

  #showFrame() {
    const f = this.stack[this.currentFrame];
    this.#printFrame(f);
    this.#printSourceLine(f.filename, f.line);
    const lines = this.#sourceLines(f.filename);
    return { frame: Debugger.frameRecord(f, this.currentFrame), ...(lines?.[f.line - 1] !== undefined ? { source: lines[f.line - 1] } : {}) };
  }

  cmdUp(arg) {
    return this.#shiftFrame(+(arg || 1));
  }

  cmdDown(arg) {
    return this.#shiftFrame(-(arg || 1));
  }

  #shiftFrame(n) {
    if(!this.#requireStopped()) return;

    const dest = this.currentFrame + n;
    if(dest < 0) {
      this.#fail('Bottom (innermost) frame selected; you cannot go down.');
      return;
    }
    if(dest >= this.stack.length) {
      this.#fail('Initial frame selected; you cannot go up.');
      return;
    }

    this.currentFrame = dest;
    return this.#showFrame();
  }

  async #evalExpression(expr) {
    const frame = this.stack[this.currentFrame]?.id ?? 0;
    const body = await this.session.evaluate(expr, frame);
    return body?.result ?? body?.value ?? inspect(body, { colors: false });
  }

  /**
   * eval: evaluate an expression in the selected frame; returns
   * { value, text, type, exception? } where `value` is typed (number,
   * boolean, null, string) and `text` is the engine's string form.
   *
   * ```js
   * (await dbg.eval('a * 2')).value   // 40
   * ```
   *
   * throws Error when the program is not stopped. An expression that throws
   * gives { exception: true } with the error text.
   */
  async eval(expr) {
    if(!this.session || !this.stack.length) throw new Error('The program is not being run.');

    const frame = this.stack[this.currentFrame]?.id ?? 0;
    const body = await this.session.evaluate(expr, frame);
    const text = `${body?.result ?? body?.value ?? inspect(body, { colors: false })}`;
    const type = body?.type ?? 'undefined';
    let value = text;

    switch (type) {
      case 'integer':
      case 'float':
        value = +text;
        break;
      case 'boolean':
        value = text == 'true';
        break;
      case 'null':
        value = null;
        break;
      case 'undefined':
        value = undefined;
        break;
    }

    /* the engine reports a thrown exception as an ordinary object result */
    const exception = type == 'object' && /^[A-Za-z]*Error\b/.test(text);
    return { value, text, type, ...(exception ? { exception } : {}) };
  }

  /** an eval() result as a command-result payload (`type` is taken by the record) */
  static valueResult(expr, { value, text, type, exception }) {
    return { expr, value, text, valueType: type, ...(exception ? { exception } : {}) };
  }

  async cmdPrint(arg) {
    if(!arg) {
      this.#fail('Argument required (expression to print).');
      return;
    }
    if(!this.#requireStopped()) return;

    const r = await this.eval(arg);
    const n = ++this.valueCounter;
    this.print(`$${n} = ${r.text}`);
    return { n, ...Debugger.valueResult(arg, r) };
  }

  async cmdEval(arg) {
    if(!arg) {
      this.#fail('Argument required (expression to evaluate).');
      return;
    }
    if(!this.#requireStopped()) return;

    const r = await this.eval(arg);
    this.print(r.text);
    return Debugger.valueResult(arg, r);
  }

  async cmdCall(arg) {
    if(!arg) {
      this.#fail('The history is empty.');
      return;
    }
    if(!this.#requireStopped()) return;

    const r = await this.eval(arg);
    if(r.type != 'undefined') this.print(`$${++this.valueCounter} = ${r.text}`);
    return Debugger.valueResult(arg, r);
  }

  cmdEcho(arg) {
    const text = arg.replace(/\\(n|t|\\)/g, (m, c) => ({ n: '\n', t: '\t', '\\': '\\' })[c]);
    this.printRaw(text, 'echo');
    return { text };
  }

  async cmdDisplay(arg) {
    if(!arg) {
      /* bare `display`: print the values of all displays now */
      if(!this.#requireStopped()) return;
      await this.#showDisplays();
      return { displays: await this.#displayValues() };
    }

    const d = { num: this.nextDisplayNum++, expr: arg };
    this.displays.push(d);
    if(this.echoDisplays && this.session && this.stack.length) await this.#showDisplay(d);
    return { display: { num: d.num, expr: d.expr } };
  }

  cmdUndisplay(arg) {
    if(!arg) {
      this.displays = [];
      return {};
    }

    const nums = arg.split(/[\s,]+/).map(Number);
    this.displays = this.displays.filter(d => !nums.includes(d.num));
    return {};
  }

  async #showDisplay(d) {
    let value;
    try {
      value = await this.#evalExpression(d.expr);
    } catch(e) {
      value = `<error: ${e.message}>`;
    }
    this.print(`${d.num}: ${d.expr} = ${value}`);
    return value;
  }

  async #showDisplays() {
    for(const d of this.displays) await this.#showDisplay(d);
  }

  /** current value of every auto-display, without printing */
  async #displayValues() {
    const out = [];
    for(const d of this.displays) {
      let value;
      try {
        value = await this.#evalExpression(d.expr);
      } catch(e) {
        value = `<error: ${e.message}>`;
      }
      out.push({ num: d.num, expr: d.expr, value });
    }
    return out;
  }

  cmdList(arg) {
    let file, start;

    if(arg) {
      const loc = this.resolveLocation(arg);
      if(!loc) {
        this.#fail(`Function "${arg}" not defined.`);
        return;
      }
      file = loc.file;
      start = Math.max(1, loc.line - 5);
    } else {
      file = this.listFile ?? this.program;
      start = this.listNext ?? Math.max(1, (this.stack[this.currentFrame]?.line ?? 6) - 5);
    }

    const lines = this.#sourceLines(file);
    if(!lines) {
      this.#fail(file ? `No source file named ${file}.` : 'No default source file.');
      return;
    }

    const shown = [];
    for(let n = start; n < start + 10 && n <= lines.length; n++) {
      this.print(`${n}\t${lines[n - 1]}`);
      shown.push({ n, text: lines[n - 1] });
    }

    this.listFile = file;
    this.listNext = Math.min(start + 10, lines.length + 1);
    return { file, lines: shown };
  }

  async cmdInfo(arg) {
    const what = arg.split(/\s+/)[0] || '';
    const is = word => what && word.startsWith(what);

    if(is('breakpoints') || is('watchpoints')) {
      const breakpoints = this.breakpoints.map(Debugger.breakpointRecord);
      const watchpoints = this.watches.map(w => ({ num: w.num, expr: w.expr }));
      if(!breakpoints.length && !watchpoints.length) {
        this.print('No breakpoints or watchpoints.');
        return { breakpoints, watchpoints };
      }
      this.print('Num     Type           What');
      for(const b of this.breakpoints) this.print(`${String(b.num).padEnd(8)}${b.temp ? 'tbreakpoint    ' : 'breakpoint     '}${b.file}:${b.line}${b.spec != `${b.file}:${b.line}` ? ` (${b.spec})` : ''}${b.condition ? ` if ${b.condition}` : ''}`);
      for(const w of this.watches) this.print(`${String(w.num).padEnd(8)}watchpoint     ${w.expr}`);
      return { breakpoints, watchpoints };
    } else if(is('locals')) {
      if(!this.#requireStopped()) return;
      const frame = this.stack[this.currentFrame]?.id ?? 0;
      const vars = await this.session.variables([frame, 1]);
      if(!vars?.length) this.print('No locals.');
      else for(const v of vars) this.print(`${v.name} = ${v.value}`);
      return { locals: await this.#locals(frame) };
    } else if(is('stack')) {
      return this.cmdBacktrace();
    } else if(is('frame')) {
      return this.cmdFrame('');
    } else if(is('args')) {
      this.print(`Argument list to give program when started is "${this.programArgs.join(' ')}".`);
      return { args: this.programArgs };
    } else if(is('display')) {
      if(!this.displays.length) {
        this.print('There are no auto-display expressions now.');
        return { displays: [] };
      }
      this.print('Num Expression');
      for(const d of this.displays) this.print(`${String(d.num).padEnd(4)}${d.expr}`);
      return { displays: this.displays.map(d => ({ num: d.num, expr: d.expr })) };
    } else if(is('source')) {
      const f = this.stack[this.currentFrame];
      const file = f?.filename ?? this.listFile ?? this.program;
      const lines = this.#sourceLines(file);
      if(!file) {
        this.print('No current source file.');
        return { program: this.program };
      }
      this.print(`Current source file is ${file}`);
      if(lines) this.print(`Contains ${lines.length} line${lines.length == 1 ? '' : 's'}.`);
      this.print(`Program: ${this.program ?? '(none)'}`);
      return { file, line: f?.line ?? null, lines: lines?.length ?? null, program: this.program, sources: this.sourceFiles() };
    } else if(is('program')) {
      const state = this.session ? (this.stack.length ? 'stopped' : 'running') : 'not running';
      this.print(`Program ${this.program ?? '(none)'}: ${state}${this.child?.pid ? `, process ${this.child.pid}` : ''}.`);
      if(this.exitCode !== null && !this.session) this.print(`It exited with status ${this.exitCode}.`);
      return { program: this.program, state: this.session ? (this.stack.length ? 'stopped' : 'running') : 'exited', pid: this.child?.pid ?? null, exitCode: this.exitCode };
    }

    this.#fail('Usage: info breakpoints|locals|stack|frame|args|display|source|program');
  }

  async cmdSet(arg) {
    let m;

    if((m = arg.match(/^args(?:\s+(.*))?$/s))) {
      this.programArgs = m[1] ? splitArgs(m[1]) : [];
      return { args: this.programArgs };
    }

    if((m = arg.match(/^var(?:iable)?\s+(.+)$/s))) {
      if(!this.#requireStopped()) return;
      return Debugger.valueResult(m[1], await this.eval(m[1]));
    }

    /* gdb settings scripts habitually set; nothing here depends on them */
    if(/^(confirm|pagination|width|height|listsize|print|style|verbose|logging)\b/.test(arg)) return { ignored: true };

    this.#fail('Usage: set args ARG... | set var NAME=EXPR');
  }

  cmdInterrupt() {
    if(!this.session) {
      this.#fail('The program is not being run.');
      return;
    }
    this.interrupt();
    return {};
  }

  cmdKill() {
    if(!this.child) {
      this.#fail('The program is not being run.');
      return;
    }

    const { child } = this;
    this.connection?.close();
    child.kill?.();
    child.wait?.();
    drainOutput(child.stdout, s => this.#output(s, 'stdout'));
    drainOutput(child.stderr, s => this.#output(s, 'stderr'));
    this.print(child.external ? '[Debuggee detached]' : `[Inferior (process ${child.pid}) killed]`);
    this.child = this.connection = this.session = null;
    this.stack = [];
    this.currentFrame = 0;
    this.lastStop = { type: 'exited', code: null, signal: child.external ? null : 'SIGKILL', killed: true };
    this.report(this.lastStop);
    return { killed: true };
  }

  cmdQuit(arg) {
    const code = arg ? +arg : undefined;
    if(this.child) this.cmdKill();
    if(this.onQuit) this.onQuit(code);
    else exit(code ?? 0);
    return { code };
  }

  cmdHelp() {
    for(const [name, [, help]] of Object.entries(Debugger.commands)) this.print(help ?? name);
    this.print('\nEmpty line repeats the last stepping command. JS directives: prefix with "\\".');
    return { commands: Object.keys(Debugger.commands) };
  }

  /* ---------------- library API ---------------- */

  /**
   * launch: start `program` with the debugger armed and stop at its first
   * statement; returns the 'stopped' record (reason 'entry').
   *
   * ```js
   * const stop = await dbg.launch('script.js', ['a', 'b']);
   * await dbg.launch('script.js', [], { run: true });  // run to the first breakpoint or exit
   * ```
   *
   *   string   program        script to debug
   *   string[] args           its arguments
   *   boolean  options.run    continue past the entry stop
   *
   * returns the 'stopped' record, or 'exited' when the program ended first
   */
  async launch(program, args = [], { run = false } = {}) {
    if(program) this.setProgram(program, args);
    this.external = false;
    if(this.session) this.cmdKill();

    this.lastError = null;
    const record = await this.#start('', run);
    if(this.lastError) throw new Error(this.lastError);
    return record;
  }

  /** the variables of a frame (default: selected) as { name, value, type } records */
  async locals(frame = this.stack[this.currentFrame]?.id ?? 0) {
    if(!this.session) throw new Error('The program is not being run.');
    return this.#locals(frame);
  }

  /** kill the debuggee (if any) and drop the connection */
  close() {
    if(this.child) this.cmdKill();
  }

  /* ---------------- helpers ---------------- */

  #requireStopped() {
    if(!this.session) {
      this.#fail('The program is not being run.');
      return false;
    }
    if(!this.stack.length) {
      this.#fail('No stack.');
      return false;
    }
    return true;
  }

  #printFrame(f) {
    const marker = f.id == this.stack[this.currentFrame]?.id ? '' : ' ';
    this.print(`#${f.id}${marker} ${f.name ?? '??'} () at ${f.filename ?? '??'}:${f.line ?? '?'}`);
  }

  #sourceLines(file) {
    if(!file) return null;
    if(!this.#sourceCache.has(file)) {
      let lines = null;
      try {
        lines = readFileSync(file, 'utf-8').split('\n');
      } catch(e) {}
      this.#sourceCache.set(file, lines);
    }
    return this.#sourceCache.get(file);
  }

  #printSourceLine(file, line) {
    const lines = this.#sourceLines(file);
    if(!lines || !(line >= 1 && line <= lines.length)) return false;
    this.print(`${line}\t${lines[line - 1]}`);
    return true;
  }
}

/* ------------------------------------------------------------------ *
 *  plumbing                                                           *
 * ------------------------------------------------------------------ */

function forwardOutput(fd, write) {
  if(typeof fd != 'number' || fd < 0) return;

  const buf = new ArrayBuffer(4096);
  const decoder = new TextDecoder();

  setReadHandler(fd, () => {
    const r = osRead(fd, buf, 0, buf.byteLength);
    if(r > 0) {
      try {
        write(decoder.decode(new Uint8Array(buf, 0, r)));
      } catch(e) {
        /* fd got reused for something else (e.g. a qjs-lws socket) while this
           handler was still registered; the bytes aren't ours to decode */
        setReadHandler(fd, null);
      }
    } else setReadHandler(fd, null);
  });
}

/* after the child died: flush what is still buffered in its stdio pipes */
function drainOutput(fd, write) {
  if(typeof fd != 'number' || fd < 0) return;

  setReadHandler(fd, null);

  const buf = new ArrayBuffer(4096);
  const decoder = new TextDecoder();

  for(let i = 0; i < 256; i++) {
    let r;
    try {
      r = osRead(fd, buf, 0, buf.byteLength);
    } catch(e) {
      break;
    }
    if(r <= 0) break;
    try {
      write(decoder.decode(new Uint8Array(buf, 0, r)));
    } catch(e) {
      break;
    }
  }
}

function splitArgs(str) {
  const args = [];
  const re = /'([^']*)'|"([^"]*)"|(\S+)/g;
  let m;
  while((m = re.exec(str))) args.push(m[1] ?? m[2] ?? m[3]);
  return args;
}
