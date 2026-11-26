'use client';
// The change drawers of the DNS view (docs/dns-server.md, "Change the DNS
// server"): one Drawer with a form of Fields per create and edit, the field
// errors of validateDnsChange (lib/dns-changes.ts) after the first submit and
// the server's changeInvalid errors on the same fields, and the confirmation of
// every change (title, Facts lines, the AD replication sentence, the verb, the
// tone). The view (device-dns.tsx) owns which drawer is open and sends the
// confirmed change to POST /api/dns through the console. An action keeps its
// name from the button to the submit, the confirmation verb and the toast.
import {useState,type FormEvent,type ReactNode} from 'react';
import {Check} from 'lucide-react';
import {Btn,Drawer,Segmented} from '@/ui/kit/kit';
import {Field,Select} from '@/ui/kit/field';
import type {Translate} from '@/ui/base/locale';
import type {Confirmation} from '@/ui/base/confirmation';
import {dnsChangeDescription,dnsChangeObject,dnsErrorKeys,dnsReverseZoneName,normalizeDnsName,validateDnsChange,DNS_RECORD_OPERATIONS,
 type DnsChangeOperation,type DnsFieldError} from '@/lib/dns-changes';
import {DNS_RECORD_TYPES,type DnsRecord,type DnsRecordType,type DnsSnapshot,type DnsZone,type DnsZoneRecords} from '@/lib/dns';
import type {MessageKey} from '@/lib/i18n/translate';

/** Which drawer is open. */
export type DnsForm=
 |{kind:'zone'}
 |{kind:'zoneSettings';zone:string}
 |{kind:'record';zone:string;record?:DnsRecord}
 |{kind:'conditional';name?:string}
 |{kind:'forwarders'}
 |{kind:'scavenging'};
/** One change ready for the confirmation; label is the verb of the flow (menu, submit, confirmation, toast). */
export type DnsChange={operation:DnsChangeOperation;parameters:Record<string,unknown>;label:MessageKey};

/** The catalog key of each operation's action label. */
export const dnsOperationLabels:Record<DnsChangeOperation,MessageKey>={
 'dns-zone-create':'dns.op.zoneCreate','dns-zone-edit':'dns.op.zoneEdit','dns-zone-delete':'dns.op.zoneDelete','dns-zone-transfer':'dns.op.zoneTransfer',
 'dns-record-add':'dns.op.recordAdd','dns-record-edit':'dns.op.recordSave','dns-record-delete':'dns.op.recordDelete',
 'dns-conditional-create':'dns.op.conditionalCreate','dns-conditional-edit':'dns.op.conditionalSave','dns-conditional-delete':'dns.op.conditionalDelete',
 'dns-forwarders-set':'dns.op.forwardersSave','dns-scavenging-set':'dns.op.scavengingSave','dns-scavenge-now':'dns.op.scavengeNow','dns-cache-clear':'dns.op.cacheClear',
};
/** A change with the action label of its operation. */
export const dnsChange=(operation:DnsChangeOperation,parameters:Record<string,unknown>,label:MessageKey=dnsOperationLabels[operation]):DnsChange=>({operation,parameters,label});
/** The operation a form sends. */
export function dnsFormOperation(form:DnsForm):DnsChangeOperation{
 switch(form.kind){
  case 'zone':return 'dns-zone-create';
  case 'zoneSettings':return 'dns-zone-edit';
  case 'record':return form.record?'dns-record-edit':'dns-record-add';
  case 'conditional':return form.name?'dns-conditional-edit':'dns-conditional-create';
  case 'forwarders':return 'dns-forwarders-set';
  case 'scavenging':return 'dns-scavenging-set';
 }
}
/** The deletes that use the danger tone. */
export const dnsDangerOperations:ReadonlySet<DnsChangeOperation>=new Set(['dns-zone-delete','dns-record-delete','dns-conditional-delete']);

/** The text of one field error. */
export const dnsFieldErrorText=(error:DnsFieldError,t:Translate)=>t(dnsErrorKeys[error.code],error.params);

// ---- Confirmation -------------------------------------------------------------------------------------
export type DnsConfirmContext={device:{id:string;name:string};snapshot:DnsSnapshot;t:Translate;
 /** The AD account the change runs as (docs/plugin-ad-sign-in.md). */
 adAccount?:string|null};
/**
 * The confirmation of a change: the question, the lines Device, Change, Object
 * and AD account, the sentences of dnsChangeDescription (the AD replication or
 * "only this device", then the operation), the verb and the tone. The payload
 * goes to POST /api/dns.
 */
