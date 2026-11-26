// The routes in the running console (ui/shell/console.tsx with the harness of tests/support/console-harness.mjs):
// old and non-canonical hashes are replaced in place on the first read, on hashchange and on popstate; the scope tabs and
// subtabs write their hash with a history entry and a reload restores them; the Configuration subtabs (Permissions, General,
// Notification rules) have routes with their fallback; the Ungrouped scopes with their empty state and palette entries;
// "Add device" and "Move devices here…" per scope and viewer; Add device in the Devices area beside the device tree; the
// agent pages as settings pages; Customers for every Owner; the rail, the navigator, the crumbs and the
// crumb button, the G shortcuts, the palette pages and the help route come from the navigation model.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {de} from '../../support/i18n-stubs.mjs';
import {consoleHarness} from '../../support/console-harness.mjs';
const navModel=await import('../../../ui/shell/nav-model.ts');
const {consoleRouteHash}=await import('../../../lib/console-route.ts');

let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const now=Date.now();
const device=(id,name,customerId,groupId=null)=>({id,name,createdAt:now-3600000,lastSeen:now-30000,revoked:0,management:1,snapshot:null,permissions:['view'],groupId,groupName:groupId?'Alpha':null,groups:groupId?[{id:groupId,name:'Alpha',parentId:null,depth:0,direct:true}]:[],customerId});
const servers=[device('a1','ALPHA-01','cA','g-a'),device('a2','ALPHA-02','cA'),device('b1','BETA-01','cB'),device('b2','BETA-02','cB','g-b')];
const group=(id,permissions)=>({id,name:id==='g-a'?'Alpha':'Beta',description:'',parentId:null,depth:0,deviceCount:1,customerId:id==='g-a'?'cA':'cB',permissions});
const owner={id:'owner',label:'owner@example.test',permissions:['*']};
const reader={id:'reader',label:'reader@example.test',permissions:[]};
// Manages the groups whose permissions name groups.manage (Alpha), without the root group right.
const grouper={id:'grouper',label:'grouper@example.test',permissions:[],canManageDeviceGroups:true};
const base={servers,jobs:[],deviceGroups:[group('g-a',['view','groups.manage']),group('g-b',['view'])],permissionDevices:[],customers:[{id:'cA',name:'Kunde A'},{id:'cB',name:'Kunde B'}],audit:[],deviceAudit:[],maintenance:null};
const harness=async(hash,{viewer=owner,data}={})=>{const ui=consoleHarness({viewer,hash,data,base});await ui.settle();return ui;};
const pushes=ui=>ui.history.filter(([type])=>type==='push');
const ids=list=>list.map(server=>server.id);

// 1. An old or non-canonical hash is replaced with replaceState, on the first read, on hashchange and on popstate.
for(const [old,expected] of [['#devices/problems','#devices/monitoring'],['#devices/alarms','#devices/monitoring'],['#devices/configuration','#devices/monitoring/alert-rules'],['#device/b1/history/alarms','#device/b1/monitoring'],['#device/b1/configuration','#device/b1/monitoring/alert-rules'],['#devices/b1/terminal','#device/b1/remote/terminal'],['#agents/releases','#settings/agent-releases'],['#administration/maintenance','#settings/retention'],['#devices/group/unassigned/jobs','#devices/ungrouped/history'],['#automation','#automation/runbooks'],['#agents/troubleshooting','#settings/agent-troubleshooting']]){
 const ui=await harness(old);
 check([ui.location.hash,pushes(ui)],[expected,[]],old+': replaced in place, no history entry');
 check(ui.history.filter(([type])=>type==='replace').map(([,hash])=>hash),[expected],old+': exactly one replaceState');
}
{
 const ui=await harness('#devices');
 for(const type of ['hashchange','popstate']){
  const before=ui.history.length;
  await ui.navigateTo('#devices/a1/management/drivers',type);
  check([ui.location.hash,ui.history.slice(before)],['#device/a1/software/drivers',[['replace','#device/a1/software/drivers']]],type+': an old device link is replaced');
  check([ui.device().props.section,ui.device().props.detail],['software',{deviceDetail:'drivers'}],type+': Drivers inside Software');
  await ui.navigateTo('#devices',type);
 }
 const before=ui.history.length;await ui.navigateTo('#devices/history/access');
 check(ui.history.slice(before),[],'a canonical hash is not written again');
}

// 2. Scope Permissions and group General have routes; without the right the scope's Devices tab, after the data loaded.
{
 let ui=await harness('#devices/group/g-a/configuration/general');
 check([ui.fleet().props.tab,ui.location.hash,ui.history],['settings','#devices/group/g-a/configuration/general',[]],'reload of the group General tab');
 ok(ui.fleet().props.settings,'the General content renders');
 ui=await harness('#devices/configuration/permissions');
 check([ui.fleet().props.tab,ui.location.hash],['permissions','#devices/configuration/permissions'],'reload of the All devices Permissions tab');
 ui=await harness('#devices/group/g-a/configuration/permissions');
 check([ui.fleet().props.tab,ui.location.hash],['permissions','#devices/group/g-a/configuration/permissions'],'reload of a group Permissions tab');
 // Without the right: the Devices tab and the scope hash, replaced without a history entry.
 ui=await harness('#devices/group/g-b/configuration/general',{viewer:grouper});
 check([ui.fleet().props.tab,ui.location.hash,pushes(ui),ui.history.at(-1)],['devices','#devices/group/g-b',[],['replace','#devices/group/g-b']],'General without canManageGroup');
 ui=await harness('#devices/configuration/permissions',{viewer:reader});
 check([ui.fleet().props.tab,ui.location.hash,pushes(ui)],['devices','#devices',[]],'Permissions without portal.roleAssignments.manage');
 // The check waits for the data.
 ui=consoleHarness({viewer:owner,hash:'#devices/group/g-a/configuration/general',base});ui.state.data=null;ui.render();await ui.settle();
 check([ui.location.hash,ui.history],['#devices/group/g-a/configuration/general',[]],'no fallback before the data loaded');
 // The tree menu entries open the routes.
 ui=await harness('#devices');
 ui.inventory().props.onAction('rename-group',{type:'group',id:'g-a',name:'Alpha'});ui.render();await ui.settle();
 check(pushes(ui).at(-1),['push','#devices/group/g-a/configuration/general'],'Rename opens the General route');
 ui.inventory().props.onAction('permissions',{type:'group',id:'g-a',name:'Alpha'});ui.render();await ui.settle();
 check(pushes(ui).at(-1),['push','#devices/group/g-a/configuration/permissions'],'Permissions opens the Permissions route');
 ui.fleet().props.onTab('tags');ui.render();await ui.settle();
 check(ui.location.hash,'#devices/group/g-a/configuration/tags','selecting a tab writes its hash');
 // Rename puts the focus into the name field of General once.
 ui.inventory().props.onAction('rename-group',{type:'group',id:'g-a',name:'Alpha'});ui.render();await ui.settle();
 const settings=ui.fleet().props.settings;
 ok(settings.props.focusName>0,'Rename asks General to focus the name field');
 settings.props.onNameFocused();ui.render();await ui.settle();
 check(ui.fleet().props.settings.props.focusName,undefined,'once: the request is cleared after the focus');
 // A Monitoring subtab whose content is missing: Notification rules of a customer while only one customer exists.
 ui=await harness('#devices/customer/cA/monitoring/notification-rules');
 check([ui.fleet().props.tab,ui.fleet().props.notifications,ui.location.hash,pushes(ui),ui.history.at(-1)],['devices',undefined,'#devices/customer/cA',[],['replace','#devices/customer/cA']],'Notification rules on a customer with one customer: the Devices tab, replaced');
 ui=await harness('#devices/customer/cA/monitoring/notification-rules',{data:{multipleCustomers:true}});
 check([ui.fleet().props.tab,!!ui.fleet().props.notifications,ui.location.hash,ui.history],['notifications',true,'#devices/customer/cA/monitoring/notification-rules',[]],'with several customers the route opens Notification rules');
 // The old bare Configuration link of a customer opens the same subtab, written in place.
 ui=await harness('#devices/customer/cA/configuration',{data:{multipleCustomers:true}});
 check([ui.fleet().props.tab,ui.location.hash,ui.history],['notifications','#devices/customer/cA/monitoring/notification-rules',[['replace','#devices/customer/cA/monitoring/notification-rules']]],'the old customer Configuration link opens Monitoring › Notification rules');
 // A customer's Alert rules are its own level; its summary reads them and its notification rules.
 ui=await harness('#devices/customer/cA/monitoring/alert-rules',{data:{multipleCustomers:true}});
 const customerAlerts=ui.fleet().props.alerts.props.children;
 check([ui.fleet().props.tab,customerAlerts.props.scope,'readOnly' in customerAlerts.props,customerAlerts.props.scopeName,customerAlerts.props.customerView],['alerts',{type:'customer',id:'cA'},false,'Kunde A',true],'Customer › Monitoring › Alert rules: the editable rules of the customer');
 const customerSummary=ui.fleet().props.monitoringSummary;
 check([customerSummary.props.alertScope,customerSummary.props.notificationScope],[{type:'customer',id:'cA'},{type:'customer',id:'cA'}],'the customer summary: the customer alert rules and notification rules');
 customerSummary.props.onOpenNotificationRules();ui.render();await ui.settle();
 check([ui.fleet().props.tab,ui.location.hash],['notifications','#devices/customer/cA/monitoring/notification-rules'],'the notification tile opens Notification rules');
 customerAlerts.props.onOpenOrigin({type:'global'});ui.render();await ui.settle();
 check([ui.fleet().props.scope,ui.fleet().props.tab,ui.location.hash],[{type:'all'},'alerts','#devices/monitoring/alert-rules'],'Open origin opens All devices › Monitoring › Alert rules');
 // The summary of All devices: its alert and notification rules; Ungrouped has none.
 ui=await harness('#devices/monitoring');
 check([ui.fleet().props.tab,ui.fleet().props.monitoringSummary.props.alertScope,ui.fleet().props.monitoringSummary.props.notificationScope],['problems',{type:'global',id:'*'},{type:'all',id:'*'}],'All devices › Monitoring: the summary of its rules');
 ui.fleet().props.monitoringSummary.props.onOpenAlertRules();ui.render();await ui.settle();
 check(ui.location.hash,'#devices/monitoring/alert-rules','the alert tile opens Alert rules');
 const notifications=ui.fleet().props.notifications.props.children;
 notifications.props.onOpenLog();ui.render();await ui.settle();
 check(ui.location.hash,'#settings/notification-channels/log','Open delivery log opens the Delivery log');
 ui=await harness('#devices/group/g-a/monitoring');
 check(ui.fleet().props.monitoringSummary.props.alertScope,{type:'group',id:'g-a'},'a group summary reads the group rules');
 ui=await harness('#devices/ungrouped/monitoring');
 check([ui.fleet().props.tab,ui.fleet().props.monitoringSummary],['problems',undefined],'Ungrouped: By device without a summary');
 ui=await harness('#devices/group/g-a/configuration/tags',{data:{deviceGroups:[]}});
 check([ui.fleet().props.tab,ui.location.hash],['devices','#devices/group/g-a'],'a group that is not there: Tags fall back to the Devices tab');
}

