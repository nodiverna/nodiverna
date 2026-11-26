import type {MessageKey} from './i18n/translate';
// The hash grammar of the console. parseConsoleRoute and consoleRouteHash are the only two functions that know it;
// every other module builds its links with consoleRouteHash or through the navigation model (ui/shell/nav-model.ts).
//
//   #dashboard                                     the Dashboard (docs/dashboard.md), the default start page
//   #devices[/<tab>[/<sub>]]                       scope "All devices"; <tab> = monitoring | inventory | history | configuration
//   #devices/group/<id>[/<tab>[/<sub>]]            a device group
//   #devices/customer/<id>[/<tab>[/<sub>]]         a customer
//   #devices/ungrouped[/<tab>[/<sub>]]             the devices without a group
//   #devices/customer/<id>/ungrouped[/<tab>[/<sub>]]  the devices of a customer without a group
//   #devices/add[/installer][/customer/<id>][/group/<id>]
//   #device/<id>[/<area>[/<sub>[/<n>]]]            <n> = GPU position or DNS zone
//   #automation/<page>[/<tab>]                    <tab> from automationPageTabs; the first tab of a page is its default
//   #settings/<page>[/<tab>]                      <tab> from settingsPageTabs; the first tab of a page is its default
//   #account
//
// Default tabs and subs are never written; the one exception is the device Permissions link, always
// #device/<id>/configuration/permissions, since the bare Configuration link was the alert rules link. Every older hash (docs/device-workspace.md, "Old links") parses to the
// route that replaced it, so consoleRouteHash(parseConsoleRoute(old)) is its canonical form; the console replaces the
// address with it without a history entry.
export type ConsoleView='dashboard'|'devices'|'device'|'add-device'|'automation'|'settings'|'account';
/** The pages of #settings/<page>. The navigation model (ui/shell/nav-model.ts) places them under their settings group. */
export const settingsPages=['accounts','user-groups','roles','entra','sessions','customers','branding','notification-channels','vulnerabilities','assistant','agent-releases','extensions','agent-troubleshooting','retention','audit','usage-data'] as const;
export type SettingsPage=typeof settingsPages[number];
/** The agent settings pages, rendered by the console itself (Agent releases, Extensions, Agent troubleshooting). */
export type AgentSettingsPage='agent-releases'|'extensions'|'agent-troubleshooting';
/** The settings pages AccessWorkspace renders (every settings page but the three agent pages); their ids are the page names. */
export type SettingsSection=Exclude<SettingsPage,AgentSettingsPage>;
/**
 * The tabs of each settings page with tabs (#settings/<page>/<tab>), in tab bar order, as automationPageTabs. The first
 * tab is the page's default and never written to the hash: Notification channels opens Channels, and
 * #settings/notification-channels/log opens the Delivery log. An unknown segment opens the first tab. Uninstall is a
 * section of Agent troubleshooting, not a tab.
 */
export const settingsPageTabs:Readonly<Partial<Record<SettingsPage,readonly string[]>>>={'notification-channels':['channels','log']};
export const isSettingsPage=(value:unknown):value is SettingsPage=>typeof value==='string'&&(settingsPages as readonly string[]).includes(value);
/** The automation pages of #automation/<page>; the first is the default. */
export const automationPages=['runbooks','desired','drift'] as const;
export type AutomationPage=typeof automationPages[number];
/**
 * The tabs of each automation page (#automation/<page>/<tab>), in tab bar order. The first tab is the page's default
 * and never written to the hash. This list is the only place that names them.
 */
