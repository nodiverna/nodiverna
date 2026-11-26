// Drive the redesigned DeviceView with linked subareas: the device routes #device/<id>[/<area>[/<sub>[/<n>]]] (lib/console-route.ts) and the link builders of the navigation model (ui/shell/nav-model.ts).
import '../../support/register.mjs';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {i18nRequire} from '../../support/i18n-stubs.mjs';
const {deviceConnection}=await import('../../../ui/base/ui-device.ts');
const consoleRoute=await import('../../../lib/console-route.ts');
const navModel=await import('../../../ui/shell/nav-model.ts');
const extensions=await import('../../../lib/extensions.ts');
const alarmsView=await import('../../../ui/devices/monitoring/alarms-view.ts');
const compile=file=>ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
const overviewFixture={exports:{}};
new Function('require','module','exports',compile('ui/devices/device/device-overview.tsx'))(()=>({}),overviewFixture,overviewFixture.exports);
const {deviceOverviewGpus}=overviewFixture.exports;
// The kit Tabs (tests/ui/kit/kit-tabs.mjs) stands in as a node with its items; a tab acts like the real one: a plain click calls onChange.
function Tabs(props){return {type:'tabs',props};}
// The conversation lives in DeviceView (useAssistantConversation): one state object per device view.
const conversationState={messages:[],stored:[],pending:false,ask:()=>{},retry:()=>{},reset:()=>{}};
// The 760px layout hook: wide by default; a test switches it to render the compact header.
let narrowLayout=false;
function harness(changes={}){
 const cells=[],effects=[];let cursor=0,dirty=false,tree;
 const hooks={useState(initial){const index=cursor++;if(!cells[index])cells[index]={value:typeof initial==='function'?initial():initial};return[cells[index].value,value=>{const next=typeof value==='function'?value(cells[index].value):value;if(!Object.is(next,cells[index].value)){cells[index].value=next;dirty=true;}}];},useRef(initial){const index=cursor++;if(!cells[index])cells[index]={current:initial};return cells[index];},useEffect(fn,deps){const index=cursor++,previous=cells[index];if(!previous||deps.some((value,i)=>!Object.is(value,previous.deps[i]))){cells[index]={deps};effects.push(fn);}}};hooks.useLayoutEffect=hooks.useEffect;
 const jsx=(type,props)=>({type,props:props??{}}),fixture={exports:{}};
 const modules={
  'react':hooks,'react/jsx-runtime':{jsx,jsxs:jsx,Fragment:'Fragment'},'lucide-react':new Proxy({},{get:(_object,key)=>String(key)}),
  '@/ui/base/ui-device':{deviceConnection},'@/ui/devices/device/device-network':{primaryDeviceAddress:()=>undefined},'@/lib/rdp-feature':{REMOTE_DESKTOP_AVAILABLE:false},
  '@/lib/console-route':consoleRoute,'@/ui/shell/nav-model':navModel,'@/ui/shell/nav-icons':{navIcons:new Proxy({},{get:(_object,key)=>String(key)})},'@/lib/extensions':extensions,'@/ui/devices/device/device-overview':{deviceOverviewGpus},'@/ui/devices/diagnostics/diagnostics-panels':{ProcessPanel:'ProcessPanel',SessionPanel:'SessionPanel',ConnectionsPanel:'ConnectionsPanel',EventPanel:'EventPanel'},
  '@/ui/devices/device/device-removal':{deviceRemovalConfirmation:()=>({})},'@/ui/base/access-capabilities':{canManageInstanceSettings:viewer=>viewer.permissions?.includes('*')===true},'@/ui/base/api':{permitted:(server,viewer,right)=>viewer.permissions?.includes('*')===true||server.permissions?.includes(right)===true},
  '@/ui/kit/kit':{Btn:'Btn',IconBtn:'IconBtn',Menu:'Menu',Notice:'Notice',Drawer:'Drawer',StatusPill:'StatusPill',connectionPillKind:kind=>kind==='waiting'?'neutral':kind,cx:(...names)=>names.filter(Boolean).join(' '),exactTime:String,shortOs:String},
  '@/ui/base/narrow-layout':{useNarrowLayout:()=>narrowLayout},'@/ui/base/clock-store':{useClockNow:pinned=>pinned??Date.now()},'@/ui/base/agent-mode':{agentModeLabel:mode=>mode},
  '@/ui/devices/assistant/device-assistant':{default:'DeviceAssistant',__esModule:true,useAssistantConversation:()=>conversationState,sourceAreaRoute:area=>[area.section,'detail' in area?area.detail:undefined]},'@/ui/devices/assistant/assistant-conversations':{earlierConversations:()=>[]},
  '@/ui/devices/device/device-description':{default:'DeviceDescription',__esModule:true,deviceDescriptionBlocked:()=>undefined},'@/ui/devices/configuration/device-tags':{default:'DeviceTags',__esModule:true,deviceTagsBlocked:()=>undefined},
  '@/ui/devices/history/history':{default:'@/ui/devices/history/history',__esModule:true,scopeHistoryCounts:()=>({jobs:2,access:1})},'@/ui/devices/monitoring/alarms':{AlarmHistory:'AlarmHistory'},'@/ui/devices/monitoring/monitoring-summary':{default:'MonitoringSummaryRow',__esModule:true},'@/ui/devices/monitoring/alarms-view':alarmsView,'@/ui/devices/management/device-power':{PowerDrawer:'PowerDrawer',powerMenuEntry:(kind,input,open)=>({onSelect:()=>open({serverId:input.server.id,kind})})},'@/ui/devices/management/device-system':{default:'@/ui/devices/management/device-system',__esModule:true,focusSystemSchedule:()=>false},
  '@/ui/shell/shell':{PageHeader:'PageHeader'},'@/ui/kit/tabs':{Tabs,tabId:(base,id)=>base+'-tab-'+id},'@/ui/devices/device/device-parts':{PlatformMark:'PlatformMark',DeviceStateNotice:'DeviceStateNotice'},
 };
 const require=id=>i18nRequire(id)??(modules[id]??{default:id,__esModule:true});
 new Function('require','module','exports',compile('ui/devices/device/device.tsx'))(require,fixture,fixture.exports);
 const calls={section:[],detail:[],assistant:[]};
 const props={server:{id:'server-a',name:'Host',revoked:0,management:1,lastSeen:Date.now(),snapshot:{mode:'Management'}},servers:[],viewer:{id:'owner',permissions:['*']},demo:false,saving:false,now:Date.now(),
  section:'overview',onSection:section=>calls.section.push(section),onDetail:detail=>calls.detail.push(detail),samples:[],historyLoading:false,jobs:[],audit:[],crumbs:[],
  onConfirm:()=>{},onSelectJob:()=>{},onCancelJob:()=>{},onAssistantOpen:open=>calls.assistant.push(open),permissions:{type:'PermissionEditor',props:{}},alerts:{type:'AlertRules',props:{}},notifications:{type:'NotificationRules',props:{}},canOffboard:false,...changes};
 const nodes=node=>!node||typeof node!=='object'?[]:[node,...[node.props?.children].flat(Infinity).flatMap(nodes)];
 const render=()=>{let count=0;do{dirty=false;cursor=0;tree=fixture.exports.default(props);for(const fn of effects.splice(0))fn();assert.ok(count++<10,'stable render');}while(dirty);};
 const find=predicate=>nodes(tree).find(predicate);
 // A subarea bar: the kit Tabs with that accessible name (the area bar is device.areas).
 const subtabs=label=>find(node=>node.type===Tabs&&node.props.label===label);
 const tab=label=>{const bar=find(node=>node.type===Tabs),item=bar?.props.items.find(entry=>entry.label===label);return item&&{props:{href:item.href,'aria-current':item.id===bar.props.value?'page':undefined,'aria-keyshortcuts':item.shortcut,title:item.title,onClick:event=>{event.preventDefault();bar.props.onChange(item.id);}}};};
 const click=label=>{const event={button:0,ctrlKey:false,metaKey:false,shiftKey:false,altKey:false,preventDefault(){}};assert.ok(tab(label),'tab exists: '+label);tab(label).props.onClick(event);render();};
 render();return {props,calls,render,find,subtabs,tab,click,panel:type=>find(node=>node.type===type),nodes,get tree(){return tree;}};
}

