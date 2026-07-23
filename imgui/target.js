/* target.js — lifecycle of the debugged child process.
 *
 * Spawns the debuggee through /usr/bin/env so QUICKJS_DEBUG_ADDRESS reaches it
 * without involving a shell:
 *
 *     /usr/bin/env QUICKJS_DEBUG_ADDRESS=<host:port> qjsm <script> [args…]
 *
 * The interpreter defaults to `qjsm` (rsenn fork's module loader binary, built
 * with CONFIG_DEBUGGER). State polling is non-blocking and tolerant of the
 * exact ChildProcess surface the child_process binding exposes.
 */

import { spawn } from 'child_process';

export class DebugTarget {
  script;
  args;
  interpreter;
  envPath = '/usr/bin/env';
  address;

  state = 'not started'; /* 'not started' | 'launching' | 'running' | 'exited' | 'killed' | 'spawn failed' */
  child = null;
  pid = -1;
  exitCode = null;
  launches = 0;
  lastError = null;

  constructor({ script, args = [], interpreter = 'qjsm', address }) {
    this.script = script;
    this.args = args;
    this.interpreter = interpreter;
    this.address = address;
  }

  get cmdline() {
    return [this.envPath, `QUICKJS_DEBUG_ADDRESS=${this.address}`, this.interpreter, this.script, ...this.args];
  }

  get started() {
    return this.child !== null && (this.state === 'launching' || this.state === 'running');
  }

  start() {
    if(this.started) return false;

    const argv = this.cmdline;

    try {
      this.child = spawn(argv[0], argv.slice(1), { stdio: ['inherit', 'inherit', 'inherit'] });
      this.pid = this.child?.pid ?? -1;
      this.exitCode = null;
      this.state = 'launching';
      this.launches++;
      this.lastError = null;
      return true;
    } catch(e) {
      this.child = null;
      this.state = 'spawn failed';
      this.lastError = e.message;
      return false;
    }
  }

  /* mark as attached once the debug socket connects */
  attached() {
    if(this.state === 'launching') this.state = 'running';
  }

  /* non-blocking liveness poll; safe to call every frame */
  poll() {
    if(!this.child || (this.state !== 'running' && this.state !== 'launching')) return;

    try {
      if(typeof this.child.wait == 'function') {
        const WNOHANG = globalThis.WNOHANG ?? 1;
        const r = this.child.wait(WNOHANG);
        if(Array.isArray(r) && r[0] === this.pid) this.#exited(r[1]);
        else if(typeof r == 'number' && r === this.pid) this.#exited(this.child.exitcode ?? this.child.exitCode ?? 0);
      } else if(this.child.exitcode !== undefined && this.child.exitcode !== null) this.#exited(this.child.exitcode);
    } catch(e) {
      /* binding without WNOHANG semantics — rely on the protocol 'terminated' event */
    }
  }

  /* protocol said goodbye — trust it even if wait() is unavailable */
  terminated() {
    if(this.state === 'running' || this.state === 'launching') this.#exited(this.exitCode ?? 0);
  }

  #exited(code) {
    this.exitCode = code;
    this.state = 'exited';
    this.child = null;
  }

  kill(signo = 15) {
    if(!this.child) return false;
    try {
      this.child.kill?.(signo);
    } catch(e) {
      this.lastError = e.message;
    }
    this.state = 'killed';
    this.child = null;
    return true;
  }

  restart() {
    this.kill();
    return this.start();
  }

  info() {
    return {
      state: this.state,
      pid: this.pid > 0 ? String(this.pid) : '-',
      interpreter: this.interpreter,
      script: this.script,
      args: this.args.join(' ') || '-',
      'exit code': this.exitCode === null ? '-' : String(this.exitCode),
      launches: String(this.launches),
      env: `QUICKJS_DEBUG_ADDRESS=${this.address}`,
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }
}
