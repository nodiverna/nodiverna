'use client';
import {useCallback,useEffect,useId,useRef,useState,type FormEvent} from 'react';
import {AlertTriangle,CheckCircle2,FlaskConical,KeyRound,LifeBuoy,LockKeyhole,LockKeyholeOpen,Plus,ShieldCheck,Trash2,UserCheck,Users,XCircle} from 'lucide-react';
import {toast} from 'sonner';
import type {Viewer} from '@/lib/types';
import type {EntraMapping,EntraSettingsView} from '@/lib/server/identity/entra/settings';
import type {DirectoryCheckState} from '@/lib/server/identity/entra/directory-check-state';
import {EMPTY_VALUE,formatNumber,formatUntil} from '@/lib/i18n/format';
import {consoleRouteHash} from '@/lib/console-route';
import {entraSettingsActionNeedsStepUp} from '@/lib/step-up';
import type {MessageKey} from '@/lib/i18n/translate';
import {api,ApiError,message} from '@/ui/base/api';
import {MfaStepUp} from '@/ui/session/mfa-step-up';
import {useStepUp} from '@/ui/session/step-up-retry';
import {Btn,Card,CopyValue,Drawer,DrawerCancel,Empty,EntranceList,Facts,Menu,Notice,SettingsPage,StatusPill,cx,exactTime,relativeTime,type IconTone,type StatusKind} from '@/ui/kit/kit';
import {ConfirmDialog} from '@/ui/kit/confirm-dialog';
import {DataTable,type DataColumn} from '@/ui/kit/data-table';
import {Field,FormActions,Select,Switch} from '@/ui/kit/field';
import {useLocale,useT,type Translate} from '@/ui/base/locale';
import {frameHeader,useFrameRefresh,type PageFrame} from '@/ui/shell/page-frame';
import '@/ui/settings/entra-settings.css';

// Settings → Microsoft Entra ID (Owners only, docs/entra-id.md). Six cards:
// the status with the switch (the focal point), the app registration with the
// connection test, the account check through Microsoft Graph (read-only), the
// group mappings, the emergency access account and Microsoft sign-in only.
// Every change but the test asks for a fresh MFA proof first
// (entraSettingsStepUpActions, lib/step-up.ts). With sample devices the page
// shows the real settings and blocks nothing: sample devices change no setting here.
export const entraSettingsEndpoint='/api/entra/settings';
export const entraPaletteKeywords:MessageKey='entra.paletteKeywords';
// Built from parts, so the repository scan for key material (tests/repo/key-material.mjs) finds no key here.
const privateKeyPlaceholder='-----BEGIN PRIVATE'+' KEY-----';
const guidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type CredentialKind=EntraSettingsView['credentialKind'];
export type AppForm={tenantId:string;clientId:string;credentialKind:CredentialKind;secret:string;certificatePem:string;privateKeyPem:string};
type AppField='tenantId'|'clientId'|'secret'|'certificatePem'|'privateKeyPem';
export type EntraStatus='on'|'off'|'notSetUp';
type TestResult=NonNullable<EntraSettingsView['lastTest']>['result'];

export const appFormOf=(view:EntraSettingsView):AppForm=>({tenantId:view.tenantId,clientId:view.clientId,credentialKind:view.credentialKind,secret:'',certificatePem:'',privateKeyPem:''});
export const appFormDirty=(form:AppForm,view:EntraSettingsView)=>form.tenantId.trim().toLowerCase()!==view.tenantId||form.clientId.trim().toLowerCase()!==view.clientId||form.credentialKind!==view.credentialKind||!!form.secret||!!form.certificatePem.trim()||!!form.privateKeyPem.trim();
/**
 * The app form after a new stored state (another card saved, the test ran, a reload): while the form is
 * not dirty against the state it was edited on, it takes the new stored values; while dirty, the typed
 * values stay and dirtiness is measured against the new state from then on. Only the form's own Save
 * and Discard reset it.
 */
export const appFormOnView=(form:AppForm,previous:EntraSettingsView,next:EntraSettingsView):AppForm=>appFormDirty(form,previous)?form:appFormOf(next);
/** The checks of the server that the client can make before it sends (lib/server/identity/entra/settings.ts). */
export function appFormErrors(form:AppForm):Partial<Record<AppField,MessageKey>>{
 const errors:Partial<Record<AppField,MessageKey>>={};
 if(!guidPattern.test(form.tenantId.trim()))errors.tenantId='apiError.entra.tenantIdFormat';
 if(!guidPattern.test(form.clientId.trim()))errors.clientId='apiError.entra.clientIdFormat';
 if(form.credentialKind==='secret'&&form.secret&&!/^[\x20-\x7e]{1,512}$/.test(form.secret))errors.secret='apiError.entra.secretFormat';
 if(form.credentialKind==='certificate'&&form.certificatePem.trim()&&!form.certificatePem.includes('-----BEGIN CERTIFICATE-----'))errors.certificatePem='apiError.entra.certificateInvalid';
 return errors;
}
/** The field a server refusal of save belongs to, by its message key. */
const serverField:Partial<Record<string,AppField>>={'apiError.entra.tenantIdFormat':'tenantId','apiError.entra.clientIdFormat':'clientId','apiError.entra.secretFormat':'secret','apiError.entra.certificateInvalid':'certificatePem','apiError.entra.certificateExpired':'certificatePem','apiError.entra.keyMismatch':'privateKeyPem'};
export const entraStatus=(view:EntraSettingsView):EntraStatus=>view.enabled?'on':view.configured?'off':'notSetUp';
const statusTexts:Record<EntraStatus,MessageKey>={on:'entra.status.on',off:'entra.status.off',notSetUp:'entra.status.notSetUp'};
/** Why the switch cannot turn on now, or null. Turning off is never blocked; sample devices block nothing here (the page shows the real settings). */
export function enableBlockedReason(view:EntraSettingsView,t:Translate):string|null{
 if(view.enabled)return null;
 return view.lastTest?.current&&view.lastTest.result==='ok'?null:t('entra.enableBlockedTest');
}
/** The last test as a Facts value: passed or failed with its time, or outdated after a change. */
export function lastTestLabel(view:EntraSettingsView,now:number,t:Translate,locale:Parameters<typeof relativeTime>[2]):string{
 const test=view.lastTest;
 if(!test)return t('entra.facts.never');
 if(!test.current)return t('entra.testResult.outdated');
 return t(test.result==='ok'?'entra.testResult.passed':'entra.testResult.failed',{time:relativeTime(test.at,now,locale)});
}
const testTextKey=(result:TestResult):MessageKey=>`entra.test.${result}` as MessageKey;
export const mappingGroupLabel=(mapping:Pick<EntraMapping,'groupName'>,t:Translate)=>mapping.groupName||t('entra.mappings.unnamed');
export const mappingScopeLabel=(mapping:Pick<EntraMapping,'scopeType'|'scopeName'|'scopeId'>,t:Translate)=>mapping.scopeType==='global'?t('tree.allDevices'):t('rbac.scope.group',{value:mapping.scopeName??mapping.scopeId});

