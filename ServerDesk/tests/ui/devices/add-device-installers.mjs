// The page Add device, tab Several devices (ui/devices/add-device/add-device-installers.tsx):
// the installers of one customer from GET /api/customers, the customer choice, the
// table with its pills, meter and row menu, the empty state, create and revoke with
// MFA first, the blocked reasons (demo mode, no customer, a disabled customer), and the load states.
// Moves the installer checks of the former Customers dialog (customers-panel-view §5).
// German texts, a stubbed fetch, no server or browser.
import assert from 'node:assert/strict';
import {de} from '../../support/i18n-stubs.mjs';
import {serverText} from '../../support/server-text.mjs';
import {loader,mount} from '../../support/add-device-harness.mjs';

let checks=0;
const check=(actual,expected,message)=>{assert.deepEqual(actual,expected,message);checks++;};
class ApiError extends Error{constructor(message,status,code){super(message);this.status=status;this.code=code;}}
const net={get:null,post:null,download:null,calls:[]},toasts=[],saved=[];
const readApiJson=async response=>{const data=await response.json();if(!response.ok)throw new ApiError(data.error,response.status,data.code);return data;};
const shared={
 api:async(url,body)=>{net.calls.push({url,body});const answer=await (body?net.post(body):net.get());if(answer instanceof Error)throw answer;return answer;},
 credentialFetch:async(url,init)=>{const body=JSON.parse(init.body);net.calls.push({url,body,fetch:true,method:init.method});return net.download(body);},
 readApiJson,message:failure=>failure instanceof Error?failure.message:'Fehler',
};
const toast={success:text=>toasts.push(text),error:text=>toasts.push('error:'+text),info:text=>toasts.push('info:'+text)};
const load=loader({'ui/base/api':shared,'ui/session/mfa-step-up':{MfaStepUp:'MfaStepUp'},'sonner':{toast}});
const {default:Installers}=load('ui/devices/add-device/add-device-installers.tsx'),kit=load('ui/kit/kit.tsx'),field=load('ui/kit/field.tsx'),table=load('ui/kit/data-table.tsx'),confirm=load('ui/kit/confirm-dialog.tsx');
const model=load('ui/devices/add-device/add-device-model.ts');
globalThis.document={createElement:()=>({href:'',download:'',click(){saved.push({href:this.href,name:this.download});}})};
URL.createObjectURL=blob=>{assert.ok(blob instanceof Blob,'the answer is saved as a blob');return 'blob:installer';};URL.revokeObjectURL=()=>{};

const A='00000000-0000-4000-8000-000000000100',B='7f1c2a54-58a8-4f0e-9d33-6f5b1f0a2c11',C='2b0f5f4e-1f6e-4c47-8d1e-0d6c0f6f9a55';
const customer=(id,name,extra={})=>({id,name,status:'active',contactName:'',contactEmail:'',contactPhone:'',createdAt:1,updatedAt:1,auditRetentionDays:null,maintenanceWindow:null,revision:1,deviceCount:0,groupCount:0,...extra});
const customers=[customer(A,'Standardkunde'),customer(B,'Kunde B'),customer(C,'Kunde C',{status:'disabled'})];
const installer=(id,extra={})=>({id,customerId:B,name:'Rollout Nord',groupId:'gB1',groupName:'Gruppe B1',mode:'ReadOnly',createdAt:Date.UTC(2031,0,1),expiresAt:Date.UTC(2031,1,15,12),maxDevices:10,enrollments:3,lastUsedAt:null,revokedAt:null,status:'active',...extra});
const installers=[
 installer('i1'),
 installer('i2',{name:'Alt',groupId:null,groupName:null,maxDevices:null,enrollments:7,revokedAt:Date.UTC(2031,0,2),status:'revoked'}),
 installer('i3',{name:'Voll',mode:'Management',maxDevices:1,enrollments:1,status:'exhausted',expiresAt:Date.UTC(2031,0,20)}),
 installer('i4',{name:'Gruppe weg',groupId:'gGone',groupName:null,status:'group-missing'}),
 installer('i5',{name:'Abgelaufen',status:'expired'}),
 installer('a1',{customerId:A,name:'Standard'}),
];
const deviceGroups=[{id:'gB1',name:'Gruppe B1',customerId:B},{id:'gB2',name:'Gruppe B2',customerId:B},{id:'gA',name:'Gruppe A',customerId:A}];
const view=(list=installers,people=customers)=>({customers:people,installers:list,deviceGroups});

