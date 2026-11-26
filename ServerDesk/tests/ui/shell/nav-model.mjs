// The navigation model of the console (ui/shell/nav-model.ts): the rail with its shortcuts per viewer, the navigator of
// Automation and Settings with the five settings groups, Add device as a page of Devices, the agent pages as settings
// pages, the crumb rule, the scope tab and device links, the palette pages, the help topic of each route and the
// shortcut list. A static check keeps old hashes and page lists out of the sources: every link comes from
// consoleRouteHash or the model. A doc scan keeps the old page names out of docs/.
import '../../support/register.mjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const model=await import('../../../ui/shell/nav-model.ts');
const {consoleRouteHash,parseConsoleRoute}=await import('../../../lib/console-route.ts');
const {topicFor}=await import('../../../ui/shell/help-panel.tsx');
const {shortcutList,shortcutOr}=await import('../../../ui/shell/console-shortcuts.ts');
const {translate}=await import('../../../lib/i18n/translate.ts');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>check(!!value,true,label);
const owner={permissions:['*']},member={permissions:[]},rolesOnly={permissions:['portal.roles.manage']},notifier={permissions:['portal.notifications.manage']};
const href=node=>consoleRouteHash(node.route);

// 1. The rail: labels, icons, shortcuts and order per viewer; Settings sits at the end. There is no Agents area.
const rail=viewer=>model.visibleRail({viewer}).map(node=>[node.id,node.label,node.icon,node.shortcut?.keys,!!node.placement.end]);
check(rail(owner),[['dashboard','rail.dashboard','LayoutDashboard','G H',false],['devices','rail.devices','Server','G D',false],['automation','rail.automation','Play','G A',false],['settings','rail.settings','Settings','G S',true]],'the Owner rail');
check(rail(member).map(([id])=>id),['dashboard','devices','automation'],'a viewer without a settings right');
check(rail(rolesOnly).map(([id])=>id),['dashboard','devices','automation','settings'],'a viewer with one settings page right also sees Settings');
check(rail(notifier).map(([id])=>id),['dashboard','devices','automation','settings'],'a viewer with the notification right sees Settings');
check(model.firstSettingsPage({viewer:rolesOnly}),'roles','G S opens the first page the viewer may open');
check(model.firstSettingsPage({viewer:notifier}),'notification-channels','the first page of a viewer with only the notification right');
check([...new Set(model.navNodes.map(node=>node.placement.area))].sort(),['account','automation','dashboard','devices','settings'],'no node is placed in an agents area');
check(/'agents'/.test(fs.readFileSync('ui/shell/nav-model.ts','utf8').match(/export type Area=[^;]*;/)[0]),false,'the Area type has no agents');

// 2. The navigator: entries, groups, labels, hints and links.
check(model.navigatorPages('automation',{viewer:member}).map(node=>[node.label,node.hint,node.icon,href(node)]),[
 ['nav.automation.runbooks','nav.automation.runbooksHint','CalendarClock','#automation/runbooks'],
 ['nav.automation.desired','nav.automation.desiredHint','ClipboardCheck','#automation/desired'],
 ['nav.automation.drift','nav.automation.driftHint','GitCompareArrows','#automation/drift'],
],'Automation');
const settings=(viewer,extra={})=>model.settingsGroups({viewer,...extra}).map(({group,pages})=>[group,pages.map(node=>[node.id,node.label,node.hint,node.icon,href(node)])]);
const ownerGroups=[
 ['nav.settings.groupUsers',[['settings.accounts','nav.settings.accounts','nav.settings.accountsHint','UserRound','#settings/accounts'],['settings.user-groups','nav.settings.userGroups','nav.settings.userGroupsHint','Users','#settings/user-groups'],['settings.roles','nav.settings.roles','nav.settings.rolesHint','KeyRound','#settings/roles'],['settings.entra','nav.settings.entra','nav.settings.entraHint','LogIn','#settings/entra'],['settings.sessions','nav.settings.sessions','nav.settings.sessionsHint','ShieldCheck','#settings/sessions']]],
 ['nav.settings.groupOrganization',[['settings.customers','nav.settings.customers','nav.settings.customersHint','Building2','#settings/customers'],['settings.branding','nav.settings.branding','nav.settings.brandingHint','Palette','#settings/branding']]],
 ['nav.settings.groupIntegrations',[['settings.notification-channels','nav.settings.notificationChannels','nav.settings.notificationChannelsHint','Send','#settings/notification-channels'],['settings.vulnerabilities','nav.settings.vulnerabilities','nav.settings.vulnerabilitiesHint','ShieldAlert','#settings/vulnerabilities'],['settings.assistant','nav.settings.assistant','nav.settings.assistantHint','Sparkles','#settings/assistant']]],
 ['nav.settings.groupAgents',[['settings.agent-releases','nav.settings.agentReleases','nav.settings.agentReleasesHint','Package','#settings/agent-releases'],['settings.extensions','nav.settings.extensions','nav.settings.extensionsHint','Puzzle','#settings/extensions'],['settings.agent-troubleshooting','nav.settings.agentTroubleshooting','nav.settings.agentTroubleshootingHint','LifeBuoy','#settings/agent-troubleshooting']]],
 ['nav.settings.groupSystem',[['settings.retention','nav.settings.retention','nav.settings.retentionHint','Wrench','#settings/retention'],['settings.audit','nav.settings.audit','nav.settings.auditHint','ScrollText','#settings/audit'],['settings.usage-data','nav.settings.usageData','nav.settings.usageDataHint','ChartColumn','#settings/usage-data']]],
];
check(settings(owner,{multipleCustomers:true}),ownerGroups,'Settings for the Owner with several customers: five groups in order');
check(settings(owner),ownerGroups,'with only the default customer the Owner gets the same pages, Customers included');
check(settings(owner,{multipleCustomers:false}).find(([group])=>group==='nav.settings.groupOrganization')[1].map(([id])=>id),['settings.customers','settings.branding'],'Organization holds Customers and then Branding');
check(model.navNodes.some(node=>node.id==='settings.license'||node.palette?.id==='page-settings-license'||node.help==='license'),false,'no node, palette entry or help topic has the id license');
check(settings(rolesOnly),[['nav.settings.groupUsers',[['settings.roles','nav.settings.roles','nav.settings.rolesHint','KeyRound','#settings/roles']]]],'the same rights filter the pages; an empty group is left out');
check(settings(notifier,{multipleCustomers:true}).map(([group,pages])=>[group,pages.map(([id])=>id)]),[['nav.settings.groupIntegrations',['settings.notification-channels']]],'the agent pages are for the Owner only');
check(model.navigatorPages('settings',{viewer:owner,multipleCustomers:true}).map(node=>node.id),ownerGroups.flatMap(([,pages])=>pages.map(([id])=>id)),'the navigator pages follow the group order');
// The crumb rule: navigator pages have no crumbs, only the area name of the crumb button.
check(['settings.sessions','settings.agent-releases','automation.drift','devices.add','account'].map(id=>model.areaCrumbOf(model.navNode(id))),['nav.settings.title','nav.settings.title','nav.automation.title',undefined,undefined],'the crumb button of navigator pages');
check('pageCrumbs' in model,false,'pageCrumbs (area › group › page) is gone');
// The selected entry follows the route.
check(['#devices/add/group/g1','#settings/agent-releases','#settings/agent-troubleshooting','#automation/desired','#settings/retention','#account'].map(hash=>model.routeNode(parseConsoleRoute(hash))?.id),
 ['devices.add','settings.agent-releases','settings.agent-troubleshooting','automation.desired','settings.retention','account'],'the node of each route');

