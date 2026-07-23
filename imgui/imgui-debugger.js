#!/usr/bin/env qjsm
/* imgui-debugger.js — Turbo Debugger-style front-end for the QuickJS debugger.
 *
 *   qjsm imgui-debugger.js [options] <script.js> [script args…]
 *
 * Options:
 *   --host <addr>          listen address            (default 127.0.0.1)
 *   --port <n>             listen port               (default 6499)
 *   --connect <host:port>  attach to a waiting debuggee (QUICKJS_DEBUG_LISTEN_ADDRESS)
 *                          instead of spawning one
 *   --interpreter <bin>    debuggee interpreter      (default qjsm)
 *
 * The GUI comes up immediately, source loaded, before the child even exists.
 * The child is launched on demand (F9 / Run menu / Process panel) through
 * /usr/bin/env QUICKJS_DEBUG_ADDRESS=<host:port> qjsm <script> — no shell.
 *
 * Keys (Turbo Debugger):
 *   F2 toggle breakpoint   F4 run to cursor    F7 trace into   F8 step over
 *   Alt+F8 step out        F9 run/launch       F12 pause       Ctrl+F2 program reset
 *   Ctrl+F7 add watch
 */

import * as path from 'path';
import * as glfw from 'glfw';
import * as ImGui from 'imgui';
import { TextEncoder, TextDecoder } from 'textcode';
import { TcpServerTransport, TcpClientTransport } from './transport.js';
import { DebuggerSession } from './debugger-client.js';
import { VarNode, VarTreeView } from './var-tree.js';
import { SourceCache, SourceView } from './source-view.js';
import { DebugTarget } from './target.js';

/* ---- EGA palette (the 16 colors of the 6-bit RGBI default text palette) -- */

const A = 0xaa / 0xff,
  F = 1.0,
  H = 0x55 / 0xff;

const EGA = {
  BLACK: [0, 0, 0, 1],
  BLUE: [0, 0, A, 1],
  GREEN: [0, A, 0, 1],
  CYAN: [0, A, A, 1] /* dark cyan */,
  RED: [A, 0, 0, 1],
  MAGENTA: [A, 0, A, 1],
  BROWN: [A, H, 0, 1],
  LIGHTGRAY: [A, A, A, 1] /* gray */,
  DARKGRAY: [H, H, H, 1],
  LIGHTBLUE: [H, H, F, 1],
  LIGHTGREEN: [H, F, H, 1],
  LIGHTCYAN: [H, F, F, 1],
  LIGHTRED: [F, H, H, 1],
  LIGHTMAGENTA: [F, H, F, 1],
  YELLOW: [F, F, H, 1],
  WHITE: [F, F, F, 1],
};

/* Source colors, exactly as specified:
 * keywords = red, identifiers = yellow, comments = green,
 * operators & parentheses & numbers = cyan. */
const SRC_PALETTE = {
  tokens: {
    keyword: EGA.RED,
    identifier: EGA.YELLOW,
    comment: EGA.GREEN,
    number: EGA.CYAN,
    other: EGA.CYAN /* operators, parens, punctuation */,
    string: EGA.WHITE,
    whitespace: EGA.LIGHTGRAY,
  },
  gutter: EGA.LIGHTGRAY,
  gutterBp: EGA.LIGHTRED,
  gutterCur: EGA.WHITE,
  currentLine: EGA.WHITE,
};

const TREE_PALETTE = {
  dim: EGA.DARKGRAY,
  error: EGA.LIGHTRED,
  types: {
    string: EGA.LIGHTGREEN,
    integer: EGA.LIGHTCYAN,
    float: EGA.LIGHTCYAN,
    boolean: EGA.LIGHTMAGENTA,
    null: EGA.DARKGRAY,
    undefined: EGA.DARKGRAY,
    object: EGA.WHITE,
    default: EGA.LIGHTGRAY,
  },
};

const has = n => typeof ImGui[n] == 'function';
const W = n => ImGui.WindowFlags?.[n] ?? 0;
const COND_FIRST = ImGui.Cond?.FirstUseEver ?? 4;
const ENTER_FLAG = ImGui.InputTextFlags?.EnterReturnsTrue ?? 0x20;

