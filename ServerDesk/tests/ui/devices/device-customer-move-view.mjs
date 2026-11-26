// "Move to another customer…" in the UI (ui/devices/fleet/customer-move-model.ts, customer-move-drawer.tsx): the entry
// in the fleet row menu, the selection bar and the device header menu (shown, hidden with one customer or without
// another customer, never for a removed device, blocked for sample devices, while saving, without both permissions and
// above 100 devices), and the drawer: the customer options without the source customers, the group list filtered by
// customer and permissions with "Ungrouped" only for global permissions, the empty state, the two consequence cards,
// the access line, the primary label and its blocked reasons, the payload sent through the step-up send after the MFA
// proof, a cancelled MFA that sends nothing and keeps the choices, the toast for one and several devices, and a refused
// move that keeps the drawer. The drawer runs on hook cells (tests/support/panel-harness.mjs), German by default.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {panelHarness} from '../../support/panel-harness.mjs';
import {de} from '../../support/i18n-stubs.mjs';
const {translate}=await import('../../../lib/i18n/translate.ts');
const model=await import('../../../ui/devices/fleet/customer-move-model.ts');
const {fleetRowMenu}=await import('../../../ui/devices/fleet/fleet.tsx');
const {deviceHeaderMenu}=await import('../../../ui/devices/device/device.tsx');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const en=(key,params)=>translate('en',key,params);

const customers=[{id:'c-b',name:'Kunde B'},{id:'c-a',name:'Kunde A'},{id:'c-c',name:'Acme'}];
const device=(id,customerId,extra={})=>({id,name:'SRV-'+id,customerId,customerName:customers.find(customer=>customer.id===customerId)?.name,revoked:0,permissions:['view','manage','groups.manage'],...extra});
const owner={id:'o',label:'owner@test',permissions:['*']};
const tech={id:'t',label:'tech@test',permissions:['view','manage','groups.manage']};
const scoped={id:'s',label:'scoped@test',permissions:[]};

// ---- When the entry shows ----
const shown=(devices,{multipleCustomers=true,list=customers}={})=>model.customerMoveShown({multipleCustomers,customers:list,devices});
check(shown([device('1','c-a')]),true,'another visible customer: shown');
check(shown([device('1','c-a')],{multipleCustomers:false}),false,'one customer: hidden');
check(shown([device('1','c-a')],{list:[customers[1]]}),false,'only the own customer visible: hidden');
check(shown([device('1','c-a'),device('2','c-b')],{list:customers.slice(0,2)}),false,'every visible customer is a source: hidden');
check(shown([device('1','c-a',{revoked:1})]),false,'a removed device: hidden');
check(model.customerMoveTargets([device('1','c-a'),device('2','c-c')],customers,'de').map(customer=>customer.name),['Kunde B'],'the targets leave out every source customer');
check(model.customerMoveTargets([device('1','x')],customers,'de').map(customer=>customer.name),['Acme','Kunde A','Kunde B'],'sorted by name');

// ---- Why it is blocked ----
const t=(key,params)=>de(key,params);
const blocked=(devices,{viewer=tech,demo=false,saving=false,bulk=false}={})=>model.customerMoveBlocked({devices,viewer,demo,saving,bulk},t);
check(blocked([device('1','c-a')]),undefined,'both permissions: not blocked');
check(blocked([device('1','c-a')],{demo:true}),de('kit.unavailable.demo'),'sample devices');
check(blocked([device('1','c-a')],{saving:true}),de('fleet.menu.saving'),'while saving');
check(blocked([device('1','c-a',{permissions:['view','manage']})]),de('devices.customerMove.noRight'),'without groups.manage');
check(blocked([device('1','c-a'),device('2','c-a',{permissions:['view','groups.manage']})],{bulk:true}),de('devices.customerMove.noRightBulk'),'the selection with a device without manage');
check(blocked([device('1','c-a',{permissions:[]})],{viewer:owner}),undefined,'an Owner holds both everywhere');
check(blocked(Array.from({length:101},(_,index)=>device(String(index),'c-a')),{bulk:true}),de('fleet.bulk.max'),'more than 100 devices');

