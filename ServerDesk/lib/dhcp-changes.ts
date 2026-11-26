import {z} from 'zod';
import {DHCP_CHANGE_OPERATIONS,pluginReady,type DhcpChangeOperation} from './plugin-catalog';
import {connectionKind} from './device-connection';
import {adIdentityReady} from './plugin-ad';
import type {DhcpIpv4Scope,DhcpOptionDefinition,DhcpOptionType,DhcpSnapshot} from './dhcp';
import type {MessageKey} from './i18n/translate';
import type {ServerSnapshot} from './types';

// The DHCP changes of DHCP plugin 1.1.0 (docs/dhcp-server.md, "Change the DHCP
// server"): one strict schema per operation, the validation against the latest
// stored read, the failover partner match, the mirrored partner parameters and
// the parts of a replicated scope. Pure: no database, no server bindings, so
// the drawers (ui/devices/extensions/dhcp-forms.tsx), POST /api/dhcp (lib/server/extensions/dhcp-manage.ts)
// and the tests share it. The plugin checks every value again (DhcpChanges.cs).

export {DHCP_CHANGE_OPERATIONS,type DhcpChangeOperation};
export const isDhcpChangeOperation=(value:unknown):value is DhcpChangeOperation=>typeof value==='string'&&(DHCP_CHANGE_OPERATIONS as readonly string[]).includes(value);
/** The largest serialized `parameters` of one change job, so the plugin request stays below the 64 KiB broker line. */
export const DHCP_JOB_PARAMETER_LIMIT=49_152;
/** The lease duration bounds of a scope or policy: 1 minute to 999 days; null is unlimited. */
export const DHCP_LEASE_MIN=60,DHCP_LEASE_MAX=86_313_600;

// ---- Addresses -------------------------------------------------------------------------------
const ipv4Pattern=/^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
/** An IPv4 address as an unsigned 32-bit number, or null. */
export function ipv4Number(text:unknown):number|null{
 if(typeof text!=='string'||!ipv4Pattern.test(text))return null;
 return text.split('.').reduce((value,part)=>value*256+Number(part),0);
}
export const ipv4Text=(value:number)=>[24,16,8,0].map(shift=>Math.floor(value/2**shift)%256).join('.');
/** The prefix length of a contiguous subnet mask from /8 to /30, or null. */
export function maskBits(text:unknown):number|null{
 const value=ipv4Number(text);if(value===null)return null;
 for(let bits=8;bits<=30;bits++)if(value===2**32-2**(32-bits))return bits;
 return null;
}
const network=(address:number,bits:number)=>address-address%2**(32-bits);
const broadcast=(address:number,bits:number)=>network(address,bits)+2**(32-bits)-1;
/** An IPv6 address as a 128-bit number, or null (also accepts an embedded IPv4 tail). */
export function ipv6Number(text:unknown):bigint|null{
 if(typeof text!=='string'||text.length<2||text.length>45||!/^[0-9a-fA-F:.]+$/.test(text))return null;
 let value=text;
 const tail=/:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
 if(tail){const v4=ipv4Number(tail[1]);if(v4===null)return null;value=value.slice(0,-tail[1].length)+(Math.floor(v4/65536)).toString(16)+':'+(v4%65536).toString(16);}
 const halves=value.split('::');if(halves.length>2)return null;
 const groups=(part:string)=>part===''?[]:part.split(':');
 const head=groups(halves[0]),rest=halves.length===2?groups(halves[1]):[];
 const missing=8-head.length-rest.length;
 if(halves.length===2?missing<1:missing!==0)return null;
 const all=[...head,...Array(halves.length===2?missing:0).fill('0'),...rest];
 if(all.some(group=>!/^[0-9a-fA-F]{1,4}$/.test(group)))return null;
 return all.reduce((sum,group)=>(sum<<BigInt('16'))+BigInt(parseInt(group,16)),BigInt('0'));
}
/** The compressed lowercase text of a 128-bit address. */
export function ipv6Text(value:bigint):string{
 const groups=Array.from({length:8},(_,index)=>Number((value>>BigInt(112-16*index))&BigInt('0xffff')));
 let best=-1,length=0;
 for(let start=0;start<8;start++){let end=start;while(end<8&&groups[end]===0)end++;if(end-start>length&&end-start>1){best=start;length=end-start;}}
 const hex=groups.map(group=>group.toString(16));
 if(best<0)return hex.join(':');
 return hex.slice(0,best).join(':')+'::'+hex.slice(best+length).join(':');
}
const LOW64=(BigInt('1')<<BigInt('64'))-BigInt('1');
/** A /64 prefix (the low 64 bits zero), or null. */
export function ipv6Prefix(text:unknown):bigint|null{const value=ipv6Number(text);return value!==null&&(value&LOW64)===BigInt('0')?value:null;}
const hexBytes=(text:string,max:number)=>{const plain=text.replace(/[-:.\s]/g,'');return /^[0-9a-fA-F]+$/.test(plain)&&plain.length%2===0&&plain.length>=2&&plain.length<=max*2?plain.toUpperCase().match(/../g)!.join('-'):null;};
/** A MAC address or client ID as hexadecimal bytes, normalized to 00-15-5D-01-02-03; null when it is none. */
export const normalizeClientId=(text:unknown)=>typeof text==='string'?hexBytes(text,85):null;
/** A DUID as hexadecimal bytes (2 to 130 bytes), normalized like a client ID; null when it is none. */
export const normalizeDuid=(text:unknown)=>{if(typeof text!=='string')return null;const value=hexBytes(text,130);return value&&value.length>=5?value:null;};