/* qjs-imgui's ImGui.InputText takes an ArrayBuffer, not a [string] ref, and
 * ImGui.InputTextWithHint is exposed but its C++ dispatch is empty (a no-op).
 * EditBuf wraps a fixed-size NUL-terminated UTF-8 ArrayBuffer that we drive
 * with ImGui.InputText + EnterReturnsTrue. */
const utf8enc = new TextEncoder();
const utf8dec = new TextDecoder();

class EditBuf {
  constructor(initial = '', size = 512) {
    this.buf = new ArrayBuffer(size);
    this.set(initial);
  }
  get value() {
    const bytes = new Uint8Array(this.buf);
    let end = 0;
    while(end < bytes.length && bytes[end] !== 0) end++;
    return utf8dec.decode(bytes.subarray(0, end));
  }
  set(s) {
    const bytes = new Uint8Array(this.buf);
    const enc = utf8enc.encode(String(s ?? ''));
    const n = Math.min(enc.length, bytes.length - 1);
    bytes.set(enc.subarray(0, n));
    for(let i = n; i < bytes.length; i++) bytes[i] = 0;
  }
  clear() {
    new Uint8Array(this.buf)[0] = 0;
  }
}

/* Turbo Debugger 5.0 chrome: blue panels, dark-cyan accents, gray status bar. */
function applyTurboTheme() {
  if(!has('PushStyleColor')) {
    ImGui.StyleColorsClassic();
    return;
  }
  const C = (name, fallback) => ImGui.Col?.[name] ?? fallback;
  const theme = [
    [C('Text', 0), EGA.LIGHTGRAY],
    [C('TextDisabled', 1), EGA.DARKGRAY],
    [C('WindowBg', 2), EGA.BLUE],
    [C('ChildBg', 3), EGA.BLUE],
    [C('PopupBg', 4), EGA.CYAN],
    [C('Border', 5), EGA.LIGHTGRAY],
    [C('FrameBg', 7), EGA.CYAN],
    [C('FrameBgHovered', 8), EGA.DARKGRAY],
    [C('FrameBgActive', 9), EGA.DARKGRAY],
    [C('TitleBg', 10), EGA.BLUE],
    [C('TitleBgActive', 11), EGA.CYAN],
    [C('TitleBgCollapsed', 12), EGA.BLUE],
    [C('MenuBarBg', 13), EGA.CYAN],
    [C('ScrollbarBg', 14), EGA.DARKGRAY],
    [C('ScrollbarGrab', 15), EGA.LIGHTGRAY],
    [C('Button', 21), EGA.CYAN],
    [C('ButtonHovered', 22), EGA.GREEN],
    [C('ButtonActive', 23), EGA.LIGHTGREEN],
    [C('Header', 24), EGA.CYAN],
    [C('HeaderHovered', 25), EGA.GREEN],
    [C('HeaderActive', 26), EGA.GREEN],
  ];
  for(const [idx, col] of theme) ImGui.PushStyleColor(idx, col);
}

/* ---- small UI helpers ---------------------------------------------------- */

/* Enter-to-submit. `hint` is dropped (InputTextWithHint is a no-op in the
 * current qjs-imgui bindings); we render the hint as dim text when the
 * buffer is empty, then swap in the live editor. */
function textInput(label, hint, buf) {
  return ImGui.InputText(label, buf.buf, buf.buf.byteLength, ENTER_FLAG);
}

/* Two-column key/value list, using ImGui.Columns() because the Tables API
 * (BeginTable/EndTable/TableNextRow/…) is defined in the C++ dispatch of
 * qjs-imgui but never registered in its JSCFunctionListEntry array. */
function kvTable(id, obj) {
  ImGui.Columns(2, id, true);
  for(const [k, v] of Object.entries(obj)) {
    ImGui.TextColored(EGA.YELLOW, '%s', k);
    ImGui.NextColumn();
    ImGui.Text('%s', String(v));
    ImGui.NextColumn();
  }
  ImGui.Columns(1);
}

function frameLabel(f, i) {
  const file = f.filename ?? f.file ?? '?';
  return `#${i}  ${f.name || '<anonymous>'}  ${path.basename(file)}:${f.line ?? '?'}`;
}

/* ---- the application ------------------------------------------------------ */

class TurboDebugger {
  session;
  target;
  transport;
  attachOnly;

