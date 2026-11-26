// The customer view of the console (ui/shell/console.tsx): a customer
// folder opens the fleet view limited to this customer's devices, with its own
// hash route, Back and Forward, the fallback to "Alle Geräte" for a customer
// the viewer cannot see, the folder actions (also leaving a deleted customer's scope), the palette entries and the
// customer crumb of groups and devices. The
// harness (tests/support/console-harness.mjs) inspects the props the console
// gives FleetView, PageHeader, InventoryTree, AccessWorkspace and the palette.
import assert from 'node:assert/strict';
import {de} from '../../support/i18n-stubs.mjs';
import {consoleHarness,nodes} from '../../support/console-harness.mjs';

const {deviceConnection}=await import('../../../ui/base/ui-device.ts');
let checks=0;
const now=Date.now();
const device=(id,name,customerId,groupId=null)=>({id,name,createdAt:now-3600000,lastSeen:now-30000,revoked:0,management:1,snapshot:null,permissions:['view'],groupId,groupName:groupId?'Alpha':null,groups:groupId?[{id:groupId,name:'Alpha',parentId:null,depth:0,direct:true}]:[],customerId});
const servers=[device('a1','ALPHA-01','cA','g-a'),device('b1','BETA-01','cB'),device('a2','ALPHA-02','cA'),device('c1','GAMMA-01','cC')];
const groupA={id:'g-a',name:'Alpha',description:'',parentId:null,depth:0,deviceCount:1,customerId:'cA',permissions:['view','groups.manage']};
const customerA={id:'cA',name:'Kunde A'},customerB={id:'cB',name:'Kunde B'},customerC={id:'cC',name:'Kunde C'};
const owner={id:'owner',label:'owner@example.test',permissions:['*']};
const technician={id:'tech',label:'tech@example.test',permissions:[]};
const grouper={id:'grouper',label:'grouper@example.test',permissions:['groups.manage']};
// Customer folders exist in a portal with several customers.
const base={servers,jobs:[],deviceGroups:[groupA],permissionDevices:[],customers:[customerA,customerB],audit:[],deviceAudit:[],maintenance:null,multipleCustomers:true};
const harness=({viewer=owner,hash='#devices',data}={})=>consoleHarness({viewer,hash,data,base});
const ids=list=>list.map(server=>server.id);
const header=ui=>ui.fleet().props.header;
const crumbs=ui=>header(ui).props.crumbs?.map(crumb=>({label:crumb.label,href:crumb.href}));
const pushes=ui=>ui.history.filter(([type])=>type==='push');
// Everything the console rendered, as text: names and ids of a hidden customer must not appear.
const rendered=ui=>JSON.stringify(nodes(ui.tree).map(node=>node.props),(key,value)=>typeof value==='function'?undefined:value);

