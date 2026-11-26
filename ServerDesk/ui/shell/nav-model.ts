// The navigation model of the console: one typed tree of the rail areas, their pages (with the settings groups and the
// page tabs), the scope tabs with their subs and the device areas with their subareas. Every node has its label, an optional hint, an
// icon name, its route (a ConsoleRoute; the hash comes from consoleRouteHash), a visibility rule, a help topic, an
// optional shortcut, palette data, and its current placement: the rail area and the navigator, tab bar or subarea bar
// it renders in. The rail, the navigator, the breadcrumbs, the palette pages, the help topic lookup, the G shortcuts,
// the scope tab links and the device area links read this module, so a page moves by changing its node here.
//
// Pure: no JSX, no CSS, no React. Icons are lucide-react names; ui/shell/nav-icons.ts maps them to components.
// Visibility calls the existing capability functions (ui/base/access-capabilities.ts, fleetScopeTabs, customerViewAvailable)
// and adds no rights logic of its own.
import type {DeviceGroup,Server,Viewer} from '@/lib/types';
import type {MessageKey} from '@/lib/i18n/translate';
import {detectTargets} from '@/lib/extensions';
import {canManageCustomers,canManageRoleAssignments,canOpenAccessSection,isOwner,canManageGroup} from '@/ui/base/access-capabilities';
import {configurationDetailLabels,configurationDetails,consoleRouteHash,monitoringDetailLabels,monitoringDetails,deviceMainSection,deviceDetailRoute,diagnosticsDetails,diagnosticsDetailLabels,hardwareDetails,hardwareDetailLabels,historyDetails,historyDetailLabels,isSettingsPage,managementDetails,managementDetailLabels,pageTabsOf,softwareDetailLabels,softwareDetails,type AgentSettingsPage,type AutomationPage,type ConsoleRoute,type DeviceMainSection,type DeviceSection,type SettingsPage,type SettingsSection} from '@/lib/console-route';
import {customerViewAvailable,fleetScopeTabs,scopeTabGroups,type FleetScope,type FleetScopeTab,type ScopeTabGroup} from '@/ui/devices/fleet/fleet-scope';

/** The rail areas, plus the account page in the account menu. */
export type Area='dashboard'|'devices'|'automation'|'settings'|'account';
/** The lucide-react icons of the nodes (ui/shell/nav-icons.ts). */
export type NavIcon='MonitorSmartphone'|'HeartPulse'|'Siren'|'History'|'ServerCog'|'Lock'|'ShieldCheck'|'CircuitBoard'|'Activity'|'BadgeCheck'|'ChartColumn'|'Rocket'|'BellRing'|'Send'|'Tag'|'Server'|'Play'|'Package'|'Settings'|'Settings2'|'CalendarClock'|'GitCompareArrows'|'ClipboardCheck'|'UserRound'|'Users'|'LogIn'|'KeyRound'|'Building2'|'ShieldAlert'|'Sparkles'|'ScrollText'|'Wrench'|'Download'|'PackageX'|'LifeBuoy'|'LayoutDashboard'|'Cpu'|'Monitor'|'ChevronRight'|'Puzzle'|'Palette';
/** The help topics (ui/shell/help-panel.tsx). */
export type HelpTopic='dashboard'|'fleet'|'problems'|'alarms'|'alert-rules'|'notifications'|'tags'
 |'software'|'extensions'|'os-support'|'encryption'|'protection'|'drivers'|'reliability'|'certificates'|'autostart'
 |'device-overview'|'device-hardware'|'device-diagnostics'|'device-management'|'device-remote'|'device-automation'|'device-history'|'device-extensions'
 |'device-software'|'device-drivers'|'device-certificates'|'device-autostart'|'device-defender'|'dhcp'|'dns'
 |'assistant'|'usageData'|'customers'|'branding'|'sessions'|'entra'|'retention'|'vulnerabilities'|'access'|'automation'|'agent-releases'|'extension-releases'|'agents'|'account';
/** What a visibility rule may look at. viewer is required; the rest is set where the rule needs it. */
export type NavContext={
 viewer:Pick<Viewer,'permissions'|'canManageDeviceGroups'>;
 /** The open scope and its group (scope tabs). */
 scope?:FleetScope;group?:Pick<DeviceGroup,'permissions'>;
 /** The visible customers (customer scopes). */
 customers?:readonly {id:string}[];
 /** The open device: the Extensions area and its DHCP and DNS subareas. */
 server?:Pick<Server,'snapshot'|'serverSoftware'>;
 /** True once a second customer exists (ConsoleData.multipleCustomers). */
 multipleCustomers?:boolean;
};
/**
 * Where a node renders today. in 'navigator' is an entry of the area's navigator; 'page' is a page of the area without
 * a navigator entry of its own (Add device, beside the device tree); 'page-tabs' is a tab in the tab bar of its parent
 * page (never a navigator page). group is the navigator group heading of a settings page.
 */
