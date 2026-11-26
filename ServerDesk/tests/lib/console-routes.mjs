// The route grammar of the console (lib/console-route.ts): every old hash canonicalizes to its new form (old links
// keep working and the console rewrites the address), every canonical hash round-trips, a tab or sub a scope type
// never has is the scope's Devices tab, the second segment after #devices is a reserved word, and the start page.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import '../support/register.mjs';

const {parseConsoleRoute,consoleRouteHash,deviceAssistantHash,startHash,automationPageTabs,settingsPageTabs,pageTabOf,pageTabsOf}=await import('../../lib/console-route.ts');
let checks=0;
const canonical=hash=>consoleRouteHash(parseConsoleRoute(hash));

// 1. Old fleet hashes (review §2.5), under #devices/, a group and a customer.
const fleetTabs=[
 ['problems','monitoring'],['jobs','history'],['access','history/access'],['software','inventory'],
 ['os-support','inventory/os-support'],['encryption','inventory/encryption'],['drivers','inventory/drivers'],['reliability','inventory/reliability'],
 ['certificates','inventory/certificates'],['autostart','inventory/autostart'],['protection','inventory/defender'],
 ['alerts','monitoring/alert-rules'],['notifications','monitoring/notification-rules'],
];
for(const prefix of ['#devices','#devices/group/g1','#devices/customer/c1']){
 for(const [old,next] of fleetTabs){
  // A customer has its own alert rules, so its old alerts link opens them too.
  assert.equal(canonical(`${prefix}/${old}`),`${prefix}/${next}`,`${prefix}/${old}`);checks++;
 }
}
const oldFleet=[
 ['#audit/jobs','#devices/history'],
 ['#devices/group/g1/tags','#devices/group/g1/configuration/tags'],
 ['#devices/tags','#devices'],['#devices/customer/c1/tags','#devices/customer/c1'],
 ['#devices/group/unassigned','#devices/ungrouped'],
 ['#devices/group/unassigned/problems','#devices/ungrouped/monitoring'],
 ['#devices/group/unassigned/jobs','#devices/ungrouped/history'],
 ['#devices/group/unassigned/protection','#devices/ungrouped/inventory/defender'],
 ['#devices/group/unassigned/alerts','#devices/ungrouped'],
 // The former Alarms tab is Monitoring: #…/alarms is By device, #…/alarms/list By alarm.
 ['#devices/alarms','#devices/monitoring'],['#devices/group/g1/alarms','#devices/group/g1/monitoring'],['#devices/customer/c1/alarms','#devices/customer/c1/monitoring'],
 ['#devices/alarms/list','#devices/monitoring/list'],['#devices/group/g1/alarms/list','#devices/group/g1/monitoring/list'],['#devices/ungrouped/alarms','#devices/ungrouped/monitoring'],
 ['#devices/customer/c1/ungrouped/alarms/list','#devices/customer/c1/ungrouped/monitoring/list'],['#devices/alarms/other','#devices/monitoring'],
 // The bare Configuration link was the alert rules link: Alert rules on All devices and groups, Notification rules on a
 // customer, Devices on Ungrouped; configuration/notification-rules is Monitoring › Notification rules.
 ['#devices/configuration','#devices/monitoring/alert-rules'],['#devices/group/g1/configuration','#devices/group/g1/monitoring/alert-rules'],
 ['#devices/customer/c1/configuration','#devices/customer/c1/monitoring/notification-rules'],['#devices/ungrouped/configuration','#devices/ungrouped'],
 ['#devices/customer/c1/ungrouped/configuration','#devices/customer/c1/ungrouped'],
 ['#devices/configuration/notification-rules','#devices/monitoring/notification-rules'],['#devices/group/g1/configuration/notification-rules','#devices/group/g1/monitoring/notification-rules'],
 ['#devices/customer/c1/configuration/notification-rules','#devices/customer/c1/monitoring/notification-rules'],
];
for(const [old,expected] of oldFleet){assert.equal(canonical(old),expected,old);checks++;}

