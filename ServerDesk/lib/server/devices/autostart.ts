// Server side of the autostart list (lib/autostart-inventory.ts): the ingest of
// POST /api/agent/autostart with the baseline and the new entries, the
// heartbeat's resync decision, the summary per device for the console and the
// alarm check, the list of one device, the confirmation of new entries with
// audit, and the fleet view with rare entries first. Each route in app/api is a
// thin adapter around this module.
import {HttpError,guid,now} from '../context';
import {devicePermissionGuard,guardPasses,principal,requireDevice} from '../identity/access';
import {featureWriteGuard} from '../identity/feature-authorization';
import {commitSessionChange} from '../identity/rbac';
import {mfaSessionFence,requireLiveSessions} from '../identity/mfa';
import {db,sql,type Queryable} from '../db';
import {accountNameSql} from '../identity/account-names';
import type {AutostartCategory,AutostartSummary,Viewer} from '../../types';
import {likePattern,scopeDeviceIds} from './software';
import {autostartChecksum,autostartId,autostartReport,autostartSearchTokens,autostartSuspicious,maxAutostartItems,type AutostartItem,type AutostartSignature} from '../../autostart-inventory';

/** The agent may send a list at most once per minute. */
export const autostartReportIntervalMs=60_000;
/** At most this many entries per confirm request, and entries named in one audit row. */
export const maxConfirmEntries=500,maxAuditEntries=50;
const invalid=()=>new HttpError('apiError.autostart.reportInvalid');
const changed=()=>new HttpError('apiError.autostart.changed');
const nothing=()=>new HttpError('apiError.autostart.nothingToConfirm');
type StateRow={checksum:string;reported_at:number;count:number;truncated:number;baseline_at:number};
type ItemRow={id:string;category:string;scope:string;location:string;name:string;command:string;target:string|null;signature:string;signer:string|null;publisher:string|null;microsoft:number;user_path:number;first_seen:number;baseline:number;acknowledged_at:number|null;acknowledged_by:string|null};
const activeDevice=(serverId:string)=>sql`EXISTS (SELECT 1 FROM servers WHERE id=${serverId} AND revoked=0)`;
const inScope=(scope:string)=>sql`(SELECT value FROM jsonb_array_elements_text(${scope}::jsonb))`;
/** SQL of "new": not part of the first report and not confirmed. */
const isNew=sql`a.baseline=0 AND a.acknowledged_at IS NULL`;
const isSuspicious=sql`(a.signature IN ('unsigned','invalid') OR a.user_path=1)`;
const numberOrNull=(value:unknown)=>value===null||value===undefined?null:Number(value);

/**
 * Stores one report of a device in one transaction, fenced on the previous
 * checksum and report time. The first report is the baseline: every entry gets
 * baseline=1. Later reports insert unknown IDs as new (first_seen now,
 * baseline 0), keep known IDs with their confirmation (and refresh their
 * signature fields), and delete missing IDs unless the report is truncated.
 * A changed command is a new ID. An identical checksum only refreshes
 * reported_at; 429 while the last report is younger than 60 s. A parallel
 * second report retries after the first commits and then meets that rule.
 */