export type NavPlacement={area:Area;in:'rail'|'navigator'|'page'|'page-tabs'|'account-menu'|'scope-tabs'|'scope-subtabs'|'device-tabs'|'device-subtabs'|'device-view-switch';group?:MessageKey;/** A rail item at the end of the rail (bottom on desktop, last on mobile). */end?:boolean};
/** A shortcut: its keys as shown, and for a G target the label, the row order of the shortcut help and an unlisted alias (keys). */
export type NavShortcut={keys:string;label?:MessageKey;order?:number;alias?:string};
/**
 * A palette entry ("Pages"): its id, a label when it differs from the node label (All devices), the hint (the parent
 * path, joined with " › "), keywords (text, or a message key with the settings suffix), icon and order.
 */
export type NavPalette={id:string;label?:MessageKey;hint?:readonly MessageKey[];keywords?:string;keywordsKey?:MessageKey;settingsSuffix?:boolean;icon?:NavIcon;order:number};
export type NavNode={
 id:string;label:MessageKey;hint?:MessageKey;icon:NavIcon;
 /** The route of the node. Scope tabs hold the All devices form and device nodes an empty device id; scopeTabRoute and deviceNodeRoute fill them in. */
 route:ConsoleRoute;
 visible:(context:NavContext)=>boolean;
 help:HelpTopic;
 shortcut?:NavShortcut;
 palette?:NavPalette;
 placement:NavPlacement;
 /** Area nodes: the navigator title and breadcrumb root. Automation pages: the page header subtitle. */
 title?:MessageKey;subtitle?:MessageKey;
 /** The internal id the view renders: the settings section (AccessWorkspace), the agent page (Agent releases, Extensions or troubleshooting), the fleet tab, the page tab, the device section or subarea. Settings ids are the page names. */
 section?:SettingsSection;agentTab?:AgentSettingsPage;tab?:string;deviceSection?:DeviceSection;sub?:string;
 /** Device areas: the search words of the area entry in the palette, besides its label. */
 keywords?:string;
 /** Scope tabs and subtabs: the scope tab they render in (a tab node's tab is its default subtab). */
 scopeTab?:ScopeTabGroup;
 children?:NavNode[];
};

const always=()=>true;
const page=(id:string,node:Omit<NavNode,'id'|'visible'>&{visible?:NavNode['visible']}):NavNode=>({id,visible:always,...node});

// The palette hints: the parent path of a page. The scope (All devices) is the root of the scope tab hints.
const allDevicesLabel:MessageKey='nav.allDevices',allDevicesHint:readonly MessageKey[]=[allDevicesLabel],automationHint:readonly MessageKey[]=['nav.automation.title'],settingsHint:readonly MessageKey[]=['palette.hint.settings'];

/** The label keys of the page tabs, as their tab bars show them (Runbooks: Library … Device status; Notification channels: Channels, Delivery log). */
const pageTabLabels:Readonly<Record<string,MessageKey>>={library:'device.section.runbooks',runs:'runbooks.runs',schedules:'runbooks.schedules',assignments:'automation.assignments',status:'automation.deviceState',configurations:'desired.configs',history:'automation.tab.history',reference:'automation.referenceDevices',channels:'notifications.tab.channels',log:'notifications.tab.log'};
/**
 * A page with its tabs (automationPageTabs, settingsPageTabs) as children in tab bar order: id <page id>.<tab>, the tab
 * label, the page route with the tab (the first tab has none), the page's visibility rule and help topic. Every tab but
 * the first gets a palette entry right after its page: the hint is the page's hint path plus the page label ("Automation
 * › Runbooks"), the icon is the page's palette icon, the keywords are the page's (paletteKeywords).
 */
const withPageTabs=(node:NavNode):NavNode=>{
 const tabs=pageTabsOf(node.route);
 if(!tabs.length)return node;
 const children=tabs.map((tab,index):NavNode=>({id:`${node.id}.${tab}`,label:pageTabLabels[tab],icon:node.icon,tab,route:index?{...node.route,tab}:node.route,visible:node.visible,help:node.help,placement:{area:node.placement.area,in:'page-tabs'},
  ...(index&&node.palette?{palette:{id:`${node.palette.id}-${tab}`,hint:[...(node.palette.hint??[]),node.label],icon:node.palette.icon??node.icon,order:node.palette.order+index/100}}:{})}));
 return {...node,children};
};

// Automation: the three pages of the navigator, in navigator order, each with its tabs.
const automationNode=(automationPage:AutomationPage,icon:NavIcon,label:MessageKey,hint:MessageKey,subtitle:MessageKey,order:number)=>withPageTabs(page('automation.'+automationPage,{label,hint,subtitle,icon,route:{view:'automation',page:automationPage},help:'automation',placement:{area:'automation',in:'navigator'},palette:{id:'page-automation-'+automationPage,hint:automationHint,keywords:'automatisierung',icon:'Play',order}}));
const automationNodes:NavNode[]=[
 automationNode('runbooks','CalendarClock','nav.automation.runbooks','nav.automation.runbooksHint','nav.automation.runbooksSubtitle',30),
 automationNode('desired','ClipboardCheck','nav.automation.desired','nav.automation.desiredHint','nav.automation.desiredSubtitle',31),
 automationNode('drift','GitCompareArrows','nav.automation.drift','nav.automation.driftHint','nav.automation.driftSubtitle',32),
];

