// Settings › Customers (ui/settings/customers-panel.tsx) on the kit: the display texts, the page header with its primary
// only once a load says "Multiple customers" is on, the card Organization with the switch Multiple customers (off: the
// only content; on: above the table; blocked while other customers exist; MFA first, rollback, toasts, a reload on a
// stale revision), the SettingsPage states, the console refresh, no
// notice and no lock, the DataTable with its columns, sort, cards, foot, row click, the Default tag (kit Tooltip, sr-only
// sentence, compact tag variant, outside the row open button) and the empty list with "Create customer", the row Menu
// with its icons and blocked reasons, the deactivate ConfirmDialog, and "Delete customer…": the last menu entry with
// its reasons (customerDeleteBlock in German and English), the delete drawer, and the row that fades out of the table
// before the page drops it. The page runs on
// the hook cells of tests/support/panel-harness.mjs with the real customer drawers (ui/settings/customer-drawers.tsx), the
// real useStepUp and real kit parts; the drawers themselves are covered by tests/ui/settings/customer-drawers-view.mjs. No
// server or browser is touched.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {panelHarness} from '../../support/panel-harness.mjs';
import {navPage,de,i18nStubs,i18nRequire} from '../../support/i18n-stubs.mjs';

let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const source=filename=>ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
const jsx=(type,props,key)=>({type,props:props??{},key});
const firstCustomer='00000000-0000-4000-8000-000000000100';
class ApiError extends Error{constructor(message,status,code){super(message);this.status=status;this.code=code;}}
let calls=[],get=()=>{throw new Error('no GET');},post=()=>{throw new Error('no POST');};
const shared={ApiError,message:failure=>failure.message,api:async(url,body)=>{calls.push({url,body});return body?post(body):get();}};
function MfaStepUp(){return null;}
const harness=panelHarness({hooked:['ui/settings/customers-panel.tsx','ui/settings/customer-drawers.tsx','ui/session/step-up-retry.ts','ui/shell/page-frame.ts'],stubs:{'@/ui/base/api':shared,'@/ui/session/mfa-step-up':{MfaStepUp}}});
const panelModule=harness.load('ui/settings/customers-panel.tsx'),CustomersPanel=panelModule.default;
const kit=harness.load('ui/kit/kit.tsx'),{DataTable}=harness.load('ui/kit/data-table.tsx'),{ConfirmDialog}=harness.load('ui/kit/confirm-dialog.tsx'),{Tooltip}=harness.load('ui/kit/tooltip.tsx');

const window={days:[1,2,3,4,5],start:'22:00',durationMinutes:240,timeZone:'Europe/Berlin'};
const customer=(extra={})=>({id:'7f1c2a54-58a8-4f0e-9d33-6f5b1f0a2c11',name:'Kunde B',status:'active',contactName:'',contactEmail:'',contactPhone:'',createdAt:1,updatedAt:1,auditRetentionDays:null,maintenanceWindow:null,revision:3,deviceCount:0,groupCount:0,...extra});
const standard=customer({id:firstCustomer,name:'Standardkunde',revision:0,deviceCount:12,groupCount:4});
const customerC=customer({id:'0e7f2e57-3a52-4d55-a8a5-0f0a8c1f8b31',name:'Kunde C',status:'disabled',revision:5,deviceCount:3,groupCount:9});
// The answer of GET /api/customers; "Multiple customers" is on unless extra says otherwise.
const setting=(customers,extra={})=>({enabled:true,otherCustomers:customers.filter(item=>item.id!==firstCustomer).length,revision:1,...extra});
const view=(customers=[standard,customer()],extra={})=>({customers,multipleCustomers:setting(customers),...extra});

