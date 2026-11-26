// Server side of the software inventory (lib/software-inventory.ts): the ingest
// of POST /api/agent/software, the heartbeat's resync decision, the list and
// change history of one device and the fleet view grouped by product and
// version. Each route in app/api is a thin adapter around this module.
import {HttpError,guid} from '../context';
import {allowedDeviceIds,requireDevice,requireGroup} from '../identity/access';
import {visibleCustomers} from '../identity/customers';
import {db,sql,type Sql,type Tx} from '../db';
import type {Viewer} from '../../types';
import {catalogNameFilter,programVerdicts,publicStatus,vulnerabilityContext,type VulnerabilityStatus} from './vulnerability-verdicts';
import {productVerdict,type Verdict} from '../../software-vulnerabilities';
import {diffSoftware,maxSoftwareItems,normalizeSoftwareName,normalizeSoftwareVersion,softwareChecksum,softwareIdentity,softwareReport,softwareSearchTokens,type SoftwareArchitecture,type SoftwareItem,type SoftwareScope,type StoredSoftware} from '../../software-inventory';

/** The agent may send a list at most once per minute. */
export const softwareReportIntervalMs=60_000;
/** The change history of the device view shows the newest 500 changes. */
export const softwareChangeLimit=500;
const invalid=()=>new HttpError('apiError.software.reportInvalid');

type StateRow={checksum:string;reported_at:number;count:number;truncated:number};
type ItemRow={key:string;scope:string;architecture:string;name:string;normalized_name:string;normalized_version?:string|null;version:string|null;publisher:string|null;install_date:string|null;first_seen:number};
const architectureOf=(value:string|null):SoftwareArchitecture|null=>value==='x64'||value==='x86'||value==='arm64'?value:null;
const storedItem=(row:ItemRow):StoredSoftware=>({key:String(row.key),scope:row.scope as SoftwareScope,architecture:architectureOf(row.architecture),name:String(row.name),normalizedName:String(row.normalized_name),version:row.version,publisher:row.publisher,installDate:row.install_date,firstSeen:Number(row.first_seen)});
const activeDevice=(serverId:string)=>sql`EXISTS (SELECT 1 FROM servers WHERE id=${serverId} AND revoked=0)`;

/**
 * Stores one report of a device in one transaction, fenced on the previous
 * checksum and report time. The first report is a baseline without change
 * rows; later reports record installed, updated and removed entries. An
 * identical checksum only refreshes reported_at. 429 while the last report is
 * younger than 60 s. A parallel second report retries after the first commits
 * (SERIALIZABLE) and then meets that rule, so changes are recorded once.
 */