export function dnsConfirmation(change:DnsChange,context:DnsConfirmContext,onSettled:Confirmation['onSettled']):Confirmation{
 const {device,snapshot,t}=context,{operation,parameters:p}=change,label=t(change.label);
 const sentences=dnsChangeDescription(operation,p,snapshot,device.name).map(sentence=>t(sentence.key,sentence.params));
 return {
  title:t('dns.confirm.title',{device:device.name}),description:sentences.join(' '),confirmLabel:label,tone:dnsDangerOperations.has(operation)?'danger':'default',
  lines:[{label:t('dns.confirm.device'),value:device.name},{label:t('dns.confirm.change'),value:label},{label:t('dns.confirm.object'),value:dnsChangeObject(operation,p),mono:true},
   ...(context.adAccount?[{label:t('pluginAd.confirm.account'),value:context.adAccount,mono:true}]:[])],
  payload:{action:'change',serverId:device.id,operation,parameters:p,confirm:true},endpoint:'/api/dns',plugin:'dns',success:t('dns.toast.queued',{action:label}),onSettled,
 };
}

// ---- The shell of every form -------------------------------------------------------------------------------
type ShellProps={id:string;title:string;description?:ReactNode;submitLabel:string;change:DnsChange|null;unchanged?:boolean;snapshot:DnsSnapshot;records:DnsZoneRecords|null;blocked?:string;busy:boolean;
 serverErrors:readonly DnsFieldError[];onCancel:()=>void;onSubmit:(change:DnsChange)=>void;children:(error:(field:string)=>string|undefined)=>ReactNode;t:Translate};
/** The Drawer, the form, the footer (Cancel and the submit named like the action) and the field errors after the first submit. */
function FormShell({id,title,description,submitLabel,change,unchanged,snapshot,records,blocked,busy,serverErrors,onCancel,onSubmit,children,t}:ShellProps){
 const [touched,setTouched]=useState(false);
 const validation=change&&!unchanged?validateDnsChange(change.operation,change.parameters,snapshot,DNS_RECORD_OPERATIONS.has(change.operation)?records:null):null;
 const errors=validation&&!validation.ok?validation.errors:[];
 const shown=[...(touched?errors:[]),...serverErrors];
 const error=(field:string)=>{const found=shown.find(item=>item.field===field);return found?dnsFieldErrorText(found,t):undefined;};
 const submit=(event:FormEvent)=>{event.preventDefault();setTouched(true);if(blocked||unchanged||busy||!change||errors.length)return;onSubmit(change);};
 const reason=blocked??(unchanged?t('common.noChanges'):undefined);
 return <Drawer open onClose={onCancel} title={title} description={description} footer={<><Btn onClick={onCancel}>{t('common.cancel')}</Btn><Btn variant="primary" icon={Check} type="submit" form={id} loading={busy} blocked={reason}>{submitLabel}</Btn></>}>
  <form id={id} className="sdx-form-grid sdx-dns-form" noValidate onSubmit={submit}>{children(error)}</form>
 </Drawer>;
}
type FormProps={snapshot:DnsSnapshot;records:DnsZoneRecords|null;blocked?:string;busy:boolean;serverErrors:readonly DnsFieldError[];onCancel:()=>void;onSubmit:(change:DnsChange)=>void;t:Translate};
/** The non-empty lines of a text area, trimmed. */
export const dnsLines=(value:string)=>value.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
const whole=(value:string)=>/^\d{1,10}$/.test(value.trim())?Number(value.trim()):Number.NaN;
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const scopes=['forest','domain','legacy'] as const;
type Scope=typeof scopes[number];
const scopeKeys={forest:'dns.field.scopeForest',domain:'dns.field.scopeDomain',legacy:'dns.field.scopeLegacy'} as const;
const dynamicKeys={none:'dns.dynamic.none',nonsecureAndSecure:'dns.dynamic.nonsecureAndSecure',secure:'dns.dynamic.secure'} as const;
type Dynamic=keyof typeof dynamicKeys;
/** The reason the AD switch is blocked: a server that is no domain controller, or a secondary zone. */
export function dnsAdBlocked(snapshot:DnsSnapshot,kind:string,t:Translate):string|undefined{
 if(!snapshot.server.isDomainController)return t('dns.blocked.notDc');
 if(kind==='secondary')return t('dns.blocked.secondaryAd');
 return undefined;
}
/** The switch "Store … in Active Directory" with its replication scope; blocked with its reason, it stays visible and reads aria-disabled. */
function AdStorage({label,on,onChange,scope,onScope,blocked,error,t}:{label:string;on:boolean;onChange:(on:boolean)=>void;scope:Scope;onScope:(scope:Scope)=>void;blocked?:string;error:(field:string)=>string|undefined;t:Translate}){
 return <>
  <Field inline label={label} hint={blocked} error={error('storage')}><input type="checkbox" role="switch" checked={on&&!blocked} aria-disabled={blocked?true:undefined} onChange={event=>{if(!blocked)onChange(event.target.checked);}}/></Field>
  {on&&!blocked&&<Field label={t('dns.field.scope')} error={error('replicationScope')}><Select value={scope} onChange={event=>onScope(event.target.value as Scope)}>{scopes.map(item=><option key={item} value={item}>{t(scopeKeys[item])}</option>)}</Select></Field>}
 </>;
}
function DynamicField({value,onChange,error,t}:{value:Dynamic;onChange:(value:Dynamic)=>void;error?:string;t:Translate}){
 return <Field label={t('dns.field.dynamic')} error={error}><Select value={value} onChange={event=>onChange(event.target.value as Dynamic)}>{(Object.keys(dynamicKeys) as Dynamic[]).map(item=><option key={item} value={item}>{t(dynamicKeys[item])}</option>)}</Select></Field>;
}
function AddressList({label,hint,value,onChange,error,autoFocus=false}:{label:string;hint:string;value:string;onChange:(value:string)=>void;error?:string;autoFocus?:boolean}){
 return <Field label={label} hint={hint} error={error}><textarea className="mono" rows={3} autoFocus={autoFocus} spellCheck={false} value={value} onChange={event=>onChange(event.target.value)}/></Field>;
}