// ---- The harness of one page ----
let tree=null,frame=null;
const viewer={id:'owner',label:'owner@example.test',permissions:['*']};
const header=primary=>({type:'PageHeader',props:{primary}});
const render=()=>{tree=harness.tree(CustomersPanel,{viewer,frame});return tree;};
const settle=async()=>{for(let round=0;round<4;round++){await harness.flush();render();}};
async function start({getter,poster=()=>{throw new Error('no POST');}}){
 harness.reset();calls=[];get=getter;post=poster;frame={header,refresh:0,tab:'',onTab(){}};
 render();await settle();
}
const find=predicate=>harness.find(tree,predicate);
const all=predicate=>harness.walk(tree).filter(predicate);
const headers=()=>all(node=>node.type==='PageHeader');
const primary=()=>headers()[0].props.primary;
const page=()=>find(node=>node.type===kit.SettingsPage);
const table=()=>find(node=>node.type===DataTable);
const notice=()=>find(node=>node.type===kit.Notice);
const menu=name=>harness.menu(tree,de('customers.menu.label',{name}));
const entry=(name,id)=>menu(name).find(item=>item.id===id);
const confirm=()=>find(node=>node.type===ConfirmDialog);
const stepUp=()=>find(node=>node.type===MfaStepUp);
const drawer=()=>find(node=>node.type===kit.Drawer&&node.props.open);
const toasts=()=>harness.toasts.splice(0);
const cellText=(row,id)=>{const value=table().props.columns.find(column=>column.id===id).cell(row);return typeof value==='string'?value:harness.text(value);};

// 1. Display texts of the model, read in German.
{
 const {maintenanceWindowText,retentionText,technicianText,customersPaletteKeywords}=panelModule;
 check([maintenanceWindowText(null,'de'),maintenanceWindowText(window,'de')],['Keins','Mo–Fr · 22:00–02:00 Uhr (Europe/Berlin)'],'no window, and a window past midnight');
 check(maintenanceWindowText({...window,days:[5,1,3],start:'00:15',durationMinutes:45,timeZone:'UTC'},'de'),'Mo, Mi, Fr · 00:15–01:00 Uhr (UTC)');
 check([retentionText(null,'de'),retentionText(1,'de'),retentionText(30,'de')],['Standard','1 Tag','30 Tage']);
 check([[0,0],[1,0],[0,2],[2,1]].map(([users,groups])=>technicianText(users,groups,'de')),['Keine','1 Konto','2 Gruppen','2 Konten, 1 Gruppe']);
 check([Object.hasOwn(panelModule,'customersNotice'),Object.hasOwn(panelModule,'customerLockReason')],[false,false],'no notice and no lock of an edition');
 check(de(customersPaletteKeywords),'kunden mandanten msp kontakt wartungsfenster aufbewahrung mehrere kunden kunde löschen');
}

// 2. The header with its primary in every state, the SettingsPage states and the refresh.
{
 let fail=true;
 await start({getter:async()=>{if(fail)throw new ApiError('Die Kunden konnten nicht geladen werden.',503);return view();}});
 check(headers().length,1,'error: the header once');
 check(primary(),undefined,'error: no primary until a load says multiple customers is on');
 check([page().props.label,page().props.loading,page().props.loadError],[de('nav.settings.customers'),false,'Die Kunden konnten nicht geladen werden.'],'error: LoadFailed in the SettingsPage');
 fail=false;page().props.onRetry();await settle();
 check(calls.filter(call=>!call.body).length,2,'Try again repeats the GET');
 check([page().props.loadError,!!table(),headers().length],[undefined,true,1],'after the retry the table shows');
 check([primary().type,primary().props.variant,primary().props.icon.displayName,harness.text(primary())],[kit.Btn,'primary','Plus',de('customers.create')],'the primary is the kit Btn Create customer');
 check(primary().props.blocked,undefined,'after the load "Create customer" is available, also with only the default customer');
 // First load: the Skeleton of the SettingsPage below the header.
 await start({getter:()=>new Promise(()=>{})});
 check([headers().length,page().props.loading,page().props.label,!!table()],[1,true,'Kunden',false],'loading: the header once and the SettingsPage Skeleton');
 check(primary(),undefined,'loading: no primary and no switch until the setting has loaded');
 check(find(node=>node.type===kit.Card),undefined,'loading: no card');
 ok(!all(node=>node.props?.['aria-label']==='Kunden neu laden').length&&!all(node=>node.type==='h2').length,'no refresh button and no in-page heading');
}
{
 // Only the default customer: the primary is available and the page has no notice; a console refresh keeps the table and sends one GET.
 await start({getter:async()=>view([standard])});
 check([primary().props.blocked,notice()],[undefined,undefined],'one customer: the primary is available, no notice');
 primary().props.onClick();render();check(drawer()?.props.title,de('customers.create'),'one customer: the primary opens the create drawer');
 drawer().props.onClose();render();
 frame={...frame,refresh:1};render();
 const before=calls.length;await harness.flush();render();
 check([page().props.loading,!!table(),calls.length-before],[false,true,1],'a console refresh keeps the loaded table and sends one GET');
 await settle();check(table().props.busy,false,'the refreshed list replaces the old one');
 await start({getter:async()=>view()});
 check([primary().props.blocked,notice()],[undefined,undefined],'two customers: the primary is available, no notice');
 {let fail=true;await start({getter:async()=>{if(fail)throw new ApiError('down',503);return view();}});
  check(primary(),undefined,'after a failed load: no primary');
  fail=false;page().props.onRetry();await settle();check(primary().props.blocked,undefined,'after a successful retry it is available');}
 // Busy: while a customer request is out, the primary says why. Deactivating needs no MFA (lib/step-up.ts).
 let release;await start({getter:async()=>view(),poster:()=>new Promise(resolve=>{release=()=>resolve(view());})});
 entry('Kunde B','deactivate').onSelect();render();
 confirm().props.onConfirm();render();
 check([stepUp().props.open,primary().props.blocked,calls.filter(call=>call.body).map(call=>call.body.action)],[false,de('kit.busy'),['set-status']],'busy: the deactivation goes out at once, without the MFA dialog, and the primary is blocked with kit.busy');
 release();await settle();
 check(primary().props.blocked,undefined,'the answer ends the busy state');
}