export const automationPageTabs={
 runbooks:['library','runs','schedules','assignments','status'],
 desired:['configurations','assignments','status','history'],
 drift:['assignments','status','reference'],
} as const satisfies Record<AutomationPage,readonly string[]>;
export type AutomationPageTab<P extends AutomationPage=AutomationPage>=typeof automationPageTabs[P][number];
export const isAutomationPage=(value:unknown):value is AutomationPage=>typeof value==='string'&&(automationPages as readonly string[]).includes(value);
/** The tab of an automation page: a known tab, or the page's default for anything else. */
export function automationPageTab(page:AutomationPage,tab:unknown):AutomationPageTab{
 const tabs:readonly string[]=automationPageTabs[page];
 return (typeof tab==='string'&&tabs.includes(tab)?tab:tabs[0]) as AutomationPageTab;
}
/** The tabs of the page of a route, default first: an automation page or a settings page with tabs; [] for a page without tabs. */
export function pageTabsOf(route:Pick<ConsoleRoute,'view'|'page'>):readonly string[]{
 if(route.view==='automation')return automationPageTabs[isAutomationPage(route.page)?route.page:'runbooks'];
 if(route.view==='settings'&&isSettingsPage(route.page))return settingsPageTabs[route.page]??[];
 return [];
}
/** The tab a page route opens: its tab when the page has it, else the page's first tab; '' for a page without tabs. */
export function pageTabOf(route:Pick<ConsoleRoute,'view'|'page'|'tab'>):string{
 const tabs=pageTabsOf(route);
 return route.tab&&tabs.includes(route.tab)?route.tab:tabs[0]??'';
}
/** The tab field of a page route: a known tab other than the page's default, so the default is never written. */
const routeTab=(route:Pick<ConsoleRoute,'view'|'page'|'tab'>):{tab?:string}=>{
 const tab=pageTabOf(route);
 return tab&&tab!==pageTabsOf(route)[0]?{tab}:{};
};
/**
 * The device areas. "extensions" (Extensions) shows only for a device with a detected role or product (lib/extensions.ts,
 * visibleDeviceAreas in ui/shell/nav-model.ts). Monitoring holds Alarms, Alert rules and Notification rules; Configuration
 * holds Permissions only.
 */
export type DeviceMainSection='overview'|'hardware'|'software'|'diagnostics'|'management'|'remote'|'automation'|'history'|'extensions'|'monitoring'|'configuration';
export type DeviceSection=DeviceMainSection|'files'|'terminal'|'rdp'|'drift'|'desired'|'runbooks';
/**
 * One console route. page is the page of the automation or settings view. tab is the internal tab of the view: the
 * fleet tab of a scope (FleetTab in ui/devices/fleet/fleet.tsx), or the tab of an automation or settings page (automationPageTabs,
 * settingsPageTabs; never the page's default). groupId 'unassigned' is the Ungrouped scope; with a customerId it is
 * the Ungrouped scope of that customer. installer, customerId and groupId of the add-device view are its link segments.
 * assistant is set only by parseConsoleRoute for an assistant link (#device/<id>/assistant): the device opens with the
 * assistant drawer open. Drawers have no route, so consoleRouteHash never writes it.
 */