// Add device (#devices/add[/installer]): a page of the Devices area beside the device tree, for the Owner, with the tabs
// One device and Several devices (ui/devices/add-device/add-device.tsx). It also shows the portal certificate.
const addDeviceNode:NavNode=page('devices.add',{label:'nav.devices.add',hint:'nav.devices.addHint',icon:'Download',route:{view:'add-device'},visible:({viewer})=>isOwner(viewer),help:'agents',shortcut:{keys:'G N',label:'shortcuts.addDevice',order:4},placement:{area:'devices',in:'page'},palette:{id:'page-add-device',hint:allDevicesHint,keywords:'agent registrieren installieren installer zertifikat certificate fingerprint',order:25}});

// Settings: the groups in navigator order, then the pages in navigator order with their group. Each page opens with its
// section right; the agent pages the Owner right.
const settingsGroupOrder:readonly MessageKey[]=['nav.settings.groupUsers','nav.settings.groupOrganization','nav.settings.groupIntegrations','nav.settings.groupAgents','nav.settings.groupSystem'];
const settingsPalette=(id:string,order:number,keywords:Pick<NavPalette,'keywords'|'keywordsKey'>):NavPalette=>({id,hint:settingsHint,...keywords,settingsSuffix:true,order});
const settingsNode=(section:SettingsSection,label:MessageKey,icon:NavIcon,group:MessageKey,help:HelpTopic,keywordsKey:MessageKey,order:number)=>withPageTabs(page('settings.'+section,{label,hint:(label+'Hint') as MessageKey,icon,section,route:{view:'settings',page:section},
 visible:({viewer})=>section==='customers'?canManageCustomers(viewer):canOpenAccessSection(viewer,section),help,placement:{area:'settings',in:'navigator',group},palette:settingsPalette('page-settings-'+section,order,{keywordsKey})}));
const agentSettingsNode=(agentTab:AgentSettingsPage,label:MessageKey,icon:NavIcon,help:HelpTopic,keywords:string,order:number)=>page('settings.'+agentTab,{label,hint:(label+'Hint') as MessageKey,icon,agentTab,route:{view:'settings',page:agentTab},
 visible:({viewer})=>isOwner(viewer),help,placement:{area:'settings',in:'navigator',group:'nav.settings.groupAgents'},palette:settingsPalette('page-settings-'+agentTab,order,{keywords})});
const settingsNodes:NavNode[]=[
 settingsNode('accounts','nav.settings.accounts','UserRound','nav.settings.groupUsers','access','rbac.paletteKeywords',40),
 settingsNode('user-groups','nav.settings.userGroups','Users','nav.settings.groupUsers','access','rbac.paletteKeywords',41),
 settingsNode('roles','nav.settings.roles','KeyRound','nav.settings.groupUsers','access','rbac.paletteKeywords',42),
 settingsNode('entra','nav.settings.entra','LogIn','nav.settings.groupUsers','entra','entra.paletteKeywords',43),
 settingsNode('sessions','nav.settings.sessions','ShieldCheck','nav.settings.groupUsers','sessions','sessionSettings.paletteKeywords',44),
 settingsNode('customers','nav.settings.customers','Building2','nav.settings.groupOrganization','customers','customers.paletteKeywords',45),
 settingsNode('branding','nav.settings.branding','Palette','nav.settings.groupOrganization','branding','branding.paletteKeywords',46),
 settingsNode('notification-channels','nav.settings.notificationChannels','Send','nav.settings.groupIntegrations','notifications','notifications.paletteKeywords',47),
 settingsNode('vulnerabilities','nav.settings.vulnerabilities','ShieldAlert','nav.settings.groupIntegrations','vulnerabilities','vulnerabilities.paletteKeywords',48),
 settingsNode('assistant','nav.settings.assistant','Sparkles','nav.settings.groupIntegrations','assistant','assistantSettings.paletteKeywords',49),
 agentSettingsNode('agent-releases','nav.settings.agentReleases','Package','agent-releases','agent releases versions',50),
 agentSettingsNode('extensions','nav.settings.extensions','Puzzle','extension-releases','extensions erweiterungen plugins releases rollout dhcp dns',50.5),
 agentSettingsNode('agent-troubleshooting','nav.settings.agentTroubleshooting','LifeBuoy','agents','agent troubleshooting missing device uninstall fehlersuche deinstallieren',51),
 settingsNode('retention','nav.settings.retention','Wrench','nav.settings.groupSystem','retention','maintenancePage.paletteKeywords',52),
 settingsNode('audit','nav.settings.audit','ScrollText','nav.settings.groupSystem','access','rbac.paletteKeywords',53),
 settingsNode('usage-data','nav.settings.usageData','ChartColumn','nav.settings.groupSystem','usageData','usageData.paletteKeywords',54),
];

