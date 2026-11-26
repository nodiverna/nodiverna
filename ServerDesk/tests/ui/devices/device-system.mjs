// Actual System UI rendering and action tests on the kit; no Windows mutation is performed.
// The panel runs on hook cells (tests/support/panel-harness.mjs): cell 0 the schedule draft, cell 1
// the pagefile editor, cell 2 the form error, cell 3 the identity form, cell 4 the power drawer target;
// ref 0 the live props. The shared power flow (ui/devices/management/device-power.tsx) runs on a harness of its own.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {panelHarness} from '../../support/panel-harness.mjs';
import {buttons} from '../../support/blocked-buttons.mjs';
import {de} from '../../support/i18n-stubs.mjs';
process.env.TZ='Europe/Berlin';
const harness=panelHarness({hooked:['ui/devices/management/device-system.tsx']});
const {load,find}=harness;
const {default:System,systemLocalDate,systemScheduleTime,systemActionReason,SYSTEM_SCHEDULE_WINDOW,SYSTEM_SCHEDULE_HEADING,focusSystemSchedule}=load('ui/devices/management/device-system.tsx');
const {PowerDrawer}=load('ui/devices/management/device-power.tsx');
const powerHarness=panelHarness({hooked:['ui/devices/management/device-power.tsx']});
const power=powerHarness.load('ui/devices/management/device-power.tsx');
const now=Date.UTC(2026,9,10,0,45),viewer={id:'owner',label:'Owner',permissions:['*']};
const capabilities=['schedule-power','cancel-power-schedule','restart-computer','shutdown-computer','set-pagefile','refresh','rename-computer','join-domain','leave-domain','set-firewall-rule','add-firewall-rule','set-task'];
const rules=[{name:'RDP-In',displayName:'Remotedesktop',enabled:true,direction:'Inbound',action:'Allow',protocol:'TCP',port:'3389',remoteAddress:'LocalSubnet'},{name:'Old-Out',displayName:'Alte Regel',enabled:false,direction:'Outbound',action:'Block',protocol:'UDP',port:'500',remoteAddress:'Any'}];
const tasks=[{name:'Scheduled Power',path:'\\ServerDesk\\',state:'Ready',lastRun:'',nextRun:'',lastResult:0},{name:'Backup',path:'\\Ops\\',state:'Disabled',lastRun:'2026-10-09 22:00',nextRun:'',lastResult:267011}];
const server={id:'device',name:'WINDOWS-SRV',lastSeen:now-1000,management:1,revoked:0,snapshot:{mode:'Management',hostname:'WINDOWS-SRV',domain:'WORKGROUP',agentCapabilities:capabilities,powerSchedule:null,rebootPending:true,disks:[{name:'C:',freeGb:20}],pagefile:{automatic:true,files:[{name:'C:\\pagefile.sys',initialMb:0,maximumMb:0,allocatedMb:1280,currentUsageMb:512,peakUsageMb:640}]},security:{lastBoot:'2026-10-09T14:41:00Z',domainJoined:false,domainRole:3},firewallRules:rules,tasks}};
let confirmations=[];
const props={server,viewer,demo:false,saving:false,now,jobs:[],onConfirm:value=>confirmations.push(value)};
function reset(){harness.reset();confirmations=[];}
const tree=(overrides={})=>harness.tree(System,{...props,...overrides}),html=(overrides={})=>harness.html(System,{...props,...overrides});
const field=(element,name)=>find(element,item=>(item.type==='input'||(item.type==='select'||item.type?.render?.name==='Select'))&&item.props.name===name);
const change=(name,value,overrides={})=>field(tree(overrides),name).props.onChange({target:{value}});
const form=(element,selector)=>find(element,item=>item.type==='form'&&(item.props.id===selector||item.props.className===selector));
const submit=element=>element.props.onSubmit({preventDefault(){}});
const button=(element,label)=>harness.button(element,label);
const reasonOf=(markup,label)=>buttons(markup).find(item=>item.inner.includes(`<span>${label}</span>`));