  srcCache = new SourceCache();
  srcView;
  scopesTree = new VarTreeView('scopes', TREE_PALETTE);
  watchTree = new VarTreeView('watch', TREE_PALETTE);
  consoleTree = new VarTreeView('console', TREE_PALETTE);

  scopeRoots = [];
  watches = []; /* { expr, node } */
  consoleLog = []; /* { kind:'in'|'out'|'err'|'sys', text, node? } */
  protoLog = [];
  activeFrame = 0;
  pendingRun = false;
  focusWatchInput = false;

  watchInput = new EditBuf();
  consoleInput = new EditBuf();

  panels = {
    module: [true],
    stack: [true],
    variables: [true],
    watches: [true],
    process: [true],
    breakpoints: [false],
    console: [true],
    protocol: [false],
  };

  constructor({ transport, attachOnly, script, scriptArgs, interpreter }) {
    this.transport = transport;
    this.attachOnly = attachOnly;
    this.session = new DebuggerSession(transport);
    this.srcView = new SourceView(this.srcCache, SRC_PALETTE);

    this.target = new DebugTarget({
      script: script ?? '<attach>',
      args: scriptArgs,
      interpreter,
      address: transport.address ?? `${transport.host}:${transport.port}`,
    });

    if(script) {
      this.srcCache.load(script); /* source visible before the child exists */
      this.srcView.show(script, 1);
    }

    this.#wire();
  }

  #wire() {
    const s = this.session;

    s.onlog = (dir, text) => {
      this.protoLog.push({ dir, text: text.length > 400 ? text.slice(0, 400) + '…' : text });
      if(this.protoLog.length > 400) this.protoLog.splice(0, this.protoLog.length - 400);
    };

    s.onstopped = (event, frames) => {
      if(event.reason === 'entry') {
        this.sys(`attached — stopped at entry`);
        s.syncAllBreakpoints();
        if(this.pendingRun) {
          this.pendingRun = false;
          s.resume();
          return;
        }
      }
      /* drop temp (run-to-cursor) breakpoints that did their job */
      for(const [p, list] of s.breakpoints) {
        const kept = list.filter(b => !b.temp);
        if(kept.length !== list.length) {
          s.breakpoints.set(p, kept);
          s.syncBreakpoints(p);
        }
      }
      this.selectFrame(0);
    };

    s.onresumed = () => {
      this.scopeRoots = [];
    };

    s.onterminated = () => {
      this.sys('debuggee terminated');
      this.target.terminated();
      this.scopeRoots = [];
    };

    s.onthread = e => this.sys(`thread ${e.reason}: ${e.thread}`);

