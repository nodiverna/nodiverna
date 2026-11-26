// The notification dispatcher and the delivery log (docs/notifications.md).
// runNotificationDispatch runs from the maintenance scheduler after the alarm
// check on every tick (runtime/maintenance-scheduler.mjs, instrumentation.ts)
// with its own lease, so replicas do not run it at the same time. A run resets
// deliveries of a crashed process, routes the pending events once
// (lib/server/notifications/notification-routing.ts) and then sends per channel: everything due for
// one channel goes out as one message (lib/server/notifications/notify/send.ts), except an emergency
// sign-in, which always goes out alone (routeEmergency). A delivery is claimed
// with a conditional update before the call, so overlapping runs never send it
// twice. GET /api/notifications/log reads the log (app/api/notifications/log).
import {allowedDeviceIds,permissionElements} from '../identity/access';
import {config,HttpError,now} from '../context';
import {db,sql} from '../db';
import {customerSeparationSql} from '../../../runtime/customer-separation.mjs';
import {maintenanceDaysFromMask,maintenanceStartText} from '../identity/customers';
import {routeEvent,type RoutingRule,type RoutingWindow,type SuppressedReason} from './notification-routing';
import type {NotificationCloseReason,NotificationEntry,NotificationEventKind} from './notification-message';
import type {AlertLevel} from '../../alert-rules';
import {channelTarget,maxRecipients,portalName,requireNotificationsRight} from './notification-channels';
import {sendNotification,type ChannelTarget,type ChannelType,type Outgoing,type SmtpConfig} from './notify/send';
import {notifyErrorKey,NotifyError,type NotifyFailureReason} from './notify/transport';
import type {Viewer} from '../../types';
import {portalEmailLogoUrl} from '../branding';

/** A run starts only when the last one started at least this long ago, across all replicas. */
export const notificationDispatchLeaseMs=50_000;
/** A delivery in sending for longer than this belongs to a crashed process. */
export const staleSendingMs=10*60_000;
/** Events routed per run; the rest waits for the next tick. */
export const routeBatchSize=500;
/** A failed run puts the delivery back with these waits; the third failed run marks it failed. */
export const deliveryRetryMs:readonly number[]=[60_000,5*60_000];
export const maxDeliveryRuns=deliveryRetryMs.length+1;
/** Failures that no later run can fix: the target refused the message format (HTTP 400 or 422). Failed after the first run. */
export const finalFailureReasons:readonly NotifyFailureReason[]=['httpRejected'];

type EventRow={id:string;alert_id:string;server_id:string;customer_id:string|null;kind:NotificationEventKind|'emergency';level:AlertLevel;rule_id:string;key:string;value:number|null;threshold:number|null;close_reason:NotificationCloseReason|null;occurred_at:number|string};
type RuleRow={id:string;scope_type:RoutingRule['scopeType'];scope_id:string;channel_id:string;levels:string;on_open:number;on_close:number;on_escalate:number;enabled:number;channel_enabled:number};
type ChannelRow={id:string;type:ChannelType;name:string;enabled:number;language:string;config:string;secret:string|null;target_hint:string};
const inList=(values:readonly string[])=>sql`(SELECT value FROM jsonb_array_elements_text(${JSON.stringify([...new Set(values)])}::jsonb))`;
const levelsOf=(text:string):AlertLevel[]=>{try{const value=JSON.parse(text);return Array.isArray(value)?value.filter((level):level is AlertLevel=>level==='info'||level==='warning'||level==='critical'):[];}catch{return [];}};
const windowOf=(row:{maintenance_days:number|null;maintenance_start:number|null;maintenance_duration:number|null;maintenance_time_zone:string|null}):RoutingWindow|null=>
 row.maintenance_days===null||row.maintenance_start===null||row.maintenance_duration===null||!row.maintenance_time_zone?null
  :{days:maintenanceDaysFromMask(Number(row.maintenance_days)),start:maintenanceStartText(Number(row.maintenance_start)),durationMinutes:Number(row.maintenance_duration),timeZone:row.maintenance_time_zone};
const multipleCustomers=async()=>!!await db().one(sql`SELECT 1 AS active WHERE ${customerSeparationSql}`);

