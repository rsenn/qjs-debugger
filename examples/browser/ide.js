/**
 * Web client for `qjs-debugger -m server`: talks over the WebSocket at /debug. Two kinds of WS message
 * arrive:
 *   - text messages carry debug-wire JSON, framed the same way as the raw
 *     TCP side ("%08x '\n' <json> '\n'", the 8 hex digits counting json's
 *     UTF-8 byte length + 1) rather than being one-message-per-frame - a
 *     large frame can otherwise come out on the wire as several separate
 *     WS messages, so it's decoded here by that explicit length prefix
 *     instead of relying on WS message boundaries (see decodeFrames()).
 *   - binary messages are streamed target I/O, the first byte the channel
 *     (1 = stdout, 2 = stderr).
 * server.js only shovels bytes; source files relative to this directory
 * are fetched as static assets from the same origin, and absolute-path
 * source files (e.g. modules the debug target loaded from elsewhere on
 * disk) go through GET /source?path=... instead, which server.js
 * restricts to .js files under the user's home.
 */

let debugLevel = 1;

function debugLog(level, arrow, color, label, ...args) {
  if(debugLevel < level) return;
  console.log(`%c${arrow}%c ${label}`, `color: ${color};`, 'color: black', ...args);
}

const statusEl = document.getElementById('status');
const statusBadge = document.getElementById('statusBadge');
const bannerEl = document.getElementById('executionBanner');
const tabsEl = document.getElementById('fileTabs');
const replLogEl = document.getElementById('replLog');
const filterEl = document.getElementById('varFilter');
const sourceEl = document.getElementById('source');
const varsEl = document.getElementById('vars');
const outputEl = document.getElementById('output');
const evalInput = document.getElementById('evalInput');
const sourceCache = new Map();
let curFile = null;

const KEYWORDS =
  'async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|enum|export|extends|finally|for|from|function|if|import|in|instanceof|let|new|of|return|static|super|switch|this|throw|try|typeof|var|void|while|with|yield';

const tokenRe = new RegExp(
  '(?<comment>//[^\\n]*|/\\*[\\s\\S]*?\\*/)' +
    '|(?<regex>(?<![\\w$)\\]]\\s*)/(?:[^/\\\\\\n[]|\\\\.|\\[(?:[^\\]\\\\\\n]|\\\\.)*\\])+/[a-z]*)' +
    `|(?<string>"(?:[^"\\\\\\n]|\\\\.)*"|'(?:[^'\\\\\\n]|\\\\.)*')` +
    '|(?<numeric>\\b0[xX][\\da-fA-F]+\\b|\\b0[oO][0-7]+\\b|\\b0[bB][01]+\\b|\\b\\d+\\.\\d*(?:[eE][+-]?\\d+)?\\b|\\b\\.\\d+\\b|\\b\\d+(?:[eE][+-]?\\d+)?\\b)' +
    `|(?<keyword>\\b(?:${KEYWORDS})\\b)` +
    '|(?<boolean>\\b(?:true|false|null|undefined)\\b)' +
    '|(?<ident>[A-Za-z_$][\\w$]*)' +
    '|(?<punct>[-+*/%=<>!&|^~?:;,.(){}\\[\\]]+)' +
    '|(?<other>[\\s\\S])',
  'g',
);

function escapeHtml(str) {
  return str.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
}

function highlightLine(line) {
  return line.replace(tokenRe, (match, ...rest) => {
    const groups = rest[rest.length - 1];
    const type = Object.keys(groups).find(k => groups[k] !== undefined);
    const escaped = escapeHtml(match);
    return type && type !== 'other' ? `<span class="tok-${type}">${escaped}</span>` : escaped;
  });
}

/* breakpoints are owned by the server-side Debugger (numbered, gdb-style): the
   gutter just issues `break`/`delete`, and the table comes back as an event */
let bpList = [];

function toggleBreakpoint(filename, line, e) {
  const bp = bpList.find(b => b.file === filename && b.line === line);

  /* shift-click: edit the condition on the command line */
  if(e?.shiftKey) {
    cmdInput.value = bp ? `condition ${bp.num} ${bp.condition ?? ''}` : `break ${filename}:${line} if `;
    cmdInput.focus();
    return;
  }

  command(bp ? `delete ${bp.num}` : `break ${filename}:${line}`, false);
}

