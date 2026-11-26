'use client';
// The subtab Monitoring › Alert rules of All devices, a customer, a device group and a device: one table of
// the 31 rules with the value that applies on this scope and where it comes from,
// plus the edit drawer with the thresholds (or the one threshold and the level of
// a limit rule), the minimum duration and the recovery margin. The server resolves the inheritance (GET /api/alert-rules);
// this view only shows it. The drawer validates with the server's function
// (validateAlertRuleSettings in lib/alert-rules.ts). A customer is a level of its own between All devices and its
// groups: its subtab edits and resets like a group's, and its groups and devices inherit from it.
import {useCallback,useEffect,useId,useRef,useState,type FormEvent} from 'react';
import {toast} from 'sonner';
import {ArrowUpRight,Pencil,RotateCcw,Siren} from 'lucide-react';
import {alarmSettingsApply,alertRule,defaultAlertRuleView,maxAlarmDurationMinutes,sameAlertSettings,validateAlertRuleSettings,type AlertEditReason,type AlertLevel,type AlertOriginView,type AlertRuleRow,type AlertRuleSettings,type AlertRuleView,type AlertScopeType,type AlertRuleField,type AlertValidationError,type LimitRule,type ThresholdRule} from '@/lib/alert-rules';
import {alertAlarmSummary,alertInheritedSummary,alertLevelLabel,alertRuleDescription,alertUnitSuffix,formatAlertThreshold} from '@/lib/alert-rules-text';
import type {MessageKey} from '@/lib/i18n/translate';
import {EMPTY_VALUE} from '@/lib/i18n/format';
import {api,ApiError,message} from '@/ui/base/api';
import {Btn,Drawer,Menu,StatusPill,type MenuEntry} from '@/ui/kit/kit';
import {AnalysisTab,FirstLoad,LoadFailed} from '@/ui/kit/analysis-tab';
import {DataTable,type DataColumn} from '@/ui/kit/data-table';
import {InheritedOrigin} from '@/ui/kit/inheritance';
import {useLocale,useT,type Translate} from '@/ui/base/locale';

export type AlertRulesScope={type:AlertScopeType;id:string};
/** A higher scope that the origin link opens: All devices, a customer or a device group. */
export type AlertOriginTarget={type:'global'}|{type:'customer';id:string}|{type:'group';id:string};
type Props={
 scope:AlertRulesScope;
 /** Name of the scope as the user knows it (device or group name, "All devices"). */
 scopeName:string;
 demo:boolean;
 /** Reloads the console data after a change, so the issues follow at once. */
 onRefresh:()=>Promise<void>|void;
 onOpenOrigin:(target:AlertOriginTarget)=>void;
 /** Whether a customer origin can open: the viewer has the customer view (customerViewAvailable) or sees sample devices. */
 customerView?:boolean;
};
const reasonKeys:Record<AlertEditReason,MessageKey>={right:'alertRules.blocked.right','customer-right':'alertRules.blocked.customerRight','customer-boundary':'alertRules.blocked.boundary','read-only':'alertRules.blocked.readOnly'};
const endpoint='/api/alert-rules';

/** The origin as the user knows it. */
export function alertOriginLabel(origin:AlertOriginView,t:Translate):string{
 if(origin.type==='default')return t('alertRules.origin.default');
 if(origin.type==='global')return t('tree.allDevices');
 return t(origin.type==='customer'?'alertRules.origin.customer':origin.type==='group'?'alertRules.origin.group':'alertRules.origin.device',{name:origin.name});
}
/** The localized text of a failed change, by error code. */
export function alertRuleFailure(failure:unknown,t:Translate):string{
 if(failure instanceof ApiError){
  if(failure.code==='ALERT_RULE_INVALID')return t('alertRules.error.invalid');
  if(failure.code==='ALERT_RULE_CHANGED')return t('alertRules.error.changed');
  if(failure.code==='ALERT_RULE_SCOPE_BOUNDARY')return t('alertRules.blocked.boundary');
  if(failure.status===403&&!failure.code)return t('alertRules.blocked.right');
 }
 return message(failure);
}