export type DispatchResult={status:'skipped'}|{status:'ran';routed:number;suppressed:number;deferred:number;sent:number;failed:number;retrying:number;recovered:number};
const logError=(message:string)=>console.error(message);

/**
 * The periodic dispatcher. Takes the lease in notification_dispatch with one
 * conditional statement (the last start is at least 50 seconds old), then runs
 * dispatchNotifications. Never throws for one channel; an error of the run
 * itself reaches the scheduler, which logs it.
 */
export async function runNotificationDispatch(time:number=now(),log:(message:string)=>void=logError):Promise<DispatchResult>{
 const lease=await db().one(sql`UPDATE notification_dispatch SET last_started_at=${time} WHERE id=1 AND (last_started_at IS NULL OR last_started_at<=${time-notificationDispatchLeaseMs}) RETURNING id`);
 if(!lease)return {status:'skipped'};
 return dispatchNotifications(time,log);
}

/** One run without the lease: reset, route, send. Two overlapping runs send each delivery at most once. */
export async function dispatchNotifications(time:number=now(),log:(message:string)=>void=logError,runId:string=crypto.randomUUID()):Promise<DispatchResult>{
 const recovered=await recoverStale(time);
 const routing=await routePending(time);
 const sending=await sendDue(time,runId,log);
 return {status:'ran',...routing,...sending,recovered};
}

/**
 * A delivery in sending for more than 10 minutes belongs to a crashed process:
 * it goes back to pending once; a second time it is failed (timeout).
 */
async function recoverStale(time:number):Promise<number>{
 const cutoff=time-staleSendingMs;
 const back=await db().exec(sql`UPDATE notification_deliveries SET status='pending',claimed_by=NULL,recovered=1,next_attempt_at=${time} WHERE status='sending' AND claimed_at<${cutoff} AND recovered=0`);
 await db().exec(sql`UPDATE notification_deliveries SET status='failed',claimed_by=NULL,last_attempt_at=${time},error_key=${notifyErrorKey('timeout')},error_params=NULL WHERE status='sending' AND claimed_at<${cutoff} AND recovered=1`);
 return back.rowCount;
}

// ---- Routing ------------------------------------------------------------------------

/**
 * An emergency sign-in (kind 'emergency', docs/entra-id.md) is routed once,
 * without notification rules, mutes or maintenance windows: the oldest enabled
 * email channel gets one delivery to the email addresses of every active
 * account with a direct, global Owner assignment (lower-cased, de-duplicated,
 * sorted, at most maxRecipients; the channel's own recipients are not used),
 * and every enabled Teams, Discord and webhook channel with an enabled rule for
 * All devices and the level critical gets one delivery too. Without any
 * delivery the event is suppressed with no-recipient.
 */
