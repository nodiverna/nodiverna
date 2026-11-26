'use client';
// The page Settings → Notification channels (docs/notifications.md): the tabs
// Channels and Delivery log (#settings/notification-channels[/log]: frame.tab and
// frame.onTab, the items from the page's tab nodes in ui/shell/nav-model.ts), the page
// primary "Add channel" in the page header of the console frame, the channel table (email over SMTP,
// Microsoft Teams, Discord, a signed webhook) and the delivery log. Every read
// and write needs the portal right "Manage notification channels"; the server
// decides. Channel changes and a test message rely on the live MFA login session
// (lib/step-up.ts: notification edits are low impact) and go out at once. Delete
// and "Generate new signing secret" confirm first. Secrets are never sent back:
// a stored secret shows as a placeholder, and the webhook signing secret appears
// once after create and after a rotation. An email channel signs in with a
// password, Microsoft 365 or Google Workspace (the Sign-in pick list right after
// Name); the fields of the chosen sign-in fade in when the choice changes.
// Sample devices change nothing here: the page shows and changes the real channels.
import {useCallback,useEffect,useId,useRef,useState,type FormEvent,type ReactElement} from 'react';
import {toast} from 'sonner';
import {FileKey,KeyRound,LayoutGrid,Pencil,Plus,Power,Send,Trash2} from 'lucide-react';
import type {Viewer} from '@/lib/types';
import type {ChannelView} from '@/lib/server/notifications/notification-channels';
import type {NotificationLogRow} from '@/lib/server/notifications/notifications';
import type {ChannelType,SmtpAuth} from '@/lib/server/notifications/notify/send';
import {alertRuleName} from '@/lib/alert-rules-text';
import {isAlertRuleId} from '@/lib/alert-rules';
import {isDiscordWebhookUrl} from '@/lib/discord-webhook-url';
import {sortTableRows} from '@/ui/base/table-sort';
import {catalogs,type MessageKey,type MessageParams} from '@/lib/i18n/translate';
import {api,message} from '@/ui/base/api';
import {MfaStepUp} from '@/ui/session/mfa-step-up';
import {useStepUp} from '@/ui/session/step-up-retry';
import {consoleRouteHash} from '@/lib/console-route';
import {pageTabNodes} from '@/ui/shell/nav-model';
import {frameHeader,useFrameRefresh,type PageFrame} from '@/ui/shell/page-frame';
import {Btn,CopyValue,Drawer,DrawerCancel,Menu,Notice,PickRow,Segmented,SettingsPage,StatusPill,cx,exactTime,relativeTime,type MenuEntry,type StatusKind} from '@/ui/kit/kit';
import {DataTable,Toolbar,type DataColumn,type TableSort} from '@/ui/kit/data-table';
import {ConfirmDialog} from '@/ui/kit/confirm-dialog';
import {Field,Select,Switch} from '@/ui/kit/field';
import {Tabs,tabId} from '@/ui/kit/tabs';
import {useLocale,useT,type Translate} from '@/ui/base/locale';
import '@/ui/settings/notifications-panel.css';
import {channelTypeIcons,channelTypeKeys,markChanged,markLeft,markShown,saveBlockedKey,shownErrors,type FieldMarks} from '@/ui/settings/notification-fields';
import {EMPTY_VALUE} from '@/lib/i18n/format';
export {channelTypeIcons,channelTypeKeys,markChanged,markLeft,markShown,saveBlockedKey,shownErrors,type FieldMarks};

const channelsEndpoint='/api/notifications/channels',logEndpoint='/api/notifications/log';
/** The order of the type pick list in the create drawer. */
export const channelTypeOrder:readonly ChannelType[]=['smtp','teams','discord','webhook'];
const urlLabels:Record<Exclude<ChannelType,'smtp'>,{label:MessageKey;hint:MessageKey;placeholder:string}>={
 teams:{label:'notifications.field.teamsUrl',hint:'notifications.hint.teams',placeholder:'https://'},
 discord:{label:'notifications.field.discordUrl',hint:'notifications.hint.discord',placeholder:'https://discord.com/api/webhooks/…'},
 webhook:{label:'notifications.field.webhookUrl',hint:'notifications.hint.webhook',placeholder:'https://'},
};
type Tab='channels'|'log';
type ChangeResult={ok:true;id?:string;revision?:number;signingSecret?:string};
/** The tab of the frame (settingsPageTabs): log is the Delivery log, anything else Channels. */
const notificationTab=(tab:string|undefined):Tab=>tab==='log'?'log':'channels';

/** The sign-ins of an email channel in the order of the pick list, with their label, hint and icon. */
export const smtpAuthOrder:readonly SmtpAuth[]=['password','microsoft365','google'];
export const smtpAuthLabels:Record<SmtpAuth,{label:MessageKey;hint:MessageKey}>={
 password:{label:'notifications.auth.password',hint:'notifications.auth.passwordHint'},
 microsoft365:{label:'notifications.auth.microsoft365',hint:'notifications.auth.microsoft365Hint'},
 google:{label:'notifications.auth.google',hint:'notifications.auth.googleHint'},
};
/** One distinct icon per sign-in: a key, the four-tile app launcher of Microsoft 365, the key file of a Google service account. */
export const smtpAuthIcons={password:KeyRound,microsoft365:LayoutGrid,google:FileKey} as const;
/** The target column: SMTP from its settings in the page language (server and port, or the sign-in provider), a URL as the masked hint. */
export function channelTarget(channel:Pick<ChannelView,'type'|'config'|'targetHint'>,t:Translate):string{
 if(channel.type!=='smtp'||!('recipients' in channel.config))return channel.targetHint;
 const smtp=channel.config,count=smtp.recipients.length;
 if(smtp.auth==='microsoft365')return t('notifications.target.microsoft365',{count});
 if(smtp.auth==='google')return t('notifications.target.google',{count});
 return t('notifications.target.smtp',{count,host:smtp.host,port:smtp.port});
}
/** The catalog text of a stored delivery error (apiError.notify.*), or the key when it is unknown. */
export function deliveryErrorText(key:string|null,params:MessageParams|null,t:Translate):string|null{
 if(!key)return null;
 return Object.hasOwn(catalogs.en,key)?t(key as MessageKey,params??undefined):key;
}