// ---- Schemas ---------------------------------------------------------------------------------
const strict=<T extends z.ZodRawShape>(shape:T)=>z.object(shape).strict();
const name=z.string().max(256),description=z.string().max(1024),address=z.string().max(45);
const int=(min:number,max:number)=>z.number().int().min(min).max(max);
const scopeType=z.enum(['dhcp','bootp','both']);
const leaseDuration=int(DHCP_LEASE_MIN,DHCP_LEASE_MAX).nullable();
const v4={family:z.literal('ipv4'),scopeId:address},v6={family:z.literal('ipv6'),prefix:address};
const byFamily=<A extends z.ZodRawShape,B extends z.ZodRawShape>(a:A,b:B)=>z.discriminatedUnion('family',[strict({...v4,...a}),strict({...v6,...b})]);
const scopeV4={name,description,startRange:address,endRange:address,leaseDurationSeconds:leaseDuration,type:scopeType};
const optionTarget={family:z.enum(['ipv4','ipv6']),level:z.enum(['server','scope','policy']),scopeId:address.nullable().optional(),prefix:address.optional(),policy:name.optional(),code:int(0,65535),vendorClass:z.string().max(128).nullable(),userClass:z.string().max(128).nullable()};
const optionValues=z.array(z.string().max(512)).min(1).max(32);
const criterion=strict({type:z.enum(['mac','vendorClass','userClass','clientId','relayAgent','circuitId','remoteId','subscriberId','fqdn']),operator:z.enum(['equals','notEquals']),values:z.array(z.string().min(1).max(256)).min(1).max(32)});
const range=strict({start:address,end:address});
const policy={scopeId:address.nullable(),name,description,enabled:z.boolean(),order:int(1,65535),condition:z.enum(['and','or']),criteria:z.array(criterion).max(32),ranges:z.array(range).max(32),leaseDurationSeconds:leaseDuration};
const scopeIds=(min:number)=>z.array(address).min(min).max(500);
const seconds=int(0,4294967295);
// The settings of one replicated scope as the source read them (dhcpSnapshotSchema), so any stored scope fits.
const applyOption=strict({code:int(0,65535),name:z.string().max(128).optional(),vendorClass:z.string().max(128).nullable(),userClass:z.string().max(128).nullable(),values:z.array(z.string().max(512)).max(32)});
const applyPolicy=strict({name,order:int(0,65535),enabled:z.boolean(),condition:z.enum(['and','or']),criteria:z.array(strict({type:criterion.shape.type,operator:criterion.shape.operator,values:z.array(z.string().max(256)).max(32)})).max(32),ranges:z.array(range).max(32),leaseDurationSeconds:seconds.nullable(),description,options:z.array(applyOption).max(256)});
const applyReservation=strict({address,clientId:z.string().max(256),name,description,type:scopeType});

/** One strict schema per DHCP change. Addresses and names are checked by validateDhcpChange. */
export const dhcpChangeSchemas={
 'dhcp-scope-create':z.discriminatedUnion('family',[strict({...v4,scopeId:address.optional(),...scopeV4,subnetMask:address,activate:z.boolean()}),strict({...v6,name,description,preference:int(0,255),activate:z.boolean()})]),
 'dhcp-scope-edit':byFamily(scopeV4,{name,description,preference:int(0,255)}),
 'dhcp-scope-activate':byFamily({},{}),
 'dhcp-scope-deactivate':byFamily({},{}),
 'dhcp-scope-delete':byFamily({},{}),
 'dhcp-superscope-create':strict({name,scopeIds:scopeIds(1)}),
 'dhcp-superscope-edit':strict({name,newName:name.optional(),scopeIds:scopeIds(1)}),
 'dhcp-superscope-activate':strict({name}),
 'dhcp-superscope-deactivate':strict({name}),
 'dhcp-superscope-delete':strict({name}),
 'dhcp-exclusion-add':byFamily({start:address,end:address},{start:address,end:address}),
 'dhcp-exclusion-remove':byFamily({start:address,end:address},{start:address,end:address}),
 'dhcp-reservation-add':byFamily({address,clientId:z.string().max(256),name,description,type:scopeType},{address,duid:z.string().max(400),iaid:seconds}),
 'dhcp-reservation-edit':byFamily({address,newAddress:address.optional(),clientId:z.string().max(256),name,description,type:scopeType},{address,newAddress:address.optional(),duid:z.string().max(400),iaid:seconds}),
 'dhcp-reservation-remove':byFamily({address},{address}),
 'dhcp-lease-delete':byFamily({addresses:z.array(address).min(1).max(100)},{addresses:z.array(address).min(1).max(100)}),
 'dhcp-option-set':strict({...optionTarget,values:optionValues}),
 'dhcp-option-remove':strict(optionTarget),
 'dhcp-policy-create':strict(policy),
 'dhcp-policy-edit':strict({...policy,newName:name.optional()}),
 'dhcp-policy-delete':strict({scopeId:address.nullable(),name}),
 // The defaults of the spec: primary, 50 % share, active with a 5 % reserve, MCLT 1 hour, no automatic switch after 1 hour, no authentication.
 'dhcp-failover-create':strict({name,partner:z.string().min(1).max(256),serverType:z.enum(['primary','secondary']).default('primary'),mode:z.enum(['loadBalance','hotStandby']),loadBalancePercent:int(0,100).default(50),serverRole:z.enum(['active','standby']).default('active'),reservePercent:int(0,100).default(5),
  mcltSeconds:int(60,3_600_000).default(3600),autoStateTransition:z.boolean().default(false),stateSwitchIntervalSeconds:int(60,DHCP_LEASE_MAX).nullable().default(3600),messageAuthentication:z.boolean().default(false),scopeIds:scopeIds(1),serverAddress:address.optional(),partnerAddress:address.optional()}),
 'dhcp-failover-edit':strict({name,loadBalancePercent:int(0,100).optional(),reservePercent:int(0,100).optional(),mcltSeconds:int(60,3_600_000).optional(),autoStateTransition:z.boolean().optional(),stateSwitchIntervalSeconds:int(60,DHCP_LEASE_MAX).nullable().optional(),
  messageAuthentication:z.boolean().optional(),addScopeIds:scopeIds(0).optional(),removeScopeIds:scopeIds(0).optional(),
  // The partner side only: the removed scopes are deleted there, as the DHCP console does.
  deleteRemovedScopes:z.boolean().optional()}),
 'dhcp-failover-remove':strict({name,deletePartnerScopes:z.boolean()}),
 'dhcp-scope-apply':strict({scopeId:address,part:int(1,20),parts:int(1,20),
  settings:strict({name,description,startRange:address,endRange:address,subnetMask:address,leaseDurationSeconds:seconds.nullable(),type:scopeType,state:z.enum(['active','inactive']),exclusions:z.array(range).max(100),options:z.array(applyOption).max(256),policies:z.array(applyPolicy).max(200)}).optional(),
  reservations:z.array(applyReservation).max(2000),keep:z.array(address).max(2000).optional()}),
} satisfies Record<DhcpChangeOperation,z.ZodTypeAny>;
export type DhcpChangeParameters<O extends DhcpChangeOperation>=z.infer<typeof dhcpChangeSchemas[O]>;

