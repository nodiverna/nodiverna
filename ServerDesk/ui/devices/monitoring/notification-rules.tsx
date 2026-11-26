'use client';
// The subtab Monitoring › Notification rules of All devices, a device group and (with several customers) a customer
// (docs/notifications.md): which alarm levels and events go to which channels.
// The server resolves the inheritance (GET /api/notifications/rules); this view
// shows the direct rules (editable) and the inherited ones nearest origin first,
// read-only with their origin (inheritance pattern, ui/kit/inheritance.tsx).
// Changes are routine (no step-up). Sample devices block every change. On a device
// (Monitoring › Notification rules of the device area) it shows, read-only, the
// rules that reach the device: a device has no rules of its own.
import {useCallback,useEffect,useId,useRef,useState,type FormEvent} from 'react';
import {toast} from 'sonner';
import {ArrowUpRight,FlaskConical,Info,Pencil,Plus,Power,ScrollText,Send,Settings,Trash2} from 'lucide-react';
import type {InheritedRuleView,NotificationRuleView,NotificationRulesView,RuleEditReason,RuleEvents,RuleOrigin,RuleViewScopeType} from '@/lib/server/notifications/notification-rules';
import type {AlertLevel} from '@/lib/alert-rules';
import type {MessageKey} from '@/lib/i18n/translate';
import {api,ApiError,message} from '@/ui/base/api';
import {Btn,Card,Drawer,Menu,Notice,StatusPill,type EmptyProps,type MenuEntry} from '@/ui/kit/kit';
import {DataTable,type DataColumn} from '@/ui/kit/data-table';
import {ConfirmDialog} from '@/ui/kit/confirm-dialog';
import {AnalysisTab,FirstLoad,LoadFailed} from '@/ui/kit/analysis-tab';
import {InheritedOrigin} from '@/ui/kit/inheritance';
import {channelTypeIcons,channelTypeKeys,markShown,saveBlockedKey,shownErrors,type FieldMarks} from '@/ui/settings/notification-fields';
import {useLocale,useT,type Translate} from '@/ui/base/locale';
import '@/ui/settings/notifications-panel.css';

/** The scope of the panel: All devices, a group, a customer, or a device (read-only: the rules that reach it). */
export type NotificationRulesScope={type:RuleViewScopeType;id:string};
/** A higher scope that the origin link opens. */
export type NotificationOriginTarget={type:'all'}|{type:'group';id:string}|{type:'customer';id:string};
type Props={
 scope:NotificationRulesScope;
 /** The scope as the user knows it: "All devices", the group or the customer name. */
 scopeName:string;
 demo:boolean;
 /**
  * Whether the viewer holds "Manage notification channels", the right of the settings page Notification channels: the
  * head links to the channels and the delivery log and the "No channels yet" action show only then.
  */
 canManageChannels:boolean;
 onOpenOrigin:(target:NotificationOriginTarget)=>void;
 /** Opens Settings › Notification channels (#settings/notification-channels). */
 onOpenSettings:()=>void;
 /** Opens its Delivery log (#settings/notification-channels/log). Without it the head has no settings links. */
 onOpenLog?:()=>void;
 /** Hides the sample devices (the console's demo switch): the one step that leads to real rules. */
 onHideDemo:()=>void;
 /** A device scope: the target of the empty state's one action, the nearest group the viewer may open or All devices. */
 deviceEmpty?:{name:string;onOpen:()=>void};
};
const endpoint='/api/notifications/rules';
const levels:readonly AlertLevel[]=['info','warning','critical'];
const eventKeys:Record<keyof RuleEvents,MessageKey>={open:'notificationRules.event.open',close:'notificationRules.event.close',escalate:'notificationRules.event.escalate'};
const reasonKeys:Record<RuleEditReason,MessageKey>={right:'notificationRules.blocked.right','customer-boundary':'notificationRules.blocked.boundary'};
const scopeParam=(scope:NotificationRulesScope)=>scope.type==='all'?'all':`${scope.type}:${scope.id}`;