export async function ingestAutostart(serverId:string,value:unknown,now:number):Promise<{ok:true;baseline:boolean;added:number;removed:number}>{
 const parsed=autostartReport.safeParse(value);
 if(!parsed.success)throw invalid();
 const report=parsed.data;
 if(await autostartChecksum(report.items)!==report.checksum)throw invalid();
 // The ID covers the masked command: a report with a forged or stale ID is invalid.
 const ids=await Promise.all(report.items.map(item=>autostartId(item)));
 if(ids.some((id,index)=>id!==report.items[index].id))throw invalid();
 return db().transaction(async tx=>{
  const state=await tx.one<StateRow>(sql`SELECT checksum,reported_at,count,truncated,baseline_at FROM device_autostart_state WHERE server_id=${serverId}`);
  if(state&&now-Number(state.reported_at)<autostartReportIntervalMs)throw new HttpError('apiError.autostart.tooSoon');
  const fence=state?sql`checksum=${state.checksum} AND reported_at=${Number(state.reported_at)}`:sql`TRUE`;
  const truncated=report.truncated?1:0;
  if(state&&state.checksum===report.checksum){
   const refreshed=await tx.exec(sql`UPDATE device_autostart_state SET reported_at=${now},count=${report.count},truncated=${truncated} WHERE server_id=${serverId} AND ${fence} AND ${activeDevice(serverId)}`);
   if(!refreshed.rowCount)throw new HttpError('apiError.agent.notApproved');
   return {ok:true as const,baseline:false,added:0,removed:0};
  }
  const stored=state
   ?await tx.exec(sql`UPDATE device_autostart_state SET checksum=${report.checksum},reported_at=${now},count=${report.count},truncated=${truncated} WHERE server_id=${serverId} AND ${fence} AND ${activeDevice(serverId)}`)
   :await tx.exec(sql`INSERT INTO device_autostart_state(server_id,checksum,reported_at,count,truncated,baseline_at) SELECT ${serverId},${report.checksum},${now},${report.count},${truncated},${now} WHERE ${activeDevice(serverId)} ON CONFLICT (server_id) DO NOTHING`);
  if(!stored.rowCount)throw new HttpError('apiError.agent.notApproved');
  const baseline=state?0:1;
  let added=0,removed=0;
  if(report.items.length){
   const rows=report.items.map(item=>({id:item.id,category:item.category,scope:item.scope,location:item.location,name:item.name,command:item.command,target:item.target,signature:item.signature,signer:item.signer,publisher:item.publisher,microsoft:item.microsoft?1:0,user_path:item.userPath?1:0}));
   const result=await tx.query<{inserted:boolean}>(sql`INSERT INTO device_autostart(server_id,id,category,scope,location,name,command,target,signature,signer,publisher,microsoft,user_path,first_seen,baseline)
    SELECT ${serverId},r.id,r.category,r.scope,r.location,r.name,r.command,r.target,r.signature,r.signer,r.publisher,r.microsoft,r.user_path,${now}::bigint,${baseline}::smallint FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
    AS r(id text,category text,scope text,location text,name text,command text,target text,signature text,signer text,publisher text,microsoft smallint,user_path smallint)
    ON CONFLICT (server_id,id) DO UPDATE SET target=excluded.target,signature=excluded.signature,signer=excluded.signer,publisher=excluded.publisher,microsoft=excluded.microsoft,user_path=excluded.user_path
    RETURNING (xmax=0) AS inserted`);
   added=result.filter(row=>row.inserted).length;
  }
  if(state&&!report.truncated){
   const gone=await tx.exec(sql`DELETE FROM device_autostart WHERE server_id=${serverId} AND NOT (id IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(report.items.map(item=>item.id))}::jsonb)))`);
   removed=gone.rowCount;
  }
  return {ok:true as const,baseline:!state,added:state?added:0,removed};
 });
}

/** True when the heartbeat's autostart checksum is set and differs from the stored state (or there is none): the agent sends its list again. */
export async function autostartResyncNeeded(serverId:string,checksum:string|null|undefined):Promise<boolean>{
 if(!checksum)return false;
 const state=await db().one<{checksum:string}>(sql`SELECT checksum FROM device_autostart_state WHERE server_id=${serverId}`);
 return state?.checksum!==checksum;
}

/**
 * The autostart summary of the devices in `scope` (the JSON array of their IDs)
 * in one statement: the report time, the number of entries, the new and the
 * suspicious new entries, and up to 20 new entries (10 suspicious and 10 others,
 * newest first). The console route and the alarm check (lib/server/devices/alerts.ts) use it.
 */