// The page node of a route is the node whose declared route is that page, not a position in a list: each page route
// (with any add-device segments) resolves to the node whose route it is, and a page moved to another area in a copy of
// the tree is still found there.
for(const node of [model.navNode('devices.add'),...model.navigatorPages('settings',{viewer:owner,multipleCustomers:true})]){
 check(model.routeNode(parseConsoleRoute(href(node)))?.id,node.id,href(node)+' resolves to its node');
 check(model.routeNode({...node.route})===node,true,node.id+': the declared route resolves to the same node object');
}
check(model.routeNode(parseConsoleRoute('#devices/add/installer/customer/c1/group/g1'))?.id,'devices.add','the add-device segments do not change the page');
{
 const moved=model.navNodes.map(node=>node.id==='settings.agent-releases'?{...node,placement:{area:'automation',in:'navigator'}}:node);
 const shuffled=[...moved].reverse();
 check([model.pageNodeIn(shuffled,{view:'settings',page:'agent-releases'})?.placement.area,model.pageNodeIn(shuffled,{view:'settings',page:'agent-troubleshooting'})?.id],
  ['automation','settings.agent-troubleshooting'],'a moved page and a reordered tree still resolve by route');
 check(/(agentNodes|settingsNodes)\[\d\]/.test(fs.readFileSync('ui/shell/nav-model.ts','utf8')),false,'no positional lookup of the pages');
}

// 3. Placement: Add device is a page of Devices; the agent pages are settings pages.
check(model.navNode('devices.add').placement,{area:'devices',in:'page'},'Add device is a page of the Devices area');
check(['#devices/add','#devices/add/installer/customer/c1/group/g1','#settings/agent-releases','#settings/agent-troubleshooting','#settings/accounts','#automation/runbooks','#devices','#device/d1','#account','#dashboard'].map(hash=>model.areaOf(parseConsoleRoute(hash))),
 ['devices','devices','settings','settings','settings','automation','devices','devices','account','dashboard'],'the area of each route');
// The Dashboard: the first rail area without a navigator; its node carries the route, the help topic and the palette entry.
check([model.routeNode(parseConsoleRoute('#dashboard'))?.id,model.helpTopicFor(parseConsoleRoute('#dashboard')),model.areaNodeOf('dashboard')?.id,model.navNode('dashboard').placement,model.areaCrumbOf(model.navNode('dashboard')),model.navNode('dashboard').visible({viewer:{permissions:[]}})],
 ['dashboard','dashboard','dashboard',{area:'dashboard',in:'rail'},undefined,true],'the Dashboard node');
check([topicFor(parseConsoleRoute('#dashboard'),'en').title,topicFor(parseConsoleRoute('#dashboard'),'de').tips.length,topicFor(parseConsoleRoute('#dashboard'),'en').docs.map(doc=>doc.file)],['Dashboard',3,['docs/dashboard.md']],'the help topic of the Dashboard');
check([model.settingsSection({page:'agent-releases'}),model.settingsSection({page:'agent-troubleshooting'}),model.settingsSection({page:'extensions'}),model.settingsSection({page:'sessions'}),model.settingsSection({page:'retention'}),model.settingsSection({page:'user-groups'}),model.settingsSection({page:'notification-channels',tab:'log'})],[null,null,null,'sessions','retention','user-groups','notification-channels'],'agent pages have no settings section; the section id is the page name');
check(model.settingsPageOf,undefined,'no section-to-page mapping is left');
check([model.navNode('settings.agent-releases').agentTab,model.navNode('settings.extensions').agentTab,model.navNode('settings.agent-troubleshooting').agentTab,model.navNode('devices.add').agentTab],['agent-releases','extensions','agent-troubleshooting',undefined],'the agent page each agent node renders; Add device is its own page');
check([model.navNode('devices.add').visible({viewer:owner}),model.navNode('devices.add').visible({viewer:notifier})],[true,false],'Add device is for the Owner');