// 2. Old device hashes.
const oldDevices=[
 ['#devices/d1','#device/d1'],['#devices/d1/overview','#device/d1'],['#devices/d1/unknown','#device/d1'],
 ['#devices/d1/hardware','#device/d1/hardware'],['#devices/d1/hardware/cpu','#device/d1/hardware/cpu'],['#devices/d1/hardware/overview','#device/d1/hardware'],
 ['#devices/d1/hardware/gpu','#device/d1/hardware/gpu'],['#devices/d1/hardware/gpu/2','#device/d1/hardware/gpu/2'],['#devices/d1/hardware/gpu/16','#device/d1/hardware/gpu/16'],
 ['#devices/d1/hardware/gpu/1','#device/d1/hardware/gpu'],['#devices/d1/hardware/gpu/17','#device/d1/hardware/gpu'],
 ['#devices/d1/diagnostics','#device/d1/diagnostics'],['#devices/d1/diagnostics/events','#device/d1/diagnostics/events'],['#devices/d1/diagnostics/processes','#device/d1/diagnostics'],
 ['#devices/d1/management','#device/d1/management'],
 ...['services','updates','storage','network','accounts','features','defender','system'].map(sub=>[`#devices/d1/management/${sub}`,`#device/d1/management${sub==='services'?'':'/'+sub}`]),
 ['#devices/d1/management/software','#device/d1/software'],
 ...['drivers','certificates','autostart'].map(sub=>[`#devices/d1/management/${sub}`,`#device/d1/software/${sub}`]),
 ['#devices/d1/files','#device/d1/remote'],['#devices/d1/remote','#device/d1/remote'],['#devices/d1/terminal','#device/d1/remote/terminal'],['#devices/d1/rdp','#device/d1/remote/rdp'],
 ['#devices/d1/runbooks','#device/d1/automation'],['#devices/d1/automation','#device/d1/automation'],['#devices/d1/desired','#device/d1/automation/desired'],['#devices/d1/drift','#device/d1/automation/drift'],
 ['#devices/d1/history','#device/d1/history'],
 // The former Server roles area has no redirect: #devices/<id>/roles opens the device Overview; extensions is the area now.
 ['#devices/d1/roles','#device/d1'],['#devices/d1/roles/dhcp','#device/d1'],['#devices/d1/extensions','#device/d1/extensions'],['#devices/d1/extensions/dns','#device/d1/extensions/dns'],
 // The Assistant is a drawer without a route: its old link opens the device (the console opens the drawer, see section 8).
 ['#devices/d1/alerts','#device/d1/monitoring/alert-rules'],['#devices/d1/permissions','#device/d1/configuration/permissions'],['#devices/d1/assistant','#device/d1'],
 ['#devices/d1/configuration','#device/d1/monitoring/alert-rules'],['#devices/d1/configuration/permissions','#device/d1/configuration/permissions'],
 ['#devices/d1/monitoring','#device/d1/monitoring'],['#devices/d1/monitoring/notification-rules','#device/d1/monitoring/notification-rules'],
 ['#devices/a%2Fb/overview','#device/a%2Fb'],
];
for(const [old,expected] of oldDevices){assert.equal(canonical(old),expected,old);checks++;}

// 3. Old page hashes.
const oldPages=[
 ['#agents','#devices/add'],['#agents/installation','#devices/add'],['#agents/unknown','#devices/add'],['#agents/installation/group/g1','#devices/add/group/g1'],
 ['#agents/releases','#settings/agent-releases'],['#agents/troubleshooting','#settings/agent-troubleshooting'],['#agents/uninstall','#settings/agent-troubleshooting'],
 ['#administration','#settings/accounts'],['#administration/accounts','#settings/accounts'],['#access/accounts','#settings/accounts'],
 ['#administration/usergroups','#settings/user-groups'],['#administration/roles','#settings/roles'],['#access/permissions','#settings/roles'],
 ...['entra','customers','vulnerabilities','assistant'].map(page=>[`#administration/${page}`,`#settings/${page}`]),
 // The License page is gone: its old links open Usage data.
 ['#administration/license','#settings/usage-data'],['#settings/license','#settings/usage-data'],
 ['#administration/settings','#settings/sessions'],['#administration/maintenance','#settings/retention'],['#administration/notifications','#settings/notification-channels'],
 ['#administration/audit','#settings/audit'],['#audit','#settings/audit'],['#administration/unknown','#settings/accounts'],
 ['#access/groups','#devices'],['#access','#devices'],['#unknown','#devices'],['','#devices'],['#','#devices'],['#devices/%E0','#devices'],['#device/%E0/hardware','#devices'],
 ['#account','#account'],['#account/other','#account'],
];
for(const [old,expected] of oldPages){assert.equal(canonical(old),expected,old||'(empty)');checks++;}

