# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A gdb-style source-level debugger for QuickJS (rsenn fork), written in JavaScript and running on QuickJS itself. Two frontends — an interactive terminal REPL and a native GUI (nanovg/glfw) — plus a DAP adapter for VS Code, all drive the engine's built-in debugger protocol over a pluggable transport. This directory is also a self-contained VS Code extension (`package.json` registers the `qjs` debug type; `extension.js` is its entry point).

There is no bundler, no test runner, no lint config, and no `npm install` step — the code runs directly on QuickJS, and JS here targets that engine, not Node.

`TODO` and `BUGS` are plain lowercase-entry text files in the repo root — the roadmap and known bugs, respectively. Each entry is a line starting with `-`. Check them for planned work or known issues; add entries the same way when asked to note something down. Newly discovered bugs go at the end of `BUGS`.

## Building / running

This module doesn't build standalone; it's one piece of the top-level quickjs fork's CMake build (submodules: qjs-modules, qjs-glfw/qjs-nanovg, qjs-lws):

```
git clone --recurse-submodules https://github.com/rsenn/quickjs.git
cd quickjs
cmake -B build/native -DCMAKE_BUILD_TYPE=RelWithDebInfo -DBUILD_SHARED_LIBS=ON \
  -DMODULE_MODULES=ON -DMODULE_DEBUGGER=ON \
  -DMODULE_GLFW=ON -DMODULE_NANOVG=ON   # only needed for -m gui
  # -DMODULE_LWS=ON                     # only needed for -t lws
cmake --build build/native -j$(nproc)
cmake --install build/native
```

This directory's `CMakeLists.txt` just installs the JS files: `qjs-debugger.js` → `bin/qjs-debugger` (+ `qjsm-debugger` symlink), the support modules (`codec.js`, `session.js`, `engine-connection.js`, `transport.js`, `server-adapter.js`, `vscode-dap.js`, `connector-lws.js`) → `bin/`, `gui/*.js` → `bin/gui/`, and the browser demo → `bin/examples/browser/`. Adding a new support module or GUI pane means adding it to the relevant `install(FILES …)` list here too.

Running:
```
qjs-debugger script.js                  # REPL, spawns qjs as debuggee
qjsm-debugger -m gui script.js          # native GUI, spawns qjsm
qjs-debugger -m server script.js        # WS server + browser UI on PORT+1
qjs-debugger -m dap                     # DAP adapter over stdio (VS Code spawns this)
```

There is no automated test suite. `Debugger`'s core logic is exercised indirectly via the REPL; GUI changes are smoke-tested manually (`qjs-debugger -m gui target.js`: set a breakpoint, step, inspect variables, run to exit — see `gui/PLAN.md` "Testing"). Verify JS changes by actually running the affected mode against `examples/orbit.js` or a scratch script.

VS Code extension: load as an Extension Development Host (`code --extensionDevelopmentPath="$PWD" /path/to/project`), or package with `npx @vscode/vsce package` and `code --install-extension qjs-debugger-*.vsix`.

## Architecture

Small modules with strict layering; every class talks to its neighbors through a minimal duck-typed contract, not inheritance:

- `codec.js` — framing only: `%08x\n` + JSON + `\n`, incremental decoder. No imports.
- `session.js` — protocol state machine: seqs, pending requests, events. Zero imports.
- `transport.js` — byte transports: `SocketTransport` ('sockets', qjs-modules' `AsyncSocket`) and `StreamTransport` (qjs-lws). Each exposes `connect()`/`accept()`.
- `engine-connection.js` — framed messages over an injected transport; `StartEngine()` spawns the debuggee with the debugger armed (`QUICKJS_DEBUG_ADDRESS`/`QUICKJS_DEBUG_LISTEN_ADDRESS`).
- `qjs-debugger.js` — the `Debugger` model, the gdb-style command interpreter, and REPL mode. This is the biggest file and the one most other pieces depend on.
- `vscode-dap.js` — DAP adapter (`-m dap`) wrapping the same `Debugger`/`EngineConnection` for VS Code.
- `gui/` — immediate-mode MVC panes on nanovg/glfw (`-m gui`); see `gui/PLAN.md` for the full design and the event-loop constraint below. `imgui/` is an unrelated/unused prior attempt — don't touch it for GUI work.
- `server-adapter.js`, `connector-lws.js`, `connector-qjsnet.js`, `client.js` — N-clients-to-1-engine fan-out and WebSocket connectors for `-m server`, plus the browser demo client under `examples/browser/`.

The three load-bearing contracts (read this before changing any of the above):
- a **transport** is `{ [Symbol.asyncIterator](), send(data), close() }` with static `connect(address, options)` / `accept(address, options)` (accept fires `options.listening()` once bound; the engine's outgoing connect does not retry).
- a **DebugSession** is constructed with a `send(obj)` function and fed via `dispatch(obj)`.
- the **Debugger** model is headless: all output goes through injected `print`/`printRaw` sinks, and state changes surface only through an `onEvent('running'|'stopped'|'exited')` hook — this is how the identical class backs both the REPL and the GUI.

### GUI mode specifics (`gui/`)

Immediate-mode MVC: Model = `Debugger` + a per-stop `Snapshot`; View = stateless `draw(app)` panes redrawn every frame, no widget state to sync; Controller = a thin input layer calling existing `Debugger` methods (`cmdNext`, `cmdContinue`, `resolveLocation`, …).

The one hard constraint: a blocking render loop (`while(!shouldClose){ render; swapBuffers; poll(); }`) starves the QuickJS event loop that services the debug socket and child stdio — the same failure class as bugs already fixed in the REPL. The frame loop must stay timer-driven (`setTimeout(tick, app.animating ? 16 : 40)` after `poll()`/`render()`/`swapBuffers()`), never a blocking loop.

Panes must never `await`. Async data (stack, scopes, displays) is fetched into a `Snapshot` object on `stopped`/frame-selection/expand events and panes just read whatever is currently in it, showing `'pending'` placeholders until it resolves.

Font: `~/.fonts/MiscFixedSC613.ttf` (fixed-cell; draw at integer pixel positions/sizes, no fractional scaling), falls back to DejaVu Sans Mono with a warning.

## Transports and connection direction

Two independent axes, both configurable from the CLI and from VS Code launch configs:
- **transport**: `socket` (qjs-modules `AsyncSocket`, default) or `lws` (qjs-lws `TCPSocketStream`, `-t lws`).
- **direction**: debugger listens and the engine connects out (default, `-l`), or the engine listens and the debugger connects (`-c`).

When touching connection setup, changes usually need to work symmetrically for both transports and both directions — check `transport.js` and `engine-connection.js` together.
