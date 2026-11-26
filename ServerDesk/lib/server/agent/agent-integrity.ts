import {z} from 'zod';
import {body,HttpError,now} from '../context';
import {deviceFromBearer} from './device-tokens';
import {db,runSteps,sql,type Queryable,type Step} from '../db';
import {auditAfterChange,auditEvent} from '../audit';
import {syncDeviceAlerts} from '../devices/alerts';
import {AGENT_INTEGRITY_EVENT_START_TYPES,AGENT_INTEGRITY_KINDS,AGENT_INTEGRITY_REASONS,AGENT_INTEGRITY_RETENTION_MS,AGENT_INTEGRITY_SERVICES,AGENT_INTEGRITY_STOP_KINDS,AGENT_INTEGRITY_TARGETS,AGENT_INTEGRITY_WINDOW_MS,type AgentIntegrityKind} from '../../agent-integrity-contract';
import type {AgentIntegrityEvent} from '../../types';

// The integrity events of agent 4.18.0 (docs/native-agent-v4.md, "Tamper
// protection in 4.18.0"; docs/alert-rules.md): POST /api/agent/integrity stores
// them, writes one device audit row per new event, and the three agent alert
// rules read them back with consoleAgentIntegrity. The shared lists live in
// lib/agent-integrity-contract.ts, so the alert rules stay free of server imports.
export {AGENT_INTEGRITY_EVENT_START_TYPES,AGENT_INTEGRITY_KINDS,AGENT_INTEGRITY_REASONS,AGENT_INTEGRITY_RETENTION_MS,AGENT_INTEGRITY_SERVICES,AGENT_INTEGRITY_STOP_KINDS,AGENT_INTEGRITY_TARGETS,AGENT_INTEGRITY_WINDOW_MS};

/** The largest request body: 20 events with their longest fields fit. */
export const AGENT_INTEGRITY_BODY_LIMIT=16384;
/** An event time this far ahead of the portal clock is stored as the receive time. */
export const AGENT_INTEGRITY_FUTURE_MS=5*60_000;
/** Older events are acknowledged but not stored. */
export const AGENT_INTEGRITY_MAX_AGE_MS=7*24*60*60_000;
/** At most this many stored stop-kind events (AGENT_INTEGRITY_STOP_KINDS) per device in 24 hours; more are acknowledged, not stored. */
export const AGENT_INTEGRITY_DAILY_CAP=100;
/** At most this many stored tamper-kind events (AGENT_INTEGRITY_TAMPER_KINDS) per device in 24 hours, a pool of their own so stop events cannot crowd them out; more are acknowledged, not stored. */
export const AGENT_INTEGRITY_TAMPER_DAILY_CAP=100;
/** An agent update claimed this recently still makes stop events planned. */
export const AGENT_UPDATE_GUARD_MS=30*60_000;

const plain=/^[^\u0000-\u001f\u007f]*$/;
const event=z.object({
 id:z.guid(),kind:z.enum(AGENT_INTEGRITY_KINDS),at:z.string().max(40).datetime({offset:true}),
 service:z.enum(AGENT_INTEGRITY_SERVICES).optional(),target:z.enum(AGENT_INTEGRITY_TARGETS).optional(),
 startType:z.enum(AGENT_INTEGRITY_EVENT_START_TYPES).optional(),reason:z.enum(AGENT_INTEGRITY_REASONS).optional(),
 user:z.string().min(1).max(256).regex(plain).optional(),repaired:z.boolean().optional(),finding:z.string().max(120).regex(plain).optional(),
}).strict();
/** The request body of POST /api/agent/integrity: the device and 1 to 20 events. */
export const agentIntegrityReport=z.object({serverId:z.guid(),events:z.array(event).min(1).max(20)}).strict();
export type AgentIntegrityReport=z.infer<typeof agentIntegrityReport>;

const stopKinds:readonly string[]=AGENT_INTEGRITY_STOP_KINDS;
/** The kinds outside AGENT_INTEGRITY_STOP_KINDS: start-type-changed, agent-removed and protection-changed. Portal-only; they have their own daily cap. */
export const AGENT_INTEGRITY_TAMPER_KINDS:readonly AgentIntegrityKind[]=AGENT_INTEGRITY_KINDS.filter(kind=>!stopKinds.includes(kind));
/** Whether a stop event counts as planned: received while an agent update of the device is pending or running, or was claimed in the last 30 minutes. Other kinds never are. */
export const plannedIntegrityKind=(kind:AgentIntegrityKind,updateActive:boolean)=>updateActive&&stopKinds.includes(kind);

