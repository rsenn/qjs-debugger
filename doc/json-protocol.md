# Scripting qjs-debugger

Three ways to drive a debug session without a terminal:

| way | use it for |
| --- | --- |
| `--batch FILE` / `--plain` | a command script, plain text output |
| `--json` | the same, one JSON record per line, for programs |
| `import { Debugger } from 'qjs-debugger'` | tests and tools in JavaScript |

## Batch mode

```sh
qjsm-debugger --plain -x cmds.txt script.js     # commands from a file
printf 'break f\nrun\nbt\n' | qjsm-debugger --plain script.js   # or stdin
qjsm-debugger --json -x cmds.txt --args script.js a b           # JSON records
```

- `-x`/`--batch FILE` reads commands from FILE (`-`: stdin); `--plain`/`--no-color`
  alone reads stdin. `--json` implies plain. No line editor, no ANSI.
- One command per line; blank lines and `#` comments are skipped. Commands run
  one after the other, each waits for the program to stop or exit, so a piped
  `break` + `run` is race-free.
- Plain mode echoes `(qjs-dbg) COMMAND` before each command output. `echo TEXT\n`
  puts markers into the output.
- `--strict` stops at the first failed command, `--timeout SECS` kills the
  debuggee and exits 124.
- At the end of input a running debuggee is killed.

Exit status:

| status | when |
| --- | --- |
| `N` | `quit N` was given |
| 124 | `--timeout` expired |
| 1 | some command failed (unknown command, "The program is not being run.", unknown function, ...) |
| exit code of the debuggee | otherwise; 128+N if it died of signal N |
| 0 | otherwise |

## JSON records

One JSON object per line on stdout, each with a `type`.

| type | when | keys |
| --- | --- | --- |
| `stopped` | the program stopped | `reason`, `file`, `line`, `function`, `frame`, `source`, `stack`, `locals`, `displays?`, `breakpoint?`, `watchpoint?` |
| `exited` | the program ended | `code`, `signal`, `pid?`; `killed: true` after `kill` |
| `output` | the program wrote | `stream` (`stdout` or `stderr`), `data` |
| `result` | every command, once, last | `command`, `ok`, then `error` or command specific keys |

`reason` is one of `entry`, `breakpoint`, `step`, `exception`, `pause`, `watchpoint`.
`stack` is `[{ frame, function, file, line }]`, `locals` is `[{ name, value, type }]`
(`value` is the engine's string form, `type` one of `integer`, `float`, `string`,
`boolean`, `null`, `undefined`, `object`). `watchpoint` is `{ num, expr, old, new }`.

A command that resumes the program first emits the `output`, `stopped` or `exited`
records it caused, then its `result`:

```
{"type":"result","command":"break","ok":true,"breakpoint":{"num":1,"file":"d.js","line":3,"spec":"d.js:3"}}
{"type":"stopped","reason":"breakpoint","breakpoint":1,"frame":0,"function":"f","file":"d.js","line":3,"source":" return b+1;","stack":[{"frame":0,"function":"f","file":"d.js","line":3},{"frame":1,"function":"<anonymous>","file":"d.js","line":5}],"locals":[{"name":"a","value":"20","type":"integer"},{"name":"b","value":"40","type":"integer"}]}
{"type":"result","command":"run","ok":true,"state":"stopped","reason":"breakpoint","file":"d.js","line":3,"function":"f"}
{"type":"result","command":"print","ok":true,"n":1,"expr":"a","value":20,"text":"20","valueType":"integer"}
{"type":"output","stream":"stdout","data":"41\n"}
{"type":"exited","code":0,"signal":null,"pid":3227947}
{"type":"result","command":"continue","ok":true,"state":"exited","code":0,"signal":null}
```

Result payloads by command:

| command | keys |
| --- | --- |
| `run` `start` `starti` `continue` `next` `step` `finish` `until` | `state` (`stopped`/`exited`), `reason`, `file`, `line`, `function` or `code`, `signal` |
| `break` `tbreak` | `breakpoint: { num, file, line, spec, condition?, temp? }` |
| `watch` | `watchpoint: { num, expr, value? }` |
| `delete` | `deleted: [num]` |
| `print` `eval` `call` `set var` | `expr`, `value` (typed: number, boolean, null, string), `text`, `valueType`; `n` for print; `exception: true` if the expression threw |
| `backtrace` `info stack` | `stack` |
| `frame` `up` `down` | `frame`, `source` |
| `list` | `file`, `lines: [{ n, text }]` |
| `info breakpoints` | `breakpoints`, `watchpoints` |
| `info locals` | `locals` |
| `info source` | `file`, `line`, `lines`, `program`, `sources` |
| `info program` | `program`, `state`, `pid`, `exitCode` |
| `echo` | `text` |