// 4. Scope tabs: five tabs, four of them with their subtabs as children, the rights rule and the links per scope type.
check(model.scopeTabs.map(node=>[node.id,node.scopeTab,node.label,node.tab,node.placement.in]),[
 ['scope.devices','devices','tree.devices','devices','scope-tabs'],['scope.monitoring','monitoring','fleet.tabs.monitoring','problems','scope-tabs'],['scope.inventory','inventory','fleet.tabs.inventory','software','scope-tabs'],
 ['scope.history','history','fleet.tabs.history','jobs','scope-tabs'],['scope.configuration','configuration','fleet.tabs.configuration','tags','scope-tabs'],
],'five tabs; a tab holds its default subtab');
check(model.scopeTabs.map(node=>node.icon),['MonitorSmartphone','Siren','Package','History','Settings2'],'the Monitoring tab node has the Siren icon');
check(model.scopeTabs.map(node=>(node.children??[]).map(child=>child.tab)),[[],['problems','alarms','alerts','notifications'],['software','extensions','drivers','certificates','autostart','os-support','encryption','protection','reliability'],['jobs','access'],['tags','permissions','settings']],'the subtabs of each tab in bar order');
check(model.scopeTabs.flatMap(node=>node.children??[]).map(child=>[child.label,child.placement.in,child.scopeTab]).filter(([label])=>['fleet.alarms.byDevice','fleet.alarms.byAlarm','alertRules.title','extensions.tab','protection.title','fleet.config.notificationRules','fleet.tabs.settings'].includes(label)),[
 ['fleet.alarms.byDevice','scope-subtabs','monitoring'],['fleet.alarms.byAlarm','scope-subtabs','monitoring'],['alertRules.title','scope-subtabs','monitoring'],['fleet.config.notificationRules','scope-subtabs','monitoring'],['extensions.tab','scope-subtabs','inventory'],['protection.title','scope-subtabs','inventory'],['fleet.tabs.settings','scope-subtabs','configuration'],
],'the renamed subtab labels (By device, By alarm, Extensions, Defender, Notification rules, General) in the subtab bar');
check(model.scopeSubtabs('history').map(node=>node.id),['scope.history.jobs','scope.history.access'],'scopeSubtabs');
check(model.scopeTabs.every(node=>node.route.view==='devices'&&node.route.tab===node.tab),true,'a tab node routes to its default subtab');
const visibleSubtabs=(scope,extra={},viewer=owner)=>model.scopeTabs.filter(node=>node.visible({viewer,scope,...extra})).map(node=>[node.scopeTab,(node.children??[]).filter(child=>child.visible({viewer,scope,...extra})).map(child=>child.tab)]);
const reports=['software','extensions','drivers','certificates','autostart','os-support','encryption','protection','reliability'],rest=[['inventory',reports],['history',['jobs','access']]];
const monitoring=['problems','alarms','alerts','notifications'];
check(visibleSubtabs({type:'all'}),[['devices',[]],['monitoring',monitoring],...rest,['configuration',['permissions']]],'All devices: Monitoring with the rules; Configuration: Permissions');
check(visibleSubtabs({type:'all'},{},member),[['devices',[]],['monitoring',monitoring],...rest],'All devices without the role assignment right: no Configuration tab');
check(visibleSubtabs({type:'group',id:'g1'},{group:{permissions:['groups.manage']}}),[['devices',[]],['monitoring',monitoring],...rest,['configuration',['tags','permissions','settings']]],'a group with the Owner right');
check(visibleSubtabs({type:'group',id:'g1'},{group:{permissions:[]}},member),[['devices',[]],['monitoring',monitoring],...rest,['configuration',['tags']]],'a group without the role-assignment and group rights');
check(visibleSubtabs({type:'customer',id:'c1'}),[['devices',[]],['monitoring',monitoring],...rest],'a customer: Monitoring with the rules, no Configuration tab');
check(visibleSubtabs({type:'unassigned'}),[['devices',[]],['monitoring',['problems','alarms']],...rest],'Ungrouped: By device and By alarm, no Configuration tab');
check(visibleSubtabs({type:'unassigned',customerId:'c1'}),[['devices',[]],['monitoring',['problems','alarms']],...rest],'the Ungrouped scope of a customer: no rules, no Configuration tab');
for(const [scope,prefix] of [[{type:'all'},'#devices'],[{type:'group',id:'g 1'},'#devices/group/g%201'],[{type:'customer',id:'c1'},'#devices/customer/c1'],[{type:'unassigned'},'#devices/ungrouped'],[{type:'unassigned',customerId:'c1'},'#devices/customer/c1/ungrouped']]){
 const links=Object.fromEntries(['devices','problems','alarms','jobs','access','software','extensions','protection','autostart'].map(tab=>[tab,model.scopeTabHref(scope,tab)]));
 check(links,{devices:prefix,problems:prefix+'/monitoring',alarms:prefix+'/monitoring/list',jobs:prefix+'/history',access:prefix+'/history/access',software:prefix+'/inventory',extensions:prefix+'/inventory/extensions',protection:prefix+'/inventory/defender',autostart:prefix+'/inventory/autostart'},prefix);
}
check(['alerts','notifications','tags','permissions','settings'].map(tab=>model.scopeTabHref({type:'group',id:'g1'},tab)),['#devices/group/g1/monitoring/alert-rules','#devices/group/g1/monitoring/notification-rules','#devices/group/g1/configuration/tags','#devices/group/g1/configuration/permissions','#devices/group/g1/configuration/general'],'the rules and configuration tabs of a group');
check(['alerts','permissions'].map(tab=>model.scopeTabHref({type:'all'},tab)),['#devices/monitoring/alert-rules','#devices/configuration/permissions'],'All devices');
check(['alerts','notifications'].map(tab=>model.scopeTabHref({type:'customer',id:'c1'},tab)),['#devices/customer/c1/monitoring/alert-rules','#devices/customer/c1/monitoring/notification-rules'],'a customer has both rules subtabs');
check([model.shownScopeTab('settings',{settings:false}),model.shownScopeTab('permissions',{permissions:true}),model.shownScopeTab('software',{})],['devices','permissions','software'],'a tab without its content shows Devices');
// routeNode: the subtab node of every scope subtab route (placement scope-subtabs), the Devices tab for the scope itself.
for(const prefix of ['#devices','#devices/group/g1','#devices/customer/c1','#devices/ungrouped','#devices/customer/c1/ungrouped']){
 const suffixes=prefix.startsWith('#devices/group')?['/monitoring','/monitoring/list','/monitoring/alert-rules','/monitoring/notification-rules','/inventory','/inventory/extensions','/inventory/defender','/history','/history/access','/configuration/tags','/configuration/permissions','/configuration/general']
  :prefix==='#devices'?['/monitoring','/monitoring/list','/monitoring/alert-rules','/monitoring/notification-rules','/inventory/drivers','/history/access','/configuration/permissions']:['/monitoring','/monitoring/list','/inventory/reliability','/history/access'];
 for(const suffix of suffixes){const route=parseConsoleRoute(prefix+suffix),node=model.routeNode(route);check([node?.placement.in,node?.tab,model.scopeTabHref(prefix==='#devices'?{type:'all'}:{type:'group',id:'g1'},node?.tab).endsWith(suffix)||!prefix.startsWith('#devices/group')&&prefix!=='#devices'],['scope-subtabs',route.tab,true],prefix+suffix);}
 check([model.routeNode(parseConsoleRoute(prefix))?.id,model.routeNode(parseConsoleRoute(prefix))?.placement.in],['scope.devices','scope-tabs'],prefix+': the Devices tab');
}
check(model.routeNode(parseConsoleRoute('#devices/customer/c1/configuration'))?.id,'scope.monitoring.notifications','an old customer Configuration link opens Monitoring › Notification rules');
check(model.routeNode(parseConsoleRoute('#devices/customer/c1/monitoring/alert-rules'))?.id,'scope.monitoring.alerts','the customer alert rules subtab');
check([model.scopeAvailable({type:'unassigned',customerId:'c1'},{viewer:owner,customers:[{id:'c1'},{id:'c2'}]}),model.scopeAvailable({type:'unassigned',customerId:'c1'},{viewer:owner,customers:[{id:'c1'}]}),model.scopeAvailable({type:'unassigned'},{viewer:owner})],[true,false,true],'the customer Ungrouped scope follows the customer view rule');