function markBreakpoint(row, line) {
  const bp = bpList.find(b => b.file === curFile && b.line === line);
  row.classList.toggle('breakpoint', !!bp);
  row.classList.toggle('conditional', !!bp?.condition);
  row.title = bp?.condition ? `if ${bp.condition}` : '';
}

function applyState({ breakpoints, program: main, sources: files }) {
  if(main && !program) {
    program = main;
    if(!curFile) openFile(program);
  }
  if(files) sources = files;
  renderTabs();
  bpList = breakpoints;
  for(const row of sourceEl.children) markBreakpoint(row, Number(row.dataset.line));
}

let ws,
  seq = 1;
const pending = new Map();

function setStatus(text, state = 'connecting') {
  statusEl.textContent = text;
  statusBadge.className = state;
}

function request(command, args) {
  const request_seq = seq++;
  const request = { type: 'request', request: { command, request_seq, args } };
  debugLog(2, '🡆', 'red', 'sendMessage(', request, ')');
  ws.send(JSON.stringify(request));
  return new Promise(resolve => pending.set(request_seq, resolve));
}

function onFrame(json) {
  let msg;
  try {
    msg = JSON.parse(json);
  } catch(e) {
    console.log(`bad debugger frame: '${json}'`);
    return;
  }
  debugLog(2, '🡄', 'green', 'onFrame', msg);
  if(msg.type === 'console') {
    consoleLine('dbg', msg.text);
  } else if(msg.type === 'response') {
    pending.get(msg.request_seq)?.(msg.body);
    pending.delete(msg.request_seq);
  } else if(msg.type === 'event') {
    if(msg.event.type === 'breakpoints') {
      applyState(msg.event);
    } else if(msg.event.type === 'StoppedEvent') {
      setStatus(`Paused (${msg.event.reason})`, 'paused');
      bannerEl.querySelector('#pausedReason').textContent = msg.event.reason ?? 'breakpoint';
      refresh();
    } else if(msg.event.type === 'terminated') {
      setStatus('Debug target terminated', 'error');
      bannerEl.classList.add('hidden');
    }
  }
}

function consoleLine(cls, text) {
  const line = document.createElement('div');
  line.className = cls;
  line.textContent = text;
  outputEl.appendChild(line);
  outputEl.scrollTop = outputEl.scrollHeight;
}

/* one gdb-style command line, run by the server's Debugger interpreter */
function command(line, echo = true) {
  if(echo) consoleLine('cmd', `(qjs) ${line}`);
  ws.send(JSON.stringify({ type: 'command', line }));
}

const history = [];
let historyPos = 0;
const cmdInput = document.getElementById('cmdInput');

cmdInput.addEventListener('keydown', e => {
  if(e.key === 'Enter') {
    const line = cmdInput.value.trim();
    if(line && history.at(-1) !== line) history.push(line);
    historyPos = history.length;
    /* an empty line repeats the last command, like gdb */
    command(line || history.at(-1) || 'help');
    cmdInput.value = '';
  } else if(e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    historyPos = Math.max(0, Math.min(history.length, historyPos + (e.key === 'ArrowUp' ? -1 : 1)));
    cmdInput.value = history[historyPos] ?? '';
    e.preventDefault();
  }
});

function onOutput(channel, text) {
  const stdin = channel === 3;
  debugLog(1, stdin ? '🡅' : '🡇', stdin ? 'blue' : '#ffc000', 'onOutput', { channel, text });
  const line = document.createElement('div');
  line.className = channel === 2 ? 'stderr' : 'stdout';
  line.textContent = text;
  outputEl.appendChild(line);
  outputEl.scrollTop = outputEl.scrollHeight;
}

/* file tabs: the main program, every file the debuggee stopped in or you opened,
   plus a picker with all the scripts the debugger knows about */
const openTabs = [];
let program = null;
let sources = [];
let stop = null; /* { file, line } of the current stop */

const baseName = f => f.slice(f.lastIndexOf('/') + 1);
const openFile = f => showSource(f, stop?.file === f ? stop.line : null);