// 1. A valid customer: the same FleetView as for groups, limited to the customer.
{
 const ui=harness({hash:'#devices/customer/cA'});await ui.settle();
 const fleet=ui.fleet().props;
 assert.deepEqual(ids(fleet.scoped),['a1','a2'],'only the devices of Kunde A, in input order');
 assert.equal(ui.fleet().key,'customer:cA','a key per customer resets search, filters and selection');
 // Alert rules have a customer level: the customer view edits the rules of the customer (Monitoring › Alert rules).
 for(const prop of ['group','permissions','settings','onAssign','onRemoveFromGroup'])assert.equal(fleet[prop],undefined,prop);
 const customerAlerts=fleet.alerts.props.children.props;
 assert.deepEqual([customerAlerts.scope,customerAlerts.readOnly,customerAlerts.scopeName],[{type:'customer',id:'cA'},undefined,'Kunde A'],'the alert rules of the customer, editable');
 assert.equal(typeof fleet.onProvision,'function','the Owner gets Add device on the customer scope');
 assert.equal(fleet.customerEmpty,false);assert.equal(fleet.groupEmpty,false);assert.equal(fleet.tab,'devices');
 assert.equal(fleet.canMove,true,'the bulk bar keeps moving devices');assert.equal(fleet.canOffboard,true);
 checks+=14;
 const page=header(ui).props,online=fleet.scoped.filter(server=>deviceConnection(server,now).kind==='online').length;
 assert.equal(page.title,'Kunde A');
 assert.deepEqual(crumbs(ui),[{label:'Alle Geräte',href:'#devices'},{label:'Kunde A',href:undefined}]);
 assert.equal(page.subtitle,de('console.fleetSubtitle',{count:2,online}));
 assert.deepEqual([page.primary.type,page.primary.props.variant,page.primary.props.children],['Btn','primary',de('console.addDevice')],'the primary is Add device');
 assert.equal(page.actions.type,'Menu');assert.equal(page.actions.props.label,'Weitere Aktionen');
 assert.deepEqual(page.actions.props.entries.map(entry=>[entry.id,entry.label]),[['create-group','Gruppe für diesen Kunden erstellen'],['manage-customer','Kunde verwalten…'],['customer-access','Technikerzugriff…'],['customer-installers','Installer']]);
 checks+=7;
 const tree=ui.inventory().props;
 assert.equal(tree.selectedCustomerId,'cA');assert.equal(tree.selectedGroupId,undefined,'no group is selected');assert.equal(tree.canManageCustomers,true);
 assert.deepEqual(ui.history,[],'loading the link adds no history entry');assert.equal(ui.location.hash,'#devices/customer/cA');
 checks+=5;
 // The root crumb goes back to all devices with one history entry.
 header(ui).props.crumbs[0].onSelect();ui.render();await ui.settle();
 assert.equal(ui.location.hash,'#devices');assert.deepEqual(ids(ui.fleet().props.scoped),ids(servers));assert.equal(header(ui).props.title,'Alle Geräte');
 assert.deepEqual(ui.history,[['push','#devices']]);assert.equal(ui.inventory().props.selectedCustomerId,undefined);assert.equal(ui.inventory().props.selectedGroupId,'all');
 checks+=6;
 // A customer without devices shows its own empty state.
 const empty=harness({hash:'#devices/customer/cB',data:{servers:servers.filter(server=>server.customerId!=='cB')}});await empty.settle();
 assert.deepEqual(empty.fleet().props.scoped,[]);assert.equal(empty.fleet().props.customerEmpty,true);assert.equal(empty.fleet().props.groupEmpty,false);
 assert.equal(header(empty).props.subtitle,de('console.fleetSubtitle',{count:0,online:0}));checks+=4;
 // Without the right to create groups or manage customers there is no menu.
 const reader=harness({viewer:technician,hash:'#devices/customer/cA'});await reader.settle();
 assert.equal(header(reader).props.title,'Kunde A');assert.equal(header(reader).props.actions,undefined,'no menu without entries');
 assert.equal(reader.inventory().props.canManageCustomers,false);checks+=3;
 assert.equal(header(reader).props.primary,false,'a technician gets no Add device');assert.equal(reader.fleet().props.onProvision,undefined);checks+=2;
 // Add device of the customer header and of its empty state open the add-device page with the customer.
 header(empty).props.primary.props.onClick();empty.render();await empty.settle();
 assert.deepEqual(pushes(empty).at(-1),['push','#devices/add/customer/cB'],'the header Add device');
 const again=harness({hash:'#devices/customer/cB',data:{servers:servers.filter(server=>server.customerId!=='cB')}});await again.settle();
 again.fleet().props.onProvision();again.render();await again.settle();
 assert.deepEqual(pushes(again).at(-1),['push','#devices/add/customer/cB'],'the empty-state Add device');checks+=2;
}
// The empty customer scope rendered: Empty "This customer has no devices yet" with the one action Add device for the
// Owner, and no action for a technician (React SSR of FleetView).
{
 const React=(await import('react')).default,{renderToStaticMarkup}=await import('react-dom/server');
 const {default:FleetView}=await import('../../../ui/devices/fleet/fleet.tsx'),{LocaleProvider}=await import('../../../ui/base/locale.tsx');
 const noop=()=>{},h=React.createElement;
 const props={header:null,servers,scoped:[],groupEmpty:false,customerEmpty:true,viewer:owner,demo:false,saving:false,now,jobs:[],audit:[],tab:'devices',onTab:noop,canOffboard:false,onOpen:noop,onConfirm:noop,onSelectJob:noop,onCancelJob:noop,onUpdated:noop,onDemo:noop,canMove:false,onMove:noop,customerColumn:true,scope:{type:'customer',id:'cB'}};
 const render=extra=>renderToStaticMarkup(h(LocaleProvider,{locale:'en'},h(FleetView,{...props,...extra})));
 const emptyOf=html=>html.match(/<div class="sdx-empty">(.*?)<\/div><\/td>/s)?.[1]??'';
 const forOwner=emptyOf(render({onProvision:noop})),forTech=emptyOf(render({viewer:technician}));
 assert.ok(forOwner.includes('This customer has no devices yet')&&forOwner.includes('Add a device for this customer to see it here.'),'the title and the new hint');
 assert.equal((forOwner.match(/<button/g)??[]).length,1,'exactly one action');
 assert.match(forOwner,/class="sdx-btn sdx-btn-secondary"[^>]*>.*<span>Add device<\/span>/s,'the Owner: Add device (secondary: the header "Add device" is the one primary)');
 assert.ok(forTech.includes('This customer has no devices yet')&&!forTech.includes('<button'),'a technician: no action');checks+=4;
 // An empty group: one action, Add device for the Owner, else Move devices here… for a group manager, else none.
 const groupProps={customerEmpty:false,groupEmpty:true,customerColumn:false,scope:{type:'group',id:'g-a'}};
 const ownerGroup=emptyOf(render({...groupProps,onProvision:noop,onAssign:noop})),managerGroup=emptyOf(render({...groupProps,viewer:technician,onAssign:noop})),otherGroup=emptyOf(render({...groupProps,viewer:technician}));
 assert.ok(ownerGroup.includes('Add a device to this group, or move devices here from another group.'),'the empty group hint');
 assert.deepEqual([ownerGroup,managerGroup,otherGroup].map(html=>[(html.match(/<button/g)??[]).length,html.match(/<span>(Add device|Move devices here…)<\/span>/)?.[1]??null]),[[1,'Add device'],[1,'Move devices here…'],[0,null]],'empty group: Add device for the Owner, Move devices here… for a manager, no action for others');
 assert.ok([ownerGroup,managerGroup].every(html=>html.includes('sdx-btn-secondary')&&!html.includes('sdx-btn-primary')),'the empty-group action is secondary, like the header button');checks+=3;
}
console.log('PASS: customer view: scoped devices, header with Add device, crumbs, menu, tree selection and the empty state with its action.');