// Scope tabs: the five tabs (scopeTabGroups) with their subtabs (fleetScopeTabs). A tab node holds the route of its default
// subtab; a subtab node holds its fleet tab, help topic and palette data.
const scopeTabHelp:Partial<Record<string,HelpTopic>>={problems:'problems',alarms:'alarms',software:'software',extensions:'extensions','os-support':'os-support',encryption:'encryption',protection:'protection',drivers:'drivers',reliability:'reliability',certificates:'certificates',autostart:'autostart',alerts:'alert-rules',notifications:'notifications',tags:'tags'};
// The palette entries of the All devices scope tabs, in tab bar order, with the tab label. The Devices tab is "All
// devices" itself; the hints come from the tree: "All devices" for a tab, "All devices › <tab>" for a subtab.
const scopeTabPalette:Partial<Record<string,NavPalette>>={
 devices:{id:'page-devices',label:allDevicesLabel,keywordsKey:'console.paletteKeywords',icon:'Server',order:0},
 // The Monitoring tab: one entry (id page-alarms, kept for stored palette history) with the words of its views; it opens By device.
 'monitoring-tab':{id:'page-alarms',keywordsKey:'monitoringTab.paletteKeywords',icon:'Siren',order:2},
 jobs:{id:'page-jobs',keywords:'jobs',icon:'Activity',order:3},
 access:{id:'page-device-access',keywords:'access log sign-ins zugriffe',icon:'ScrollText',order:4},
 software:{id:'page-software',keywords:'software programs inventory',icon:'Package',order:5},
 extensions:{id:'page-fleet-extensions',keywords:'extensions erweiterungen plugins roles rollen dhcp dns active directory sql exchange veeam',icon:'Puzzle',order:6},
 'os-support':{id:'page-os-support',keywords:'lifecycle esu support windows',icon:'CalendarClock',order:7},
 encryption:{id:'page-encryption',keywords:'bitlocker encryption',icon:'Lock',order:8},
 protection:{id:'page-protection',keywords:'defender antivirus threat scan protection schutz',icon:'ShieldCheck',order:9},
 drivers:{id:'page-drivers',keywords:'drivers device manager unsigned',icon:'CircuitBoard',order:10},
 reliability:{id:'page-reliability',keywords:'reliability stability crashes hangs',icon:'Activity',order:11},
 certificates:{id:'page-certificates',keywords:'certificates expiry tls https rdp',icon:'BadgeCheck',order:12},
 autostart:{id:'page-autostart',keywords:'autostart run startup services tasks',icon:'Rocket',order:13},
 alerts:{id:'page-alert-rules',keywords:'alerts alarms thresholds',icon:'BellRing',order:14},
 notifications:{id:'page-notification-rules',keywords:'notifications rules benachrichtigungen regeln',icon:'Send',order:15},
 permissions:{id:'page-permissions',keywords:'permissions rights berechtigungen',icon:'KeyRound',order:16},
};
// The icons of the scope tabs and subtabs: the tab bars show none, the palette and the model use them.
const scopeTabIcons:Readonly<Record<FleetScopeTab['id']|ScopeTabGroup,NavIcon>>={devices:'MonitorSmartphone',monitoring:'Siren',problems:'HeartPulse',alarms:'Siren',inventory:'Package',history:'History',configuration:'Settings2',jobs:'Activity',access:'ScrollText',software:'Package',extensions:'Puzzle','os-support':'CalendarClock',encryption:'Lock',protection:'ShieldCheck',drivers:'CircuitBoard',reliability:'Activity',certificates:'BadgeCheck',autostart:'Rocket',alerts:'BellRing',notifications:'Send',tags:'Tag',permissions:'KeyRound',settings:'Settings'};
/** The rights rule of a fleet tab on top of its scope types: Permissions needs portal.roleAssignments.manage, General canManageGroup. */
const scopeTabRight=(tab:FleetScopeTab['id'],{viewer,group}:NavContext)=>tab==='permissions'?canManageRoleAssignments(viewer):tab==='settings'?canManageGroup(viewer,group):true;
/** A subtab node; its palette hint is the path of its parent tab (parentHint: All devices, then the tab label). */
const scopeSubtabNode=(tab:FleetScopeTab,parentHint:readonly MessageKey[]):NavNode=>{
 const palette=scopeTabPalette[tab.id];
 return {id:`scope.${tab.group}.${tab.id}`,label:tab.label,icon:scopeTabIcons[tab.id],tab:tab.id,scopeTab:tab.group,route:{view:'devices',tab:tab.id},
  visible:context=>(!tab.scopes||!context.scope||tab.scopes.includes(context.scope.type))&&scopeTabRight(tab.id,context),help:scopeTabHelp[tab.id]??'fleet',placement:{area:'devices',in:'scope-subtabs'},
  ...(palette?{palette:{...palette,hint:parentHint}}:{})};
};
const scopeTabNode=({id,label}:typeof scopeTabGroups[number]):NavNode=>{
 if(id==='devices')return {id:'scope.devices',label,icon:scopeTabIcons.devices,tab:'devices',scopeTab:'devices',route:{view:'devices',tab:'devices'},visible:always,help:'fleet',placement:{area:'devices',in:'scope-tabs'},palette:scopeTabPalette.devices};
 const children=fleetScopeTabs.filter(tab=>tab.group===id).map(tab=>scopeSubtabNode(tab,[...allDevicesHint,label])),first=children[0];
 // The Monitoring tab carries the palette entry of its alarm views; Alert rules and Notification rules have their own
 // (hint "All devices › Monitoring"); the other tabs leave it to their subtabs.
 const monitoring=scopeTabPalette['monitoring-tab'],palette=id==='monitoring'&&monitoring?{...monitoring,hint:allDevicesHint}:undefined;
 return {id:'scope.'+id,label,icon:scopeTabIcons[id],tab:first.tab,scopeTab:id,route:first.route,visible:context=>children.some(child=>child.visible(context)),help:first.help,placement:{area:'devices',in:'scope-tabs'},children,...(palette?{palette}:{})};
};
const scopeTabNodes:NavNode[]=scopeTabGroups.map(scopeTabNode);