async function open(props={},{get=()=>view()}={}){
 net.get=get;net.calls=[];toasts.length=0;saved.length=0;
 const chosen=[];
 const ui=mount(Installers,{chosenCustomer:B,routeGroupId:'',multipleCustomers:true,demo:false,certificate:null,onChooseCustomer:id=>chosen.push(id),...props},{expand:['AgentModePick']});
 await ui.settle();
 const api={
  ui,chosen,
  table:()=>ui.find(node=>node.type===table.DataTable),
  rows:()=>api.table().props.rows,
  cells:row=>api.table().props.columns.map(column=>column.cell(row)),
  primary:()=>ui.find(node=>node.type===kit.SectionHead).props.primary,
  drawer:()=>ui.find(node=>node.type===kit.Drawer),
  mfa:()=>ui.find(node=>node.type==='MfaStepUp'),
  confirm:()=>ui.find(node=>node.type===confirm.ConfirmDialog),
  field:label=>ui.find(node=>node.type===field.Field&&node.props.label===label),
  set(label,value){api.field(label).props.children.props.onChange({target:{value}});ui.render();},
  submit(){ui.find(node=>node.type==='form'&&node.props.id==='sdx-installer-create').props.onSubmit({preventDefault(){}});ui.render();},
  async verify(token){api.mfa().props.onVerified({managementToken:token});ui.render();await ui.settle();},
 };
 return api;
}
const flat=node=>[node].flat(Infinity);

// ---- skeleton while loading, a failed load with retry that repeats the GET.
{
 const pending=await open({},{get:()=>new Promise(()=>{})});
 const skeleton=pending.ui.find(node=>node.type===kit.Skeleton);
 check([skeleton.props.variant,skeleton.props.label,skeleton.props.after,skeleton.props.action.type],['table','Installer werden geladen',15000,kit.RetryAction],'a table skeleton with the slow-load retry');
 check(net.calls,[{url:'/api/customers',body:undefined}],'one GET per visit');
 check(pending.primary().props.blocked,'Installer werden geladen','Create waits for the list');
 let attempts=0;
 const failing=await open({},{get:()=>++attempts===1?new ApiError('down',500):view()});
 const failed=failing.ui.find(node=>node.type===kit.LoadFailed);
 check(failed.props.text,'Die Installer konnten nicht geladen werden.','the load failure');
 failed.props.onRetry();await failing.ui.settle();
 check([net.calls.length,net.calls.every(call=>call.url==='/api/customers'&&call.body===undefined),!!failing.table()],[2,true,true],'the retry repeats the GET and shows the list');
}