/** The origin as the user knows it. */
export function ruleOriginLabel(origin:Pick<RuleOrigin,'type'|'name'>,t:Translate):string{
 if(origin.type==='all')return t('tree.allDevices');
 return t(origin.type==='group'?'alertRules.origin.group':'notificationRules.origin.customer',{name:origin.name});
}
/**
 * Whether the Direct card says "No channels yet": only for an editor while no channel and no rule exists.
 * A viewer gets no channel list from the server, so "No rules apply here" shows instead. Sample devices
 * have no channel data, so they get the demo state, never this one.
 */
export const showsNoChannels=(view:NotificationRulesView,demo:boolean)=>!demo&&view.canEdit&&!view.channels.length&&!view.direct.length&&!view.inherited.length;
/** The blocked reason of "Add notification rule": the lock (sample devices, right, boundary, saving) first, then "No channels yet" for an editor. */
export function addRuleBlocked(view:NotificationRulesView|null,blocked:string|undefined,t:Translate):string|undefined{
 return blocked??(view?.canEdit&&!view.channels.length?t('notificationRules.noChannels.title'):undefined);
}
/** The empty view of sample devices and of a scope before its first answer. */
export const emptyRulesView=(scope:NotificationRulesScope,name:string):NotificationRulesView=>({scope:{...scope,name},direct:[],inherited:[],channels:[],canEdit:false,reason:null});

/**
 * The head links of the subtab: Settings › Notification channels and its Delivery log, the place that answers "who was
 * told". Only for a viewer who may open that page (canManageChannels); otherwise none.
 */
export function NotificationSettingsLinks({canManageChannels,onOpenSettings,onOpenLog}:Pick<Props,'canManageChannels'|'onOpenSettings'|'onOpenLog'>){
 const t=useT();
 if(!canManageChannels||!onOpenLog)return null;
 return <>
  <Btn size="sm" icon={Settings} onClick={onOpenSettings}>{t('monitoringTab.openChannels')}</Btn>
  <Btn size="sm" icon={ScrollText} onClick={onOpenLog}>{t('monitoringTab.openLog')}</Btn>
 </>;
}

/** What the Direct card shows without direct rules: one Empty with its cause and exactly one action (or none where the viewer can never act). */
export function directRulesEmpty({view,demo,canManageChannels,addBlocked,t,onAdd,onOpenSettings,onHideDemo}:{view:NotificationRulesView;demo:boolean;canManageChannels:boolean;addBlocked:string|undefined;t:Translate;onAdd:()=>void;onOpenSettings:()=>void;onHideDemo:()=>void}):EmptyProps{
 if(demo)return {icon:FlaskConical,title:t('notificationRules.demo.title'),children:t('notificationRules.demo.text'),action:<Btn icon={FlaskConical} onClick={onHideDemo}>{t('palette.action.hideDemo')}</Btn>};
 if(showsNoChannels(view,demo))return {icon:Send,title:t('notificationRules.noChannels.title'),children:t(canManageChannels?'notificationRules.noChannels.admin':'notificationRules.noChannels.ask'),action:canManageChannels?<Btn icon={Settings} onClick={onOpenSettings}>{t('notificationRules.noChannels.open')}</Btn>:undefined};
 const add=<Btn icon={Plus} blocked={addBlocked} onClick={onAdd}>{t('notificationRules.add')}</Btn>;
 if(view.inherited.length)return {icon:Send,title:t('notificationRules.empty.direct'),children:t('notificationRules.empty.directText'),action:add};
 return {icon:Send,title:t('notificationRules.empty.none'),children:t('notificationRules.empty.noneText'),action:add};
}