// ---- Errors ----------------------------------------------------------------------------------
export type DhcpErrorCode='invalid'|'ipv4'|'ipv6'|'prefix'|'mask'|'order'|'subnet'|'exists'|'overlap'|'outside'|'reservationAddress'|'reservationClient'|'clientId'|'duid'|'required'|'duration'|'number'
 |'optionValue'|'optionSingle'|'optionUnknown'|'criteria'|'rangesServer'|'scopesRequired'|'nameTaken'|'missing'|'inFailover'|'secret'|'tooLarge';
export type DhcpFieldError={field:string;code:DhcpErrorCode;params?:Record<string,string|number>};
export type DhcpValidation={ok:true}|{ok:false;errors:DhcpFieldError[]};
/** The catalog key of each code (UI copy). */
export const dhcpErrorKeys:Record<DhcpErrorCode,MessageKey>={
 invalid:'dhcp.error.invalid',ipv4:'dhcp.error.ipv4',ipv6:'dhcp.error.ipv6',prefix:'dhcp.error.prefix',mask:'dhcp.error.mask',order:'dhcp.error.order',subnet:'dhcp.error.subnet',exists:'dhcp.error.exists',
 overlap:'dhcp.error.overlap',outside:'dhcp.error.outside',reservationAddress:'dhcp.error.reservationAddress',reservationClient:'dhcp.error.reservationClient',clientId:'dhcp.error.clientId',duid:'dhcp.error.duid',
 required:'dhcp.error.required',duration:'dhcp.error.duration',number:'dhcp.error.number',optionValue:'dhcp.error.optionValue',optionSingle:'dhcp.error.optionSingle',optionUnknown:'dhcp.error.optionUnknown',
 criteria:'dhcp.error.criteria',rangesServer:'dhcp.error.rangesServer',scopesRequired:'dhcp.error.scopesRequired',nameTaken:'dhcp.error.nameTaken',missing:'dhcp.error.missing',inFailover:'dhcp.error.inFailover',
 secret:'dhcp.error.secret',tooLarge:'dhcp.error.tooLarge',
};
const errorCodes=new Set(Object.keys(dhcpErrorKeys));
/** The field errors of a changeInvalid answer, without anything that is no field error. */
export function dhcpFieldErrors(value:unknown):DhcpFieldError[]{
 if(!Array.isArray(value))return [];
 return value.filter((item):item is DhcpFieldError=>!!item&&typeof item==='object'&&typeof (item as DhcpFieldError).field==='string'&&errorCodes.has((item as DhcpFieldError).code)).slice(0,50);
}

const numberBounds:Record<string,[number,number]>={preference:[0,255],order:[1,65535],iaid:[0,4294967295],loadBalancePercent:[0,100],reservePercent:[0,100],mcltSeconds:[60,3_600_000],stateSwitchIntervalSeconds:[60,DHCP_LEASE_MAX],code:[0,65535]};
function schemaErrors(issues:z.ZodIssue[]):DhcpFieldError[]{
 const errors:DhcpFieldError[]=[];
 for(const issue of issues){
  const field=String(issue.path[0]??'parameters');
  if(errors.some(error=>error.field===field))continue;
  if(field==='leaseDurationSeconds')errors.push({field,code:'duration'});
  else if(numberBounds[field])errors.push({field,code:'number',params:{min:numberBounds[field][0],max:numberBounds[field][1]}});
  else if(field==='criteria'&&issue.code==='too_small')errors.push({field,code:'criteria'});
  else if(/scopeIds$/i.test(field)&&issue.code==='too_small')errors.push({field,code:'scopesRequired'});
  else errors.push({field,code:'invalid'});
 }
 return errors;
}

/** The parameters with every client ID and DUID normalized (00-15-5D-01-02-03); unchanged when one is invalid. */
export function normalizeDhcpChange<T>(operation:DhcpChangeOperation,parameters:T):T{
 if(!parameters||typeof parameters!=='object')return parameters;
 const p={...parameters} as Record<string,unknown>;
 if(operation==='dhcp-reservation-add'||operation==='dhcp-reservation-edit'){
  if(typeof p.clientId==='string')p.clientId=normalizeClientId(p.clientId)??p.clientId;
  if(typeof p.duid==='string')p.duid=normalizeDuid(p.duid)??p.duid;
 }
 return p as T;
}