// ---- the customer choice.
{
 const several=await open();
 const select=several.field('Kunde').props.children;
 check([select.props.value,flat(select.props.children).filter(node=>node?.type==='option').map(node=>[node.props.value,several.ui.text(node)])],[B,[['','Kunde wählen'],[A,'Standardkunde'],[B,'Kunde B'],[C,'Kunde C']]],'several customers: the select with the route customer');
 select.props.onChange({target:{value:A}});check(several.chosen,[A],'a choice goes to the page');
 const unknown=await open({chosenCustomer:'2b0f0000-0000-4000-8000-000000000000'});
 check([unknown.field('Kunde').props.children.props.value,unknown.table()],['',undefined],'an unknown customer is ignored');
 check(unknown.ui.text(unknown.ui.find(node=>node.type===kit.Notice)),'Wähle einen Kunden, um seine Installer zu sehen.','no customer: the notice');
 check(unknown.primary().props.blocked,'Wähle im Feld Kunde einen Kunden.','and Create is blocked');
 const single=await open({chosenCustomer:''},{get:()=>view(installers,[customers[1]])});
 check(single.field('Kunde').props.children.props.value,B,'exactly one customer is preselected');
 const plain=await open({multipleCustomers:false,chosenCustomer:''},{get:()=>view(installers,[customers[0]])});
 check([plain.field('Kunde'),plain.table().props.label,plain.primary().props.blocked,plain.ui.find(node=>node.type===kit.Notice)],[undefined,'Installer',undefined,undefined],'only the default customer: no field, the default customer, Create is available, no notice');
 // One customer: the copy names no customer (descriptionSingle, tableSingle, emptyTitleSingle, the drawer title Create installer).
 const head=ui=>ui.ui.find(node=>node.type===kit.SectionHead);
 check(head(plain).props.description,de('addDevice.installers.descriptionSingle'),'one customer: the description without a customer');
 const emptyPlain=await open({multipleCustomers:false,chosenCustomer:''},{get:()=>view([],[customers[0]])});
 check(emptyPlain.table().props.empty.title,'Noch keine Installer','one customer: the empty title without a customer');
 emptyPlain.primary().props.onClick();emptyPlain.ui.render();
 check(emptyPlain.drawer().props.title,'Installer erstellen','one customer: the drawer title is Create installer');
 // Several customers: the copy keeps {customer}.
 const emptySeveral=await open({},{get:()=>view([],customers)});
 check([head(emptySeveral).props.description,emptySeveral.table().props.label,emptySeveral.table().props.empty.title],[de('addDevice.installers.description'),'Installer von Kunde B','Noch keine Installer für Kunde B'],'several customers: the copy names the customer');
 emptySeveral.primary().props.onClick();emptySeveral.ui.render();
 check(emptySeveral.drawer().props.title,'Installer für Kunde B erstellen','several customers: the drawer title names the customer');
 // The model helper in both languages.
 check([model.installerCopy(false,'X','en'),model.installerCopy(true,'Contoso','en')],[
  {description:'An installer adds every device it runs on to Nodiverna. It contains a secret key, so give it only to people who set up devices.',table:'Installers',emptyTitle:'No installers yet',drawerTitle:'Create installer'},
  {description:'An installer adds every device it runs on to its customer. It contains a secret key, so give it only to people who set up devices.',table:'Installers of Contoso',emptyTitle:'No installers for Contoso yet',drawerTitle:'Create installer for Contoso'}],'installerCopy: one and several customers');
}