export default function NotificationRulesPanel({scope,scopeName,demo,canManageChannels,onOpenOrigin,onOpenSettings,onOpenLog,onHideDemo,deviceEmpty}:Props){
 const t=useT(),[locale]=useLocale();
 const key=scopeParam(scope);
 const [loaded,setLoaded]=useState<{key:string;view:NotificationRulesView}|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[busy,setBusy]=useState(false);
 const [editing,setEditing]=useState<NotificationRuleView|'new'|null>(null),[deleting,setDeleting]=useState<NotificationRuleView|null>(null);
 const sequence=useRef(0),mounted=useRef(true);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 const load=useCallback(async()=>{
  if(demo)return;
  const current=++sequence.current;setLoading(true);
  try{const view=await api<NotificationRulesView>(`${endpoint}?${new URLSearchParams({scope:key})}`);if(mounted.current&&current===sequence.current){setLoaded({key,view});setError('');}}
  catch(failure){if(mounted.current&&current===sequence.current)setError(message(failure,locale));}
  finally{if(mounted.current&&current===sequence.current)setLoading(false);}
 },[demo,key,locale]);
 useEffect(()=>{queueMicrotask(()=>void load());},[load]);
 const view=demo?emptyRulesView(scope,scopeName):loaded?.key===key?loaded.view:null;
 const locked=demo?t('kit.unavailable.demo'):view&&!view.canEdit?t(reasonKeys[view.reason??'right']):undefined;
 const blocked=locked??(busy?t('fleet.menu.saving'):undefined);
 const send=async(body:Record<string,unknown>,success:MessageKey)=>{
  setBusy(true);
  try{await api(endpoint,{...body,scope:key});toast.success(t(success));await load();return true;}
  catch(failure){toast.error(failure instanceof ApiError&&failure.code==='NOTIFY_RULE_EXISTS'?t('notificationRules.error.exists'):message(failure,locale));if(failure instanceof ApiError&&failure.code==='NOTIFY_RULE_CHANGED')void load();return false;}
  finally{if(mounted.current)setBusy(false);}
 };
 const openOrigin=(origin:RuleOrigin)=>onOpenOrigin(origin.type==='all'?{type:'all'}:{type:origin.type,id:origin.id});
 const addBlocked=addRuleBlocked(view,blocked,t),add=()=>{if(!addBlocked)setEditing('new');};
 const remove=()=>{const rule=deleting;setDeleting(null);if(rule)void send({action:'delete',id:rule.id,revision:rule.revision},'notificationRules.deleted');};
 const links=<NotificationSettingsLinks canManageChannels={canManageChannels} onOpenSettings={onOpenSettings} onOpenLog={onOpenLog}/>;
 const loadState=<>
  {error&&<LoadFailed text={<>{t('notificationRules.loadFailed')}{view?' '+t('notifications.staleData'):''}</>} loading={loading} onRetry={()=>void load()}/>}
  {!view&&!error&&<FirstLoad label={t('notificationRules.loading')} loading={loading} onRetry={()=>void load()}/>}
 </>;
 // A device: the rules that reach it, read-only; no Direct card and no "Add notification rule".
 if(scope.type==='device')return <AnalysisTab title={t('fleet.config.notificationRules')} description={t('notificationRules.device.meta')} actions={links} className="sdx-notification-rules">
  {loadState}
  {view&&<DeviceRulesTable view={view} demo={demo} busy={loading} onOpenOrigin={openOrigin}
   empty={demo?directRulesEmpty({view,demo,canManageChannels,addBlocked,t,onAdd:add,onOpenSettings,onHideDemo})
    :{icon:Send,title:t('notificationRules.device.empty.title'),children:t('notificationRules.device.empty.text'),action:deviceEmpty&&<Btn icon={ArrowUpRight} onClick={deviceEmpty.onOpen}>{t('notificationRules.device.empty.action',{name:deviceEmpty.name})}</Btn>}}/>}
 </AnalysisTab>;
 return <AnalysisTab title={t('fleet.config.notificationRules')} description={t('notificationRules.meta')} actions={<>{links}<Btn icon={Plus} blocked={addBlocked} onClick={add}>{t('notificationRules.add')}</Btn></>} className="sdx-notification-rules">
  {loadState}
  {view&&<RulesTable view={view} busy={loading} blocked={blocked} directEmpty={directRulesEmpty({view,demo,canManageChannels,addBlocked,t,onAdd:add,onOpenSettings,onHideDemo})}
     onEdit={rule=>setEditing(rule)} onToggle={rule=>void send({action:'update',id:rule.id,revision:rule.revision,levels:rule.levels,events:rule.events,enabled:!rule.enabled},'notificationRules.saved')} onDelete={setDeleting} onOpenOrigin={openOrigin}/>}
  {editing&&view&&!locked&&<RuleDrawer key={editing==='new'?'new':editing.id} rule={editing==='new'?null:editing} view={view} scopeName={scopeName} busy={busy} onClose={()=>setEditing(null)}
   onSave={body=>void send(body,'notificationRules.saved').then(done=>{if(done)setEditing(null);})}/>}
  <ConfirmDialog open={!!deleting} onOpenChange={open=>{if(!open)setDeleting(null);}} title={t('notificationRules.delete.title',{channel:deleting?.channel.name??''})}
   body={t('notificationRules.delete.description',{scope:scopeName})} confirmLabel={t('notificationRules.delete.confirm')} tone="danger" onConfirm={remove}/>
 </AnalysisTab>;
}

