import {z} from 'zod';
import {DNS_CHANGE_OPERATIONS,pluginReady,type DnsChangeOperation} from './plugin-catalog';
import {connectionKind} from './device-connection';
import {adIdentityReady} from './plugin-ad';
import {ipv4Number,ipv6Number,ipv6Text} from './dhcp-changes';
import {dnsRecordDataSchemas,isDnsRecordType,DNS_RECORD_TYPES,type DnsRecord,type DnsSnapshot,type DnsZone,type DnsZoneRecords} from './dns';
import type {MessageKey} from './i18n/translate';
import type {ServerSnapshot} from './types';

// The DNS changes of DNS plugin 1.0.0 (docs/dns-server.md, "Change the DNS
// server"): one strict schema per operation, the validation against the latest
// stored read (and the stored records of a zone), the reverse zone names, the
// object and the sentences of the confirmation, and the manage gate of the
// view. Pure: no database, no server bindings, so the drawers
// (ui/devices/extensions/dns-forms.tsx), POST /api/dns (lib/server/extensions/dns-manage.ts) and the tests
// share it. The plugin checks every value again (DnsChanges.cs).

export {DNS_CHANGE_OPERATIONS,type DnsChangeOperation};
export const isDnsChangeOperation=(value:unknown):value is DnsChangeOperation=>typeof value==='string'&&(DNS_CHANGE_OPERATIONS as readonly string[]).includes(value);
/** The largest serialized `parameters` of one change job, so the plugin request stays below the 64 KiB broker line. */
export const DNS_JOB_PARAMETER_LIMIT=49_152;
/** The record operations: they need the stored records of their zone and return the zone's records after the change. */
export const DNS_RECORD_OPERATIONS:ReadonlySet<DnsChangeOperation>=new Set(['dns-record-add','dns-record-edit','dns-record-delete']);
/** The bounds of a TTL in seconds, of a forwarder timeout and of the aging intervals in hours. */
export const DNS_TTL_MAX=2_147_483_647,DNS_TIMEOUT_MIN=1,DNS_TIMEOUT_MAX=15,DNS_HOURS_MIN=1,DNS_HOURS_MAX=8760;

// ---- Names ------------------------------------------------------------------------------------------
const label=/^[A-Za-z0-9_-]{1,63}$/;
/** A DNS name without its trailing dot, trimmed and in lower case. */
export const normalizeDnsName=(value:string)=>value.trim().replace(/\.$/,'').toLowerCase();
/** Whether a DNS name is valid: labels of 1 to 63 letters, digits, hyphens and underscores, at most 253 characters (a trailing dot is removed). */
export function dnsNameValid(value:unknown):boolean{
 if(typeof value!=='string')return false;
 const name=value.trim().replace(/\.$/,'');
 return name.length>0&&name.length<=253&&name.split('.').every(part=>label.test(part));
}
/** Whether a record name is valid inside its zone: '@' (or empty) for the zone itself, else a relative name that may start with '*.'; the full name stays within 253 characters. */
export function dnsRecordNameValid(value:unknown,zone:string):boolean{
 if(typeof value!=='string')return false;
 const name=value.trim().replace(/\.$/,'');
 if(name===''||name==='@')return true;
 const rest=name==='*'?'':name.startsWith('*.')?name.slice(2):name;
 if(rest&&!dnsNameValid(rest))return false;
 return name.length+1+zone.length<=253;
}
/** A record name as the portal and the plugin compare it: '@' for the zone itself, else the relative name in lower case. */
export const normalizeRecordName=(value:string)=>{const name=normalizeDnsName(value);return name===''?'@':name;};
/** A host name that ends in a domain: valid, with at least two labels. SRV also takes '.' (no service). */
export const dnsFqdnValid=(value:unknown,allowRoot=false)=>typeof value==='string'&&(allowRoot&&value.trim()==='.'||dnsNameValid(value)&&normalizeDnsName(value).includes('.'));

/** A server address: IPv4 or IPv6, in its canonical text (IPv6 compressed, lower case), or null. */
export function dnsAddress(value:unknown):string|null{
 if(typeof value!=='string')return null;
 const trimmed=value.trim();
 if(ipv4Number(trimmed)!==null)return trimmed;
 const v6=ipv6Number(trimmed);
 return v6===null?null:ipv6Text(v6);
}

/**
 * The reverse lookup zone of a network ID: an IPv4 network of 1 to 3 octets
 * (10.20.30 gives 30.20.10.in-addr.arpa) or an IPv6 prefix with a length that
 * is a multiple of 4 from 4 to 124 (2001:db8:1::/48 gives the nibbles in
 * reverse and .ip6.arpa). Null when the network ID is none; host bits must be 0.
 * The plugin computes the same names (DnsSelfTests.ReverseVectors).
 */
