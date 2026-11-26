// The Automation pages on the kit (ui/automation/automation-workspace.tsx and its parts), run on hook cells
// (tests/support/panel-harness.mjs) in German: the scope helpers, the first-load Skeleton, the routed tab bar with
// its counts, the one page primary (blocked by right, sample devices and the catalog lock, left out while an editor
// is open), the tab contents, "Create template" and "Assign template" as Drawers that send the classic bodies through
// useStepUp (a step-up code resends the same request once, cancelling sends nothing), "Remove assignment" and
// "Start runbook" in the kit ConfirmDialog, the Schedules union with its Source column, Device status with 50 rows
// per page and Unavailable for sample devices. RunbookPanel and DesiredStatePanel are stubs here; they have their own
// view tests.
import assert from 'node:assert/strict';
import {panelHarness} from '../../support/panel-harness.mjs';
import {de,translateModule} from '../../support/i18n-stubs.mjs';
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const clone=value=>structuredClone(value);
const text=html=>html.replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#x27;/g,"'").replace(/\s+/g,' ').trim();
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};
class ApiError extends Error{constructor(message,status=403,code){super(message);this.status=status;this.code=code;}}

const groups=[{id:'parent',name:'Produktion',parentId:null,depth:0},{id:'child',name:'Webserver',parentId:'parent',depth:1},{id:'peer',name:'Testlabor',parentId:null,depth:0}];
const rights=['view','drift.manage','desired.manage','runbooks.manage','runbooks.execute'];
const servers=[{id:'one',name:'WEB-001',permissions:rights,groups:[groups[0],groups[1]],groupName:'Webserver',snapshot:{hostname:'web.internal'}},{id:'two',name:'LAB-002',permissions:rights,groups:[groups[0]],groupName:'Produktion',snapshot:null}];
const baseData={templates:[
 {id:'drift',kind:'drift',slot:'default',name:'Web-Baseline',createdAt:1,payload:{hasBaseline:true}},
 {id:'desired',kind:'desired',slot:'default',name:'Web-Konfiguration',createdAt:1,payload:{intervalSeconds:900}},
 {id:'runbook',kind:'runbook',slot:'book',name:'Wartung',createdAt:1,payload:{recurrence:null}},
 {id:'nightly',kind:'runbook',slot:'night',name:'Nachtlauf',createdAt:1,payload:{recurrence:{kind:'interval',minutes:60}}},
],assignments:[
 {id:'assignment',kind:'drift',slot:'default',scopeType:'group',scopeId:'parent',templateId:'drift',templateName:'Web-Baseline',disabled:false,createdAt:1,nextDue:null},
 {id:'manual',kind:'runbook',slot:'book',scopeType:'device',scopeId:'two',templateId:'runbook',templateName:'Wartung',disabled:false,createdAt:1,nextDue:null},
 {id:'night-a',kind:'runbook',slot:'night',scopeType:'group',scopeId:'child',templateId:'nightly',templateName:'Nachtlauf',disabled:false,createdAt:1,nextDue:null},
],groups,states:[{serverId:'one',kind:'drift',slot:'default',assignmentId:'assignment',status:'applied',message:'',updatedAt:1}]};
const owner={id:'owner',label:'owner@example.test',permissions:['*']};

const calls=[];let get=()=>clone(baseData),post=()=>({});
const shared={api:(url,body)=>{calls.push({url,body});return Promise.resolve().then(()=>body?post(body):get(url));},ApiError,message:error=>error.message,permitted:(server,viewer,right)=>viewer.permissions?.includes('*')===true||server.permissions?.includes(right)===true,stamp:value=>value?'T'+value:'–'};
function RunbookPanel(){return null;}
function DesiredStatePanel(){return null;}
function MfaStepUp(){return null;}
const stubs={'@/ui/base/api':shared,'@/ui/session/mfa-step-up':{MfaStepUp},'@/ui/automation/runbook-panel':{__esModule:true,default:RunbookPanel},'@/ui/automation/desired-state-panel':{__esModule:true,default:DesiredStatePanel}};
const harness=panelHarness({hooked:['ui/automation/automation-workspace.tsx','ui/session/step-up-retry.ts','ui/shell/page-frame.ts'],stubs});
const workspace=harness.load('ui/automation/automation-workspace.tsx'),Page=workspace.default;
const {AutomationAssignments}=harness.load('ui/automation/automation-assignments.tsx');
const {CreateTemplateDrawer,AssignTemplateDrawer}=harness.load('ui/automation/automation-template-drawers.tsx');
const {AutomationDeviceStatus,ReferenceDevices}=harness.load('ui/automation/automation-device-status.tsx');
const {ConfirmDialog}=harness.load('ui/kit/confirm-dialog.tsx'),{Tabs}=harness.load('ui/kit/tabs.tsx'),kit=harness.load('ui/kit/kit.tsx');
const posts=()=>calls.filter(call=>call.body);
const of=(tree,type)=>harness.walk(tree).find(node=>node.type===type);
const openDialog=tree=>harness.walk(tree).find(node=>node.type===ConfirmDialog&&node.props.open);