type TableActions={blocked?:string;onEdit:(rule:NotificationRuleView)=>void;onToggle:(rule:NotificationRuleView)=>void;onDelete:(rule:NotificationRuleView)=>void;onOpenOrigin:(origin:RuleOrigin)=>void};
/** The row menu of a direct rule: Edit, Turn on/off, Delete; blocked entries stay visible with the reason. */
export function directRuleMenu(rule:NotificationRuleView,t:Translate,{blocked,onEdit,onToggle,onDelete}:TableActions):MenuEntry[]{
 return [
  {id:'edit',label:t('notificationRules.menu.edit'),icon:Pencil,blocked,onSelect:()=>{if(!blocked)onEdit(rule);}},
  {id:'toggle',label:t(rule.enabled?'notificationRules.menu.off':'notificationRules.menu.on'),icon:Power,blocked,onSelect:()=>{if(!blocked)onToggle(rule);}},
  {id:'separator',separator:true},
  {id:'delete',label:t('notificationRules.menu.delete'),icon:Trash2,danger:true,blocked,onSelect:()=>{if(!blocked)onDelete(rule);}},
 ];
}
/** The row menu of an inherited rule (nodiverna-ui §7): Open origin first when the viewer may open it, then Edit blocked with "Change it at <origin>". */
export function inheritedRuleMenu(rule:InheritedRuleView,t:Translate,{onOpenOrigin}:Pick<TableActions,'onOpenOrigin'>):MenuEntry[]{
 const origin=ruleOriginLabel(rule.origin,t);
 return [
  ...(rule.origin.visible?[{id:'origin',label:t('notificationRules.menu.openOrigin'),icon:ArrowUpRight,onSelect:()=>onOpenOrigin(rule.origin)}]:[]),
  {id:'edit',label:t('notificationRules.menu.edit'),icon:Pencil,blocked:t('notificationRules.changeAt',{origin})},
 ];
}

/**
 * The row menu of a rule that reaches a device (Monitoring › Notification rules of a device): Open origin, blocked with
 * its reason when the viewer may not open the origin, then Edit, Turn on/off and Delete, blocked with "Change it at <origin>".
 */
export function deviceRuleMenu(rule:InheritedRuleView,t:Translate,{onOpenOrigin}:Pick<TableActions,'onOpenOrigin'>):MenuEntry[]{
 const origin=ruleOriginLabel(rule.origin,t),changeAt=t('notificationRules.changeAt',{origin});
 return [
  {id:'origin',label:t('notificationRules.menu.openOrigin'),icon:ArrowUpRight,blocked:rule.origin.visible?undefined:t('notificationRules.originHidden',{origin}),onSelect:()=>{if(rule.origin.visible)onOpenOrigin(rule.origin);}},
  {id:'edit',label:t('notificationRules.menu.edit'),icon:Pencil,blocked:changeAt,onSelect:()=>{}},
  {id:'toggle',label:t(rule.enabled?'notificationRules.menu.off':'notificationRules.menu.on'),icon:Power,blocked:changeAt,onSelect:()=>{}},
  {id:'separator',separator:true},
  {id:'delete',label:t('notificationRules.menu.delete'),icon:Trash2,danger:true,blocked:changeAt,onSelect:()=>{}},
 ];
}