export async function ingestSoftware(serverId:string,value:unknown,now:number):Promise<{ok:true;baseline:boolean;changes:number}>{
 const parsed=softwareReport.safeParse(value);
 if(!parsed.success)throw invalid();
 const report=parsed.data;
 if(await softwareChecksum(report.items)!==report.checksum)throw invalid();
 return db().transaction(async tx=>{
  const state=await tx.one<StateRow>(sql`SELECT checksum,reported_at,count,truncated FROM device_software_state WHERE server_id=${serverId}`);
  if(state&&now-Number(state.reported_at)<softwareReportIntervalMs)throw new HttpError('apiError.software.tooSoon');
  const fence=state?sql`checksum=${state.checksum} AND reported_at=${Number(state.reported_at)}`:sql`TRUE`;
  if(state&&state.checksum===report.checksum){
   const refreshed=await tx.exec(sql`UPDATE device_software_state SET reported_at=${now},count=${report.count},truncated=${report.truncated?1:0} WHERE server_id=${serverId} AND ${fence} AND ${activeDevice(serverId)}`);
   if(!refreshed.rowCount)throw new HttpError('apiError.agent.notApproved');
   return {ok:true as const,baseline:false,changes:0};
  }
  const previous=(await tx.query<ItemRow>(sql`SELECT key,scope,architecture,name,normalized_name,version,publisher,install_date,first_seen FROM device_software WHERE server_id=${serverId}`)).map(storedItem);
  const {changes,firstSeen}=state?diffSoftware(previous,report.items,report.truncated,now):{changes:[],firstSeen:new Map<string,number>()};
  const stored=state
   ?await tx.exec(sql`UPDATE device_software_state SET checksum=${report.checksum},reported_at=${now},count=${report.count},truncated=${report.truncated?1:0} WHERE server_id=${serverId} AND ${fence} AND ${activeDevice(serverId)}`)
   :await tx.exec(sql`INSERT INTO device_software_state(server_id,checksum,reported_at,count,truncated) SELECT ${serverId},${report.checksum},${now},${report.count},${report.truncated?1:0} WHERE ${activeDevice(serverId)} ON CONFLICT (server_id) DO NOTHING`);
  if(!stored.rowCount)throw new HttpError('apiError.agent.notApproved');
  await replaceItems(tx,serverId,report.items,firstSeen,now);
  if(changes.length)await tx.exec(sql`INSERT INTO device_software_changes(server_id,at,change,name,normalized_name,version_from,version_to,publisher,architecture,scope)
   SELECT ${serverId},${now}::bigint,c.change,c.name,c.normalized_name,c.version_from,c.version_to,c.publisher,c.architecture,c.scope FROM jsonb_to_recordset(${JSON.stringify(changes.map(change=>({change:change.change,name:change.name,normalized_name:change.normalizedName,version_from:change.versionFrom,version_to:change.versionTo,publisher:change.publisher,architecture:change.architecture,scope:change.scope})))}::jsonb)
   AS c(change text,name text,normalized_name text,version_from text,version_to text,publisher text,architecture text,scope text)`);
  return {ok:true as const,baseline:!state,changes:changes.length};
 });
}
async function replaceItems(tx:Tx,serverId:string,items:readonly SoftwareItem[],firstSeen:Map<string,number>,now:number){
 await tx.exec(sql`DELETE FROM device_software WHERE server_id=${serverId}`);
 if(!items.length)return;
 const rows=items.map(item=>({key:item.key,scope:item.scope,architecture:item.architecture??'',name:item.name,normalized_name:normalizeSoftwareName(item.name,item.version),version:item.version,normalized_version:normalizeSoftwareVersion(item.version),publisher:item.publisher,install_date:item.installDate,first_seen:firstSeen.get(softwareIdentity(item))??now}));
 await tx.exec(sql`INSERT INTO device_software(server_id,key,scope,architecture,name,normalized_name,version,normalized_version,publisher,install_date,first_seen,updated_at)
  SELECT ${serverId},r.key,r.scope,r.architecture,r.name,r.normalized_name,r.version,r.normalized_version,r.publisher,r.install_date,r.first_seen,${now}::bigint FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
  AS r(key text,scope text,architecture text,name text,normalized_name text,version text,normalized_version text,publisher text,install_date text,first_seen bigint)`);
}

/** True when the heartbeat's checksum is set and differs from the stored state (or there is none): the agent sends its list again. */
export async function softwareResyncNeeded(serverId:string,checksum:string|null|undefined):Promise<boolean>{
 if(!checksum)return false;
 const state=await db().one<{checksum:string}>(sql`SELECT checksum FROM device_software_state WHERE server_id=${serverId}`);
 return state?.checksum!==checksum;
}