// ---- The fleet row menu: right after "Move to group…" ----
{
 const action={onSelect:()=>{}},restart={onSelect:()=>{}};
 const entries=fleetRowMenu({move:action,customerMove:{blocked:'reason',onSelect:()=>{}},restart,removal:action,onOpen:()=>{}},key=>en(key));
 const ids=entries.map(entry=>entry.id);
 check(ids.slice(ids.indexOf('move'),ids.indexOf('move')+2),['move','move-customer'],'the row menu entry follows "Move to group…"');
 const entry=entries.find(item=>item.id==='move-customer');
 check([entry.label,entry.blocked],['Move to another customer…','reason'],'its label and blocked reason');
 check(fleetRowMenu({move:action,restart,onOpen:()=>{}},key=>en(key)).some(item=>item.id==='move-customer'),false,'without the entry it is absent');
}
// ---- The selection bar and the row menu use the model ----
{
 const fleet=readFileSync('ui/devices/fleet/fleet.tsx','utf8');
 ok(/\{t\('groups\.assign\.submit'\)\}<\/Btn>\}\n    \{customerMove&&customerMoveShown\(\{\.\.\.customerMove,devices:selected\}\)&&<Btn size="sm" icon=\{Building2\} blocked=\{customerMoveBlocked\(\{devices:selected,viewer,demo,saving,bulk:true\},t\)\}/.test(fleet),'the selection bar: a secondary small Btn right after "Move to group…", shown and blocked by the model');
 ok(fleet.includes('.then(done=>{if(done)setSelection([]);})}>{t(\'devices.customerMove.menu\')}</Btn>'),'a move clears the selection');
 ok(fleet.includes('customerMove:customerMove&&customerMoveShown({...customerMove,devices:[server]})?{blocked:customerMoveBlocked({devices:[server],viewer,demo,saving},t)'),'the row menu: shown and blocked by the model');
}
// ---- The device header menu: in the edit group after the move entry ----
{
 const move=()=>{},moveCustomer={blocked:undefined,onSelect:()=>{}},rename={onSelect:()=>{}};
 check(deviceHeaderMenu({narrow:true,move,moveCustomer,rename},key=>en(key)).map(entry=>entry.id),['move','move-customer','rename'],'narrow: after "Move to group…"');
 check(deviceHeaderMenu({narrow:false,move,moveCustomer,rename},key=>en(key)).map(entry=>entry.id),['move-customer','rename'],'wide: first in the edit group (the move is a header button)');
 check(deviceHeaderMenu({narrow:false,move,rename},key=>en(key)).map(entry=>entry.id),['rename'],'absent without it');
 const source=readFileSync('ui/devices/device/device.tsx','utf8');
 ok(source.includes('const moveCustomer=customerMove&&customerMoveShown({...customerMove,devices:[server]})?{blocked:customerMoveBlocked({devices:[server],viewer,demo,saving},t)'),'the device page: shown and blocked by the model');
}