// ---- Option values -----------------------------------------------------------------------------
/** Whether one line is a valid value of the option type. */
export function dhcpOptionValueValid(type:DhcpOptionType,value:string):boolean{
 const whole=(max:bigint)=>/^\d{1,20}$/.test(value)&&BigInt(value)<=max;
 switch(type){
  case 'byte':return whole(BigInt('255'));
  case 'word':return whole(BigInt('65535'));
  case 'dword':return whole(BigInt('4294967295'));
  case 'dwordDword':return whole(BigInt('18446744073709551615'));
  case 'ipAddress':return ipv4Number(value)!==null;
  case 'ipv6Address':return ipv6Number(value)!==null;
  case 'string':return value.length>0&&value.length<=512;
  case 'binary':case 'encapsulated':return hexBytes(value,255)!==null;
 }
}
/** The definition of an option code (and vendor class) in the read, or null. */
export function dhcpOptionDefinition(snapshot:DhcpSnapshot,family:'ipv4'|'ipv6',code:number,vendorClass:string|null=null):DhcpOptionDefinition|null{
 return snapshot[family].optionDefinitions?.find(item=>item.code===code&&(item.vendorClass??null)===(vendorClass??null))??null;
}

// ---- Validation ----------------------------------------------------------------------------------
type Scope4=DhcpIpv4Scope;
const findScope=(snapshot:DhcpSnapshot,id:unknown)=>snapshot.ipv4.scopes.find(scope=>scope.id===id)??null;
const findScope6=(snapshot:DhcpSnapshot,prefix:unknown)=>{const value=ipv6Prefix(prefix);return value===null?null:snapshot.ipv6.scopes.find(scope=>ipv6Number(scope.prefix)===value)??null;};
const sameText=(a:string,b:string)=>a.localeCompare(b,'en',{sensitivity:'accent'})===0;
const policiesAt=(snapshot:DhcpSnapshot,scopeId:string|null)=>scopeId===null?snapshot.ipv4.policies:findScope(snapshot,scopeId)?.policies??[];

/**
 * Validates one change against the latest stored read: the schema,
 * then addresses, ranges, uniqueness, the object of an edit or removal, the
 * option value types, the policy rules and the failover rules. Returns every
 * field error with its code; the drawers show them under their fields.
 */
