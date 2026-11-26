import {z} from 'zod';

// The DHCP server as the DHCP plugin reads it (docs/dhcp-server.md): the
// snapshot schema of the upload (lib/server/extensions/plugin-data.ts), the scope usage rows of
// the fleet view and the helpers of the device view. Pure: no database, no
// server bindings, so the client and the tests use it as well.

export const DHCP_PLUGIN='dhcp',DHCP_READ='dhcp-read';
/** The plugin reads the DHCP server every 15 minutes under the signed plugin policy. */
export const DHCP_INTERVAL_SECONDS=900;

const text=(max:number)=>z.string().max(max);
const ipv4=z.string().regex(/^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/);
const ipv6=z.string().min(2).max(45).regex(/^[0-9a-fA-F:.]+$/);
const address=z.union([ipv4,ipv6]);
const seconds=z.number().int().min(0).max(4294967295);
const count=z.number().int().min(0).max(4294967295);
const percent=z.number().finite().min(0).max(100);
const isoDate=z.string().max(40).datetime({offset:true});

const option=z.object({code:z.number().int().min(0).max(65535),name:text(128),vendorClass:text(128).nullable(),userClass:text(128).nullable(),values:z.array(text(512)).max(32)}).strict();
const range=(value:z.ZodTypeAny)=>z.object({start:value,end:value}).strict();
const criterion=z.object({
 type:z.enum(['mac','vendorClass','userClass','clientId','relayAgent','circuitId','remoteId','subscriberId','fqdn']),
 operator:z.enum(['equals','notEquals']),values:z.array(text(256)).max(32),
}).strict();
// The policy options arrive with plugin 1.1.0; 1.0.0 data have none.
const policy=z.object({
 name:text(256),scopeId:ipv4.nullable(),order:z.number().int().min(0).max(65535),enabled:z.boolean(),condition:z.enum(['and','or']),
 criteria:z.array(criterion).max(32),ranges:z.array(range(ipv4)).max(32),leaseDurationSeconds:seconds.nullable(),description:text(1024),
 options:z.array(option).max(256).optional(),
}).strict();
/** The value types of a DHCP option definition (DHCP_OPTION_DATA_TYPE). */
export const dhcpOptionTypes=['byte','word','dword','dwordDword','ipAddress','ipv6Address','string','binary','encapsulated'] as const;
export type DhcpOptionType=typeof dhcpOptionTypes[number];
// The option definitions arrive with plugin 1.1.0 (DhcpEnumOptionsV5/V6); the option forms use them.
const optionDefinition=z.object({code:z.number().int().min(0).max(65535),name:text(128),type:z.enum(dhcpOptionTypes),multiValued:z.boolean(),vendorClass:text(128).nullable()}).strict();
const ipv4Scope=z.object({
 id:ipv4,name:text(256),description:text(1024),subnetMask:ipv4,startRange:ipv4,endRange:ipv4,state:z.enum(['active','inactive']),
 leaseDurationSeconds:seconds.nullable(),type:z.enum(['dhcp','bootp','both']),superscope:text(256).nullable(),failover:text(256).nullable(),
 usage:z.object({total:count,inUse:count,free:count,reserved:count,percent}).strict(),
 exclusions:z.array(range(ipv4)).max(100),
 reservations:z.array(z.object({address:ipv4,name:text(256),clientId:text(256),type:z.enum(['dhcp','bootp','both']),description:text(1024)}).strict()).max(2000),
 options:z.array(option).max(256),policies:z.array(policy).max(200),
}).strict();
const ipv6Scope=z.object({
 prefix:ipv6,name:text(256),description:text(1024),state:z.enum(['active','inactive']),preference:z.number().int().min(0).max(255),
 preferredLifetimeSeconds:seconds,validLifetimeSeconds:seconds,
 usage:z.object({inUse:count,free:count,percent}).strict(),
 exclusions:z.array(range(ipv6)).max(100),
 reservations:z.array(z.object({address:ipv6,name:text(256),duid:text(260),iaid:count,description:text(1024)}).strict()).max(2000),
 options:z.array(option).max(256),
}).strict();
const failover=z.object({
 name:text(256),partner:text(256),mode:z.enum(['loadBalance','hotStandby']),serverRole:z.enum(['active','standby']).nullable(),
 loadBalancePercent:z.number().int().min(0).max(100).nullable(),reservePercent:z.number().int().min(0).max(100).nullable(),
 state:text(64),mcltSeconds:seconds,autoStateTransition:z.boolean(),stateSwitchIntervalSeconds:seconds.nullable(),
 scopeIds:z.array(ipv4).max(500),messageAuthentication:z.boolean(),
}).strict();
const lease=z.object({
 family:z.enum(['ipv4','ipv6']),address,scope:text(64),name:text(256).nullable(),clientId:text(260),expiresAt:isoDate.nullable(),
 state:z.enum(['active','expired','declined','reserved','other']),
}).strict();

