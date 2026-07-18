/**
 * gui/theme.js — colors, metrics and font for the GUI debugger.
 *
 * MiscFixedSC613 is a 6x13 semicondensed pixel font: draw it at
 * FONT_SIZE 13, integer pixel positions, no fractional scaling.
 */

import { gethome } from 'path';
import { RGB } from 'nanovg';

export const FONT = 'fixed';
export const FONT_SIZE = 12;

const FONT_PATHS = [
  gethome() + '/.fonts/MiscFixedSC613.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
  '/usr/share/fonts/TTF/DejaVuSansMono.ttf',
];

/** Register the UI font on the nanovg context; returns the path or null. */
export function loadFont(vg) {
  for(const path of FONT_PATHS)
    if(vg.CreateFont(FONT, path) >= 0) {
      /* measure the monospace advance; column math everywhere uses it
         (TextBounds takes exactly (x, y, str, end, bounds) and returns
         the advance) */
      try {
        vg.FontFace(FONT);
        vg.FontSize(FONT_SIZE);
        const w = vg.TextBounds(0, 0, 'MMMMMMMMMM', null, {});
        if(w > 0) metrics.charW = w / 10;
      } catch(e) {}
      return path;
    }

  return null;
}

export const colors = {
  bg: RGB(0, 0, 0),
  panel: RGB(0, 0, 0),
  border: RGB(70, 70, 76),
  titleBg: RGB(48, 48, 52),
  titleFg: RGB(210, 210, 210),
  text: RGB(220, 220, 220),
  dim: RGB(140, 140, 140),
  accent: RGB(90, 160, 255),
  running: RGB(230, 190, 80),
  stopped: RGB(120, 210, 120),
  exited: RGB(160, 160, 160),
  breakpoint: RGB(220, 80, 80),
  currentLine: RGB(50, 60, 40),
};

/* source syntax colors, keyed by the style names REPL.colorizeJs emits
   (same scheme as the repl: punctuation light blue, comments light green,
   identifiers yellow, keywords red) */
export const syntax = {
  default: RGB(90, 220, 220) /* punctuation, operators: cyan */,
  comment: RGB(130, 220, 130),
  string: RGB(100, 220, 220),
  regex: RGB(220, 120, 220),
  number: RGB(120, 200, 120),
  keyword: RGB(240, 100, 100),
  type: RGB(240, 100, 100),
  identifier: RGB(235, 220, 100),
  function: RGB(235, 220, 100),
  error: RGB(255, 80, 80),
};

export const metrics = {
  toolbarH: 26,
  consoleH: 160,
  titleH: 18,
  rowH: FONT_SIZE + 1,
  pad: 6,
  charW: 7 /* remeasured from the font in loadFont() */,
};