async function routeEmergency(event:EventRow,time:number):Promise<'routed'|'suppressed'|'gone'>{
 const [mail,owners,chats]=await Promise.all([
  db().one<ChannelRow>(sql`SELECT id,type,name,enabled,language,config,secret,target_hint FROM notification_channels WHERE type='smtp' AND enabled=1 ORDER BY created_at,id LIMIT 1`),
  db().query<{email:string}>(sql`SELECT DISTINCT lower(trim(u.email)) AS email FROM local_users u WHERE u.status='active' AND trim(u.email)<>'' AND EXISTS (SELECT 1 FROM role_assignments owner_assignment JOIN rbac_roles owner_role ON owner_role.id=owner_assignment.role_id WHERE owner_assignment.principal_type='user' AND owner_assignment.principal_id=u.id AND owner_assignment.scope_type='global' AND owner_assignment.scope_id='*' AND EXISTS (SELECT 1 FROM ${permissionElements(sql`owner_role`)} owner_right WHERE owner_right.value='*'))`),
  db().query<ChannelRow>(sql`SELECT c.id,c.type,c.name,c.enabled,c.language,c.config,c.secret,c.target_hint FROM notification_channels c WHERE c.type IN ('teams','discord','webhook') AND c.enabled=1 AND EXISTS (SELECT 1 FROM notification_rules r WHERE r.channel_id=c.id AND r.enabled=1 AND r.scope_type='all' AND r.levels IS JSON ARRAY AND jsonb_exists(r.levels::jsonb,'critical')) ORDER BY c.id`),
 ]);
 const recipients=[...new Set(owners.map(row=>row.email))].sort().slice(0,maxRecipients);
 const targets:{channel:ChannelRow;recipients:string|null}[]=[...(mail&&recipients.length?[{channel:mail,recipients:JSON.stringify(recipients)}]:[]),...chats.map(channel=>({channel,recipients:null}))];
 if(!targets.length){
  const {rowCount}=await db().exec(sql`UPDATE notification_events SET status='suppressed',suppressed_reason='no-recipient',routed_at=${time} WHERE id=${event.id} AND status='pending'`);
  return rowCount?'suppressed':'gone';
 }
 return db().transaction(async tx=>{
  const {rowCount}=await tx.exec(sql`UPDATE notification_events SET status='routed',routed_at=${time} WHERE id=${event.id} AND status='pending'`);
  if(!rowCount)return 'gone' as const;
  for(const {channel,recipients:list} of targets)await tx.exec(sql`INSERT INTO notification_deliveries(id,event_id,channel_id,channel_name,channel_type,target_hint,status,attempts,created_at,recipients)
   VALUES(${crypto.randomUUID()},${event.id},${channel.id},${channel.name},${channel.type},${channel.target_hint},'pending',0,${time},${list}::text) ON CONFLICT (event_id,channel_id) DO NOTHING`);
  return 'routed' as const;
 });
}