// Device areas in tab order (review §2.3): keys 1–9 for the first nine, Extensions only with a detected role or product,
// then Monitoring and Configuration without a key; Configuration (Permissions) only with portal.roleAssignments.manage.
// Each area holds its subareas in bar order.
const deviceRoute=(deviceSection:DeviceSection,deviceDetail?:string):ConsoleRoute=>({view:'device',deviceId:'',deviceSection,...(deviceDetail?{deviceDetail}:{})});
const subNode=(area:DeviceMainSection,sub:string,label:MessageKey,route:ConsoleRoute,help:HelpTopic,visible:NavNode['visible']=always):NavNode=>({id:`device.${area}.${sub}`,label,icon:'ChevronRight',sub,route,visible,help,placement:{area:'devices',in:'device-subtabs'}});
const softwareHelp:Readonly<Record<typeof softwareDetails[number],HelpTopic>>={programs:'device-software',drivers:'device-drivers',certificates:'device-certificates',autostart:'device-autostart'};
const managementHelp:Partial<Record<string,HelpTopic>>={defender:'device-defender'};
const monitoringHelp:Readonly<Record<typeof monitoringDetails[number],HelpTopic>>={alarms:'alarms','alert-rules':'alert-rules','notification-rules':'notifications'};
const areaNode=(section:DeviceMainSection,icon:NavIcon,help:HelpTopic,children:NavNode[]=[],extra:Partial<Pick<NavNode,'visible'|'keywords'>>={}):NavNode=>({id:'device.'+section,label:`device.section.${section}` as MessageKey,icon,deviceSection:section,route:deviceRoute(section),visible:always,help,placement:{area:'devices',in:'device-tabs'},children,...extra});
const hasTarget=(role?:string):NavNode['visible']=>({server})=>!server||detectTargets(server).some(entry=>!role||entry.id===role);
/** The DHCP and DNS subareas of Extensions show only with that detected target. */
const extensionsSubNodes:NavNode[]=[
 subNode('extensions','overview','device.section.overview',deviceRoute('extensions','overview'),'device-extensions'),
 subNode('extensions','dhcp','dhcp.title',deviceRoute('extensions','dhcp'),'dhcp',hasTarget('dhcp')),
 subNode('extensions','dns','dns.title',deviceRoute('extensions','dns'),'dns',hasTarget('dns')),
];
/** The palette search words of Extensions: its German name and its former names Plugins and Roles, so "plugins", "roles" and "rollen" still find it. */
export const extensionsKeywords='extensions erweiterungen plugins roles rollen dhcp dns';
const deviceAreaNodes:NavNode[]=[
 areaNode('overview','LayoutDashboard','device-overview'),
 areaNode('hardware','Cpu','device-hardware',hardwareDetails.map(id=>subNode('hardware',id,hardwareDetailLabels[id],deviceRoute('hardware',id),'device-hardware'))),
 areaNode('software','Package','device-software',softwareDetails.map(id=>subNode('software',id,softwareDetailLabels[id],deviceRoute('software',id),softwareHelp[id]))),
 areaNode('diagnostics','Activity','device-diagnostics',diagnosticsDetails.map(id=>subNode('diagnostics',id,diagnosticsDetailLabels[id],deviceRoute('diagnostics',id),'device-diagnostics'))),
 areaNode('management','Settings2','device-management',managementDetails.map(id=>subNode('management',id,managementDetailLabels[id],deviceRoute('management',id),managementHelp[id]??'device-management'))),
 areaNode('remote','Monitor','device-remote',(['files','terminal','rdp'] as const).map(id=>subNode('remote',id,`device.section.${id}`,deviceRoute(id),'device-remote'))),
 areaNode('automation','Play','device-automation',(['runbooks','desired','drift'] as const).map(id=>subNode('automation',id,`device.section.${id}`,deviceRoute(id),'device-automation'))),
 areaNode('history','History','device-history',historyDetails.map(id=>subNode('history',id,historyDetailLabels[id],deviceRoute('history',id),'device-history'))),
 areaNode('extensions','Puzzle','device-extensions',extensionsSubNodes,{visible:hasTarget(),keywords:extensionsKeywords}),
 areaNode('monitoring','Siren','alarms',monitoringDetails.map(id=>subNode('monitoring',id,monitoringDetailLabels[id],deviceRoute('monitoring',id),monitoringHelp[id]))),
 areaNode('configuration','Settings','access',configurationDetails.map(id=>subNode('configuration',id,configurationDetailLabels[id],deviceRoute('configuration',id),'access',({viewer})=>canManageRoleAssignments(viewer))),{visible:({viewer})=>canManageRoleAssignments(viewer)}),
];