// 2b. Tabs and subtabs: choosing one writes its hash with a history entry; reload, Back and Forward restore it.
{
 const ui=await harness('#devices');
 for(const [tab,hash] of [['problems','#devices/monitoring'],['alarms','#devices/monitoring/list'],['software','#devices/inventory'],['protection','#devices/inventory/defender'],['jobs','#devices/history'],['access','#devices/history/access'],['alerts','#devices/monitoring/alert-rules'],['notifications','#devices/monitoring/notification-rules'],['permissions','#devices/configuration/permissions'],['devices','#devices']]){
  const before=ui.history.length;
  ui.fleet().props.onTab(tab);ui.render();await ui.settle();
  check([ui.location.hash,ui.history.slice(before)],[hash,[['push',hash]]],`${tab}: pushes ${hash}`);
 }
 await ui.navigateTo('#devices/inventory/extensions','popstate');
 check(ui.fleet().props.tab,'extensions','Back or Forward restores the subtab');
 for(const [hash,tab] of [['#devices/monitoring/list','alarms'],['#devices/group/g-a/inventory/certificates','certificates'],['#devices/customer/cB/history/access','access'],['#devices/ungrouped/monitoring','problems']]){
  const reload=await harness(hash);
  check([reload.fleet().props.tab,reload.location.hash,reload.history],[tab,hash,[]],`reload of ${hash}`);
 }
}
function ok(value,label){assert.ok(value,label);checks++;}

// 3. The Ungrouped scope of a customer: the loose devices of the customer, the Ungrouped tab set, title and crumbs.
{
 const ui=await harness('#devices/customer/cA/ungrouped/inventory/drivers');
 const fleet=ui.fleet(),header=fleet.props.header;
 check([ids(fleet.props.scoped),fleet.props.scope,fleet.props.tab],[['a2'],{type:'unassigned',customerId:'cA'},'drivers'],'the devices of Kunde A without a group');
 check([header.props.title,header.props.crumbs.map(crumb=>[crumb.label,crumb.href])],[de('console.ungrouped'),[[de('nav.allDevices'),'#devices'],['Kunde A','#devices/customer/cA'],[de('console.ungrouped'),undefined]]],'title and crumbs');
 check([header.props.actions,header.props.primary.type,header.props.primary.props.children,fleet.props.customerEmpty,fleet.props.ungroupedEmpty],[undefined,'Btn',de('console.addDevice'),false,false],'no customer menu; the primary is Add device');
 check([fleet.props.alerts,fleet.props.notifications,fleet.props.tags,fleet.props.permissions,fleet.props.settings,fleet.props.monitoringSummary],[undefined,undefined,undefined,undefined,undefined,undefined],'no rules, no configuration, no summary');
 check(ui.history,[],'the link stays');
 header.props.crumbs[1].onSelect();ui.render();await ui.settle();
 check([ui.location.hash,ids(ui.fleet().props.scoped)],['#devices/customer/cA/inventory/drivers',['a1','a2']],'the customer crumb opens the customer on the same tab, as the group crumbs do');
 // Not available: the same rule as the customer view.
 const single=await harness('#devices/customer/cA/ungrouped',{data:{customers:[{id:'cA',name:'Kunde A'}]}});
 check([single.location.hash,single.history.at(-1)],['#devices',['replace','#devices']],'a single customer: back to All devices without a history entry');
 const plain=await harness('#devices/ungrouped');
 check([ids(plain.fleet().props.scoped),plain.fleet().props.scope],[['a2','b1'],{type:'unassigned'}],'#devices/ungrouped is the Ungrouped scope of all devices');
 check([plain.fleet().props.header.props.title,plain.fleet().props.header.props.crumbs.map(crumb=>crumb.label),/^2 /.test(plain.fleet().props.header.props.subtitle)],[de('console.ungrouped'),[de('nav.allDevices'),de('console.ungrouped')],true],'the Ungrouped title, crumbs and count subtitle');
 // The tree: the Ungrouped node is selected on its route; selecting it opens the route.
 const again=await harness('#devices/customer/cA/ungrouped');
 check([plain.inventory().props.selectedUngrouped,again.inventory().props.selectedUngrouped,again.inventory().props.selectedCustomerId,ui.inventory().props.selectedUngrouped],[true,true,'cA',false],'the tree selects the Ungrouped node of its route, and no longer after the crumb');
 plain.inventory().props.onUngrouped('cB');plain.render();await plain.settle();
 check(pushes(plain).at(-1),['push','#devices/customer/cB/ungrouped'],'the node in a folder opens the customer Ungrouped scope');
 plain.inventory().props.onUngrouped();plain.render();await plain.settle();
 check(pushes(plain).at(-1),['push','#devices/ungrouped'],'the node of a flat tree opens #devices/ungrouped');
}

// 3b. An empty Ungrouped scope: "Every device is in a group" with "Show all devices" to the scope above.
{
 const grouped=[device('a1','ALPHA-01','cA','g-a'),device('b2','BETA-02','cB','g-b')];
 let ui=await harness('#devices/ungrouped',{data:{servers:grouped}});
 check([ui.fleet().props.ungroupedEmpty,ui.fleet().props.scoped.length],[true,0],'#devices/ungrouped without devices is empty');
 ui.fleet().props.onShowAll();ui.render();await ui.settle();
 check(pushes(ui).at(-1),['push','#devices'],'"Show all devices" opens All devices');
 ui=await harness('#devices/customer/cA/ungrouped',{data:{servers:grouped}});
 check(ui.fleet().props.ungroupedEmpty,true,'the customer Ungrouped scope without devices is empty');
 ui.fleet().props.onShowAll();ui.render();await ui.settle();
 check(pushes(ui).at(-1),['push','#devices/customer/cA'],'"Show all devices" opens the customer');
 check((await harness('#devices/customer/cA')).fleet().props.ungroupedEmpty,false,'a customer scope is never the empty Ungrouped state');
}

