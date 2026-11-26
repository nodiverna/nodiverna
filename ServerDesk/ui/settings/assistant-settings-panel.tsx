'use client';
import {useCallback,useEffect,useId,useRef,useState,type FormEvent} from 'react';
import {Bot,Building2,FlaskConical,KeyRound,Search,Sparkles,Trash2} from 'lucide-react';
import {toast} from 'sonner';
import type {Viewer} from '@/lib/types';
import type {AssistantCustomerKey,AssistantKeyView,AssistantSettingsView} from '@/lib/server/devices/assistant-settings';
import {assistantDefaultModels,assistantProviders,validAssistantKey,validAssistantModel,type AssistantProvider} from '@/lib/assistant-config';
import {assistantSettingsActionNeedsStepUp} from '@/lib/step-up';
import type {MessageKey} from '@/lib/i18n/translate';
import {api,ApiError,message} from '@/ui/base/api';
import {MfaStepUp} from '@/ui/session/mfa-step-up';
import {useStepUp} from '@/ui/session/step-up-retry';
import {frameHeader,useFrameRefresh,type PageFrame} from '@/ui/shell/page-frame';
import {Btn,Card,DangerZone,Drawer,DrawerCancel,SettingsPage,StatusPill,cx,relativeTime} from '@/ui/kit/kit';
import {ConfirmDialog} from '@/ui/kit/confirm-dialog';
import {DataTable,Toolbar,type DataColumn} from '@/ui/kit/data-table';
import {Field,FormActions} from '@/ui/kit/field';
import {useLocale,useT,type Translate} from '@/ui/base/locale';
import '@/ui/devices/assistant/assistant.css';
import {EMPTY_VALUE} from '@/lib/i18n/format';

// Settings → AI assistant (Owners only, docs/ai-assistant.md): the
// organization key and, once a second customer exists, one key per customer.
// The account page reuses the key card for the personal key
// (ui/account/personal-assistant-key.tsx). A key is write-only: the page
// learns provider, model and the last 4 characters. Saving the organization
// key or a customer key needs a fresh MFA proof (lib/step-up.ts, rule 6),
// through useStepUp; removing one only stops the assistant and needs none. With sample devices the page shows and changes
// the real settings.
export const assistantSettingsEndpoint='/api/assistant/settings';
export type KeyScope='organization'|'personal'|'customer';
export type KeyForm={provider:AssistantProvider;key:string;model:string};
type KeyField='provider'|'key'|'model';
export type KeyErrors=Partial<Record<KeyField,string>>;

/** The form of a stored key: its provider and model, the key field empty. Without a key: Claude with its default model. */
export const keyFormOf=(view:AssistantKeyView|null):KeyForm=>({provider:view?.provider??'anthropic',key:'',model:view?.model??assistantDefaultModels[view?.provider??'anthropic']});
export const keyFormDirty=(form:KeyForm,view:AssistantKeyView|null)=>{const base=keyFormOf(view);return form.provider!==base.provider||form.model!==base.model||form.key.trim()!=='';};
/** The client checks with the server rules (lib/assistant-config.ts). */
export function keyFormErrors(form:KeyForm,view:AssistantKeyView|null):Partial<Record<KeyField,MessageKey>>{
 const errors:Partial<Record<KeyField,MessageKey>>={},key=form.key.trim();
 if(!validAssistantModel(form.model.trim()))errors.model='assistantSettings.modelInvalid';
 if(key&&!validAssistantKey(form.provider,key))errors.key=form.provider==='anthropic'?'assistantSettings.keyInvalid.anthropic':'assistantSettings.keyInvalid.openai';
 else if(!key&&!view)errors.key='assistantSettings.keyRequired';
 else if(!key&&view&&view.provider!==form.provider)errors.key='assistantSettings.newKeyForProvider';
 return errors;
}
export const providerLabel=(provider:AssistantProvider,t:Translate)=>t(provider==='anthropic'?'assistant.provider.anthropic':'assistant.provider.openai');
const providerIcons={anthropic:Sparkles,openai:Bot} as const;