/**
 * One read of the DHCP server (schema 1). Every list is bounded; the upload is
 * at most 2 MiB, so the plugin cuts the leases first, then the reservations,
 * and sets the truncated flags. A stopped service gives service stopped with
 * the server facts and empty lists.
 */
export const dhcpSnapshotSchema=z.object({
 schema:z.literal(1),service:z.enum(['running','stopped']),
 server:z.object({name:text(256),authorization:z.enum(['authorized','unauthorized','notInDomain','unknown']),domain:text(256).nullable()}).strict(),
 ipv4:z.object({scopes:z.array(ipv4Scope).max(500),superscopes:z.array(z.object({name:text(256),scopeIds:z.array(ipv4).max(500)}).strict()).max(100),serverOptions:z.array(option).max(256),policies:z.array(policy).max(200),failover:z.array(failover).max(32),optionDefinitions:z.array(optionDefinition).max(512).optional()}).strict(),
 ipv6:z.object({scopes:z.array(ipv6Scope).max(200),serverOptions:z.array(option).max(256),optionDefinitions:z.array(optionDefinition).max(512).optional()}).strict(),
 leases:z.object({items:z.array(lease).max(10000),total:count,truncated:z.boolean()}).strict(),
 truncated:z.object({reservations:z.boolean(),leases:z.boolean()}).strict(),
}).strict();

export type DhcpSnapshot=z.infer<typeof dhcpSnapshotSchema>;
export type DhcpIpv4Scope=DhcpSnapshot['ipv4']['scopes'][number];
export type DhcpIpv6Scope=DhcpSnapshot['ipv6']['scopes'][number];
export type DhcpOption=DhcpIpv4Scope['options'][number];
export type DhcpPolicy=DhcpIpv4Scope['policies'][number];
export type DhcpFailover=DhcpSnapshot['ipv4']['failover'][number];
export type DhcpLease=DhcpSnapshot['leases']['items'][number];
export type DhcpOptionDefinition=z.infer<typeof optionDefinition>;
export type DhcpReservationRow={family:'ipv4'|'ipv6';address:string;name:string;clientId:string;scope:string;type:string|null;description:string};

/** One scope of the fleet view: the IPv4 total, or null for an IPv6 scope (its pool is not countable). */
export type DhcpUsageSummary={family:'ipv4'|'ipv6';scopeId:string;name:string;range:string;state:'active'|'inactive';inUse:number;total:number|null;percent:number};
export type DhcpUsageRow=DhcpUsageSummary&{serverId:string;collectedAt:number};

/** The scope usage of a snapshot: every IPv4 scope with its range, then every IPv6 scope. Stored as the summary of the upload. */
export function dhcpUsageSummary(snapshot:DhcpSnapshot):DhcpUsageSummary[]{
 return [
  ...snapshot.ipv4.scopes.map(scope=>({family:'ipv4' as const,scopeId:scope.id,name:scope.name,range:`${scope.startRange} – ${scope.endRange}`,state:scope.state,inUse:scope.usage.inUse,total:scope.usage.total,percent:scope.usage.percent})),
  ...snapshot.ipv6.scopes.map(scope=>({family:'ipv6' as const,scopeId:scope.prefix,name:scope.name,range:scope.prefix,state:scope.state,inUse:scope.usage.inUse,total:null,percent:scope.usage.percent})),
 ];
}

/** The usage rows of one device from its stored summary. */
export function dhcpUsageRows(serverId:string,summary:DhcpUsageSummary[],collectedAt:number):DhcpUsageRow[]{
 return summary.map(row=>({...row,serverId,collectedAt}));
}

/** The fleet order: the fullest scope first, then the server name, then the scope id. */
export function sortDhcpUsageRows<T extends {serverId:string;scopeId:string;percent:number}>(rows:T[],serverName:(id:string)=>string):T[]{
 const names=new Intl.Collator('en',{numeric:true,sensitivity:'base'});
 return [...rows].sort((a,b)=>b.percent-a.percent||names.compare(serverName(a.serverId),serverName(b.serverId))||names.compare(a.scopeId,b.scopeId));
}

