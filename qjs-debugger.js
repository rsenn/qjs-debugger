#!/usr/bin/env qjsm
/**
 * qjs-debugger — gdb-style command line debugger for QuickJS.
 *
 * Installed as bin/qjs-debugger and bin/qjsm-debugger; the name decides
 * which interpreter is spawned for the debuggee (qjs or qjsm).
 *
 * Modes: repl (default, implemented), server, gui (stubs).
 *
 * Usage:
 *   qjs-debugger script.js
 *   qjs-debugger --args script.js arg1 arg2 ...
 */
import { readFileSync } from 'fs';
import * as io from 'io';
import { clearTimeout as osClearTimeout, read as osRead, setReadHandler, setTimeout as osSetTimeout } from 'os';
import { basename, dirname, exists, join } from 'path';
import { REPL } from 'repl';
import { exit, out as stdout, puts } from 'std';
import { TextDecoder } from 'textcode';
import inspect from 'inspect';
import process from 'process';
import Console from 'console';
import { EngineConnection, StartEngine } from './engine-connection.js';
import { SocketTransport, StreamTransport } from './transport.js';

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

  #sourceCache = new Map();
  #closed = null;

  print = (...args) => console.log(...args);
  printRaw = s => (puts(s), stdout.flush());
  onEvent = null; /* (kind: 'running' | 'stopped' | 'exited') => {} — for GUI views */
  echoSourceLine = true; /* print the stopped-at source line (off in GUI: the source pane shows it) */
  echoDisplays = true; /* print auto-displays at every stop (off in GUI: the watches pane shows them) */

  constructor({ interpreter = 'qjs', address = '127.0.0.1:9901', listen = true, transport = SocketTransport } = {}) {
    this.interpreter = interpreter;
    this.address = address;
    this.listen = listen; /* true: we accept, engine connects out; false: engine listens, we connect */
    this.transport = transport;
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
    start: ['cmdStart', 'start -- run and stop at program entry', false],
    break: ['cmdBreak', 'break [FILE:]LINE | FUNCTION | Class.prototype.method -- set breakpoint (b)', false],
    delete: ['cmdDelete', 'delete [NUM...] -- delete breakpoints (d)', false],
    catch: ['cmdCatch', 'catch [throw|off] -- stop on exceptions', false],
    continue: ['cmdContinue', 'continue -- resume execution (c)', true],
    next: ['cmdNext', 'next -- step over (n)', true],
    step: ['cmdStep', 'step -- step into (s)', true],
    finish: ['cmdFinish', 'finish -- step out of current function(fin)', true],
    backtrace: ['cmdBacktrace', 'backtrace -- print call stack (bt, where)', false],
    frame: ['cmdFrame', 'frame [NUM] -- select stack frame (f)', false],
    up: ['cmdUp', 'up [N] -- select caller frame', true],
    down: ['cmdDown', 'down [N] -- select callee frame', true],
    print: ['cmdPrint', 'print EXPR -- evaluate expression in selected frame (p)', false],
    display: ['cmdDisplay', 'display [EXPR] -- print EXPR at every stop; alone: print all displays', false],
    undisplay: ['cmdUndisplay', 'undisplay [NUM...] -- remove auto-display expressions', false],
    list: ['cmdList', 'list [LOCATION] -- show source (l)', true],
    info: ['cmdInfo', 'info breakpoints|locals|frame|stack|display', false],
    set: ['cmdSet', 'set args ARG... -- set program arguments', false],
    interrupt: ['cmdInterrupt', 'interrupt -- pause the running program', false],
    kill: ['cmdKill', 'kill -- kill the debugged program', false],
    quit: ['cmdQuit', 'quit -- exit the debugger (q)', false],
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
    const name = this.resolveCommand(word);

    if(!name) {
      this.print(`Undefined command: "${word}".  Try "help".`);
      return;
    }

    const [method, , repeatable] = Debugger.commands[name];
    this.lastRepeat = repeatable ? line : null;

    this.busy = true;
    try {
      await this[method](rest.trim());
    } finally {
      this.busy = false;
    }
  }

  /* ---------------- target lifecycle ---------------- */

  async launch() {
    this.#sourceCache.clear();

    const args = [this.program, ...this.programArgs];

    const spawnEngine = () => {
      const { child } = StartEngine(args, this.address, {
        listen: !this.listen,
        interpreter: this.interpreter,
        env: process.env,
      });
      this.child = child;

      forwardOutput(child.stdout, this.printRaw);
      forwardOutput(child.stderr, this.printRaw);
    };

    try {
      if(this.listen) {
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

  #terminated() {
    if(!this.child) return;

    const status = this.child.wait?.();
    const pid = this.child.pid;

    drainOutput(this.child.stdout, this.printRaw);
    drainOutput(this.child.stderr, this.printRaw);

    if(status?.signalCode != null) this.print(`[Inferior (process ${pid}) killed by signal ${status.signalCode}]`);
    else if(status?.exitCode) this.print(`[Inferior (process ${pid}) exited with code ${status.exitCode}]`);
    else this.print(`[Inferior (process ${pid}) exited normally]`);

    this.connection?.close();
    this.child = this.connection = this.session = null;
    this.stack = [];
    this.currentFrame = 0;
    this.identifiers = [];
    this.onEvent?.('exited');
  }

  /** Send a resuming request and wait for the next stop (or program exit). */
  async #resume(command) {
    if(!this.session) {
      this.print('The program is not being run.');
      return;
    }

    this.onEvent?.('running');
    const stopped = this.session.waitEvent('stopped');

    try {
      await this.session.request(command);
    } catch(e) {
      /* rejected by session.abort() when the program exits mid-request */
    }

    const ev = await Promise.race([stopped, this.#closed]);
    if(ev?.closed) {
      this.#terminated();
      return;
    }

    await this.#onStopped(ev);
  }

  async #onStopped(ev) {
    this.stack = await this.session.stackTrace();
    this.currentFrame = 0;

    const f = this.stack[0] ?? {};
    this.listFile = f.filename ?? this.listFile;
    this.listNext = null;

    if(/^step/i.test(ev.reason ?? '')) {
      /* stepping: gdb prints just the new source line */
      if(this.echoSourceLine && !this.#printSourceLine(f.filename, f.line)) this.#printFrame(f);
    } else {
      let prefix = '';
      if(ev.reason == 'breakpoint') {
        const bp = this.breakpoints.find(b => b.file == f.filename && b.line == f.line);
        if(bp) prefix = `Breakpoint ${bp.num}, `;
      } else if(ev.reason == 'exception') prefix = 'Stopped on exception, ';
      else if(ev.reason == 'pause') prefix = 'Program interrupted, ';

      this.print(`${prefix}${f.name ?? '??'} () at ${f.filename ?? '??'}:${f.line ?? '?'}`);
      if(this.echoSourceLine) this.#printSourceLine(f.filename, f.line);
    }

    if(this.echoDisplays) await this.#showDisplays();

    /* fill the completion cache in the background; the prompt need not wait */
    this.#refreshIdentifiers().catch(() => {});

    this.onEvent?.('stopped');
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

  #findFunction(name) {
    const matches = [];

    for(const file of this.#sourceFiles()) {
      let text;
      try {
        text = readFileSync(file, 'utf-8');
      } catch(e) {
        continue;
      }

      for(const { key, line } of ScanFunctions(text)) if(key == name) matches.push({ file, line });
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
        for(const { key, line } of ScanFunctions(text)) if(key.endsWith(suffix)) matches.push({ file, line });
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
      return;
    }
    this.setProgram(arg);
  }

  async cmdRun(arg) {
    await this.#start(arg, true);
  }

  async cmdStart(arg) {
    await this.#start(arg, false);
  }

  async #start(arg, resume) {
    if(!this.program) {
      this.print('No executable file specified.\nUse the "file" command.');
      return;
    }

    if(this.session) this.cmdKill('');
    if(arg) this.programArgs = splitArgs(arg);

    this.print(`Starting program: ${this.interpreter} ${[this.program, ...this.programArgs].join(' ')}`);
    this.onEvent?.('running');

    const entry = await this.launch();
    if(!entry) return;

    if(resume) await this.#resume('continue');
    else await this.#onStopped(entry);
  }

  cmdBreak(arg) {
    if(!arg) {
      const f = this.stack[this.currentFrame];
      if(!f) {
        this.print('No default breakpoint location.');
        return;
      }
      arg = `${f.filename}:${f.line}`;
    }

    const loc = this.resolveLocation(arg);
    if(!loc) {
      this.print(`Function "${arg}" not defined.`);
      return;
    }

    const bp = { num: this.nextBpNum++, ...loc, spec: arg };
    this.breakpoints.push(bp);
    this.print(`Breakpoint ${bp.num} at ${bp.file}:${bp.line}`);
    this.#sendBreakpoints(bp.file);
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
  }

  cmdCatch(arg) {
    this.stopOnException = arg != 'off';
    this.session?.stopOnException(this.stopOnException);
    this.print(`Catchpoint on exceptions ${this.stopOnException ? 'enabled' : 'disabled'}.`);
  }

  async cmdContinue() {
    await this.#resume('continue');
  }

  async cmdNext() {
    await this.#resume('next');
  }

  async cmdStep() {
    await this.#resume('stepIn');
  }

  async cmdFinish() {
    await this.#resume('stepOut');
  }

  cmdBacktrace() {
    if(!this.#requireStopped()) return;
    for(const f of this.stack) this.#printFrame(f);
  }

  cmdFrame(arg) {
    if(!this.#requireStopped()) return;

    if(arg) {
      const n = +arg;
      if(!(n >= 0 && n < this.stack.length)) {
        this.print('No such frame.');
        return;
      }
      this.currentFrame = n;
    }

    const f = this.stack[this.currentFrame];
    this.#printFrame(f);
    this.#printSourceLine(f.filename, f.line);
  }

  cmdUp(arg) {
    this.#shiftFrame(+(arg || 1));
  }

  cmdDown(arg) {
    this.#shiftFrame(-(arg || 1));
  }

  #shiftFrame(n) {
    if(!this.#requireStopped()) return;

    const dest = this.currentFrame + n;
    if(dest < 0) {
      this.print('Bottom (innermost) frame selected; you cannot go down.');
      return;
    }
    if(dest >= this.stack.length) {
      this.print('Initial frame selected; you cannot go up.');
      return;
    }

    this.currentFrame = dest;
    const f = this.stack[dest];
    this.#printFrame(f);
    this.#printSourceLine(f.filename, f.line);
  }

  async #evalExpression(expr) {
    const frame = this.stack[this.currentFrame]?.id ?? 0;
    const body = await this.session.evaluate(expr, frame);
    return body?.result ?? body?.value ?? inspect(body, { colors: false });
  }

  async cmdPrint(arg) {
    if(!arg) {
      this.print('Argument required (expression to print).');
      return;
    }
    if(!this.#requireStopped()) return;

    this.print(`$${++this.valueCounter} = ${await this.#evalExpression(arg)}`);
  }

  async cmdDisplay(arg) {
    if(!arg) {
      /* bare `display`: print the values of all displays now */
      if(!this.#requireStopped()) return;
      await this.#showDisplays();
      return;
    }

    const d = { num: this.nextDisplayNum++, expr: arg };
    this.displays.push(d);
    if(this.echoDisplays && this.session && this.stack.length) await this.#showDisplay(d);
  }

  cmdUndisplay(arg) {
    if(!arg) {
      this.displays = [];
      return;
    }

    const nums = arg.split(/[\s,]+/).map(Number);
    this.displays = this.displays.filter(d => !nums.includes(d.num));
  }

  async #showDisplay(d) {
    let value;
    try {
      value = await this.#evalExpression(d.expr);
    } catch(e) {
      value = `<error: ${e.message}>`;
    }
    this.print(`${d.num}: ${d.expr} = ${value}`);
  }

  async #showDisplays() {
    for(const d of this.displays) await this.#showDisplay(d);
  }

  cmdList(arg) {
    let file, start;

    if(arg) {
      const loc = this.resolveLocation(arg);
      if(!loc) {
        this.print(`Function "${arg}" not defined.`);
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
      this.print(file ? `No source file named ${file}.` : 'No default source file.');
      return;
    }

    for(let n = start; n < start + 10 && n <= lines.length; n++) this.print(`${n}\t${lines[n - 1]}`);

    this.listFile = file;
    this.listNext = Math.min(start + 10, lines.length + 1);
  }

  async cmdInfo(arg) {
    const what = arg.split(/\s+/)[0] || '';

    if('breakpoints'.startsWith(what) && what) {
      if(!this.breakpoints.length) {
        this.print('No breakpoints or watchpoints.');
        return;
      }
      this.print('Num     Type           What');
      for(const b of this.breakpoints) this.print(`${String(b.num).padEnd(8)}breakpoint     ${b.file}:${b.line}${b.spec != `${b.file}:${b.line}` ? ` (${b.spec})` : ''}`);
    } else if('locals'.startsWith(what) && what) {
      if(!this.#requireStopped()) return;
      const frame = this.stack[this.currentFrame]?.id ?? 0;
      const vars = await this.session.variables([frame, 1]);
      if(!vars?.length) this.print('No locals.');
      else for(const v of vars) this.print(`${v.name} = ${v.value}`);
    } else if('stack'.startsWith(what) && what) {
      this.cmdBacktrace();
    } else if('frame'.startsWith(what) && what) {
      this.cmdFrame('');
    } else if('args'.startsWith(what) && what) {
      this.print(`Argument list to give program when started is "${this.programArgs.join(' ')}".`);
    } else if('display'.startsWith(what) && what) {
      if(!this.displays.length) {
        this.print('There are no auto-display expressions now.');
        return;
      }
      this.print('Num Expression');
      for(const d of this.displays) this.print(`${String(d.num).padEnd(4)}${d.expr}`);
    } else {
      this.print('Usage: info breakpoints|locals|stack|frame|args|display');
    }
  }

  cmdSet(arg) {
    const m = arg.match(/^args(?:\s+(.*))?$/s);
    if(!m) {
      this.print('Usage: set args ARG...');
      return;
    }
    this.programArgs = m[1] ? splitArgs(m[1]) : [];
  }

  cmdInterrupt() {
    if(!this.session) {
      this.print('The program is not being run.');
      return;
    }
    this.interrupt();
  }

  cmdKill() {
    if(!this.child) {
      this.print('The program is not being run.');
      return;
    }

    const { child } = this;
    this.connection?.close();
    child.kill?.();
    const status = child.wait?.();
    drainOutput(child.stdout, this.printRaw);
    drainOutput(child.stderr, this.printRaw);
    this.print(`[Inferior (process ${child.pid}) killed]`);
    this.child = this.connection = this.session = null;
    this.stack = [];
    this.currentFrame = 0;
  }

  cmdQuit() {
    if(this.child) this.cmdKill();
    exit(0);
  }

  cmdHelp() {
    for(const [name, [, help]] of Object.entries(Debugger.commands)) this.print(help ?? name);
    this.print('\nEmpty line repeats the last stepping command. JS directives: prefix with "\\".');
  }

  /* ---------------- helpers ---------------- */

  #requireStopped() {
    if(!this.session) {
      this.print('The program is not being run.');
      return false;
    }
    if(!this.stack.length) {
      this.print('No stack.');
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
    if(r > 0) write(decoder.decode(new Uint8Array(buf, 0, r)));
    else setReadHandler(fd, null);
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
    write(decoder.decode(new Uint8Array(buf, 0, r)));
  }
}

function splitArgs(str) {
  const args = [];
  const re = /'([^']*)'|"([^"]*)"|(\S+)/g;
  let m;
  while((m = re.exec(str))) args.push(m[1] ?? m[2] ?? m[3]);
  return args;
}

/* ------------------------------------------------------------------ *
 *  repl mode                                                          *
 * ------------------------------------------------------------------ */

function StartREPL(dbg) {
  const repl = (globalThis.repl = new REPL(undefined, false));
  repl.ps1 = '(qjs-dbg) ';
  repl.historyLoad(null);

  const { log } = console;
  console.log = repl.printFunction(log);

  dbg.print = (...args) => repl.printStatus(args.join(' '), false);
  dbg.printRaw = repl.printFunction(s => (puts(s), stdout.flush()));

  /* gdb command interpreter instead of JS evaluation; '\' keeps REPL directives.
     Commands run asynchronously: lines entered meanwhile are queued. */
  const queue = [];

  const nextLine = () => {
    if(queue.length) runLine(queue.shift());
    else repl.cmdReadlineStart();
  };

  const runLine = expr => {
    if(expr == '') {
      if(!dbg.lastRepeat) return nextLine();
      expr = dbg.lastRepeat;
    } else repl.historyAdd(expr);

    repl.evalRunning = true;
    dbg
      .execute(expr)
      .catch(err => repl.printStatus(`${err?.message ?? err}`, false))
      .finally(() => {
        repl.evalRunning = false;
        nextLine();
      });
  };

  repl.handleCmd = function(expr) {
    if(expr === null) return false;
    if(expr[0] == '\\' || expr == '?') return REPL.prototype.handleCmd.call(this, expr);

    this.reset(); /* clear the line buffer so type-ahead starts fresh */

    if(this.evalRunning) queue.push(expr.trim());
    else runLine(expr.trim());

    return true;
  };

  /* tab completion: debugger commands get debugger candidates, '\' directives
     keep the REPL's JS completion */
  repl.getCompletions = function(line, pos) {
    if(line.startsWith('\\')) return REPL.prototype.getCompletions.call(this, line, pos);
    return dbg.getCompletions(line, pos);
  };

  /* Ctrl-C interrupts the running program instead of the debugger */
  const { controlC } = repl;
  repl.controlC = function(...args) {
    if(dbg.busy && dbg.session) {
      dbg.interrupt();
      return;
    }
    return controlC.call(this, ...args);
  };

  repl.addCleanupHandler(() => dbg.child && dbg.cmdKill());

  globalThis.dbg = dbg;
  repl.run();
  return repl;
}

/* ------------------------------------------------------------------ *
 *  main                                                               *
 * ------------------------------------------------------------------ */

function Usage(name) {
  puts(`Usage: ${name} [OPTIONS] [SCRIPT.js]
       ${name} [OPTIONS] --args SCRIPT.js [ARGS...]

  -m, --mode MODE       repl | server | gui  (default: repl)
  -a, --address ADDR    engine debug address (default: 127.0.0.1:9901)
  -l, --listen          listen on ADDR, engine connects out (default)
  -c, --connect         engine listens on ADDR, debugger connects
  -t, --transport NAME  socket (AsyncSocket) | lws (TCPSocketStream)
  -h, --help            show this help
`);
}

function main(...args) {
  globalThis.io ??= io; /* AsyncSocket looks its read/write handlers up here */
  globalThis.setTimeout ??= osSetTimeout;
  globalThis.clearTimeout ??= osClearTimeout;
  globalThis.console = new Console(process.stdout, {
    inspectOptions: { colors: true, depth: 4, compact: 2, maxArrayLength: 100 },
  });

  const name = basename(process.argv[1] ?? 'qjs-debugger', '.js');
  const interpreter = name.startsWith('qjsm') ? 'qjsm' : 'qjs';

  let mode = 'repl',
    address = '127.0.0.1:9901',
    listen = true,
    transport = SocketTransport,
    program = null,
    programArgs = [];

  for(let i = 0; i < args.length; i++) {
    const arg = args[i];
    let m;

    if(arg == '--args') {
      program = args[++i] ?? null;
      programArgs = args.slice(i + 1);
      break;
    } else if((m = arg.match(/^(?:-m|--mode)(?:=(.*))?$/))) mode = m[1] ?? args[++i];
    else if((m = arg.match(/^(?:-a|--address)(?:=(.*))?$/))) address = m[1] ?? args[++i];
    else if(arg == '-l' || arg == '--listen') listen = true;
    else if(arg == '-c' || arg == '--connect') listen = false;
    else if((m = arg.match(/^(?:-t|--transport)(?:=(.*))?$/))) {
      const name = m[1] ?? args[++i];
      if(/^(socket|sockets?|async)/i.test(name)) transport = SocketTransport;
      else if(/^(lws|stream|tcp)/i.test(name)) transport = StreamTransport;
      else {
        puts(`${basename(process.argv[1] ?? 'qjs-debugger', '.js')}: unknown transport '${name}' (socket, lws)\n`);
        exit(1);
      }
    } else if(arg == '-h' || arg == '--help') {
      Usage(name);
      exit(0);
    } else if(arg.startsWith('-')) {
      puts(`${name}: unrecognized option '${arg}'\n`);
      Usage(name);
      exit(1);
    } else if(program === null) program = arg;
    else programArgs.push(arg);
  }

  const dbg = new Debugger({ interpreter, address, listen, transport });
  if(program !== null) dbg.setProgram(program, programArgs);

  switch (mode) {
    case 'repl':
      puts(`${name} (debugging ${interpreter}) -- type "help" for a list of commands.\n`);
      StartREPL(dbg);
      break;

    case 'gui':
      import('./gui/main.js')
        .then(({ StartGUI }) => StartGUI(dbg))
        .catch(err => {
          puts(`${name}: cannot start gui: ${err.message}\n`);
          exit(1);
        });
      break;

    case 'server':
      puts(`${name}: mode '${mode}' is not implemented yet.\n`);
      exit(1);
      break;

    default:
      puts(`${name}: unknown mode '${mode}' (repl, server, gui)\n`);
      exit(1);
  }
}

main(...process.argv.slice(2));
