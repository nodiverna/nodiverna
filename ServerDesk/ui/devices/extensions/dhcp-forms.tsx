'use client';
// The change drawers of the DHCP view (docs/dhcp-server.md, "Change the DHCP
// server"): one Drawer with a form of Fields per create and edit, the field
// errors of validateDhcpChange (lib/dhcp-changes.ts) after the first submit and
// the server's changeInvalid errors on the same fields, and the confirmation of
// every change (title, Facts lines, one sentence on what else changes, the
// verb, the tone). The view (device-dhcp.tsx) owns which drawer is open and
// sends the confirmed change to POST /api/dhcp through the console.
import {useState,type FormEvent,type ReactNode} from 'react';
import {Check,Plus,Trash2} from 'lucide-react';
import {Btn,Drawer,IconBtn,Segmented,cx} from '@/ui/kit/kit';
import {Field,Select} from '@/ui/kit/field';
import type {Translate} from '@/ui/base/locale';
import type {Confirmation} from '@/ui/base/confirmation';
import {DHCP_LEASE_MAX,DHCP_LEASE_MIN,dhcpChangeObject,dhcpErrorKeys,dhcpMirror,dhcpPartnerDevice,dhcpSecretValid,ipv4Number,validateDhcpChange,
 type DhcpChangeOperation,type DhcpFieldError,type DhcpPartnerCandidate} from '@/lib/dhcp-changes';
import {dhcpOptionTypes,type DhcpIpv4Scope,type DhcpLease,type DhcpOptionType,type DhcpPolicy,type DhcpSnapshot} from '@/lib/dhcp';
import type {MessageKey} from '@/lib/i18n/translate';
import {EMPTY_VALUE} from '@/lib/i18n/format';

/** Which drawer is open. `from` is the scope whose details the form replaced: Cancel returns there. */
export type DhcpForm=
 |{kind:'scope';family:'ipv4'|'ipv6';id?:string;from?:string}
 |{kind:'superscope';name?:string}
 |{kind:'exclusion';family:'ipv4'|'ipv6';scope:string;from?:string}
 |{kind:'reservation';family:'ipv4'|'ipv6';scope?:string;address?:string;lease?:DhcpLease;from?:string}
 |{kind:'option';family:'ipv4'|'ipv6';level:'server'|'scope'|'policy';scope?:string|null;policy?:string;code?:number;vendorClass?:string|null;userClass?:string|null;from?:string}
 |{kind:'policy';scope:string|null;name?:string;from?:string}
 |{kind:'failover';name?:string};
/** One change ready for the confirmation; label is the verb of the flow (menu, submit, confirmation, toast). */
export type DhcpChange={operation:DhcpChangeOperation;parameters:Record<string,unknown>;secret?:string;label:MessageKey};

/** The catalog key of each operation's action label. */
export const dhcpOperationLabels:Record<DhcpChangeOperation,MessageKey>={
 'dhcp-scope-create':'dhcp.op.scopeCreate','dhcp-scope-edit':'dhcp.op.scopeEdit','dhcp-scope-activate':'dhcp.op.scopeActivate','dhcp-scope-deactivate':'dhcp.op.scopeDeactivate','dhcp-scope-delete':'dhcp.op.scopeDelete',
 'dhcp-superscope-create':'dhcp.op.superscopeCreate','dhcp-superscope-edit':'dhcp.op.superscopeEdit','dhcp-superscope-activate':'dhcp.op.superscopeActivate','dhcp-superscope-deactivate':'dhcp.op.superscopeDeactivate','dhcp-superscope-delete':'dhcp.op.superscopeDelete',
 'dhcp-exclusion-add':'dhcp.op.exclusionAdd','dhcp-exclusion-remove':'dhcp.op.exclusionRemove','dhcp-reservation-add':'dhcp.op.reservationAdd','dhcp-reservation-edit':'dhcp.op.reservationEdit','dhcp-reservation-remove':'dhcp.op.reservationRemove',
 'dhcp-lease-delete':'dhcp.op.leaseDelete','dhcp-option-set':'dhcp.op.optionSet','dhcp-option-remove':'dhcp.op.optionRemove','dhcp-policy-create':'dhcp.op.policyCreate','dhcp-policy-edit':'dhcp.op.policyEdit','dhcp-policy-delete':'dhcp.op.policyDelete',
 'dhcp-failover-create':'dhcp.op.failoverCreate','dhcp-failover-edit':'dhcp.op.failoverEdit','dhcp-failover-remove':'dhcp.op.failoverRemove','dhcp-scope-apply':'dhcp.op.scopeReplicate',
};
/** A change with the action label of its operation. */
export const dhcpChange=(operation:DhcpChangeOperation,parameters:Record<string,unknown>,label:MessageKey=dhcpOperationLabels[operation]):DhcpChange=>({operation,parameters,label});
/** The operation a form sends. */
export function dhcpFormOperation(form:DhcpForm):DhcpChangeOperation{
 switch(form.kind){
  case 'scope':return form.id?'dhcp-scope-edit':'dhcp-scope-create';
  case 'superscope':return form.name?'dhcp-superscope-edit':'dhcp-superscope-create';
  case 'exclusion':return 'dhcp-exclusion-add';
  case 'reservation':return form.address?'dhcp-reservation-edit':'dhcp-reservation-add';
  case 'option':return 'dhcp-option-set';
  case 'policy':return form.name?'dhcp-policy-edit':'dhcp-policy-create';
  case 'failover':return form.name?'dhcp-failover-edit':'dhcp-failover-create';
 }
}
/** The deletes and removals that use the danger tone. */
const dangerOperations=new Set<DhcpChangeOperation>(['dhcp-scope-delete','dhcp-superscope-delete','dhcp-policy-delete','dhcp-failover-remove','dhcp-lease-delete','dhcp-exclusion-remove','dhcp-reservation-remove']);

/** The text of one field error. */
export function dhcpFieldErrorText(error:DhcpFieldError,t:Translate):string{
 const params={...(error.params??{})};
 if(error.code==='optionValue'&&typeof params.type==='string'&&(dhcpOptionTypes as readonly string[]).includes(params.type))params.type=t(`dhcp.optionType.${params.type as DhcpOptionType}`);
 return t(dhcpErrorKeys[error.code],params);
}

// ---- Confirmation -------------------------------------------------------------------------------------
export type DhcpConfirmContext={device:{id:string;name:string};snapshot:DhcpSnapshot;collectedAt:number|null;partners:readonly DhcpPartnerCandidate[];time:(at:number)=>string;t:Translate;
 /** The AD accounts the change runs as (docs/plugin-ad-sign-in.md): the device's, and the partner's when the partner is in another directory. */
 adAccounts?:{device?:string|null;partner?:string|null}};