// ---- head, notice, columns, pills, meter, menu and foot.
{
 const ui=await open();
 const head=ui.ui.find(node=>node.type===kit.SectionHead);
 check([head.props.hideTitle,head.props.description,ui.ui.text(head.props.primary),head.props.primary.props.variant,head.props.primary.props.blocked],[true,de('addDevice.installers.description'),'Installer erstellen','primary',undefined],'the head with the primary Create installer');
 check(ui.ui.find(node=>node.type===kit.Notice),undefined,'no notice');
 const tableNode=ui.table();
 check([tableNode.props.label,tableNode.props.entranceId,tableNode.props.cards],['Installer von Kunde B','add-device-installers',true],'label, entrance and cards');
 check(tableNode.props.columns.map(column=>[column.id,column.label,!!column.sort]),[['name','Name',true],['group','Gruppe',false],['mode','Agent-Modus',false],['validUntil','Gültig bis',true],['devices','Geräte',false],['status','Status',false],['actions','Aktionen',false]],'the columns; name and valid until sort');
 check(tableNode.props.columns.at(-1).hideLabel,true,'the menu column has a hidden label');
 check(ui.rows().map(row=>row.id),['i1','i2','i3','i4','i5'],'only this customer, in the order of the answer');
 const [nord,alt,voll,weg,abgelaufen]=ui.rows();
 check(ui.cells(nord).slice(1,4).map(cell=>typeof cell==='string'?cell:ui.ui.text(cell)),['Gruppe B1','Nur lesen','15.2.2031'],'group, the D5 mode label and the date');
 check(ui.cells(voll)[2],'Verwaltung','Management, never the raw value');
 check(ui.cells(alt)[1],'Ohne Gruppe');check(ui.cells(weg)[1],'Gelöscht');
 const devices=row=>ui.cells(row)[4],meter=row=>flat(devices(row).props.children).find(node=>node?.type===kit.Meter);
 check([ui.ui.text(devices(nord)),meter(nord).props.size,meter(nord).props.value],['3 von 10','sm',30],'"3 of 10" with a small meter');
 check([ui.ui.text(devices(alt)),meter(alt)],['7',undefined],'no meter without a maximum');
 check(meter(voll).props.value,100,'a used-up installer has a full meter');
 const pill=row=>ui.cells(row)[5];
 check([nord,abgelaufen,voll,alt,weg].map(row=>[pill(row).props.kind,ui.ui.text(pill(row))]),[['success','Aktiv'],['neutral','Abgelaufen'],['neutral','Aufgebraucht'],['neutral','Widerrufen'],['warning','Gruppe gelöscht']],'the status pills');
 const menu=ui.cells(nord)[6];
 check([menu.type,menu.props.label,menu.props.entries.map(entry=>[entry.label,entry.danger,entry.blocked])],[kit.Menu,'Aktionen für Rollout Nord',[['Installer widerrufen…',true,undefined]]],'the row menu with the danger entry');
 check(ui.cells(alt)[6],null,'a revoked installer has no menu');
 check(tableNode.props.foot,'5 Installer','the foot');
 check([model.installerDevicesText(3,null,'de'),model.installerDevicesText(0,1,'de')],['3','0 von 1']);
 check(['active','expired','revoked','exhausted','group-missing'].map(status=>model.installerStatusText(status,'de')),['Aktiv','Abgelaufen','Widerrufen','Aufgebraucht','Gruppe gelöscht'],'the status texts');
 check(ui.ui.find(node=>node.type?.name==='PortalCertificateCard').props.use,'several','the certificate below the list');
 // Sort by name, then back.
 tableNode.props.onSort({column:'name',direction:'asc'});ui.ui.render();
 check(ui.rows().map(row=>row.name),['Abgelaufen','Alt','Gruppe weg','Rollout Nord','Voll'],'sorted by name');
 check(model.installerUsage(3,null),null);
 check((await open({},{get:()=>view([installers[3]].map(item=>({...item,customerId:B})).concat(installers.slice(0,1)))})).table().props.foot,'2 Installer','the plural');
 check(model.installerCustomer(customers,{multipleCustomers:true,chosen:''}),null);
 check((await open({},{get:()=>view([installers[0]])})).table().props.foot,'1 Installer','one installer');
}

// ---- the empty state.
{
 const ui=await open({},{get:()=>view([])});
 const empty=ui.table().props.empty;
 check([empty.icon,empty.title,empty.children,ui.ui.text(empty.action),empty.action.props.variant,empty.action.props.blocked],['Package','Noch keine Installer für Kunde B','Erstelle einen Installer, um mehrere Geräte dieses Kunden mit einer Datei hinzuzufügen.','Installer erstellen',undefined,undefined],'the empty state with a secondary Create');
 const demoEmpty=await open({demo:true},{get:()=>view([])});
 check(demoEmpty.table().props.empty.action.props.blocked,de('kit.unavailable.demo'),'the empty action has the same reasons');
}

// ---- the blocked reasons in order.
{
 const reason=async props=>(await open(props,{get:()=>view()})).primary().props.blocked;
 check(await reason({demo:true}),de('kit.unavailable.demo'),'demo first');
 check(await reason({chosenCustomer:''}),'Wähle im Feld Kunde einen Kunden.','then no customer');
 check(await reason({}),undefined,'no license lock');
 check(await reason({chosenCustomer:C}),'Einem deaktivierten Kunden kannst du keine Geräte hinzufügen.','then a disabled customer');
}