// 5. Device areas and subareas.
const roleServer={snapshot:{os:'Microsoft Windows Server 2022 Standard',features:[{name:'DHCP',displayName:'DHCP-Server',installed:true,featureType:'Role'}]}},plain={snapshot:{os:'Microsoft Windows 11 Pro',features:[]}};
const fixedAreas=['overview','hardware','software','diagnostics','management','remote','automation','history','monitoring','configuration'];
const areaLabels=['device.section.overview','device.section.hardware','device.section.software','device.section.diagnostics','device.section.management','device.section.remote','device.section.automation','device.section.history','device.section.monitoring','device.section.configuration'];
check(model.visibleDeviceAreas(plain,owner).map(node=>[node.deviceSection,node.label]),fixedAreas.map((id,index)=>[id,areaLabels[index]]),'the areas of review §2.3 in tab order, Monitoring and Configuration last');
check(model.visibleDeviceAreas(roleServer,owner).map(node=>node.deviceSection),[...fixedAreas.slice(0,8),'extensions','monitoring','configuration'],'Extensions before Monitoring with a detected role');
check([model.visibleDeviceAreas(plain,member).map(node=>node.deviceSection),model.visibleDeviceAreas(plain).map(node=>node.deviceSection)],[fixedAreas.slice(0,9),fixedAreas.slice(0,9)],'Configuration only with portal.roleAssignments.manage');
check([model.deviceKeyAreas(plain).map(node=>node.deviceSection),model.deviceKeyAreas(roleServer).map(node=>node.deviceSection)],[fixedAreas.slice(0,8),[...fixedAreas.slice(0,8),'extensions']],'the keys 1–9 stay: Monitoring and Configuration have none, 9 is Extensions');
check(model.navNode('device.monitoring').icon,'Siren','the Monitoring area has the Siren icon');
check(translate('en','monitoringTab.paletteKeywords').split(' ').filter(word=>['alarms','problems','monitoring','überwachung','notifications','benachrichtigungen'].includes(word)),['alarms','problems','monitoring','überwachung','notifications','benachrichtigungen'],'the Monitoring palette words keep the alarm words and add monitoring and notifications');
check([model.navNode('device.extensions').label,model.navNode('device.extensions').icon,model.navNode('device.extensions').help],['device.section.extensions','Puzzle','device-extensions'],'the Extensions label, icon and help topic');
check(model.navNodes.filter(node=>node.id==='device.roles'||node.id.startsWith('device.roles.')||node.id==='scope.inventory.roles'||node.palette?.id==='page-server-roles').length,0,'no Server roles node or palette entry');
check(model.deviceSubareas('extensions').map(node=>[node.id,node.help]),[['device.extensions.overview','device-extensions'],['device.extensions.dhcp','dhcp'],['device.extensions.dns','dns']],'the Extensions subareas');
check([model.navNode('scope.inventory.extensions').icon,model.navNode('scope.inventory.extensions').help,model.navNode('scope.inventory.extensions').label],['Puzzle','extensions','extensions.tab'],'the scope subtab Extensions');
check([model.navNode('settings.extensions').icon,model.navNode('settings.extensions').help,model.navNode('settings.extensions').placement.group],['Puzzle','extension-releases','nav.settings.groupAgents'],'the settings page Extensions');
check([owner,member,{id:'pm',permissions:['plugins.manage']}].map(viewer=>model.navNode('settings.extensions').visible({viewer})),[true,false,false],'the settings page is for Owners only');
check(model.navTree.devicePanels,undefined,'no panel nodes');
check(model.navNodes.filter(node=>node.id.startsWith('device.panel')||node.route.view==='device'&&node.route.assistant).length,0,'no panel or assistant node');
check([...fixedAreas,'extensions'].map(id=>model.deviceAreaHref('d 1',id)),
 ['#device/d%201','#device/d%201/hardware','#device/d%201/software','#device/d%201/diagnostics','#device/d%201/management','#device/d%201/remote','#device/d%201/automation','#device/d%201/history','#device/d%201/monitoring','#device/d%201/configuration/permissions','#device/d%201/extensions'],'area links');
check(model.deviceSubareas('software').map(node=>[node.sub,node.label,model.deviceSubareaHref('d1','software',node.sub),node.help]),[
 ['programs','device.area.programs','#device/d1/software','device-software'],['drivers','drivers.title','#device/d1/software/drivers','device-drivers'],
 ['certificates','certificates.title','#device/d1/software/certificates','device-certificates'],['autostart','autostart.title','#device/d1/software/autostart','device-autostart'],
],'the Software bar');
check(model.deviceSubareas('management').map(node=>[node.sub,node.label,model.deviceSubareaHref('d1','management',node.sub)]),[
 ['services','device.area.services','#device/d1/management'],['updates','device.area.updates','#device/d1/management/updates'],['storage','device.area.storage','#device/d1/management/storage'],['network','device.area.network','#device/d1/management/network'],
 ['accounts','device.area.accounts','#device/d1/management/accounts'],['features','device.area.features','#device/d1/management/features'],['tasks','management.tasks.title','#device/d1/management/tasks'],
 ['defender','device.area.defender','#device/d1/management/defender'],['system','device.area.system','#device/d1/management/system'],
],'the Management bar: Scheduled tasks, and no Software subareas');
check(['remote','automation','history','extensions','diagnostics','monitoring','configuration'].map(area=>model.deviceSubareas(area).map(node=>model.deviceSubareaHref('d1',area,node.sub))),[
 ['#device/d1/remote','#device/d1/remote/terminal','#device/d1/remote/rdp'],['#device/d1/automation','#device/d1/automation/desired','#device/d1/automation/drift'],
 ['#device/d1/history','#device/d1/history/access'],['#device/d1/extensions','#device/d1/extensions/dhcp','#device/d1/extensions/dns'],
 ['#device/d1/diagnostics','#device/d1/diagnostics/sessions','#device/d1/diagnostics/events','#device/d1/diagnostics/connections'],
 ['#device/d1/monitoring','#device/d1/monitoring/alert-rules','#device/d1/monitoring/notification-rules'],
 ['#device/d1/configuration/permissions'],
],'the other subarea bars');
check([model.deviceSubareas('history').map(node=>node.placement.in),model.deviceSubareas('extensions').map(node=>node.label),model.deviceSubareas('monitoring').map(node=>[node.id,node.label,node.help]),model.deviceSubareas('configuration').map(node=>node.label)],
 [['device-subtabs','device-subtabs'],['device.section.overview','dhcp.title','dns.title'],[['device.monitoring.alarms','alarms.title','alarms'],['device.monitoring.alert-rules','alertRules.title','alert-rules'],['device.monitoring.notification-rules','fleet.config.notificationRules','notifications']],['tree.permissions']],'History views are subtabs (no Alarms); the Extensions, Monitoring and Configuration subtab labels and help topics');
const dnsServer={snapshot:{os:'Microsoft Windows Server 2022 Standard',features:[{name:'DNS',displayName:'DNS-Server',installed:true,featureType:'Role'}]}};
check([roleServer,dnsServer].map(server=>model.visibleDeviceSubareas('extensions',{viewer:owner,server}).map(node=>node.sub)),[['overview','dhcp'],['overview','dns']],'DHCP and DNS only with that role');
check([owner,member].map(viewer=>model.visibleDeviceSubareas('configuration',{viewer,server:plain}).map(node=>node.sub)),[['permissions'],[]],'Permissions only with portal.roleAssignments.manage');
check([owner,member].map(viewer=>model.visibleDeviceSubareas('monitoring',{viewer,server:plain}).map(node=>node.sub)),[['alarms','alert-rules','notification-rules'],['alarms','alert-rules','notification-rules']],'Monitoring for every viewer of the device');
check([model.navNode('device.extensions').keywords,model.extensionsKeywords],['extensions erweiterungen plugins roles rollen dhcp dns','extensions erweiterungen plugins roles rollen dhcp dns'],'the Extensions palette keywords keep the old words');
check([model.deviceSubareaHref('d1','hardware','gpu',{gpu:3}),model.deviceSubareaHref('d1','hardware','overview')],['#device/d1/hardware/gpu/3','#device/d1/hardware'],'hardware with the GPU position');

