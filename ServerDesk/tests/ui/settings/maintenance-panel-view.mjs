// The page Settings → Data retention: the real MaintenancePanel with
// deterministic hooks, timers and API replies, plus the navigation entries,
// the palette, the help topic and the capability rule. The page sits on the kit:
// SettingsPage with its loading and error look, the storage KpiRow, the cards
// "Daily cleanup" (state pill, Facts, the recent runs in a closed Disclosure) and
// "Retention by area" (one DataTable), and the two drawers "Change retention" and
// "Change schedule" that save through the real useStepUp. No server or browser is
// touched.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {navPage,de,i18nStubs,i18nRequire,translateModule,formatModule} from '../../support/i18n-stubs.mjs';
const {translate}=translateModule;

let checks=0;
const check=(value,expected,label)=>{assert.deepEqual(value,expected,label);checks++;};
const jsx=(type,props,key)=>({type,props:props??{},key});
// The text of a node and its children.
const textOf=node=>typeof node==='string'||typeof node==='number'?String(node):!node||typeof node!=='object'?'':Array.isArray(node)?node.map(textOf).join(''):[node.props?.children].flat(Infinity).map(textOf).join('');
const source=filename=>ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
const loadModule=(filename,stubs={})=>{const mod={exports:{}};new Function('require','module','exports',source(path.resolve(filename)))(id=>i18nRequire(id)??(Object.hasOwn(stubs,id)?stubs[id]:id.endsWith('.css')?{}:id==='lucide-react'?new Proxy({}, {get:(_target,key)=>String(key)}):id==='react/jsx-runtime'?{jsx,jsxs:jsx,Fragment:'Fragment'}:(()=>{throw Error('Unexpected import '+id+' in '+filename);})()),mod,mod.exports);return mod.exports;};

class ApiError extends Error{constructor(message,status,code){super(message);this.status=status;this.code=code;}}
const kitNames=['Btn','Card','Disclosure','Drawer','DrawerCancel','Facts','Kpi','KpiRow','Meter','Notice','RichText','SettingsPage','StatusPill'];
const kit={...Object.fromEntries(kitNames.map(name=>[name,name])),exactTime:value=>`@${value}`,relativeTime:value=>`~${value}`};
const field={Field:'Field',Select:'Select'};
const stepUp=loadModule('lib/step-up.ts'),codes=loadModule('lib/errors/codes.ts'),capabilities=loadModule('ui/base/access-capabilities.ts'),tableSort=loadModule('ui/base/table-sort.ts'),route=loadModule('lib/console-route.ts');
const model=loadModule('ui/settings/retention-model.ts',{'@/lib/step-up':stepUp});
const pageSource=fs.readFileSync('ui/settings/maintenance-panel.tsx','utf8'),cssSource=fs.readFileSync('ui/settings/maintenance-panel.css','utf8');

const now=Date.UTC(2026,9,28,9),MiB=1024*1024;
const run=(id,extra={})=>({id,startedAt:now-id*60_000,finishedAt:now-id*60_000+65_000,status:'succeeded',trigger:'schedule',requestedBy:null,error:null,
 result:{retention:{auditDays:30,jobDays:30},audit:{deleted:12,more:false},customerAudit:[{customerId:'c-1',auditDays:7,deleted:3,more:true,customerName:'Kunde A'}],jobs:{deleted:4,more:false},jobOutputs:{deleted:2,more:false},softwareChanges:{deleted:6,more:false},integrityEvents:{deleted:1,more:false},transfers:{cleared:5,failed:1,more:false},usageReport:{status:'failed',error:'timeout'}},...extra});
const tableNames=['audit','jobs','job_outputs','device_software_changes','alerts','notification_events','notification_deliveries','agent_integrity_events','transfers','transfer_chunks'];
const storage=(overrides={})=>({databaseBytes:100*MiB,tables:Object.fromEntries(tableNames.map(name=>[name,{bytes:MiB,rows:10}])),transferObjectBytes:2*MiB,...overrides});
const viewOf=(overrides={})=>{
 const history=overrides.history??[run(1)];
 return {settings:{auditDays:30,jobDays:30,runAt:'03:00',timeZone:'UTC',revision:4,source:{auditDays:'default',jobDays:'default'},...overrides.settings},
  envInvalid:{auditDays:false,jobDays:false,...overrides.envInvalid},
  status:{lastRun:history[0]??null,lastSuccessAt:now-3_600_000,running:false,nextRunAt:now+3_600_000,stale:false,...overrides.status},history,
  storage:storage(overrides.storage),
  areaRetention:{softwareDays:{days:365,source:'default',envInvalid:false},alertDays:{days:90,source:'default',envInvalid:false},assistantScriptDays:7,integrityDays:90,...overrides.areaRetention},
  customerRetention:{count:0,minDays:null,maxDays:null,...overrides.customerRetention}};
};
const owner={id:'owner',label:'owner@example.test',permissions:['*']};
const fieldLabels={auditDays:'maintenancePage.auditDays',jobDays:'maintenancePage.jobDays',runAt:'maintenancePage.runAt',timeZone:'maintenancePage.timeZone'};
const propKeys=['children','actions','action','hint','footer','wide','primary','detail','parts'];

