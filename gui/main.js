/**
 * gui/main.js — GUI debugger mode entry (phase 2: core debugging).
 *
 * Opens a glfw window with a nanovg GL3 context, lays out the panes
 * (toolbar, source, stack, variables, console) and runs a
 * setTimeout-driven frame loop so the QuickJS event loop keeps
 * servicing the debug session between frames (a blocking
 * while/poll loop would starve it).
 *
 * Immediate-mode MVC: the Debugger instance is the model (its
 * print/printRaw sinks feed the console pane, onEvent drives the
 * source pane), panes redraw from it every frame, and input maps
 * onto the same commands the REPL uses.
 */

import { setTimeout } from 'os';
import { exit } from 'std';
import { CONTEXT_VERSION_MAJOR, CONTEXT_VERSION_MINOR, context, createStandardCursor, KEY_ESCAPE, KEY_F5, KEY_F10, KEY_F11, OPENGL_CORE_PROFILE, OPENGL_FORWARD_COMPAT, OPENGL_PROFILE, poll, RESIZABLE, SAMPLES, Window } from 'glfw';
import { ANTIALIAS, CreateGL3, DeleteGL3, STENCIL_STROKES } from 'nanovg';
import { colors, metrics, loadFont } from './theme.js';
import { contains, fillRect, panel, scrollbarHit, scrollbarOffset, strokeRect, text } from './widgets.js';
import { CommandLine } from './command-line.js';
import { ConsolePane } from './console-pane.js';
import { FilePicker } from './file-picker.js';
import { SourcePane } from './source-pane.js';
import { StackPane } from './stack-pane.js';
import { VarsPane } from './vars-pane.js';
import { WatchPane } from './watch-pane.js';
import * as toolbar from './toolbar.js';

/* glfw literals the module exports no constants for */
const PRESS = 1;
const REPEAT = 2;
const MB_LEFT = 0;
const MOD_SHIFT = 1;
const MOD_CONTROL = 2;

const FRAME_MS = 33;
const SCROLL_LINES = 3;
const BORDER_GRAB = 4; /* px on either side of a pane border */

/* GLFW standard cursor shapes (the module exports no constants for them) */
const CURSOR_SHAPES = { arrow: 0x36001, ibeam: 0x36002, hand: 0x36004, hresize: 0x36005, vresize: 0x36006 };

export function StartGUI(dbg) {
  const app = new GuiApp(dbg);
  app.initWindow();
  app.start();
  return app;
}

class GuiApp {
  running = true;
  panes = {};
  content = {}; /* panel content rects from the last frame (for hit tests) */
  mouse = { x: 0, y: 0 };
  scrollDrag = null; /* { target, rect } while a scrollbar is held */
  paneDrag = null; /* 'src' | 'console' | 'stack' | 'vars' while a border is held */
  splits = { src: 0.6, console: 0.18, stack: 0.35, vars: 0.4 }; /* pane split fractions */
  tooltip = null; /* { text } for the source hover */
  #hover = { key: null, since: 0, pending: false };
  #cmdQueue = [];
  #cmdBusy = false;
  vars = null; /* null | 'pending' | [{ name, value, variablesReference }] — locals of the selected frame */
  varChildren = new Map(); /* ref -> rows | 'pending' (refs are valid per pause only) */
  expandedVars = new Set();
  displayValues = []; /* [{ num, expr, value }] evaluated at each stop */
  #varsSeq = 0;
  #dispSeq = 0;

