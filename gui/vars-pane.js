/**
 * gui/vars-pane.js — local variables of the selected frame (flat list,
 * phase 3). The app owns the async fetch; this pane only renders
 * app.vars: null | 'pending' | [{ name, value, type }].
 */

import { colors, FONT_SIZE, metrics, syntax } from './theme.js';
import { text } from './widgets.js';

const CHAR_W = 7;

export class VarsPane {
  #scroll = 0;

  scrollBy(n) {
    this.#scroll = Math.max(0, this.#scroll + n);
  }

  reset() {
    this.#scroll = 0;
  }

  draw(app, rect) {
    const { vg, dbg } = app;
    const { rowH, pad } = metrics;

    vg.Save();
    vg.IntersectScissor(rect.x, rect.y, rect.w, rect.h);

    if(app.vars == null || !dbg.stack.length) {
      text(vg, rect.x + pad, rect.y + pad, dbg.child ? '(running)' : '(not stopped)', colors.dim);
    } else if(app.vars == 'pending') {
      text(vg, rect.x + pad, rect.y + pad, '...', colors.dim);
    } else if(!app.vars.length) {
      text(vg, rect.x + pad, rect.y + pad, '(no locals)', colors.dim);
    } else {
      const rows = Math.max(1, Math.floor((rect.h - pad) / rowH));
      const max = Math.max(0, app.vars.length - rows);
      if(this.#scroll > max) this.#scroll = max;

      let y = rect.y + pad;
      for(let i = this.#scroll; i < app.vars.length && i < this.#scroll + rows; i++, y += rowH) {
        const v = app.vars[i];
        const name = String(v.name ?? '?');

        text(vg, rect.x + pad, y, name, syntax.identifier);
        text(vg, rect.x + pad + (name.length + 1) * CHAR_W, y, `= ${v.value ?? ''}`, colors.text);
      }
    }

    vg.Restore();
  }
}