// 2. Opening from the tree adds one history entry; Back and Forward restore the views.
{
 const ui=harness({hash:'#devices/group/g-a'});await ui.settle();
 assert.equal(ui.fleet().props.group,groupA);assert.deepEqual(ui.history,[]);
 ui.inventory().props.onCustomer('cB');ui.render();await ui.settle();
 assert.deepEqual(ui.history,[['push','#devices/customer/cB']],'exactly one pushState');
 assert.deepEqual(ids(ui.fleet().props.scoped),['b1']);assert.equal(ui.fleet().props.group,undefined);assert.equal(ui.inventory().props.selectedCustomerId,'cB');
 checks+=6;
 await ui.navigateTo('#devices/group/g-a');
 assert.equal(ui.fleet().props.group,groupA,'Back restores the group');assert.equal(ui.inventory().props.selectedCustomerId,undefined);assert.equal(ui.inventory().props.selectedGroupId,'g-a');
 await ui.navigateTo('#devices/customer/cB');
 assert.equal(ui.inventory().props.selectedCustomerId,'cB','Forward restores the customer');assert.deepEqual(ids(ui.fleet().props.scoped),['b1']);
 assert.equal(ui.history.length,1,'Back and Forward add no entries');
 checks+=6;
 // Every other navigation clears the customer.
 ui.inventory().props.onDevice('b1');ui.render();await ui.settle();
 assert.equal(ui.location.hash,'#device/b1');assert.equal(ui.inventory().props.selectedCustomerId,undefined);
 ui.inventory().props.onAll();ui.render();await ui.settle();
 assert.equal(ui.location.hash,'#devices');assert.equal(header(ui).props.title,'Alle Geräte');
 ui.inventory().props.onCustomer('cA');ui.render();await ui.settle();ui.inventory().props.onGroup('g-a');ui.render();await ui.settle();
 assert.equal(ui.location.hash,'#devices/group/g-a');assert.equal(ui.inventory().props.selectedCustomerId,undefined);
 checks+=6;
}
console.log('PASS: history: one pushState per open, Back and Forward restore group and customer, other navigation clears the customer.');

