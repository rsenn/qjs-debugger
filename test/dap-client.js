/* dap-client.js: a minimal DAP client driving `qjs-debugger -m dap`.
 *
 * ```sh
 * qjsm test/dap-client.js [interpreter]   # exit 0 when the session behaves
 * ```
 *
 * Launches test/cases/f.js, sets a breakpoint on line 3, and checks the
 * stop, stack trace, variables and evaluate responses, then lets it exit.
 */
import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { read as osRead, setReadHandler, write as osWrite, setTimeout as osSetTimeout } from 'os';
import { exit } from 'std';
import { TextDecoder, TextEncoder } from 'textcode';
import process from 'process';

const here = dirname(process.argv[1]);
const interpreter = process.argv[2] ?? 'qjsm';
const adapter = join(here, '..', 'qjs-debugger.js');
const program = join(here, 'cases', 'f.js');

const child = spawn('qjsm', [adapter, '-m', 'dap', '-i', interpreter], { stdio: ['pipe', 'pipe', 'inherit'] });
const encoder = new TextEncoder();
const decoder = new TextDecoder();

let seq = 0;
let buffer = new Uint8Array(0);
const pending = new Map(); /* request_seq -> resolve */
const events = []; /* received events not yet consumed */
const eventWaiters = [];

function dispatch(msg) {
  if(msg.type == 'response') pending.get(msg.request_seq)?.(msg);
  else if(msg.type == 'event') {
    const i = eventWaiters.findIndex(w => w.name == msg.event);
    if(i >= 0) eventWaiters.splice(i, 1)[0].resolve(msg);
    else events.push(msg);
  }
}

function feed(chunk) {
  const joined = new Uint8Array(buffer.length + chunk.length);
  joined.set(buffer, 0);
  joined.set(chunk, buffer.length);
  buffer = joined;

  for(;;) {
    const text = decoder.decode(buffer);
    const sep = text.indexOf('\r\n\r\n');
    if(sep < 0) return;
    const length = +text.slice(0, sep).match(/Content-Length:\s*(\d+)/i)[1];
    const start = encoder.encode(text.slice(0, sep + 4)).length;
    if(buffer.length < start + length) return;
    dispatch(JSON.parse(decoder.decode(buffer.subarray(start, start + length))));
    buffer = buffer.slice(start + length);
  }
}

const rbuf = new ArrayBuffer(65536);
setReadHandler(child.stdout, () => {
  const r = osRead(child.stdout, rbuf, 0, rbuf.byteLength);
  if(r > 0) feed(new Uint8Array(rbuf, 0, r));
  else setReadHandler(child.stdout, null);
});

function request(command, args = {}) {
  const request_seq = ++seq;
  const json = JSON.stringify({ seq: request_seq, type: 'request', command, arguments: args });
  const bytes = encoder.encode(`Content-Length: ${encoder.encode(json).length}\r\n\r\n${json}`);
  osWrite(child.stdin, bytes.buffer, 0, bytes.length);
  return new Promise(resolve => pending.set(request_seq, resolve));
}

function waitEvent(name) {
  const i = events.findIndex(e => e.event == name);
  if(i >= 0) return Promise.resolve(events.splice(i, 1)[0]);
  return new Promise(resolve => eventWaiters.push({ name, resolve }));
}

let failures = 0;
function check(what, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : ' ' + detail}`);
  if(!ok) failures++;
}

osSetTimeout(() => {
  console.log('FAIL timeout');
  child.kill();
  exit(1);
}, 30000);

const init = await request('initialize', { adapterID: 'qjs', linesStartAt1: true, columnsStartAt1: true });
check('initialize', init.success);

/* the adapter answers launch once the engine is attached; breakpoints need that session */
await request('launch', { program, interpreter, stopOnEntry: false });
await waitEvent('initialized');
const bps = await request('setBreakpoints', { source: { path: program }, breakpoints: [{ line: 3 }] });
check('setBreakpoints', bps.success);
await request('configurationDone');

const stopped = await waitEvent('stopped');
check('stopped on breakpoint', stopped.body.reason == 'breakpoint', JSON.stringify(stopped.body));

const stack = await request('stackTrace', { threadId: stopped.body.threadId });
const top = stack.body?.stackFrames?.[0];
check('stackTrace', top?.line == 3 && top?.name == 'f', JSON.stringify(top));

const scopes = await request('scopes', { frameId: top?.id ?? 0 });
check('scopes', scopes.success && scopes.body?.scopes?.length > 0);

const vars = await request('variables', { variablesReference: scopes.body.scopes[0].variablesReference });
const names = (vars.body?.variables ?? []).map(v => v.name);
check('variables has a and b', names.includes('a') && names.includes('b'), names.join(','));

const ev = await request('evaluate', { expression: 'a + b', frameId: top?.id ?? 0, context: 'repl' });
check('evaluate a + b', ev.body?.result == '60', JSON.stringify(ev.body));

await request('continue', { threadId: stopped.body.threadId });
await waitEvent('terminated');
check('terminated', true);

await request('disconnect');
child.kill();
exit(failures ? 1 : 0);