export default function AlertRulesPanel({scope,scopeName,demo,onRefresh,onOpenOrigin,customerView=false}:Props){
 const t=useT(),[locale]=useLocale();
 const key=`${scope.type}:${scope.id}`;
 const [loaded,setLoaded]=useState<{key:string;view:AlertRuleView}|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[editing,setEditing]=useState<string|null>(null);
 const sequence=useRef(0),mounted=useRef(true);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 const load=useCallback(async()=>{
  if(demo)return;
  const current=++sequence.current;setLoading(true);
  try{
   const view=await api<AlertRuleView>(`${endpoint}?${new URLSearchParams({scopeType:scope.type,scopeId:scope.type==='global'?'*':scope.id})}`);
   if(mounted.current&&current===sequence.current){setLoaded({key,view});setError('');}
  }catch(failure){if(mounted.current&&current===sequence.current)setError(message(failure,locale));}
  finally{if(mounted.current&&current===sequence.current)setLoading(false);}
 },[demo,key,scope.type,scope.id,locale]);
 useEffect(()=>{queueMicrotask(()=>void load());},[load]);
 const view=demo?defaultAlertRuleView({type:scope.type,id:scope.id,name:scopeName}):loaded?.key===key?loaded.view:null;
 // Why changes are impossible here at all (sample devices, missing right, boundary); busy only pauses them.
 const locked=demo?t('kit.unavailable.demo'):view&&!view.canEdit?t(reasonKeys[view.reason??'right']):undefined;
 const row=view?.rules.find(item=>item.ruleId===editing)??null;
 const openOrigin=(origin:AlertOriginView)=>{if(origin.type==='global')onOpenOrigin({type:'global'});else if(origin.type==='customer'||origin.type==='group')onOpenOrigin({type:origin.type,id:origin.id});};
 const send=async(body:Record<string,unknown>,success:string)=>{
  setBusy(true);
  try{await api(endpoint,body);toast.success(success);await Promise.all([load(),onRefresh()]);return true;}
  catch(failure){toast.error(alertRuleFailure(failure,t));if(failure instanceof ApiError&&failure.code==='ALERT_RULE_CHANGED')void load();return false;}
  finally{if(mounted.current)setBusy(false);}
 };
 const scopeId=scope.type==='global'?'*':scope.id;
 const reset=(item:AlertRuleRow)=>{if(locked||busy||!item.override)return;void send({action:'reset-rule',scopeType:scope.type,scopeId,ruleId:item.ruleId,expected:item.override.updatedAt},t('alertRules.resetDone'));};

 const retry=()=>void load();
 // The shared load states: FirstLoad on the first load, LoadFailed (with the stale sentence while older rules show) on an error.
 return <AnalysisTab title={t('alertRules.title')} description={t('alertRules.meta')} className="sdx-alert-rules">
  {error&&<LoadFailed text={view?<>{t('alertRules.loadFailed')} {t('alertRules.staleData')}</>:t('alertRules.loadFailed')} loading={loading} onRetry={retry}/>}
  {!view?(!error&&<FirstLoad label={t('alertRules.loading')} loading={loading} onRetry={retry}/>)
   :<AlertRulesTable view={view} scope={scope} customerView={customerView} blocked={locked??(busy?t('fleet.menu.saving'):undefined)} onEdit={item=>setEditing(item.ruleId)} onReset={reset} onOpenOrigin={openOrigin}/>}
  <EditDrawer key={editing??''} row={locked?null:row} busy={busy} onClose={()=>setEditing(null)}
   onSave={settings=>{if(!row)return;void send({action:'set-rule',scopeType:scope.type,scopeId,ruleId:row.ruleId,...settings,expected:row.override?.updatedAt??null},t('alertRules.saved')).then(done=>{if(done)setEditing(null);});}}/>
 </AnalysisTab>;
}

