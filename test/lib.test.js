/* lib.test.js: drives the Debugger class as a library (no text parsing).
 *
 * ```sh
 * qjsm test/lib.test.js [interpreter]
 * ```
 */
import { dirname, join } from 'path';
import { exit } from 'std';
import process from 'process';
import { Debugger } from '../debugger.js';

const here = dirname(process.argv[1]);
const dbg = new Debugger({ interpreter: process.argv[2] ?? 'qjsm', quiet: true });
let failures = 0;
const check = (what, ok, detail = '') => ok || (failures++, console.log(`FAIL ${what} ${detail}`));

const events = [];
dbg.on('stopped', s => events.push(s.reason));
let output = '';
dbg.on('output', o => (output += o.data));

const program = join(here, 'cases', 'f.js');
let stop = await dbg.launch(program);
check('launch stops at entry', stop.type == 'stopped' && stop.reason == 'entry', JSON.stringify(stop));

const bp = dbg.break(`${program}:3`);
check('break returns the breakpoint', bp?.num == 1 && bp.line == 3, JSON.stringify(bp));
check('break unknown function', dbg.break('nosuch') === null && dbg.lastError !== null);

stop = await dbg.continue();
check('continue stops at the breakpoint', stop.reason == 'breakpoint' && stop.line == 3 && stop.breakpoint == 1, JSON.stringify(stop));
check('stop carries locals', stop.locals?.some(v => v.name == 'a' && v.value == '20'), JSON.stringify(stop.locals));
check('stop carries the stack', stop.stack?.[0]?.function == 'f' && stop.stack.length == 2, JSON.stringify(stop.stack));

const a = await dbg.eval('a * 2');
check('eval is typed', a.value === 40 && a.type == 'integer', JSON.stringify(a));
await dbg.eval('b = 7');
check('eval assigns', (await dbg.eval('b')).value === 7);
check('backtrace', dbg.backtrace()[1].line == 5);

stop = await dbg.step();
check('step reports reason step', stop.reason == 'step', JSON.stringify(stop));

stop = await dbg.continue();
check('continue to the end', stop.type == 'exited' && stop.code == 0, JSON.stringify(stop));
check('output captured', output == '8\n', JSON.stringify(output));
check('events seen', events.join() == 'entry,breakpoint,step', events.join());

stop = await dbg.launch(join(here, 'cases', 'exit3.js'), [], { run: true });
check('exit code', stop.type == 'exited' && stop.code == 3 && dbg.exitCode == 3, JSON.stringify(stop));

console.log(failures ? `${failures} library check(s) failed` : 'library ok');
exit(failures ? 1 : 0);
