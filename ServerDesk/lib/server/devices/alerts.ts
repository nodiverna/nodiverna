// Server side of the alarms: the alarm state per device (syncDeviceAlerts, from
// the heartbeat and the periodic check runAlertSweep), the open alarms of the
// console, the actions acknowledge, mute and unmute of POST /api/alerts and the
// device alarm history of GET /api/alerts. app/api/alerts/route.ts is a thin
// adapter. The transitions themselves are pure (lib/server/devices/alert-state.ts).
import {guid,HttpError,now} from '../context';
import {devicePermissionGuard,principal,requireDevice} from '../identity/access';
import {auditAfterChange,auditEvent} from '../audit';
import {featureWriteGuard} from '../identity/feature-authorization';
import {commitSessionChange} from '../identity/rbac';
import {mfaSessionFence,requireLiveSessions} from '../identity/mfa';
import {db,sql,type Queryable} from '../db';
import {consoleAlertOverrides} from './alert-rule-overrides';
import {consoleEsuOverrides} from './os-esu';
import {deviceOsSupport} from '../../os-support';
import {consoleAutostart} from './autostart';
import {consoleDhcpAlerts} from '../extensions/plugin-data';
import {consoleDnsAlerts} from '../extensions/dns-data';
import {consoleAgentIntegrity} from '../agent/agent-integrity';
import {alertReadings,deviceAlertChain,effectiveAlertSettings,evaluateAlertRules,resolveAlertRules,type AlertIssueParams,type AlertLevel,type AlertReading} from '../../alert-rules';
import {alertEvents,alertTransitions,type ActiveAlert,type AlertTransitions} from './alert-state';
import type {AlertHistoryEntry,OpenAlert,Server,ServerSnapshot,Viewer} from '../../types';

type AlertRow={id:string;server_id:string;rule_id:string;key:string;state:string;level:string;peak_level:string;peak_value:number|null;threshold:number|null;params:string;started_at:number;opened_at:number|null;closed_at:number|null;close_reason:string|null;acknowledged_at:number|null;acknowledged_by:string|null;muted_until:number|null;muted_by:string|null};
const columns=sql`id,server_id,rule_id,key,state,level,peak_level,peak_value,threshold,params,started_at,opened_at,closed_at,close_reason,acknowledged_at,acknowledged_by,muted_until,muted_by`;
const numberOrNull=(value:unknown)=>value===null||value===undefined?null:Number(value);
const paramsOf=(text:string):AlertIssueParams=>{try{const value=JSON.parse(text);return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}catch{return {};}};
const inScope=(scope:string)=>sql`(SELECT value FROM jsonb_array_elements_text(${scope}::jsonb))`;

// ---- Alarm state ---------------------------------------------------------------

/** The first key of the transaction-scoped advisory lock of a device's alarms (the second is hashtext of the device ID). */
const alertLockClass=1634497907;
/** The devices of one transaction of the periodic check. */
export const alertSweepBatchSize=25;
/** A periodic check starts only when the last one started at least this long ago, across all replicas. */
export const alertSweepLeaseMs=50_000;

type DeviceRow={id:string;snapshot:string|null;lastSeen:number|null;customerId:string|null;groups:string|{id:string;depth:number}[]|null;updating:boolean};
const activeOf=(row:AlertRow):ActiveAlert=>({id:row.id,ruleId:row.rule_id,key:row.key,state:row.state==='pending'?'pending':'open',level:row.level as AlertLevel,peakLevel:row.peak_level as AlertLevel,
 peakValue:numberOrNull(row.peak_value),threshold:numberOrNull(row.threshold),params:paramsOf(row.params),startedAt:Number(row.started_at),openedAt:numberOrNull(row.opened_at),acknowledgedAt:numberOrNull(row.acknowledged_at)});
const snapshotOf=(text:string|null):ServerSnapshot|null=>{if(!text)return null;try{return JSON.parse(text) as ServerSnapshot;}catch{return null;}};

/**
 * Writes the transitions of one device and, in the same transaction, one
 * notification_events row per event (alertEvents in lib/server/devices/alert-state.ts): an event
 * exists exactly when its alarm change commits. The partial unique indexes on
 * alert_id stop a second open or close event of one alarm; such a duplicate is
 * skipped and never fails the alarm change. Sending happens later
 * (runNotificationDispatch in lib/server/notifications/notifications.ts), never here.
 */