export function dnsReverseZoneName(networkId:unknown):string|null{
 if(typeof networkId!=='string')return null;
 const value=networkId.trim();
 if(/^\d{1,3}(\.\d{1,3}){0,2}$/.test(value)){
  const octets=value.split('.');
  if(octets.some(octet=>Number(octet)>255||octet.length>1&&octet.startsWith('0')))return null;
  return [...octets].reverse().join('.')+'.in-addr.arpa';
 }
 const match=/^([0-9a-fA-F:.]+)\/(\d{1,3})$/.exec(value);
 if(!match)return null;
 const bits=Number(match[2]),address=ipv6Number(match[1]);
 if(address===null||bits<4||bits>124||bits%4!==0)return null;
 const hostMask=(BigInt(1)<<BigInt(128-bits))-BigInt(1);
 if((address&hostMask)!==BigInt(0))return null;
 const hex=address.toString(16).padStart(32,'0').slice(0,bits/4);
 return [...hex].reverse().join('.')+'.ip6.arpa';
}

// ---- Schemas ----------------------------------------------------------------------------------------
const strict=<T extends z.ZodRawShape>(shape:T)=>z.object(shape).strict();
const name=z.string().max(255),address=z.string().max(45);
const int=(min:number,max:number)=>z.number().int().min(min).max(max);
const addresses=(min:number)=>z.array(address).min(min).max(16);
const scope=z.enum(['forest','domain','legacy']);
const dynamicUpdate=z.enum(['none','nonsecureAndSecure','secure']);
const hoursValue=int(DNS_HOURS_MIN,DNS_HOURS_MAX);
const aging=strict({enabled:z.boolean(),noRefreshHours:hoursValue,refreshHours:hoursValue});
const ttl=int(0,DNS_TTL_MAX).nullable();
const timeout=int(DNS_TIMEOUT_MIN,DNS_TIMEOUT_MAX);
/** A record as the portal names it in an edit or a delete: the name, the type and the data of the read. */
const recordIdentity=strict({name,type:z.string().min(1).max(16),data:z.record(z.string(),z.unknown())}).superRefine((value,context)=>{
 const schema=Object.hasOwn(dnsRecordDataSchemas,value.type)?dnsRecordDataSchemas[value.type as keyof typeof dnsRecordDataSchemas]:z.object({}).strict();
 if(!schema.safeParse(value.data).success)context.addIssue({code:z.ZodIssueCode.custom,path:['data'],message:'record data'});
});
const recordAdd=z.discriminatedUnion('type',DNS_RECORD_TYPES.map(type=>strict({zone:name,name,type:z.literal(type),ttlSeconds:ttl,ageRecord:z.boolean(),data:dnsRecordDataSchemas[type]})) as unknown as [z.ZodObject,...z.ZodObject[]]);

/** One strict schema per DNS change. Names and addresses are checked by validateDnsChange. */
export const dnsChangeSchemas={
 'dns-zone-create':strict({kind:z.enum(['primary','secondary','stub']),lookup:z.enum(['forward','reverse']),name:name.optional(),networkId:z.string().max(64).optional(),
  storage:z.enum(['ad','file']),replicationScope:scope.nullable(),fileName:name.nullable(),masters:z.array(address).max(16),dynamicUpdate}),
 'dns-zone-edit':strict({zone:name,dynamicUpdate:dynamicUpdate.optional(),
  transfers:strict({mode:z.enum(['none','any','nameServers','list']),servers:z.array(address).max(16)}).optional(),
  notify:strict({mode:z.enum(['off','nameServers','list']),servers:z.array(address).max(16)}).optional(),
  aging:aging.optional(),masters:addresses(1).optional(),storage:z.enum(['ad','file']).optional(),replicationScope:scope.optional()}),
 'dns-zone-delete':strict({zone:name}),
 'dns-zone-transfer':strict({zone:name}),
 'dns-record-add':recordAdd,
 'dns-record-edit':strict({zone:name,record:recordIdentity,ttlSeconds:ttl.optional(),ageRecord:z.boolean().optional(),data:z.record(z.string(),z.unknown()).optional()}).superRefine((value,context)=>{
  if(value.data===undefined)return;
  const type=value.record.type;
  if(!isDnsRecordType(type)){context.addIssue({code:z.ZodIssueCode.custom,path:['record'],message:'type'});return;}
  const parsed=dnsRecordDataSchemas[type].safeParse(value.data);
  if(!parsed.success)for(const issue of parsed.error.issues)context.addIssue({...issue,path:['data',...issue.path]});
 }),
 'dns-record-delete':strict({zone:name,records:z.array(recordIdentity).min(1).max(100)}),
 'dns-conditional-create':strict({name,masters:addresses(1),storage:z.enum(['ad','file']),replicationScope:scope.nullable(),timeoutSeconds:timeout.default(5)}),
 'dns-conditional-edit':strict({name,masters:addresses(1).optional(),storage:z.enum(['ad','file']).optional(),replicationScope:scope.nullable().optional(),timeoutSeconds:timeout.optional()}),
 'dns-conditional-delete':strict({name}),
 'dns-forwarders-set':strict({servers:z.array(address).max(16),timeoutSeconds:timeout,useRootHints:z.boolean()}),
 'dns-scavenging-set':strict({enabled:z.boolean(),intervalHours:hoursValue,defaultAging:aging,applyToAdZones:z.boolean()}),
 'dns-scavenge-now':strict({}),
 'dns-cache-clear':strict({}),
} satisfies Record<DnsChangeOperation,z.ZodTypeAny>;