// 3c. "Add device" (Owner) and "Move devices here…" (group manager) in the page header, per scope and viewer.
{
 const header=ui=>ui.fleet().props.header.props;
 for(const [hash,target] of [['#devices','#devices/add'],['#devices/group/g-a','#devices/add/group/g-a'],['#devices/customer/cA','#devices/add/customer/cA'],['#devices/ungrouped','#devices/add'],['#devices/customer/cB/ungrouped','#devices/add/customer/cB']]){
  const ui=await harness(hash);
  const primary=header(ui).primary;
  check([primary.type,primary.props.variant,primary.props.children,primary.props.blocked],['Btn','primary',de('console.addDevice'),undefined],hash+': the primary is Add device');
  primary.props.onClick();ui.render();await ui.settle();
  check(pushes(ui).at(-1),['push',target],hash+': Add device opens '+target);
 }
 for(const [hash,target] of [['#devices','#devices/add'],['#devices/group/g-a','#devices/add/group/g-a'],['#devices/customer/cA','#devices/add/customer/cA']]){
  const ui=await harness(hash);
  ui.fleet().props.onProvision();ui.render();await ui.settle();
  check(pushes(ui).at(-1),['push',target],hash+': the empty-state Add device opens the same route');
 }
 // A group: Move devices here… next to the primary for a manager; it opens today's drawer.
 let ui=await harness('#devices/group/g-a');
 const move=header(ui).actions;
 check([move.type,move.props.children,move.props.variant??'secondary',move.props.blocked],['Btn',de('console.moveDevicesHere'),'secondary',undefined],'a group: the secondary "Move devices here…"');
 move.props.onClick();ui.render();await ui.settle();
 check(ui.find('AssignDevicesDrawer').props.group?.id,'g-a','it opens the drawer of the group');
 ui=await harness('#devices/group/g-a',{viewer:grouper});
 check([header(ui).primary,header(ui).actions?.props.children,ui.fleet().props.onAssign!==undefined,ui.fleet().props.onProvision],[false,de('console.moveDevicesHere'),true,undefined],'a group manager who is not the Owner: Move devices here… is the only header button');
 ui=await harness('#devices/group/g-b',{viewer:grouper});
 check([header(ui).primary,header(ui).actions],[false,undefined],'a group the viewer may not manage: no header button');
 ui=await harness('#devices/customer/cA',{viewer:reader});
 check([header(ui).primary,ui.fleet().props.onProvision],[false,undefined],'a technician: no Add device');
 // Demo mode: Add device stays visible and blocked.
 ui=await harness('#devices');
 ui.fleet().props.onDemo();ui.render();await ui.settle();
 check([header(ui).primary.props.children,header(ui).primary.props.blocked,ui.fleet().props.onProvision],[de('console.addDevice'),de('kit.unavailable.demo'),undefined],'demo: Add device is blocked with its reason');
 header(ui).primary.props.onClick();ui.render();await ui.settle();
 check(ui.location.hash,'#devices','demo: a blocked Add device opens nothing');
 // The tree: "Add device" of a customer folder opens the add-device page with the customer.
 ui=await harness('#devices');
 ui.inventory().props.onAction('provision',{type:'customer',id:'cB',name:'Kunde B'});ui.render();await ui.settle();
 check(pushes(ui).at(-1),['push','#devices/add/customer/cB'],'the folder entry Add device opens #devices/add/customer/<id>');
 ui=await harness('#devices');
 ui.inventory().props.onAction('provision',{type:'group',id:'g-a',name:'Alpha'});ui.render();await ui.settle();
 check(pushes(ui).at(-1),['push','#devices/add/group/g-a'],'the group entry opens #devices/add/group/<id>');
 ui=await harness('#devices');
 ui.inventory().props.onAction('provision',{type:'global',name:'Alle Geräte'});ui.render();await ui.settle();
 check(pushes(ui).at(-1),['push','#devices/add'],'All devices opens #devices/add');
 const tech=await harness('#devices',{viewer:reader});
 tech.inventory().props.onAction('provision',{type:'customer',id:'cB',name:'Kunde B'});tech.render();await tech.settle();
 check(pushes(tech),[],'a technician: the folder entry opens nothing');
 // The add-device page passes the customer segment to the form.
 ui=await harness('#devices/add/customer/cB');
 check(ui.find('AddDevicePage').props.routeCustomerId,'cB','the customer segment preselects the customer in the form');
}

// 4. Add device is a page of Devices: the device tree beside it, the crumbs All devices › [customer] › Add device.
{
 const ui=await harness('#devices/add/installer/customer/cB/group/g-a');
 const page=ui.find('AddDevicePage'),header=ui.find('PageHeader');
 check([page.props.installer,page.props.routeCustomerId,page.props.routeGroupId,ui.find('Rail').props.area,!!ui.inventory(),ui.find('NavList'),ui.find('NavGroups'),ui.history],[true,'cB','g-a','devices',true,undefined,undefined,[]],'Several devices with the customer and the group, the Devices rail item and the device tree');
 check([ui.find('AgentsArea'),ui.find('EnrollDialog')],[undefined,undefined],'no AgentsArea and no enroll dialog');
 check([page.props.owner,page.props.demo,page.props.multipleCustomers,page.props.customers,page.props.groupCustomers],[true,false,false,base.customers,{'g-a':'cA','g-b':'cB'}],'the page gets the viewer, the customers and the customer of each group');
 check(ui.find('Navigator').props.title,de('rail.devices'),'the navigator is the device tree with its filter');
 check([header.props.title,header.props.subtitle,header.props.areaCrumb,header.props.primary],[de('nav.devices.add'),de('nav.devices.addHint'),undefined,undefined],'title and subtitle, no primary');
 check(header.props.crumbs.map(crumb=>[crumb.label,crumb.href]),[[de('nav.allDevices'),'#devices'],['Kunde B','#devices/customer/cB'],[de('nav.devices.add'),undefined]],'All devices › customer › Add device');
 // Choosing a tab adds one history entry with the page's choice; Back returns to the other tab.
 page.props.onTab(false,{customerId:'cB',groupId:'g-b'});ui.render();await ui.settle();
 check([ui.location.hash,pushes(ui),ui.find('AddDevicePage').props.installer],['#devices/add/customer/cB/group/g-b',[['push','#devices/add/customer/cB/group/g-b']],false],'One device with one history entry');
 await ui.navigateTo('#devices/add/installer/customer/cB/group/g-a');
 check([ui.find('AddDevicePage').props.installer,pushes(ui).length],[true,1],'Back shows Several devices again');
 ui.find('PageHeader').props.crumbs[1].onSelect();ui.render();await ui.settle();
 check([ui.location.hash,ids(ui.fleet().props.scoped)],['#devices/customer/cB',['b1','b2']],'the customer crumb opens the customer scope');
 // Without customer folders (one customer) the customer crumb is left out.
 const single=await harness('#devices/add/customer/cA',{data:{customers:[{id:'cA',name:'Kunde A'}]}});
 check(single.find('PageHeader').props.crumbs.map(crumb=>crumb.label),[de('nav.allDevices'),de('nav.devices.add')],'one customer: All devices › Add device');
}
// The fleet primary, the tree menu entry, the palette entry and G N open #devices/add with a history entry.
{
 const ui=await harness('#devices');
 ui.fleet().props.header.props.primary.props.onClick();ui.render();await ui.settle();
 check(pushes(ui).at(-1),['push','#devices/add'],'the Add device primary on All devices');
 await ui.navigateTo('#devices');
 ui.inventory().props.onAction('provision',{type:'group',id:'g-a',name:'Alpha'});ui.render();await ui.settle();
 check(pushes(ui).at(-1),['push','#devices/add/group/g-a'],'the tree menu entry with its group');
 await ui.navigateTo('#devices');
 ui.find('CommandPalette').props.getItems().find(item=>item.id==='page-add-device').run();ui.render();await ui.settle();
 check(pushes(ui).at(-1),['push','#devices/add'],'the palette entry');
 await ui.navigateTo('#devices');
 const before=pushes(ui).length;
 ui.shortcuts().go(navModel.goShortcutNode('n'));ui.render();await ui.settle();
 check([pushes(ui).length-before,pushes(ui).at(-1)],[1,['push','#devices/add']],'G N');
}

// 5. The agent pages are settings pages without AgentsArea: both render their own header through the page frame,
// Releases with its page primary; the old uninstall links.
{
 // The parts of a page in render order (the elements whose type is a capitalised name).
 const parts=ui=>{const out=[];const walk=node=>{if(Array.isArray(node)){node.forEach(walk);return;}if(!node||typeof node!=='object'||!('props' in node))return;if(typeof node.type==='string'&&/^[A-Z]/.test(node.type))out.push(node.type);walk(node.props.children);};walk(ui.tree);return out.filter(type=>['AgentReleasesPage','ExtensionsPage','ReleasePanel','PluginReleases','AgentTroubleshootingPage','AgentUninstallation','AgentsArea','AddDevicePage'].includes(type));};
 const releases=await harness('#settings/agent-releases');
 const page=releases.find('AgentReleasesPage');
 check([parts(releases),releases.find('AgentsArea'),releases.find('PageHeader'),releases.find('Rail').props.area,releases.find('NavGroups').props.value,releases.find('AccessWorkspace'),releases.history],[['AgentReleasesPage'],undefined,undefined,'settings','settings.agent-releases',undefined,[]],'Releases in the Settings area with its navigator entry selected; the console renders no header of its own');
 const header=page.props.frame.header('CheckNow');
 check([header.type,header.props.title,header.props.subtitle,header.props.crumbs,header.props.areaCrumb.label,header.props.primary],['PageHeader',de('nav.settings.agentReleases'),de('nav.settings.agentReleasesHint'),undefined,de('nav.settings.title'),'CheckNow'],'frame.header: label, hint, no crumbs, the crumb button and the page primary');
 check([page.props.servers,page.props.onConfirm],[undefined,undefined],'Agent releases has no extension rollout any more: no devices, no confirmation');
 // Settings → Extensions: its own page with the release table, the devices for the rollout and the confirmation; no header primary.
 const extensions=await harness('#settings/extensions'),extensionsPage=extensions.find('ExtensionsPage'),extensionsHeader=extensionsPage.props.frame.header();
 check([parts(extensions),extensions.find('NavGroups').props.value,extensionsHeader.props.title,extensionsHeader.props.subtitle,extensionsHeader.props.primary,extensionsPage.props.servers,typeof extensionsPage.props.onConfirm,extensions.find('AgentReleasesPage')],
  [['ExtensionsPage'],'settings.extensions',de('nav.settings.extensions'),de('nav.settings.extensionsHint'),undefined,base.servers,'function',undefined],'#settings/extensions renders the Extensions page with its navigator entry, the devices and the confirmation');
 const troubleshooting=await harness('#settings/agent-troubleshooting');
 const troubleshootingHeader=troubleshooting.find('AgentTroubleshootingPage').props.frame.header();
 check([parts(troubleshooting),troubleshooting.find('AgentsArea'),troubleshooting.find('NavGroups').props.value,troubleshooting.all('PageHeader').length,[troubleshootingHeader.props.title,troubleshootingHeader.props.primary]],[['AgentTroubleshootingPage'],undefined,'settings.agent-troubleshooting',0,[de('nav.settings.agentTroubleshooting'),undefined]],'Agent troubleshooting: no console header, its frame header without a primary; the page holds its own uninstall card');
 for(const old of ['#settings/agent-troubleshooting/uninstall','#agents/uninstall']){
  const ui=await harness(old);
  check([ui.location.hash,ui.history,!!ui.find('AgentTroubleshootingPage')],['#settings/agent-troubleshooting',[['replace','#settings/agent-troubleshooting']],true],old+': one replaceState to Agent troubleshooting');
 }
 const denied=await harness('#settings/agent-releases',{viewer:{id:'notifier',label:'n@example.test',permissions:['portal.notifications.manage']}});
 check([denied.location.hash,pushes(denied),denied.find('AgentReleasesPage')],['#devices',[],undefined],'the agent pages are for the Owner only');
 const deniedExtensions=await harness('#settings/extensions',{viewer:{id:'manager',label:'m@example.test',permissions:['plugins.manage','portal.notifications.manage']}});
 check([deniedExtensions.find('ExtensionsPage'),deniedExtensions.find('CommandPalette').props.getItems().some(item=>item.id==='page-settings-extensions')],[undefined,false],'Settings → Extensions is for the Owner only, also with plugins.manage');
}