async function writeTransitions(tx:Queryable,serverId:string,before:readonly ActiveAlert[],transitions:AlertTransitions,readings:readonly AlertReading[],time:number){
 const ids=transitions.inserts.map(()=>crypto.randomUUID());
 for(const [index,row] of transitions.inserts.entries())await tx.exec(sql`INSERT INTO alerts(id,server_id,rule_id,key,state,level,peak_level,peak_value,threshold,params,started_at,opened_at)
  VALUES(${ids[index]},${serverId},${row.ruleId},${row.key},${row.state},${row.level},${row.peakLevel},${row.peakValue}::double precision,${row.threshold}::integer,${JSON.stringify(row.params)},${row.startedAt},${row.openedAt}::bigint)`);
 for(const row of transitions.updates)await tx.exec(sql`UPDATE alerts SET state=${row.state},level=${row.level},peak_level=${row.peakLevel},peak_value=${row.peakValue}::double precision,threshold=${row.threshold}::integer,
  params=${JSON.stringify(row.params)},opened_at=${row.openedAt}::bigint${row.clearAcknowledgement?sql`,acknowledged_at=NULL,acknowledged_by=NULL`:sql``} WHERE id=${row.id} AND state<>'closed'`);
 for(const row of transitions.closes)await tx.exec(sql`UPDATE alerts SET state='closed',closed_at=GREATEST(${time}::bigint,started_at),close_reason=${row.reason} WHERE id=${row.id} AND state='open'`);
 for(const id of transitions.deletes)await tx.exec(sql`DELETE FROM alerts WHERE id=${id} AND state='pending'`);
 for(const event of alertEvents(before,transitions,readings)){
  const alertId=event.alertId??ids[event.insert??-1];
  if(!alertId)continue;
  const conflict=event.kind==='open'?sql` ON CONFLICT (alert_id) WHERE kind = 'open' DO NOTHING`:event.kind==='close'?sql` ON CONFLICT (alert_id) WHERE kind = 'close' DO NOTHING`:sql``;
  await tx.exec(sql`INSERT INTO notification_events(id,alert_id,server_id,customer_id,kind,level,rule_id,key,value,threshold,close_reason,occurred_at,status)
   VALUES(${crypto.randomUUID()},${alertId},${serverId},(SELECT customer_id FROM servers WHERE id=${serverId}),${event.kind},${event.level},${event.ruleId},${event.key},${event.value}::double precision,${event.threshold}::integer,${event.closeReason}::text,${time},'pending')${conflict}`);
 }
}

/**
 * Evaluates the devices and applies the transitions in one transaction. It first
 * takes the advisory lock of every device (in ID order), then reads the devices,
 * their agent update, the rule and ESU settings, their autostart summary, their
 * stored DHCP data, their integrity events and
 * their alarms that are not closed: a constant number of reads, whatever the
 * number of devices. Removed
 * devices are skipped. Concurrent calls for one device wait for each other, and
 * the partial unique index idx_alerts_active stops a second alarm per rule and key.
 */
async function syncAlertBatch(ids:readonly string[],time:number){
 const scope=JSON.stringify([...new Set(ids)].sort());
 await db().transaction(async tx=>{
  await tx.query(sql`SELECT pg_advisory_xact_lock(${alertLockClass}::integer,hashtext(ordered.id)) FROM (SELECT value AS id FROM jsonb_array_elements_text(${scope}::jsonb) ORDER BY value) ordered`);
  const devices=await tx.query<DeviceRow>(sql`SELECT s.id,s.snapshot,s.last_seen AS "lastSeen",s.customer_id AS "customerId",
   (SELECT coalesce(jsonb_agg(jsonb_build_object('id',g.id,'name',g.name,'depth',(SELECT MAX(depth) FROM device_group_ancestors WHERE group_id=g.id))),'[]'::jsonb) FROM device_groups g WHERE EXISTS (SELECT 1 FROM device_group_members m JOIN device_group_ancestors a ON a.group_id=m.group_id WHERE m.server_id=s.id AND a.ancestor_id=g.id)) AS groups,
   EXISTS (SELECT 1 FROM jobs j WHERE j.server_id=s.id AND j.action='agent-update' AND j.state='running') AS updating
   FROM servers s WHERE s.revoked=0 AND s.id IN ${inScope(scope)}`);
  if(!devices.length)return;
  const live=JSON.stringify(devices.map(device=>String(device.id)));
  const overrides=await consoleAlertOverrides(live,tx),esu=await consoleEsuOverrides(live,tx),autostart=await consoleAutostart(live,tx),dhcp=await consoleDhcpAlerts(live,tx),dns=await consoleDnsAlerts(live,tx),integrity=await consoleAgentIntegrity(live,tx,time);
  const active=await tx.query<AlertRow>(sql`SELECT ${columns} FROM alerts WHERE state<>'closed' AND server_id IN ${inScope(live)}`);
  for(const device of devices){
   const id=String(device.id),groups=(typeof device.groups==='string'?JSON.parse(device.groups):device.groups??[]) as {id:string;name?:string;depth:number}[];
   const customerId=device.customerId==null?null:String(device.customerId);
   const server={id,snapshot:snapshotOf(device.snapshot),lastSeen:numberOrNull(device.lastSeen),groups,customerId,maintenance:device.updating?{state:'updating' as const,version:'',notBefore:0}:undefined};
   const settings=effectiveAlertSettings(resolveAlertRules(overrides,deviceAlertChain(id,groups,customerId)));
   const osSupport=deviceOsSupport(server as unknown as Server,esu,settings,time),evaluated={...server,osSupport,autostart:autostart.get(id),dhcpAlerts:dhcp.get(id),dnsAlerts:dns.get(id),agentIntegrity:integrity.get(id)};
   const before=active.filter(row=>row.server_id===id).map(activeOf),readings=alertReadings(evaluated,time);
   const transitions=alertTransitions({server:evaluated,alerts:before,issues:evaluateAlertRules(evaluated,settings,time),readings,settings,now:time});
   await writeTransitions(tx,id,before,transitions,readings,time);
  }
 });
}

