// Where a path or command line may break (ui/devices/inventory/path-wrap.ts, Management → Autostart): only after "\",
// "/" or a space, never inside a file name, and without losing characters. No browser, no server.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
const {pathBreakParts}=await import('../../../ui/devices/inventory/path-wrap.ts');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};

const command='C:\\Program Files\\ServerDesk\\ServerDesk.Agent.exe --run';
const parts=pathBreakParts(command);
check(parts.join(''),command,'joining the parts gives the input back');
check(parts,['C:\\','Program ','Files\\','ServerDesk\\','ServerDesk.Agent.exe ','--run'],'breaks after backslashes and spaces');
check(parts.filter(part=>part.includes('ServerDesk.Agent.exe')).length,1,'"ServerDesk.Agent.exe" stays in one part');
check(pathBreakParts('/usr/local/bin/agent'),['/','usr/','local/','bin/','agent'],'slashes split');
check(pathBreakParts('a b'),['a ','b'],'spaces split');
check(pathBreakParts(''),[''],'an empty text gives one empty part');
check(pathBreakParts('agent.exe'),['agent.exe'],'a file name alone stays whole');
for(const text of ['C:\\\\double','trailing\\','  two spaces','HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'])check(pathBreakParts(text).join(''),text,`no character is lost: ${text}`);

console.log(`PASS path wrap (${checks} checks): breaks only after separators and spaces, keeps file names whole and loses no character.`);
