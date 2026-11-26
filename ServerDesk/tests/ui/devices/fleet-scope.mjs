// The shared device scopes of the fleet view (ui/devices/fleet/fleet-scope.ts): which devices
// "All devices", "Ungrouped", a group and a customer show, when the customer
// view may open, and the tab list the scopes share.
import assert from 'node:assert/strict';
import '../../support/register.mjs';

const {scopeDevices,customerViewAvailable,fleetScopeTabs,scopeTabs,scopeTabGroups,scopeTabGroup}=await import('../../../ui/devices/fleet/fleet-scope.ts');
let checks=0;

const devices=[
 {id:'d1',groupId:'g1',groups:[{id:'g1',name:'Root',parentId:null,depth:0,direct:true}],customerId:'cA'},
 {id:'d2',groupId:'g2',groups:[{id:'g1',name:'Root',parentId:null,depth:0,direct:false},{id:'g2',name:'Child',parentId:'g1',depth:1,direct:true}],customerId:'cB'},
 {id:'d3',groupId:null,groups:[],customerId:'cA'},
 {id:'d4',groupId:'legacy'},
 {id:'d5',customerId:'cB'},
];
const ids=list=>list.map(device=>device.id);

// all: every device, as a new list.
const all=scopeDevices(devices,{type:'all'});
assert.deepEqual(ids(all),['d1','d2','d3','d4','d5']);assert.notEqual(all,devices,'a copy, not the input');checks+=2;
// unassigned: neither groups nor a legacy groupId.
assert.deepEqual(ids(scopeDevices(devices,{type:'unassigned'})),['d3','d5']);checks++;
// group: direct and inherited membership, and the legacy groupId.
assert.deepEqual(ids(scopeDevices(devices,{type:'group',id:'g1'})),['d1','d2'],'inherited membership through groups');
assert.deepEqual(ids(scopeDevices(devices,{type:'group',id:'g2'})),['d2']);
assert.deepEqual(ids(scopeDevices(devices,{type:'group',id:'legacy'})),['d4'],'legacy groupId');
assert.deepEqual(ids(scopeDevices(devices,{type:'group',id:'none'})),[]);checks+=4;
// customer: only matching customerId, in input order; a device without customerId never matches.
assert.deepEqual(ids(scopeDevices(devices,{type:'customer',id:'cA'})),['d1','d3']);
assert.deepEqual(ids(scopeDevices(devices,{type:'customer',id:'cB'})),['d2','d5']);
assert.deepEqual(ids(scopeDevices(devices,{type:'customer',id:'cGone'})),[]);
assert.deepEqual(ids(scopeDevices([...devices].reverse(),{type:'customer',id:'cA'})),['d3','d1'],'input order');checks+=4;

// The old inline filter of console.tsx gives the same results for all, unassigned and groups.
const inline=(servers,groupFilter)=>servers.filter(server=>groupFilter==='all'||groupFilter==='unassigned'&&!(server.groups?.length||server.groupId)||server.groups?.some(group=>group.id===groupFilter)||server.groupId===groupFilter);
for(const filter of ['all','unassigned','g1','g2','legacy','none']){
 const scope=filter==='all'?{type:'all'}:filter==='unassigned'?{type:'unassigned'}:{type:'group',id:filter};
 assert.deepEqual(scopeDevices(devices,scope),inline(devices,filter),filter);checks++;
}

// customerViewAvailable: two or more visible customers, and this one among them.
const two=[{id:'cA',name:'A'},{id:'cB',name:'B'}];
assert.equal(customerViewAvailable(two,'cA'),true);assert.equal(customerViewAvailable(two,'cB'),true);
assert.equal(customerViewAvailable(undefined,'cA'),false,'no list (demo, not loaded)');
assert.equal(customerViewAvailable([],'cA'),false,'empty list');
assert.equal(customerViewAvailable([two[0]],'cA'),false,'a single customer');
assert.equal(customerViewAvailable(two,'cX'),false,'an unknown id');
assert.equal(customerViewAvailable(two,''),false,'no id');assert.equal(customerViewAvailable(two,undefined),false);checks+=8;