export function validateDhcpChange(operation:DhcpChangeOperation,parameters:unknown,snapshot:DhcpSnapshot):DhcpValidation{
 const schema=dhcpChangeSchemas[operation] as z.ZodTypeAny;
 if(!schema)return {ok:false,errors:[{field:'operation',code:'invalid'}]};
 const parsed=schema.safeParse(normalizeDhcpChange(operation,parameters));
 if(!parsed.success)return {ok:false,errors:schemaErrors(parsed.error.issues)};
 const p=parsed.data as Record<string,unknown>,errors:DhcpFieldError[]=[];
 const add=(field:string,code:DhcpErrorCode,params?:Record<string,string|number>)=>{if(!errors.some(error=>error.field===field))errors.push(params?{field,code,params}:{field,code});};
 const required=(field:string)=>{if(typeof p[field]!=='string'||!(p[field] as string).trim())add(field,'required');};
 const v4=(field:string,value=p[field])=>{const number=ipv4Number(value);if(number===null)add(field,'ipv4');return number;};
 const v6=(field:string,value=p[field])=>{const number=ipv6Number(value);if(number===null)add(field,'ipv6');return number;};
 const scope4=(field='scopeId')=>{if(ipv4Number(p[field])===null){add(field,'ipv4');return null;}const scope=findScope(snapshot,p[field]);if(!scope)add(field,'missing');return scope;};
 const scope6=()=>{if(ipv6Prefix(p.prefix)===null){add('prefix','prefix');return null;}const scope=findScope6(snapshot,p.prefix);if(!scope)add('prefix','missing');return scope;};
 const inRange=(field:string,value:number|null,scope:Scope4)=>{
  const start=ipv4Number(scope.startRange)!,end=ipv4Number(scope.endRange)!;
  if(value!==null&&(value<start||value>end))add(field,'outside',{start:scope.startRange,end:scope.endRange});
 };
 const inPrefix=(field:string,value:bigint|null,prefix:string)=>{
  const base=ipv6Number(prefix);if(value===null||base===null)return;
  if((value&~LOW64)!==base)add(field,'outside',{start:ipv6Text(base),end:ipv6Text(base|LOW64)});
 };
 const order=(endField:string,start:number|bigint|null,end:number|bigint|null)=>{if(start!==null&&end!==null&&end<start)add(endField,'order');};
 const scopeList=(field:string,{free=false,inRelationship}:{free?:boolean;inRelationship?:string}={})=>{
  const ids=(p[field] as string[]|undefined)??[];
  for(const id of ids){
   if(ipv4Number(id)===null){add(field,'ipv4');return;}
   const scope=findScope(snapshot,id);if(!scope){add(field,'missing');return;}
   if(free&&scope.failover){add(field,'inFailover',{scope:id,relationship:scope.failover});return;}
   if(inRelationship!==undefined&&scope.failover!==inRelationship){add(field,'missing');return;}
  }
  if(new Set(ids).size!==ids.length)add(field,'invalid');
 };
 const leaseOk=()=>{const value=p.leaseDurationSeconds;if(value!==null&&(typeof value!=='number'||value<DHCP_LEASE_MIN||value>DHCP_LEASE_MAX))add('leaseDurationSeconds','duration');};
 const family=p.family as 'ipv4'|'ipv6'|undefined;
 switch(operation){
  case 'dhcp-scope-create':{
   required('name');
   if(family==='ipv6'){
    const prefix=ipv6Prefix(p.prefix);
    if(prefix===null)add('prefix','prefix');
    else if(findScope6(snapshot,p.prefix))add('prefix','exists',{scope:ipv6Text(prefix)});
    break;
   }
   const start=v4('startRange'),end=v4('endRange'),bits=maskBits(p.subnetMask);
   if(bits===null)add('subnetMask','mask');
   order('endRange',start,end);
   if(start===null||end===null||bits===null)break;
   const id=network(start,bits);
   if(network(end,bits)!==id){add('endRange','subnet');break;}
   if(p.scopeId!==undefined&&p.scopeId!==ipv4Text(id))add('scopeId','subnet');
   const existing=findScope(snapshot,ipv4Text(id));
   if(existing){add('startRange','exists',{scope:existing.id});break;}
   const top=broadcast(start,bits);
   const overlap=snapshot.ipv4.scopes.find(scope=>{const other=ipv4Number(scope.id),otherBits=maskBits(scope.subnetMask);if(other===null||otherBits===null)return false;return other<=top&&broadcast(other,otherBits)>=id;});
   if(overlap)add('startRange','overlap',{scope:overlap.id});
   leaseOk();
   break;
  }
  case 'dhcp-scope-edit':{
   required('name');
   if(family==='ipv6'){scope6();break;}
   const scope=scope4();if(!scope)break;
   const start=v4('startRange'),end=v4('endRange'),id=ipv4Number(scope.id)!,bits=maskBits(scope.subnetMask)??24;
   order('endRange',start,end);
   if(start!==null&&network(start,bits)!==id)add('startRange','subnet');
   if(end!==null&&network(end,bits)!==id)add('endRange','subnet');
   leaseOk();
   break;
  }
  case 'dhcp-scope-activate':case 'dhcp-scope-deactivate':
   if(family==='ipv6')scope6();else scope4();
   break;
  case 'dhcp-scope-delete':{
   if(family==='ipv6'){scope6();break;}
   const scope=scope4();
   if(scope?.failover)add('scopeId','inFailover',{scope:scope.id,relationship:scope.failover});
   break;
  }
  case 'dhcp-superscope-create':{
   required('name');
   if(snapshot.ipv4.superscopes.some(item=>sameText(item.name,String(p.name))))add('name','nameTaken');
   scopeList('scopeIds');
   break;
  }
  case 'dhcp-superscope-edit':{
   if(!snapshot.ipv4.superscopes.some(item=>item.name===p.name)){add('name','missing');break;}
   if(p.newName!==undefined){
    if(!String(p.newName).trim())add('newName','required');
    else if(p.newName!==p.name&&snapshot.ipv4.superscopes.some(item=>sameText(item.name,String(p.newName))))add('newName','nameTaken');
   }
   scopeList('scopeIds');
   break;
  }
  case 'dhcp-superscope-activate':case 'dhcp-superscope-deactivate':case 'dhcp-superscope-delete':
   if(!snapshot.ipv4.superscopes.some(item=>item.name===p.name))add('name','missing');
   break;
  case 'dhcp-exclusion-add':case 'dhcp-exclusion-remove':{
   const adding=operation==='dhcp-exclusion-add';
   if(family==='ipv6'){
    const scope=scope6(),start=v6('start'),end=v6('end');order('end',start,end);
    if(!scope)break;
    if(adding){inPrefix('start',start,scope.prefix);inPrefix('end',end,scope.prefix);}
    else if(!scope.exclusions.some(item=>ipv6Number(item.start)===start&&ipv6Number(item.end)===end))add('start','missing');
    break;
   }
   const scope=scope4(),start=v4('start'),end=v4('end');order('end',start,end);
   if(!scope)break;
   if(adding){inRange('start',start,scope);inRange('end',end,scope);}
   else if(!scope.exclusions.some(item=>item.start===p.start&&item.end===p.end))add('start','missing');
   break;
  }
  case 'dhcp-reservation-add':case 'dhcp-reservation-edit':{
   const editing=operation==='dhcp-reservation-edit',target=editing&&p.newAddress!==undefined?'newAddress':'address';
   if(family==='ipv6'){
    const scope=scope6(),value=v6(target,p[target]);
    if(normalizeDuid(p.duid)===null)add('duid','duid');
    if(!scope)break;
    const current=editing?scope.reservations.find(item=>ipv6Number(item.address)===ipv6Number(p.address))??null:null;
    if(editing&&!current){add('address','missing');break;}
    inPrefix(target,value,scope.prefix);
    if(value!==null&&scope.reservations.some(item=>item!==current&&ipv6Number(item.address)===value))add(target,'reservationAddress',{address:String(p[target])});
    break;
   }
   const scope=scope4(),value=v4(target,p[target]),client=normalizeClientId(p.clientId);
   required('name');
   if(client===null)add('clientId','clientId');
   if(!scope)break;
   const current=editing?scope.reservations.find(item=>item.address===p.address)??null:null;
   if(editing&&!current){add('address','missing');break;}
   inRange(target,value,scope);
   if(value!==null&&scope.reservations.some(item=>item!==current&&item.address===p[target]))add(target,'reservationAddress',{address:String(p[target])});
   if(client!==null&&scope.reservations.some(item=>item!==current&&normalizeClientId(item.clientId)===client))add('clientId','reservationClient');
   break;
  }
  case 'dhcp-reservation-remove':{
   if(family==='ipv6'){const scope=scope6();if(scope&&!scope.reservations.some(item=>ipv6Number(item.address)===ipv6Number(p.address)))add('address','missing');break;}
   const scope=scope4();if(scope&&!scope.reservations.some(item=>item.address===p.address))add('address','missing');
   break;
  }
  case 'dhcp-lease-delete':{
   if(family==='ipv6')scope6();else scope4();
   for(const value of p.addresses as string[])if((family==='ipv6'?ipv6Number(value):ipv4Number(value))===null){add('addresses',family==='ipv6'?'ipv6':'ipv4');break;}
   break;
  }
  case 'dhcp-option-set':case 'dhcp-option-remove':{
   const fam=family??'ipv4',level=p.level as 'server'|'scope'|'policy',code=p.code as number;
   let options=fam==='ipv4'?snapshot.ipv4.serverOptions:snapshot.ipv6.serverOptions;
   if(fam==='ipv6'&&level==='policy'){add('level','invalid');break;}
   if(level==='scope'){
    if(fam==='ipv6'){const scope=scope6();options=scope?.options??[];}
    else{const scope=scope4();options=scope?.options??[];}
   }
   if(level==='policy'){
    const scopeId=(p.scopeId as string|null|undefined)??null;
    if(scopeId!==null&&!findScope(snapshot,scopeId)){add('scopeId','missing');break;}
    const owner=policiesAt(snapshot,scopeId).find(item=>item.name===p.policy);
    if(!owner){add('policy','missing');break;}
    options=owner.options??[];
   }
   const same=(item:{code:number;vendorClass:string|null;userClass:string|null})=>item.code===code&&(item.vendorClass??null)===(p.vendorClass??null)&&(item.userClass??null)===(p.userClass??null);
   if(operation==='dhcp-option-remove'){if(!options.some(same))add('code','missing');break;}
   const definitions=snapshot[fam].optionDefinitions,definition=dhcpOptionDefinition(snapshot,fam,code,(p.vendorClass as string|null)??null);
   if(definitions?.length&&!definition){add('code','optionUnknown');break;}
   if(!definition)break;
   const values=p.values as string[];
   if(!definition.multiValued&&values.length>1){add('values','optionSingle');break;}
   const bad=values.findIndex(value=>!dhcpOptionValueValid(definition.type,value.trim()));
   if(bad>=0)add('values','optionValue',{line:bad+1,type:definition.type});
   break;
  }
  case 'dhcp-policy-create':case 'dhcp-policy-edit':case 'dhcp-policy-delete':{
   const scopeId=(p.scopeId as string|null)??null;
   let scope:Scope4|null=null;
   if(scopeId!==null){scope=scope4();if(!scope)break;}
   const list=policiesAt(snapshot,scopeId),existing=list.find(item=>item.name===p.name);
   if(operation!=='dhcp-policy-create'&&!existing){add('name','missing');break;}
   if(operation==='dhcp-policy-delete')break;
   if(operation==='dhcp-policy-create'){required('name');if(list.some(item=>sameText(item.name,String(p.name))))add('name','nameTaken');}
   if(p.newName!==undefined){
    if(!String(p.newName).trim())add('newName','required');
    else if(p.newName!==p.name&&list.some(item=>sameText(item.name,String(p.newName))))add('newName','nameTaken');
   }
   if(!(p.criteria as unknown[]).length)add('criteria','criteria');
   const ranges=p.ranges as {start:string;end:string}[];
   if(ranges.length&&!scope)add('ranges','rangesServer');
   else if(scope)for(const item of ranges){
    const start=ipv4Number(item.start),end=ipv4Number(item.end);
    if(start===null||end===null){add('ranges','ipv4');break;}
    if(end<start){add('ranges','order');break;}
    inRange('ranges',start,scope);inRange('ranges',end,scope);
   }
   leaseOk();
   break;
  }
  case 'dhcp-failover-create':{
   required('name');
   if(snapshot.ipv4.failover.some(item=>sameText(item.name,String(p.name))))add('name','nameTaken');
   scopeList('scopeIds',{free:true});
   for(const field of ['serverAddress','partnerAddress'])if(p[field]!==undefined)v4(field);
   break;
  }
  case 'dhcp-failover-edit':{
   const relation=snapshot.ipv4.failover.find(item=>item.name===p.name);
   if(!relation){add('name','missing');break;}
   scopeList('addScopeIds',{free:true});
   scopeList('removeScopeIds',{inRelationship:relation.name});
   const removed=new Set((p.removeScopeIds as string[]|undefined)??[]),added=(p.addScopeIds as string[]|undefined)??[];
   if(relation.scopeIds.filter(id=>!removed.has(id)).length+added.length<1)add('removeScopeIds','scopesRequired');
   break;
  }
  case 'dhcp-failover-remove':
   if(!snapshot.ipv4.failover.some(item=>item.name===p.name))add('name','missing');
   break;
  case 'dhcp-scope-apply':
   if(ipv4Number(p.scopeId)===null)add('scopeId','ipv4');
   break;
 }
 if(!errors.length&&new TextEncoder().encode(JSON.stringify(p)).length>DHCP_JOB_PARAMETER_LIMIT)add('parameters','tooLarge');
 return errors.length?{ok:false,errors}:{ok:true};
}