/** Provider, API key and model: the form block of every key card and the customer drawer. API key and Model are kit Fields. */
export function AssistantKeyFields({id,form,view,errors,disabled,onChange,autoFocus=false}:{id:string;form:KeyForm;view:AssistantKeyView|null;errors:KeyErrors;disabled:boolean;onChange:(form:KeyForm)=>void;autoFocus?:boolean}){
 const t=useT();
 const choose=(provider:AssistantProvider)=>{
  // A model that is still the default of the old provider follows the new provider.
  const model=form.model===assistantDefaultModels[form.provider]?assistantDefaultModels[provider]:form.model;
  onChange({...form,provider,model});
 };
 const saved=view&&view.provider===form.provider;
 return <>
  <fieldset className="sdx-choice sdx-assistant-providers" disabled={disabled} aria-describedby={errors.provider?`${id}-provider-error`:undefined}>
   <legend>{t('assistantSettings.provider')}</legend>
   {assistantProviders.map(provider=>{const Icon=providerIcons[provider];return <label key={provider} className={cx(form.provider===provider&&'selected')}>
    <input type="radio" name={`${id}-provider`} value={provider} checked={form.provider===provider} autoFocus={autoFocus&&form.provider===provider} onChange={()=>choose(provider)}/>
    <Icon size={18} aria-hidden/><span><strong>{providerLabel(provider,t)}</strong><small>{t(provider==='anthropic'?'assistantSettings.keyHint.anthropic':'assistantSettings.keyHint.openai')}</small></span>
   </label>;})}
   {errors.provider&&<span className="sdx-field-error" id={`${id}-provider-error`}>{errors.provider}</span>}
  </fieldset>
  <Field label={t('assistantSettings.key')} error={errors.key} hint={saved?t('assistantSettings.keySaved',{hint:view.keyHint}):t(form.provider==='anthropic'?'assistantSettings.keyHint.anthropic':'assistantSettings.keyHint.openai')}>
   <input id={`${id}-key`} className="mono" type="password" autoComplete="off" spellCheck={false} value={form.key} disabled={disabled}
    placeholder={saved?t('assistantSettings.keySaved',{hint:view.keyHint}):(form.provider==='anthropic'?'sk-ant-…':'sk-…')} onChange={event=>onChange({...form,key:event.target.value})}/>
  </Field>
  <Field label={t('assistantSettings.model')} error={errors.model} hint={t('assistantSettings.modelHint',{model:assistantDefaultModels[form.provider]})}>
   <input id={`${id}-model`} className="mono" type="text" autoComplete="off" spellCheck={false} value={form.model} disabled={disabled} maxLength={100} onChange={event=>onChange({...form,model:event.target.value})}/>
  </Field>
 </>;
}

type Texts={saved:MessageKey;removed:MessageKey;removeConfirm:string;removeText:MessageKey;removeLabel:string};
type KeyPayload=Record<string,unknown>&{action:string};
/**
 * Save, test and remove for one key. Saving and removing go through useStepUp: saving an organization or customer
 * key asks for the MFA proof first (lib/step-up.ts rule 6), removing goes out at once, and an answer that asks for
 * a new proof opens the dialog and resends once. Cancelling sends nothing and keeps the input. The form resets
 * when the stored key changes.
 */