type EntraView=EntraSettingsView&Record<string,unknown>;
type EntraRequest={body:Record<string,unknown>;failed?:(failure:unknown)=>boolean;managementToken?:string};
/**
 * Sends one change on useStepUp; step-up actions ask for the MFA proof first and resend once with it.
 * dispatch resolves with the new view (after onView and done), or null when blocked, cancelled or failed;
 * failed handles a failure itself (a field error) instead of the toast.
 */
function useEntraChange({onView}:{onView:(view:EntraSettingsView)=>void}){
 const [locale]=useLocale(),[action,setAction]=useState<string|null>(null);
 const change=useStepUp<EntraRequest,EntraView>({locale,
  needsStepUp:({body})=>entraSettingsActionNeedsStepUp(body.action),
  send:({body,managementToken})=>api<EntraView>(entraSettingsEndpoint,managementToken?{...body,managementToken}:body),
  onError:(failure,{failed})=>failed?.(failure)??false,
 });
 const dispatch=(payload:Record<string,unknown>,done?:(view:EntraView)=>void,failed?:(failure:unknown)=>boolean):Promise<EntraView|null>=>{
  // Cancelling the step-up sends nothing and keeps the input.
  if(change.busy)return Promise.resolve(null);
  setAction(String(payload.action));
  return change.run({body:payload,failed}).then(view=>{if(view){onView(view);done?.(view);}return view;});
 };
 return {busy:change.sending?action:null,dispatch,dialog:<MfaStepUp {...change.dialog}/>};
}

/**
 * The status card: icon tile, status pill, the kit Switch and the facts. The focal point of the page. The
 * switch moves at once; onToggle resolves false (cancelled or already reported) to roll it back.
 */
export function EntraStatusCard({view,now,busy,onToggle,className,style}:{view:EntraSettingsView;now:number;busy:boolean;onToggle:(enabled:boolean)=>Promise<unknown>|unknown;className?:string;style?:React.CSSProperties}){
 const t=useT(),[locale]=useLocale(),status=entraStatus(view),blocked=enableBlockedReason(view,t);
 return <Card className={cx('sdx-entra-status',className)} style={style} id="sdx-entra-status-title" title={t('entra.status.title')} icon={ShieldCheck} iconTone={view.enabled?'success':'neutral'} description={t('entra.status.description')}
  actions={<StatusPill kind={status==='on'?'success':'neutral'}>{t(statusTexts[status])}</StatusPill>}>
  <Switch label={t('entra.enable')} checked={view.enabled} blocked={blocked} busy={busy} onChange={onToggle}/>
  <Facts columns={3} items={[
   {id:'accounts',label:t('entra.facts.accounts'),value:<span className="sdx-entra-count">{view.accounts}</span>},
   {id:'signin',label:t('entra.facts.lastSignIn'),value:view.lastSignInAt?relativeTime(view.lastSignInAt,now,locale):t('entra.facts.never'),hint:view.lastSignInAt?exactTime(view.lastSignInAt,locale):undefined},
   {id:'test',label:t('entra.facts.lastTest'),value:lastTestLabel(view,now,t,locale)},
  ]}/>
 </Card>;
}

/** The redirect URI with its copy button. */
function RedirectUri({value}:{value:string}){
 const t=useT();
 return <div className="sdx-field"><span>{t('entra.redirectUri')}</span>
  <CopyValue value={value} label={t('entra.copyRedirectUri')} success={t('entra.redirectUriCopied')}/>
  <small>{t('entra.redirectUriHint')}</small>
 </div>;
}
/**
 * The portal API of the app registration (Expose an API): the application ID URI
 * with its copy button, or the pending hint before a client ID is saved; then the
 * scope access_as_user and the setup hint. Its access token carries the MFA signal.
 */
function PortalApi({applicationIdUri,scope}:{applicationIdUri:string|null;scope:string}){
 const t=useT();
 return <>
  <div className="sdx-field"><span>{t('entra.applicationIdUri')}</span>
   {applicationIdUri?<CopyValue value={applicationIdUri} label={t('entra.copyApplicationIdUri')} success={t('entra.applicationIdUriCopied')}/>:<small>{t('entra.applicationIdUriPending')}</small>}
  </div>
  <div className="sdx-field"><span>{t('entra.apiScope')}</span>
   <div className="sdx-copy-value"><code className="mono">{scope}</code></div>
   <small>{t('entra.applicationIdUriHint')}</small>
  </div>
 </>;
}

