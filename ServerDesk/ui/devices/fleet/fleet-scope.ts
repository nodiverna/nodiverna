import type {Server} from '@/lib/types';
import type {MessageKey} from '@/lib/i18n/translate';

// The device scopes of the fleet view: "All devices", "Ungrouped" (of all devices or
// of one customer), a group and a customer. The scopes share one tab list (fleetScopeTabs: five tabs, four of
// them with subtabs), so an analysis tab is built once and gets the scoped devices; a tab that only fits some
// scopes names them in scopes. docs/customers.md describes the customer view.
export type FleetScope={type:'all'}|{type:'unassigned';customerId?:string}|{type:'group';id:string}|{type:'customer';id:string};
type ScopeDevice=Pick<Server,'groupId'|'groups'|'customerId'>;

/** The devices of a scope, in input order. A group also holds the devices of its subgroups (groups lists inherited memberships). */
export function scopeDevices<T extends ScopeDevice>(servers:readonly T[],scope:FleetScope):T[]{
 if(scope.type==='all')return [...servers];
 if(scope.type==='unassigned')return servers.filter(server=>!(server.groups?.length||server.groupId)&&(!scope.customerId||server.customerId===scope.customerId));
 if(scope.type==='customer')return servers.filter(server=>server.customerId===scope.id);
 return servers.filter(server=>server.groups?.some(group=>group.id===scope.id)||server.groupId===scope.id);
}

/**
 * True when the customer view of this customer may open: the viewer sees at
 * least two customers (the tree shows customer folders) and this one is among
 * them. The list is already limited to the viewer's customer boundary.
 */
export function customerViewAvailable(customers:readonly {id:string}[]|undefined,id:string|undefined){
 return !!id&&!!customers&&customers.length>=2&&customers.some(customer=>customer.id===id);
}

/** The five scope tabs: Devices, then the four tabs with pill subtabs (docs/customers.md, "Scope tabs"). */
export type ScopeTabGroup='devices'|'monitoring'|'inventory'|'history'|'configuration';
/** The fleet tabs (FleetTab in ui/devices/fleet/fleet.tsx): Devices and the subtabs of the other four tabs. */
export type FleetScopeTabId='devices'|'problems'|'alarms'|'alerts'|'notifications'|'software'|'extensions'|'drivers'|'certificates'|'autostart'|'os-support'|'encryption'|'protection'|'reliability'|'jobs'|'access'|'tags'|'permissions'|'settings';
export type FleetScopeTab={id:FleetScopeTabId;label:MessageKey;
 /** The scope tab the fleet tab belongs to; the fleet tabs of the four other tabs are its subtabs, the first is the default. */
 group:ScopeTabGroup;
 /** The scope types that show this tab; without it every scope does. */
 scopes?:ReadonlyArray<FleetScope['type']>};
/** The five scope tabs in order: the tab label and the accessible name of its pill subtab bar. */
export const scopeTabGroups:ReadonlyArray<{id:ScopeTabGroup;label:MessageKey;subtabs?:MessageKey}>=[
 {id:'devices',label:'tree.devices'},
 {id:'monitoring',label:'fleet.tabs.monitoring',subtabs:'fleet.subtabs.monitoring'},
 {id:'inventory',label:'fleet.tabs.inventory',subtabs:'fleet.subtabs.inventory'},
 {id:'history',label:'fleet.tabs.history',subtabs:'fleet.subtabs.history'},
 {id:'configuration',label:'fleet.tabs.configuration',subtabs:'fleet.subtabs.configuration'},
];
/** The fleet tabs in tab and subtab order. A later analysis tab is added only here. */
export const fleetScopeTabs:ReadonlyArray<FleetScopeTab>=[
 {id:'devices',label:'tree.devices',group:'devices'},
 // Monitoring (docs/alert-rules.md, docs/notifications.md) on every scope type: what fired (the devices with warning or
 // critical alarms, worst first, and the open alarms), what is watched (the alert rules) and who is told (the notification rules).
 {id:'problems',label:'fleet.alarms.byDevice',group:'monitoring'},
 {id:'alarms',label:'fleet.alarms.byAlarm',group:'monitoring'},
 // Alert rules have an "All devices", a customer and a group level; each scope edits its own (docs/alert-rules.md).
 {id:'alerts',label:'alertRules.title',group:'monitoring',scopes:['all','group','customer']},
 // Notification rules on All devices, a group and a customer (docs/notifications.md); the console shows the customer subtab only once a second customer exists.
 {id:'notifications',label:'fleet.config.notificationRules',group:'monitoring',scopes:['all','group','customer']},
 // The inventory reports (docs/device-health-signals.md) on every scope type; Extensions is docs/extensions.md, Defender needs agent 4.14.0.
 {id:'software',label:'software.title',group:'inventory'},
 {id:'extensions',label:'extensions.tab',group:'inventory'},
 {id:'drivers',label:'drivers.title',group:'inventory'},
 {id:'certificates',label:'certificates.title',group:'inventory'},
 {id:'autostart',label:'autostart.title',group:'inventory'},
 {id:'os-support',label:'osSupport.title',group:'inventory'},
 {id:'encryption',label:'encryption.title',group:'inventory'},
 {id:'protection',label:'protection.title',group:'inventory'},
 {id:'reliability',label:'reliability.title',group:'inventory'},
 // The jobs and the device accesses of the scoped devices.
 {id:'jobs',label:'history.tab.jobs',group:'history'},
 {id:'access',label:'history.tab.access',group:'history'},
 // Tags belong to devices and device groups only (docs/device-tags.md).
 {id:'tags',label:'tags.title',group:'configuration',scopes:['group']},
 // The role assignments of All devices and a group (portal.roleAssignments.manage), and the General page of a group (canManageGroup).
 {id:'permissions',label:'tree.permissions',group:'configuration',scopes:['all','group']},
 {id:'settings',label:'fleet.tabs.settings',group:'configuration',scopes:['group']},
];
/** The fleet tabs a scope type shows, in order. Rights decide further (the console passes the content). */
export function scopeTabs(scope:FleetScope['type']):FleetScopeTab[]{
 return fleetScopeTabs.filter(tab=>!tab.scopes||tab.scopes.includes(scope));
}
/** The scope tab of a fleet tab; an unknown id is Devices. */
export function scopeTabGroup(tab:string):ScopeTabGroup{
 return fleetScopeTabs.find(item=>item.id===tab)?.group??'devices';
}