// 6. The palette pages: the exact label of each destination, its parent path as the hint, today's keywords and the order.
const t=key=>'«'+key+'»';
// The hints are parent paths from the tree: a scope subtab names its tab ("All devices › Inventory"), a page tab its area and page.
const all='«nav.allDevices»',history='«nav.allDevices» › «fleet.tabs.history»',inventory='«nav.allDevices» › «fleet.tabs.inventory»',configuration='«nav.allDevices» › «fleet.tabs.configuration»',monitoringHint='«nav.allDevices» › «fleet.tabs.monitoring»',settingsHint='«palette.hint.settings»';
const automationTab=(page,pageLabel,tab,label)=>[`page-automation-${page}-${tab}`,`«${label}»`,`«nav.automation.title» › «${pageLabel}»`,'automatisierung','Play',`#automation/${page}/${tab}`];
const palette=(viewer,extra={})=>model.palettePages.filter(node=>node.visible({viewer,scope:{type:'all'},...extra}));
const row=node=>[node.palette.id,t(node.palette.label??node.label),model.paletteHint(node,t),model.paletteKeywords(node,t),node.palette.icon??node.icon,href(node)];
const settingsRow=(id,label,keywords,icon,page)=>[id,`«${label}»`,settingsHint,`${keywords} ${settingsHint.toLowerCase()}`,icon,'#settings/'+page];
const ownerPalette=[
 ['page-dashboard','«rail.dashboard»',undefined,'«dashboard.paletteKeywords»','LayoutDashboard','#dashboard'],
 ['page-devices','«nav.allDevices»',undefined,'«console.paletteKeywords»','Server','#devices'],
 ['page-alarms','«fleet.tabs.monitoring»',all,'«monitoringTab.paletteKeywords»','Siren','#devices/monitoring'],
 ['page-jobs','«history.tab.jobs»',history,'jobs','Activity','#devices/history'],
 ['page-device-access','«history.tab.access»',history,'access log sign-ins zugriffe','ScrollText','#devices/history/access'],
 ['page-software','«software.title»',inventory,'software programs inventory','Package','#devices/inventory'],
 ['page-fleet-extensions','«extensions.tab»',inventory,'extensions erweiterungen plugins roles rollen dhcp dns active directory sql exchange veeam','Puzzle','#devices/inventory/extensions'],
 ['page-os-support','«osSupport.title»',inventory,'lifecycle esu support windows','CalendarClock','#devices/inventory/os-support'],
 ['page-encryption','«encryption.title»',inventory,'bitlocker encryption','Lock','#devices/inventory/encryption'],
 ['page-protection','«protection.title»',inventory,'defender antivirus threat scan protection schutz','ShieldCheck','#devices/inventory/defender'],
 ['page-drivers','«drivers.title»',inventory,'drivers device manager unsigned','CircuitBoard','#devices/inventory/drivers'],
 ['page-reliability','«reliability.title»',inventory,'reliability stability crashes hangs','Activity','#devices/inventory/reliability'],
 ['page-certificates','«certificates.title»',inventory,'certificates expiry tls https rdp','BadgeCheck','#devices/inventory/certificates'],
 ['page-autostart','«autostart.title»',inventory,'autostart run startup services tasks','Rocket','#devices/inventory/autostart'],
 ['page-alert-rules','«alertRules.title»',monitoringHint,'alerts alarms thresholds','BellRing','#devices/monitoring/alert-rules'],
 ['page-notification-rules','«fleet.config.notificationRules»',monitoringHint,'notifications rules benachrichtigungen regeln','Send','#devices/monitoring/notification-rules'],
 ['page-permissions','«tree.permissions»',configuration,'permissions rights berechtigungen','KeyRound','#devices/configuration/permissions'],
 ['page-add-device','«nav.devices.add»',all,'agent registrieren installieren installer zertifikat certificate fingerprint','Download','#devices/add'],
 ['page-automation-runbooks','«nav.automation.runbooks»','«nav.automation.title»','automatisierung','Play','#automation/runbooks'],
 automationTab('runbooks','nav.automation.runbooks','runs','runbooks.runs'),automationTab('runbooks','nav.automation.runbooks','schedules','runbooks.schedules'),
 automationTab('runbooks','nav.automation.runbooks','assignments','automation.assignments'),automationTab('runbooks','nav.automation.runbooks','status','automation.deviceState'),
 ['page-automation-desired','«nav.automation.desired»','«nav.automation.title»','automatisierung','Play','#automation/desired'],
 automationTab('desired','nav.automation.desired','assignments','automation.assignments'),automationTab('desired','nav.automation.desired','status','automation.deviceState'),
 automationTab('desired','nav.automation.desired','history','automation.tab.history'),
 ['page-automation-drift','«nav.automation.drift»','«nav.automation.title»','automatisierung','Play','#automation/drift'],
 automationTab('drift','nav.automation.drift','status','automation.deviceState'),automationTab('drift','nav.automation.drift','reference','automation.referenceDevices'),
 settingsRow('page-settings-accounts','nav.settings.accounts','«rbac.paletteKeywords»','UserRound','accounts'),
 settingsRow('page-settings-user-groups','nav.settings.userGroups','«rbac.paletteKeywords»','Users','user-groups'),
 settingsRow('page-settings-roles','nav.settings.roles','«rbac.paletteKeywords»','KeyRound','roles'),
 settingsRow('page-settings-entra','nav.settings.entra','«entra.paletteKeywords»','LogIn','entra'),
 settingsRow('page-settings-sessions','nav.settings.sessions','«sessionSettings.paletteKeywords»','ShieldCheck','sessions'),
 settingsRow('page-settings-customers','nav.settings.customers','«customers.paletteKeywords»','Building2','customers'),
 settingsRow('page-settings-branding','nav.settings.branding','«branding.paletteKeywords»','Palette','branding'),
 settingsRow('page-settings-notification-channels','nav.settings.notificationChannels','«notifications.paletteKeywords»','Send','notification-channels'),
 ['page-settings-notification-channels-log','«notifications.tab.log»','«palette.hint.settings» › «nav.settings.notificationChannels»','«notifications.paletteKeywords» «palette.hint.settings»','Send','#settings/notification-channels/log'],
 settingsRow('page-settings-vulnerabilities','nav.settings.vulnerabilities','«vulnerabilities.paletteKeywords»','ShieldAlert','vulnerabilities'),
 settingsRow('page-settings-assistant','nav.settings.assistant','«assistantSettings.paletteKeywords»','Sparkles','assistant'),
 settingsRow('page-settings-agent-releases','nav.settings.agentReleases','agent releases versions','Package','agent-releases'),
 settingsRow('page-settings-extensions','nav.settings.extensions','extensions erweiterungen plugins releases rollout dhcp dns','Puzzle','extensions'),
 settingsRow('page-settings-agent-troubleshooting','nav.settings.agentTroubleshooting','agent troubleshooting missing device uninstall fehlersuche deinstallieren','LifeBuoy','agent-troubleshooting'),
 settingsRow('page-settings-retention','nav.settings.retention','«maintenancePage.paletteKeywords»','Wrench','retention'),
 settingsRow('page-settings-audit','nav.settings.audit','«rbac.paletteKeywords»','ScrollText','audit'),
 settingsRow('page-settings-usage-data','nav.settings.usageData','«usageData.paletteKeywords»','ChartColumn','usage-data'),
 ['page-account','«nav.account.title»',undefined,'passwort mfa passkey','UserRound','#account'],
];
check(palette(owner,{multipleCustomers:true}).map(row),ownerPalette,'the palette pages of the Owner with several customers');
check(palette(owner).map(node=>node.palette.id),ownerPalette.map(([id])=>id),'with only the default customer the same entries, Customers included');
check(palette(owner).length,48,'the Owner has 48 palette page entries');
check(palette(owner).filter(node=>node.placement.in==='page-tabs').map(node=>node.id),['automation.runbooks.runs','automation.runbooks.schedules','automation.runbooks.assignments','automation.runbooks.status','automation.desired.assignments','automation.desired.status','automation.desired.history','automation.drift.status','automation.drift.reference','settings.notification-channels.log'],'ten new page tab entries, each after its page in tab order');
check(palette(notifier,{multipleCustomers:true}).map(node=>node.palette.id).filter(id=>!/^page-(dashboard|devices|alarms|jobs|device-access|software|fleet-extensions|os-support|encryption|protection|drivers|reliability|certificates|autostart|alert-rules|notification-rules|automation-)/.test(id)),['page-settings-notification-channels','page-settings-notification-channels-log','page-account'],'a non-owner: no Add device, no agent pages, no Permissions, only the settings pages (and their tabs) of the right');
check(palette(rolesOnly).some(node=>node.palette.id==='page-settings-notification-channels-log'),false,'a viewer without the notification right gets no Delivery log entry');
check(palette(member).some(node=>node.route.view==='settings'),false,'settings pages only with their right');
{
 const routes=palette(owner,{multipleCustomers:true}).map(href);
 check(routes.length,new Set(routes).size,'each destination appears once');
 check(model.palettePages.some(node=>node.palette.id==='action-provision'),false,'no separate Add device action');
}
check(model.palettePages.some(node=>node.palette.id==='page-problems'||translate('en',node.palette.label??node.label)==='Problems'),false,'one Alarms entry, no palette page names a Problems tab');
check(['nav.allDevices','alarms.title','protection.title'].map(key=>[translate('en',key),translate('de',key)]),[['All devices','Alle Geräte'],['Alarms','Alarme'],['Defender','Defender']],'the scope entries All devices, Alarms and Defender');