// Linked subareas render the matching panel.
let ui=harness({section:'diagnostics',detail:{deviceDetail:'events'}});
assert.ok(ui.panel('EventPanel'),'events from the link');assert.equal(ui.subtabs('Diagnosebereich').props.value,'events');
ui.props.detail={deviceDetail:'__proto__'};ui.render();assert.ok(ui.panel('ProcessPanel'),'an unknown subarea shows the default');
ui.props.section='management';ui.props.detail={deviceDetail:'updates'};ui.render();assert.ok(ui.panel('@/ui/devices/management/device-updates'),'Windows Update from the link');assert.equal(ui.subtabs('Verwaltungsbereich').props.value,'updates');
ui.props.detail={deviceDetail:'features'};ui.render();assert.ok(ui.panel('@/ui/devices/management/roles-features'),'the shared feature ID renders Roles & features');assert.ok(!ui.panel('@/ui/devices/management/device-accounts'),'and not Accounts');
ui.props.detail={deviceDetail:'accounts'};ui.render();assert.ok(ui.panel('@/ui/devices/management/device-accounts'),'accounts renders the Accounts panel');assert.ok(!ui.panel('@/ui/devices/management/roles-features'),'and not Roles & features');
ui.props.detail={deviceDetail:'tasks'};ui.render();assert.ok(ui.panel('@/ui/devices/management/device-tasks'),'Scheduled tasks from the link');assert.equal(ui.subtabs('Verwaltungsbereich').props.value,'tasks');
ui.panel('@/ui/devices/management/device-tasks').props.onOpenScheduling();assert.deepEqual(ui.calls.detail.at(-1),{deviceDetail:'system'},'Open scheduling opens Management → System');
ui.props.detail={deviceDetail:'system'};ui.render();assert.ok(ui.panel('@/ui/devices/management/device-system'),'and renders System');
ui.props.section='software';ui.props.detail={};ui.render();assert.ok(ui.panel('@/ui/devices/inventory/device-software'),'the Software area shows Programs by default');assert.equal(ui.subtabs('Softwarebereich').props.value,'programs');
for(const [sub,panel] of [['drivers','@/ui/devices/inventory/device-drivers'],['certificates','@/ui/devices/inventory/device-certificates'],['autostart','@/ui/devices/inventory/device-autostart']]){ui.props.detail={deviceDetail:sub};ui.render();assert.ok(ui.panel(panel),sub+' from the link');assert.equal(ui.subtabs('Softwarebereich').props.value,sub);}
assert.deepEqual(consoleRoute.parseConsoleRoute('#devices/d1/management/software'),{view:'device',deviceId:'d1',deviceSection:'software'},'the old management/software link opens Software › Programs');
assert.deepEqual(consoleRoute.parseConsoleRoute('#device/d1/management/drivers'),{view:'device',deviceId:'d1',deviceSection:'software',deviceDetail:'drivers'},'the old management/drivers link opens Software › Drivers');
assert.equal(consoleRoute.consoleRouteHash({view:'device',deviceId:'d1',deviceSection:'software',deviceDetail:'programs'}),'#device/d1/software','Programs is the default and never written');
assert.deepEqual([...consoleRoute.managementDetails],['services','updates','storage','network','accounts','features','tasks','defender','system'],'the Management bar: Scheduled tasks after Roles & features, no Software subareas');
assert.deepEqual([...consoleRoute.softwareDetails],['programs','drivers','certificates','autostart'],'the Software bar');
ui.props.section='hardware';ui.props.detail={deviceDetail:'cpu'};ui.render();assert.equal(ui.panel('@/ui/devices/hardware/device-hardware').props.detail,'cpu');
ui.props.detail={deviceDetail:'gpu',gpu:2};ui.render();assert.equal(ui.panel('@/ui/devices/hardware/device-hardware').props.detail,'gpu');assert.equal(ui.panel('@/ui/devices/hardware/device-hardware').props.gpu,2);
ui.props.detail={};ui.render();assert.equal(ui.panel('@/ui/devices/hardware/device-hardware').props.detail,'overview');assert.equal(ui.panel('@/ui/devices/hardware/device-hardware').props.gpu,undefined);