// 3. The table.
{
 const contact=customer({contactName:'Erika Muster',contactEmail:'it@kunde-b.example',contactPhone:'+49 30 1234',auditRetentionDays:1,maintenanceWindow:window,deviceCount:7,groupCount:2});
 const assignments=[{customerId:contact.id,subjectType:'user',subjectId:'u1'},{customerId:contact.id,subjectType:'group',subjectId:'g1'}];
 await start({getter:async()=>view([standard,contact,customerC],{assignments})});
 const props=table().props;
 check([props.label,props.cards,props.entranceId,harness.text(props.foot)||props.foot],[de('nav.settings.customers'),true,'settings-customers','3 Kunden'],'label, cards, entrance and the plural foot');
 check(props.columns.map(column=>[column.id,column.label]),[['name','Kunde'],['contact','Kontakt'],['devices','Geräte'],['groups','Gruppen'],['access','Technikerzugriff'],['retention','Audit-Aufbewahrung'],['window','Wartungsfenster'],['actions','Aktionen']],'the columns in order');
 const column=id=>props.columns.find(item=>item.id===id);
 check([column('name').primary,column('name').sort,column('devices').align,column('devices').mono,column('devices').sort,column('groups').align,column('groups').mono,column('retention').hideBelow,column('window').wrap,column('actions').hideLabel,column('actions').className],[true,{first:'asc'},'end',true,{first:'desc'},'end',true,1280,true,true,'sdx-col-actions'],'sort, alignment, mono, hiding and the actions column');
 check(props.rows.map(row=>row.name),['Standardkunde','Kunde B','Kunde C'],'the server order');
 const name=row=>harness.walk(column('name').cell(row));
 // The Default tag: outside the row open button (aside), in the kit Tooltip, focusable, the compact tag variant, the sentence also as sr-only text.
 const tip=column('name').aside(standard),tag=tip.props.children,hidden=harness.walk(tag).find(node=>node.props?.className==='sr-only');
 check([tip.type,tip.props.content,tag.type,tag.props.className,tag.props.tabIndex,Object.hasOwn(tag.props,'title')],[Tooltip,de('customers.defaultTitle'),'span','sdx-tag sdx-tag-sm',0,false],'the Default tag: kit Tooltip with the explanation, focusable, compact variant, no native title');
 check([tag.props.children[0],harness.text(hidden).trim()],[de('customers.standard'),de('customers.defaultTitle')],'the tag reads "Default" and its sr-only sentence');
 ok(!name(standard).some(node=>String(node.props?.className??'').includes('sdx-tag')),'the tag is not inside the name cell (the row open button)');
 const pill=name(customerC).find(node=>node.type===kit.StatusPill);
 check([pill.props.kind,harness.text(pill)],['neutral',de('fleet.disabled')],'a deactivated customer has the neutral pill Deactivated');
 ok(!name(contact).some(node=>node.props?.className==='sdx-tag'||node.type===kit.StatusPill)&&column('name').aside(contact)===null,'an active customer has no tag');
 check([column('contact').cell(standard),harness.walk(column('contact').cell(contact)).filter(node=>node.type==='small'||node.type==='span'&&node.props.className!=='sdx-cell-stack').map(node=>harness.text(node))],['—',['Erika Muster','it@kunde-b.example','+49 30 1234']],'the contact as a cell stack, or EMPTY_VALUE');
 check([column('devices').cell(contact),column('groups').cell(contact),cellText(contact,'access'),cellText(contact,'retention'),cellText(contact,'window')],[7,2,'1 Konto, 1 Gruppe','1 Tag','Mo–Fr · 22:00–02:00 Uhr (Europe/Berlin)'],'counts, technicians, retention and window');
 props.onSort({column:'devices',direction:'desc'});render();
 check(table().props.rows.map(row=>row.name),['Standardkunde','Kunde B','Kunde C'],'devices descending: 12, 7, 3');
 table().props.onSort({column:'name',direction:'desc'});render();
 check(table().props.rows.map(row=>row.name),['Standardkunde','Kunde C','Kunde B'],'name descending');
 table().props.onSort({column:'groups',direction:'asc'});render();
 check(table().props.rows.map(row=>row.name),['Kunde B','Standardkunde','Kunde C'],'groups ascending: 2, 4, 9');
 // A row click opens "Manage customer…".
 table().props.onOpen(contact);render();
 check(drawer()?.props.title,de('customers.drawer.manageTitle',{name:'Kunde B'}),'a row click opens the manage drawer');
 // An empty list: "No customers yet", its hint and "Create customer" (secondary) with the reason of the primary.
 {
  await start({getter:async()=>view([])});
  const empty=table().props.empty;
  check([empty.icon.displayName,empty.title,empty.children,empty.action.type,empty.action.props.variant,empty.action.props.icon.displayName,harness.text(empty.action),empty.action.props.blocked,primary().props.blocked],
   ['Building2',de('customers.none'),de('customers.noneHint'),kit.Btn,'secondary','Plus',de('customers.create'),undefined,undefined],'the empty list offers "Create customer" like the primary');
 }
 ok(!fs.readFileSync('ui/settings/customers-panel.tsx','utf8').includes("'customers.noMatch'"),'customers.noMatch is no longer used by the table');
}