export type ConsoleRoute={view:ConsoleView;deviceId?:string;deviceSection?:DeviceSection;deviceDetail?:string;gpu?:number;zone?:string;assistant?:boolean;groupId?:string;customerId?:string;tab?:string;page?:SettingsPage|AutomationPage;installer?:boolean};
/** Subareas that may appear in a device link. The first entry is the default and never written to the hash. */
export const diagnosticsDetails=['processes','sessions','events','connections'] as const;
/** The Management subarea bar. Scheduled tasks is #device/<id>/management/tasks. */
export const managementDetails=['services','updates','storage','network','accounts','features','tasks','defender','system'] as const;
/** The Software area, the read-only lists: Programs (the default, #device/<id>/software), Drivers, Certificates and Autostart. */
export const softwareDetails=['programs','drivers','certificates','autostart'] as const;
/** The Monitoring area: Alarms (the default, #device/<id>/monitoring), Alert rules and Notification rules. */
export const monitoringDetails=['alarms','alert-rules','notification-rules'] as const;
/** The Configuration area: Permissions only, always written as #device/<id>/configuration/permissions. */
export const configurationDetails=['permissions'] as const;
export const hardwareDetails=['overview','cpu','memory','storage','network','system','gpu'] as const;
/** The Extensions area (#device/<id>/extensions): the overview, the DHCP server of the DHCP extension or the DNS server of the DNS extension. */
export const extensionsDetails=['overview','dhcp','dns'] as const;
/** The views of the device History: jobs and device access (the alarms are Monitoring › Alarms). */
export const historyDetails=['jobs','access'] as const;
export type ExtensionsDetail=typeof extensionsDetails[number];
export type DiagnosticsDetail=typeof diagnosticsDetails[number];
export type ManagementDetail=typeof managementDetails[number];
export type SoftwareDetail=typeof softwareDetails[number];
export type MonitoringDetail=typeof monitoringDetails[number];
export type ConfigurationDetail=typeof configurationDetails[number];
export type HardwareDetail=typeof hardwareDetails[number];
export type HistoryDetail=typeof historyDetails[number];
export const deviceDetails={diagnostics:diagnosticsDetails,management:managementDetails,software:softwareDetails,hardware:hardwareDetails,extensions:extensionsDetails,history:historyDetails,monitoring:monitoringDetails,configuration:configurationDetails} as const;
export type DeviceDetailSection=keyof typeof deviceDetails;
/** GPUs are addressed by their 1-based position in deviceOverviewGpus, never by adapter ID. */
export const maxGpuPosition=16;
export type DeviceDetailRoute={deviceDetail?:string;gpu?:number;zone?:string};
const hasDetails=(section:unknown):section is DeviceDetailSection=>typeof section==='string'&&Object.hasOwn(deviceDetails,section);
/** Valid subarea of a main section, or the section default. */
export function deviceDetailOf<S extends DeviceDetailSection>(section:S,detail:unknown):typeof deviceDetails[S][number]{
 const items=deviceDetails[section] as ReadonlyArray<string>;
 return (typeof detail==='string'&&items.includes(detail)?detail:items[0]) as typeof deviceDetails[S][number];
}
/** Canonical subarea fields: only valid non-default values, a GPU position from 2 to 16, and a DNS zone only on the DNS view. */
export function deviceDetailRoute(section:unknown,detail:unknown,gpu?:unknown,zone?:unknown):DeviceDetailRoute{
 if(!hasDetails(section))return {};
 const value=deviceDetailOf(section,detail);
 if(value===deviceDetails[section][0])return {};
 if(value==='gpu'&&typeof gpu==='number'&&Number.isInteger(gpu)&&gpu>=2&&gpu<=maxGpuPosition)return {deviceDetail:value,gpu};
 if(section==='extensions'&&value==='dns'&&typeof zone==='string'&&zone)return {deviceDetail:value,zone};
 return {deviceDetail:value};
}
/** Message keys of the Diagnostics subarea names (subarea bar, Overview fix links). */
export const diagnosticsDetailLabels:Readonly<Record<DiagnosticsDetail,MessageKey>>={processes:'device.area.processes',sessions:'device.area.sessions',events:'device.area.events',connections:'device.area.connections'};
/** Message keys of the Management subarea names (subarea bar, Overview fix links). */
export const managementDetailLabels:Readonly<Record<ManagementDetail,MessageKey>>={services:'device.area.services',updates:'device.area.updates',storage:'device.area.storage',network:'device.area.network',accounts:'device.area.accounts',features:'device.area.features',tasks:'management.tasks.title',defender:'device.area.defender',system:'device.area.system'};
/** Message keys of the Software subarea names (subarea bar, Overview fix links). */
export const softwareDetailLabels:Readonly<Record<SoftwareDetail,MessageKey>>={programs:'device.area.programs',drivers:'drivers.title',certificates:'certificates.title',autostart:'autostart.title'};
/** Message keys of the Monitoring subarea names. */
export const monitoringDetailLabels:Readonly<Record<MonitoringDetail,MessageKey>>={alarms:'alarms.title','alert-rules':'alertRules.title','notification-rules':'fleet.config.notificationRules'};
/** Message keys of the Configuration subarea names. */
export const configurationDetailLabels:Readonly<Record<ConfigurationDetail,MessageKey>>={permissions:'tree.permissions'};
/** Message keys of the Hardware subarea names (subarea bar, Overview fix links). */
export const hardwareDetailLabels:Readonly<Record<HardwareDetail,MessageKey>>={overview:'hardware.tab.overview',cpu:'fleet.col.cpu',memory:'hardware.tab.memory',storage:'hardware.tab.storage',network:'management.category.network',system:'hardware.tab.system',gpu:'device.gpu.card'};
/** Message keys of the Extensions subarea names in the Overview fix links: the Extensions overview, the DHCP server or the DNS server. */
export const extensionsDetailLabels:Readonly<Record<ExtensionsDetail,MessageKey>>={overview:'device.section.extensions',dhcp:'dhcp.title',dns:'dns.title'};
/** Message keys of the device History views. */
export const historyDetailLabels:Readonly<Record<HistoryDetail,MessageKey>>={jobs:'history.tab.jobs',access:'history.tab.access'};
/** Message keys of the device area names (tabs, breadcrumbs, palette). */
export const deviceSectionLabels:Readonly<Record<DeviceSection,MessageKey>>={overview:'device.section.overview',hardware:'device.section.hardware',software:'device.section.software',monitoring:'device.section.monitoring',configuration:'device.section.configuration',diagnostics:'device.section.diagnostics',management:'device.section.management',remote:'device.section.remote',automation:'device.section.automation',history:'device.section.history',extensions:'device.section.extensions',files:'device.section.files',terminal:'device.section.terminal',rdp:'device.section.rdp',drift:'device.section.drift',desired:'device.section.desired',runbooks:'device.section.runbooks'};
/**
 * The device areas in tab order; the conditional Extensions area (before Monitoring) is not among
 * them, and Configuration shows only with portal.roleAssignments.manage (visibleDeviceAreas in ui/shell/nav-model.ts).
 */
