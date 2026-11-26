// The customer drawers (ui/settings/customer-drawers.tsx) with their form state and write flow: "Manage customer…" (create and
// edit) with its fields, switches, weekday toggles, validation and exact request bodies; "Technician access…" with one
// PickList, its search, hints and blocked rows; one useStepUp for every write (MFA first only for the technicians and an
// edit that shortens the own audit retention, create and a harmless edit at once, cancel keeps the input, a resend once
// after an MFA prompt, the success and error toasts); and CustomerDrawerHost, which the console renders for
// the customer folder menu in Devices; and "Delete customer…": the DangerZone at the end of the manage drawer of an
// existing customer, the kit NameConfirmDrawer with its consequences, the last-customer notice and the typed name, the
// request body, MFA first, cancel, success with onDeleted and the reload before the error toast. Runs on the hook cells of tests/support/panel-harness.mjs with the real kit, the
// real useStepUp and a recorded API. No server or browser is touched.
import assert from 'node:assert/strict';
import {panelHarness} from '../../support/panel-harness.mjs';
import {de} from '../../support/i18n-stubs.mjs';
import {renderToStaticMarkup} from 'react-dom/server';

let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
class ApiError extends Error{constructor(message,status,code){super(message);this.status=status;this.code=code;}}
let calls=[],get=()=>{throw new Error('no GET');},post=()=>{throw new Error('no POST');};
const shared={ApiError,message:failure=>failure.message,api:async(url,body)=>{calls.push({url,body});return body?post(body):get();}};
function MfaStepUp(){return null;}
const harness=panelHarness({hooked:['ui/settings/customer-drawers.tsx','ui/session/step-up-retry.ts'],stubs:{'@/ui/base/api':shared,'@/ui/session/mfa-step-up':{MfaStepUp}}});
const drawers=harness.load('ui/settings/customer-drawers.tsx'),kit=harness.load('ui/kit/kit.tsx'),field=harness.load('ui/kit/field.tsx'),{NameConfirmDrawer}=harness.load('ui/kit/name-confirm-drawer.tsx');

const firstCustomer='00000000-0000-4000-8000-000000000100';
const window={days:[1,2,3,4,5],start:'22:00',durationMinutes:240,timeZone:'Europe/Berlin'};
const customer=(extra={})=>({id:'7f1c2a54-58a8-4f0e-9d33-6f5b1f0a2c11',name:'Kunde B',status:'active',contactName:'',contactEmail:'',contactPhone:'',createdAt:1,updatedAt:1,auditRetentionDays:null,maintenanceWindow:null,revision:3,deviceCount:0,groupCount:0,...extra});
const standard=customer({id:firstCustomer,name:'Standardkunde',revision:0});
const people={users:[
 {id:'11111111-1111-4111-8111-111111111111',label:'Olivia Owner',email:'owner@example.test',status:'active',owner:true},
 {id:'22222222-2222-4222-8222-222222222222',label:'Anna Technik',email:'anna@example.test',status:'active',owner:false},
 {id:'33333333-3333-4333-8333-333333333333',label:'Ben Alt',email:'ben@example.test',status:'disabled',owner:false},
],groups:[
 {id:'44444444-4444-4444-8444-444444444444',name:'Team Nord',enabled:true},
 {id:'55555555-5555-4555-8555-555555555555',name:'Team Alt',enabled:false},
]};
const [olivia,anna,ben]=people.users,[nord,alt]=people.groups;
const saved=[{customerId:customer().id,subjectType:'user',subjectId:anna.id},{customerId:customer().id,subjectType:'group',subjectId:nord.id}];
const view=(list=[standard,customer()],assignments=saved,technicians=people)=>({customers:list,technicians,assignments});