// ---- Errors -----------------------------------------------------------------------------------------
export type DnsErrorCode='invalid'|'name'|'recordName'|'zoneExists'|'zoneMissing'|'networkId'|'address'|'ipv4'|'ipv6'|'mastersRequired'|'serversRequired'|'duplicateAddress'
 |'secureNeedsAd'|'scopeRequired'|'notDc'|'secondaryAd'|'kind'|'secondary'|'fqdn'|'number'|'text'|'duplicate'|'missing'|'cname'|'cnameTaken'|'ptrReverse'|'lastNs'
 |'recordsNotRead'|'soa'|'otherType'|'unchanged'|'scavengingOff'|'tooLarge';
export type DnsFieldError={field:string;code:DnsErrorCode;params?:Record<string,string|number>};
export type DnsValidation={ok:true}|{ok:false;errors:DnsFieldError[]};
/** The catalog key of each code (UI copy). */
export const dnsErrorKeys:Record<DnsErrorCode,MessageKey>={
 invalid:'dns.error.invalid',name:'dns.error.name',recordName:'dns.error.recordName',zoneExists:'dns.error.zoneExists',zoneMissing:'dns.error.zoneMissing',networkId:'dns.error.networkId',
 address:'dns.error.address',ipv4:'dns.error.ipv4',ipv6:'dns.error.ipv6',mastersRequired:'dns.error.mastersRequired',serversRequired:'dns.error.serversRequired',duplicateAddress:'dns.error.duplicateAddress',
 secureNeedsAd:'dns.error.secureNeedsAd',scopeRequired:'dns.error.scopeRequired',notDc:'dns.blocked.notDc',secondaryAd:'dns.blocked.secondaryAd',kind:'dns.error.kind',secondary:'dns.blocked.secondary',
 fqdn:'dns.error.fqdn',number:'dns.error.number',text:'dns.error.text',duplicate:'dns.error.duplicate',missing:'dns.error.missing',cname:'dns.error.cname',cnameTaken:'dns.error.cnameTaken',
 ptrReverse:'dns.error.ptrReverse',lastNs:'dns.error.lastNs',recordsNotRead:'dns.error.recordsNotRead',soa:'dns.blocked.soa',otherType:'dns.blocked.otherType',unchanged:'common.noChanges',
 scavengingOff:'dns.blocked.scavengingOff',tooLarge:'dns.error.tooLarge',
};
const errorCodes=new Set(Object.keys(dnsErrorKeys));
/** The field errors of a changeInvalid answer, without anything that is no field error. */
export function dnsFieldErrors(value:unknown):DnsFieldError[]{
 if(!Array.isArray(value))return [];
 return value.filter((item):item is DnsFieldError=>!!item&&typeof item==='object'&&typeof (item as DnsFieldError).field==='string'&&errorCodes.has((item as DnsFieldError).code)).slice(0,50);
}

const numberBounds:Record<string,[number,number]>={
 ttlSeconds:[0,DNS_TTL_MAX],timeoutSeconds:[DNS_TIMEOUT_MIN,DNS_TIMEOUT_MAX],intervalHours:[DNS_HOURS_MIN,DNS_HOURS_MAX],noRefreshHours:[DNS_HOURS_MIN,DNS_HOURS_MAX],refreshHours:[DNS_HOURS_MIN,DNS_HOURS_MAX],
 preference:[0,65535],priority:[0,65535],weight:[0,65535],port:[0,65535],
};
/** The form field of a schema issue: the data field of a record, the interval of an aging block, else the first key. */
function issueField(path:PropertyKey[]):string{
 const [first,second]=path;
 if((first==='data'||first==='aging'||first==='defaultAging')&&typeof second==='string')return second;
 if(first==='transfers'||first==='notify')return second==='servers'?`${first}Servers`:String(first);
 return String(first??'parameters');
}
function schemaErrors(issues:z.ZodIssue[]):DnsFieldError[]{
 const errors:DnsFieldError[]=[];
 for(const issue of issues){
  const field=issueField(issue.path);
  if(errors.some(error=>error.field===field))continue;
  if(numberBounds[field])errors.push({field,code:'number',params:{min:numberBounds[field][0],max:numberBounds[field][1]}});
  else if(field==='strings')errors.push({field,code:'text'});
  else if(field==='masters'&&issue.code==='too_small')errors.push({field,code:'mastersRequired'});
  else errors.push({field,code:'invalid'});
 }
 return errors;
}

