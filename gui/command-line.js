/**
 * gui/command-line.js — single-line gdb command input at the bottom of
 * the console pane. Submits through app.submitCommand() (the same
 * command interpreter as the REPL) and completes via
 * dbg.getCompletions(), so break/print/display completion works here
 * too.
 */

import { colors, FONT_SIZE, metrics, syntax } from './theme.js';
import { fillRect, text } from './widgets.js';

export class CommandLine {
  text = '';
  cursor = 0;
  #history = [];
  #hIndex = 0;
  #saved = '';

  /** Reusable input: the console prompt by default, custom submit/complete for other panes. */
  constructor({ prompt = '(qjs-dbg) ', onSubmit, complete } = {}) {
    this.prompt = prompt;
    this.onSubmit = onSubmit ?? ((app, line) => app.submitCommand(line));
    this.complete = complete ?? ((app, text, cursor) => app.dbg.getCompletions(text, cursor));
  }

  #set(text, cursor = text.length) {
    this.text = text;
    this.cursor = cursor;
  }

  insert(str) {
    this.#set(this.text.slice(0, this.cursor) + str + this.text.slice(this.cursor), this.cursor + str.length);
  }

  handleChar(codepoint) {
    const ch = String.fromCodePoint(codepoint);
    if(ch >= ' ') this.insert(ch);
  }

  /** Editing keys; returns true when consumed. */
  handleKey(app, key) {
    const { KEYS } = CommandLine;

    switch (key) {
      case KEYS.ENTER: {
        const line = this.text;
        if(line.trim()) {
          this.#history.push(line);
          if(this.#history.length > 200) this.#history.shift();
        }
        this.#hIndex = this.#history.length;
        this.#set('');
        this.onSubmit(app, line);
        return true;
      }

      case KEYS.BACKSPACE:
        if(this.cursor > 0) this.#set(this.text.slice(0, this.cursor - 1) + this.text.slice(this.cursor), this.cursor - 1);
        return true;

      case KEYS.DELETE:
        this.#set(this.text.slice(0, this.cursor) + this.text.slice(this.cursor + 1), this.cursor);
        return true;

      case KEYS.LEFT:
        this.cursor = Math.max(0, this.cursor - 1);
        return true;

      case KEYS.RIGHT:
        this.cursor = Math.min(this.text.length, this.cursor + 1);
        return true;

      case KEYS.HOME:
        this.cursor = 0;
        return true;

      case KEYS.END:
        this.cursor = this.text.length;
        return true;

      case KEYS.UP:
        if(this.#hIndex > 0) {
          if(this.#hIndex == this.#history.length) this.#saved = this.text;
          this.#set(this.#history[--this.#hIndex]);
        }
        return true;

      case KEYS.DOWN:
        if(this.#hIndex < this.#history.length) {
          this.#hIndex++;
          this.#set(this.#hIndex == this.#history.length ? this.#saved : this.#history[this.#hIndex]);
        }
        return true;

      case KEYS.TAB: {
        const res = this.complete(app, this.text, this.cursor);
        const tab = res?.tab ?? [];
        if(!tab.length) return true;

        /* insert the chars shared by all candidates (repl semantics) */
        let len = tab[0].length;
        for(let i = 1; i < tab.length; i++) {
          let j = 0;
          while(j < len && tab[i][j] == tab[0][j]) j++;
          len = j;
        }

        if(len > res.pos) this.insert(tab[0].slice(res.pos, len));
        else if(tab.length > 1) app.console.push(tab.join('  '));
        return true;
      }
    }

    return false;
  }

  draw(vg, rect, focused = true) {
    const { pad, charW } = metrics;

    fillRect(vg, rect.x, rect.y, rect.w, rect.h, colors.titleBg);

    const y = rect.y + Math.floor((rect.h - FONT_SIZE) / 2) + 1;
    text(vg, rect.x + pad, y, this.prompt, focused ? colors.accent : colors.dim);

    const tx = rect.x + pad + Math.round(this.prompt.length * charW);
    text(vg, tx, y, this.text, colors.text);

    if(!focused) return;

    /* block cursor */
    fillRect(vg, tx + Math.round(this.cursor * charW), y, Math.ceil(charW), FONT_SIZE, colors.border);
    if(this.cursor < this.text.length) text(vg, tx + Math.round(this.cursor * charW), y, this.text[this.cursor], colors.bg);
  }
}

/* glfw key codes (the module exports them; kept local to avoid the import churn) */
CommandLine.KEYS = { ENTER: 257, TAB: 258, BACKSPACE: 259, DELETE: 261, RIGHT: 262, LEFT: 263, DOWN: 264, UP: 265, HOME: 268, END: 269 };
