#!/usr/bin/env qjsm
/**
 * qjs-debugger — gdb-style command line debugger for QuickJS.
 *
 * Installed as bin/qjs-debugger and bin/qjsm-debugger; the name decides
 * which interpreter is spawned for the debuggee (qjs or qjsm).
 *
 * Modes: repl (default), server, gui, dap. The Debugger model itself lives
 * in debugger.js (also importable as a library).
 *
 * Usage:
 *   qjs-debugger script.js
 *   qjs-debugger --args script.js arg1 arg2 ...
 *   qjs-debugger --batch cmds.txt --json script.js
 */
import { spawn as spawnProcess } from 'child_process';
import { readFileSync } from 'fs';
import { getpid, open as osOpen, O_RDONLY, read as osRead, setReadHandler, setTimeout as osSetTimeout, signal as osSignal, SIGUSR1 } from 'os';
import { basename, dirname, join } from 'path';
import { REPL } from 'repl';
import { exit, getenv, open as fopen, out as stdout, puts } from 'std';
import { TextDecoder, TextEncoder } from 'textcode';
import process from 'process';
import Console from 'console';
import { EngineConnection } from './engine-connection.js';
import { Debugger } from './debugger.js';
import { SocketTransport, StreamTransport } from './transport.js';
import { DebuggerServerAdapter } from './server-adapter.js';
import { DAPAdapter } from './vscode-dap.js';


/* ------------------------------------------------------------------ *
 *  batch mode — commands from a file or stdin, plain or JSON output   *
 * ------------------------------------------------------------------ */

/**
 * Line source over a file descriptor: each readLine() resolves with the next
 * line (without its newline), or null at end of input. Lines are cut on raw
 * bytes so a multi-byte character split across reads decodes intact.
 */
function LineReader(fd) {
  const buf = new ArrayBuffer(4096);
  const decoder = new TextDecoder();
  const lines = [];
  const waiters = [];
  let pending = new Uint8Array(0);
  let eof = false;

  const settle = () => {
    while(waiters.length && (lines.length || eof)) waiters.shift()(lines.length ? lines.shift() : null);
  };

  setReadHandler(fd, () => {
    let r;
    try {
      r = osRead(fd, buf, 0, buf.byteLength);
    } catch(e) {
      r = 0;
    }

    if(r > 0) {
      const joined = new Uint8Array(pending.length + r);
      joined.set(pending, 0);
      joined.set(new Uint8Array(buf, 0, r), pending.length);

      let start = 0;
      for(let i = 0; i < joined.length; i++) {
        if(joined[i] != 10) continue;
        lines.push(decoder.decode(joined.subarray(start, i)).replace(/\r$/, ''));
        start = i + 1;
      }
      pending = joined.slice(start);
    } else {
      if(pending.length) lines.push(decoder.decode(pending).replace(/\r$/, ''));
      pending = new Uint8Array(0);
      eof = true;
      setReadHandler(fd, null);
    }
    settle();
  });

  return {
    readLine: () => new Promise(resolve => (waiters.push(resolve), settle())),
  };
}

/**
 * Run the debugger from a command script, no line editor, no ANSI.
 *
 *   source   '-' (stdin) or a file name
 *   json     one JSON record per line instead of text (see doc/json-protocol.md)
 *   strict   stop at the first failed command
 *   timeout  seconds after which the debuggee is killed and the exit status is 124
 *
 * Exit status: 124 on timeout, else the `quit CODE` given, else 1 if any
 * command failed, else the debuggee's exit status (128+N when killed by
 * signal N), else 0.
 */
