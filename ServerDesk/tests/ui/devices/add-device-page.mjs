// The page Add device, tab One device (ui/devices/add-device/add-device.tsx) and its model
// (ui/devices/add-device/add-device-model.ts): the four steps and their states, customer before group
// with several customers, the route preselection, the blocked reasons, the request with its
// step-up retry and ENROLL_CUSTOMER_REQUIRED (moved from the former enroll dialog
// test), the downloaded registration, the waiting state with its 10-second refresh,
// the success state and the tab links. German texts, as a German user sees them.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {de} from '../../support/i18n-stubs.mjs';
import {advance,intervals,loader,mount} from '../../support/add-device-harness.mjs';

let checks=0;
const check=(actual,expected,message)=>{assert.deepEqual(actual,expected,message);checks++;};
const load=loader({'ui/base/api':{api:()=>new Promise(()=>{}),message:failure=>failure.message},'ui/session/mfa-step-up':{MfaStepUp:'MfaStepUp'},'sonner':{toast:{success(){},error(){},info(){}}}});
const page=load('ui/devices/add-device/add-device.tsx'),kit=load('ui/kit/kit.tsx'),field=load('ui/kit/field.tsx'),tabs=load('ui/kit/tabs.tsx');
const model=load('ui/devices/add-device/add-device-model.ts'),guide=load('ui/devices/add-device/agent-guide.ts'),action=load('ui/devices/add-device/enroll-action.ts');

const A='00000000-0000-4000-8000-000000000100',B='11111111-1111-4111-8111-111111111111',X='99999999-9999-4999-8999-999999999999';
const groups=[['gA','Berlin'],['gB1','Hamburg'],['gB2','Kiel'],['gX','Fremd']];
const groupCustomers={gA:A,gB1:B,gB2:B,gX:X};
const customers=[{id:A,name:'Standardkunde'},{id:B,name:'Kunde B'}];
const now=Date.parse('2026-11-13T10:00:00Z');

function open(props={}){
 const log={enroll:[],tabs:[],refreshes:0,opened:[]};
 const ui=mount(page.default,{installer:false,routeCustomerId:'',routeGroupId:'',groups,groupCustomers,customers,multipleCustomers:false,servers:[],now,demo:false,owner:true,saving:false,certificate:null,
  onTab:(installer,choice)=>log.tabs.push([installer,choice]),onEnroll:(input,created)=>log.enroll.push({input,created}),onRefresh:()=>{log.refreshes++;},onOpenDevice:id=>log.opened.push(id),...props},{expand:['OneDevice','RegisterForm','WaitStep','AgentModePick']});
 const fieldNode=label=>ui.find(node=>node.type===field.Field&&node.props.label===label);
 const api={
  ui,log,
  steps:()=>ui.find(node=>node.type===kit.Steps),
  states:()=>api.steps().props.items.map(item=>item.state),
  labels:()=>ui.all(node=>node.type===field.Field||node.type==='span'&&node.props.className==='sdx-field-label').map(node=>node.type==='span'?ui.text(node):node.props.label),
  control:label=>fieldNode(label).props.children,
  choices:label=>{const control=fieldNode(label).props.children;return [control.props.children].flat(Infinity).filter(node=>node&&node.type==='option').map(node=>[node.props.value,ui.text(node)]);},
  choose(label,value){fieldNode(label).props.children.props.onChange({target:{value}});ui.render();},
  name(value){fieldNode(de('agents.enroll.deviceName')).props.children.props.onChange({target:{value}});ui.render();},
  submitButton:()=>ui.find(node=>node.type===kit.Btn&&node.props.type==='submit'),
  send(){ui.find(node=>node.type==='form').props.onSubmit({preventDefault(){}});ui.render();},
  tab:()=>ui.find(node=>node.type===tabs.Tabs),
  wait:()=>ui.find(node=>node.type==='div'&&node.props.className==='sdx-add-device-wait'),
 };
 return api;
}
const L={name:de('agents.enroll.deviceName'),customer:de('agents.enroll.customer'),group:de('tree.deviceGroup'),mode:de('agents.enroll.mode')};

