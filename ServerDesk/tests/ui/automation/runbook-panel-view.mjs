// Automation → Runbooks on the kit (ui/automation/runbook-panel.tsx), run on hook cells (tests/support/panel-harness.mjs)
// in German plus English for the retry: the sr-only head, Unavailable with the concrete reason and no
// request (sample device, missing right), the Tabs with counts only after the load, one row Menu per
// runbook, the blocked "Create runbook", the empty runs and schedules, the run and schedule
// confirmations with the trigger verb and the classic bodies, the preview Mode column with the UI mode names
// (raw value only for the Management check), the danger delete and the load retry.
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {panelHarness} from '../../support/panel-harness.mjs';
import {de} from '../../support/i18n-stubs.mjs';
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const text=html=>html.replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#x27;/g,"'").replace(/\s+/g,' ').trim();
class ApiError extends Error{constructor(message,status,code){super(message);this.status=status;this.code=code;}}
const calls=[];let respond=()=>Promise.resolve({});
const shared={api:(url,body)=>{calls.push({url,body});return respond(url,body);},ApiError,message:error=>error.message,stamp:value=>value?'T'+value:'–',permitted:(server,viewer,right)=>viewer.permissions?.includes('*')===true||server.permissions?.includes(right)===true,v3:server=>server.snapshot?.protocolVersion===3};
const stubs={'@/ui/base/api':shared,'@/ui/session/mfa-step-up':{MfaStepUp:()=>null}};
const make=locale=>{const harness=panelHarness({hooked:['ui/automation/runbook-panel.tsx'],stubs,locale});const kit=harness.load('ui/kit/kit.tsx');return {harness,Panel:harness.load('ui/automation/runbook-panel.tsx').default,ConfirmDialog:harness.load('ui/kit/confirm-dialog.tsx').ConfirmDialog,Tabs:harness.load('ui/kit/tabs.tsx').Tabs,Drawer:kit.Drawer,Card:kit.Card};};
const {harness,Panel,ConfirmDialog,Tabs,Drawer,Card}=make('de');
const owner={id:'owner',label:'Owner',permissions:['*']};
const device={id:'d1',name:'CT-WEB01',revoked:0,management:1,permissions:['view','runbooks.read','runbooks.execute'],snapshot:{protocolVersion:3,mode:'Management'}};
const version={id:'v1',version:2,createdAt:1,definition:{steps:[{id:'s1',name:'Datum',kind:'powershell',script:'Get-Date',timeoutSeconds:60}],parameters:[]}};
const data={runbooks:[{id:'rb1',name:'Health',description:'Prüft den Server',canManage:true,canDelete:true,versions:[version]}],runs:[],schedules:[]};
const preview={targets:[{serverId:'d1',name:'CT-WEB01',online:true,mode:'Management',steps:[{}],preconditionErrors:[]}],warnings:[],version:2};
const props={servers:[device],viewer:owner,demo:false,serverId:'d1'};
const dialogs=tree=>harness.walk(tree).filter(node=>node.type===ConfirmDialog);
const openDialog=tree=>dialogs(tree).find(node=>node.props.open);
const mount=async(overrides={},reply=()=>Promise.resolve(structuredClone(data)))=>{harness.reset();calls.length=0;respond=reply;harness.tree(Panel,{...props,...overrides});await harness.flush();return harness.tree(Panel,{...props,...overrides});};

// ---- Sample device and missing right: Unavailable, no tabs, no request ----
let tree=await mount({demo:true});let html=harness.html(Panel,{...props,demo:true});
ok(/<h2 class="sr-only">Runbooks<\/h2>/.test(html),'the tab label is only the accessible heading');
ok(text(html).includes('Bei Beispielgeräten nicht möglich.')&&text(html).includes(de('runbooks.description.device')),'demo: the kit sentence below the description');
ok(!html.includes('role="tablist"')&&!html.includes('<table'),'demo: no tabs and no tables');
check(calls.length,0,'demo: no request');
const reader={id:'reader',label:'Reader',permissions:[]};
tree=await mount({viewer:reader,servers:[{...device,permissions:['view']}]});html=harness.html(Panel,{...props,viewer:reader,servers:[{...device,permissions:['view']}]});
ok(text(html).includes(de('runbooks.unavailable.right'))&&!html.includes('role="tablist"'),'no runbook right: the right sentence and no tabs');
check(calls.length,0,'no right: no request');
ok(!harness.walk(tree).some(node=>node.props?.children==='Runbook erstellen'),'an unavailable panel hides "Create runbook"');

