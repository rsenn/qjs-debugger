/* var-tree.js — variable tree model + ImGui renderer.
 *
 *   VarNode      pure model. Lazy children via an injected provider — any object
 *                with variables(ref, options, cb), i.e. a DebuggerSession, but the
 *                model never imports it. Handles indexedVariables paging in chunks
 *                (and fixes the quickjs-debugger.c quirk that names paged children
 *                0..count-1 instead of start+i).
 *
 *   VarTreeView  ImGui renderer. Remembers expansion by *name path*, because the
 *                server invalidates every variablesReference on resume — after a
 *                step, fresh nodes matching previously-open paths are re-fetched
 *                and re-opened automatically.
 */

import * as ImGui from 'imgui';

const CHUNK = 256;

export class VarNode {
  name;
  value;
  type;
  ref; /* variablesReference; 0 = leaf */
  indexed; /* indexedVariables count (arrays) */
  path;
  children = null; /* null = never fetched, [] = fetched/empty */
  loading = false;
  error = null;
  isRange = false;
  rangeStart = 0;
  rangeCount = 0;

  constructor({ name, value = '', type = '', ref = 0, indexed = 0, path = '' }) {
    this.name = String(name);
    this.value = String(value ?? '');
    this.type = String(type ?? '');
    this.ref = ref | 0;
    this.indexed = indexed | 0;
    this.path = path || this.name;
  }

  static fromVariable(v, parentPath = '') {
    return new VarNode({
      name: v.name,
      value: v.value,
      type: v.type,
      ref: v.variablesReference ?? 0,
      indexed: v.indexedVariables ?? 0,
      path: parentPath ? `${parentPath}/${v.name}` : String(v.name),
    });
  }

  /* Roots for evaluate() results: body = { result, type, variablesReference } */
  static fromEvaluation(label, body, pathPrefix = 'eval') {
    return new VarNode({
      name: label,
      value: body?.result,
      type: body?.type,
      ref: body?.variablesReference ?? 0,
      indexed: body?.indexedVariables ?? 0,
      path: `${pathPrefix}/${label}`,
    });
  }

  get expandable() {
    return this.ref > 0 || this.isRange;
  }

  /* provider.variables(ref, options, cb) may return === false to refuse the
   * request (e.g. the session guards against refs from a previous pause —
   * quickjs-debugger.c assert()s on unknown refs, which would kill the child). */
  fetch(provider, cb = null) {
    if(this.loading) return;
    this.loading = true;
    this.error = null;

    const done = kids => {
      this.children = kids;
      this.loading = false;
      if(cb) cb(this);
    };

    const refused = () => {
      this.loading = false;
      this.error = '<stale>';
      if(cb) cb(this);
    };

    if(this.isRange) {
      const ok = provider.variables(this.ref, { filter: 'indexed', start: this.rangeStart, count: this.rangeCount }, body => {
        if(!Array.isArray(body)) return done([]);
        done(
          body.map((v, i) => {
            const node = VarNode.fromVariable(v, this.path);
            node.name = String(this.rangeStart + i); /* server names them 0..count-1 */
            node.path = `${this.path}/${node.name}`;
            return node;
          }),
        );
      });
      if(ok === false) refused();
      return;
    }

    /* big arrays: synthesize [start..end] range nodes instead of one giant request */
    if(this.indexed > CHUNK) {
      const kids = [];
      for(let start = 0; start < this.indexed; start += CHUNK) {
        const count = Math.min(CHUNK, this.indexed - start);
        const r = new VarNode({ name: `[${start} … ${start + count - 1}]`, value: '', type: 'range', path: `${this.path}/[${start}]` });
        r.isRange = true;
        r.ref = this.ref;
        r.rangeStart = start;
        r.rangeCount = count;
        kids.push(r);
      }
      return done(kids);
    }

    const ok = provider.variables(this.ref, {}, body => {
      if(!Array.isArray(body)) {
        this.error = 'no data';
        return done([]);
      }
      done(body.map(v => VarNode.fromVariable(v, this.path)));
    });
    if(ok === false) refused();
  }
}

/* ----------------------------------------------------------------------- */

const has = name => typeof ImGui[name] == 'function';

/* qjs-imgui defines BeginTable/EndTable/TableSetupColumn/TableHeadersRow/
 * TableNextRow/TableSetColumnIndex in its C++ dispatch (IMGUI_BEGIN_TABLE
 * etc.), but never lists them in js_imgui_static_funcs — so none of them
 * are callable from JS. We render on ImGui.Columns() instead. */

export class VarTreeView {
  id;
  palette;
  expanded = new Set(); /* name paths kept across stop generations */
  showTypes = true;

  /* palette: { text, name, types: {string,integer,float,boolean,null,undefined,object,default}, error } */
  constructor(id, palette) {
    this.id = id;
    this.palette = palette;
  }

  typeColor(type) {
    return this.palette.types[type] ?? this.palette.types.default;
  }

  /* Re-open previously expanded paths on a fresh node set (after step/continue). */
  reExpand(roots, provider) {
    for(const node of roots) {
      if(!this.expanded.has(node.path) || !node.expandable) continue;
      node.fetch(provider, n => this.reExpand(n.children ?? [], provider));
    }
  }

  render(roots, provider) {
    const cols = this.showTypes ? 3 : 2;
    const id = `##vt_${this.id}`;

    ImGui.Columns(cols, id, true);

    ImGui.TextColored(this.palette.dim, 'Name');
    ImGui.NextColumn();
    ImGui.TextColored(this.palette.dim, 'Value');
    ImGui.NextColumn();
    if(this.showTypes) {
      ImGui.TextColored(this.palette.dim, 'Type');
      ImGui.NextColumn();
    }
    ImGui.Separator();

    for(const node of roots) this.#row(node, provider);

    ImGui.Columns(1);
  }

  #row(node, provider) {
    let open = false;

    if(node.expandable) {
      open = ImGui.TreeNode(`${node.name}##${node.path}`);

      if(open && node.children === null && !node.loading) {
        this.expanded.add(node.path);
        node.fetch(provider);
      } else if(open) this.expanded.add(node.path);
      else this.expanded.delete(node.path);
    } else {
      ImGui.BulletText('%s', node.name);
    }
    ImGui.NextColumn();

    if(node.error) ImGui.TextColored(this.palette.error, '%s', node.error);
    else ImGui.TextColored(this.typeColor(node.type), '%s', this.#clip(node.value));

    if(node.value.length > 120 && has('IsItemHovered') && has('SetTooltip')) if (ImGui.IsItemHovered()) ImGui.SetTooltip('%s', node.value.slice(0, 2000));
    ImGui.NextColumn();

    if(this.showTypes) {
      ImGui.TextColored(this.palette.dim, '%s', node.type);
      ImGui.NextColumn();
    }

    if(open) {
      if(node.loading) {
        ImGui.TextColored(this.palette.dim, '(loading…)');
        ImGui.NextColumn();
        ImGui.NextColumn();
        if(this.showTypes) ImGui.NextColumn();
      } else for(const child of node.children ?? []) this.#row(child, provider);

      ImGui.TreePop();
    }
  }

  #clip(s) {
    return s.length > 120 ? s.slice(0, 117) + '...' : s;
  }
}