// 4. Canonical hashes round-trip.
const canonicalHashes=[
 '#devices','#devices/monitoring','#devices/monitoring/list','#devices/monitoring/alert-rules','#devices/monitoring/notification-rules','#devices/history','#devices/history/access',
 '#devices/inventory',...['extensions','drivers','certificates','autostart','os-support','encryption','defender','reliability'].map(sub=>'#devices/inventory/'+sub),
 '#devices/configuration/permissions',
 '#devices/group/g1','#devices/group/g1/monitoring','#devices/group/g1/monitoring/list','#devices/group/g1/monitoring/alert-rules','#devices/group/g1/monitoring/notification-rules',
 '#devices/group/g1/configuration/tags','#devices/group/g1/configuration/permissions','#devices/group/g1/configuration/general','#devices/group/a%2Fb',
 '#devices/customer/c1','#devices/customer/c1/monitoring','#devices/customer/c1/monitoring/list','#devices/customer/c1/monitoring/alert-rules','#devices/customer/c1/monitoring/notification-rules','#devices/customer/c1/inventory/defender',
 '#devices/ungrouped','#devices/ungrouped/monitoring','#devices/ungrouped/monitoring/list','#devices/ungrouped/history/access','#devices/ungrouped/inventory/autostart',
 '#devices/customer/c1/ungrouped','#devices/customer/c1/ungrouped/monitoring','#devices/customer/c1/ungrouped/monitoring/list','#devices/customer/c1/ungrouped/inventory',
 '#devices/add','#devices/add/installer','#devices/add/customer/c1','#devices/add/group/g1','#devices/add/installer/customer/c1','#devices/add/installer/group/g1','#devices/add/customer/c1/group/g1','#devices/add/installer/customer/c1/group/g1','#devices/add/group/a%2Fb',
 '#device/d1','#device/d1/hardware','#device/d1/hardware/memory','#device/d1/hardware/gpu','#device/d1/hardware/gpu/2','#device/d1/hardware/gpu/16',
 '#device/d1/software','#device/d1/software/drivers','#device/d1/software/certificates','#device/d1/software/autostart',
 '#device/d1/diagnostics','#device/d1/diagnostics/connections',
 '#device/d1/management','#device/d1/management/updates','#device/d1/management/tasks','#device/d1/management/defender','#device/d1/management/system',
 '#device/d1/remote','#device/d1/remote/terminal','#device/d1/remote/rdp',
 '#device/d1/automation','#device/d1/automation/desired','#device/d1/automation/drift',
 '#device/d1/history','#device/d1/history/access',
 '#device/d1/monitoring','#device/d1/monitoring/alert-rules','#device/d1/monitoring/notification-rules',
 '#device/d1/extensions','#device/d1/extensions/dhcp','#device/d1/extensions/dns','#device/d1/extensions/dns/contoso.com','#device/d1/extensions/dns/_msdcs.contoso.com','#device/d1/extensions/dns/a%2Fb%20zone',
 '#device/d1/configuration/permissions','#device/a%2Fb',
 '#automation/runbooks','#automation/desired','#automation/drift',
 // Every tab of every automation page; the first tab is the default and never written.
 ...Object.entries(automationPageTabs).flatMap(([page,tabs])=>tabs.slice(1).map(tab=>`#automation/${page}/${tab}`)),
 ...['accounts','user-groups','roles','entra','sessions','customers','notification-channels','vulnerabilities','assistant','agent-releases','extensions','agent-troubleshooting','retention','audit','usage-data'].map(page=>'#settings/'+page),
 // The second tab of Notification channels (settingsPageTabs); Channels has no segment.
 '#settings/notification-channels/log',
 '#account',
];
for(const hash of canonicalHashes){assert.equal(canonical(hash),hash,hash);checks++;}
assert.equal(canonicalHashes.some(hash=>hash.endsWith('/uninstall')),false,'no uninstall route: Uninstall is a section of Agent troubleshooting');checks++;