// ---- Records --------------------------------------------------------------------------------------
type RecordData=Record<string,unknown>;
const nameFields=['target','host','nameServer','exchange'] as const;
/** The data of a record in the form the portal and the plugin compare: names lower case without the trailing dot, IPv6 compressed. */
export function normalizeRecordData(type:string,data:RecordData):RecordData{
 const result:RecordData={...data};
 for(const field of nameFields)if(typeof result[field]==='string'&&result[field]!=='.')result[field]=normalizeDnsName(result[field] as string);
 if((type==='A'||type==='AAAA')&&typeof result.address==='string')result.address=dnsAddress(result.address)??result.address.trim();
 return result;
}
const sorted=(value:unknown):unknown=>Array.isArray(value)?value.map(sorted):value&&typeof value==='object'?Object.fromEntries(Object.entries(value as RecordData).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,sorted(item)])):value;
/** The identity of a record: its name, type and normalized data. */
export const dnsRecordKey=(record:{name:string;type:string;data:RecordData})=>`${normalizeRecordName(record.name)}|${record.type.toUpperCase()}|${JSON.stringify(sorted(normalizeRecordData(record.type.toUpperCase(),record.data)))}`;
/** The data of a record as one line, for the object of a confirmation. */
export function dnsRecordDataText(type:string,data:RecordData):string{
 const value=(key:string)=>String(data[key]??'');
 switch(type){
  case 'A':case 'AAAA':return value('address');
  case 'CNAME':return value('target');
  case 'PTR':return value('host');
  case 'NS':return value('nameServer');
  case 'MX':return `${value('preference')} ${value('exchange')}`;
  case 'TXT':return (Array.isArray(data.strings)?data.strings as string[]:[]).map(item=>`"${item}"`).join(' ');
  case 'SRV':return `${value('priority')} ${value('weight')} ${value('port')} ${value('target')}`;
  default:return '';
 }
}

