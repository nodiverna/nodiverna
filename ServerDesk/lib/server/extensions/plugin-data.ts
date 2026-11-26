import {z} from 'zod';
import {body,HttpError,guid,now} from '../context';
import {agentFromBearer,snapshot as deviceSnapshot} from '../agent/agent-protocol';
import {devicePermissionGuard,principal,requireDevice} from '../identity/access';
import {db,sql,type Queryable} from '../db';
import {isPluginOperation,pluginOperations,pluginReady,snapshotPlugin,PLUGIN_JOB} from '../../plugin-catalog';
import {syncDeviceAlerts} from '../devices/alerts';
import {DHCP_PLUGIN,DHCP_READ,dhcpSnapshotSchema,dhcpUsageRows,dhcpUsageSummary,sortDhcpUsageRows,type DhcpSnapshot,type DhcpUsageRow,type DhcpUsageSummary} from '../../dhcp';
import {DNS_PLUGIN,DNS_READ} from '../../dns';
import {ingestDnsData} from './dns-data';
import type {DhcpAlertData,Viewer} from '../../types';

// The data that agent plugins upload (docs/agent-plugins.md, "Signed
// collection"): POST /api/agent/plugin-data with the device credentials, and
// the reads of GET /api/dhcp. device_plugin_data keeps only the latest result
// per device, plugin and operation; an older collectedAt never overwrites a
// newer one. The broker uploads a periodic result at most every 15 minutes
// under the signed plugin policy, and a job result with the job id: a read job,
// or the fresh read after a DHCP change (plugin 1.1.0), which is stored as the
// one dhcp-read row of the device. The DNS plugin (docs/dns-server.md) uploads
// its server read and the records of one zone; lib/server/extensions/dns-data.ts stores them.

/** The largest upload body: the 2 MiB of plugin data and the envelope. */
export const PLUGIN_DATA_BODY_LIMIT=2_621_440;
/** A periodic upload (without job id) is accepted at most once per minute per device and plugin. */
export const PLUGIN_DATA_SPACING_MS=60_000;
// Collected on the device; a time this far ahead of the portal clock is refused.
const FUTURE_TOLERANCE_MS=10*60_000;

/** The periodic read of each plugin: the only operation that uploads without a job id. */
const periodicReads:Readonly<Record<string,string>>={[DHCP_PLUGIN]:DHCP_READ,[DNS_PLUGIN]:DNS_READ};
const upload=z.object({
 serverId:z.guid(),plugin:z.enum([DHCP_PLUGIN,DNS_PLUGIN]),operation:z.string().max(64),jobId:z.guid().nullable().optional(),
 collectedAt:z.string().max(40).datetime({offset:true}),data:z.unknown().optional(),
}).strict();

/**
 * One upload. The operation must belong to the plugin, and the bearer device
 * must be the device of the body and report the plugin ready with the
 * operation. With a job id the job must be a running plugin job of this
 * operation on the device; without one the operation must be the plugin's
 * periodic read (dhcp-read, dns-read) and the upload counts against the
 * 60-second spacing per plugin (429 apiError.plugin.dataTooSoon). Data that
 * fail the schema answer 400 apiError.plugin.dataInvalid. A DHCP upload is
 * stored as the dhcp-read row with its service state; a DNS upload goes to
 * lib/server/extensions/dns-data.ts by its kind. A stored read then brings the alarms up to date.
 */
export async function ingestPluginData(request:Request){
 // Authenticate from the headers before reading up to 2.5 MiB of body.
 const device=await agentFromBearer(request,{allowTokenRetry:true});
 const raw=await body(request,PLUGIN_DATA_BODY_LIMIT);
 const parsed=upload.safeParse(raw);if(!parsed.success)throw new HttpError('apiError.plugin.dataInvalid');
 const p=parsed.data;if(!isPluginOperation(p.operation)||pluginOperations[p.operation].plugin!==p.plugin)throw new HttpError('apiError.plugin.dataInvalid');
 if(p.serverId!==device.id)throw new HttpError('apiError.agent.notApproved');
 if(!pluginReady(deviceSnapshot(device),p.plugin,p.operation))throw new HttpError('apiError.plugin.notReported');
 const time=now(),collectedAt=Date.parse(p.collectedAt);
 if(!Number.isSafeInteger(collectedAt)||collectedAt<1||collectedAt>time+FUTURE_TOLERANCE_MS)throw new HttpError('apiError.plugin.dataInvalid');
 const jobId=p.jobId??null;
 // Only a running change job may upload the read after its change.
 if(jobId===null&&p.operation!==periodicReads[p.plugin])throw new HttpError('apiError.plugin.dataInvalid');
 const runningJob=sql`EXISTS (SELECT 1 FROM jobs WHERE id=${jobId} AND server_id=${device.id} AND action=${PLUGIN_JOB} AND target=${p.operation} AND state='running')`;
 if(jobId!==null&&!await db().one(sql`SELECT 1 AS running WHERE ${runningJob}`))throw new HttpError('apiError.plugin.jobNotRunning');
 if(jobId===null){
  const last=await db().one<{received_at:number}>(sql`SELECT max(received_at) AS received_at FROM device_plugin_data WHERE server_id=${device.id} AND plugin=${p.plugin}`);
  if(last?.received_at!=null&&Number(last.received_at)>time-PLUGIN_DATA_SPACING_MS)throw new HttpError('apiError.plugin.dataTooSoon');
 }
 // Guarded in the write as well: the device is active, the job still runs, and a periodic upload keeps its spacing.
 const spacing=jobId===null?sql`NOT EXISTS (SELECT 1 FROM device_plugin_data spaced WHERE spaced.server_id=${device.id} AND spaced.plugin=${p.plugin} AND spaced.received_at>${time-PLUGIN_DATA_SPACING_MS})`:runningJob;
 if(p.plugin===DNS_PLUGIN){
  const result=await ingestDnsData({device,operation:p.operation,jobId,data:p.data,collectedAt,time,guard:sql`EXISTS (SELECT 1 FROM servers WHERE id=${device.id} AND revoked=0) AND ${spacing}`});
  if(result.server)await syncAlerts(device.id,time);
  return Response.json({ok:true,stored:result.stored},{headers:{'Cache-Control':'no-store'}});
 }
 const data=dhcpSnapshotSchema.safeParse(p.data);if(!data.success)throw new HttpError('apiError.plugin.dataInvalid');
 const summary=JSON.stringify(dhcpUsageSummary(data.data));
 const stored=await db().exec(sql`INSERT INTO device_plugin_data (server_id,plugin,operation,data,summary,collected_at,received_at,service)
  SELECT ${device.id},${p.plugin},${DHCP_READ},${JSON.stringify(data.data)},${summary},${collectedAt},${time},${data.data.service} WHERE EXISTS (SELECT 1 FROM servers WHERE id=${device.id} AND revoked=0) AND ${spacing}
  ON CONFLICT (server_id,plugin,operation) DO UPDATE SET data=excluded.data,summary=excluded.summary,collected_at=excluded.collected_at,received_at=excluded.received_at,service=excluded.service
  WHERE excluded.collected_at>device_plugin_data.collected_at`);
 // The DHCP alert rules read the stored data: bring the alarms of the device up to date.
 if(stored.rowCount>0)await syncAlerts(device.id,time);
 return Response.json({ok:true,stored:stored.rowCount>0},{headers:{'Cache-Control':'no-store'}});
}

