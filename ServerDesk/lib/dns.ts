import {z} from 'zod';

// The Windows DNS server as the DNS plugin reads it (docs/dns-server.md): the
// schema of the server read (dns-read, every 15 minutes) and of one zone's
// records (dns-zone-read, on request), the zone summary of the fleet card, the
// KPI row and the filters of the device view. Pure: no database, no server
// bindings, so the client, POST/GET /api/dns and the tests share it.

export const DNS_PLUGIN='dns',DNS_READ='dns-read',DNS_ZONE_READ='dns-zone-read';
/** The plugin reads the DNS server every 15 minutes under the signed plugin policy. */
export const DNS_INTERVAL_SECONDS=900;
/** The record types the portal changes; SOA is read only, every other type is shown as text. */
export const DNS_RECORD_TYPES=['A','AAAA','CNAME','MX','PTR','TXT','SRV','NS'] as const;
export type DnsRecordType=typeof DNS_RECORD_TYPES[number];
export const isDnsRecordType=(value:unknown):value is DnsRecordType=>typeof value==='string'&&(DNS_RECORD_TYPES as readonly string[]).includes(value);

const text=(max:number)=>z.string().max(max);
const isoDate=z.string().max(40).datetime({offset:true});
const hours=z.number().int().min(0).max(87600);
const address=z.string().min(2).max(45).regex(/^[0-9a-fA-F:.]+$/);
/** A zone name as stored: lower case, without the trailing dot. */
const zoneName=z.string().min(1).max(255).refine(value=>value===value.toLowerCase()&&!value.endsWith('.'),{message:'lower case without a trailing dot'});
const scope=z.enum(['forest','domain','legacy','custom']);
const aging=z.object({enabled:z.boolean(),noRefreshHours:hours,refreshHours:hours}).strict();

const zone=z.object({
 name:zoneName,kind:z.enum(['primary','secondary','stub','forwarder']),lookup:z.enum(['forward','reverse']),
 storage:z.enum(['ad','file']),replicationScope:scope.nullable(),partition:text(255).nullable(),fileName:text(255).nullable(),
 dynamicUpdate:z.enum(['none','nonsecureAndSecure','secure']),
 transfers:z.object({mode:z.enum(['none','any','nameServers','list']),servers:z.array(address).max(16)}).strict(),
 notify:z.object({mode:z.enum(['off','nameServers','list']),servers:z.array(address).max(16)}).strict(),
 masters:z.array(address).max(16),aging:aging.nullable(),forwarderTimeoutSeconds:z.number().int().min(0).max(3600).nullable(),
 paused:z.boolean(),autoCreated:z.boolean(),serial:z.number().int().min(0).max(4294967295).nullable(),recordCount:z.number().int().min(0).max(100_000_000).nullable(),
}).strict();

/**
 * One read of the DNS server (dns-read). Every list is bounded; the upload is
 * at most 2 MiB, so the plugin cuts the zones last and sets truncated.zones.
 * A stopped service gives service stopped with empty lists.
 */
export const dnsSnapshotSchema=z.object({
 kind:z.literal('server'),collectedAt:isoDate,service:z.enum(['running','stopped']),
 server:z.object({name:text(256),domain:text(256).nullable(),version:text(64).nullable(),isDomainController:z.boolean(),listenAddresses:z.array(address).max(64)}).strict(),
 forwarders:z.object({servers:z.array(address).max(16),timeoutSeconds:z.number().int().min(0).max(3600),useRootHints:z.boolean()}).strict(),
 scavenging:z.object({enabled:z.boolean(),intervalHours:hours,lastRunAt:isoDate.nullable(),defaultAging:aging}).strict(),
 zones:z.array(zone).max(2000),
 truncated:z.object({zones:z.boolean()}).strict(),
}).strict();
export type DnsSnapshot=z.infer<typeof dnsSnapshotSchema>;
export type DnsZone=DnsSnapshot['zones'][number];