/**
 * The channels of the page: GET with a reload, and the channel changes through useStepUp. No change opens the
 * MFA dialog first (lib/step-up.ts); an answer that still asks for a proof opens it and resends once. A change
 * that went through reloads the table. Cancelling sends nothing.
 */
function useChannels(frame:PageFrame|undefined){
 const [locale]=useLocale();
 const [channels,setChannels]=useState<ChannelView[]|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[loadedAt,setLoadedAt]=useState(0);
 const mounted=useRef(true),sequence=useRef(0);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 const load=useCallback(async()=>{
  const current=++sequence.current;setLoading(true);
  try{const result=await api<{channels:ChannelView[]}>(channelsEndpoint);if(mounted.current&&current===sequence.current){setChannels(result.channels);setLoadedAt(Date.now());setError('');}}
  catch(failure){if(mounted.current&&current===sequence.current)setError(message(failure,locale));}
  finally{if(mounted.current&&current===sequence.current)setLoading(false);}
 },[locale]);
 useEffect(()=>{queueMicrotask(()=>void load());},[load]);
 useFrameRefresh(frame,load);
 const change=useStepUp<Record<string,unknown>,ChangeResult>({locale,needsStepUp:()=>false,send:body=>api<ChangeResult>(channelsEndpoint,body)});
 const run=async(body:Record<string,unknown>)=>{const result=await change.run(body);if(result)void load();return result;};
 return {channels,error,loading,loadedAt,load,run,busy:change.busy,dialog:change.dialog};
}

export default function NotificationsPanel({frame}:{viewer?:Viewer;frame?:PageFrame}){
 const t=useT(),tab=notificationTab(frame?.tab),panelId='sdx-notifications-panel';
 const data=useChannels(frame);
 const [creating,setCreating]=useState(false),[secret,setSecret]=useState<{name:string;value:string}|null>(null);
 const create=async(body:Record<string,unknown>)=>{
  const result=await data.run(body);
  if(!result)return;
  toast.success(t('notifications.saved'));setCreating(false);
  if(result.signingSecret)setSecret({name:String(body.name),value:result.signingSecret});
 };
 // The tab bar from the page's tab nodes (ui/shell/nav-model.ts): Channels and Delivery log with their links.
 const tabs=pageTabNodes({view:'settings',page:'notification-channels'}).map(node=>({id:node.tab??'',label:t(node.label),href:consoleRouteHash(node.route)}));
 // The page header keeps its own gap below it; the tabs and the tab panel follow in the page grid.
 return <div className="sdx-notifications-page">
  {frameHeader(frame,<Btn variant="primary" icon={Plus} onClick={()=>setCreating(true)}>{t('notifications.add')}</Btn>)}
  <div className="sdx-notifications">
   <Tabs items={tabs} value={tab} onChange={id=>frame?.onTab(id)} label={t('notifications.tabsLabel')} panelId={panelId}/>
   <div id={panelId} role="tabpanel" aria-labelledby={tabId(panelId,tab)} className="sdx-notifications-panel">
    {tab==='channels'?<ChannelsView data={data} onAdd={()=>setCreating(true)} onSecret={setSecret}/>:<DeliveryLog frame={frame}/>}
   </div>
  </div>
  {creating&&<ChannelDrawer key="new" channel={null} busy={data.busy} onClose={()=>setCreating(false)} onSave={create}/>}
  <SecretDrawer secret={secret} onClose={()=>setSecret(null)}/>
  <MfaStepUp {...data.dialog}/>
 </div>;
}