async function StartBatch(dbg, { source = '-', json = false, strict = false, timeout = 0 } = {}) {
  const write = s => (stdout.puts(s), stdout.flush());
  dbg.completion = false;

  if(json) {
    dbg.print = () => {};
    dbg.printRaw = () => {};
    dbg.emit = record => write(JSON.stringify(record) + '\n');
    dbg.collectState = true;
  } else {
    dbg.print = (...args) => write(args.join(' ') + '\n');
    dbg.printRaw = s => write(s);
  }

  let fd = 0;
  if(source != '-') {
    fd = osOpen(source, O_RDONLY);
    if(fd < 0) {
      puts(`${source}: cannot open command file\n`);
      exit(1);
    }
  }

  let status = null; /* set by quit CODE */
  let failed = false;
  let timedOut = false;
  dbg.onQuit = code => (status = code ?? false);

  if(timeout > 0)
    osSetTimeout(() => {
      timedOut = true;
      dbg.close();
      write(json ? JSON.stringify({ type: 'result', command: '', ok: false, error: `timeout after ${timeout}s` }) + '\n' : `timeout after ${timeout}s\n`);
      exit(124);
    }, timeout * 1000);

  const reader = LineReader(fd);

  for(let line; (line = await reader.readLine()) !== null && status === null; ) {
    line = line.trim();
    if(line == '' || line[0] == '#') continue;

    if(!json) write(`(qjs-dbg) ${line}\n`);

    try {
      await dbg.execute(line);
    } catch(err) {
      if(!json) write(`${err?.message ?? err}\n`);
    }

    if(dbg.lastError !== null) {
      failed = true;
      if(strict) break;
    }
  }

  dbg.close();

  if(timedOut) return;
  stdout.flush();
  exit(typeof status == 'number' ? status : failed ? 1 : (dbg.exitCode ?? 0));
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
  dbg.printRaw = repl.printFunction(s => (stdout.puts(s), stdout.flush()));

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
 *  server mode — HTTP/WebSocket server (qjs-lws), N clients : 1 engine *
 * ------------------------------------------------------------------ */

/**
 * Serve the debug protocol over WebSockets so any number of browser/REPL
 * clients can share one running engine (see server-adapter.js). dbg is
 * used purely as a config bag here (program/args/address/listen/transport)
 * — DebuggerServerAdapter, not dbg, is the session owner for this mode.
 *
 * One port, one LWSContext, all backed by the same DebuggerServerAdapter
 * (and hence the same single engine):
 *   - JSON and the engine's own length-framed wire protocol, both as WS,
 *     sharing the port: which one a client gets is purely which
 *     Sec-WebSocket-Protocol it asks for — `new WebSocket(url, 'debugger')`
 *     (one JSON message per WS frame) vs `new WebSocket(url,
 *     'debugger-raw')` (unmodified `%08x\n<json>\n` framing) —
 *     libwebsockets matches that name against every protocol on the vhost
 *     regardless of which mount matched the URL (see connector-lws.js's
 *     header comment), so no separate mount is needed per encoding.
 *   - qjs-lws's examples/debugger/demo.html UI: static files, GET
 *     /source?path=... for absolute-path sources, and the WS 'browser'
 *     protocol at /debug demo.js expects.
 *   - when dbg.listen (true, default), the engine's own connection: lws's
 *     listen-fallback (LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG
 *     + listenAcceptRole/listenAcceptProtocol) lets the same port both
 *     serve HTTP/WS *and* accept the engine's raw, non-HTTP TCP connection
 *     (armed with QUICKJS_DEBUG_ADDRESS=host:port) by sniffing whether the
 *     first bytes look like an HTTP request line — see connector-lws.js's
 *     LWSEngineConnector. This sidesteps forwardOutput's os.setReadHandler
 *     pipe polling colliding with qjs-lws's own event loop (see BUGS) by
 *     keeping the engine spawn+output capture on lws-native primitives too
 *     (SubprocessStream), rather than qjs-modules' AsyncSocket. dbg.listen
 *     = false (engine listens, we connect out) isn't part of that demo —
 *     it keeps using the plain EngineConnection.connect() path, dialing
 *     out to dbg.address rather than accepting on `port`.
 */
async function StartServer(dbg, { port = 8998 } = {}) {
  if(!dbg.program) {
    puts('No executable file specified. Use --args SCRIPT.js or pass it positionally.\n');
    exit(1);
  }

  const { createServer, LWSMPRO_NO_MOUNT, LWSMPRO_FILE, LWSMPRO_CALLBACK, LWS_WRITE_HTTP_FINAL, LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG } = await import('lws.so');
  const { LWSConnector, LWSEngineConnector } = await import('./connector-lws.js');

  const adapter = new DebuggerServerAdapter({ timeout: 0 });
  adapter.onstatus = msg => (stdout.puts(`[server] ${msg}\n`), stdout.flush());

  /* demo.js connects with `new WebSocket(url, 'browser')` — an explicit
     Sec-WebSocket-Protocol header, required for mount-based dispatch to
     work correctly on a context that also serves other protocols (see
     connector-lws.js's header comment) — so name it to match. */
  const browserConnector = LWSConnector(adapter, { mode: 'browser', name: 'browser' });
  const demoDir = join(dirname(process.argv[1] ?? '.'), 'examples', 'browser');

  /* GET /source?path=<abs>, for stack frames outside demoDir (our targets
     are always given as absolute paths) — same as qjs-lws's own
     examples/debugger/server.js. */
  function serveSource(wsi) {
    const m = (wsi.headers?.['uri-args'] ?? '').match(/(?:^|&)path=([^&]*)/);
    const path = m ? decodeURIComponent(m[1]) : null;

    if(!path || !path.endsWith('.js')) {
      wsi.respond(400, { 'content-type': 'text/plain' });
      wsi.write('bad request: missing or non-.js path\n', LWS_WRITE_HTTP_FINAL);
      return;
    }

    let content;
    try {
      content = readFileSync(path, 'utf-8');
    } catch(e) {
      wsi.respond(404, { 'content-type': 'text/plain' });
      wsi.write('not found\n', LWS_WRITE_HTTP_FINAL);
      return;
    }

    wsi.respond(200, { 'content-type': 'text/javascript' }, content.length);
    wsi.write(content, LWS_WRITE_HTTP_FINAL);
  }

  const browserMounts = [
    { mountpoint: '/debug', protocol: 'browser', originProtocol: LWSMPRO_NO_MOUNT },
    { mountpoint: '/source', protocol: 'source', originProtocol: LWSMPRO_CALLBACK },
    { mountpoint: '/', origin: demoDir, def: 'demo.html', originProtocol: LWSMPRO_FILE, protocol: 'http' },
  ];
  const protocols = [
    LWSConnector(adapter, { mode: 'json', name: 'debugger' }),
    LWSConnector(adapter, { mode: 'raw', name: 'debugger-raw' }),
    { name: 'http' },
    { name: 'source', onHttp: serveSource },
    browserConnector,
  ];

  if(dbg.listen) {
    const { SubprocessStream } = await import('lws/subprocess-stream.js');

    createServer({
      port,
      vhostName: 'localhost',
      options: LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG,
      listenAcceptRole: 'raw-skt',
      listenAcceptProtocol: 'engine',
      mounts: browserMounts,
      protocols: [...protocols, { name: 'engine', ...LWSEngineConnector({ onConnect: connection => adapter.attachEngine(connection) }) }],
    });

    const child = SubprocessStream(['/usr/bin/env', `QUICKJS_DEBUG_ADDRESS=127.0.0.1:${port}`, dbg.interpreter, dbg.program, ...dbg.programArgs]);
    pumpOutput(child.stdout, 1, browserConnector);
    pumpOutput(child.stderr, 2, browserConnector);
  } else {
    spawnProcess(dbg.interpreter, [dbg.program, ...dbg.programArgs], {
      env: { ...process.env, QUICKJS_DEBUG_LISTEN_ADDRESS: dbg.address },
      cwd: dbg.cwd ?? undefined,
      stdio: 'inherit',
    });
    const connection = await EngineConnection.connect(dbg.address, { transport: dbg.transport });
    adapter.attachEngine(connection);

    createServer({ port, vhostName: 'localhost', mounts: browserMounts, protocols });
  }

  stdout.puts(`Debugger server: http://0.0.0.0:${port}/ (browser demo), ws://0.0.0.0:${port}/ ('debugger' subprotocol: JSON, 'debugger-raw': wire protocol)\n`);
  stdout.flush();
}

/* Forwards one of the debuggee's output streams to every connected
   'browser'-mode WS client as a channel-prefixed binary message
   (1 = stdout, 2 = stderr) — see qjs-lws's examples/debugger/demo.js. */
async function pumpOutput(stream, channel, connector) {
  const reader = stream.getReader();

  for(;;) {
    const { value, done } = await reader.read();
    if(done) break;

    const framed = new Uint8Array(1 + value.byteLength);
    framed[0] = channel;
    framed.set(new Uint8Array(value), 1);
    connector.broadcastBinary(framed.buffer);
  }
}

/* ------------------------------------------------------------------ *
 *  dap mode — debug adapter for VS Code                               *
 * ------------------------------------------------------------------ */

/**
 * Incremental decoder for the DAP stdio framing:
 *
 *     Content-Length: <n>\r\n\r\n<n bytes of JSON>
 *
 * Byte-accurate like codec.js's FrameDecoder (the header is pure ASCII,
 * so scanning for CRLFCRLF is safe even mid multi-byte UTF-8 body).
 */
class DAPFrameDecoder {
  #buf = new Uint8Array(0);

  constructor(onFrame) {
    this.onFrame = onFrame;
  }

  push(chunk) {
    const buf = new Uint8Array(this.#buf.length + chunk.length);
    buf.set(this.#buf, 0);
    buf.set(chunk, this.#buf.length);
    this.#buf = buf;

    for(;;) {
      let sep = -1;
      for(let i = 0; i + 3 < this.#buf.length; i++) {
        if(this.#buf[i] == 13 && this.#buf[i + 1] == 10 && this.#buf[i + 2] == 13 && this.#buf[i + 3] == 10) {
          sep = i;
          break;
        }
      }
      if(sep < 0) return;

      const header = new TextDecoder().decode(this.#buf.subarray(0, sep));
      const m = header.match(/Content-Length:\s*(\d+)/i);
      if(!m) throw new Error('DAPFrameDecoder: missing Content-Length header');

      const length = +m[1];
      const bodyStart = sep + 4;
      if(this.#buf.length < bodyStart + length) return;

      const json = new TextDecoder().decode(this.#buf.subarray(bodyStart, bodyStart + length));
      this.#buf = this.#buf.subarray(bodyStart + length);
      this.onFrame(json);
    }
  }
}

/**
 * Run as a VS Code debug adapter over stdio: DAP requests in on stdin,
 * DAP responses/events out on stdout, both Content-Length framed. The
 * engine side is unchanged from the other modes — DAPAdapter (see
 * vscode-dap.js) is transport-agnostic and just wraps the same
 * EngineConnection-backed DebugSession that repl/gui use.
 *
 * stdout is reserved for the DAP stream: dbg.print/printRaw and console
 * output are redirected to DAP 'output' events (falling back to stderr
 * before a session exists) so nothing else can corrupt it.
 */
function StartDAP(dbg) {
  const encoder = new TextEncoder();
  let seq = 0;

  /* Log every DAP message crossing stdio (both directions) to a file,
     since stdout/stdin are the DAP stream itself and can't be used for
     logging. Enabled either by QJS_DEBUGGER_DAP_LOG=/path/to/file up
     front, or on demand by sending SIGUSR1 to this process, which opens
     a generated /tmp/qjs-dap-<pid>-<timestamp>.log. */
  let dapLog = null;
  const openDapLog = path => {
    if(dapLog) return;
    dapLog = fopen(path, 'a');
    console.error(`qjs-debugger: logging DAP traffic to ${path}`);
  };
  const dapLogPath = getenv('QJS_DEBUGGER_DAP_LOG');
  if(dapLogPath) openDapLog(dapLogPath);
  osSignal(SIGUSR1, () => openDapLog(`/tmp/qjs-dap-${getpid()}-${Date.now()}.log`));

  const logDAP = (direction, msg) => {
    if(!dapLog) return;
    dapLog.puts(`[${new Date().toISOString()}] ${direction} ${JSON.stringify(msg)}\n`);
    dapLog.flush();
  };

  const send = msg => {
    const json = JSON.stringify({ seq: ++seq, ...msg });
    logDAP('-->', { seq, ...msg });
    const length = encoder.encode(json).length;
    stdout.puts(`Content-Length: ${length}\r\n\r\n${json}`);
    stdout.flush();
  };

  const adapter = new DAPAdapter(send);

  const output = (text, category = 'console') => adapter.event('output', { category, output: text });
  dbg.print = (...args) => output(args.join(' ') + '\n');
  dbg.printRaw = s => output(s, 'stdout');

  let stopOnEntry = false;

  const configure = (args, defaultListen) => {
    if(args.address) dbg.address = args.address;
    dbg.listen = typeof args.listen == 'boolean' ? args.listen : defaultListen;
    if(args.interpreter) dbg.interpreter = args.interpreter;
    if(args.cwd) dbg.cwd = args.cwd;
    stopOnEntry = !!args.stopOnEntry;
  };

  /* launch: spawn a fresh engine for `program` (dbg.launchEngine(), same as the
     other modes) — listen defaults true (we accept, engine connects out) */
  adapter.onLaunch = async args => {
    if(!args.program) throw new Error("launch requires 'program'");
    configure(args, true);
    dbg.setProgram(args.program, args.args ?? []);
    await dbg.launchEngine();
    adapter.attachSession(dbg.session);
  };

  /* attach: connect to (or accept from) an already-running engine at
     `address` — never spawns anything, unlike dbg.launchEngine(); listen
     defaults false ("connect": the engine is already listening) */
  adapter.onAttach = async args => {
    configure(args, false);
    if(!dbg.address) throw new Error("attach requires 'address'");

    dbg.connection = dbg.listen
      ? await EngineConnection.accept(dbg.address, { transport: dbg.transport })
      : await EngineConnection.connect(dbg.address, { transport: dbg.transport });

    dbg.session = dbg.connection.attachSession({ timeout: 0 });
    await dbg.session.waitEvent('stopped'); /* the engine stops at 'entry' as soon as it attaches */
    adapter.attachSession(dbg.session);
  };

  /* breakpoints (setBreakpoints/setExceptionBreakpoints) are only sent by
     VS Code once launch/attach has responded; resume past the automatic
     entry stop once they're all in, signaled by configurationDone —
     unless the launch/attach config asked to stay stopped */
  adapter.onConfigurationDone = async () => {
    if(!stopOnEntry) await dbg.session?.request('continue').catch(() => {});
  };

  adapter.onDisconnect = adapter.onTerminate = async () => {
    if(dbg.child) dbg.cmdKill();
    else dbg.connection?.close();
  };

  const decoder = new DAPFrameDecoder(json => {
    let request;
    try {
      request = JSON.parse(json);
    } catch(e) {
      return;
    }
    logDAP('<--', request);
    adapter.dispatch(request);
  });

  setReadHandler(0, () => {
    const buf = new ArrayBuffer(4096);
    let r;
    try {
      r = osRead(0, buf, 0, buf.byteLength);
    } catch(e) {
      r = 0;
    }
    if(r > 0) decoder.push(new Uint8Array(buf, 0, r));
    else setReadHandler(0, null);
  });
}

/* ------------------------------------------------------------------ *
 *  main                                                               *
 * ------------------------------------------------------------------ */

function Usage(name) {
  puts(`Usage: ${name} [OPTIONS] [SCRIPT.js]
       ${name} [OPTIONS] --args SCRIPT.js [ARGS...]

  -m, --mode MODE       repl | server | gui | dap  (default: repl)
  -a, --address ADDR    engine debug address (default: 127.0.0.1:9901)
  -l, --listen          listen on ADDR, engine connects out (default)
  -c, --connect         engine listens on ADDR, debugger connects
  -e, --external        don't spawn the debuggee: "run" waits for (-l) or
                        connects to (-c) a process started elsewhere, e.g.
                        QUICKJS_DEBUG_ADDRESS=ADDR qjs script.js
                        (implied when no SCRIPT is given)
  -t, --transport NAME  socket (AsyncSocket) | lws (TCPSocketStream)
  -p, --port PORT       server mode: HTTP, WS ('debugger' subprotocol: JSON,
                        'debugger-raw': wire protocol) and the engine's TCP
                        connection all share PORT (default: 8998)
  -x, --batch FILE      run the commands in FILE ('-': stdin), no line editor
      --plain           plain text output, no ANSI; commands from stdin
                        unless --batch is given (also: --no-color)
      --json            one JSON record per line (doc/json-protocol.md);
                        implies --plain
      --strict          batch: stop at the first failed command
      --timeout SECS    batch: kill the debuggee after SECS, exit status 124
  -i, --interpreter I   debuggee interpreter (default: qjs, qjsm-debugger: qjsm)
  -h, --help            show this help

Batch exit status: the 'quit CODE' given, else 1 if a command failed, else
the debuggee's exit status (128+N when killed by signal N), else 0.
`);
}

function main(...args) {
  const name = basename(process.argv[1] ?? 'qjs-debugger', '.js');
  let interpreter = name.startsWith('qjsm') ? 'qjsm' : 'qjs';

  let mode = 'repl',
    address = '127.0.0.1:9901',
    listen = true,
    external = false,
    transport = SocketTransport,
    port = 8998,
    batch = null,
    plain = false,
    json = false,
    strict = false,
    timeout = 0,
    program = null,
    programArgs = [];

  for(let i = 0; i < args.length; i++) {
    const arg = args[i];
    let m;

    if(arg == '--args' || arg == '--') {
      program = args[++i] ?? null;
      programArgs = args.slice(i + 1);
      break;
    } else if((m = arg.match(/^(?:-m|--mode)(?:=(.*))?$/))) mode = m[1] ?? args[++i];
    else if((m = arg.match(/^(?:-a|--address)(?:=(.*))?$/))) address = m[1] ?? args[++i];
    else if((m = arg.match(/^(?:-p|--port)(?:=(.*))?$/))) port = +(m[1] ?? args[++i]);
    else if((m = arg.match(/^(?:-x|--batch)(?:=(.*))?$/))) batch = m[1] ?? args[++i];
    else if((m = arg.match(/^--timeout(?:=(.*))?$/))) timeout = +(m[1] ?? args[++i]);
    else if((m = arg.match(/^(?:-i|--interpreter)(?:=(.*))?$/))) interpreter = m[1] ?? args[++i];
    else if(arg == '--plain' || arg == '--no-color') plain = true;
    else if(arg == '--json') json = true;
    else if(arg == '--strict') strict = true;
    else if(arg == '-l' || arg == '--listen') listen = true;
    else if(arg == '-c' || arg == '--connect') listen = false;
    else if(arg == '-e' || arg == '--external') external = true;
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

  /* dap mode reserves stdout for the DAP stream; everything console-ish goes to stderr */
  globalThis.console = new Console(mode == 'dap' ? process.stderr : process.stdout, {
    inspectOptions: { colors: !(plain || json || batch !== null), depth: 4, compact: 2, maxArrayLength: 100 },
  });

  const dbg = new Debugger({ interpreter, address, listen, transport });
  if(program !== null) dbg.setProgram(program, programArgs);
  dbg.external = external || (program === null && (mode == 'repl' || mode == 'gui'));

  switch (mode) {
    case 'repl':
      if(batch !== null || plain || json) {
        StartBatch(dbg, { source: batch ?? '-', json, strict, timeout }).catch(err => {
          puts(`${name}: ${err?.message ?? err}\n`);
          exit(1);
        });
        break;
      }
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

    case 'dap':
      StartDAP(dbg);
      break;

    case 'server':
      StartServer(dbg, { port }).catch(err => {
        puts(`${name}: cannot start server: ${err.message}\n`);
        exit(1);
      });
      break;

    default:
      puts(`${name}: unknown mode '${mode}' (repl, server, gui, dap)\n`);
      exit(1);
  }
}

main(...process.argv.slice(2));