// ---- A probe component: the hook and its drawers, as the page and the console use them ----
let tree=null,hook=null,probeProps={};
function Probe(props){hook=drawers.useCustomers(props);return hook.drawers;}
const render=()=>{tree=harness.tree(Probe,probeProps);return tree;};
const settle=async()=>{for(let round=0;round<4;round++){await harness.flush();render();}};
async function start({getter=async()=>view(),poster=async()=>view(),props={}}={}){
 harness.reset();calls=[];get=getter;post=poster;probeProps=props;render();await settle();
 await hook.load();await settle();
}
const find=predicate=>harness.find(tree,predicate);
const all=predicate=>harness.walk(tree).filter(predicate);
const openDrawer=()=>find(node=>node.type===kit.Drawer&&node.props.open);
const fieldOf=label=>find(node=>node.type===field.Field&&node.props.label===label);
const input=label=>fieldOf(label).props.children;
const type=(label,value)=>{input(label).props.onChange({target:{value}});render();};
const switchOf=label=>find(node=>node.type===field.Switch&&node.props.label===label);
const submitButton=()=>harness.walk(openDrawer().props.footer).find(node=>node.props?.type==='submit');
const form=()=>find(node=>node.type==='form'&&node.props.id===submitButton().props.form);
const submit=async()=>{form().props.onSubmit({preventDefault(){}});render();await settle();};
const stepUp=()=>find(node=>node.type===MfaStepUp);
const verify=async token=>{stepUp().props.onVerified({managementToken:token});await settle();};
const posts=()=>calls.filter(call=>call.body).map(call=>call.body);
const toasts=()=>harness.toasts.splice(0);
// WeekdayGroup is a component of the drawer module: its element is expanded here.
const weekdays=()=>{const element=find(node=>typeof node.type==='function'&&node.type.name==='WeekdayGroup');return element&&element.type(element.props);};