// 5. Non-canonical forms of the new grammar.
const nonCanonical=[
 // Defaults are never written; an invalid sub is the default.
 ['#devices/monitoring/other','#devices/monitoring'],['#devices/monitoring/problems','#devices/monitoring'],['#devices/inventory/programs','#devices/inventory'],['#devices/history/jobs','#devices/history'],
 ['#devices/configuration/alert-rules','#devices/monitoring/alert-rules'],
 ['#device/d1/overview','#device/d1'],['#device/d1/unknown','#device/d1'],['#device/d1/hardware/overview','#device/d1/hardware'],['#device/d1/hardware/gpu/1','#device/d1/hardware/gpu'],['#device/d1/hardware/gpu/17','#device/d1/hardware/gpu'],
 ['#device/d1/software/programs','#device/d1/software'],['#device/d1/software/unknown','#device/d1/software'],['#device/d1/management/services','#device/d1/management'],
 // The old Management subareas of the read-only lists open the Software area (slice 6).
 ['#device/d1/management/software','#device/d1/software'],['#device/d1/management/drivers','#device/d1/software/drivers'],['#device/d1/management/certificates','#device/d1/software/certificates'],['#device/d1/management/autostart','#device/d1/software/autostart'],
 ['#device/d1/management/unknown','#device/d1/management'],['#device/d1/remote/files','#device/d1/remote'],['#device/d1/automation/runbooks','#device/d1/automation'],
 ['#device/d1/history/jobs','#device/d1/history'],['#device/d1/extensions/overview','#device/d1/extensions'],['#device/d1/extensions/dhcp/zone','#device/d1/extensions/dhcp'],
 // The removed Server roles links (no redirect): the device Overview and the Inventory default.
 ['#device/d1/server-roles','#device/d1'],['#device/d1/server-roles/dhcp','#device/d1'],['#device/d1/server-roles/dns/contoso.com','#device/d1'],['#devices/inventory/server-roles','#devices/inventory'],['#devices/group/g1/inventory/server-roles','#devices/group/g1/inventory'],
 // The device Configuration holds Permissions only, always written: the bare and the alert rules link are Monitoring › Alert rules.
 ['#device/d1/configuration','#device/d1/monitoring/alert-rules'],['#device/d1/configuration/alert-rules','#device/d1/monitoring/alert-rules'],['#device/d1/configuration/unknown','#device/d1/monitoring/alert-rules'],
 // The alarm history moved from History to Monitoring › Alarms; an unknown Monitoring sub opens Alarms.
 ['#device/d1/history/alarms','#device/d1/monitoring'],['#device/d1/monitoring/alarms','#device/d1/monitoring'],['#device/d1/monitoring/unknown','#device/d1/monitoring'],
 ['#device/d1/assistant','#device/d1'],['#device/d1/assistant/more','#device/d1'],['#device','#devices'],['#device/','#devices'],
 ['#automation','#automation/runbooks'],['#automation/other','#automation/runbooks'],
 ['#automation/runbooks/library','#automation/runbooks'],['#automation/desired/configurations','#automation/desired'],['#automation/drift/assignments','#automation/drift'],
 ['#automation/runbooks/unknown','#automation/runbooks'],['#automation/drift/runs','#automation/drift'],['#automation/desired/reference','#automation/desired'],['#automation/other/runs','#automation/runbooks/runs'],
 ['#settings','#settings/accounts'],['#settings/unknown','#settings/accounts'],['#settings/accounts/tab','#settings/accounts'],['#settings/agent-troubleshooting/other','#settings/agent-troubleshooting'],['#settings/agent-troubleshooting/uninstall','#settings/agent-troubleshooting'],
 ['#settings/notification-channels/other','#settings/notification-channels'],['#settings/notification-channels/channels','#settings/notification-channels'],['#settings/retention/log','#settings/retention'],
 ['#devices/add/unknown','#devices/add'],['#devices/add/group/g1/installer','#devices/add/installer/group/g1'],
];
for(const [hash,expected] of nonCanonical){assert.equal(canonical(hash),expected,hash);checks++;}

