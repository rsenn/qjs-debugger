/**
 * gui/source-pane.js — read-only source view: line numbers, breakpoint
 * gutter dots, current-line highlight. Auto-centers on the stop line
 * (show()); wheel scrolling detaches until the next stop.
 */

import { readFileSync } from 'fs';
import { ALIGN_LEFT, ALIGN_TOP } from 'nanovg';
import { REPL } from 'repl';
import { colors, FONT, FONT_SIZE, metrics, syntax } from './theme.js';
import { fillRect, text } from './widgets.js';

/* colorizeJs is a pure function on REPL.prototype: per-char style names */
const colorizeJs = str => REPL.prototype.colorizeJs.call(null, str);

const GUTTER_DOT = 10; /* px reserved for the breakpoint dot */
const CHAR_W = 7; /* MiscFixedSC613 advance at size 13 */

export class SourcePane {
  file = null;
  #lines = null;
  #runs = null; /* per line: [{ style, text }] from colorizeJs */
  #top = 1; /* first visible line, 1-based */

  /** Load (if needed) and center on `line`. */
  show(file, line) {
    if(file != this.file) {
      this.file = file;
      try {
        const text = readFileSync(file, 'utf-8');
        this.#lines = text.split('\n');
        this.#runs = this.#colorize(text, this.#lines);
      } catch(e) {
        this.#lines = this.#runs = null;
      }
    }

    if(this.#lines && line) this.#top = Math.max(1, line - Math.floor(this.#visibleRows / 2));
  }

  /** Group colorizeJs' per-char style names into per-line draw runs. */
  #colorize(text, lines) {
    const [, , styles] = colorizeJs(text);
    const runs = [];
    let off = 0;

    for(const line of lines) {
      const lineRuns = [];
      let cur = null;

      for(let j = 0; j < line.length; j++) {
        const style = styles[off + j] ?? 'default';
        if(cur && cur.style == style) cur.text += line[j];
        else lineRuns.push((cur = { style, text: line[j] }));
      }

      runs.push(lineRuns);
      off += line.length + 1; /* the '\n' */
    }

    return runs;
  }

  scrollBy(n) {
    if(!this.#lines) return;
    this.#top = Math.max(1, Math.min(this.#lines.length, this.#top + n));
  }

  /** Line number when (x, y) is in the breakpoint gutter, else null. */
  gutterHit(rect, x, y) {
    if(!this.#lines) return null;

    const { rowH, pad } = metrics;
    const numW = String(this.#lines.length).length * CHAR_W;
    if(x - rect.x > GUTTER_DOT + numW + 2 * pad) return null;

    const line = this.#top + Math.floor((y - rect.y - pad) / rowH);
    return line >= 1 && line <= this.#lines.length ? line : null;
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

      /* syntax-colored runs; vg.Text returns the x advance */
      vg.FontFace(FONT);
      vg.FontSize(FONT_SIZE);
      vg.TextAlign(ALIGN_LEFT | ALIGN_TOP);

      let x = textX;
      for(const run of this.#runs[n - 1] ?? []) {
        vg.FillColor(syntax[run.style] ?? colors.text);
        x = vg.Text(Math.round(x), y, run.text.replaceAll('\t', '    '));
      }
    }

    vg.Restore();
  }
}