// ---- With data: Tabs with counts after the load, one row Menu, blocked create ----
harness.reset();calls.length=0;respond=()=>Promise.resolve(structuredClone(data));
html=harness.html(Panel,props);
ok(/role="tablist"/.test(html)&&!/—/.test(text(html.slice(html.indexOf('role="tablist"'),html.indexOf('</nav>')))),'before the load the tabs show no "—"');
ok(/role="status" aria-label="Runbooks werden geladen"/.test(html),'the first load shows the Skeleton');
await harness.flush();tree=harness.tree(Panel,props);html=harness.html(Panel,props);
check(calls.map(call=>call.url),['/api/runbooks?serverId=d1'],'one GET for the device');
const tabs=harness.walk(tree).find(node=>node.type===Tabs);
check(tabs.props.items.map(item=>[item.label,item.count]),[['Runbooks',1],['Läufe',0],['Zeitpläne',0]],'the views with their counts after the load');
check((html.match(/role="tab"/g)||[]).length,3,'three kit tabs');
ok(text(html).includes(de('runbooks.catalogTitle'))&&/role="region" aria-label="Runbooks"/.test(html),'the catalog card with its labelled table');
check(harness.menu(tree,'Aktionen für Health').map(entry=>entry.label??'—'),['Lauf vorbereiten…','Neue Version…','—','Runbook löschen…'],'one row Menu with prepare, new version and delete');
check(harness.menu(tree,'Aktionen für Health')[3].danger,true,'delete is the danger entry');
const body=html.slice(html.indexOf('<tbody'),html.indexOf('</tbody>'));
check((body.match(/<button/g)||[]).length,2,'per row only the open button of the name and the menu trigger');
ok(!text(body).includes('Vorbereiten')&&!text(body).includes(de('common.delete')),'no per-row action buttons');
const limited={id:'tech',label:'Tech',permissions:[]},limitedServers=[{...device,permissions:['runbooks.read','runbooks.execute']}];
await mount({viewer:limited,servers:limitedServers});html=harness.html(Panel,{...props,viewer:limited,servers:limitedServers});
const create=html.match(/<button[^>]*>(?:(?!<\/button>).)*<span>Runbook erstellen<\/span>(?:(?!<\/button>).)*<\/button>/)?.[0]??'';
ok(/aria-disabled="true"/.test(create)&&create.includes(de('runbooks.blocked.manage'))&&!/ disabled=""/.test(create),'"Runbook erstellen" is blocked with the right, focusable, no native disabled');

// ---- Empty runs and schedules ----
tree=await mount();
harness.walk(tree).find(node=>node.type===Tabs).props.onChange('runs');tree=harness.tree(Panel,props);html=harness.html(Panel,props);
ok(text(html).includes(de('runbooks.noRuns'))&&text(html).includes(de('runbooks.noRunsHint')),'runs: Empty with title and hint');
harness.walk(tree).find(node=>node.type===Tabs).props.onChange('schedules');tree=harness.tree(Panel,props);html=harness.html(Panel,props);
ok(text(html).includes(de('runbooks.noSchedulesTitle'))&&text(html).includes(de('runbooks.noSchedulesHint')),'schedules: Empty with title and hint');