export function useKeyEditor({scope,view,customerId,texts,onSaved,onStale}:{scope:KeyScope;view:AssistantKeyView|null;customerId?:string;texts:Texts;onSaved:(view:AssistantKeyView|null)=>void;onStale:()=>void}){
 const t=useT(),[locale]=useLocale();
 const [form,setForm]=useState<KeyForm>(()=>keyFormOf(view)),[baseline,setBaseline]=useState(view);
 const [submitted,setSubmitted]=useState(false),[serverErrors,setServerErrors]=useState<KeyErrors>({});
 const [testing,setTesting]=useState(false),[confirming,setConfirming]=useState(false),[action,setAction]=useState<string|null>(null);
 const mounted=useRef(true);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 // A new stored state (saved, removed, reloaded) resets the form to it.
 if(baseline!==view){setBaseline(view);setForm(keyFormOf(view));setSubmitted(false);setServerErrors({});}
 const dirty=keyFormDirty(form,view),clientErrors=keyFormErrors(form,view);
 const errors:KeyErrors={...Object.fromEntries(Object.entries(submitted?clientErrors:{}).map(([field,key])=>[field,t(key as MessageKey)])),...serverErrors};
 const change=(next:KeyForm)=>{setForm(next);setServerErrors({});};
 const base=customerId?{customerId}:{};
 /** Field errors and a stale state are handled here; anything else is a toast. */
 const failed=(failure:unknown)=>{
  if(failure instanceof ApiError&&failure.code==='ASSISTANT_FIELD_INVALID'&&typeof failure.params?.field==='string'&&['provider','key','model'].includes(failure.params.field)){setServerErrors({[failure.params.field as KeyField]:message(failure,locale)});return;}
  if(failure instanceof ApiError&&failure.code==='ASSISTANT_SECRET_UNDECRYPTABLE'){setServerErrors({key:message(failure,locale)});return;}
  if(failure instanceof ApiError&&failure.code==='ASSISTANT_SETTINGS_CHANGED'){toast.error(t('assistantSettings.stale'));onStale();return;}
  toast.error(message(failure,locale));
 };
 const request=useStepUp<KeyPayload,{key:AssistantKeyView|null}>({locale,needsStepUp:payload=>assistantSettingsActionNeedsStepUp(payload.action),
  send:payload=>api<{key:AssistantKeyView|null}>(assistantSettingsEndpoint,payload),onError:failure=>{failed(failure);return true;}});
 const dispatch=async(payload:KeyPayload)=>{
  setAction(payload.action);
  const result=await request.run(payload);
  if(!result||!mounted.current)return;
  onSaved(result.key);
  toast.success(t(payload.action===`remove-${scope}-key`?texts.removed:texts.saved));
 };
 const busy=request.busy||testing;
 const save=(event?:FormEvent)=>{
  event?.preventDefault();
  if(busy||!dirty)return;
  setSubmitted(true);
  if(Object.keys(clientErrors).length)return;
  void dispatch({action:`set-${scope}-key`,...base,provider:form.provider,model:form.model.trim(),...(form.key.trim()?{key:form.key.trim()}:{}),revision:view?.revision??null});
 };
 const test=async()=>{
  if(busy)return;
  setSubmitted(true);
  const {key:keyError,model:modelError}=clientErrors;
  if(modelError||keyError&&(form.key.trim()||!view||view.provider!==form.provider))return;
  setTesting(true);
  try{
   await api(assistantSettingsEndpoint,{action:`test-${scope}-key`,...base,provider:form.provider,model:form.model.trim(),...(form.key.trim()?{key:form.key.trim()}:{})});
   if(mounted.current)toast.success(t('assistantSettings.testOk'));
  }catch(failure){if(mounted.current)failed(failure);}
  finally{if(mounted.current)setTesting(false);}
 };
 const remove=()=>{setConfirming(false);if(view)void dispatch({action:`remove-${scope}-key`,...base,revision:view.revision});};
 const discard=()=>{setForm(keyFormOf(view));setSubmitted(false);setServerErrors({});};
 const sending=request.sending?action:null;
 const dialogs=<>
  <ConfirmDialog open={confirming} onOpenChange={setConfirming} tone="danger" title={texts.removeConfirm} body={t(texts.removeText)} confirmLabel={texts.removeLabel} onConfirm={remove}/>
  <MfaStepUp {...request.dialog}/>
 </>;
 return {form,change,errors,dirty,busy,testing,saving:sending===`set-${scope}-key`,removing:sending===`remove-${scope}-key`,save,test,discard,askRemove:()=>{if(!busy)setConfirming(true);},dialogs};
}
export type KeyEditor=ReturnType<typeof useKeyEditor>;