// 1. Create customer.
{
 await start();
 check(calls,[{url:'/api/customers',body:undefined}],'load() runs one GET');
 ok(hook.openManage(null),'Create customer opens');render();
 const drawer=openDrawer().props;
 check([drawer.title,drawer.icon.displayName,drawer.dirty],[de('customers.create'),'Building2',false],'the kit Drawer with the Building2 tile, clean');
 check(find(node=>node.type===kit.Notice),undefined,'another customer exists: no first-customer notice');
 const footer=harness.walk(drawer.footer);
 ok(footer.some(node=>node.type===kit.DrawerCancel),'the footer has DrawerCancel');
 check([submitButton().type,submitButton().props.variant,submitButton().props.blocked,harness.text(submitButton())],[kit.Btn,'primary',undefined,de('customers.create')],'the primary submit "Create customer"');
 check([input('Name').props.autoFocus,input('Name').props.required,input('Name').props.maxLength],[true,true,80],'Name: required, autofocus, 80');
 check([input(de('customers.contactName')).props.maxLength,input(de('customers.email')).props.type,input(de('customers.email')).props.maxLength,input(de('customers.phone')).props.type,input(de('customers.phone')).props.maxLength],[120,'email',254,'tel',40]);
 const own=switchOf(de('customers.ownRetention')),windowSwitch=switchOf(de('customers.setWindow'));
 check([own.props.checked,own.props.hint,windowSwitch.props.checked,fieldOf(de('customers.daysLabel')),weekdays()],[false,de('customers.retentionDefault'),false,undefined,undefined],'both switches off: the default retention hint, no window fields');
 check(all(node=>node.type==='legend').map(node=>harness.text(node)),[de('customers.retention'),de('customers.window')],'two sections');
 // Validation runs after the first submit and then live.
 await submit();
 check([posts(),fieldOf('Name').props.error,stepUp().props.open],[[],de('customers.error.name'),false],'an empty name sends nothing and shows its error under the field');
 type('Name','Neu GmbH');
 check([fieldOf('Name').props.error,openDrawer().props.dirty],[undefined,true],'the error follows the input; the drawer is dirty');
 own.props.onChange(true);render();
 check([switchOf(de('customers.ownRetention')).props.hint,fieldOf(de('customers.daysLabel')).props.hint,input(de('customers.daysLabel')).props.value,posts()],[undefined,de('customers.retentionHint'),'30',[]],'the own retention: a Days field with its hint; a switch sends nothing');
 type(de('customers.daysLabel'),'0');
 check(fieldOf(de('customers.daysLabel')).props.error,de('customers.error.retention'),'days outside 1–3650 show their error at once after the first submit');
 type(de('customers.daysLabel'),'90');
 switchOf(de('customers.setWindow')).props.onChange(true);render();
 const days=weekdays();
 const group=harness.walk(days).find(node=>node.props?.role==='group');
 const buttons=harness.walk(group).filter(node=>node.type===kit.Btn);
 check([harness.text(harness.walk(days).find(node=>node.props?.id===group.props['aria-labelledby'])),buttons.map(node=>[harness.text(node),node.props.pressed,node.props.size])],[de('customers.daysLabel'),[['Mo',true,'sm'],['Di',true,'sm'],['Mi',true,'sm'],['Do',true,'sm'],['Fr',true,'sm'],['Sa',false,'sm'],['So',false,'sm']]],'seven pressed or plain kit Btns in a group named Days');
 for(const button of buttons.slice(0,5))button.props.onClick();render();
 check(harness.walk(weekdays()).find(node=>node.className==='sdx-field-error'||node.props?.className==='sdx-field-error')&&harness.text(harness.walk(weekdays()).find(node=>node.props?.className==='sdx-field-error')),de('customers.error.days'),'a window without a day shows its error');
 await submit();check(posts(),[],'an invalid form sends nothing');
 harness.walk(weekdays()).filter(node=>node.type===kit.Btn)[5].props.onClick();render();
 check([input(de('customers.start')).props.type,input(de('customers.start')).props.step,input(de('customers.start')).props.value],['time',900,'22:00']);
 const duration=input(de('customers.duration')),zone=input(de('customers.timeZone'));
 check([duration.type,harness.walk(duration).filter(node=>node.type==='option').map(node=>harness.text(node)),zone.type,zone.props.wide],[field.Select,['30 Min.','1 Std.','2 Std.','3 Std.','4 Std.','6 Std.','8 Std.','12 Std.'],field.Select,true],'Duration and the wide Time zone are kit Selects');
 type(de('customers.start'),'23:30');duration.props.onChange({target:{value:'120'}});render();input(de('customers.timeZone')).props.onChange({target:{value:'Europe/Berlin'}});render();
 // Creating a customer needs no MFA (lib/step-up.ts): the request goes out at once, without the dialog.
 let release;post=()=>new Promise(resolve=>{release=()=>resolve(view([standard,customer(),customer({id:'2b0f5f4e-1f6e-4c47-8d1e-0d6c0f6f9a55',name:'Neu GmbH'})]));});
 await submit();
 check(stepUp().props.open,false,'create opens no MFA dialog');
 check(posts(),[{action:'create',name:'Neu GmbH',contactName:'',contactEmail:'',contactPhone:'',auditRetentionDays:90,maintenanceWindow:{days:[6],start:'23:30',durationMinutes:120,timeZone:'Europe/Berlin'}}],'the body equals the payload of the form, without a managementToken');
 check([submitButton().props.loading,openDrawer().props.dirty],[true,false],'while it runs: the submit is loading and the drawer has no discard question');
 openDrawer().props.onClose();render();
 ok(openDrawer(),'a user close waits while the request runs');
 release();await settle();
 check([toasts(),openDrawer(),hook.data.customers.map(item=>item.name)],[[de('customers.toast.created')],undefined,['Standardkunde','Kunde B','Neu GmbH']],'success: the toast, the drawer closes, the list of the answer');
}

