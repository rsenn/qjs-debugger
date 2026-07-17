/**
 * gui/widgets.js — immediate-mode drawing primitives shared by the panes.
 * Pure draw calls on the nanovg context; no retained state.
 */

import { ALIGN_LEFT, ALIGN_TOP } from 'nanovg';
import { colors, FONT, FONT_SIZE, metrics } from './theme.js';

export function fillRect(vg, x, y, w, h, color) {
  vg.BeginPath();
  vg.Rect(x, y, w, h);
  vg.FillColor(color);
  vg.Fill();
}

export function strokeRect(vg, x, y, w, h, color) {
  vg.BeginPath();
  /* 0.5 offsets keep 1px lines crisp */
  vg.Rect(x + 0.5, y + 0.5, w - 1, h - 1);
  vg.StrokeColor(color);
  vg.StrokeWidth(1);
  vg.Stroke();
}

/** Draw one line of text at integer pixel position (pixel font). */
export function text(vg, x, y, str, color = colors.text) {
  vg.FontFace(FONT);
  vg.FontSize(FONT_SIZE);
  vg.TextAlign(ALIGN_LEFT | ALIGN_TOP);
  vg.FillColor(color);
  vg.Text(Math.round(x), Math.round(y), str);
}

/**
 * Panel frame with title bar; returns the content rect
 * { x, y, w, h } inside the frame.
 */
export function panel(vg, rect, title) {
  const { x, y, w, h } = rect;
  const { titleH, pad } = metrics;

  fillRect(vg, x, y, w, h, colors.panel);
  fillRect(vg, x, y, w, titleH, colors.titleBg);
  strokeRect(vg, x, y, w, h, colors.border);
  text(vg, x + pad, y + (titleH - FONT_SIZE) / 2 + 1, title, colors.titleFg);

  return { x: x + 1, y: y + titleH, w: w - 2, h: h - titleH - 1 };
}

export function contains(rect, x, y) {
  return x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
}

/** Clickable zone at the right edge; the visual bar is 4px of it. */
export const SCROLLBAR_W = 10;

/** Right-edge scroll indicator; hidden when everything fits. */
export function scrollbar(vg, rect, total, visible, offset) {
  if(!(total > visible)) return;

  const x = rect.x + rect.w - 5;
  fillRect(vg, x, rect.y, 4, rect.h, colors.titleBg);

  const th = Math.max(12, (visible / total) * rect.h);
  const ty = rect.y + (Math.min(offset, total - visible) / (total - visible)) * (rect.h - th);
  fillRect(vg, x, ty, 4, th, colors.border);
}

export function scrollbarHit(rect, x, y) {
  return x >= rect.x + rect.w - SCROLLBAR_W && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
}

/** Offset-from-top for a pointer at `y` on the track (thumb-centered, clamped). */
export function scrollbarOffset(rect, y, total, visible) {
  if(!(total > visible)) return 0;

  const th = Math.max(12, (visible / total) * rect.h);
  const f = (y - rect.y - th / 2) / (rect.h - th);
  return Math.round(Math.max(0, Math.min(1, f)) * (total - visible));
}
