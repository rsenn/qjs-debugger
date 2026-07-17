/**
 * gui/vars-pane.js — variables of the selected frame as an expandable
 * tree, with auto-display expressions on top. The app owns all async
 * state; this pane renders and hit-tests:
 *
 *   app.vars          null | 'pending' | [{ name, value, variablesReference }]
 *   app.varChildren   Map(ref -> rows | 'pending')
 *   app.expandedVars  Set(ref)
 *   app.displayValues [{ num, expr, value }]
 */

import { colors, FONT_SIZE, metrics, syntax } from './theme.js';
import { scrollbar, text } from './widgets.js';

const INDENT = 2; /* chars per tree level */

export class VarsPane {
  #scroll = 0;
  #flat = []; /* rows of the last draw, for rowAt() */

  scrollBy(n) {
    this.#scroll = Math.max(0, this.#scroll + n);
  }

  reset() {
    this.#scroll = 0;
  }

  /** Flatten displays + expanded variable tree into draw rows. */
  #flatten(app) {
    const rows = [];

    for(const d of app.displayValues) rows.push({ kind: 'display', label: `${d.num}: ${d.expr}`, value: d.value, depth: 0, ref: 0 });

    const visit = (v, depth) => {
      const ref = v.variablesReference | 0;
      rows.push({ kind: 'var', label: String(v.name ?? '?'), value: v.value, depth, ref });

      if(ref > 0 && app.expandedVars.has(ref)) {
        const kids = app.varChildren.get(ref);
        if(!Array.isArray(kids)) rows.push({ kind: 'info', label: '...', value: undefined, depth: depth + 1, ref: 0 });
        else for(const k of kids) visit(k, depth + 1);
      }
    };

    if(Array.isArray(app.vars)) for(const v of app.vars) visit(v, 0);

    return rows;
  }

  draw(app, rect) {
    const { vg, dbg } = app;
    const { rowH, pad, charW } = metrics;

    vg.Save();
    vg.IntersectScissor(rect.x, rect.y, rect.w, rect.h);

    this.#flat = this.#flatten(app);

    if(!this.#flat.length) {
      const msg = app.vars == 'pending' ? '...' : !dbg.stack.length ? (dbg.child ? '(running)' : '(not stopped)') : '(no locals)';
      text(vg, rect.x + pad, rect.y + pad, msg, colors.dim);
      vg.Restore();
      return;
    }

    const rows = Math.max(1, Math.floor((rect.h - pad) / rowH));
    const max = Math.max(0, this.#flat.length - rows);
    if(this.#scroll > max) this.#scroll = max;

    let y = rect.y + pad;
    for(let i = this.#scroll; i < this.#flat.length && i < this.#scroll + rows; i++, y += rowH) {
      const r = this.#flat[i];
      let x = rect.x + pad + Math.round(r.depth * INDENT * charW);

      if(r.kind == 'display') {
        text(vg, x, y, r.label, colors.accent);
        x += Math.round((r.label.length + 1) * charW);
        text(vg, x, y, `= ${r.value ?? ''}`, colors.text);
        continue;
      }

      if(r.kind == 'info') {
        text(vg, x, y, r.label, colors.dim);
        continue;
      }

      if(r.ref > 0) {
        text(vg, x, y, app.expandedVars.has(r.ref) ? '-' : '+', syntax.default);
      }
      x += Math.round(2 * charW);

      text(vg, x, y, r.label, syntax.identifier);
      x += Math.round((r.label.length + 1) * charW);
      text(vg, x, y, `= ${r.value ?? ''}`, colors.text);
    }

    scrollbar(vg, rect, this.#flat.length, rows, this.#scroll);

    vg.Restore();
  }

  /** Flattened row at (x, y) from the last draw, or null. */
  rowAt(rect, x, y) {
    const { rowH, pad } = metrics;
    const i = this.#scroll + Math.floor((y - rect.y - pad) / rowH);
    return this.#flat[i] ?? null;
  }
}
