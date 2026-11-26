import type {ServerSnapshot} from './types';
import {baseVersion,compareReleaseRank} from '../runtime/release-version.mjs';

// Agent plugins (docs/agent-plugins.md): the job kinds, the plugin operations
// the portal knows and the plugin entries of the heartbeat snapshot. Pure: no
// database, no server bindings, so the job requirements, the client and the
// tests use it.

/** The agent capability of a plugin host (agent 4.16.0 and later). */
export const PLUGIN_HOST='plugin-host';
/** The first agent version with the plugin host. */
export const PLUGIN_HOST_MIN_AGENT='4.16.0';
export const PLUGIN_INSTALL='plugin-install',PLUGIN_REMOVE='plugin-remove',PLUGIN_JOB='plugin-job';
export const pluginJobKinds:ReadonlySet<string>=new Set([PLUGIN_INSTALL,PLUGIN_REMOVE,PLUGIN_JOB]);

/**
 * The DHCP changes of DHCP plugin 1.1.0 (docs/dhcp-server.md, lib/dhcp-changes.ts):
 * one plugin operation per change, so a finished job keeps its rights and its
 * label through the target. dhcp-scope-apply is the partner side of a failover
 * create, a scope added to a relationship and a replicate.
 */
export const DHCP_CHANGE_OPERATIONS=[
 'dhcp-scope-create','dhcp-scope-edit','dhcp-scope-activate','dhcp-scope-deactivate','dhcp-scope-delete',
 'dhcp-superscope-create','dhcp-superscope-edit','dhcp-superscope-activate','dhcp-superscope-deactivate','dhcp-superscope-delete',
 'dhcp-exclusion-add','dhcp-exclusion-remove','dhcp-reservation-add','dhcp-reservation-edit','dhcp-reservation-remove','dhcp-lease-delete',
 'dhcp-option-set','dhcp-option-remove','dhcp-policy-create','dhcp-policy-edit','dhcp-policy-delete',
 'dhcp-failover-create','dhcp-failover-edit','dhcp-failover-remove','dhcp-scope-apply',
] as const;
export type DhcpChangeOperation=typeof DHCP_CHANGE_OPERATIONS[number];
/**
 * The DNS plugin 1.0.0 (docs/dns-server.md, lib/dns-changes.ts): two reads,
 * the server every 15 minutes and the records of one zone on request, and one
 * operation per change.
 */
export const DNS_READ_OPERATIONS=['dns-read','dns-zone-read'] as const;
export const DNS_CHANGE_OPERATIONS=[
 'dns-zone-create','dns-zone-edit','dns-zone-delete','dns-zone-transfer',
 'dns-record-add','dns-record-edit','dns-record-delete',
 'dns-conditional-create','dns-conditional-edit','dns-conditional-delete',
 'dns-forwarders-set','dns-scavenging-set','dns-scavenge-now','dns-cache-clear',
] as const;
export type DnsReadOperation=typeof DNS_READ_OPERATIONS[number];
export type DnsChangeOperation=typeof DNS_CHANGE_OPERATIONS[number];
type OperationDefinition={plugin:string;permission:'dhcp.read'|'dhcp.manage'|'dns.read'|'dns.manage';readOnly:boolean};
const dhcpChange:OperationDefinition={plugin:'dhcp',permission:'dhcp.manage',readOnly:false};
const dnsRead:OperationDefinition={plugin:'dns',permission:'dns.read',readOnly:true};
const dnsChange:OperationDefinition={plugin:'dns',permission:'dns.manage',readOnly:false};

/**
 * The plugin operations of this portal: the plugin that runs it and the device
 * right it needs. Only a read runs in ReadOnly mode; a change needs Management
 * mode and MFA like every other changing job. Any other operation is unknown
 * to this portal.
 */