/**
 * Brings the alarms of one device up to date at `time`: the heartbeat route
 * after every stored Heartbeat, and runAlertSweep for every device. A removed
 * device (revoked=1) gets no alarms.
 */
export async function syncDeviceAlerts(serverId:string,time:number=now()){await syncAlertBatch([serverId],time);}

export type AlertSweepResult={status:'skipped'}|{status:'ran';devices:number;failed:number};
const logError=(message:string)=>console.error(message);
/**
 * The periodic alarm check, once a minute from the portal process scheduler
 * (runtime/maintenance-scheduler.mjs). It takes the lease in alert_sweep with one
 * conditional statement that succeeds only when the last start is at least 50
 * seconds old, so several replicas never check at the same time. Then it brings
 * every device with a Heartbeat up to date in batches of 25 devices. A failing
 * batch is retried device by device; a failing device is logged (its ID and the
 * error, never snapshot data) and does not stop the others. So a device that
 * stops sending gets its Device offline alarm, its live alarms close with no-data
 * and pending alarms open once their minimum duration has passed, also without
 * new data.
 */
export async function runAlertSweep(time:number=now(),log:(message:string)=>void=logError):Promise<AlertSweepResult>{
 const lease=await db().one(sql`UPDATE alert_sweep SET last_started_at=${time} WHERE id=1 AND (last_started_at IS NULL OR last_started_at<=${time-alertSweepLeaseMs}) RETURNING id`);
 if(!lease)return {status:'skipped'};
 let after='',devices=0,failed=0;
 for(;;){
  const rows=await db().query<{id:string}>(sql`SELECT id FROM servers WHERE revoked=0 AND last_seen IS NOT NULL AND id>${after} ORDER BY id LIMIT ${alertSweepBatchSize}`);
  if(!rows.length)break;
  const ids=rows.map(row=>String(row.id));after=ids[ids.length-1];
  try{await syncAlertBatch(ids,time);devices+=ids.length;}
  catch{
   for(const id of ids){
    try{await syncAlertBatch([id],time);devices++;}
    catch(error){failed++;log(`ServerDesk: The alarm check failed for device ${id}: ${error instanceof Error?error.message:String(error)}`);}
   }
  }
  if(rows.length<alertSweepBatchSize)break;
 }
 return {status:'ran',devices,failed};
}

// ---- Console ---------------------------------------------------------------------

const openAlertOf=(row:AlertRow,time:number):OpenAlert=>{
 const mutedUntil=numberOrNull(row.muted_until),acknowledgedAt=numberOrNull(row.acknowledged_at);
 return {id:row.id,ruleId:row.rule_id,key:row.key,level:row.level as AlertLevel,peakLevel:row.peak_level as AlertLevel,peakValue:numberOrNull(row.peak_value),threshold:numberOrNull(row.threshold),params:paramsOf(row.params),
  startedAt:Number(row.started_at),openedAt:numberOrNull(row.opened_at),
  acknowledged:acknowledgedAt===null?null:{at:acknowledgedAt,by:row.acknowledged_by??''},
  muted:mutedUntil!==null&&mutedUntil>time?{until:mutedUntil,by:row.muted_by??''}:null};
};
/**
 * The open alarms of the visible devices (`scope`, the JSON array of their IDs)
 * per device, oldest first, in one statement. Pending and closed alarms are
 * never part of the console data; a mute whose time is up is null.
 */
