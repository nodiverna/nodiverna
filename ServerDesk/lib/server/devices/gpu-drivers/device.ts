// Server side of GPU driver updates (docs/gpu-driver-updates.md): the driver
// status of one device for GET /api/gpu-drivers/device, and the lookup that
// fills in the download of an install-gpu-driver job before the console queues
// it. The route in app/api is a thin adapter; this module owns the SQL.
import {HttpError,guid,now} from '../../context';
import {customerAccessGuard,devicePermissionGuard,guardPasses,principal} from '../../identity/access';
import {db,sql} from '../../db';
import {apiErrorCodes} from '../../../errors/api-error-keys';
import type {ServerSnapshot,Viewer} from '../../../types';
import {compareGpuDriverVersions,effectiveGpuDriverVersion,gpuDriverGroups,gpuDriverStatus,gpuDriverVendorNames,gpuDriverVendors,validGpuDriverVersion,type GpuDriverGroup,type GpuDriverReason,type GpuDriverRecentInstall,type GpuDriverStatus,type GpuDriverVendor} from '../../../gpu-drivers/installed';
import {acceptedGpuDriverDownload,gpuDriverCatalog,gpuOsFamily,type GpuDriverCatalog,type GpuDriverCheck} from './catalog';

/**
 * installed is the effective version (effectiveGpuDriverVersion in
 * installed.ts), reported the version of the snapshot. pendingInventory is set
 * while a recent install is newer than what the device reports.
 */
export type GpuDriverEntry={
 vendor:GpuDriverVendor;gpuIds:string[];gpuNames:string[];installed:string|null;reported:string|null;pendingInventory:GpuDriverRecentInstall|null;
 latest:{version:string;releasedAt:string|null}|null;status:GpuDriverStatus;reason:GpuDriverReason|null;checkedAt:number;
};
export type GpuDriverNotice={code:string;messageKey:'apiError.gpuDriver.checkTooSoon'|'apiError.gpuDriver.checkBusy'};
export type GpuDriverView={entries:GpuDriverEntry[];notice?:GpuDriverNotice};

type SnapshotLike=Pick<ServerSnapshot,'os'>&Partial<Pick<ServerSnapshot,'gpus'|'gpuDetails'|'osInfo'>>|null;
const parseSnapshot=(raw:unknown):SnapshotLike=>{if(typeof raw!=='string'||!raw)return null;try{const value=JSON.parse(raw) as unknown;return value&&typeof value==='object'?value as SnapshotLike:null;}catch{return null;}};

/**
 * The vendor's lookup: the first GPU with a result wins, else the first GPU's
 * failure. Marked limited when any of the GPU lookups was limited.
 */
async function vendorCheck(group:GpuDriverGroup,snapshot:SnapshotLike,catalog:GpuDriverCatalog,force:boolean):Promise<GpuDriverCheck>{
 const osFamily=gpuOsFamily(snapshot);let first:GpuDriverCheck|null=null,limited=false;
 for(const gpu of group.gpus){
  const check=await catalog.lookup({vendor:group.vendor,name:gpu.name,deviceId:gpu.deviceId,osFamily},{force});
  limited||=check.limited===true;
  if(check.result.ok){first=check;break;}
  first??=check;
 }
 return limited?{...first!,limited:true}:first!;
}

/** A recent install counts for 24 hours after its job finished. */
export const recentGpuDriverInstallMs=86_400_000;
const recentVersion=(raw:unknown):string|null=>{
 if(typeof raw!=='string')return null;
 try{const args=JSON.parse(raw) as unknown,version=args&&typeof args==='object'?(args as {version?:unknown}).version:null;return validGpuDriverVersion(version)?version:null;}catch{return null;}
};
/**
 * The recent install of each vendor on a device: the newest succeeded
 * install-gpu-driver job whose target names the vendor, whose result code says
 * installed and whose result_args.version is a valid version. Its finish time
 * is last_progress, else claimed_at, else created_at; it counts only while
 * that is within the last 24 hours.
 */
export async function recentGpuDriverInstalls(serverId:string,at:number=now()):Promise<Partial<Record<GpuDriverVendor,GpuDriverRecentInstall>>>{
 const rows=await db().query<{target:string;result_args:string|null;finished:number|string}>(sql`SELECT target,result_args,COALESCE(last_progress,claimed_at,created_at) AS finished FROM jobs WHERE server_id=${serverId} AND action='install-gpu-driver' AND state='succeeded' AND result_code IN ('AGENT_GPU_DRIVER_INSTALLED','AGENT_GPU_DRIVER_INSTALLED_REBOOT') AND COALESCE(last_progress,claimed_at,created_at)>${at-recentGpuDriverInstallMs} ORDER BY finished DESC,created_at DESC LIMIT 50`);
 const recent:Partial<Record<GpuDriverVendor,GpuDriverRecentInstall>>={};
 for(const row of rows){
  const vendor=gpuDriverVendors.find(item=>row.target.startsWith(gpuDriverVendorNames[item]+' ')),version=recentVersion(row.result_args);
  if(vendor&&version&&!recent[vendor])recent[vendor]={version,finishedAt:Number(row.finished)};
 }
 return recent;
}
/** Whether an install-gpu-driver job of the device waits or runs, whatever the vendor. */
export async function gpuDriverJobActive(serverId:string):Promise<boolean>{
 return Boolean(await db().one(sql`SELECT 1 AS active FROM jobs WHERE server_id=${serverId} AND action='install-gpu-driver' AND state IN ('pending','running') LIMIT 1`));
}
/** The condition of the job INSERT that admits a GPU driver job only while no other one waits or runs on the device. */
export const noActiveGpuDriverJob=(serverId:string)=>sql`NOT EXISTS (SELECT 1 FROM jobs WHERE server_id=${serverId} AND action='install-gpu-driver' AND state IN ('pending','running'))`;