// ---- The drawer ----
const groups=[
 {id:'gb',name:'B Server',description:'',parentId:null,depth:0,deviceCount:3,permissions:['view','manage','groups.manage'],customerId:'c-b'},
 {id:'gb2',name:'Web',description:'',parentId:'gb',depth:1,deviceCount:1,permissions:['view','manage','groups.manage'],customerId:'c-b'},
 {id:'gb3',name:'B Clients',description:'',parentId:null,depth:0,deviceCount:2,permissions:['view','groups.manage'],customerId:'c-b'},
 {id:'gc',name:'C Server',description:'',parentId:null,depth:0,deviceCount:0,permissions:['view','manage','groups.manage'],customerId:'c-c'},
];
function drawerHarness(locale='de'){
 const sent=[];let answer=async payload=>({ok:true,ids:payload.ids,customerId:payload.customerId,groupId:payload.groupId});
 const MfaStepUp=()=>null;
 const harness=panelHarness({locale,hooked:['ui/devices/fleet/customer-move-drawer.tsx','ui/session/step-up-retry.ts'],stubs:{
  '@/ui/session/mfa-step-up':{MfaStepUp},
  '@/ui/base/api':h=>({...h.load('ui/base/api.tsx'),api:async(url,payload)=>{sent.push({url,payload});return answer(payload);}}),
 }});
 const {CustomerMoveDrawer}=harness.load('ui/devices/fleet/customer-move-drawer.tsx');
 const moved=[],closed=[];
 const props=(devices,viewer=tech)=>({open:true,devices,customers,groups,viewer,onClose:()=>closed.push(true),onMoved:result=>moved.push(result)});
 const view=p=>{const tree=harness.tree(CustomerMoveDrawer,p);return {tree,
  primary:harness.find(tree,node=>node.props?.variant==='primary'),
  select:harness.find(tree,node=>typeof node.props?.onChange==='function'&&node.props.value!==undefined&&!node.props.search),
  options:harness.walk(tree).filter(node=>node.type==='option').map(node=>harness.text(node).trim()),
  rows:harness.walk(tree).filter(node=>typeof node.props?.onSelect==='function'&&'selected' in node.props),
  dialog:harness.find(tree,node=>node.type===MfaStepUp)?.props,
  // The two ends of the "from → to" line (RouteEnd): the name, or the placeholder.
  route:harness.walk(tree).filter(node=>node.type?.name==='RouteEnd').map(node=>node.props.name??node.props.placeholder),
  text:harness.text(tree)};};
 return {harness,view,props,sent,moved,closed,setAnswer:value=>{answer=value;}};
}
{
 const {harness,view,props,sent,moved}=drawerHarness();
 const one=[device('1','c-a')];
 harness.reset();
 let v=view(props(one));
 ok(harness.find(v.tree,node=>node.props?.title===de('devices.customerMove.titleOne',{name:'SRV-1'})&&node.props.description===de('devices.customerMove.description')),'the Drawer with its title and description');
 check(v.options,[de('devices.customerMove.customerPlaceholder'),'Acme','Kunde B'],'an empty first option, then the customers without the source customer, sorted');
 check(v.select.props.value,'','nothing is preselected');
 check(v.rows,[],'no group list before a customer');
 check([harness.text(v.primary).trim(),v.primary.props.blocked],[de('devices.customerMove.submitPlain'),de('devices.customerMove.pickCustomer')],'the primary before a customer');
 ok(v.text.includes(de('devices.customerMove.staysTitle'))||harness.find(v.tree,node=>node.props?.title===de('devices.customerMove.staysTitle')&&node.props.iconTone==='success'),'the card "Stays with the device"');
 const cards=harness.walk(v.tree).filter(node=>node.props?.flush&&node.props.icon);
 check(cards.map(card=>[card.props.title,card.props.iconTone]),[[de('devices.customerMove.staysTitle'),'success'],[de('devices.customerMove.endsTitle'),'warning']],'two flush cards with their icon tiles');
 ok([de('devices.customerMove.staysAgent'),de('devices.customerMove.staysData'),de('devices.customerMove.endsInherited'),de('devices.customerMove.endsDirect'),de('devices.customerMove.endsWork')].every(line=>v.text.includes(line)),'what stays and what ends');
 check(v.route,['Kunde A',de('devices.customerMove.customerPlaceholder')],'the from → to line: the source and the placeholder');
 ok(!v.text.includes(de('devices.customerMove.access',{customer:'Kunde B'})),'no access line before a customer');
 // Customer B: its groups with both permissions in tree order, "Ungrouped" first for the global permissions.
 v.select.props.onChange({target:{value:'c-b'}});
 v=view(props(one));
 check(v.route,['Kunde A','Kunde B'],'the line names the target');
 check(v.rows.map(row=>[row.props.label,row.props.level??0]),[[de('groups.noGroup'),0],['B Server',0],['Web',1]],'"Ungrouped", then the groups of the customer with both permissions');
 check(v.rows[0].props.hint,de('devices.customerMove.ungroupedHint'),'the hint of "Ungrouped"');
 check([harness.text(v.primary).trim(),v.primary.props.blocked],[de('devices.customerMove.submit',{customer:'Kunde B'}),de('devices.customerMove.pickGroup')],'the primary names the customer and waits for a group');
 ok(v.text.includes(de('devices.customerMove.access',{customer:'Kunde B'})),'the access line');
 v.rows.find(row=>row.props.label==='Web').props.onSelect();
 v=view(props(one));
 check(v.primary.props.blocked,undefined,'a group is chosen');
 // The MFA opens first; a cancel sends nothing and keeps the choices.
 await harness.flush();
 v.primary.props.onClick();await harness.settle();
 v=view(props(one));
 check([v.dialog.open,sent.length],[true,0],'the MFA dialog opens before any request');
 v.dialog.onClose();await harness.settle();
 v=view(props(one));
 check([v.dialog.open,sent.length,v.rows.find(row=>row.props.selected)?.props.label,v.select.props.value],[false,0,'Web','c-b'],'cancel: nothing sent, the drawer keeps customer and group');
 // Confirmed: the move payload with the proof, the toast, and onMoved.
 v.primary.props.onClick();await harness.settle();
 v=view(props(one));
 v.dialog.onVerified({managementToken:'proof-1'});await harness.settle();
 check(sent,[{url:'/api/console',payload:{action:'move-customer',ids:['1'],customerId:'c-b',groupId:'gb2',confirm:true,managementToken:'proof-1'}}],'the payload through the step-up send');
 check(harness.toasts,[de('devices.customerMove.doneOne',{name:'SRV-1',customer:'Kunde B'})],'the toast for one device');
 check(moved,[{ok:true,ids:['1'],customerId:'c-b',groupId:'gb2'}],'onMoved after the move');
 v=view(props(one));
 check(v.select.props.value,'','the choices reset after the move');
}
{
 // Several devices of two customers, "Ungrouped", a refused move keeps the drawer, then a success.
 const {harness,view,props,sent,moved,setAnswer}=drawerHarness();
 const two=[device('1','c-a'),device('2','c-c')];
 harness.reset();await harness.flush();
 let v=view(props(two));
 ok(harness.find(v.tree,node=>node.props?.title===de('devices.customerMove.titleMany',{count:2})),'the title for several devices');
 check(v.route[0],'Kunde A, Acme','several sources: the names joined');
 ok(harness.find(v.tree,node=>Array.isArray(node.props?.items)&&node.props.items[0]?.label===de('console.removal.devicesLabel')&&node.props.items[0].value==='SRV-1, SRV-2'),'the Facts line with the device names');
 check(v.options,[de('devices.customerMove.customerPlaceholder'),'Kunde B'],'both source customers left out');
 v.select.props.onChange({target:{value:'c-b'}});v=view(props(two));
 v.rows[0].props.onSelect();v=view(props(two));
 setAnswer(async()=>{const error=new Error('refused');error.code='CONFLICT';error.messageKey='apiError.devices.moveChanged';throw error;});
 v.primary.props.onClick();await harness.settle();v=view(props(two));v.dialog.onVerified({managementToken:'proof-2'});await harness.settle();
 v=view(props(two));
 check([moved.length,harness.toasts.length,harness.toasts[0].startsWith('error:'),v.select.props.value,v.rows[0].props.selected],[0,1,true,'c-b',true],'a refused move: toast.error, the drawer keeps its choices');
 setAnswer(async payload=>({ok:true,ids:payload.ids,customerId:payload.customerId,groupId:payload.groupId}));
 v.primary.props.onClick();await harness.settle();v=view(props(two));v.dialog.onVerified({managementToken:'proof-3'});await harness.settle();
 check(sent.at(-1).payload,{action:'move-customer',ids:['1','2'],customerId:'c-b',groupId:null,confirm:true,managementToken:'proof-3'},'"Ungrouped" sends groupId null');
 check(harness.toasts.at(-1),de('devices.customerMove.doneMany',{count:2,customer:'Kunde B'}),'the toast for several devices');
}
{
 // Without global permissions: no "Ungrouped"; without a group with both permissions: the empty state.
 const {harness,view,props}=drawerHarness();
 harness.reset();
 let v=view(props([device('1','c-a')],scoped));
 v.select.props.onChange({target:{value:'c-b'}});v=view(props([device('1','c-a')],scoped));
 check(v.rows.map(row=>row.props.label),['B Server','Web'],'a group-scoped technician: no "Ungrouped"');
 const restricted={...scoped,permissions:[]},noGroups=groups.map(group=>({...group,permissions:['view']}));
 const {harness:second,view:view2,props:props2}=drawerHarness();
 second.reset();
 let w=view2({...props2([device('1','c-a')],restricted),groups:noGroups});
 w.select.props.onChange({target:{value:'c-b'}});w=view2({...props2([device('1','c-a')],restricted),groups:noGroups});
 const empty=second.find(w.tree,node=>node.props?.empty)?.props.empty;
 check([empty.props.title,second.text(empty).trim()],[de('groups.noneAvailable'),de('devices.customerMove.noGroups')],'the empty state names the permissions');
}
{
 // English once.
 const {harness,view,props}=drawerHarness('en');
 harness.reset();
 const v=view(props([device('1','c-a')]));
 check([harness.text(v.primary).trim(),v.primary.props.blocked],['Move to customer','Choose a target customer first.'],'the English primary');
}
// ---- The console hosts the drawer and refreshes after a move ----
{
 const source=readFileSync('ui/shell/console.tsx','utf8');
 ok(source.includes('<CustomerMoveDrawer open={customerMoveIds.length>0&&!demo}'),'the console hosts the drawer');
 ok(source.includes('if(moved)void refresh(true);'),'a move refreshes the console data');
 ok(/customerMove=\{customerMove\}/.test(source),'the fleet and the device page get the entry');
}
// ---- The copy ----
check([en('devices.customerMove.menu'),de('devices.customerMove.menu'),en('devices.customerMove.titleMany',{count:1}),de('devices.customerMove.doneMany',{count:3,customer:'B'})],['Move to another customer…','Zu anderem Kunden verschieben…','Move 1 device to another customer','3 Geräte nach B verschoben.'],'the labels and the plurals');

console.log(`PASS device customer move view (${checks} checks): the entry in the row menu, selection bar and device menu with its shown and blocked rules, and the drawer with its customers, groups, cards, primary, MFA-first payload, toasts and refusal.`);