const u16=z.number().int().min(0).max(65535),u32=z.number().int().min(0).max(4294967295);
const host=text(255);
/** The typed data of each record type; any other type has {} and shows only its text. */
export const dnsRecordDataSchemas={
 A:z.object({address:text(45)}).strict(),
 AAAA:z.object({address:text(45)}).strict(),
 CNAME:z.object({target:host}).strict(),
 PTR:z.object({host}).strict(),
 NS:z.object({nameServer:host}).strict(),
 MX:z.object({preference:u16,exchange:host}).strict(),
 TXT:z.object({strings:z.array(text(255)).min(1).max(16)}).strict(),
 SRV:z.object({priority:u16,weight:u16,port:u16,target:host}).strict(),
 SOA:z.object({primaryServer:host,responsiblePerson:host,serial:u32,refreshSeconds:u32,retrySeconds:u32,expireSeconds:u32,minimumTtlSeconds:u32}).strict(),
} as const;
const otherData=z.object({}).strict();
/** The data schema of a record type: typed for the known types, {} for any other. */
export const dnsRecordDataSchema=(type:string)=>Object.hasOwn(dnsRecordDataSchemas,type)?dnsRecordDataSchemas[type as keyof typeof dnsRecordDataSchemas]:otherData;

const record=z.object({
 name:text(255).min(1),type:z.string().min(1).max(16).regex(/^[A-Z0-9]+$/),ttlSeconds:z.number().int().min(0).max(2147483647),
 timestamp:isoDate.nullable(),data:z.record(z.string(),z.unknown()),text:text(4096),
}).strict().superRefine((value,context)=>{
 const parsed=dnsRecordDataSchema(value.type).safeParse(value.data);
 if(!parsed.success)context.addIssue({code:z.ZodIssueCode.custom,path:['data'],message:'data does not fit the type'});
});
/** The records of one zone (dns-zone-read, and the read after a record change). The plugin cuts them to 2 MiB with truncated and the full total. */
export const dnsZoneRecordsSchema=z.object({
 kind:z.literal('zone'),zone:zoneName,collectedAt:isoDate,
 records:z.array(record).max(100_000),total:z.number().int().min(0).max(100_000_000),truncated:z.boolean(),
}).strict();
export type DnsZoneRecords=z.infer<typeof dnsZoneRecordsSchema>;
export type DnsRecord=DnsZoneRecords['records'][number];

// ---- Summary and the fleet rows ------------------------------------------------------------------
/** One zone of the stored summary (device_plugin_data.summary of dns-read). */
export type DnsZoneSummary=Pick<DnsZone,'name'|'kind'|'lookup'|'storage'|'replicationScope'|'dynamicUpdate'|'recordCount'|'autoCreated'>;
/** One row of the fleet card: a zone of a device with the read time. */
export type DnsFleetZone=Omit<DnsZoneSummary,'autoCreated'|'name'>&{serverId:string;zone:string;collectedAt:number};
/** The zone summary of a read: one entry per zone in read order. */
export function dnsZoneSummary(snapshot:DnsSnapshot):DnsZoneSummary[]{
 return snapshot.zones.map(item=>({name:item.name,kind:item.kind,lookup:item.lookup,storage:item.storage,replicationScope:item.replicationScope,dynamicUpdate:item.dynamicUpdate,recordCount:item.recordCount,autoCreated:item.autoCreated}));
}
/** The fleet rows of one device from its summary: zones that Windows did not create itself. */
export function dnsFleetRows(serverId:string,summary:readonly DnsZoneSummary[],collectedAt:number):DnsFleetZone[]{
 return summary.filter(item=>!item.autoCreated).map(item=>({serverId,zone:item.name,kind:item.kind,lookup:item.lookup,storage:item.storage,replicationScope:item.replicationScope,dynamicUpdate:item.dynamicUpdate,recordCount:item.recordCount,collectedAt}));
}
/** The fleet order: zone name, then device name. */
export function sortDnsFleetRows<T extends {serverId:string;zone:string}>(rows:readonly T[],serverName:(id:string)=>string):T[]{
 const names=new Intl.Collator('en',{numeric:true,sensitivity:'base'});
 return [...rows].sort((a,b)=>names.compare(a.zone,b.zone)||names.compare(serverName(a.serverId),serverName(b.serverId)));
}