// 2. Manage an existing customer; a failure keeps the drawer; an MFA prompt resends once.
{
 const edited=customer({contactName:'Erika',auditRetentionDays:14,maintenanceWindow:window});
 let attempt=0;
 await start({getter:async()=>view([standard,edited]),poster:async body=>{attempt++;if(attempt===1)throw new ApiError('Die Bestätigung ist abgelaufen.',403,'MFA_STEP_UP_REQUIRED');if(attempt===2)throw new ApiError('Der Name ist schon vergeben.',409,'CUSTOMER_NAME_TAKEN');return view(undefined,[standard,{...edited,name:body.name,revision:4}]);}});
 hook.openManage(edited);render();
 check([openDrawer().props.title,harness.text(submitButton()),submitButton().props.blocked,submitButton().props.variant],[de('customers.drawer.manageTitle',{name:'Kunde B'}),'Kunde speichern',de('common.noChanges'),'primary'],'edit: "Manage Kunde B", Save customer blocked while nothing changed');
 check([switchOf(de('customers.ownRetention')).props.checked,input(de('customers.daysLabel')).props.value,switchOf(de('customers.setWindow')).props.checked],[true,'14',true],'the form starts from the customer');
 await submit();check([stepUp().props.open,posts()],[false,[]],'an unchanged form submits nothing');
 type('Name','Kunde B Neu');
 check(submitButton().props.blocked,undefined,'a change unblocks Save customer');
 // A name change keeps the retention: it goes out at once; the server's MFA prompt opens the dialog.
 await submit();
 check([posts().at(-1),stepUp().props.open],[{action:'update',id:edited.id,revision:3,name:'Kunde B Neu',contactName:'Erika',contactEmail:'',contactPhone:'',auditRetentionDays:14,maintenanceWindow:{days:[1,2,3,4,5],start:'22:00',durationMinutes:240,timeZone:'Europe/Berlin'}},true],'update with revision at once; an MFA prompt opens the dialog');
 await verify('second');
 check([posts().length,posts().at(-1).managementToken,toasts(),!!openDrawer(),input('Name').props.value],[2,'second',['error:Der Name ist schon vergeben.'],true,'Kunde B Neu'],'resent once with the new proof; the failure is a toast and the drawer keeps its input');
 await submit();
 check([posts().length,posts().at(-1).managementToken,toasts(),openDrawer()],[3,undefined,[de('customers.toast.saved')],undefined],'saved without a dialog: the toast and the drawer closes');
}

// 2a. An edit that shortens the own audit retention asks for MFA first; cancel sends nothing and keeps the input.
{
 const edited=customer({contactName:'Erika',auditRetentionDays:14,maintenanceWindow:window});
 await start({getter:async()=>view([standard,edited]),poster:async body=>view(undefined,[standard,{...edited,auditRetentionDays:body.auditRetentionDays,revision:4}])});
 hook.openManage(edited);render();
 type(de('customers.daysLabel'),'7');
 await submit();
 check([stepUp().props.open,posts(),!!openDrawer()],[true,[],true],'a shorter retention opens the MFA dialog before any request');
 stepUp().props.onClose();await settle();
 check([stepUp().props.open,posts(),input(de('customers.daysLabel')).props.value,!!openDrawer()],[false,[],'7',true],'cancel sends nothing and keeps the input');
 await submit();await verify('shorter');
 check([posts().length,posts().at(-1).auditRetentionDays,posts().at(-1).managementToken,toasts()],[1,7,'shorter',[de('customers.toast.saved')]],'sent once with the proof');
 // A longer own retention goes out at once.
 hook.openManage(edited);render();type(de('customers.daysLabel'),'30');
 await submit();
 check([stepUp().props.open,posts().length,posts().at(-1).auditRetentionDays,posts().at(-1).managementToken],[false,2,30,undefined],'a longer retention sends at once');
}

// 2b. The first-customer notice: only in the create drawer, only while the default customer is the only one.
{
 await start({getter:async()=>view([standard],[])});
 ok(hook.openManage(null),'Create customer opens');render();
 const first=harness.walk(form())[1];
 check([first.type,first.props.tone,first.props.icon?.displayName,harness.text(first)],[kit.Notice,'warning','TriangleAlert',de('customers.firstCustomerNotice')],'the warning comes first, above the fields');
 check(harness.walk(form()).filter(node=>node.type===kit.Notice).length,1,'one notice');
 openDrawer().props.onClose();render();
 ok(hook.openManage(standard),'Manage customer opens for the default customer');render();
 check(find(node=>node.type===kit.Notice),undefined,'the edit drawer has no notice');
}