/**
 * Whether the origin is a higher scope than the one shown: All devices below All devices, the customer on a group or
 * device, a parent group. On the customer scope itself a customer origin is the scope's own value.
 */
export const alertOriginIsHigher=(origin:AlertOriginView,scope:AlertRulesScope)=>origin.type==='global'&&scope.type!=='global'
 ||origin.type==='customer'&&(scope.type==='group'||scope.type==='device')
 ||origin.type==='group'&&!(scope.type==='group'&&origin.id===scope.id);
type TableActions={blocked?:string;onEdit:(item:AlertRuleRow)=>void;onReset:(item:AlertRuleRow)=>void;onOpenOrigin:(origin:AlertOriginView)=>void;
 /** Whether a customer origin can open (customerView of AlertRulesPanel); without it the origin is plain text. */
 customerView?:boolean};
/** Whether the viewer can open the origin: it is visible, and a customer origin also needs the customer view. */
export const alertOriginOpens=(origin:AlertOriginView,customerView:boolean)=>origin.type!=='default'&&origin.visible&&(origin.type!=='customer'||customerView);
/** The row menu: edit and reset stay visible with the reason when blocked; "Open origin" only for a higher origin that opens. */
export function alertRuleMenu(item:AlertRuleRow,scope:AlertRulesScope,t:Translate,{blocked,onEdit,onReset,onOpenOrigin,customerView=false}:TableActions):MenuEntry[]{
 const origin=item.origin;
 return [
  {id:'edit',label:t('alertRules.menu.edit'),icon:Pencil,blocked,onSelect:()=>{if(!blocked)onEdit(item);}},
  ...(item.override?[{id:'reset',label:t('alertRules.menu.reset'),icon:RotateCcw,blocked,onSelect:()=>{if(!blocked)onReset(item);}}]:[]),
  ...(alertOriginIsHigher(origin,scope)&&alertOriginOpens(origin,customerView)?[{id:'origin',label:t('alertRules.menu.openOrigin'),icon:ArrowUpRight,onSelect:()=>onOpenOrigin(origin)}]:[]),
 ];
}
/**
 * The table of the rules in catalog order with the values that apply on this scope: the rule name, the
 * steps, the alarm settings (hidden below 1280px) and the level (hidden below 1440px; both stay in the cards
 * and the drawer), the status pill, the origin and the row menu. Rule, alarm and origin wrap, so all eight
 * columns fit next to the tree at 1440px. A limit rule shows its one threshold under Warning. The description
 * line restates the columns, so it is only a fact in card mode.
 */