// 4. The row menu.
{
 // The write that makes the page busy stays out until the next start.
 await start({getter:async()=>view([standard,customer(),customerC]),poster:()=>new Promise(()=>{})});
 check(menu('Kunde B').filter(item=>!item.separator).map(item=>[item.id,item.icon.displayName]),[['manage','Pencil'],['access','Users'],['installers','Package'],['deactivate','PowerOff'],['delete','Trash2']],'every entry has the icon of the tree menu for the same action');
 check(entry('Kunde C','activate').icon.displayName,'Power','"Activate customer" uses Power');
 check(menu('Kunde B').map(item=>[item.id,item.label??null,!!item.danger,!!item.separator]),[['manage','Kunde verwalten…',false,false],['access','Technikerzugriff…',false,false],['installers','Installer',false,false],['separator',null,false,true],['deactivate','Kunde deaktivieren…',true,false],['delete','Kunde löschen…',true,false]],'entries in order, danger last after a separator, Delete customer… the very last');
 check(entry('Kunde B','installers').href,'#devices/add/installer/customer/'+customer().id,'Installers links to Several devices of Add device');
 check(menu('Kunde C').at(-2).id,'activate');check(entry('Kunde C','activate').label,'Kunde aktivieren');
 check(menu('Kunde B').map(item=>item.blocked),[undefined,undefined,undefined,undefined,undefined,undefined],'every entry is available');
 // Delete is never hidden: the first customer and a customer with devices and groups say why.
 check(entry('Standardkunde','delete').blocked,de('customers.delete.defaultBlocked'),'the first customer cannot be deleted');
 check(entry('Kunde C','delete').blocked,'Kunde C hat noch 3 Geräte und 9 Gerätegruppen. Entferne oder lösche sie zuerst.','the data a customer still holds');
 check(entry('Standardkunde','deactivate').blocked,de('customers.defaultProtected'),'the first customer cannot be deactivated');
 ok(!table().props.columns.some(column=>harness.walk(column.cell(customer())).some(node=>node.type===kit.Btn)),'no Btn sits in a row');
 // Busy: every write entry says so while a request waits; Installers stays.
 entry('Kunde C','activate').onSelect();render();
 check(menu('Kunde B').map(item=>item.blocked),[de('kit.busy'),de('kit.busy'),undefined,undefined,de('kit.busy'),de('kit.busy')],'busy: kit.busy on the write entries');
 check(entry('Standardkunde','deactivate').blocked,de('customers.defaultProtected'),'the first-customer reason wins over busy');
 // Only the default customer: no lock; technician access without an assignment opens too.
 await start({getter:async()=>view([standard])});
 check(menu('Standardkunde').filter(item=>!item.separator).map(item=>item.blocked),[undefined,undefined,undefined,de('customers.defaultProtected'),de('customers.delete.defaultBlocked')],'one customer: only the first-customer reasons');
 entry('Standardkunde','access').onSelect();render();
 check(drawer()?.props.title,de('customers.drawer.accessTitle',{name:'Standardkunde'}),'technician access opens without an assignment');
}