// 6. Invalid tabs and subs for a scope type are the scope's Devices tab.
const invalid=[
 ['#devices/customer/c1/configuration/permissions','#devices/customer/c1'],['#devices/customer/c1/configuration/tags','#devices/customer/c1'],['#devices/customer/c1/configuration/general','#devices/customer/c1'],
 ['#devices/ungrouped/configuration/notification-rules','#devices/ungrouped'],['#devices/ungrouped/configuration/permissions','#devices/ungrouped'],
 // Monitoring subtabs a scope type never has: Ungrouped has no rules.
 ['#devices/ungrouped/monitoring/alert-rules','#devices/ungrouped'],['#devices/ungrouped/monitoring/notification-rules','#devices/ungrouped'],
 ['#devices/customer/c1/ungrouped/monitoring/alert-rules','#devices/customer/c1/ungrouped'],
 ['#devices/configuration/tags','#devices'],['#devices/configuration/general','#devices'],
];
for(const [hash,expected] of invalid){assert.equal(canonical(hash),expected,hash);checks++;}

// 7. The reserved second segment: #devices/inventory/drivers is a scope route, any other word an old device link.
assert.deepEqual(parseConsoleRoute('#devices/inventory/drivers'),{view:'devices',tab:'drivers'});
for(const word of ['monitoring','alarms','inventory','history','configuration','group','customer','ungrouped','add','problems','jobs','software','alerts','notifications','tags'])assert.notEqual(parseConsoleRoute(`#devices/${word}/overview`).view,'device',word);
assert.deepEqual(parseConsoleRoute('#devices/server-1/hardware'),{view:'device',deviceId:'server-1',deviceSection:'hardware'},'any other word is a device');
// roles lost its meaning (no redirect): #devices/roles is an older link to the device with id roles.
assert.deepEqual([parseConsoleRoute('#devices/roles'),parseConsoleRoute('#devices/roles/overview')],[{view:'device',deviceId:'roles',deviceSection:'overview'},{view:'device',deviceId:'roles',deviceSection:'overview'}],'#devices/roles is a device link');checks++;
assert.deepEqual(parseConsoleRoute('#devices/customer/c1/ungrouped'),{view:'devices',customerId:'c1',groupId:'unassigned',tab:'devices'},'ungrouped is reserved after customer/<id>');
checks+=4;