// 5a. The page frame (ui/shell/page-frame.ts): for every settings page the Owner may open, every automation page and My
// account the console renders no PageHeader. The page element gets a frame whose header(primary) is the PageHeader of
// its node: the node label, its subtitle or hint, no crumbs, the area crumb button and the given primary.
{
 const framed=ui=>ui.find('AccessWorkspace')??ui.find('AgentReleasesPage')??ui.find('ExtensionsPage')??ui.find('AgentTroubleshootingPage')??ui.find('AutomationWorkspace');
 const pages=[...navModel.navigatorPages('settings',{viewer:owner,multipleCustomers:true}),...navModel.navigatorPages('automation',{viewer:owner})];
 check(pages.length,19,'sixteen settings pages and three automation pages');
 for(const node of pages){
  const hash=consoleRouteHash(node.route),ui=await harness(hash,{data:{multipleCustomers:true}});
  const header=framed(ui).props.frame.header('Primary');
  check([ui.location.hash,ui.all('PageHeader').length,header.type,header.props.title,header.props.subtitle,header.props.crumbs,header.props.areaCrumb.label,header.props.primary],
   [hash,0,'PageHeader',de(node.label),de(node.subtitle??node.hint),undefined,de(navModel.areaCrumbOf(node)),'Primary'],hash+': no console header; the frame header of the node with the primary');
 }
 // My account: the subtitle names an Entra sign-in; no crumbs and no crumb button.
 for(const [viewer,subtitle] of [[owner,'nav.account.subtitle'],[{...owner,identitySource:'entra'},'nav.account.subtitleEntra']]){
  const ui=await harness('#account',{viewer}),header=ui.find('AccountPanel').props.frame.header();
  check([ui.all('PageHeader').length,header.props.title,header.props.subtitle,header.props.crumbs,header.props.areaCrumb,header.props.primary,ui.find('AccountPanel').props.frame.tab],
   [0,de('nav.account.title'),de(subtitle),undefined,undefined,undefined,''],'#account ('+(viewer.identitySource??'local')+'): the frame header with its subtitle; a page without tabs has tab ""');
 }
 const ui=await harness('#settings/notification-channels');
 const access=ui.find('AccessWorkspace');
 check([ui.all('PageHeader').length,access.props.section,access.props.frame.tab],[0,'notification-channels','channels'],'Notification channels: AccessWorkspace gets the frame on the Channels tab');
 check(access.props.frame.header('AddChannel').props.primary,'AddChannel','its frame header carries the page primary');
 check([access.props.frame.tab,(await harness('#settings/audit')).find('AccessWorkspace').props.frame.tab],['channels',''],'the first tab of a page with tabs, "" without tabs');
}

// 5b. The tabs of Notification channels: a tab change pushes its hash once, Back and Forward switch the
// tab, a reload keeps it, and an unknown tab opens Channels without a history entry.
{
 const ui=await harness('#settings/notification-channels');
 const frame=()=>ui.find('AccessWorkspace').props.frame;
 const before=pushes(ui).length;
 frame().onTab('log');ui.render();await ui.settle();
 check([pushes(ui).length-before,ui.location.hash,frame().tab,ui.find('NavGroups').props.value],[1,'#settings/notification-channels/log','log','settings.notification-channels'],'the Delivery log tab pushes its hash once');
 await ui.navigateTo('#settings/notification-channels');
 check(frame().tab,'channels','Back shows Channels');
 await ui.navigateTo('#settings/notification-channels/log');
 check(frame().tab,'log','Forward shows the Delivery log');
 const reloaded=await harness('#settings/notification-channels/log');
 check([reloaded.find('AccessWorkspace').props.frame.tab,reloaded.history],['log',[]],'a reload keeps the tab');
 const unknown=await harness('#settings/notification-channels/other');
 check([unknown.location.hash,unknown.history,unknown.find('AccessWorkspace').props.frame.tab],['#settings/notification-channels',[['replace','#settings/notification-channels']],'channels'],'an unknown tab opens Channels in place');
 // The default tab in the link is replaced in place by the page link.
 const explicit=await harness('#settings/notification-channels/channels');
 check([explicit.location.hash,explicit.history,explicit.find('AccessWorkspace').props.frame.tab],['#settings/notification-channels',[['replace','#settings/notification-channels']],'channels'],'#settings/notification-channels/channels is replaced in place');
 // Choosing Channels again writes the page link without a segment, with one history entry.
 const back=await harness('#settings/notification-channels/log'),start=pushes(back).length;
 back.find('AccessWorkspace').props.frame.onTab('channels');back.render();await back.settle();
 check([pushes(back).length-start,back.location.hash,back.find('AccessWorkspace').props.frame.tab],[1,'#settings/notification-channels','channels'],'onTab of the first tab: one entry, no segment');
}

// 5b2. The tabs of an Automation page: frame.tab from the link (the first tab without one), onTab pushes once, the first
// tab writes no segment, an unknown tab opens the first, Back and Forward switch the tab; the navigator, the header and
// the help topic stay those of the page. A runbook run from the job panel opens the Runs tab with its output drawer.
{
 const ui=await harness('#automation/runbooks/runs');
 const frame=()=>ui.find('AutomationWorkspace').props.frame;
 check([frame().tab,ui.find('AutomationWorkspace').props.page,ui.find('NavList').props.value,ui.find('HelpPanel').props.route,frame().header().props.title],['runs','runbooks','automation.runbooks',{view:'automation',page:'runbooks',tab:'runs'},de('nav.automation.runbooks')],'#automation/runbooks/runs: the Runs tab of the Runbooks page');
 const before=pushes(ui).length;
 frame().onTab('status');ui.render();await ui.settle();
 check([pushes(ui).length-before,ui.location.hash,frame().tab],[1,'#automation/runbooks/status','status'],'onTab pushes its hash once');
 frame().onTab('library');ui.render();await ui.settle();
 check([pushes(ui).length-before,ui.location.hash,frame().tab],[2,'#automation/runbooks','library'],'the first tab writes no segment');
 frame().onTab('nope');ui.render();await ui.settle();
 check([pushes(ui).length-before,ui.location.hash,frame().tab],[2,'#automation/runbooks','library'],'an unknown tab opens the first tab');
 await ui.navigateTo('#automation/runbooks/status');
 check(frame().tab,'status','Back shows the previous tab');
 await ui.navigateTo('#automation/runbooks');
 check(frame().tab,'library','Forward shows the next one');
 const drift=await harness('#automation/drift');
 check([drift.find('AutomationWorkspace').props.page,drift.find('AutomationWorkspace').props.frame.tab,drift.history],['drift','assignments',[]],'#automation/drift: its first tab');
 const old=await harness('#automation/desired/configurations');
 check([old.location.hash,old.history,old.find('AutomationWorkspace').props.frame.tab],['#automation/desired',[['replace','#automation/desired']],'configurations'],'the default tab in the link is replaced in place');
 // A runbook run of the job panel: #automation/runbooks/runs with the run focus; a tab change clears the focus.
 const jobs=await harness('#devices');
 jobs.find('JobDock').props.onSelect({id:'job-1',action:'runbook-run',serverId:'a1',metadata:{runbookRunId:'run-1'}});jobs.render();await jobs.settle();
 const workspace=jobs.find('AutomationWorkspace');
 check([jobs.location.hash,pushes(jobs).at(-1),workspace.props.page,workspace.props.frame.tab,workspace.props.runFocus?.runId,workspace.props.runFocus?.serverId],['#automation/runbooks/runs',['push','#automation/runbooks/runs'],'runbooks','runs','run-1','a1'],'a runbook run opens #automation/runbooks/runs with its run');
 workspace.props.frame.onTab('schedules');jobs.render();await jobs.settle();
 check([jobs.location.hash,jobs.find('AutomationWorkspace').props.runFocus],['#automation/runbooks/schedules',null],'opening a tab clears the run focus');
}

