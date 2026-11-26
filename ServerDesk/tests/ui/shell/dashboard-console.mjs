// The Dashboard in the running console (ui/shell/console.tsx with tests/support/console-harness.mjs, docs/dashboard.md):
// a console opened without a hash shows the Dashboard for the start page dashboard and the former start views for
// devices and alarms, a link always wins; the Dashboard has its rail item, no navigator, its page header and help
// route; the rail, G H, the palette page and Back and Forward open it; the view gets the devices, the jobs, the
// layout of the account, the Owner flag, the pinned devices, the customers and the audit entries; a link of a widget
// opens its place with a history entry; a saved layout shows at once and stays until a console load carries the same;
// the palette action asks for the edit mode;
// sample devices get no stored layout.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {consoleHarness} from '../../support/console-harness.mjs';
const {navNode}=await import('../../../ui/shell/nav-model.ts');
const {builtInDashboardLayout,moveDashboardWidget,removeDashboardWidget}=await import('../../../lib/dashboard-layout.ts');
const {translate}=await import('../../../lib/i18n/translate.ts');

let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const de=key=>translate('de',key);
const now=Date.now();
const device=(id,name)=>({id,name,createdAt:now-3600000,lastSeen:now-30000,revoked:0,management:1,snapshot:null,permissions:['view'],groupId:null,groupName:null,groups:[]});
const servers=[device('a1','ALPHA-01'),device('b1','BETA-01')];
const jobs=[{id:'j1',serverId:'a1',action:'restart-service',target:'Spooler',state:'succeeded',createdAt:now-60000,claimedAt:now-50000,result:null,actor:'owner'}];
const owner={id:'owner',label:'owner@example.test',permissions:['*']},member={id:'member',label:'member@example.test',permissions:[]};
const custom=moveDashboardWidget(builtInDashboardLayout,'jobs',0),portalDefault=removeDashboardWidget(builtInDashboardLayout,'updates');
const dashboard={own:custom,default:portalDefault};
const customers=[{id:'k1',name:'Kiwi'},{id:'k2',name:'Apple'}],audit=[{id:1,at:1,actor:'anna',action:'session.signIn',target:'',serverId:null,scope:'portal'}],deviceAudit=[{id:2,at:2,actor:'anna',action:'device.rename',target:'a1',serverId:'a1',scope:'device'}];
const base={servers,jobs,deviceGroups:[],permissionDevices:[],customers,audit,deviceAudit,maintenance:null,preferences:{consoleBackground:true,pinnedDeviceIds:['a1'],dashboard}};
const start=async({hash='',startPage='dashboard',viewer=owner,data}={})=>{const ui=consoleHarness({viewer,hash,startPage,base,data});await ui.settle();return ui;};
const view=ui=>ui.find('DashboardView');

// ---- the start page ----
let ui=await start();
check([ui.history,ui.location.hash,!!view(ui),ui.fleet()],[[['replace','#dashboard']],'#dashboard',true,undefined],'no hash and the start page dashboard: the Dashboard, replaced in place without a history entry');
ui=await start({startPage:'devices'});
check([ui.history.filter(([type])=>type==='push'),view(ui),ui.fleet().props.tab],[[],undefined,'devices'],'the start page devices opens All devices, as before');
ui=await start({startPage:'alarms'});
check([ui.location.hash,view(ui),ui.fleet().props.tab],['#devices/monitoring',undefined,'problems'],'the start page alarms opens Monitoring, as before');
ui=await start({hash:'#devices'});
check([ui.history,view(ui),!!ui.fleet()],[[],undefined,true],'a link with a hash wins over the start page');
ui=await start({hash:'#dashboard',startPage:'devices'});
check([ui.history,!!view(ui)],[[],true],'the link #dashboard opens the Dashboard for every start page');
ui=await start({hash:'#dashboard/anything'});
check([ui.location.hash,!!view(ui)],['#dashboard',true],'a longer link is replaced by its canonical form');

// ---- the page in the frame ----
ui=await start();
const rail=()=>ui.find('Rail');
check([rail().props.area,rail().props.items.map(item=>item.id),rail().props.items[0].label,rail().props.items[0].shortcut],['dashboard',['dashboard','devices','automation','settings'],de('rail.dashboard'),'G H'],'the rail marks the Dashboard, its first item');
check([ui.find('Navigator'),ui.find('Topbar').props.canToggleNavigator,ui.find('InventoryTree')],[undefined,false,undefined],'the Dashboard has no navigator');
check(ui.find('HelpHost').props.route,{view:'dashboard'},'Help gets the Dashboard route');
const props=view(ui).props;
check([props.servers,props.jobs,props.viewer,props.demo,props.owner,props.narrow,props.preference,props.refreshKey,props.customizeRequest],[servers,jobs,owner,false,true,false,dashboard,0,0],'the view gets the devices, the jobs, the viewer, the layout of the account and the Owner flag');
check([props.pinnedIds,props.customers,props.audit,props.deviceAudit],[['a1'],customers,audit,deviceAudit],'and what the widgets read beyond the devices: the pinned devices, the visible customers and the audit entries');
const header=props.header('ACTIONS');
check([header.type,header.props.title,header.props.subtitle,header.props.actions,header.props.compact,header.props.primary,header.props.crumbs],['PageHeader',de('rail.dashboard'),de('dashboard.subtitle'),'ACTIONS',false,undefined,undefined],'the page header of the node: title, subtitle and the page actions, no primary and no crumbs');
check(props.header('ACTIONS','SAVE').props.primary,'SAVE','in edit mode the page hands its primary action (Save) to the header');
check(view(await start({viewer:member})).props.owner,false,'an account that is no Owner');