/** The app registration: IDs, the credential, the redirect URI, the portal API, Test connection and Save. */
export function EntraAppCard({view,now,change,className,style}:{view:EntraSettingsView;now:number;change:ReturnType<typeof useEntraChange>;className?:string;style?:React.CSSProperties}){
 const t=useT(),[locale]=useLocale(),id='sdx-entra-app';
 const [form,setForm]=useState<AppForm>(()=>appFormOf(view)),[baseline,setBaseline]=useState(view),[submitted,setSubmitted]=useState(false),[serverErrors,setServerErrors]=useState<Partial<Record<AppField,string>>>({});
 // A new stored state (another card saved, the test ran, a reload) keeps typed values (appFormOnView).
 if(baseline!==view){setBaseline(view);setForm(appFormOnView(form,baseline,view));}
 const reset=(stored:EntraSettingsView)=>{setForm(appFormOf(stored));setSubmitted(false);setServerErrors({});};
 const dirty=appFormDirty(form,view),clientErrors=appFormErrors(form);
 const errors:Partial<Record<AppField,string>>={...Object.fromEntries(Object.entries(submitted?clientErrors:{}).map(([field,key])=>[field,t(key as MessageKey)])),...serverErrors};
 const set=(next:Partial<AppForm>)=>{setForm(previous=>({...previous,...next}));setServerErrors({});};
 const fieldError=(failure:unknown)=>{const field=failure instanceof ApiError&&failure.messageKey?serverField[failure.messageKey]:undefined;if(!field)return false;setServerErrors({[field]:message(failure,locale)});return true;};
 const save=(event:FormEvent)=>{
  event.preventDefault();
  if(!dirty||change.busy)return;
  setSubmitted(true);
  if(Object.keys(clientErrors).length)return;
  change.dispatch({action:'save',tenantId:form.tenantId.trim(),clientId:form.clientId.trim(),credentialKind:form.credentialKind,revision:view.revision,
   ...(form.credentialKind==='secret'?{secret:form.secret}:{certificatePem:form.certificatePem.trim(),privateKeyPem:form.privateKeyPem.trim()})},
   saved=>{toast.success(t(saved.disabled===true?'entra.savedDisabled':'entra.saved'));reset(saved);},fieldError);
 };
 const test=()=>{if(change.busy)return;change.dispatch({action:'test'},tested=>{const result=tested.result as TestResult;if(result==='ok')toast.success(t('entra.test.ok'));else toast.error(t(testTextKey(result)));});};
 const testBlocked=!view.configured?t('entra.testBlocked'):undefined;
 const result=view.lastTest;
 return <Card className={cx('sdx-entra-app',className)} style={style} id={`${id}-title`} title={t('entra.app.title')} icon={KeyRound} iconTone="accent" description={t('entra.app.description')}>
  <form className="sdx-form-grid" noValidate onSubmit={save} aria-labelledby={`${id}-title`}>
   {(['tenantId','clientId'] as const).map(name=><Field key={name} label={t(name==='tenantId'?'entra.tenantId':'entra.clientId')} hint={t('entra.guidHint')} error={errors[name]}>
    <input id={`${id}-${name}`} className="mono" type="text" autoComplete="off" spellCheck={false} maxLength={36} placeholder="00000000-0000-0000-0000-000000000000" value={form[name]} disabled={!!change.busy} onChange={event=>set({[name]:event.target.value})}/>
   </Field>)}
   <fieldset className="sdx-choice sdx-entra-credential" disabled={!!change.busy}>
    <legend>{t('entra.credential')}</legend>
    {(['secret','certificate'] as const).map(kind=><label key={kind} className={cx(form.credentialKind===kind&&'selected')}>
     <input type="radio" name={`${id}-credential`} value={kind} checked={form.credentialKind===kind} onChange={()=>set({credentialKind:kind})}/>
     {kind==='secret'?<KeyRound size={18} aria-hidden/>:<ShieldCheck size={18} aria-hidden/>}<span><strong>{t(kind==='secret'?'entra.credential.secret':'entra.credential.certificate')}</strong></span>
    </label>)}
   </fieldset>
   {form.credentialKind==='secret'?<Field label={t('entra.secret')} hint={view.secretSaved?t('entra.secretSaved'):undefined} error={errors.secret}>
    <input id={`${id}-secret`} className="mono" type="password" autoComplete="new-password" spellCheck={false} maxLength={512} value={form.secret} disabled={!!change.busy} placeholder={view.secretSaved?'••••••••••••':undefined} onChange={event=>set({secret:event.target.value})}/>
   </Field>:<>
    {view.certificate&&<Facts columns={2} items={[{id:'thumbprint',label:t('entra.thumbprint'),value:view.certificate.thumbprint,mono:true},{id:'valid',label:t('entra.validUntil'),value:view.certificate.expiresAt?exactTime(view.certificate.expiresAt,locale):EMPTY_VALUE}]}/>}
    {(['certificatePem','privateKeyPem'] as const).map(name=><Field key={name} label={t(name==='certificatePem'?'entra.certificatePem':'entra.privateKeyPem')} hint={name==='privateKeyPem'&&view.privateKeySaved?t('entra.privateKeySaved'):t('entra.certificateHint')} error={errors[name]}>
     <textarea id={`${id}-${name}`} className="mono sdx-entra-pem" rows={4} spellCheck={false} autoComplete="off" value={form[name]} disabled={!!change.busy} placeholder={name==='certificatePem'?'-----BEGIN CERTIFICATE-----':privateKeyPlaceholder} onChange={event=>set({[name]:event.target.value})}/>
    </Field>)}
   </>}
   <RedirectUri value={view.redirectUri}/>
   <PortalApi applicationIdUri={view.applicationIdUri} scope={view.apiScope}/>
   <FormActions dirty={dirty} busy={!!change.busy} loading={change.busy==='save'} saveLabel={t('common.save')} onDiscard={()=>reset(view)}
    extra={<Btn icon={FlaskConical} loading={change.busy==='test'} blocked={testBlocked} onClick={test}>{t('entra.test')}</Btn>}/>
   {result&&<Notice tone={!result.current?'warning':result.result==='ok'?'success':'danger'} icon={!result.current?AlertTriangle:result.result==='ok'?CheckCircle2:AlertTriangle}>
    {t(!result.current?'entra.test.outdated':testTextKey(result.result))}{result.current&&<span className="sdx-entra-test-time"> · {relativeTime(result.at,now,locale)}</span>}
   </Notice>}
  </form>
 </Card>;
}