A failed command gives `{"type":"result","command":"print","ok":false,"error":"The program is not being run."}`.

## Commands beyond the gdb basics

| command | meaning |
| --- | --- |
| `break LOC if EXPR` | stop only when EXPR is true (checked by the debugger, so a false condition costs one round trip) |
| `tbreak LOC [if EXPR]` | one-shot breakpoint |
| `watch EXPR` | software watchpoint: while one exists, `continue` runs statement by statement (`next`) and stops when EXPR's text changes. Slow; EXPR is evaluated in the innermost frame |
| `until [LOC]` | run to LOC; without it, `next` until the line is past the current one (leaves loops) |
| `eval EXPR` | print the bare value (no `$N`) |
| `call EXPR` | evaluate, e.g. a function call; result printed unless undefined |
| `set var NAME = EXPR` | assign in the selected frame (also: `print NAME = EXPR`) |
| `echo TEXT` | print TEXT, `\n` and `\t` escapes |
| `info source`, `info program` | current file and program state, exit status |
| `quit [CODE]` | exit the debugger with CODE |

Not available: `return` (the engine has no forced return) and hardware watchpoints.

## Library

```js
import { Debugger } from 'qjs-debugger';

const dbg = new Debugger({ interpreter: 'qjsm', quiet: true });
dbg.on('stopped', stop => console.log(stop.reason, stop.file, stop.line));
dbg.on('output', out => process.stdout.write(out.data));

await dbg.launch('script.js', ['arg']);      // stopped at entry
dbg.break('script.js:3', { condition: 'a > 1' });
const stop = await dbg.continue();           // { type: 'stopped', reason, file, line, stack, locals, ... }
console.log((await dbg.eval('a * 2')).value);   // typed: 40
await dbg.step();  await dbg.next();  await dbg.finish();
console.log(dbg.backtrace());                // refreshed on every stop
const end = await dbg.continue();            // { type: 'exited', code, signal }
```

| member | meaning |
| --- | --- |
| `new Debugger({ interpreter, address, listen, transport, quiet })` | `quiet` silences the text output; records still arrive through `on()` |
| `launch(program, args?, { run? })` | start and stop at entry (`run: true`: continue to the first stop or exit); returns the record |
| `break(spec, { condition?, temp? })`, `tbreak(spec)` | returns the breakpoint record, `null` if the location is unknown (`dbg.lastError` has the message) |
| `continue()` `next()` `step()` `finish()` `until(loc?)` | resume; resolve with the next `stopped` or `exited` record |
| `eval(expr)` | `{ value, text, type, exception? }`; throws if the program is not stopped |
| `backtrace()`, `locals(frame?)` | frames / variables of the last stop |
| `execute(line)` | run one command line as the REPL would; its `result` record goes to `on('result')` |
| `on(name, fn)` | `stopped`, `exited`, `output`, `result`; returns the unsubscribe function |
| `close()` | kill the debuggee |
| `exitCode` | exit status of the last run (128+N for a signal), `null` before |

`dbg.stack` stays the cached array of frames of the last stop (the GUI reads it), so the
refreshed list is `backtrace()`.

## Attaching to a program started elsewhere

```sh
# the debugger waits, the program connects out
qjsm-debugger -e --plain -x cmds.txt &
QUICKJS_DEBUG_ADDRESS=127.0.0.1:9901 qjsm script.js

# the program listens, the debugger connects
QUICKJS_DEBUG_LISTEN_ADDRESS=127.0.0.1:9901 qjsm script.js &
qjsm-debugger -e -c --plain -x cmds.txt
```

`-a HOST:PORT` picks another address. `-e` is implied when no script is given.
The program's own output goes to its terminal, not to the debugger.

## Tests

`test/run.sh [interpreter]` runs the batch cases in `test/cases`, the library test,
both attach directions, a DAP client (`test/dap-client.js`) and the server's JSON
WebSocket protocol (`test/server-client.py`, needs python3 `websockets`).
`UPDATE=1 test/run.sh` rewrites the expected outputs.