// Subtabs, overview jumps and indirect links report subarea and GPU position.
const gpuNow=Date.now(),gpus=[{id:'luid_0x0000_phys_0',name:'NVIDIA RTX 4090',vendor:'nvidia',utilization:20,collectedAt:new Date(gpuNow).toISOString()},{id:'luid_0x0001_phys_1',name:'AMD Radeon RX 7900 XTX',vendor:'amd',utilization:30,collectedAt:new Date(gpuNow).toISOString()}];
ui=harness({section:'diagnostics'});ui.props.server={...ui.props.server,snapshot:{mode:'Management',gpus}};ui.render();
ui.subtabs('Diagnosebereich').props.onChange('sessions');ui.render();assert.deepEqual(ui.calls.detail.at(-1),{deviceDetail:'sessions'});assert.deepEqual(ui.calls.section,[],'a subtab keeps the main section');assert.ok(ui.panel('SessionPanel'),'uncontrolled detail falls back to local state');
ui.panel('SessionPanel').props.onSelectUser('CONTOSO\\alice');ui.render();assert.deepEqual(ui.calls.detail.at(-1),{});assert.equal(ui.panel('ProcessPanel').props.selectedUser,'CONTOSO\\alice');
ui.props.section='management';ui.render();ui.subtabs('Verwaltungsbereich').props.onChange('updates');ui.render();assert.deepEqual(ui.calls.detail.at(-1),{deviceDetail:'updates'});assert.ok(ui.panel('@/ui/devices/management/device-updates'));
ui.subtabs('Verwaltungsbereich').props.onChange('network');ui.render();ui.panel('@/ui/devices/management/device-network-panel').props.onOpenConnections();assert.equal(ui.calls.section.at(-1),'diagnostics');assert.deepEqual(ui.calls.detail.at(-1),{deviceDetail:'connections'});
ui.props.section='overview';ui.render();const summary=()=>ui.panel('@/ui/devices/device/device-summary');
summary().props.onNavigate({section:'hardware',hardware:'gpu',gpuId:'luid_0x0001_phys_1'});assert.equal(ui.calls.section.at(-1),'hardware');assert.deepEqual(ui.calls.detail.at(-1),{deviceDetail:'gpu',gpu:2},'GPU jumps carry the position');
summary().props.onNavigate({section:'hardware',hardware:'gpu',gpuId:'luid_0x0000_phys_0'});assert.deepEqual(ui.calls.detail.at(-1),{deviceDetail:'gpu'});
const before=ui.calls.detail.length;summary().props.onNavigate({section:'hardware',hardware:'gpu',gpuId:'luid_unknown'});assert.equal(ui.calls.detail.length,before,'an unknown GPU is not a target');
for(const management of ['storage','network','system','updates']){summary().props.onNavigate({section:'management',management,drive:'C:'});assert.equal(ui.calls.section.at(-1),'management');assert.deepEqual(ui.calls.detail.at(-1),{deviceDetail:management});}
summary().props.onNavigate({section:'diagnostics',diagnosis:'processes'});assert.deepEqual(ui.calls.detail.at(-1),{});
assert.doesNotMatch(JSON.stringify(ui.calls.detail),/luid|C:|alice/,'adapter IDs, drives and process users stay out of the route');
ui.props.section='hardware';ui.render();ui.panel('@/ui/devices/hardware/device-hardware').props.onDetailChange('memory');assert.deepEqual(ui.calls.detail.at(-1),{deviceDetail:'memory'});ui.panel('@/ui/devices/hardware/device-hardware').props.onDetailChange('gpu',2);assert.deepEqual(ui.calls.detail.at(-1),{deviceDetail:'gpu',gpu:2});
ui.props.section='remote';ui.render();ui.subtabs('Bereich Fernzugriff').props.onChange('terminal');assert.equal(ui.calls.section.at(-1),'terminal');assert.deepEqual(ui.calls.detail.at(-1),{});

