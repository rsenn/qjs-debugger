/**
 * gui/source-pane.js — read-only source view: line numbers, breakpoint
 * gutter dots, current-line highlight. Auto-centers on the stop line
 * (show()); wheel scrolling detaches until the next stop.
 */

import { readFileSync } from 'fs';
import { colors, FONT_SIZE, metrics } from './theme.js';
import { fillRect, text } from './widgets.js';

const GUTTER_DOT = 10; /* px reserved for the breakpoint dot */
const CHAR_W = 7; /* MiscFixedSC613 advance at size 13 */

export class SourcePane {
  file = null;
  #lines = null;
  #top = 1; /* first visible line, 1-based */

  /** Load (if needed) and center on `line`. */
  show(file, line) {
    if(file != this.file) {
      this.file = file;
      try {
        this.#lines = readFileSync(file, 'utf-8').split('\n');
      } catch(e) {
        this.#lines = null;
      }
    }

    if(this.#lines && line) this.#top = Math.max(1, line - Math.floor(this.#visibleRows / 2));
  }

  scrollBy(n) {
    if(!this.#lines) return;
    this.#top = Math.max(1, Math.min(this.#lines.length, this.#top + n));
  }

  #rows = 0;
  get #visibleRows() {
    return this.#rows || 20;
  }

  draw(app, rect) {
    const { vg, dbg } = app;
    const { rowH, pad } = metrics;

    this.#rows = Math.floor((rect.h - pad) / rowH);

    vg.Save();
    vg.IntersectScissor(rect.x, rect.y, rect.w, rect.h);

    if(!this.#lines) {
      text(vg, rect.x + pad, rect.y + pad, this.file ? `cannot read ${this.file}` : '(no source)', colors.dim);
      vg.Restore();
      return;
    }

    const f = dbg.stack[dbg.currentFrame];
    const stopLine = f?.filename == this.file ? f.line : -1;
    const bpLines = new Set(dbg.breakpoints.filter(b => b.file == this.file).map(b => b.line));

    const numW = String(this.#lines.length).length * CHAR_W;
    const textX = rect.x + GUTTER_DOT + numW + 2 * pad;

    let y = rect.y + pad;
    for(let n = this.#top; n < this.#top + this.#rows && n <= this.#lines.length; n++, y += rowH) {
      if(n == stopLine) fillRect(vg, rect.x, y - 1, rect.w, rowH, colors.currentLine);

      if(bpLines.has(n)) fillRect(vg, rect.x + 2, y + Math.floor((FONT_SIZE - 7) / 2), 7, 7, colors.breakpoint);

      text(vg, rect.x + GUTTER_DOT + pad, y, String(n).padStart(String(this.#lines.length).length), n == stopLine ? colors.accent : colors.dim);
      if(n == stopLine) text(vg, rect.x + 2, y, '>', colors.accent);

      text(vg, textX, y, this.#lines[n - 1].replaceAll('\t', '    '));
    }

    vg.Restore();
  }
}