// ---- The device view ----------------------------------------------------------------------------
/** The zones of the Zones section: every zone that is no conditional forwarder. */
export const dnsZones=(snapshot:DnsSnapshot)=>snapshot.zones.filter(item=>item.kind!=='forwarder');
/** The conditional forwarders: the zones of kind forwarder. */
export const dnsConditionalForwarders=(snapshot:DnsSnapshot)=>snapshot.zones.filter(item=>item.kind==='forwarder');

export type DnsKpis={zones:number;forward:number;reverse:number;ad:number;records:number;forwarders:number;useRootHints:boolean;scavenging:boolean;intervalHours:number};
/**
 * The KPI row of the device view: the zones (no conditional forwarders) with
 * the forward and reverse split, how many are stored in AD, the records of the
 * primary zones, the forwarders with the root hints and the scavenging state.
 */
export function dnsKpis(snapshot:DnsSnapshot):DnsKpis{
 const zones=dnsZones(snapshot);
 return {
  zones:zones.length,forward:zones.filter(item=>item.lookup==='forward').length,reverse:zones.filter(item=>item.lookup==='reverse').length,
  ad:zones.filter(item=>item.storage==='ad').length,
  records:zones.filter(item=>item.kind==='primary').reduce((sum,item)=>sum+(item.recordCount??0),0),
  forwarders:snapshot.forwarders.servers.length,useRootHints:snapshot.forwarders.useRootHints,
  scavenging:snapshot.scavenging.enabled,intervalHours:snapshot.scavenging.intervalHours,
 };
}

/** The storage of a zone as one key: AD with its replication scope, or a file. */
export type DnsStorageKey='forest'|'domain'|'legacy'|'custom'|'file';
export const dnsStorageKey=(item:Pick<DnsZone,'storage'|'replicationScope'>):DnsStorageKey=>item.storage==='file'?'file':item.replicationScope??'domain';

export type DnsZoneFilter={query:string;lookup:''|'forward'|'reverse'};
/** The zones that match the search (zone name, case-insensitive) and the lookup ('' matches all). */
export function filterDnsZones<T extends Pick<DnsZone,'name'|'lookup'>>(zones:readonly T[],{query,lookup}:DnsZoneFilter):T[]{
 const needle=query.trim().toLowerCase();
 return zones.filter(item=>(!lookup||item.lookup===lookup)&&(!needle||item.name.includes(needle)));
}

/** The type filter of the records: '' all, a known type, SOA, or 'other' for every type the portal does not change. */
export const dnsRecordTypeFilters=['','A','AAAA','CNAME','MX','PTR','TXT','SRV','NS','SOA','other'] as const;
export type DnsRecordTypeFilter=typeof dnsRecordTypeFilters[number];
export type DnsRecordFilter={query:string;type:DnsRecordTypeFilter};
/** The records that match the search (name or text, case-insensitive) and the type filter. */
export function filterDnsRecords(records:readonly DnsRecord[],{query,type}:DnsRecordFilter):DnsRecord[]{
 const needle=query.trim().toLowerCase();
 return records.filter(item=>{
  if(type==='other'?isDnsRecordType(item.type)||item.type==='SOA':type&&item.type!==type)return false;
  return !needle||item.name.toLowerCase().includes(needle)||item.text.toLowerCase().includes(needle);
 });
}

/** A TTL in whole days, hours, minutes or seconds. */
export function dnsTtl(seconds:number):{unit:'days'|'hours'|'minutes'|'seconds';value:number}{
 if(seconds>=86400&&seconds%86400===0)return {unit:'days',value:seconds/86400};
 if(seconds>=3600&&seconds%3600===0)return {unit:'hours',value:seconds/3600};
 if(seconds>=60&&seconds%60===0)return {unit:'minutes',value:seconds/60};
 return {unit:'seconds',value:seconds};
}