// ---- four steps, their order, titles and states before a registration.
{
 const p=open();
 const steps=p.steps();
 check(steps.props.label,'Schritte zum Hinzufügen eines Geräts','the steps are named');
 check(steps.props.items.map(item=>item.title),['Gerät registrieren','Agent herunterladen','Agent installieren','Auf die erste Meldung warten'],'four steps in order');
 check(p.states(),['current','waiting','waiting','waiting'],'before a registration: step 1 current, the rest waiting');
 check(model.addDeviceStepStates('waiting'),{register:'done',download:undefined,install:undefined,wait:'current'},'after the download');
 check(model.addDeviceStepStates('online'),{register:'done',download:'done',install:'done',wait:'done'},'after the first report');
}

// ---- field order, the hint, the mode pick list, the note and the primary button.
{
 const community=open();
 check(community.labels(),[L.name,L.group,L.mode],'one customer: name, group, mode');
 const name=community.control(L.name);
 check([name.type,name.props.maxLength,name.props.placeholder],['input',64,'SRV-APP01'],'a text field, 64 characters, placeholder');
 check(community.ui.find(node=>node.type===field.Field&&node.props.label===L.name).props.hint,de('agents.enroll.deviceNameHint'),'the existing name hint');
 check(community.choices(L.group).map(([value])=>value),['','gA','gB1','gB2','gX'],'every group with one customer');
 const rows=community.ui.all(node=>node.type===kit.PickRow);
 check(rows.map(row=>[row.props.label,row.props.hint,row.props.selected]),[['Nur lesen',de('addDevice.readOnlyHint'),true],['Verwaltung',de('addDevice.managementHint'),false]],'Read-only and Management with hints, Read-only by default');
 check(community.ui.find(node=>node.type===kit.PickList).props.mode,'radio','a radio pick list');
 assert.ok(community.ui.text().includes('Installiere den Agent innerhalb von 7 Tagen. Danach funktioniert die Registrierungsdatei nicht mehr.'));checks++;
 check([community.submitButton().props.variant,community.ui.text(community.submitButton())],['primary','Registrierung herunterladen'],'the primary "Download registration"');
 const several=open({multipleCustomers:true});
 check(several.labels(),[L.name,L.customer,L.group,L.mode],'several customers: the customer comes before the group');
 check(several.choices(L.customer),[['','Kunde wählen'],[A,'Standardkunde'],[B,'Kunde B']],'first "Choose a customer", then the visible customers');
 check(several.control(L.customer).props['aria-required'],'true','the customer is required');
 check(several.ui.find(node=>node.type===field.Field&&node.props.label===L.customer).props.hint,'Wähle den Kunden, zu dem das neue Gerät gehört. Die Gruppenliste zeigt nur die Gruppen dieses Kunden.','the customer hint');
 check(several.choices(L.group),[['','Ohne Gruppe']],'no customer yet: only "No group"');
 check(open({multipleCustomers:true,demo:true}).labels(),[L.name,L.group,L.mode],'demo mode shows no customer field');
}

