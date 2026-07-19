/**
 * gui/vars-pane.js — variables of the selected frame as three
 * collapsible sections (Locals, Closure, Global), each an expandable
 * tree. The app owns all async state; this pane renders and hit-tests:
 *
 *   app.vars             { local, closure, global }, each:
 *                         null | 'pending' | [{ name, value, variablesReference }]
 *   app.varChildren       Map(ref -> rows | 'pending')
 *   app.expandedVars      Set(ref)
 *   app.expandedSections  Set('local' | 'closure' | 'global')
 */

import { colors, FONT_SIZE, metrics, syntax } from './theme.js';
import { scrollbar, text } from './widgets.js';

const INDENT = 2; /* chars per tree level */

const SECTIONS = [
  ['local', 'Locals'],
  ['closure', 'Closure'],
  ['global', 'Global'],
];

export class VarsPane {
  #scroll = 0;
  #flat = []; /* rows of the last draw, for rowAt() */
  #lastRows = 1;

  scrollBy(n) {
    this.#scroll = Math.max(0, this.#scroll + n);
  }

  reset() {
    this.#scroll = 0;
  }

  /* uniform scrollbar interface */
  get scrollInfo() {
    return { total: this.#flat.length, visible: this.#lastRows, offset: this.#scroll };
  }

  setScrollOffset(o) {
    this.#scroll = Math.max(0, o);
  }

  /** Flatten section headers + their expanded variable trees into draw rows. */
  #flatten(app) {
    const rows = [];

    /* the engine reuses one variablesReference per object, so cyclic
       graphs (obj.self = obj) repeat an expanded ref down the branch —
       `path` stops the descent there */
    const visit = (v, depth, path) => {
      const ref = v.variablesReference | 0;
      rows.push({ kind: 'var', label: String(v.name ?? '?'), value: v.value, depth, ref });

      if(ref > 0 && app.expandedVars.has(ref) && !path.has(ref)) {
        const kids = app.varChildren.get(ref);
        if(!Array.isArray(kids)) rows.push({ kind: 'info', label: '...', value: undefined, depth: depth + 1, ref: 0 });
        else {
          const branch = new Set(path).add(ref);
          for(const k of kids) visit(k, depth + 1, branch);
        }
      }
    };

    for(const [section, title] of SECTIONS) {
      const vars = app.vars[section];
      const count = Array.isArray(vars) ? vars.length : null;
      rows.push({ kind: 'section', label: title, count, depth: 0, section });

      if(!app.expandedSections.has(section)) continue;

      if(vars == 'pending') rows.push({ kind: 'info', label: '...', depth: 1, ref: 0 });
      else if(Array.isArray(vars)) {
        if(!vars.length) rows.push({ kind: 'info', label: '(none)', depth: 1, ref: 0 });
        else for(const v of vars) visit(v, 1, new Set());
      }
    }

    return rows;
  }

  draw(app, rect) {
    const { vg, dbg } = app;
    const { rowH, pad, charW } = metrics;

    vg.Save();
    vg.IntersectScissor(rect.x, rect.y, rect.w, rect.h);

    if(!dbg.stack.length) {
      const msg = dbg.child ? '(running)' : '(not stopped)';
      text(vg, rect.x + pad, rect.y + pad, msg, colors.dim);
      this.#flat = [];
      vg.Restore();
      return;
    }

    this.#flat = this.#flatten(app);

    const rows = Math.max(1, Math.floor((rect.h - pad) / rowH));
    const max = Math.max(0, this.#flat.length - rows);
    if(this.#scroll > max) this.#scroll = max;
    this.#lastRows = rows;

    let y = rect.y + pad;
    for(let i = this.#scroll; i < this.#flat.length && i < this.#scroll + rows; i++, y += rowH) {
      const r = this.#flat[i];
      let x = rect.x + pad + Math.round(r.depth * INDENT * charW);

      if(r.kind == 'section') {
        text(vg, x, y, app.expandedSections.has(r.section) ? '-' : '+', syntax.default);
        x += Math.round(2 * charW);
        const suffix = r.count == null ? '' : ` (${r.count})`;
        text(vg, x, y, r.label + suffix, colors.titleFg);
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