assert.equal(systemLocalDate(now),'2026-10-10T02:45');
assert.equal(systemScheduleTime('2026-10-11T03:15',now).at,Date.UTC(2026,9,11,1,15),'browser-local time maps to UTC');
assert.equal(systemScheduleTime('2026-10-25T02:30',now).at,Date.UTC(2026,9,25,0,30),'ambiguous DST hour uses browser Date semantics, shown explicitly as UTC');
assert.match(systemScheduleTime('2027-03-28T02:30',now).error,/lokale Uhrzeit/,'nonexistent DST hour rejected');
for(const invalid of ['','not-a-date','2026-10-40T02:30','2026-13-11T12:30','2026-10-10T02:46'])assert.ok(systemScheduleTime(invalid,now).error);
assert.ok(systemScheduleTime(systemLocalDate(now+SYSTEM_SCHEDULE_WINDOW+60000),now).error);
assert.equal(systemActionReason(props,'schedule-power'),'');
assert.equal(systemActionReason({...props,server:{...server,management:0}},'refresh'),'','readonly refresh retains diagnostic permission');
for(const change of [{demo:true},{saving:true},{viewer:{...viewer,permissions:[]}},{server:{...server,revoked:1}},{server:{...server,management:0}},{server:{...server,lastSeen:now-180000}},{server:{...server,snapshot:{...server.snapshot,mode:'ReadOnly'}}},{server:{...server,snapshot:{...server.snapshot,mode:undefined}}},{server:{...server,snapshot:{...server.snapshot,agentCapabilities:[]}}}])assert.ok(systemActionReason({...props,...change},'schedule-power'));
assert.equal(systemActionReason({...props,viewer:{...viewer,permissions:[]},server:{...server,permissions:['manage']}},'schedule-power'),'');
// Full sentences, in the helper's order.
for(const [flags,key] of [[{demo:true},'kit.unavailable.demo'],[{saving:true},'services.blocked.saving'],[{server:{...server,revoked:1}},'kit.unavailable.revoked'],[{viewer:{...viewer,permissions:[]}},'management.blocked.manage'],[{server:{...server,lastSeen:now-180000}},'management.blocked.offline'],[{server:{...server,management:0}},'management.blocked.readOnly'],[{server:{...server,snapshot:{...server.snapshot,agentCapabilities:[]}}},'system.blocked.scheduleUpdate']]){const reason=systemActionReason({...props,...flags},'schedule-power');assert.equal(reason,de(key));assert.match(reason,/\.$/);}
assert.equal(systemActionReason({...props,server:{...server,snapshot:{...server.snapshot,agentCapabilities:[]}}},'restart-computer'),de('management.blocked.unsupported'));

