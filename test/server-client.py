#!/usr/bin/env python3
"""server-client.py: drives `qjs-debugger -m server` over its JSON WebSocket protocol.

    python3 test/server-client.py [interpreter] [port]

Starts the server on test/cases/f.js, connects with the 'debugger'
subprotocol (one JSON document per frame), sets a breakpoint on line 3,
continues to it, evaluates `a + b` and lets the program finish.
Exit status 0 when every check passed.
"""
import asyncio, json, os, subprocess, sys

import websockets

here = os.path.dirname(os.path.abspath(__file__))
interpreter = sys.argv[1] if len(sys.argv) > 1 else 'qjsm'
port = int(sys.argv[2]) if len(sys.argv) > 2 else 8997
program = os.path.join(here, 'cases', 'f.js')
failures = 0
seq = 0
backlog = []  # events that arrived while a response was awaited


def check(what, ok, detail=''):
    global failures
    print(('ok   ' if ok else 'FAIL ') + what + ('' if ok else ' ' + str(detail)))
    failures += 0 if ok else 1


async def event(ws, kind, timeout=20):
    """next engine event of type `kind` (others are skipped)"""
    for i, ev in enumerate(backlog):
        if ev['type'] == kind:
            return backlog.pop(i)
    while True:
        msg = json.loads(await asyncio.wait_for(ws.recv(), timeout))
        if msg.get('type') == 'event':
            if msg['event']['type'] == kind:
                return msg['event']
            backlog.append(msg['event'])


async def request(ws, command, args=None, timeout=20):
    global seq
    seq += 1
    await ws.send(json.dumps({'type': 'request', 'request': {'request_seq': seq, 'command': command, 'args': args or {}}}))
    while True:
        msg = json.loads(await asyncio.wait_for(ws.recv(), timeout))
        if msg.get('type') == 'response' and msg.get('request_seq') == seq:
            return msg
        if msg.get('type') == 'event':
            backlog.append(msg['event'])


async def main():
    server = subprocess.Popen(
        ['qjsm', os.path.join(here, '..', 'qjs-debugger.js'), '-m', 'server', '-p', str(port), '-i', interpreter, program],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(50):
            try:
                ws = await websockets.connect(f'ws://127.0.0.1:{port}/', subprotocols=['debugger'])
                break
            except OSError:
                await asyncio.sleep(0.2)
        else:
            check('connect', False)
            return

        async with ws:
            check('connect', True)
            # the engine may already be parked at its entry stop; either way
            # setting breakpoints and continuing is valid from there
            await ws.send(json.dumps({'type': 'breakpoints', 'breakpoints': {'path': program, 'breakpoints': [{'line': 3}]}}))
            await request(ws, 'continue')
            stop = await event(ws, 'StoppedEvent')
            check('stopped on breakpoint', stop.get('reason') == 'breakpoint', stop)

            stack = (await request(ws, 'stackTrace'))['body']
            check('stackTrace line 3 in f', stack[0]['line'] == 3 and stack[0]['name'] == 'f', stack[:1])

            ev = (await request(ws, 'evaluate', {'expression': 'a + b', 'frameId': 0}))['body']
            check('evaluate a + b', ev.get('result') == '60', ev)

            await request(ws, 'continue')
            await event(ws, 'terminated')
            check('terminated', True)
    finally:
        server.kill()
        server.wait()


try:
    asyncio.run(main())
except Exception as e:  # noqa: BLE001
    check('session', False, repr(e))
sys.exit(1 if failures else 0)