/** The audit target: device name, device ID, service or target, and the reason, start type or finding (a missing part is left out); at most 500 characters. */
export function integrityAuditTarget(deviceName:string,deviceId:string,item:Pick<AgentIntegrityReport['events'][number],'service'|'target'|'reason'|'startType'|'finding'>):string{
 return [deviceName,deviceId,item.service??item.target,item.reason??item.startType??item.finding].filter(part=>part!==undefined&&part!=='').join(' / ').slice(0,500);
}

/**
 * POST /api/agent/integrity. The device authenticates from the headers before
 * the body is read; a removed device is refused. The body (at most 16 KiB) must
 * match the strict schema, else 400 apiError.agentIntegrity.invalid. An event
 * time more than 5 minutes ahead is replaced by the receive time; events older
 * than 7 days and events over the cap (100 stop events and 100 tamper events per
 * device and 24 hours, two separate pools; each keeps its first events in report
 * order) are acknowledged without a row. A repeated event ID is acknowledged again without
 * a second row. Each new event that is not planned gets one device audit row in
 * the same transaction. A stored event brings the alarms up to date; a failure
 * there is logged and leaves the answer unchanged.
 */
export async function ingestAgentIntegrity(request:Request){
 // Authenticate from the headers before reading the body.
 const time=now(),{device}=await deviceFromBearer<{id:string;name:string}>(request,'id,name',{allowTokenRetry:true,time});
 const parsed=agentIntegrityReport.safeParse(await body(request,AGENT_INTEGRITY_BODY_LIMIT));
 if(!parsed.success)throw new HttpError('apiError.agentIntegrity.invalid');
 const report=parsed.data;
 if(report.serverId!==device.id)throw new HttpError('apiError.agent.notApproved');
 const accepted=report.events.map(item=>item.id);
 const fresh=[...new Map(report.events.map(item=>[item.id,item])).values()]
  .map(item=>{const at=Date.parse(item.at);return {...item,occurredAt:at>time+AGENT_INTEGRITY_FUTURE_MS?time:at};})
  .filter(item=>item.occurredAt>=time-AGENT_INTEGRITY_MAX_AGE_MS);
 if(!fresh.length)return answer(accepted);
 const inserted=await db().transaction(async tx=>{
  const state=await tx.one<{stops:number;tampers:number;updating:boolean}>(sql`SELECT stored.stops,stored.tampers,
   EXISTS (SELECT 1 FROM jobs WHERE server_id=${device.id} AND action='agent-update' AND (state IN ('pending','claimed','running') OR claimed_at>=${time-AGENT_UPDATE_GUARD_MS})) AS updating
   FROM (SELECT count(*) FILTER (WHERE kind IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(AGENT_INTEGRITY_STOP_KINDS)}::jsonb)))::integer AS stops,
    count(*) FILTER (WHERE kind IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(AGENT_INTEGRITY_TAMPER_KINDS)}::jsonb)))::integer AS tampers
    FROM agent_integrity_events WHERE server_id=${device.id} AND received_at>${time-AGENT_INTEGRITY_WINDOW_MS}) stored`);
  // Two pools: stop events cannot take the room of tamper events and the other way round.
  const pools={stop:{cap:AGENT_INTEGRITY_DAILY_CAP,stored:Number(state?.stops??0),dropped:0},tamper:{cap:AGENT_INTEGRITY_TAMPER_DAILY_CAP,stored:Number(state?.tampers??0),dropped:0}};
  const kept=fresh.filter(item=>{
   const pool=pools[stopKinds.includes(item.kind)?'stop':'tamper'];
   if(pool.stored>=pool.cap){pool.dropped++;return false;}
   pool.stored++;return true;
  });
  for(const [name,pool] of Object.entries(pools))if(pool.dropped>0)console.error(`ServerDesk: Device ${device.id} sent more than ${pool.cap} ${name} integrity events in 24 hours; ${pool.dropped} were acknowledged without storing them.`);
  const steps:Step[]=[];
  for(const item of kept){
   const planned=plannedIntegrityKind(item.kind,!!state?.updating);
   steps.push(sql`INSERT INTO agent_integrity_events (id,server_id,event_id,kind,service,target,start_type,reason,user_name,finding,repaired,planned,occurred_at,received_at)
    SELECT ${crypto.randomUUID()},${device.id},${item.id},${item.kind},${item.service??null}::text,${item.target??null}::text,${item.startType??null}::text,${item.reason??null}::text,${item.user??null}::text,${item.finding??null}::text,${item.repaired??null}::boolean,${planned},${item.occurredAt},${time}
    WHERE EXISTS (SELECT 1 FROM servers WHERE id=${device.id} AND revoked=0)
    ON CONFLICT (server_id,event_id) DO NOTHING`);
   // Planned events (during an agent update) are kept without an audit row and without an alarm.
   if(!planned)steps.push(...auditEvent({actor:'Agent',action:'agent.integrity.'+item.kind,target:integrityAuditTarget(device.name,device.id,item),serverIds:device.id,guard:auditAfterChange,at:time}));
  }
  const results=await runSteps(tx,steps);
  // Walk the same list in the same order that built the steps: 1 step per planned event, 2 otherwise.
  let count=0,index=0;
  for(const item of kept){if(results[index].rowCount>0)count++;index+=plannedIntegrityKind(item.kind,!!state?.updating)?1:2;}
  return count;
 });
 if(inserted>0){
  try{await syncDeviceAlerts(device.id,time);}
  catch(error){console.error(`ServerDesk: The alarm state of device ${device.id} could not be updated: ${error instanceof Error?error.message:String(error)}`);}
 }
 return answer(accepted);
}
const answer=(accepted:string[])=>Response.json({ok:true,accepted:[...new Set(accepted)]},{headers:{'Cache-Control':'no-store'}});