function harness({get=()=>viewOf(),post=()=>viewOf(),demo=false,viewer=owner}={}){
 const cells=[],effects=[],calls=[],toasts=[],intervals=[];let cursor=0,dirty=false,tree;
 const changed=(old,deps)=>!old||!deps||deps.some((value,i)=>!Object.is(value,old.deps?.[i]));
 const hooks={
  useState(initial){const index=cursor++;cells[index]??={value:typeof initial==='function'?initial():initial};return [cells[index].value,value=>{const next=typeof value==='function'?value(cells[index].value):value;if(!Object.is(next,cells[index].value)){cells[index].value=next;dirty=true;}}];},
  useRef(initial){const index=cursor++;cells[index]??={value:{current:initial}};return cells[index].value;},
  useCallback(fn,deps){const index=cursor++,old=cells[index];if(changed(old,deps))cells[index]={deps,value:fn};return cells[index].value;},
  useEffect(fn,deps){const index=cursor++,old=cells[index];if(changed(old,deps))effects.push(()=>{old?.cleanup?.();cells[index]={deps,cleanup:fn()};});},
 };
 const toast={success:text=>toasts.push(text),error:text=>toasts.push('error:'+text)};
 const api=async(url,payload)=>{calls.push({url,payload});return payload?post(payload):get();};
 // The real step-up flow on the harness hooks: the dialog props come from useStepUp.
 const retry=loadModule('ui/session/step-up-retry.ts',{...i18nStubs,react:hooks,sonner:{toast},'@/ui/base/api':{message:error=>error.message}});
 const mod=loadModule('ui/settings/maintenance-panel.tsx',{react:hooks,sonner:{toast},
  '@/lib/step-up':stepUp,'@/lib/errors/codes':codes,'@/lib/console-route':route,'@/ui/base/table-sort':tableSort,'@/ui/base/api':{api,ApiError,message:error=>error.message},'@/ui/session/mfa-step-up':{MfaStepUp:'MfaStepUp'},
  '@/ui/session/step-up-retry':retry,'@/ui/base/access-capabilities':capabilities,'@/ui/shell/page-frame':{useFrameRefresh(){},frameHeader:(frame,primary)=>frame?frame.header(primary):null},'@/ui/kit/kit':kit,'@/ui/kit/field':field,'@/ui/kit/data-table':{DataTable:'DataTable'},
  '@/ui/settings/retention-model':model,...i18nStubs});
 const frame={header:primary=>jsx('Header',{primary}),refresh:0,tab:'',onTab(){}};
 // Function components (RunState) are expanded; kit parts stay as named nodes.
 const expand=node=>{if(!node||typeof node!=='object')return node;if(Array.isArray(node))return node.map(expand);if(typeof node.type==='function')return expand(node.type(node.props));const props={...node.props};for(const key of propKeys)if(key in props)props[key]=key==='parts'?Object.fromEntries(Object.entries(props.parts).map(([name,part])=>[name,expand(part)])):expand(props[key]);return {...node,props};};
 const children=node=>propKeys.flatMap(key=>key==='parts'&&node.props?.parts?Object.values(node.props.parts):[node.props?.[key]]);
 function nodes(node){if(!node||typeof node!=='object')return [];if(Array.isArray(node))return node.flatMap(nodes);return [node,...children(node).flatMap(nodes)];}
 function text(node){if(typeof node==='string'||typeof node==='number')return String(node);if(!node||typeof node!=='object')return '';if(Array.isArray(node))return node.map(text).join('');return [node.props?.title,node.props?.description,node.props?.meta,node.props?.label,node.props?.hint,node.props?.value,node.props?.detail,(node.props?.items??[]).map(item=>[item.label,expand(item.value),item.hint]),node.type==='RichText'?node.props.text:null,node.props?.children].flat(Infinity).map(child=>text(child)).join(' ');}
 const realSet=globalThis.setInterval,realClear=globalThis.clearInterval;
 function render(){
  globalThis.setInterval=(fn,ms)=>{const entry={fn,ms,cleared:false};intervals.push(entry);return entry;};globalThis.clearInterval=entry=>{if(entry)entry.cleared=true;};
  try{let limit=0;do{dirty=false;cursor=0;tree=expand(mod.default({viewer,demo,frame}));for(const effect of effects.splice(0))effect();if(limit++>12)throw Error('Unstable render');}while(dirty);}
  finally{globalThis.setInterval=realSet;globalThis.clearInterval=realClear;}
 }
 async function settle(){for(let n=0;n<30;n++){await new Promise(resolve=>setImmediate(resolve));if(dirty)render();}}
 const find=predicate=>nodes(tree).find(predicate);
 const all=predicate=>nodes(tree).filter(predicate);
 const drawerOf=kind=>find(node=>node.type==='Drawer'&&node.props.title===de(kind==='retention'?'maintenancePage.retentionDrawerTitle':'maintenancePage.scheduleDrawerTitle'));
 const fieldOf=id=>find(node=>node.type==='Field'&&node.props.label===de(fieldLabels[id]));
 render();
 const ui={calls,toasts,intervals,module:mod,render,settle,find,all,fieldOf,drawerOf,expand,nodes:()=>nodes(tree),text:()=>text(tree),textOf:node=>text(node),tree:()=>tree,
  posts:()=>calls.filter(call=>call.payload).map(call=>call.payload),
  primary:()=>find(node=>node.type==='Header')?.props.primary,
  runNow:()=>find(node=>node.type==='Btn'&&node.props.icon==='Play'),
  changeSchedule:()=>find(node=>node.type==='Btn'&&node.props.icon==='CalendarClock'),
  cards:()=>all(node=>node.type==='Card'),
  kpis:()=>all(node=>node.type==='Kpi'),
  runsTable:()=>find(node=>node.type==='DataTable'&&node.props.label===de('maintenancePage.historyTitle')),
  areaTable:()=>find(node=>node.type==='DataTable'&&node.props.label===de('maintenancePage.areasTitle')),
  saveOf(kind){return nodes(this.drawerOf(kind).props.footer).find(node=>node.type==='Btn'&&node.props.type==='submit');},
  formOf(kind){return nodes(this.drawerOf(kind).props.children).find(node=>node.type==='form');},
  input:id=>fieldOf(id)?.props.children,
  dialog:()=>find(node=>node.type==='MfaStepUp'),
  change(id,value){this.input(id).props.onChange({target:{value}});render();},
  submit(kind){this.formOf(kind).props.onSubmit({preventDefault(){}});render();},
  verify(proof){this.dialog().props.onVerified(proof);render();},
  fieldError(id){return fieldOf(id)?.props.error??null;},
 };
 return ui;
}
const cellText=(ui,table,column,row)=>ui.textOf(ui.expand(table.props.columns.find(item=>item.id===column).cell(row))).replace(/\s+/g,' ').trim();