type ChannelsData=ReturnType<typeof useChannels>;
/** The Channels tab: the table with its row menu, the edit drawer and the delete and rotation confirmations. */
function ChannelsView({data,onAdd,onSecret}:{data:ChannelsData;onAdd:()=>void;onSecret:(secret:{name:string;value:string})=>void}){
 const t=useT(),[locale]=useLocale();
 const [editing,setEditing]=useState<ChannelView|null>(null),[deleting,setDeleting]=useState<ChannelView|null>(null),[rotating,setRotating]=useState<ChannelView|null>(null),[testing,setTesting]=useState<string|null>(null);
 const [sort,setSort]=useState<TableSort<ChannelColumn>>(defaultChannelSort);
 const mounted=useRef(true);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 const blocked=data.busy?t('kit.busy'):undefined;
 const test=async(channel:ChannelView)=>{
  if(testing)return;
  setTesting(channel.id);
  try{await api(channelsEndpoint,{action:'test',id:channel.id});toast.success(t('notifications.testSent'));}
  catch(failure){toast.error(message(failure,locale));}
  finally{if(mounted.current)setTesting(null);void data.load();}
 };
 const setEnabled=async(channel:ChannelView,enabled:boolean)=>{if(await data.run({action:'set-enabled',id:channel.id,revision:channel.revision,enabled}))toast.success(t('notifications.saved'));};
 // The rotation runs only after its confirmation; Cancel sends nothing.
 const rotate=async(channel:ChannelView)=>{setRotating(null);const result=await data.run({action:'rotate-secret',id:channel.id,revision:channel.revision});if(result?.signingSecret){toast.success(t('notifications.rotated'));onSecret({name:channel.name,value:result.signingSecret});}};
 const remove=async(channel:ChannelView)=>{setDeleting(null);if(await data.run({action:'delete',id:channel.id,revision:channel.revision}))toast.success(t('notifications.deleted'));};
 const menu=(channel:ChannelView):MenuEntry[]=>[
  {id:'test',label:t('notifications.menu.test'),icon:Send,blocked:blocked??(testing?t('kit.busy'):undefined),onSelect:()=>void test(channel)},
  {id:'edit',label:t('notifications.menu.edit'),icon:Pencil,blocked,onSelect:()=>setEditing(channel)},
  {id:'enable',label:t(channel.enabled?'notifications.menu.off':'notifications.menu.on'),icon:Power,blocked,onSelect:()=>void setEnabled(channel,!channel.enabled)},
  ...(channel.type==='webhook'?[{id:'rotate',label:t('notifications.menu.rotate'),icon:KeyRound,blocked,onSelect:()=>setRotating(channel)}]:[]),
  {id:'separator',separator:true},
  {id:'delete',label:t('notifications.menu.delete'),icon:Trash2,danger:true,blocked,onSelect:()=>setDeleting(channel)},
 ];
 const {channels,error}=data;
 return <>
  <SettingsPage label={t('nav.settings.notificationChannels')} loading={!channels&&!error} loadError={error?`${t('notifications.loadFailed')}${channels?' '+t('notifications.staleData'):''}`:undefined} onRetry={()=>void data.load()} retrying={data.loading}
   wide={channels&&<ChannelsTable channels={channels} loadedAt={data.loadedAt} menu={menu} sort={sort} onSort={setSort} onAdd={onAdd}/>}/>
  {editing&&<ChannelDrawer key={editing.id} channel={editing} busy={data.busy} onClose={()=>setEditing(null)}
   onSave={async body=>{const result=await data.run(body);if(!result)return;toast.success(t('notifications.saved'));setEditing(null);}}/>}
  <ConfirmDialog open={!!deleting} onOpenChange={open=>{if(!open)setDeleting(null);}} tone="danger" title={t('notifications.delete.title',{name:deleting?.name??''})}
   body={deleting?.ruleCount?t('notifications.delete.rules',{count:deleting.ruleCount}):t('notifications.delete.noRules')} confirmLabel={t('notifications.delete.confirm')} onConfirm={()=>{if(deleting)void remove(deleting);}}/>
  <ConfirmDialog open={!!rotating} onOpenChange={open=>{if(!open)setRotating(null);}} tone="danger" title={t('notifications.rotate.title',{name:rotating?.name??''})}
   body={t('notifications.rotate.body')} confirmLabel={t('notifications.menu.rotate')} onConfirm={()=>{if(rotating)void rotate(rotating);}}/>
 </>;
}

export type ChannelColumn='name'|'type'|'status'|'lastDelivery';
const defaultChannelSort:TableSort<ChannelColumn>={column:'name',direction:'asc'};
/** The channel rows in the order of a sort: Name, Type, Status (On first ascending) and Last delivery (none last). */
export function sortChannels(channels:readonly ChannelView[],sort:TableSort<ChannelColumn>|null,t:Translate):ChannelView[]{
 return sortTableRows(channels,sort,{name:channel=>channel.name,type:channel=>t(channelTypeKeys[channel.type]),status:channel=>channel.enabled?0:1,lastDelivery:channel=>channel.lastDelivery?.at});
}
/** The channel table: Name, Type, Target, Status, Last delivery and the row menu; Empty with "Add channel" without channels. */
export function ChannelsTable({channels,loadedAt,menu,sort=defaultChannelSort,onSort,onAdd}:{channels:ChannelView[];loadedAt:number;menu:(channel:ChannelView)=>MenuEntry[];sort?:TableSort<ChannelColumn>;onSort?:(next:TableSort<ChannelColumn>)=>void;onAdd?:()=>void}){
 const t=useT(),[locale]=useLocale();
 const columns:DataColumn<ChannelView>[]=[
  {id:'name',label:t('notifications.col.name'),primary:true,sort:{first:'asc'},cell:channel=><strong>{channel.name}</strong>},
  {id:'type',label:t('notifications.col.type'),sort:{first:'asc'},cell:channel=>{const Icon=channelTypeIcons[channel.type];return <span className="sdx-notification-type"><Icon size={14} aria-hidden/>{t(channelTypeKeys[channel.type])}</span>;}},
  {id:'target',label:t('notifications.col.target'),wrap:true,cell:channel=><span className="mono">{channelTarget(channel,t)}</span>},
  {id:'status',label:t('notifications.col.status'),sort:{first:'asc'},cell:channel=>channel.enabled?<StatusPill kind="success">{t('notifications.status.on')}</StatusPill>:<StatusPill kind="neutral">{t('notifications.status.off')}</StatusPill>},
  {id:'lastDelivery',label:t('notifications.col.lastDelivery'),sort:{first:'desc'},cell:channel=>channel.lastDelivery?<span className="sdx-muted-cell" title={exactTime(channel.lastDelivery.at,locale)}>{t(channel.lastDelivery.status==='sent'?'notifications.lastDelivery.sent':'notifications.lastDelivery.failed',{time:relativeTime(channel.lastDelivery.at,Math.max(loadedAt,channel.lastDelivery.at),locale)})}</span>:<span className="sdx-muted-cell">{t('notifications.lastDelivery.never')}</span>},
  {id:'actions',label:t('notifications.col.actions'),hideLabel:true,className:'sdx-col-actions',align:'end',cell:channel=><Menu label={t('notifications.actionsFor',{name:channel.name})} entries={menu(channel)}/>},
 ];
 return <DataTable<ChannelView> columns={columns} rows={sortChannels(channels,sort,t)} rowKey={channel=>channel.id} label={t('nav.settings.notificationChannels')} cards entranceId="notification-channels" className="sdx-notification-channels"
  sort={sort} onSort={next=>onSort?.(next as TableSort<ChannelColumn>)}
  empty={{icon:Send,title:t('notifications.empty.title'),children:t('notifications.empty.text'),action:onAdd&&<Btn size="sm" icon={Plus} onClick={onAdd}>{t('notifications.add')}</Btn>}}/>;
}