export const pluginOperations:Readonly<Record<'dhcp-read'|DhcpChangeOperation|DnsReadOperation|DnsChangeOperation,OperationDefinition>>={
 'dhcp-read':{plugin:'dhcp',permission:'dhcp.read',readOnly:true},
 ...Object.fromEntries(DHCP_CHANGE_OPERATIONS.map(operation=>[operation,dhcpChange])) as Record<DhcpChangeOperation,OperationDefinition>,
 ...Object.fromEntries(DNS_READ_OPERATIONS.map(operation=>[operation,dnsRead])) as Record<DnsReadOperation,OperationDefinition>,
 ...Object.fromEntries(DNS_CHANGE_OPERATIONS.map(operation=>[operation,dnsChange])) as Record<DnsChangeOperation,OperationDefinition>,
};
export type PluginOperation=keyof typeof pluginOperations;
export const isPluginOperation=(value:unknown):value is PluginOperation=>typeof value==='string'&&Object.hasOwn(pluginOperations,value);

/**
 * The metadata of a plugin release for the console (lib/server/extensions/plugin-releases.ts): no manifest bytes, no signature.
 * target: the detection id the plugin extends (lib/extensions.ts), from the manifest's target or, in an older
 * manifest without one, its role.
 */
export type PluginReleaseSummary={id:string;name:string;target:string;version:string;minAgentVersion:string;capabilities:string[];changelog:{features:string[];fixes:string[]};createdAt:number};

/** One plugin as the agent reports it in the heartbeat snapshot (lib/server/agent/telemetry.ts). */
export type PluginReport=ServerSnapshot extends {plugins?:(infer T)[]}?T:never;
/**
 * The detection id a reported plugin extends: target, else role (only in a snapshot stored before target existed),
 * else null. Every reader of the reported target goes through it.
 */
export function pluginReportTarget(report:{target?:string|null;role?:string|null}):string|null{
 return report.target??report.role??null;
}

/** The reported plugin of this name, or null. */
export function snapshotPlugin(snapshot:Pick<ServerSnapshot,'plugins'>|null|undefined,name:string):PluginReport|null{
 return snapshot?.plugins?.find(plugin=>plugin.name===name)??null;
}
/** Whether the snapshot reports the plugin ready with this capability. */
export function pluginReady(snapshot:Pick<ServerSnapshot,'plugins'>|null|undefined,name:string,capability:string):boolean{
 const plugin=snapshotPlugin(snapshot,name);
 return plugin?.state==='ready'&&plugin.capabilities.includes(capability);
}

/**
 * The rank order of two versions (runtime/release-version.mjs): negative, 0 or
 * positive; null when one side is no version. The base X.Y.Z first, then a
 * release above a dev build X.Y.Z-dev.<sha7> of its base; two dev builds of the
 * same base have rank 0 although they differ.
 */
export function comparePluginVersions(left:string,right:string):number|null{
 return compareReleaseRank(left,right);
}
/** Whether an agent meets a minimum agent version X.Y.Z: a dev agent X.Y.Z-dev.<sha7> counts as its base. */
export function agentMeetsMinimum(agentVersion:string|null|undefined,minimum:string):boolean{
 const base=baseVersion(agentVersion);
 return base!==null&&(compareReleaseRank(minimum,base)??1)<=0;
}

/** One periodic plugin operation of the signed plugin policy: the broker runs it every intervalSeconds while the policy is valid. */
export type PluginCollection={plugin:string;operation:string;intervalSeconds:number};
/** The periodic reads of the plugin policy, each while its plugin reports the read. dns-zone-read is never periodic. */
const periodicReads:readonly PluginCollection[]=[{plugin:'dhcp',operation:'dhcp-read',intervalSeconds:900},{plugin:'dns',operation:'dns-read',intervalSeconds:900}];
/**
 * The plugin policy of a device for its next channel answer (signed there as
 * plugin-policy): the DHCP read and the DNS server read every 15 minutes, each
 * while the last snapshot reports its plugin ready with that read; otherwise nothing.
 */
export function pluginCollectionPolicy(snapshot:Pick<ServerSnapshot,'plugins'>|null|undefined):{collect:PluginCollection[]}{
 return {collect:periodicReads.filter(entry=>pluginReady(snapshot,entry.plugin,entry.operation)).map(entry=>({...entry}))};
}