async function routePending(time:number):Promise<{routed:number;suppressed:number;deferred:number}>{
 const pending=await db().query<EventRow>(sql`SELECT id,alert_id,server_id,customer_id,kind,level,rule_id,key,value,threshold,close_reason,occurred_at FROM notification_events WHERE status='pending' ORDER BY occurred_at,id LIMIT ${routeBatchSize}`);
 let emergencyRouted=0,emergencySuppressed=0;
 for(const event of pending.filter(event=>event.kind==='emergency')){const result=await routeEmergency(event,time);if(result==='routed')emergencyRouted++;else if(result==='suppressed')emergencySuppressed++;}
 const events=pending.filter(event=>event.kind!=='emergency');
 if(!events.length)return {routed:emergencyRouted,suppressed:emergencySuppressed,deferred:0};
 const alertIds=events.map(event=>event.alert_id),servers=events.map(event=>event.server_id),customers=events.flatMap(event=>event.customer_id?[event.customer_id]:[]);
 const [ruleRows,channelRows,groupRows,muteRows,customerRows,deliveryRows,active]=await Promise.all([
  db().query<RuleRow>(sql`SELECT r.id,r.scope_type,r.scope_id,r.channel_id,r.levels,r.on_open,r.on_close,r.on_escalate,r.enabled,c.enabled AS channel_enabled FROM notification_rules r JOIN notification_channels c ON c.id=r.channel_id`),
  db().query<ChannelRow>(sql`SELECT id,type,name,enabled,language,config,secret,target_hint FROM notification_channels`),
  db().query<{server_id:string;group_id:string}>(sql`SELECT DISTINCT m.server_id,a.ancestor_id AS group_id FROM device_group_members m JOIN device_group_ancestors a ON a.group_id=m.group_id WHERE m.server_id IN ${inList(servers)}`),
  db().query<{id:string;muted_until:number|null}>(sql`SELECT id,muted_until FROM alerts WHERE id IN ${inList(alertIds)}`),
  customers.length?db().query<{id:string;maintenance_days:number|null;maintenance_start:number|null;maintenance_duration:number|null;maintenance_time_zone:string|null}>(sql`SELECT id,maintenance_days,maintenance_start,maintenance_duration,maintenance_time_zone FROM customers WHERE id IN ${inList(customers)}`):Promise.resolve([]),
  db().query<{alert_id:string;channel_id:string|null;status:string}>(sql`SELECT e.alert_id,d.channel_id,d.status FROM notification_deliveries d JOIN notification_events e ON e.id=d.event_id WHERE e.alert_id IN ${inList(alertIds)}`),
  multipleCustomers(),
 ]);
 const rules:RoutingRule[]=ruleRows.map(row=>({id:row.id,scopeType:row.scope_type,scopeId:row.scope_id,channelId:row.channel_id,levels:levelsOf(row.levels),onOpen:Number(row.on_open)===1,onClose:Number(row.on_close)===1,onEscalate:Number(row.on_escalate)===1,enabled:Number(row.enabled)===1,channelEnabled:Number(row.channel_enabled)===1}));
 const channels=new Map(channelRows.map(row=>[row.id,row]));
 const groups=new Map<string,string[]>();for(const row of groupRows){const list=groups.get(row.server_id)??[];list.push(row.group_id);groups.set(row.server_id,list);}
 const mutes=new Map(muteRows.map(row=>[row.id,row.muted_until===null?null:Number(row.muted_until)]));
 const windows=new Map(customerRows.map(row=>[row.id,windowOf(row)]));
 // Per alarm: channels with a sent or failed delivery, and whether a delivery is still on its way.
 const notified=new Map<string,Set<string>>(),busy=new Set<string>();
 for(const row of deliveryRows){
  if(row.status==='pending'||row.status==='sending')busy.add(row.alert_id);
  else if(row.channel_id){const set=notified.get(row.alert_id)??new Set();set.add(row.channel_id);notified.set(row.alert_id,set);}
 }
 let routed=emergencyRouted,suppressed=emergencySuppressed,deferred=0;
 for(const event of events){
  // An escalation or close waits while an earlier event of the alarm is still on its way
  // (or itself still waits), so it is decided on what that event actually reached.
  if(event.kind!=='open'&&busy.has(event.alert_id)){deferred++;continue;}
  const result=routeEvent({kind:event.kind as NotificationEventKind,level:event.level,occurredAt:Number(event.occurred_at)},rules,{
   mutedUntil:mutes.get(event.alert_id)??null,maintenanceWindow:event.customer_id?windows.get(event.customer_id)??null:null,
   customerId:event.customer_id,multipleCustomers:active,groupIds:groups.get(event.server_id)??[],notifiedChannels:notified.get(event.alert_id)??new Set(),
  });
  if(result.status==='suppressed'){
   const {rowCount}=await db().exec(sql`UPDATE notification_events SET status='suppressed',suppressed_reason=${result.reason},routed_at=${time} WHERE id=${event.id} AND status='pending'`);
   suppressed+=rowCount;continue;
  }
  const targets=result.channelIds.flatMap(id=>{const channel=channels.get(id);return channel?[channel]:[];});
  const done=await db().transaction(async tx=>{
   const {rowCount}=await tx.exec(sql`UPDATE notification_events SET status='routed',routed_at=${time} WHERE id=${event.id} AND status='pending'`);
   if(!rowCount)return false;
   for(const channel of targets)await tx.exec(sql`INSERT INTO notification_deliveries(id,event_id,channel_id,channel_name,channel_type,target_hint,status,attempts,created_at)
    VALUES(${crypto.randomUUID()},${event.id},${channel.id},${channel.name},${channel.type},${channel.target_hint},'pending',0,${time}) ON CONFLICT (event_id,channel_id) DO NOTHING`);
   return true;
  });
  if(done){routed++;busy.add(event.alert_id);}
 }
 return {routed,suppressed,deferred};
}

// ---- Sending --------------------------------------------------------------------------

type ClaimedRow={id:string;event_id:string;attempts:number;recipients:string|null};
type EntryRow=EventRow&{device_name:string|null;customer_name:string|null;customer_time_zone:string|null};