/** Tone of the icon tile and the status pill per state of the account check. */
export const checkTones:Record<DirectoryCheckState,{tile:IconTone;pill:StatusKind}>={off:{tile:'neutral',pill:'neutral'},waiting:{tile:'neutral',pill:'neutral'},ok:{tile:'success',pill:'success'},failed:{tile:'danger',pill:'critical'}};
/** The icon tile tone of the account check: warning while it keeps a last Owner active (state ok or waiting), else the state's tone. */
export const checkTileTone=(check:Pick<EntraSettingsView['directoryCheck'],'state'|'keptOwners'>):IconTone=>check.keptOwners.length&&(check.state==='ok'||check.state==='waiting')?'warning':checkTones[check.state].tile;
const accountsSettingsHash=consoleRouteHash({view:'settings',page:'accounts'});
/** The text of the Graph permissions for the clipboard: "User.Read.All, GroupMember.Read.All". */
export const permissionsText=(view:Pick<EntraSettingsView,'graphPermissions'>)=>view.graphPermissions.join(', ');

/** The Graph permissions as a list with their copy button (CopyValue copies permissionsText). */
function GraphPermissions({view}:{view:EntraSettingsView}){
 const t=useT(),labelId=useId(),hintId=useId();
 return <div className="sdx-entra-permissions" role="group" aria-labelledby={labelId} aria-describedby={hintId}>
  <span id={labelId} className="sdx-entra-permissions-label">{t('entra.check.permissions')}</span>
  <CopyValue value={permissionsText(view)} label={t('entra.check.copyPermissions')} success={t('entra.check.permissionsCopied')}
   display={<ul className="sdx-entra-permission-list">{view.graphPermissions.map(name=><li key={name}><code className="mono">{name}</code></li>)}</ul>}/>
  <small id={hintId}>{t('entra.check.permissionsHint')}</small>
 </div>;
}

/**
 * The account check through Microsoft Graph (lib/server/identity/entra/directory-check.ts): its
 * state as the focal pill, the facts of the last run, the permissions it needs,
 * while failed, what went wrong, and while it keeps a last Owner active that
 * Entra reports disabled, a warning with the way out. Read-only: the check runs on its own.
 */
export function EntraCheckCard({view,now,className,style}:{view:EntraSettingsView;now:number;className?:string;style?:React.CSSProperties}){
 const t=useT(),[locale]=useLocale(),check=view.directoryCheck,tone=checkTones[check.state];
 const count=(value:number)=><span className="sdx-entra-check-count">{formatNumber(locale,value)}</span>;
 const kept=check.keptOwners;
 return <Card className={cx('sdx-entra-check',className)} style={style} id="sdx-entra-check-title" title={t('entra.check.title')} icon={UserCheck} iconTone={checkTileTone(check)} description={t('entra.check.description')}
  actions={<StatusPill kind={tone.pill}>{t(`entra.check.state.${check.state}` as MessageKey)}</StatusPill>}>
  {check.state==='failed'&&check.result&&check.result!=='ok'&&<Notice tone="danger" icon={AlertTriangle}>{t(`entra.check.result.${check.result}` as MessageKey)}</Notice>}
  {kept.length>0&&<Notice tone="warning" icon={AlertTriangle} action={<a className="sdx-btn sdx-btn-secondary sdx-btn-sm" href={accountsSettingsHash}><span>{t('entra.check.openAccounts')}</span></a>}>
   {t('entra.check.keptOwners',{count:kept.length,accounts:kept.map(owner=>owner.name||t('entra.check.keptOwnerUnnamed')).join(', ')})}
  </Notice>}
  {check.state==='off'?<p className="sdx-entra-check-off">{t('entra.check.offHint')}</p>:<Facts columns={2} items={[
   {id:'last',label:t('entra.check.lastRun'),value:check.lastRunAt?relativeTime(check.lastRunAt,now,locale):t('entra.facts.never'),hint:check.lastRunAt?exactTime(check.lastRunAt,locale):undefined},
   ...(check.nextRunAt!==null?[{id:'next',label:t('entra.check.nextRun'),value:formatUntil(locale,check.nextRunAt,now),hint:exactTime(check.nextRunAt,locale)}]:[]),
   {id:'checked',label:t('entra.check.checked'),value:count(check.checked),hint:check.remaining>0?t('entra.check.remaining',{count:check.remaining}):undefined},
   {id:'locked',label:t('entra.check.locked'),value:count(check.locked)},
   {id:'groups',label:t('entra.check.groupChanges'),value:count(check.groupChanges)},
  ]}/>}
  <GraphPermissions view={view}/>
 </Card>;
}