// ---- preselection from the route.
{
 const value=(p,label)=>p.control(label).props.value;
 const routeCustomer=open({multipleCustomers:true,routeCustomerId:B});
 check([value(routeCustomer,L.customer),value(routeCustomer,L.group)],[B,''],'a route customer is preselected, no group');
 check(routeCustomer.choices(L.group).map(([id])=>id),['','gB1','gB2'],'the group list shows only its groups');
 check(value(open({multipleCustomers:true,routeCustomerId:X}),L.customer),'','an unknown customer is ignored');
 const routeGroup=open({multipleCustomers:true,routeGroupId:'gB1'});
 check([value(routeGroup,L.customer),value(routeGroup,L.group)],[B,'gB1'],'a route group preselects itself and its customer');
 const both=open({multipleCustomers:true,routeCustomerId:B,routeGroupId:'gA'});
 check([value(both,L.customer),value(both,L.group)],[B,''],'a group of another customer than the route customer is dropped');
 const same=open({multipleCustomers:true,routeCustomerId:B,routeGroupId:'gB2'});
 check([value(same,L.customer),value(same,L.group)],[B,'gB2'],'a group of the route customer stays');
 const foreign=open({multipleCustomers:true,routeGroupId:'gX'});
 check([value(foreign,L.customer),value(foreign,L.group)],['',''],'a group of an invisible customer: both empty');
 check(value(open({routeGroupId:'gX'}),L.group),'gX','with one customer the route group stays');
 // A customer change clears a group of another customer; the same customer keeps it.
 const p=open({multipleCustomers:true,routeCustomerId:B,routeGroupId:'gB2'});
 p.choose(L.customer,B);check(value(p,L.group),'gB2','the same customer keeps its group');
 p.choose(L.customer,A);check([value(p,L.customer),value(p,L.group)],[A,''],'another customer clears the group');
 check(p.choices(L.group).map(([id])=>id),['','gA'],'the list follows the customer');
 // A route group that no longer exists: the gone option and the blocked reason.
 const gone=open({routeGroupId:'gGone'});
 check(gone.choices(L.group)[1],['gGone','Gruppe nicht mehr verfügbar'],'the missing group shows as "Group no longer available"');
 gone.name('SRV-01');
 check(gone.submitButton().props.blocked,'Die ausgewählte Gruppe existiert nicht mehr. Wähle eine andere Gruppe.','and blocks the button');
 // Field changes do not change the hash; the tab links carry the current choice.
 p.choose(L.group,'gA');
 const items=p.tab().props.items;
 check(items.map(item=>[item.id,item.label,item.href]),[['one','Ein Gerät',`#devices/add/customer/${A}/group/gA`],['several','Mehrere Geräte',`#devices/add/installer/customer/${A}/group/gA`]],'the tab links carry the choice');
 check(p.log.tabs,[],'a field change opens nothing');
 check([p.tab().props.variant,p.tab().props.value,p.tab().props.panelId],['underline','one',page.addDevicePanelId],'underline tabs with the panel id');
 const panel=p.ui.find(node=>node.props?.role==='tabpanel');
 check([panel.props.id,panel.props['aria-labelledby']],[page.addDevicePanelId,tabs.tabId(page.addDevicePanelId,'one')],'the content is the tabpanel of the active tab');
 p.tab().props.onChange('several');
 check(p.log.tabs,[[true,{customerId:A,groupId:'gA'}]],'choosing a tab asks the console for the other tab with the choice');
 check(open({installer:true}).tab().props.value,'several','the installer route selects Several devices');
}

// ---- the blocked reasons in order.
{
 const reason=props=>{const key=model.enrollBlockedKey({demo:false,owner:true,name:'SRV',multipleCustomers:true,customerId:A,groupMissing:false,...props});return key&&de(key);};
 check(reason({demo:true,owner:false,name:''}),de('kit.unavailable.demo'),'demo first');
 check(reason({owner:false,name:''}),'Nur ein Owner kann neue Geräte registrieren.','then the Owner');
 check(reason({name:'  ',customerId:''}),'Gib einen Gerätenamen ein, um die Registrierung herunterzuladen.','then the name');
 check(reason({customerId:'',groupMissing:true}),'Wähle im Feld Kunde einen Kunden.','then the customer with several customers');
 check(reason({groupMissing:true}),'Die ausgewählte Gruppe existiert nicht mehr. Wähle eine andere Gruppe.','then a missing group');
 check(reason({}),null,'otherwise free');
 const demo=open({demo:true});demo.name('SRV-01');
 check(demo.submitButton().props.blocked,de('kit.unavailable.demo'),'the page blocks the button in demo mode');
 demo.send();check(demo.log.enroll,[],'a blocked submit sends nothing');
 check(open({saving:true}).submitButton().props.loading,true,'loading while the request runs');
}