// ---- Shared secret ---------------------------------------------------------------------------------
/** A new failover shared secret: 8 to 255 characters. */
export const dhcpSecretValid=(value:unknown):value is string=>typeof value==='string'&&value.length>=8&&value.length<=255;
/** Whether a change sets a new shared secret: an authenticated failover create, or an edit that turns authentication on. */
export const dhcpChangeNeedsSecret=(operation:DhcpChangeOperation,parameters:Record<string,unknown>)=>(operation==='dhcp-failover-create'||operation==='dhcp-failover-edit')&&parameters.messageAuthentication===true;
/** The agent capability that unseals secrets for plugins (agent 4.17.0). */
export const PLUGIN_SECRETS='plugin-secrets';

// ---- Failover partner ------------------------------------------------------------------------------
/** A device that may be the failover partner: its name, the DHCP server name of its read (null when unknown) and its addresses. */
export type DhcpPartnerCandidate={id:string;name:string;serverName:string|null;addresses:string[]};
/**
 * The device of a failover partner: the partner text matches the DHCP
 * server name of the read, the device name equals its first DNS label, or the
 * IPv4 partner is one of the device addresses (all case-insensitive). The one
 * match, or null for none or more than one.
 */
export function dhcpPartnerDevice<T extends DhcpPartnerCandidate>(partner:string,candidates:readonly T[]):T|null{
 const text=partner.trim().toLowerCase();if(!text)return null;
 const label=ipv4Number(text)===null?text.split('.')[0]:null;
 const matches=candidates.filter(device=>(device.serverName!==null&&device.serverName.toLowerCase()===text)||(label!==null&&device.name.toLowerCase()===label)||(ipv4Number(text)!==null&&device.addresses.includes(text)));
 return matches.length===1?matches[0]:null;
}
/** The first usable IPv4 address of a device (no loopback, no link-local), for the failover endpoints. */
export function dhcpDeviceAddress(snapshot:Pick<ServerSnapshot,'networks'>|null|undefined):string|null{
 for(const item of snapshot?.networks??[])for(const value of item.addresses??[]){const number=ipv4Number(value);if(number!==null&&!value.startsWith('127.')&&!value.startsWith('169.254.'))return value;}
 return null;
}