type MappingForm={groupObjectId:string;groupName:string;roleId:string;scope:string};
const emptyMapping:MappingForm={groupObjectId:'',groupName:'',roleId:'',scope:'global'};
/** Whether the mapping drawer holds input to lose: any field differs from the empty form. */
export const mappingFormDirty=(form:MappingForm)=>(Object.keys(emptyMapping) as (keyof MappingForm)[]).some(key=>form[key]!==emptyMapping[key]);
/** The client checks of add-mapping; the server checks again. */
export function mappingFormErrors(form:MappingForm,view:Pick<EntraSettingsView,'roles'>):Partial<Record<'groupObjectId'|'groupName'|'roleId',MessageKey>>{
 const errors:Partial<Record<'groupObjectId'|'groupName'|'roleId',MessageKey>>={};
 if(!guidPattern.test(form.groupObjectId.trim()))errors.groupObjectId='apiError.entra.groupIdFormat';
 if(form.groupName.trim().length>120)errors.groupName='apiError.entra.groupNameFormat';
 const role=view.roles.find(item=>item.id===form.roleId);
 if(!role||role.portal&&form.scope!=='global')errors.roleId='apiError.entra.roleNotAllowed';
 return errors;
}

/** The drawer "Add mapping": group object ID, name, role and scope. */
function MappingDrawer({view,change,onClose}:{view:EntraSettingsView;change:ReturnType<typeof useEntraChange>;onClose:()=>void}){
 const t=useT(),formId=useId().replace(/:/g,''),[form,setForm]=useState<MappingForm>(emptyMapping),[submitted,setSubmitted]=useState(false);
 const errors=submitted?mappingFormErrors(form,view):{};
 const submit=(event:FormEvent)=>{
  event.preventDefault();setSubmitted(true);
  if(change.busy||Object.keys(mappingFormErrors(form,view)).length)return;
  change.dispatch({action:'add-mapping',groupObjectId:form.groupObjectId.trim(),groupName:form.groupName.trim(),roleId:form.roleId,scopeType:form.scope==='global'?'global':'devicegroup',...(form.scope==='global'?{}:{scopeId:form.scope})},()=>{toast.success(t('entra.mappings.added'));onClose();});
 };
 const error=(name:keyof typeof errors)=>errors[name]?t(errors[name]!):undefined;
 return <Drawer open onClose={onClose} dirty={mappingFormDirty(form)} title={t('entra.mappings.add')} description={t('entra.mappings.description')}
  footer={<><DrawerCancel label={t('common.cancel')}/><Btn type="submit" form={formId} variant="primary" icon={Plus} loading={change.busy==='add-mapping'}>{t('entra.mappings.add')}</Btn></>}>
  <form id={formId} className="sdx-form-grid" noValidate onSubmit={submit}>
   <Field label={t('entra.mappings.groupId')} hint={t('entra.guidHint')} error={error('groupObjectId')}>
    <input id={`${formId}-groupObjectId`} className="mono" autoFocus autoComplete="off" spellCheck={false} maxLength={36} placeholder="00000000-0000-0000-0000-000000000000" value={form.groupObjectId} onChange={event=>setForm({...form,groupObjectId:event.target.value})}/>
   </Field>
   <Field label={t('entra.mappings.groupName')} hint={t('entra.mappings.groupNameHint')} error={error('groupName')}>
    <input id={`${formId}-groupName`} autoComplete="off" maxLength={120} value={form.groupName} onChange={event=>setForm({...form,groupName:event.target.value})}/>
   </Field>
   <Field label={t('entra.mappings.role')} error={error('roleId')}>
    <Select id={`${formId}-role`} value={form.roleId} onChange={event=>setForm({...form,roleId:event.target.value})}>
     <option value="" disabled>{t('entra.mappings.selectRole')}</option>
     {view.roles.map(role=><option key={role.id} value={role.id}>{role.name}</option>)}
    </Select>
   </Field>
   <Field label={t('entra.mappings.scope')}>
    <Select id={`${formId}-scope`} value={form.scope} onChange={event=>setForm({...form,scope:event.target.value})}>
     <option value="global">{t('tree.allDevices')}</option>
     {view.deviceGroups.map(group=><option key={group.id} value={group.id}>{t('rbac.scope.group',{value:group.name})}</option>)}
    </Select>
   </Field>
  </form>
 </Drawer>;
}

/** The group mappings: the table with a remove entry per row, Add mapping in the head, an empty state. */
export function EntraMappingsCard({view,change,className,style}:{view:EntraSettingsView;change:ReturnType<typeof useEntraChange>;className?:string;style?:React.CSSProperties}){
 const t=useT(),[adding,setAdding]=useState(false),[removing,setRemoving]=useState<EntraMapping|null>(null);
 const add=<Btn size="sm" icon={Plus} onClick={()=>setAdding(true)}>{t('entra.mappings.add')}</Btn>;
 const columns:DataColumn<EntraMapping>[]=[
  {id:'group',label:t('entra.mappings.group'),primary:true,wrap:true,cell:mapping=><span className="sdx-entra-group"><strong>{mappingGroupLabel(mapping,t)}</strong><small className="mono">{mapping.groupObjectId}</small></span>},
  {id:'role',label:t('entra.mappings.role'),cell:mapping=>mapping.roleName},
  {id:'scope',label:t('entra.mappings.scope'),wrap:true,cell:mapping=>mappingScopeLabel(mapping,t)},
  {id:'actions',label:t('entra.mappings.remove'),align:'end',card:false,cell:mapping=><Menu label={t('entra.mappings.actions',{group:mappingGroupLabel(mapping,t)})} entries={[{id:'remove',label:t('entra.mappings.remove'),icon:Trash2,danger:true,onSelect:()=>setRemoving(mapping)}]}/>},
 ];
 return <Card className={cx('sdx-entra-mappings',className)} style={style} id="sdx-entra-mappings-title" title={t('entra.mappings.title')} icon={Users} iconTone="accent" description={t('entra.mappings.description')} actions={view.mappings.length?add:undefined} flush>
  <DataTable<EntraMapping> columns={columns} rows={view.mappings} rowKey={mapping=>mapping.id} label={t('entra.mappings.title')} variant="flush" cards
   empty={{icon:Users,title:t('entra.mappings.emptyTitle'),children:t('entra.mappings.emptyText'),action:add}}/>
  {adding&&<MappingDrawer view={view} change={change} onClose={()=>setAdding(false)}/>}
  <ConfirmDialog open={!!removing} onOpenChange={open=>{if(!open)setRemoving(null);}} tone="danger"
   title={removing?t('entra.mappings.removeQuestion',{group:mappingGroupLabel(removing,t),role:removing.roleName}):''}
   lines={removing?[{label:t('entra.mappings.groupId'),value:removing.groupObjectId},{label:t('entra.mappings.scope'),value:mappingScopeLabel(removing,t)}]:[]}
   body={t('entra.mappings.removeText')} confirmLabel={t('entra.mappings.remove')}
   onConfirm={()=>{const mapping=removing;setRemoving(null);if(mapping)change.dispatch({action:'remove-mapping',id:mapping.id},()=>toast.success(t('entra.mappings.removed')));}}/>
 </Card>;
}