// 3. Technician access.
{
 await start();
 ok(hook.openAccess(customer()),'Technician access opens');render();
 const drawer=openDrawer().props;
 check([drawer.title,drawer.description,drawer.icon.displayName,harness.text(submitButton()),submitButton().props.blocked],[de('customers.drawer.accessTitle',{name:'Kunde B'}),de('customers.accessHint'),'Users','Zugriff speichern',de('common.noChanges')],'title, description, the Users tile and the blocked Save access');
 check(find(node=>node.type===kit.Notice),undefined,'no notice');
 const list=()=>find(node=>node.type===kit.PickList);
 const rows=()=>harness.walk(list()).filter(node=>node.type===kit.PickCheckRow);
 check([list().props.mode,list().props.label,list().props.search.label,list().props.search.placeholder],['checkbox',de('customers.technicians.label'),de('customers.filterLabel'),de('customers.filterPlaceholder')],'one PickList with its search');
 check(rows().map(row=>[row.props.label,row.props.hint,row.props.checked,row.props.blocked]),[
  [olivia.label,'owner@example.test · Owner',false,undefined],[anna.label,'anna@example.test',true,undefined],[ben.label,'ben@example.test · Deaktiviert',false,undefined],
  [nord.name,'Benutzergruppe',true,undefined],[alt.name,'Benutzergruppe · Deaktiviert',false,undefined]],'users, then groups, with their hints and the saved selection');
 ok(rows().slice(0,3).every(row=>row.props.icon.type.displayName==='User')&&rows().slice(3).every(row=>row.props.icon.type.displayName==='Users'),'User and Users icons');
 const search=value=>{list().props.search.onChange(value);render();};
 search('ANNA@EXAMPLE');check(rows().map(row=>row.props.label),[anna.label],'the search matches the email without case');
 search('nord');check(rows().map(row=>row.props.label),[nord.name],'and the group names');
 search('zzz');check([rows().length,harness.text(list().props.empty)],[0,de('customers.noMatch')],'no match: customers.noMatch');
 search('');
 rows().find(row=>row.props.label===nord.name).props.onChange(false);render();
 rows().find(row=>row.props.label===ben.label).props.onChange(true);render();
 check([submitButton().props.blocked,openDrawer().props.dirty],[undefined,true],'a change unblocks Save access');
 await submit();await verify('tech-proof');
 check(posts(),[{action:'set-technicians',id:customer().id,revision:3,userIds:[anna.id,ben.id],groupIds:[],managementToken:'tech-proof'}],'ids in list order');
 check([toasts(),openDrawer()],[[de('customers.toast.accessSaved')],undefined]);
 // Without any user or group: customers.noGroups.
 await start({getter:async()=>view(undefined,[],{users:[],groups:[]})});
 hook.openAccess(customer());render();
 check(harness.text(find(node=>node.type===kit.PickList).props.empty),de('customers.noGroups'));
 // No edition lock: the drawer opens also without an assignment, and no row is blocked.
 await start();
 ok(hook.openAccess(standard),'without an assignment the drawer opens');render();
 check(find(node=>node.type===kit.Notice),undefined,'no notice in the access drawer');
 hook.openAccess(customer());render();
 check(rows().map(row=>[row.props.label,row.props.blocked]),[[olivia.label,undefined],[anna.label,undefined],[ben.label,undefined],[nord.name,undefined],[alt.name,undefined]],'no row is blocked');;
 rows().find(row=>row.props.label===anna.label).props.onChange(false);render();
 await submit();await verify('revoke');
 check(posts().at(-1),{action:'set-technicians',id:customer().id,revision:3,userIds:[],groupIds:[nord.id],managementToken:'revoke'},'removing is sent');
}