export type DhcpKpis={scopes:number;active:number;inUse:number;total:number;percent:number;leases:number;leasesTruncated:boolean;fullest:{id:string;name:string;percent:number}|null};
/**
 * The KPI row of the device view: the IPv4 scope count and how many are
 * active, the in-use percent over the active IPv4 scopes (the sum of inUse over
 * the sum of total, 0 without addresses), the lease total and the fullest IPv4 scope.
 */
export function dhcpKpis(snapshot:DhcpSnapshot):DhcpKpis{
 const scopes=snapshot.ipv4.scopes,active=scopes.filter(scope=>scope.state==='active');
 const inUse=active.reduce((sum,scope)=>sum+scope.usage.inUse,0),total=active.reduce((sum,scope)=>sum+scope.usage.total,0);
 const fullest=[...scopes].sort((a,b)=>b.usage.percent-a.usage.percent||a.id.localeCompare(b.id,'en',{numeric:true}))[0];
 return {scopes:scopes.length,active:active.length,inUse,total,percent:total>0?Math.round(inUse/total*1000)/10:0,leases:snapshot.leases.total,leasesTruncated:snapshot.leases.truncated||snapshot.truncated.leases,fullest:fullest?{id:fullest.id,name:fullest.name,percent:fullest.usage.percent}:null};
}

/** Every reservation of the snapshot, IPv4 first, in scope order. */
export function dhcpReservations(snapshot:DhcpSnapshot):DhcpReservationRow[]{
 return [
  ...snapshot.ipv4.scopes.flatMap(scope=>scope.reservations.map(item=>({family:'ipv4' as const,address:item.address,name:item.name,clientId:item.clientId,scope:scope.id,type:item.type,description:item.description}))),
  ...snapshot.ipv6.scopes.flatMap(scope=>scope.reservations.map(item=>({family:'ipv6' as const,address:item.address,name:item.name,clientId:item.duid,scope:scope.prefix,type:null,description:item.description}))),
 ];
}

/** Every policy of the snapshot: the server policies first, then the policies of each scope, each list by its order. */
export function dhcpPolicies(snapshot:DhcpSnapshot):DhcpPolicy[]{
 const byOrder=(a:DhcpPolicy,b:DhcpPolicy)=>a.order-b.order||a.name.localeCompare(b.name);
 return [...[...snapshot.ipv4.policies].sort(byOrder),...snapshot.ipv4.scopes.flatMap(scope=>[...scope.policies].sort(byOrder))];
}

export type DhcpLeaseFilter={query:string;scope:string;state:string};
/** The leases that match the search (address, name or client ID, case-insensitive), the scope and the state; '' matches all. */
export function filterDhcpLeases(leases:DhcpLease[],{query,scope,state}:DhcpLeaseFilter):DhcpLease[]{
 const needle=query.trim().toLowerCase();
 return leases.filter(item=>(!scope||item.scope===scope)&&(!state||item.state===state)&&(!needle||[item.address,item.name??'',item.clientId].some(value=>value.toLowerCase().includes(needle))));
}

/** The scopes of one superscope filter: '' all, '\u0000' the scopes without a superscope, else the scopes of that superscope. */
export const DHCP_NO_SUPERSCOPE='\u0000';
export function filterDhcpScopes(scopes:DhcpIpv4Scope[],superscope:string):DhcpIpv4Scope[]{
 if(!superscope)return scopes;
 return scopes.filter(scope=>superscope===DHCP_NO_SUPERSCOPE?scope.superscope===null:scope.superscope===superscope);
}

/** A lease duration in whole days, hours or minutes, or null for unlimited. */
export function dhcpDuration(secondsValue:number|null):{unit:'days'|'hours'|'minutes'|'seconds';value:number}|null{
 if(secondsValue===null)return null;
 if(secondsValue>=86400&&secondsValue%86400===0)return {unit:'days',value:secondsValue/86400};
 if(secondsValue>=3600&&secondsValue%3600===0)return {unit:'hours',value:secondsValue/3600};
 if(secondsValue>=60&&secondsValue%60===0)return {unit:'minutes',value:secondsValue/60};
 return {unit:'seconds',value:secondsValue};
}
