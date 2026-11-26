import {HttpError,guid} from '../context';
import {snapshot as deviceSnapshot} from '../agent/agent-protocol';
import {devicePermissionGuard,principal,requireDevice} from '../identity/access';
import {db,jsonText,sql,type Queryable,type Sql} from '../db';
import {snapshotPlugin,PLUGIN_JOB} from '../../plugin-catalog';
import {DNS_PLUGIN,DNS_READ,dnsFleetRows,dnsSnapshotSchema,dnsZoneRecordsSchema,dnsZoneSummary,sortDnsFleetRows,type DnsFleetZone,type DnsSnapshot,type DnsZoneRecords,type DnsZoneSummary} from '../../dns';
import {DNS_RECORD_OPERATIONS} from '../../dns-changes';
import type {DnsAlertData,Viewer} from '../../types';

// The data of the DNS plugin (docs/dns-server.md): the ingest of its uploads
// (called by lib/server/extensions/plugin-data.ts after the device, the job and the spacing are
// checked) and the views of GET /api/dns. The server read (dns-read) is the one
// device_plugin_data row (dns, dns-read) with its service state and the zone
// summary; the records of one zone are one device_dns_zone_records row per
// device and zone. An older collectedAt never overwrites a newer one. Zone
// records are stored only for a running job of that device whose parameter
// zone is the zone of the data.

/** The operations whose upload carries the records of their zone (kind zone): the zone read, the record changes and the transfer from the primary. */
export const DNS_ZONE_DATA_OPERATIONS:ReadonlySet<string>=new Set(['dns-zone-read',...DNS_RECORD_OPERATIONS,'dns-zone-transfer']);
/** Whether an operation uploads the server (kind server): the read and every other change. */
export const dnsServerDataOperation=(operation:string)=>operation===DNS_READ||operation.startsWith('dns-')&&!DNS_ZONE_DATA_OPERATIONS.has(operation);

type Upload={device:{id:string};operation:string;jobId:string|null;data:unknown;collectedAt:number;time:number;
 /** The guard of the write: the device is active and the running job (or the periodic spacing) still holds. */
 guard:Sql};
/**
 * One DNS upload, routed by data.kind. server: the dns-read row with service
 * and summary; in the same transaction the zone records of zones that the read
 * no longer lists are deleted (only when truncated.zones is false). zone: the
 * row of that zone, only for a running zone read, record change or transfer
 * whose parameter zone equals data.zone. Answers whether a server read was
 * stored (the caller then syncs the alarms) and whether anything was stored.
 */
export async function ingestDnsData(upload:Upload):Promise<{stored:boolean;server:boolean}>{
 const {device,operation,jobId,collectedAt,time,guard}=upload;
 const kind=upload.data&&typeof upload.data==='object'?(upload.data as {kind?:unknown}).kind:undefined;
 if(kind==='server'){
  if(!dnsServerDataOperation(operation))throw new HttpError('apiError.plugin.dataInvalid');
  const parsed=dnsSnapshotSchema.safeParse(upload.data);if(!parsed.success)throw new HttpError('apiError.plugin.dataInvalid');
  const snapshot=parsed.data,summary=JSON.stringify(dnsZoneSummary(snapshot)),zones=JSON.stringify(snapshot.zones.map(zone=>zone.name));
  const stored=await db().transaction(async tx=>{
   const written=await tx.exec(sql`INSERT INTO device_plugin_data (server_id,plugin,operation,data,summary,collected_at,received_at,service)
    SELECT ${device.id},${DNS_PLUGIN},${DNS_READ},${JSON.stringify(snapshot)},${summary},${collectedAt},${time},${snapshot.service} WHERE ${guard}
    ON CONFLICT (server_id,plugin,operation) DO UPDATE SET data=excluded.data,summary=excluded.summary,collected_at=excluded.collected_at,received_at=excluded.received_at,service=excluded.service
    WHERE excluded.collected_at>device_plugin_data.collected_at`);
   // The records of a zone that is gone; a read with cut zones keeps every row.
   if(written.rowCount>0&&!snapshot.truncated.zones)await tx.exec(sql`DELETE FROM device_dns_zone_records WHERE server_id=${device.id} AND zone NOT IN (SELECT value FROM jsonb_array_elements_text(${zones}::jsonb))`);
   return written.rowCount>0;
  });
  return {stored,server:stored};
 }
 if(kind==='zone'){
  if(!DNS_ZONE_DATA_OPERATIONS.has(operation)||jobId===null)throw new HttpError('apiError.plugin.dataInvalid');
  const parsed=dnsZoneRecordsSchema.safeParse(upload.data);if(!parsed.success)throw new HttpError('apiError.plugin.dataInvalid');
  const records=parsed.data;
  // Only the job of this zone may store its records.
  const zoneJob=sql`EXISTS (SELECT 1 FROM jobs WHERE id=${jobId} AND server_id=${device.id} AND action=${PLUGIN_JOB} AND target=${operation} AND state='running' AND ${jsonText(sql`parameters`,'parameters','zone')}=${records.zone})`;
  if(!await db().one(sql`SELECT 1 AS matched WHERE ${zoneJob}`))throw new HttpError('apiError.plugin.dataInvalid');
  const written=await db().exec(sql`INSERT INTO device_dns_zone_records (server_id,zone,data,record_count,truncated,collected_at,received_at)
   SELECT ${device.id},${records.zone},${JSON.stringify(records)},${records.total},${records.truncated},${collectedAt},${time} WHERE ${guard} AND ${zoneJob}
   ON CONFLICT (server_id,zone) DO UPDATE SET data=excluded.data,record_count=excluded.record_count,truncated=excluded.truncated,collected_at=excluded.collected_at,received_at=excluded.received_at
   WHERE excluded.collected_at>device_dns_zone_records.collected_at`);
  return {stored:written.rowCount>0,server:false};
 }
 throw new HttpError('apiError.plugin.dataInvalid');
}