export async function consoleAutostart(scope:string,q:Queryable=db()):Promise<Map<string,AutostartSummary>>{
 const rows=await q.query<{server_id:string;reported_at:number;count:number;new_count:number;suspicious_new_count:number;new_entries:string|{id:string;name:string;category:AutostartCategory;suspicious:boolean;first_seen:number}[]|null}>(sql`SELECT st.server_id,st.reported_at,st.count,
  (SELECT count(*) FROM device_autostart a WHERE a.server_id=st.server_id AND ${isNew}) AS new_count,
  (SELECT count(*) FROM device_autostart a WHERE a.server_id=st.server_id AND ${isNew} AND ${isSuspicious}) AS suspicious_new_count,
  (SELECT coalesce(json_agg(json_build_object('id',e.id,'name',e.name,'category',e.category,'suspicious',e.suspicious,'first_seen',e.first_seen) ORDER BY e.suspicious DESC,e.first_seen DESC,e.name,e.id),'[]'::json) FROM (
    SELECT a.id,a.name,a.category,${isSuspicious} AS suspicious,a.first_seen,row_number() OVER (PARTITION BY ${isSuspicious} ORDER BY a.first_seen DESC,a.name,a.id) AS rank
    FROM device_autostart a WHERE a.server_id=st.server_id AND ${isNew}) e WHERE e.rank<=10) AS new_entries
  FROM device_autostart_state st WHERE st.server_id IN ${inScope(scope)}`);
 const result=new Map<string,AutostartSummary>();
 for(const row of rows){
  const entries=typeof row.new_entries==='string'?JSON.parse(row.new_entries):row.new_entries??[];
  result.set(String(row.server_id),{reportedAt:Number(row.reported_at),count:Number(row.count),newCount:Number(row.new_count),suspiciousNewCount:Number(row.suspicious_new_count),
   newEntries:(entries as {id:string;name:string;category:AutostartCategory;suspicious:boolean;first_seen:number}[]).map(entry=>({id:String(entry.id),name:String(entry.name),category:entry.category,suspicious:!!entry.suspicious,firstSeen:Number(entry.first_seen)}))});
 }
 return result;
}

export type AutostartEntry=AutostartItem&{firstSeen:number;baseline:boolean;acknowledgedAt:number|null;acknowledgedBy:string|null;isNew:boolean;suspicious:boolean};
export type AutostartConfirmReason='right'|'read-only';
export type DeviceAutostartView={state:{checksum:string;reportedAt:number;count:number;truncated:boolean;baselineAt:number}|null;items:AutostartEntry[];canConfirm:boolean;reason:AutostartConfirmReason|null};
const entryOf=(row:ItemRow):AutostartEntry=>{
 const item:AutostartItem={id:String(row.id),category:row.category as AutostartCategory,scope:row.scope==='user'?'user':'machine',location:row.location,name:row.name,command:row.command,target:row.target,signature:row.signature as AutostartSignature,signer:row.signer,publisher:row.publisher,microsoft:Number(row.microsoft)===1,userPath:Number(row.user_path)===1};
 const baseline=Number(row.baseline)===1,acknowledgedAt=numberOrNull(row.acknowledged_at);
 return {...item,firstSeen:Number(row.first_seen),baseline,acknowledgedAt,acknowledgedBy:row.acknowledged_by,isNew:!baseline&&acknowledgedAt===null,suspicious:autostartSuspicious(item)};
};
const manageGuard=(v:Viewer,id:string)=>devicePermissionGuard(sql`${id}`,sql`${principal(v)}`,'manage');
/**
 * GET /api/autostart/device?id=: the device right view; 404 outside the customer
 * boundary. canConfirm: the viewer has the device right manage and may write
 * (reason right or read-only otherwise).
 */
export async function deviceAutostartView(v:Viewer,id:unknown):Promise<DeviceAutostartView>{
 if(!guid(id))throw new HttpError('apiError.device.invalid');
 await requireDevice(v,id,'view');
 const [state,items,right,write]=await Promise.all([
  db().one<StateRow>(sql`SELECT checksum,reported_at,count,truncated,baseline_at FROM device_autostart_state WHERE server_id=${id}`),
  db().query<ItemRow>(sql`SELECT a.id,a.category,a.scope,a.location,a.name,a.command,a.target,a.signature,a.signer,a.publisher,a.microsoft,a.user_path,a.first_seen,a.baseline,a.acknowledged_at,${accountNameSql(sql`u`,sql`a.acknowledged_by`)} AS acknowledged_by FROM device_autostart a LEFT JOIN local_users u ON u.auth_email=a.acknowledged_by WHERE a.server_id=${id} ORDER BY lower(a.name),a.name,a.category,a.id LIMIT ${maxAutostartItems}`),
  guardPasses(manageGuard(v,id)),
  guardPasses(featureWriteGuard(v,manageGuard(v,id))),
 ]);
 return {
  state:state?{checksum:state.checksum,reportedAt:Number(state.reported_at),count:Number(state.count),truncated:Number(state.truncated)===1,baselineAt:Number(state.baseline_at)}:null,
  items:items.map(entryOf),canConfirm:write,reason:write?null:right?'read-only':'right',
 };
}