/** The failover relationship a scope-level change is mirrored through, or null. */
export type DhcpMirror={scopeId:string;relationship:string;partner:string};
/** The IPv4 scope of a scope-level change, or null for lease deletes, server-level changes, superscopes, IPv6 and failover. */
export function dhcpChangeScope(operation:DhcpChangeOperation,parameters:Record<string,unknown>):string|null{
 const p=parameters;
 switch(operation){
  case 'dhcp-scope-edit':case 'dhcp-scope-activate':case 'dhcp-scope-deactivate':
  case 'dhcp-exclusion-add':case 'dhcp-exclusion-remove':case 'dhcp-reservation-add':case 'dhcp-reservation-edit':case 'dhcp-reservation-remove':
   return p.family==='ipv4'&&typeof p.scopeId==='string'?p.scopeId:null;
  case 'dhcp-option-set':case 'dhcp-option-remove':
   if(p.family!=='ipv4')return null;
   return (p.level==='scope'||p.level==='policy')&&typeof p.scopeId==='string'?p.scopeId:null;
  case 'dhcp-policy-create':case 'dhcp-policy-edit':case 'dhcp-policy-delete':
   return typeof p.scopeId==='string'?p.scopeId:null;
  default:return null;
 }
}
/** The mirror of a change: the scope's failover relationship and partner when the scope is in one. */
export function dhcpMirror(operation:DhcpChangeOperation,parameters:Record<string,unknown>,snapshot:DhcpSnapshot):DhcpMirror|null{
 const scopeId=dhcpChangeScope(operation,parameters);if(!scopeId)return null;
 const scope=findScope(snapshot,scopeId);if(!scope?.failover)return null;
 const relation=snapshot.ipv4.failover.find(item=>item.name===scope.failover);
 return relation?{scopeId,relationship:relation.name,partner:relation.partner}:null;
}
/**
 * The partner side of a failover change: create as
 * secondary with 100−p and the role flipped, the local server as partner and
 * the endpoints swapped; an edit with 100−p; a removal that deletes the scopes
 * there. Other changes are mirrored with the same parameters.
 */
export function dhcpPartnerParameters(operation:DhcpChangeOperation,parameters:Record<string,unknown>,localServerName:string):Record<string,unknown>{
 const p=parameters;
 if(operation==='dhcp-failover-create')return {...p,serverType:'secondary',partner:localServerName,loadBalancePercent:100-Number(p.loadBalancePercent),serverRole:p.serverRole==='active'?'standby':'active',
  ...(p.partnerAddress!==undefined?{serverAddress:p.partnerAddress}:{}),...(p.serverAddress!==undefined?{partnerAddress:p.serverAddress}:{})};
 if(operation==='dhcp-failover-edit')return {...p,...(typeof p.loadBalancePercent==='number'?{loadBalancePercent:100-p.loadBalancePercent}:{}),...(Array.isArray(p.removeScopeIds)&&p.removeScopeIds.length?{deleteRemovedScopes:true}:{})};
 if(operation==='dhcp-failover-remove')return {name:p.name,deletePartnerScopes:true};
 return {...p};
}

// ---- Replicate ---------------------------------------------------------------------------------------
type ApplyPart=DhcpChangeParameters<'dhcp-scope-apply'>;
const bytes=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value)).length;
/**
 * One stored scope as dhcp-scope-apply parts of at most `limit` bytes:
 * part 1 carries the settings (range, exclusions, scope options, scope
 * policies with their options) and replaces them, every part upserts a chunk
 * of reservations, and the last part carries `keep` (every reservation
 * address) and removes the others. Null when the settings alone exceed the limit.
 */
