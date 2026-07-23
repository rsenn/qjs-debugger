/* debugger-client.js — protocol session for quickjs-debugger.c.
 *
 * Synchronous-poll sibling of plot-cv's DebuggerDispatcher: identical command
 * surface (stepIn / next / stepOut / continue / pause / evaluate / scopes /
 * variables / stackTrace / breakpoints / stopOnException), but callback-based
 * and pumped once per UI frame — no promises, no event loop required.
 *
 * Fully uncoupled: knows nothing about sockets, framing, ImGui or trees.
 * The transport is any object with { connected, send(obj), pump() -> obj[] }.
 *
 * Protocol facts honoured here (from quickjs-debugger.c):
 *   - scope variablesReference encoding: (frame << 2) | scope; 0=Global 1=Local 2=Closure
 *   - object references are allocated per-pause; ALL refs die on resume
 *   - the debuggee announces pauses via { type:'event', event:{ type:'StoppedEvent',
 *     reason: entry|breakpoint|step|stepIn|stepOut|pause|exception } }
 *   - breakpoints are per-path line lists, replaced wholesale on each sync
 */

export const SCOPE_GLOBAL = 0,
  SCOPE_LOCAL = 1,
  SCOPE_CLOSURE = 2;

export function scopeReference(frame, scope) {
  return (frame << 2) | scope;
}

export class Breakpoint {
  line;
  enabled = true;
  temp = false;
  condition = null;
  ignore = 0;
  hits = 0;

  constructor(line, opts = {}) {
    this.line = line;
    Object.assign(this, opts);
  }
}