export const deviceSections:ReadonlyArray<{id:DeviceMainSection;label:MessageKey}>=(['overview','hardware','software','diagnostics','management','remote','automation','history','monitoring','configuration'] as const).map(id=>({id,label:deviceSectionLabels[id]}));
export function deviceMainSection(section:DeviceSection):DeviceMainSection{
 if(['files','terminal','rdp'].includes(section))return 'remote';
 if(['drift','desired','runbooks'].includes(section))return 'automation';
 return section as DeviceMainSection;
}
export function isDeviceSection(value:unknown):value is DeviceSection{return typeof value==='string'&&Object.hasOwn(deviceSectionLabels,value);}

/** The scope types of the fleet view (FleetScope in ui/devices/fleet/fleet-scope.ts); 'unassigned' is either Ungrouped scope. */
export type ScopeType='all'|'group'|'customer'|'unassigned';
/**
 * The link segments of each fleet tab that has a route: [tab, sub]. The tab ids are the internal fleet tabs; the default
 * tab "devices" has no segment. permissions and settings are the scope Permissions and the group General tab. The
 * Configuration subtabs are always written with their sub: the bare #…/configuration was the alert rules link.
 */
export const fleetTabSegments:Readonly<Record<string,readonly [string,string?]>>={
 problems:['monitoring'],alarms:['monitoring','list'],alerts:['monitoring','alert-rules'],notifications:['monitoring','notification-rules'],
 jobs:['history'],access:['history','access'],
 software:['inventory'],extensions:['inventory','extensions'],'os-support':['inventory','os-support'],encryption:['inventory','encryption'],protection:['inventory','defender'],drivers:['inventory','drivers'],reliability:['inventory','reliability'],certificates:['inventory','certificates'],autostart:['inventory','autostart'],
 tags:['configuration','tags'],permissions:['configuration','permissions'],settings:['configuration','general'],
};
/**
 * The fleet tabs with a route that each scope type has. A customer has Alert rules (its own level, docs/alert-rules.md) and
 * Notification rules, but no tags, permissions or general settings; both Ungrouped scopes have no rules and no configuration.
 */
export const scopeRouteTabs:Readonly<Record<ScopeType,readonly string[]>>={
 all:Object.keys(fleetTabSegments).filter(tab=>tab!=='tags'&&tab!=='settings'),
 group:Object.keys(fleetTabSegments),
 customer:Object.keys(fleetTabSegments).filter(tab=>!['tags','permissions','settings'].includes(tab)),
 unassigned:Object.keys(fleetTabSegments).filter(tab=>!['alerts','notifications','tags','permissions','settings'].includes(tab)),
};
/** The fleet tab names of the older links (#devices/<tab>), each mapped by fleetTabSegments. */
const oldFleetTabs=['problems','jobs','access','software','os-support','encryption','protection','drivers','reliability','certificates','autostart','alerts','notifications','tags'];
/** The reserved second segments after #devices: any other value is an older device link (#devices/<id>/…). */
export const devicesReservedSegments:ReadonlySet<string>=new Set(['monitoring','alarms','inventory','history','configuration','group','customer','ungrouped','add',...oldFleetTabs]);
const subTab=(tab:string,sub:string|undefined)=>Object.entries(fleetTabSegments).find(([,segments])=>segments[0]===tab&&segments[1]===sub)?.[0];