function renderTabs() {
  tabsEl.innerHTML = '';

  for(const f of openTabs) {
    const tab = document.createElement('div');
    tab.className = `ftab${f === curFile ? ' active' : ''}`;
    tab.title = f;
    tab.textContent = baseName(f);
    if(f === program) tab.classList.add('main');
    tab.addEventListener('click', () => openFile(f));
    tabsEl.appendChild(tab);
  }

  const picker = document.createElement('select');
  picker.id = 'filePicker';
  picker.title = 'Open a source file';
  picker.add(new Option('Open file…', ''));
  for(const f of new Set([program, ...sources].filter(Boolean))) picker.add(new Option(f === program ? `${f}  (main)` : f, f));
  picker.addEventListener('change', () => picker.value && openFile(picker.value));
  tabsEl.appendChild(picker);
}

/* one fetch per file at a time; an empty or failed answer is shown but not cached */
const inflight = new Map();

function loadSource(filename) {
  const cached = sourceCache.get(filename);
  if(cached !== undefined) return Promise.resolve(cached);

  if(!inflight.has(filename))
    inflight.set(
      filename,
      (async () => {
        try {
          const res = await fetch(`/source?path=${encodeURIComponent(filename)}`);
          const text = res.ok ? await res.text() : `(HTTP ${res.status} fetching ${filename})`;
          if(res.ok && text) sourceCache.set(filename, text);
          return text || `(empty answer for ${filename})`;
        } catch(e) {
          return `(could not load ${filename}: ${e})`;
        } finally {
          inflight.delete(filename);
        }
      })(),
    );

  return inflight.get(filename);
}

async function showSource(filename, line) {
  if(!filename) {
    sourceEl.innerHTML = '<div class="empty">(no source info for this frame)</div>';
    return;
  }

  const text = await loadSource(filename);

  sourceEl.innerHTML = '';
  curFile = filename;
  if(!openTabs.includes(filename)) openTabs.push(filename);
  renderTabs();

  text.split('\n').forEach((codeLine, i) => {
    const div = document.createElement('div');
    div.className = 'row';
    div.dataset.line = i + 1;
    const lineNo = i + 1;
    if(lineNo === line) div.classList.add('current');

    const no = document.createElement('span');
    no.className = 'gutter';
    const dot = document.createElement('span');
    dot.className = 'bp';
    no.append(dot, String(lineNo));
    no.addEventListener('click', e => toggleBreakpoint(filename, lineNo, e));

    const code = document.createElement('span');
    code.className = 'code';
    code.innerHTML = highlightLine(codeLine);

    div.append(no, code);
    markBreakpoint(div, lineNo);
    sourceEl.appendChild(div);
  });

  sourceEl.querySelector('.current')?.scrollIntoView({ block: 'center' });
}

let currentFrameId = 0;

async function refresh() {
  const frames = await request('stackTrace');
  const frame = frames?.[0];
  if(!frame) return;

  currentFrameId = frame.id;
  stop = { file: frame.filename, line: frame.line };
  if(frame.line) {
    document.getElementById('pausedLocation').textContent = `${frame.filename}:${frame.line}`;
    bannerEl.classList.remove('hidden');
  }
  await showSource(frame.filename, frame.line);

  /* refreshes can overlap (stop event + connect query): collect locally, drop stale results */
  const mine = ++refreshSeq;
  const data = [];

  for(const scope of await request('scopes', { frameId: frame.id })) {
    if(scope.expensive) continue;
    data.push({ name: scope.name, vars: await request('variables', { variablesReference: scope.reference }) });
  }

  if(mine !== refreshSeq) return;
  scopeData = data;
  renderVars();
}