// 6b. Page tabs: each page with tabs has them as children in tab bar order (automationPageTabs, settingsPageTabs), never
// as navigator pages; a tab route resolves to its page (navigator selection, header, help topic).
{
 const tabs=id=>model.navNode(id).children.map(node=>[node.id,node.label,href(node),node.placement.in,node.placement.area,node.help,node.icon]);
 check(tabs('automation.runbooks'),[
  ['automation.runbooks.library','device.section.runbooks','#automation/runbooks','page-tabs','automation','automation','CalendarClock'],
  ['automation.runbooks.runs','runbooks.runs','#automation/runbooks/runs','page-tabs','automation','automation','CalendarClock'],
  ['automation.runbooks.schedules','runbooks.schedules','#automation/runbooks/schedules','page-tabs','automation','automation','CalendarClock'],
  ['automation.runbooks.assignments','automation.assignments','#automation/runbooks/assignments','page-tabs','automation','automation','CalendarClock'],
  ['automation.runbooks.status','automation.deviceState','#automation/runbooks/status','page-tabs','automation','automation','CalendarClock'],
 ],'the Runbooks tabs');
 check(tabs('automation.desired').map(([id,label,link])=>[id,label,link]),[['automation.desired.configurations','desired.configs','#automation/desired'],['automation.desired.assignments','automation.assignments','#automation/desired/assignments'],['automation.desired.status','automation.deviceState','#automation/desired/status'],['automation.desired.history','automation.tab.history','#automation/desired/history']],'the Desired State tabs');
 check(tabs('automation.drift').map(([id,label,link])=>[id,label,link]),[['automation.drift.assignments','automation.assignments','#automation/drift'],['automation.drift.status','automation.deviceState','#automation/drift/status'],['automation.drift.reference','automation.referenceDevices','#automation/drift/reference']],'the Configuration drift tabs');
 check(tabs('settings.notification-channels'),[['settings.notification-channels.channels','notifications.tab.channels','#settings/notification-channels','page-tabs','settings','notifications','Send'],['settings.notification-channels.log','notifications.tab.log','#settings/notification-channels/log','page-tabs','settings','notifications','Send']],'the Notification channels tabs');
 check(model.navNodes.filter(node=>node.placement.in==='page-tabs'&&!node.id.startsWith('automation.')&&!node.id.startsWith('settings.notification-channels.')),[],'no other page has tabs');
 check(model.navNodes.filter(node=>node.placement.in==='page-tabs').map(node=>node.visible===model.navNodes.find(page=>page.children?.includes(node)).visible),Array(14).fill(true),'a tab has the visibility rule of its page');
 check(model.navNodes.filter(node=>node.placement.in==='page-tabs'&&node.palette).length,10,'every tab but the first has palette data');
 check([...model.navigatorPages('automation',{viewer:owner}),...model.navigatorPages('settings',{viewer:owner,multipleCustomers:true}),...model.settingsGroups({viewer:owner,multipleCustomers:true}).flatMap(({pages})=>pages)].some(node=>node.placement.in==='page-tabs'),false,'tab nodes are never navigator pages');
 // The tab bars read these nodes through pageTabNodes.
 check(model.pageTabNodes(parseConsoleRoute('#automation/runbooks/runs')).map(node=>node.tab),['library','runs','schedules','assignments','status'],'pageTabNodes of a tab route: the tabs of its page');
 check(model.pageTabNodes(parseConsoleRoute('#settings/notification-channels/log')).map(node=>node.tab),['channels','log'],'pageTabNodes of the Delivery log');
 check([model.pageTabNodes(parseConsoleRoute('#settings/audit')),model.pageTabNodes(parseConsoleRoute('#devices/inventory')),model.pageTabNodes({view:'account'})],[[],[],[]],'pages without tabs have none');
 // A tab route belongs to its page: navigator selection, header node and help topic.
 for(const [hash,page] of [['#automation/runbooks/runs','automation.runbooks'],['#automation/desired/history','automation.desired'],['#automation/drift/reference','automation.drift'],['#settings/notification-channels/log','settings.notification-channels']]){
  check([model.routeNode(parseConsoleRoute(hash))?.id,model.helpTopicFor(parseConsoleRoute(hash)),model.areaOf(parseConsoleRoute(hash))],[page,model.navNode(page).help,model.navNode(page).placement.area],hash+' resolves to its page');
 }
 // The German and English labels and hints of the palette rows the spec names.
 const row=(id,locale)=>{const node=model.palettePages.find(item=>item.palette.id===id);const tr=key=>translate(locale,key);return [tr(node.palette.label??node.label),model.paletteHint(node,tr)];};
 check([row('page-automation-runbooks-runs','de'),row('page-settings-notification-channels-log','de'),row('page-software','de'),row('page-permissions','de'),row('page-device-access','de')],
  [['Läufe','Automation › Runbooks'],['Zustellprotokoll','Einstellungen › Benachrichtigungskanäle'],['Software','Alle Geräte › Inventar'],['Berechtigungen','Alle Geräte › Konfiguration'],['Gerätezugriffe','Alle Geräte › Historie']],'German palette rows');
 check([row('page-automation-runbooks-runs','en'),row('page-automation-desired-history','en'),row('page-automation-drift-reference','en'),row('page-settings-notification-channels-log','en'),row('page-software','en')],
  [['Runs','Automation › Runbooks'],['History','Automation › Desired State'],['Reference devices','Automation › Configuration drift'],['Delivery log','Settings › Notification channels'],['Software','All devices › Inventory']],'English palette rows');
 check(['page-devices','page-alarms','page-add-device'].map(id=>row(id,'en')[1]),[undefined,'All devices','All devices'],'All devices, Alarms and Add device keep their hints');
 // Palette search (command-palette.tsx filterPaletteItems): a tab entry is found by its label and by its page.
 const {filterPaletteItems}=await import('../../../ui/shell/command-palette.tsx');
 const items=palette(owner,{multipleCustomers:true}).map(node=>{const tr=key=>translate('en',key),hint=model.paletteHint(node,tr);return {id:node.palette.id,group:'Pages',label:tr(node.palette.label??node.label),...(hint?{hint}:{}),keywords:model.paletteKeywords(node,tr),Icon:null,run(){}};});
 const found=query=>filterPaletteItems(items,query).map(item=>[item.label,item.hint]);
 check(found('runs')[0],['Runs','Automation › Runbooks'],'"runs" lists Runs · Automation › Runbooks');
 check(found('delivery')[0],['Delivery log','Settings › Notification channels'],'"delivery" lists Delivery log · Settings › Notification channels first');
 check(found('runbooks')[0],['Runbooks','Automation'],'"runbooks" lists the Runbooks page first');
 ok(found('runbooks').some(([label])=>label==='Runs'),'"runbooks" also finds the Runbooks tabs');
}