// ---- Loading, error, the KPI row and exactly two cards -----------------------------------
{
 let ui=harness();
 const first=ui.find(node=>node.type==='SettingsPage');
 check([first.props.loading,first.props.label,first.props.loadError,first.props.wide],[true,de('nav.settings.retention'),undefined,undefined],'first load: SettingsPage loading (the facts Skeleton) with the page label');
 check(ui.primary()?.props.children,de('maintenancePage.changeRetention'),'the header primary in every state');
 await ui.settle();
 check(ui.calls.map(call=>call.url),['/api/maintenance'],'one GET');
 const root=ui.tree(),[header,body]=[root.props.children].flat();
 check([root.type,header.type,body.type,body.props.className,body.props.loading],['Fragment','Header','SettingsPage','sdx-maintenance',false],'the frame header with its primary, then one kit SettingsPage');
 check([ui.primary().props.variant,ui.primary().props.blocked],['primary',undefined],'Change retention… is the page primary');

 // KPI row: database size (focal point), file transfer storage, deleted in the last run.
 const row=ui.find(node=>node.type==='KpiRow');
 check([row.props.label,row.props.entranceId],[de('maintenancePage.kpi.label'),'maintenance-kpis'],'the KpiRow with its label and entrance');
 const kpis=ui.kpis().map(kpi=>({label:kpi.props.label,value:kpi.props.value,detail:kpi.props.detail??null,icon:kpi.props.icon,tone:kpi.props.tone??'accent'}));
 check(kpis,[
  {label:de('maintenancePage.kpi.database'),value:formatModule.formatBytes('de',100*MiB),detail:de('maintenancePage.kpi.databaseDetail',{size:formatModule.formatBytes('de',10*MiB)}),icon:'Database',tone:'accent'},
  {label:de('maintenancePage.kpi.transfers'),value:formatModule.formatBytes('de',2*MiB),detail:de('maintenancePage.kpi.transfersDetail'),icon:'HardDrive',tone:'neutral'},
  {label:de('maintenancePage.kpi.deleted'),value:12+3+4+2+6+1+5,detail:`~${now-60_000+65_000}`,icon:'Eraser',tone:'neutral'},
 ],'three tiles: the database size leads, the file transfer storage, the deleted rows of the last run with its end');

 const cards=ui.cards();
 check(cards.map(card=>card.props.title),[de('maintenancePage.cleanupTitle'),de('maintenancePage.areasTitle')],'exactly two cards: Daily cleanup, Retention by area');
 check(cards.map(card=>[card.props.icon,card.props.meta,typeof card.props.description]),[['Wrench',undefined,'string'],['Archive',undefined,'string']],'an icon tile and one description per card, no meta hint');
 check(body.props.wide.type,'Card','the area card is the full-width part of SettingsPage');
 check(ui.all(node=>node.type==='Field').every(item=>item.props.hint===undefined),true,'no field hint without an env source');
 for(const gone of ['maintenancePage.statusTitle','maintenancePage.formTitle','maintenancePage.statusHint','maintenancePage.usage.','maintenancePage.errorLabel','maintenancePage.area.usageReport','maintenancePage.fact.finished','FormActions'])check(pageSource.includes(gone),false,`no ${gone}`);

 // Cleanup card: the state pill leads, then the facts and the closed disclosure.
 const pill=ui.find(node=>node.type==='StatusPill');
 check([pill.props.kind,pill.props.size],['success','lg'],'the large state pill of the last run');
 const facts=ui.find(node=>node.type==='Facts');
 check(facts.props.items.map(item=>[item.id,item.label,item.value]),[
  ['lastRun',de('maintenancePage.fact.lastRun'),`@${now-60_000}`],
  ['nextRun',de('maintenancePage.fact.nextRun'),`@${now+3_600_000}`],
  ['dailyRun',de('maintenancePage.fact.dailyRun'),'03:00 (UTC)'],
 ],'Last run, Next run and Daily run; no Last success after a successful run');
 check([cards[0].props.actions.props.children].flat().map(button=>[button.props.icon,button.props.size,button.props.variant]),[['CalendarClock','sm',undefined],['Play','sm',undefined]],'Change schedule… and Run now: secondary small buttons in the card head');
 const disclosure=ui.find(node=>node.type==='Disclosure');
 check([disclosure.props.title,disclosure.props.open,disclosure.props.hint],[de('maintenancePage.historyTitle'),undefined,undefined],'Recent runs is a closed Disclosure without a hint');
 const runs=ui.runsTable();
 check([disclosure.props.children].flat().includes(runs),true,'the runs table is inside the disclosure');
 check([runs.props.columns.map(column=>column.label),runs.props.columns.filter(column=>column.sort).map(column=>column.id),runs.props.cards],[[de('maintenancePage.col.started'),de('maintenancePage.col.duration'),de('maintenancePage.col.trigger'),de('maintenancePage.col.status'),de('maintenancePage.col.result')],['started'],true],'Started (sortable), Duration, Started by, Status, Result; cards on a phone');
 check([cellText(ui,runs,'duration',runs.props.rows[0]),cellText(ui,runs,'trigger',runs.props.rows[0])],['1 min 5 s',de('maintenancePage.trigger.schedule')],'the duration and the trigger moved into the runs table');
 check(cellText(ui,runs,'result',runs.props.rows[0]).includes(de('maintenancePage.historySummary',{audit:'15',jobs:'4',transfers:'5'})),true,'the short result summary');
 runs.props.onSort({column:'started',direction:'asc'});ui.render();
 check(ui.runsTable().props.sort,{column:'started',direction:'asc'},'a press on Started sorts');

 // Area table.
 const areas=ui.areaTable();
 check([areas.props.entranceId,areas.props.cards,areas.props.variant],['maintenance-areas',true,'flush'],'the area DataTable rises once, cards on a phone');
 check(areas.props.columns.map(column=>[column.id,column.label,!!column.primary,column.hideBelow??null]),[
  ['area',de('maintenancePage.col.area'),true,null],['keptFor',de('maintenancePage.col.keptFor'),false,null],['setBy',de('maintenancePage.col.setBy'),false,null],
  ['size',de('maintenancePage.col.size'),false,null],['entries',de('maintenancePage.col.entries'),false,1280],['lastRun',de('maintenancePage.col.lastRun'),false,null],
 ],'Area (primary), Kept for, Set by, Size, Entries (hidden below 1280 px), Last run');
 check(areas.props.rows.map(item=>item.id),['audit','jobs','jobOutputs','assistantScripts','softwareChanges','alerts','notifications','integrityEvents','transfers'],'the rows in order, no customer row without customers of their own retention');
 const auditRow=areas.props.rows[0];
 check([cellText(ui,areas,'keptFor',auditRow),cellText(ui,areas,'lastRun',auditRow),cellText(ui,areas,'entries',auditRow)],['30 Tage',de('maintenancePage.result.deleted',{count:'12'}),'10'],'audit: kept, last run, entries');
 const size=ui.expand(areas.props.columns.find(column=>column.id==='size').cell(auditRow));
 const meter=[size.props.children].flat(Infinity).find(child=>child?.type==='Meter');
 check([meter.props.size,meter.props.value,meter.props.label,meter.props.warning>100,meter.props.critical>100],['sm',1,de('maintenancePage.sizeShare',{share:'1 %'}),true,true],'a small meter shows the share of the database and never warns');
 const assistant=ui.expand(areas.props.columns.find(column=>column.id==='size').cell(areas.props.rows[3]));
 check([[assistant.props.children].flat(Infinity).some(child=>child?.type==='Meter'),textOf(assistant)],[false,'—'],'no size: "—" without a meter');
 const setBy=ui.expand(areas.props.columns.find(column=>column.id==='setBy').cell(areas.props.rows[4]));
 const rich=[setBy.props.children].flat().find(child=>child?.type==='RichText');
 check([rich.props.text,rich.props.parts.variable.props.className,textOf(rich.props.parts.variable)],[de('maintenancePage.setBy.defaultEnv'),'mono','SOFTWARE_CHANGE_RETENTION_DAYS'],'the variable in Set by renders in .mono');
 check(/@keyframes|#[0-9a-f]{3,6}\b|rgba?\(|box-shadow|border-radius/i.test(cssSource),false,'the stylesheet adds no keyframes, colors, shadows or radii');
 const pixels=[...cssSource.replace(/font-size: \d+px/g,'').replace(/ 1px solid/g,'').matchAll(/(\d+)px/g)].map(match=>Number(match[1]));
 check([pixels.length>0,pixels.filter(value=>value%4)],[true,[]],'spacing on the 4px grid (borders and font sizes aside)');

 ui=harness({get:()=>{throw new Error('offline');}});await ui.settle();
 const page=ui.find(node=>node.type==='SettingsPage');
 check([page.props.loading,page.props.loadError,typeof page.props.onRetry],[false,de('maintenancePage.loadError'),'function'],'a load error is the SettingsPage loadError (LoadFailed with Try again)');
 page.props.onRetry();await ui.settle();
 check(ui.calls.map(call=>call.url),['/api/maintenance','/api/maintenance'],'Try again repeats the GET');
}

// ---- The customer row, the KPI omission, no runs, a failed run, refresh error ----------
{
 let ui=harness({get:()=>viewOf({customerRetention:{count:2,minDays:7,maxDays:400}})});await ui.settle();
 const customer=ui.areaTable().props.rows[1];
 check([customer.id,cellText(ui,ui.areaTable(),'keptFor',customer),cellText(ui,ui.areaTable(),'size',customer),cellText(ui,ui.areaTable(),'lastRun',customer)],['customerAudit','7–400 Tage','—',de('maintenancePage.result.deletedMore',{count:'3'})],'the customer row with the range and the sum of the customer passes');
 const parts=ui.expand(ui.areaTable().props.columns.find(column=>column.id==='setBy').cell(customer));
 const customersLink=[parts.props.children].flat().find(child=>child?.type==='RichText').props.parts.customers;
 check([customersLink.type,customersLink.props.href,textOf(customersLink)],['a','#settings/customers',de('nav.settings.customers')],'"Per customer, in Customers" links to Settings → Customers');

 ui=harness({get:()=>viewOf({history:[],status:{lastSuccessAt:null,nextRunAt:null,stale:true},storage:{databaseBytes:null,transferObjectBytes:null}})});await ui.settle();
 check(ui.text().includes(de('maintenancePage.neverRun')),true,'no runs: the never-run sentence in the cleanup card');
 check([ui.find(node=>node.type==='Disclosure'),ui.find(node=>node.type==='StatusPill')],[undefined,undefined],'no runs: no disclosure and no state pill');
 check(ui.kpis().map(kpi=>kpi.props.value),[null,null,null],'null values and no finished run: KpiRow leaves every tile out');
 check(ui.find(node=>node.type==='Facts').props.items.map(item=>[item.id,item.value]),[['nextRun','—'],['dailyRun','03:00 (UTC)']],'Next run is "—" with the scheduler off');

 const failed=run(1,{status:'failed',error:'serverMessage.maintenance.transfersFailed',trigger:'manual',requestedBy:'owner@example.test'});
 ui=harness({get:()=>viewOf({history:[failed,run(2)]})});await ui.settle();
 const danger=ui.find(node=>node.type==='Notice'&&node.props.tone==='danger');
 check(textOf(danger.props.children),de('serverMessage.maintenance.transfersFailed'),'a failed last run: one danger notice with only the reason');
 check(ui.find(node=>node.type==='StatusPill')?.props.kind,'critical','the failed pill');
 check(ui.cards()[0].props.iconTone,'danger','the card tile turns danger');
 check(ui.find(node=>node.type==='Facts').props.items.map(item=>item.id),['lastRun','nextRun','dailyRun','lastSuccess'],'Last success shows after a failed run');
 check(ui.kpis()[2].props.tone,'critical','the deleted tile is critical after a failed run');
 check(ui.text().includes('serverMessage.'),false,'never the key itself');
 const errorLine=ui.expand(ui.runsTable().props.columns.find(column=>column.id==='result').cell(failed));
 check([errorLine.props.children].flat().filter(Boolean).map(child=>child.type),['span','small'],'a failed history row shows its reason on a second, muted line');
 check(cellText(ui,ui.runsTable(),'trigger',failed),de('maintenancePage.trigger.manual',{name:'owner@example.test'}),'Started by names the account');
 // Every reason in the notice and in the history result, in German and English; an unknown value shows the internal text.
 const en=(key,params)=>translate('en',key,params);
 for(const key of ['retentionInvalid','lockLost','lockExpired','transfersFailed','internal'].map(reason=>`serverMessage.maintenance.${reason}`)){
  const page=harness({get:()=>viewOf({history:[run(1,{status:'failed',error:key})]})});await page.settle();
  const notice=page.find(node=>node.type==='Notice'&&node.props.tone==='danger');
  check([textOf(notice.props.children),cellText(page,page.runsTable(),'result',page.runsTable().props.rows[0]).endsWith(de(key))],[de(key),true],`${key}: the German text in the notice and the history row`);
  check([page.module.runErrorText(key,en),de(key)!==en(key)],[en(key),true],`${key}: the English text`);
 }
 for(const raw of ['connect ECONNREFUSED 10.0.0.5:5432','serverMessage.maintenance.bogus','apiError.maintenance.running','']){
  const page=harness({get:()=>viewOf({history:[run(1,{status:'failed',error:raw})]})});await page.settle();
  const notice=page.find(node=>node.type==='Notice'&&node.props.tone==='danger');
  check([textOf(notice.props.children),raw?page.text().includes(raw):false],[de('serverMessage.maintenance.internal'),false],`${JSON.stringify(raw)}: the internal text, no raw text`);
  check(page.module.runErrorText(raw,en),en('serverMessage.maintenance.internal'),`${JSON.stringify(raw)}: runErrorText falls back to internal`);
 }

 // A running last run: Last success shows; the newest finished run fills the KPI tile and the table.
 const running={...run(0),finishedAt:null,status:'running',trigger:'manual',requestedBy:'owner@example.test',result:null};
 ui=harness({get:()=>viewOf({history:[running,run(1)],status:{running:true}})});await ui.settle();
 check(ui.find(node=>node.type==='Facts').props.items.map(item=>item.id),['lastRun','nextRun','dailyRun','lastSuccess'],'Last success shows while a run is active');
 check([ui.kpis()[2].props.value,cellText(ui,ui.areaTable(),'lastRun',ui.areaTable().props.rows[0])],[33,de('maintenancePage.result.deleted',{count:'12'})],'the running run is skipped for the deleted figures');

 // A refresh error keeps the last data and says so.
 let fail=false;ui=harness({get:()=>{if(fail)throw new Error('offline');return viewOf({status:{running:true}});}});await ui.settle();
 fail=true;ui.intervals.find(entry=>!entry.cleared&&entry.ms===5000).fn();await ui.settle();
 check(ui.find(node=>node.type==='SettingsPage').props.loadError,`${de('maintenancePage.loadError')} ${de('notifications.staleData')}`,'a refresh error ends with the stale-data note');
 check(!!ui.areaTable()&&!!ui.runsTable()&&ui.kpis().length===3,true,'the last data stays');
}

// ---- Run now: blocked reasons, start, polling and the end toast -------------------
{
 let ui=harness({get:()=>viewOf({status:{running:true}})});await ui.settle();
 check(ui.runNow().props.blocked,de('maintenancePage.blockedRunning'),'blocked while a run is active');
 check(ui.intervals.filter(entry=>!entry.cleared).map(entry=>entry.ms),[5000],'the page polls every 5 seconds while a run is active');
 check(/sdx-maintenance-state[^{]*\{[^}]*transition: color/.test(cssSource)&&/prefers-reduced-motion/.test(cssSource),true,'the state pill fades its color, not under reduced motion');
 ui=harness({demo:true});await ui.settle();
 check([ui.runNow().props.blocked,ui.primary().props.blocked,ui.changeSchedule().props.blocked],[undefined,undefined,undefined],'demo mode keeps Run now and both changes');
 check(ui.calls.map(call=>call.url),['/api/maintenance'],'demo mode shows the real installation data');
 ui=harness({viewer:{id:'tech',label:'tech',permissions:['view']}});await ui.settle();
 check([ui.runNow().props.blocked,ui.primary().props.blocked,ui.changeSchedule().props.blocked],Array(3).fill(de('maintenancePage.error.ownerOnly')),'a viewer without the Owner right is blocked with the reason');
 ui.primary().props.onClick();ui.render();
 check(ui.drawerOf('retention').props.open,false,'a blocked primary opens nothing');

 let state='idle';
 const runningRun={...run(0),finishedAt:null,status:'running',trigger:'manual',requestedBy:'owner@example.test',result:null};
 ui=harness({get:()=>state==='idle'?viewOf():state==='running'?viewOf({history:[{...runningRun,id:7},run(1)],status:{running:true}}):viewOf({history:[{...run(0),id:7,trigger:'manual'},run(1)]}),
  post:payload=>{if(payload.action==='run'){state='running';return {runId:7};}throw new Error('unexpected');}});await ui.settle();
 ui.runNow().props.onClick();ui.render();
 check(ui.runNow().props.loading,true,'Run now shows its loading state while the POST runs');
 await ui.settle();
 check(ui.posts(),[{action:'run'}],'Run now posts the run action without a proof');
 check(ui.dialog().props.open,false,'no step-up for Run now');
 check(ui.toasts,[de('maintenancePage.runStarted')],'started toast');
 check(ui.runNow().props.blocked,de('maintenancePage.blockedRunning'),'the button is blocked while the run is active');
 check(ui.find(node=>node.type==='StatusPill').props.kind,'waiting','the pill turns to running');
 const poll=ui.intervals.find(entry=>!entry.cleared&&entry.ms===5000);
 check(!!poll,true,'polling starts');
 state='done';poll.fn();await ui.settle();
 check(ui.toasts,[de('maintenancePage.runStarted'),de('maintenancePage.runSucceeded')],'the one-time end toast of the run started here');
 check(poll.cleared,true,'polling stops when the run is done');
 check(ui.find(node=>node.type==='KpiRow').props.entranceId,'maintenance-kpis','the poll re-renders with the same entrance id, which the kit claims once per page load');
 state='idle';
 for(const [code,key] of [['MAINTENANCE_RUNNING','maintenancePage.error.running'],['MAINTENANCE_MIGRATIONS_PENDING','maintenancePage.error.migrations']]){
  ui=harness({post:()=>{throw new ApiError('Serverseitiger Text',409,code);}});await ui.settle();
  ui.runNow().props.onClick();await ui.settle();
  check(ui.toasts,['error:'+de(key)],`${code}: the catalog text, not the server text`);
 }
 let failState='idle';
 ui=harness({get:()=>failState==='idle'?viewOf():failState==='running'?viewOf({history:[{...runningRun,id:9}],status:{running:true}}):viewOf({history:[{...run(0),id:9,status:'failed',error:'x'}]}),post:()=>{failState='running';return {runId:9};}});await ui.settle();
 ui.runNow().props.onClick();await ui.settle();
 failState='failed';ui.intervals.find(entry=>!entry.cleared&&entry.ms===5000).fn();await ui.settle();
 check(ui.toasts,[de('maintenancePage.runStarted'),'error:'+de('maintenancePage.runFailed')],'the failed toast of the run started here');
}

// ---- The retention drawer: header primary, fields, step-up, toasts -------------------
{
 let ui=harness({get:()=>viewOf({settings:{auditDays:15,jobDays:null,source:{auditDays:'env',jobDays:'env'}},envInvalid:{jobDays:true}})});await ui.settle();
 check([ui.drawerOf('retention').props.open,ui.drawerOf('schedule').props.open],[false,false],'both drawers start closed');
 ui.primary().props.onClick();ui.render();
 const drawer=ui.drawerOf('retention');
 check([drawer.props.open,drawer.props.icon,drawer.props.description,drawer.props.dirty],[true,'Archive',de('maintenancePage.retentionDrawerDescription'),false],'the header primary opens "Change retention" with its one description');
 check([ui.fieldOf('auditDays').props.label,ui.fieldOf('jobDays').props.label],[de('maintenancePage.auditDays'),de('maintenancePage.jobDays')],'Audit entries (days) and Jobs and job output (days)');
 check([ui.input('auditDays').props.autoFocus,ui.input('jobDays').props.autoFocus,ui.input('auditDays').props.type,ui.input('auditDays').props.min,ui.input('auditDays').props.max],[true,false,'number',1,3650],'the first field takes focus');
 const hint=ui.fieldOf('auditDays').props.hint;
 check([hint.type,hint.props.text,textOf(hint.props.parts.variable),hint.props.parts.variable.props.className],['RichText',de('maintenancePage.sourceEnv'),'AUDIT_RETENTION_DAYS','mono'],'an env start value: the one field hint, the variable in .mono');
 check([ui.input('jobDays').props.value,ui.fieldError('jobDays'),ui.fieldError('auditDays')],['',de('maintenancePage.error.retention'),null],'an invalid start value shows as an empty field with its error');
 const footer=[drawer.props.footer.props.children].flat();
 check([footer[0].type,footer[1].props.variant,footer[1].props.type,footer[1].props.form,footer[1].props.children],['DrawerCancel','primary','submit','sdx-maintenance-retention-form',de('common.save')],'the footer: Cancel, then the primary Save submit');
 check(ui.saveOf('retention').props.blocked,de('common.noChanges'),'Save waits for a change');

 // The schedule drawer: blocked while a retention value is invalid.
 ui.drawerOf('retention').props.onClose();ui.render();
 ui.changeSchedule().props.onClick();ui.render();
 check([ui.drawerOf('schedule').props.open,ui.drawerOf('retention').props.open],[true,false],'Change schedule… opens "Change schedule"');
 ui.change('runAt','05:00');
 check([ui.drawerOf('schedule').props.dirty,ui.saveOf('schedule').props.blocked],[true,de('maintenancePage.blockedRetentionInvalid')],'a null retention blocks the schedule Save with its reason');
 ui.submit('schedule');await ui.settle();
 check([ui.posts(),ui.dialog().props.open],[[],false],'a blocked Save sends nothing');

 ui=harness();await ui.settle();
 ui.primary().props.onClick();ui.render();
 ui.change('auditDays','0');ui.change('jobDays','3651');
 check([ui.drawerOf('retention').props.dirty,ui.fieldError('auditDays'),ui.fieldError('jobDays')],[true,null,null],'dirty after a change; no field errors before the first submit');
 ui.submit('retention');
 check([ui.fieldError('auditDays'),ui.fieldError('jobDays')],[de('maintenancePage.error.retention'),de('maintenancePage.error.retention')],'field errors after the submit');
 check([ui.posts(),ui.dialog().props.open],[[],false],'an invalid form sends nothing and asks for no MFA');
 for(const value of ['1.5','']){ui.change('auditDays',value);check(ui.fieldError('auditDays'),de('maintenancePage.error.retention'),`audit days ${JSON.stringify(value)}`);}

 let attempts=0;
 const reply=payload=>viewOf({settings:{auditDays:payload.auditDays,jobDays:payload.jobDays,runAt:payload.runAt,timeZone:payload.timeZone,revision:5,source:{auditDays:'stored',jobDays:'stored'}}});
 ui=harness({get:()=>viewOf({settings:{runAt:'02:15',timeZone:'Europe/Berlin'}}),post:payload=>{attempts++;if(attempts===1)throw new ApiError('abgelaufen',403,'MFA_STEP_UP_REQUIRED');return reply(payload);}});await ui.settle();
 ui.primary().props.onClick();ui.render();
 ui.change('auditDays','10');ui.submit('retention');
 check([ui.dialog().props.open,ui.posts(),ui.saveOf('retention').props.blocked],[true,[],de('kit.busy')],'a shorter retention: Save opens the MFA confirmation first (useStepUp) and sends nothing yet');
 ui.dialog().props.onClose();ui.render();await ui.settle();
 check([ui.posts(),ui.input('auditDays').props.value,ui.drawerOf('retention').props.open],[[],'10',true],'cancelling sends nothing and keeps the input and the drawer');
 ui.submit('retention');ui.verify({managementToken:'used'});await ui.settle();
 check(ui.dialog().props.open,true,'MFA_STEP_UP_REQUIRED reopens the dialog');
 ui.verify({managementToken:'fresh'});await ui.settle();
 const payload={action:'set',auditDays:10,jobDays:30,runAt:'02:15',timeZone:'Europe/Berlin',revision:4};
 check(ui.posts(),[{...payload,managementToken:'used'},{...payload,managementToken:'fresh'}],'the full payload: the drawer values plus the current schedule, resent once with the new proof');
 check([ui.toasts,ui.drawerOf('retention').props.open],[[de('maintenancePage.retentionSaved')],false],'"Retention saved." and the drawer closes');
 check(cellText(ui,ui.areaTable(),'keptFor',ui.areaTable().props.rows[0]),'10 Tage','the view updates');

 // A longer retention deletes nothing: Save goes out at once, without the dialog.
 {
  const longer=harness({get:()=>viewOf({settings:{auditDays:30,jobDays:30}}),post:payload=>viewOf({settings:{auditDays:payload.auditDays,jobDays:payload.jobDays,runAt:payload.runAt,timeZone:payload.timeZone,revision:5,source:{auditDays:'stored',jobDays:'stored'}}})});await longer.settle();
  longer.primary().props.onClick();longer.render();
  longer.change('auditDays','60');longer.submit('retention');
  check(longer.dialog().props.open,false,'a longer retention opens no MFA dialog');
  await longer.settle();
  check([longer.posts().length,longer.posts()[0]?.managementToken,longer.toasts],[1,undefined,[de('maintenancePage.retentionSaved')]],'one request without a managementToken');
  const needs=model.maintenanceSaveNeedsStepUp,set=(auditDays,jobDays)=>({action:'set',auditDays,jobDays,runAt:'03:00',timeZone:'UTC',revision:1});
  check([needs({auditDays:30,jobDays:30},set(30,30)),needs({auditDays:30,jobDays:30},set(60,30)),needs({auditDays:30,jobDays:30},set(10,30)),needs({auditDays:30,jobDays:30},set(30,7)),needs({auditDays:null,jobDays:30},set(30,30)),needs(undefined,set(1,1)),needs({auditDays:30,jobDays:30},{action:'run'})],
   [false,false,true,true,true,false,false],'the page asks first only for a shorter retention; an invalid start value counts as no limit; without loaded settings the server decides');
 }
 // Server errors: the catalog text as a toast, the drawer stays open with the input.
 for(const [code,key] of Object.entries({MAINTENANCE_RETENTION_INVALID:'maintenancePage.error.retention',MAINTENANCE_TIME_INVALID:'maintenancePage.error.time',MAINTENANCE_TIME_ZONE_INVALID:'maintenancePage.error.timeZone',MAINTENANCE_SETTINGS_CONFLICT:'maintenancePage.error.conflict',MAINTENANCE_RUNNING:'maintenancePage.error.running',MAINTENANCE_MIGRATIONS_PENDING:'maintenancePage.error.migrations',MAINTENANCE_OWNER_ONLY:'maintenancePage.error.ownerOnly'})){
  check(ui.module.maintenanceFailure(new ApiError('Servertext',400,code)),de(key),`${code} maps to its catalog text`);
  check(Object.hasOwn(codes.errorCatalog,code),true,`${code} is in the error catalog`);
 }
 check(ui.module.maintenanceFailure(new ApiError('Ein anderer Fehler.',500,'INTERNAL_ERROR')),'Ein anderer Fehler.','other codes show the shared message');
 ui=harness({post:()=>{throw new ApiError('Servertext',409,'MAINTENANCE_SETTINGS_CONFLICT');}});await ui.settle();
 ui.primary().props.onClick();ui.render();
 ui.change('jobDays','14');ui.submit('retention');ui.verify({managementToken:'proof'});await ui.settle();
 check([ui.toasts,ui.input('jobDays').props.value,ui.drawerOf('retention').props.open],[['error:'+de('maintenancePage.error.conflict')],'14',true],'a conflict shows the catalog text, keeps the input and the drawer');
}

// ---- The schedule drawer ----------------------------------------------------------------
{
 const ui=harness({get:()=>viewOf({settings:{auditDays:20,jobDays:40}}),post:payload=>viewOf({settings:{auditDays:payload.auditDays,jobDays:payload.jobDays,runAt:payload.runAt,timeZone:payload.timeZone,revision:5,source:{auditDays:'stored',jobDays:'stored'}}})});await ui.settle();
 ui.changeSchedule().props.onClick();ui.render();
 const drawer=ui.drawerOf('schedule');
 check([drawer.props.icon,drawer.props.description,ui.input('runAt').props.type,ui.input('runAt').props.autoFocus,ui.input('timeZone').type],['CalendarClock',de('maintenancePage.scheduleDrawerDescription'),'time',true,'Select'],'"Change schedule": the time input takes focus, the time zone is the kit Select');
 check([ui.fieldOf('runAt').props.hint,ui.fieldOf('timeZone').props.hint],[undefined,undefined],'no field hints: the drawer description carries the hint');
 check([ui.input('timeZone').props.children].flat().some(option=>option.props.value==='UTC'),true,'UTC is in the zone list');
 ui.change('runAt','24:00');ui.change('timeZone','Mars/Base');ui.submit('schedule');
 check([ui.fieldError('runAt'),ui.fieldError('timeZone')],[de('maintenancePage.error.time'),de('maintenancePage.error.timeZone')],'field errors after the submit');
 check(ui.posts(),[],'nothing sent');
 ui.change('runAt','04:30');ui.change('timeZone','Europe/Berlin');ui.submit('schedule');
 check(ui.dialog().props.open,false,'saving the schedule asks for no MFA: run time and time zone delete nothing');
 await ui.settle();
 check(ui.posts(),[{action:'set',auditDays:20,jobDays:40,runAt:'04:30',timeZone:'Europe/Berlin',revision:4}],'the full payload: the schedule plus the current retention, without a managementToken');
 check([ui.toasts,ui.drawerOf('schedule').props.open],[[de('maintenancePage.scheduleSaved')],false],'"Schedule saved." and the drawer closes');
 check(ui.find(node=>node.type==='Facts').props.items.find(item=>item.id==='dailyRun').value,'04:30 (Europe/Berlin)','the Daily run fact updates');
 check([/needsStepUp:payload=>maintenanceSaveNeedsStepUp\(view\?\.settings,payload\)/.test(pageSource)&&/maintenanceSetNeedsStepUp\(/.test(fs.readFileSync('ui/settings/retention-model.ts','utf8')),/useStepUp</.test(pageSource),/pending=useRef|stepUpRetry\(/.test(pageSource)],[true,true,false],'the page reads the classification from lib/step-up.ts through useStepUp; no local pending logic');
 check([/sdx-loading|common\.reload|maintenancePage\.(retry|discard|noChanges|save)'|common\.demoBlocked/.test(pageSource)],[false],'no classic loading, page-own retry or form keys, no demo block');
 const en=fs.readFileSync('lib/i18n/messages/en.ts','utf8'),de2=fs.readFileSync('lib/i18n/messages/de.ts','utf8');
 check([en,de2].some(catalog=>/'maintenancePage\.(retry|discard|noChanges|save|loading|staleData|statusTitle|statusHint|formTitle|formHint|errorLabel|saved|historyHint|historyEmptyTitle|historyEmptyText|auditDaysHint|jobDaysHint|runAtHint|timeZoneHint|usage\.\w+|area\.usageReport|area\.customerAudit|fact\.(started|finished|duration|trigger))'/.test(catalog)),false,'the dropped keys are gone from both catalogs');
}

// ---- Navigation, palette, help and the capability rule ----------------------------
await import('../../support/register.mjs');
const navModel=await import('../../../ui/shell/nav-model.ts');
const settingsIds=navModel.navigatorPages('settings',{viewer:{permissions:['*']}}).map(node=>node.section);
{
 check(navPage(navModel,'retention'),{id:'retention',label:'Datenaufbewahrung',description:'Lege fest, wie lange Nodiverna Daten aufbewahrt und wann die tägliche Bereinigung läuft.',icon:'Wrench',group:de('nav.settings.groupSystem')},'the navigator entry Data retention in the System group with the Wrench icon');
 check([settingsIds.indexOf('retention'),settingsIds.indexOf('audit'),settingsIds.indexOf('usage-data')],[settingsIds.length-3,settingsIds.length-2,settingsIds.length-1],'Data retention, Audit log and Usage data end the navigator (group System)');
 check([navModel.navNode('settings.retention').palette.keywordsKey,navModel.navNode('settings.retention').palette.hint],['maintenancePage.paletteKeywords',['palette.hint.settings']],'the palette entry has its keywords');
 check(de('maintenancePage.paletteKeywords'),'wartung aufbewahrung audit aufträge bereinigung zeitplan lauf verlauf größe datenbank speicher maintenance retention','German keywords with the size words');
 check(translate('en','maintenancePage.paletteKeywords').includes('size database storage'),true,'English keywords with the size words');
 for(const [viewer,expected] of [[owner,true],[{permissions:['view','portal.users.manage']},false],[{permissions:[]},false]])check(capabilities.canOpenAccessSection(viewer,'retention'),expected,`canOpenAccessSection retention: ${viewer.permissions.join(',')}`);
 check([route.consoleRouteHash({view:'settings',page:'retention'}),route.parseConsoleRoute('#administration/maintenance').page],['#settings/retention','retention'],'the hash route and the old link');
 {const ids=navModel.navigatorPages('settings',{viewer:{permissions:['*']}}).map(node=>node.id);check(ids.slice(ids.indexOf('settings.retention')-1,ids.indexOf('settings.retention')+1),['settings.agent-troubleshooting','settings.retention'],'Data retention opens the System group after the agent pages');}
 const help=fs.readFileSync('ui/shell/help-panel.tsx','utf8');
 check([navModel.helpTopicFor({view:'settings',page:'retention'}),/retention:maintenanceTopic/.test(help)&&/file:'docs\/self-hosting\.md#maintenance'/.test(help)],['retention',true],'the help topic (the page name) with the docs link');
 check([de('help.maintenance.title'),de('help.maintenance.tip3')],['Datenaufbewahrung','Kann eine Bereinigung nicht alles löschen, startet eine Minute nach ihrem Ende eine weitere.'],'help texts');
 check(/case 'retention':return <MaintenancePanel viewer=\{viewer\} frame=\{frame\}\/>;/.test(fs.readFileSync('ui/settings/access-workspace.tsx','utf8')),true,'the workspace renders the panel behind the capability check');
}
console.log(`PASS ${checks} data retention page checks: SettingsPage loading and error, KPI row and omission, two cards without meta hints, cleanup facts and failure notice, runs in a closed disclosure, area table, both drawers with step-up and toasts, field errors, Run now states and polling, error codes, navigation, palette and help.`);