// ---- New zone -------------------------------------------------------------------------------------------------
export function ZoneForm(props:FormProps){
 const {snapshot,t}=props,dc=snapshot.server.isDomainController;
 const [kind,setKind]=useState<'primary'|'secondary'|'stub'>('primary'),[lookup,setLookup]=useState<'forward'|'reverse'>('forward');
 const [name,setName]=useState(''),[networkId,setNetworkId]=useState(''),[ad,setAd]=useState(dc),[scope,setScope]=useState<Scope>('domain');
 const [fileName,setFileName]=useState<string|null>(null),[masters,setMasters]=useState(''),[dynamic,setDynamic]=useState<Dynamic>(dc?'secure':'none');
 const adBlocked=dnsAdBlocked(snapshot,kind,t),stored=ad&&!adBlocked;
 const zoneName=lookup==='reverse'?dnsReverseZoneName(networkId):name.trim()?normalizeDnsName(name):null;
 const shownFile=fileName??(zoneName?`${zoneName}.dns`:'');
 const change=dnsChange('dns-zone-create',{kind,lookup,...(lookup==='forward'?{name:name.trim()}:{networkId:networkId.trim()}),storage:stored?'ad':'file',replicationScope:stored?scope:null,
  fileName:stored?null:shownFile.trim()||null,masters:kind==='primary'?[]:dnsLines(masters),dynamicUpdate:kind==='primary'?(!stored&&dynamic==='secure'?'none':dynamic):'none'});
 return <FormShell {...props} id="sdx-dns-zone-form" title={t('dns.op.newZone')} submitLabel={t('dns.op.zoneCreate')} change={change}>
  {error=><>
   <Field label={t('dns.field.kind')}><Segmented<'primary'|'secondary'|'stub'> label={t('dns.field.kind')} size="sm" value={kind} onChange={setKind} items={[{id:'primary',label:t('dns.kind.primary')},{id:'secondary',label:t('dns.kind.secondary')},{id:'stub',label:t('dns.kind.stub')}]}/></Field>
   <Field label={t('dns.field.lookup')}><Segmented<'forward'|'reverse'> label={t('dns.field.lookup')} size="sm" value={lookup} onChange={setLookup} items={[{id:'forward',label:t('dns.field.forwardLookup')},{id:'reverse',label:t('dns.field.reverseLookup')}]}/></Field>
   {lookup==='forward'
    ?<Field label={t('dns.field.zoneName')} error={error('name')}><input autoFocus className="mono" value={name} placeholder="corp.example" spellCheck={false} autoCapitalize="off" onChange={event=>setName(event.target.value)}/></Field>
    :<Field label={t('dns.field.networkId')} error={error('networkId')} hint={<span aria-live="polite">{zoneName?t('dns.field.reverseName',{zone:zoneName}):t('dns.field.networkIdHint')}</span>}>
     <input autoFocus className="mono" value={networkId} placeholder="10.20.30" spellCheck={false} onChange={event=>setNetworkId(event.target.value)}/></Field>}
   <AdStorage label={t('dns.field.storeAd')} on={ad} onChange={on=>{setAd(on);if(!on&&dynamic==='secure')setDynamic('none');}} scope={scope} onScope={setScope} blocked={adBlocked} error={error} t={t}/>
   {!stored&&<Field label={t('dns.field.file')} error={error('fileName')}><input className="mono" value={shownFile} spellCheck={false} onChange={event=>setFileName(event.target.value)}/></Field>}
   {kind!=='primary'&&<AddressList label={t('dns.field.masters')} hint={t('dns.field.mastersHint')} value={masters} onChange={setMasters} error={error('masters')}/>}
   {kind==='primary'&&<DynamicField value={dynamic} onChange={setDynamic} error={error('dynamicUpdate')} t={t}/>}
  </>}
 </FormShell>;
}