function entryOf(group:GpuDriverGroup,check:GpuDriverCheck,recent:GpuDriverRecentInstall|undefined):GpuDriverEntry{
 const {result}=check,{installed,pending}=effectiveGpuDriverVersion(group.installed,recent),{status,reason}=gpuDriverStatus(installed,result);
 return {vendor:group.vendor,gpuIds:group.gpus.map(gpu=>gpu.id),gpuNames:group.gpus.map(gpu=>gpu.name),installed,reported:group.installed,pendingInventory:pending,
  latest:result.ok?{version:result.version,releasedAt:result.releasedAt}:null,status,reason,checkedAt:check.checkedAt};
}

/**
 * GET /api/gpu-drivers/device?serverId=&refresh=1: one entry per vendor on the
 * device. Needs the device right view inside the customer boundary (404
 * outside). A revoked device or one without NVIDIA or AMD GPUs gives no
 * entries. refresh skips the cache at most once every 5 minutes per device; a
 * refused refresh answers the cached state with the notice checkTooSoon. When
 * a vendor's budget of forced lookups was used up, the allowed refresh answers
 * with the notice checkBusy. The answer never contains a download URL. A
 * recent install that the device has not reported yet counts as installed
 * (recentGpuDriverInstalls, pendingInventory).
 */
export async function gpuDriverDeviceView(v:Viewer,serverId:unknown,refresh:boolean,catalog:GpuDriverCatalog=gpuDriverCatalog):Promise<GpuDriverView>{
 if(!guid(serverId))throw new HttpError('apiError.device.invalid');
 const row=await db().one<{revoked:number;snapshot:string|null}>(sql`SELECT revoked,snapshot FROM servers WHERE id=${serverId} AND ${customerAccessGuard(sql`servers.customer_id`,sql`${principal(v)}`)}`);
 if(!row)throw new HttpError('apiError.device.notFound');
 // The view right first, also for a revoked device, so its state is never shown to a viewer without the right.
 if(!await guardPasses(devicePermissionGuard(sql`${serverId}`,sql`${principal(v)}`,'view',{includeRevoked:true})))throw new HttpError('apiError.access.devicePermissionMissing',{permission:'view'});
 // A revoked device has no GPUs to update.
 if(Number(row.revoked)!==0)return {entries:[]};
 const snapshot=parseSnapshot(row.snapshot),groups=gpuDriverGroups(snapshot);
 if(!groups.length)return {entries:[]};
 const force=refresh&&catalog.claimRefresh(serverId);
 const [checks,recent]=await Promise.all([Promise.all(groups.map(group=>vendorCheck(group,snapshot,catalog,force))),recentGpuDriverInstalls(serverId)]);
 const entries=groups.map((group,index)=>entryOf(group,checks[index],recent[group.vendor]));
 if(refresh&&!force)return {entries,notice:{code:apiErrorCodes['apiError.gpuDriver.checkTooSoon'],messageKey:'apiError.gpuDriver.checkTooSoon'}};
 if(checks.some(check=>check.limited))return {entries,notice:{code:apiErrorCodes['apiError.gpuDriver.checkBusy'],messageKey:'apiError.gpuDriver.checkBusy'}};
 return {entries};
}

/**
 * The stored parameters of an install-gpu-driver job: vendor and version from
 * the request, URL and size only from the current lookup on the server. A
 * driver job that waits or runs on the device refuses any second one
 * (jobActive), before the lookup. A failed lookup is refused with the reason
 * the GET shows: unsupportedOs, unsupportedModel or lookupFailed. A recent
 * install that the device has not reported yet refuses the same or an older
 * version (alreadyInstalled); otherwise the effective installed version must
 * be older than the latest (noUpdate).
 */
export async function resolveGpuDriverJob(serverId:string,snapshot:SnapshotLike,params:{vendor:GpuDriverVendor;version:string},catalog:GpuDriverCatalog=gpuDriverCatalog):Promise<{vendor:GpuDriverVendor;version:string;url:string;sizeBytes:number}>{
 if(await gpuDriverJobActive(serverId))throw new HttpError('apiError.gpuDriver.jobActive');
 const vendor=gpuDriverVendorNames[params.vendor],group=gpuDriverGroups(snapshot).find(item=>item.vendor===params.vendor);
 if(!group)throw new HttpError('apiError.gpuDriver.noGpu',{vendor});
 const check=await vendorCheck(group,snapshot,catalog,false),{result}=check;
 if(!result.ok&&result.reason==='unsupported-os')throw new HttpError('apiError.gpuDriver.unsupportedOs',{vendor});
 if(!result.ok&&result.reason==='unsupported-model')throw new HttpError('apiError.gpuDriver.unsupportedModel');
 if(!result.ok||!acceptedGpuDriverDownload(params.vendor,result.downloadUrl))throw new HttpError('apiError.gpuDriver.lookupFailed',{vendor});
 const {installed,pending}=effectiveGpuDriverVersion(group.installed,(await recentGpuDriverInstalls(serverId))[params.vendor]);
 if(pending&&compareGpuDriverVersions(result.version,pending.version)<=0&&compareGpuDriverVersions(params.version,pending.version)<=0)throw new HttpError('apiError.gpuDriver.alreadyInstalled',{vendor,version:pending.version});
 if(gpuDriverStatus(installed,result).status!=='outdated')throw new HttpError('apiError.gpuDriver.noUpdate');
 if(params.version!==result.version)throw new HttpError('apiError.gpuDriver.versionChanged');
 return {vendor:params.vendor,version:result.version,url:result.downloadUrl,sizeBytes:result.sizeBytes};
}