// 4. CustomerDrawerHost over Devices: the loading drawer at once, the form in the same drawer, the refusals and a close while loading.
{
 const Host=drawers.CustomerDrawerHost;
 let done=0,saved=0;
 const hostRender=props=>{tree=harness.tree(Host,{closeKey:'#devices',onSaved:()=>saved++,onDone:()=>done++,...props});return tree;};
 const hostSettle=async props=>{for(let round=0;round<4;round++){await harness.flush();hostRender(props);}};
 harness.reset();calls=[];toasts();
 get=async()=>view();post=async()=>view();
 hostRender({request:null});await hostSettle({request:null});
 check([calls,openDrawer()],[[],undefined],'no request: no GET and no drawer');
 // The loading drawer opens in the render that gets the request; the list then fills the same Drawer with the form.
 let answer;get=()=>new Promise(resolve=>{answer=()=>resolve(view());});
 const request={customerId:customer().id,customerName:'Kunde B',drawer:'manage'};
 const slot=()=>tree.props.children[0];
 hostRender({request});
 const loading=openDrawer();
 check([loading?.props.title,loading?.props.icon.displayName,loading?.props.closeKey,loading===slot()],[de('customers.drawer.manageTitle',{name:'Kunde B'}),'Building2','#devices',true],'a manage request opens its drawer at once, with the name from the console and the manage icon tile');
 const skeleton=harness.walk(loading.props.children).find(node=>node.type===kit.Skeleton);
 check([skeleton?.props.variant,skeleton?.props.label,skeleton?.props.after],['facts',de('customers.drawer.loading'),15000],'its body is the facts Skeleton "Loading customer…" with the slow hint');
 const loadingFoot=harness.walk(loading.props.footer);
 check([loadingFoot.some(node=>node.type===kit.DrawerCancel),loadingFoot.find(node=>node.props?.type==='submit')?.props.blocked,loadingFoot.find(node=>node.props?.type==='submit')?.props.variant],[true,de('customers.blocked.loading'),'primary'],'its footer: Cancel and the primary submit blocked while the customer loads');
 await hostSettle({request});
 check([calls,done],[[{url:'/api/customers',body:undefined}],0],'one GET; the request stays until the list arrives');
 answer();await hostSettle({request});
 check([calls,done,openDrawer()?.props.title,openDrawer()?.props.closeKey,openDrawer()===slot()],[[{url:'/api/customers',body:undefined}],1,de('customers.drawer.manageTitle',{name:'Kunde B'}),'#devices',true],'the host clears the request; the same drawer slot shows the manage form with the route as closeKey');
 check([input('Name').props.autoFocus,!harness.walk(openDrawer().props.children).some(node=>node.type===kit.Skeleton)],[true,true],'the form replaces the Skeleton, focus on its first field');
 get=async()=>view();
 hostRender({request:null});
 input('Name').props.onChange({target:{value:'Kunde B2'}});hostRender({request:null});
 form().props.onSubmit({preventDefault(){}});hostRender({request:null});
 await hostSettle({request:null});
 check([saved,toasts()],[1,[de('customers.toast.saved')]],'a save runs onSaved (the console refresh(true))');
 // An access request: its own title, icon tile and description while loading, then the access form in the same slot.
 const accessRequest={customerId:customer().id,customerName:'Kunde B',drawer:'access'};
 hostRender({request:null});
 hostRender({request:accessRequest});
 check([openDrawer()?.props.title,openDrawer()?.props.icon.displayName,openDrawer()?.props.description,openDrawer()===tree.props.children[1],harness.walk(openDrawer().props.children).some(node=>node.type===kit.Skeleton)],
  [de('customers.drawer.accessTitle',{name:'Kunde B'}),'Users',de('customers.accessHint'),true,true],'an access request opens the technician access drawer at once with the Skeleton');
 await hostSettle({request:accessRequest});
 check([openDrawer()?.props.title,openDrawer()===tree.props.children[1],!!find(node=>node.type===kit.PickList)],[de('customers.drawer.accessTitle',{name:'Kunde B'}),true,true],'the same slot then shows the access form');
 openDrawer().props.onClose();hostRender({request:null});
 // A customer that is gone closes the loading drawer with an info toast.
 const gone={customerId:'2b0f5f4e-1f6e-4c47-8d1e-0d6c0f6f9a55',customerName:'Weg',drawer:'access'};
 hostRender({request:gone});ok(openDrawer(),'the loading drawer opens for a customer that turns out to be gone');
 await hostSettle({request:gone});
 check([toasts(),openDrawer()],[['info:'+de('customers.focus.notFound')],undefined],'a customer that is gone: the drawer closes with the info toast');
 // Without an assignment the technician access drawer opens: there is no edition lock.
 get=async()=>view([standard,customer()],[]);
 const access={customerId:customer().id,customerName:'Kunde B',drawer:'access'};
 hostRender({request:access});await hostSettle({request:access});
 check([toasts(),openDrawer()?.props.title],[[],de('customers.drawer.accessTitle',{name:'Kunde B'})],'technician access opens without an assignment');
 openDrawer().props.onClose();hostRender({request:null});
 get=async()=>{throw new ApiError('Speicher nicht erreichbar.',503);};
 const failing={customerId:customer().id,customerName:'Kunde B',drawer:'manage'};
 hostRender({request:failing});ok(openDrawer(),'the loading drawer opens before the load fails');
 await hostSettle({request:failing});
 check([toasts(),openDrawer()],[['error:Speicher nicht erreichbar.'],undefined],'a failed load closes it with the error toast');
 // A close by the user before the list arrives: nothing opens later, nothing is sent, no toast.
 let late;get=()=>new Promise(resolve=>{late=()=>resolve(view());});calls=[];
 const closing={customerId:customer().id,customerName:'Kunde B',drawer:'manage'};
 hostRender({request:closing});openDrawer().props.onClose();hostRender({request:closing});
 check(openDrawer(),undefined,'the user closes the loading drawer');
 await hostSettle({request:closing});
 // A second request while the first loads has no effect.
 const second={customerId:customer().id,customerName:'Kunde B',drawer:'access'};
 const doneBefore=done;hostRender({request:second});
 check(openDrawer(),undefined,'a second request while one loads opens nothing');
 await hostSettle({request:second});
 check([calls.length,done-doneBefore],[1,1],'and sends no second GET; the console clears it');
 late();await hostSettle({request:null});
 check([openDrawer(),posts(),toasts()],[undefined,[],[]],'the late list opens no drawer and sends nothing');
}