// 5. Deactivate asks with a ConfirmDialog, activate does not; neither asks for MFA (lib/step-up.ts).
{
 const list=[standard,customer(),customerC];
 await start({getter:async()=>view(list),poster:async()=>view(list)});
 check(confirm().props.open,false);
 entry('Kunde B','deactivate').onSelect();render();
 const dialog=confirm().props;
 check([dialog.open,dialog.title,dialog.body,dialog.confirmLabel,dialog.tone],[true,'Kunde B deaktivieren?',de('customers.disableHint'),'Kunde deaktivieren','danger'],'the ConfirmDialog names the action');
 dialog.onConfirm();render();
 await settle();
 check([confirm().props.open,stepUp().props.open],[false,false],'confirmed: no MFA dialog');
 check(calls.at(-1),{url:'/api/customers',body:{action:'set-status',id:customer().id,revision:3,status:'disabled'}},'set-status disabled at once, without a proof');
 check(toasts(),[de('customers.toast.disabled')]);
 entry('Kunde C','activate').onSelect();render();await settle();
 check([confirm().props.open,stepUp().props.open],[false,false],'activate: no question and no MFA dialog');
 check(calls.at(-1).body,{action:'set-status',id:customerC.id,revision:5,status:'active'});
 check(toasts(),[de('customers.toast.enabled')]);
}

