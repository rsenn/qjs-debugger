/**
 * vscode-dap.js — DAPAdapter: translates the quickjs wire protocol to the
 * VS Code Debug Adapter Protocol (DAP) and back.
 *
 * Per protocol.md, most DAP requests (evaluate, stackTrace, scopes,
 * variables, continue, pause, next, stepIn, stepOut) are already
 * DAP-shaped on the wire — the engine speaks them natively. This module
 * only bridges the parts that differ: the request/response/event
 * envelope (DAP's flat {seq, type, command, arguments} vs the wire's
 * {type, request:{request_seq, command, args}}), commands the engine
 * doesn't have (initialize, launch/attach, threads, completions,
 * setBreakpoints/setExceptionBreakpoints), and event shape (scopes'
 * `reference` -> DAP's `variablesReference`, stackTrace's bare array of
 * {id,name,filename,line} -> `{stackFrames: [{..., source}], totalFrames}`).
 *
 * Transport-agnostic: consumes/produces plain DAP JSON objects, no
 * Content-Length framing, no stdio, no process spawning. Wire it up to
 * whatever carries DAP messages (vscode-debugadapter's stdio loop, a
 * socket, a test harness) by injecting `send` and calling `dispatch()`
 * for each inbound DAP request — the same send/dispatch shape used by
 * DebugSession (session.js) for the wire side.
 *
 * One DAPAdapter == one DebugSession == one JSContext ("thread" in DAP
 * terms). Multiplexing several JSContexts into one DAP session (see
 * protocol.md, "Debugging Multiple JSContexts") is a policy question for
 * whoever owns several DAPAdapter instances — it does not belong here.
 */

export class DAPAdapter {
  #session;
  #send;
  #seq = 0;
  #threadId;

  /** Optional hooks; assign to handle launch/attach/configurationDone/disconnect/terminate. */
  onLaunch = async () => {};
  onAttach = async () => {};
  onConfigurationDone = async () => {};
  onDisconnect = async () => {};
  onTerminate = async () => {};

  /**
   * @param send      (dapMsg) => void — deliver one DAP message to the client
   * @param threadId  synthetic thread id reported to DAP (default 1)
   *
   * No DebugSession yet at construction time: DAP's 'initialize' request
   * (and its response) always precedes 'launch'/'attach', at which point
   * there is nothing to debug yet. Wire the session up from an onLaunch/
   * onAttach hook via attachSession() once it exists.
   */
  constructor(send, threadId = 1) {
    if(typeof send != 'function') throw new TypeError('DAPAdapter: send function required');
    this.#send = send;
    this.#threadId = threadId;
  }

  /** Wire (or rewire) the DebugSession once the engine connection is up. */
  attachSession(session) {
    this.#session = session;

    session.on('stopped', ev => {
      if(ev.reason != 'entry') this.event('stopped', { reason: ev.reason, threadId: this.#threadId, description: ev.description, text: ev.text });
    });
    session.on('terminated', () => this.event('terminated', {}));
    session.on('aborted', () => this.event('terminated', {}));
    return this;
  }

  #requireSession() {
    if(!this.#session) throw new Error('DAPAdapter: no active debug session (launch/attach first)');
    return this.#session;
  }

  event(event, body) {
    this.#send({ seq: ++this.#seq, type: 'event', event, body });
  }

  response(request, body) {
    this.#send({ seq: ++this.#seq, type: 'response', request_seq: request.seq, success: true, command: request.command, body });
  }

  errorResponse(request, message) {
    this.#send({ seq: ++this.#seq, type: 'response', request_seq: request.seq, success: false, command: request.command, message });
  }

  /** commands the engine already speaks natively — forward the arguments as-is, body as-is */
  async #forward(request, args) {
    const { body } = await this.#requireSession().request(request.command, args);
    this.response(request, body);
  }

  /** Entry point for every incoming DAP request. */
  async dispatch(request) {
    if(request.type != 'request') return;
    const args = request.arguments ?? {};

    try {
      switch (request.command) {
        case 'initialize':
          this.response(request, {
            supportsEvaluateForHovers: true,
            supportsConfigurationDoneRequest: true,
            supportsCompletionsRequest: true,
            completionTriggerCharacters: ['.', '['],
            supportsTerminateRequest: true,
            exceptionBreakpointFilters: [{ filter: 'exceptions', label: 'All Exceptions' }],
          });
          this.event('initialized', {});
          break;

        case 'launch':
          await this.onLaunch(args);
          this.response(request, {});
          break;

        case 'attach':
          await this.onAttach(args);
          this.response(request, {});
          break;

        case 'configurationDone':
          this.response(request, {});
          await this.onConfigurationDone(args);
          break;

        case 'disconnect':
          await this.onDisconnect(args);
          this.response(request, {});
          break;

        case 'terminate':
          await this.onTerminate(args);
          this.response(request, {});
          break;

        case 'threads':
          this.response(request, { threads: [{ id: this.#threadId, name: 'main' }] });
          break;

        case 'setBreakpoints': {
          const path = args.source?.path;
          const breakpoints = (args.breakpoints ?? []).map(b => ({ line: b.line, column: b.column }));
          if(path) await this.#requireSession().breakpoints(path, breakpoints);
          this.response(request, { breakpoints: breakpoints.map(b => ({ ...b, verified: true })) });
          break;
        }

        case 'setExceptionBreakpoints':
          await this.#requireSession().stopOnException((args.filters ?? []).length > 0);
          this.response(request, {});
          break;

        case 'stackTrace': {
          const frames = (await this.#requireSession().request('stackTrace', args)).body;
          this.response(request, {
            stackFrames: frames.map(({ id, name, filename, line, column }) => ({
              id,
              name,
              line,
              column: column || 0,
              source: filename ? { name: filename.slice(filename.lastIndexOf('/') + 1), path: filename } : undefined,
            })),
            totalFrames: frames.length,
          });
          break;
        }

        case 'scopes': {
          const scopes = (await this.#requireSession().request('scopes', args)).body;
          this.response(request, {
            scopes: scopes.map(({ name, reference, expensive }) => ({ name, variablesReference: reference, expensive: !!expensive })),
          });
          break;
        }

        case 'variables':
          this.response(request, { variables: (await this.#requireSession().request('variables', args)).body });
          break;

        case 'completions': {
          const expression = args.text.slice(0, -1);
          if(!expression) {
            this.errorResponse(request, 'no completion available for empty string');
            break;
          }
          const session = this.#requireSession();
          const value = (await session.request('evaluate', { frameId: args.frameId, expression })).body;
          if(!value.variablesReference || value.indexedVariables !== undefined) {
            this.errorResponse(request, 'no completion available');
            break;
          }
          const variables = (await session.request('variables', { variablesReference: value.variablesReference })).body;
          this.response(request, { targets: variables.map(v => ({ label: v.name, type: 'field' })) });
          break;
        }

        /* already DAP-shaped on the wire (see protocol.md) — pure passthrough */
        case 'evaluate':
        case 'continue':
        case 'pause':
        case 'next':
        case 'stepIn':
        case 'stepOut':
          await this.#forward(request, args);
          break;

        default:
          this.errorResponse(request, `unsupported request '${request.command}'`);
      }
    } catch(e) {
      this.errorResponse(request, e.message);
    }
  }
}

Object.assign(DAPAdapter.prototype, { [Symbol.toStringTag]: 'DAPAdapter' });

//export default DAPAdapter;