// ---- the drawer, validation, MFA first, the body, the file, the toast, the reload and the highlight.
{
 const ui=await open({routeGroupId:'gB2'});
 ui.primary().props.onClick();ui.ui.render();
 const drawer=ui.drawer();
 check([drawer.props.open,drawer.props.title,drawer.props.description,drawer.props.dirty],[true,'Installer für Kunde B erstellen',de('customers.secretHint'),false],'the drawer');
 const submit=()=>flat(ui.drawer().props.footer.props.children).find(node=>node?.type===kit.Btn&&node.props.type==='submit');
 check([flat(drawer.props.footer.props.children).map(node=>node?.type===kit.DrawerCancel?'cancel':ui.ui.text(node)),submit().props.blocked],[['cancel','Installer erstellen'],'Gib zuerst einen Namen ein.'],'Cancel and the blocked submit');
 const fields=ui.ui.all(node=>node.type===field.Field).map(node=>node.props.label).filter(label=>label!=='Kunde');
 check(fields,['Name','Gerätegruppe','Gültig für','Höchstens Geräte'],'name, group, valid for, maximum (the mode is a pick list)');
 const name=ui.field('Name').props.children;
 check([name.props.autoFocus,name.props.maxLength,name.props.placeholder],[true,80,de('customers.installerPlaceholder')],'the name field');
 check([ui.field('Gerätegruppe').props.children.props.value,flat(ui.field('Gerätegruppe').props.children.props.children).filter(node=>node?.type==='option').map(node=>node.props.value)],['gB2',['','gB1','gB2']],'the groups of this customer, the route group preselected');
 check([ui.field('Gültig für').props.children.props.value,flat(ui.field('Gültig für').props.children.props.children).filter(node=>node?.type==='option').map(node=>ui.ui.text(node))],[30,['1 Tag','7 Tage','30 Tage','90 Tage','365 Tage']],'valid for, default 30 days');
 check([ui.field('Höchstens Geräte').props.hint,ui.field('Höchstens Geräte').props.children.props.placeholder],['Nach so vielen Geräten funktioniert der Installer nicht mehr.','Unbegrenzt'],'the maximum hint and placeholder');
 check(ui.ui.all(node=>node.type===kit.PickRow).map(row=>[row.props.label,row.props.selected]),[['Nur lesen',true],['Verwaltung',false]],'Read-only by default');
 ui.set('Name','Rollout Süd');
 check(ui.drawer().props.dirty,true,'a change makes the drawer dirty');
 ui.ui.all(node=>node.type===kit.PickRow)[1].props.onSelect();ui.ui.render();
 ui.set('Gültig für','90');
 ui.set('Höchstens Geräte','2.5');
 ui.submit();
 check([ui.field('Höchstens Geräte').props.error,ui.mfa().props.open,net.calls.length],['Gib eine ganze Zahl von 1 bis 10000 ein.',false,1],'an invalid maximum: the field error after submit, nothing sent');
 for(const bad of ['0','10001','abc'])check(model.installerMaxDevices(bad).valid,false,bad);
 ui.set('Höchstens Geräte','25');
 ui.submit();
 check([ui.mfa().props.open,net.calls.length,ui.drawer().props.open],[true,1,true],'MFA first, nothing sent, the drawer stays');
 // Cancel MFA: nothing sent, the drawer keeps its input.
 ui.mfa().props.onClose();ui.ui.render();await ui.ui.settle();
 check([net.calls.length,ui.drawer().props.open,ui.field('Name').props.children.props.value],[1,true,'Rollout Süd'],'cancelling MFA keeps the drawer');
 let release;
 net.download=()=>new Promise(resolve=>{release=()=>resolve(new Response('script',{status:200,headers:{'Content-Disposition':'attachment; filename="Install-ServerDesk-Kunde_B-Rollout_Sued.ps1"'}}));});
 net.get=()=>view([...installers,installer('i9',{name:'Rollout Süd'})]);
 ui.submit();await ui.verify('installer-proof');
 check(net.calls.at(-1),{url:'/api/customers',body:{action:'create-installer',customerId:B,name:'Rollout Süd',groupId:'gB2',mode:'Management',validDays:90,maxDevices:25,managementToken:'installer-proof'},fetch:true,method:'POST'},'the body after the proof');
 check(submit().props.loading,true,'the submit shows its spinner');
 release();await ui.ui.settle();
 check(saved,[{href:'blob:installer',name:'Install-ServerDesk-Kunde_B-Rollout_Sued.ps1'}],'the file name from Content-Disposition');
 check(toasts,['Installer heruntergeladen. Starte ihn auf jedem Gerät in einer PowerShell als Administrator.'],'the toast');
 check([ui.drawer().props.open,net.calls.at(-1),ui.table().props.highlightKey],[false,{url:'/api/customers',body:undefined},['i9']],'the drawer closes, the list reloads and the new row is highlighted');
 check(model.installerFileName(null),'Install-ServerDesk.ps1','the fallback name');
}