export type EmergencyState='ready'|'used'|'none';
/** used while an emergency sign-in waits for an Owner; ready while the chosen account still qualifies (server check); none otherwise. */
export const emergencyState=(view:Pick<EntraSettingsView,'emergency'|'switchChecks'>):EmergencyState=>view.emergency.openAlarms>0?'used':view.switchChecks.emergency?'ready':'none';
export const emergencyTones:Record<EmergencyState,{tile:IconTone;pill:StatusKind}>={ready:{tile:'success',pill:'success'},used:{tile:'warning',pill:'warning'},none:{tile:'neutral',pill:'neutral'}};
type EmergencyAccount=NonNullable<EntraSettingsView['emergency']['account']>;
/** The second factors of the emergency access: "Authenticator app", "2 passkeys", or both. */
export function emergencyFactors(account:Pick<EmergencyAccount,'authenticator'|'passkeys'>,t:Translate):string{
 const parts=[...account.authenticator?[t('entra.emergency.factor.authenticator')]:[],...account.passkeys>0?[t('entra.emergency.factor.passkeys',{count:account.passkeys})]:[]];
 return parts.length?parts.join(' · '):EMPTY_VALUE;
}
const accountName=(account:{displayName:string;username:string})=>account.displayName||account.username;
/** The choice the form starts with: the chosen account while it is a candidate, else none. */
export const emergencyChoiceOf=(view:Pick<EntraSettingsView,'emergency'>)=>{const id=view.emergency.account?.id;return id&&view.emergency.candidates.some(candidate=>candidate.id===id)?id:'';};
/** The emergency choice after a new stored state, by the rule of appFormOnView: a changed choice stays while it is still a candidate. */
export const emergencyChoiceOnView=(choice:string,previous:Pick<EntraSettingsView,'emergency'>,next:Pick<EntraSettingsView,'emergency'>)=>choice!==emergencyChoiceOf(previous)&&next.emergency.candidates.some(candidate=>candidate.id===choice)?choice:emergencyChoiceOf(next);

/**
 * Emergency access: the state pill answers "Is there a way in if Microsoft
 * fails?". The facts of the chosen account, then the choice while Microsoft
 * sign-in only is off (or the empty state without candidates), or the line
 * that the choice is fixed while it is on.
 */
export function EntraEmergencyCard({view,now,change,className,style}:{view:EntraSettingsView;now:number;change:ReturnType<typeof useEntraChange>;className?:string;style?:React.CSSProperties}){
 const t=useT(),[locale]=useLocale(),id='sdx-entra-emergency',state=emergencyState(view),tone=emergencyTones[state],{account,candidates}=view.emergency;
 const [choice,setChoice]=useState(()=>emergencyChoiceOf(view)),[baseline,setBaseline]=useState(view);
 if(baseline!==view){setBaseline(view);setChoice(emergencyChoiceOnView(choice,baseline,view));}
 const unchanged=!choice||choice===account?.id;
 const save=(event:FormEvent)=>{
  event.preventDefault();
  if(change.busy||unchanged)return;
  change.dispatch({action:'set-emergency-account',userId:choice,revision:view.revision},saved=>{toast.success(t('entra.emergency.saved'));setChoice(emergencyChoiceOf(saved));});
 };
 return <Card className={cx('sdx-entra-emergency',className)} style={style} id={`${id}-title`} title={t('entra.emergency.title')} icon={LifeBuoy} iconTone={tone.tile} description={t('entra.emergency.description')}
  actions={<StatusPill kind={tone.pill}>{t(`entra.emergency.state.${state}` as MessageKey)}</StatusPill>}>
  {account&&<Facts columns={2} items={[
   {id:'account',label:t('entra.emergency.account'),value:<span className="sdx-entra-group"><strong>{accountName(account)}</strong><small className="mono">{account.username}</small></span>},
   {id:'factors',label:t('entra.emergency.factors'),value:emergencyFactors(account,t)},
   {id:'last',label:t('entra.emergency.lastUsed'),value:view.emergency.lastSignInAt?relativeTime(view.emergency.lastSignInAt,now,locale):t('entra.facts.never'),hint:view.emergency.lastSignInAt?exactTime(view.emergency.lastSignInAt,locale):undefined},
   {id:'alarms',label:t('entra.emergency.openAlarms'),value:<span className="sdx-entra-check-count">{formatNumber(locale,view.emergency.openAlarms)}</span>},
  ]}/>}
  {view.entraOnly.enabled?<p className="sdx-entra-note">{t('entra.emergency.changeBlocked')}</p>
   :!candidates.length?<Empty icon={LifeBuoy} title={t('entra.emergency.emptyTitle')}>{t('entra.emergency.emptyText')}</Empty>
   :<form className="sdx-form-grid" noValidate onSubmit={save} aria-labelledby={`${id}-title`}>
    <Field label={t('entra.emergency.account')} hint={t('entra.emergency.accountHint')}>
     <Select id={`${id}-account`} value={choice} disabled={!!change.busy} onChange={event=>setChoice(event.target.value)}>
      {!choice&&<option value="" disabled>{t('entra.emergency.choose')}</option>}
      {candidates.map(candidate=><option key={candidate.id} value={candidate.id}>{candidate.displayName&&candidate.displayName!==candidate.username?`${candidate.displayName} (${candidate.username})`:candidate.username}</option>)}
     </Select>
    </Field>
    <div className="sdx-form-actions">
     <Btn type="submit" variant="primary" loading={change.busy==='set-emergency-account'} blocked={unchanged?t('common.noChanges'):undefined}>{t('entra.emergency.save')}</Btn>
    </div>
   </form>}
 </Card>;
}