function valueClass(v) {
  if(v === undefined || v === '') return '';
  if(v === 'true' || v === 'false') return 'val-boolean';
  if(v === 'null' || v === 'undefined') return 'val-null';
  if(!isNaN(v)) return 'val-number';
  if(/^["'`]/.test(v)) return 'val-string';
  if(/^[{\[]/.test(v)) return 'val-object';
  return '';
}

function renderVars() {
  const term = filterEl.value.toLowerCase();
  varsEl.innerHTML = '';

  for(const { name, vars } of scopeData) {
    const shown = vars.filter(v => !term || v.name.toLowerCase().includes(term));
    if(term && !shown.length) continue;

    const group = document.createElement('div');
    group.className = 'scope-group';

    const heading = document.createElement('div');
    heading.className = 'scope';
    heading.textContent = name;

    const list = document.createElement('div');
    list.className = 'vars';

    for(const v of shown) {
      const row = document.createElement('div');
      row.className = 'variable-row';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'var-name';
      nameSpan.textContent = v.name;

      const valSpan = document.createElement('span');
      valSpan.className = `var-value ${valueClass(v.value)}`;
      valSpan.title = valSpan.textContent = v.value;

      row.append(nameSpan, valSpan);
      list.appendChild(row);
    }

    group.append(heading, list);
    varsEl.appendChild(group);
  }

  if(!varsEl.children.length) varsEl.innerHTML = '<div class="placeholder">No matching variables</div>';
}

let scopeData = [];
let refreshSeq = 0;
filterEl.addEventListener('input', renderVars);

async function evaluate(expression, frameId = currentFrameId) {
  const { result } = await request('evaluate', { expression, frameId });
  return result;
}

function replLine(cls, text) {
  const el = document.createElement('div');
  el.className = cls;
  el.textContent = text;
  replLogEl.appendChild(el);
  replLogEl.scrollTop = replLogEl.scrollHeight;
}

async function runEval() {
  const expression = evalInput.value;
  if(expression) {
    replLine('log-in', `> ${expression}`);
    try {
      replLine('log-out', `= ${await evaluate(expression)}`);
    } catch(err) {
      replLine('log-err', `Error: ${err.message}`);
    }
    evalInput.value = '';
  }
}

const tabs = { tabConsole: 'consoleView', tabRepl: 'replView' };

for(const [tab, view] of Object.entries(tabs))
  document.getElementById(tab).addEventListener('click', () => {
    for(const [t, v] of Object.entries(tabs)) {
      document.getElementById(t).classList.toggle('active', t === tab);
      document.getElementById(v).classList.toggle('hidden', v !== view);
    }
  });

document.getElementById('btnClear').addEventListener('click', () => {
  outputEl.innerHTML = '';
  replLogEl.innerHTML = '';
});

document.getElementById('evalRun').addEventListener('click', runEval);
evalInput.addEventListener('keydown', e => e.key === 'Enter' && runEval());

const keyMap = { F5: 'continue', F9: 'pause', F10: 'next', F11: 'stepIn', F12: 'stepOut' };
const commandOf = { continue: 'continue', pause: 'interrupt', next: 'next', stepIn: 'step', stepOut: 'finish' };

for(const id of ['continue', 'next', 'stepIn', 'stepOut', 'pause'])
  document.getElementById(id).addEventListener('click', () => {
    command(commandOf[id]);
    if(id === 'continue') {
      setStatus('Running…', 'connected');
      bannerEl.classList.add('hidden');
    }
  });

document.addEventListener('keydown', e => {
  const id = keyMap[e.key];
  if(id) {
    e.preventDefault();
    command(commandOf[id]);
  }
});

document.getElementById('hostLabel').textContent = location.host;

ws = new WebSocket(`ws://${location.host}/debug`, 'browser');
ws.binaryType = 'arraybuffer';

let textBuf = new Uint8Array(0);

function decodeFrames() {
  for(;;) {
    if(textBuf.length < 9) return;

    const len = parseInt(new TextDecoder().decode(textBuf.subarray(0, 8)), 16);
    const total = 9 + len;

    if(textBuf.length < total) return;

    onFrame(new TextDecoder().decode(textBuf.subarray(9, total - 1)));
    textBuf = textBuf.subarray(total);
  }
}

ws.onopen = async () => {
  setStatus('Connected — waiting for a debug target…', 'connected');
  ws.send(JSON.stringify({ type: 'command', line: '' })); /* publishes the breakpoint table */

  /* the engine already stopped at entry before this page connected, so no
     StoppedEvent will come: query the current stop instead */
  const timeout = new Promise(resolve => setTimeout(resolve, 2000, null));
  if(await Promise.race([request('stackTrace').catch(() => null), timeout])) {
    setStatus('Paused', 'paused');
    refresh();
  }
};
ws.onclose = () => setStatus('Disconnected', 'error');
ws.onerror = () => setStatus('Connection error', 'error');
ws.onmessage = ({ data }) => {
  if(typeof data == 'string') {
    const chunk = new TextEncoder().encode(data);
    const merged = new Uint8Array(textBuf.length + chunk.length);
    merged.set(textBuf, 0);
    merged.set(chunk, textBuf.length);
    textBuf = merged;
    decodeFrames();
    return;
  }

  const bytes = new Uint8Array(data);
  onOutput(bytes[0], new TextDecoder().decode(bytes.subarray(1)));
};