// ---- Zone settings ---------------------------------------------------------------------------------------------
const transferModes=['none','any','nameServers','list'] as const;
const transferKeys={none:'dns.field.transfersOff',any:'dns.field.transfersAny',nameServers:'dns.field.transfersNs',list:'dns.field.transfersList'} as const;
export function ZoneSettingsForm({zone,...props}:FormProps&{zone:DnsZone}){
 const {snapshot,t}=props,primary=zone.kind==='primary',stub=zone.kind==='stub';
 const aging=zone.aging??{enabled:false,noRefreshHours:168,refreshHours:168};
 const [dynamic,setDynamic]=useState<Dynamic>(zone.dynamicUpdate),[transfers,setTransfers]=useState<typeof transferModes[number]>(zone.transfers.mode),[transferList,setTransferList]=useState(zone.transfers.servers.join('\n'));
 const [notify,setNotify]=useState(zone.notify.mode!=='off'),[notifyMode,setNotifyMode]=useState<'nameServers'|'list'>(zone.notify.mode==='list'?'list':'nameServers'),[notifyList,setNotifyList]=useState(zone.notify.servers.join('\n'));
 const [agingOn,setAgingOn]=useState(aging.enabled),[noRefresh,setNoRefresh]=useState(String(aging.noRefreshHours)),[refresh,setRefresh]=useState(String(aging.refreshHours));
 const [masters,setMasters]=useState(zone.masters.join('\n')),[ad,setAd]=useState(zone.storage==='ad'),[scope,setScope]=useState<Scope>(zone.replicationScope==='forest'||zone.replicationScope==='legacy'?zone.replicationScope:'domain');
 const showAd=(primary||stub)&&snapshot.server.isDomainController;
 const p:Record<string,unknown>={zone:zone.name};
 if(primary&&dynamic!==zone.dynamicUpdate)p.dynamicUpdate=dynamic;
 if(!stub){
  const nextTransfers={mode:transfers,servers:transfers==='list'?dnsLines(transferList):[]};
  if(!same(nextTransfers,zone.transfers))p.transfers=nextTransfers;
  const nextNotify={mode:notify?notifyMode:'off',servers:notify&&notifyMode==='list'?dnsLines(notifyList):[]};
  if(!same(nextNotify,zone.notify))p.notify=nextNotify;
 }
 if(primary){const next={enabled:agingOn,noRefreshHours:whole(noRefresh),refreshHours:whole(refresh)};if(!same(next,aging))p.aging=next;}
 if(!primary&&!same(dnsLines(masters),zone.masters))p.masters=dnsLines(masters);
 if(showAd){
  const storage=ad?'ad':'file';
  if(storage!==zone.storage)p.storage=storage;
  if(ad&&(zone.storage!=='ad'||scope!==zone.replicationScope&&zone.replicationScope!=='custom'))p.replicationScope=scope;
 }
 const change=dnsChange('dns-zone-edit',p);
 return <FormShell {...props} id="sdx-dns-zone-settings-form" title={t('dns.op.zoneSettings')} description={<span className="mono">{zone.name}</span>} submitLabel={t('dns.op.zoneEdit')} change={change} unchanged={Object.keys(p).length===1}>
  {error=><>
   {primary&&<Field label={t('dns.field.dynamic')} error={error('dynamicUpdate')}><Select autoFocus value={dynamic} onChange={event=>setDynamic(event.target.value as Dynamic)}>{(Object.keys(dynamicKeys) as Dynamic[]).map(item=><option key={item} value={item}>{t(dynamicKeys[item])}</option>)}</Select></Field>}
   {!primary&&<AddressList autoFocus label={t('dns.field.masters')} hint={t('dns.field.mastersHint')} value={masters} onChange={setMasters} error={error('masters')}/>}
   {!stub&&<>
    <Field label={t('dns.field.transfers')} error={error('transfers')}><Select value={transfers} onChange={event=>setTransfers(event.target.value as typeof transfers)}>{transferModes.map(mode=><option key={mode} value={mode}>{t(transferKeys[mode])}</option>)}</Select></Field>
    {transfers==='list'&&<AddressList label={t('dns.field.transferServers')} hint={t('dns.field.mastersHint')} value={transferList} onChange={setTransferList} error={error('transfersServers')}/>}
    <Field inline label={t('dns.field.notify')} error={error('notify')}><input type="checkbox" role="switch" checked={notify} onChange={event=>setNotify(event.target.checked)}/></Field>
    {notify&&<Field label={t('dns.field.notifyTarget')}><Select value={notifyMode} onChange={event=>setNotifyMode(event.target.value as 'nameServers'|'list')}><option value="nameServers">{t('dns.field.notifyNs')}</option><option value="list">{t('dns.field.notifyList')}</option></Select></Field>}
    {notify&&notifyMode==='list'&&<AddressList label={t('dns.field.transferServers')} hint={t('dns.field.mastersHint')} value={notifyList} onChange={setNotifyList} error={error('notifyServers')}/>}
   </>}
   {primary&&<>
    <Field inline label={t('dns.field.aging')} error={error('aging')}><input type="checkbox" role="switch" checked={agingOn} onChange={event=>setAgingOn(event.target.checked)}/></Field>
    {agingOn&&<div className="sdx-dns-pair">
     <Field label={t('dns.field.noRefresh')} error={error('noRefreshHours')}><input inputMode="numeric" value={noRefresh} onChange={event=>setNoRefresh(event.target.value)}/></Field>
     <Field label={t('dns.field.refresh')} error={error('refreshHours')}><input inputMode="numeric" value={refresh} onChange={event=>setRefresh(event.target.value)}/></Field>
    </div>}
   </>}
   {showAd&&<AdStorage label={t('dns.field.storeAd')} on={ad} onChange={setAd} scope={scope} onScope={setScope} error={error} t={t}/>}
  </>}
 </FormShell>;
}