    this.transport.onstatechange = t => {
      if(t.connected) {
        this.sys(`debuggee connected (${t.peer ?? t.url ?? ''})`);
        this.session.resetConnectionState();
        this.target.attached();
      } else {
        this.sys('debug connection closed');
        this.session.state = this.session.state === 'terminated' ? 'terminated' : 'detached';
      }
    };
  }

  sys(text) {
    this.consoleLog.push({ kind: 'sys', text });
  }

  /* generation-guarded provider for all variable trees (see var-tree.js) */
  get provider() {
    const s = this.session,
      gen = s.stopGeneration;
    return {
      variables: (ref, opts, cb) => {
        if(s.state !== 'stopped' || s.stopGeneration !== gen) return false;
        s.variables(ref, opts, cb);
        return true;
      },
    };
  }

  /* ---- actions ---------------------------------------------------------- */

  run() {
    const s = this.session;
    if(s.state === 'stopped') return void s.resume();
    if(!this.attachOnly && !this.target.started && !s.connected) {
      this.pendingRun = true;
      if(this.target.start()) this.sys(`launched: ${this.target.cmdline.join(' ')}`);
      else this.sys(`spawn failed: ${this.target.lastError}`);
    }
  }

  reset() {
    if(this.attachOnly) return;
    this.pendingRun = false; /* stop at entry, like TD's program reset */
    this.transport.codec?.reset?.();
    this.session.resetConnectionState();
    if(this.target.started) this.target.kill();
    if(this.target.start()) this.sys('program reset — relaunched, will stop at entry');
  }

  toggleBpAtCursor() {
    if(!this.srcView.file) return;
    const on = this.session.toggleBreakpoint(this.srcView.file, this.srcView.cursorLine);
    this.sys(`${on ? 'set' : 'cleared'} breakpoint ${path.basename(this.srcView.file)}:${this.srcView.cursorLine}`);
  }

  runToCursor() {
    if(this.srcView.file) this.session.runToLine(this.srcView.file, this.srcView.cursorLine);
  }

  selectFrame(i) {
    const s = this.session;
    if(!s.frames[i]) return;
    this.activeFrame = i;
    const f = s.frames[i];
    const file = f.filename ?? f.file;
    if(file) this.srcView.show(file, f.line ?? 1);

    const gen = s.stopGeneration;
    s.scopes(f.id ?? i, scopes => {
      if(!Array.isArray(scopes) || s.stopGeneration !== gen || s.state !== 'stopped') return;
      this.scopeRoots = scopes.map(sc => new VarNode({ name: sc.name, value: '', type: 'scope', ref: sc.reference, path: `scope/${sc.name}` }));
      for(const root of this.scopeRoots)
        if(root.name !== 'Global') {
          /* Global is expensive — fetch only on expand */ root.fetch(this.provider);
          this.scopesTree.expanded.add(root.path);
        }
      this.scopesTree.reExpand(this.scopeRoots, this.provider);
    });

    this.refreshWatches();
  }

  refreshWatches() {
    const s = this.session;
    if(s.state !== 'stopped') return;
    const frameId = s.frames[this.activeFrame]?.id ?? this.activeFrame;
    for(const w of this.watches)
      s.evaluate(frameId, w.expr, body => {
        w.node = VarNode.fromEvaluation(w.expr, body, `watch${this.watches.indexOf(w)}`);
      });
  }

  addWatch(expr) {
    expr = expr.trim();
    if(!expr) return;
    this.watches.push({ expr, node: null });
    this.refreshWatches();
  }

  evalConsole(expr) {
    expr = expr.trim();
    if(!expr) return;
    this.consoleLog.push({ kind: 'in', text: expr });
    if(this.session.state !== 'stopped') {
      this.consoleLog.push({ kind: 'err', text: 'cannot evaluate: debuggee not stopped' });
      return;
    }
    const frameId = this.session.frames[this.activeFrame]?.id ?? this.activeFrame;
    const n = this.consoleLog.length;
    this.session.evaluate(frameId, expr, body => {
      this.consoleLog.push({ kind: 'out', text: '', node: VarNode.fromEvaluation(expr, body, `con${n}`) });
    });
  }

  key(keycode, mods) {
    const K = name => glfw['KEY_' + name] ?? { F2: 291, F4: 293, F7: 296, F8: 297, F9: 298, F12: 301 }[name];
    const CTRL = (glfw.MOD_CONTROL ?? 2) & mods,
      ALT = (glfw.MOD_ALT ?? 4) & mods;
    const s = this.session;

    if(keycode === K('F2')) CTRL ? this.reset() : this.toggleBpAtCursor();
    else if(keycode === K('F4')) this.runToCursor();
    else if(keycode === K('F7')) CTRL ? (this.focusWatchInput = true) : s.stepIn();
    else if(keycode === K('F8')) ALT ? s.stepOut() : s.next();
    else if(keycode === K('F9')) this.run();
    else if(keycode === K('F12')) s.pause();
  }

  /* ---- per-frame --------------------------------------------------------- */

  pump() {
    this.target.poll();
    this.session.pump();
  }

  /* qjs-imgui's ImGuiIO wrapper exposes only 4 methods (no DisplaySize
   * getter), so the app is driven from the GLFW window size instead. */
  draw(w, h) {
    this.#backdrop(w, h);
    if(this.panels.module[0]) this.#moduleWindow();
    if(this.panels.stack[0]) this.#stackWindow();
    if(this.panels.variables[0]) this.#variablesWindow();
    if(this.panels.watches[0]) this.#watchesWindow();
    if(this.panels.process[0]) this.#processWindow();
    if(this.panels.breakpoints[0]) this.#breakpointsWindow();
    if(this.panels.console[0]) this.#consoleWindow();
    if(this.panels.protocol[0]) this.#protocolWindow();
  }

  #backdrop(w, h) {
    if(has('PushStyleColor')) ImGui.PushStyleColor(ImGui.Col?.WindowBg ?? 2, EGA.DARKGRAY); /* TD desktop */
    ImGui.SetNextWindowPos([0, 0]);
    ImGui.SetNextWindowSize([w, h]);
    ImGui.Begin('##desktop', null, W('NoTitleBar') | W('NoResize') | W('NoMove') | W('NoScrollbar') | W('NoCollapse') | W('NoBringToFrontOnFocus') | W('MenuBar'));
    this.#menuBar();
    this.#statusBar(w, h);
    ImGui.End();
    if(has('PopStyleColor')) ImGui.PopStyleColor();
  }

  #menuBar() {
    if(!ImGui.BeginMenuBar()) return;
    const s = this.session;

    if(ImGui.BeginMenu('≡ File')) {
      if(ImGui.MenuItem('Quit', 'Alt+X')) this.quit = true;
      ImGui.EndMenu();
    }

    if(ImGui.BeginMenu('Run')) {
      if(ImGui.MenuItem('Run', 'F9')) this.run();
      if(ImGui.MenuItem('Step over', 'F8')) s.next();
      if(ImGui.MenuItem('Trace into', 'F7')) s.stepIn();
      if(ImGui.MenuItem('Step out', 'Alt+F8')) s.stepOut();
      if(ImGui.MenuItem('Run to cursor', 'F4')) this.runToCursor();
      if(ImGui.MenuItem('Pause', 'F12')) s.pause();
      ImGui.Separator();
      if(ImGui.MenuItem('Program reset', 'Ctrl+F2')) this.reset();
      ImGui.EndMenu();
    }

    if(ImGui.BeginMenu('Breakpoints')) {
      if(ImGui.MenuItem('Toggle at cursor', 'F2')) this.toggleBpAtCursor();
      if(ImGui.MenuItem('Clear all')) s.clearBreakpoints();
      if(ImGui.MenuItem(`${s.exceptionBreak ? '[x]' : '[ ]'} Stop on exception`)) s.stopOnException(!s.exceptionBreak);
      ImGui.EndMenu();
    }

    if(ImGui.BeginMenu('Data')) {
      if(ImGui.MenuItem('Add watch…', 'Ctrl+F7')) {
        this.panels.watches[0] = true;
        this.focusWatchInput = true;
      }
      ImGui.EndMenu();
    }

    if(ImGui.BeginMenu('View')) {
      for(const [name, flag] of Object.entries(this.panels)) if(ImGui.MenuItem(`${flag[0] ? '[x]' : '[ ]'} ${name[0].toUpperCase() + name.slice(1)}`)) flag[0] = !flag[0];
      ImGui.EndMenu();
    }

    ImGui.EndMenuBar();
  }

  #statusBar(w, h) {
    const s = this.session,
      t = this.target;
    let state;
    if(s.state === 'stopped') {
      const f = s.frames[0];
      state = `STOPPED (${s.stopReason}) at ${f ? `${path.basename(f.filename ?? f.file ?? '?')}:${f.line}` : '?'}`;
    } else if(s.state === 'running') state = 'RUNNING';
    else if(s.state === 'terminated' || t.state === 'exited') state = `TERMINATED${t.exitCode !== null ? ` (exit ${t.exitCode})` : ''}`;
    else if(t.state === 'launching') state = 'LAUNCHING — waiting for debug connection';
    else state = `READY — F9 runs ${path.basename(t.script)}`;

    ImGui.SetCursorPos([8, h - 44]);
    if(has('PushStyleColor')) {
      ImGui.PushStyleColor(ImGui.Col?.ChildBg ?? 3, EGA.LIGHTGRAY);
      ImGui.BeginChild('##status', [w - 16, 24]);
      ImGui.TextColored(EGA.BLACK, ' F2-Bkpt  F4-Here  F7-Trace  F8-Step  Alt+F8-Out  F9-Run  F12-Pause  Ctrl+F2-Reset  Ctrl+F7-Watch  |  %s', state);
      ImGui.EndChild();
      ImGui.PopStyleColor();
    } else ImGui.Text('F2-Bkpt F4-Here F7-Trace F8-Step F9-Run | %s', state);
  }

  #moduleWindow() {
    const s = this.session;
    ImGui.SetNextWindowPos([10, 40], COND_FIRST);
    ImGui.SetNextWindowSize([770, 470], COND_FIRST);
    const title = `Module: ${this.srcView.file ? path.basename(this.srcView.file) : '(none)'}###module`;

    if(ImGui.Begin(title)) {
      const files = [...new Set([...this.srcCache.knownFiles, ...s.frames.map(f => f.filename ?? f.file).filter(Boolean)])];
      const curIdx = [Math.max(0, files.indexOf(this.srcView.file))];
      ImGui.PushItemWidth(360);
      if(files.length && ImGui.Combo('##modsel', curIdx, files)) this.srcView.show(files[curIdx[0]]);
      ImGui.PopItemWidth();
      ImGui.Separator();

      const f = s.state === 'stopped' ? s.frames[this.activeFrame] : null;
      const curFile = f ? (f.filename ?? f.file) : null;

      this.srcView.render({
        currentLine: curFile === this.srcView.file ? (f?.line ?? -1) : -1,
        isBreakpoint: line => !!s.findBreakpoint(this.srcView.file, line),
      });
    }
    ImGui.End();
  }

  #stackWindow() {
    ImGui.SetNextWindowPos([790, 40], COND_FIRST);
    ImGui.SetNextWindowSize([480, 180], COND_FIRST);
    if(ImGui.Begin('Stack###stack')) {
      const s = this.session;
      if(s.state !== 'stopped') ImGui.TextDisabled('(running)');
      else
        s.frames.forEach((f, i) => {
          if(ImGui.Selectable(`${frameLabel(f, i)}##frame${i}`, i === this.activeFrame)) this.selectFrame(i);
        });
    }
    ImGui.End();
  }

  #variablesWindow() {
    ImGui.SetNextWindowPos([790, 230], COND_FIRST);
    ImGui.SetNextWindowSize([480, 280], COND_FIRST);
    if(ImGui.Begin('Variables###variables')) {
      if(this.session.state !== 'stopped') ImGui.TextDisabled('(no scope — debuggee running)');
      else this.scopesTree.render(this.scopeRoots, this.provider);
    }
    ImGui.End();
  }

  #watchesWindow() {
    ImGui.SetNextWindowPos([10, 520], COND_FIRST);
    ImGui.SetNextWindowSize([770, 180], COND_FIRST);
    if(ImGui.Begin('Watches###watches')) {
      if(this.focusWatchInput && has('SetKeyboardFocusHere')) ImGui.SetKeyboardFocusHere();
      this.focusWatchInput = false;

      ImGui.PushItemWidth(400);
      const submitted = textInput('##wexpr', 'expression…', this.watchInput);
      ImGui.PopItemWidth();
      ImGui.SameLine();
      if(ImGui.Button('Add watch') || submitted) {
        this.addWatch(this.watchInput.value);
        this.watchInput.clear();
      }

      let remove = -1;
      this.watches.forEach((w, i) => {
        ImGui.PushID(1000 + i);
        if(ImGui.SmallButton('x')) remove = i;
        ImGui.SameLine();
        if(w.node) this.watchTree.render([w.node], this.provider);
        else ImGui.TextColored(EGA.DARKGRAY, '%s = <not evaluated>', w.expr);
        ImGui.PopID();
      });
      if(remove >= 0) this.watches.splice(remove, 1);
    }
    ImGui.End();
  }

  #processWindow() {
    ImGui.SetNextWindowPos([790, 520], COND_FIRST);
    ImGui.SetNextWindowSize([480, 180], COND_FIRST);
    if(ImGui.Begin('Process###process')) {
      if(!this.attachOnly) {
        if(ImGui.Button(this.target.started ? 'Kill' : 'Start')) this.target.started ? this.target.kill() : this.run();
        ImGui.SameLine();
        if(ImGui.Button('Restart')) this.reset();
        ImGui.Separator();
      }
      ImGui.TextColored(EGA.YELLOW, 'Child process');
      kvTable('##proc', this.target.info());
      ImGui.Spacing();
      ImGui.TextColored(EGA.YELLOW, 'Debug connection');
      kvTable('##sock', this.transport.info());
    }
    ImGui.End();
  }

  #breakpointsWindow() {
    ImGui.SetNextWindowPos([200, 200], COND_FIRST);
    ImGui.SetNextWindowSize([620, 240], COND_FIRST);
    if(ImGui.Begin('Breakpoints###breakpoints')) {
      const s = this.session;
      let row = 0;
      for(const [file, list] of s.breakpoints)
        for(const bp of [...list]) {
          ImGui.PushID(2000 + row++);
          const en = [bp.enabled];
          if(ImGui.Checkbox('##en', en)) {
            bp.enabled = en[0];
            s.syncBreakpoints(file);
          }
          ImGui.SameLine();
          ImGui.Text('%s:%d  (hits: %d)', path.basename(file), bp.line, bp.hits);
          ImGui.SameLine();
          bp._buf ??= new EditBuf(bp.condition ?? '');
          ImGui.PushItemWidth(200);
          if(ImGui.InputText('##cond', bp._buf.buf, bp._buf.buf.byteLength, ENTER_FLAG)) bp.condition = bp._buf.value || null;
          ImGui.PopItemWidth();
          ImGui.SameLine();
          if(ImGui.SmallButton('x')) s.removeBreakpoint(file, bp.line);
          ImGui.PopID();
        }
      if(row === 0) ImGui.TextDisabled('(no breakpoints — F2 in the Module window)');
    }
    ImGui.End();
  }

  #consoleWindow() {
    ImGui.SetNextWindowPos([10, 705], COND_FIRST);
    ImGui.SetNextWindowSize([1260, 90], COND_FIRST);
    if(ImGui.Begin('Console###console')) {
      const footer = 30;
      if(has('BeginChild')) ImGui.BeginChild('##conlog', [0, -footer]);

      for(let i = 0; i < this.consoleLog.length; i++) {
        const e = this.consoleLog[i];
        if(e.kind === 'in') ImGui.TextColored(EGA.YELLOW, '> %s', e.text);
        else if(e.kind === 'err') ImGui.TextColored(EGA.LIGHTRED, '%s', e.text);
        else if(e.kind === 'sys') ImGui.TextColored(EGA.LIGHTCYAN, '** %s', e.text);
        else if(e.node) {
          ImGui.PushID(3000 + i);
          this.consoleTree.render([e.node], this.provider);
          ImGui.PopID();
        }
      }
      if(has('BeginChild')) {
        if(has('GetScrollY') && has('GetScrollMaxY') && has('SetScrollY')) if (ImGui.GetScrollY() >= ImGui.GetScrollMaxY() - 20) ImGui.SetScrollY(ImGui.GetScrollMaxY());
        ImGui.EndChild();
      }

      ImGui.PushItemWidth(-80);
      const submitted = textInput('##cin', 'evaluate in current frame…', this.consoleInput);
      ImGui.PopItemWidth();
      ImGui.SameLine();
      if(ImGui.Button('Eval') || submitted) {
        this.evalConsole(this.consoleInput.value);
        this.consoleInput.clear();
      }
    }
    ImGui.End();
  }

  #protocolWindow() {
    ImGui.SetNextWindowPos([300, 150], COND_FIRST);
    ImGui.SetNextWindowSize([700, 400], COND_FIRST);
    if(ImGui.Begin('Protocol###protocol')) {
      for(const e of this.protoLog) {
        const col = e.dir === '->' ? EGA.LIGHTGREEN : e.dir === '<-' ? EGA.LIGHTCYAN : EGA.YELLOW;
        ImGui.TextColored(col, '%s %s', e.dir, e.text);
      }
    }
    ImGui.End();
  }
}