// ---- navigation ----
ui=await start();
view(ui).props.onNavigate('#device/a1/monitoring');ui.render();await ui.settle();
check([ui.location.hash,ui.history.at(-1),ui.device().props.server.id,ui.device().props.section,view(ui)],['#device/a1/monitoring',['push','#device/a1/monitoring'],'a1','monitoring',undefined],'a widget link opens its place with a history entry');
await ui.navigateTo('#dashboard');
check([!!view(ui),ui.device(),rail().props.area],[true,undefined,'dashboard'],'Back returns to the Dashboard');
view(ui).props.onNavigate('#devices/history');ui.render();await ui.settle();
check([ui.location.hash,ui.fleet().props.tab],['#devices/history','jobs'],'Show all jobs opens History › Jobs');
rail().props.items.find(item=>item.id==='dashboard').onSelect();ui.render();await ui.settle();
check([ui.location.hash,ui.history.at(-1),!!view(ui)],['#dashboard',['push','#dashboard'],true],'the rail item opens the Dashboard with a history entry');
rail().props.items.find(item=>item.id==='devices').onSelect();ui.render();await ui.settle();
check([ui.location.hash,!!ui.fleet(),view(ui)],['#devices/history',true,undefined],'Devices opens All devices from the Dashboard, on the tab it showed last');
ui.shortcuts().go(navNode('dashboard'));ui.render();await ui.settle();
check([ui.location.hash,!!view(ui)],['#dashboard',true],'G H opens the Dashboard');
view(ui).props.onAddDevice();ui.render();await ui.settle();
check([ui.location.hash,!!ui.find('AddDevicePage')],['#devices/add',true],'Add device of the empty Dashboard opens the page for the Owner');
ui=await start({viewer:member});
view(ui).props.onAddDevice();ui.render();await ui.settle();
check(ui.location.hash,'#dashboard','an account that is no Owner stays');

// ---- the palette ----
ui=await start({hash:'#devices'});
let items=ui.find('CommandPalette').props.getItems();
ok(!items.some(item=>item.id==='action-customize-dashboard'),'no Customize action outside the Dashboard');
items.find(item=>item.id==='page-dashboard').run();ui.render();await ui.settle();
check([ui.location.hash,!!view(ui)],['#dashboard',true],'the palette page opens the Dashboard');
items=ui.find('CommandPalette').props.getItems();
const customize=items.find(item=>item.id==='action-customize-dashboard');
check([customize.label,customize.group],[de('palette.action.customizeDashboard'),de('rail.dashboard')],'the Customize action on the Dashboard');
customize.run();ui.render();await ui.settle();
check(view(ui).props.customizeRequest,1,'the action asks the view to turn on the edit mode');
customize.run();ui.render();await ui.settle();
check(view(ui).props.customizeRequest,2,'each run is a new request');

// ---- a saved layout shows at once and stays until a load carries the same ----
ui=await start();
const saved={own:null,default:custom};
view(ui).props.onPreference(saved);ui.render();await ui.settle();
check([view(ui).props.preference,ui.refreshes.length],[saved,1],'the saved layout shows at once and the console loads again');
// A load that started before the save still carries the old layout: the saved one stays.
ui.setData({preferences:{...base.preferences,dashboard:{own:custom,default:portalDefault}}});await ui.settle();
check(view(ui).props.preference,saved,'an older load does not bring the old layout back');
// The load after the save carries the same: the console data is the source again.
const loaded={own:null,default:[...custom]};
ui.setData({preferences:{...base.preferences,dashboard:loaded}});await ui.settle();
check(view(ui).props.preference===loaded,true,'the next load carries the saved layout; the console data is the source again');
const later={own:portalDefault,default:custom};
ui.setData({preferences:{...base.preferences,dashboard:later}});await ui.settle();
check(view(ui).props.preference,later,'a later change from the server shows');
// A save the server does not confirm in the next two loads: the server's layout wins.
view(ui).props.onPreference(saved);ui.render();await ui.settle();
const other={own:custom,default:custom};
ui.setData({preferences:{...base.preferences,dashboard:{...other}}});await ui.settle();
check(view(ui).props.preference,saved,'the first differing load is waited out');
ui.setData({preferences:{...base.preferences,dashboard:{...other}}});await ui.settle();
check(view(ui).props.preference,other,'the second differing load wins');

// ---- data without a layout, and sample devices ----
ui=await start({data:{preferences:{consoleBackground:true,pinnedDeviceIds:[]}}});
check(view(ui).props.preference,undefined,'console data without a layout: the view falls back to the built-in layout');
ui=await start({hash:'#devices'});
ui.fleet().props.onDemo();ui.render();await ui.settle();
ui.shortcuts().go(navNode('dashboard'));ui.render();await ui.settle();
check([view(ui).props.demo,view(ui).props.preference,ui.find('CommandPalette').props.getItems().some(item=>item.id==='action-customize-dashboard')],[true,undefined,false],'sample devices: no stored layout and no Customize action');
check([view(ui).props.pinnedIds,view(ui).props.customers,view(ui).props.audit,view(ui).props.deviceAudit],[undefined,undefined,undefined,undefined],'sample devices: no pins, customers or audit entries of the portal reach the widgets');

// ---- the source ----
const source=readFileSync('ui/shell/console.tsx','utf8');
ok(source.includes("<Skeleton variant={view==='dashboard'?'cards':'table'}"),'the first load of the Dashboard shows the cards skeleton');
ok(/view==='dashboard'&&page&&<DashboardView/.test(source)&&source.includes("if(next==='dashboard')go({view:'dashboard'});"),'the console renders the view for its route and opens it from the rail');

console.log(`dashboard console: ${checks} checks passed`);