/** The partner of a change by its name in the parameters or the last read (failover operations, a mirrored scope change), and the partner device of the portal when one matches. */
export function dhcpChangePartner(operation:DhcpChangeOperation,p:Record<string,unknown>,snapshot:DhcpSnapshot,partners:readonly DhcpPartnerCandidate[]){
 const relation=typeof p.name==='string'?snapshot.ipv4.failover.find(item=>item.name===p.name):undefined;
 const mirror=dhcpMirror(operation,p,snapshot);
 const name=operation==='dhcp-failover-create'?String(p.partner??''):operation==='dhcp-failover-edit'||operation==='dhcp-failover-remove'?relation?.partner??'':mirror?.partner??'';
 return {relation,mirror,name,device:name?dhcpPartnerDevice(name,partners):null};
}
/** The partner device of a replicate, or null when the partner is no device of the portal. */
export const dhcpReplicatePartner=(relationship:string,snapshot:DhcpSnapshot,partners:readonly DhcpPartnerCandidate[])=>{const relation=snapshot.ipv4.failover.find(item=>item.name===relationship);return relation?dhcpPartnerDevice(relation.partner,partners):null;};
/** The confirmation lines of the AD accounts: "AD account" and, for a partner in another directory, "AD account on <partner>". */
const adLines=(context:DhcpConfirmContext,partner:string)=>[
 ...(context.adAccounts?.device?[{label:context.t('pluginAd.confirm.account'),value:context.adAccounts.device,mono:true}]:[]),
 ...(context.adAccounts?.partner&&partner?[{label:context.t('pluginAd.confirm.partnerAccount',{device:partner}),value:context.adAccounts.partner,mono:true}]:[]),
];
/**
 * The confirmation of a change: the question, the lines Device,
 * Change, Object and Partner, one or two sentences on what else changes, the
 * verb and the tone. The payload goes to POST /api/dhcp.
 */
export function dhcpConfirmation(change:DhcpChange,context:DhcpConfirmContext,onSettled:Confirmation['onSettled']):Confirmation{
 const {device,snapshot,partners,t}=context,{operation,parameters:p}=change,label=t(change.label);
 const {mirror,name:partnerName,device:partner}=dhcpChangePartner(operation,p,snapshot,partners);
 const server=snapshot.server.name||device.name,partnerLabel=partner?.name??partnerName;
 const sentences:string[]=[];
 if(operation==='dhcp-scope-delete')sentences.push(t('dhcp.confirm.scopeDelete'));
 if(operation==='dhcp-scope-deactivate')sentences.push(t('dhcp.confirm.deactivate'));
 if(operation==='dhcp-superscope-delete')sentences.push(t('dhcp.confirm.superscopeDelete'));
 if(operation==='dhcp-lease-delete')sentences.push(t('dhcp.confirm.leaseDelete',{count:(p.addresses as unknown[]).length}));
 if(mirror)sentences.push(partner?t('dhcp.confirm.mirrored',{scope:mirror.scopeId,relationship:mirror.relationship,partner:partner.name}):t('dhcp.confirm.localOnly',{scope:mirror.scopeId,relationship:mirror.relationship,partner:mirror.partner}));
 if(operation==='dhcp-failover-create')sentences.push(t('dhcp.confirm.failoverCreate',{server,partner:partnerLabel,count:(p.scopeIds as unknown[]).length}));
 if(operation==='dhcp-failover-edit')sentences.push(t((p.removeScopeIds as unknown[]|undefined)?.length?'dhcp.confirm.failoverEditRemove':'dhcp.confirm.failoverEdit',{server,partner:partnerLabel}));
 if(operation==='dhcp-failover-remove')sentences.push(partner?t('dhcp.confirm.failoverRemove',{server,partner:partner.name}):t('dhcp.confirm.failoverRemoveLocal',{partner:partnerName}));
 if(!sentences.length)sentences.push(t('dhcp.confirm.plain',{device:device.name}));
 const involved=!!partnerName&&(operation.startsWith('dhcp-failover-')||!!mirror);
 return {
  title:t('dhcp.confirm.title',{device:device.name}),description:sentences.join(' '),confirmLabel:label,tone:dangerOperations.has(operation)?'danger':'default',
  lines:[{label:t('dhcp.confirm.device'),value:device.name},{label:t('dhcp.confirm.change'),value:label},{label:t('dhcp.confirm.object'),value:dhcpChangeObject(operation,p)},...(involved?[{label:t('dhcp.confirm.partner'),value:partnerLabel}]:[]),...adLines(context,partner?.name??'')],
  payload:{action:'change',serverId:device.id,operation,parameters:p,confirm:true,...(change.secret?{secret:change.secret}:{})},endpoint:'/api/dhcp',plugin:'dhcp',success:t('dhcp.toast.queued',{action:label}),onSettled,
 };
}
/** The confirmation of a replicate: the scope settings of the last read go to the partner. */
export function dhcpReplicateConfirmation(relationship:string,scopeId:string|null,context:DhcpConfirmContext,onSettled:Confirmation['onSettled']):Confirmation{
 const {device,snapshot,partners,t,collectedAt}=context,relation=snapshot.ipv4.failover.find(item=>item.name===relationship);
 const partner=relation?dhcpPartnerDevice(relation.partner,partners):null,label=t(scopeId?'dhcp.op.scopeReplicate':'dhcp.op.failoverReplicate');
 const count=scopeId?1:relation?.scopeIds.length??0;
 return {
  title:t('dhcp.confirm.title',{device:device.name}),description:t('dhcp.confirm.replicate',{count,time:collectedAt?context.time(collectedAt):EMPTY_VALUE,server:snapshot.server.name||device.name,partner:partner?.name??relation?.partner??''}),confirmLabel:label,tone:'default',
  lines:[{label:t('dhcp.confirm.device'),value:device.name},{label:t('dhcp.confirm.change'),value:label},{label:t('dhcp.confirm.object'),value:scopeId??relationship},{label:t('dhcp.confirm.partner'),value:partner?.name??relation?.partner??''},...adLines(context,partner?.name??'')],
  payload:{action:'replicate',serverId:device.id,relationship,...(scopeId?{scopeId}:{}),confirm:true},endpoint:'/api/dhcp',plugin:'dhcp',success:t('dhcp.toast.queued',{action:label}),onSettled,
 };
}