// 4a. Delete customer: the DangerZone of the manage drawer, the delete drawer, the request and its outcomes.
{
 const deleteDrawer=()=>find(node=>node.type===NameConfirmDrawer);
 // CustomerDeleteZone reads the drawer's close context, so its markup comes from SSR and its handler is called directly.
 const zone=()=>{const element=find(node=>typeof node.type==='function'&&node.type.name==='CustomerDeleteZone');return element&&{element,markup:renderToStaticMarkup(element)};};
 const deleted=[];
 const other=customer({id:'0e7f2e57-3a52-4d55-a8a5-0f0a8c1f8b31',name:'Kunde C',revision:5});
 const settingOf=list=>({enabled:true,otherCustomers:list.filter(item=>item.id!==firstCustomer).length,revision:1});
 const listed=list=>({...view(list),multipleCustomers:settingOf(list)});
 const answer=listed([standard]);
 await start({getter:async()=>listed([standard,customer()]),poster:async()=>answer,props:{onDeleted:(gone,index)=>deleted.push([gone.id,index])}});
 // The create drawer has no zone; the manage drawer of an existing customer ends with it.
 hook.openManage(null);render();
 check(zone(),undefined,'the create drawer has no DangerZone');
 openDrawer().props.onClose();render();
 hook.openManage(customer());render();
 const formChildren=[form().props.children].flat(Infinity).filter(Boolean);
 check(formChildren.at(-1)?.type?.name,'CustomerDeleteZone','the DangerZone is the last section of the form');
 const {markup,element}=zone();
 ok(markup.includes('sdx-danger-zone')&&[de('customers.delete.zoneTitle'),de('customers.delete.zoneDescription'),de('customers.menu.delete')].every(part=>markup.includes(part.replace('„','&quot;').replace('“','&quot;'))||markup.includes(part)),'the kit DangerZone with its title, description and label');
 check(element.props.blocked,undefined,'no reason for an empty customer');
 // The zone closes the manage drawer through its guarded close (kit-drawer-close test), then onDelete opens the delete drawer.
 element.props.onDelete();render();
 const drawer=deleteDrawer().props;
 check([drawer.open,drawer.name,drawer.title,drawer.description,drawer.icon.displayName,drawer.iconTone,drawer.fieldLabel,drawer.confirmLabel,drawer.enterNameFirst,drawer.closeKey],
  [true,'Kunde B',de('customers.delete.title',{name:'Kunde B'}),de('customers.delete.description',{name:'Kunde B'}),'Trash2','danger',de('customers.delete.typeName'),de('customers.delete.confirm'),de('customers.delete.enterNameFirst'),undefined],'the delete drawer names the customer, with the danger Trash2 tile');
 const body=[drawer.children].flat(Infinity).filter(Boolean);
 check(body.slice(0,2).map(node=>harness.text(node)),[de('customers.delete.removedWith'),de('customers.delete.auditKept')],'the consequences: what goes and what stays');
 const notice=body.find(node=>node.type===kit.Notice);
 check([notice?.props.tone,harness.text(notice)],['warning',de('customers.delete.lastNotice',{defaultName:'Standardkunde'})],'the last other customer: the warning with the default customer name');
 // Cancel in the MFA dialog sends nothing and keeps the drawer.
 drawer.onConfirm();await settle();
 check([stepUp().props.open,posts()],[true,[]],'MFA first: the delete is in customerStepUpActions');
 stepUp().props.onClose();await settle();
 check([stepUp().props.open,posts(),deleteDrawer().props.open],[false,[],true],'cancel sends nothing and keeps the drawer');
 // A refusal for new data loads the list again first; the drawer stays and holds the fresh customer.
 const fresh=customer({revision:4,deviceCount:2});
 let gets=0;get=async()=>{gets++;return listed([standard,fresh]);};
 post=async()=>{throw new ApiError('Der Kunde hat noch Geräte.',409,'CUSTOMER_IN_USE');};
 deleteDrawer().props.onConfirm();await settle();await verify('in-use');await settle();
 check([posts().at(-1),gets,toasts(),deleteDrawer().props.open,deleteDrawer().props.name],[{action:'delete',id:customer().id,revision:3,managementToken:'in-use'},1,['error:Der Kunde hat noch Geräte.'],true,'Kunde B'],'the request body; CUSTOMER_IN_USE reloads the list before the toast and keeps the drawer');
 check(harness.load('ui/settings/customers-model.ts').customerBodyNeedsStepUp({action:'delete',id:customer().id,revision:3},[customer()]),true,'customerBodyNeedsStepUp is true for the delete');
 // Success: the toast, the drawer closes, the answer's list, onDeleted with the old index.
 post=async()=>answer;
 deleteDrawer().props.onConfirm();await settle();await verify('ok');await settle();
 check([posts().at(-1),toasts(),deleteDrawer().props.open,hook.data.customers.map(item=>item.id),deleted],[{action:'delete',id:customer().id,revision:4,managementToken:'ok'},[de('customers.delete.done')],false,[firstCustomer],[[customer().id,1]]],'deleted: the toast, the drawer closes, the list of the answer and onDeleted');
 // With another customer left there is no notice; the default customer and a busy request block the zone.
 await start({getter:async()=>listed([standard,customer(),other]),poster:async()=>answer});
 ok(hook.openDelete(customer()),'openDelete opens');render();
 check([deleteDrawer().props.children].flat(Infinity).filter(Boolean).some(node=>node.type===kit.Notice),false,'two other customers: no last-customer notice');
 deleteDrawer().props.onClose();render();
 hook.openManage(standard);render();
 check(zone().element.props.blocked,de('customers.delete.defaultBlocked'),'the default customer: the zone is blocked with its reason');
}