// ---- Record ----------------------------------------------------------------------------------------------------
type Ttl={amount:string;unit:'seconds'|'minutes'|'hours'|'days';zoneDefault:boolean};
const ttlUnits={seconds:1,minutes:60,hours:3600,days:86400} as const;
/** A TTL as the number and unit of the form. */
export function dnsTtlParts(seconds:number|null):Ttl{
 if(seconds===null)return {amount:'1',unit:'hours',zoneDefault:true};
 for(const unit of ['days','hours','minutes'] as const)if(seconds>=ttlUnits[unit]&&seconds%ttlUnits[unit]===0)return {amount:String(seconds/ttlUnits[unit]),unit,zoneDefault:false};
 return {amount:String(seconds),unit:'seconds',zoneDefault:false};
}
/** The seconds of the form; null for the zone default, NaN when the number is no whole number. */
export const dnsTtlSeconds=(ttl:Ttl)=>ttl.zoneDefault?null:whole(ttl.amount)*ttlUnits[ttl.unit];
type RecordValues={address:string;target:string;host:string;nameServer:string;exchange:string;preference:string;text:string;priority:string;weight:string;port:string};
const emptyValues:RecordValues={address:'',target:'',host:'',nameServer:'',exchange:'',preference:'10',text:'',priority:'0',weight:'100',port:''};
/** The form values of a record's data. */
function valuesOf(record:DnsRecord|undefined):RecordValues{
 if(!record)return emptyValues;
 const d=record.data as Record<string,unknown>,text=(key:string)=>d[key]===undefined?'':String(d[key]);
 return {...emptyValues,address:text('address'),target:text('target'),host:text('host'),nameServer:text('nameServer'),exchange:text('exchange'),preference:text('preference')||'10',
  text:Array.isArray(d.strings)?(d.strings as string[]).join('\n'):'',priority:text('priority')||'0',weight:text('weight')||'100',port:text('port')};
}
/** The record data of the form for a type. */
export function dnsRecordDataOf(type:DnsRecordType,values:RecordValues):Record<string,unknown>{
 switch(type){
  case 'A':case 'AAAA':return {address:values.address.trim()};
  case 'CNAME':return {target:values.target.trim()};
  case 'PTR':return {host:values.host.trim()};
  case 'NS':return {nameServer:values.nameServer.trim()};
  case 'MX':return {preference:whole(values.preference),exchange:values.exchange.trim()};
  case 'TXT':return {strings:values.text.split(/\r?\n/).filter(line=>line.length>0)};
  case 'SRV':return {priority:whole(values.priority),weight:whole(values.weight),port:whole(values.port),target:values.target.trim()};
 }
}
export function RecordForm({zone,record,...props}:FormProps&{zone:DnsZone;record?:DnsRecord}){
 const {t}=props,editing=!!record;
 const [type,setType]=useState<DnsRecordType>(record&&(DNS_RECORD_TYPES as readonly string[]).includes(record.type)?record.type as DnsRecordType:zone.lookup==='reverse'?'PTR':'A');
 const [name,setName]=useState(record&&record.name!=='@'?record.name:''),[values,setValues]=useState<RecordValues>(valuesOf(record));
 const [ttl,setTtl]=useState<Ttl>(dnsTtlParts(record?record.ttlSeconds:null)),[age,setAge]=useState(record?record.timestamp!==null:false);
 const set=(key:keyof RecordValues)=>(event:{target:{value:string}})=>setValues(previous=>({...previous,[key]:event.target.value}));
 const data=dnsRecordDataOf(type,values),seconds=dnsTtlSeconds(ttl);
 let change:DnsChange,unchanged=false;
 if(record){
  const p:Record<string,unknown>={zone:zone.name,record:{name:record.name,type:record.type,data:record.data}};
  if(!same(data,dnsRecordDataOf(type,valuesOf(record))))p.data=data;
  if(seconds!==record.ttlSeconds&&!(ttl.zoneDefault))p.ttlSeconds=seconds;
  if(age!==(record.timestamp!==null))p.ageRecord=age;
  change=dnsChange('dns-record-edit',p);unchanged=Object.keys(p).length===2;
 }else change=dnsChange('dns-record-add',{zone:zone.name,name:name.trim()||'@',type,ttlSeconds:seconds,ageRecord:age,data});
 const field=(error:(field:string)=>string|undefined,key:keyof RecordValues,label:MessageKey,placeholder?:string)=>
  <Field label={t(label)} error={error(key)}><input className="mono" spellCheck={false} placeholder={placeholder} inputMode={['preference','priority','weight','port'].includes(key)?'numeric':undefined} value={values[key]} onChange={set(key)}/></Field>;
 return <FormShell {...props} id="sdx-dns-record-form" title={t(editing?'dns.op.recordEdit':'dns.op.recordAdd')} description={<span className="mono">{zone.name}</span>} submitLabel={t(editing?'dns.op.recordSave':'dns.op.recordAdd')} change={change} unchanged={unchanged}>
  {error=><>
   <Field label={t('dns.field.recordType')} error={error('type')} hint={editing?t('dns.field.typeFixed'):undefined}>
    <Select autoFocus value={type} blocked={editing?t('dns.field.typeFixed'):undefined} onChange={event=>{if(!editing)setType(event.target.value as DnsRecordType);}}>{DNS_RECORD_TYPES.map(item=><option key={item} value={item}>{item}</option>)}</Select>
   </Field>
   <Field label={t('dns.field.recordName')} hint={t('dns.field.recordNameHint',{zone:zone.name})} error={error('name')}><input className="mono" value={name} readOnly={editing} aria-disabled={editing||undefined} spellCheck={false} autoCapitalize="off" placeholder="@" onChange={event=>setName(event.target.value)}/></Field>
   {type==='A'&&field(error,'address','dns.field.ipv4','10.0.0.10')}
   {type==='AAAA'&&field(error,'address','dns.field.ipv6','2001:db8::10')}
   {type==='CNAME'&&field(error,'target','dns.field.target','host.corp.example')}
   {type==='PTR'&&field(error,'host','dns.field.host','host.corp.example')}
   {type==='NS'&&field(error,'nameServer','dns.field.nameServer','ns1.corp.example')}
   {type==='MX'&&<div className="sdx-dns-pair">{field(error,'exchange','dns.field.exchange','mail.corp.example')}{field(error,'preference','dns.field.preference')}</div>}
   {type==='TXT'&&<Field label={t('dns.field.text')} hint={t('dns.field.textHint')} error={error('strings')}><textarea className="mono" rows={3} spellCheck={false} value={values.text} onChange={set('text')}/></Field>}
   {type==='SRV'&&<>
    <div className="sdx-dns-triple">{field(error,'priority','dns.field.priority')}{field(error,'weight','dns.field.weight')}{field(error,'port','dns.field.port')}</div>
    {field(error,'target','dns.field.target','host.corp.example')}
   </>}
   <div className="sdx-dns-ttl">
    <Field label={t('dns.field.ttl')} error={error('ttlSeconds')}><input inputMode="numeric" value={ttl.zoneDefault?'':ttl.amount} readOnly={ttl.zoneDefault} aria-disabled={ttl.zoneDefault||undefined} onChange={event=>setTtl({...ttl,amount:event.target.value})}/></Field>
    <Field label={t('dns.field.ttlUnit')}><Select value={ttl.unit} blocked={ttl.zoneDefault?t('dns.field.ttlUnitBlocked'):undefined} onChange={event=>{if(!ttl.zoneDefault)setTtl({...ttl,unit:event.target.value as Ttl['unit']});}}>
     {(Object.keys(ttlUnits) as Ttl['unit'][]).map(unit=><option key={unit} value={unit}>{t(`dns.unit.${unit}`)}</option>)}
    </Select></Field>
    <Field inline label={t('dns.field.ttlDefault')}><input type="checkbox" role="switch" checked={ttl.zoneDefault} onChange={event=>setTtl({...ttl,zoneDefault:event.target.checked})}/></Field>
   </div>
   <Field inline label={t('dns.field.ageRecord')} hint={t('dns.field.ageRecordHint')} error={error('ageRecord')}><input type="checkbox" role="switch" checked={age} onChange={event=>setAge(event.target.checked)}/></Field>
  </>}
 </FormShell>;
}