async function sendDue(time:number,runId:string,log:(message:string)=>void):Promise<{sent:number;failed:number;retrying:number}>{
 // Deliveries whose channel was deleted or turned off after routing are not sent.
 await db().exec(sql`UPDATE notification_deliveries SET status='failed',last_attempt_at=${time},error_key=${'apiError.notify.channelChanged'} WHERE status='pending' AND (channel_id IS NULL OR channel_id IN (SELECT id FROM notification_channels WHERE enabled=0))`);
 const due=await db().query<{channel_id:string}>(sql`SELECT DISTINCT channel_id FROM notification_deliveries WHERE status='pending' AND channel_id IS NOT NULL AND (next_attempt_at IS NULL OR next_attempt_at<=${time})`);
 const totals={sent:0,failed:0,retrying:0};
 if(!due.length)return totals;
 const active=await multipleCustomers();
 for(const {channel_id:channelId} of due){
  try{
   const result=await sendChannel(channelId,time,runId,active);
   totals.sent+=result.sent;totals.failed+=result.failed;totals.retrying+=result.retrying;
  }catch(error){
   // One channel never stops the others. Only the channel ID and the error class are logged.
   log(`ServerDesk: Sending notifications failed for channel ${channelId}: ${error instanceof Error?error.name:'error'}`);
  }
 }
 return totals;
}

async function sendChannel(channelId:string,time:number,runId:string,active:boolean):Promise<{sent:number;failed:number;retrying:number}>{
 const claimed=await db().query<ClaimedRow>(sql`UPDATE notification_deliveries SET status='sending',claimed_by=${runId},claimed_at=${time} WHERE channel_id=${channelId} AND status='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=${time}) RETURNING id,event_id,attempts,recipients`);
 if(!claimed.length)return {sent:0,failed:0,retrying:0};
 const channel=await db().one<ChannelRow>(sql`SELECT id,type,name,enabled,language,config,secret,target_hint FROM notification_channels WHERE id=${channelId}`);
 const rows=await db().query<EntryRow&{alarm_actor:string|null;alarm_name:string|null;alarm_address:string|null}>(sql`SELECT e.id,e.alert_id,e.server_id,e.customer_id,e.kind,e.level,e.rule_id,e.key,e.value,e.threshold,e.close_reason,e.occurred_at,s.name AS device_name,c.name AS customer_name,c.maintenance_time_zone AS customer_time_zone,a.actor AS alarm_actor,a.display_name AS alarm_name,a.address AS alarm_address
  FROM notification_events e LEFT JOIN servers s ON s.id=e.server_id LEFT JOIN customers c ON c.id=e.customer_id LEFT JOIN security_alarms a ON a.id=e.security_alarm_id WHERE e.id IN ${inList(claimed.map(row=>row.event_id))}`);
 const mine=sql`claimed_by=${runId} AND status='sending' AND channel_id=${channelId}`,totals={sent:0,failed:0,retrying:0};
 const add=(result:{sent:number;failed:number;retrying:number})=>{totals.sent+=result.sent;totals.failed+=result.failed;totals.retrying+=result.retrying;};
 // Every emergency delivery goes out alone, to the recipients stored at routing (also on a retry).
 const emergencies=new Map(rows.filter(row=>row.kind==='emergency').map(row=>[row.id,row]));
 for(const delivery of claimed.filter(row=>emergencies.has(row.event_id))){
  const row=emergencies.get(delivery.event_id)!;
  const signIn={account:row.alarm_name||row.alarm_actor||'',occurredAt:Number(row.occurred_at),address:row.alarm_address??'unknown'};
  add(await deliver(channel,{kind:'emergency',signIn},time,sql`${mine} AND id=${delivery.id}`,storedRecipients(delivery.recipients)));
 }
 const alarms=rows.filter(row=>row.kind!=='emergency');
 if(!alarms.length)return totals;
 const entries:NotificationEntry[]=alarms.map(row=>({eventId:row.id,kind:row.kind as NotificationEventKind,alertId:row.alert_id,level:row.level,device:{id:row.server_id,name:row.device_name??row.server_id},
  customer:active&&row.customer_id?{id:row.customer_id,name:row.customer_name??'',timeZone:row.customer_time_zone}:null,
  ruleId:row.rule_id,key:row.key,value:row.value===null?null:Number(row.value),threshold:row.threshold===null?null:Number(row.threshold),closeReason:row.close_reason,occurredAt:Number(row.occurred_at)}));
 add(await deliver(channel,{kind:'alarms',entries},time,sql`${mine} AND event_id IN ${inList(alarms.map(row=>row.id))}`,null));
 return totals;
}
/** The recipients of an emergency delivery (a JSON array of addresses), or null. */
function storedRecipients(text:string|null):string[]|null{
 if(text===null)return null;
 try{const value=JSON.parse(text);return Array.isArray(value)?value.filter((item):item is string=>typeof item==='string'):null;}catch{return null;}
}