// 5c. Refresh: the top-bar refresh, R and the palette action count up frame.refresh, so the open settings page
// loads again; the console data reloads as before.
{
 const ui=await harness('#settings/retention');
 const count=()=>ui.find('AccessWorkspace').props.frame.refresh,start=count(),reloads=ui.refreshes.length;
 ui.find('Topbar').props.onRefresh();ui.render();await ui.settle();
 check(count(),start+1,'the top-bar refresh');
 ui.shortcuts().refresh();ui.render();await ui.settle();
 check(count(),start+2,'R');
 ui.find('CommandPalette').props.getItems().find(item=>item.id==='action-refresh').run();ui.render();await ui.settle();
 check([count(),ui.refreshes.length-reloads],[start+3,3],'the palette action; each one also reloads the console data');
 const releases=await harness('#settings/agent-releases');
 const first=releases.find('AgentReleasesPage').props.frame.refresh;
 releases.find('Topbar').props.onRefresh();releases.render();await releases.settle();
 check(releases.find('AgentReleasesPage').props.frame.refresh,first+1,'Agent releases gets the same count');
 for(const [hash,type] of [['#automation/drift','AutomationWorkspace'],['#account','AccountPanel']]){
  const page=await harness(hash),value=()=>page.find(type).props.frame.refresh,initial=value();
  page.find('Topbar').props.onRefresh();page.render();await page.settle();
  page.shortcuts().refresh();page.render();await page.settle();
  page.find('CommandPalette').props.getItems().find(item=>item.id==='action-refresh').run();page.render();await page.settle();
  check(value(),initial+3,hash+': the top-bar refresh, R and the palette count up frame.refresh');
 }
}

// 5d. "Assign role" from Accounts opens All devices › Configuration › Permissions with one history entry and hands the
// account to the editor as its prefill; the editor's onPrefillDone and leaving the page drop it. The top-bar refresh
// counts up the editor's refreshKey on the scope and on the device, and frame.refresh on Accounts.
{
 const ui=await harness('#settings/accounts');
 const frameCount=()=>ui.find('AccessWorkspace').props.frame.refresh,startFrame=frameCount();
 ui.find('Topbar').props.onRefresh();ui.render();await ui.settle();
 check(frameCount(),startFrame+1,'#settings/accounts: the top-bar refresh raises frame.refresh');
 const before=pushes(ui).length,editor=()=>ui.editors()[0];
 ui.find('AccessWorkspace').props.onAssignRole('u-1');ui.render();await ui.settle();
 check([ui.location.hash,pushes(ui).length-before,ui.fleet().props.tab,editor().props.prefill],['#devices/configuration/permissions',1,'permissions',{subjectType:'user',subjectId:'u-1'}],'"Assign role": one history entry, the Permissions tab and the prefill');
 editor().props.onPrefillDone();ui.render();await ui.settle();
 check(editor().props.prefill,undefined,'onPrefillDone drops the prefill');
 const start=editor().props.refreshKey;
 ui.find('Topbar').props.onRefresh();ui.render();await ui.settle();
 check(editor().props.refreshKey,start+1,'#devices/configuration/permissions: the top-bar refresh raises refreshKey');
 await ui.navigateTo('#settings/accounts');ui.find('AccessWorkspace').props.onAssignRole('u-2');ui.render();await ui.settle();
 ui.fleet().props.onTab('devices');ui.render();await ui.settle();ui.fleet().props.onTab('permissions');ui.render();await ui.settle();
 check(editor().props.prefill,undefined,'another tab drops the prefill');
 await ui.navigateTo('#settings/accounts');ui.find('AccessWorkspace').props.onAssignRole('u-3');ui.render();await ui.settle();
 await ui.navigateTo('#settings/accounts');await ui.navigateTo('#devices/configuration/permissions');
 check(editor().props.prefill,undefined,'Back and Forward drop the prefill');
 const deviceUi=await harness('#device/a1/configuration/permissions'),deviceKey=()=>deviceUi.editors()[0].props.refreshKey,deviceStart=deviceKey();
 deviceUi.find('Topbar').props.onRefresh();deviceUi.render();await deviceUi.settle();
 check(deviceKey(),deviceStart+1,'the device Permissions editor gets the same count');
}

// The registration of the page: the console sends it, saves the file and reports the device id of the JSON to the page.
{
 const ui=await harness('#devices/add');
 const registration={id:'dev-new',token:'secret',origin:'https://portal.test',jobSigningKey:'k',mode:'ReadOnly'};
 ui.state.reply=()=>new Response(JSON.stringify(registration),{status:200,headers:{'Content-Type':'application/json'}});
 const created=[];
 ui.find('AddDevicePage').props.onEnroll({name:'SRV 01',mode:'ReadOnly',groupId:'g-a'},value=>created.push(value));ui.render();await ui.settle();
 check(ui.posts.at(-1),{url:'/api/console',body:{action:'enroll',name:'SRV 01',mode:'ReadOnly',agentVersion:4,format:'json',groupId:'g-a'}},'the request of enrollBody');
 check([ui.downloads,created],[['ServerDesk-SRV_01.registration.json'],[{name:'SRV 01',fileName:'ServerDesk-SRV_01.registration.json',deviceId:'dev-new'}]],'the file is saved and the page learns the device id');
 check([ui.toasts,ui.refreshes.length>0,ui.location.hash],[[de('console.registrationDownloaded')],true,'#devices/add'],'the toast, a fresh console snapshot, the page stays');
 check(ui.find('AddDevicePage').props.certificate,null,'without portalCertificate in the answer the card says "none"');
 ui.setData({portalCertificate:{name:'Root',sha256:'AA:BB',notAfter:'2030-01-01T00:00:00.000Z'}});
 check(ui.find('AddDevicePage').props.certificate,{name:'Root',sha256:'AA:BB',notAfter:'2030-01-01T00:00:00.000Z'},'the Owner block of the console answer feeds the certificate card');
}

// 6. Settings, Automation and the rail from the model.
{
 const ui=await harness('#settings/retention');
 const groups=ui.find('NavGroups');
 check([ui.find('AccessWorkspace').props.section,ui.find('Rail').props.area,groups.props.value],['retention','settings','settings.retention'],'Data retention renders the retention section in Settings');
 check(groups.props.groups.map(group=>[group.label,group.items.map(item=>item.href)]),[
  [de('nav.settings.groupUsers'),['#settings/accounts','#settings/user-groups','#settings/roles','#settings/entra','#settings/sessions']],
  [de('nav.settings.groupOrganization'),['#settings/customers','#settings/branding']],
  [de('nav.settings.groupIntegrations'),['#settings/notification-channels','#settings/vulnerabilities','#settings/assistant']],
  [de('nav.settings.groupAgents'),['#settings/agent-releases','#settings/extensions','#settings/agent-troubleshooting']],
  [de('nav.settings.groupSystem'),['#settings/retention','#settings/audit','#settings/usage-data']],
 ],'the five groups and links; Customers and Branding for every Owner, Usage data after Audit log');
 // The page header of a settings page comes from its frame (ui/shell/page-frame.ts).
 const pageHeader=()=>ui.find('AccessWorkspace').props.frame.header(),header=pageHeader();
 check([header.props.title,header.props.subtitle,header.props.crumbs,header.props.areaCrumb.label,header.props.areaCrumb.expanded,ui.find('Navigator').props.open],[de('nav.settings.retention'),de('nav.settings.retentionHint'),undefined,de('nav.settings.title'),false,false],'no crumbs, the crumb button with the area name');
 header.props.areaCrumb.onSelect();ui.render();await ui.settle();
 check([pageHeader().props.areaCrumb.expanded,ui.find('Navigator').props.open],[true,true],'the crumb button opens the navigator overlay and says so');
 ui.find('NavGroups').props.onSelect('settings.audit');ui.render();await ui.settle();
 check([ui.location.hash,pageHeader().props.areaCrumb.expanded,ui.find('Navigator').props.open],['#settings/audit',false,false],'a page choice closes the overlay');
 check(ui.find('HelpPanel').props.route,{view:'settings',page:'audit'},'the help panel gets the route');
 check(ui.find('Rail').props.items.map(item=>[item.id,item.label,item.shortcut,item.placement]),[['dashboard',de('rail.dashboard'),'G H',undefined],['devices',de('rail.devices'),'G D',undefined],['automation',de('rail.automation'),'G A',undefined],['settings',de('rail.settings'),'G S','end']],'the Owner rail: the Dashboard first, no Agents');
 const rail=item=>ui.find('Rail').props.items.find(entry=>entry.id===item);
 rail('automation').onSelect();ui.render();await ui.settle();check(ui.location.hash,'#automation/runbooks','Automation');
 // The Automation page renders its PageHeader through the frame, with the page primary.
 const automationHeader=ui.find('AutomationWorkspace').props.frame.header('primary');
 check([automationHeader.props.crumbs,automationHeader.props.areaCrumb.label,automationHeader.props.primary],[undefined,de('nav.automation.title'),'primary'],'Automation: no crumbs, the crumb button, the page primary');
 check([ui.find('AutomationWorkspace').props.page,ui.find('AutomationWorkspace').props.frame.tab],['runbooks','library'],'Automation: the page and its default tab');
 ui.find('NavList').props.onSelect('automation.drift');ui.render();await ui.settle();check([ui.location.hash,ui.find('NavList').props.value],['#automation/drift','automation.drift'],'a navigator entry');
 rail('settings').onSelect();ui.render();await ui.settle();check(ui.location.hash,'#settings/audit','Settings returns to its last page');
 // The last page may be an agent page.
 ui.find('NavGroups').props.onSelect('settings.agent-troubleshooting');ui.render();await ui.settle();
 rail('devices').onSelect();ui.render();await ui.settle();check(ui.location.hash,'#devices','Devices');
 rail('settings').onSelect();ui.render();await ui.settle();check(ui.location.hash,'#settings/agent-troubleshooting','Settings returns to Agent troubleshooting');
 // A last page the viewer may no longer open: the first page the viewer may open.
 rail('automation').onSelect();ui.render();await ui.settle();
 ui.setViewer({...owner,permissions:['portal.roles.manage']});await ui.settle();
 ui.find('Rail').props.items.find(entry=>entry.id==='settings').onSelect();ui.render();await ui.settle();
 check(ui.location.hash,'#settings/roles','the first allowed page when the last one is not allowed');
 const denied=await harness('#settings/retention',{viewer:reader});
 check([denied.location.hash,denied.find('AccessWorkspace'),denied.find('Rail').props.items.map(item=>item.id)],['#devices',undefined,['dashboard','devices','automation']],'a page the viewer may not open falls back to All devices');
}
// G S and G I open the first settings page the viewer may open.
{
 for(const [key,viewer,hash] of [['s',owner,'#settings/accounts'],['i',owner,'#settings/accounts'],['s',{id:'notifier',label:'n@example.test',permissions:['portal.notifications.manage']},'#settings/notification-channels']]){
  const ui=await harness('#devices',{viewer});
  ui.shortcuts().go(navModel.goShortcutNode(key));ui.render();await ui.settle();
  check([ui.location.hash,pushes(ui).length],[hash,1],`G ${key.toUpperCase()} for ${viewer.id}`);
 }
}