// ---- Conditional forwarder --------------------------------------------------------------------------------------
export function ConditionalForm({current,...props}:FormProps&{current?:DnsZone}){
 const {snapshot,t}=props,editing=!!current,dc=snapshot.server.isDomainController;
 const [name,setName]=useState(current?.name??''),[masters,setMasters]=useState(current?.masters.join('\n')??''),[ad,setAd]=useState(current?current.storage==='ad':dc);
 const [scope,setScope]=useState<Scope>(current?.replicationScope==='domain'||current?.replicationScope==='legacy'?current.replicationScope:'forest'),[timeout,setTimeoutValue]=useState(String(current?.forwarderTimeoutSeconds??5));
 const adBlocked=dc?undefined:t('dns.blocked.notDc'),stored=ad&&!adBlocked;
 let change:DnsChange,unchanged=false;
 if(current){
  const p:Record<string,unknown>={name:current.name};
  if(!same(dnsLines(masters),current.masters))p.masters=dnsLines(masters);
  if(dc&&(stored?'ad':'file')!==current.storage)p.storage=stored?'ad':'file';
  if(stored&&(current.storage!=='ad'||scope!==current.replicationScope&&current.replicationScope!=='custom'))p.replicationScope=scope;
  if(whole(timeout)!==current.forwarderTimeoutSeconds)p.timeoutSeconds=whole(timeout);
  change=dnsChange('dns-conditional-edit',p);unchanged=Object.keys(p).length===1;
 }else change=dnsChange('dns-conditional-create',{name:name.trim(),masters:dnsLines(masters),storage:stored?'ad':'file',replicationScope:stored?scope:null,timeoutSeconds:whole(timeout)});
 return <FormShell {...props} id="sdx-dns-conditional-form" title={t(editing?'dns.op.conditionalEdit':'dns.op.conditionalNew')} submitLabel={t(editing?'dns.op.conditionalSave':'dns.op.conditionalCreate')} change={change} unchanged={unchanged}>
  {error=><>
   <Field label={t('dns.field.domain')} error={error('name')} hint={editing?t('dns.field.domainFixed'):undefined}><input autoFocus className="mono" value={name} readOnly={editing} aria-disabled={editing||undefined} placeholder="branch.example" spellCheck={false} autoCapitalize="off" onChange={event=>setName(event.target.value)}/></Field>
   <AddressList label={t('dns.field.masters')} hint={t('dns.field.mastersHint')} value={masters} onChange={setMasters} error={error('masters')}/>
   <AdStorage label={t('dns.field.storeAdForwarder')} on={ad} onChange={setAd} scope={scope} onScope={setScope} blocked={adBlocked} error={error} t={t}/>
   <Field label={t('dns.field.timeoutSeconds')} error={error('timeoutSeconds')}><input inputMode="numeric" value={timeout} onChange={event=>setTimeoutValue(event.target.value)}/></Field>
  </>}
 </FormShell>;
}