/**
 * Sends one message through the channel and records the outcome on the
 * claimed deliveries `mine`. `recipients` replaces the recipients of an email
 * channel (an emergency delivery); null keeps the channel's own.
 */
async function deliver(channel:ChannelRow|null,outgoing:Outgoing,time:number,mine:ReturnType<typeof sql>,recipients:string[]|null):Promise<{sent:number;failed:number;retrying:number}>{
 const messageId=crypto.randomUUID();
 let failure:NotifyError|null=null;
 if(!channel)failure=new NotifyError('connectFailed');
 else{
  try{
   const stored=await channelTarget(channel);
   const target:ChannelTarget=recipients&&stored.type==='smtp'?{...stored,config:{...(stored.config as SmtpConfig),recipients}}:stored;
   const outcome=await sendNotification(target,outgoing,{deliveryId:messageId,time,portal:portalName(),origin:config('SITE_ORIGIN'),locale:channel.language==='de'?'de':'en',logoUrl:stored.type==='smtp'?await portalEmailLogoUrl():null});
   if(!outcome.ok)failure=outcome.error;
  }catch(error){
   failure=error instanceof HttpError&&error.messageKey===notifyErrorKey('secretUndecryptable')?new NotifyError('secretUndecryptable'):error instanceof NotifyError?error:new NotifyError('connectFailed');
  }
 }
 const finished=Math.max(now(),time);
 if(!failure){
  const {rowCount}=await db().exec(sql`UPDATE notification_deliveries SET status='sent',claimed_by=NULL,sent_at=${finished},last_attempt_at=${finished},message_id=${messageId},attempts=attempts+1,error_key=NULL,error_params=NULL,next_attempt_at=NULL WHERE ${mine}`);
  return {sent:rowCount,failed:0,retrying:0};
 }
 return recordFailure(mine,failure.reason,failure.params,finished);
}

/**
 * Puts the claimed deliveries back with the next wait, or marks them failed
 * after the third failed run; a final failure (finalFailureReasons) at once.
 */
async function recordFailure(mine:ReturnType<typeof sql>,reason:NotifyFailureReason,params:Record<string,string|number>,finished:number){
 const key=notifyErrorKey(reason),paramsText=Object.keys(params).length?JSON.stringify(params):null;
 const runs=finalFailureReasons.includes(reason)?1:maxDeliveryRuns;
 const failed=await db().exec(sql`UPDATE notification_deliveries SET status='failed',claimed_by=NULL,attempts=attempts+1,last_attempt_at=${finished},error_key=${key},error_params=${paramsText}::text,next_attempt_at=NULL WHERE ${mine} AND attempts+1>=${runs}::bigint`);
 const retrying=await db().exec(sql`UPDATE notification_deliveries SET status='pending',claimed_by=NULL,attempts=attempts+1,last_attempt_at=${finished},error_key=${key},error_params=${paramsText}::text,
  next_attempt_at=${finished}::bigint+(CASE WHEN attempts=0 THEN ${deliveryRetryMs[0]}::bigint ELSE ${deliveryRetryMs[1]}::bigint END) WHERE ${mine}`);
 return {sent:0,failed:failed.rowCount,retrying:retrying.rowCount};
}

// ---- Delivery log ---------------------------------------------------------------------

export type LogStatusFilter='all'|'sent'|'failed'|'suppressed';
export type NotificationLogRow={
 id:string;eventId:string;time:number;event:NotificationEventKind|'test'|'emergency';level:AlertLevel|null;
 device:{id:string;name:string}|null;ruleId:string|null;
 channel:{name:string;type:ChannelType}|null;targetHint:string|null;
 status:'sent'|'failed'|'pending'|'suppressed';reason:SuppressedReason|null;attempts:number;
 errorKey:string|null;errorParams:Record<string,string|number>|null;
};
export const notificationLogLimit={default:50,max:100};
type LogRow={row_id:string;event_id:string;kind:NotificationLogRow['event'];level:AlertLevel|null;rule_id:string|null;server_id:string|null;device_name:string|null;occurred_at:number|string;event_status:string;suppressed_reason:SuppressedReason|null;
 delivery_id:string|null;channel_name:string|null;channel_type:ChannelType|null;target_hint:string|null;delivery_status:string|null;attempts:number|null;error_key:string|null;error_params:string|null};
