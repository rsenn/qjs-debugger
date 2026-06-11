# qjs-debugger — decoupled rewrite

Seven small modules, strict layering. Every class talks to its neighbors
through a minimal duck-typed contract, never through a concrete import of a
transport or server library (the only hard qjs-modules dependencies sit in
`engine-connection.js` and the two connectors, which is exactly where they
belong).

```
codec.js              framing only:   %08x\n + JSON + \n, byte-accurate incremental decoder
session.js            protocol only:  seqs, pending-request map w/ timeouts, events  (zero imports)
engine-connection.js  TCP <-> engine: AsyncSocket + FrameDecoder, spawn helper       (qjs only)
server-adapter.js     N clients <-> 1 engine: seq translation, event fan-out   (zero imports*)
connector-qjsnet.js   { onConnect, onMessage, onClose, onError } for qjs-net createServer()
connector-lws.js      { name, callback } protocol entry for qjs-lws LWSContext
client.js             DebugSession over any WebSocket-shaped transport     (browser + qjs)
```

## The three contracts

**Transport → DebugSession** (`session.js`): a session is constructed with a
`send(obj)` function and fed via `session.dispatch(obj)`. That's the whole
interface — which is why the same class backs the browser client, the REPL
client and the server adapter.

**ClientPort** (consumed by `server-adapter.js`): `{ sendMessage(obj),
close?() }`. Each connector wraps its native handle (qjs-net `ws`, lws `wsi`)
into one of these; the adapter never learns which server it's running in.

**EngineConnection** (consumed by `server-adapter.js`): `{ sendMessage(obj),
onmessage, onclose, close() }`. Want to debug over a serial line or a pipe
instead of TCP? Implement those four members and `attachEngine()` it.

## Seq spaces (the old design's collision, fixed by construction)

Engine-side seqs are owned exclusively by the adapter's internal
`DebugSession`. Client seqs never reach the engine: `clientMessage()` issues
the request through the session (fresh seq), then rewrites `request_seq`
back to the client's value on the response. The REPL on the server just uses
`adapter.session` directly — same seq space, no conflict possible.

## Wiring

### Server on qjs-net

```js
import { createServer } from 'net';
import { DebuggerServerAdapter } from './server-adapter.js';
import { QjsNetConnector } from './connector-qjsnet.js';
import { EngineConnection, StartEngine } from './engine-connection.js';

function main(...args) {
  const adapter = (globalThis.adapter = new DebuggerServerAdapter({ launch: StartEngine, connect: EngineConnection.connect }));

  createServer('wss://0.0.0.0:8998/ws', {
    mounts: [['/', '.', 'debugger.html']],
    ...QjsNetConnector(adapter),
  });

  /* server-side REPL drives the same engine with the same seq space: */
  globalThis.dbg = adapter; // adapter.session.next(), .evaluate(...), ...
}

main(...scriptArgs.slice(1));
```

### Server on qjs-lws

```js
import { LWSContext } from 'lws.so';
import { DebuggerServerAdapter } from './server-adapter.js';
import { LWSConnector } from './connector-lws.js';
import { EngineConnection, StartEngine } from './engine-connection.js';

function main(...args) {
  const adapter = new DebuggerServerAdapter({ launch: StartEngine, connect: EngineConnection.connect });

  const ctx = new LWSContext({
    port: 8998,
    vhostName: 'localhost',
    protocols: [LWSConnector(adapter, { name: 'debugger' })],
  });

  console.log('debugger listening on ws://localhost:8998 (protocol "debugger")');
}

main(...scriptArgs.slice(1));
```

One adapter = one debuggee shared by all clients. For one debuggee per
connection, pass a factory instead: `QjsNetConnector(ws => new
DebuggerServerAdapter())` (ditto for LWS).

### Browser client

```js
import { DebuggerClient } from './client.js';

const client = await DebuggerClient.connect('wss://' + location.host + '/ws');

client.on('stopped', ev => console.log('stopped:', ev.reason));

await client.start(['test-ecmascript2.js']);          // spawn via the server
await client.breakpoints('test-ecmascript2.js', [47]); // line numbers ok
const [event, stack] = await client.continueUntilStopped();
console.log(await client.variables([0, 1]));           // frame 0, locals
console.log(await client.evaluate('x + y'));
await client.next();
```

### QuickJS REPL client — via the WebSocket server

```js
import { WebSocketClient } from './lib/async/websocket.js';
import { DebuggerClient } from './client.js';

const client = await DebuggerClient.connect('wss://localhost:8998/ws', { WebSocket: WebSocketClient });
```

### QuickJS REPL client — straight to the engine, no server

```js
import { EngineConnection, StartEngine } from './engine-connection.js';

const { address } = StartEngine(['myscript.js'], '127.0.0.1:9901');
const conn = await EngineConnection.connect(address);
const session = conn.attachSession();

await session.stopOnException();
const [event, stack] = await session.next();
console.log(stack[0]);
```

Identical API in all four shapes, because it's the same `DebugSession`
underneath every time.

## Notes / assumptions to verify against your tree

- `engine-connection.js` imports `spawn` from `'child_process'` with a
  node-ish `(file, args, { env, stdio })` signature; if your binding's spawn
  differs, inject your own via `StartEngine(args, addr, { spawn: mySpawn })` —
  it was made injectable for exactly this reason.
- `connector-lws.js` defaults LWS_CALLBACK_{ESTABLISHED,CLOSED,RECEIVE} to
  0/1/6; pass `{ reasons: { ... } }` with the real imported constants if your
  build exposes them, and `isFinal(wsi)` if you have fragment finality.
- The `success:false` rejection path in `session.js` assumes the
  quickjs-debugger.c patch from earlier (error responses for unknown
  commands); without it, unknown commands fall back to the timeout instead
  of an immediate rejection — degraded, not broken.
- Stdout/stderr forwarding of the spawned engine to clients (the old
  server's `forward()`), the meriyah AST/function-list machinery, and the
  REPL pretty-printing decorators were intentionally left out of the core;
  they layer cleanly on top (`adapter.child.stdio`, `adapter.broadcast()`)
  without touching any of these classes.