export async function consoleAlerts(scope:string,time:number):Promise<Map<string,OpenAlert[]>>{
 const rows=await db().query<AlertRow>(sql`SELECT ${columns} FROM alerts WHERE state='open' AND server_id IN ${inScope(scope)} ORDER BY started_at,id`);
 const result=new Map<string,OpenAlert[]>();
 for(const row of rows){const id=String(row.server_id),list=result.get(id)??[];list.push(openAlertOf(row,time));result.set(id,list);}
 return result;
}

// ---- Alarm week (Dashboard) ---------------------------------------------------

/** The hours GET /api/dashboard counts: 8 days, so the browser can fill its 7 local days in any time zone. */
export const alarmWeekHours=192;
const hourMs=3_600_000;
export type AlarmWeek={start:number;hours:number[]};
/**
 * The alarms that opened per UTC hour on the visible devices (`scope`, the JSON array of their IDs): `start` is the
 * full hour 191 hours before the current one, `hours` holds one count per hour up to the current hour. An alarm
 * counts at opened_at, so a pending alarm never counts; a closed one still does. One statement.
 */
export async function alarmWeek(scope:string,time:number):Promise<AlarmWeek>{
 const start=Math.floor(time/hourMs)*hourMs-(alarmWeekHours-1)*hourMs,end=start+alarmWeekHours*hourMs,hours=new Array<number>(alarmWeekHours).fill(0);
 if(scope==='[]')return {start,hours};
 const rows=await db().query<{hour:number;count:number}>(sql`SELECT ((opened_at-${start}::bigint)/3600000)::int AS hour,count(*)::int AS count FROM alerts
  WHERE state<>'pending' AND opened_at>=${start}::bigint AND opened_at<${end}::bigint AND server_id IN ${inScope(scope)} GROUP BY 1`);
 for(const row of rows){const index=Number(row.hour);if(index>=0&&index<alarmWeekHours)hours[index]=Number(row.count);}
 return {start,hours};
}

// ---- Acknowledge, mute, unmute ------------------------------------------------------

/** The mute durations in minutes: 1 hour, 4 hours, 1 day, 7 days. */
export const alertMuteMinutes=[60,240,1440,10080] as const;
export type AlertAction='acknowledge'|'mute'|'unmute';
const invalid=()=>new HttpError('apiError.alarms.invalid');
const stateChanged=()=>new HttpError('apiError.alarms.stateChanged');
const notFound=()=>new HttpError('apiError.alarms.notFound');
/**
 * The device of an alarm with the right: 404 outside the customer boundary or
 * without view (the alarm answers as if it did not exist), 403 with view but
 * without `permission`.
 */
async function requireAlertDevice(v:Viewer,serverId:string,permission:'view'|'alerts.manage'){
 try{await requireDevice(v,serverId,'view');}
 catch(error){if(error instanceof HttpError&&(error.status===403||error.status===404))throw notFound();throw error;}
 if(permission!=='view')await requireDevice(v,serverId,permission);
}
const iso=(value:number|null)=>value===null?null:new Date(value).toISOString();

/**
 * POST /api/alerts: acknowledge, mute (60, 240, 1440 or 10080 minutes; a muted
 * alarm gets the new end) and unmute. Routine changes (lib/step-up.ts): no
 * step-up proof, the statement carries the live session fence. The statement
 * holds only while the right (alerts.manage on the device, inside the customer
 * boundary), the portal write gate and the session hold, the alarm is still open
 * with the level and mute the request saw, and for acknowledge it is not
 * acknowledged, for unmute still muted. One device audit row commits with it.
 */