// The Dashboard (#dashboard, ui/devices/dashboard/dashboard-view.tsx): the first rail area and the default start page. It has
// no navigator and no pages below it; G H (home) opens it.
const dashboardNode:NavNode={id:'dashboard',label:'rail.dashboard',hint:'dashboard.subtitle',icon:'LayoutDashboard',route:{view:'dashboard'},visible:always,help:'dashboard',shortcut:{keys:'G H',label:'shortcuts.dashboard',order:0},placement:{area:'dashboard',in:'rail'},palette:{id:'page-dashboard',keywordsKey:'dashboard.paletteKeywords',order:-1}};
// The rail areas, in rail order; Settings sits at the end. Each area holds its scope tabs or the pages of its navigator;
// Devices also holds Add device. G I stays an unlisted alias of G S for one release.
const railNodes:NavNode[]=[
 dashboardNode,
 {id:'devices',label:'rail.devices',title:'rail.devices',icon:'Server',route:{view:'devices',tab:'devices'},visible:always,help:'fleet',shortcut:{keys:'G D',label:'shortcuts.devices',order:1},placement:{area:'devices',in:'rail'},children:[...scopeTabNodes,addDeviceNode]},
 {id:'automation',label:'rail.automation',title:'nav.automation.title',icon:'Play',route:{view:'automation',page:'runbooks'},visible:always,help:'automation',shortcut:{keys:'G A',label:'shortcuts.automation',order:2},placement:{area:'automation',in:'rail'},children:automationNodes},
 {id:'settings',label:'rail.settings',title:'nav.settings.title',icon:'Settings',route:{view:'settings',page:'accounts'},visible:context=>settingsNodes.some(node=>node.visible(context)),help:'access',shortcut:{keys:'G S',label:'shortcuts.administration',order:3,alias:'G I'},placement:{area:'settings',in:'rail',end:true},children:settingsNodes},
];
const accountNode:NavNode={id:'account',label:'nav.account.title',hint:'nav.account.subtitle',icon:'UserRound',route:{view:'account'},visible:always,help:'account',shortcut:{keys:'G K',label:'shortcuts.account',order:5},placement:{area:'account',in:'account-menu'},palette:{id:'page-account',keywords:'passwort mfa passkey',icon:'UserRound',order:60}};

/** The whole tree: the rail areas with their pages and scope tabs, the account page, and the device areas with their subareas. */
export const navTree={rail:railNodes,account:accountNode,deviceAreas:deviceAreaNodes} as const;

const walk=(nodes:readonly NavNode[]):NavNode[]=>nodes.flatMap(node=>[node,...walk(node.children??[])]);
/** Every node of the tree, depth first. */
export const navNodes:readonly NavNode[]=walk([...railNodes,accountNode,...deviceAreaNodes]);
export const navNode=(id:string)=>navNodes.find(node=>node.id===id);

/** The rail items a viewer sees, in rail order (Settings last). */
export function visibleRail(context:NavContext):NavNode[]{return railNodes.filter(node=>node.visible(context));}
/** The navigator pages of an area, in navigator order, filtered by visibility. */
export function navigatorPages(area:'automation'|'settings',context:NavContext):NavNode[]{return (railNodes.find(node=>node.id===area)?.children??[]).filter(node=>node.visible(context));}
/** The settings pages a viewer sees, under their group headings in navigator order. A group without a visible page is left out. */
export function settingsGroups(context:NavContext):{group:MessageKey;pages:NavNode[]}[]{
 return settingsGroupOrder.map(group=>({group,pages:settingsNodes.filter(node=>node.placement.group===group&&node.visible(context))})).filter(({pages})=>pages.length>0);
}
/** The first settings page a viewer may open (the G S target), or undefined. */
/** The settings page of a route, or undefined. */
const settingsPageIn=(route:ConsoleRoute):SettingsPage|undefined=>isSettingsPage(route.page)?route.page:undefined;
export function firstSettingsPage(context:NavContext):SettingsPage|undefined{const node=settingsNodes.find(item=>item.visible(context));return node&&settingsPageIn(node.route);}
/**
 * The page key of a route: its canonical hash without the fields of one instance (the add-device segments and the tab
 * of an automation or settings page, which is a view inside the page: #automation/runbooks/runs,
 * #settings/notification-channels/log). A page node and a route of the same page have the same key, wherever the node
 * is placed in the tree.
 */
const pageKey=(route:ConsoleRoute)=>consoleRouteHash({view:route.view,...(route.page?{page:route.page}:{}),...(route.tab&&route.view==='devices'?{tab:route.tab}:{})});
/** The page nodes: the Dashboard, every page of the rail areas (navigator entries and pages such as Add device) and the account page, wherever the model places them. */
const pageNodes=():NavNode[]=>[dashboardNode,...walk(railNodes).filter(node=>node.placement.in==='navigator'||node.placement.in==='page'),accountNode];
/**
 * The page node of a page route (add-device, automation, settings, account) among the given nodes: the node whose
 * declared route has the same page key. Exported for the tests, which pass a tree with a page moved elsewhere.
 */