// ---- Prepare, preview, start: ConfirmDialog with the trigger verb and the classic body ----
tree=await mount();
harness.menu(tree,'Aktionen für Health')[0].onSelect();tree=harness.tree(Panel,props);
ok(text(harness.html(Panel,props)).includes('Health vorbereiten'),'the prepare drawer');
const prepareDrawer=harness.walk(tree).find(node=>node.type===Drawer&&node.props.title==='Health vorbereiten');
check([prepareDrawer?.props.open,prepareDrawer?.props.wide],[true,true],'Prepare is a wide Drawer, opened from the row menu');
ok(!harness.walk(tree).some(node=>node.type===Card&&String(node.props.title).includes('vorbereiten')),'Prepare is no Card below the catalog');
let start=harness.button(tree,'Runbook starten');
check(start.props.blocked,de('runbooks.blocked.preview'),'"Runbook starten" waits for the preview');
respond=(url,request)=>Promise.resolve(request?.action==='dryrun'?structuredClone(preview):structuredClone(data));
harness.button(tree,'Vorschau').props.onClick();await harness.settle();tree=harness.tree(Panel,props);
check(calls.at(-1).body,{action:'dryrun',versionId:'v1',targets:['d1'],parameters:{},secrets:{},concurrency:1,failureStop:true},'the preview body');
start=harness.button(tree,'Runbook starten');check(start.props.blocked,undefined,'after the preview the start is free');
start.props.onClick();tree=harness.tree(Panel,props);
let dialog=openDialog(tree);
check([dialog.props.title,dialog.props.confirmLabel,dialog.props.lines],[de('runbooks.runConfirmTitle'),'Runbook starten',[{label:'Runbook',value:'Health'},{label:'Version',value:'v2'},{label:'Geräte',value:'CT-WEB01'}]],'the run confirmation: the verb of the trigger and the facts');
check(dialog.props.body,de('runbooks.runConfirmBody'),'the body says what runs');
let before=calls.length;dialog.props.onConfirm();await harness.settle();
check(calls[before].body,{action:'run',versionId:'v1',targets:['d1'],parameters:{},secrets:{},concurrency:1,failureStop:true,confirm:true},'the run body is the classic one');
ok(harness.toasts.includes(de('runbooks.toast.started')),'a success toast');
ok(!harness.walk(harness.tree(Panel,props)).some(node=>node.type===Drawer&&node.props.open),'the started run closes the drawer');
// The schedule switch renames the trigger and the confirm button.
tree=harness.tree(Panel,props);harness.menu(tree,'Aktionen für Health')[0].onSelect();tree=harness.tree(Panel,props);harness.button(tree,'Vorschau').props.onClick();await harness.settle();tree=harness.tree(Panel,props);
const scheduleSwitch=harness.walk(tree).find(node=>node.props?.label==='Als Zeitplan speichern').props.children;
check(scheduleSwitch.props.role,'switch','"Als Zeitplan speichern" is a switch');
scheduleSwitch.props.onChange({target:{checked:true}});tree=harness.tree(Panel,props);
harness.button(tree,'Zeitplan speichern').props.onClick();tree=harness.tree(Panel,props);dialog=openDialog(tree);
check([dialog.props.title,dialog.props.confirmLabel],[de('runbooks.scheduleConfirmTitle'),'Zeitplan speichern'],'the schedule confirmation keeps the verb');
before=calls.length;dialog.props.onConfirm();await harness.settle();
check(calls[before].body,{action:'schedule',versionId:'v1',targets:['d1'],parameters:{},secrets:{},concurrency:1,failureStop:true,confirm:true,recurrence:{kind:'daily',timeZone:'Europe/Berlin',hour:2,minute:0,weekdays:[0,1,2,3,4,5,6]},catchupSeconds:3600},'the schedule body is the classic one');