export type DeviceSoftwareView={
 state:{checksum:string;reportedAt:number;count:number;truncated:boolean}|null;
 /** verdict only while the vulnerability check is on (docs/software-vulnerabilities.md). */
 items:(SoftwareItem&{firstSeen:number;normalizedName:string;normalizedVersion:string|null;verdict?:Verdict})[];
 changes:{id:number;at:number;change:'installed'|'updated'|'removed';name:string;versionFrom:string|null;versionTo:string|null;publisher:string|null;architecture:SoftwareArchitecture|null;scope:SoftwareScope}[];
 vulnerabilities:VulnerabilityStatus;
};
/** GET /api/software/device?id=: the device right view (as the hardware inventory); 404 outside the customer boundary. With the vulnerability check on, each item has its verdict. */
export async function deviceSoftwareView(v:Viewer,id:unknown):Promise<DeviceSoftwareView>{
 if(!guid(id))throw new HttpError('apiError.device.invalid');
 await requireDevice(v,id,'view');
 const [state,items,changes]=await Promise.all([
  db().one<StateRow>(sql`SELECT checksum,reported_at,count,truncated FROM device_software_state WHERE server_id=${id}`),
  db().query<ItemRow>(sql`SELECT key,scope,architecture,name,normalized_name,normalized_version,version,publisher,install_date,first_seen FROM device_software WHERE server_id=${id} ORDER BY lower(name),name,scope,architecture,key LIMIT ${maxSoftwareItems}`),
  db().query<{id:number;at:number;change:string;name:string;version_from:string|null;version_to:string|null;publisher:string|null;architecture:string|null;scope:string}>(sql`SELECT id,at,change,name,version_from,version_to,publisher,architecture,scope FROM device_software_changes WHERE server_id=${id} ORDER BY at DESC,id DESC LIMIT ${softwareChangeLimit}`),
 ]);
 const context=await vulnerabilityContext();
 const list=items.map(row=>({key:String(row.key),scope:row.scope as SoftwareScope,architecture:architectureOf(row.architecture),name:String(row.name),version:row.version,publisher:row.publisher,installDate:row.install_date,firstSeen:Number(row.first_seen),normalizedName:String(row.normalized_name),normalizedVersion:row.normalized_version??null}));
 const verdicts=context.enabled?await programVerdicts(context,list):null;
 return {
  state:state?{checksum:state.checksum,reportedAt:Number(state.reported_at),count:Number(state.count),truncated:Number(state.truncated)===1}:null,
  items:verdicts?list.map((item,index)=>({...item,verdict:verdicts[index]})):list,
  changes:changes.map(row=>({id:Number(row.id),at:Number(row.at),change:row.change as 'installed'|'updated'|'removed',name:row.name,versionFrom:row.version_from,versionTo:row.version_to,publisher:row.publisher,architecture:architectureOf(row.architecture),scope:row.scope as SoftwareScope})),
  vulnerabilities:publicStatus(context),
 };
}

export type SoftwareFleetRow={name:string;publisher:string|null;version:string|null;normalizedName:string;normalizedVersion:string|null;deviceCount:number;deviceIds:string[];verdict?:Verdict};
export type SoftwareFleetView={rows:SoftwareFleetRow[];total:number;truncated:boolean;vulnerabilities:VulnerabilityStatus&{vulnerableRows:number}};
/** The visible devices of a scope: all, unassigned (of all customers or of one customer), a group (with its subgroups) or a customer; 404 for a group or customer outside the boundary. Shared by the fleet views of software, drivers (lib/server/devices/drivers.ts) and autostart (lib/server/devices/autostart.ts). */
export async function scopeDeviceIds(v:Viewer,scope:string|null):Promise<string[]>{
 const visible=await allowedDeviceIds(v,'view');
 if(!visible.length)return [];
 const ids=JSON.stringify(visible);
 const active=sql`s.revoked=0 AND s.id IN (SELECT value FROM jsonb_array_elements_text(${ids}::jsonb))`;
 if(scope===null||scope==='all')return (await db().query<{id:string}>(sql`SELECT s.id FROM servers s WHERE ${active}`)).map(row=>row.id);
 if(scope==='unassigned')return (await db().query<{id:string}>(sql`SELECT s.id FROM servers s WHERE ${active} AND NOT EXISTS (SELECT 1 FROM device_group_members m WHERE m.server_id=s.id)`)).map(row=>row.id);
 const [type,id]=[scope.slice(0,scope.indexOf(':')),scope.slice(scope.indexOf(':')+1)];
 if(type==='group'&&guid(id)){
  await requireGroup(v,id,'view');
  return (await db().query<{id:string}>(sql`SELECT s.id FROM servers s WHERE ${active} AND EXISTS (SELECT 1 FROM device_group_members m JOIN device_group_ancestors a ON a.group_id=m.group_id WHERE m.server_id=s.id AND a.ancestor_id=${id})`)).map(row=>row.id);
 }
 if((type==='customer'||type==='unassigned')&&guid(id)){
  if(!(await visibleCustomers(v)).some(customer=>customer.id===id))throw new HttpError('apiError.customer.notFound');
  const loose=type==='unassigned'?sql` AND NOT EXISTS (SELECT 1 FROM device_group_members m WHERE m.server_id=s.id)`:sql``;
  return (await db().query<{id:string}>(sql`SELECT s.id FROM servers s WHERE ${active} AND s.customer_id=${id}${loose}`)).map(row=>row.id);
 }
 throw new HttpError('apiError.software.invalidScope');
}
export const likePattern=(token:string)=>'%'+token.replace(/[\\%_]/g,match=>'\\'+match)+'%';
type FleetRow={name:string;publisher:string|null;version:string|null;normalized_name:string;normalized_version:string|null;device_count:number;device_ids:string;total:number};
const fleetRow=(row:FleetRow):SoftwareFleetRow=>({name:row.name,publisher:row.publisher,version:row.version,normalizedName:row.normalized_name,normalizedVersion:row.normalized_version,deviceCount:Number(row.device_count),deviceIds:String(row.device_ids??'').split(',').filter(Boolean)});
const rowKey=(row:Pick<SoftwareFleetRow,'normalizedName'|'normalizedVersion'>)=>JSON.stringify([row.normalizedName,row.normalizedVersion]);
/** The grouped rows of the devices in the shown order, with an extra filter and an optional row limit. */
function fleetRows(devices:string[],filter:Sql,limit:number|null){
 return db().query<FleetRow>(sql`SELECT mode() WITHIN GROUP (ORDER BY d.name) AS name,mode() WITHIN GROUP (ORDER BY d.publisher) AS publisher,mode() WITHIN GROUP (ORDER BY d.version) AS version,
  d.normalized_name,d.normalized_version,count(DISTINCT d.server_id) AS device_count,string_agg(DISTINCT d.server_id,',' ORDER BY d.server_id) AS device_ids,count(*) OVER () AS total
  FROM device_software d WHERE d.server_id IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(devices)}::jsonb)) AND ${filter}
  GROUP BY d.normalized_name,d.normalized_version ORDER BY count(DISTINCT d.server_id) DESC,lower(mode() WITHIN GROUP (ORDER BY d.name)),d.normalized_name,d.normalized_version NULLS LAST ${limit===null?sql``:sql`LIMIT ${limit}`}`);
}
/**
 * GET /api/software?scope=&q=&vulnerable=: the programs of the visible devices
 * in the scope, grouped by normalized name and version, most devices first, at
 * most 2000 rows. Every search token must be a substring of name, publisher or
 * version. With the vulnerability check on, every row has its verdict; the
 * rows of catalog products are read without the row cap, so vulnerableRows
 * counts all of them and vulnerable=1 keeps only vulnerable rows before the cap.
 */
