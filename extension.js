/**
 * extension.js — VS Code extension entry point.
 *
 * Registers the "qjs" debug type's adapter as an external process: for
 * every debug session VS Code starts, spawn
 *
 *     <runtimeExecutable> <this dir>/qjs-debugger.js -m dap
 *
 * and talk DAP to it over stdio. qjs-debugger.js itself (see StartDAP() /
 * vscode-dap.js) speaks the DAP session — this file only tells VS Code how
 * to start that process; it owns no debugging logic of its own.
 */

const vscode = require('vscode');
const path = require('path');

const QJS_DEBUGGER = path.join(__dirname, 'qjs-debugger.js');

class QjsDebugAdapterDescriptorFactory {
  createDebugAdapterDescriptor(session) {
    const runtimeExecutable = session.configuration.runtimeExecutable || 'qjsm';
    return new vscode.DebugAdapterExecutable(runtimeExecutable, [QJS_DEBUGGER, '-m', 'dap']);
  }
}

function activate(context) {
  context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('qjs', new QjsDebugAdapterDescriptorFactory()));
}

function deactivate() {}

module.exports = { activate, deactivate };
