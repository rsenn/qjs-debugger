# GUI debugger mode — plan

`qjs-debugger -m gui script.js` opens a native window rendered with
qjs-nanovg on a qjs-glfw OpenGL context. Everything lives in `gui/`;
`imgui/` is not used or touched. Font: `~/.fonts/MiscFixedSC613.ttf`
(a fixed-cell pixel font — ideal for source text; draw at integer
pixel positions, integer font size, no fractional scaling).

## Architecture: immediate-mode MVC

MVC — yes, but in the lightweight form that fits immediate-mode
rendering, not the classic observer/binding ceremony:

- **Model** = the existing `Debugger` class (qjs-debugger.js exports it)
  plus a per-stop `Snapshot`. `Debugger` is already headless: all
  terminal output goes through the injected `print`/`printRaw` sinks,
  and it owns breakpoints, stack, displays, the identifier cache and
  the launch/resume lifecycle. The GUI instantiates the same class the
  REPL uses — breakpoints by function name, `--args`, transports, all
  come for free.
- **View** = stateless panes redrawn from the model every frame
  (`draw(app)` reads, never writes). No widget state to synchronize —
  that is the immediate-mode advantage, and it is why full MVC
  machinery (observers per field, mediators, two-way bindings) would
  be dead weight here.
- **Controller** = a thin input layer mapping clicks/keys onto the
  Debugger methods that already exist (`cmdNext`, `cmdContinue`,
  `resolveLocation`, …). One `onEvent(kind)` callback on Debugger
  (stop / resume / exit) is the only "observer" needed: it marks state
  dirty and triggers the async snapshot refresh.

So: one source of truth, panes render from it, inputs call commands on
it. That is the whole pattern.

## The event-loop constraint (the one hard problem)

tradeview.js-style `while(!shouldClose){ render; swapBuffers; poll(); }`
blocks the QuickJS event loop — EngineConnection sockets, child stdout
forwarding and DebugSession promises would starve (same failure class
as the REPL bugs already fixed). The frame loop must therefore be
timer-driven:

    const tick = () => {
      if(window.shouldClose) return shutdown();
      poll();                       /* glfw input callbacks fire here */
      render();                     /* BeginFrame … EndFrame */
      window.swapBuffers();
      setTimeout(tick, app.animating ? 16 : 40);
    };

Between ticks the event loop services the debug socket and the child's
stdio. A `dirty` flag can skip re-rendering on idle ticks later; not
needed for correctness.

## Async data in an immediate-mode view: Snapshot

Panes must never await. On every stop the controller builds a
`Snapshot`:

    { stack, frame,                      /* selected frame index */
      scopes: Map(ref -> vars|'pending'),/* filled lazily */
      displays: [{ num, expr, value }],
      running: false }

- `stopped` event → fetch stack + local scope + displays, mark dirty.
- Expanding a variable row → if `scopes` lacks that
  `variablesReference`, issue `session.variables(ref)`, store
  `'pending'`, re-render when it resolves.
- Resume/exit → snapshot replaced by `{ running: true }` / null;
  panes gray out, toolbar flips to Pause.

## Files

    gui/
      main.js          entry (export StartGUI(dbg)): window + GL context,
                       font loading, timer frame loop, layout, input wiring
      theme.js         colors, metrics, font registration
                       ('fixed', $HOME/.fonts/MiscFixedSC613.ttf; fallback
                       to DejaVu list with a warning)
      widgets.js       im-mode primitives: panel, textRow, button,
                       scrollbar, hitTest — shared by all panes
      source-pane.js   source text w/ line numbers, current-line highlight,
                       breakpoint gutter (click toggles), wheel scrolling,
                       auto-centers on the stop line
      stack-pane.js    backtrace rows; click selects frame (updates
                       snapshot.frame, source pane follows)
      vars-pane.js     locals/closure/globals sections as an indented tree
                       (expand rows with variablesReference > 0);
                       auto-display expressions shown on top
      console-pane.js  scrollback of child stdout/stderr + debugger
                       messages (this pane IS dbg.print/printRaw's sink);
                       later: a command input line that feeds dbg.execute()
                       for full REPL parity incl. completion
      toolbar.js       Run/Restart · Pause/Continue · Next · Step · Finish ·
                       Kill buttons + status text (file:line / running /
                       exited); keyboard: F5 continue, F10 next, F11 step,
                       Shift-F11 finish, Ctrl-R run

qjs-debugger.js's `gui` mode stub becomes:

    case 'gui':
      import('./gui/main.js').then(({ StartGUI }) => StartGUI(dbg));
      break;

CMake: install `gui/*.js` to `bin/gui/` (relative imports keep working
in-tree and installed).

## Small Debugger (model) extensions needed

- `onEvent = kind => {}` hook fired on stop/resume/exit (today those
  paths only print). REPL mode ignores it.
- `toggleBreakpoint(file, line)` — public wrapper around the existing
  breakpoint list + `#sendBreakpoints` for the gutter click.
- No other changes: `launch()`, `#resume`, displays, sources and the
  identifier cache are reused as-is.

## Phases

1. **Skeleton** — window, font, timer loop, theme, empty pane layout;
   `-m gui` wired. Verify the debug session works while the window is
   open (the event-loop test).
2. **Core debugging** — onEvent hook + Snapshot; toolbar buttons/keys;
   source pane read-only with stop highlight; console pane receiving
   child output.
3. **Interaction** — breakpoint gutter, stack-frame selection,
   flat variables pane.
4. **Depth** — variables tree expansion, displays section, scrollbars,
   window resize relayout.
5. **Parity extras** — command input line (dbg.execute + completion),
   source file picker, hover value tooltips.

## Testing

Core logic stays in `Debugger` (already exercised by the REPL tests).
GUI smoke-testing is manual (`DISPLAY` is available); each phase ends
with `qjs-debugger -m gui target.js`, set a breakpoint, step, inspect
variables, run to exit. Layout/widget helpers are pure functions of
(rect, state) and can be unit-tested headlessly if they grow hairy.