/** The cells every rule row shares: the channel (type icon, name, "Off" while the channel is off), the levels, the events and the status. */
function ruleColumns<R extends NotificationRuleView>(t:Translate):DataColumn<R>[]{
 return [
  {id:'channel',label:t('notificationRules.col.channel'),primary:true,cell:rule=>{const Icon=channelTypeIcons[rule.channel.type];return <span className="sdx-notification-type"><Icon size={14} aria-hidden/><span className="sr-only">{t(channelTypeKeys[rule.channel.type])}: </span><strong>{rule.channel.name}</strong>{!rule.channel.enabled&&<span className="sdx-tag">{t('notifications.status.off')}</span>}</span>;}},
  {id:'levels',label:t('notificationRules.col.levels'),cell:rule=><span className="sdx-notification-tags">{rule.levels.map(level=><span key={level} className="sdx-tag">{t(`alertRules.level.${level}`)}</span>)}</span>},
  {id:'events',label:t('notificationRules.col.events'),cell:rule=><span className="sdx-notification-tags">{(Object.keys(eventKeys) as (keyof RuleEvents)[]).filter(event=>rule.events[event]).map(event=><span key={event} className="sdx-tag">{t(eventKeys[event])}</span>)}</span>},
  {id:'status',label:t('notificationRules.col.status'),cell:rule=>rule.enabled?<StatusPill kind="success">{t('notifications.status.on')}</StatusPill>:<StatusPill kind="neutral">{t('notifications.status.off')}</StatusPill>},
 ];
}

/** The row menu column of a rule table. */
function actionsColumn<R extends NotificationRuleView>(t:Translate,entries:(rule:R)=>MenuEntry[]):DataColumn<R>{
 return {id:'actions',label:t('notificationRules.col.actions'),hideLabel:true,className:'sdx-col-actions',cell:rule=><Menu label={t('notificationRules.actionsFor',{channel:rule.channel.name})} entries={entries(rule)}/>};
}
/** The columns of an inherited rule table: the shared cells, the origin (InheritedOrigin, a link when the viewer may open it) and the row menu. */
function inheritedColumns(t:Translate,onOpenOrigin:(origin:RuleOrigin)=>void,entries:(rule:InheritedRuleView)=>MenuEntry[]):DataColumn<InheritedRuleView>[]{
 return [...ruleColumns<InheritedRuleView>(t),
  {id:'origin',label:t('notificationRules.col.origin'),className:'sdx-tag-origin-cell',cell:rule=>{const label=ruleOriginLabel(rule.origin,t);return <InheritedOrigin label={label} hint={t('notificationRules.changeAt',{origin:label})} onOpen={rule.origin.visible?()=>onOpenOrigin(rule.origin):undefined}/>;}},
  actionsColumn(t,entries)];
}

/**
 * Two cards (nodiverna-ui §7, "one list, two sections"): "Direct" with the editable rules of this scope and,
 * only when some exist, "Inherited" with the rules of higher levels, nearest origin first, each with its
 * origin. The row order is the server's. directEmpty is the cause-specific empty row of the Direct card.
 */
export function RulesTable({view,directEmpty,busy,...actions}:{view:NotificationRulesView;directEmpty:EmptyProps;busy?:boolean}&TableActions){
 const t=useT();
 const directColumns:DataColumn<NotificationRuleView>[]=[...ruleColumns<NotificationRuleView>(t),actionsColumn(t,rule=>directRuleMenu(rule,t,actions))];
 return <>
  <Card title={t('notificationRules.section.direct')} icon={Send} iconTone="accent" flush>
   <DataTable<NotificationRuleView> label={t('notificationRules.table.direct')} variant="flush" cards entranceId="notification-direct-rows" columns={directColumns} rows={view.direct} rowKey={rule=>rule.id} empty={directEmpty} busy={busy}/>
  </Card>
  {view.inherited.length>0&&<Card title={t('notificationRules.section.inherited')} icon={ArrowUpRight} iconTone="neutral" flush>
   <DataTable<InheritedRuleView> label={t('notificationRules.table.inherited')} variant="flush" cards columns={inheritedColumns(t,actions.onOpenOrigin,rule=>inheritedRuleMenu(rule,t,actions))} rows={view.inherited} rowKey={rule=>rule.id} empty={{icon:ArrowUpRight,title:t('notificationRules.empty.direct')}} busy={busy}/>
  </Card>}
 </>;
}

