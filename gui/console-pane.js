/**
 * gui/console-pane.js — scrollback for child stdout/stderr and debugger
 * messages. This pane is the sink behind dbg.print/printRaw in GUI mode.
 */

import { colors, FONT_SIZE, metrics } from './theme.js';
import { scrollbar, text } from './widgets.js';

const MAX_LINES = 1000;

export class ConsolePane {
  #lines = [];
  #partial = ''; /* trailing chunk without a newline yet */
  #scroll = 0; /* lines scrolled up from the bottom */
  #lastTotal = 0; /* from the last draw, for the scrollbar interface */
  #lastRows = 1;

  /** One complete message line (dbg.print). */
  push(str) {
    this.pushRaw(str + '\n');
  }

  /** Raw chunk, possibly with embedded/partial lines (dbg.printRaw). */
  pushRaw(str) {
    /* the pixel font has no tab glyph; ANSI colors don't apply here */
    this.#partial += String(str).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replaceAll('\t', '    ');

    for(;;) {
      const nl = this.#partial.indexOf('\n');
      if(nl < 0) break;
      this.#lines.push(this.#partial.slice(0, nl));
      this.#partial = this.#partial.slice(nl + 1);
    }

    if(this.#lines.length > MAX_LINES) this.#lines.splice(0, this.#lines.length - MAX_LINES);
  }

  scrollBy(n) {
    const max = Math.max(0, this.#lines.length - 1);
    this.#scroll = Math.max(0, Math.min(max, this.#scroll + n));
  }

  /* uniform scrollbar interface; #scroll counts from the bottom */
  get scrollInfo() {
    return { total: this.#lastTotal, visible: this.#lastRows, offset: Math.max(0, this.#lastTotal - this.#lastRows - this.#scroll) };
  }

  setScrollOffset(o) {
    this.#scroll = Math.max(0, this.#lastTotal - this.#lastRows - o);
  }

  draw(vg, rect) {
    const { rowH, pad } = metrics;
    const rows = Math.max(1, Math.floor((rect.h - pad) / rowH));

    const all = this.#partial ? [...this.#lines, this.#partial] : this.#lines;
    const end = Math.max(0, all.length - this.#scroll);
    const start = Math.max(0, end - rows);

    this.#lastTotal = all.length;
    this.#lastRows = rows;

    vg.Save();
    vg.IntersectScissor(rect.x, rect.y, rect.w, rect.h);

    let y = rect.y + pad;
    for(let i = start; i < end; i++, y += rowH) text(vg, rect.x + pad, y, all[i]);

    scrollbar(vg, rect, all.length, rows, start);

    vg.Restore();
  }
}
