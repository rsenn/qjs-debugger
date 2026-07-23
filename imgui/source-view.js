/* source-view.js — source code model + Module-window renderer.
 *
 *   SourceCache  loads files once, tokenizes the WHOLE file (so multi-line
 *                comments and template strings keep their state), splits the
 *                token stream into per-line [type, text] segments. Tokenizer is
 *                plot-cv's TrivialTokenizer regex, extended with a number class.
 *
 *   SourceView   ImGui renderer: line-number gutter with breakpoint '*' and
 *                execution '>' marks, cursor line (click), per-token colors,
 *                manual clipping for large files, scroll-to-line on stops.
 *
 * Token types: whitespace keyword comment identifier number string other
 * Colors are injected (palette), the view has no opinion about them.
 */

import * as fs from 'fs';
import * as ImGui from 'imgui';

const TOKEN_RE =
  /(\n|\t| )|(\b(?:arguments|as|async|await|break|case|catch|class|const|constructor|continue|debugger|default|delete|do|else|enum|eval|export|extends|false|finally|for|from|function|get|if|implements|import|in|instanceof|interface|let|meta|new|null|of|package|private|protected|public|return|set|static|super|switch|target|this|throw|true|try|typeof|var|void|while|with|yield)\b)|(\/\*(?:[^*]\/|[^/])*\*\/|\/\/[^\n]*(?=\n|$))|([A-Za-z_$][A-Za-z_$0-9]*)|((?:0[xXoObB][0-9a-fA-F_]+|(?:[0-9][0-9_]*)(?:\.[0-9_]*)?(?:[eE][+-]?[0-9]+)?)n?)|("(?:\\"|[^"\n])*"|'(?:\\'|[^'\n])*'|`(?:\\`|[^`])*`)|([^\sA-Za-z_$'"`])/g;

const TOKEN_TYPES = [undefined, 'whitespace', 'keyword', 'comment', 'identifier', 'number', 'string', 'other'];

export function tokenize(input) {
  TOKEN_RE.lastIndex = 0;
  const ret = [];
  let match;
  while((match = TOKEN_RE.exec(input))) {
    const which = match.findIndex((m, i) => i > 0 && m !== undefined);
    ret.push([TOKEN_TYPES[which] ?? 'other', match[which] ?? match[0]]);
  }
  return ret;
}

/* token stream -> array of lines, each line an array of [type, text] segments */
export function tokenizeLines(input, tabWidth = 4) {
  const lines = [[]];
  for(const [type, text] of tokenize(input)) {
    const parts = text.split('\n');
    for(let i = 0; i < parts.length; i++) {
      if(i > 0) lines.push([]);
      let seg = parts[i];
      if(seg === '') continue;
      if(type === 'whitespace') seg = seg.replace(/\t/g, ' '.repeat(tabWidth));
      const line = lines[lines.length - 1];
      const last = line[line.length - 1];
      if(last && last[0] === type) last[1] += seg;
      else line.push([type, seg]);
    }
  }
  return lines;
}

export class SourceCache {
  #files = new Map(); /* path -> { lines, error } */

  load(path) {
    let entry = this.#files.get(path);
    if(entry) return entry;

    try {
      const text = fs.readFileSync(path, 'utf8');
      entry = { path, lines: tokenizeLines(text), error: null };
    } catch(e) {
      entry = { path, lines: [[['comment', `// <source unavailable: ${e.message}>`]]], error: e.message };
    }

    this.#files.set(path, entry);
    return entry;
  }

  invalidate(path = null) {
    if(path === null) this.#files.clear();
    else this.#files.delete(path);
  }

  get knownFiles() {
    return [...this.#files.keys()];
  }
}

/* ----------------------------------------------------------------------- */

const has = name => typeof ImGui[name] == 'function';

export class SourceView {
  cache;
  palette; /* { tokens: {keyword,identifier,comment,number,string,other,whitespace}, gutter, gutterBp, gutterCur, currentLine } */
  file = null;
  cursorLine = 1;
  #scrollTo = -1;

  constructor(cache, palette) {
    this.cache = cache;
    this.palette = palette;
  }

  show(path, line = -1) {
    this.file = path;
    if(line > 0) {
      this.cursorLine = line;
      this.#scrollTo = line;
    }
  }

  /* opts: { currentLine, isBreakpoint(line), onClickLine(line) } */
  render(opts = {}) {
    if(!this.file) {
      ImGui.TextColored(this.palette.tokens.comment, '// no module loaded');
      return;
    }

    const { lines } = this.cache.load(this.file);
    const lineH = has('GetTextLineHeightWithSpacing') ? ImGui.GetTextLineHeightWithSpacing() : 17;
    const total = lines.length;

    /* manual clipper */
    let first = 0,
      last = total;
    if(has('GetScrollY')) {
      const [, availH] = ImGui.GetContentRegionAvail();
      const scrollY = ImGui.GetScrollY();
      first = Math.max(0, Math.floor(scrollY / lineH) - 4);
      last = Math.min(total, first + Math.ceil(availH / lineH) + 8);
      if(first > 0) ImGui.Dummy([1, first * lineH]);
    }

    for(let i = first; i < last; i++) this.#line(i + 1, lines[i], opts);

    if(last < total) ImGui.Dummy([1, (total - last) * lineH]);

    if(this.#scrollTo > 0) {
      if(has('SetScrollY')) ImGui.SetScrollY(Math.max(0, (this.#scrollTo - 8) * lineH));
      this.#scrollTo = -1;
    }
  }

  #line(no, segs, opts) {
    const isCur = no === opts.currentLine;
    const hasBp = opts.isBreakpoint ? opts.isBreakpoint(no) : false;

    const mark = isCur ? '>' : hasBp ? '*' : ' ';
    const num = String(no).padStart(5);
    const label = `${mark}${num} ##src${no}`;

    if(ImGui.Selectable(label, isCur || no === this.cursorLine)) {
      this.cursorLine = no;
      if(opts.onClickLine) opts.onClickLine(no);
    }

    let firstSeg = true;
    for(const [type, text] of segs) {
      if(firstSeg) {
        ImGui.SameLine(64);
        firstSeg = false;
      } else ImGui.SameLine(0, 0);

      const col = isCur ? this.palette.currentLine : (this.palette.tokens[type] ?? this.palette.tokens.other);
      ImGui.TextColored(col, '%s', text);
    }
  }
}