// ---- The preview's Mode column names the agent mode as the UI does (D5), the checks keep the raw value ----
{
 const mixed={targets:[{serverId:'d1',name:'CT-WEB01',online:true,mode:'Management',steps:[{}],preconditionErrors:[]},{serverId:'d2',name:'CT-RO02',online:true,mode:'ReadOnly',steps:[{}],preconditionErrors:[]}],warnings:[],version:2};
 const readOnly={...device,id:'d2',name:'CT-RO02',management:0,snapshot:{protocolVersion:3,mode:'ReadOnly'}};
 const twoDevices={...props,servers:[device,readOnly]};
 const previewFlow=async(run,menuLabel,previewLabel)=>{
  run.harness.reset();calls.length=0;respond=(url,request)=>Promise.resolve(request?.action==='dryrun'?structuredClone(mixed):structuredClone(data));
  run.harness.tree(run.Panel,twoDevices);await run.harness.flush();let current=run.harness.tree(run.Panel,twoDevices);
  run.harness.menu(current,menuLabel)[0].onSelect();current=run.harness.tree(run.Panel,twoDevices);
  run.harness.button(current,previewLabel).props.onClick();await run.harness.settle();current=run.harness.tree(run.Panel,twoDevices);
  return current;
 };
 for(const [locale,run,menuLabel,previewLabel,startLabel,labels] of [['de',{harness,Panel},'Aktionen für Health','Vorschau','Runbook starten',['Verwaltung','Nur lesen']],['en',make('en'),'Actions for Health','Preview','Start runbook',['Management','Read-only']]]){
  const current=await previewFlow(run,menuLabel,previewLabel);
  const table=run.harness.table(current,locale==='de'?'Vorschau · Version 2':'Preview · version 2');
  ok(table,`${locale}: the preview table is shown`);
  const modeColumn=table.props.columns.find(column=>column.id==='mode');
  check(table.props.rows.map(row=>modeColumn.cell(row)),labels,`${locale}: the Mode cells name the modes ("${labels.join('", "')}")`);
  const markup=run.harness.html(run.Panel,twoDevices);
  const previewBody=markup.slice(markup.indexOf(locale==='de'?'Vorschau · Version 2':'Preview · version 2'));
  ok(!/>\s*ReadOnly\s*</.test(previewBody)&&!text(previewBody).includes('ReadOnly'),`${locale}: the raw value ReadOnly is never cell text`);
  // The PowerShell check still compares the raw value: the ReadOnly target needs Management mode and blocks the start.
  const checkColumn=table.props.columns.find(column=>column.id==='check');
  const checkTexts=table.props.rows.map(row=>text(renderToStaticMarkup(checkColumn.cell(row))));
  ok(!checkTexts[0].includes(locale==='de'?de('runbooks.managementRequired'):'Management required')&&checkTexts[1].includes(locale==='de'?de('runbooks.managementRequired'):'Management required'),`${locale}: only the ReadOnly target shows "Management required" for a PowerShell runbook`);
  check(run.harness.button(current,startLabel).props.blocked,locale==='de'?de('runbooks.blocked.precondition'):'A selected device does not meet the preview checks. Fix them or remove the device.',`${locale}: the ReadOnly target blocks the start (precondition)`);
  // The cleanups clear the panel's 5 s refresh interval, so the English harness does not keep the process alive.
  run.harness.reset();
 }
}

// ---- Delete: danger, "Runbook löschen", the classic body ----
tree=await mount();
harness.menu(tree,'Aktionen für Health')[3].onSelect();tree=harness.tree(Panel,props);dialog=openDialog(tree);
check([dialog.props.tone,dialog.props.confirmLabel,dialog.props.title,dialog.props.lines],['danger','Runbook löschen',de('runbooks.deleteTitle'),[{label:'Runbook',value:'Health'}]],'delete asks with the danger tone');
respond=(url,request)=>Promise.resolve(request?{messageKey:'serverMessage.runbooks.deleted'}:structuredClone(data));before=calls.length;dialog.props.onConfirm();await harness.settle();
check(calls[before].body,{action:'delete',runbookId:'rb1',confirm:true},'the delete body is the classic one');
ok(!harness.walk(harness.tree(Panel,props)).some(node=>node.type===ConfirmDialog&&node.props.open&&node.props.tone==='danger'),'the dialog closes after the delete');