/**
 * The fleet tab of the segments after a scope. A tab or sub the scope type never has is the Devices tab; an unknown sub is
 * the tab's default. Older links: alarms[/list] is Monitoring (By device, By alarm); a bare configuration (the former alert
 * rules link) is Alert rules, on a customer Notification rules; configuration/notification-rules is Notification rules.
 */
function scopeTab(type:ScopeType,tab:string|undefined,sub:string|undefined):string{
 if(!tab)return 'devices';
 let found:string|undefined;
 if(tab==='alarms')found=sub==='list'?'alarms':'problems';
 else if(tab==='configuration'){
  const old=type==='customer'?'notifications':'alerts';
  found=sub==='notification-rules'?'notifications':sub?subTab(tab,sub)??old:old;
 }else if(tab==='monitoring'||tab==='inventory'||tab==='history'){
  const fallback=subTab(tab,undefined);
  found=sub?subTab(tab,sub)??fallback:fallback;
 }else if(oldFleetTabs.includes(tab))found=tab;
 return found&&scopeRouteTabs[type].includes(found)?found:'devices';
}
const gpuPosition=(value:string|undefined)=>/^(?:[2-9]|1[0-6])$/.test(value??'')?Number(value):undefined;
/** The old Management subareas that form the Software area now; the old software subarea is Programs. */
const oldSoftwareDetails:Readonly<Record<string,SoftwareDetail>>={software:'programs',drivers:'drivers',certificates:'certificates',autostart:'autostart'};
const softwareRoute=(sub:string|undefined):ConsoleRoute=>({view:'device',deviceSection:'software',...deviceDetailRoute('software',sub)});

/** A device link with the singular root: #device/<id>[/<area>[/<sub>[/<n>]]]. An invalid area is the Overview, an invalid sub the area default. */
function parseDevice(deviceId:string,[area,sub,extra]:string[]):ConsoleRoute{
 const base={view:'device',deviceId} as const;
 switch(area){
  case 'hardware':return {...base,deviceSection:'hardware',...deviceDetailRoute('hardware',sub,gpuPosition(extra))};
  case 'diagnostics':return {...base,deviceSection:'diagnostics',...deviceDetailRoute('diagnostics',sub)};
  case 'management':return Object.hasOwn(oldSoftwareDetails,sub)?{...softwareRoute(oldSoftwareDetails[sub]),...base}:{...base,deviceSection:'management',...deviceDetailRoute('management',sub)};
  case 'software':return {...softwareRoute(sub),...base};
  case 'remote':return {...base,deviceSection:sub==='terminal'||sub==='rdp'?sub:'remote'};
  case 'automation':return {...base,deviceSection:sub==='desired'||sub==='drift'?sub:'automation'};
  // The former History › Alarms is Monitoring › Alarms.
  case 'history':return sub==='alarms'?{...base,deviceSection:'monitoring'}:{...base,deviceSection:'history',...deviceDetailRoute('history',sub)};
  case 'extensions':return {...base,deviceSection:'extensions',...deviceDetailRoute('extensions',sub,undefined,extra)};
  case 'monitoring':return {...base,deviceSection:'monitoring',...deviceDetailRoute('monitoring',sub)};
  // Only configuration/permissions is Configuration: the bare link and configuration/alert-rules were the alert rules.
  case 'configuration':return sub==='permissions'?{...base,deviceSection:'configuration'}:{...base,deviceSection:'monitoring',deviceDetail:'alert-rules'};
  case 'assistant':return {...base,deviceSection:'overview',assistant:true};
  default:return {...base,deviceSection:'overview'};
 }
}
/** An older device link: #devices/<id>[/<section>[/<sub>[/<n>]]], with the former panels alerts, permissions and assistant as the section. */
function parseOldDevice(deviceId:string,[section,detail,extra]:string[]):ConsoleRoute{
 const base={view:'device',deviceId} as const;
 if(section==='alerts')return {...base,deviceSection:'monitoring',deviceDetail:'alert-rules'};
 if(section==='permissions')return {...base,deviceSection:'configuration'};
 if(section==='configuration'||section==='monitoring')return parseDevice(deviceId,[section,detail]);
 if(section==='assistant')return {...base,deviceSection:'overview',assistant:true};
 if(section==='management'&&Object.hasOwn(oldSoftwareDetails,detail))return {...softwareRoute(oldSoftwareDetails[detail]),...base};
 const deviceSection:DeviceSection=isDeviceSection(section)?section:'overview';
 return {...base,deviceSection,...(deviceSection==='history'?{}:deviceDetailRoute(deviceSection,detail,gpuPosition(extra)))};
}
/** #devices/add[/installer][/customer/<id>][/group/<id>]. */
function parseAdd(parts:string[]):ConsoleRoute{
 const route:ConsoleRoute={view:'add-device',installer:false};
 for(let index=0;index<parts.length;index++){
  const part=parts[index];
  if(part==='installer')route.installer=true;
  else if((part==='customer'||part==='group')&&parts[index+1]){route[part==='customer'?'customerId':'groupId']=parts[index+1];index++;}
 }
 return route;
}
const scopeRoute=(type:ScopeType,fields:{groupId?:string;customerId?:string},tab:string|undefined,sub:string|undefined):ConsoleRoute=>({view:'devices',...fields,tab:scopeTab(type,tab,sub)});
const administrationPages:Readonly<Record<string,SettingsPage>>={accounts:'accounts',usergroups:'user-groups',roles:'roles',entra:'entra',customers:'customers',license:'usage-data',vulnerabilities:'vulnerabilities',assistant:'assistant',settings:'sessions',maintenance:'retention',notifications:'notification-channels',audit:'audit'};