// 8. The view and id fields, one hash per view.
const fields=[
 ['#devices',{view:'devices',tab:'devices'}],
 ['#devices/group/g1/configuration/general',{view:'devices',groupId:'g1',tab:'settings'}],
 ['#devices/customer/c1',{view:'devices',customerId:'c1',tab:'devices'}],
 ['#devices/ungrouped/monitoring/list',{view:'devices',groupId:'unassigned',tab:'alarms'}],
 ['#devices/group/g1/monitoring/alert-rules',{view:'devices',groupId:'g1',tab:'alerts'}],
 ['#devices/customer/c1/monitoring/notification-rules',{view:'devices',customerId:'c1',tab:'notifications'}],
 ['#devices/customer/c1/ungrouped/history',{view:'devices',customerId:'c1',groupId:'unassigned',tab:'jobs'}],
 ['#devices/add',{view:'add-device',installer:false}],
 ['#devices/add/installer/customer/c1/group/g1',{view:'add-device',installer:true,customerId:'c1',groupId:'g1'}],
 ['#device/d1/hardware/gpu/3',{view:'device',deviceId:'d1',deviceSection:'hardware',deviceDetail:'gpu',gpu:3}],
 ['#device/d1/software',{view:'device',deviceId:'d1',deviceSection:'software'}],
 ['#device/d1/software/drivers',{view:'device',deviceId:'d1',deviceSection:'software',deviceDetail:'drivers'}],
 ['#device/d1/management/tasks',{view:'device',deviceId:'d1',deviceSection:'management',deviceDetail:'tasks'}],
 ['#device/d1/remote/rdp',{view:'device',deviceId:'d1',deviceSection:'rdp'}],
 ['#device/d1/history/alarms',{view:'device',deviceId:'d1',deviceSection:'monitoring'}],
 ['#device/d1/monitoring',{view:'device',deviceId:'d1',deviceSection:'monitoring'}],
 ['#device/d1/monitoring/notification-rules',{view:'device',deviceId:'d1',deviceSection:'monitoring',deviceDetail:'notification-rules'}],
 ['#device/d1/extensions/dns/a%2Fb',{view:'device',deviceId:'d1',deviceSection:'extensions',deviceDetail:'dns',zone:'a/b'}],
 ['#device/d1/configuration',{view:'device',deviceId:'d1',deviceSection:'monitoring',deviceDetail:'alert-rules'}],
 ['#device/d1/configuration/permissions',{view:'device',deviceId:'d1',deviceSection:'configuration'}],
 // The assistant link sets the drawer-open flag; the old form too.
 ['#device/d1/assistant',{view:'device',deviceId:'d1',deviceSection:'overview',assistant:true}],
 ['#devices/d1/assistant',{view:'device',deviceId:'d1',deviceSection:'overview',assistant:true}],
 // Automation and Settings: page is the page, tab the page tab (never the default).
 ['#automation/drift',{view:'automation',page:'drift'}],['#automation/runbooks/runs',{view:'automation',page:'runbooks',tab:'runs'}],
 ['#automation/runbooks/schedules',{view:'automation',page:'runbooks',tab:'schedules'}],['#automation/desired',{view:'automation',page:'desired'}],
 ['#automation/desired/configurations',{view:'automation',page:'desired'}],['#automation/nope/x',{view:'automation',page:'runbooks'}],['#automation',{view:'automation',page:'runbooks'}],
 ['#settings/agent-troubleshooting/uninstall',{view:'settings',page:'agent-troubleshooting'}],['#agents/uninstall',{view:'settings',page:'agent-troubleshooting'}],
 ['#settings/retention',{view:'settings',page:'retention'}],
 ['#settings/notification-channels',{view:'settings',page:'notification-channels'}],['#settings/notification-channels/log',{view:'settings',page:'notification-channels',tab:'log'}],
 ['#settings/notification-channels/unknown',{view:'settings',page:'notification-channels'}],['#settings/notification-channels/channels',{view:'settings',page:'notification-channels'}],
 ['#account',{view:'account'}],
];
for(const [hash,route] of fields){assert.deepEqual(parseConsoleRoute(hash),route,hash);checks++;}
// The automation tabs: one list names them, every page and tab round-trips through the route fields.
assert.deepEqual(automationPageTabs,{runbooks:['library','runs','schedules','assignments','status'],desired:['configurations','assignments','status','history'],drift:['assignments','status','reference']},'the automation tabs, default first');checks++;
// The settings tabs are declared the same way: every tab, the default first.
assert.deepEqual(settingsPageTabs,{'notification-channels':['channels','log']},'the settings tabs, default first');checks++;
// Every tab of every automation and settings page round-trips: the default tab has no segment and no tab field.
for(const [view,pages] of [['automation',automationPageTabs],['settings',settingsPageTabs]])for(const [page,tabs] of Object.entries(pages))for(const [index,tab] of tabs.entries()){
 const hash=consoleRouteHash({view,page,tab}),route=parseConsoleRoute(hash);
 assert.equal(hash,`#${view}/${page}${index?'/'+tab:''}`,view+' '+page+'/'+tab);
 assert.deepEqual(route,{view,page,...(index?{tab}:{})},hash);
 assert.deepEqual([pageTabOf(route),pageTabsOf(route)],[tab,tabs],hash+': the resolved tab');
 checks+=3;
}
assert.deepEqual([pageTabOf({view:'settings',page:'audit'}),pageTabsOf({view:'settings',page:'audit'}),pageTabOf({view:'automation',page:'drift',tab:'runs'}),pageTabOf({view:'account'})],['',[],'assignments',''],'a page without tabs, an unknown tab and the account page');checks++;
// No route field pageTab is left: the route type, the routes and the console name none.
for(const file of ['lib/console-route.ts','ui/shell/nav-model.ts','ui/shell/console.tsx','ui/automation/automation-workspace.tsx','ui/settings/notifications-panel.tsx'])assert.doesNotMatch(fs.readFileSync(file,'utf8'),/\bpageTab\b/,file+' has no pageTab');
checks+=5;
assert.equal(consoleRouteHash({view:'device',deviceId:'d1',deviceSection:'extensions',deviceDetail:'dns',zone:'a/b c'}),'#device/d1/extensions/dns/a%2Fb%20c','the zone is encoded like ids');
assert.equal(consoleRouteHash({view:'device',deviceId:'d1',deviceSection:'extensions',deviceDetail:'dhcp',zone:'x'}),'#device/d1/extensions/dhcp','a zone only on the DNS view');
assert.equal(consoleRouteHash({view:'device',deviceId:'d1',deviceSection:'history',deviceDetail:'access',assistant:true}),'#device/d1/history/access','consoleRouteHash never writes an assistant segment');
checks+=3;
// The assistant link: deviceAssistantHash appends the segment to the device hash, and parseConsoleRoute reads it back,
// also for an id that needs encoding; consoleRouteHash of the parsed route still drops it.
for(const id of ['5f3e1a2b-1111-4222-8333-444455556666','a/b c#d']){
 assert.equal(deviceAssistantHash(id),`#device/${encodeURIComponent(id)}/assistant`,id+': the assistant hash');
 assert.deepEqual(parseConsoleRoute(deviceAssistantHash(id)),{view:'device',deviceId:id,deviceSection:'overview',assistant:true},id+': the round trip');
 assert.equal(consoleRouteHash(parseConsoleRoute(deviceAssistantHash(id))),`#device/${encodeURIComponent(id)}`,id+': consoleRouteHash drops the assistant segment');
 checks+=3;
}

// 9. The start page.
assert.equal(startHash('','problems'),'#devices/monitoring');assert.equal(startHash('#','problems'),'#devices/monitoring');assert.equal(startHash('','alarms'),'#devices/monitoring');checks++;
assert.equal(startHash('','dashboard'),'#dashboard');assert.equal(startHash('#','dashboard'),'#dashboard');assert.equal(startHash('#account','dashboard'),'#account');checks++;
// #dashboard: the Dashboard; anything after it is dropped, and an unknown root is still All devices.
assert.deepEqual([parseConsoleRoute('#dashboard'),parseConsoleRoute('#dashboard/alarms'),consoleRouteHash({view:'dashboard'}),consoleRouteHash(parseConsoleRoute('#dashboard/x')),parseConsoleRoute('#dashboards')],[{view:'dashboard'},{view:'dashboard'},'#dashboard','#dashboard',{view:'devices'}]);checks++;
assert.equal(startHash('','devices'),'');assert.equal(startHash('#device/d1','problems'),'#device/d1');assert.equal(startHash('',undefined),'');
checks+=5;

console.log(`PASS console routes (${checks} checks): old fleet, device and page hashes canonicalize, canonical hashes round-trip, scope-invalid tabs, reserved segments, route fields and the start page.`);