// 7. Customers: a page of every Owner, with or without a second customer. The old License link opens Usage data.
{
 let ui=await harness('#settings/customers');
 check([ui.location.hash,pushes(ui),ui.history,ui.find('AccessWorkspace').props.section],['#settings/customers',[],[],'customers'],'one customer: the Customers page opens');
 ui=await harness('#settings/customers',{data:{multipleCustomers:true}});
 check([ui.location.hash,ui.history,ui.find('AccessWorkspace').props.section,ui.find('NavGroups').props.groups[1].items.map(item=>item.id)],['#settings/customers',[],'customers',['settings.customers','settings.branding']],'several customers: the same page, Branding after it');
 const items=(await harness('#devices')).find('CommandPalette').props.getItems();
 check(items.some(item=>item.id==='page-settings-customers'),true,'the palette offers Customers with one customer too');
 ui=await harness('#settings/license');
 check([ui.location.hash,ui.history,ui.find('AccessWorkspace').props.section],['#settings/usage-data',[['replace','#settings/usage-data']],'usage-data'],'the old License link opens Usage data in place');
}

// 8. The palette pages: each destination once, with its label and its parent path; they open their routes.
{
 const ui=await harness('#devices');
 const items=ui.find('CommandPalette').props.getItems(),page=id=>items.find(item=>item.id===id);
 check(items.filter(item=>item.id.startsWith('page-')).length,48,'all pages and page tabs of the Owner');
 check([items.filter(item=>item.id.startsWith('page-'))[0].id,page('page-dashboard').label,page('page-dashboard').hint],['page-dashboard',de('rail.dashboard'),undefined],'the Dashboard is the first page');
 check([page('page-settings-extensions').label,page('page-settings-extensions').hint,page('page-fleet-extensions').label,page('page-fleet-extensions').hint,items.some(item=>item.id==='page-server-roles')],[de('nav.settings.extensions'),de('palette.hint.settings'),de('extensions.tab'),`${de('nav.allDevices')} › ${de('fleet.tabs.inventory')}`,false],'Extensions: the settings page and the Inventory subtab; no Server roles entry');
 // The page tabs: the exact German label and hint, right after their page in tab order.
 check([['page-automation-runbooks-runs'],['page-settings-notification-channels-log'],['page-software']].map(([id])=>[page(id).label,page(id).hint,page(id).group]),
  [['Läufe','Automation › Runbooks',de('palette.group.pages')],['Zustellprotokoll','Einstellungen › Benachrichtigungskanäle',de('palette.group.pages')],['Software','Alle Geräte › Inventar',de('palette.group.pages')]],'Runs, Delivery log and Software: label and hint');
 const order=items.filter(item=>item.id.startsWith('page-')).map(item=>item.id);
 const after=(pageId,tabIds)=>order.slice(order.indexOf(pageId),order.indexOf(pageId)+tabIds.length+1);
 check([after('page-automation-runbooks',['runs','schedules','assignments','status']),after('page-automation-desired',['assignments','status','history']),after('page-automation-drift',['status','reference']),after('page-settings-notification-channels',['log'])],
  [['page-automation-runbooks','page-automation-runbooks-runs','page-automation-runbooks-schedules','page-automation-runbooks-assignments','page-automation-runbooks-status'],
   ['page-automation-desired','page-automation-desired-assignments','page-automation-desired-status','page-automation-desired-history'],
   ['page-automation-drift','page-automation-drift-status','page-automation-drift-reference'],
   ['page-settings-notification-channels','page-settings-notification-channels-log']],'the tab entries follow their page in tab order');
 check([page('page-automation-runbooks-runs').keywords,page('page-settings-notification-channels-log').keywords],[page('page-automation-runbooks').keywords,page('page-settings-notification-channels').keywords],'a tab entry has the keywords of its page');
 for(const [id,hash] of [['page-automation-runbooks-runs','#automation/runbooks/runs'],['page-settings-notification-channels-log','#settings/notification-channels/log']]){
  const tabs=await harness('#devices'),entry=tabs.find('CommandPalette').props.getItems().find(item=>item.id===id),start=pushes(tabs).length;
  entry.run();tabs.render();await tabs.settle();
  check([tabs.location.hash,pushes(tabs).length-start],[hash,1],id+' opens its tab with one history entry');
 }
 const notifier=await harness('#devices',{viewer:{id:'notifier',label:'n@example.test',permissions:['portal.notifications.manage']}});
 check(notifier.find('CommandPalette').props.getItems().some(item=>item.id==='page-settings-notification-channels-log'),true,'a notifier sees Delivery log');
 const roles=await harness('#devices',{viewer:{id:'roles',label:'r@example.test',permissions:['portal.roles.manage']}});
 check(roles.find('CommandPalette').props.getItems().some(item=>item.id==='page-settings-notification-channels-log'),false,'a viewer without the notification right does not');
 check(items.some(item=>item.id==='action-provision'),false,'no separate Add device action');
 check([page('page-devices').label,page('page-devices').hint,page('page-jobs').label,page('page-jobs').hint,page('page-add-device').label,page('page-add-device').hint,page('page-automation-drift').hint,page('page-settings-agent-releases').hint,page('page-account').hint],
  [de('nav.allDevices'),undefined,de('history.tab.jobs'),`${de('nav.allDevices')} › ${de('fleet.tabs.history')}`,de('nav.devices.add'),de('nav.allDevices'),de('nav.automation.title'),de('palette.hint.settings'),undefined],'labels and hints');
 check([page('page-devices').label,page('page-alarms').label,page('page-protection').label,page('page-problems')],[de('nav.allDevices'),de('fleet.tabs.monitoring'),de('protection.title'),undefined],'All devices, one Monitoring entry, Defender');
 // The Ungrouped nodes of the tree are in the group "Groups": here one per customer folder with a group and a loose device.
 check(items.filter(item=>item.id.startsWith('ungrouped-')).map(item=>[item.id,item.group,item.label,item.hint]),[['ungrouped-cA',de('palette.group.groups'),de('console.ungrouped'),'Kunde A'],['ungrouped-cB',de('palette.group.groups'),de('console.ungrouped'),'Kunde B']],'the Ungrouped entries with the parent as hint');
 page('ungrouped-cB').run();ui.render();await ui.settle();check(ui.location.hash,'#devices/customer/cB/ungrouped','an Ungrouped entry opens its route');
 const flat=await harness('#devices',{data:{customers:[]}}),flatItems=flat.find('CommandPalette').props.getItems().filter(item=>item.id.startsWith('ungrouped-'));
 check(flatItems.map(item=>[item.id,item.hint]),[['ungrouped-all',de('nav.allDevices')]],'a flat tree: one entry under All devices');
 flatItems[0].run();flat.render();await flat.settle();check(flat.location.hash,'#devices/ungrouped','it opens #devices/ungrouped');
 const noGroups=await harness('#devices',{data:{customers:[],deviceGroups:[],servers:servers.map(server=>({...server,groupId:null,groups:[]}))}});
 check(noGroups.find('CommandPalette').props.getItems().filter(item=>item.id.startsWith('ungrouped-')),[],'no group: no Ungrouped entry');
 for(const [id,hash] of [['page-jobs','#devices/history'],['page-device-access','#devices/history/access'],['page-alarms','#devices/monitoring'],['page-alert-rules','#devices/monitoring/alert-rules'],['page-notification-rules','#devices/monitoring/notification-rules'],['page-protection','#devices/inventory/defender'],['page-settings-sessions','#settings/sessions'],['page-settings-agent-troubleshooting','#settings/agent-troubleshooting'],['page-settings-extensions','#settings/extensions'],['page-fleet-extensions','#devices/inventory/extensions'],['page-automation-desired','#automation/desired'],['page-account','#account'],['page-add-device','#devices/add'],['page-devices','#devices']]){
  page(id).run();ui.render();await ui.settle();check(ui.location.hash,hash,id);
 }
 check([page('page-settings-retention').hint,page('page-settings-retention').keywords],[de('palette.hint.settings'),`${de('maintenancePage.paletteKeywords')} ${de('palette.hint.settings').toLowerCase()}`],'settings hint and keywords');
}