// 5. The drawer module stays on the kit.
{
 const source=(await import('node:fs')).readFileSync('ui/settings/customer-drawers.tsx','utf8');
 ok(!/@\/components\/ui\/|ErrorNote|skeleton-bar|<select\b|role="switch"|opensMfaPrompt|MFA_STEP_UP_REQUIRED/.test(source),'kit parts and useStepUp only');
 ok(/needsStepUp:body=>customerBodyNeedsStepUp\(/.test(source)&&/from '@\/lib\/step-up'/.test((await import('node:fs')).readFileSync('ui/settings/customers-model.ts','utf8')),'the customer writes ask by the shared rule of lib/step-up.ts');
 const needs=harness.load('ui/settings/customers-model.ts').customerBodyNeedsStepUp,list=[{id:'c1',auditRetentionDays:30},{id:'c2',auditRetentionDays:null}];
 check([
  needs({action:'create',auditRetentionDays:1},list),needs({action:'set-status',id:'c1',status:'disabled'},list),needs({action:'set-technicians',id:'c1'},list),
  needs({action:'update',id:'c1',auditRetentionDays:30},list),needs({action:'update',id:'c1',auditRetentionDays:60},list),needs({action:'update',id:'c1',auditRetentionDays:10},list),
  needs({action:'update',id:'c1',auditRetentionDays:null},list),needs({action:'update',id:'c2',auditRetentionDays:10},list),needs({action:'update',id:'c1',auditRetentionDays:10},undefined),
 ],[false,false,true,false,false,true,false,false,false],'create and status never, technicians always, an edit only for a known shorter own value; an unknown value goes out and lets the server ask');
}

console.log(`${checks} customer drawer checks passed.`);