// 6. Kit only.
{
 const page=fs.readFileSync('ui/settings/customers-panel.tsx','utf8'),drawers=fs.readFileSync('ui/settings/customer-drawers.tsx','utf8');
 for(const [file,text] of [['customers-panel.tsx',page],['customer-drawers.tsx',drawers]]){
  ok(!/@\/components\/ui\/|ErrorNote|skeleton-bar|<select\b|role="switch"|MFA_LOGIN_REQUIRED|MFA_STEP_UP_REQUIRED|deaktivieren\?|>Owner</.test(text),`${file}: kit only, no own MFA logic, no literal`);
 }
 ok(/useCustomers/.test(page)&&!/<Drawer\b/.test(page),'the page keeps the table; the drawers live in customer-drawers.tsx');
 ok(!/CustomerFocus|handledFocus|focus\?:/.test(page),'the focus request is gone');
 const css=fs.readFileSync('ui/settings/customers-panel.css','utf8');
 ok(!/#[0-9a-f]{3,8}\b|rgba?\(/i.test(css)&&!/sd-customers?-/.test(css),'tokens only, no old classic rules');
 ok(!/\.sdx-tag\b/.test(css),'no page-local restyle of the kit tag: the compact tag is the kit variant .sdx-tag.sdx-tag-sm');
 ok(fs.readFileSync('ui/styles/console.css','utf8').includes('.sdx-tag.sdx-tag-sm { height: 20px; padding: 0 8px; }'),'the kit compact tag: 20px high, padding 0 8px');
}

// 7. The card Organization with the switch Multiple customers.
{
 const {Switch}=harness.load('ui/kit/field.tsx');
 const card=()=>find(node=>node.type===kit.Card);
 const toggle=()=>find(node=>node.type===Switch);
 const model=harness.load('ui/settings/customers-model.ts');
 // Off: one card with the switch, nothing else.
 let answer=view([standard],{multipleCustomers:{enabled:false,otherCustomers:0,revision:0}});
 await start({getter:async()=>answer,poster:async body=>({...view([standard]),multipleCustomers:{enabled:body.enabled,otherCustomers:0,revision:1}})});
 check([card().props.title,card().props.description,card().props.icon.displayName,card().props.iconTone],[de('customers.multiple.cardTitle'),de('customers.multiple.cardDescription'),'Building2','accent'],'off: the card Organization with its IconTile and description');
 check([toggle().props.label,toggle().props.hint,toggle().props.checked,toggle().props.blocked],[de('customers.multiple.label'),de('customers.multiple.hint'),false,undefined],'off: the switch Multiple customers, not blocked');
 check([primary(),table(),page().props.wide,confirm(),all(node=>node.type===kit.Menu).length],[undefined,undefined,undefined,undefined,0],'off: no Create customer, no table, no row menu, no deactivate dialog');
 // Turning it on: the MFA proof first, then the request with the revision; the answer shows the table.
 let pending=toggle().props.onChange(true);render();
 check([stepUp().props.open,calls.filter(call=>call.body).length,toggle().props.busy],[true,0,true],'on: the MFA dialog first, nothing sent, the switch busy');
 stepUp().props.onVerified({managementToken:'on'});await settle();
 check(await pending,true,'the switch keeps the new state');
 check(calls.at(-1),{url:'/api/customers',body:{action:'set-multiple-customers',enabled:true,revision:0,managementToken:'on'}},'set-multiple-customers with the revision and the proof');
 check(toasts(),[de('customers.multiple.turnedOn')],'the success toast');
 check([toggle().props.checked,!!table(),table().props.entranceId,harness.text(primary())],[true,true,'settings-customers',de('customers.create')],'on: the card stays above the table, Create customer is back');
 // Cancel: nothing sent, the switch rolls back silently.
 pending=toggle().props.onChange(false);render();
 const sent=calls.length;stepUp().props.onClose();
 check([await pending,calls.length-sent,toasts()],[false,0,[]],'cancel: rollback, nothing sent, no toast');
 // A failure: rollback with the error toast.
 post=async()=>{throw new ApiError('Fehler beim Speichern.',500,'INTERNAL_ERROR');};
 pending=toggle().props.onChange(false);render();stepUp().props.onVerified({managementToken:'fail'});await settle();
 check([await pending,toasts()],[false,['error:Fehler beim Speichern.']],'failure: rollback and toast.error(message)');
 // A stale revision (CONFLICT): the page loads again before the toast.
 answer=view([standard],{multipleCustomers:{enabled:true,otherCustomers:0,revision:4}});
 post=async()=>{throw new ApiError('Jemand anderes hat diese Einstellung geändert.',409,'CONFLICT');};
 const gets=calls.filter(call=>!call.body).length;
 pending=toggle().props.onChange(false);render();stepUp().props.onVerified({managementToken:'stale'});
 check(await pending,false,'stale: rollback');
 await settle();
 check([calls.filter(call=>!call.body).length-gets,toasts()],[1,['error:Jemand anderes hat diese Einstellung geändert.']],'stale: one GET, then the error toast');
 // Off again with only the default customer: the answer hides the table.
 post=async body=>({...view([standard]),multipleCustomers:{enabled:body.enabled,otherCustomers:0,revision:5}});
 pending=toggle().props.onChange(false);render();stepUp().props.onVerified({managementToken:'off'});await settle();
 check([await pending,calls.at(-1).body.revision,toasts(),toggle().props.checked,table(),primary()],[true,4,[de('customers.multiple.turnedOff')],false,undefined,undefined],'off: the revision of the reload, the toast, no table');
 // On with other customers: blocked with the plural reason.
 for(const [list,count] of [[[standard,customer()],1],[[standard,customer(),customerC,customer({id:'1d2c3b4a-0000-4000-8000-000000000003',name:'Kunde D'})],3]]){
  await start({getter:async()=>view(list)});
  check(toggle().props.blocked,de('customers.multiple.offBlocked',{count}),`${count} other customers: blocked with the reason`);
  check([!!card(),!!table()],[true,true],'card and table');
 }
 // The model helper, in German and English.
 check([1,3].map(count=>model.multipleCustomersBlock({enabled:true,otherCustomers:count,revision:1},'de')),['Es gibt noch 1 weiteren Kunden. Lösche ihn zuerst, um mehrere Kunden auszuschalten.','Es gibt noch 3 weitere Kunden. Lösche sie zuerst, um mehrere Kunden auszuschalten.'],'the reason in German');
 check([1,3].map(count=>model.multipleCustomersBlock({enabled:true,otherCustomers:count,revision:1},'en')),['1 other customer still exists. Delete it first to turn off multiple customers.','3 other customers still exist. Delete them first to turn off multiple customers.'],'the reason in English');
 check([model.multipleCustomersBlock({enabled:true,otherCustomers:0,revision:1},'de'),model.multipleCustomersBlock({enabled:false,otherCustomers:0,revision:0},'de'),model.multipleCustomersBlock(undefined,'de')],[undefined,undefined,undefined],'not blocked with only the default customer, while off, or without the setting');
 check([model.multipleCustomersOn(null),model.multipleCustomersOn({multipleCustomers:{enabled:false,otherCustomers:0,revision:0}}),model.multipleCustomersOn({multipleCustomers:{enabled:true,otherCustomers:0,revision:1}})],[false,false,true],'multipleCustomersOn');
}

// Help, palette and navigation entries.
await import('../../support/register.mjs');
const navModel=await import('../../../ui/shell/nav-model.ts');
const settingsIds=navModel.navigatorPages('settings',{viewer:{permissions:['*']}}).map(node=>node.section);
const loadModule=(filename,stubs)=>{const mod={exports:{}};new Function('require','module','exports',source(path.resolve(filename)))(id=>i18nRequire(id)??(Object.hasOwn(stubs,id)?stubs[id]:id.endsWith('.css')?{}:id==='lucide-react'?new Proxy({}, {get:(_target,key)=>String(key)}):id==='react/jsx-runtime'?{jsx,jsxs:jsx,Fragment:'Fragment'}:(()=>{throw Error('Unexpected import '+id);})()),mod,mod.exports);return mod.exports;};
const help=loadModule('ui/shell/help-panel.tsx',{...i18nStubs,'@/ui/base/docs-base':loadModule('ui/base/docs-base.ts',{}),'@/ui/shell/console-shortcuts':{shortcutList:[]},'@/ui/kit/kit':{Drawer:'Drawer',Kbd:'Kbd'},'@/ui/shell/nav-model':navModel,'@/ui/base/health-score':loadModule('ui/base/health-score.ts',{})});
assert.deepEqual(help.topicFor({view:'settings',page:'customers'}),{title:'Kunden',tips:['Konten und Benutzergruppen sehen nur die Kunden, die du ihnen im Kundenmenü mit „Technikerzugriff…“ zuweist. Owner sehen alle Kunden.','Um mehrere Geräte zu einem Kunden hinzuzufügen, wähle im Kundenmenü „Installer“. Jedes Gerät, auf dem der Installer läuft, kommt direkt zu diesem Kunden.','Schalte „Mehrere Kunden“ ein, um mehrere Organisationen zu verwalten. Sobald es einen zweiten Kunden gibt, sieht jedes Konto nur die Kunden, die ihm zugewiesen sind.'],docs:[{label:'Kunden',file:'docs/customers.md'}]});
assert.equal(help.topicFor({view:'settings',page:'roles'}).title,'Konten & Zugriff');checks+=2;
assert.equal(settingsIds.indexOf('customers'),settingsIds.indexOf('sessions')+1,'Customers opens the Organization group, after Sessions');
// The Customers page shows for every global Owner, with or without a second customer.
assert.deepEqual([false,undefined,true].map(multipleCustomers=>navModel.navigatorPages('settings',{viewer:{permissions:['*']},multipleCustomers}).some(node=>node.section==='customers')),[true,true,true],'Customers for every Owner');checks++;assert.equal(navPage(navModel,'roles').label,'Rollen');
assert.deepEqual(navPage(navModel,'customers'),{id:'customers',label:'Kunden',description:'Erstelle die Kunden, deren Geräte du verwaltest, mit Kontakten, Datenaufbewahrung und Wartungsfenstern.',icon:'Building2',group:'Organisation'},'texts are message keys, read in German');
assert.equal(navModel.navNode('settings.customers').palette.keywordsKey,'customers.paletteKeywords');assert.equal(navModel.paletteKeywords(navModel.navNode('settings.customers'),de),de('customers.paletteKeywords')+' einstellungen','the palette translates the page keywords');
assert.doesNotMatch(fs.readFileSync('ui/shell/console-shortcuts.ts','utf8'),/customer|Kunde/i,'no new shortcut');checks+=3;
// The section ids are the page names of #settings/<page>: the Customers node renders the customers section.
assert.deepEqual(settingsIds.filter(Boolean),['accounts','user-groups','roles','entra','sessions','customers','branding','notification-channels','vulnerabilities','assistant','retention','audit','usage-data']);assert.equal(de(navModel.navNode('settings.customers').label),'Kunden');checks+=2;
const capabilities=loadModule('ui/base/access-capabilities.ts',{});
assert.equal(capabilities.canOpenAccessSection({permissions:['*']},'customers'),true);
assert.equal(capabilities.canOpenAccessSection({permissions:['*']},'customers'),true);
assert.equal(capabilities.canOpenAccessSection({permissions:['portal.users.manage','portal.userGroups.manage','portal.roles.manage','portal.roleAssignments.manage']},'customers'),false,'delegated portal rights are not Owner');
assert.equal(capabilities.canOpenAccessSection({permissions:[]},'customers'),false);checks+=4;

// 8. Delete customer: the reasons, the drawer from the row menu, the fading row and the focus target.
{
 const model=harness.load('ui/settings/customers-model.ts'),{NameConfirmDrawer}=harness.load('ui/kit/name-confirm-drawer.tsx');
 const block=(extra,busy=false,locale='de')=>model.customerDeleteBlock(customer({runbookCount:0,templateCount:0,roleCount:0,...extra}),busy,locale);
 check([block({id:firstCustomer,name:'Standardkunde'},true,'de'),block({id:firstCustomer},false,'en')],[de('customers.delete.defaultBlocked'),'You cannot delete the first customer. All devices and groups without a customer of their own belong to it.'],'the first customer: its reason wins over busy');
 check([block({deviceCount:1},false,'en'),block({deviceCount:3,groupCount:1},false,'en'),block({deviceCount:3,groupCount:1},false,'de')],
  ['Kunde B still has 1 device. Remove or delete them first.','Kunde B still has 3 devices and 1 device group. Remove or delete them first.','Kunde B hat noch 3 Geräte und 1 Gerätegruppe. Entferne oder lösche sie zuerst.'],'the data the customer still holds, as a list in the console language');
 check(block({deviceCount:1,groupCount:2,runbookCount:1,templateCount:4,roleCount:1},true,'de'),'Kunde B hat noch 1 Gerät, 2 Gerätegruppen, 1 Runbook, 4 Automationsvorlagen und 1 Rolle. Entferne oder lösche sie zuerst.','every kind in its order; the data reason wins over busy');
 check([block({},true,'de'),block({},false,'de')],[de('kit.busy'),undefined],'an empty customer: only a running request blocks it');
 // From the row menu to the deleted row.
 const gone=customer(),after=view([standard]);
 await start({getter:async()=>view([standard,gone]),poster:async()=>after});
 entry('Kunde B','delete').onSelect();render();
 const drawer=()=>find(node=>node.type===NameConfirmDrawer);
 check([drawer()?.props.open,drawer()?.props.name],[true,'Kunde B'],'"Delete customer…" opens the delete drawer');
 drawer().props.onConfirm();render();await settle();
 stepUp().props.onVerified({managementToken:'delete'});await settle();
 check([calls.at(-1).body,toasts(),drawer().props.open],[{action:'delete',id:gone.id,revision:3,managementToken:'delete'},[de('customers.delete.done')],false],'the request after the proof, the toast, the drawer closes');
 check([table().props.leavingKeys,table().props.rows.map(row=>row.id),table().props.foot],[[gone.id],[firstCustomer,gone.id],de('customers.foot',{count:1})],'the deleted row stays for its fade; the foot already counts the new list');
 ok(harness.walk(tree).some(node=>node.type==='div'&&node.props.tabIndex===-1&&node.props.children===table()),'the table sits in a focusable wrapper, the focus target after a delete');
 await new Promise(resolve=>setTimeout(resolve,panelModule.customerLeaveMs+40));await settle();
 check([table().props.leavingKeys,table().props.rows.map(row=>row.id)],[undefined,[firstCustomer]],'after the fade the row is gone');
 check(panelModule.customersWithLeaving([standard],{customer:gone,index:1}).map(row=>row.id),[firstCustomer,gone.id],'the leaving customer keeps its place');
 check(panelModule.customersWithLeaving([standard,gone],{customer:gone,index:1}).map(row=>row.id),[firstCustomer,gone.id],'a customer still in the list is not doubled');
}

console.log(`${checks} customers panel checks passed.`);