// The five scope tabs: Devices, Monitoring, Inventory, History and Configuration (scopeTabGroups), and the fleet tabs in tab and
// subtab order, each with its tab. The first subtab is the default.
assert.deepEqual(scopeTabGroups.map(group=>[group.id,group.label,group.subtabs??null]),[['devices','tree.devices',null],['monitoring','fleet.tabs.monitoring','fleet.subtabs.monitoring'],['inventory','fleet.tabs.inventory','fleet.subtabs.inventory'],['history','fleet.tabs.history','fleet.subtabs.history'],['configuration','fleet.tabs.configuration','fleet.subtabs.configuration']]);
assert.deepEqual(fleetScopeTabs.map(tab=>[tab.group,tab.id]),[['devices','devices'],...['problems','alarms','alerts','notifications'].map(id=>['monitoring',id]),
 ...['software','extensions','drivers','certificates','autostart','os-support','encryption','protection','reliability'].map(id=>['inventory',id]),
 ['history','jobs'],['history','access'],...['tags','permissions','settings'].map(id=>['configuration',id])]);
assert.deepEqual(fleetScopeTabs.map(tab=>tab.label),['tree.devices','fleet.alarms.byDevice','fleet.alarms.byAlarm','alertRules.title','fleet.config.notificationRules','software.title','extensions.tab','drivers.title','certificates.title','autostart.title','osSupport.title','encryption.title','protection.title','reliability.title','history.tab.jobs','history.tab.access','tags.title','tree.permissions','fleet.tabs.settings']);
assert.ok(fleetScopeTabs.every(tab=>!('icon' in tab)),'scope tabs carry no icon');checks+=4;
assert.deepEqual(['problems','alarms','alerts','notifications','software','protection','jobs','access','tags','settings','devices','nothing'].map(scopeTabGroup),['monitoring','monitoring','monitoring','monitoring','inventory','inventory','history','history','configuration','configuration','devices','devices'],'the tab of each fleet tab');checks++;
// The scope tab of the former Alarms subtabs and rules is Monitoring.
assert.equal(scopeTabGroup('alerts'),'monitoring');checks++;
// Monitoring: By device, By alarm, Alert rules, Notification rules on All devices, a group and a customer (a customer has
// its own alert rule level); By device and By alarm only on both Ungrouped scopes. Configuration: Tags
// (group), Permissions (All devices, group), General (group); a customer and Ungrouped have none.
const shared=['devices','problems','alarms'],reports=['software','extensions','drivers','certificates','autostart','os-support','encryption','protection','reliability','jobs','access'];
assert.deepEqual(scopeTabs('all').map(tab=>tab.id),[...shared,'alerts','notifications',...reports,'permissions']);
assert.deepEqual(scopeTabs('group').map(tab=>tab.id),[...shared,'alerts','notifications',...reports,'tags','permissions','settings']);
assert.deepEqual(scopeTabs('unassigned').map(tab=>tab.id),[...shared,...reports]);
assert.deepEqual(scopeTabs('customer').map(tab=>tab.id),[...shared,'alerts','notifications',...reports]);checks+=4;

// The tags tab is part of a group link only (Configuration → Tags); the old link opens it too.
const {parseConsoleRoute,consoleRouteHash}=await import('../../../lib/console-route.ts');
assert.equal(consoleRouteHash({view:'devices',groupId:'g-1',tab:'tags'}),'#devices/group/g-1/configuration/tags');
assert.deepEqual(parseConsoleRoute('#devices/group/g-1/tags'),{view:'devices',groupId:'g-1',tab:'tags'});
assert.deepEqual(parseConsoleRoute('#devices/group/g-1/configuration/tags'),{view:'devices',groupId:'g-1',tab:'tags'});checks++;
assert.equal(consoleRouteHash({view:'devices',groupId:'all',tab:'tags'}),'#devices','All devices has no tags tab in its link');
assert.equal(consoleRouteHash({view:'devices',customerId:'c-1',tab:'tags'}),'#devices/customer/c-1','nor a customer');checks+=4;