// Every subarea bar is the kit Tabs (pill, overflow "More") with link tabs to its subarea route and one tabpanel (DV-tabs-2, DV-tabs-4, DV-added-1).
{
 const hash=(deviceSection,deviceDetail)=>consoleRoute.consoleRouteHash({view:'device',deviceId:'server-a',deviceSection,deviceDetail});
 const bars=[
  ['diagnostics','Diagnosebereich',['processes','sessions','events','connections'].map(id=>hash('diagnostics',id))],
  ['management','Verwaltungsbereich',[...consoleRoute.managementDetails].map(id=>hash('management',id))],
  ['remote','Bereich Fernzugriff',['files','terminal','rdp'].map(id=>hash(id))],
  ['automation','Bereich Automation',['runbooks','desired','drift'].map(id=>hash(id))],
  ['software','Softwarebereich',['programs','drivers','certificates','autostart'].map(id=>hash('software',id))],
  ['history','Bereich Historie',['jobs','access'].map(id=>hash('history',id))],
  ['monitoring','Monitoring-Bereich',['alarms','alert-rules','notification-rules'].map(id=>hash('monitoring',id))],
 ];
 for(const [section,label,hrefs] of bars){
  const view=harness({section}),bar=view.subtabs(label);
  assert.ok(bar,section+': a subarea Tabs bar named '+label);
  assert.deepEqual([bar.props.variant,bar.props.overflow,bar.props.panelId],['pill','menu','sdx-device-subpanel'],section+': pill, overflow menu and the subarea panel');
  assert.deepEqual(bar.props.items.map(item=>item.href),hrefs,section+': every subarea is a link tab to its route');
  const panel=view.find(node=>node.props?.role==='tabpanel'&&node.props.id==='sdx-device-subpanel');
  assert.equal(panel?.props['aria-labelledby'],'sdx-device-subpanel-tab-'+bar.props.value,section+': the subarea content is the tabpanel labelled by the active tab');
 }
 assert.equal(hash('management','updates'),'#device/server-a/management/updates');assert.equal(hash('terminal'),'#device/server-a/remote/terminal');
 // The Software subtabs link to the Software area; Files, Terminal and Remote Desktop to remote, the automation subtabs to automation.
 const software=harness({section:'software'}).subtabs('Softwarebereich').props.items;
 assert.deepEqual(software.map(item=>[item.label,item.href]),[['Programme','#device/server-a/software'],['Treiber','#device/server-a/software/drivers'],['Zertifikate','#device/server-a/software/certificates'],['Autostart','#device/server-a/software/autostart']],'the Software subtabs link to #device/<id>/software[/…]');
 const management=harness({section:'management'}).subtabs('Verwaltungsbereich').props.items,href=id=>management.find(item=>item.id===id)?.href;
 assert.deepEqual(['services','updates','tasks','defender','software','drivers'].map(href),['#device/server-a/management','#device/server-a/management/updates','#device/server-a/management/tasks','#device/server-a/management/defender',undefined,undefined],'Management has Scheduled tasks and no Software subtabs');
 assert.deepEqual(harness({section:'remote'}).subtabs('Bereich Fernzugriff').props.items.map(item=>item.href),['#device/server-a/remote','#device/server-a/remote/terminal','#device/server-a/remote/rdp']);
 assert.deepEqual(harness({section:'automation'}).subtabs('Bereich Automation').props.items.map(item=>item.href),['#device/server-a/automation','#device/server-a/automation/desired','#device/server-a/automation/drift']);
 const drivers=harness({section:'software',detail:{deviceDetail:'drivers'}});
 assert.deepEqual([drivers.tab('Software').props['aria-current'],drivers.subtabs('Softwarebereich').props.value],['page','drivers'],'#device/<id>/software/drivers: the Software area tab and the Drivers subtab are selected');
 // The paused Remote Desktop keeps its plain label and carries the state as a tag.
 const rdpTab=harness({section:'remote'}).subtabs('Bereich Fernzugriff').props.items[2];
 assert.deepEqual([rdpTab.label,rdpTab.tag],['Remote Desktop','Pausiert'],'the paused Remote Desktop tab: label "Remote Desktop", tag "Pausiert"');
 assert.equal(harness({section:'remote'}).subtabs('Bereich Fernzugriff').props.items[1].tag,undefined,'only the paused tab carries a tag');
 // The Terminal opens without autoConnect: opening the subarea starts no session.
 const terminalView=harness({section:'terminal'}),terminal=terminalView.panel('@/ui/devices/remote/terminal-panel');
 assert.ok(terminal,'the Terminal subarea renders the terminal panel');assert.equal('autoConnect' in terminal.props,false,'the TerminalPanel gets no autoConnect prop');
 assert.doesNotMatch(fs.readFileSync('ui/devices/device/device.tsx','utf8'),/autoConnect/,'device.tsx never asks for an automatic connect');
 // The paused Remote Desktop subarea offers the terminal: its action switches to the Terminal subarea.
 const rdpView=harness({section:'rdp'}),rdp=rdpView.panel('@/ui/devices/remote/rdp-panel');
 assert.equal(typeof rdp.props.onOpenTerminal,'function','the RDP subarea gets the Open terminal callback');
 rdp.props.onOpenTerminal();assert.equal(rdpView.calls.section.at(-1),'terminal','Open terminal switches to the Terminal subarea');
 // Hardware: the bar lives in DeviceHardware; DeviceView gives it the subarea links and the panel id.
 const hardware=harness({section:'hardware'}).panel('@/ui/devices/hardware/device-hardware');
 assert.equal(hardware.props.panelId,'sdx-device-subpanel');
 assert.deepEqual([hardware.props.subareaHref('cpu'),hardware.props.subareaHref('gpu',2),hardware.props.subareaHref('overview')],['#device/server-a/hardware/cpu','#device/server-a/hardware/gpu/2','#device/server-a/hardware'],'hardware subarea links carry the GPU position');
 const hardwareSource=fs.readFileSync('ui/devices/hardware/device-hardware.tsx','utf8');
 assert.doesNotMatch(hardwareSource,/sd-subnav/,'device-hardware.tsx has no sd-subnav any more');
 assert.ok(hardwareSource.includes("<Tabs variant=\"pill\" overflow=\"menu\" label={t('hardware.areas')} panelId={panelId}"),'Hardware uses Tabs pill with overflow menu, named hardware.areas');
 assert.ok(hardwareSource.includes("id==='gpu'&&gpus.length>1?t('hardware.gpus')"),'the GPU label stays plural with more than one GPU');
 assert.match(hardwareSource,/<div className="dhw-toolbar"><Tabs [^\n]*\/><Btn variant="secondary" size="sm"/,'the copy button stays in the same row, after the tab bar');
 assert.ok(!fs.readFileSync('ui/devices/device/device.tsx','utf8').includes('<Segmented'),'device.tsx renders no Segmented subareas');
}
// The area bar: the areas of review §2.3 in order, underline Tabs without icons, link tabs, the keys 1–9 in the title; no Plugins, Alert rules, Assistant or Permissions tab.
{
 const areaBar=view=>view.find(node=>node.type===Tabs&&node.props.label==='Gerätebereiche');
 const plain=areaBar(harness({}));
 assert.deepEqual(plain.props.items.map(item=>[item.id,item.label,item.href,item.shortcut,item.title]),[
  ['overview','Überblick','#device/server-a','1','Überblick (1)'],['hardware','Hardware','#device/server-a/hardware','2','Hardware (2)'],['software','Software','#device/server-a/software','3','Software (3)'],
  ['diagnostics','Diagnose','#device/server-a/diagnostics','4','Diagnose (4)'],['management','Verwaltung','#device/server-a/management','5','Verwaltung (5)'],['remote','Fernzugriff','#device/server-a/remote','6','Fernzugriff (6)'],
  ['automation','Automation','#device/server-a/automation','7','Automation (7)'],['history','Historie','#device/server-a/history','8','Historie (8)'],
  ['monitoring','Monitoring','#device/server-a/monitoring',undefined,undefined],['configuration','Konfiguration','#device/server-a/configuration/permissions',undefined,undefined],
 ],'the areas, their links and keys; Monitoring and Configuration have no key');
 assert.equal(plain.props.variant,undefined,'the area bar is the underline Tabs');
 for(const absent of ['Plugins','Alarmregeln','Assistent','Berechtigungen'])assert.ok(!plain.props.items.some(item=>item.label===absent),absent+' is no area tab');
}
// The parsed panel links of slice 3 are areas or the drawer now.
assert.deepEqual(consoleRoute.parseConsoleRoute('#devices/d1/alerts'),{view:'device',deviceId:'d1',deviceSection:'monitoring',deviceDetail:'alert-rules'},'the old alerts link opens Monitoring › Alert rules');
assert.deepEqual(consoleRoute.parseConsoleRoute('#devices/d1/permissions'),{view:'device',deviceId:'d1',deviceSection:'configuration'},'the old permissions link opens Configuration (Permissions)');
assert.deepEqual(consoleRoute.parseConsoleRoute('#device/d1/assistant'),{view:'device',deviceId:'d1',deviceSection:'overview',assistant:true},'the assistant link opens the device with the drawer');
assert.equal(consoleRoute.consoleRouteHash({view:'device',deviceId:'d1',deviceSection:'management',deviceDetail:'updates'}),'#device/d1/management/updates','area links use the singular root');
// The second segment after #devices is a reserved word: a device whose id is one is no longer reachable through the old link.
assert.deepEqual(consoleRoute.parseConsoleRoute('#devices/alerts/overview'),{view:'devices',tab:'alerts'},'alerts is reserved: the old fleet tab');
assert.equal(consoleRoute.consoleRouteHash({view:'device',deviceId:'alerts',deviceSection:'configuration'}),'#device/alerts/configuration/permissions','a device named alerts has its own root');
assert.deepEqual(consoleRoute.parseConsoleRoute('#devices/alerts'),{view:'devices',tab:'alerts'},'the old fleet alert rules link opens Monitoring › Alert rules');
assert.deepEqual(consoleRoute.parseConsoleRoute('#devices/d1/tags'),{view:'device',deviceId:'d1',deviceSection:'overview'},'an unknown third segment is no panel');
// Monitoring: Alarms by default with the summary row and the state notice, then Alert rules and Notification
// rules without the notice; the History has Jobs and Device access only.
{
 const view=harness({section:'monitoring'});
 assert.ok(view.panel('AlarmHistory'),'Alarms is the default');assert.equal(view.panel('AlarmHistory').props.summary?.type,'MonitoringSummaryRow','the summary row shows first in the Alarms block');
 assert.deepEqual(view.subtabs('Monitoring-Bereich').props.items.map(item=>[item.id,item.label,item.href]),[['alarms','Alarme','#device/server-a/monitoring'],['alert-rules','Alarmregeln','#device/server-a/monitoring/alert-rules'],['notification-rules','Benachrichtigungsregeln','#device/server-a/monitoring/notification-rules']],'the Monitoring subtabs');
 assert.ok(view.panel('DeviceStateNotice'),'Alarms shows the device state notice');
 const summaryRow=view.panel('AlarmHistory').props.summary;
 assert.deepEqual([summaryRow.props.alertScope,summaryRow.props.notificationScope],[{type:'device',id:'server-a'},{type:'device',id:'server-a'}],'the summary reads the device rules');
 summaryRow.props.onOpenNotificationRules();assert.deepEqual(view.calls.detail.at(-1),{deviceDetail:'notification-rules'},'the notification tile opens Notification rules');
 summaryRow.props.onOpenAlertRules();assert.deepEqual(view.calls.detail.at(-1),{deviceDetail:'alert-rules'},'the alert tile opens Alert rules');
 view.props.detail={deviceDetail:'alert-rules'};view.render();
 assert.ok(view.panel('AlertRules'),'Alert rules from the link');assert.equal(view.panel('AlarmHistory'),undefined);assert.equal(view.panel('DeviceStateNotice'),undefined,'no state notice on Alert rules');assert.equal(view.panel('MonitoringSummaryRow'),undefined,'the summary only on Alarms');
 view.props.detail={deviceDetail:'notification-rules'};view.render();
 assert.ok(view.panel('NotificationRules'),'Notification rules from the link');assert.equal(view.panel('DeviceStateNotice'),undefined,'no state notice on Notification rules');
 assert.deepEqual([...consoleRoute.historyDetails],['jobs','access'],'the History has no Alarms view');
 const history=harness({section:'history'});
 assert.deepEqual(history.subtabs('Bereich Historie').props.items.map(item=>item.id),['jobs','access'],'no Alarms tab in the History bar');
 assert.equal(history.panel('AlarmHistory'),undefined);
}
// The Monitoring tab counts the open alarms in the tone of the worst level; nothing at 0.
{
 const areaItem=(view,id)=>view.find(node=>node.type===Tabs&&node.props.label==='Gerätebereiche').props.items.find(item=>item.id===id);
 const quiet=harness({});assert.deepEqual([areaItem(quiet,'monitoring').count,areaItem(quiet,'monitoring').tone],[undefined,undefined],'no count without open alarms');
 const alarmed=harness({});alarmed.props.server={...alarmed.props.server,alerts:[{id:'a1',level:'warning'},{id:'a2',level:'critical'},{id:'a3',level:'info'}]};alarmed.render();
 assert.deepEqual([areaItem(alarmed,'monitoring').count,areaItem(alarmed,'monitoring').tone],[3,'critical'],'the open alarms with the worst tone');
 const warned=harness({});warned.props.server={...warned.props.server,alerts:[{id:'a1',level:'warning'}]};warned.render();
 assert.deepEqual([areaItem(warned,'monitoring').count,areaItem(warned,'monitoring').tone],[1,'warning']);
}
// Configuration holds Permissions only, without a bar and without a state notice; without the right the area is absent and a
// Configuration link shows Monitoring › Alert rules.
{
 const view=harness({section:'configuration'});
 assert.ok(view.panel('PermissionEditor'),'Permissions');assert.equal(view.panel('AlertRules'),undefined);
 assert.equal(view.subtabs('Konfigurationsbereich'),undefined,'no bar with one subarea');
 assert.equal(view.panel('DeviceStateNotice'),undefined,'Configuration shows no device state notice');
 const reader=harness({section:'configuration',permissions:undefined,viewer:{id:'reader',permissions:[]}});
 assert.ok(reader.panel('AlertRules'),'Configuration without the right shows Monitoring › Alert rules');assert.equal(reader.panel('PermissionEditor'),undefined);
 const bar=reader.find(node=>node.type===Tabs&&node.props.label==='Gerätebereiche');
 assert.equal(bar.props.value,'monitoring','the Monitoring tab is selected');assert.ok(!bar.props.items.some(item=>item.id==='configuration'),'no Configuration tab without the right');
 assert.equal(reader.subtabs('Monitoring-Bereich').props.value,'alert-rules');
 assert.equal(consoleRoute.consoleRouteHash({view:'device',deviceId:'d1',deviceSection:'configuration'}),'#device/d1/configuration/permissions','the Permissions link is always written');
 assert.deepEqual(consoleRoute.parseConsoleRoute('#device/d1/configuration/permissions'),{view:'device',deviceId:'d1',deviceSection:'configuration'});
 for(const [old,hash] of [['#device/d1/history/alarms','#device/d1/monitoring'],['#device/d1/configuration','#device/d1/monitoring/alert-rules'],['#device/d1/configuration/alert-rules','#device/d1/monitoring/alert-rules'],['#devices/d1/alerts','#device/d1/monitoring/alert-rules'],['#devices/d1/permissions','#device/d1/configuration/permissions'],['#devices/d1/history','#device/d1/history'],['#device/d1/monitoring/unknown','#device/d1/monitoring']])
  assert.equal(consoleRoute.consoleRouteHash(consoleRoute.parseConsoleRoute(old)),hash,old);
}