// 7. The help topic of each route equals the topic of today's page or tab.
const topics=[
 ['#devices/alarms','help.problems.title'],['#devices/alarms/list','help.alarms.title'],['#devices/group/g1/alarms','help.problems.title'],['#devices/customer/c1/ungrouped/alarms/list','help.alarms.title'],['#device/x/software','software.title'],['#device/x/software/drivers','drivers.title'],['#device/x/management/defender','device.area.defender'],
 ['#device/x/extensions/dns','help.dns.title'],['#device/x/extensions/dhcp','help.dhcp.title'],['#settings/extensions','help.extensionReleases.title'],['#device/x/assistant','help.deviceOverview.title'],['#settings/agent-releases','releases.title'],['#devices/add','help.agents.title'],
 ['#device/x/software/certificates','certificates.title'],['#device/x/software/autostart','autostart.title'],['#device/x/management/tasks','help.management.title'],['#device/x/history','help.history.title'],
 ['#settings/agent-troubleshooting','help.agents.title'],['#devices','help.fleet.title'],['#devices/history/access','help.fleet.title'],['#devices/configuration','help.alertRules.title'],['#devices/configuration/notification-rules','help.notifications.title'],
 ['#devices/group/g1/configuration/tags','help.tags.title'],['#devices/group/g1/configuration/general','help.fleet.title'],['#devices/inventory','software.title'],['#devices/inventory/extensions','help.extensions.title'],['#devices/inventory/server-roles','software.title'],['#devices/inventory/defender','protection.title'],
 ['#device/x','help.deviceOverview.title'],['#device/x/configuration','help.alertRules.title'],['#device/x/configuration/permissions','help.access.title'],['#device/x/history/alarms','help.alarms.title'],
 // Monitoring: the subtabs keep their topics; the device area uses alarms, alert-rules and notifications.
 ['#devices/monitoring','help.problems.title'],['#devices/monitoring/list','help.alarms.title'],['#devices/monitoring/alert-rules','help.alertRules.title'],['#devices/monitoring/notification-rules','help.notifications.title'],
 ['#devices/customer/c1/monitoring/alert-rules','help.alertRules.title'],['#device/x/monitoring','help.alarms.title'],['#device/x/monitoring/alert-rules','help.alertRules.title'],['#device/x/monitoring/notification-rules','help.notifications.title'],['#device/x/remote/rdp','help.remote.title'],['#device/x/extensions','help.deviceExtensions.title'],['#device/x/server-roles','help.deviceOverview.title'],
 ['#settings/license','help.usageData.title'],['#settings/usage-data','help.usageData.title'],['#settings/sessions','help.security.title'],['#settings/retention','help.maintenance.title'],['#settings/customers','help.customers.title'],['#settings/branding','help.branding.title'],['#settings/entra','help.entra.title'],['#settings/notification-channels','help.notifications.title'],['#settings/vulnerabilities','help.vulnerabilities.title'],['#settings/assistant','help.assistant.title'],['#settings/audit','help.access.title'],['#settings/user-groups','help.access.title'],
 ['#automation/runbooks','help.automation.title'],['#account','help.account.title'],
];
for(const [hash,key] of topics)check(topicFor(parseConsoleRoute(hash),'en').title,translate('en',key),hash);
// A tab whose content is missing shows Devices.
check([topicFor(parseConsoleRoute('#devices/alarms'),'en').title,topicFor(parseConsoleRoute('#devices/alarms/list'),'en').title,topicFor(parseConsoleRoute('#devices'),'en').title],['Alarms by device','Alarms by alarm','All devices'],'the help titles of the alarm views and All devices');
ok(translate('en','help.fleet.tip2').includes('“Move devices here…”')&&!/Problems/.test(['help.problems.tip1','help.problems.tip2','help.problems.tip3','help.alarms.tip1','help.alarms.tip2','help.alarms.tip3','help.fleet.tip1','help.fleet.tip2','help.fleet.tip3','help.fleet.tip4'].map(key=>translate('en',key)).join(' ')),'the group tip names Move devices here…; no tip names a Problems tab');
check(topicFor({view:'devices',tab:model.shownScopeTab('alerts',{alerts:false})},'en').title,translate('en','help.fleet.title'),'Alert rules without its content');
// Every help key that a topic lists exists in both catalogs, and every help key outside the frame texts and the doc
// labels is read somewhere under ui/ or lib/: a tip that no topic lists is deleted, not kept.
{
 const en=(await import('../../../lib/i18n/messages/en.ts')).default,de=(await import('../../../lib/i18n/messages/de.ts')).default;
 const listed=[...new Set(fs.readFileSync('ui/shell/help-panel.tsx','utf8').match(/'help\.[\w.]+'/g).map(key=>key.slice(1,-1)))];
 ok(listed.length>150,'the help topics list their keys');
 check(listed.filter(key=>!Object.hasOwn(en,key)||!Object.hasOwn(de,key)),[],'every help key of a topic exists in en and de');
 const sources=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?(entry.name==='messages'?[]:sources(path.join(dir,entry.name))):/\.tsx?$/.test(entry.name)?[fs.readFileSync(path.join(dir,entry.name),'utf8')]:[]);
 const code=[...sources('ui'),...sources('lib')].join('\n');
 const frame=key=>key.startsWith('help.doc.')||['help.title','help.onThisPage','help.shortcuts','help.docs'].includes(key);
 check(Object.keys(en).filter(key=>key.startsWith('help.')&&!frame(key)&&!code.includes(`'${key}'`)),[],'no help key is left that no code reads');
 // Help tips quote the labels they name and state no key, rule or value order.
 const tips=listed.filter(key=>/\.tip\d$|\.uninstall$/.test(key));
 check(tips.filter(key=>/"|\bgreyed out\b|\bwins\b|comes first, then|management mode/.test(en[key])||/"|\bgewinnt\b|Zuerst gilt|ausgegraut/.test(de[key])),[],'no tip uses straight quotes, an order of keys or rules, "greyed out" or a lower-case mode name');
}