// ---- Validation -----------------------------------------------------------------------------------
const findZone=(snapshot:DnsSnapshot,zoneName:unknown)=>typeof zoneName==='string'?snapshot.zones.find(item=>item.name===normalizeDnsName(zoneName))??null:null;
/** The zone name of a create: the normalized name of a forward zone, the reverse name of a network ID. */
export function dnsCreatedZoneName(parameters:Record<string,unknown>):string|null{
 if(parameters.lookup==='reverse')return dnsReverseZoneName(parameters.networkId);
 return typeof parameters.name==='string'&&dnsNameValid(parameters.name)?normalizeDnsName(parameters.name):null;
}
type Context={snapshot:DnsSnapshot;records:DnsZoneRecords|null;p:Record<string,unknown>;add:(field:string,code:DnsErrorCode,params?:Record<string,string|number>)=>void};
/** A list of server addresses: each IPv4 or IPv6, none twice; `min` addresses at least. */
function addressList(context:Context,field:string,values:unknown,min:number,minCode:DnsErrorCode='mastersRequired'){
 const list=Array.isArray(values)?values:[];
 if(list.length<min){context.add(field,minCode);return;}
 const canonical=list.map(dnsAddress);
 if(canonical.some(item=>item===null)){context.add(field,'address');return;}
 if(new Set(canonical).size!==canonical.length)context.add(field,'duplicateAddress');
}
/** The storage rules of a zone or conditional forwarder: AD only on a domain controller and never for a secondary zone, a scope with AD and none with a file. */
function storageRules(context:Context,storage:unknown,replicationScope:unknown,kind:string,scopeKept:boolean){
 if(storage==='ad'){
  if(!context.snapshot.server.isDomainController)context.add('storage','notDc');
  else if(kind==='secondary')context.add('storage','secondaryAd');
  if((replicationScope===null||replicationScope===undefined)&&!scopeKept)context.add('replicationScope','scopeRequired');
 }
 if(storage==='file'&&replicationScope!==null&&replicationScope!==undefined)context.add('replicationScope','invalid');
}
/** The zone of a zone operation: it exists and is no conditional forwarder. */
function zoneOf(context:Context,field='zone'):DnsZone|null{
 const zone=findZone(context.snapshot,context.p[field]);
 if(!zone){context.add(field,'zoneMissing');return null;}
 if(zone.kind==='forwarder'){context.add(field,'kind');return null;}
 return zone;
}
/** The conditional forwarder of an edit or delete: a zone of kind forwarder. */
function forwarderOf(context:Context):DnsZone|null{
 const zone=findZone(context.snapshot,context.p.name);
 if(!zone){context.add('name','zoneMissing');return null;}
 if(zone.kind!=='forwarder'){context.add('name','kind');return null;}
 return zone;
}
function recordData(context:Context,type:string,data:RecordData,zone:DnsZone){
 const host=(field:string,allowRoot=false)=>{if(!dnsFqdnValid(data[field],allowRoot))context.add(field,'fqdn');};
 switch(type){
  case 'A':if(ipv4Number(typeof data.address==='string'?data.address.trim():null)===null)context.add('address','ipv4');break;
  case 'AAAA':if(ipv6Number(typeof data.address==='string'?data.address.trim():null)===null)context.add('address','ipv6');break;
  case 'CNAME':host('target');break;
  case 'PTR':host('host');if(zone.lookup!=='reverse')context.add('type','ptrReverse');break;
  case 'NS':host('nameServer');break;
  case 'MX':host('exchange');break;
  case 'SRV':host('target',true);break;
  case 'TXT':{const strings=Array.isArray(data.strings)?data.strings as unknown[]:[];if(!strings.length||strings.length>16||strings.some(item=>typeof item!=='string'||item.length>255))context.add('strings','text');break;}
 }
}
/** The records of a record change: the stored read of this zone, else recordsNotRead. */
function zoneRecords(context:Context,zone:DnsZone):DnsRecord[]|null{
 if(!context.records||context.records.zone!==zone.name){context.add('zone','recordsNotRead');return null;}
 return context.records.records;
}
/** The rules of a record name: no duplicate, a CNAME alone at its name. */
function recordConflicts(context:Context,records:readonly DnsRecord[],candidate:{name:string;type:string;data:RecordData},except?:string){
 const key=dnsRecordKey(candidate),at=normalizeRecordName(candidate.name);
 const others=records.filter(item=>normalizeRecordName(item.name)===at&&dnsRecordKey(item)!==except);
 if(others.some(item=>dnsRecordKey(item)===key)){context.add('name','duplicate');return;}
 const shown=at==='@'?'@':at;
 if(candidate.type==='CNAME'&&others.length)context.add('name','cname',{name:shown});
 else if(candidate.type!=='CNAME'&&others.some(item=>item.type==='CNAME'))context.add('name','cnameTaken',{name:shown});
}
/** The identity of an edited or deleted record: SOA and other types are refused, the record must be in the read. */
function existingRecord(context:Context,records:readonly DnsRecord[],identity:{name:string;type:string;data:RecordData},field:string):DnsRecord|null{
 if(identity.type==='SOA'){context.add(field,'soa');return null;}
 if(!isDnsRecordType(identity.type)){context.add(field,'otherType');return null;}
 const key=dnsRecordKey(identity),found=records.find(item=>dnsRecordKey(item)===key)??null;
 if(!found)context.add(field,'missing');
 return found;
}

/**
 * Checks one change against the stored read (and, for a record change, the
 * stored records of its zone): first the schema, then names, addresses, the
 * storage rules, the object of an edit or delete and its kind, and the record
 * rules. Returns every field error with its code; the drawers show them under
 * their fields, POST /api/dns answers them as changeInvalid.
 */