// Main tabs reset the subarea, and rights still apply.
ui=harness({section:'diagnostics',detail:{deviceDetail:'events'}});ui.click('Diagnose');assert.deepEqual(ui.calls.section,['diagnostics']);assert.deepEqual(ui.calls.detail,[{}],'a main tab starts at the section default');
ui=harness({section:'diagnostics',detail:{deviceDetail:'events'}});ui.click('Konfiguration');assert.deepEqual(ui.calls.section,['configuration']);assert.deepEqual(ui.calls.detail,[{}],'Configuration opens at Permissions');
ui=harness({section:'diagnostics',detail:{deviceDetail:'events'}});ui.click('Monitoring');assert.deepEqual(ui.calls.section,['monitoring']);assert.deepEqual(ui.calls.detail,[{}],'Monitoring opens at Alarms');
ui=harness({section:'diagnostics'});ui.subtabs('Diagnosebereich').props.onChange('events');ui.render();assert.ok(ui.panel('EventPanel'));ui.props.server={...ui.props.server,id:'server-b'};ui.render();assert.ok(ui.panel('ProcessPanel'),'a new device never inherits the local subarea');
ui=harness({section:'overview',viewer:{id:'reader',permissions:[]}});ui.props.server={...ui.props.server,permissions:[],snapshot:{mode:'Management',gpus}};ui.render();ui.panel('@/ui/devices/device/device-summary').props.onNavigate({section:'hardware',hardware:'gpu',gpuId:'luid_0x0001_phys_1'});assert.deepEqual(ui.calls.detail,[],'without view right an overview jump is ignored');
ui=harness({section:'hardware',detail:{deviceDetail:'gpu',gpu:2},viewer:{id:'reader',permissions:[]}});assert.equal(ui.panel('@/ui/devices/hardware/device-hardware').props.viewer.id,'reader','DeviceHardware keeps its own view check for linked subareas');
// The Extensions area: the route round-trips; it shows only for a device with a detected role or product, before Configuration with key 9.
assert.deepEqual(consoleRoute.parseConsoleRoute('#device/d1/extensions'),{view:'device',deviceId:'d1',deviceSection:'extensions'},'#device/<id>/extensions parses');
assert.equal(consoleRoute.consoleRouteHash({view:'device',deviceId:'d1',deviceSection:'extensions'}),'#device/d1/extensions','and writes extensions');
assert.equal(consoleRoute.deviceSectionLabels.extensions,'device.section.extensions','the Extensions label key');
// The former Server roles links have no redirect: they open the device Overview like any unknown area.
assert.deepEqual([consoleRoute.parseConsoleRoute('#device/d1/server-roles'),consoleRoute.parseConsoleRoute('#device/d1/server-roles/dhcp'),consoleRoute.parseConsoleRoute('#devices/d1/roles')],[{view:'device',deviceId:'d1',deviceSection:'overview'},{view:'device',deviceId:'d1',deviceSection:'overview'},{view:'device',deviceId:'d1',deviceSection:'overview'}],'server-roles and the old roles section open the Overview');
// The DHCP server of the DHCP extension is an Extensions subarea: #device/<id>/extensions/dhcp round-trips, the overview is the default and never written.
assert.deepEqual(consoleRoute.parseConsoleRoute('#device/d1/extensions/dhcp'),{view:'device',deviceId:'d1',deviceSection:'extensions',deviceDetail:'dhcp'},'#device/<id>/extensions/dhcp parses');
assert.equal(consoleRoute.consoleRouteHash({view:'device',deviceId:'d1',deviceSection:'extensions',deviceDetail:'dhcp'}),'#device/d1/extensions/dhcp','and writes extensions/dhcp');
assert.equal(consoleRoute.consoleRouteHash({view:'device',deviceId:'d1',deviceSection:'extensions',deviceDetail:'overview'}),'#device/d1/extensions','the overview default is not written');
assert.deepEqual(consoleRoute.deviceDetailRoute('extensions','dns'),{deviceDetail:'dns'},'the DNS server is an Extensions subarea');
assert.deepEqual(consoleRoute.parseConsoleRoute('#device/d1/extensions/dns/contoso.com'),{view:'device',deviceId:'d1',deviceSection:'extensions',deviceDetail:'dns',zone:'contoso.com'},'#device/<id>/extensions/dns/<zone> parses');
assert.equal(consoleRoute.consoleRouteHash({view:'device',deviceId:'d1',deviceSection:'extensions',deviceDetail:'dns'}),'#device/d1/extensions/dns','and writes extensions/dns');
assert.deepEqual(consoleRoute.deviceDetailRoute('extensions','wins'),{},'an unknown Extensions subarea falls back to the overview');
assert.deepEqual(consoleRoute.deviceDetailRoute('extensions','dhcp'),{deviceDetail:'dhcp'},'dhcp is kept');
const dhcpServer={snapshot:{mode:'Management',os:'Microsoft Windows Server 2022 Standard',features:[{name:'DHCP',displayName:'DHCP-Server',installed:true,featureType:'Role'}]}};
ui=harness({section:'extensions'});ui.props.server={...ui.props.server,...dhcpServer};ui.render();
assert.equal(ui.tab('Erweiterungen').props['aria-current'],'page','the Extensions tab is current');assert.equal(ui.tab('Erweiterungen').props['aria-keyshortcuts'],'9','Extensions has key 9');
assert.equal(ui.tab('Konfiguration').props['aria-keyshortcuts'],undefined,'Configuration stays without a key');
assert.ok(ui.panel('@/ui/devices/extensions/device-extensions'),'the Extensions area renders');assert.equal('onBack' in ui.panel('@/ui/devices/extensions/device-extensions').props,false,'no back control');ui.panel('@/ui/devices/extensions/device-extensions').props.onOpenArea('features');
assert.deepEqual([ui.calls.section.at(-1),ui.calls.detail.at(-1)],['management',{deviceDetail:'features'}],'the jump opens Management → Roles & features');
ui.panel('@/ui/devices/extensions/device-extensions').props.onOpenArea('software');assert.deepEqual([ui.calls.section.at(-1),ui.calls.detail.at(-1)],['software',{}],'Open software opens Software › Programs');
// The pill bar: Overview, then DHCP only with the DHCP role; link tabs and the subarea panel.
assert.deepEqual(ui.subtabs('Bereich Erweiterungen').props.items.map(item=>[item.label,item.href]),[['Überblick','#device/server-a/extensions'],['DHCP-Server','#device/server-a/extensions/dhcp']],'the Extensions subtabs of a DHCP server');
ui.subtabs('Bereich Erweiterungen').props.onChange('dhcp');assert.deepEqual(ui.calls.detail.at(-1),{deviceDetail:'dhcp'},'the DHCP subtab reports its detail');
ui.panel('@/ui/devices/extensions/device-extensions').props.onDetail('dhcp');assert.deepEqual(ui.calls.detail.at(-1),{deviceDetail:'dhcp'},'"Open DHCP" selects the subtab');
ui.props.detail={deviceDetail:'dns'};ui.render();assert.equal(ui.panel('@/ui/devices/extensions/device-extensions').props.detail,'overview','a DNS link on a device without the DNS role shows the Overview subtab');assert.equal(ui.subtabs('Bereich Erweiterungen').props.value,'overview');
{
 const productOnly={snapshot:{mode:'Management',os:'Microsoft Windows Server 2022 Standard',features:[{name:'Print-Services',displayName:'Druck- und Dokumentdienste',installed:true,featureType:'Role'}]}};
 const view=harness({section:'extensions'});view.props.server={...view.props.server,...productOnly};view.render();
 assert.equal(view.subtabs('Bereich Erweiterungen'),undefined,'no bar with only the Overview subtab');assert.ok(view.panel('@/ui/devices/extensions/device-extensions'));
}
ui=harness({section:'overview'});ui.props.server={...ui.props.server,...dhcpServer};ui.render();ui.click('Erweiterungen');assert.deepEqual(ui.calls.section,['extensions'],'the Extensions tab opens the area');
ui=harness({section:'extensions'});
assert.equal(ui.tab('Erweiterungen'),undefined,'no Extensions tab without a detection');
assert.equal(ui.tab('Überblick').props['aria-current'],'page','an Extensions link without a detection shows the Overview tab active');
assert.ok(ui.panel('@/ui/devices/device/device-summary'),'and the Overview area, not a blank body');assert.equal(ui.panel('@/ui/devices/extensions/device-extensions'),undefined);