type Draft={type:ChannelType;name:string;enabled:boolean;language:'en'|'de';auth:SmtpAuth;host:string;port:string;tls:'tls'|'starttls'|'none';from:string;recipients:string;username:string;password:string;
 tenantId:string;clientId:string;clientSecret:string;serviceAccountKey:string;url:string};
type DraftField='name'|'host'|'port'|'from'|'recipients'|'username'|'password'|'tenantId'|'clientId'|'clientSecret'|'serviceAccountKey'|'url';
const draftFields:readonly DraftField[]=['name','host','port','from','recipients','username','password','tenantId','clientId','clientSecret','serviceAccountKey','url'];
const emailPattern=/^[^\s@<>()",;:\\[\]]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const hostPattern=/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.?$|^\[?[0-9a-f:.]+\]?$/i;
const domainPattern=/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const guidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const controlCharacters=/[\u0000-\u001f\u007f]/;
/** The BEGIN line of a PEM private key, PKCS #8 or RSA (\s keeps the literal marker out of the source, which the key scan of tests/repo/key-material.mjs refuses). */
const pemPrivateKey=/-----BEGIN (?:RSA )?PRIVATE\sKEY-----/;
/** The JSON key file of a service account: at most 16 KiB, as on the server. */
export const serviceAccountKeyBytes=16*1024;
export const recipientList=(text:string)=>text.split(/[,;\s]+/).map(item=>item.trim()).filter(Boolean);
function draftOf(channel:ChannelView|null):Draft{
 const smtp=channel?.type==='smtp'&&'recipients' in channel.config?channel.config:null;
 const password=smtp?.auth==='password'?smtp:null,microsoft=smtp?.auth==='microsoft365'?smtp:null;
 return {type:channel?.type??'smtp',name:channel?.name??'',enabled:channel?.enabled??true,language:channel?.language??'en',auth:smtp?.auth??'password',
  host:password?.host??'',port:password?String(password.port):'587',tls:password?.tls??'starttls',from:smtp?.from??'',recipients:smtp?.recipients.join(', ')??'',username:password?.username??'',password:'',
  tenantId:microsoft?.tenantId??'',clientId:microsoft?.clientId??'',clientSecret:'',serviceAccountKey:'',url:''};
}
/** The stored state a draft is checked against: a stored URL, the sign-in whose secret is stored, the stored service account. */
export type StoredSecrets={url:boolean;secretAuth?:SmtpAuth|null;serviceAccount?:string|null};
/** Whether a pasted key looks like a service account key: JSON with "type": "service_account", client_email and private_key. The server checks the key itself. */
export function looksLikeServiceAccountKey(text:string):boolean{
 if(new TextEncoder().encode(text).length>serviceAccountKeyBytes)return false;
 try{
  const file=JSON.parse(text) as Record<string,unknown>|null;
  return !!file&&typeof file==='object'&&file.type==='service_account'&&typeof file.client_email==='string'&&emailPattern.test(file.client_email)&&typeof file.private_key==='string'&&pemPrivateKey.test(file.private_key);
 }catch{return false;}
}
/**
 * Field errors with the server rules (lib/server/notifications/notification-channels.ts); the server
 * checks again. Discord URLs use the shared rule of lib/discord-webhook-url.ts:
 * a Discord channel needs one, a Teams or webhook channel refuses one. An email
 * channel checks the fields of its sign-in; the client secret and the service
 * account key are needed on create and after a change of the sign-in, else an
 * empty field keeps the stored one.
 */
export function channelDraftErrors(draft:Draft,stored:StoredSecrets):Partial<Record<DraftField,MessageKey>>{
 const errors:Partial<Record<DraftField,MessageKey>>={};
 if(!draft.name.trim()||draft.name.trim().length>80)errors.name='notifications.error.name';
 if(draft.type==='smtp'){
  if(!emailPattern.test(draft.from.trim()))errors.from='notifications.error.from';
  const list=recipientList(draft.recipients);
  if(!list.length||list.length>20||!list.every(item=>emailPattern.test(item))||new Set(list.map(item=>item.toLowerCase())).size!==list.length)errors.recipients='notifications.error.recipients';
  const keeps=stored.secretAuth===draft.auth;
  if(draft.auth==='microsoft365'){
   const tenant=draft.tenantId.trim();
   if(!guidPattern.test(tenant)&&!domainPattern.test(tenant))errors.tenantId='notifications.error.tenantId';
   if(!guidPattern.test(draft.clientId.trim()))errors.clientId='notifications.error.clientId';
   if(draft.clientSecret?draft.clientSecret.length>512||controlCharacters.test(draft.clientSecret):!keeps)errors.clientSecret='notifications.error.clientSecret';
  }else if(draft.auth==='google'){
   if(draft.serviceAccountKey.trim()?!looksLikeServiceAccountKey(draft.serviceAccountKey):!keeps)errors.serviceAccountKey='notifications.error.serviceAccountKey';
  }else{
   if(!hostPattern.test(draft.host.trim()))errors.host='notifications.error.host';
   const port=Number(draft.port);if(!/^\d{1,5}$/.test(draft.port)||port<1||port>65535)errors.port='notifications.error.port';
   const username=draft.username.trim();
   if(username.length>256||draft.tls==='none'&&username||!username&&draft.password)errors.username='notifications.error.username';
   if(draft.password.length>256||draft.tls==='none'&&draft.password)errors.password='notifications.error.password';
  }
 }else if(draft.type==='discord'){
  if(draft.url?!isDiscordWebhookUrl(draft.url.trim()):!stored.url)errors.url='notifications.error.discordUrl';
 }else if(draft.url?!/^https:\/\/[^\s/@:]+(?::\d+)?(?:[/?#]\S*)?$/i.test(draft.url)||draft.url.length>2048:!stored.url)errors.url='notifications.error.url';
 else if(isDiscordWebhookUrl(draft.url.trim()))errors.url='notifications.error.discordUrlWrongType';
 return errors;
}
/** The settings of an email channel in the request: auth and only the fields of that sign-in; an empty secret field is left out. */
function smtpSettings(draft:Draft):Record<string,unknown>{
 const shared={auth:draft.auth,from:draft.from.trim(),recipients:recipientList(draft.recipients)};
 if(draft.auth==='microsoft365')return {...shared,tenantId:draft.tenantId.trim(),clientId:draft.clientId.trim(),...(draft.clientSecret?{clientSecret:draft.clientSecret}:{})};
 if(draft.auth==='google')return {...shared,...(draft.serviceAccountKey.trim()?{serviceAccountKey:draft.serviceAccountKey}:{})};
 return {...shared,host:draft.host.trim(),port:Number(draft.port),tls:draft.tls,username:draft.username.trim()||null,...(draft.password?{password:draft.password}:{})};
}
/** The request body of the drawer: an empty password, client secret, key or URL keeps the stored one. */
export function channelBody(draft:Draft,channel:ChannelView|null):Record<string,unknown>{
 const base={name:draft.name.trim(),enabled:draft.enabled,language:draft.language};
 const settings=draft.type==='smtp'?smtpSettings(draft):draft.url?{url:draft.url.trim()}:{};
 return channel?{action:'update',id:channel.id,revision:channel.revision,...base,...settings}:{action:'create',type:draft.type,...base,...settings};
}


/** What a drawer form starts with besides the stored values; tests use it to render a changed or submitted form. */
export type ChannelDraftStart={draft?:Partial<Draft>;shown?:readonly DraftField[];submitted?:boolean};
/**
 * The state of the channel drawer: the draft, the fields whose errors show and
 * the reason that blocks Save. The drawer owns it, so Save is blocked from the
 * first render while the form is invalid.
 */
export function useChannelDraft(channel:ChannelView|null,start:ChannelDraftStart={}){
 const [draft,setDraft]=useState<Draft>(()=>({...draftOf(channel),...start.draft}));
 const [marks,setMarks]=useState<FieldMarks<DraftField>>(()=>({changed:new Set(start.shown),shown:new Set(start.shown)}));
 const [submitted,setSubmitted]=useState(!!start.submitted);
 const smtp=channel?.type==='smtp'&&'recipients' in channel.config?channel.config:null;
 const stored:StoredSecrets={url:!!channel&&channel.type!=='smtp',secretAuth:smtp&&channel?.secretSet?smtp.auth:null,serviceAccount:smtp?.auth==='google'?smtp.serviceAccount:null};
 const errors=channelDraftErrors(draft,stored),visible=shownErrors(errors,marks.shown,submitted);
 // The draft differs from the stored values (or the defaults of a new channel): a close asks "Discard changes?".
 const base=draftOf(channel),dirty=(Object.keys(base) as (keyof Draft)[]).some(key=>draft[key]!==base[key]);
 return {
  draft,stored,errors,visible,dirty,invalid:Object.keys(errors).length>0,blocked:saveBlockedKey(errors,visible),
  /** A change of the values; `fields` are the text fields it changed. */
  change:(changes:Partial<Draft>,fields:readonly DraftField[]=[])=>{setDraft(current=>({...current,...changes}));setMarks(current=>markChanged(current,fields));},
  /** The user left a field: its error shows from now on if the user changed it. */
  leave:(field:DraftField)=>setMarks(current=>markLeft(current,field)),
  /** Errors of these fields show at once (a choice that can make them invalid). */
  reveal:(fields:readonly DraftField[])=>setMarks(current=>markShown(current,fields)),
  submit:()=>setSubmitted(true),
 };
}
export type ChannelDraftState=ReturnType<typeof useChannelDraft>;

/** The create and edit drawer. Save is blocked with a reason while the form is invalid, from the first render; a close with changes asks first. `start` exists for the tests. */
export function ChannelDrawer({channel,busy,onClose,onSave,start}:{channel:ChannelView|null;busy:boolean;onClose:()=>void;onSave:(body:Record<string,unknown>)=>Promise<void>|void;start?:ChannelDraftStart}){
 const t=useT(),formId=useId(),form=useChannelDraft(channel,start);
 return <Drawer open onClose={onClose} dirty={form.dirty} icon={channel?channelTypeIcons[channel.type]:Plus} title={t(channel?'notifications.drawer.edit':'notifications.drawer.create')} description={t('notifications.drawer.description')}
  footer={<>{busy?<Btn blocked={t('kit.busy')}>{t('common.cancel')}</Btn>:<DrawerCancel/>}<Btn variant="primary" type="submit" form={formId} loading={busy} blocked={form.blocked?t(form.blocked):undefined}>{t('common.save')}</Btn></>}>
  <ChannelForm formId={formId} channel={channel} busy={busy} form={form} onSubmit={body=>void onSave(body)}/>
 </Drawer>;
}

/** The props of a drawer control: a stable id (the form id and the field) and the blur after which the field's error shows. */
type ControlProps={id:string;onBlur:()=>void};
/**
 * The fields of the create and edit drawer: the type pick list (create only),
 * the name, for email the Sign-in pick list and the fields of that sign-in, the
 * language and the switch. Every text field is a kit Field; TLS mode and
 * Language are the kit Select, Enabled the kit Switch. A stored secret shows the
 * placeholder "Stored – leave empty to keep" while the sign-in stays. A field
 * shows its error once the user changed it and left it, and every error shows
 * after a submit. The form never sends while it is invalid, also not with Enter.
 * The fields of a new sign-in fade in (sdx-fade), not on the first render.
 */
export function ChannelForm({formId,channel,busy,onSubmit,form}:{formId:string;channel:ChannelView|null;busy:boolean;onSubmit:(body:Record<string,unknown>)=>void;form:ChannelDraftState}){
 const t=useT();
 const {draft,stored,visible}=form;
 const [switched,setSwitched]=useState(false),keyFile=useRef<HTMLInputElement>(null);
 const set=(changes:Partial<Draft>)=>form.change(changes,(Object.keys(changes) as (keyof Draft)[]).filter((key):key is DraftField=>draftFields.includes(key as DraftField)));
 const submit=(event:FormEvent)=>{event.preventDefault();form.submit();if(!form.invalid&&!busy)onSubmit(channelBody(draft,channel));};
 const field=(name:DraftField,label:MessageKey,control:(props:ControlProps)=>ReactElement<{id?:string}>,hint?:string)=>{
  const error=visible[name];
  return <Field label={t(label)} hint={hint} error={error?t(error):undefined}>{control({id:`${formId}-${name}`,onBlur:()=>form.leave(name)})}</Field>;
 };
 const storedHint=t('notifications.hint.stored'),urlField=draft.type==='smtp'?urlLabels.webhook:urlLabels[draft.type];
 // The stored secret applies while the sign-in stays the stored one.
 const keeps=stored.secretAuth===draft.auth;
 const chooseAuth=(auth:SmtpAuth)=>{if(auth===draft.auth)return;setSwitched(true);set({auth});};
 // A key file is read in the browser, at most 16 KiB; its text goes into the field.
 const readKeyFile=async(file:File|undefined)=>{
  if(!file)return;
  try{
   if(file.size>serviceAccountKeyBytes)throw new Error('too large');
   const text=await file.text();
   form.change({serviceAccountKey:text},['serviceAccountKey']);form.reveal(['serviceAccountKey']);
  }catch{toast.error(t('notifications.keyFile.failed'));}
  finally{if(keyFile.current)keyFile.current.value='';}
 };
 const sender=(hint?:string)=>field('from','notifications.field.from',props=><input {...props} type="email" autoComplete="off" value={draft.from} disabled={busy} onChange={event=>set({from:event.target.value})}/>,hint);
 const recipients=field('recipients','notifications.field.recipients',props=><textarea {...props} rows={2} value={draft.recipients} disabled={busy} onChange={event=>set({recipients:event.target.value})}/>,t('notifications.hint.recipients'));
 const signIn=<div className="sdx-field"><span className="sdx-field-label" id={`${formId}-auth`}>{t('notifications.field.auth')}</span>
  <div className="sdx-pick-list" role="radiogroup" aria-labelledby={`${formId}-auth`}>{smtpAuthOrder.map(auth=>{const Icon=smtpAuthIcons[auth];return <PickRow key={auth} selected={draft.auth===auth} icon={<Icon size={15} aria-hidden/>} label={t(smtpAuthLabels[auth].label)} hint={t(smtpAuthLabels[auth].hint)} onSelect={()=>chooseAuth(auth)}/>;})}</div>
 </div>;
 const modeClass=cx('sdx-form-grid sdx-notification-mode',switched&&'sdx-notification-mode-enter');
 return <form id={formId} className="sdx-form-grid sdx-notification-form" noValidate onSubmit={submit}>
   {!channel&&<div className="sdx-field"><span className="sdx-field-label" id={`${formId}-type`}>{t('notifications.field.type')}</span>
    <div className="sdx-pick-list" role="radiogroup" aria-labelledby={`${formId}-type`}>{channelTypeOrder.map(type=>{const Icon=channelTypeIcons[type];return <PickRow key={type} selected={draft.type===type} icon={<Icon size={15} aria-hidden/>} label={t(channelTypeKeys[type])} onSelect={()=>set({type})}/>;})}</div>
   </div>}
   {field('name','notifications.field.name',props=><input {...props} autoFocus maxLength={80} value={draft.name} disabled={busy} onChange={event=>set({name:event.target.value})}/>)}
   {draft.type==='smtp'&&signIn}
   {draft.type==='smtp'&&draft.auth==='microsoft365'?<div key="microsoft365" className={modeClass}>
    <p className="sdx-notification-mode-hint">{t('notifications.hint.microsoft365')}</p>
    {sender(t('notifications.hint.senderMailbox'))}
    {recipients}
    <div className="sdx-notification-pair sdx-notification-pair-even">
     {field('tenantId','notifications.field.tenantId',props=><input {...props} className="mono" autoComplete="off" spellCheck={false} placeholder="contoso.onmicrosoft.com" value={draft.tenantId} disabled={busy} onChange={event=>set({tenantId:event.target.value})}/>)}
     {field('clientId','notifications.field.clientId',props=><input {...props} className="mono" autoComplete="off" spellCheck={false} value={draft.clientId} disabled={busy} onChange={event=>set({clientId:event.target.value})}/>)}
    </div>
    {field('clientSecret','notifications.field.clientSecret',props=><input {...props} type="password" autoComplete="new-password" maxLength={512} placeholder={keeps?storedHint:undefined} value={draft.clientSecret} disabled={busy} onChange={event=>set({clientSecret:event.target.value})}/>)}
   </div>
   :draft.type==='smtp'&&draft.auth==='google'?<div key="google" className={modeClass}>
    <p className="sdx-notification-mode-hint">{t('notifications.hint.google')}</p>
    {sender(t('notifications.hint.senderMailbox'))}
    {recipients}
    <div className="sdx-notification-key">
     {field('serviceAccountKey','notifications.field.serviceAccountKey',props=><textarea {...props} className="mono" rows={5} autoComplete="off" spellCheck={false} placeholder={keeps?storedHint:'{ "type": "service_account", … }'} value={draft.serviceAccountKey} disabled={busy}
      onChange={event=>set({serviceAccountKey:event.target.value})}
      onDragOver={event=>{if(event.dataTransfer.types.includes('Files'))event.preventDefault();}}
      onDrop={event=>{const file=event.dataTransfer.files[0];if(file){event.preventDefault();void readKeyFile(file);}}}/>,keeps&&stored.serviceAccount?t('notifications.serviceAccount.stored',{account:stored.serviceAccount}):undefined)}
     <div className="sdx-notification-keyfile">
      <Btn icon={FileKey} blocked={busy?t('kit.busy'):undefined} onClick={()=>keyFile.current?.click()}>{t('notifications.keyFile.choose')}</Btn>
      <input ref={keyFile} type="file" accept=".json,application/json" hidden tabIndex={-1} aria-hidden onChange={event=>void readKeyFile(event.target.files?.[0])}/>
     </div>
    </div>
   </div>
   :draft.type==='smtp'?<div key="password" className={modeClass}>
    <div className="sdx-notification-pair">
     {field('host','notifications.field.host',props=><input {...props} className="mono" autoComplete="off" value={draft.host} disabled={busy} onChange={event=>set({host:event.target.value})}/>)}
     {field('port','notifications.field.port',props=><input {...props} type="number" inputMode="numeric" min={1} max={65535} value={draft.port} disabled={busy} onChange={event=>set({port:event.target.value})}/>)}
    </div>
    <Field label={t('notifications.field.tls')}><Select id={`${formId}-tls`} value={draft.tls} blocked={busy?t('kit.busy'):undefined} onChange={event=>{set({tls:event.target.value as Draft['tls']});form.reveal(['username','password']);}}>{(['tls','starttls','none'] as const).map(mode=><option key={mode} value={mode}>{t(`notifications.tls.${mode}`)}</option>)}</Select></Field>
    {sender()}
    {recipients}
    <div className="sdx-notification-pair">
     {field('username','notifications.field.username',props=><input {...props} autoComplete="off" value={draft.username} disabled={busy||draft.tls==='none'} onChange={event=>set({username:event.target.value})}/>)}
     {field('password','notifications.field.password',props=><input {...props} type="password" autoComplete="new-password" placeholder={keeps?storedHint:undefined} value={draft.password} disabled={busy||draft.tls==='none'} onChange={event=>set({password:event.target.value})}/>,t('notifications.hint.appPassword'))}
    </div>
   </div>:field('url',urlField.label,props=><input {...props} type="url" className="mono" autoComplete="off" spellCheck={false} placeholder={stored.url?storedHint:urlField.placeholder} value={draft.url} disabled={busy} onChange={event=>set({url:event.target.value})}/>,t(urlField.hint))}
   <Field label={t('notifications.field.language')}><Select id={`${formId}-language`} value={draft.language} blocked={busy?t('kit.busy'):undefined} onChange={event=>set({language:event.target.value==='de'?'de':'en'})}><option value="en">{t('notifications.language.en')}</option><option value="de">{t('notifications.language.de')}</option></Select></Field>
   <Switch label={t('notifications.field.enabled')} checked={draft.enabled} blocked={busy?t('kit.busy'):undefined} onChange={enabled=>set({enabled})}/>
  </form>;
}

/** The signing secret, once: the warning, the secret with its copy button, and Done. */
function SecretDrawer({secret,onClose}:{secret:{name:string;value:string}|null;onClose:()=>void}){
 const t=useT();
 return <Drawer open={!!secret} onClose={onClose} icon={KeyRound} title={t('notifications.secret.title')} description={secret?.name}
  footer={<Btn variant="primary" onClick={onClose}>{t('notifications.secret.done')}</Btn>}>
  {secret&&<SecretContent value={secret.value}/>}
 </Drawer>;
}
/** The note that the secret is not shown again, then the secret in the kit CopyValue (the icon turns into a check for 1.2 s). */
export function SecretContent({value}:{value:string}){
 const t=useT();
 return <div className="sdx-form-grid sdx-notification-secret">
   <Notice tone="warning" icon={KeyRound}>{t('notifications.secret.note')}</Notice>
   <CopyValue value={value} label={t('notifications.secret.copy')} success={t('notifications.secret.copied')}/>
  </div>;
}

// ---- Delivery log ------------------------------------------------------------------

export type LogFilter='all'|'sent'|'failed'|'suppressed';
const statusKind:Record<NotificationLogRow['status'],StatusKind>={sent:'success',failed:'critical',pending:'waiting',suppressed:'neutral'};
const reasonKeys={muted:'notifications.log.status.muted','maintenance-window':'notifications.log.status.maintenance','not-notified':'notifications.log.status.notNotified','no-rule':'notifications.log.status.noRule','no-recipient':'notifications.log.status.noRecipient'} as const satisfies Record<NonNullable<NotificationLogRow['reason']>,MessageKey>;
/** The status text of a log row: Sent, Failed, Pending or the suppression reason. */
export function logStatusText(row:Pick<NotificationLogRow,'status'|'reason'>,t:Translate):string{
 if(row.status==='suppressed')return t(reasonKeys[row.reason??'no-rule']);
 return t(`notifications.log.status.${row.status}`);
}

/** The Delivery log tab: the newest 50 entries of the chosen status, more through the cursor ("Load more"). */
function DeliveryLog({frame}:{frame?:PageFrame}){
 const t=useT(),[locale]=useLocale();
 const [filter,setFilter]=useState<LogFilter>('all');
 const [rows,setRows]=useState<NotificationLogRow[]|null>(null),[next,setNext]=useState<string|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false);
 const sequence=useRef(0);
 const load=useCallback(async(cursor:string|null)=>{
  const current=++sequence.current;setLoading(true);
  const params=new URLSearchParams({status:filter,limit:'50'});
  if(cursor)params.set('before',cursor);
  try{
   const result=await api<{entries:NotificationLogRow[];next:string|null}>(`${logEndpoint}?${params}`);
   if(current!==sequence.current)return;
   setRows(previous=>cursor&&previous?[...previous,...result.entries]:result.entries);setNext(result.next);setError('');
  }catch(failure){if(current===sequence.current)setError(message(failure,locale));}
  finally{if(current===sequence.current)setLoading(false);}
 },[filter,locale]);
 // A new filter starts from the newest entries; older rows stay visible until the answer arrives.
 useEffect(()=>{queueMicrotask(()=>void load(null));},[load]);
 useFrameRefresh(frame,()=>load(null));
 const choose=(value:LogFilter)=>{setNext(null);setFilter(value);};
 return <SettingsPage label={t('nav.settings.notificationChannels')} loading={!rows&&!error} loadError={error?`${t('notifications.log.loadFailed')}${rows?' '+t('notifications.staleData'):''}`:undefined} onRetry={()=>void load(null)} retrying={loading}
  wide={rows&&<LogTable rows={rows} filter={filter} next={next} loading={loading} onMore={()=>void load(next)} onFilter={choose}/>}/>;
}

/** The log table with its status filter and "Load more" in the foot; Empty when nothing was sent yet or nothing has the chosen status ("All" resets the filter). */
export function LogTable({rows,filter,next,loading,onMore,onFilter}:{rows:NotificationLogRow[];filter:LogFilter;next:string|null;loading:boolean;onMore:()=>void;onFilter?:(filter:LogFilter)=>void}){
 const t=useT(),[locale]=useLocale();
 const filters:{id:LogFilter;label:string}[]=[{id:'all',label:t('notifications.log.filter.all')},{id:'sent',label:t('notifications.log.filter.sent')},{id:'failed',label:t('notifications.log.filter.failed')},{id:'suppressed',label:t('notifications.log.filter.suppressed')}];
 const columns:DataColumn<NotificationLogRow>[]=[
  {id:'time',label:t('notifications.log.col.time'),cell:row=><span className="sdx-muted-cell">{exactTime(row.time,locale)}</span>},
  {id:'event',label:t('notifications.log.col.event'),primary:true,cell:row=><>{t(`notifications.log.event.${row.event}`)}{row.level&&<small className="sdx-notification-level">{t(`alertRules.level.${row.level}`)}</small>}</>},
  {id:'device',label:t('notifications.log.col.device'),cell:row=>row.event==='emergency'?t('notifications.log.emergency'):row.device?.name??EMPTY_VALUE},
  {id:'alarm',label:t('notifications.log.col.alarm'),cell:row=>row.ruleId&&isAlertRuleId(row.ruleId)?alertRuleName(row.ruleId,locale):row.ruleId??EMPTY_VALUE},
  {id:'channel',label:t('notifications.log.col.channel'),cell:row=>{if(!row.channel)return EMPTY_VALUE;const Icon=channelTypeIcons[row.channel.type];return <span className="sdx-notification-type"><Icon size={14} aria-hidden/>{row.channel.name}</span>;}},
  {id:'target',label:t('notifications.log.col.target'),cell:row=>row.targetHint?<span className="mono">{row.targetHint}</span>:EMPTY_VALUE},
  {id:'status',label:t('notifications.log.col.status'),cell:row=>{const error=deliveryErrorText(row.errorKey,row.errorParams,t);return <><StatusPill kind={statusKind[row.status]}>{logStatusText(row,t)}</StatusPill>{error&&row.status!=='sent'&&<small className="sdx-notification-error">{error}</small>}</>;}},
  {id:'attempts',label:t('notifications.log.col.attempts'),mono:true,align:'end',cell:row=>row.channel?row.attempts:EMPTY_VALUE},
 ];
 const empty=filter==='all'?{icon:Send,title:t('notifications.log.empty.title'),children:t('notifications.log.empty.text')}
  :{icon:Send,title:t('notifications.log.emptyFilter'),action:onFilter&&<Btn size="sm" onClick={()=>onFilter('all')}>{t('fleet.analysis.showAll')}</Btn>};
 return <DataTable<NotificationLogRow> columns={columns} rows={rows} rowKey={row=>row.id} label={t('notifications.tab.log')} cards className="sdx-notification-log" busy={loading}
  toolbar={<Toolbar filters={<Segmented size="sm" label={t('notifications.log.filterLabel')} value={filter} onChange={value=>onFilter?.(value)} items={filters}/>}/>}
  foot={next&&<Btn size="sm" loading={loading} onClick={onMore}>{t('notifications.log.loadMore')}</Btn>}
  empty={empty}/>;
}