/** The status pill of a key: the focal point of each key card. */
export function KeyStatus({view}:{view:AssistantKeyView|null}){
 const t=useT();
 return <StatusPill kind={view?'success':'neutral'}>{t(view?'assistantSettings.status.ready':'assistantSettings.status.missing')}</StatusPill>;
}

/** The removal of a stored key: the kit DangerZone, loading while it runs and blocked with kit.busy while another request of the card runs. */
function KeyDangerZone({editor,label,text}:{editor:KeyEditor;label:string;text:string}){
 const t=useT();
 return <DangerZone title={label} description={text} label={label} icon={Trash2} loading={editor.removing} blocked={editor.busy&&!editor.removing?t('kit.busy'):undefined} onClick={editor.askRemove}/>;
}

const cardTexts={
 organization:{title:'assistantSettings.organization.title',text:'assistantSettings.organization.text',saved:'assistantSettings.organization.saved',removed:'assistantSettings.organization.removed',remove:'assistantSettings.organization.remove',removeConfirm:'assistantSettings.organization.removeConfirm',removeText:'assistantSettings.organization.removeText'},
 personal:{title:'assistantSettings.personal.title',text:'assistantSettings.personal.text',saved:'assistantSettings.personal.saved',removed:'assistantSettings.personal.removed',remove:'assistantSettings.personal.remove',removeConfirm:'assistantSettings.personal.removeConfirm',removeText:'assistantSettings.personal.removeText'},
} as const satisfies Record<'organization'|'personal',Record<string,MessageKey>>;

/** The card of the organization key or the personal key: status, the form, Test key, Save, and the removal in the danger zone. */
export function AssistantKeyCard({scope,view,onSaved,onStale}:{scope:'organization'|'personal';view:AssistantKeyView|null;onSaved:(view:AssistantKeyView|null)=>void;onStale:()=>void}){
 const t=useT(),id=`sdx-assistant-${scope}`,texts=cardTexts[scope];
 const editor=useKeyEditor({scope,view,texts:{saved:texts.saved,removed:texts.removed,removeConfirm:t(texts.removeConfirm),removeText:texts.removeText,removeLabel:t(texts.remove)},onSaved,onStale});
 return <Card className="sdx-assistant-key" title={t(texts.title)} icon={scope==='organization'?KeyRound:Sparkles} iconTone="accent" description={t(texts.text)} id={`${id}-title`} actions={<KeyStatus view={view}/>}>
  <form className="sdx-form-grid" noValidate onSubmit={editor.save} aria-labelledby={`${id}-title`}>
   <AssistantKeyFields id={id} form={editor.form} view={view} errors={editor.errors} disabled={editor.saving} onChange={editor.change}/>
   <FormActions dirty={editor.dirty} busy={editor.busy} loading={editor.saving} onDiscard={editor.discard}
    extra={<Btn icon={FlaskConical} loading={editor.testing} blocked={editor.busy&&!editor.testing?t('kit.busy'):undefined} onClick={()=>void editor.test()}>{t('assistantSettings.test')}</Btn>}/>
   {view&&<KeyDangerZone editor={editor} label={t(texts.remove)} text={t(texts.removeText)}/>}
  </form>
  {editor.dialogs}
 </Card>;
}

/** The search shows from this many customers on. */
export const customerSearchFrom=10;
export const customerKeyLine=(key:AssistantKeyView,t:Translate)=>t('assistantSettings.customers.keyLine',{provider:providerLabel(key.provider,t),model:key.model,hint:key.keyHint});