export function AlertRulesTable({view,scope,...actions}:{view:AlertRuleView;scope:AlertRulesScope}&TableActions){
 const t=useT(),[locale]=useLocale();
 const unused=<span className="sdx-muted-cell" role="img" aria-label={t('alertRules.notUsed')}>{EMPTY_VALUE}</span>;
 const ruleOf=(item:AlertRuleRow)=>alertRule(item.ruleId);
 const step=(item:AlertRuleRow,value:number|null)=>{const rule=ruleOf(item);return rule.kind!=='boolean'&&value!==null?<span className="mono">{formatAlertThreshold(rule,value,locale)}</span>:unused;};
 const columns:DataColumn<AlertRuleRow>[]=[
  {id:'rule',label:t('alertRules.column.rule'),primary:true,wrap:true,className:'sdx-alert-rule-cell',cell:item=>t(ruleOf(item).name)},
  {id:'description',label:t('alertRules.column.rule'),table:false,cell:item=>alertRuleDescription(ruleOf(item),item.effective,locale)},
  {id:'warning',label:t('alertRules.column.warning'),cell:item=>ruleOf(item).kind==='limit'?<span className="sdx-alert-limit" role="group" aria-label={t('alertRules.threshold')}>{step(item,item.effective.warning)}</span>:step(item,item.effective.warning)},
  {id:'critical',label:t('alertRules.column.critical'),cell:item=>ruleOf(item).kind==='limit'?unused:step(item,item.effective.critical)},
  {id:'alarm',label:t('alertRules.column.alarm'),hideBelow:1280,wrap:true,className:'sdx-alert-alarm-col',cell:item=>{const alarm=alertAlarmSummary(ruleOf(item),item.effective,locale);return alarm===null?unused:<span className="sdx-alert-alarm-cell">{alarm}</span>;}},
  {id:'level',label:t('alertRules.column.level'),hideBelow:1440,cell:item=>{const rule=ruleOf(item);return rule.kind==='threshold'?t('alertRules.level.byThreshold'):alertLevelLabel(item.effective.level??rule.defaults.level,locale);}},
  {id:'status',label:t('alertRules.column.status'),cell:item=>item.effective.enabled?<StatusPill kind="success">{t('alertRules.status.on')}</StatusPill>:<StatusPill kind="neutral">{t('alertRules.status.off')}</StatusPill>},
  {id:'origin',label:t('alertRules.column.origin'),wrap:true,className:'sdx-alert-origin-cell',cell:item=><Origin item={item} higher={alertOriginIsHigher(item.origin,scope)} opens={alertOriginOpens(item.origin,actions.customerView??false)} onOpen={actions.onOpenOrigin}/>},
  {id:'actions',label:t('alertRules.column.actions'),hideLabel:true,className:'sdx-col-actions',cell:item=><Menu label={t('alertRules.actionsFor',{name:t(ruleOf(item).name)})} entries={alertRuleMenu(item,scope,t,actions)}/>},
 ];
 return <DataTable<AlertRuleRow> label={t('alertRules.title')} cards entranceId="alert-rule-rows" className="sdx-alert-rules-table sdx-table-sticky-actions" columns={columns} rows={view.rules} rowKey={item=>item.ruleId}
  empty={{icon:Siren,title:t('alertRules.loadFailedTitle'),children:t('alertRules.loadFailedHint')}}/>;
}

/** Origin cell: a direct override is "Changed" with the inherited value; a higher origin links there; the default and the scope itself are muted text, so overrides stand out. */
function Origin({item,higher,opens,onOpen}:{item:AlertRuleRow;higher:boolean;opens:boolean;onOpen:(origin:AlertOriginView)=>void}){
 const t=useT(),[locale]=useLocale(),rule=alertRule(item.ruleId);
 if(item.override){
  const inherited=t('alertRules.inherited',{summary:alertInheritedSummary(rule,item.inherited.settings,locale),origin:alertOriginLabel(item.inherited.origin,t)});
  return <span className="sdx-alert-origin"><span className="sdx-tag sdx-tag-changed">{t('alertRules.changed')}</span><small>{inherited}</small></span>;
 }
 if(item.origin.type==='default'||!higher)return <span className="sdx-muted-cell">{alertOriginLabel(item.origin,t)}</span>;
 const origin=item.origin;
 return <InheritedOrigin label={alertOriginLabel(origin,t)} hint={null} onOpen={opens?()=>onOpen(origin):undefined}/>;
}

