// The new console is the only UI. The classic shell, its device
// workspace, its navigation and the switch between both consoles are gone, and
// nothing in the sources or tests still loads them. Reads files only.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

let checks=0;
const read=file=>fs.readFileSync(file,'utf8');

// 1. The classic-only modules are deleted.
const deleted=['app/dashboard.tsx','app/console-navigation.tsx','app/console-navigation.css','app/device-activity.tsx','app/fleet-sort-header.tsx','app/device-workspace.tsx','app/device-workspace.css','app/device-header.tsx','app/device-header.css','app/redesign/ui-preference.ts'];
for(const file of deleted){assert.equal(fs.existsSync(file),false,file+' is deleted');checks++;}

// 2. No source or test imports or loads one of them.
const deletedNames=new Set(['dashboard','console-navigation','device-activity','fleet-sort-header','device-workspace','device-header','ui-preference']);
const self=path.resolve('tests/ui/shell/single-console.mjs');
function walk(dir){
 const out=[];
 if(!fs.existsSync(dir))return out;
 for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
  if(entry.name==='node_modules'||entry.name.startsWith('.'))continue;
  const full=path.join(dir,entry.name);
  if(entry.isDirectory())out.push(...walk(full));else out.push(full);
 }
 return out;
}
const sources=['app','ui','lib','tests','scripts'].flatMap(walk).filter(file=>/\.(ts|tsx|mjs)$/.test(file)&&path.resolve(file)!==self);
assert.ok(sources.length>100,'the scan sees the source tree');checks++;
const moduleName=specifier=>path.posix.basename(specifier.replace(/\\/g,'/')).replace(/\.(tsx?|mjs|js|css)$/,'');
const quoted=String.raw`(['"\x60])([^'"\x60\r\n]+)\1`;
const patterns=[
 new RegExp(String.raw`\bfrom\s*`+quoted,'g'),                        // import … from '…', export … from '…'
 new RegExp(String.raw`\bimport\s*\(?\s*`+quoted,'g'),                 // import '…' and import('…')
 new RegExp(String.raw`\brequire\s*\(\s*`+quoted,'g'),
 new RegExp(String.raw`\b[A-Za-z_$][\w$]*\s*\(\s*`+quoted,'g'),       // load('app/…'), readFileSync('app/…'), harness('app/…')
 new RegExp(String.raw`\b(?:join|resolve)\s*\([^)]*?,\s*`+quoted,'g'), // path.join(root,'app/…')
];
const pathLike=value=>/^(\.{1,2}\/|@\/|app\/|components\/|lib\/)/.test(value);
const hits=[];
for(const file of sources){
 const text=read(file);
 patterns.forEach((pattern,index)=>{
  for(const match of text.matchAll(pattern)){
   const value=match[2];
   // Calls with any string argument are only module references when the argument is a path.
   if(index>=3&&!pathLike(value))continue;
   if(deletedNames.has(moduleName(value)))hits.push(`${path.relative('.',file)}: ${value}`);
  }
 });
}
assert.deepEqual(hits,[],'no file imports or loads a deleted classic module');checks++;

// 3. The switch is gone from the UI.
const appFiles=[...walk('app'),...walk('ui')];
for(const needle of ['switchConsoleFlavor','ConsoleFlavor','Klassische Oberfläche','Neue Oberfläche']){
 const found=appFiles.filter(file=>read(file).includes(needle)).map(file=>path.relative('.',file));
 assert.deepEqual(found,[],`no file under app/ contains ${needle}`);checks++;
}
const shell=read('ui/shell/shell.tsx'),consoleSource=read('ui/shell/console.tsx');
assert.doesNotMatch(shell,/onClassic|LayoutDashboard/,'the account menu has no classic entry and no unused icon');
assert.doesNotMatch(consoleSource,/action-classic|onClassic|LayoutDashboard/,'the palette has no classic action');checks+=2;

// 4. Every signed-in viewer gets the console, imported statically.
const entry=read('ui/session/identity-entry.tsx');
assert.match(entry,/\r?\nimport Console from '@\/ui\/shell\/console';\r?\n/,'static import of the console');
assert.match(entry,/<SessionGate key=\{viewer\.id\+':'\+viewer\.label\} viewer=\{viewer\} onSessionEnded=\{end=>sessionEnded\(viewer,end\)\}><Console viewer=\{viewer\}\/><\/SessionGate>/,'the console is the only child of the session gate, which hands an ended session back to the sign-in card');
assert.doesNotMatch(entry,/\blazy\b|\bSuspense\b|useConsoleFlavor/,'no lazy split and no flavor switch');checks+=3;

// 5. Confirmation lives in its own module.
assert.match(read('ui/base/confirmation.ts'),/^export type Confirmation=\{title:string;description:string;payload:Record<string,unknown>;confirmLabel:string;tone\?:'danger'\|'default';lines\?:ConfirmationLine\[\];uninstall\?:UninstallChoice;onSettled\?:\(outcome:ConfirmationOutcome\)=>void;endpoint\?:'\/api\/plugins'\|'\/api\/assistant'\|'\/api\/dhcp'\|'\/api\/dns';plugin\?:string;stepUpFirst\?:boolean;success\?:string\};$/m);checks++;
const formerImporters=['ui/devices/management/device-network-panel.tsx','ui/devices/device/device-removal.tsx','ui/devices/management/device-services.tsx','ui/devices/management/device-system.tsx','ui/devices/management/device-updates.tsx','ui/devices/remote/rdp-panel.tsx','ui/devices/management/storage-panel.tsx','ui/shell/console.tsx','ui/devices/device/device.tsx','ui/devices/fleet/fleet.tsx'];
for(const file of formerImporters)assert.match(read(file),/import type \{Confirmation\} from '@\/ui\/base\/confirmation';/,file+' imports Confirmation from ui/base/confirmation.ts');
assert.deepEqual(sources.filter(file=>/\bConfirmation\b[^;]*from\s*['"][^'"]*device-workspace['"]/.test(read(file))),[],'nobody imports Confirmation from device-workspace');checks+=2;

// 6. No lint exemption points to a deleted file.
const exempted=[...read('eslint.config.mjs').matchAll(/\bfile:\s*"([^"]+)"/g)].map(match=>match[1]);
assert.ok(exempted.length>0);assert.deepEqual(exempted.filter(file=>!fs.existsSync(file)),[],'every lint exemption names an existing file');checks+=2;

console.log(`PASS single console (${checks} assertions): classic shell, device workspace, navigation and the console switch are deleted, nothing loads them, Confirmation lives in ui/base/confirmation.ts.`);