// ---- Stored data ----------------------------------------------------------------------------------
export type StoredDns={snapshot:DnsSnapshot;collectedAt:number;receivedAt:number;service:'running'|'stopped'};
/** The stored server read of a device with its service state (the service column, else the read itself), or null. */
export async function storedDns(serverId:string,q:Queryable=db()):Promise<StoredDns|null>{
 const row=await q.one<{data:string;collected_at:number;received_at:number;service:string|null}>(sql`SELECT data,collected_at,received_at,service FROM device_plugin_data WHERE server_id=${serverId} AND plugin=${DNS_PLUGIN} AND operation=${DNS_READ}`);
 if(!row)return null;
 const snapshot=JSON.parse(row.data) as DnsSnapshot;
 return {snapshot,collectedAt:Number(row.collected_at),receivedAt:Number(row.received_at),service:row.service==='running'||row.service==='stopped'?row.service:snapshot.service};
}
/** The stored records of one zone of a device, or null. */
export async function storedDnsZone(serverId:string,zone:string,q:Queryable=db()):Promise<{records:DnsZoneRecords;collectedAt:number;receivedAt:number}|null>{
 const row=await q.one<{data:string;collected_at:number;received_at:number}>(sql`SELECT data,collected_at,received_at FROM device_dns_zone_records WHERE server_id=${serverId} AND zone=${zone}`);
 return row?{records:JSON.parse(row.data) as DnsZoneRecords,collectedAt:Number(row.collected_at),receivedAt:Number(row.received_at)}:null;
}

// ---- Views of GET /api/dns -----------------------------------------------------------------------------
export type DeviceDnsView={snapshot:DnsSnapshot|null;collectedAt:number|null;receivedAt:number|null;plugin:{version:string;state:'ready'|'damaged'}|null};
/** GET /api/dns?serverId=: the latest server read of a device for a viewer with dns.read there (customer boundary). */
export async function deviceDnsView(v:Viewer,serverId:unknown):Promise<DeviceDnsView>{
 if(!guid(serverId))throw new HttpError('apiError.device.invalid');
 const device=await requireDevice(v,serverId,'dns.read');
 const stored=await storedDns(device.id),plugin=snapshotPlugin(deviceSnapshot(device),DNS_PLUGIN);
 return {snapshot:stored?.snapshot??null,collectedAt:stored?.collectedAt??null,receivedAt:stored?.receivedAt??null,plugin:plugin?{version:plugin.version,state:plugin.state}:null};
}
export type DeviceDnsZoneView={records:DnsZoneRecords|null;collectedAt:number|null;receivedAt:number|null};
/** GET /api/dns?serverId=&zone=: the stored records of one zone, or null before the first zone read. */
export async function deviceDnsZoneView(v:Viewer,serverId:unknown,zone:unknown):Promise<DeviceDnsZoneView>{
 if(!guid(serverId))throw new HttpError('apiError.device.invalid');
 if(typeof zone!=='string'||!zone||zone.length>255)throw new HttpError('apiError.request.invalid');
 const device=await requireDevice(v,serverId,'dns.read');
 const stored=await storedDnsZone(device.id,zone);
 return {records:stored?.records??null,collectedAt:stored?.collectedAt??null,receivedAt:stored?.receivedAt??null};
}
/**
 * GET /api/dns?zones=1: the zones of every device where the viewer holds
 * dns.read inside the customer boundary, in one statement from the stored
 * summary, without the zones Windows created, sorted by zone name, then device
 * name. No right gives [].
 */
export async function dnsFleetZones(v:Viewer):Promise<DnsFleetZone[]>{
 const rows=await db().query<{server_id:string;name:string;summary:string;collected_at:number}>(sql`SELECT d.server_id,s.name,d.summary,d.collected_at FROM device_plugin_data d JOIN servers s ON s.id=d.server_id
  WHERE d.plugin=${DNS_PLUGIN} AND d.operation=${DNS_READ} AND s.revoked=0 AND ${devicePermissionGuard(sql`d.server_id`,sql`${principal(v)}`,'dns.read')}`);
 const names=new Map(rows.map(row=>[String(row.server_id),String(row.name)]));
 return sortDnsFleetRows(rows.flatMap(row=>{let summary:DnsZoneSummary[]=[];try{summary=JSON.parse(row.summary);}catch{}return dnsFleetRows(String(row.server_id),summary,Number(row.collected_at));}),id=>names.get(id)??id);
}

/**
 * The DNS data the alert rule DNS service stopped reads, for a JSON array of
 * device IDs in ONE statement: the service state with the read time. Used only
 * for the evaluation; the console row never carries it.
 */
export async function consoleDnsAlerts(scope:string,q:Queryable=db()):Promise<Map<string,DnsAlertData>>{
 const rows=await q.query<{server_id:string;service:string|null;collected_at:number}>(sql`SELECT server_id,service,collected_at FROM device_plugin_data
  WHERE plugin=${DNS_PLUGIN} AND operation=${DNS_READ} AND server_id IN (SELECT value FROM jsonb_array_elements_text(${scope}::jsonb))`);
 return new Map(rows.map(row=>[String(row.server_id),{service:row.service==='running'||row.service==='stopped'?row.service:null,collectedAt:Number(row.collected_at)}]));
}