/** The customer keys: the count as the focal point, the table of customers, and the drawer of one customer. */
export function CustomerKeysCard({customers,now,onSaved,onStale,initialQuery=''}:{customers:AssistantCustomerKey[];now:number;onSaved:(customerId:string,view:AssistantKeyView|null)=>void;onStale:()=>void;/** The search text to start with (tests). */initialQuery?:string}){
 const t=useT(),[locale]=useLocale();
 const [query,setQuery]=useState(initialQuery),[open,setOpen]=useState<string|null>(null);
 const filtered=query.trim()?customers.filter(customer=>customer.customerName.toLowerCase().includes(query.trim().toLowerCase())):customers;
 const count=customers.filter(customer=>customer.key).length,current=customers.find(customer=>customer.customerId===open)??null;
 const columns:DataColumn<AssistantCustomerKey>[]=[
  {id:'customer',label:t('assistantSettings.customers.colCustomer'),primary:true,wrap:true,cell:customer=><span className="sdx-assistant-customer">{customer.customerName}{customer.customerDisabled&&<span className="sdx-tag">{t('fleet.disabled')}</span>}</span>},
  {id:'key',label:t('assistantSettings.customers.colKey'),wrap:true,cell:customer=><span className="sdx-assistant-keycell"><KeyStatus view={customer.key}/>{customer.key&&<span className="mono">{customerKeyLine(customer.key,t)}</span>}</span>},
  {id:'updated',label:t('assistantSettings.customers.colUpdated'),hideBelow:900,cell:customer=>customer.key?relativeTime(customer.key.updatedAt,now,locale):EMPTY_VALUE},
  {id:'actions',label:t('assistantSettings.customers.colActions'),align:'end',card:false,cell:customer=><Btn size="sm" icon={KeyRound} onClick={()=>setOpen(customer.customerId)}>{t(customer.key?'assistantSettings.customers.change':'assistantSettings.customers.set')}</Btn>},
 ];
 return <Card className="sdx-assistant-customers" title={t('assistantSettings.customers.title')} icon={Building2} iconTone="accent" description={t('assistantSettings.customers.text')} id="sdx-assistant-customers-title" flush
  actions={<span className="sdx-assistant-count">{t('assistantSettings.customers.count',{count,total:customers.length})}</span>}>
  <DataTable<AssistantCustomerKey> columns={columns} rows={filtered} rowKey={customer=>customer.customerId} label={t('assistantSettings.customers.caption')} variant="flush" cards entranceId="assistant-customer-keys"
   onOpen={customer=>setOpen(customer.customerId)} openLabel={customer=>t(customer.key?'assistantSettings.customers.change':'assistantSettings.customers.set')+': '+customer.customerName}
   toolbar={customers.length>=customerSearchFrom?<Toolbar className="sdx-assistant-search" search={{value:query,onChange:setQuery,label:t('assistantSettings.customers.search'),placeholder:t('assistantSettings.customers.search')}}/>:undefined}
   empty={{icon:Search,title:t('assistantSettings.customers.noMatch',{query:query.trim()}),action:<Btn size="sm" onClick={()=>setQuery('')}>{t('assistantSettings.customers.clearSearch')}</Btn>}}/>
  {current&&<CustomerKeyDrawer key={current.customerId} customer={current} onClose={()=>setOpen(null)} onSaved={view=>{onSaved(current.customerId,view);setOpen(null);}} onStale={()=>{setOpen(null);onStale();}}/>}
 </Card>;
}