const paramsOf=(text:string|null)=>{if(!text)return null;try{const value=JSON.parse(text);return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,string|number>:null;}catch{return null;}};

/**
 * GET /api/notifications/log?before=<time>:<id>&limit=50&status=all|sent|failed|suppressed:
 * newest first, one row per delivery and one per event without delivery
 * (suppressed or still pending). Needs portal.notifications.manage and shows only
 * entries of devices the viewer may view; test messages and emergency sign-ins
 * always (they name no device, and the log shows no account).
 */
export async function notificationLog(v:Viewer,params:URLSearchParams):Promise<{entries:NotificationLogRow[];next:string|null}>{
 await requireNotificationsRight(v);
 const invalid=()=>new HttpError('apiError.notify.logInvalid');
 const limitText=params.get('limit'),beforeText=params.get('before'),statusText=params.get('status')??'all';
 const limit=limitText===null?notificationLogLimit.default:/^\d{1,3}$/.test(limitText)?Number(limitText):NaN;
 if(!(limit>=1&&limit<=notificationLogLimit.max))throw invalid();
 if(!['all','sent','failed','suppressed'].includes(statusText))throw invalid();
 let before:{time:number;id:string}|null=null;
 if(beforeText!==null){
  const match=/^(\d{1,16}):([0-9a-f-]{36})$/i.exec(beforeText);
  if(!match)throw invalid();
  before={time:Number(match[1]),id:match[2].toLowerCase()};
 }
 const visible=JSON.stringify(await allowedDeviceIds(v,'view'));
 const filter=statusText==='sent'?sql`d.status='sent'`:statusText==='failed'?sql`d.status='failed'`:statusText==='suppressed'?sql`e.status='suppressed'`:sql`TRUE`;
 const rows=await db().query<LogRow>(sql`SELECT coalesce(d.id,e.id) AS row_id,e.id AS event_id,e.kind,e.level,e.rule_id,e.server_id,s.name AS device_name,e.occurred_at,e.status AS event_status,e.suppressed_reason,
  d.id AS delivery_id,d.channel_name,d.channel_type,d.target_hint,d.status AS delivery_status,d.attempts,d.error_key,d.error_params
  FROM notification_events e LEFT JOIN notification_deliveries d ON d.event_id=e.id LEFT JOIN servers s ON s.id=e.server_id
  WHERE (e.kind IN ('test','emergency') OR e.server_id IN (SELECT value FROM jsonb_array_elements_text(${visible}::jsonb))) AND ${filter}
  ${before?sql`AND (e.occurred_at,coalesce(d.id,e.id))<(${before.time}::bigint,${before.id}::text)`:sql``}
  ORDER BY e.occurred_at DESC,coalesce(d.id,e.id) DESC LIMIT ${limit+1}`);
 const page=rows.slice(0,limit),last=page[page.length-1];
 return {
  entries:page.map(row=>({
   id:row.row_id,eventId:row.event_id,time:Number(row.occurred_at),event:row.kind,level:row.level,
   device:row.server_id?{id:row.server_id,name:row.device_name??row.server_id}:null,ruleId:row.rule_id,
   channel:row.delivery_id&&row.channel_name&&row.channel_type?{name:row.channel_name,type:row.channel_type}:null,targetHint:row.delivery_id?row.target_hint:null,
   status:row.delivery_id?(row.delivery_status==='sent'?'sent':row.delivery_status==='failed'?'failed':'pending'):row.event_status==='suppressed'?'suppressed':'pending',
   reason:row.delivery_id?null:row.suppressed_reason,attempts:Number(row.attempts??0),errorKey:row.error_key,errorParams:paramsOf(row.error_params),
  })),
  next:rows.length>limit&&last?`${Number(last.occurred_at)}:${last.row_id}`:null,
 };
}