/**
 * The rules that reach a device (nodiverna-ui §7, read-only): one info notice that rules live on groups, customers and All
 * devices, then one flush card with every rule, nearest origin first (the server's order), each with its origin. A
 * disabled rule and a disabled channel are marked in text, as in the inherited card of a group. A sample device (demo)
 * has no rules and gets no notice: its empty state says why.
 */
export function DeviceRulesTable({view,demo,empty,busy,onOpenOrigin}:{view:NotificationRulesView;demo?:boolean;empty:EmptyProps;busy?:boolean;onOpenOrigin:(origin:RuleOrigin)=>void}){
 const t=useT();
 return <>
  {!demo&&<Notice tone="info" icon={Info}>{t('notificationRules.device.notice')}</Notice>}
  <Card title={t('notificationRules.device.cardTitle')} icon={Send} iconTone="accent" flush>
   <DataTable<InheritedRuleView> label={t('notificationRules.device.cardTitle')} variant="flush" cards entranceId="notification-device-rows" columns={inheritedColumns(t,onOpenOrigin,rule=>deviceRuleMenu(rule,t,{onOpenOrigin}))} rows={view.inherited} rowKey={rule=>rule.id} empty={empty} busy={busy}/>
  </Card>
 </>;
}

type Draft={channelId:string;levels:AlertLevel[];events:RuleEvents;enabled:boolean};
type DraftField='channel'|'levels'|'events';
/** Field errors of the drawer; the server checks again. */
export function ruleDraftErrors(draft:Draft):Partial<Record<DraftField,MessageKey>>{
 const errors:Partial<Record<DraftField,MessageKey>>={};
 if(!draft.channelId)errors.channel='notificationRules.error.channel';
 if(!draft.levels.length)errors.levels='notificationRules.error.levels';
 if(!draft.events.open&&!draft.events.close&&!draft.events.escalate)errors.events='notificationRules.error.events';
 return errors;
}

/** What the rule form starts with besides the stored values; tests use it to render a changed or submitted form. */
export type RuleDraftStart={draft?:Partial<Draft>;shown?:readonly DraftField[];submitted?:boolean};
/**
 * The state of the rule drawer: the draft, the fields whose errors show and the
 * reason that blocks Save. The channel, the levels and the events are choices,
 * so their error shows right after a change.
 */
export function useRuleDraft(rule:NotificationRuleView|null,start:RuleDraftStart={}){
 const [draft,setDraft]=useState<Draft>(()=>({...(rule?{channelId:rule.channel.id,levels:[...rule.levels],events:{...rule.events},enabled:rule.enabled}:{channelId:'',levels:['warning','critical'] as AlertLevel[],events:{open:true,close:true,escalate:true},enabled:true}),...start.draft}));
 const [marks,setMarks]=useState<FieldMarks<DraftField>>(()=>({changed:new Set(start.shown),shown:new Set(start.shown)}));
 const [submitted,setSubmitted]=useState(!!start.submitted);
 const errors=ruleDraftErrors(draft),visible=shownErrors(errors,marks.shown,submitted);
 return {
  draft,errors,visible,invalid:Object.keys(errors).length>0,blocked:saveBlockedKey(errors,visible),
  change:(changes:Partial<Draft>,field?:DraftField)=>{setDraft(current=>({...current,...changes}));if(field)setMarks(current=>markShown(current,[field]));},
  submit:()=>setSubmitted(true),
 };
}
export type RuleDraftState=ReturnType<typeof useRuleDraft>;

/** The create and edit drawer of a rule. Save is blocked with a reason while the form is invalid, from the first render. `start` exists for the tests. */
export function RuleDrawer({rule,view,scopeName,busy,onClose,onSave,start}:{rule:NotificationRuleView|null;view:NotificationRulesView;scopeName:string;busy:boolean;onClose:()=>void;onSave:(body:Record<string,unknown>)=>void;start?:RuleDraftStart}){
 const t=useT(),formId=useId(),form=useRuleDraft(rule,start);
 const scope=view.scope.type==='all'?t('tree.allDevices'):scopeName;
 return <Drawer open onClose={onClose} title={t(rule?'notificationRules.drawer.edit':'notificationRules.drawer.create')} description={t('notificationRules.drawer.description',{scope})}
  footer={<><Btn onClick={onClose} disabled={busy}>{t('common.cancel')}</Btn><Btn variant="primary" type="submit" form={formId} loading={busy} blocked={form.blocked?t(form.blocked):undefined}>{t('common.save')}</Btn></>}>
  <RuleForm formId={formId} rule={rule} view={view} busy={busy} form={form} onSubmit={onSave}/>
 </Drawer>;
}