// ---- The Runbooks page: the page's tab bar picks the view, the panel renders no Tabs of its own ----
{
 const library={servers:[device],viewer:owner,demo:false,view:'runbooks'};
 harness.reset();calls.length=0;respond=()=>Promise.resolve(structuredClone(data));harness.tree(Panel,library);await harness.flush();tree=harness.tree(Panel,library);
 check(calls.map(call=>call.url),['/api/runbooks'],'library: one GET without a device');
 ok(!harness.walk(tree).some(node=>node.type===Tabs)&&!harness.html(Panel,library).includes('role="tablist"'),'library with a page tab: no inner Tabs');
 ok(!harness.html(Panel,library).includes('sdx-btn-primary'),'library: no gradient button in the content (the page header holds the primary)');
 ok(!/<h2 class="sr-only">/.test(harness.html(Panel,library)),'library: no in-panel h2');
 for(const view of ['runs','schedules'])ok(text(harness.html(Panel,{...library,view})).includes(view==='runs'?de('runbooks.noRuns'):de('runbooks.noSchedulesTitle')),`library: the ${view} view without a tab bar`);
 check(harness.html(Panel,{...library,view:null}),'','another page tab: the panel renders nothing');
}
// ---- Stop run: a danger ConfirmDialog; the cancel request goes out only on confirm ----
{
 const running={...structuredClone(data),runs:[{id:'run-1',versionId:'v1',state:'running',createdAt:7,devices:[{serverId:'d1',state:'running',stepIndex:0,jobId:'j1',result:null}]}]};
 tree=await mount({initialTab:'runs'},()=>Promise.resolve(structuredClone(running)));
 const stopEntry=harness.menu(tree,'Aktionen für Health').find(entry=>entry.id==='stop');
 check(stopEntry.label,'Lauf stoppen…','the row menu offers "Lauf stoppen…" with an ellipsis');
 const before=calls.length;stopEntry.onSelect();tree=harness.tree(Panel,props);const dialog=openDialog(tree);
 check([dialog.props.tone,dialog.props.title,dialog.props.confirmLabel,dialog.props.body],['danger','Lauf stoppen?','Lauf stoppen',de('runbooks.stopBody')],'"Lauf stoppen?" with the danger tone and the verb');
 check(dialog.props.lines,[{label:'Runbook',value:'Health'},{label:'Gestartet',value:'T7'},{label:'Geräte',value:'CT-WEB01'}],'the lines Runbook, Started and Devices');
 check(calls.length,before,'opening the dialog sends nothing');
 respond=(url,request)=>request?Promise.reject(new Error('Abgelehnt')):Promise.resolve(structuredClone(running));
 dialog.props.onConfirm();await harness.settle();tree=harness.tree(Panel,props);
 check(calls.at(-1).body,{action:'cancel',runId:'run-1'},'confirm sends the cancel request');
 ok(harness.toasts.includes('error:Abgelehnt')&&openDialog(tree)?.props.title==='Lauf stoppen?','a failure shows toast.error and the dialog stays open');
 respond=()=>Promise.resolve(structuredClone(running));openDialog(tree).props.onConfirm();await harness.settle();tree=harness.tree(Panel,props);
 ok(harness.toasts.includes(de('runbooks.toast.stopped'))&&!openDialog(tree),'success: the dialog closes with a toast');
 // The output drawer of an unfinished run has "Lauf stoppen…" in its footer.
 harness.menu(tree,'Aktionen für Health').find(entry=>entry.id==='output').onSelect();tree=harness.tree(Panel,props);
 const output=harness.walk(tree).find(node=>node.type===Drawer&&node.props.open&&node.props.footer);
 ok(output&&harness.button(output.props.footer,'Lauf stoppen…'),'the output drawer footer has "Lauf stoppen…" while the run is unfinished');
 harness.button(output.props.footer,'Lauf stoppen…').props.onClick();tree=harness.tree(Panel,props);
 check(openDialog(tree)?.props.title,'Lauf stoppen?','the footer button asks first too');
}
// ---- Save a new runbook: "Prepare" opens with the returned version, also before the list has it ----
{
 const added={id:'rb-new',name:'Neu',description:'',canManage:true,canDelete:true,versions:[{...version,id:'v-new',version:1}]};
 let list=structuredClone(data);
 tree=await mount({},(url,request)=>Promise.resolve(request?.action==='create-version'?{id:'rb-new',versionId:'v-new'}:structuredClone(list)));
 harness.button(tree,'Runbook erstellen').props.onClick();tree=harness.tree(Panel,props);
 const editorOf=current=>harness.walk(current).find(node=>node.props?.onSave&&node.props?.onNameChange);
 editorOf(tree).props.onNameChange('Neu');tree=harness.tree(Panel,props);
 editorOf(tree).props.onSave();await harness.settle();tree=harness.tree(Panel,props);
 ok(calls.some(call=>call.body?.action==='create-version'&&call.body.name==='Neu'),'the create-version request');
 ok(harness.toasts.includes('Runbook erstellt.'),'the toast "Runbook erstellt."');
 let prepare=harness.walk(tree).find(node=>node.type===Drawer&&node.props.title==='Neu vorbereiten');
 ok(prepare?.props.open&&harness.walk(prepare).some(node=>node.props?.variant==='facts'&&node.props?.label),'before the list has the runbook, the open drawer shows a Skeleton');
 list={...structuredClone(data),runbooks:[...structuredClone(data.runbooks),added]};
 harness.labelled(tree,'Aktualisieren').props.onClick();await harness.settle();tree=harness.tree(Panel,props);
 prepare=harness.walk(tree).find(node=>node.type===Drawer&&node.props.title==='Neu vorbereiten');
 ok(prepare?.props.open&&harness.walk(prepare).some(node=>(node.type==='select'||node.type?.render?.name==='Select')&&node.props.value==='v-new'),'after the reload the drawer shows the form with the returned version');
 check(harness.table(tree,'Runbooks').props.highlightKey,'rb-new','the new row is highlighted');
 // A new version of an existing runbook: no drawer, the row is highlighted.
 tree=await mount({},(url,request)=>Promise.resolve(request?.action==='create-version'?{id:'rb1',versionId:'v3'}:structuredClone(data)));
 harness.menu(tree,'Aktionen für Health')[1].onSelect();tree=harness.tree(Panel,props);
 editorOf(tree).props.onSave();await harness.settle();tree=harness.tree(Panel,props);
 ok(harness.toasts.includes(de('runbooks.toast.versionSaved')),'a new version: the toast "Version gespeichert."');
 ok(!harness.walk(tree).some(node=>node.type===Drawer&&node.props.open),'a new version opens no drawer');
 check(harness.table(tree,'Runbooks').props.highlightKey,'rb1','the row of the new version is highlighted');
}

