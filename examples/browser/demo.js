/**
 * Talks to server.js over the WebSocket at /debug. Two kinds of WS message
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
const filenameEl = document.getElementById('activeFilename');
const replLogEl = document.getElementById('replLog');
const filterEl = document.getElementById('varFilter');
const sourceEl = document.getElementById('source');
const varsEl = document.getElementById('vars');
const outputEl = document.getElementById('output');
const evalInput = document.getElementById('evalInput');
const sourceCache = new Map();
const breakpoints = new Map(); // filename -> Set<line>

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

function toggleBreakpoint(filename, line, div) {
  let set = breakpoints.get(filename);
  if(!set) breakpoints.set(filename, (set = new Set()));
  if(set.has(line)) set.delete(line);
  else set.add(line);
  div.classList.toggle('breakpoint', set.has(line));
  ws.send(JSON.stringify({ type: 'breakpoints', breakpoints: { path: filename, breakpoints: [...set].map(line => ({ line })) } }));
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
  if(msg.type === 'response') {
    pending.get(msg.request_seq)?.(msg.body);
    pending.delete(msg.request_seq);
  } else if(msg.type === 'event') {
    if(msg.event.type === 'StoppedEvent') {
      setStatus(`Paused (${msg.event.reason})`, 'paused');
      bannerEl.querySelector('#pausedReason').textContent = msg.event.reason ?? 'breakpoint';
      refresh();
    } else if(msg.event.type === 'terminated') {
      setStatus('Debug target terminated', 'error');
      bannerEl.classList.add('hidden');
    }
  }
}

function onOutput(channel, text) {
  const stdin = channel === 3;
  debugLog(1, stdin ? '🡅' : '🡇', stdin ? 'blue' : '#ffc000', 'onOutput', { channel, text });
  const line = document.createElement('div');
  line.className = channel === 2 ? 'stderr' : 'stdout';
  line.textContent = text;
  outputEl.appendChild(line);
  outputEl.scrollTop = outputEl.scrollHeight;
}

async function showSource(filename, line) {
  if(!filename) {
    sourceEl.innerHTML = '<div class="empty">(no source info for this frame)</div>';
    bannerEl.classList.add('hidden');
    return;
  }

  let text = sourceCache.get(filename);

  if(text === undefined) {
    const url = `/source?path=${encodeURIComponent(filename)}`;
    try {
      const res = await fetch(url);
      text = res.ok ? await res.text() : `(HTTP ${res.status} fetching ${filename})`;
    } catch(e) {
      text = `(could not load ${filename}: ${e})`;
    }
    sourceCache.set(filename, text);
  }

  sourceEl.innerHTML = '';
  filenameEl.textContent = filename;

  if(line) {
    document.getElementById('pausedLocation').textContent = `${filename}:${line}`;
    bannerEl.classList.remove('hidden');
  } else bannerEl.classList.add('hidden');

  text.split('\n').forEach((codeLine, i) => {
    const div = document.createElement('div');
    div.className = 'row';
    const lineNo = i + 1;
    if(lineNo === line) div.classList.add('current');
    if(breakpoints.get(filename)?.has(lineNo)) div.classList.add('breakpoint');

    const no = document.createElement('span');
    no.className = 'gutter';
    const dot = document.createElement('span');
    dot.className = 'bp';
    no.append(dot, String(lineNo));
    no.addEventListener('click', () => toggleBreakpoint(filename, lineNo, div));

    const code = document.createElement('span');
    code.className = 'code';
    code.innerHTML = highlightLine(codeLine);

    div.append(no, code);
    sourceEl.appendChild(div);
  });

  sourceEl.querySelector('.current')?.scrollIntoView({ block: 'center' });
}

let currentFrameId = 0;

/* like gdb's `start`: on the first (entry) stop, run to main() if the main
   script has one; otherwise stay at the first statement */
let started = false;

async function findMain(filename) {
  if(!sourceCache.has(filename)) await showSource(filename);
  const lines = (sourceCache.get(filename) ?? '').split('\n');
  const i = lines.findIndex(l => /^\s*(?:async\s+)?function\s+main\s*\(/.test(l) && /\{\s*$/.test(l));
  if(i < 0) return 0;
  for(let n = i + 1; n < lines.length; n++) {
    const t = lines[n].trim();
    if(t && !t.startsWith('//')) return n + 1;
  }
  return 0;
}

async function refresh() {
  const frames = await request('stackTrace');
  const frame = frames?.[0];
  if(!frame) return;

  if(!started) {
    started = true;
    const line = frame.filename && (await findMain(frame.filename));
    if(line) {
      const set = new Set([line]);
      breakpoints.set(frame.filename, set);
      ws.send(JSON.stringify({ type: 'breakpoints', breakpoints: { path: frame.filename, breakpoints: [{ line }] } }));
      request('continue');
      setStatus(`Running to main() at ${frame.filename}:${line}…`, 'connected');
      return;
    }
  }

  currentFrameId = frame.id;
  await showSource(frame.filename, frame.line);

  scopeData = [];

  for(const scope of await request('scopes', { frameId: frame.id })) {
    if(scope.expensive) continue;
    scopeData.push({ name: scope.name, vars: await request('variables', { variablesReference: scope.reference }) });
  }

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

for(const id of ['continue', 'next', 'stepIn', 'stepOut', 'pause'])
  document.getElementById(id).addEventListener('click', () => {
    request(id);
    if(id === 'continue') {
      setStatus('Running…', 'connected');
      bannerEl.classList.add('hidden');
    }
  });

document.addEventListener('keydown', e => {
  const id = keyMap[e.key];
  if(id) {
    e.preventDefault();
    request(id);
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

  /* the engine already stopped at entry before this page connected, so no
     StoppedEvent will come: query the current stop instead */
  const timeout = new Promise(resolve => setTimeout(resolve, 2000, null));
  if(await Promise.race([request('stackTrace').catch(() => null), timeout])) {
    setStatus('Paused (entry)', 'paused');
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