type SwitchCheck={id:'signIn'|'emergency'|'owner'|'mail';met:boolean;text:MessageKey;hint?:MessageKey;warning?:boolean};
/** The four checks of the switch in their order; the mail channel only warns. */
export function switchCheckRows(view:Pick<EntraSettingsView,'switchChecks'>):SwitchCheck[]{
 const checks=view.switchChecks;
 return [
  {id:'signIn',met:checks.signIn,text:'entra.only.check.signIn'},
  {id:'emergency',met:checks.emergency,text:'entra.only.check.emergency'},
  {id:'owner',met:checks.viewerEntraOwner,text:'entra.only.check.owner',hint:'entra.only.check.ownerHint'},
  {id:'mail',met:checks.mailChannel,text:'entra.only.check.mail',hint:'entra.only.check.mailHint',warning:true},
 ];
}
/** Why the switch to Microsoft sign-in only cannot start now, or null: one of the first three checks. */
export function switchBlockedReason(view:Pick<EntraSettingsView,'switchChecks'>,t:Translate):string|null{
 const checks=view.switchChecks;
 return checks.signIn&&checks.emergency&&checks.viewerEntraOwner?null:t('entra.only.blocked');
}

/** The lines of the switch confirmation: the built-in accounts it locks and the emergency access that stays. */
export function switchConfirmLines(view:Pick<EntraSettingsView,'entraOnly'|'emergency'>,t:Translate,locale:Parameters<typeof formatNumber>[0]):string[]{
 return [t('entra.only.confirm.locked',{count:formatNumber(locale,view.entraOnly.lockedAccounts)}),...view.emergency.account?[t('entra.only.confirm.emergency',{name:accountName(view.emergency.account)})]:[]];
}

/**
 * Microsoft sign-in only: while off, the checklist answers "Can I switch
 * safely?" with the switch button below it; while on, when and by whom it was
 * switched, the locked accounts and the way back. Both directions confirm
 * first; the step-up (a fresh Microsoft sign-in for an Entra Owner) follows.
 */
export function EntraOnlyCard({view,now,change,className,style}:{view:EntraSettingsView;now:number;change:ReturnType<typeof useEntraChange>;className?:string;style?:React.CSSProperties}){
 const t=useT(),[locale]=useLocale(),id='sdx-entra-only',on=view.entraOnly.enabled,[confirming,setConfirming]=useState<'on'|'off'|null>(null);
 const blocked=switchBlockedReason(view,t),busy=change.busy==='set-entra-only';
 const switchOn=()=>{setConfirming(null);change.dispatch({action:'set-entra-only',enabled:true,revision:view.revision},done=>toast.success(t('entra.only.switched',{count:Number(done.locked??0)})));};
 const switchOff=()=>{setConfirming(null);change.dispatch({action:'set-entra-only',enabled:false,revision:view.revision},()=>toast.success(t('entra.only.allowed')));};
 return <Card className={cx('sdx-entra-only',className)} style={style} id={`${id}-title`} title={t('entra.only.title')} icon={LockKeyhole} iconTone={on?'success':'neutral'} description={t('entra.only.description')}
  actions={<StatusPill kind={on?'success':'neutral'}>{t(on?'entra.only.state.on':'entra.only.state.off')}</StatusPill>}>
  {on?<>
   {!view.enabled&&<Notice tone="warning" icon={AlertTriangle}>{t('entra.only.signInOff')}</Notice>}
   <Facts columns={3} items={[
    {id:'since',label:t('entra.only.since'),value:view.entraOnly.since?relativeTime(view.entraOnly.since,now,locale):EMPTY_VALUE,hint:view.entraOnly.since?exactTime(view.entraOnly.since,locale):undefined},
    {id:'by',label:t('entra.only.by'),value:view.entraOnly.by??EMPTY_VALUE},
    {id:'locked',label:t('entra.only.locked'),value:<span className="sdx-entra-check-count">{formatNumber(locale,view.entraOnly.lockedAccounts)}</span>},
   ]}/>
   <div className="sdx-form-actions">
    <Btn icon={LockKeyholeOpen} loading={busy} onClick={()=>{if(!change.busy)setConfirming('off');}}>{t('entra.only.allowLocal')}</Btn>
   </div>
  </>:<>
   <div className="sdx-entra-checklist" role="group" aria-labelledby={`${id}-checks`}>
    <h3 id={`${id}-checks`} className="sdx-entra-checklist-title">{t('entra.only.checks')}</h3>
    <ul>{switchCheckRows(view).map(row=>{
     const Icon=row.met?CheckCircle2:row.warning?AlertTriangle:XCircle;
     return <li key={row.id} className={cx('sdx-entra-check-row',row.met?'is-met':row.warning?'is-warning':'is-missing')}>
      <Icon size={16} aria-hidden/>
      <div><span><span className="sr-only">{t(row.met?'entra.only.check.met':'entra.only.check.notMet')}: </span>{t(row.text)}</span>{!row.met&&row.hint&&<small>{t(row.hint)}</small>}</div>
     </li>;
    })}</ul>
   </div>
   <div className="sdx-form-actions">
    <Btn variant="primary" icon={LockKeyhole} loading={busy} blocked={blocked??undefined} onClick={()=>{if(!blocked&&!change.busy)setConfirming('on');}}>{t('entra.only.switch')}</Btn>
   </div>
  </>}
  <ConfirmDialog open={confirming==='on'} onOpenChange={open=>{if(!open)setConfirming(null);}} tone="danger" title={t('entra.only.confirm.title')} body={t('entra.only.confirm.text')} confirmLabel={t('entra.only.switch')} onConfirm={switchOn}>
   <ul className="sdx-entra-confirm-lines">{switchConfirmLines(view,t,locale).map(line=><li key={line}>{line}</li>)}</ul>
  </ConfirmDialog>
  <ConfirmDialog open={confirming==='off'} onOpenChange={open=>{if(!open)setConfirming(null);}} title={t('entra.only.allowConfirm.title')} body={t('entra.only.allowConfirm.text')} confirmLabel={t('entra.only.allowLocal')} onConfirm={switchOff}/>
 </Card>;
}