// The device History views are routed. The detail picks the view; switching it reports the detail (the console writes the hash with a history entry).
{
 for(const [detail,tab] of [[{},'jobs'],[{deviceDetail:'access'},'access'],[{deviceDetail:'alarms'},'jobs'],[{deviceDetail:'other'},'jobs']]){
  const view=harness({section:'history',detail});
  assert.equal(view.panel('@/ui/devices/history/history').props.tab,tab,'the History view from the link: '+tab);
 }
 const view=harness({section:'history'});view.panel('@/ui/devices/history/history').props.onTab('access');assert.deepEqual(view.calls.detail.at(-1),{deviceDetail:'access'},'switching to Device access reports the access detail');
 const bar=view.subtabs('Bereich Historie');assert.deepEqual(bar.props.items.map(item=>[item.id,item.href,item.count]),[['jobs','#device/server-a/history',2],['access','#device/server-a/history/access',1]],'the History views are link tabs of the shared subarea bar, with their counts; the alarms are Monitoring › Alarms');
 assert.deepEqual([bar.props.variant,bar.props.className,view.panel('@/ui/devices/history/history').props.viewSwitch],['pill','sdx-subtabs',false],'the same pill bar as the other areas; the panel shows no switch of its own');bar.props.onChange('access');assert.deepEqual(view.calls.detail.at(-1),{deviceDetail:'access'},'a History subtab reports its view');
 view.panel('@/ui/devices/history/history').props.onTab('jobs');assert.deepEqual(view.calls.detail.at(-1),{},'Jobs is the default and not written');
 assert.deepEqual(['#device/d1/history','#device/d1/history/access'].map(hash=>consoleRoute.parseConsoleRoute(hash).deviceDetail),[undefined,'access']);
 assert.equal(consoleRoute.consoleRouteHash({view:'device',deviceId:'d1',deviceSection:'history',deviceDetail:'alarms'}),'#device/d1/history','alarms is no History view any more');
}
// The DNS zone page: the Extensions area passes the zone of the link and reports a zone change as the dns detail with the zone.
{
 const dnsServer={snapshot:{mode:'Management',os:'Microsoft Windows Server 2022 Standard',features:[{name:'DNS',displayName:'DNS-Server',installed:true,featureType:'Role'}]}};
 const view=harness({section:'extensions',detail:{deviceDetail:'dns',zone:'contoso.com'}});view.props.server={...view.props.server,...dnsServer};view.render();
 const extensions=view.panel('@/ui/devices/extensions/device-extensions');assert.deepEqual([extensions.props.detail,extensions.props.zone],['dns','contoso.com'],'the zone of the link reaches the DNS view');
 extensions.props.onZone('fabrikam.com');assert.deepEqual(view.calls.detail.at(-1),{deviceDetail:'dns',zone:'fabrikam.com'},'opening a zone reports it');
 extensions.props.onZone(null);assert.deepEqual(view.calls.detail.at(-1),{deviceDetail:'dns'},'back to the zone list');
}
// The header: "Ask assistant" opens the non-modal drawer, which stays open on an area change with the
// same conversation; "More actions" opens the description editor and the add-tag form in the meta line.
{
 const view=harness({section:'overview',assistantOpen:false});
 const head=()=>view.find(node=>node.type==='PageHeader');
 const inHeader=predicate=>view.nodes(head().props.actions).concat(view.nodes(head().props.badges),view.nodes(head().props.description)).find(predicate);
 const ask=inHeader(node=>node.type==='Btn'&&node.props.icon==='Sparkles');
 assert.ok(ask,'the wide header has the Ask assistant button with the Sparkles icon');assert.equal(ask.props.children,'Assistent fragen','labelled Ask assistant');
 assert.equal(ask.props.variant,'tinted','the wide Ask assistant is the tinted Btn');
 ask.props.onClick();assert.deepEqual(view.calls.assistant,[true],'it asks the console to open the drawer');
 const drawer=()=>view.find(node=>node.type==='Drawer');
 assert.equal(drawer().props.open,false,'closed until the console opens it');
 view.props.assistantOpen=true;view.render();
 assert.deepEqual([drawer().props.open,drawer().props.modal,drawer().props.wide],[true,false,true],'a wide non-modal drawer');
 const assistant=()=>view.nodes(drawer()).find(node=>node.type==='DeviceAssistant');
 assert.equal(assistant().props.inDrawer,true,'the assistant renders inside the drawer');
 const conversation=assistant().props.conversation;
 view.props.section='hardware';view.render();assert.equal(drawer().props.open,true,'the drawer stays open on an area change');assert.equal(assistant().props.conversation,conversation,'and keeps the conversation');
 assistant().props.onOpenArea({section:'software',detail:'drivers'});assert.deepEqual([view.calls.section.at(-1),view.calls.detail.at(-1)],['software',{deviceDetail:'drivers'}],'a Software source chip opens its area behind the drawer');
 drawer().props.onClose();assert.deepEqual(view.calls.assistant,[true,false],'Close asks the console to close it');
 const revoked=harness({server:{id:'server-a',name:'Host',revoked:1,management:1,lastSeen:Date.now(),snapshot:{mode:'Management'}},assistantOpen:true});
 assert.equal(revoked.find(node=>node.type==='Drawer').props.open,false,'never on a revoked device');
 // Compact header (760px or narrower): the same tinted Btn with its label in the title line, between refresh and More actions.
 narrowLayout=true;
 try{
  const compact=harness({section:'overview',assistantOpen:false});
  const compactHead=compact.find(node=>node.type==='PageHeader');
  assert.equal(compactHead.props.actions,undefined,'compact: no actions row');
  const line=compact.nodes(compactHead.props.badges).find(node=>node.type==='span'&&node.props.className==='sdx-page-line-actions');
  assert.ok(line,'compact: the line actions sit in the badges');
  const lineControls=[line.props.children].flat(Infinity).filter(node=>node&&typeof node==='object');
  assert.deepEqual(lineControls.map(node=>node.type==='Menu'?'Menu':node.props.icon),['RefreshCw','Sparkles','Menu'],'compact: refresh, Ask assistant, More actions');
  const compactAsk=lineControls[1];
  assert.deepEqual([compactAsk.type,compactAsk.props.variant,compactAsk.props.children,compactAsk.props['aria-expanded']],['Btn','tinted','Assistent fragen',false],'compact: a tinted Btn with the visible label and aria-expanded');
  assert.match(compactAsk.props.className,/(?:^|\s)sdx-device-ask(?:\s|$)/,'compact: the sdx-device-ask class for the 32px and 520px rules');
  compactAsk.props.onClick();assert.deepEqual(compact.calls.assistant,[true],'compact: a click asks the console to open the drawer');
  const compactDrawer=compact.find(node=>node.type==='Drawer');
  assert.ok(compactAsk.props.ref&&compactDrawer.props.returnFocus===compactAsk.props.ref,'compact: the drawer returns focus to the same button ref');
  assert.equal(compact.nodes(compactHead.props.badges).filter(node=>node.props?.icon==='Sparkles').length,1,'compact: one Ask assistant control');
 }finally{narrowLayout=false;}
 assert.equal(drawer().props.returnFocus,ask.props.ref,'wide: the drawer returns focus to the Ask assistant button');
 // More actions › "Add description…" and "Add tags…".
 const menu=()=>inHeader(node=>node.type==='Menu');
 assert.deepEqual(menu().props.entries.filter(entry=>!entry.separator).map(entry=>entry.id),['description','tags','restart','shutdown'],'the entries without rename and removal callbacks');
 const description=()=>inHeader(node=>node.type==='DeviceDescription'),tags=()=>inHeader(node=>node.type==='DeviceTags');
 assert.deepEqual([description().props.editing,tags().props.formOpen],[false,false],'no editor open');
 menu().props.entries.find(entry=>entry.id==='description').onSelect();view.render();
 assert.deepEqual([description().props.editing,tags().props.formOpen],[true,false],'"Add description…" opens the description editor');
 description().props.onClose();view.render();assert.equal(description().props.editing,false,'Esc, Cancel or Save closes it');
 menu().props.entries.find(entry=>entry.id==='tags').onSelect();view.render();
 assert.deepEqual([description().props.editing,tags().props.formOpen],[false,true],'"Add tags…" opens the add form');
 tags().props.onFormClose();view.render();assert.equal(tags().props.formOpen,false,'and it closes again');
 // Restart… and Shut down… open the shared power drawer for this device.
 menu().props.entries.find(entry=>entry.id==='restart').onSelect();view.render();
 assert.deepEqual(view.find(node=>node.type==='PowerDrawer').props.target,{serverId:'server-a',kind:'restart-computer'},'Restart… opens the power drawer for this device');
}
// Number shortcuts: 1–9 call section(index), 0 does nothing (ui/shell/console-shortcuts.ts).
{
 const listeners=[],effects=[];const savedWindow=globalThis.window,savedElement=globalThis.HTMLElement;
 globalThis.HTMLElement=class {};globalThis.window={addEventListener:(type,listener)=>listeners.push(listener),removeEventListener:()=>{}};
 try{
  const shortcutsFixture={exports:{}};
  new Function('require','module','exports',ts.transpileModule(fs.readFileSync('ui/shell/console-shortcuts.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText)(id=>id==='react'?{useEffect:fn=>effects.push(fn),useRef:current=>({current})}:id==='@/ui/shell/nav-model'?navModel:{},shortcutsFixture,shortcutsFixture.exports);
  const sections=[],noop=()=>{};
  shortcutsFixture.exports.useConsoleShortcuts({palette:noop,help:noop,search:noop,refresh:noop,jobs:noop,go:noop,step:noop,section:index=>sections.push(index)});
  for(const effect of effects)effect();
  const press=key=>{for(const listener of listeners)listener({key,ctrlKey:false,metaKey:false,altKey:false,defaultPrevented:false,target:null,preventDefault(){}});};
  press('1');press('7');press('8');press('9');press('0');
  assert.deepEqual(sections,[0,6,7,8],'9 calls section(8); 0 does nothing');
  assert.deepEqual(shortcutsFixture.exports.shortcutList.find(item=>item.label==='shortcuts.switchArea').keys,['1','–','9'],'the shortcut help shows 1 – 9');
 }finally{globalThis.window=savedWindow;globalThis.HTMLElement=savedElement;}
}
// The paused Remote Desktop subarea itself: one Empty with the title, the notice and "Open terminal".
{
 const {default:React}=await import('react'),{renderToStaticMarkup}=await import('react-dom/server');
 const {RdpPausedState}=await import('../../../ui/devices/remote/rdp-panel.tsx'),{LocaleProvider}=await import('../../../ui/base/locale.tsx');
 let opened=0,built;
 const html=renderToStaticMarkup(React.createElement(LocaleProvider,{locale:'de'},React.createElement(()=>{built=RdpPausedState({onOpenTerminal:()=>opened++});return built;})));
 assert.match(html,/class="sdx-empty"/);assert.ok(html.includes('<strong>Remote Desktop ist pausiert</strong>'),'the Empty title');
 assert.ok(html.includes('Remote Desktop ist vorübergehend pausiert. Nutze stattdessen das Terminal oder den Dateibrowser.'),'the notice sentence');
 assert.match(html,/<button[^>]*>(?:(?!<\/button>).)*Terminal öffnen/,'the Open terminal button');
 for(const absent of ['In Arbeit','sd-rdp-panel','<h2','Migration'])assert.ok(!html.includes(absent),absent+' is absent from the paused subarea');
 built.props.action.props.onClick();assert.equal(opened,1,'the action calls the Open terminal callback');
}
console.log('PASS: redesign DeviceView renders the areas of review §2.3 with the keys 1–9, linked subareas (#device/<id>/…) of Software, Management (Scheduled tasks), Extensions and Configuration, routed History views and DNS zones, subarea Tabs (pill, overflow menu, link tabs, tabpanel, no bar with one subtab), the tinted Ask assistant (wide and compact) with its drawer and the More actions editors and power entry, overview, connection and session changes with GPU positions, and resets on main tabs and devices.');