export function validateDnsChange(operation:DnsChangeOperation,parameters:unknown,snapshot:DnsSnapshot,records:DnsZoneRecords|null):DnsValidation{
 const schema=dnsChangeSchemas[operation] as z.ZodTypeAny|undefined;
 if(!schema)return {ok:false,errors:[{field:'operation',code:'invalid'}]};
 if(JSON.stringify(parameters??null).length>DNS_JOB_PARAMETER_LIMIT)return {ok:false,errors:[{field:'parameters',code:'tooLarge'}]};
 const parsed=schema.safeParse(parameters);
 if(!parsed.success)return {ok:false,errors:schemaErrors(parsed.error.issues)};
 const p=parsed.data as Record<string,unknown>,errors:DnsFieldError[]=[];
 const add=(field:string,code:DnsErrorCode,params?:Record<string,string|number>)=>{if(!errors.some(error=>error.field===field))errors.push(params?{field,code,params}:{field,code});};
 const context:Context={snapshot,records,p,add};
 switch(operation){
  case 'dns-zone-create':{
   const created=dnsCreatedZoneName(p),field=p.lookup==='reverse'?'networkId':'name';
   if(p.lookup==='reverse'?typeof p.networkId!=='string':typeof p.name!=='string')add(field,p.lookup==='reverse'?'networkId':'name');
   else if(!created)add(field,p.lookup==='reverse'?'networkId':'name');
   else if(findZone(snapshot,created))add(field,'zoneExists',{zone:created});
   storageRules(context,p.storage,p.replicationScope,String(p.kind),false);
   if(p.storage==='ad'&&p.fileName!==null)add('fileName','invalid');
   if(p.storage==='file'&&p.fileName!==null&&!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}$/.test(String(p.fileName)))add('fileName','invalid');
   if(p.kind==='primary'){if((p.masters as unknown[]).length)add('masters','invalid');}
   else addressList(context,'masters',p.masters,1);
   if(p.dynamicUpdate==='secure'&&(p.storage!=='ad'||p.kind!=='primary'))add('dynamicUpdate','secureNeedsAd');
   else if(p.kind!=='primary'&&p.dynamicUpdate!=='none')add('dynamicUpdate','kind');
   break;
  }
  case 'dns-zone-edit':{
   const zone=zoneOf(context);if(!zone)break;
   const keys=Object.keys(p).filter(key=>key!=='zone');
   if(!keys.length){add('zone','unchanged');break;}
   const primary=zone.kind==='primary',stub=zone.kind==='stub';
   if(p.dynamicUpdate!==undefined&&!primary)add('dynamicUpdate','kind');
   if(p.aging!==undefined&&!primary)add('aging','kind');
   if(p.masters!==undefined){if(primary)add('masters','kind');else addressList(context,'masters',p.masters,1);}
   for(const block of ['transfers','notify'] as const){
    const value=p[block] as {mode:string;servers:string[]}|undefined;if(!value)continue;
    if(stub){add(block,'kind');continue;}
    if(value.mode==='list')addressList(context,`${block}Servers`,value.servers,1,'serversRequired');
    else if(value.servers.length)add(`${block}Servers`,'invalid');
   }
   const storage=p.storage??zone.storage;
   if(p.storage!==undefined||p.replicationScope!==undefined){
    // A zone that stays in AD keeps its scope when none is given.
    storageRules(context,storage,p.replicationScope,zone.kind,storage==='ad'&&zone.storage==='ad');
   }
   const dynamicAfter=p.dynamicUpdate??zone.dynamicUpdate;
   if(dynamicAfter==='secure'&&storage!=='ad')add(p.dynamicUpdate!==undefined?'dynamicUpdate':'storage','secureNeedsAd');
   break;
  }
  case 'dns-zone-delete':zoneOf(context);break;
  case 'dns-zone-transfer':{const zone=zoneOf(context);if(zone&&zone.kind!=='secondary'&&zone.kind!=='stub')add('zone','kind');break;}
  case 'dns-record-add':case 'dns-record-edit':case 'dns-record-delete':{
   const zone=zoneOf(context);if(!zone)break;
   if(zone.kind!=='primary'){add('zone','secondary');break;}
   const list=zoneRecords(context,zone);if(!list)break;
   if(operation==='dns-record-add'){
    if(!dnsRecordNameValid(p.name,zone.name)){add('name','recordName');break;}
    const data=p.data as RecordData;
    recordData(context,String(p.type),data,zone);
    if(!errors.length)recordConflicts(context,list,{name:String(p.name),type:String(p.type),data});
   }else if(operation==='dns-record-edit'){
    const identity=p.record as {name:string;type:string;data:RecordData};
    const found=existingRecord(context,list,identity,'record');if(!found)break;
    if(p.data===undefined&&p.ttlSeconds===undefined&&p.ageRecord===undefined){add('record','unchanged');break;}
    if(p.data!==undefined){
     const data=p.data as RecordData;recordData(context,identity.type,data,zone);
     const candidate={name:identity.name,type:identity.type,data};
     if(!errors.length&&dnsRecordKey(candidate)!==dnsRecordKey(identity))recordConflicts(context,list,candidate,dnsRecordKey(identity));
    }
   }else{
    const identities=p.records as {name:string;type:string;data:RecordData}[];
    for(const identity of identities)if(!existingRecord(context,list,identity,'records'))break;
    if(new Set(identities.map(dnsRecordKey)).size!==identities.length)add('records','invalid');
    const removed=new Set(identities.map(dnsRecordKey));
    const apexNs=list.filter(item=>item.type==='NS'&&normalizeRecordName(item.name)==='@');
    if(apexNs.length&&apexNs.every(item=>removed.has(dnsRecordKey(item))))add('records','lastNs');
   }
   break;
  }
  case 'dns-conditional-create':{
   if(!dnsNameValid(p.name))add('name','name');
   else if(findZone(snapshot,p.name))add('name','zoneExists',{zone:normalizeDnsName(String(p.name))});
   addressList(context,'masters',p.masters,1);
   storageRules(context,p.storage,p.replicationScope,'forwarder',false);
   break;
  }
  case 'dns-conditional-edit':{
   const zone=forwarderOf(context);if(!zone)break;
   if(!Object.keys(p).some(key=>key!=='name')){add('name','unchanged');break;}
   if(p.masters!==undefined)addressList(context,'masters',p.masters,1);
   if(p.storage!==undefined||p.replicationScope!==undefined){
    const storage=p.storage??zone.storage;
    storageRules(context,storage,p.replicationScope,'forwarder',storage==='ad'&&zone.storage==='ad');
   }
   break;
  }
  case 'dns-conditional-delete':forwarderOf(context);break;
  case 'dns-forwarders-set':addressList(context,'servers',p.servers,0);break;
  case 'dns-scavenging-set':break;
  case 'dns-scavenge-now':if(!snapshot.scavenging.enabled)add('scavenging','scavengingOff');break;
  case 'dns-cache-clear':break;
 }
 return errors.length?{ok:false,errors}:{ok:true};
}