// ---- One page, no third navigation level ----
reset();let markup=html();
assert.ok(!markup.includes('sd-system-nav')&&!/<button[^>]*aria-current/.test(markup),'no system navigation');
assert.ok(!fs.readFileSync('ui/devices/management/device-system.tsx','utf8').includes('ManagementPanel'),'System no longer renders ManagementPanel');
assert.match(markup,/<h2 class="sr-only">System<\/h2>/);
const headings=[...markup.matchAll(/<h2[^>]*>(?:<span class="sdx-icon-tile[^"]*"[^>]*>.*?<\/span>)?([^<]+)<\/h2>/g)].map(match=>match[1]);
assert.deepEqual(headings,['System','Auslagerungsdatei','Neu starten und herunterfahren','Wartung zum Termin','Computer & Domäne'].map(text=>text.replace('&','&amp;')),'the sections in order: no Firewall rules (Network) and no Scheduled tasks (its own subarea)');
assert.equal((markup.match(/<h2[^>]*><span class="sdx-icon-tile/g)||[]).length,4,'one IconTile per card head');
assert.ok(!markup.includes('Firewall-Regeln')&&!markup.includes('Geplante Aufgaben'),'System has no Firewall rules or Scheduled tasks card');
// KPIs: restart pending is a warning, no accent banner; the page file meter.
assert.match(markup,/class="sdx-kpi sdx-kpi-warning[^"]*"[^>]* aria-label="Neustart: Ausstehend"/);assert.ok(!markup.includes('sd-system-reboot'),'no accent status banner');
assert.match(html({server:{...server,snapshot:{...server.snapshot,rebootPending:false}}}),/aria-label="Neustart: Nicht erforderlich"/);assert.ok(!/sdx-kpi-warning[^"]*"[^>]* aria-label="Neustart/.test(html({server:{...server,snapshot:{...server.snapshot,rebootPending:false}}})));
assert.match(html({server:{...server,snapshot:{...server.snapshot,rebootPending:false}}}),/sdx-icon-tile-success[^>]*>.*?Neustart/,'not required is a success tone');
assert.match(markup,/role="meter" aria-label="Auslagerungsdatei C:\\pagefile.sys: 512\sMiB von 1,3\sGiB verwendet" aria-valuemin="0" aria-valuemax="100" aria-valuenow="40"/);
assert.match(markup,/512\sMiB/);assert.ok(!/\d MB\b/.test(markup),'no MB');assert.ok(!markup.includes('sd-system-file-bar'));
assert.match(markup,/Europe\/Berlin/);assert.ok(!markup.includes('0 / 0'),'automatic pagefile no meaningless initial/maximum zero values');

// ---- Schedule ----
change('time','2026-10-11T03:15');change('reason','CHG-001 · Wartung');
let element=tree();assert.match(harness.html(System,props),/2026-10-11T01:15:00.000Z/);const retainedSchedule=form(element,'sdx-system-schedule-form');submit(retainedSchedule);
assert.deepEqual(confirmations[0].payload,{action:'job',id:'device',kind:'schedule-power',params:{operation:'shutdown',scheduledAt:'2026-10-11T01:15:00.000Z',reason:'CHG-001 · Wartung'},confirm:true});
assert.match(confirmations[0].description,/Europe\/Berlin/);assert.match(confirmations[0].description,/ungespeicherte Arbeit/);assert.match(confirmations[0].description,/nicht nachgeholt/);
assert.deepEqual(confirmations[0].lines,[{label:'Gerät',value:'WINDOWS-SRV'}]);assert.ok(!confirmations[0].description.includes('WINDOWS-SRV'));assert.equal(confirmations[0].confirmLabel,'Planen');
for(const changes of [{viewer:{...viewer,permissions:[]}},{saving:true},{server:{...server,snapshot:{...server.snapshot,mode:'ReadOnly'}}},{server:{...server,id:'other-device'}},{server:{...server,snapshot:{...server.snapshot,powerSchedule:undefined}}},{now:Date.UTC(2026,9,11,1,15)},{jobs:[{id:'job',serverId:'device',action:'schedule-power',state:'pending'}]}]){tree(changes);submit(retainedSchedule);assert.equal(confirmations.length,1,'retained handlers revalidate current rights/scope/mode/clock/known plan and job state');}
reset();change('operation','restart');change('time','2026-10-11T03:15');change('reason','Routine');submit(form(tree(),'sdx-system-schedule-form'));assert.equal(confirmations[0].payload.params.operation,'restart');assert.ok(!confirmations[0].description.includes('Zum Einschalten'));
reset();change('time','2026-10-11T03:15');change('reason','');submit(form(tree(),'sdx-system-schedule-form'));assert.equal(confirmations.length,0);markup=html();assert.match(markup,/1 bis 200/);assert.match(markup,/aria-invalid="true"/,'the error shows at the field');
reset();submit(form(tree(),'sdx-system-schedule-form'));assert.match(html(),new RegExp(`class="sdx-field-error">${de('system.schedule.pickTime')}`));
assert.equal((html().match(/sdx-btn-primary/g)||[]).length,1,'the schedule submit is the only primary button');
reset();const old={...server,snapshot:{...server.snapshot,agentCapabilities:capabilities.filter(kind=>!kind.includes('schedule')),powerSchedule:undefined}};markup=html({server:old});assert.equal(reasonOf(markup,'Termin prüfen').description,de('system.blocked.scheduleUpdate'));assert.ok(!reasonOf(markup,'Neu starten').blocked,'old agent still offers existing immediate actions');
reset();markup=html({server:{...server,snapshot:{...server.snapshot,powerSchedule:undefined}}});assert.match(markup,/Der Agent hat die Windows-Planung noch nicht gemeldet/);assert.equal(reasonOf(markup,'Termin prüfen').description,de('system.scheduled.notCollected'));
reset();markup=html({jobs:[{id:'failed-schedule',serverId:'device',action:'schedule-power',state:'failed',createdAt:now,result:'Windows-Aufgabe konnte nicht bestätigt werden.'}]});assert.match(markup,/class="sdx-notice sdx-notice-danger" role="alert">.*?Planungsauftrag fehlgeschlagen/);assert.match(markup,/Windows-Aufgabe konnte nicht bestätigt werden/);
reset();markup=html({jobs:[{id:'coded-schedule',serverId:'device',action:'schedule-power',state:'failed',createdAt:now,result:'A restart or shutdown is already scheduled. Remove that schedule first.',resultCode:'AGENT_SCHEDULE_EXISTS',resultArgs:null}]});assert.match(markup,/Ein Neustart oder Herunterfahren ist bereits geplant. Entferne diese Planung zuerst./);assert.ok(!markup.includes('A system schedule already exists'));
markup=html({jobs:[{id:'old-failure',serverId:'device',action:'schedule-power',state:'failed',createdAt:now-1000,result:'OLD FAILURE'},{id:'new-success',serverId:'device',action:'cancel-power-schedule',state:'succeeded',createdAt:now,result:'Completed'}]});assert.ok(!markup.includes('OLD FAILURE'),'later completed plan actions supersede an old failure');
const plan={id:'12345678-1234-1234-1234-123456789abc',operation:'shutdown',scheduledAt:'2026-10-11T01:15:00.000Z',reason:'Nightly maintenance'};
const planned={...server,snapshot:{...server.snapshot,powerSchedule:plan}};
reset();element=tree({server:planned});assert.match(harness.html(System,{...props,server:planned}),/In Windows geplant/);assert.ok(!form(element,'sdx-system-schedule-form'),'existing plan must be explicitly removed before replacement');const cancel=button(element,'Planung entfernen');cancel.props.onClick();assert.deepEqual(confirmations[0].payload.params,{scheduleId:plan.id});assert.equal(confirmations[0].payload.kind,'cancel-power-schedule');assert.equal(confirmations[0].tone,'danger');assert.equal(confirmations[0].confirmLabel,'Planung entfernen');
for(const changes of [{server:{...planned,snapshot:{...planned.snapshot,powerSchedule:{...plan,id:'12345678-1234-1234-1234-123456789abd'}}}},{server:{...planned,snapshot:{...planned.snapshot,powerSchedule:{...plan,scheduledAt:'2026-10-12T01:15:00.000Z'}}}},{server:{...planned,snapshot:{...planned.snapshot,powerSchedule:{...plan,operation:'restart'}}}},{viewer:{...viewer,permissions:[]}},{server:{...planned,id:'another-device'}},{jobs:[{serverId:'device',action:'cancel-power-schedule',state:'running'}]}]){tree(changes);cancel.props.onClick();assert.equal(confirmations.length,1,'cancellation is bound to current plan identity, time, operation, rights and device');}
reset();markup=html({server:planned,jobs:[{serverId:'device',action:'cancel-power-schedule',state:'running'}]});assert.equal(reasonOf(markup,'Planung entfernen').description,de('system.scheduled.syncing'));
// "Open scheduling" (Management → Scheduled tasks) focuses the schedule heading of this page.
reset();markup=html();assert.match(markup,new RegExp(`<h2 id="${SYSTEM_SCHEDULE_HEADING}" tabindex="-1">`),'the schedule heading is a focus target');
const focused=[];globalThis.document={getElementById:id=>{focused.push(['get',id]);return {scrollIntoView:options=>focused.push(['scroll',options]),focus:options=>focused.push(['focus',options])};}};
assert.equal(focusSystemSchedule(),true);assert.deepEqual(focused,[['get',SYSTEM_SCHEDULE_HEADING],['scroll',{block:'start',behavior:'auto'}],['focus',{preventScroll:true}]]);
globalThis.document={getElementById:()=>null};assert.equal(focusSystemSchedule(),false,'false while the heading is not rendered yet');delete globalThis.document;

// ---- Power: the System buttons open the shared power flow ----
reset();button(tree(),'Neu starten').props.onClick();const drawer=find(tree(),item=>item.type===PowerDrawer);
assert.deepEqual(drawer.props.target,{serverId:'device',kind:'restart-computer'},'Restart opens the power drawer for this device');assert.deepEqual(drawer.props.servers.map(item=>item.id),['device']);
markup=html();assert.match(markup,/role="dialog"/);assert.match(markup,new RegExp(de('system.prepareRestart')));assert.match(markup,/name="delaySeconds"[^>]*value="300"/);
reset();button(tree(),'Herunterfahren').props.onClick();assert.deepEqual(find(tree(),item=>item.type===PowerDrawer).props.target,{serverId:'device',kind:'shutdown-computer'},'Shut down opens it for the shutdown');
reset();button(tree({server:{...server,lastSeen:now-180000}}),'Neu starten').props.onClick();assert.equal(find(tree(),item=>item.type===PowerDrawer).props.target,null,'a blocked button opens nothing');
// The drawer itself: the lead time and the reason, then the confirmation with the job payload.
{
 const {powerConfirmation,powerInput,powerMenuEntry}=power;
 assert.equal(load('ui/devices/management/device-power.tsx').systemActionReason,systemActionReason,'System re-exports the one blocked reason of the power flow');
 const drawerProps=(target,extra={})=>({target,servers:[server],viewer,demo:false,saving:false,now,onConfirm:value=>confirmations.push(value),onClose:()=>closed.push(1),...extra});
 const closed=[];
 const field=(element,name)=>powerHarness.find(element,item=>item.type==='input'&&item.props.name===name);
 const fill=(target,values,extra)=>{for(const [name,value] of Object.entries(values))field(powerHarness.tree(power.PowerDrawer,drawerProps(target,extra)),name).props.onChange({target:{value}});return powerHarness.find(powerHarness.tree(power.PowerDrawer,drawerProps(target,extra)),item=>item.type==='form');};
 const restartTarget={serverId:'device',kind:'restart-computer'},shutdownTarget={serverId:'device',kind:'shutdown-computer'};
 reset();powerHarness.reset();let form=fill(restartTarget,{delaySeconds:'90',powerReason:'Planned update'});form.props.onSubmit({preventDefault(){}});
 assert.deepEqual(confirmations[0].payload,{action:'job',id:'device',kind:'restart-computer',params:{delaySeconds:90,reason:'Planned update'},confirm:true},'the restart job');
 assert.deepEqual([confirmations[0].title,confirmations[0].confirmLabel,confirmations[0].tone,confirmations[0].lines],[de('system.power.restartTitle'),'Neu starten',undefined,[{label:'Gerät',value:'WINDOWS-SRV'}]],'"Restart server?" with the verb Restart and the default tone');
 assert.equal(closed.length,1,'confirming the review closes the drawer');
 reset();powerHarness.reset();form=fill(shutdownTarget,{powerReason:'Maintenance'});form.props.onSubmit({preventDefault(){}});
 assert.deepEqual(confirmations[0].payload.params,{delaySeconds:300,reason:'Maintenance'},'the default lead time of five minutes');assert.match(confirmations[0].description,/Hypervisor- oder Hardwarezugang/);
 assert.deepEqual([confirmations[0].title,confirmations[0].confirmLabel,confirmations[0].tone],[de('system.power.shutdownTitle'),'Herunterfahren','danger'],'"Shut down server?" is the danger tone');
 reset();powerHarness.reset();form=fill(shutdownTarget,{delaySeconds:'3601',powerReason:'Planned update'});form.props.onSubmit({preventDefault(){}});
 assert.equal(confirmations.length,0,'an invalid lead time asks nothing');assert.match(powerHarness.html(power.PowerDrawer,drawerProps(shutdownTarget)),/3.600 Sekunden/);
 // A retained submit checks the live device again: another device, offline or without the right asks nothing.
 for(const extra of [{servers:[{...server,lastSeen:now-180000}]},{viewer:{...viewer,permissions:[]}},{saving:true},{demo:true}]){
  reset();powerHarness.reset();form=fill(restartTarget,{powerReason:'Planned update'});powerHarness.tree(power.PowerDrawer,drawerProps(restartTarget,extra));form.props.onSubmit({preventDefault(){}});
  assert.equal(confirmations.length,0,'stale submit: '+Object.keys(extra)[0]);
 }
 // The drawer's submit is blocked with the same reason.
 powerHarness.reset();const blockedMarkup=powerHarness.html(power.PowerDrawer,drawerProps(restartTarget,{servers:[{...server,lastSeen:now-180000}]}));
 assert.equal(reasonOf(blockedMarkup,de('management.reviewChange')).description,de('management.blocked.offline'),'Review change is blocked with the reason');
 assert.deepEqual([powerInput('60',' x '),powerInput('59','x'),powerInput('600',''),powerInput('600','a'.repeat(201))],[{delaySeconds:60,reason:'x'},null,null,null],'lead time 60–3600 s, reason 1–200 characters');
 // The device menu and the fleet row use the same entry: blocked with systemActionReason, else it opens the drawer for the device.
 const opened=[];
 for(const [flags,key] of [[{demo:true},'kit.unavailable.demo'],[{saving:true},'services.blocked.saving'],[{server:{...server,revoked:1}},'kit.unavailable.revoked'],[{viewer:{...viewer,permissions:[]}},'management.blocked.manage'],[{server:{...server,lastSeen:now-180000}},'management.blocked.offline'],[{server:{...server,management:0}},'management.blocked.readOnly'],[{server:{...server,snapshot:{...server.snapshot,agentCapabilities:[]}}},'management.blocked.unsupported']]){
  const entry=powerMenuEntry('restart-computer',{...props,...flags},target=>opened.push(target),'de');
  assert.equal(entry.blocked,de(key),'blocked: '+key);entry.onSelect();
 }
 assert.deepEqual(opened,[],'a blocked entry does nothing');
 const entry=powerMenuEntry('shutdown-computer',props,target=>opened.push(target),'de');assert.equal(entry.blocked,undefined);entry.onSelect();
 assert.deepEqual(opened,[{serverId:'device',kind:'shutdown-computer'}],'an open entry opens the drawer for this device');
 assert.deepEqual(powerConfirmation({id:'device',name:'WINDOWS-SRV'},'restart-computer',{delaySeconds:90,reason:'Planned update'},'de').payload,{action:'job',id:'device',kind:'restart-computer',params:{delaySeconds:90,reason:'Planned update'},confirm:true},'the same payload from every entry point');
 for(const source of ['ui/devices/device/device.tsx','ui/devices/fleet/fleet.tsx','ui/devices/management/device-system.tsx'])assert.match(fs.readFileSync(source,'utf8'),/<PowerDrawer /,source+' renders the shared power drawer');
}
// Demo: Restart and Shut down stay focusable with the reason.
reset();markup=html({demo:true});for(const label of ['Neu starten','Herunterfahren']){const blocked=reasonOf(markup,label);assert.ok(blocked.blocked&&!blocked.disabled,label+' stays focusable');assert.equal(blocked.description,de('kit.unavailable.demo'));}
assert.match(markup,new RegExp(`<div>${de('kit.unavailable.demo')} ${de('system.readOnly')}</div>`),'the panel notice');

// ---- Page file ----
reset();button(tree(),'Konfigurieren').props.onClick();markup=html();assert.match(markup,/role="switch"/);submit(form(tree(),'sdx-system-editor'));assert.deepEqual(confirmations[0].payload.params,{automatic:true});assert.equal(confirmations[0].payload.kind,'set-pagefile');assert.equal(confirmations[0].confirmLabel,'Konfigurieren');
reset();button(tree(),'Konfigurieren').props.onClick();field(tree(),'automatic').props.onChange({target:{checked:false}});markup=html();assert.match(markup,/C: · 20\sGiB frei/,'the drive with its free space');assert.match(markup,/Anfangsgröße \(MiB\)/);
change('initialMb','4096');change('maximumMb','8192');submit(form(tree(),'sdx-system-editor'));assert.deepEqual(confirmations[0].payload.params,{automatic:false,drive:'C:',initialMb:4096,maximumMb:8192});assert.match(confirmations[0].description,/C: · 4\sGiB–8\sGiB/,'the review uses IEC units');
reset();button(tree(),'Konfigurieren').props.onClick();field(tree(),'automatic').props.onChange({target:{checked:false}});change('initialMb','8192');change('maximumMb','4096');submit(form(tree(),'sdx-system-editor'));assert.equal(confirmations.length,0);assert.match(html(),/maximale Größe muss/);
reset();button(tree(),'Konfigurieren').props.onClick();const retainedPagefile=form(tree(),'sdx-system-editor');tree({server:{...server,snapshot:{...server.snapshot,pagefile:undefined}}});submit(retainedPagefile);assert.equal(confirmations.length,0,'missing current config blocks retained pagefile dialog action');
reset();assert.equal(reasonOf(html({server:{...server,snapshot:{...server.snapshot,pagefile:undefined}}}),'Konfigurieren').description,de('system.configPending'));
reset();button(tree(),'Inventar aktualisieren').props.onClick();assert.deepEqual(confirmations[0].payload.params,{});assert.equal(confirmations[0].payload.kind,'refresh');

// ---- Computer & domain with the moved rules ----
reset();markup=html();
assert.match(markup,/WINDOWS-SRV/);assert.match(markup,/class="sdx-btn sdx-btn-danger[^"]*"[^>]*>(?:(?!<\/button>).)*Domäne verlassen/,'Leave domain is a danger button');
const dc={...server,snapshot:{...server.snapshot,security:{...server.snapshot.security,domainRole:5}}};markup=html({server:dc});
for(const label of ['Umbenennen','Domäne beitreten','Domäne verlassen'])assert.equal(reasonOf(markup,label).description,de('management.blocked.domainController'),label+' is protected on a domain controller');
markup=html({server:{...server,snapshot:{...server.snapshot,mode:'ReadOnly'}}});for(const label of ['Umbenennen','Domäne beitreten'])assert.equal(reasonOf(markup,label).description,de('management.blocked.readOnly'));
markup=html({viewer:{...viewer,permissions:[]},server:{...server,permissions:['view']}});assert.equal(reasonOf(markup,'Umbenennen').description,de('management.blocked.manage'));
markup=html({server:{...server,snapshot:{...server.snapshot,agentCapabilities:[]}}});assert.equal(reasonOf(markup,'Domäne beitreten').description,de('management.blocked.unsupported'));
markup=html({saving:true});assert.equal(reasonOf(markup,'Umbenennen').description,de('services.blocked.saving'));
// Rename and leave open the Drawer; passwords are never prefilled.
reset();button(tree(),'Umbenennen').props.onClick();markup=html();assert.match(markup,/role="dialog"/);assert.match(markup,/name="name"[^>]*value="WINDOWS-SRV"/);assert.match(markup,/type="password"[^>]*value=""/);
change('name','SRV-NEW');submit(form(tree(),'sdx-system-identity'));assert.deepEqual(confirmations[0].payload,{action:'job',id:'device',kind:'rename-computer',params:{name:'SRV-NEW'},confirm:true});assert.equal(confirmations[0].confirmLabel,'Umbenennen');
reset();button(tree(),'Domäne verlassen').props.onClick();change('username','CORP\\admin');change('password','secret');submit(form(tree(),'sdx-system-identity'));assert.deepEqual(confirmations[0].payload.params,{workgroup:'WORKGROUP',username:'CORP\\admin',password:'secret'});assert.equal(confirmations[0].tone,'danger');assert.equal(confirmations[0].confirmLabel,'Domäne verlassen');assert.ok(!confirmations[0].description.includes('secret'),'the password never shows');
reset();button(tree(),'Domäne beitreten').props.onClick();submit(form(tree(),'sdx-system-identity'));assert.equal(confirmations.length,0,'required fields');assert.match(html(),/aria-invalid="true"/);
console.log('PASS: System on the kit as one page: hidden title, sections in order, restart/page file KPIs with a real meter, native calendar UTC/DST/bounds, exact schedule and identity-guard cancel contracts, pagefile/power confirmations in IEC units, identity actions with the moved rules and unchanged payloads, the shared power flow (System, device menu and fleet row) with its blocked reasons, the danger shutdown and stale checks, Open scheduling focus, readonly/offline/saving/capability/scoped-rights and stale handler checks.');