export function pageNodeIn(nodes:readonly NavNode[],route:ConsoleRoute):NavNode|undefined{
 const key=pageKey(route);
 return nodes.find(node=>pageKey(node.route)===key);
}
/** The section of a settings route that AccessWorkspace renders, or null for a page without one (the agent pages). */
export function settingsSection(route:Pick<ConsoleRoute,'page'|'tab'>):SettingsSection|null{return pageNodeIn(pageNodes(),{view:'settings',...route})?.section??null;}

/** The scope fields of a route (#devices, a group, a customer, either Ungrouped scope). */
function scopeRouteFields(scope:FleetScope):Pick<ConsoleRoute,'groupId'|'customerId'>{
 return scope.type==='group'?{groupId:scope.id}:scope.type==='customer'?{customerId:scope.id}:scope.type==='unassigned'?{groupId:'unassigned',...(scope.customerId?{customerId:scope.customerId}:{})}:{};
}
/** The route of a fleet tab on a scope. */
function scopeTabRoute(scope:FleetScope,tab:string):ConsoleRoute{return {view:'devices',...scopeRouteFields(scope),tab};}
/** The link of a scope tab: the scope with the fleet tab. The Devices tab links to the scope itself. */
export function scopeTabHref(scope:FleetScope,tab:string):string{return consoleRouteHash(scopeTabRoute(scope,tab));}
/**
 * The five scope tabs in order: Devices, Monitoring, Inventory, History and Configuration; the last four hold their subtabs as
 * children, the first child is the default. The tab bars (FleetView) show a subtab when the console passes its content
 * (shownScopeTab) and a tab with at least one shown subtab; the console builds that content under the same rights, so the
 * visibility rule of a node is what the palette and the model tests read.
 */
export const scopeTabs:readonly NavNode[]=scopeTabNodes;
/** The subtab nodes of a scope tab, in bar order; Devices has none. */
export function scopeSubtabs(group:ScopeTabGroup):NavNode[]{return scopeTabNodes.find(node=>node.scopeTab===group)?.children??[];}
/**
 * The fleet tab a scope shows: a tab whose content the console does not pass (present false or missing: Permissions,
 * General, Tags, Notification rules, Alert rules without the right or the scope) shows the Devices tab.
 */
export function shownScopeTab<T extends string>(tab:T,present:Partial<Record<'permissions'|'settings'|'tags'|'notifications'|'alerts',boolean>>):T|'devices'{
 const optional=['permissions','settings','tags','notifications','alerts'] as const;
 return optional.some(item=>item===tab&&!present[item])?'devices':tab;
}
/** True when a scope may open: a customer (or its Ungrouped scope) only while the viewer sees at least two customers (customerViewAvailable). */
export function scopeAvailable(scope:FleetScope,context:NavContext):boolean{
 const customer=scope.type==='customer'?scope.id:scope.type==='unassigned'?scope.customerId:undefined;
 return customer===undefined||customerViewAvailable(context.customers,customer);
}

/**
 * The device areas of this device and viewer in tab order: the fixed areas, plus Extensions before
 * Monitoring with a detected role or product, and Configuration last only when the viewer has portal.roleAssignments.manage.
 */
export function visibleDeviceAreas(server:Pick<Server,'snapshot'|'serverSoftware'>,viewer:NavContext['viewer']={}):NavNode[]{return deviceAreaNodes.filter(node=>node.visible({viewer,server}));}
/** The areas that the keys 1–9 open, in key order: every visible area but Monitoring and Configuration, which have no key. */
export function deviceKeyAreas(server:Pick<Server,'snapshot'|'serverSoftware'>):NavNode[]{return visibleDeviceAreas(server).filter(node=>node.deviceSection!=='monitoring'&&node.deviceSection!=='configuration').slice(0,9);}
/** The device areas every device has (all but Extensions). */
export const fixedDeviceAreas:readonly NavNode[]=deviceAreaNodes.filter(node=>node.deviceSection!=='extensions');
/** The subarea nodes of a device area, in bar order. */
export function deviceSubareas(area:DeviceMainSection):NavNode[]{return deviceAreaNodes.find(node=>node.deviceSection===area)?.children??[];}
/** The subarea nodes of a device area that this viewer and device have (Permissions with the right, DHCP and DNS with the role), in bar order. */
export function visibleDeviceSubareas(area:DeviceMainSection,context:NavContext):NavNode[]{return deviceSubareas(area).filter(node=>node.visible(context));}
/** The route of a device node for one device. */
function deviceNodeRoute(node:Pick<NavNode,'route'>,deviceId:string,extra:Pick<ConsoleRoute,'gpu'|'zone'>={}):ConsoleRoute{return {...node.route,deviceId,...extra};}
/** The link of a device area tab. */
export function deviceAreaHref(deviceId:string,id:DeviceMainSection):string{
 const node=deviceAreaNodes.find(item=>item.deviceSection===id);
 return consoleRouteHash(node?deviceNodeRoute(node,deviceId):{view:'device',deviceId});
}
/** The link of a device subarea: the subarea node of the area, with the GPU position on Hardware. */
export function deviceSubareaHref(deviceId:string,area:DeviceMainSection,sub:string,extra:Pick<ConsoleRoute,'gpu'|'zone'>={}):string{
 const node=deviceSubareas(area).find(item=>item.sub===sub);
 return consoleRouteHash(node?deviceNodeRoute(node,deviceId,extra):{view:'device',deviceId,deviceSection:area});
}