type EventRow={id:string;server_id:string;kind:AgentIntegrityEvent['kind'];service:AgentIntegrityEvent['service'];target:AgentIntegrityEvent['target'];start_type:AgentIntegrityEvent['startType'];reason:AgentIntegrityEvent['reason'];user_name:string|null;finding:string|null;repaired:boolean|null;occurred_at:number;received_at:number};
/**
 * The integrity events the agent alert rules read, for a JSON array of device
 * IDs in ONE statement: every event that is not planned and reached the portal
 * in the last 24 hours, plus per device the newest service-stopped,
 * broker-unresponsive, start-type-changed (per service) and agent-removed event
 * of up to 90 days. Used only for the evaluation; the console row never carries it.
 */
export async function consoleAgentIntegrity(scope:string,q:Queryable=db(),time:number=now()):Promise<Map<string,{events:AgentIntegrityEvent[]}>>{
 const rows=await q.query<EventRow>(sql`SELECT id,server_id,kind,service,target,start_type,reason,user_name,finding,repaired,occurred_at,received_at FROM (
   SELECT e.*,row_number() OVER (PARTITION BY e.server_id,e.kind,e.service ORDER BY e.received_at DESC,e.occurred_at DESC,e.id DESC) AS position FROM agent_integrity_events e
   WHERE e.planned=false AND e.received_at>=${time-AGENT_INTEGRITY_RETENTION_MS} AND e.server_id IN (SELECT value FROM jsonb_array_elements_text(${scope}::jsonb))) ranked
  WHERE received_at>=${time-AGENT_INTEGRITY_WINDOW_MS} OR (position=1 AND kind IN ('service-stopped','broker-unresponsive','start-type-changed','agent-removed'))
  ORDER BY server_id,received_at,occurred_at`);
 const result=new Map<string,{events:AgentIntegrityEvent[]}>();
 for(const row of rows){
  const id=String(row.server_id),entry=result.get(id)??{events:[]};
  entry.events.push({id:String(row.id),kind:row.kind,service:row.service??null,target:row.target??null,startType:row.start_type??null,reason:row.reason??null,user:row.user_name??null,finding:row.finding??null,repaired:row.repaired??null,occurredAt:Number(row.occurred_at),receivedAt:Number(row.received_at)});
  result.set(id,entry);
 }
 return result;
}