// 3. Fallback to "Alle Geräte": replaceState only, no customer name or device of a hidden customer.
const assertFallback=(ui,message,shown=servers)=>{
 assert.equal(ui.location.hash,'#devices',message);
 assert.deepEqual(pushes(ui),[],message+': no pushState');
 assert.deepEqual(ui.history.at(-1),['replace','#devices'],message+': replaceState');
 assert.deepEqual(ids(ui.fleet().props.scoped),ids(shown),message+': all devices');
 assert.equal(header(ui).props.title,'Alle Geräte');assert.equal(ui.inventory().props.selectedCustomerId,undefined);
 checks+=6;
};
{
 const unknown=harness({hash:'#devices/customer/cX'});await unknown.settle();assertFallback(unknown,'an unknown id');
 assert.doesNotMatch(rendered(unknown),/cX/);checks++;
 // A technician without Kunde B: data is boundary-filtered, the link to B lands on all devices.
 const visible=servers.filter(server=>server.customerId!=='cB');
 const tech=harness({viewer:technician,hash:'#devices/customer/cB',data:{customers:[customerA,customerC],servers:visible}});await tech.settle();
 assertFallback(tech,'a customer outside the boundary',visible);
 assert.doesNotMatch(rendered(tech),/Kunde B|BETA-01|"b1"|"cB"/,'no name, device or id of Kunde B');checks++;
 const single=harness({hash:'#devices/customer/cA',data:{customers:[customerA]}});await single.settle();assertFallback(single,'a single customer');
 const none=harness({hash:'#devices/customer/cA',data:{customers:undefined}});await none.settle();assertFallback(none,'no customer list');
 // Demo mode: a customer link falls back on hashchange too.
 const demo=harness();await demo.settle();demo.fleet().props.onDemo();demo.render();await demo.settle();
 const before=demo.history.length;
 await demo.navigateTo('#devices/customer/cA','hashchange');
 assert.equal(demo.location.hash,'#devices','demo mode');assert.deepEqual(demo.history.slice(before),[['replace','#devices']]);assert.equal(demo.inventory().props.selectedCustomerId,undefined);
 assert.equal(demo.inventory().props.customers,undefined);checks+=4;
}
{
 // No fallback before data loads, and no customer devices or names meanwhile.
 const ui=harness({hash:'#devices/customer/cX'});ui.state.data=null;ui.render();await ui.settle();
 assert.equal(ui.location.hash,'#devices/customer/cX','the link waits for the data');assert.deepEqual(ui.history,[]);
 assert.equal(ui.fleet(),undefined,'the loading state, no fleet');assert.doesNotMatch(rendered(ui),/Kunde|ALPHA|BETA/);
 ui.state.data={viewer:owner,...base};ui.render();await ui.settle();
 assertFallback(ui,'once loaded');checks+=4;
}
{
 // A refresh that removes the open customer, or leaves fewer than two, falls back.
 const removed=harness({hash:'#devices/customer/cA'});await removed.settle();
 assert.equal(removed.inventory().props.selectedCustomerId,'cA');
 removed.setData({customers:[customerB,customerC],servers:servers.filter(server=>server.customerId!=='cA')});await removed.settle();
 assertFallback(removed,'the customer is gone',servers.filter(server=>server.customerId!=='cA'));
 const fewer=harness({hash:'#devices/customer/cA'});await fewer.settle();
 fewer.setData({customers:[customerA]});await fewer.settle();assertFallback(fewer,'fewer than two customers');checks++;
}
console.log('PASS: fallback: unknown, hidden, single, demo and removed customers land on all devices through replaceState, not before data loads.');

// 4. Tabs: History stays in the route, permissions does not.
{
 const jobs=harness({hash:'#devices/customer/cA/history'});await jobs.settle();
 assert.equal(jobs.fleet().props.tab,'jobs');assert.deepEqual(ids(jobs.fleet().props.scoped),['a1','a2'],'History gets the scoped devices');
 jobs.fleet().props.onTab('access');jobs.render();await jobs.settle();assert.equal(jobs.location.hash,'#devices/customer/cA/history/access');
 const permissions=harness({hash:'#devices/customer/cA/configuration/permissions'});await permissions.settle();
 assert.equal(permissions.fleet().props.tab,'devices');assert.equal(permissions.fleet().props.permissions,undefined);assert.equal(permissions.location.hash,'#devices/customer/cA');
 checks+=6;
}
console.log('PASS: tabs: the history tab is routed, permissions and settings are not part of the customer view.');