/**
 * POST /api/autostart/device: confirm {id, entryIds} (1 to 500) or confirm-all
 * {id, expected} (the checksum the viewer saw). The statement holds only while
 * the right manage on the device (inside the customer boundary), the portal
 * write gate and the session hold; for confirm-all also while the stored list
 * still has the expected checksum. Entries already confirmed, of the first
 * report or unknown are skipped. One audit row (autostart.confirm, device row,
 * up to 50 entries and the count) commits in the same statement, so a failing
 * audit insert rolls the confirmation back.
 */
export async function confirmAutostart(request:Request,v:Viewer,p:Record<string,unknown>):Promise<{ok:true;count:number}>{
 const action=p.action;
 if(action!=='confirm'&&action!=='confirm-all')throw new HttpError('apiError.request.invalid');
 if(!guid(p.id))throw new HttpError('apiError.device.invalid');
 const id=p.id.toLowerCase();
 let entryIds:string[]=[],expected='';
 if(action==='confirm'){
  if(!Array.isArray(p.entryIds)||p.entryIds.length<1||p.entryIds.length>maxConfirmEntries||!p.entryIds.every(entry=>typeof entry==='string'&&/^[0-9a-f]{64}$/.test(entry)))throw new HttpError('apiError.autostart.invalidSelection');
  entryIds=[...new Set(p.entryIds as string[])];
 }else{
  if(typeof p.expected!=='string'||!/^[0-9a-f]{64}$/.test(p.expected))throw new HttpError('apiError.request.invalid');
  expected=p.expected;
 }
 await requireDevice(v,id,'view');
 await requireDevice(v,id,'manage');
 const state=await db().one<{checksum:string}>(sql`SELECT checksum FROM device_autostart_state WHERE server_id=${id}`);
 if(action==='confirm-all'&&state?.checksum!==expected)throw changed();
 const time=now(),fence=await mfaSessionFence(request,v);
 const guard=sql`(${featureWriteGuard(v,manageGuard(v,id))}) AND (${fence})`;
 const selection=action==='confirm'?sql`a.id IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(entryIds)}::jsonb))`:sql`EXISTS (SELECT 1 FROM device_autostart_state s WHERE s.server_id=${id} AND s.checksum=${expected})`;
 const statement=sql`WITH confirmed AS (
   UPDATE device_autostart a SET acknowledged_at=${time},acknowledged_by=${v.label} WHERE a.server_id=${id} AND ${isNew} AND ${selection} AND ${guard} RETURNING a.name,a.category,a.location,a.id
  ),logged AS (
   INSERT INTO audit(at,actor,action,target,server_id,scope)
   SELECT ${time}::bigint,${v.label}::text,'autostart.confirm',json_build_object(
     'entries',(SELECT coalesce(json_agg(json_build_object('name',e.name,'category',e.category,'location',e.location) ORDER BY e.category,lower(e.name),e.id),'[]'::json) FROM (SELECT * FROM confirmed ORDER BY category,lower(name),id LIMIT ${maxAuditEntries}) e),
     'count',(SELECT count(*) FROM confirmed))::text,${id}::text,'device'
   WHERE EXISTS (SELECT 1 FROM confirmed) RETURNING id
  )
  SELECT (SELECT count(*) FROM confirmed) AS count,(SELECT count(*) FROM logged) AS logged`;
 const row=await commitSessionChange(statement) as {count:number;logged:number}|null;
 const count=Number(row?.count??0);
 if(!count){
  // Refused or nothing to do: a lost right answers like the pre-check, an ended
  // session with its own 401; otherwise the list changed or nothing was new.
  await requireDevice(v,id,'manage');await requireLiveSessions(request,v);
  if(action==='confirm-all'){
   const current=await db().one<{checksum:string}>(sql`SELECT checksum FROM device_autostart_state WHERE server_id=${id}`);
   if(current?.checksum!==expected)throw changed();
  }
  throw nothing();
 }
 return {ok:true,count};
}

