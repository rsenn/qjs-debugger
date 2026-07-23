#!/usr/bin/env qjsm
/* poc.js — smallest thing that proves text renders AND live debug state updates.
 *
 * Nothing fancy: one plain window, only ImGui.Text lines. Spawns the target
 * script, and auto-steps every 500 ms so the "state" and "frame" lines
 * visibly change in real time. No theme, no columns, no input widgets.
 *
 *   qjsm poc.js <script.js>
 */

import * as glfw from 'glfw';
import * as ImGui from 'imgui';
// import * as path from 'path';
// import { TcpServerTransport } from './transport.js';
// import { DebuggerSession } from './debugger-client.js';
// import { DebugTarget } from './target.js';

console.log('argv:', JSON.stringify(globalThis.scriptArgs));
const script = globalThis.scriptArgs?.[1];
if(!script) {
  console.log('usage: qjsm poc.js <script.js>');
  throw new Error('no script');
}
console.log('script:', script);

let msgLog = []; /* newest first, keep last 12 */
const log = m => {
  msgLog.unshift(m);
  if(msgLog.length > 12) msgLog.length = 12;
};

/* No context hints: same combo minimal.js used successfully. */

console.log('creating window…');
const win = new glfw.Window(720, 520, 'qjs-debugger POC');
console.log('makeContextCurrent…');
win.makeContextCurrent();
glfw.context.swapInterval(1);

console.log('ImGui.Init…');
ImGui.Init(ImGui.ImplGlfw, ImGui.ImplOpenGL3);
console.log('ImGui.CreateContext…');
ImGui.CreateContext(win, true, '#version 130');
console.log('StyleColorsDark…');
ImGui.StyleColorsDark();

/* Step 1: prove text renders with NO transport/target objects at all. */
log('POC step 1: no debug target yet');

console.log('entering loop…');

let lastStep = 0;
const stepEvery = 500; /* ms */

let frame = 0;
while(!win.shouldClose) {
  frame++;
  if(frame <= 3) console.log(`frame ${frame}: glfw.poll…`);
  glfw.poll();

  const now = Date.now();
  if(frame <= 3) console.log(`frame ${frame}: NewFrame…`);
  ImGui.NewFrame();
  ImGui.Begin('debugger POC');

  ImGui.Text('script:  %s', script);
  ImGui.Text('frame:   %d', frame);
  ImGui.Text('now:     %d', now);
  ImGui.Text(' ');
  ImGui.Text('recent events:');
  for(const m of msgLog) ImGui.Text('  %s', m);

  ImGui.End();
  if(frame <= 3) console.log(`frame ${frame}: Render…`);
  ImGui.Render();
  if(frame <= 3) console.log(`frame ${frame}: RenderDrawData…`);
  ImGui.RenderDrawData(ImGui.GetDrawData());
  if(frame <= 3) console.log(`frame ${frame}: swapBuffers…`);
  win.swapBuffers();
  if(frame <= 3) console.log(`frame ${frame}: done`);
}

ImGui.ImplOpenGL3.Shutdown();
ImGui.ImplGlfw.Shutdown();
ImGui.DestroyContext();