type Draft={enabled:boolean;warning:string;critical:string;level:AlertLevel;durationMinutes:string;recovery:string};
const text=(value:number|null)=>value===null?'':String(value);
const draftOf=(settings:AlertRuleSettings,fallback:AlertLevel):Draft=>({enabled:settings.enabled,warning:text(settings.warning),critical:text(settings.critical),level:settings.level??fallback,durationMinutes:text(settings.durationMinutes),recovery:text(settings.recovery)});
const numberOf=(value:string)=>value.trim()===''?null:Number(value);
type DrawerField='warning'|'critical'|'level'|'durationMinutes'|'recovery';
const alarmField=(field:AlertRuleField)=>field==='durationMinutes'||field==='recovery';
function validationText(error:AlertValidationError,rule:ThresholdRule|LimitRule|null,t:Translate):string{
 if(error.code==='range'&&rule){
  if(error.field==='durationMinutes')return t('alertRules.validation.range',{min:0,max:maxAlarmDurationMinutes});
  if(error.field==='recovery')return t('alertRules.validation.range',{min:0,max:rule.range.max});
  return t('alertRules.validation.range',{min:rule.range.min,max:rule.range.max});
 }
 if(error.code==='required')return alarmField(error.field)?t('alertRules.validation.alarmRequired'):rule?.kind==='limit'?t('alertRules.field.thresholdHint'):t('alertRules.validation.required');
 const keys={order:'alertRules.validation.order',orderBelow:'alertRules.validation.orderBelow',level:'alertRules.validation.level',recovery:'alertRules.validation.recovery',recoverySum:'alertRules.validation.recoverySum'} as const;
 return Object.hasOwn(keys,error.code)?t(keys[error.code as keyof typeof keys]):t('alertRules.error.invalid');
}

/** A number field of the edit drawer. aria-describedby always names an element
 * that is rendered: the hint without an error, the error after a failed submit. */
export function AlertRuleNumberField({id,label,value,error,hint,unit,min,max,disabled,onChange}:{id:string;label:string;value:string;error:string;hint:string;unit:string;min:number;max:number;disabled:boolean;onChange:(value:string)=>void}){
 return <label className="sdx-field" htmlFor={id}>
  <span>{label}</span>
  <span className="sdx-input-unit"><input id={id} type="number" inputMode="numeric" min={min} max={max} step={1} value={value} disabled={disabled} aria-invalid={!!error||undefined} aria-describedby={error?`${id}-error`:`${id}-hint`} onChange={event=>onChange(event.target.value)}/><span aria-hidden>{unit}</span></span>
  {error?<span className="sdx-field-error" id={`${id}-error`}>{error}</span>:<small id={`${id}-hint`}>{hint}</small>}
 </label>;
}

/** The level of a boolean rule. It has no hint, so aria-describedby exists only with an error. */
export function AlertRuleLevelField({id,label,value,error,disabled,onChange}:{id:string;label:string;value:AlertLevel;error:string;disabled:boolean;onChange:(level:AlertLevel)=>void}){
 const [locale]=useLocale();
 return <label className="sdx-field" htmlFor={id}><span>{label}</span>
  <select id={id} value={value} disabled={disabled} aria-invalid={!!error||undefined} aria-describedby={error?`${id}-error`:undefined} onChange={event=>onChange(event.target.value as AlertLevel)}>{(['info','warning','critical'] as const).map(level=><option key={level} value={level}>{alertLevelLabel(level,locale)}</option>)}</select>
  {error&&<span className="sdx-field-error" id={`${id}-error`}>{error}</span>}
 </label>;
}

