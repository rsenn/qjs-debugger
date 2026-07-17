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
import { CONTEXT_VERSION_MAJOR, CONTEXT_VERSION_MINOR, context, KEY_ESCAPE, KEY_F5, KEY_F10, KEY_F11, OPENGL_CORE_PROFILE, OPENGL_FORWARD_COMPAT, OPENGL_PROFILE, poll, RESIZABLE, SAMPLES, Window } from 'glfw';
import { ANTIALIAS, CreateGL3, DeleteGL3, STENCIL_STROKES } from 'nanovg';
import { colors, metrics, loadFont } from './theme.js';
import { contains, fillRect, panel, text } from './widgets.js';
import { ConsolePane } from './console-pane.js';
import { SourcePane } from './source-pane.js';
import * as toolbar from './toolbar.js';

/* glfw literals the module exports no constants for */
const PRESS = 1;
const REPEAT = 2;
const MB_LEFT = 0;
const MOD_SHIFT = 1;
const MOD_CONTROL = 2;

const FRAME_MS = 33;
const SCROLL_LINES = 3;

export function StartGUI(dbg) {
  const app = new GuiApp(dbg);
  app.initWindow();
  app.start();
  return app;
}

class GuiApp {
  running = true;
  panes = {};
  mouse = { x: 0, y: 0 };

  constructor(dbg) {
    this.dbg = dbg;
    this.console = new ConsolePane();
    this.source = new SourcePane();

    dbg.print = (...args) => this.console.push(args.join(' '));
    dbg.printRaw = s => this.console.pushRaw(s);
    dbg.onEvent = kind => this.#onDebugEvent(kind);

    if(dbg.program) this.source.show(dbg.program, 1);
  }

  #onDebugEvent(kind) {
    if(kind == 'stopped') {
      const f = this.dbg.stack[this.dbg.currentFrame];
      if(f?.filename) this.source.show(f.filename, f.line);
    }
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
    if(!dbg.child) line = id == 'continue' ? 'run' : 'start';

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

    this.layout();
    this.#bindInput();
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
      },

      handleMouseButton(button, action) {
        if(button != MB_LEFT || action != PRESS) return;
        const { x, y } = app.mouse;

        if(contains(app.panes.toolbar, x, y)) {
          const id = toolbar.hit(app, app.panes.toolbar, x, y);
          if(id) app.command(id);
        }
      },

      handleScroll(dx, dy) {
        const { x, y } = app.mouse;
        const lines = -Math.sign(dy) * SCROLL_LINES;

        if(contains(app.panes.source, x, y)) app.source.scrollBy(lines);
        else if(contains(app.panes.console, x, y)) app.console.scrollBy(-lines);
      },

      handleKey(key, scancode, action, mods) {
        if(action != PRESS && action != REPEAT) return;

        if(key == KEY_ESCAPE) app.running = false;
        else if(key == KEY_F5) app.command('continue');
        else if(key == KEY_F10) app.command('next');
        else if(key == KEY_F11) app.command(mods & MOD_SHIFT ? 'finish' : 'step');
        else if(key == 82 /* R */ && mods & MOD_CONTROL) app.command('run');
      },
    });
  }

  layout() {
    const { toolbarH, consoleH } = metrics;
    const w = this.width;
    const midY = toolbarH;
    const midH = this.height - toolbarH - consoleH;
    const srcW = Math.floor(w * 0.6);
    const stackH = Math.floor(midH * 0.4);

    this.panes = {
      toolbar: { x: 0, y: 0, w, h: toolbarH },
      source: { x: 0, y: midY, w: srcW, h: midH },
      stack: { x: srcW, y: midY, w: w - srcW, h: stackH },
      vars: { x: srcW, y: midY + stackH, w: w - srcW, h: midH - stackH },
      console: { x: 0, y: midY + midH, w, h: consoleH },
    };
  }

  render() {
    const { vg, panes } = this;

    vg.BeginFrame(this.width, this.height, 1);

    fillRect(vg, 0, 0, this.width, this.height, colors.bg);

    toolbar.draw(this, panes.toolbar);

    this.source.draw(this, panel(vg, panes.source, this.source.file ?? 'Source'));

    for(const [name, title] of [
      ['stack', 'Stack'],
      ['vars', 'Variables'],
    ]) {
      const content = panel(vg, panes[name], title);
      text(vg, content.x + metrics.pad, content.y + metrics.pad, '(phase 3)', colors.dim);
    }

    this.console.draw(vg, panel(vg, panes.console, 'Console'));

    vg.EndFrame();
  }

  start() {
    this.tick();
  }

  tick() {
    if(!this.running || this.window.shouldClose) return this.shutdown();

    poll();
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