/**
 * The parameters as the job carries them: zone and record names in lower case
 * without the trailing dot, '@' for the zone itself, server addresses in their
 * canonical text and record data normalized. Call after a successful validation.
 */
export function normalizeDnsChange(operation:DnsChangeOperation,parameters:Record<string,unknown>):Record<string,unknown>{
 const p:Record<string,unknown>={...parameters};
 const list=(value:unknown)=>Array.isArray(value)?value.map(item=>dnsAddress(item)??item):value;
 const identity=(value:{name:string;type:string;data:RecordData})=>({name:normalizeRecordName(value.name),type:value.type,data:normalizeRecordData(value.type,value.data)});
 if(typeof p.zone==='string')p.zone=normalizeDnsName(p.zone);
 if(operation==='dns-zone-create'){
  if(p.lookup==='reverse'){p.name=dnsReverseZoneName(p.networkId);}else if(typeof p.name==='string')p.name=normalizeDnsName(p.name);
  if(p.storage==='file'&&(p.fileName===null||p.fileName===''))p.fileName=`${String(p.name)}.dns`;
 }
 if(operation.startsWith('dns-conditional-')&&typeof p.name==='string')p.name=normalizeDnsName(p.name);
 for(const key of ['masters','servers'])if(p[key]!==undefined)p[key]=list(p[key]);
 for(const key of ['transfers','notify'])if(p[key]&&typeof p[key]==='object'){const block=p[key] as {servers:unknown};p[key]={...block,servers:list(block.servers)};}
 if(operation==='dns-record-add'){p.name=normalizeRecordName(String(p.name));p.data=normalizeRecordData(String(p.type),p.data as RecordData);}
 if(operation==='dns-record-edit'){const record=identity(p.record as {name:string;type:string;data:RecordData});p.record=record;if(p.data)p.data=normalizeRecordData(record.type,p.data as RecordData);}
 if(operation==='dns-record-delete')p.records=(p.records as {name:string;type:string;data:RecordData}[]).map(identity);
 return p;
}

// ---- Display ----------------------------------------------------------------------------------------
/** The object of a change for the confirmation and the audit target: the zone, "{zone} / {name} {type}", the conditional forwarder, or Forwarders, Scavenging, Cache. */
export function dnsChangeObject(operation:DnsChangeOperation,parameters:Record<string,unknown>):string{
 const p=parameters,text=(value:unknown)=>typeof value==='string'?value:'';
 const zone=text(p.zone);
 switch(operation){
  case 'dns-zone-create':return dnsCreatedZoneName(p)??(text(p.name)||text(p.networkId));
  case 'dns-zone-edit':case 'dns-zone-delete':case 'dns-zone-transfer':return zone;
  case 'dns-record-add':return `${zone} / ${text(p.name)||'@'} ${text(p.type)}`;
  case 'dns-record-edit':{const record=p.record as {name?:string;type?:string}|undefined;return `${zone} / ${record?.name||'@'} ${record?.type??''}`.trim();}
  case 'dns-record-delete':{
   const list=Array.isArray(p.records)?p.records as {name?:string;type?:string}[]:[];
   const names=list.slice(0,3).map(item=>`${item.name||'@'} ${item.type??''}`.trim());
   return `${zone} / ${names.join(', ')}${list.length>3?` (+${list.length-3})`:''}`;
  }
  case 'dns-conditional-create':case 'dns-conditional-edit':case 'dns-conditional-delete':return text(p.name);
  case 'dns-forwarders-set':return 'Forwarders';
  case 'dns-scavenging-set':case 'dns-scavenge-now':return 'Scavenging';
  case 'dns-cache-clear':return 'Cache';
 }
}