// ---- Lease duration -------------------------------------------------------------------------------------
type Duration={amount:string;unit:'days'|'hours'|'minutes';unlimited:boolean};
const unitSeconds={days:86400,hours:3600,minutes:60} as const;
/** A lease duration as the number and unit of the form; null is Unlimited. */
export function durationParts(seconds:number|null|undefined,fallback=691200):Duration{
 if(seconds===null)return {amount:String(fallback/86400),unit:'days',unlimited:true};
 const value=seconds??fallback;
 for(const unit of ['days','hours','minutes'] as const)if(value%unitSeconds[unit]===0)return {amount:String(value/unitSeconds[unit]),unit,unlimited:false};
 return {amount:String(Math.max(1,Math.round(value/60))),unit:'minutes',unlimited:false};
}
/** The seconds of the form; null for Unlimited, NaN when the number is no whole number. */
export function durationSeconds(duration:Duration):number|null{
 if(duration.unlimited)return null;
 return /^\d{1,7}$/.test(duration.amount.trim())?Number(duration.amount)*unitSeconds[duration.unit]:Number.NaN;
}
function DurationField({value,onChange,error,switchLabel,t}:{value:Duration;onChange:(next:Duration)=>void;error?:string;switchLabel:string;t:Translate}){
 return <div className="sdx-dhcp-duration">
  <Field label={t('dhcp.field.leaseDuration')} error={error} hint={t('dhcp.field.leaseHint',{min:DHCP_LEASE_MIN/60,max:DHCP_LEASE_MAX/86400})}>
   <input inputMode="numeric" value={value.unlimited?'':value.amount} readOnly={value.unlimited} aria-disabled={value.unlimited||undefined} onChange={event=>onChange({...value,amount:event.target.value})}/>
  </Field>
  <Field label={t('dhcp.field.unit')}>
   <Select value={value.unit} blocked={value.unlimited?t('dhcp.field.unitBlocked'):undefined} onChange={event=>onChange({...value,unit:event.target.value as Duration['unit']})}>
    {(['days','hours','minutes'] as const).map(unit=><option key={unit} value={unit}>{t(`dhcp.field.unit.${unit}`)}</option>)}
   </Select>
  </Field>
  <Field inline label={switchLabel}><input type="checkbox" role="switch" checked={value.unlimited} onChange={event=>onChange({...value,unlimited:event.target.checked})}/></Field>
 </div>;
}

// ---- The shell of every form -------------------------------------------------------------------------------
type ShellProps={id:string;title:string;description?:ReactNode;submitLabel:string;change:DhcpChange|null;unchanged?:boolean;snapshot:DhcpSnapshot;blocked?:string;busy:boolean;
 serverErrors:readonly DhcpFieldError[];onCancel:()=>void;onSubmit:(change:DhcpChange)=>void;children:(error:(field:string)=>string|undefined)=>ReactNode;t:Translate;extraErrors?:DhcpFieldError[]};
/** The Drawer, the form, the footer (Cancel and the submit named like the action) and the field errors after the first submit. */
function FormShell({id,title,description,submitLabel,change,unchanged,snapshot,blocked,busy,serverErrors,onCancel,onSubmit,children,t,extraErrors=[]}:ShellProps){
 const [touched,setTouched]=useState(false);
 const validation=change?validateDhcpChange(change.operation,change.parameters,snapshot):null;
 const errors=[...(validation&&!validation.ok?validation.errors:[]),...extraErrors];
 const shown=[...(touched?errors:[]),...serverErrors];
 const error=(field:string)=>{const found=shown.find(item=>item.field===field);return found?dhcpFieldErrorText(found,t):undefined;};
 const submit=(event:FormEvent)=>{event.preventDefault();setTouched(true);if(blocked||unchanged||busy||!change||errors.length)return;onSubmit(change);};
 const reason=blocked??(unchanged?t('common.noChanges'):undefined);
 return <Drawer open onClose={onCancel} title={title} description={description} footer={<><Btn onClick={onCancel}>{t('common.cancel')}</Btn><Btn variant="primary" icon={Check} type="submit" form={id} loading={busy} blocked={reason}>{submitLabel}</Btn></>}>
  <form id={id} className="sdx-form-grid sdx-dhcp-form" noValidate onSubmit={submit}>{children(error)}</form>
 </Drawer>;
}
type FormProps={snapshot:DhcpSnapshot;blocked?:string;busy:boolean;serverErrors:readonly DhcpFieldError[];onCancel:()=>void;onSubmit:(change:DhcpChange)=>void;t:Translate};
const text=(value:string)=>value.trim();
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
/** The class mask of an IPv4 address: /8 below 128, /16 below 192, else /24. */
export function classMask(address:string):string{const value=ipv4Number(address);if(value===null)return '255.255.255.0';const first=Math.floor(value/2**24);return first<128?'255.0.0.0':first<192?'255.255.0.0':'255.255.255.0';}
const scopeTypes=['dhcp','bootp','both'] as const;