// ---- Forwarders -------------------------------------------------------------------------------------------------
export function ForwardersForm(props:FormProps){
 const {snapshot,t}=props,current=snapshot.forwarders;
 const [servers,setServers]=useState(current.servers.join('\n')),[timeout,setTimeoutValue]=useState(String(current.timeoutSeconds||3)),[rootHints,setRootHints]=useState(current.useRootHints);
 const p={servers:dnsLines(servers),timeoutSeconds:whole(timeout),useRootHints:rootHints};
 return <FormShell {...props} id="sdx-dns-forwarders-form" title={t('dns.op.forwardersEdit')} submitLabel={t('dns.op.forwardersSave')} change={dnsChange('dns-forwarders-set',p)} unchanged={same(p,{servers:current.servers,timeoutSeconds:current.timeoutSeconds,useRootHints:current.useRootHints})}>
  {error=><>
   <AddressList autoFocus label={t('dns.field.forwarders')} hint={t('dns.field.forwardersHint')} value={servers} onChange={setServers} error={error('servers')}/>
   <Field label={t('dns.field.timeoutSeconds')} error={error('timeoutSeconds')}><input inputMode="numeric" value={timeout} onChange={event=>setTimeoutValue(event.target.value)}/></Field>
   <Field inline label={t('dns.field.rootHints')}><input type="checkbox" role="switch" checked={rootHints} onChange={event=>setRootHints(event.target.checked)}/></Field>
  </>}
 </FormShell>;
}