// ---- the request (enrollBody), step-up retry and ENROLL_CUSTOMER_REQUIRED keep the input.
{
 const community=open();community.name(' SRV-01 ');community.send();
 check(community.log.enroll.map(entry=>entry.input),[{name:'SRV-01',mode:'ReadOnly',groupId:''}],'the trimmed name, no customerId with one customer');
 check(action.enrollBody(community.log.enroll[0].input),{action:'enroll',name:'SRV-01',mode:'ReadOnly',agentVersion:4,format:'json',groupId:null},'groupId null, no customerId');
 const several=open({multipleCustomers:true,routeCustomerId:B,routeGroupId:'gB1'});
 several.name('SRV-02');
 several.ui.all(node=>node.type===kit.PickRow)[1].props.onSelect();several.ui.render();
 several.send();
 check(several.log.enroll.map(entry=>entry.input),[{name:'SRV-02',mode:'Management',groupId:'gB1',customerId:B}],'several customers: the request sends the customer');
 check(action.enrollBody({...several.log.enroll[0].input,managementToken:'proof'}),{action:'enroll',name:'SRV-02',mode:'Management',agentVersion:4,format:'json',groupId:'gB1',customerId:B,managementToken:'proof'},'the retry adds the token');
 // Without the created callback (step-up open, an error) the form keeps everything.
 check([several.control(L.name).props.value,several.control(L.customer).props.value,several.control(L.group).props.value,several.states()[0]],['SRV-02',B,'gB1','current'],'the input stays until the download');
 // submitEnrollment: the console's request helper.
 class ApiError extends Error{constructor(message,status,code){super(message);this.status=status;this.code=code;}}
 const run=async answer=>{
  const log=[];
  await action.submitEnrollment({name:'SRV-03',mode:'ReadOnly',groupId:''},{
   post:async body=>{log.push(['post',body]);return answer;},
   failure:async response=>new ApiError(response.body.error,response.status,response.body.code),
   created:()=>{log.push(['created']);},
   stepUp:failure=>{if(failure?.code!=='MFA_STEP_UP_REQUIRED')return false;log.push(['stepUp']);return true;},
   error:message=>{log.push(['error',message]);},
   refresh:async()=>{log.push(['refresh']);},
   fallback:'Registrierung fehlgeschlagen.',
  });
  return log;
 };
 const required='Wähle einen Kunden für das neue Gerät.';
 check(await run({ok:false,status:400,body:{error:required,code:'ENROLL_CUSTOMER_REQUIRED'}}),[['post',{action:'enroll',name:'SRV-03',mode:'ReadOnly',agentVersion:4,format:'json',groupId:null}],['error',required],['refresh']],'ENROLL_CUSTOMER_REQUIRED: the error toast, then the reload');
 check((await run({ok:false,status:400,body:{error:'x',code:'VALIDATION_FAILED'}})).map(([step])=>step),['post','error'],'another error does not reload');
 check((await run({ok:false,status:400,body:{error:required,code:undefined}})).map(([step])=>step),['post','error'],'the client branches on the code, not on the text');
 check((await run({ok:false,status:403,body:{error:'MFA',code:'MFA_STEP_UP_REQUIRED'}})).map(([step])=>step),['post','stepUp'],'a step-up answer opens MfaStepUp');
 check((await run({ok:true,status:200})).map(([step])=>step),['post','created'],'only a success downloads');
 check([action.enrollCustomerRequired(new ApiError('x',400,'ENROLL_CUSTOMER_REQUIRED')),action.enrollCustomerRequired(null)],[true,false]);
 // The console: the customer field follows ConsoleData.multipleCustomers, the request goes through submitEnrollment.
 const consoleSource=fs.readFileSync('ui/shell/console.tsx','utf8');
 assert.match(consoleSource,/<AddDevicePage installer=\{addInstaller\} routeCustomerId=\{addCustomerId\} routeGroupId=\{agentGroupId\}[^>]*multipleCustomers=\{data\?\.multipleCustomers===true\}/,'the page gets the route and multipleCustomers');
 assert.match(consoleSource,/await submitEnrollment\(input,\{/,'the console sends through submitEnrollment');checks+=2;
}

// ---- after the download: the file, the device id, the summary, the command, "Add another device".
{
 check(model.registrationFileName('SRV 01/ä'),'ServerDesk-SRV_01__.registration.json','every character outside [a-z0-9-] becomes "_"');
 check([model.registrationDeviceId('{"id":"dev-1","token":"t"}'),model.registrationDeviceId('{}'),model.registrationDeviceId('not json')],['dev-1',null,null],'the device id of the JSON');
 const p=open({routeGroupId:'gA'});
 const command=()=>p.ui.find(node=>node.type===kit.CommandBlock&&node.props.label==='Installationsbefehl');
 check(command().props.command,guide.agentInstallCommand(de('agents.install.registrationFile')),'before the download the command names the placeholder file');
 assert.ok(p.ui.text().includes(de('addDevice.installText'))&&p.ui.text().includes(de('addDevice.afterCommand')));checks++;
 p.name('SRV-01');p.choose(L.group,'gB1');p.send();
 p.log.enroll[0].created({name:'SRV-01',fileName:model.registrationFileName('SRV-01'),deviceId:'dev-1'});p.ui.render();
 check(p.states(),['done',undefined,undefined,'current'],'after the download: step 1 done, step 4 current');
 assert.ok(p.ui.text().includes('Registrierung für SRV-01 heruntergeladen.'),'the summary line');checks++;
 check(p.ui.find(node=>node.type==='form'),undefined,'the form gives way to the summary');
 check(command().props.command,'.\\ServerDesk.Agent.exe --install --config .\\ServerDesk-SRV-01.registration.json','the command uses the downloaded file');
 const another=p.ui.find(node=>node.type===kit.Btn&&p.ui.text(node)==='Weiteres Gerät hinzufügen');
 check(another.props.variant,undefined,'"Add another device" is secondary');
 another.props.onClick();p.ui.render();
 check([p.control(L.name).props.value,p.control(L.group).props.value,p.states()],['','gA',['current','waiting','waiting','waiting']],'a reset: name empty, the group of the route, the first state');
}

// ---- the repair disclosure.
{
 const p=open();
 const disclosure=p.ui.find(node=>node.type===kit.Disclosure);
 check(disclosure.props.title,de('agents.install.update'),'the disclosure title');
 assert.ok(p.ui.text(disclosure).includes(de('agents.install.updateHint')));checks++;
 check(p.ui.all(node=>node.type===kit.CommandBlock).map(node=>node.props.command).at(-1),guide.agentRepairCommand,'with the repair command');
 check(p.ui.find(node=>node.type?.name==='PortalCertificateCard').props.use,'one','step 3 shows the certificate with the One-device text');
}

// ---- step 4 before, waiting, refresh every 10 s, success, offline variant; the timer stops.
{
 const p=open();
 check(p.ui.text(p.wait()),'Nach der Installation meldet sich das Gerät hier und erscheint im Gerätebaum.','before a registration');
 check(p.wait().props['aria-live'],'polite','the region is live');
 check(intervals(),[],'no timer before a registration');
 p.name('SRV-01');p.send();p.log.enroll[0].created({name:'SRV-01',fileName:'f',deviceId:'dev-1'});p.ui.render();
 const pill=()=>p.ui.find(node=>node.type===kit.StatusPill);
 check([pill().props.kind,p.ui.text(pill())],['neutral','Warte auf SRV-01…'],'missing from servers: the neutral pill waits');
 check(p.ui.find(node=>node.type==='span'&&node.props.className==='sdx-live')?.props.children.type,kit.StatusPill,'the pill pulses (sdx-live)');
 assert.ok(p.ui.text(p.wait()).includes(de('addDevice.waitingHint'))&&p.ui.text(p.wait()).includes('Nach ein paar Minuten noch keine Meldung?'));checks++;
 check(p.ui.find(node=>node.type==='a'&&p.ui.text(node)==='Agent-Fehlersuche öffnen').props.href,'#settings/agent-troubleshooting','the troubleshooting link');
 check(intervals(),[10000],'one 10-second timer while waiting');
 advance(10000);check(p.log.refreshes,1,'the console refreshes after 10 s');
 advance(20000);check(p.log.refreshes,3,'and every 10 s');
 // The device is enrolled but has not reported: still waiting.
 p.ui.setProps({servers:[{id:'dev-1',name:'SRV-01',lastSeen:null}]});
 check(p.ui.text(pill()),'Warte auf SRV-01…','connectionKind waiting keeps waiting');
 p.ui.setProps({servers:[{id:'dev-1',name:'SRV-01',lastSeen:now-1000}]});
 check(p.states(),['done','done','done','done'],'after the first report every step is done');
 check(intervals(),[],'the timer stops once the device reported');
 const online=p.ui.find(node=>node.type==='div'&&String(node.props.className).includes('sdx-add-device-online'));
 assert.ok(p.ui.text(online).includes('SRV-01 ist online')&&p.ui.text(online).includes('Öffne das Gerät, um seine Übersicht zu sehen.'));checks++;
 const openDevice=p.ui.find(node=>node.type===kit.Btn&&p.ui.text(node)==='Gerät öffnen');
 check(openDevice.props.variant,'primary','"Open device" is the primary');
 openDevice.props.onClick();check(p.log.opened,['dev-1'],'it opens the device');
 check(p.ui.find(node=>node.type===kit.Btn&&p.ui.text(node)==='Registrierung herunterladen'),undefined,'one primary at a time');
 p.ui.setProps({servers:[{id:'dev-1',name:'SRV-01',lastSeen:now-600000}]});
 assert.ok(p.ui.text(p.wait()).includes('SRV-01 hat sich zum ersten Mal gemeldet'),'offline: reported for the first time');checks++;
 // Unmount stops the timer; reset stops it; demo mode never starts it.
 const leave=open();leave.name('SRV-02');leave.send();leave.log.enroll[0].created({name:'SRV-02',fileName:'f',deviceId:'dev-2'});leave.ui.render();
 check(intervals(),[10000],'waiting again');leave.ui.dispose();check(intervals(),[],'leaving the page stops the timer');
 const reset=open();reset.name('SRV-03');reset.send();reset.log.enroll[0].created({name:'SRV-03',fileName:'f',deviceId:'dev-3'});reset.ui.render();
 reset.ui.find(node=>node.type===kit.Btn&&reset.ui.text(node)==='Weiteres Gerät hinzufügen').props.onClick();reset.ui.render();
 check(intervals(),[],'"Add another device" stops the timer');reset.ui.dispose();
 check(model.waitingRefreshActive({phase:'waiting',shown:true,demo:true}),false,'never in demo mode');
 check(model.waitingRefreshActive({phase:'waiting',shown:true,demo:false}),true);
}

// ---- the waiting state lives in the page only.
{
 const p=open();p.name('SRV-01');p.send();p.log.enroll[0].created({name:'SRV-01',fileName:'f',deviceId:'dev-1'});p.ui.render();p.ui.dispose();
 check(open().states(),['current','waiting','waiting','waiting'],'a new visit starts at the first state');
}

// ---- A new route (another customer or group link) starts the choice again; a tab change keeps it.
{
 const p=open({multipleCustomers:true,routeCustomerId:A});
 p.choose(L.customer,B);
 p.ui.setProps({installer:true,routeCustomerId:B});
 check(p.ui.find(node=>node.type?.name==='AddDeviceInstallers').props.chosenCustomer,B,'the tab change keeps the chosen customer');
 p.ui.setProps({installer:false,routeCustomerId:'',routeGroupId:'gA'});
 check([p.control(L.customer).props.value,p.control(L.group).props.value],[A,'gA'],'a new group link preselects again');
}

// ---- the old parts are gone; the page files are kit only.
{
 assert.ok(!fs.existsSync('app/redesign/areas.tsx'),'areas.tsx is deleted');checks++;
 const sources=['app','ui','tests'].flatMap(function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{const file=dir+'/'+entry.name;return entry.isDirectory()?walk(file):/\.(tsx?|mjs)$/.test(entry.name)?[file]:[];});});
 const importers=sources.filter(file=>file!=='tests/ui/devices/add-device-page.mjs'&&/^\s*import\s[^;\n]*\b(AgentsArea|EnrollDialog|EnrollForm)\b/m.test(fs.readFileSync(file,'utf8')));
 check(importers,[],'no file imports AgentsArea, EnrollDialog or EnrollForm');
 for(const file of ['ui/devices/add-device/add-device.tsx','ui/devices/add-device/add-device-installers.tsx','ui/devices/add-device/portal-certificate-card.tsx','ui/devices/add-device/agent-mode-pick.tsx','ui/devices/add-device/add-device-model.ts'])assert.doesNotMatch(fs.readFileSync(file,'utf8'),/@\/components\/ui\//,`${file} imports no components/ui`);
 checks++;
 assert.doesNotMatch(fs.readFileSync('ui/devices/add-device/add-device-model.ts','utf8'),/from 'react'/,'the model has no React');checks++;
 check(fs.existsSync('app/agent-installation.tsx'),false,'app/agent-installation.tsx (AgentInstallation and AgentTroubleshooting) is deleted');
}

console.log(`PASS add device page (${checks} checks): four steps and their states, customer before group, route preselection, blocked reasons, the request with step-up and ENROLL_CUSTOMER_REQUIRED, the downloaded file and its command, the waiting state with its 10-second refresh, the success state and the tab links.`);