// ---- Scope -------------------------------------------------------------------------------------------------
export function ScopeForm({form,...props}:FormProps&{form:Extract<DhcpForm,{kind:'scope'}>}){
 const {snapshot,t}=props;
 const v4=form.family==='ipv4'?snapshot.ipv4.scopes.find(item=>item.id===form.id):undefined,v6=form.family==='ipv6'?snapshot.ipv6.scopes.find(item=>item.prefix===form.id):undefined;
 const editing=!!form.id;
 const [name,setName]=useState(v4?.name??v6?.name??''),[description,setDescription]=useState(v4?.description??v6?.description??'');
 const [start,setStart]=useState(v4?.startRange??''),[end,setEnd]=useState(v4?.endRange??''),[mask,setMask]=useState(v4?.subnetMask??''),[maskEdited,setMaskEdited]=useState(editing);
 const [duration,setDuration]=useState<Duration>(durationParts(v4?v4.leaseDurationSeconds:undefined)),[type,setType]=useState<typeof scopeTypes[number]>(v4?.type??'dhcp'),[activate,setActivate]=useState(true);
 const [prefix,setPrefix]=useState(v6?.prefix??''),[preference,setPreference]=useState(String(v6?.preference??0));
 const lease=durationSeconds(duration);
 const build=():DhcpChange=>{
  if(form.family==='ipv6')return editing?dhcpChange('dhcp-scope-edit',{family:'ipv6',prefix:form.id,name:text(name),description:text(description),preference:Number(preference)},'dhcp.form.save.scope')
   :dhcpChange('dhcp-scope-create',{family:'ipv6',prefix:text(prefix),name:text(name),description:text(description),preference:/^\d+$/.test(preference)?Number(preference):Number.NaN,activate});
  const common={name:text(name),description:text(description),startRange:text(start),endRange:text(end),leaseDurationSeconds:lease,type};
  return editing?dhcpChange('dhcp-scope-edit',{family:'ipv4',scopeId:form.id,...common},'dhcp.form.save.scope'):dhcpChange('dhcp-scope-create',{family:'ipv4',...common,subnetMask:text(mask),activate});
 };
 const change=build(),initial=editing?{...change.parameters,...(v4?{name:v4.name,description:v4.description,startRange:v4.startRange,endRange:v4.endRange,leaseDurationSeconds:v4.leaseDurationSeconds,type:v4.type}:{}),...(v6?{name:v6.name,description:v6.description,preference:v6.preference}:{})}:null;
 return <FormShell {...props} id="sdx-dhcp-scope-form" title={t(editing?'dhcp.op.scopeEdit':'dhcp.op.scopeCreate')} description={form.id?<span className="mono">{form.id}</span>:undefined}
  submitLabel={t(editing?'dhcp.form.save.scope':'dhcp.op.scopeCreate')} change={change} unchanged={editing&&same(initial,change.parameters)}>
  {error=><>
   {form.family==='ipv6'&&!editing&&<Field label={t('dhcp.field.prefix')} error={error('prefix')} hint={t('dhcp.field.prefixHint')}><input autoFocus className="mono" value={prefix} placeholder="2001:db8:1::" onChange={event=>setPrefix(event.target.value)}/></Field>}
   <Field label={t('dhcp.field.name')} error={error('name')}><input autoFocus={form.family==='ipv4'||editing} value={name} maxLength={256} onChange={event=>setName(event.target.value)}/></Field>
   <Field label={t('dhcp.field.description')} error={error('description')}><textarea rows={2} value={description} maxLength={1024} onChange={event=>setDescription(event.target.value)}/></Field>
   {form.family==='ipv4'?<>
    <div className="sdx-dhcp-pair">
     <Field label={t('dhcp.field.start')} error={error('startRange')}><input className="mono" inputMode="decimal" value={start} placeholder="10.40.0.10" onChange={event=>{setStart(event.target.value);if(!maskEdited)setMask(classMask(event.target.value));}}/></Field>
     <Field label={t('dhcp.field.end')} error={error('endRange')}><input className="mono" inputMode="decimal" value={end} placeholder="10.40.0.200" onChange={event=>setEnd(event.target.value)}/></Field>
    </div>
    <Field label={t('dhcp.field.mask')} error={error('subnetMask')??error('scopeId')} hint={editing?t('dhcp.field.maskFixed'):t('dhcp.field.maskHint')}>
     <input className="mono" inputMode="decimal" value={mask} readOnly={editing} aria-disabled={editing||undefined} placeholder="255.255.255.0" onChange={event=>{setMask(event.target.value);setMaskEdited(true);}}/>
    </Field>
    <DurationField value={duration} onChange={setDuration} error={error('leaseDurationSeconds')} switchLabel={t('dhcp.field.unlimited')} t={t}/>
    <Field label={t('dhcp.field.type')} error={error('type')}><Select value={type} onChange={event=>setType(event.target.value as typeof type)}>{scopeTypes.map(item=><option key={item} value={item}>{t(`dhcp.type.${item}`)}</option>)}</Select></Field>
   </>:<Field label={t('dhcp.field.preference')} error={error('preference')} hint={t('dhcp.field.preferenceHint')}><input inputMode="numeric" value={preference} onChange={event=>setPreference(event.target.value)}/></Field>}
   {!editing&&<Field inline label={t('dhcp.field.activateNow')}><input type="checkbox" role="switch" checked={activate} onChange={event=>setActivate(event.target.checked)}/></Field>}
  </>}
 </FormShell>;
}

// ---- Superscope ------------------------------------------------------------------------------------------------
export function SuperscopeForm({form,...props}:FormProps&{form:Extract<DhcpForm,{kind:'superscope'}>}){
 const {snapshot,t}=props,current=snapshot.ipv4.superscopes.find(item=>item.name===form.name),editing=!!current;
 const [name,setName]=useState(current?.name??''),[members,setMembers]=useState<string[]>(current?.scopeIds??[]);
 const change=editing?dhcpChange('dhcp-superscope-edit',{name:current.name,...(text(name)!==current.name?{newName:text(name)}:{}),scopeIds:members},'dhcp.form.save.superscope'):dhcpChange('dhcp-superscope-create',{name:text(name),scopeIds:members});
 return <FormShell {...props} id="sdx-dhcp-superscope-form" title={t(editing?'dhcp.op.superscopeEdit':'dhcp.op.superscopeCreate')} submitLabel={t(editing?'dhcp.form.save.superscope':'dhcp.op.superscopeCreate')} change={change}
  unchanged={editing&&text(name)===current.name&&same([...members].sort(),[...current.scopeIds].sort())}>
  {error=><>
   <Field label={t('dhcp.field.name')} error={error('name')??error('newName')}><input autoFocus value={name} maxLength={256} onChange={event=>setName(event.target.value)}/></Field>
   <fieldset className="sdx-dhcp-fieldset" aria-describedby={error('scopeIds')?'sdx-dhcp-members-error':undefined}><legend>{t('dhcp.field.members')}</legend>
    <ScopePick scopes={snapshot.ipv4.scopes} selected={members} onChange={setMembers} meta={scope=>scope.superscope??t('dhcp.superscope.none')} label={t('dhcp.field.members')}/>
    {error('scopeIds')&&<p id="sdx-dhcp-members-error" className="sdx-field-error">{error('scopeIds')}</p>}
   </fieldset>
  </>}
 </FormShell>;
}
/** A checkbox pick list of IPv4 scopes with a meta line per scope. */
function ScopePick({scopes,selected,onChange,meta,label}:{scopes:DhcpIpv4Scope[];selected:string[];onChange:(next:string[])=>void;meta:(scope:DhcpIpv4Scope)=>string;label:string}){
 return <div className="sdx-pick-list" role="group" aria-label={label}>{scopes.map(scope=>{const checked=selected.includes(scope.id);return <label key={scope.id} className={cx('sdx-pick-row',checked&&'selected')}>
  <input type="checkbox" className="sdx-check" checked={checked} onChange={event=>onChange(event.target.checked?[...selected,scope.id]:selected.filter(id=>id!==scope.id))}/>
  <span className="sdx-pick-text"><strong>{scope.name||scope.id} <span className="mono">{scope.id}</span></strong><small>{meta(scope)}</small></span>
 </label>;})}</div>;
}