// 5. Folder actions.
{
 const ui=harness({hash:'#devices/customer/cA'});await ui.settle();
 const host=current=>current.find('CustomerDrawerHost');
 assert.equal(host(ui).props.request,null,'no drawer is requested at first');assert.equal(host(ui).props.closeKey,'#devices/customer/cA','the route closes an open drawer');
 ui.inventory().props.onAction('manage-customer',{type:'customer',id:'cA',name:'Falscher Name'});ui.render();await ui.settle();
 // The drawer opens over Devices: the hash, the history, the view, the tree selection and the scope stay.
 assert.deepEqual(host(ui).props.request,{customerId:'cA',customerName:'Kunde A',drawer:'manage'},'the host gets the customer id and the console name, not the name the tree passed');
 assert.deepEqual([ui.location.hash,ui.history,ui.find('AccessWorkspace'),ui.inventory().props.selectedCustomerId,ui.fleet().key],['#devices/customer/cA',[],undefined,'cA','customer:cA']);
 host(ui).props.onDone();ui.render();assert.equal(host(ui).props.request,null,'the host clears the request once it handled it');
 host(ui).props.onSaved();await ui.settle();assert.deepEqual(ui.refreshes.at(-1),[true],'a save reloads the console data, so the tree and the header show the new name');
 checks+=8;
 // A delete from the manage drawer: the host reloads the console data (onSaved), then onDeleted leaves the deleted
 // customer's scope for All devices; a delete of another customer keeps the route.
 host(ui).props.onDeleted('cB');ui.render();await ui.settle();
 assert.equal(ui.location.hash,'#devices/customer/cA','the delete of another customer keeps the route');
 host(ui).props.onDeleted('cA');ui.render();await ui.settle();
 assert.deepEqual([ui.location.hash,ui.history.at(-1)],['#devices',['push','#devices']],'the scope of the deleted customer goes to All devices');
 const ungrouped=harness({hash:'#devices/customer/cA/ungrouped'});await ungrouped.settle();
 ungrouped.find('CustomerDrawerHost').props.onDeleted('cA');ungrouped.render();await ungrouped.settle();
 assert.equal(ungrouped.location.hash,'#devices','its Ungrouped scope too');
 checks+=3;
 const other=harness();await other.settle();
 other.inventory().props.onAction('customer-access',{type:'customer',id:'cB',name:'Kunde B'});other.render();await other.settle();
 assert.deepEqual(other.find('CustomerDrawerHost').props.request,{customerId:'cB',customerName:'Kunde B',drawer:'access'},'customer-access');
 assert.deepEqual([other.location.hash,other.history],['#devices',[]]);checks+=2;
 // A route change hands the host a new closeKey: an open drawer closes through its dirty guard.
 await other.navigateTo('#devices/customer/cA');assert.equal(other.find('CustomerDrawerHost').props.closeKey,'#devices/customer/cA');checks++;
 // The header menu of the customer scope opens the same drawers.
 const scope=harness({hash:'#devices/customer/cB'});await scope.settle();
 header(scope).props.actions.props.entries.find(item=>item.id==='customer-access').onSelect();scope.render();await scope.settle();
 assert.deepEqual([scope.find('CustomerDrawerHost').props.request,scope.location.hash,scope.history],[{customerId:'cB',customerName:'Kunde B',drawer:'access'},'#devices/customer/cB',[]],'More actions › Technician access…');
 header(scope).props.actions.props.entries.find(item=>item.id==='manage-customer').onSelect();scope.render();await scope.settle();
 assert.deepEqual(scope.find('CustomerDrawerHost').props.request,{customerId:'cB',customerName:'Kunde B',drawer:'manage'},'More actions › Manage customer…');checks+=2;
 // "Installers" opens the tab Several devices of Add device with the customer, with a history entry; Devices and the tree stay.
 const installers=harness();await installers.settle();
 installers.inventory().props.onAction('customer-installers',{type:'customer',id:'cB',name:'Kunde B'});installers.render();await installers.settle();
 assert.deepEqual([installers.location.hash,installers.history.at(-1),installers.find('AccessWorkspace'),installers.find('Rail').props.area,!!installers.inventory()],['#devices/add/installer/customer/cB',['push','#devices/add/installer/customer/cB'],undefined,'devices',true],'customer-installers');
 assert.deepEqual([installers.find('AddDevicePage').props.installer,installers.find('AddDevicePage').props.routeCustomerId],[true,'cB'],'the page shows Several devices for the customer');checks+=2;
 // The header menu runs the same actions.
 const menu=harness({hash:'#devices/customer/cB'});await menu.settle();
 const entry=header(menu).props.actions.props.entries.find(item=>item.id==='customer-installers');
 assert.equal(entry.label,'Installer','the menu keeps the entry "Installers"');
 entry.onSelect();menu.render();await menu.settle();
 assert.deepEqual([menu.location.hash,menu.history.at(-1)],['#devices/add/installer/customer/cB',['push','#devices/add/installer/customer/cB']]);checks+=2;
 // Create group: a root group with the customer preset.
 const create=harness();await create.settle();
 create.inventory().props.onAction('create-group',{type:'customer',id:'cB',name:'Kunde B'});create.render();
 const drawer=create.find('GroupCreateDrawer').props;
 assert.equal(drawer.open,true);assert.equal(drawer.parent,null);assert.equal(drawer.customerId,'cB');assert.deepEqual(drawer.customers,[customerA,customerB]);
 drawer.onClose();create.render();assert.equal(create.find('GroupCreateDrawer').props.open,false);
 create.inventory().props.onAction('create-group',{type:'global',name:'Alle Geräte'});create.render();
 assert.equal(create.find('GroupCreateDrawer').props.customerId,undefined,'a plain root group has no preset');
 checks+=6;
 // Refusals: no right, demo mode, unknown customer.
 for(const viewer of [technician,grouper]){
  const denied=harness({viewer});await denied.settle();
  for(const action of ['manage-customer','customer-access','customer-installers'])denied.inventory().props.onAction(action,{type:'customer',id:'cA',name:'Kunde A'});
  denied.render();await denied.settle();
  assert.equal(denied.location.hash,'#devices',viewer.id+' stays');assert.equal(denied.find('CustomerDrawerHost').props.request,null,viewer.id+' opens no drawer');checks+=2;
 }
 const noRoot=harness({viewer:technician});await noRoot.settle();
 noRoot.inventory().props.onAction('create-group',{type:'customer',id:'cA',name:'Kunde A'});noRoot.render();
 assert.equal(noRoot.find('GroupCreateDrawer').props.open,false,'creating a root group needs the root group right');
 const rooted=harness({viewer:grouper});await rooted.settle();
 rooted.inventory().props.onAction('create-group',{type:'customer',id:'cA',name:'Kunde A'});rooted.render();
 assert.equal(rooted.find('GroupCreateDrawer').props.customerId,'cA','the root group right is enough to create');checks+=2;
 const unknown=harness();await unknown.settle();
 unknown.inventory().props.onAction('manage-customer',{type:'customer',id:'cX',name:'Weg'});unknown.inventory().props.onAction('create-group',{type:'customer',id:'cX',name:'Weg'});unknown.render();await unknown.settle();
 assert.equal(unknown.location.hash,'#devices');assert.equal(unknown.find('GroupCreateDrawer').props.open,false);assert.equal(unknown.find('CustomerDrawerHost').props.request,null,'a customer outside the console data opens nothing');checks+=3;
 const demo=harness();await demo.settle();
 const stale=demo.inventory().props.onAction;
 demo.fleet().props.onDemo();demo.render();await demo.settle();
 assert.equal(demo.inventory().props.onAction,undefined);
 stale('manage-customer',{type:'customer',id:'cA',name:'Kunde A'});stale('create-group',{type:'customer',id:'cA',name:'Kunde A'});demo.render();await demo.settle();
 assert.equal(demo.location.hash,'#devices','demo mode');assert.equal(demo.find('GroupCreateDrawer').props.open,false);assert.equal(demo.find('CustomerDrawerHost').props.request,null,'demo mode opens no customer drawer');checks+=4;
 assert.deepEqual([...ui.posts,...create.posts,...demo.posts],[],'nothing is sent');checks++;
}
console.log('PASS: folder actions: Owners open the customer drawers over Devices, the root group right creates a preset root group, refusals do nothing.');