/** "Edit alert rule": the switch, the thresholds or the level, the minimum duration and recovery margin of an alarm rule, and the inherited value as a hint. */
function EditDrawer({row,busy,onClose,onSave}:{row:AlertRuleRow|null;busy:boolean;onClose:()=>void;onSave:(settings:AlertRuleSettings)=>void}){
 const t=useT(),[locale]=useLocale(),formId=useId();
 const rule=row?alertRule(row.ruleId):null;
 const [draft,setDraft]=useState<Draft|null>(()=>row&&rule?draftOf(row.effective,rule.defaults.level??'warning'):null),[submitted,setSubmitted]=useState(false);
 if(!row||!rule||!draft)return null;
 const threshold=rule.kind==='threshold'?rule:null,limit=rule.kind==='limit'?rule:null,alarm=alarmSettingsApply(rule);
 const input=threshold?{enabled:draft.enabled,warning:numberOf(draft.warning),critical:numberOf(draft.critical),...(alarm?{durationMinutes:numberOf(draft.durationMinutes),recovery:numberOf(draft.recovery)}:{})}
  :limit?{enabled:draft.enabled,warning:numberOf(draft.warning),level:draft.level}:{enabled:draft.enabled,level:draft.level};
 const result=validateAlertRuleSettings(rule.id,input),errors=result.ok?[]:result.errors;
 const fieldError=(field:DrawerField)=>{const error=errors.find(item=>item.field===field);return submitted&&error?validationText(error,threshold??limit,t):'';};
 const changed=result.ok?!sameAlertSettings(result.settings,row.effective):true;
 const saveBlocked=!changed?t('common.noChanges'):submitted&&!result.ok?t('alertRules.blocked.invalid'):undefined;
 const submit=(event:FormEvent)=>{event.preventDefault();setSubmitted(true);if(result.ok&&changed&&!busy)onSave(result.settings);};
 const inherited=t('alertRules.inherited',{summary:alertInheritedSummary(rule,row.inherited.settings,locale),origin:alertOriginLabel(row.inherited.origin,t)});
 const field=(name:'warning'|'critical')=><AlertRuleNumberField id={`${formId}-${name}`} label={t(name==='warning'?'alertRules.field.warning':'alertRules.field.critical')} value={draft[name]} error={fieldError(name)} hint={t('alertRules.field.emptyHint')} unit={t(alertUnitSuffix[threshold!.unit])} min={threshold!.range.min} max={threshold!.range.max} disabled={busy} onChange={value=>setDraft({...draft,[name]:value})}/>;
 // The one threshold of a limit rule (stored in warning).
 const limitField=()=><AlertRuleNumberField id={`${formId}-threshold`} label={t('alertRules.threshold')} value={draft.warning} error={fieldError('warning')} hint={t('alertRules.field.thresholdHint')} unit={t(alertUnitSuffix[limit!.unit])} min={limit!.range.min} max={limit!.range.max} disabled={busy} onChange={value=>setDraft({...draft,warning:value})}/>;
 const levelField=<AlertRuleLevelField id={`${formId}-level`} label={t('alertRules.field.level')} value={draft.level} error={fieldError('level')} disabled={busy} onChange={level=>setDraft({...draft,level})}/>;
 const alarmInput=(name:'durationMinutes'|'recovery')=>{const duration=name==='durationMinutes';return <AlertRuleNumberField id={`${formId}-${name}`} label={t(duration?'alertRules.field.duration':'alertRules.field.recovery')} value={draft[name]} error={fieldError(name)} hint={t(duration?'alertRules.field.durationHint':'alertRules.field.recoveryHint')} unit={t(duration?'alertRules.suffix.minutes':alertUnitSuffix[threshold!.unit])} min={0} max={duration?maxAlarmDurationMinutes:threshold!.range.max} disabled={busy} onChange={value=>setDraft({...draft,[name]:value})}/>;};
 return <Drawer open onClose={onClose} title={t('alertRules.drawer.title')} description={<><strong>{t(rule.name)}</strong> · {alertRuleDescription(rule,result.ok?result.settings:row.effective,locale)}</>}
  footer={<><Btn onClick={onClose} disabled={busy}>{t('common.cancel')}</Btn><Btn variant="primary" type="submit" form={formId} loading={busy} blocked={saveBlocked}>{t('common.save')}</Btn></>}>
  <form id={formId} className="sdx-form-grid sdx-alert-rule-form" noValidate onSubmit={submit}>
   <label className="sdx-alert-rule-switch"><input type="checkbox" role="switch" autoFocus checked={draft.enabled} disabled={busy} onChange={event=>setDraft({...draft,enabled:event.target.checked})}/>{t('alertRules.field.enabled')}</label>
   {threshold?<div className="sdx-alert-rule-steps">{field('warning')}{field('critical')}</div>
    :limit?<div className="sdx-alert-rule-steps">{limitField()}{levelField}</div>
    :levelField}
   {threshold&&alarm&&<div className="sdx-alert-rule-steps">{alarmInput('durationMinutes')}{alarmInput('recovery')}</div>}
   <p className="sdx-alert-rule-inherited">{inherited}</p>
  </form>
 </Drawer>;
}