// 8. The shortcut list and the G targets: G S lists Settings, G I stays an unlisted alias.
check(shortcutList.map(row=>[row.keys.join(' '),row.label,row.scope]),[
 ['Ctrl K','shortcuts.search',undefined],['/','shortcuts.deviceSearch',undefined],[`F1 ${shortcutOr} ?`,'shortcuts.help',undefined],
 ['G H','shortcuts.dashboard',undefined],['G D','shortcuts.devices',undefined],['G A','shortcuts.automation',undefined],['G S','shortcuts.administration',undefined],['G N','shortcuts.addDevice',undefined],['G K','shortcuts.account',undefined],
 ['1 – 9','shortcuts.switchArea','shortcuts.scopeDevice'],['J','shortcuts.nextDevice','shortcuts.scopeDevice'],['K','shortcuts.previousDevice','shortcuts.scopeDevice'],['R','shortcuts.refresh',undefined],['T','shortcuts.jobs',undefined],['Esc','shortcuts.close',undefined],
],'the rows of the shortcut help');
check(shortcutList.filter(row=>row.keys[0]==='G').map(row=>[row.keys.join(' '),translate('en',row.label),translate('de',row.label)]),[['G H','Dashboard','Dashboard'],['G D','All devices','Alle Geräte'],['G A','Automation','Automation'],['G S','Settings','Einstellungen'],['G N','Add device','Gerät hinzufügen'],['G K','My account','Mein Konto']],'the G rows in English and German');
check(model.goShortcuts.map(({key,node})=>[key,node.id,href(node)]),[['h','dashboard','#dashboard'],['d','devices','#devices'],['a','automation','#automation/runbooks'],['s','settings','#settings/accounts'],['n','devices.add','#devices/add'],['k','account','#account']],'the G targets');
check(['s','i','I','n','x'].map(key=>model.goShortcutNode(key)?.id),['settings','settings','settings','devices.add',undefined],'G I is an alias of G S');

// The automation page names: "Runbooks" in the navigator and the page header, and "Automation" as the German area title.
check([translate('en','nav.automation.runbooks'),translate('de','nav.automation.runbooks'),translate('de','nav.automation.title'),translate('de','help.automation.title'),translate('de','device.section.automation')],['Runbooks','Runbooks','Automation','Automation','Automation'],'the automation page and area names');
check(model.deviceSubareas('automation').map(node=>node.sub),['runbooks','desired','drift'],'the device area keeps Runbooks, Desired State, Configuration drift');

// 9. Static checks: no old literal hash outside console-route.ts, and no page lists in the console, the help and the shortcuts.
{
 const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?walk(path.join(dir,entry.name)):[path.join(dir,entry.name)]);
 const sources=[...walk('app'),...walk('ui')].filter(file=>/\.tsx?$/.test(file)).concat(walk('lib').filter(file=>/\.ts$/.test(file))).filter(file=>path.basename(file)!=='console-route.ts');
 assert.ok(sources.length>200,'the scan sees the sources');
 const old=/#(?:agents|administration|audit)\b|#access\/|#devices\/(?!add\b|group\b|customer\b|ungrouped\b|alarms\b|inventory\b|history\b|configuration\b)[^\s'"`)\]]*\//;
 const hits=sources.flatMap(file=>fs.readFileSync(file,'utf8').split('\n').map((line,index)=>old.test(line)?`${file}:${index+1}`:null).filter(Boolean));
 check(hits,[],'no old literal hash in app/ or lib/');
 for(const file of ['ui/shell/console.tsx','ui/shell/help-panel.tsx','ui/shell/console-shortcuts.ts']){
  const source=fs.readFileSync(file,'utf8');
  check(source.match(/\bconst (automationPages|accessPages|accessGroups|agentPages|deviceTopics|healthTabs|deviceHealthAreas)\b[^=]*=\s*\[/g)??[],[],file+': no page or tab list');
  check(/\{id:'page-|\{keys:\['G'|action-provision/.test(source),false,file+': no hand-written palette page, Add device action or G shortcut');
 }
 check(/topicKeysFor|administrationTab/.test(fs.readFileSync('ui/shell/help-panel.tsx','utf8')),false,'the help topic is no longer keyed on the view and flags');
 check(/pageCrumbs|lastAgentRoute|'agents'/.test(fs.readFileSync('ui/shell/console.tsx','utf8')),false,'the console has no Agents area and no settings or automation crumbs');
}

// 10. The docs name the new places: no old page name is left in docs/.
{
 const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?walk(path.join(dir,entry.name)):[path.join(dir,entry.name)]);
 const old=['Settings → Security','Settings → License','Settings → Notifications','Settings → Portal log','**Settings** → **Maintenance**','page **Maintenance**','page **License**','Agents →'];
 const hits=walk('docs').filter(file=>file.endsWith('.md')).flatMap(file=>{const text=fs.readFileSync(file,'utf8');return old.filter(phrase=>phrase==='Settings → License'?/Settings → License(?! & usage data)/.test(text):text.includes(phrase)).map(phrase=>`${file}: ${phrase}`);});
 check(hits,[],'no old page name in docs/');
}

console.log(`PASS nav model (${checks} checks): rail and shortcuts per viewer without Agents, the settings groups, Add device in Devices, the crumb rule, scope tab and device links, palette pages, help topics, the shortcut list, the static checks and the doc scan.`);