// Monitoring › By alarm (monitoring/list) is part of the link of every scope type, round-trips, and an unknown tab still falls back to devices.
for(const [route,hash] of [[{view:'devices',tab:'alarms'},'#devices/monitoring/list'],[{view:'devices',groupId:'g-1',tab:'alarms'},'#devices/group/g-1/monitoring/list'],[{view:'devices',customerId:'c-1',tab:'alarms'},'#devices/customer/c-1/monitoring/list'],[{view:'devices',groupId:'unassigned',tab:'alarms'},'#devices/ungrouped/monitoring/list']]){
 assert.equal(consoleRouteHash(route),hash);assert.deepEqual(parseConsoleRoute(hash),route,hash);checks+=2;
}
assert.deepEqual(parseConsoleRoute('#devices/group/g-1/alarmz'),{view:'devices',groupId:'g-1',tab:'devices'},'an unknown tab falls back to devices');checks++;
// Monitoring › By device (problems) sits right after devices on every scope type, round-trips on all four, and Back/Forward reads the same hashes.
for(const type of ['all','group','unassigned','customer']){const tabs=scopeTabs(type);assert.equal(tabs[1].id,'problems',type);assert.equal(tabs[1].label,'fleet.alarms.byDevice');assert.equal('icon' in tabs[1],false);checks+=3;}
for(const [route,hash] of [[{view:'devices',tab:'problems'},'#devices/monitoring'],[{view:'devices',groupId:'g-1',tab:'problems'},'#devices/group/g-1/monitoring'],[{view:'devices',customerId:'c-1',tab:'problems'},'#devices/customer/c-1/monitoring'],[{view:'devices',groupId:'unassigned',tab:'problems'},'#devices/ungrouped/monitoring']]){
 assert.equal(consoleRouteHash(route),hash);assert.deepEqual(parseConsoleRoute(hash),route,hash);checks+=2;
}
assert.deepEqual(parseConsoleRoute('#devices/customer/c-1/problemz'),{view:'devices',customerId:'c-1',tab:'devices'},'an unknown customer tab falls back to devices');checks++;

// The start page: an empty hash opens the Dashboard for the value dashboard and Monitoring › By device for alarms (or the older problems); a link always wins.
const {startHash,startPages}=await import('../../../lib/console-route.ts');
assert.deepEqual(startPages,['dashboard','devices','alarms'],'the stored values');checks++;
for(const [hash,stored,expected,label] of [
 ['','dashboard','#dashboard','an empty hash with dashboard'],
 ['#','dashboard','#dashboard','a bare # with dashboard'],
 ['#devices','dashboard','#devices','a link wins over the start page dashboard'],
 ['','alarms','#devices/monitoring','an empty hash with alarms'],
 ['#','alarms','#devices/monitoring','a bare # with alarms'],
 ['#devices/inventory','alarms','#devices/inventory','a link wins over the start page alarms'],
 ['','problems','#devices/monitoring','an empty hash with the older problems'],
 ['#','problems','#devices/monitoring','a bare # with problems'],
 ['#devices/alarms','problems','#devices/alarms','a link wins over the start page'],
 ['#devices','problems','#devices','#devices is a link too'],
 ['','devices','','devices keeps the hash'],
 ['',null,'','a missing value acts as devices'],
 ['','"problems"','','an invalid value acts as devices'],
 ['',42,'','a number acts as devices'],
]){assert.equal(startHash(hash,stored),expected,label);checks++;}
// Inventory › Extensions sits right after Software on every scope type and round-trips on all of them.
for(const type of ['all','group','unassigned','customer']){const tabs=scopeTabs(type),at=tabs.findIndex(tab=>tab.id==='extensions');assert.equal(tabs[at-1].id,'software',type);assert.deepEqual([tabs[at].label,'icon' in tabs[at]],['extensions.tab',false],type);checks+=2;}
for(const [route,hash] of [[{view:'devices',tab:'extensions'},'#devices/inventory/extensions'],[{view:'devices',groupId:'g-1',tab:'extensions'},'#devices/group/g-1/inventory/extensions'],[{view:'devices',customerId:'c-1',tab:'extensions'},'#devices/customer/c-1/inventory/extensions'],[{view:'devices',groupId:'unassigned',tab:'extensions'},'#devices/ungrouped/inventory/extensions'],[{view:'devices',customerId:'c-1',groupId:'unassigned',tab:'extensions'},'#devices/customer/c-1/ungrouped/inventory/extensions']]){
 assert.equal(consoleRouteHash(route),hash);assert.deepEqual(parseConsoleRoute(hash),route,hash);checks+=2;
}
console.log(`${checks} fleet scope checks passed.`);
