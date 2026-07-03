import { createServer } from 'net';
import { DebuggerServerAdapter } from '../server-adapter.js';
import { QjsNetConnector } from '../connector-qjsnet.js';
import { EngineConnection, StartEngine } from '../engine-connection.js';

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