export async function softwareFleetView(v:Viewer,params:URLSearchParams):Promise<SoftwareFleetView>{
 const devices=await scopeDeviceIds(v,params.get('scope'));
 const context=await vulnerabilityContext(),status=publicStatus(context),vulnerableOnly=context.enabled&&params.get('vulnerable')==='1';
 if(!devices.length)return {rows:[],total:0,truncated:false,vulnerabilities:{...status,vulnerableRows:0}};
 const tokens=softwareSearchTokens(params.get('q'));
 const search=tokens.length?sql.join(tokens.map(token=>{const pattern=likePattern(token);return sql`(d.name ILIKE ${pattern} OR coalesce(d.publisher,'') ILIKE ${pattern} OR coalesce(d.version,'') ILIKE ${pattern})`;}),sql` AND `):sql`TRUE`;
 let verdicts=new Map<string,Verdict>(),catalogRows:SoftwareFleetRow[]=[];
 if(context.enabled){
  catalogRows=(await fleetRows(devices,sql`${search} AND d.normalized_version IS NOT NULL AND ${catalogNameFilter()}`,null)).map(fleetRow);
  const found=await programVerdicts(context,catalogRows);
  verdicts=new Map(catalogRows.map((row,index)=>[rowKey(row),found[index]]));
 }
 const vulnerableRows=[...verdicts.values()].filter(verdict=>verdict.status==='vulnerable').length;
 const vulnerabilities={...status,vulnerableRows};
 if(vulnerableOnly){
  const rows=catalogRows.filter(row=>verdicts.get(rowKey(row))?.status==='vulnerable');
  return {rows:rows.slice(0,maxSoftwareItems).map(row=>({...row,verdict:verdicts.get(rowKey(row))})),total:rows.length,truncated:rows.length>maxSoftwareItems,vulnerabilities};
 }
 const rows=await fleetRows(devices,search,maxSoftwareItems+1);
 const total=rows.length?Number(rows[0].total):0;
 const unchecked=productVerdict(null,null);
 return {
  rows:rows.slice(0,maxSoftwareItems).map(fleetRow).map(row=>context.enabled?{...row,verdict:verdicts.get(rowKey(row))??unchecked}:row),
  total,truncated:total>maxSoftwareItems,vulnerabilities,
 };
}