// 9. The device areas of slice 6: the keys 1–9, the non-modal assistant drawer, and the fallbacks of Configuration ›
// Permissions and of a DHCP or DNS link.
{
 let ui=await harness('#device/a1');
 const key=async index=>{ui.shortcuts().section(index);ui.render();await ui.settle();};
 await key(2);check([ui.device().props.section,ui.location.hash],['software','#device/a1/software'],'3 opens Software');
 await key(4);check(ui.location.hash,'#device/a1/management','5 opens Management');
 await key(7);check(ui.location.hash,'#device/a1/history','8 opens History');
 let before=ui.history.length;await key(8);check([ui.location.hash,ui.history.length],['#device/a1/history',before],'9 does nothing on a device without Extensions');
 // #device/<id>/assistant opens the device with the drawer, replaced in place; the drawer has no route.
 ui=await harness('#device/a1/assistant');
 check([ui.location.hash,pushes(ui),ui.history.at(-1),ui.device().props.assistantOpen],['#device/a1',[],['replace','#device/a1'],true],'the assistant link opens the drawer and becomes #device/a1');
 ui=await harness('#devices/a1/assistant');
 check([ui.location.hash,ui.device().props.assistantOpen],['#device/a1',true],'the old assistant link too');
 await key(1);check([ui.location.hash,ui.device().props.assistantOpen],['#device/a1/hardware',true],'the drawer stays open on an area switch');
 ui.device().props.onSection('diagnostics');ui.render();await ui.settle();check([ui.location.hash,ui.device().props.assistantOpen],['#device/a1/diagnostics',true],'and on a tab change');
 ui.device().props.onAssistantOpen(false);ui.render();await ui.settle();check([ui.device().props.assistantOpen,ui.location.hash],[false,'#device/a1/diagnostics'],'closing it leaves the route');
 // The palette action opens the drawer on the open device and leaves the route unchanged.
 before=ui.history.length;
 const ask=ui.find('CommandPalette').props.getItems().find(item=>item.id==='device-assistant');
 check(ask.label,de('assistant.palette.ask',{name:'ALPHA-01'}),'the palette action names the device');
 ask.run();ui.render();await ui.settle();check([ui.device().props.assistantOpen,ui.location.hash,ui.history.length],[true,'#device/a1/diagnostics',before],'the palette opens the drawer without a hash change');
 // Another device closes it; an earlier conversation of another device opens that device with its drawer.
 ui.shortcuts().step(1);ui.render();await ui.settle();check([ui.device().props.server.id,ui.device().props.assistantOpen],['a2',false],'the stepper opens the next device with the drawer closed');
 ui.device().props.onOpenDeviceAssistant('b1');ui.render();await ui.settle();check([ui.device().props.server.id,ui.device().props.assistantOpen,ui.location.hash],['b1',true,'#device/b1'],'an earlier conversation opens its device with the drawer');
 // Configuration (Permissions) without portal.roleAssignments.manage shows Monitoring › Alert rules, replaced after the data loaded.
 ui=await harness('#device/a1/configuration/permissions',{viewer:reader});
 check([ui.device().props.section,ui.device().props.detail,ui.location.hash,pushes(ui),ui.history.at(-1)],['monitoring',{deviceDetail:'alert-rules'},'#device/a1/monitoring/alert-rules',[],['replace','#device/a1/monitoring/alert-rules']],'Configuration without the right falls back to Monitoring › Alert rules');
 ui=await harness('#device/a1/configuration/permissions');
 check([ui.device().props.section,ui.device().props.detail,ui.location.hash,ui.history],['configuration',{},'#device/a1/configuration/permissions',[]],'with the right the link stays');
 // The device Monitoring: the rules panels of the device, the head links and the empty-state place.
 ui=await harness('#device/a1/monitoring/notification-rules');
 const deviceRules=ui.device().props.notifications.props.children;
 check([ui.device().props.section,ui.device().props.detail,deviceRules.props.scope,deviceRules.props.canManageChannels],['monitoring',{deviceDetail:'notification-rules'},{type:'device',id:'a1'},true],'the device Notification rules panel');
 check(deviceRules.props.deviceEmpty.name,'Alpha','the empty-state action names the nearest group the viewer may open');
 deviceRules.props.deviceEmpty.onOpen();ui.render();await ui.settle();
 check(ui.location.hash,'#devices/group/g-a/monitoring/notification-rules','and opens its Monitoring › Notification rules');
 ui=await harness('#device/a1/monitoring');
 ui.device().props.notifications.props.children.props.onOpenSettings();ui.render();await ui.settle();
 check(ui.location.hash,'#settings/notification-channels','Open notification channels opens the Channels tab');
 // A DNS link on a device with only the DHCP role shows the Extensions Overview: #device/<id>/extensions.
 const dhcp={...device('r1','ROLES-01','cA'),snapshot:{os:'Microsoft Windows Server 2022 Standard',features:[{name:'DHCP',displayName:'DHCP-Server',installed:true,featureType:'Role'}]}};
 ui=await harness('#device/r1/extensions/dns',{data:{servers:[...servers,dhcp]}});
 check([ui.device().props.section,ui.device().props.detail,ui.location.hash,pushes(ui)],['extensions',{},'#device/r1/extensions',[]],'a DNS link without the DNS role falls back to the Overview subtab');
 ui=await harness('#device/r1/extensions/dhcp',{data:{servers:[...servers,dhcp]}});
 check([ui.device().props.detail,ui.location.hash,ui.history],[{deviceDetail:'dhcp'},'#device/r1/extensions/dhcp',[]],'the DHCP link of a DHCP server stays');
 await key(8);check(ui.location.hash,'#device/r1/extensions','9 opens Extensions on a device with a role');
 // The palette device items of an installed DHCP extension open the DHCP subarea of Extensions.
 const ready={...dhcp,snapshot:{...dhcp.snapshot,plugins:[{name:'dhcp',target:'dhcp',version:'1.1.0',capabilities:['dhcp-read','dhcp-scope-create'],state:'ready',networkBlocked:true}]}};
 ui=await harness('#device/r1',{data:{servers:[...servers,ready]}});
 const deviceItems=ui.find('CommandPalette').props.getItems();
 check(['section-extensions','device-dhcp','device-dhcp-new-scope'].map(id=>!!deviceItems.find(item=>item.id===id)),[true,true,true],'the palette offers the Extensions area, the DHCP server and New DHCP scope');
 deviceItems.find(item=>item.id==='device-dhcp').run();ui.render();await ui.settle();
 check(ui.location.hash,'#device/r1/extensions/dhcp','the palette item DHCP server opens #device/<id>/extensions/dhcp');
}