export function dhcpScopeApplyParts(scope:DhcpIpv4Scope,limit=DHCP_JOB_PARAMETER_LIMIT):ApplyPart[]|null{
 const budget=limit-64;
 const settings:NonNullable<ApplyPart['settings']>={name:scope.name,description:scope.description,startRange:scope.startRange,endRange:scope.endRange,subnetMask:scope.subnetMask,leaseDurationSeconds:scope.leaseDurationSeconds,type:scope.type,state:scope.state,
  exclusions:scope.exclusions.map(item=>({start:String(item.start),end:String(item.end)})),options:scope.options.map(item=>({code:item.code,vendorClass:item.vendorClass,userClass:item.userClass,values:item.values})),
  policies:scope.policies.map(item=>({name:item.name,order:item.order,enabled:item.enabled,condition:item.condition,criteria:item.criteria,ranges:item.ranges.map(range=>({start:String(range.start),end:String(range.end)})),leaseDurationSeconds:item.leaseDurationSeconds,description:item.description,options:(item.options??[]).map(option=>({code:option.code,vendorClass:option.vendorClass,userClass:option.userClass,values:option.values}))}))};
 const reservations=scope.reservations.map(item=>({address:item.address,clientId:item.clientId,name:item.name,description:item.description,type:item.type}));
 const parts:ApplyPart[]=[];
 let current:ApplyPart={scopeId:scope.id,part:1,parts:1,settings,reservations:[]},size=bytes(current);
 if(size>budget)return null;
 for(const item of reservations){
  const extra=bytes(item)+1;
  if(size+extra>budget&&current.reservations.length){parts.push(current);current={scopeId:scope.id,part:1,parts:1,reservations:[]};size=bytes(current);}
  current.reservations.push(item);size+=extra;
 }
 const keep=reservations.map(item=>item.address),keepSize=bytes(keep)+8;
 if(size+keepSize>budget){parts.push(current);current={scopeId:scope.id,part:1,parts:1,reservations:[]};}
 current.keep=keep;parts.push(current);
 return parts.map((part,index)=>({...part,part:index+1,parts:parts.length}));
}

// ---- Display -----------------------------------------------------------------------------------------
/** The object of a change for the confirmation and the audit target, for example a scope id, a reservation address or a policy name. */
export function dhcpChangeObject(operation:DhcpChangeOperation,parameters:Record<string,unknown>):string{
 const p=parameters,text=(value:unknown)=>typeof value==='string'?value:'';
 const scope=text(p.scopeId)||text(p.prefix);
 switch(operation){
  case 'dhcp-scope-create':{
   if(p.family==='ipv6')return text(p.prefix);
   const start=ipv4Number(p.startRange),bits=maskBits(p.subnetMask);
   return text(p.scopeId)||(start!==null&&bits!==null?ipv4Text(network(start,bits)):text(p.startRange));
  }
  case 'dhcp-scope-edit':case 'dhcp-scope-activate':case 'dhcp-scope-deactivate':case 'dhcp-scope-delete':case 'dhcp-scope-apply':return scope;
  case 'dhcp-exclusion-add':case 'dhcp-exclusion-remove':return `${text(p.start)} – ${text(p.end)}`;
  case 'dhcp-reservation-add':case 'dhcp-reservation-edit':case 'dhcp-reservation-remove':return text(p.address);
  case 'dhcp-lease-delete':{const list=Array.isArray(p.addresses)?p.addresses.map(String):[];return list.slice(0,3).join(', ')+(list.length>3?` (+${list.length-3})`:'');}
  case 'dhcp-option-set':case 'dhcp-option-remove':return [String(p.code),scope,text(p.policy)].filter(Boolean).join(' / ');
  case 'dhcp-policy-create':case 'dhcp-policy-edit':case 'dhcp-policy-delete':return [text(p.name),scope].filter(Boolean).join(' / ');
  default:return text(p.name);
 }
}

// ---- The manage gate of the view ------------------------------------------------------------------------
type ManagedDevice={permissions?:string[];lastSeen:number|null;management?:number;maintenance?:{state:string}|null;snapshot:Pick<ServerSnapshot,'plugins'|'mode'|'agentCapabilities'>|null};
/**
 * The first reason why the viewer cannot change this DHCP server now,
 * as a catalog key, or null: demo, the right Manage DHCP, offline, a plugin
 * without the operation, an agent without plugin-ad-identity (the key takes
 * {device}), ReadOnly mode, a stopped service, no data. The server
 * stays the authority; every change control shows the reason. Without `data`
 * (undefined, a failover partner in the client) the last two steps are skipped.
 */
export function dhcpManageBlocked(server:ManagedDevice,viewer:{permissions?:string[]},demo:boolean,now:number,data:{snapshot:DhcpSnapshot|null}|null|undefined,operation:DhcpChangeOperation='dhcp-scope-create'):MessageKey|null{
 if(demo)return 'kit.unavailable.demo';
 // eslint-disable-next-line no-restricted-syntax -- a display gate of the client like permitted() in ui/base/api.tsx; POST /api/dhcp checks dhcp.manage itself.
 if(!viewer.permissions?.includes('*')&&!server.permissions?.includes('dhcp.manage'))return 'dhcp.blocked.manageRight';
 if(connectionKind(server,now)!=='online')return 'extensions.blocked.offline';
 if(!pluginReady(server.snapshot,'dhcp',operation))return 'dhcp.blocked.pluginOld';
 // Agent 4.19.0 runs a change with the technician's AD account (docs/plugin-ad-sign-in.md); the text names the device ({device}).
 if(!adIdentityReady(server.snapshot))return 'pluginAd.blocked.agent';
 if(!server.management||server.snapshot?.mode!=='Management')return 'dhcp.blocked.readOnly';
 if(data===undefined)return null;
 if(data?.snapshot?.service==='stopped')return 'dhcp.blocked.stopped';
 if(!data?.snapshot)return 'dhcp.blocked.noData';
 return null;
}
