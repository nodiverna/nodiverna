// Server side of the driver inventory (lib/driver-inventory.ts): the ingest of
// POST /api/agent/drivers, the heartbeat's resync decision, the list of one
// device and the fleet view grouped by driver, version and provider. There is
// no change history. Each route in app/api is a thin adapter around this module.
import {HttpError,guid} from '../context';
import {requireDevice} from '../identity/access';
import {db,sql} from '../db';
import type {Viewer} from '../../types';
import {likePattern,scopeDeviceIds} from './software';
import {driverChecksum,driverReport,driverSearchTokens,maxDriverItems,type DriverItem} from '../../driver-inventory';

/** The agent may send a list at most once per minute. */
export const driverReportIntervalMs=60_000;
const invalid=()=>new HttpError('apiError.drivers.reportInvalid');
type StateRow={checksum:string;reported_at:number;count:number;truncated:number};
type ItemRow={key:string;device_name:string;device_class:string|null;inf_name:string|null;file:string|null;service:string|null;provider:string|null;version:string|null;driver_date:string|null;signed:number|null;signer:string|null};
const activeDevice=(serverId:string)=>sql`EXISTS (SELECT 1 FROM servers WHERE id=${serverId} AND revoked=0)`;
const signedOf=(value:number|null):boolean|null=>value===null||value===undefined?null:Number(value)===1;
const itemOf=(row:ItemRow):DriverItem=>({key:String(row.key),deviceName:String(row.device_name),deviceClass:row.device_class,infName:row.inf_name,file:row.file,service:row.service,provider:row.provider,version:row.version,date:row.driver_date,signed:signedOf(row.signed),signer:row.signer});

/**
 * Stores one report of a device in one transaction, fenced on the previous
 * checksum and report time: the device's rows are replaced. An identical
 * checksum only refreshes reported_at. 429 while the last report is younger
 * than 60 s. A parallel second report retries after the first commits and then
 * meets that rule.
 */
export async function ingestDrivers(serverId:string,value:unknown,now:number):Promise<{ok:true;changed:boolean}>{
 const parsed=driverReport.safeParse(value);
 if(!parsed.success)throw invalid();
 const report=parsed.data;
 if(await driverChecksum(report.items)!==report.checksum)throw invalid();
 return db().transaction(async tx=>{
  const state=await tx.one<StateRow>(sql`SELECT checksum,reported_at,count,truncated FROM device_driver_state WHERE server_id=${serverId}`);
  if(state&&now-Number(state.reported_at)<driverReportIntervalMs)throw new HttpError('apiError.drivers.tooSoon');
  const fence=state?sql`checksum=${state.checksum} AND reported_at=${Number(state.reported_at)}`:sql`TRUE`;
  const truncated=report.truncated?1:0;
  if(state&&state.checksum===report.checksum){
   const refreshed=await tx.exec(sql`UPDATE device_driver_state SET reported_at=${now},count=${report.count},truncated=${truncated} WHERE server_id=${serverId} AND ${fence} AND ${activeDevice(serverId)}`);
   if(!refreshed.rowCount)throw new HttpError('apiError.agent.notApproved');
   return {ok:true as const,changed:false};
  }
  const stored=state
   ?await tx.exec(sql`UPDATE device_driver_state SET checksum=${report.checksum},reported_at=${now},count=${report.count},truncated=${truncated} WHERE server_id=${serverId} AND ${fence} AND ${activeDevice(serverId)}`)
   :await tx.exec(sql`INSERT INTO device_driver_state(server_id,checksum,reported_at,count,truncated) SELECT ${serverId},${report.checksum},${now},${report.count},${truncated} WHERE ${activeDevice(serverId)} ON CONFLICT (server_id) DO NOTHING`);
  if(!stored.rowCount)throw new HttpError('apiError.agent.notApproved');
  await tx.exec(sql`DELETE FROM device_drivers WHERE server_id=${serverId}`);
  if(report.items.length){
   const rows=report.items.map(item=>({key:item.key,device_name:item.deviceName,device_class:item.deviceClass,inf_name:item.infName,file:item.file,service:item.service,provider:item.provider,version:item.version,driver_date:item.date,signed:item.signed===null?null:item.signed?1:0,signer:item.signer}));
   await tx.exec(sql`INSERT INTO device_drivers(server_id,key,device_name,device_class,inf_name,file,service,provider,version,driver_date,signed,signer)
    SELECT ${serverId},r.key,r.device_name,r.device_class,r.inf_name,r.file,r.service,r.provider,r.version,r.driver_date,r.signed,r.signer FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
    AS r(key text,device_name text,device_class text,inf_name text,file text,service text,provider text,version text,driver_date text,signed smallint,signer text)`);
  }
  return {ok:true as const,changed:true};
 });
}