// ---- A failed load: "Erneut versuchen" / "Try again" repeats the request ----
for(const [locale,label] of [['de','Erneut versuchen'],['en','Try again']]){
 const run=locale==='de'?{harness,Panel}:make('en');
 run.harness.reset();calls.length=0;respond=()=>Promise.reject(new Error('down'));
 run.harness.tree(run.Panel,props);await run.harness.flush();tree=run.harness.tree(run.Panel,props);
 const retry=run.harness.button(tree,label);ok(retry&&run.harness.html(run.Panel,props).includes('sdx-notice-danger'),`${locale}: the load error offers "${label}"`);
 respond=()=>Promise.resolve(structuredClone(data));const count=calls.length;retry.props.onClick();await run.harness.settle();
 check([calls.length,calls.at(-1).url],[count+1,'/api/runbooks?serverId=d1'],`${locale}: the retry repeats the request`);
 if(locale==='en')ok(run.harness.html(run.Panel,props).includes('Create runbook'),'en: the English primary');
 run.harness.reset();
}
// The cleanups clear the 5 s refresh intervals, so the process ends.
harness.reset();
console.log(`PASS runbook panel view (${checks} checks): the sr-only head, Unavailable without a request, Tabs with counts, one row Menu, the blocked create, empty runs and schedules, Prepare as a Drawer, run, schedule and delete confirmations with the classic bodies, the library views without Tabs, the Stop run confirmation, Prepare after a new runbook, the preview Mode labels (German and English) and the load retry.`);