/** The alert rules read the stored plugin data: bring the alarms of the device up to date; a failure is logged, the upload stays stored. */
async function syncAlerts(serverId:string,time:number){
 try{await syncDeviceAlerts(serverId,time);}catch(error){console.error(`ServerDesk: The alarm state of device ${serverId} could not be updated: ${error instanceof Error?error.message:String(error)}`);}
}

export type DeviceDhcpView={snapshot:DhcpSnapshot|null;collectedAt:number|null;receivedAt:number|null;plugin:{version:string;state:'ready'|'damaged'}|null};
/** GET /api/dhcp?serverId=: the latest DHCP read of a device for a viewer with dhcp.read there (customer boundary). */
export async function deviceDhcpView(v:Viewer,serverId:unknown):Promise<DeviceDhcpView>{
 if(!guid(serverId))throw new HttpError('apiError.device.invalid');
 const device=await requireDevice(v,serverId,'dhcp.read');
 const row=await db().one<{data:string;collected_at:number;received_at:number}>(sql`SELECT data,collected_at,received_at FROM device_plugin_data WHERE server_id=${device.id} AND plugin=${DHCP_PLUGIN} AND operation=${DHCP_READ}`);
 const plugin=snapshotPlugin(deviceSnapshot(device),DHCP_PLUGIN);
 return {snapshot:row?JSON.parse(row.data) as DhcpSnapshot:null,collectedAt:row?Number(row.collected_at):null,receivedAt:row?Number(row.received_at):null,plugin:plugin?{version:plugin.version,state:plugin.state}:null};
}

/**
 * GET /api/dhcp?usage=1: the scope usage rows of every device where the
 * viewer holds dhcp.read inside the customer boundary, in one statement,
 * sorted by percent (descending), server name and scope id. No right gives [].
 */
export async function dhcpUsage(v:Viewer):Promise<DhcpUsageRow[]>{
 const rows=await db().query<{server_id:string;name:string;summary:string;collected_at:number}>(sql`SELECT d.server_id,s.name,d.summary,d.collected_at FROM device_plugin_data d JOIN servers s ON s.id=d.server_id
  WHERE d.plugin=${DHCP_PLUGIN} AND d.operation=${DHCP_READ} AND ${devicePermissionGuard(sql`d.server_id`,sql`${principal(v)}`,'dhcp.read')}`);
 const names=new Map(rows.map(row=>[row.server_id,row.name]));
 return sortDhcpUsageRows(rows.flatMap(row=>dhcpUsageRows(row.server_id,JSON.parse(row.summary) as DhcpUsageSummary[],Number(row.collected_at))),id=>names.get(id)??id);
}

/**
 * The DHCP data the alert rules read, for a JSON array of device IDs
 * in ONE statement: the service state and the IPv4 scopes of the stored usage
 * summary with the read time. Used only for the evaluation; the console row
 * never carries it.
 */
export async function consoleDhcpAlerts(scope:string,q:Queryable=db()):Promise<Map<string,DhcpAlertData>>{
 const rows=await q.query<{server_id:string;summary:string;service:string|null;collected_at:number}>(sql`SELECT server_id,summary,service,collected_at FROM device_plugin_data
  WHERE plugin=${DHCP_PLUGIN} AND operation=${DHCP_READ} AND server_id IN (SELECT value FROM jsonb_array_elements_text(${scope}::jsonb))`);
 const result=new Map<string,DhcpAlertData>();
 for(const row of rows){
  let summary:DhcpUsageSummary[]=[];try{summary=JSON.parse(row.summary);}catch{}
  result.set(String(row.server_id),{service:row.service==='running'||row.service==='stopped'?row.service:null,collectedAt:Number(row.collected_at),
   scopes:summary.filter(item=>item.family==='ipv4'&&item.total!==null).map(item=>({scopeId:item.scopeId,state:item.state,inUse:item.inUse,total:item.total!,percent:item.percent}))});
 }
 return result;
}