/**
 * The fields of the rule drawer: the channel (create only; a channel with a
 * rule here already is not offered), the levels, the events and the switch.
 * A choice shows its error right after the change, and every error shows after
 * a submit. The form never sends while it is invalid, also not with Enter.
 */
export function RuleForm({formId,rule,view,busy,onSubmit,form}:{formId:string;rule:NotificationRuleView|null;view:NotificationRulesView;busy:boolean;onSubmit:(body:Record<string,unknown>)=>void;form:RuleDraftState}){
 const t=useT();
 const {draft,visible}=form;
 const taken=new Set(view.direct.filter(item=>item.id!==rule?.id).map(item=>item.channel.id));
 const error=(field:DraftField)=>visible[field]?<span className="sdx-field-error" id={`${formId}-${field}-error`}>{t(visible[field]!)}</span>:null;
 const submit=(event:FormEvent)=>{
  event.preventDefault();form.submit();
  if(form.invalid||busy)return;
  onSubmit(rule?{action:'update',id:rule.id,revision:rule.revision,levels:draft.levels,events:draft.events,enabled:draft.enabled}:{action:'create',channelId:draft.channelId,levels:draft.levels,events:draft.events,enabled:draft.enabled});
 };
 return <form id={formId} className="sdx-form-grid" noValidate onSubmit={submit}>
   <label className="sdx-field" htmlFor={`${formId}-channel`}><span>{t('notificationRules.field.channel')}</span>
    <select id={`${formId}-channel`} autoFocus value={draft.channelId} disabled={busy||!!rule} aria-invalid={!!visible.channel||undefined} aria-describedby={visible.channel?`${formId}-channel-error`:undefined} onChange={event=>form.change({channelId:event.target.value},'channel')}>
     {!rule&&<option value="">{t('notificationRules.chooseChannel')}</option>}
     {view.channels.filter(channel=>rule?channel.id===rule.channel.id:!taken.has(channel.id)).map(channel=><option key={channel.id} value={channel.id}>{t(channel.enabled?'notificationRules.channelOption':'notificationRules.channelOptionOff',{name:channel.name,type:t(channelTypeKeys[channel.type])})}</option>)}
    </select>
    {error('channel')}
   </label>
   <fieldset className="sdx-notification-checks" aria-invalid={!!visible.levels||undefined} aria-describedby={visible.levels?`${formId}-levels-error`:undefined}>
    <legend>{t('notificationRules.field.levels')}</legend>
    {levels.map(level=><label key={level}><input type="checkbox" className="sdx-check" checked={draft.levels.includes(level)} disabled={busy} onChange={event=>form.change({levels:event.target.checked?levels.filter(item=>item===level||draft.levels.includes(item)):draft.levels.filter(item=>item!==level)},'levels')}/>{t(`alertRules.level.${level}`)}</label>)}
    {error('levels')}
   </fieldset>
   <fieldset className="sdx-notification-checks" aria-invalid={!!visible.events||undefined} aria-describedby={visible.events?`${formId}-events-error`:undefined}>
    <legend>{t('notificationRules.field.events')}</legend>
    {(Object.keys(eventKeys) as (keyof RuleEvents)[]).map(event=><label key={event}><input type="checkbox" className="sdx-check" checked={draft.events[event]} disabled={busy} onChange={change=>form.change({events:{...draft.events,[event]:change.target.checked}},'events')}/>{t(eventKeys[event])}</label>)}
    {error('events')}
   </fieldset>
   <div className="sdx-switch-field"><label><input type="checkbox" role="switch" checked={draft.enabled} disabled={busy} onChange={event=>form.change({enabled:event.target.checked})}/>{t('notificationRules.field.enabled')}</label></div>
  </form>;
}