// 6. Palette.
{
 const items=ui=>ui.find('CommandPalette').props.getItems().filter(item=>item.group==='Kunden');
 const ui=harness();await ui.settle();
 const found=items(ui);
 assert.deepEqual(found.map(item=>[item.id,item.label,item.hint,item.Icon]),[['customer-cA','Kunde A','Kunde','Building2'],['customer-cB','Kunde B','Kunde','Building2']]);
 found[1].run();ui.render();await ui.settle();
 assert.equal(ui.location.hash,'#devices/customer/cB');assert.deepEqual(pushes(ui),[['push','#devices/customer/cB']]);
 checks+=3;
 const single=harness({data:{customers:[customerA]}});await single.settle();assert.deepEqual(items(single),[],'one customer: no entries');
 const demo=harness();await demo.settle();demo.fleet().props.onDemo();demo.render();await demo.settle();assert.deepEqual(items(demo),[],'demo mode: no entries');
 checks+=2;
}
console.log('PASS: palette: each visible customer from two on, opening the customer view.');
// 7. The customer crumb (L3): groups and devices name their customer while the tree shows it as a folder.
{
 const sub={id:'g-a1',name:'Alpha Sub',description:'',parentId:'g-a',depth:1,deviceCount:1,permissions:['view']};
 const loose=device('x1','X-01',undefined,'g-a1');
 const data={servers:[...servers,loose],deviceGroups:[groupA,sub]};
 const crumbsOf=list=>list.map(crumb=>[crumb.label,crumb.href]);
 const all=[de('nav.allDevices'),'#devices'],kundeA=['Kunde A','#devices/customer/cA'];
 const group=harness({hash:'#devices/group/g-a1',data});await group.settle();
 assert.deepEqual(crumbsOf(header(group).props.crumbs),[all,kundeA,['Alpha','#devices/group/g-a'],['Alpha Sub','#devices/group/g-a1']],'group: All devices › customer of the root group › group path (Breadcrumbs renders the last one as text)');
 header(group).props.crumbs[1].onSelect();group.render();await group.settle();
 assert.deepEqual([group.location.hash,ids(group.fleet().props.scoped)],['#devices/customer/cA',['a1','a2']],'the customer crumb opens the customer scope');
 const inGroup=harness({hash:'#device/a1',data});await inGroup.settle();
 assert.deepEqual(crumbsOf(inGroup.device().props.crumbs),[all,kundeA,['Alpha','#devices/group/g-a'],['ALPHA-01',undefined]],'device in a group: All devices › customer › group path › device');
 const noGroup=harness({hash:'#device/a2',data});await noGroup.settle();
 assert.deepEqual(crumbsOf(noGroup.device().props.crumbs),[all,kundeA,['ALPHA-02',undefined]],'device without a group: All devices › customer › device');
 const inherited=harness({hash:'#device/x1',data});await inherited.settle();
 assert.deepEqual(crumbsOf(inherited.device().props.crumbs),[all,kundeA,['Alpha','#devices/group/g-a'],['Alpha Sub','#devices/group/g-a1'],['X-01',undefined]],'a device without its own customer uses the root group customer');
 const hidden=harness({hash:'#device/c1',data});await hidden.settle();
 assert.deepEqual(crumbsOf(hidden.device().props.crumbs),[all,['GAMMA-01',undefined]],'a customer that is no folder gets no crumb');
 checks+=6;
 const single={...data,customers:[customerA]};
 const oneGroup=harness({hash:'#devices/group/g-a1',data:single});await oneGroup.settle();
 assert.deepEqual(crumbsOf(header(oneGroup).props.crumbs),[all,['Alpha','#devices/group/g-a'],['Alpha Sub','#devices/group/g-a1']],'one customer: group crumbs as before');
 const oneDevice=harness({hash:'#device/a1',data:single});await oneDevice.settle();
 assert.deepEqual(crumbsOf(oneDevice.device().props.crumbs),[all,['Alpha','#devices/group/g-a'],['ALPHA-01',undefined]],'one customer: device crumbs as before');
 checks+=2;
}
console.log('PASS: customer crumb: group and device crumbs name the customer folder, and not without folders.');
console.log(`${checks} customer view checks passed.`);