export async function changeAlert(request:Request,v:Viewer,p:Record<string,unknown>):Promise<{ok:true;mutedUntil:number|null}>{
 const action=p.action;
 if(action!=='acknowledge'&&action!=='mute'&&action!=='unmute')throw invalid();
 if(!guid(p.id))throw invalid();
 const minutes=action==='mute'?p.minutes:null;
 if(action==='mute'&&!(alertMuteMinutes as readonly unknown[]).includes(minutes))throw invalid();
 const id=p.id.toLowerCase();
 const alert=await db().one<AlertRow>(sql`SELECT ${columns} FROM alerts WHERE id=${id} AND state<>'pending'`);
 if(!alert)throw notFound();
 const serverId=String(alert.server_id);
 await requireAlertDevice(v,serverId,'alerts.manage');
 const time=now(),storedMute=numberOrNull(alert.muted_until),activeMute=storedMute!==null&&storedMute>time?storedMute:null;
 if(alert.state!=='open'||action==='acknowledge'&&alert.acknowledged_at!==null||action==='unmute'&&activeMute===null)throw stateChanged();
 const fence=await mfaSessionFence(request,v);
 const guard=sql`(${featureWriteGuard(v,devicePermissionGuard(sql`${serverId}`,sql`${principal(v)}`,'alerts.manage'))}) AND (${fence})`;
 const match=sql`id=${id} AND state='open' AND level=${alert.level} AND muted_until IS NOT DISTINCT FROM ${storedMute}::bigint`;
 const mutedUntil=action==='mute'?time+Number(minutes)*60_000:null;
 const statement=action==='acknowledge'?sql`UPDATE alerts SET acknowledged_at=${time},acknowledged_by=${v.label} WHERE ${match} AND acknowledged_at IS NULL AND ${guard} RETURNING id`
  :action==='mute'?sql`UPDATE alerts SET muted_until=${mutedUntil},muted_by=${v.label} WHERE ${match} AND ${guard} RETURNING id`
  :sql`UPDATE alerts SET muted_until=NULL,muted_by=NULL WHERE ${match} AND muted_until>${time} AND ${guard} RETURNING id`;
 const target:Record<string,unknown>={alert:id,rule:alert.rule_id,key:alert.key,level:alert.level};
 if(action==='mute'){target.mutedUntil=iso(mutedUntil);target.minutes=minutes;}
 if(action!=='acknowledge')target.previousMutedUntil=iso(activeMute);
 const audit=auditEvent({actor:v.label,action:`alert.${action}`,target:JSON.stringify(target),guard:auditAfterChange,at:time,serverIds:[serverId]});
 const row=await commitSessionChange(statement,audit);
 if(!row){
  // Refused in the transaction: a lost right answers like the pre-check, an
  // ended session with its own 401; otherwise the alarm changed meanwhile.
  await requireAlertDevice(v,serverId,'alerts.manage');await requireLiveSessions(request,v);
  throw stateChanged();
 }
 return {ok:true,mutedUntil};
}

// ---- History ------------------------------------------------------------------------

export const alertHistoryLimit={default:50,max:100};
/**
 * GET /api/alerts?serverId=<id>&before=<startedAt>:<id>&limit=50: the open and
 * closed alarms of one device (never pending ones), newest start first, and the
 * cursor of the next page. A device outside the customer boundary answers 404.
 */
export async function alertHistory(v:Viewer,params:URLSearchParams):Promise<{alerts:AlertHistoryEntry[];next:string|null}>{
 const serverId=params.get('serverId'),limitText=params.get('limit'),beforeText=params.get('before');
 if(!guid(serverId))throw invalid();
 const limit=limitText===null?alertHistoryLimit.default:/^\d{1,3}$/.test(limitText)?Number(limitText):NaN;
 if(!(limit>=1&&limit<=alertHistoryLimit.max))throw invalid();
 let before:{startedAt:number;id:string}|null=null;
 if(beforeText!==null){
  const match=/^(\d{1,16}):([0-9a-f-]{36})$/i.exec(beforeText);
  if(!match||!guid(match[2]))throw invalid();
  before={startedAt:Number(match[1]),id:match[2].toLowerCase()};
 }
 const id=serverId.toLowerCase();
 await requireDevice(v,id,'view');
 const time=now();
 const rows=await db().query<AlertRow>(sql`SELECT ${columns} FROM alerts WHERE server_id=${id} AND state<>'pending'${before?sql` AND (started_at,id)<(${before.startedAt}::bigint,${before.id}::text)`:sql``} ORDER BY started_at DESC,id DESC LIMIT ${limit+1}`);
 const page=rows.slice(0,limit),last=page[page.length-1];
 return {
  alerts:page.map(row=>({...openAlertOf(row,time),state:row.state==='closed'?'closed':'open',closedAt:numberOrNull(row.closed_at),closeReason:row.close_reason as AlertHistoryEntry['closeReason']})),
  next:rows.length>limit&&last?`${Number(last.started_at)}:${last.id}`:null,
 };
}