export function parseConsoleRoute(hash:string):ConsoleRoute{
 let parts:string[];try{parts=hash.replace(/^#/,'').split('/').map(decodeURIComponent);}catch{return {view:'devices'};}
 const [root,id,section]=parts;
 if(root==='devices'){
  if(!id)return {view:'devices',tab:'devices'};
  if(id==='add')return parseAdd(parts.slice(2));
  if(id==='group'){
   if(!section)return {view:'devices',tab:'devices'};
   return section==='unassigned'?scopeRoute('unassigned',{groupId:'unassigned'},parts[3],parts[4]):scopeRoute('group',{groupId:section},parts[3],parts[4]);
  }
  if(id==='customer'){
   if(!section)return {view:'devices',tab:'devices'};
   return parts[3]==='ungrouped'?scopeRoute('unassigned',{customerId:section,groupId:'unassigned'},parts[4],parts[5]):scopeRoute('customer',{customerId:section},parts[3],parts[4]);
  }
  if(id==='ungrouped')return scopeRoute('unassigned',{groupId:'unassigned'},section,parts[3]);
  if(devicesReservedSegments.has(id))return scopeRoute('all',{},id,section);
  return parseOldDevice(id,parts.slice(2));
 }
 if(root==='device')return id?parseDevice(id,parts.slice(2)):{view:'devices',tab:'devices'};
 if(root==='automation'){const page=isAutomationPage(id)?id:'runbooks';return {view:'automation',page,...routeTab({view:'automation',page,tab:section})};}
 // #settings/license was the License page; its usage data card now has the page Usage data.
 if(root==='settings'){const page=id==='license'?'usage-data':isSettingsPage(id)?id:'accounts';return {view:'settings',page,...routeTab({view:'settings',page,tab:section})};}
 if(root==='account')return {view:'account'};
 if(root==='dashboard')return {view:'dashboard'};
 // Older roots: #agents, #administration, #access and #audit.
 if(root==='agents'){
  if(id==='releases')return {view:'settings',page:'agent-releases'};
  if(id==='troubleshooting'||id==='uninstall')return {view:'settings',page:'agent-troubleshooting'};
  return {view:'add-device',installer:false,...(id==='installation'&&section==='group'&&parts[3]?{groupId:parts[3]}:{})};
 }
 if(root==='administration')return {view:'settings',page:administrationPages[id]??'accounts'};
 if(root==='audit')return id==='jobs'?{view:'devices',tab:'jobs'}:{view:'settings',page:'audit'};
 if(root==='access'&&(id==='accounts'||id==='permissions'))return {view:'settings',page:id==='accounts'?'accounts':'roles'};
 return {view:'devices'};
}

function deviceHash(route:ConsoleRoute&{deviceId:string}):string{
 const base=`#device/${encodeURIComponent(route.deviceId)}`;
 const section:DeviceSection=isDeviceSection(route.deviceSection)?route.deviceSection:'overview';
 const {deviceDetail,gpu,zone}=deviceDetailRoute(deviceMainSection(section),route.deviceDetail,route.gpu,route.zone),sub=deviceDetail?'/'+deviceDetail:'';
 switch(deviceMainSection(section)){
  case 'hardware':return `${base}/hardware${sub}${gpu?'/'+gpu:''}`;
  case 'diagnostics':return `${base}/diagnostics${sub}`;
  case 'software':return `${base}/software${sub}`;
  case 'management':return `${base}/management${sub}`;
  case 'monitoring':return `${base}/monitoring${sub}`;
  case 'configuration':return `${base}/configuration/permissions`;
  case 'remote':return `${base}/remote${section==='terminal'||section==='rdp'?'/'+section:''}`;
  case 'automation':return `${base}/automation${section==='desired'||section==='drift'?'/'+section:''}`;
  case 'history':return `${base}/history${sub}`;
  case 'extensions':return `${base}/extensions${sub}${zone?'/'+encodeURIComponent(zone):''}`;
  default:return base;
 }
}
function scopeHash(route:ConsoleRoute):string{
 const customer=route.customerId||'',group=route.groupId&&route.groupId!=='all'?route.groupId:'';
 const [type,prefix]:[ScopeType,string]=customer?(group==='unassigned'?['unassigned',`#devices/customer/${encodeURIComponent(customer)}/ungrouped`]:['customer',`#devices/customer/${encodeURIComponent(customer)}`])
  :group==='unassigned'?['unassigned','#devices/ungrouped']:group?['group',`#devices/group/${encodeURIComponent(group)}`]:['all','#devices'];
 const tab=route.tab??'';
 if(!scopeRouteTabs[type].includes(tab))return prefix;
 const [segment,sub]=fleetTabSegments[tab];
 return `${prefix}/${segment}${sub?'/'+sub:''}`;
}
export function consoleRouteHash(route:ConsoleRoute):string{
 if(route.view==='device')return route.deviceId?deviceHash({...route,deviceId:route.deviceId}):'#devices';
 if(route.view==='devices')return scopeHash(route);
 if(route.view==='add-device')return `#devices/add${route.installer?'/installer':''}${route.customerId?`/customer/${encodeURIComponent(route.customerId)}`:''}${route.groupId&&route.groupId!=='all'?`/group/${encodeURIComponent(route.groupId)}`:''}`;
 if(route.view==='automation'||route.view==='settings'){
  const page=route.view==='automation'?(isAutomationPage(route.page)?route.page:'runbooks'):(isSettingsPage(route.page)?route.page:'accounts');
  const {tab}=routeTab({view:route.view,page,tab:route.tab});
  return `#${route.view}/${page}${tab?'/'+tab:''}`;
 }
 if(route.view==='dashboard')return '#dashboard';
 return '#account';
}
/**
 * The link that opens a device with its assistant drawer (#device/<id>/assistant; parseConsoleRoute reads it as the
 * Overview with assistant:true). consoleRouteHash never writes the assistant segment, because the console replaces the
 * hash with its canonical form, so this is the one place that appends it.
 */
export const deviceAssistantHash=(deviceId:string)=>`${consoleRouteHash({view:'device',deviceId})}/assistant`;

/**
 * The start pages a browser may store (localStorage serverdesk.redesign.startPage): the Dashboard (the default without a
 * stored value, ui/shell/start-page.tsx), All devices or Alarms. An older stored "problems" reads as alarms.
 */
export const startPages=['dashboard','devices','alarms'] as const;
export type StartPage=typeof startPages[number];
export const startPageKey='serverdesk.redesign.startPage';
/**
 * The hash the console opens with when the link has no hash: the Dashboard for the start page dashboard, the Monitoring
 * tab of All devices (view by device) for alarms (or the older problems). A link with a hash always wins; any other
 * value acts as devices (the link stays as it is).
 */
export function startHash(hash:string,stored:unknown):string{
 if(hash!==''&&hash!=='#')return hash;
 if(stored==='dashboard')return consoleRouteHash({view:'dashboard'});
 return stored==='alarms'||stored==='problems'?consoleRouteHash({view:'devices',tab:'problems'}):hash;
}