// The console frame (ui/shell/page-frame.ts): header records the primary and counts the calls, onTab records the tabs.
let props,tabs=[];const shown={primary:undefined,headers:0};
const frameOf=(tab,refresh=0)=>({header:primary=>{shown.primary=primary;shown.headers++;return null;},refresh,tab,onTab:next=>tabs.push(next)});
const base={page:'drift',servers,viewer:owner,demo:false,runFocus:null,onOpenDevice:()=>{}};
const render=()=>{shown.headers=0;return harness.tree(Page,props);};
const mount=async({tab='assignments',...overrides}={},reply=()=>clone(baseData))=>{harness.reset();calls.length=0;tabs=[];get=reply;post=()=>({});props={...base,frame:frameOf(tab),...overrides};render();await harness.flush();return render();};

// ---- The scope helpers stay exported ----
check(workspace.automationGroupPath(groups[1],groups),'Produktion / Webserver','nested scope path is clear');
check(workspace.effectiveDeviceAssignments(servers[0],baseData,'drift')[0].scopeId,'parent','device inherits parent scope through membership');
const overrides={...clone(baseData),assignments:[...clone(baseData.assignments),{...baseData.assignments[0],id:'child-a',scopeId:'child',templateId:'child-template',templateName:'Child'},{...baseData.assignments[0],id:'device-a',scopeType:'device',scopeId:'one',templateId:'direct',templateName:'Direct'}]};
check(workspace.effectiveDeviceAssignments(servers[0],overrides,'drift')[0].templateId,'direct','device choice beats descendant and root choices');
const conflictData={...clone(baseData),assignments:[...clone(baseData.assignments),{...baseData.assignments[0],id:'peer-a',scopeId:'peer',templateId:'other'}]};
check(workspace.effectiveDeviceAssignments({...servers[0],groups:[groups[0],groups[2]]},conflictData,'drift')[0].conflict,true,'peer contradictions are explicit conflicts');

// ---- First load: a Skeleton in the tab's shape, no mutation ----
{
 const wait=deferred();harness.reset();calls.length=0;get=()=>wait.promise;props={...base,frame:frameOf('assignments')};render();await harness.flush();let tree=render();
 const skeleton=harness.walk(tree).find(node=>node.type===kit.Skeleton);
 check([skeleton?.props.variant,skeleton?.props.after],['cards',15000],'the first load shows a cards Skeleton with the slow-load retry');
 check(posts().length,0,'rendering never mutates');
 wait.resolve(clone(baseData));await harness.settle();tree=render();
 ok(!harness.walk(tree).some(node=>node.type===kit.Skeleton)&&of(tree,AutomationAssignments),'the data replaces the Skeleton');
 // A failed first load: LoadFailed with "Erneut versuchen"; the retry repeats the request.
 harness.reset();calls.length=0;get=()=>Promise.reject(new Error('Portal nicht erreichbar'));render();await harness.flush();tree=render();
 const failed=harness.walk(tree).find(node=>node.type===kit.LoadFailed);
 ok(failed?.props.text==='Portal nicht erreichbar'&&!harness.walk(tree).some(node=>node.type===kit.Skeleton),'a failed first load shows LoadFailed instead of the Skeleton');
 get=()=>clone(baseData);failed.props.onRetry();await harness.settle();tree=render();
 ok(of(tree,AutomationAssignments)&&!of(tree,kit.LoadFailed),'the retry loads the data');
 // A failed refresh keeps the loaded data and says so: the polling effect loads again.
 get=()=>Promise.reject(new Error('Portal nicht erreichbar'));
 const polling=[...harness.h.effects.values()].find(effect=>String(effect.callback).includes('15000'));polling.cleanup?.();polling.cleanup=polling.callback();await harness.settle();tree=render();
 check(of(tree,kit.LoadFailed)?.props.text,'Portal nicht erreichbar '+de('console.staleData'),'a failed refresh says that the last loaded state is shown');
 ok(of(tree,AutomationAssignments),'and keeps the loaded data');
}

