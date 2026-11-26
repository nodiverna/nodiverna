// The classic agent troubleshooting component stays gone (removed, not wired back in): app/agent-installation.tsx
// does not exist, and no source, test support or doc under app/, ui/,
// lib/, tests/ or docs/ names the classic component. AgentTroubleshootingPage (ui/settings/troubleshooting.tsx)
// is the Agent troubleshooting page, and the console renders it for #settings/agent-troubleshooting; the
// console navigation test (tests/ui/shell/console-navigation.mjs) renders that route. The classic name is built
// from parts so this file does not match itself.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root=process.cwd();
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const classic=['Agent','Troubleshooting'].join('');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

check(fs.existsSync(path.join(root,'app/agent-installation.tsx')),false,'app/agent-installation.tsx is deleted');

// Every text file below the scanned folders; the bare name (not part of a longer identifier such as AgentTroubleshootingPage).
const textFile=/\.(?:ts|tsx|mjs|js|cjs|json|md|css)$/;
const skip=new Set(['node_modules','.next']);
const walk=dir=>fs.existsSync(dir)?fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>skip.has(entry.name)?[]:entry.isDirectory()?walk(path.join(dir,entry.name)):textFile.test(entry.name)?[path.join(dir,entry.name)]:[]):[];
const bare=new RegExp(`\\b${classic}\\b`);
// The two existing tests that assert the deletion name the component in their message or comment.
const allowed=new Map([
 ['tests/ui/devices/add-device-page.mjs',new RegExp(`'app/agent-installation\\.tsx \\(AgentInstallation and ${classic}\\) is deleted'`)],
 ['tests/ui/devices/agent-installation-download.mjs',new RegExp(`// .*The classic ${classic} and its file are deleted\\.`)],
]);
const found=[];
for(const file of ['app','ui','lib','tests','docs'].flatMap(dir=>walk(path.join(root,dir)))){
 const name=path.relative(root,file).replaceAll('\\','/');
 fs.readFileSync(file,'utf8').split('\n').forEach((line,index)=>{
  if(!bare.test(line))return;
  if(allowed.get(name)?.test(line))return;
  found.push(`${name}:${index+1}`);
 });
}
check(found,[],`no file under app/, ui/, lib/, tests/ or docs/ names ${classic} outside the deletion checks`);
ok([...allowed.keys()].every(file=>bare.test(read(file))),'the allowed occurrences still exist (the list stays current)');

// The Agent troubleshooting page is AgentTroubleshootingPage, rendered by the console for its agent tab.
ok(/export default function AgentTroubleshootingPage\(/.test(read('ui/settings/troubleshooting.tsx')),'ui/settings/troubleshooting.tsx exports AgentTroubleshootingPage');
const console_=read('ui/shell/console.tsx');
ok(console_.includes("import AgentTroubleshootingPage from '@/ui/settings/troubleshooting';")&&console_.includes("{agentTab==='agent-troubleshooting'&&page&&<AgentTroubleshootingPage"),'the console renders AgentTroubleshootingPage for #settings/agent-troubleshooting');

console.log(`PASS no classic troubleshooting (${checks} checks): app/agent-installation.tsx is gone, no file names the classic component outside the deletion checks, and the console renders AgentTroubleshootingPage.`);