/**
 * The node of a route: the page, the scope subtab (or the Devices tab), or the device area or subarea. The navigator
 * selection, the breadcrumbs, the page header and the help topic read it.
 */
export function routeNode(route:ConsoleRoute):NavNode|undefined{
 if(route.view==='dashboard'||route.view==='account'||route.view==='add-device'||route.view==='automation'||route.view==='settings')return pageNodeIn(pageNodes(),route);
 if(route.view==='devices'){const tab=route.tab??'devices';return walk(scopeTabNodes).find(node=>node.tab===tab&&!node.children)??scopeTabNodes[0];}
 const section=route.deviceSection??'overview',main=deviceMainSection(section),area=deviceAreaNodes.find(node=>node.deviceSection===main);
 const sub=main==='remote'||main==='automation'?(section===main?area?.children?.[0]:area?.children?.find(node=>node.sub===section))
  :area?.children?.find(node=>node.sub===(deviceDetailRoute(main,route.deviceDetail).deviceDetail??area.children?.[0]?.sub));
 return sub??area;
}
/**
 * The tab nodes of the page of a route (an automation or settings page), in tab bar order, the first tab first; [] for a
 * page without tabs. The tab bars (AutomationWorkspace, NotificationsPanel) build their items from them: id node.tab,
 * label node.label, href consoleRouteHash(node.route).
 */
export function pageTabNodes(route:ConsoleRoute):NavNode[]{
 if(route.view!=='automation'&&route.view!=='settings')return [];
 return routeNode(route)?.children?.filter(node=>node.placement.in==='page-tabs')??[];
}
/** The rail area a route belongs to: its node's placement (Add device is a page of Devices, the agent pages are settings pages). */
export function areaOf(route:Pick<ConsoleRoute,'view'|'page'|'tab'>):Area{
 if(route.view==='devices'||route.view==='device')return 'devices';
 return routeNode(route as ConsoleRoute)?.placement.area??'devices';
}
/** The area node (rail item) of an area. */
export function areaNodeOf(area:Area):NavNode|undefined{return area==='account'?accountNode:railNodes.find(node=>node.id===area);}
/**
 * The crumb button of a navigator page (Automation, Settings): the area title. These pages have no breadcrumbs, since
 * their hierarchy is the navigator; at 900px or narrower the button opens the navigator overlay. Other pages: undefined.
 */
export function areaCrumbOf(node:NavNode):MessageKey|undefined{
 return node.placement.in==='navigator'?areaNodeOf(node.placement.area)?.title:undefined;
}
/**
 * The help topic of a route. Pass the route of what the console shows (a tab without its element shows Devices, a
 * Extensions link on a device without a detection shows the Overview).
 */
export function helpTopicFor(route:ConsoleRoute):HelpTopic{
 return routeNode(route)?.help??'fleet';
}

/** The palette group "Pages": the nodes with palette data, in palette order. */
export const palettePages:readonly NavNode[]=navNodes.filter(node=>node.palette).sort((a,b)=>a.palette!.order-b.palette!.order);
/** The hint of a palette page: its parent path ("All devices › History"), or undefined for a top page. */
export function paletteHint(node:NavNode,t:(key:MessageKey)=>string):string|undefined{
 const hint=node.palette?.hint;
 return hint?.length?hint.map(key=>t(key)).join(' › '):undefined;
}
/** The search words of a palette page; settings pages add the translated hint. A page tab has the words of its page. */
export function paletteKeywords(node:NavNode,t:(key:MessageKey)=>string):string|undefined{
 const palette=node.palette;if(!palette)return undefined;
 const tabPage=node.placement.in==='page-tabs'?navNodes.find(item=>item.children?.includes(node)):undefined;
 if(tabPage)return paletteKeywords(tabPage,t);
 const words=palette.keywordsKey?t(palette.keywordsKey):palette.keywords,hint=paletteHint(node,t);
 return palette.settingsSuffix&&hint?`${words} ${hint.toLowerCase()}`:words;
}

const goKey=(keys:string)=>keys.split(' ')[1].toLowerCase();
/** The G shortcuts in the order of the shortcut help: dashboard, devices, automation, settings, add device, account. */
export const goShortcuts:readonly {key:string;node:NavNode;label:MessageKey}[]=navNodes.filter(node=>node.shortcut?.label).sort((a,b)=>(a.shortcut!.order??0)-(b.shortcut!.order??0))
 .map(node=>({key:goKey(node.shortcut!.keys),node,label:node.shortcut!.label!}));
/** The node of G then a key: a listed G shortcut, or an unlisted alias (G I for Settings). */
export function goShortcutNode(key:string):NavNode|undefined{
 const letter=key.toLowerCase();
 return goShortcuts.find(item=>item.key===letter)?.node??goShortcuts.find(item=>item.node.shortcut?.alias&&goKey(item.node.shortcut.alias)===letter)?.node;
}