// ---- The tab bar: routed link tabs, counts after the load, no classic bar ----
{
 let tree=await mount({page:'runbooks',tab:'library'});
 const bar=of(tree,Tabs);
 check([bar.props.variant,bar.props.overflow,bar.props.label],['underline','menu','Ansichten: Runbooks'],'one underline tab bar with the overflow menu');
 check(bar.props.items.map(item=>[item.id,item.label,item.href]),[['library','Runbooks','#automation/runbooks'],['runs','Läufe','#automation/runbooks/runs'],['schedules','Zeitpläne','#automation/runbooks/schedules'],['assignments','Zuweisungen','#automation/runbooks/assignments'],['status','Gerätestatus','#automation/runbooks/status']],'the Runbooks tabs, library first, as links');
 check(bar.props.items.map(item=>item.count),[undefined,undefined,undefined,2,undefined],'before the panel load only Assignments has a count');
 of(tree,RunbookPanel).props.onCounts({runbooks:2,runs:5,schedules:1});tree=render();
 check(of(tree,Tabs).props.items.map(item=>item.count),[2,5,2,2,undefined],'counts: Runbooks, Runs, Schedules of both sources, Assignments; Device status none');
 bar.props.onChange('runs');check(tabs,['runs'],'a tab click changes the route');
 const html=harness.html(Page,props);
 ok(!html.includes('sd-section-tabs')&&!/class="aw-/.test(html)&&!html.includes('panel-heading'),'no classic tab bar, aw- class or classic panel');
 check(harness.walk(tree).filter(node=>node.type===Tabs).length,1,'one tab bar on the page');
 tree=await mount({page:'desired',tab:'history'});
 check(of(tree,Tabs).props.items.map(item=>[item.id,item.label]),[['configurations','Konfigurationen'],['assignments','Zuweisungen'],['status','Gerätestatus'],['history','Historie']],'the Desired State tabs');
 of(tree,DesiredStatePanel).props.onCounts({configs:4,runs:9});tree=render();
 check(of(tree,Tabs).props.items.map(item=>item.count),[4,0,undefined,9],'Desired State counts: Configurations, Assignments, History');
 check(of(tree,DesiredStatePanel).props.view,'history','the panel takes its view from the page tab');
 of(tree,DesiredStatePanel).props.onView('status');check(tabs,['status'],'a view change inside the panel moves the page tab');
 tree=await mount({page:'drift',tab:'reference'});
 check(of(tree,Tabs).props.items.map(item=>[item.id,item.label,item.count]),[['assignments','Zuweisungen',1],['status','Gerätestatus',undefined],['reference','Referenzgeräte',undefined]],'the drift tabs');
}

// ---- The tab contents ----
{
 let tree=await mount({page:'drift',tab:'assignments'});
 const assignments=of(tree,AutomationAssignments);
 check([assignments.props.templates.map(entry=>entry.id),assignments.props.assignments.map(entry=>entry.id),assignments.props.showCreate],[['drift'],['assignment'],false],'drift Assignments: its templates and assignments; the page primary creates templates');
 tree=await mount({page:'drift',tab:'status'});ok(of(tree,AutomationDeviceStatus)?.props.kind==='drift'&&!of(tree,AutomationAssignments),'Device status');
 tree=await mount({page:'drift',tab:'reference'});check(of(tree,ReferenceDevices).props.devices.map(s=>s.id),['one','two'],'Reference devices: the devices with drift.manage');
 tree=await mount({page:'runbooks',tab:'library'});check(of(tree,RunbookPanel).props.view,'runbooks','Runbooks library: the panel in its library view');
 tree=await mount({page:'runbooks',tab:'assignments'});
 check([of(tree,RunbookPanel).props.view,of(tree,AutomationAssignments).props.showCreate],[null,true],'Runbooks Assignments: the panel stays mounted without a view; the Templates card creates templates');
 tree=await mount({page:'desired',tab:'configurations'});check(of(tree,DesiredStatePanel).props.view,'configurations','Desired State Configurations');
 const origin=of(tree,DesiredStatePanel).props.origin(servers[0]);ok(origin,'the Desired State device table gets an Origin cell');
 // Run focus from the job panel: the Runs tab with the device-scoped run.
 tree=await mount({page:'runbooks',tab:'runs',runFocus:{serverId:'one',runId:'run-1',revision:1}});
 check([of(tree,RunbookPanel).props.initialRunId,of(tree,RunbookPanel).props.serverId,of(tree,RunbookPanel).props.view],['run-1','one','runs'],'a focused run opens its output on the Runs tab');
}

// ---- The page primary ----
{
 let tree=await mount({page:'drift',tab:'status'});
 check([shown.primary.props.variant,shown.primary.props.children,shown.primary.props.blocked],['primary','Vorlage erstellen',undefined],'drift: "Vorlage erstellen" in the page header');
 shown.primary.props.onClick();tree=render();check(of(tree,CreateTemplateDrawer).props.open,true,'it opens the Create template drawer on any tab');
 const reader={id:'reader',label:'reader',permissions:[]},readOnly=servers.map(s=>({...s,permissions:['view']}));
 await mount({page:'drift',viewer:reader,servers:readOnly});check(shown.primary.props.blocked,de('drift.blocked.manage'),'without the right: visible and blocked with the reason');
 await mount({page:'desired',tab:'configurations',viewer:reader,servers:readOnly});check([shown.primary.props.children,shown.primary.props.blocked],['Konfiguration erstellen',de('desired.blocked.manage')],'Desired State: "Konfiguration erstellen", blocked with its right');
 await mount({page:'runbooks',tab:'library'},()=>({...clone(baseData),catalog:{separated:true,libraryWritable:false,customers:[]}}));
 ok(shown.primary.props.blocked&&shown.primary.props.blocked!==de('runbooks.blocked.manage'),'the separated catalog lock blocks the primary with its reason');
 tree=await mount({page:'runbooks',tab:'assignments'});
 shown.primary.props.onClick();tree=render();
 check([tabs,of(tree,RunbookPanel).props.createRequest],[['library'],1],'"Runbook erstellen" switches to the library tab and asks the panel for the editor');
 of(tree,RunbookPanel).props.onEditorChange(true);render();check(shown.primary,null,'while the editor is open the page has no primary');
 // Sample devices: one Unavailable, the primary blocked, no request.
 tree=await mount({page:'runbooks',tab:'library',demo:true});
 check([harness.walk(tree).filter(node=>node.type===kit.Unavailable).map(node=>node.props.reason),shown.primary.props.blocked,calls.length],[['demo'],de('kit.unavailable.demo'),0],'demo: one Unavailable, the blocked primary and no request');
 ok(!of(tree,RunbookPanel)&&of(tree,Tabs).props.items.every(item=>item.count===undefined),'demo: no panel and no counts');
}

// ---- Create template and Assign template: Drawers, the classic bodies, useStepUp ----
{
 let tree=await mount({page:'drift',tab:'assignments'});
 of(tree,AutomationAssignments).props.onCreate();tree=render();
 const body={action:'create-template',kind:'drift',name:'Baseline',sourceServerId:'one',includeBaseline:true,versionId:'',intervalSeconds:0,parameters:{},recurrence:null,concurrency:2};
 let attempts=0;post=()=>{attempts++;if(attempts===1)throw new ApiError('MFA bestätigen',403,'MFA_LOGIN_REQUIRED');return {id:'new'};};
 of(tree,CreateTemplateDrawer).props.onSubmit(body);await harness.settle();tree=render();
 check([of(tree,MfaStepUp).props.open,of(tree,CreateTemplateDrawer).props.open,posts().length],[true,true,1],'a step-up code opens MfaStepUp and keeps the drawer');
 of(tree,MfaStepUp).props.onClose();await harness.settle();tree=render();
 check([of(tree,MfaStepUp).props.open,of(tree,CreateTemplateDrawer).props.open,posts().length],[false,true,1],'cancelling sends nothing and keeps the drawer input');
 attempts=0;of(tree,CreateTemplateDrawer).props.onSubmit(body);await harness.settle();tree=render();
 of(tree,MfaStepUp).props.onVerified({managementToken:'proof'});await harness.settle();tree=render();
 check(posts().slice(-2).map(call=>call.body),[body,{...body,managementToken:'proof'}],'after the proof the same request goes out once more');
 ok(harness.toasts.includes(de('automation.templateCreated'))&&!of(tree,CreateTemplateDrawer).props.open,'success: the toast and the drawer closes');
 // Assign: the drawer opens with the row's template; the body is the classic one.
 of(tree,AutomationAssignments).props.onAssign('drift');tree=render();
 check([of(tree,AssignTemplateDrawer).props.open,of(tree,AssignTemplateDrawer).props.initialTemplateId],[true,'drift'],'"Vorlage zuweisen…" opens the Assign drawer with the row template');
 post=()=>({});const assign={action:'assign',templateId:'drift',scopeType:'group',scopeId:'child',disabled:false,confirm:true};
 of(tree,AssignTemplateDrawer).props.onSubmit(assign);await harness.settle();tree=render();
 check(posts().at(-1).body,assign,'the assign body');ok(harness.toasts.includes(de('automation.assignmentSaved'))&&!of(tree,AssignTemplateDrawer).props.open,'the assignment toast and the drawer closes');
 // A failure: toast.error, the drawer stays open.
 of(tree,AutomationAssignments).props.onAssign();tree=render();post=()=>{throw new Error('Bereich geändert');};
 of(tree,AssignTemplateDrawer).props.onSubmit(assign);await harness.settle();tree=render();
 ok(harness.toasts.includes('error:Bereich geändert')&&of(tree,AssignTemplateDrawer).props.open,'a failure shows toast.error and keeps the drawer');
}

// ---- Remove assignment and Start runbook: kit ConfirmDialog, the request only on confirm ----
{
 let tree=await mount({page:'drift',tab:'assignments'});
 of(tree,AutomationAssignments).props.onRemove(baseData.assignments[0]);tree=render();let dialog=openDialog(tree);
 check([dialog.props.tone,dialog.props.title,dialog.props.confirmLabel,dialog.props.lines],['danger',de('automation.removeTitle'),'Zuweisung entfernen',[{label:'Vorlage',value:'Web-Baseline'},{label:'Bereich',value:'Produktion'}]],'remove: danger, the question, the verb and the lines');
 check(posts().length,0,'opening the dialog sends nothing');
 dialog.props.onConfirm();await harness.settle();tree=render();
 check(posts().at(-1).body,{action:'remove-assignment',assignmentId:'assignment',confirm:true},'the remove body');
 ok(harness.toasts.includes('Zuweisung entfernt.')&&!openDialog(tree),'the remove toast and the dialog closes');
 tree=await mount({page:'runbooks',tab:'assignments'});
 of(tree,AutomationAssignments).props.onStart(baseData.assignments[2]);tree=render();dialog=openDialog(tree);
 check([dialog.props.tone??'default',dialog.props.title,dialog.props.confirmLabel,dialog.props.lines],['default','Runbook starten?','Runbook starten',[{label:'Vorlage',value:'Nachtlauf'},{label:'Bereich',value:'Produktion / Webserver'}]],'start: the question, the verb and the lines');
 check(dialog.props.body,de('automation.runDescription',{templateName:'Nachtlauf',value:'Webserver'}),'start: the classic body, no extra checkbox');
 ok(!harness.walk(dialog).some(node=>node.type==='input'),'no confirm checkbox in the dialog');
 post=()=>{throw new Error('Nicht erlaubt');};dialog.props.onConfirm();await harness.settle();tree=render();
 ok(harness.toasts.includes('error:Nicht erlaubt')&&openDialog(tree),'a failed start keeps the dialog open with toast.error');
 post=()=>({});openDialog(tree).props.onConfirm();await harness.settle();tree=render();
 const run=posts().at(-1).body;check([run.action,run.assignmentId,run.confirm,typeof run.requestId],['run','night-a',true,'string'],'the run body with a request id');
 ok(harness.toasts.includes(de('automation.campaignStarted'))&&!openDialog(tree),'the start toast');
}

// ---- Schedules: both ways in one list with their Source ----
{
 let tree=await mount({page:'runbooks',tab:'schedules'});
 check(of(tree,RunbookPanel).props.assignmentSchedules,[{id:'night-a',templateName:'Nachtlauf',recurrence:{kind:'interval',minutes:60},scope:'Webserver',path:'Produktion / Webserver',nextDue:null,paused:false}],'the recurring runbook assignments go to the Schedules view; manual ones do not');
 of(tree,RunbookPanel).props.onShowAssignment('night-a');check(tabs,['assignments'],'"Zuweisung anzeigen" opens the Assignments tab');
 props={...props,frame:{...props.frame,tab:'assignments'}};tree=render();check(of(tree,AutomationAssignments).props.highlight,'night-a','and highlights that row');
 const {RunbookSchedules}=harness.load('ui/automation/runbook-schedules.tsx');
 let shownAssignment='',turnedOff='',library=0;
 const scheduleProps={schedules:[{id:'s1',versionId:'v1',targets:['one'],nextDue:99,recurrence:{kind:'daily',hour:2,minute:0,timeZone:'Europe/Berlin'},enabled:false}],assignments:of(render(),RunbookPanel)?.props.assignmentSchedules??[{id:'night-a',templateName:'Nachtlauf',recurrence:{kind:'interval',minutes:60},scope:'Webserver',path:'Produktion / Webserver',nextDue:null,paused:false}],servers,runName:()=>'Health',onTurnOff:id=>{turnedOff=id;},onShowAssignment:id=>{shownAssignment=id;},onShowLibrary:()=>{library++;}};
 const element=RunbookSchedules(scheduleProps),table=harness.table(element);
 check([table.props.columns.find(column=>column.id==='next').label,translateModule.translate('en','runbooks.nextRun')],['Nächster Lauf','Next run'],'the Schedules column is named "Next run" (de "Nächster Lauf")');
 check(table.props.rows.map(row=>[row.source,row.name,row.targets,row.nextDue,row.active]),[['schedule','Health','WEB-001',99,false],['assignment','Nachtlauf','Webserver',null,true]],'one table: a schedule row and an assignment row');
 const html=text(harness.html(RunbookSchedules,scheduleProps));
 for(const part of ['Quelle','Zeitplan','Zuweisung','Nach der nächsten Gerätemeldung','Täglich 02:00 · Europe/Berlin','Alle 60 Minuten','Produktion / Webserver','Ausgeschaltet','Aktiv'])ok(html.includes(part),`the Schedules table shows "${part}"`);
 const [scheduleMenu,assignmentMenu]=table.props.rows.map(row=>harness.walk(table.props.columns.at(-1).cell(row)).find(node=>Array.isArray(node.props.entries)).props.entries);
 check([scheduleMenu[0].label,scheduleMenu[0].blocked],['Ausschalten',de('runbooks.blocked.scheduleOff')],'a turned-off schedule: "Ausschalten" blocked with its reason');
 assignmentMenu[0].onSelect();check([assignmentMenu[0].label,shownAssignment],['Zuweisung anzeigen','night-a'],'an assignment row shows its assignment');
 const empty=harness.table(RunbookSchedules({...scheduleProps,schedules:[],assignments:[]}));
 check([empty.props.empty.title,empty.props.empty.children],[de('runbooks.noSchedulesTitle'),de('runbooks.noSchedulesHint')],'the empty Schedules state');
 empty.props.empty.action.props.onClick();check(library,1,'"Runbooks anzeigen" goes to the library');
 check(turnedOff,'','nothing was turned off');
}

// ---- Device status: 50 rows per page, page 1 again on search ----
{
 const status=panelHarness({hooked:['ui/automation/automation-device-status.tsx'],stubs:{'@/ui/base/api':shared}});
 const {AutomationDeviceStatus:Status}=status.load('ui/automation/automation-device-status.tsx');
 const many=Array.from({length:120},(_,index)=>({id:'d'+index,name:'VM-'+String(index).padStart(4,'0'),permissions:rights,groups:[groups[0]],groupName:'Produktion',snapshot:null}));
 const opened=[];const statusProps={kind:'drift',servers:many,data:baseData,onOpenDevice:id=>opened.push(id)};
 let tree=status.tree(Status,statusProps),table=status.table(tree);
 check([table.props.rows.length,table.props.pagination.total,table.props.pagination.page,table.props.foot],[50,120,1,'120 von 120 Geräten'],'50 rows, the pagination and the foot');
 table.props.pagination.onPage(3);tree=status.tree(Status,statusProps);table=status.table(tree);check([table.props.rows.length,table.props.rows[0].name],[20,'VM-0100'],'page 3 holds the last 20');
 table.props.toolbar.props.search.onChange('VM-01');tree=status.tree(Status,statusProps);table=status.table(tree);
 check([table.props.pagination.page,table.props.rows.length,table.props.foot],[1,20,'20 von 120 Geräten'],'a search starts at page 1 again');
 table.props.onOpen(table.props.rows[0]);check(opened,['d100'],'a row opens the device');
 table.props.toolbar.props.search.onChange('nichts');tree=status.tree(Status,statusProps);table=status.table(tree);
 check([table.props.empty.title,table.props.empty.action.props.children],[de('automation.noDevices'),'Suche löschen'],'no match: Empty with "Suche löschen"');
 table.props.empty.action.props.onClick();tree=status.tree(Status,statusProps);check(status.table(tree).props.rows.length,50,'"Suche löschen" shows the devices again');
 tree=status.tree(Status,{...statusProps,servers:[servers[0]]});
 ok(text(status.html(Status,{...statusProps,servers:[servers[0]]})).includes('Web-Baseline')&&status.html(Status,{...statusProps,servers:[servers[0]]}).includes('Produktion'),'the effective template and its origin');
 status.reset();
}

// ---- The drawers: kit controls, blocked submits, the classic bodies ----
{
 const drawers=panelHarness({hooked:['ui/automation/automation-template-drawers.tsx'],stubs:{'@/ui/base/api':shared}});
 const {CreateTemplateDrawer:Create,AssignTemplateDrawer:Assign}=drawers.load('ui/automation/automation-template-drawers.tsx'),dkit=drawers.load('ui/kit/kit.tsx'),dfield=drawers.load('ui/kit/field.tsx');
 const catalogs={'/api/runbooks':{runbooks:[{id:'book',name:'Wartung',versions:[{id:'run-version',version:4,definition:{parameters:[{name:'Message',type:'string',required:true,secret:false},{name:'Count',type:'number',required:false,secret:false,default:2},{name:'Enabled',type:'boolean',required:false,secret:false,default:false},{name:'Password',type:'string',required:false,secret:true}]}}]}]},
  '/api/desired-state':{configs:[{id:'config',name:'Web-Konfiguration'}],versions:[{id:'flat-version',configId:'config',version:8},{id:'unrelated-version',configId:'other-config',version:99}]}};
 const submitted=[];calls.length=0;get=url=>clone(catalogs[url]);
 const createProps={open:true,kind:'runbook',devices:servers,busy:false,onClose:()=>{},onSubmit:body=>submitted.push(body)};
 drawers.reset();let tree=drawers.tree(Create,createProps);
 ok(drawers.walk(tree).some(node=>node.type===dkit.Skeleton&&node.props.label===de('automation.loadingVersions')),'the versions load with a Skeleton');
 const submit=current=>drawers.walk(drawers.walk(current).find(node=>node.type===dkit.Drawer).props.footer).find(node=>node.props?.type==='submit');
 check([drawers.walk(tree).find(node=>node.type===dkit.Drawer).props.title,submit(tree).props.blocked,submit(tree).props.form],['Vorlage erstellen',de('automation.blocked.name'),'automation-create-template'],'the drawer and its blocked submit');
 await drawers.flush();tree=drawers.tree(Create,createProps);
 const field=(current,label)=>drawers.walk(current).find(node=>node.props?.label===label)?.props.children;
 field(tree,'Name').props.onChange({target:{value:'Runbook template'}});tree=drawers.tree(Create,createProps);
 check(submit(tree).props.blocked,de('automation.blocked.version'),'the version is required');
 field(tree,'Version').props.onChange({target:{value:'run-version'}});tree=drawers.tree(Create,createProps);
 ok(!field(tree,'Password'),'secret parameters stay out of shared templates');
 field(tree,'Message').props.onChange({target:{value:'Hello'}});tree=drawers.tree(Create,createProps);
 drawers.walk(tree).find(node=>node.props?.label==='Regelmäßig ausführen'&&node.props.onChange).props.onChange(true);tree=drawers.tree(Create,createProps);
 field(tree,'Intervall in Minuten').props.onChange({target:{value:'15'}});tree=drawers.tree(Create,createProps);
 check([submit(tree).props.blocked,drawers.walk(tree).find(node=>node.type===dkit.Drawer).props.dirty],[undefined,true],'the submit is free and the drawer is dirty');
 drawers.walk(tree).find(node=>node.type==='form').props.onSubmit({preventDefault(){}});
 check(submitted.at(-1),{action:'create-template',kind:'runbook',name:'Runbook template',sourceServerId:'one',includeBaseline:true,versionId:'run-version',intervalSeconds:0,parameters:{Message:'Hello',Count:2,Enabled:false},recurrence:{kind:'interval',minutes:15},concurrency:2},'the classic runbook template body');
 // Desired State: flat versions join their configuration; the interval is numeric.
 const desiredProps={...createProps,kind:'desired'};drawers.reset();drawers.tree(Create,desiredProps);await drawers.flush();tree=drawers.tree(Create,desiredProps);
 check(drawers.walk(tree).filter(node=>node.type==='option').map(node=>node.props.value).filter(value=>/version/.test(value)),['flat-version'],'the flat version fallback joins the right configuration');
 field(tree,'Name').props.onChange({target:{value:'Desired template'}});field(tree,'Version').props.onChange({target:{value:'flat-version'}});field(tree,'Prüfintervall')?.props.onChange({target:{value:'900'}});tree=drawers.tree(Create,desiredProps);
 drawers.walk(tree).find(node=>node.type==='form').props.onSubmit({preventDefault(){}});
 check([submitted.at(-1).versionId,submitted.at(-1).intervalSeconds],['flat-version',900],'the desired body keeps the version and a numeric interval');
 // Drift: the reference device and the scan baseline switch.
 const driftProps={...createProps,kind:'drift'};drawers.reset();tree=drawers.tree(Create,driftProps);
 field(tree,'Name').props.onChange({target:{value:'Baseline'}});tree=drawers.tree(Create,driftProps);
 check(drawers.walk(tree).find(node=>node.type===dfield.Switch||node.props?.label===de('automation.useScan'))?.props.checked,true,'drift: the scan baseline is a switch, on by default');
 drawers.walk(tree).find(node=>node.type==='form').props.onSubmit({preventDefault(){}});
 check(submitted.at(-1),{action:'create-template',kind:'drift',name:'Baseline',sourceServerId:'one',includeBaseline:true,versionId:'',intervalSeconds:0,parameters:{},recurrence:null,concurrency:2},'the classic drift template body');
 // Assign: blocked until a target and the approval; the body is the classic one.
 const assignProps={open:true,kind:'drift',templates:baseData.templates.filter(entry=>entry.kind==='drift'),initialTemplateId:'drift',groups,devices:servers,servers,showOwner:false,busy:false,onClose:()=>{},onSubmit:body=>submitted.push(body)};
 drawers.reset();tree=drawers.tree(Assign,assignProps);
 const assignButton=current=>drawers.walk(drawers.walk(current).find(node=>node.type===dkit.Drawer).props.footer).find(node=>node.props?.type==='submit');
 const assignForm=current=>drawers.walk(current).find(node=>node.type==='form'&&node.props.id==='automation-assign-template');
 check([assignButton(tree).props.blocked,assignButton(tree).props.form,drawers.text(assignButton(tree))],['Wähle eine Gruppe oder ein Gerät.','automation-assign-template','Vorlage zuweisen'],'no target: the submit of the drawer form is blocked');
 const before=submitted.length;assignForm(tree).props.onSubmit({preventDefault(){}});check(submitted.length,before,'Enter while blocked sends nothing');
 const pick=drawers.walk(tree).find(node=>node.type===dkit.PickList);
 check([pick.props.mode,pick.props.search.label],['radio','Gruppen suchen'],'the targets are a radio pick list with search');
 drawers.walk(tree).find(node=>node.type===dkit.PickRow&&node.props.label==='Webserver').props.onSelect();tree=drawers.tree(Assign,assignProps);
 check(assignButton(tree).props.blocked,'Schalte die Bestätigung am Ende des Formulars ein.','a target without the approval: blocked');
 ok(text(drawers.html(Assign,assignProps)).includes('1 Gerät'),'the impact counts the affected devices');
 drawers.walk(tree).find(node=>node.props?.label===de('automation.confirmAssignment')&&node.props.onChange).props.onChange(true);tree=drawers.tree(Assign,assignProps);
 check(assignButton(tree).props.blocked,undefined,'with the approval the submit is free');
 assignForm(tree).props.onSubmit({preventDefault(){}});
 check(submitted.at(-1),{action:'assign',templateId:'drift',scopeType:'group',scopeId:'child',disabled:false,confirm:true},'the classic assign body');
 // The scope type is a Segmented; a device search filters the pick list.
 drawers.walk(tree).find(node=>node.type===dkit.Segmented).props.onChange('device');tree=drawers.tree(Assign,assignProps);
 check([assignButton(tree).props.blocked,drawers.walk(tree).find(node=>node.type===dkit.PickList).props.search.label],['Wähle eine Gruppe oder ein Gerät.','Geräte suchen'],'a new scope type asks for a target and the approval again');
 drawers.reset();
}

// ---- The kit insets the toolbar of a flush table (Device status in a flush Card) ----
{
 const fs=await import('node:fs');
 ok(/\.sdx-toolbar:has\(\+ \.sdx-table-wrap-flush\) \{ margin: 0; padding: var\(--sd-space-3\) var\(--sd-space-4\); \}/.test(fs.readFileSync('ui/styles/console.css','utf8')),'the toolbar of a flush DataTable takes the card padding in the kit CSS');
 ok(!/className=/.test(fs.readFileSync('ui/automation/automation-device-status.tsx','utf8').split(/\r?\n/).filter(line=>line.includes('<Toolbar')).join('')),'Device status adds no page class to its toolbar');
}

// ---- The Assignments tab without templates and without assignments ----
{
 const created=[];
 const element=AutomationAssignments({kind:'drift',templates:[],assignments:[],groups,servers,showOwner:false,showCreate:false,onCreate:()=>created.push(1),onAssign:()=>{},onStart:()=>{},onRemove:()=>{}});
 const empty=harness.walk(element).find(node=>node.type===kit.Empty);
 check([empty.props.title,empty.props.children,empty.props.action.props.children],[de('automation.noTemplates'),de('automation.noTemplatesHint'),'Vorlage erstellen'],'no template: one Empty with "Vorlage erstellen"');
 empty.props.action.props.onClick();check(created.length,1,'its action creates a template');
 const assigned=AutomationAssignments({kind:'runbook',templates:baseData.templates.filter(entry=>entry.kind==='runbook'),assignments:[],groups,servers,showOwner:false,showCreate:true,onCreate:()=>{},onAssign:()=>{},onStart:()=>{},onRemove:()=>{}});
 const table=harness.table(assigned,'Zuweisungen');
 check([table.props.empty.title,table.props.empty.action.props.children,table.props.cards,table.props.entranceId],[de('automation.noAssignments'),'Vorlage zuweisen…',true,'automation-assignments'],'no assignment: the card has its own Empty with "Vorlage zuweisen…"');
 const withRows=AutomationAssignments({kind:'runbook',templates:baseData.templates,assignments:baseData.assignments.filter(a=>a.kind==='runbook'),groups,servers,showOwner:false,showCreate:true,onCreate:()=>{},onAssign:()=>{},onStart:()=>{},onRemove:()=>{}});
 const rows=harness.table(withRows,'Zuweisungen'),menu=harness.walk(rows.props.columns.at(-1).cell(rows.props.rows[1])).find(node=>Array.isArray(node.props.entries));
 check([menu.props.label,menu.props.entries.map(entry=>entry.label??'—'),menu.props.entries.at(-1).danger],['Aktionen für Webserver',['Runbook starten…','—','Zuweisung entfernen…'],true],'the assignment row Menu: start, separator, the danger remove');
 ok(harness.walk(withRows).some(node=>node.type===kit.Disclosure),'the inheritance help is a Disclosure');
}
// ---- The page frame: one header per render, tabs from the nav model, onTab through the frame, the console refresh ----
{
 let tree=await mount({page:'runbooks',tab:'runs'});
 check(shown.headers,1,'the page renders the frame header exactly once');
 const {pageTabNodes}=harness.load('ui/shell/nav-model.ts'),{consoleRouteHash}=harness.load('lib/console-route.ts');
 check(of(tree,Tabs).props.items.map(item=>[item.id,item.href]),pageTabNodes({view:'automation',page:'runbooks'}).map(node=>[node.tab,consoleRouteHash(node.route)]),'the tab items are the tab nodes of the page');
 check(of(tree,Tabs).props.value,'runs','the active tab is frame.tab');
 of(tree,Tabs).props.onChange('status');check(tabs,['status'],'a tab change goes through frame.onTab');
 // An unknown frame tab opens the first tab; a page without a frame shows its first tab and renders no header.
 tree=await mount({page:'drift',tab:'nope'});check(of(tree,Tabs).props.value,'assignments','an unknown tab is the first tab');
 harness.reset();calls.length=0;props={...base,page:'desired'};render();await harness.flush();tree=render();
 check([of(tree,Tabs).props.value,shown.headers],['configurations',0],'without a frame: the first tab and no header');
 // A console refresh (frame.refresh) loads GET /api/automation once more; the loaded data stays shown meanwhile.
 tree=await mount({page:'drift',tab:'assignments'});
 const gets=()=>calls.filter(call=>!call.body&&call.url==='/api/automation').length,before=gets();
 const wait=deferred();get=()=>wait.promise;
 props={...props,frame:frameOf('assignments',1)};render();await harness.flush();tree=render();
 check(gets(),before+1,'a refresh change sends one GET /api/automation');
 ok(of(tree,AutomationAssignments)&&!harness.walk(tree).some(node=>node.type===kit.Skeleton),'the loaded assignments stay shown during the reload, no Skeleton');
 wait.resolve(clone(baseData));await harness.settle();
 render();await harness.flush();check(gets(),before+1,'the same count loads nothing more');
}
harness.reset();
console.log(`PASS automation workspace view (${checks} checks): scope helpers, the first-load Skeleton and stale refresh, the routed tab bar with counts, the page primary, the tab contents, Create and Assign drawers on useStepUp, Remove and Start confirmations, the Schedules union, Device status paging and Unavailable for sample devices.`);
