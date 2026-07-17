/**
 * gui/toolbar.js — Run/Continue/Pause/Next/Step/Finish/Kill buttons plus
 * the status text. Pure immediate-mode: layout is recomputed per call,
 * clicks resolve through hit().
 */

import { colors, FONT_SIZE, metrics } from './theme.js';
import { contains, fillRect, strokeRect, text } from './widgets.js';


const BUTTONS = [
  { id: 'run', label: 'Run' },
  { id: 'continue', label: 'Continue' },
  { id: 'pause', label: 'Pause' },
  { id: 'next', label: 'Next' },
  { id: 'step', label: 'Step' },
  { id: 'finish', label: 'Finish' },
  { id: 'kill', label: 'Kill' },
];

/** Is the target stopped at a frame (resuming commands make sense)? */
function stopped(dbg) {
  return !!dbg.session && !dbg.busy && dbg.stack.length > 0;
}

export function enabled(dbg, id) {
  switch (id) {
    case 'run':
      return !!dbg.program && !dbg.busy;
    case 'continue':
      return stopped(dbg) || (!!dbg.program && !dbg.child && !dbg.busy);
    case 'pause':
      return !!dbg.session && dbg.busy;
    case 'next':
    case 'step':
      /* on a not-started program these act like gdb 'start' */
      return stopped(dbg) || (!!dbg.program && !dbg.child && !dbg.busy);
    case 'finish':
      return stopped(dbg);
    case 'kill':
      return !!dbg.child;
  }
  return false;
}

function layout(rect) {
  const { pad } = metrics;
  const h = rect.h - 2 * 3;
  let x = rect.x + pad;

  return BUTTONS.map(b => {
    const w = Math.ceil(b.label.length * metrics.charW) + 2 * pad;
    const r = { ...b, x, y: rect.y + 3, w, h };
    x += w + pad;
    return r;
  });
}

export function draw(app, rect) {
  const { vg, dbg } = app;
  const { pad } = metrics;

  fillRect(vg, rect.x, rect.y, rect.w, rect.h, colors.titleBg);

  let right = rect.x + pad;
  for(const b of layout(rect)) {
    const on = enabled(dbg, b.id);
    fillRect(vg, b.x, b.y, b.w, b.h, on ? colors.panel : colors.titleBg);
    strokeRect(vg, b.x, b.y, b.w, b.h, on ? colors.border : colors.titleBg);
    text(vg, b.x + pad, b.y + (b.h - FONT_SIZE) / 2 + 1, b.label, on ? colors.text : colors.dim);
    right = b.x + b.w;
  }

  const [status, color] = statusText(dbg);
  text(vg, right + 2 * pad, rect.y + (rect.h - FONT_SIZE) / 2 + 1, status, color);
}

export function hit(app, rect, x, y) {
  for(const b of layout(rect)) if(contains(b, x, y)) return enabled(app.dbg, b.id) ? b.id : null;
  return null;
}

export function statusText(dbg) {
  /* ASCII only: MiscFixedSC613 has no em-dash glyph */
  if(!dbg.program) return ['(no program)', colors.dim];
  if(!dbg.child) return [`${dbg.program} - not started`, colors.exited];
  if(dbg.busy || !dbg.stack.length) return [`${dbg.program} - running`, colors.running];

  const f = dbg.stack[dbg.currentFrame] ?? {};
  return [`${dbg.program} - stopped at ${f.filename ?? '??'}:${f.line ?? '?'}`, colors.stopped];
}
