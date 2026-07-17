/**
 * gui/watch-pane.js — watch expressions under the variables pane. Backed
 * by the same model as the 'display' command (dbg.displays), so watches
 * added here are visible to the REPL's info display/undisplay and vice
 * versa. Rows show 'x N: expr = value' (x removes); the input line at
 * the bottom (app.watchInput) adds one.
 */

import { colors, FONT_SIZE, metrics, syntax } from './theme.js';
import { scrollbar, text } from './widgets.js';

export const INPUT_H = () => metrics.rowH + 4;

export class WatchPane {
  #scroll = 0;
  #lastRows = 1;
  #rows = []; /* merged rows of the last draw, for rowAt() */

  /* uniform scrollbar interface (list area only) */
  get scrollInfo() {
    return { total: this.#rows.length, visible: this.#lastRows, offset: this.#scroll };
  }

  setScrollOffset(o) {
    this.#scroll = Math.max(0, o);
  }

  scrollBy(n) {
    this.#scroll = Math.max(0, this.#scroll + n);
  }

  /** The list area (input row excluded). */
  listRect(rect) {
    return { ...rect, h: rect.h - INPUT_H() };
  }

  inputRect(rect) {
    return { x: rect.x, y: rect.y + rect.h - INPUT_H(), w: rect.w, h: INPUT_H() };
  }

  draw(app, rect) {
    const { vg, dbg } = app;
    const { rowH, pad, charW } = metrics;
    const list = this.listRect(rect);

    /* merge expressions (model) with the values evaluated at the last stop */
    const values = new Map(app.displayValues.map(d => [d.num, d.value]));
    this.#rows = dbg.displays.map(d => ({ num: d.num, expr: d.expr, value: values.get(d.num) }));

    vg.Save();
    vg.IntersectScissor(list.x, list.y, list.w, list.h);

    if(!this.#rows.length) {
      text(vg, list.x + pad, list.y + pad, '(no watches)', colors.dim);
    } else {
      const rows = Math.max(1, Math.floor((list.h - pad) / rowH));
      const max = Math.max(0, this.#rows.length - rows);
      if(this.#scroll > max) this.#scroll = max;
      this.#lastRows = rows;

      let y = list.y + pad;
      for(let i = this.#scroll; i < this.#rows.length && i < this.#scroll + rows; i++, y += rowH) {
        const r = this.#rows[i];
        let x = list.x + pad;

        text(vg, x, y, 'x', colors.breakpoint);
        x += Math.round(2 * charW);

        const label = `${r.num}: ${r.expr}`;
        text(vg, x, y, label, syntax.identifier);
        x += Math.round((label.length + 1) * charW);

        if(r.value != undefined) text(vg, x, y, `= ${r.value}`, colors.text);
      }

      scrollbar(vg, list, this.#rows.length, this.#lastRows, this.#scroll);
    }

    vg.Restore();

    app.watchInput.draw(vg, this.inputRect(rect), app.focusedInput == app.watchInput);
  }

  /** Row under (x, y) in the list area: { num, remove } or null. */
  rowAt(rect, x, y) {
    const { rowH, pad, charW } = metrics;
    const list = this.listRect(rect);
    if(y >= list.y + list.h) return null;

    const r = this.#rows[this.#scroll + Math.floor((y - list.y - pad) / rowH)];
    if(!r) return null;

    return { num: r.num, remove: x < list.x + pad + 2 * charW };
  }
}