  constructor(dbg) {
    this.dbg = dbg;
    this.console = new ConsolePane();
    this.source = new SourcePane();
    this.stack = new StackPane();
    this.varsPane = new VarsPane();
    this.watches = new WatchPane();
    this.picker = new FilePicker();
    this.cmdline = new CommandLine();
    this.focusedInput = this.cmdline;

    this.watchInput = new CommandLine({
      prompt: '+ ',
      onSubmit: (app, line) => app.addWatch(line),
      /* complete as identifiers, like 'print <expr>' */
      complete: (app, text, cursor) => app.dbg.getCompletions('print ' + text, cursor + 6),
    });

    dbg.print = (...args) => this.console.push(args.join(' '));
    dbg.printRaw = s => this.console.pushRaw(s);
    dbg.onEvent = kind => this.#onDebugEvent(kind);
    dbg.echoSourceLine = false; /* the source pane shows the stopped-at line */
    dbg.echoDisplays = false; /* the watches pane shows them */

    if(dbg.program) this.source.show(dbg.program, 1);
  }

  #onDebugEvent(kind) {
    if(kind == 'stopped') {
      const f = this.dbg.stack[this.dbg.currentFrame];
      if(f?.filename) this.source.show(f.filename, f.line);
      this.#refreshVars();
    } else {
      this.vars = null;
      this.#varsSeq++;
      this.#dispSeq++;
      this.varChildren.clear();
      this.expandedVars.clear();
      this.displayValues = [];
      this.varsPane.reset();
    }
  }

  /** Fetch the selected frame's locals and displays; panes render 'pending' meanwhile. */
  #refreshVars() {
    const { dbg } = this;

    /* variablesReferences are only valid within one pause */
    this.varChildren.clear();
    this.expandedVars.clear();
    this.displayValues = [];

    if(!dbg.session || !dbg.stack.length) {
      this.vars = null;
      return;
    }

    const frame = dbg.stack[dbg.currentFrame]?.id ?? 0;
    const seq = ++this.#varsSeq;
    this.vars = 'pending';

    dbg.session
      .variables([frame, 1])
      .then(vars => seq == this.#varsSeq && (this.vars = vars ?? []))
      .catch(() => seq == this.#varsSeq && (this.vars = []));

    this.refreshDisplays();
  }

  /** Re-evaluate all watch/display expressions in the selected frame. */
  refreshDisplays() {
    const { dbg } = this;

    if(!dbg.session || !dbg.stack.length || !dbg.displays.length) {
      this.displayValues = [];
      return;
    }

    const frame = dbg.stack[dbg.currentFrame]?.id ?? 0;
    const seq = ++this.#dispSeq;

    Promise.all(
      dbg.displays.map(d =>
        dbg.session
          .evaluate(d.expr, frame)
          .then(body => ({ num: d.num, expr: d.expr, value: body?.result ?? body?.value ?? '' }))
          .catch(err => ({ num: d.num, expr: d.expr, value: `<error: ${err?.message ?? err}>` })),
      ),
    ).then(values => seq == this.#dispSeq && (this.displayValues = values));
  }

  /** Watches pane input: add an expression (shared with the display command). */
  addWatch(line) {
    line = line.trim();
    if(!line) return;

    this.dbg.cmdDisplay(line).catch(err => this.dbg.print(`${err?.message ?? err}`));
    this.refreshDisplays();
  }

  removeWatch(num) {
    this.dbg.cmdUndisplay(String(num));
    this.displayValues = this.displayValues.filter(d => d.num != num);
  }

  /** Expand/collapse a variable row; children are fetched on first expand. */
  toggleVar(row) {
    if(!(row?.ref > 0)) return;

    if(this.expandedVars.has(row.ref)) {
      this.expandedVars.delete(row.ref);
      return;
    }

    this.expandedVars.add(row.ref);

    if(!this.varChildren.has(row.ref)) {
      const seq = this.#varsSeq;
      this.varChildren.set(row.ref, 'pending');

      this.dbg.session
        ?.variables(row.ref)
        .then(vars => seq == this.#varsSeq && this.varChildren.set(row.ref, vars ?? []))
        .catch(() => seq == this.#varsSeq && this.varChildren.set(row.ref, []));
    }
  }

  /** Console input: echo the line and run it through the command queue. */
  submitCommand(line) {
    const { dbg } = this;

    line = line.trim();
    this.console.push(`(qjs-dbg) ${line || ''}`);

    if(!line) {
      if(!dbg.lastRepeat) return;
      line = dbg.lastRepeat;
    }

    this.#cmdQueue.push(line);
    this.#drainCommands();
  }

  #drainCommands() {
    if(this.#cmdBusy) return;

    const line = this.#cmdQueue.shift();
    if(line == undefined) return;

    this.#cmdBusy = true;
    this.dbg
      .execute(line)
      .catch(err => this.dbg.print(`${err?.message ?? err}`))
      .finally(() => {
        this.#cmdBusy = false;
        this.#drainCommands();
      });
  }

  /** Evaluate the identifier under the cursor after a short dwell (source hover). */
  #updateHover() {
    const { dbg, mouse } = this;
    const rect = this.content.source;

    const usable = rect && dbg.session && !dbg.busy && dbg.stack.length && !this.picker.isOpen && contains(rect, mouse.x, mouse.y);
    const word = usable ? this.source.wordAt(rect, mouse.x, mouse.y) : null;
    const key = word ? `${word.expr}@${word.line}` : null;

    if(key != this.#hover.key) {
      this.#hover = { key, since: Date.now(), pending: false };
      this.tooltip = null;
      return;
    }

    if(!key || this.tooltip || this.#hover.pending) return;
    if(Date.now() - this.#hover.since < 350) return;

    this.#hover.pending = true;
    const frame = dbg.stack[dbg.currentFrame]?.id ?? 0;

    dbg.session
      .evaluate(word.expr, frame)
      .then(body => {
        if(this.#hover.key == key) this.tooltip = { text: `${word.expr} = ${body?.result ?? body?.value ?? ''}` };
      })
      .catch(() => {});
  }

  /** Scrollable view whose scrollbar zone is under (x, y), if it can scroll. */
  scrollTarget(x, y) {
    const { content, picker } = this;
    const targets = picker.isOpen
      ? [[picker, picker.contentRect]]
      : [
          [this.source, content.source],
          [this.varsPane, content.vars],
          [this.watches, content.watches && this.watches.listRect(content.watches)],
          [this.console, content.console],
        ];

    for(const [target, rect] of targets)
      if(rect && scrollbarHit(rect, x, y)) {
        const { total, visible } = target.scrollInfo;
        if(total > visible) return { target, rect };
      }

    return null;
  }

  selectFrame(i) {
    const { dbg } = this;
    if(!(i >= 0 && i < dbg.stack.length) || i == dbg.currentFrame) return;

    dbg.currentFrame = i;
    const f = dbg.stack[i];
    if(f?.filename) this.source.show(f.filename, f.line);
    this.#refreshVars();
  }

  /** Toolbar/keyboard commands, routed through the same command interpreter as the REPL. */
  command(id) {
    const { dbg } = this;
    if(!toolbar.enabled(dbg, id)) return;

    if(id == 'pause') {
      dbg.interrupt();
      return;
    }

    /* on a not-started program, resuming buttons behave like gdb:
       Continue runs, Next/Step stop at the entry */
    let line = id;
    if(!dbg.child && id != 'run' && id != 'start') line = id == 'continue' ? 'run' : 'starti';

    dbg.execute(line).catch(err => dbg.print(`${err?.message ?? err}`));
  }

  initWindow() {
    Window.hint(CONTEXT_VERSION_MAJOR, 3);
    Window.hint(CONTEXT_VERSION_MINOR, 2);
    Window.hint(OPENGL_PROFILE, OPENGL_CORE_PROFILE);
    Window.hint(OPENGL_FORWARD_COMPAT, true);
    Window.hint(RESIZABLE, true);
    Window.hint(SAMPLES, 4);

    this.window = context.current = new Window(1280, 900, `qjs-debugger — ${this.dbg.program ?? '(no program)'}`);

    const { width, height } = this.window.size;
    this.width = width;
    this.height = height;

    this.vg = CreateGL3(ANTIALIAS | STENCIL_STROKES);

    this.font = loadFont(this.vg);
    if(!this.font) this.dbg.print('gui: no usable font found (~/.fonts/MiscFixedSC613.ttf)');

    this.cursors = {};
    try {
      for(const [name, shape] of Object.entries(CURSOR_SHAPES)) this.cursors[name] = createStandardCursor(shape);
    } catch(e) {}
    this.#cursorShape = 'arrow';

    this.layout();
    this.#bindInput();
  }

  #cursorShape = 'arrow';

  #setCursorShape(name) {
    if(name == this.#cursorShape || this.cursors[name] == undefined) return;
    this.#cursorShape = name;
    this.window.setCursor(this.cursors[name]);
  }

  /** Pick the pointer shape from what is under the mouse. */
  #updateCursor() {
    const { x, y } = this.mouse;
    const { content, panes } = this;
    let shape = 'arrow';

    if(this.paneDrag) shape = this.paneDrag == 'src' ? 'hresize' : 'vresize';
    else if(this.scrollDrag) shape = 'hand';
    else if(this.picker.isOpen) shape = this.scrollTarget(x, y) || this.picker.fileAt(x, y) ? 'hand' : 'arrow';
    else if(this.scrollTarget(x, y)) shape = 'hand';
    else if(this.paneBorderAt(x, y)) shape = this.paneBorderAt(x, y) == 'src' ? 'hresize' : 'vresize';
    else if(contains(panes.toolbar, x, y)) shape = toolbar.hit(this, panes.toolbar, x, y) ? 'hand' : 'arrow';
    else if(contains({ ...panes.source, h: metrics.titleH }, x, y)) shape = 'hand';
    else if(content.source && contains(content.source, x, y)) shape = this.source.gutterHit(content.source, x, y) != null ? 'hand' : 'ibeam';
    else if(content.stack && contains(content.stack, x, y)) shape = this.stack.rowAt(this, content.stack, x, y) >= 0 ? 'hand' : 'arrow';
    else if(content.vars && contains(content.vars, x, y)) shape = this.varsPane.rowAt(content.vars, x, y)?.ref > 0 ? 'hand' : 'arrow';
    else if(content.watches && contains(content.watches, x, y)) {
      if(contains(this.watches.inputRect(content.watches), x, y)) shape = 'ibeam';
      else shape = this.watches.rowAt(content.watches, x, y) ? 'hand' : 'arrow';
    } else if(content.consoleInput && contains(content.consoleInput, x, y)) shape = 'ibeam';

    this.#setCursorShape(shape);
  }

  #bindInput() {
    const app = this;

    Object.assign(this.window, {
      handleSize(w, h) {
        app.width = w;
        app.height = h;
        app.layout();
      },

      handleCursorPos(x, y) {
        app.mouse = { x, y };

        if(app.scrollDrag) {
          const { target, rect } = app.scrollDrag;
          const { total, visible } = target.scrollInfo;
          target.setScrollOffset(scrollbarOffset(rect, y, total, visible));
        } else if(app.paneDrag) {
          app.#dragBorder(x, y);
        }
      },

      handleMouseButton(button, action) {
        if(button != MB_LEFT) return;

        if(action != PRESS) {
          app.scrollDrag = null;
          app.paneDrag = null;
          return;
        }

        const { x, y } = app.mouse;
        const { content } = app;

        /* scrollbar press: jump there and start dragging the thumb */
        const scroll = app.scrollTarget(x, y);
        if(scroll) {
          const { total, visible } = scroll.target.scrollInfo;
          scroll.target.setScrollOffset(scrollbarOffset(scroll.rect, y, total, visible));
          app.scrollDrag = scroll;
          return;
        }

        /* pane borders: start resizing */
        if(!app.picker.isOpen) {
          const border = app.paneBorderAt(x, y);
          if(border) {
            app.paneDrag = border;
            return;
          }
        }

        /* modal file picker: a row selects, anything else dismisses */
        if(app.picker.isOpen) {
          const file = app.picker.fileAt(x, y);
          if(file) app.source.show(file);
          app.picker.close();
          return;
        }

        /* the source pane's title (the path) opens the picker */
        if(contains({ ...app.panes.source, h: metrics.titleH }, x, y)) {
          app.picker.open(app.dbg.sourceFiles());
          return;
        }

        if(contains(app.panes.toolbar, x, y)) {
          const id = toolbar.hit(app, app.panes.toolbar, x, y);
          if(id) app.command(id);
        } else if(content.source && contains(content.source, x, y)) {
          const line = app.source.gutterHit(content.source, x, y);
          if(line != null && app.source.file) app.dbg.toggleBreakpoint(app.source.file, line);
        } else if(content.stack && contains(content.stack, x, y)) {
          app.selectFrame(app.stack.rowAt(app, content.stack, x, y));
        } else if(content.vars && contains(content.vars, x, y)) {
          app.toggleVar(app.varsPane.rowAt(content.vars, x, y));
        } else if(content.watches && contains(content.watches, x, y)) {
          if(contains(app.watches.inputRect(content.watches), x, y)) {
            app.focusedInput = app.watchInput;
          } else {
            const row = app.watches.rowAt(content.watches, x, y);
            if(row?.remove) app.removeWatch(row.num);
          }
        } else if(content.console && contains(app.panes.console, x, y)) {
          app.focusedInput = app.cmdline;
        }
      },

      handleScroll(dx, dy) {
        const { x, y } = app.mouse;
        const lines = -Math.sign(dy) * SCROLL_LINES;

        if(app.picker.isOpen) app.picker.scrollBy(lines);
        else if(contains(app.panes.source, x, y)) app.source.scrollBy(lines);
        else if(contains(app.panes.vars, x, y)) app.varsPane.scrollBy(lines);
        else if(contains(app.panes.watches, x, y)) app.watches.scrollBy(lines);
        else if(contains(app.panes.console, x, y)) app.console.scrollBy(-lines);
      },

      handleKey(key, scancode, action, mods) {
        if(action != PRESS && action != REPEAT) return;

        if(key == KEY_ESCAPE && app.picker.isOpen) app.picker.close();
        else if(key == KEY_ESCAPE) app.running = false;
        else if(key == KEY_F5) app.command('continue');
        else if(key == KEY_F10) app.command('next');
        else if(key == KEY_F11) app.command(mods & MOD_SHIFT ? 'finish' : 'step');
        else if(key == 82 /* R */ && mods & MOD_CONTROL) app.command('run');
        else app.focusedInput.handleKey(app, key);
      },

      handleChar(codepoint) {
        app.focusedInput.handleChar(codepoint);
      },
    });
  }

  layout() {
    const { toolbarH } = metrics;
    const w = this.width;
    const consoleH = Math.round(this.height * this.splits.console);
    const midY = toolbarH;
    const midH = this.height - toolbarH - consoleH;
    const srcW = Math.floor(w * this.splits.src);
    const stackH = Math.floor(midH * this.splits.stack);
    const varsH = Math.floor(midH * this.splits.vars);

    this.panes = {
      toolbar: { x: 0, y: 0, w, h: toolbarH },
      source: { x: 0, y: midY, w: srcW, h: midH },
      stack: { x: srcW, y: midY, w: w - srcW, h: stackH },
      vars: { x: srcW, y: midY + stackH, w: w - srcW, h: varsH },
      watches: { x: srcW, y: midY + stackH + varsH, w: w - srcW, h: midH - stackH - varsH },
      console: { x: 0, y: midY + midH, w, h: consoleH },
    };
  }

  /** Draggable pane border under (x, y): 'src' | 'console' | 'stack' | 'vars' | null. */
  paneBorderAt(x, y) {
    const { source, stack, vars, console: con } = this.panes;
    const near = (v, target) => Math.abs(v - target) <= BORDER_GRAB;

    if(x >= source.w && y < con.y && near(y, stack.y + stack.h)) return 'stack';
    if(x >= source.w && y < con.y && near(y, vars.y + vars.h)) return 'vars';
    if(y >= source.y && y < con.y && near(x, source.w)) return 'src';
    if(near(y, con.y)) return 'console';
    return null;
  }

  /** Move the border held in paneDrag to the pointer, with minimum pane sizes. */
  #dragBorder(x, y) {
    const { toolbarH } = metrics;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const midH = this.height - toolbarH - Math.round(this.height * this.splits.console);

    switch (this.paneDrag) {
      case 'src':
        this.splits.src = clamp(x / this.width, 0.15, 0.85);
        break;
      case 'console':
        this.splits.console = clamp((this.height - y) / this.height, 0.06, 0.6);
        break;
      case 'stack':
        this.splits.stack = clamp((y - toolbarH) / midH, 0.08, 0.92 - this.splits.vars);
        break;
      case 'vars':
        this.splits.vars = clamp((y - toolbarH) / midH - this.splits.stack, 0.08, 0.92 - this.splits.stack);
        break;
    }

    this.layout();
  }

  render() {
    const { vg, panes } = this;

    vg.BeginFrame(this.width, this.height, 1);

    fillRect(vg, 0, 0, this.width, this.height, colors.bg);

    toolbar.draw(this, panes.toolbar);

    this.source.draw(this, (this.content.source = panel(vg, panes.source, this.source.file ?? 'Source')));
    this.stack.draw(this, (this.content.stack = panel(vg, panes.stack, 'Stack')));
    this.varsPane.draw(this, (this.content.vars = panel(vg, panes.vars, 'Variables')));
    this.watches.draw(this, (this.content.watches = panel(vg, panes.watches, 'Watches')));
    /* console: scrollback above, the command input line on the bottom row */
    const consoleContent = panel(vg, panes.console, 'Console');
    const inputH = metrics.rowH + 4;
    this.content.console = { ...consoleContent, h: consoleContent.h - inputH };
    this.console.draw(vg, this.content.console);
    this.content.consoleInput = { x: consoleContent.x, y: consoleContent.y + consoleContent.h - inputH, w: consoleContent.w, h: inputH };
    this.cmdline.draw(vg, this.content.consoleInput, this.focusedInput == this.cmdline);

    this.picker.draw(this, panes.source);

    this.#drawTooltip();

    vg.EndFrame();
  }

  #drawTooltip() {
    if(!this.tooltip) return;

    const { vg, mouse } = this;
    const { rowH, pad, charW } = metrics;

    const str = this.tooltip.text.length > 160 ? this.tooltip.text.slice(0, 157) + '...' : this.tooltip.text;
    const w = Math.ceil(str.length * charW) + 2 * pad;
    const h = rowH + 2 * pad;
    const x = Math.max(0, Math.min(this.width - w, mouse.x + 12));
    const y = Math.max(0, Math.min(this.height - h, mouse.y + 16));

    fillRect(vg, x, y, w, h, colors.titleBg);
    strokeRect(vg, x, y, w, h, colors.border);
    text(vg, x + pad, y + pad, str, colors.text);
  }

  start() {
    this.tick();
  }

  tick() {
    if(!this.running || this.window.shouldClose) return this.shutdown();

    poll();
    this.#updateHover();
    this.#updateCursor();
    this.render();
    this.window.swapBuffers();

    setTimeout(() => this.tick(), FRAME_MS);
  }

  shutdown() {
    if(this.dbg.child) this.dbg.cmdKill();
    DeleteGL3(this.vg);
    this.window.destroy();
    exit(0);
  }
}