/** The drawer "Key for {customer}": the form block, Test key and Save key in the footer, removal in the danger zone. A close with changes asks first. */
export function CustomerKeyDrawer({customer,onClose,onSaved,onStale}:{customer:AssistantCustomerKey;onClose:()=>void;onSaved:(view:AssistantKeyView|null)=>void;onStale:()=>void}){
 const t=useT(),formId=useId().replace(/:/g,''),view=customer.key;
 const editor=useKeyEditor({scope:'customer',view,customerId:customer.customerId,texts:{saved:'assistantSettings.customers.saved',removed:'assistantSettings.customers.removed',removeConfirm:t('assistantSettings.customers.removeConfirm',{customer:customer.customerName}),removeText:'assistantSettings.customers.removeText',removeLabel:t('assistantSettings.customers.remove')},onSaved,onStale});
 return <Drawer open onClose={onClose} dirty={editor.dirty} icon={KeyRound} title={t('assistantSettings.customers.drawerTitle',{customer:customer.customerName})} description={t('assistantSettings.customers.text')}
  footer={<><DrawerCancel/><Btn icon={FlaskConical} loading={editor.testing} blocked={editor.busy&&!editor.testing?t('kit.busy'):undefined} onClick={()=>void editor.test()}>{t('assistantSettings.test')}</Btn>
   <Btn type="submit" form={formId} variant="primary" loading={editor.saving} blocked={!editor.dirty?t('common.noChanges'):editor.busy&&!editor.saving?t('kit.busy'):undefined}>{t('assistantSettings.customers.save')}</Btn></>}>
  <form id={formId} className="sdx-form-grid sdx-assistant-drawer" noValidate onSubmit={editor.save}>
   <div className="sdx-assistant-drawer-status"><KeyStatus view={view}/>{view&&<span className="mono">{customerKeyLine(view,t)}</span>}</div>
   <AssistantKeyFields id={`sdx-assistant-customer-${formId}`} form={editor.form} view={view} errors={editor.errors} disabled={editor.saving} onChange={editor.change} autoFocus/>
   {view&&<KeyDangerZone editor={editor} label={t('assistantSettings.customers.remove')} text={t('assistantSettings.customers.removeText')}/>}
  </form>
  {editor.dialogs}
 </Drawer>;
}

/** The settings of GET /api/assistant/settings with a reload; initialView shows before the first load (tests). */
export function useAssistantSettings(viewerId:string,initialView:AssistantSettingsView|null=null){
 const [view,setView]=useState<AssistantSettingsView|null>(initialView),[loadFailed,setLoadFailed]=useState(false),[loading,setLoading]=useState(!initialView);
 const mounted=useRef(false),sequence=useRef(0);
 const load=useCallback(async()=>{
  const current=++sequence.current;setLoading(true);
  try{const next=await api<AssistantSettingsView>(assistantSettingsEndpoint);if(mounted.current&&current===sequence.current){setView(next);setLoadFailed(false);}}
  catch{if(mounted.current&&current===sequence.current)setLoadFailed(true);}
  finally{if(mounted.current&&current===sequence.current)setLoading(false);}
 },[]);
 useEffect(()=>{mounted.current=true;void Promise.resolve().then(load);return()=>{mounted.current=false;};},[load,viewerId]);
 return {view,setView,loadFailed,loading,load};
}
/** The load failure of the settings: the sentence, with the stale-data note while older settings stay shown. */
export const assistantLoadError=(loadFailed:boolean,stale:boolean,t:Translate)=>loadFailed?`${t('assistantSettings.loadError')}${stale?' '+t('notifications.staleData'):''}`:undefined;

export default function AssistantSettingsPanel({viewer,initialView=null,now:givenNow,frame}:{viewer:Viewer;initialView?:AssistantSettingsView|null;now?:number;frame?:PageFrame}){
 const t=useT(),[mountedAt]=useState(()=>Date.now()),now=givenNow??mountedAt;
 const {view,setView,loadFailed,loading,load}=useAssistantSettings(viewer.id,initialView);
 useFrameRefresh(frame,load);
 const customerKeys=view?.customerKeys;
 return <>{frameHeader(frame)}<SettingsPage className="sdx-assistant-settings" label={t('nav.settings.assistant')} loading={!view&&!loadFailed} loadError={assistantLoadError(loadFailed,!!view,t)} onRetry={()=>void load()} retrying={loading}>
  {view&&<>
   <AssistantKeyCard scope="organization" view={view.organization??null} onSaved={organization=>setView(previous=>previous&&{...previous,organization})} onStale={()=>void load()}/>
   {customerKeys?.visible&&<CustomerKeysCard customers={customerKeys.customers} now={now} onStale={()=>void load()}
    onSaved={(customerId,key)=>setView(previous=>previous?.customerKeys?{...previous,customerKeys:{...previous.customerKeys,customers:previous.customerKeys.customers.map(customer=>customer.customerId===customerId?{...customer,key}:customer)}}:previous)}/>}
  </>}
 </SettingsPage></>;
}