// 10. Overlays at 900px or narrower (slice 14): window.matchMedia matches (max-width: 900px), so the navigator is an
// overlay, the bottom bar holds Jobs and Help is a non-modal drawer that follows the route.
{
 const phone=async(hash,options={})=>{const ui=consoleHarness({viewer:owner,hash,base,media:['(max-width: 900px)'],...options});await ui.settle();return ui;};
 const step=async(ui,run)=>{run();ui.render();await ui.settle();};
 let ui=await phone('#devices');
 const topbar=()=>ui.find('Topbar'),navigator=()=>ui.find('Navigator'),rail=()=>ui.find('Rail'),item=id=>rail().props.items.find(entry=>entry.id===id);
 check([topbar().props.overlay,topbar().props.navigatorOpen,navigator().props.overlay,navigator().props.open],[true,false,true,false],'the toggle reports the closed overlay');
 // The top-bar toggle opens and closes the overlay.
 await step(ui,()=>topbar().props.onToggleNavigator());
 check([topbar().props.navigatorOpen,navigator().props.open],[true,true],'the toggle opens the overlay');
 await step(ui,()=>topbar().props.onToggleNavigator());
 check([topbar().props.navigatorOpen,navigator().props.open],[false,false],'a second click on the toggle (above the scrim) closes it');
 // The active bottom-bar item toggles the overlay and says so; the inactive items navigate.
 check([item('devices').expanded,item('automation').expanded,item('settings').expanded],[false,undefined,undefined],'only the active item of an area with a navigator carries aria-expanded');
 await step(ui,()=>item('devices').onSelect());
 check([navigator().props.open,item('devices').expanded,ui.location.hash],[true,true,'#devices'],'the active Devices item opens the overlay without navigating');
 // Esc (the Navigator's onClose) closes it; a tree choice and a route change close it too.
 await step(ui,()=>navigator().props.onClose());
 check(navigator().props.open,false,'Esc or the scrim close the overlay');
 await step(ui,()=>item('devices').onSelect());
 await step(ui,()=>ui.inventory().props.onDevice('a1'));
 check([navigator().props.open,ui.location.hash],[false,'#device/a1'],'choosing a tree entry closes the overlay');
 await step(ui,()=>topbar().props.onToggleNavigator());
 await ui.navigateTo('#devices');
 check(navigator().props.open,false,'a route change (Back) closes the overlay');
 await step(ui,()=>item('automation').onSelect());
 check([ui.location.hash,navigator().props.open],['#automation/runbooks',false],'an inactive item navigates as before');
 check([item('automation').expanded,item('devices').expanded],[false,undefined],'Automation is the active item now');
 // The crumb button of a navigator page toggles the same overlay (the Automation page renders the header of its frame).
 const pageHeader=()=>ui.find('AutomationWorkspace').props.frame.header();
 await step(ui,()=>pageHeader().props.areaCrumb.onSelect());
 check([navigator().props.open,pageHeader().props.areaCrumb.expanded,item('automation').expanded],[true,true,true],'the crumb button opens the overlay; every opener reports it');
 await step(ui,()=>ui.find('NavList').props.onSelect('automation.drift'));
 check([navigator().props.open,ui.location.hash],[false,'#automation/drift'],'a page choice closes it');

 // A layer opened while the overlay is open closes the overlay first: the overlay paints above the palette, Help and the
 // Jobs sheet, and its scrim leaves the top bar tappable (search, help) next to F1, T, Ctrl K, / and the Jobs item.
 const layers=[
  ['the top-bar search',()=>topbar().props.onSearch(),()=>ui.find('CommandPalette').props.open],
  ['Ctrl K',()=>ui.shortcuts().palette(),()=>ui.find('CommandPalette').props.open],
  ['/ outside the fleet search',()=>ui.shortcuts().search(),()=>ui.find('CommandPalette').props.open],
  ['the top-bar help button',()=>topbar().props.onHelp(),()=>ui.find('HelpPanel').props.open],
  ['F1',()=>ui.shortcuts().help(),()=>ui.find('HelpPanel').props.open],
  ['T',()=>ui.shortcuts().jobs(),()=>ui.find('JobSheet').props.open],
  ['the Jobs item',()=>rail().props.jobs.onSelect(),()=>ui.find('JobSheet').props.open],
 ];
 for(const [name,open,shown] of layers){
  ui=await phone('#settings/audit');
  await step(ui,()=>topbar().props.onToggleNavigator());
  check(navigator().props.open,true,`${name}: the overlay is open`);
  await step(ui,open);
  check([navigator().props.open,topbar().props.navigatorOpen,shown()],[false,false,true],`${name} closes the navigator overlay and opens its layer above the page`);
 }
 // The palette's Help action (opened from the palette, which already closed the overlay) leaves it closed as well.
 ui=await phone('#settings/audit');
 await step(ui,()=>topbar().props.onToggleNavigator());
 await step(ui,()=>ui.find('CommandPalette').props.getItems().find(entry=>entry.id==='action-help').run());
 check([navigator().props.open,ui.find('HelpPanel').props.open,ui.find('CommandPalette').props.open],[false,true,false],'the palette Help action opens Help with the overlay closed');
 const consoleSource=fs.readFileSync('ui/shell/console.tsx','utf8');
 ok(consoleSource.includes("if(view==='devices'&&field){setDrawerOpen(false);field.focus();}"),'/ on the fleet closes the overlay before it focuses the search field behind it');

 // Help stays open while the workspace changes and shows the topic of the new route; the palette closes it.
 ui=await phone('#devices');
 await step(ui,()=>ui.shortcuts().help());
 check([ui.find('HelpPanel').props.open,ui.find('HelpPanel').props.route.view],[true,'devices'],'F1 opens Help');
 await step(ui,()=>ui.inventory().props.onDevice('a1'));
 check([ui.find('HelpPanel').props.open,ui.find('HelpPanel').props.route],[true,{view:'device',deviceId:'a1',deviceSection:'overview'}],'a tree choice keeps Help open with the route of the device');
 await step(ui,()=>ui.find('Topbar').props.onSearch());
 check([ui.find('HelpPanel').props.open,ui.find('CommandPalette').props.open],[false,true],'the top-bar search opens the palette and closes Help');

 // Demo mode: the top bar gets the demo pill and its End; no demo Notice in the workspace.
 await step(ui,()=>ui.find('FleetView')?.props.onDemo?.()??ui.find('CommandPalette').props.getItems().find(entry=>entry.id==='action-demo').run());
 check([ui.find('Topbar').props.demo,ui.find('Topbar').props.status,ui.all('Notice').filter(notice=>notice.props.tone==='info').length],[true,'',0],'demo: the pill in place of the freshness, no banner');
 await step(ui,()=>ui.find('Topbar').props.onEndDemo());
 check(ui.find('Topbar').props.demo,false,'End turns demo mode off');

 // Jobs: the bottom-bar item opens the sheet; T too; Show all jobs and a chosen job close it.
 const jobs=[{id:'j1',serverId:'a1',action:'refresh',state:'running',createdAt:now-5000,claimedAt:now-4000},{id:'j2',serverId:'a2',action:'refresh',state:'pending',createdAt:now-3000},{id:'j3',serverId:'a2',action:'refresh',state:'succeeded',createdAt:now-90000}];
 ui=await phone('#devices',{data:{jobs}});
 const sheet=()=>ui.find('JobSheet');
 check([rail().props.jobs.count,rail().props.jobs.open,sheet().props.open],[2,false,false],'the Jobs item counts the running and waiting jobs');
 await step(ui,()=>rail().props.jobs.onSelect());
 check([sheet().props.open,rail().props.jobs.open,ui.find('JobDock').props.open],[true,true,true],'the Jobs item opens the sheet (jobsOpen drives both forms; CSS hides the dock)');
 ok(sheet().props.returnFocus===rail().props.jobsRef,'focus returns to the Jobs item');
 await step(ui,()=>ui.shortcuts().jobs());
 check(sheet().props.open,false,'T closes it');
 await step(ui,()=>ui.shortcuts().jobs());
 check(sheet().props.open,true,'and T opens it');
 await step(ui,()=>sheet().props.onShowAll());
 check([sheet().props.open,ui.location.hash],[false,'#devices/history'],'Show all jobs opens All devices › History › Jobs and closes the sheet');
 await step(ui,()=>rail().props.jobs.onSelect());
 await step(ui,()=>sheet().props.onSelect(jobs[0]));
 const detail=ui.find('JobDetailDrawer');
 check([sheet().props.open,detail.props.open,detail.props.job?.id],[false,true,'j1'],'a job choice closes the sheet and opens the job detail drawer');
 const toaster=ui.find('Toaster');
 check([toaster.props.offset.bottom,toaster.props.mobileOffset.bottom],['calc(70px + env(safe-area-inset-bottom))','calc(70px + env(safe-area-inset-bottom))'],'toasts sit above the bottom bar');
}
// Above 900px: T toggles the dock as before, the sheet stays closed, the toggle keeps aria-pressed (overlay false).
{
 const ui=await harness('#devices');
 ui.shortcuts().jobs();ui.render();await ui.settle();
 check([ui.find('JobDock').props.open,ui.find('JobSheet').props.open,ui.find('Topbar').props.overlay,ui.find('Toaster').props.offset.bottom],[true,false,false,64],'wide: T opens the dock, not the sheet');
 check(ui.find('Rail').props.items.map(entry=>entry.expanded),[undefined,undefined,undefined,undefined],'wide: no rail item carries aria-expanded');
}
console.log(`PASS console navigation (${checks} checks): old hashes replaced in place on load, hashchange and popstate; tabs and subtabs with history entries and reloads; routed Configuration subtabs with the fallback; the Ungrouped scopes with their empty state and palette entries; Add device and Move devices here per scope and viewer; Add device in Devices with its crumbs; the agent pages in Settings; Customers for every Owner; settings, automation, crumb button, rail, G shortcuts and palette from the model; the device keys 1–9, the assistant drawer without a route, and the Permissions and Server roles fallbacks. Also: the agent pages in Settings without AgentsArea; one page header per settings page with the page primary on two pages; the routed Notification channels tabs; the refresh count of the settings frame; at 900px or narrower the navigator overlay (toggle, active bottom-bar item, crumb button, Esc, route change), Help across routes, the demo pill wiring and the Jobs sheet.`);