// ---- Scavenging -------------------------------------------------------------------------------------------------
export function ScavengingForm(props:FormProps){
 const {snapshot,t}=props,current=snapshot.scavenging;
 const [enabled,setEnabled]=useState(current.enabled),[days,setDays]=useState(String(Math.max(1,Math.round((current.intervalHours||168)/24))));
 const [agingOn,setAgingOn]=useState(current.defaultAging.enabled),[noRefresh,setNoRefresh]=useState(String(current.defaultAging.noRefreshHours||168)),[refresh,setRefresh]=useState(String(current.defaultAging.refreshHours||168));
 const [applyAd,setApplyAd]=useState(false);
 const p={enabled,intervalHours:whole(days)*24,defaultAging:{enabled:agingOn,noRefreshHours:whole(noRefresh),refreshHours:whole(refresh)},applyToAdZones:applyAd};
 const unchanged=!applyAd&&same({enabled:p.enabled,intervalHours:p.intervalHours,defaultAging:p.defaultAging},{enabled:current.enabled,intervalHours:current.intervalHours,defaultAging:current.defaultAging});
 return <FormShell {...props} id="sdx-dns-scavenging-form" title={t('dns.op.scavengingEdit')} submitLabel={t('dns.op.scavengingSave')} change={dnsChange('dns-scavenging-set',p)} unchanged={unchanged}>
  {error=><>
   <Field inline label={t('dns.field.autoScavenge')}><input autoFocus type="checkbox" role="switch" checked={enabled} onChange={event=>setEnabled(event.target.checked)}/></Field>
   <Field label={t('dns.field.interval')} error={error('intervalHours')?t('dns.error.number',{min:1,max:365}):undefined}><input inputMode="numeric" value={days} onChange={event=>setDays(event.target.value)}/></Field>
   <Field inline label={t('dns.field.defaultAging')}><input type="checkbox" role="switch" checked={agingOn} onChange={event=>setAgingOn(event.target.checked)}/></Field>
   <div className="sdx-dns-pair">
    <Field label={t('dns.field.noRefresh')} error={error('noRefreshHours')}><input inputMode="numeric" value={noRefresh} onChange={event=>setNoRefresh(event.target.value)}/></Field>
    <Field label={t('dns.field.refresh')} error={error('refreshHours')}><input inputMode="numeric" value={refresh} onChange={event=>setRefresh(event.target.value)}/></Field>
   </div>
   <Field inline label={t('dns.field.applyAd')}><input type="checkbox" role="switch" checked={applyAd} onChange={event=>setApplyAd(event.target.checked)}/></Field>
  </>}
 </FormShell>;
}

/** The open drawer of the view: one form at a time. */
export function DnsFormDrawer(props:FormProps&{form:DnsForm}){
 const {form,...rest}=props,zones=rest.snapshot.zones;
 switch(form.kind){
  case 'zone':return <ZoneForm {...rest}/>;
  case 'zoneSettings':{const zone=zones.find(item=>item.name===form.zone);return zone?<ZoneSettingsForm {...rest} zone={zone}/>:null;}
  case 'record':{const zone=zones.find(item=>item.name===form.zone);return zone?<RecordForm {...rest} zone={zone} record={form.record}/>:null;}
  case 'conditional':return <ConditionalForm {...rest} current={form.name?zones.find(item=>item.name===form.name&&item.kind==='forwarder'):undefined}/>;
  case 'forwarders':return <ForwardersForm {...rest}/>;
  case 'scavenging':return <ScavengingForm {...rest}/>;
 }
}