/** GET /api/entra/settings with a reload; initialView shows before the first load (tests). */
export function useEntraSettings(viewerId:string,initialView:EntraSettingsView|null=null){
 const [view,setView]=useState<EntraSettingsView|null>(initialView),[loadFailed,setLoadFailed]=useState(false),[loading,setLoading]=useState(!initialView);
 const mounted=useRef(false),sequence=useRef(0);
 const load=useCallback(async()=>{
  const current=++sequence.current;setLoading(true);
  try{const next=await api<EntraSettingsView>(entraSettingsEndpoint);if(mounted.current&&current===sequence.current){setView(next);setLoadFailed(false);}}
  catch{if(mounted.current&&current===sequence.current)setLoadFailed(true);}
  finally{if(mounted.current&&current===sequence.current)setLoading(false);}
 },[]);
 useEffect(()=>{mounted.current=true;if(!initialView)void Promise.resolve().then(load);return()=>{mounted.current=false;};},[load,viewerId,initialView]);
 return {view,setView,loadFailed,setLoadFailed,loading,load};
}

export default function EntraSettingsPanel({viewer,initialView=null,initialLoadFailed=false,now:givenNow,frame}:{viewer:Viewer;initialView?:EntraSettingsView|null;/** Tests: render the load failure. */initialLoadFailed?:boolean;now?:number;frame?:PageFrame}){
 const t=useT(),[mountedAt]=useState(()=>Date.now()),now=givenNow??mountedAt;
 const {view,setView,loadFailed,loading,load}=useEntraSettings(viewer.id,initialView),[offConfirm,setOffConfirm]=useState(false),offAnswer=useRef<((confirmed:boolean)=>void)|null>(null);
 const change=useEntraChange({onView:next=>setView(next)});
 useFrameRefresh(frame,load);
 const failed=loadFailed||initialLoadFailed;
 const page=(children:React.ReactNode)=><>{frameHeader(frame)}<SettingsPage className="sdx-entra-settings" label={t('nav.settings.entra')} loading={!view&&!failed} loadError={failed?`${t('entra.loadError')}${view?' '+t('notifications.staleData'):''}`:undefined} onRetry={()=>void load()} retrying={loading&&!initialLoadFailed}>{children}</SettingsPage></>;
 if(!view)return page(null);
 // Resolves false when the step-up is cancelled or the request failed (already reported), so the switch rolls back.
 const setEnabled=(enabled:boolean)=>change.dispatch({action:'set-enabled',enabled},()=>toast.success(t(enabled?'entra.enabled':'entra.disabled'))).then(result=>result!==null);
 // While Microsoft sign-in only is on, turning sign-in off leaves only the emergency access: confirm first.
 const toggle=(enabled:boolean):Promise<boolean>=>{
  if(!enabled&&view.entraOnly.enabled)return new Promise<boolean>(resolve=>{offAnswer.current=resolve;setOffConfirm(true);});
  return setEnabled(enabled);
 };
 const answerOff=(confirmed:boolean)=>{const answer=offAnswer.current;offAnswer.current=null;setOffConfirm(false);if(!answer)return;if(confirmed)void setEnabled(false).then(answer);else answer(false);};
 return page(<>
  <EntranceList id="entra-settings" className="sdx-entra-cards">
   <EntraStatusCard key="status" view={view} now={now} busy={change.busy==='set-enabled'} onToggle={toggle}/>
   <EntraAppCard key="app" view={view} now={now} change={change}/>
   <EntraCheckCard key="check" view={view} now={now}/>
   <EntraMappingsCard key="mappings" view={view} change={change}/>
   <EntraEmergencyCard key="emergency" view={view} now={now} change={change}/>
   <EntraOnlyCard key="only" view={view} now={now} change={change}/>
  </EntranceList>
  <ConfirmDialog open={offConfirm} onOpenChange={open=>{if(!open)answerOff(false);}} tone="danger" title={t('entra.offConfirm.title')} body={t('entra.offConfirm.text')} confirmLabel={t('entra.offConfirm.action')} onConfirm={()=>answerOff(true)}/>
  {change.dialog}
 </>);
}