// ---- an error keeps the drawer with its input and shows the API text.
{
 const ui=await open();
 ui.primary().props.onClick();ui.ui.render();ui.set('Name','Fehler');
 net.download=()=>Response.json({error:serverText('apiError.customer.installerGroupMismatch'),code:'VALIDATION_FAILED'},{status:400});
 ui.submit();await ui.verify('proof');
 check([ui.drawer().props.open,ui.field('Name').props.children.props.value,toasts],[true,'Fehler',['error:'+serverText('apiError.customer.installerGroupMismatch')]],'the drawer stays and toast.error shows the API text');
 check(net.calls.at(-1).body,{action:'create-installer',customerId:B,name:'Fehler',groupId:null,mode:'ReadOnly',validDays:30,maxDevices:null,managementToken:'proof'},'an empty maximum is unlimited (null)');
}

// ---- revoke with ConfirmDialog, MFA, body and toast; blocked in demo mode.
{
 const ui=await open({},{get:()=>view()});
 ui.cells(ui.rows()[0])[6].props.entries[0].onSelect();ui.ui.render();
 const dialog=ui.confirm();
 check([dialog.props.open,dialog.props.tone,dialog.props.title,dialog.props.lines,dialog.props.confirmLabel,dialog.props.body,dialog.props.blocked],[true,'danger','Installer widerrufen?',[{label:'Installer',value:'Rollout Nord'},{label:'Kunde',value:'Kunde B'}],'Installer widerrufen',de('customers.revokeDescription',{value:'Rollout Nord'}),undefined],'the confirmation');
 dialog.props.onConfirm();ui.ui.render();
 check([ui.confirm().props.open,ui.mfa().props.open,net.calls.length],[false,true,1],'then MFA, nothing sent yet');
 net.post=()=>view([{...installers[0],revokedAt:Date.UTC(2031,0,3),status:'revoked'},...installers.slice(1)]);
 await ui.verify('revoke-proof');
 check(net.calls.at(-1),{url:'/api/customers',body:{action:'revoke-installer',id:'i1',managementToken:'revoke-proof'}},'the revoke body');
 check([toasts,ui.ui.text(ui.cells(ui.rows()[0])[5]),ui.cells(ui.rows()[0])[6]],[['Installer widerrufen.'],'Widerrufen',null],'the toast; the row shows Revoked without a menu');
}
{
 const demo=await open({demo:true});
 check(demo.cells(demo.rows()[0])[6].props.entries[0].blocked,de('kit.unavailable.demo'),'demo mode blocks the menu entry');
 demo.ui.find(node=>node.type===confirm.ConfirmDialog).props.onConfirm();
 check([demo.ui.find(node=>node.type===confirm.ConfirmDialog).props.blocked,net.calls.length],[de('kit.unavailable.demo'),1],'and the confirmation, nothing sent');
 check(demo.table().props.rows.length,5,'demo mode lists the real installers');
}

console.log(`PASS add device installers (${checks} checks): load states, the customer choice, columns with pills, meter and row menu, the empty state, blocked reasons, create and revoke with MFA first.`);