/* ---- entry point ----------------------------------------------------------- */

function parseArgs(argv) {
  const opts = { host: '127.0.0.1', port: 6499, connect: null, interpreter: 'qjsm', script: null, scriptArgs: [] };
  for(let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if(opts.script !== null) opts.scriptArgs.push(a);
    else if(a === '--host') opts.host = argv[++i];
    else if(a === '--port') opts.port = Number(argv[++i]);
    else if(a === '--connect') opts.connect = argv[++i];
    else if(a === '--interpreter' || a === '-i') opts.interpreter = argv[++i];
    else opts.script = a;
  }
  return opts;
}

function main(argv) {
  const opts = parseArgs(argv);

  if(!opts.script && !opts.connect) {
    console.log('usage: qjsm imgui-debugger.js [--host A] [--port N] [--connect host:port] [--interpreter qjsm] <script.js> [args…]');
    return 1;
  }

  let transport;
  if(opts.connect) {
    const [h, p] = opts.connect.split(':');
    transport = new TcpClientTransport({ host: h, port: Number(p) }).connect();
  } else {
    transport = new TcpServerTransport({ host: opts.host, port: opts.port }).listen();
    console.log(`listening for debuggee on ${transport.address}`);
  }

  const app = new TurboDebugger({
    transport,
    attachOnly: !!opts.connect,
    script: opts.script,
    scriptArgs: opts.scriptArgs,
    interpreter: opts.interpreter,
  });

  /* glfw is initialised at module-import time by qjs-glfw; no glfw.init().
   * Match the working test-imgui.js context: GL 3.2 core forward-compat +
   * MSAA. Without these hints GLFW picks a legacy compat profile whose
   * driver silently fails to link ImGui's `#version 150 core` shaders, which
   * is what makes text render as invisible glyphs while chrome rectangles
   * (drawn by the still-valid vertex program) still show. */
  glfw.Window.hint(glfw.CONTEXT_VERSION_MAJOR, 3);
  glfw.Window.hint(glfw.CONTEXT_VERSION_MINOR, 2);
  glfw.Window.hint(glfw.OPENGL_PROFILE, glfw.OPENGL_CORE_PROFILE);
  glfw.Window.hint(glfw.OPENGL_FORWARD_COMPAT, true);
  glfw.Window.hint(glfw.SAMPLES, 4);
  glfw.Window.hint(glfw.RESIZABLE, true);

  const win = new glfw.Window(1280, 800, 'Turbo Debugger - QuickJS');
  win.makeContextCurrent();
  glfw.context.swapInterval(1);

  /* qjs-imgui's dispatch model: register renderer/platform impls with Init(),
   * then CreateContext(window, install_callbacks, glsl_version) internally
   * calls ImplGlfw.InitForOpenGL(window, install_callbacks) and
   * ImplOpenGL3.Init(glsl_version). ImGui.NewFrame() then auto-invokes each
   * impl's NewFrame; ImGui.RenderDrawData(data) dispatches to the renderer.
   * `#version 150` matches the 3.2 core context. `install_callbacks=false`
   * because we install our own key handler below; otherwise the backend's
   * KeyCallback and ours would race for the same GLFW slot. */
  ImGui.Init(ImGui.ImplGlfw, ImGui.ImplOpenGL3);
  ImGui.CreateContext(win, false, '#version 150');
  ImGui.StyleColorsDark();
  applyTurboTheme();

  /* Force the font atlas onto the GPU up-front so a missing/broken font
   * texture surfaces here (as a `false` return) instead of silently
   * rendering all glyphs as invisible quads on the first frame. */
  ImGui.ImplOpenGL3.CreateFontsTexture();

  /* Forward the input events the backend would have installed itself, plus
   * our own F-key hotkeys. Order matters: forward first, hotkeys last, so a
   * caught hotkey doesn't also steer ImGui. */
  win.handleKey = (key, sc, action, mods) => {
    ImGui.ImplGlfw.KeyCallback(win, key, sc, action, mods);
    if(action === (glfw.PRESS ?? 1)) app.key(key, mods);
  };
  win.handleChar = c => ImGui.ImplGlfw.CharCallback(win, c);
  win.handleMouseButton = (btn, action, mods) => ImGui.ImplGlfw.MouseButtonCallback(win, btn, action, mods);
  win.handleScroll = (x, y) => ImGui.ImplGlfw.ScrollCallback(win, x, y);
  win.handleCursorEnter = e => ImGui.ImplGlfw.CursorEnterCallback(win, e);
  win.handleFocus = e => ImGui.ImplGlfw.WindowFocusCallback(win, e);

  while(!win.shouldClose && !app.quit) {
    glfw.poll();
    app.pump();

    ImGui.NewFrame();

    const { width: winW, height: winH } = win.size;
    app.draw(winW, winH);

    ImGui.Render();
    ImGui.RenderDrawData(ImGui.GetDrawData());
    win.swapBuffers();
  }

  app.target.kill();
  transport.close();

  ImGui.ImplOpenGL3.Shutdown();
  ImGui.ImplGlfw.Shutdown();
  ImGui.DestroyContext();
  win.destroy();
  glfw.terminate();
  return 0;
}

main(globalThis.scriptArgs?.slice(1) ?? []);