/** True when the heartbeat's driver checksum is set and differs from the stored state (or there is none): the agent sends its list again. */
export async function driverResyncNeeded(serverId:string,checksum:string|null|undefined):Promise<boolean>{
 if(!checksum)return false;
 const state=await db().one<{checksum:string}>(sql`SELECT checksum FROM device_driver_state WHERE server_id=${serverId}`);
 return state?.checksum!==checksum;
}

export type DeviceDriverView={state:{checksum:string;reportedAt:number;count:number;truncated:boolean}|null;items:DriverItem[]};
/** GET /api/drivers/device?id=: the device right view; 404 outside the customer boundary. */
export async function deviceDriverView(v:Viewer,id:unknown):Promise<DeviceDriverView>{
 if(!guid(id))throw new HttpError('apiError.device.invalid');
 await requireDevice(v,id,'view');
 const [state,items]=await Promise.all([
  db().one<StateRow>(sql`SELECT checksum,reported_at,count,truncated FROM device_driver_state WHERE server_id=${id}`),
  db().query<ItemRow>(sql`SELECT key,device_name,device_class,inf_name,file,service,provider,version,driver_date,signed,signer FROM device_drivers WHERE server_id=${id} ORDER BY lower(device_name),device_name,key LIMIT ${maxDriverItems}`),
 ]);
 return {state:state?{checksum:state.checksum,reportedAt:Number(state.reported_at),count:Number(state.count),truncated:Number(state.truncated)===1}:null,items:items.map(itemOf)};
}

export type DriverFleetRow={driver:string;version:string|null;provider:string|null;date:string|null;signed:boolean|null;deviceClass:string|null;deviceCount:number;deviceIds:string[]};
export type DriverFleetView={rows:DriverFleetRow[];total:number;truncated:boolean};
/**
 * GET /api/drivers?scope=&q=: the drivers of the visible devices in the scope,
 * grouped by driver (INF name, else device name), version and provider, most
 * devices first, at most 2000 rows. signed is false when one device reports
 * the driver unsigned, true when all report it signed, else null. Every search
 * token must be a substring of the driver, device name, provider or version.
 */
export async function driverFleetView(v:Viewer,params:URLSearchParams):Promise<DriverFleetView>{
 const devices=await scopeDeviceIds(v,params.get('scope'));
 if(!devices.length)return {rows:[],total:0,truncated:false};
 const tokens=driverSearchTokens(params.get('q'));
 const search=tokens.length?sql.join(tokens.map(token=>{const pattern=likePattern(token);return sql`(coalesce(d.inf_name,'') ILIKE ${pattern} OR d.device_name ILIKE ${pattern} OR coalesce(d.provider,'') ILIKE ${pattern} OR coalesce(d.version,'') ILIKE ${pattern})`;}),sql` AND `):sql`TRUE`;
 const rows=await db().query<{driver:string;version:string|null;provider:string|null;date:string|null;signed:number|null;device_class:string|null;device_count:number;device_ids:string;total:number}>(sql`SELECT coalesce(d.inf_name,d.device_name) AS driver,d.version,d.provider,
  max(d.driver_date) AS date,CASE WHEN bool_or(d.signed=0) THEN 0 WHEN bool_and(d.signed=1) THEN 1 ELSE NULL END AS signed,mode() WITHIN GROUP (ORDER BY d.device_class) AS device_class,
  count(DISTINCT d.server_id) AS device_count,string_agg(DISTINCT d.server_id,',' ORDER BY d.server_id) AS device_ids,count(*) OVER () AS total
  FROM device_drivers d WHERE d.server_id IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(devices)}::jsonb)) AND ${search}
  GROUP BY coalesce(d.inf_name,d.device_name),d.version,d.provider ORDER BY count(DISTINCT d.server_id) DESC,lower(coalesce(d.inf_name,d.device_name)),d.version NULLS LAST,d.provider NULLS LAST LIMIT ${maxDriverItems+1}`);
 const total=rows.length?Number(rows[0].total):0;
 return {
  rows:rows.slice(0,maxDriverItems).map(row=>({driver:String(row.driver),version:row.version,provider:row.provider,date:row.date,signed:signedOf(row.signed),deviceClass:row.device_class,deviceCount:Number(row.device_count),deviceIds:String(row.device_ids??'').split(',').filter(Boolean)})),
  total,truncated:total>maxDriverItems,
 };
}
