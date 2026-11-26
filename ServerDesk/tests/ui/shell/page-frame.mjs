// The page frame of the console (ui/shell/page-frame.ts): useFrameRefresh on fake hooks (no load on mount, one load per
// refresh change, the latest load, nothing without a frame), frameHeader, and source guards: every page component that
// renders the header calls it exactly once, settings-frame and headerPrimary are gone, and ui/shell/console.tsx keeps
// its lines short (400 characters per line, 240 inside the returned tree).
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import ts from 'typescript';

let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};

// Fake hooks: refs live in cells by call order; effects run after a render when their deps change (no deps: always).
function hookRuntime(){
 const cells=[];let cursor=0,queue=[];
 const changed=(old,deps)=>!old||!deps||deps.some((value,index)=>!Object.is(value,old[index]));
 const react={
  useRef(initial){const index=cursor++;cells[index]??={current:initial};return cells[index];},
  useEffect(effect,deps){const index=cursor++;if(changed(cells[index]?.deps,deps)){cells[index]={deps};queue.push(effect);}},
 };
 return {react,render(component){cursor=0;queue=[];component();for(const effect of queue)effect();}};
}
const runtime=hookRuntime();
const source=ts.transpileModule(fs.readFileSync('ui/shell/page-frame.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const frameModule={exports:{}};
new Function('require','module','exports',source)(id=>{if(id==='react')return runtime.react;throw Error('Unexpected import '+id);},frameModule,frameModule.exports);
const {frameHeader,useFrameRefresh}=frameModule.exports;

// useFrameRefresh: never on mount, once per refresh change, with the latest load.
{
 const loads=[];let frame={header:()=>null,refresh:3,tab:'',onTab(){}};let load=()=>loads.push('first');
 const Page=()=>useFrameRefresh(frame,load);
 runtime.render(Page);
 check(loads,[],'no load on mount');
 runtime.render(Page);
 check(loads,[],'a render without a refresh loads nothing');
 frame={...frame,refresh:4};runtime.render(Page);
 check(loads,['first'],'one load for one refresh');
 load=()=>loads.push('latest');frame={...frame,refresh:5};runtime.render(Page);
 check(loads,['first','latest'],'the latest load runs');
 runtime.render(Page);runtime.render(Page);
 check(loads,['first','latest'],'no second load for the same count');
}
{
 const fresh=hookRuntime(),mod={exports:{}};
 new Function('require','module','exports',source)(id=>{if(id==='react')return fresh.react;throw Error(id);},mod,mod.exports);
 let calls=0;const Page=()=>mod.exports.useFrameRefresh(undefined,()=>calls++);
 fresh.render(Page);fresh.render(Page);
 check(calls,0,'without a frame nothing loads');
}
// frameHeader: null without a frame, one header(primary) call with one.
{
 check(frameHeader(undefined,'primary'),null,'no frame, no header');
 const calls=[];const frame={header:primary=>{calls.push(primary);return 'header';},refresh:0,tab:'',onTab(){}};
 check([frameHeader(frame,'primary'),calls],['header',['primary']],'the header with the primary, called once');
 check([frameHeader(frame),calls.length,calls[1]],['header',2,undefined],'a page without a primary passes nothing');
}

// The file comment names the rules of the frame.
{
 const text=fs.readFileSync('ui/shell/page-frame.ts','utf8');
 for(const word of ['exactly once','every state','refresh','first tab','one\n// history entry','Back and Forward','no crumbs','area\n// crumb'])check(text.includes(word),true,'the page-frame comment says: '+word.replace(/\n\/\/ /g,' '));
 check(/export type PageFrame=\{[\s\S]*header:\(primary\?:ReactNode\)=>ReactNode;[\s\S]*refresh:number;[\s\S]*tab:string;[\s\S]*onTab:\(tab:string\)=>void;\s*\};/.test(text),true,'the PageFrame type');
}

// Every page component of the frame renders the header exactly once: frameHeader(frame…) or frame.header(…).
{
 const pages={
  'ui/settings/settings-accounts.tsx':'AccountsPage','ui/settings/settings-user-groups.tsx':'UserGroupsPage','ui/settings/settings-roles.tsx':'RolesPage','ui/settings/audit-log.tsx':'AuditLogPage','ui/settings/usage-data-page.tsx':'UsageDataPage','ui/settings/customers-panel.tsx':'CustomersPanel',
  'ui/settings/session-settings-panel.tsx':'SessionSettingsPanel','ui/settings/entra-settings-panel.tsx':'EntraSettingsPanel','ui/settings/maintenance-panel.tsx':'MaintenancePanel',
  'ui/settings/notifications-panel.tsx':'NotificationsPanel','ui/settings/vulnerabilities-panel.tsx':'VulnerabilitiesPanel','ui/settings/assistant-settings-panel.tsx':'AssistantSettingsPanel',
  'ui/settings/agent-releases-page.tsx':'AgentReleasesPage','ui/settings/troubleshooting.tsx':'AgentTroubleshootingPage','ui/automation/automation-workspace.tsx':'AutomationWorkspace','ui/account/account-panel.tsx':'AccountPanel',
 };
 for(const [file,component] of Object.entries(pages)){
  const text=fs.readFileSync(file,'utf8');
  check((text.match(/frameHeader\(frame\b|frame\.header\(/g)??[]).length,1,file+': one header call');
  check(new RegExp(`function ${component}\\(\\{[^}]*\\bframe\\b`).test(text),true,component+' takes frame');
 }
 // AccessWorkspace hands the frame to every section and renders the header itself only without permission.
 const access=fs.readFileSync('ui/settings/access-workspace.tsx','utf8');
 check((access.match(/frameHeader\(frame\)/g)??[]).length,1,'AccessWorkspace: one header call');
 check(/if\(!canOpenAccessSection\(viewer,section\)\)return <>\{frameHeader\(frame\)\}<SettingsPage /.test(access),true,'AccessWorkspace: the header in its no-permission branch, then one SettingsPage');
 for(const section of ['UsageDataPage','SessionSettingsPanel','EntraSettingsPanel','MaintenancePanel','NotificationsPanel','VulnerabilitiesPanel','AssistantSettingsPanel','CustomersPanel','AuditLogPage','AccountsPage','UserGroupsPage','RolesPage'])
  check(new RegExp(`<${section} [^>]*frame=\\{frame\\}`).test(access),true,'AccessWorkspace hands the frame to '+section);
}

// settings-frame is gone from app/ and tests/; no node flag says who owns the header.
{
 const self=path.resolve('tests/ui/shell/page-frame.mjs');
 const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(item=>{const full=path.join(dir,item.name);return item.isDirectory()?item.name==='node_modules'?[]:walk(full):[full];});
 check(fs.existsSync('app/settings-frame.ts'),false,'app/settings-frame.ts is gone');
 const hits=['app','ui','tests'].flatMap(walk).filter(file=>path.resolve(file)!==self&&/\.(tsx?|mjs|css)$/.test(file)&&/settings-frame|SettingsFrame/.test(fs.readFileSync(file,'utf8')));
 check(hits,[],'no file names settings-frame');
 check(/headerPrimary/.test(fs.readFileSync('ui/shell/nav-model.ts','utf8')),false,'nav-model.ts has no headerPrimary');
 check(/headerPrimary/.test(fs.readFileSync('ui/shell/console.tsx','utf8')),false,'the console reads no headerPrimary');
}

// console.tsx: no line over 400 characters, none over 240 inside the returned tree.
{
 const lines=fs.readFileSync('ui/shell/console.tsx','utf8').split('\n'),start=lines.findIndex(line=>line.startsWith(' return <div className="sd-console sdx"'));
 check(start>0,true,'the returned tree is found');
 check(lines.map((line,index)=>[index+1,line.length]).filter(([,length])=>length>400),[],'no line over 400 characters');
 check(lines.slice(start).map((line,index)=>[start+index+1,line.length]).filter(([,length])=>length>240),[],'no line over 240 characters in the returned tree');
 // Each view of main and each overlay starts on its own line.
 const tree=lines.slice(start);
 for(const opener of ["{view==='devices'&&<FleetView","{view==='device'&&(active?<DeviceView","{view==='automation'&&page&&<AutomationWorkspace","{view==='add-device'&&page&&<>","{agentTab==='agent-releases'&&page&&<AgentReleasesPage","{agentTab==='agent-troubleshooting'&&page&&<AgentTroubleshootingPage","{accessSection&&page&&<div className=\"sdx-embedded\">","{view==='account'&&<AccountPanel",
  '<JobDetailDrawer ','<GroupCreateDrawer ','<GroupDeleteDrawer ','{renameServer&&<DeviceNameDrawer ','{offboardingIds.length>0&&<OffboardingDrawer ','<ConfirmDialog ','<MfaStepUp '])
  check(tree.filter(line=>line.trimStart().startsWith(opener)).length,1,'one line opens '+opener);
}

console.log(`PASS page frame (${checks} checks): useFrameRefresh and frameHeader, the frame comment, one header call per page component, AccessWorkspace hands the frame on, no settings-frame and no headerPrimary, and the short console lines.`);