/** One sentence of a confirmation: its catalog key and parameters. */
export type DnsSentence={key:MessageKey;params?:Record<string,string|number>};
/** The storage of the object a change touches after the change: an AD scope (with the partition of a custom scope), or null for a file or a server setting. */
function changedStorage(operation:DnsChangeOperation,p:Record<string,unknown>,snapshot:DnsSnapshot):{object:string;scope:'forest'|'domain'|'legacy'|'custom';partition:string}|null{
 const zone=findZone(snapshot,operation.startsWith('dns-conditional-')?p.name:p.zone);
 const create=operation==='dns-zone-create'||operation==='dns-conditional-create';
 const object=create?(operation==='dns-zone-create'?dnsCreatedZoneName(p)??'':normalizeDnsName(String(p.name??''))):zone?.name??'';
 const storage=create?p.storage:(p.storage as string|undefined)??zone?.storage;
 // A deleted object replicates its removal from where it was stored.
 const scope=(create?p.replicationScope:(p.replicationScope as string|undefined)??zone?.replicationScope) as 'forest'|'domain'|'legacy'|'custom'|null|undefined;
 if(storage!=='ad'&&!(operation.endsWith('-delete')&&zone?.storage==='ad'))return null;
 return {object,scope:scope??'domain',partition:zone?.partition??''};
}
/**
 * The sentences of a confirmation: for a change to a zone or conditional
 * forwarder stored in AD, how far it replicates (forest, domain, all domain
 * controllers, or the custom partition); else that it applies only to this
 * device. Then the sentence of the operation itself (delete, transfer, cache,
 * scavenging). Pure; the drawers translate it.
 */
export function dnsChangeDescription(operation:DnsChangeOperation,parameters:Record<string,unknown>,snapshot:DnsSnapshot,device:string):DnsSentence[]{
 const p=parameters,sentences:DnsSentence[]=[];
 const serverWide=operation==='dns-forwarders-set'||operation==='dns-scavenging-set'||operation==='dns-scavenge-now'||operation==='dns-cache-clear';
 const stored=serverWide?null:changedStorage(operation,p,snapshot);
 if(stored){
  const key=({forest:'dns.confirm.adForest',domain:'dns.confirm.adDomain',legacy:'dns.confirm.adLegacy',custom:'dns.confirm.adCustom'} as const)[stored.scope];
  sentences.push({key,params:stored.scope==='custom'?{object:stored.object,partition:stored.partition}:{object:stored.object}});
 }else sentences.push({key:'dns.confirm.local',params:{device}});
 if(operation==='dns-zone-delete'||operation==='dns-conditional-delete')sentences.push({key:'dns.confirm.zoneDelete'});
 if(operation==='dns-record-delete')sentences.push({key:'dns.confirm.recordDelete',params:{count:Array.isArray(p.records)?p.records.length:0}});
 if(operation==='dns-zone-transfer')sentences.push({key:'dns.confirm.transfer',params:{device}});
 if(operation==='dns-cache-clear')sentences.push({key:'dns.confirm.cacheClear',params:{device}});
 if(operation==='dns-scavenge-now')sentences.push({key:'dns.confirm.scavengeNow'});
 if(operation==='dns-scavenging-set'&&p.applyToAdZones===true)sentences.push({key:'dns.confirm.applyAd'});
 return sentences;
}

// ---- The manage gate of the view --------------------------------------------------------------------
type ManagedDevice={permissions?:string[];lastSeen:number|null;management?:number;maintenance?:{state:string}|null;snapshot:Pick<ServerSnapshot,'plugins'|'mode'|'agentCapabilities'>|null};
/**
 * The first reason why the viewer cannot change this DNS server now, as a
 * catalog key, or null: demo, the right Manage DNS, offline, a plugin without
 * the operation, an agent without plugin-ad-identity (the key takes {device}),
 * ReadOnly mode, a stopped service, no data. A missing AD sign-in is no reason:
 * the change opens the sign-in first. The server stays the authority. Without
 * `data` (undefined) the last two steps are skipped.
 */
export function dnsManageBlocked(server:ManagedDevice,viewer:{permissions?:string[]},demo:boolean,now:number,data?:{snapshot:DnsSnapshot|null}|null,operation:DnsChangeOperation='dns-zone-create'):MessageKey|null{
 if(demo)return 'kit.unavailable.demo';
 // eslint-disable-next-line no-restricted-syntax -- a display gate of the client like permitted() in ui/base/api.tsx; POST /api/dns checks dns.manage itself.
 if(!viewer.permissions?.includes('*')&&!server.permissions?.includes('dns.manage'))return 'dns.blocked.manageRight';
 if(connectionKind(server,now)!=='online')return 'extensions.blocked.offline';
 if(!pluginReady(server.snapshot,'dns',operation))return 'dns.blocked.plugin';
 if(!adIdentityReady(server.snapshot))return 'pluginAd.blocked.agent';
 if(!server.management||server.snapshot?.mode!=='Management')return 'dns.blocked.readOnly';
 if(data===undefined)return null;
 if(data?.snapshot?.service==='stopped')return 'dns.blocked.stopped';
 if(!data?.snapshot)return 'dns.blocked.noData';
 return null;
}
