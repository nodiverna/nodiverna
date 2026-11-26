// Exercise the actual diagnostics views, loading states and handlers against current rights/inventory.
// The panels of ui/devices/diagnostics/diagnostics-panels.tsx run with deterministic hook cells (their hooks only); the kit
// parts they render (DataTable, ConfirmDialog, Drawer, Menu, Notice, Skeleton) render with React SSR.
// Radix portals render in place, so open drawers, dialogs and menus show in the markup.
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import ts from 'typescript';
import React from 'react';
import * as radix from 'radix-ui';
import {renderToStaticMarkup} from 'react-dom/server';
import {i18nRequire} from '../../support/i18n-stubs.mjs';
const require=createRequire(import.meta.url),cache=new Map(),root=process.cwd();
const panelsFile=path.resolve('ui/devices/diagnostics/diagnostics-panels.tsx');
let states=new Map(),refs=new Map(),stateIndex=0,refIndex=0,submissions=[],downloads=[],toasts=[],loads=0,nextSubmission='submitted-1',effects=[];
const react={...React,useState(initial){const index=stateIndex++;if(!states.has(index))states.set(index,typeof initial==='function'?initial():initial);return [states.get(index),next=>states.set(index,typeof next==='function'?next(states.get(index)):next)];},useRef(initial){const index=refIndex++;if(!refs.has(index))refs.set(index,{current:initial});return refs.get(index);},useEffect(callback,dependencies){effects.push({callback,dependencies});},useCallback(callback){return callback;},useMemo(callback){return callback();}};
const inline=({children})=>children;
const radixInline={...radix,Dialog:{...radix.Dialog,Portal:inline},AlertDialog:{...radix.AlertDialog,Portal:inline},DropdownMenu:{...radix.DropdownMenu,Portal:inline}};
const toast={success:text=>toasts.push(text),error:text=>toasts.push('error:'+text),info:text=>toasts.push('info:'+text)};
function load(filename){
  const absolute=path.resolve(filename);if(cache.has(absolute))return cache.get(absolute).exports;if(absolute.endsWith('.css'))return {};
  const mod={exports:{}};cache.set(absolute,mod);
  const code=ts.transpileModule(fs.readFileSync(absolute,'utf8'),{fileName:absolute,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
  function localRequire(id){const i18nStub=i18nRequire(id);if(i18nStub)return i18nStub;
    // Only the panels run on the hook cells; the kit renders with React itself.
    if(id==='react')return absolute===panelsFile?react:React;
    if(id==='radix-ui')return radixInline;
    if(id==='sonner')return {toast};
    if(id==='@/ui/session/mfa-step-up')return {MfaStepUp:({open,children,...props})=>open?React.createElement('aside',{'data-mfa':'true',...props},children):null};
    if(id==='@/ui/base/api')return {...load('ui/base/api.tsx'),downloadText:(...args)=>downloads.push(args)};
    // A plain JavaScript module of runtime/ (for example runtime/release-version.mjs) loads as itself.
    if(id.startsWith('.')&&id.endsWith('.mjs'))return require(path.resolve(path.dirname(absolute),id));
    if(id.startsWith('.')||id.startsWith('@/')){const base=id.startsWith('@/')?path.join(root,id.slice(2)):path.resolve(path.dirname(absolute),id),file=[base,base+'.ts',base+'.tsx',base+'.js'].find(candidate=>fs.existsSync(candidate)&&fs.statSync(candidate).isFile());if(file)return load(file);}
    return require(id);
  }
  new Function('require','module','exports',code)(localRequire,mod,mod.exports);return mod.exports;
}
const {ProcessPanel,SessionPanel,ConnectionsPanel,EventPanel}=load('ui/devices/diagnostics/diagnostics-panels.tsx');
const {createDiagnosisClient}=load('ui/devices/diagnostics/diagnosis-client.ts');
const {sortProcesses}=load('ui/devices/diagnostics/process-view.ts');
const at=Date.now(),oldNow=Date.now;Date.now=()=>at;
// datetime-local values in the test's time zone; two hours apart so "Von" stays after "Bis" even across a DST fall-back.
const localInput=ms=>{const date=new Date(ms),pad=value=>String(value).padStart(2,'0');return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;};
const viewer={id:'owner',label:'Owner',permissions:['*']};
const capabilities=['list-processes','kill-process','query-events','export-events','support-bundle'];
const server={id:'device',name:'WIN-TEST',management:1,lastSeen:at-1000,revoked:0,snapshot:{protocolVersion:3,mode:'Management',agentCapabilities:capabilities}};
const props={viewer,demo:false,server};
const job=(kind,data={},changes={})=>({id:kind,kind,state:'succeeded',createdAt:at,claimedAt:null,result:null,data:{kind,at:new Date(at).toISOString(),data},...changes});
// Hook cells of useDiagnosis: 0 data, 1 failure, 2 request state; ref 0 the client, ref 1 the scope. EventPanel's queries are cell 3.
const QUERIES=3;
function reset({jobs=[],loaded=true,loading=false,error='',source=error?'query':null,kind,params,busyKind=null,submitted=null,autoStarted=true,autoPreparing=false}={}){
  states=new Map([[0,{serverId:'device',jobs,loaded}],[1,{serverId:'device',error,source,kind,params}],[2,{serverId:'device',loading,busyKind,autoStarted,autoPreparing,submitted}]]);refs=new Map();submissions=[];downloads=[];toasts=[];loads=0;nextSubmission='submitted-1';
  refs.set(0,{current:{serverId:'device',value:{submit:async(kind,params,confirm)=>{submissions.push({kind,params,confirm});return nextSubmission;},load:async()=>{loads++;return null;},automatic:async()=>null}}});
}
function tree(Panel,overrides={}){stateIndex=0;refIndex=0;effects=[];return Panel({...props,...overrides});}
const isElement=value=>!!value&&typeof value==='object'&&'type' in value&&'props' in value;
// Every element of the panel tree: children and element props (toolbar, actions, foot, footer, action, empty.action), and the cells of every DataTable row.
function walk(node,result=[]){
  if(Array.isArray(node)){for(const item of node)walk(item,result);return result;}
  if(!isElement(node))return result;
  result.push(node);
  for(const [key,value] of Object.entries(node.props)){
    if(key==='columns'||key==='rows')continue;
    if(isElement(value)||Array.isArray(value))walk(value,result);
    else if(key==='empty'&&value)walk(value.action,result);
  }
  if(Array.isArray(node.props.columns)&&Array.isArray(node.props.rows))for(const row of node.props.rows)for(const column of node.props.columns)walk(column.cell(row),result);
  return result;
}
const text=element=>walk(element).flatMap(item=>React.Children.toArray(item.props.children).filter(child=>typeof child==='string'||typeof child==='number')).join(' ');
const find=(element,predicate)=>walk(element).find(predicate);
// The control with this aria-label, else the kit part with this label prop (IconBtn, Menu).
/** "End process" of a row: the kill entry of its row Menu ("Aktionen für …"), pressed like a button. */
const endProcess=(element,name)=>{const entry=labelled(element,'Aktionen für '+name)?.props.entries.find(item=>item.id==='kill');return entry&&{props:{onClick:entry.onSelect,blocked:entry.blocked}};};
const labelled=(element,label)=>find(element,item=>item.props['aria-label']===label)??find(element,item=>item.props.label===label&&!Array.isArray(item.props.columns));
const clickButton=(element,label)=>find(element,item=>item.props.onClick&&text(item).trim()===label);
const table=(element,label)=>find(element,item=>Array.isArray(item.props.columns)&&(label===undefined||item.props.label===label));
const search=element=>find(element,item=>item.props.search)?.props.search;
const confirmDialog=element=>find(element,item=>typeof item.props.onConfirm==='function'&&'confirmLabel' in item.props);
const menuEntries=element=>find(element,item=>Array.isArray(item.props.entries))?.props.entries;
const entry=(element,id)=>menuEntries(element)?.find(item=>item.id===id);
const queryForm=element=>find(element,item=>item.type==='form'&&item.props.className==='sdx-dx-event-query');
const submitQuery=element=>queryForm(element).props.onSubmit({preventDefault(){}});
const queryButton=element=>find(element,item=>item.props.type==='submit'&&text(item).trim()==='Abfragen');
const html=(Panel,overrides={})=>renderToStaticMarkup(tree(Panel,overrides));
const rowsShown=markup=>(markup.match(/aria-label="Details zu proc/g)||[]).length;
const flush=async()=>{for(let index=0;index<8;index++)await Promise.resolve();};

// Assertions below intentionally use rendered UI and the actual callbacks.
// First loads use the kit Skeleton (table) with a label, not an empty result.
reset({loaded:false,loading:true});let markup=html(ProcessPanel);
assert.match(markup,/class="sdx-skeleton-set sdx-skeleton-table" role="status" aria-label="Prozesse werden geladen…"/);assert.ok(!markup.includes('Keine Prozesse im Ergebnis'));
reset({loaded:false,loading:true});markup=html(EventPanel);assert.match(markup,/sdx-skeleton-table" role="status" aria-label="Ereignisse werden geladen…"/);assert.ok(!markup.includes('Keine Ereignisse für diese Abfrage'));
assert.ok(!fs.readFileSync('ui/devices/diagnostics/diagnostics-panels.tsx','utf8').includes('sd-diagnosis-loading'),'the spinner block is gone');
reset();markup=html(EventPanel);assert.match(markup,/Protokoll auswählen/);assert.match(markup,/Wähle eine Vorlage oder setze eigene Filter, und starte die Abfrage\./);assert.equal(submissions.length,0,'opening event viewer does not fetch unrequested host data');

const processes=Array.from({length:60},(_,index)=>({name:`proc${String(index).padStart(3,'0')}.exe`,pid:1000+index,parentPid:index>50?1050:4,sessionId:index%2,user:index%2?'DOMAIN\\Niko':'NT AUTHORITY\\SYSTEM',path:`C:\\Apps\\proc${index}.exe`,cpuPercent:index===3?null:index,memoryMb:index*2+10,startedAt:new Date(at-3600000-index*1000).toISOString(),protected:index===0?true:index===1?undefined:false}));
const processServer={...server,snapshot:{...server.snapshot,processes,processInventory:{collectedAt:new Date(at).toISOString(),count:60,truncated:false,complete:true,intervalSeconds:30}}};
const processProps={server:processServer};
// The DataTable "Prozesse", sorted by CPU, 25 rows per page, the kit Pagination.
reset();markup=html(ProcessPanel,processProps);assert.match(markup,/60 Prozesse erfasst/);assert.match(markup,/role="region" aria-label="Prozesse"/);assert.match(markup,/1–25 von 60/);assert.match(markup,/60 von 60 Prozessen/);assert.equal(rowsShown(markup),25);assert.match(markup,/proc059.exe/);assert.ok(!markup.includes('proc003.exe'),'descending CPU view leaves unknown measurements last');
assert.ok(!markup.includes('sd-dx-chips')&&!markup.includes('sd-dx-sort'),'no chip filter and no own sort buttons');
assert.match(markup,/role="switch"/,'the process tree is a switch');assert.match(markup,/<meter|role="meter"/,'CPU values carry a meter');
let element=tree(ProcessPanel,processProps);table(element,'Prozesse').props.pagination.onPage(2);markup=html(ProcessPanel,processProps);assert.match(markup,/26–50 von 60/);
element=tree(ProcessPanel,processProps);search(element).onChange('proc003');markup=html(ProcessPanel,processProps);assert.ok(!markup.includes('sdx-pagination'),'the search goes back to page 1, one page');assert.match(markup,/1 von 60 Prozessen/);assert.match(markup,/proc003.exe/);assert.ok(markup.includes('—'),'unknown CPU stays unknown');assert.equal(rowsShown(markup),1);
element=tree(ProcessPanel,processProps);search(element).onChange('');element=tree(ProcessPanel,processProps);table(element,'Prozesse').props.onSort({column:'pid',direction:'asc'});markup=html(ProcessPanel,processProps);assert.match(markup,/proc000.exe/);assert.match(markup,/aria-sort="ascending"/);
element=tree(ProcessPanel,processProps);labelled(element,'Prozessbenutzer').props.onChange({target:{value:'DOMAIN\\Niko'}});markup=html(ProcessPanel,processProps);assert.equal(rowsShown(markup),25);assert.match(markup,/1–25 von 30/);
element=tree(ProcessPanel,processProps);search(element).onChange('not-a-process');markup=html(ProcessPanel,processProps);assert.match(markup,/Keine Prozesse für diesen Filter/);assert.match(markup,/Filter zurücksetzen/);
element=tree(ProcessPanel,processProps);clickButton(element,'Filter zurücksetzen').props.onClick();markup=html(ProcessPanel,processProps);assert.equal(rowsShown(markup),25,'"Reset filters" brings every process back');
reset();element=tree(ProcessPanel,processProps);clickButton(element,'Details aktualisieren').props.onClick();await flush();assert.deepEqual(submissions,[{kind:'list-processes',params:{limit:1000,sampleMs:350},confirm:false}]);
// Memory in IEC bytes, no literal "MB".
reset();markup=html(ProcessPanel,{server:{...processServer,snapshot:{...processServer.snapshot,processes:[{...processes[5],memoryMb:512}]}}});assert.match(markup,/512\sMiB/);assert.ok(!/\d\sMB\b/.test(markup),'no literal MB');
// sortProcesses (ui/devices/diagnostics/process-view.ts): CPU desc with unmeasured values last, PID as the tie-break.
assert.deepEqual(sortProcesses([{pid:3,cpuPercent:null},{pid:2,cpuPercent:5},{pid:1,cpuPercent:5},{pid:4,cpuPercent:9}],{column:'cpu',direction:'desc'}).map(row=>row.pid),[4,1,2,3]);
assert.deepEqual(sortProcesses([{pid:3,cpuPercent:null},{pid:2,cpuPercent:5},{pid:4,cpuPercent:9}],{column:'cpu',direction:'asc'}).map(row=>row.pid),[2,4,3],'unmeasured stays last in both directions');
// Without an inventory the filter shows no counts and no "—".
reset();markup=html(ProcessPanel,{server:{...server,lastSeen:at-180000}});const segment=markup.slice(markup.indexOf('aria-label="Prozessfilter"'),markup.indexOf('</div>',markup.indexOf('aria-label="Prozessfilter"')));
assert.match(markup,/role="group" aria-label="Prozessfilter"/);assert.ok(segment&&!/<b[ >]/.test(segment)&&!segment.includes('—'),'no counts and no dash without an inventory');

function selectProcess(name='proc059.exe',overrides=processProps){const element=tree(ProcessPanel,overrides);endProcess(element,name).props.onClick();return tree(ProcessPanel,overrides);}
// End process confirms in the kit ConfirmDialog with the verb and the danger tone.
reset();element=selectProcess();let confirm=confirmDialog(element);assert.equal(confirm.props.open,true);assert.equal(confirm.props.confirmLabel,'Prozess beenden');assert.equal(confirm.props.tone,'danger');
assert.deepEqual(confirm.props.lines.map(line=>line.value),['proc059.exe','1059','WIN-TEST'],'lines: process, PID, device');assert.equal(confirm.props.blocked,undefined);
markup=renderToStaticMarkup(element);assert.match(markup,/role="alertdialog"/);assert.match(markup,/Prozess beenden\?/);
confirm.props.onConfirm();await flush();assert.deepEqual(submissions,[{kind:'kill-process',params:{pid:1059,startedAt:processes[59].startedAt,confirm:true},confirm:true}]);

// A retained confirmation cannot silently adopt a newly selected process.
reset();element=selectProcess();const retainedFirstProcess=confirmDialog(element);
element=selectProcess('proc058.exe');const currentSecondProcess=confirmDialog(element);
retainedFirstProcess.props.onConfirm();await flush();assert.equal(submissions.length,0,'old process A confirmation cannot terminate newly selected process B');
currentSecondProcess.props.onConfirm();await flush();assert.deepEqual(submissions,[{kind:'kill-process',params:{pid:1058,startedAt:processes[58].startedAt,confirm:true},confirm:true}],'current selected process B remains confirmable');

for(const overrides of [
 {server:{...processServer,management:0}},
 {server:{...processServer,snapshot:{...processServer.snapshot,mode:'ReadOnly'}}},
 {server:{...processServer,lastSeen:at-180000}},
 {server:{...processServer,revoked:1}},
 {server:{...processServer,snapshot:{...processServer.snapshot,agentCapabilities:['list-processes']}}},
 {viewer:{...viewer,permissions:[]},server:{...processServer,permissions:['diagnose']}},
 {demo:true},
 {server:{...processServer,id:'another-device'}},
 {server:{...processServer,snapshot:{...processServer.snapshot,processes:processes.map(row=>row.pid===1059?{...row,startedAt:new Date(at-2000).toISOString()}:row)}}},
 {server:{...processServer,snapshot:{...processServer.snapshot,processes:processes.map(row=>row.pid===1059?{...row,protected:true}:row)}}},
 {server:{...processServer,snapshot:{...processServer.snapshot,processInventory:{...processServer.snapshot.processInventory,collectedAt:new Date(at-180000).toISOString()}}}},
]){
 reset();element=selectProcess();const retained=confirmDialog(element);tree(ProcessPanel,{...processProps,...overrides});retained.props.onConfirm();await flush();assert.equal(submissions.length,0,'retained kill handler obeys current rights, mode, online state, identity and scope');
}
// The protected process: the row action stays visible and says why; a forced callback still submits nothing.
reset();element=tree(ProcessPanel,processProps);search(element).onChange('proc000');element=tree(ProcessPanel,processProps);const protectedEnd=endProcess(element,'proc000.exe');assert.equal(protectedEnd.props.blocked,'Geschützter Prozess');protectedEnd.props.onClick();element=tree(ProcessPanel,processProps);assert.equal(confirmDialog(element).props.open,false);confirmDialog(element).props.onConfirm();await flush();assert.equal(submissions.length,0,'protected process cannot reach submit even through stale/forced callback');
// The other blocked reasons of the row action.
reset();element=tree(ProcessPanel,{server:{...processServer,management:0}});assert.equal(endProcess(element,'proc059.exe').props.blocked,'Verwaltungsmodus und Verwaltungsberechtigungen erforderlich');
reset();element=tree(ProcessPanel,{server:{...processServer,lastSeen:at-180000}});assert.equal(endProcess(element,'proc059.exe').props.blocked,'Dafür muss das Gerät online sein.');
// A row opens the kit Drawer with the process facts; there is no "Details" button.
reset();element=tree(ProcessPanel,processProps);assert.ok(!clickButton(element,'Details'),'no Details button');table(element,'Prozesse').props.onOpen({row:processes[59],depth:0});markup=html(ProcessPanel,processProps);assert.match(markup,/role="dialog"/);assert.match(markup,/C:\\Apps\\proc59\.exe/);assert.match(markup,/<dl class="sdx-facts">/);

// The MFA challenge retries the selected process's exact identity, never a reused PID.
// The panel decides by the error code (opensMfaPrompt), never by the message text.
const {ApiError}=load('ui/base/api.tsx');
{
 reset();let first=true;
 refs.get(0).current.value.submit=async(kind,params,confirm)=>{submissions.push({kind,params,confirm});if(first){first=false;throw new ApiError('MFA-Bestätigung erforderlich',403);}return nextSubmission;};
 const selected=selectProcess();confirmDialog(selected).props.onConfirm();await flush();
 assert.equal(find(tree(ProcessPanel,processProps),item=>typeof item.props.onVerified==='function'),undefined,'an MFA message text without a code opens no challenge');
 // A failed action is a toast, not a panel notice.
 assert.deepEqual(toasts,['error:MFA-Bestätigung erforderlich'],'a rejected kill shows toast.error');assert.ok(!html(ProcessPanel,processProps).includes('sdx-notice-danger'),'and no danger notice');
}
async function challengedKill(){
 reset();let first=true;
 refs.get(0).current.value.submit=async(kind,params,confirm)=>{submissions.push({kind,params,confirm});if(first){first=false;throw new ApiError('Request refused.',403,'MFA_STEP_UP_REQUIRED');}return nextSubmission;};
 const selected=selectProcess();confirmDialog(selected).props.onConfirm();await flush();
 const challenged=tree(ProcessPanel,processProps),challenge=find(challenged,item=>typeof item.props.onVerified==='function');
 assert.ok(challenge,'an MFA rejection opens the actual challenge');assert.deepEqual(toasts,[],'an MFA code opens MfaStepUp instead of a toast');return challenge;
}
const staleChallenge=await challengedKill();selectProcess('proc058.exe');
await staleChallenge.props.onVerified();await flush();assert.equal(submissions.length,1,'a retained MFA callback cannot adopt another selected process identity');
let challenge=await challengedKill();await challenge.props.onVerified();await flush();
assert.equal(submissions.length,2);assert.deepEqual(submissions[1],submissions[0],'MFA retry retains pid and precise startedAt');
for(const overrides of [
 {viewer:{...viewer,permissions:[]},server:{...processServer,permissions:['diagnose']}},
 {server:{...processServer,management:0}},
 {server:{...processServer,snapshot:{...processServer.snapshot,mode:'ReadOnly'}}},
 {server:{...processServer,lastSeen:at-180000}},
 {server:{...processServer,snapshot:{...processServer.snapshot,agentCapabilities:['list-processes']}}},
 {server:{...processServer,snapshot:{...processServer.snapshot,processes:processes.map(row=>row.pid===1059?{...row,startedAt:new Date(at-2000).toISOString()}:row)}}},
 {server:{...processServer,id:'another-device'}},
]){
 challenge=await challengedKill();tree(ProcessPanel,{...processProps,...overrides});await challenge.props.onVerified();await flush();
 assert.equal(submissions.length,1,'retained MFA callbacks cannot submit after permissions, inventory identity, capabilities or scope change');
}
reset();element=tree(ProcessPanel,processProps);
const treeSwitch=find(element,item=>item.type==='input'&&item.props.role==='switch'&&item.props.onChange);
treeSwitch.props.onChange({target:{checked:true}});markup=html(ProcessPanel,processProps);
assert.match(markup,/↳/,'process hierarchy is displayed');assert.equal(rowsShown(markup),25,'hierarchy remains bounded by paging');
assert.equal(new Set([...markup.matchAll(/aria-label="Details zu ([^"]+)"/g)].map(match=>match[1])).size,25,'tree traversal never duplicates displayed process identities');

reset();markup=html(ProcessPanel,{server:{...processServer,snapshot:{...processServer.snapshot,processes:[],processInventory:{...processServer.snapshot.processInventory,complete:false}}}});assert.match(markup,/Prozesse werden geladen/);assert.ok(!markup.includes('0 Prozesse erfasst'));
reset();markup=html(ProcessPanel,{server:{...processServer,lastSeen:at-180000,snapshot:{...processServer.snapshot,processes:[],processInventory:{...processServer.snapshot.processInventory,complete:false}}}});assert.ok(!markup.includes('Prozesse werden geladen'));assert.match(markup,/Gerät offline/);

// No skeleton after the job wait limit; the slow notice with "Try again" and the empty state instead.
reset({jobs:[job('list-processes',{}, {state:'running',data:null,createdAt:at-61000})]});markup=html(ProcessPanel);
assert.match(markup,/class="sdx-notice sdx-notice-warning" role="status"/);assert.ok(markup.includes('Das Laden der Details dauert länger als üblich.'));assert.match(markup,/Erneut versuchen/);assert.ok(!markup.includes('sdx-skeleton'),'no skeleton after 60 s');
assert.match(markup,/Noch kein automatisches Prozessinventar<\/strong><p>Aktualisiere die Details oder den Agent\./,'the cause-specific empty state below it');
element=tree(ProcessPanel);find(element,item=>typeof item.props.onRetry==='function'&&'text' in item.props).props.onRetry();await flush();assert.deepEqual(submissions,[{kind:'list-processes',params:{limit:1000,sampleMs:350},confirm:false}],'"Try again" sends the process query again');
reset({jobs:[job('list-processes',{}, {state:'running',data:null,createdAt:at-61000})]});markup=html(ProcessPanel,processProps);assert.match(markup,/sdx-notice-warning/);assert.equal(rowsShown(markup),25,'with saved data the table stays below the notice');
// A failed read: the danger notice with "Try again" reloads the jobs; saved rows stay with the stale note.
reset({error:'Diagnosedaten konnten nicht gelesen werden.',source:'read'});markup=html(ProcessPanel);
assert.match(markup,/class="sdx-notice sdx-notice-danger" role="alert"/);assert.match(markup,/Diagnosedaten konnten nicht gelesen werden\./);assert.match(markup,/Erneut versuchen/);
element=tree(ProcessPanel);find(element,item=>typeof item.props.onRetry==='function'&&'error' in item.props).props.onRetry();await flush();assert.equal(loads,1,'"Try again" reads the jobs again');assert.equal(states.get(1).source,null,'and clears the notice');
reset({error:'Diagnosedaten konnten nicht gelesen werden.',source:'read'});markup=html(ProcessPanel,processProps);assert.match(markup,/Angezeigt wird der zuletzt geladene Stand\./);assert.equal(rowsShown(markup),25,'loaded rows stay');
// A failed query repeats exactly its parameters.
reset({error:'Die Abfrage wurde abgelehnt.',kind:'list-processes',params:{limit:1000,sampleMs:350}});element=tree(ProcessPanel,processProps);find(element,item=>typeof item.props.onRetry==='function'&&'error' in item.props).props.onRetry();await flush();
assert.deepEqual(submissions,[{kind:'list-processes',params:{limit:1000,sampleMs:350},confirm:false}],'a failed query is sent again with its parameters');

// Use the actual one-shot diagnosis client while exercising the component's effects.
function automaticClient(){
 const automatic=createDiagnosisClient({
  isCurrent:()=>refs.get(1)?.current.serverId==='device'&&refs.get(1)?.current.enabled===true,
  read:async()=>({jobs:states.get(0).jobs}),
  post:async(kind,params,confirm)=>{submissions.push({kind,params,confirm});return {id:nextSubmission};},
  onJobs:jobs=>states.set(0,{serverId:'device',jobs,loaded:true}),
  onBusy:busyKind=>states.set(2,{...states.get(2),busyKind}),
  onLoading:loading=>states.set(2,{...states.get(2),loading}),
  onAutomatic:autoPreparing=>states.set(2,{...states.get(2),autoStarted:true,autoPreparing}),
  onSubmitted:submitted=>states.set(2,{...states.get(2),submitted}),
  onError:(error,source)=>states.set(1,{serverId:'device',error:String(error),source:source==='read'?'read':'query',kind:'list-processes',params:{}}),
 });
 refs.get(0).current.value=automatic;return automatic;
}
async function processEffects(overrides={}){
 tree(ProcessPanel,overrides);for(const effect of effects.slice(1))effect.callback();await flush();
}
reset({loaded:false,loading:true,autoStarted:false});const automatic=automaticClient();
markup=html(ProcessPanel);assert.match(markup,/Prozesse werden geladen/);assert.ok(!markup.includes('Noch kein automatisches Prozessinventar'));
await processEffects();assert.equal(submissions.length,0,'automatic process discovery waits for the first GET');
await automatic.load();await processEffects();await flush();
assert.deepEqual(submissions,[{kind:'list-processes',params:{},confirm:false}],'missing process inventory starts one automatic query after GET completes');
for(let index=0;index<4;index++)await processEffects();assert.equal(submissions.length,1,'rerenders never repeat automatic process queries');automatic.dispose();
for(const setup of [
 {overrides:processProps},
 {overrides:{server:{...processServer,snapshot:{...processServer.snapshot,processInventory:{...processServer.snapshot.processInventory,complete:false},processes:[]}}}},
 {jobs:[job('list-processes',{}, {state:'failed',data:null})]},
 {jobs:[job('list-processes',{}, {state:'running',data:null})]},
 {error:'Diagnosedaten konnten nicht gelesen werden.'},
 {overrides:{server:{...server,lastSeen:at-180000}}},
 {overrides:{server:{...server,snapshot:{...server.snapshot,agentCapabilities:[]}}}},
 {overrides:{viewer:{...viewer,permissions:[]},server:{...server,permissions:[]}}},
 {overrides:{demo:true}},
 {overrides:{server:{...server,revoked:1}}},
]){
 reset({jobs:setup.jobs??[],error:setup.error??'',source:setup.error?'read':null,autoStarted:false});const client=automaticClient();await processEffects(setup.overrides);assert.equal(submissions.length,0,'inventory/history/error/offline/capability/rights guards prevent unwanted automatic host work');client.dispose();
}

// The concrete reason in each of the four panels.
const sessionServer={...server,snapshot:{...server.snapshot,agentCapabilities:[...capabilities,'list-sessions','message-session','disconnect-session','logoff-session','list-connections','network-diagnostics']}};
for(const Panel of [ProcessPanel,SessionPanel,ConnectionsPanel,EventPanel]){
 reset();markup=html(Panel,{demo:true});assert.ok(markup.includes('Bei Beispielgeräten nicht möglich.'),Panel.name+': the demo sentence');assert.ok(!markup.includes('zugewiesenen Rechte'),Panel.name+': no generic note');
 reset();markup=html(Panel,{viewer:{...viewer,permissions:[]},server:{...sessionServer,permissions:['security.events']}});assert.ok(markup.includes('Dir fehlt die Berechtigung, auf diesem Gerät Diagnosen auszuführen.'),Panel.name+': the right sentence');assert.match(markup,/class="sdx-notice sdx-notice-info" role="status"/);
 reset();markup=html(Panel,{server:{...sessionServer,revoked:1}});assert.ok(markup.includes('weil sein Agentzugriff widerrufen wurde.'),Panel.name+': a revoked device names its reason');
}
reset();markup=html(EventPanel,{viewer:{...viewer,permissions:[]},server:{...sessionServer,permissions:[]}});assert.match(markup,/class="sdx-card sdx-card-flush sdx-crashes"/,'Events still render the crash list without diagnose');assert.match(markup,/Abstürze/);

// Sessions on the DataTable, one row Menu with blocked reasons, ConfirmDialogs named like their entries.
const sessionJob=job('list-sessions',{sessions:[{sessionId:2,username:'DOMAIN\\Niko',state:'Active',station:'RDP-Tcp',client:'PC-7',logonAt:new Date(at-3600000).toISOString(),idleSeconds:120,processIds:[1,2,3]},{sessionId:0,username:'',state:'Disconnected',station:'Services'}]});
reset({jobs:[sessionJob]});markup=html(SessionPanel,{server:sessionServer,onSelectUser:()=>{}});assert.match(markup,/role="region" aria-label="Sitzungen"/);
{const shown=[];const withUser=find(tree(SessionPanel,{server:sessionServer,onSelectUser:user=>shown.push(user)}),item=>Array.isArray(item.props.entries)&&item.props.label==='Aktionen für DOMAIN\\Niko').props.entries;assert.deepEqual(withUser.map(item=>item.label),['3 Prozesse anzeigen','Nachricht senden','Sitzung trennen','Benutzer abmelden'],'"Show 3 processes" is the first entry of the session menu');withUser[0].onSelect();assert.deepEqual(shown,['DOMAIN\\Niko'],'it opens the processes of the user');assert.ok(!/<button[^>]*>[^<]*Prozesse anzeigen/.test(markup),'no Btn column for it');}assert.match(markup,/aria-label="Aktionen für DOMAIN\\Niko"/);
element=tree(SessionPanel,{server:{...sessionServer,management:0}});let entries=menuEntries(element);
assert.deepEqual(entries.map(item=>item.label),['Nachricht senden','Sitzung trennen','Benutzer abmelden'],'three entries');assert.equal(entries[0].blocked,'Verwaltungsmodus und Verwaltungsberechtigungen erforderlich','Send message names its reason');
element=tree(SessionPanel,{server:sessionServer});const consoleEntries=find(element,item=>Array.isArray(item.props.entries)&&item.props.label==='Aktionen für —').props.entries;assert.equal(consoleEntries[0].blocked,'In dieser Sitzung ist kein Benutzer angemeldet.','a console session without a user');
entries=menuEntries(element);assert.equal(entries[0].blocked,undefined);entries[0].onSelect();element=tree(SessionPanel,{server:sessionServer});confirm=confirmDialog(element);
assert.equal(confirm.props.confirmLabel,'Nachricht senden');assert.equal(confirm.props.blocked,'Gib eine Nachricht ein.','blocked while the message is empty');
const field=find(confirm,item=>item.type==='textarea');assert.equal(field.props.maxLength,1000);field.props.onChange({target:{value:'Bitte abmelden.'}});
element=tree(SessionPanel,{server:sessionServer});confirm=confirmDialog(element);assert.equal(confirm.props.blocked,undefined);confirm.props.onConfirm();await flush();
assert.deepEqual(submissions,[{kind:'message-session',params:{sessionId:2,username:'DOMAIN\\Niko',confirm:true,message:'Bitte abmelden.'},confirm:true}]);
reset({jobs:[sessionJob]});element=tree(SessionPanel,{server:sessionServer});menuEntries(element)[2].onSelect();confirm=confirmDialog(tree(SessionPanel,{server:sessionServer}));assert.deepEqual([confirm.props.confirmLabel,confirm.props.tone],['Benutzer abmelden','danger'],'Sign out uses the danger tone');
let shownUser='';reset({jobs:[sessionJob]});element=tree(SessionPanel,{server:sessionServer,onSelectUser:user=>{shownUser=user;}});menuEntries(element)[0].onSelect();assert.equal(shownUser,'DOMAIN\\Niko','"Show processes" opens Processes for the user');

// Connections in a card, no "Details" column; a row opens the drawer.
const connectionJob=job('list-connections',{connections:[{protocol:'TCP',state:'Established',localAddress:'10.0.0.5',localPort:443,remoteAddress:'10.0.0.9',remotePort:51000,name:'svchost.exe',pid:880,user:'SYSTEM'}]});
reset({jobs:[connectionJob]});element=tree(ConnectionsPanel,{server:sessionServer});const connections=table(element,'Offene Verbindungen');
assert.deepEqual(connections.props.columns.map(column=>column.id),['protocol','state','local','remote','process','user']);assert.ok(!connections.props.columns.some(column=>column.label==='Details'),'no Details column');
markup=html(ConnectionsPanel,{server:sessionServer});assert.match(markup,/Offene Verbindungen/);assert.match(markup,/1 von 1 Verbindungen/);assert.match(markup,/Netzwerk testen/);
connections.props.onOpen(connections.props.rows[0]);markup=html(ConnectionsPanel,{server:sessionServer});assert.match(markup,/role="dialog"/);assert.match(markup,/10\.0\.0\.9:51000/);
element=tree(ConnectionsPanel,{server:sessionServer});
const port=find(element,item=>item.type==='input'&&item.props.type==='number');port.props.onChange({target:{value:'70000'}});element=tree(ConnectionsPanel,{server:sessionServer});
assert.equal(find(element,item=>item.props.type==='submit').props.blocked,'Gib einen TCP-Port von 1 bis 65535 ein.','an invalid port blocks the test with its reason');

// A template fills the fields and runs its query once; opening the panel runs nothing.
reset();element=tree(EventPanel);await flush();assert.equal(submissions.length,0,'opening the Events panel queries nothing');clickButton(element,'Fehler · 24 Std.').props.onClick();element=tree(EventPanel);assert.equal(labelled(element,'Ereignisstufe').props.value,'errors');assert.equal(labelled(element,'Ereigniskanal').props.value,'System');assert.ok(labelled(element,'Ereignisse von').props.value);await flush();assert.equal(submissions.length,1,'the template runs its query once');assert.equal(submissions[0].kind,'query-events');assert.deepEqual(submissions[0].params.levels,[1,2]);assert.equal(submissions[0].params.limit,50);assert.equal(submissions[0].params.includeXml,false);assert.ok(submissions[0].params.from.endsWith('Z'));
const base={channel:'System',provider:undefined,eventIds:[],text:'',from:undefined,to:undefined,levels:[],limit:50,includeXml:false};
const eventRows=[{id:41,recordId:100,at:new Date(at).toISOString(),level:'Kritisch',levelNumber:1,provider:'Kernel-Power',message:'Unexpected shutdown <script>alert(1)</script>',xml:'<event />'},{id:7036,recordId:99,at:new Date(at-1000).toISOString(),level:'Information',levelNumber:4,provider:'Service Control Manager',message:'A service changed state.'},{id:500,recordId:98,at:new Date(at-2000).toISOString(),level:'Warnung',levelNumber:3,provider:'Application',message:'Warning sample'}];
const cursor={channel:'System',recordId:98,timeCreated:new Date(at-2000).toISOString()};
const eventJob=job('query-events',{channel:'System',events:eventRows,hasMore:true,scanned:3,cursor});
reset({jobs:[eventJob]});states.set(QUERIES,{[eventJob.id]:base});markup=html(EventPanel);assert.match(markup,/3 Treffer · 3 gescannt/);assert.match(markup,/Kernel-Power/);assert.ok(markup.includes('&lt;script&gt;'));assert.ok(!markup.includes('<script>'));assert.match(markup,/Ältere Ereignisse/);
// The result table with a level pill (always with text) and the result filter.
assert.match(markup,/role="region" aria-label="System"/);assert.match(markup,/class="sdx-pill sdx-pill-critical"><i aria-hidden="true"><\/i>Kritisch<\/span>/);assert.match(markup,/class="sdx-pill sdx-pill-warning"><i aria-hidden="true"><\/i>Warnung<\/span>/);assert.match(markup,/class="sdx-pill sdx-pill-neutral"><i aria-hidden="true"><\/i>Information<\/span>/);
assert.match(markup,/role="group" aria-label="Ergebnisse filtern"/);assert.ok(!markup.includes('sd-event-item')&&!markup.includes('sd-event-exportbar'),'no event button list and no export bar');
element=tree(EventPanel);clickButton(element,'Ältere Ereignisse').props.onClick();await flush();assert.deepEqual(submissions[0],{kind:'query-events',params:{...base,cursor},confirm:false});

// An older rendered next-page callback uses the latest successful matching query.
const nextCursor={channel:'Application',recordId:7,timeCreated:new Date(at-5000).toISOString()};
const nextBase={...base,channel:'Application'},nextJob=job('query-events',{channel:'Application',events:eventRows,hasMore:true,scanned:3,cursor:nextCursor},{id:'latest-event-query'});
reset({jobs:[eventJob]});states.set(QUERIES,{[eventJob.id]:base});element=tree(EventPanel);const retainedLatestPage=clickButton(element,'Ältere Ereignisse');
labelled(element,'Ereigniskanal').props.onValueChange('Application');
states.set(0,{serverId:'device',jobs:[nextJob,eventJob],loaded:true});states.set(QUERIES,{[eventJob.id]:base,[nextJob.id]:nextBase});tree(EventPanel);
retainedLatestPage.props.onClick();await flush();assert.deepEqual(submissions[0],{kind:'query-events',params:{...nextBase,cursor:nextCursor},confirm:false},'latest matching query supplies both its parameters and cursor');
reset({jobs:[eventJob]});states.set(QUERIES,{[eventJob.id]:base});element=tree(EventPanel);const stalePresetPage=clickButton(element,'Ältere Ereignisse');
clickButton(element,'Systemstarts · 7 Tage').props.onClick();element=tree(EventPanel);
assert.equal(labelled(element,'Ereignis-IDs').props.value,'41, 1074, 6005, 6006, 6008');assert.equal(labelled(element,'Ereignisstufe').props.value,'all');
assert.equal(clickButton(element,'Ältere Ereignisse').props.blocked,'Der Filter hat sich geändert. Frage zuerst erneut ab.');stalePresetPage.props.onClick();await flush();assert.equal(submissions.length,1,'the template runs its own query once; the stale older-page cursor sends nothing');
submitQuery(element);await flush();assert.deepEqual(submissions[0].params.eventIds,[41,1074,6005,6006,6008]);
assert.equal(submissions[0].params.cursor,undefined,'preset query starts independently');

reset({jobs:[eventJob]});states.set(QUERIES,{[eventJob.id]:base});element=tree(EventPanel);const nextPage=clickButton(element,'Ältere Ereignisse');labelled(element,'Ereignistextfilter').props.onChange({target:{value:'changed'}});tree(EventPanel);nextPage.props.onClick();await flush();assert.equal(submissions.length,0,'a retained next-page action cannot mix cursor with changed filters');
// One export IconBtn with a Menu: two local downloads, a separator, two agent jobs.
reset({jobs:[eventJob]});element=tree(EventPanel);entries=menuEntries(element);
assert.equal(find(element,item=>Array.isArray(item.props.entries)).props.label,'Ereignisse exportieren');assert.equal(find(element,item=>Array.isArray(item.props.entries)).props.trigger.props.label,'Ereignisse exportieren','the trigger is the download IconBtn');
assert.deepEqual(entries.map(item=>item.label??'—'),['Ergebnisse als CSV herunterladen','Ergebnisse als JSON herunterladen','—','EVTX auf dem Gerät exportieren','Supportpaket erstellen'],'four entries and a separator');
entry(element,'json').onSelect();entry(element,'csv').onSelect();assert.equal(downloads.length,2);assert.equal(downloads[0][0],'ServerDesk-WIN-TEST-System.json');assert.deepEqual(JSON.parse(downloads[0][1]),eventRows);assert.match(downloads[1][1],/at;level;id;provider;message/);assert.equal(downloads[1][0],'ServerDesk-WIN-TEST-System.csv');
assert.deepEqual(toasts,['Ereignisse exportiert.','Ereignisse exportiert.'],'each download confirms with a toast');
reset({jobs:[job('query-events',{channel:'System',events:[{...eventRows[0],message:'=cmd|calc'}]})]});entry(tree(EventPanel),'csv').onSelect();assert.match(downloads[0][1],/"'=cmd\|calc"/,'CSV stays injection safe');
reset({jobs:[eventJob]});element=tree(EventPanel);table(element,'System').props.onOpen(table(element,'System').props.rows[0]);markup=html(EventPanel);assert.match(markup,/Ereignis 41/);assert.match(markup,/Datensatz-ID/);assert.match(markup,/XML kopieren/);assert.match(markup,/role="dialog"/);
// Without a result and without an export capability the IconBtn itself is blocked and opens no menu.
reset();element=tree(EventPanel,{server:{...server,snapshot:{...server.snapshot,agentCapabilities:['query-events']}}});
const exportButton=labelled(element,'Ereignisse exportieren');assert.equal(exportButton.props.blocked,'Führe zuerst eine Abfrage aus.');assert.equal(menuEntries(element),undefined,'no menu behind a blocked export button');
reset();element=tree(EventPanel);assert.equal(entry(element,'csv').blocked,'Führe zuerst eine Abfrage aus.','without results the downloads say why');

for(const invalid of [{label:'Ereignis-IDs',value:'41,not-a-number'},{label:'Ereignis-IDs',value:'65536'},{label:'Ereignisse von',value:'invalid-date'}]){
 reset();element=tree(EventPanel);const retained=queryForm(element).props.onSubmit,exported=entry(element,'evtx').onSelect;labelled(element,invalid.label).props.onChange({target:{value:invalid.value}});element=tree(EventPanel);assert.ok(queryButton(element).props.blocked,'the query says why it cannot run');assert.ok(entry(element,'evtx').blocked);retained({preventDefault(){}});exported();await flush();assert.equal(submissions.length,0,'invalid IDs/date values cannot reach submit through retained query/export callbacks');
}
reset();element=tree(EventPanel);labelled(element,'Ereignisse von').props.onChange({target:{value:localInput(at-3600000)}});labelled(element,'Ereignisse bis').props.onChange({target:{value:localInput(at-3*3600000)}});element=tree(EventPanel);assert.ok(queryButton(element).props.blocked);assert.match(html(EventPanel),/role="alert" class="sdx-field-error">Gib einen gültigen Zeitraum/);
reset();element=tree(EventPanel);entry(element,'evtx').onSelect();await flush();entry(element,'bundle').onSelect();await flush();assert.deepEqual(submissions,[{kind:'export-events',params:{filter:base,format:'evtx'},confirm:false},{kind:'support-bundle',params:{channels:['System'],includeEvents:true},confirm:false}]);
assert.deepEqual(toasts,['Auftrag erstellt. Den Fortschritt siehst du unten unter „Aufträge“.','Auftrag erstellt. Den Fortschritt siehst du unten unter „Aufträge“.'],'agent jobs confirm with the job toast');
// While an event query runs or another action is busy, the agent-job entries stay visible and say why; the downloads stay available.
const waitText='Eine andere Anfrage läuft. Warte, bis sie abgeschlossen ist.';
for(const setup of [{busyKind:'query-events'},{jobs:[job('query-events',{}, {id:'newer',state:'running',data:null}),eventJob]},{jobs:[eventJob],busyKind:'export-events'}]){
 reset(setup);element=tree(EventPanel);
 assert.deepEqual([entry(element,'evtx').blocked,entry(element,'bundle').blocked],[waitText,waitText],'EVTX and the support bundle wait for the running request');
 if(setup.jobs)assert.equal(entry(element,'csv').blocked,undefined,'the downloads of the shown result stay available');
 entry(element,'evtx').onSelect();entry(element,'bundle').onSelect();await flush();assert.equal(submissions.length,0,'a blocked entry sends nothing');
}
reset();element=tree(EventPanel);const retainedEvtx=entry(element,'evtx').onSelect;labelled(element,'Ereignistextfilter').props.onChange({target:{value:'search'}});element=tree(EventPanel);assert.equal(entry(element,'evtx').blocked,'EVTX-Dateien können keinen Textfilter nutzen. Leere den Nachrichtenfilter.','EVTX names the text filter');retainedEvtx();await flush();assert.equal(submissions.length,0,'EVTX cannot silently drop a current text filter');
for(const overrides of [{server:{...server,lastSeen:at-180000}},{server:{...server,snapshot:{...server.snapshot,agentCapabilities:[]}}},{viewer:{...viewer,permissions:[]},server:{...server,permissions:[]}},{demo:true},{server:{...server,id:'another-device'}}]){
 reset();element=tree(EventPanel);const query=queryForm(element).props.onSubmit,evtx=entry(element,'evtx').onSelect,support=entry(element,'bundle').onSelect;tree(EventPanel,overrides);query({preventDefault(){}});evtx();support();await flush();assert.equal(submissions.length,0,'retained event actions obey current rights, capability, offline and scope');
}
const securityJob=job('query-events',{channel:'Security',events:[{...eventRows[0],message:'sensitive event'}],scope:{security:true}});
reset({jobs:[securityJob]});element=tree(EventPanel);const retainedJson=entry(element,'json').onSelect;tree(EventPanel,{viewer:{...viewer,permissions:[]},server:{...server,permissions:['diagnose']}});retainedJson();assert.equal(downloads.length,0,'revoked Security permission immediately hides buffered events and prevents stale downloads');markup=html(EventPanel,{viewer:{...viewer,permissions:[]},server:{...server,permissions:['diagnose']}});assert.ok(!markup.includes('sensitive event'));

// Agent output scope is on the outer envelope and wins over an inner false flag.
const scopedBundle=job('support-bundle',{scope:{security:false},file:{name:'Security-support-secret.zip',path:'C:\\Temp\\Security-secret.zip',size:1024,expiresAt:new Date(at+86400000).toISOString()}},{data:{kind:'support-bundle',at:new Date(at).toISOString(),scope:{security:true},data:{scope:{security:false},file:{name:'Security-support-secret.zip',path:'C:\\Temp\\Security-secret.zip',size:1024,expiresAt:new Date(at+86400000).toISOString()}}},result:'Security export private output'});
reset({jobs:[scopedBundle]});markup=html(EventPanel);assert.match(markup,/Security-support-secret.zip/);assert.match(markup,/1\sKiB/,'the export size in IEC bytes');
markup=html(EventPanel,{viewer:{...viewer,permissions:[]},server:{...server,permissions:['diagnose']}});
assert.ok(!markup.includes('Security-support-secret.zip'),'Security output filenames are masked immediately after rights withdrawal');
assert.ok(!markup.includes('Security-secret.zip'),'Security output paths cannot leak through inner scope overrides');assert.ok(!markup.includes('Security export private output'));
const outerScopedEvent=job('query-events',{channel:'Application',events:[{...eventRows[0],message:'outer-scoped sensitive event'}]},{data:{kind:'query-events',at:new Date(at).toISOString(),scope:{security:true},data:{channel:'Application',scope:{security:false},events:[{...eventRows[0],message:'outer-scoped sensitive event'}]}}});
reset({jobs:[outerScopedEvent]});element=tree(EventPanel);const staleScopedJson=entry(element,'json').onSelect;
markup=html(EventPanel,{viewer:{...viewer,permissions:[]},server:{...server,permissions:['diagnose']}});assert.ok(!markup.includes('outer-scoped sensitive event'));
staleScopedJson();assert.equal(downloads.length,0,'outer scoped query results stay protected independently of channel naming');

reset();element=tree(EventPanel);labelled(element,'Ereigniskanal').props.onValueChange('Security');element=tree(EventPanel);const retainedSecurityQuery=queryForm(element).props.onSubmit;tree(EventPanel,{viewer:{...viewer,permissions:[]},server:{...server,permissions:['diagnose']}});retainedSecurityQuery({preventDefault(){}});await flush();assert.equal(submissions.length,0,'Security query rechecks current permission');
reset({jobs:[job('query-events',{}, {})]});markup=html(EventPanel);assert.ok(!markup.includes('Keine Ereignisse für diese Abfrage'),'missing events array is never presented as empty success');
reset({jobs:[job('query-events',{channel:'System',events:[]})]});markup=html(EventPanel);assert.match(markup,/Keine Ereignisse für diese Abfrage/);
reset({jobs:[job('query-events',{}, {state:'running',data:null})]});markup=html(EventPanel);assert.match(markup,/Ereignisse werden geladen/);assert.ok(!markup.includes('Protokoll auswählen'));
// A failed event query: "Try again" sends exactly its parameters again.
reset({error:'Kanal nicht gefunden.',kind:'query-events',params:{...base,channel:'Setup'}});element=tree(EventPanel);find(element,item=>typeof item.props.onRetry==='function'&&'error' in item.props).props.onRetry();await flush();
assert.deepEqual(submissions,[{kind:'query-events',params:{...base,channel:'Setup'},confirm:false}],'the failed query is repeated with its own parameters');
Date.now=oldNow;
// UI-Rework 13b: the process row Menu, "every process is protected" said once, the Connections query in its empty state.
{
 reset();let element=tree(ProcessPanel,processProps);
 const menu=labelled(element,'Aktionen für proc059.exe');
 assert.deepEqual(menu.props.entries.map(entry=>entry.separator?'—':entry.label),['Details anzeigen','—','Prozess beenden'],'the process row Menu: Show details, separator, End process');
 assert.equal(menu.props.entries.at(-1).danger,true,'End process is the danger entry');
 menu.props.entries[0].onSelect();element=tree(ProcessPanel,processProps);assert.ok(renderToStaticMarkup(element).includes('role="dialog"'),'Show details opens the drawer');
 // Some protected rows: the filter item and the shield stay.
 reset();element=tree(ProcessPanel,processProps);find(element,item=>item.props.label==='Prozessfilter'&&Array.isArray(item.props.items)).props.onChange('protected');let markup=html(ProcessPanel,processProps);
 assert.ok(markup.includes('<span>Geschützt</span>')&&markup.includes('aria-label="Geschützter Prozess"')&&!markup.includes('Jeder Prozess ist geschützt'),'mixed rows: the Protected filter item and the shield on the protected row');
 // Every row protected: one sentence in the meta, no filter item, no shield; a stored protected focus falls back to All.
 const guarded={server:{...processServer,snapshot:{...processServer.snapshot,processes:processes.map(row=>({...row,protected:true}))}}};
 reset();markup=html(ProcessPanel,guarded);
 assert.equal((markup.match(/Jeder Prozess ist geschützt und lässt sich nicht beenden\./g)||[]).length,1,'every row protected: the meta line says it once');
 assert.ok(!markup.includes('<span>Geschützt</span>')&&!markup.includes('aria-label="Geschützter Prozess"'),'no Protected filter item and no shield per row');
 element=tree(ProcessPanel,guarded);find(element,item=>item.props.label==='Prozessfilter'&&Array.isArray(item.props.items)).props.onChange('protected');
 markup=html(ProcessPanel,guarded);assert.match(markup,/aria-pressed="true" class="active"><span>Alle Prozesse<\/span>/,'a stored protected focus falls back to All');
 assert.equal(rowsShown(markup),25,'and lists every process');
 // Connections: before the first query the empty state explains and offers the query; nothing queries on open.
 reset();element=tree(ConnectionsPanel,{server:sessionServer});await flush();
 assert.equal(submissions.length,0,'opening Connections queries nothing');
 const empty=table(element,'Offene Verbindungen').props.empty;
 assert.deepEqual([empty.title,empty.children,empty.action.props.children],['Noch keine Verbindungen abgefragt','Der Agent listet die offenen Netzwerkverbindungen des Geräts auf.','Abfragen'],'the empty state: title, hint and the Query action');
 empty.action.props.onClick();await flush();assert.deepEqual(submissions.map(item=>item.kind),['list-connections'],'the empty-state Query runs the same query as the toolbar');
 reset();element=tree(ConnectionsPanel,{server:{...sessionServer,lastSeen:at-180000}});
 const offline=table(element,'Offene Verbindungen')?.props.empty;
 assert.ok(!offline||offline.action===undefined||offline.action.props.blocked==='Dafür muss das Gerät online sein.','offline: the query is blocked with the reason (or the offline empty state)');
 // Events: the templates are blocked offline and run nothing.
 reset();element=tree(EventPanel,{server:{...server,lastSeen:at-180000}});const template=clickButton(element,'Fehler · 24 Std.');
 assert.equal(template.props.blocked,'Dafür muss das Gerät online sein.','offline: the templates are blocked with the query reason');
 template.props.onClick();await flush();assert.equal(submissions.length,0,'a blocked template runs nothing');
}
console.log('PASS: actual process/sessions/connections/events SSR on the kit, the concrete blocked reasons, first-load skeletons and the 60 s limit, load errors with retry and stale data, action errors as toasts, process search/sort/25-row paging, exact safe kill intent and MFA retries, one-shot automatic discovery, stale identity/current-rights guards, event presets/validation/latest cursor/export menu and outer-envelope Security scope protections.');
