/**
 * gui/stack-pane.js — backtrace rows; clicking a row selects the frame
 * (the app re-centers the source pane and refetches variables).
 */

import { basename } from 'path';
import { colors, FONT_SIZE, metrics } from './theme.js';
import { fillRect, text } from './widgets.js';

export class StackPane {
  draw(app, rect) {
    const { vg, dbg } = app;
    const { rowH, pad } = metrics;

    vg.Save();
    vg.IntersectScissor(rect.x, rect.y, rect.w, rect.h);

    if(!dbg.stack.length) {
      text(vg, rect.x + pad, rect.y + pad, dbg.child ? '(running)' : '(no stack)', colors.dim);
      vg.Restore();
      return;
    }

    let y = rect.y + pad;
    for(let i = 0; i < dbg.stack.length; i++, y += rowH) {
      const f = dbg.stack[i];
      const selected = i == dbg.currentFrame;

      if(selected) fillRect(vg, rect.x, y - 1, rect.w, rowH, colors.currentLine);

      text(vg, rect.x + pad, y, `#${f.id ?? i}  ${f.name ?? '??'} () at ${basename(f.filename ?? '??')}:${f.line ?? '?'}`, selected ? colors.text : colors.dim);
    }

    vg.Restore();
  }

  /** Frame index at (x, y), or -1. */
  rowAt(app, rect, x, y) {
    const { rowH, pad } = metrics;
    const i = Math.floor((y - rect.y - pad) / rowH);
    return i >= 0 && i < app.dbg.stack.length ? i : -1;
  }
}