// ---- Exclusion -----------------------------------------------------------------------------------------------------
export function ExclusionForm({form,...props}:FormProps&{form:Extract<DhcpForm,{kind:'exclusion'}>}){
 const {snapshot,t}=props,[start,setStart]=useState(''),[end,setEnd]=useState('');
 const v4=form.family==='ipv4'?snapshot.ipv4.scopes.find(item=>item.id===form.scope):undefined;
 const change=dhcpChange('dhcp-exclusion-add',form.family==='ipv4'?{family:'ipv4',scopeId:form.scope,start:text(start),end:text(end)}:{family:'ipv6',prefix:form.scope,start:text(start),end:text(end)});
 const hint=v4?t('dhcp.field.rangeHint',{start:v4.startRange,end:v4.endRange}):t('dhcp.field.prefixRangeHint',{prefix:form.scope});
 return <FormShell {...props} id="sdx-dhcp-exclusion-form" title={t('dhcp.op.exclusionAdd')} description={<span className="mono">{form.scope}</span>} submitLabel={t('dhcp.op.exclusionAdd')} change={change}>
  {error=><div className="sdx-dhcp-pair">
   <Field label={t('dhcp.field.start')} error={error('start')} hint={hint}><input autoFocus className="mono" value={start} onChange={event=>setStart(event.target.value)}/></Field>
   <Field label={t('dhcp.field.end')} error={error('end')}><input className="mono" value={end} onChange={event=>setEnd(event.target.value)}/></Field>
  </div>}
 </FormShell>;
}

