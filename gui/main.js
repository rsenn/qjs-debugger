/**
 * gui/main.js — GUI debugger mode entry (phase 1: skeleton).
 *
 * Opens a glfw window with a nanovg GL3 context, lays out the pane
 * frames (toolbar, source, stack, variables, console) and runs a
 * setTimeout-driven frame loop so the QuickJS event loop keeps
 * servicing the debug session between frames (a blocking
 * while/poll loop would starve it).
 */

import { setTimeout } from 'os';
import { exit } from 'std';
import { CONTEXT_VERSION_MAJOR, CONTEXT_VERSION_MINOR, context, KEY_ESCAPE, OPENGL_CORE_PROFILE, OPENGL_FORWARD_COMPAT, OPENGL_PROFILE, poll, RESIZABLE, SAMPLES, Window } from 'glfw';
import { ANTIALIAS, CreateGL3, DeleteGL3, STENCIL_STROKES } from 'nanovg';
import { colors, FONT_SIZE, loadFont, metrics } from './theme.js';
import { fillRect, panel, text } from './widgets.js';

const PRESS = 1; /* glfw action; the module exports no constant for it */
const FRAME_MS = 33;

export function StartGUI(dbg) {
  const app = new GuiApp(dbg);
  app.initWindow();
  app.start();
  return app;
}

class GuiApp {
  running = true;
  panes = {};

  constructor(dbg) {
    this.dbg = dbg;
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
    if(!this.font) console.log('qjs-debugger gui: no usable font found (~/.fonts/MiscFixedSC613.ttf)');

    this.layout();

    const app = this;
    Object.assign(this.window, {
      handleSize(w, h) {
        app.width = w;
        app.height = h;
        app.layout();
      },
      handleKey(key, scancode, action, mods) {
        if(action == PRESS && key == KEY_ESCAPE) app.running = false;
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

  #status() {
    const { dbg } = this;

    /* ASCII only: MiscFixedSC613 has no em-dash glyph */
    if(!dbg.program) return ['(no program)', colors.dim];
    if(!dbg.child) return [`${dbg.program} - not started`, colors.exited];
    if(dbg.busy || !dbg.stack.length) return [`${dbg.program} - running`, colors.running];

    const f = dbg.stack[dbg.currentFrame] ?? {};
    return [`${dbg.program} - stopped at ${f.filename ?? '??'}:${f.line ?? '?'}`, colors.stopped];
  }

  render() {
    const { vg, panes } = this;

    vg.BeginFrame(this.width, this.height, 1);

    fillRect(vg, 0, 0, this.width, this.height, colors.bg);

    /* toolbar: status text only (buttons come in phase 2) */
    fillRect(vg, panes.toolbar.x, panes.toolbar.y, panes.toolbar.w, panes.toolbar.h, colors.titleBg);
    const [status, color] = this.#status();
    text(vg, metrics.pad, (metrics.toolbarH - FONT_SIZE) / 2 + 1, status, color);

    for(const [name, title] of [
      ['source', 'Source'],
      ['stack', 'Stack'],
      ['vars', 'Variables'],
      ['console', 'Console'],
    ]) {
      const content = panel(vg, panes[name], title);
      text(vg, content.x + metrics.pad, content.y + metrics.pad, '(phase 2)', colors.dim);
    }

    vg.EndFrame();
  }

  start() {
    /* phase 1: auto-run to prove window + debug session coexist;
       phase 2 puts this behind the toolbar's Run button */
    if(this.dbg.program) this.dbg.execute('run').catch(err => console.log(`gui: run failed: ${err.message}`));

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
