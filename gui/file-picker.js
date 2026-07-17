/**
 * gui/file-picker.js — temporary overlay listing the debuggee's source
 * files. Opened by clicking the source pane's title (the path); clicking
 * a row selects that file into the source pane, any other click or
 * Escape dismisses it.
 */

import { colors, FONT_SIZE, metrics } from './theme.js';
import { contains, fillRect, panel, scrollbar, text } from './widgets.js';

export class FilePicker {
  files = null; /* null = closed */
  #scroll = 0;
  #rect = null; /* overlay rect of the last draw */

  get isOpen() {
    return Array.isArray(this.files);
  }

  open(files) {
    this.files = files;
    this.#scroll = 0;
  }

  close() {
    this.files = null;
    this.#rect = null;
  }

  scrollBy(n) {
    this.#scroll = Math.max(0, Math.min(Math.max(0, (this.files?.length ?? 0) - 1), this.#scroll + n));
  }

  /** Overlay centered over `over` (the source pane rect). */
  draw(app, over) {
    if(!this.isOpen) return;

    const { vg } = app;
    const { rowH, titleH, pad } = metrics;

    const w = Math.min(Math.max(...this.files.map(f => f.length), 20) * metrics.charW + 4 * pad, over.w - 2 * pad);
    const h = Math.min(titleH + this.files.length * rowH + 3 * pad, over.h - 2 * pad);
    const rect = (this.#rect = {
      x: over.x + Math.floor((over.w - w) / 2),
      y: over.y + pad,
      w: Math.floor(w),
      h: Math.floor(h),
    });

    const content = panel(vg, rect, 'Select source');

    vg.Save();
    vg.IntersectScissor(content.x, content.y, content.w, content.h);

    const rows = Math.max(1, Math.floor((content.h - pad) / rowH));
    const max = Math.max(0, this.files.length - rows);
    if(this.#scroll > max) this.#scroll = max;

    let y = content.y + pad;
    for(let i = this.#scroll; i < this.files.length && i < this.#scroll + rows; i++, y += rowH) {
      const file = this.files[i];
      const current = file == app.source.file;
      if(current) fillRect(vg, content.x, y - 1, content.w, rowH, colors.currentLine);
      text(vg, content.x + pad, y, file, current ? colors.accent : colors.text);
    }

    scrollbar(vg, content, this.files.length, rows, this.#scroll);

    vg.Restore();
  }

  /** File under (x, y), or undefined when the click misses the rows. */
  fileAt(x, y) {
    if(!this.isOpen || !this.#rect) return undefined;

    const { rowH, titleH, pad } = metrics;
    const content = { x: this.#rect.x, y: this.#rect.y + titleH, w: this.#rect.w, h: this.#rect.h - titleH };
    if(!contains(content, x, y)) return undefined;

    return this.files[this.#scroll + Math.floor((y - content.y - pad) / rowH)];
  }
}