export type AutostartFleetRow={name:string;category:AutostartCategory;target:string|null;signature:AutostartSignature;signer:string|null;publisher:string|null;userPath:boolean;deviceCount:number;newCount:number;deviceIds:string[];newDeviceIds:string[]};
export type AutostartFleetView={rows:AutostartFleetRow[];total:number;truncated:boolean};
/**
 * GET /api/autostart?scope=&q=: the autostart entries of the visible devices in
 * the scope, grouped by category, name and target (case-insensitive), with the
 * devices and the devices where the entry is new. Rare entries first (device
 * count ascending, then name), at most 2000 rows. Every search token must be a
 * substring of the name, target, command, signer or publisher.
 */
export async function autostartFleetView(v:Viewer,params:URLSearchParams):Promise<AutostartFleetView>{
 const devices=await scopeDeviceIds(v,params.get('scope'));
 if(!devices.length)return {rows:[],total:0,truncated:false};
 const tokens=autostartSearchTokens(params.get('q'));
 const search=tokens.length?sql.join(tokens.map(token=>{const pattern=likePattern(token);return sql`(a.name ILIKE ${pattern} OR coalesce(a.target,'') ILIKE ${pattern} OR a.command ILIKE ${pattern} OR coalesce(a.signer,'') ILIKE ${pattern} OR coalesce(a.publisher,'') ILIKE ${pattern})`;}),sql` AND `):sql`TRUE`;
 const rows=await db().query<{name:string;category:string;target:string|null;signature:string;signer:string|null;publisher:string|null;user_path:boolean;device_count:number;new_count:number;device_ids:string;new_device_ids:string|null;total:number}>(sql`SELECT mode() WITHIN GROUP (ORDER BY a.name) AS name,a.category,mode() WITHIN GROUP (ORDER BY a.target) AS target,
  mode() WITHIN GROUP (ORDER BY a.signature) AS signature,mode() WITHIN GROUP (ORDER BY a.signer) AS signer,mode() WITHIN GROUP (ORDER BY a.publisher) AS publisher,
  bool_or(a.user_path=1) AS user_path,count(DISTINCT a.server_id) AS device_count,count(DISTINCT a.server_id) FILTER (WHERE ${isNew}) AS new_count,
  string_agg(DISTINCT a.server_id,',' ORDER BY a.server_id) AS device_ids,string_agg(DISTINCT a.server_id,',' ORDER BY a.server_id) FILTER (WHERE ${isNew}) AS new_device_ids,count(*) OVER () AS total
  FROM device_autostart a WHERE a.server_id IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(devices)}::jsonb)) AND ${search}
  GROUP BY a.category,lower(a.name),lower(coalesce(a.target,'')) ORDER BY count(DISTINCT a.server_id) ASC,lower(mode() WITHIN GROUP (ORDER BY a.name)),a.category,lower(coalesce(a.target,'')) LIMIT ${maxAutostartItems+1}`);
 const total=rows.length?Number(rows[0].total):0;
 const ids=(value:string|null)=>String(value??'').split(',').filter(Boolean);
 return {
  rows:rows.slice(0,maxAutostartItems).map(row=>({name:String(row.name),category:row.category as AutostartCategory,target:row.target,signature:row.signature as AutostartSignature,signer:row.signer,publisher:row.publisher,userPath:row.user_path===true,deviceCount:Number(row.device_count),newCount:Number(row.new_count),deviceIds:ids(row.device_ids),newDeviceIds:ids(row.new_device_ids)})),
  total,truncated:total>maxAutostartItems,
 };
}