// ---- Reservation -----------------------------------------------------------------------------------------------------
export function ReservationForm({form,...props}:FormProps&{form:Extract<DhcpForm,{kind:'reservation'}>}){
 const {snapshot,t}=props,family=form.family;
 const [scope,setScope]=useState(form.scope??(family==='ipv4'?snapshot.ipv4.scopes[0]?.id:snapshot.ipv6.scopes[0]?.prefix)??'');
 const v4=family==='ipv4'?snapshot.ipv4.scopes.find(item=>item.id===scope)?.reservations.find(item=>item.address===form.address):undefined;
 const v6=family==='ipv6'?snapshot.ipv6.scopes.find(item=>item.prefix===scope)?.reservations.find(item=>item.address===form.address):undefined;
 const editing=!!form.address;
 const [address,setAddress]=useState(form.address??form.lease?.address??''),[client,setClient]=useState(v4?.clientId??v6?.duid??form.lease?.clientId??'');
 const [name,setName]=useState(v4?.name??form.lease?.name??''),[description,setDescription]=useState(v4?.description??''),[type,setType]=useState<typeof scopeTypes[number]>(v4?.type??'dhcp'),[iaid,setIaid]=useState(String(v6?.iaid??0));
 const moved=editing&&text(address)!==form.address;
 const parameters=family==='ipv4'?{family:'ipv4',scopeId:scope,address:editing?form.address:text(address),...(moved?{newAddress:text(address)}:{}),clientId:text(client),name:text(name),description:text(description),type}
  :{family:'ipv6',prefix:scope,address:editing?form.address:text(address),...(moved?{newAddress:text(address)}:{}),duid:text(client),iaid:/^\d+$/.test(iaid)?Number(iaid):Number.NaN};
 const change=dhcpChange(editing?'dhcp-reservation-edit':'dhcp-reservation-add',parameters,editing?'dhcp.form.save.reservation':'dhcp.op.reservationAdd');
 const initial=editing?(family==='ipv4'?{family,scopeId:scope,address:form.address,clientId:v4?.clientId,name:v4?.name,description:v4?.description,type:v4?.type}:{family,prefix:scope,address:form.address,duid:v6?.duid,iaid:v6?.iaid}):null;
 const scopes=family==='ipv4'?snapshot.ipv4.scopes.map(item=>({id:item.id,label:`${item.id} ${item.name}`.trim()})):snapshot.ipv6.scopes.map(item=>({id:item.prefix,label:`${item.prefix} ${item.name}`.trim()}));
 const range=family==='ipv4'?snapshot.ipv4.scopes.find(item=>item.id===scope):undefined;
 return <FormShell {...props} id="sdx-dhcp-reservation-form" title={t(editing?'dhcp.op.reservationEdit':'dhcp.op.reservationAdd')} description={form.scope?<span className="mono">{form.scope}</span>:undefined}
  submitLabel={t(editing?'dhcp.form.save.reservation':'dhcp.op.reservationAdd')} change={change} unchanged={editing&&same(initial,{...parameters,newAddress:undefined})&&!moved}>
  {error=><>
   {!form.scope&&<Field label={t('dhcp.field.scope')} error={error('scopeId')??error('prefix')}><Select autoFocus value={scope} onChange={event=>setScope(event.target.value)}>{scopes.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</Select></Field>}
   <Field label={t('dhcp.field.address')} error={error('address')??error('newAddress')} hint={range?t('dhcp.field.rangeHint',{start:range.startRange,end:range.endRange}):undefined}><input autoFocus={!!form.scope} className="mono" value={address} onChange={event=>setAddress(event.target.value)}/></Field>
   {family==='ipv4'?<>
    <Field label={t('dhcp.field.clientId')} error={error('clientId')}><input className="mono" value={client} placeholder="00-15-5D-01-02-03" onChange={event=>setClient(event.target.value)}/></Field>
    <Field label={t('dhcp.field.name')} error={error('name')}><input value={name} maxLength={256} onChange={event=>setName(event.target.value)}/></Field>
    <Field label={t('dhcp.field.description')} error={error('description')}><textarea rows={2} value={description} maxLength={1024} onChange={event=>setDescription(event.target.value)}/></Field>
    <Field label={t('dhcp.field.type')}><Select value={type} onChange={event=>setType(event.target.value as typeof type)}>{scopeTypes.map(item=><option key={item} value={item}>{t(`dhcp.type.${item}`)}</option>)}</Select></Field>
   </>:<>
    <Field label={t('dhcp.field.duid')} error={error('duid')}><input className="mono" value={client} onChange={event=>setClient(event.target.value)}/></Field>
    <Field label={t('dhcp.field.iaid')} error={error('iaid')}><input inputMode="numeric" className="mono" value={iaid} onChange={event=>setIaid(event.target.value)}/></Field>
   </>}
  </>}
 </FormShell>;
}

// ---- Option ------------------------------------------------------------------------------------------------------------
/** The hint of the values field: the option type, one value per line. */
export const optionValuesHint=(type:DhcpOptionType|null,t:Translate)=>t('dhcp.field.valuesHint',{type:type?t(`dhcp.optionPlural.${type}`):t('dhcp.optionPlural.any')});
export function OptionForm({form,...props}:FormProps&{form:Extract<DhcpForm,{kind:'option'}>}){
 const {snapshot,t}=props,family=form.family,definitions=snapshot[family].optionDefinitions??[];
 const scope=form.scope??null;
 const policies=form.level==='policy'?(scope?snapshot.ipv4.scopes.find(item=>item.id===scope)?.policies:snapshot.ipv4.policies)??[]:[];
 const owner=form.level==='policy'?policies.find(item=>item.name===form.policy)?.options??[]:form.level==='scope'?(family==='ipv4'?snapshot.ipv4.scopes.find(item=>item.id===scope)?.options:snapshot.ipv6.scopes.find(item=>item.prefix===scope)?.options)??[]:snapshot[family].serverOptions;
 const current=form.code!==undefined?owner.find(item=>item.code===form.code&&(item.vendorClass??null)===(form.vendorClass??null)&&(item.userClass??null)===(form.userClass??null)):undefined;
 const editing=!!current;
 const [code,setCode]=useState(String(current?.code??definitions[0]?.code??'')),[vendor,setVendor]=useState(current?.vendorClass??''),[user,setUser]=useState(current?.userClass??''),[values,setValues]=useState((current?.values??[]).join('\n'));
 const numeric=/^\d+$/.test(code)?Number(code):Number.NaN,definition=definitions.find(item=>item.code===numeric&&(item.vendorClass??'')===text(vendor))??definitions.find(item=>item.code===numeric)??null;
 const target={family,level:form.level,...(family==='ipv4'&&form.level!=='server'?{scopeId:scope}:{}),...(family==='ipv6'&&form.level==='scope'?{prefix:scope}:{}),...(form.level==='policy'?{policy:form.policy}:{}),
  code:numeric,vendorClass:text(vendor)||null,userClass:text(user)||null};
 const change=dhcpChange('dhcp-option-set',{...target,values:values.split('\n').map(line=>line.trim()).filter(Boolean)},editing?'dhcp.form.save.option':'dhcp.op.optionSet');
 const where=form.level==='server'?t('dhcp.level.server'):form.level==='scope'?t('dhcp.level.scope',{id:scope??''}):t('dhcp.level.policy',{name:form.policy??''});
 return <FormShell {...props} id="sdx-dhcp-option-form" title={t(editing?'dhcp.op.optionEdit':'dhcp.op.optionSet')} description={where} submitLabel={t(editing?'dhcp.form.save.option':'dhcp.op.optionSet')} change={change}
  unchanged={editing&&same(current.values,change.parameters.values)&&(current.vendorClass??null)===target.vendorClass&&(current.userClass??null)===target.userClass}>
  {error=><>
   <Field label={t('dhcp.field.option')} error={error('code')} hint={editing?t('dhcp.field.optionFixed'):undefined}>
    {definitions.length?<Select autoFocus value={code} blocked={editing?t('dhcp.field.optionFixed'):undefined} onChange={event=>{if(!editing)setCode(event.target.value);}}>{definitions.map(item=><option key={`${item.code}-${item.vendorClass??''}`} value={item.code}>{`${item.code} ${item.name}`}</option>)}</Select>
     :<input autoFocus inputMode="numeric" className="mono" value={code} readOnly={editing} aria-disabled={editing||undefined} onChange={event=>setCode(event.target.value)}/>}
   </Field>
   <div className="sdx-dhcp-pair">
    <Field label={t('dhcp.field.vendorClass')}><input value={vendor} maxLength={128} readOnly={editing} aria-disabled={editing||undefined} onChange={event=>setVendor(event.target.value)}/></Field>
    <Field label={t('dhcp.field.userClass')}><input value={user} maxLength={128} readOnly={editing} aria-disabled={editing||undefined} onChange={event=>setUser(event.target.value)}/></Field>
   </div>
   <Field label={t('dhcp.field.values')} error={error('values')} hint={optionValuesHint(definition?.type??null,t)}><textarea className="mono" rows={4} value={values} onChange={event=>setValues(event.target.value)}/></Field>
  </>}
 </FormShell>;
}

// ---- Policy --------------------------------------------------------------------------------------------------------------
const criterionTypes=['mac','vendorClass','userClass','clientId','relayAgent','circuitId','remoteId','subscriberId','fqdn'] as const;
type CriterionRow={type:typeof criterionTypes[number];operator:'equals'|'notEquals';values:string};
export function PolicyForm({form,...props}:FormProps&{form:Extract<DhcpForm,{kind:'policy'}>}){
 const {snapshot,t}=props,list=form.scope?snapshot.ipv4.scopes.find(item=>item.id===form.scope)?.policies??[]:snapshot.ipv4.policies;
 const current:DhcpPolicy|undefined=form.name!==undefined?list.find(item=>item.name===form.name):undefined,editing=!!current;
 const [name,setName]=useState(current?.name??''),[description,setDescription]=useState(current?.description??''),[enabled,setEnabled]=useState(current?.enabled??true);
 const [order,setOrder]=useState(String(current?.order??(Math.max(0,...list.map(item=>item.order))+1))),[condition,setCondition]=useState<'and'|'or'>(current?.condition??'or');
 const [criteria,setCriteria]=useState<CriterionRow[]>(current?.criteria.map(item=>({type:item.type,operator:item.operator,values:item.values.join(', ')}))??[{type:'mac',operator:'equals',values:''}]);
 const [ranges,setRanges]=useState(current?.ranges.map(item=>({start:String(item.start),end:String(item.end)}))??[]);
 const [duration,setDuration]=useState<Duration>({...durationParts(current?.leaseDurationSeconds??86400),unlimited:current?current.leaseDurationSeconds===null:true});
 const fields={scopeId:form.scope,description:text(description),enabled,order:/^\d+$/.test(order)?Number(order):Number.NaN,condition,
  criteria:criteria.map(row=>({type:row.type,operator:row.operator,values:row.values.split(',').map(value=>value.trim()).filter(Boolean)})),ranges:ranges.map(item=>({start:text(item.start),end:text(item.end)})),leaseDurationSeconds:durationSeconds(duration)};
 const change=editing?dhcpChange('dhcp-policy-edit',{name:current.name,...(text(name)!==current.name?{newName:text(name)}:{}),...fields},'dhcp.form.save.policy'):dhcpChange('dhcp-policy-create',{name:text(name),...fields});
 const initial=current?{scopeId:current.scopeId,description:current.description,enabled:current.enabled,order:current.order,condition:current.condition,criteria:current.criteria,ranges:current.ranges.map(item=>({start:String(item.start),end:String(item.end)})),leaseDurationSeconds:current.leaseDurationSeconds}:null;
 const setRow=(index:number,next:Partial<CriterionRow>)=>setCriteria(rows=>rows.map((row,i)=>i===index?{...row,...next}:row));
 return <FormShell {...props} id="sdx-dhcp-policy-form" title={t(editing?'dhcp.op.policyEdit':'dhcp.op.policyCreate')} description={form.scope?t('dhcp.level.scope',{id:form.scope}):t('dhcp.level.server')}
  submitLabel={t(editing?'dhcp.form.save.policy':'dhcp.op.policyCreate')} change={change} unchanged={editing&&text(name)===current.name&&same(initial,fields)}>
  {error=><>
   <Field label={t('dhcp.field.name')} error={error('name')??error('newName')}><input autoFocus value={name} maxLength={256} onChange={event=>setName(event.target.value)}/></Field>
   <Field label={t('dhcp.field.description')}><textarea rows={2} value={description} maxLength={1024} onChange={event=>setDescription(event.target.value)}/></Field>
   <Field inline label={t('dhcp.field.enabled')}><input type="checkbox" role="switch" checked={enabled} onChange={event=>setEnabled(event.target.checked)}/></Field>
   <Field label={t('dhcp.field.order')} error={error('order')}><input inputMode="numeric" value={order} onChange={event=>setOrder(event.target.value)}/></Field>
   <fieldset className="sdx-dhcp-fieldset"><legend>{t('dhcp.field.conditions')}</legend>
    <Segmented<'and'|'or'> label={t('dhcp.field.conditions')} size="sm" value={condition} onChange={setCondition} items={[{id:'and',label:t('dhcp.field.matchAll')},{id:'or',label:t('dhcp.field.matchAny')}]}/>
    {criteria.map((row,index)=><div key={index} className="sdx-dhcp-row">
     <Select aria-label={t('dhcp.field.conditionType')} value={row.type} onChange={event=>setRow(index,{type:event.target.value as CriterionRow['type']})}>{criterionTypes.map(item=><option key={item} value={item}>{t(`dhcp.criterion.${item}`)}</option>)}</Select>
     <Select aria-label={t('dhcp.field.conditionOperator')} value={row.operator} onChange={event=>setRow(index,{operator:event.target.value as CriterionRow['operator']})}><option value="equals">{t('dhcp.operator.equals')}</option><option value="notEquals">{t('dhcp.operator.notEquals')}</option></Select>
     <input aria-label={t('dhcp.field.conditionValues')} value={row.values} placeholder={t('dhcp.field.conditionPlaceholder')} onChange={event=>setRow(index,{values:event.target.value})}/>
     <IconBtn icon={Trash2} label={t('dhcp.field.removeCondition')} onClick={()=>setCriteria(rows=>rows.filter((_,i)=>i!==index))}/>
    </div>)}
    <Btn size="sm" variant="ghost" icon={Plus} onClick={()=>setCriteria(rows=>[...rows,{type:'mac',operator:'equals',values:''}])}>{t('dhcp.field.addCondition')}</Btn>
    {error('criteria')&&<p className="sdx-field-error">{error('criteria')}</p>}
   </fieldset>
   {form.scope&&<fieldset className="sdx-dhcp-fieldset"><legend>{t('dhcp.field.ranges')}</legend>
    {ranges.map((item,index)=><div key={index} className="sdx-dhcp-row">
     <input className="mono" aria-label={t('dhcp.field.start')} value={item.start} onChange={event=>setRanges(rows=>rows.map((row,i)=>i===index?{...row,start:event.target.value}:row))}/>
     <input className="mono" aria-label={t('dhcp.field.end')} value={item.end} onChange={event=>setRanges(rows=>rows.map((row,i)=>i===index?{...row,end:event.target.value}:row))}/>
     <IconBtn icon={Trash2} label={t('dhcp.field.removeRange')} onClick={()=>setRanges(rows=>rows.filter((_,i)=>i!==index))}/>
    </div>)}
    <Btn size="sm" variant="ghost" icon={Plus} onClick={()=>setRanges(rows=>[...rows,{start:'',end:''}])}>{t('dhcp.field.addRange')}</Btn>
    {error('ranges')&&<p className="sdx-field-error">{error('ranges')}</p>}
   </fieldset>}
   <DurationField value={duration} onChange={setDuration} error={error('leaseDurationSeconds')} switchLabel={t('dhcp.field.scopeLease')} t={t}/>
  </>}
 </FormShell>;
}

// ---- Failover ---------------------------------------------------------------------------------------------------------------
/** One device the failover form offers as partner, with the reason it cannot be one (undefined when it can). */
export type DhcpPartnerOption=DhcpPartnerCandidate&{blocked?:string;secretBlocked?:string};
export function FailoverForm({form,partners,secretBlocked,...props}:FormProps&{form:Extract<DhcpForm,{kind:'failover'}>;partners:readonly DhcpPartnerOption[];secretBlocked?:string}){
 const {snapshot,t}=props,current=snapshot.ipv4.failover.find(item=>item.name===form.name),editing=!!current;
 const free=snapshot.ipv4.scopes.filter(scope=>!scope.failover);
 const [name,setName]=useState(''),[partner,setPartner]=useState(partners.find(item=>!item.blocked)?.name??'');
 const [scopes,setScopes]=useState<string[]>([]),[removed,setRemoved]=useState<string[]>([]);
 const [mode,setMode]=useState<'loadBalance'|'hotStandby'>(current?.mode??'loadBalance'),[share,setShare]=useState(String(current?.loadBalancePercent??50)),[role,setRole]=useState<'active'|'standby'>(current?.serverRole??'active'),[reserve,setReserve]=useState(String(current?.reservePercent??5));
 const [mclt,setMclt]=useState(String(Math.round((current?.mcltSeconds??3600)/60))),[auto,setAuto]=useState(current?.autoStateTransition??false),[interval,setSwitchInterval]=useState(String(Math.round((current?.stateSwitchIntervalSeconds??3600)/60)));
 const [authenticate,setAuthenticate]=useState(current?.messageAuthentication??false),[secret,setSecret]=useState('');
 const whole=(value:string,factor=1)=>/^\d{1,9}$/.test(value.trim())?Number(value)*factor:Number.NaN;
 const chosen=partners.find(item=>item.name===partner),secretReason=secretBlocked??chosen?.secretBlocked;
 const needsSecret=authenticate&&!(editing&&current.messageAuthentication);
 const extraErrors:DhcpFieldError[]=[...(!editing&&chosen?.blocked?[{field:'partner',code:'invalid' as const}]:[]),...((needsSecret||secret)&&!secretReason&&!dhcpSecretValid(secret)?[{field:'secret',code:'secret' as const}]:[])];
 const settings={...(mode==='loadBalance'?{loadBalancePercent:whole(share)}:{reservePercent:whole(reserve)}),mcltSeconds:whole(mclt,60),autoStateTransition:auto,stateSwitchIntervalSeconds:auto?whole(interval,60):null,messageAuthentication:authenticate};
 const change:DhcpChange=editing
  ?{...dhcpChange('dhcp-failover-edit',{name:current.name,...settings,...(scopes.length?{addScopeIds:scopes}:{}),...(removed.length?{removeScopeIds:removed}:{})},'dhcp.form.save.relationship'),...(authenticate&&secret?{secret}:{})}
  :{...dhcpChange('dhcp-failover-create',{name:text(name),partner,serverType:'primary',mode,loadBalancePercent:mode==='loadBalance'?whole(share):50,serverRole:role,reservePercent:mode==='hotStandby'?whole(reserve):5,
    mcltSeconds:whole(mclt,60),autoStateTransition:auto,stateSwitchIntervalSeconds:auto?whole(interval,60):null,messageAuthentication:authenticate,scopeIds:scopes}),...(authenticate&&secret?{secret}:{})};
 const before=current?{...(current.mode==='loadBalance'?{loadBalancePercent:current.loadBalancePercent}:{reservePercent:current.reservePercent}),mcltSeconds:current.mcltSeconds,autoStateTransition:current.autoStateTransition,stateSwitchIntervalSeconds:current.autoStateTransition?current.stateSwitchIntervalSeconds:null,messageAuthentication:current.messageAuthentication}:null;
 const unchanged=editing&&same(before,settings)&&!scopes.length&&!removed.length&&!secret;
 return <FormShell {...props} id="sdx-dhcp-failover-form" title={t(editing?'dhcp.op.failoverEdit':'dhcp.op.failoverCreate')} description={current?`${current.name} · ${current.partner}`:undefined}
  submitLabel={t(editing?'dhcp.form.save.relationship':'dhcp.op.failoverCreate')} change={change} unchanged={unchanged} extraErrors={extraErrors}
  blocked={props.blocked??((!editing||scopes.length>0)&&snapshot.truncated.reservations?t('dhcp.blocked.reservationsTruncated'):undefined)??(needsSecret&&secretReason?secretReason:undefined)}>
  {error=><>
   {!editing&&<>
    <Field label={t('dhcp.field.relationship')} error={error('name')}><input autoFocus value={name} maxLength={256} onChange={event=>setName(event.target.value)}/></Field>
    <Field label={t('dhcp.field.partner')} error={error('partner')} hint={chosen?.blocked}>
     <Select value={partner} onChange={event=>setPartner(event.target.value)}>
      {!partners.length&&<option value="">{t('dhcp.field.noPartner')}</option>}
      {partners.map(item=><option key={item.id} value={item.name} disabled={!!item.blocked}>{item.blocked?t('dhcp.field.partnerBlocked',{name:item.name,reason:item.blocked}):item.name}</option>)}
     </Select>
    </Field>
   </>}
   <fieldset className="sdx-dhcp-fieldset"><legend>{t(editing?'dhcp.field.addScopes':'dhcp.field.scopes')}</legend>
    <ScopePick scopes={free} selected={scopes} onChange={setScopes} meta={scope=>`${scope.startRange} – ${scope.endRange}`} label={t(editing?'dhcp.field.addScopes':'dhcp.field.scopes')}/>
    {error('scopeIds')??error('addScopeIds')?<p className="sdx-field-error">{error('scopeIds')??error('addScopeIds')}</p>:null}
   </fieldset>
   {editing&&<fieldset className="sdx-dhcp-fieldset"><legend>{t('dhcp.field.removeScopes')}</legend>
    <ScopePick scopes={snapshot.ipv4.scopes.filter(scope=>current.scopeIds.includes(scope.id))} selected={removed} onChange={setRemoved} meta={scope=>`${scope.startRange} – ${scope.endRange}`} label={t('dhcp.field.removeScopes')}/>
    {error('removeScopeIds')&&<p className="sdx-field-error">{error('removeScopeIds')}</p>}
   </fieldset>}
   {!editing&&<Segmented<'loadBalance'|'hotStandby'> label={t('dhcp.field.mode')} value={mode} onChange={setMode} items={[{id:'loadBalance',label:t('dhcp.field.loadBalance')},{id:'hotStandby',label:t('dhcp.field.hotStandby')}]}/>}
   {mode==='loadBalance'?<Field label={t('dhcp.field.share')} error={error('loadBalancePercent')} hint="%"><input inputMode="numeric" value={share} onChange={event=>setShare(event.target.value)}/></Field>:<>
    {!editing&&<Field label={t('dhcp.field.role')}><Select value={role} onChange={event=>setRole(event.target.value as typeof role)}><option value="active">{t('dhcp.role.active')}</option><option value="standby">{t('dhcp.role.standby')}</option></Select></Field>}
    <Field label={t('dhcp.field.reserve')} error={error('reservePercent')} hint="%"><input inputMode="numeric" value={reserve} onChange={event=>setReserve(event.target.value)}/></Field>
   </>}
   <Field label={t('dhcp.field.mclt')} error={error('mcltSeconds')}><input inputMode="numeric" value={mclt} onChange={event=>setMclt(event.target.value)}/></Field>
   <Field inline label={t('dhcp.field.autoSwitch')}><input type="checkbox" role="switch" checked={auto} onChange={event=>setAuto(event.target.checked)}/></Field>
   {auto&&<Field label={t('dhcp.field.switchInterval')} error={error('stateSwitchIntervalSeconds')}><input inputMode="numeric" value={interval} onChange={event=>setSwitchInterval(event.target.value)}/></Field>}
   <Field inline label={t('dhcp.field.authenticate')}><input type="checkbox" role="switch" checked={authenticate} onChange={event=>setAuthenticate(event.target.checked)}/></Field>
   {authenticate&&<Field label={t('dhcp.field.secret')} error={secretReason?undefined:error('secret')} hint={secretReason??(editing&&current.messageAuthentication?t('dhcp.field.secretKeep'):undefined)}>
    <input type="password" autoComplete="new-password" value={secret} readOnly={!!secretReason} aria-disabled={!!secretReason||undefined} onChange={event=>setSecret(event.target.value)}/>
   </Field>}
  </>}
 </FormShell>;
}

/** The open drawer of the view: one form at a time. */
export function DhcpFormDrawer(props:FormProps&{form:DhcpForm;partners:readonly DhcpPartnerOption[];secretBlocked?:string}){
 const {form,partners,secretBlocked,...rest}=props;
 switch(form.kind){
  case 'scope':return <ScopeForm {...rest} form={form}/>;
  case 'superscope':return <SuperscopeForm {...rest} form={form}/>;
  case 'exclusion':return <ExclusionForm {...rest} form={form}/>;
  case 'reservation':return <ReservationForm {...rest} form={form}/>;
  case 'option':return <OptionForm {...rest} form={form}/>;
  case 'policy':return <PolicyForm {...rest} form={form}/>;
  case 'failover':return <FailoverForm {...rest} form={form} partners={partners} secretBlocked={secretBlocked}/>;
 }
}
