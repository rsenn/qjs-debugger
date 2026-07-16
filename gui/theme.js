/**
 * gui/theme.js — colors, metrics and font for the GUI debugger.
 *
 * MiscFixedSC613 is a 6x13 semicondensed pixel font: draw it at
 * FONT_SIZE 13, integer pixel positions, no fractional scaling.
 */

import { gethome } from 'path';
import { RGB } from 'nanovg';

export const FONT = 'fixed';
export const FONT_SIZE = 13;

const FONT_PATHS = [
  gethome() + '/.fonts/MiscFixedSC613.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
  '/usr/share/fonts/TTF/DejaVuSansMono.ttf',
];

/** Register the UI font on the nanovg context; returns the path or null. */
export function loadFont(vg) {
  for(const path of FONT_PATHS) if(vg.CreateFont(FONT, path) >= 0) return path;
  return null;
}

export const colors = {
  bg: RGB(24, 24, 26),
  panel: RGB(32, 32, 35),
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

export const metrics = {
  toolbarH: 26,
  consoleH: 160,
  titleH: 18,
  rowH: 14,
  pad: 6,
};
