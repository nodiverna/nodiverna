// The installed graphics driver of a device and its status against the vendor's
// latest driver (docs/gpu-driver-updates.md). Pure: no database, no network, no
// server bindings, so the GPU view, the API and the tests share it.

/** The vendors with driver updates. Intel has none. */
export const gpuDriverVendors=['nvidia','amd'] as const;
export type GpuDriverVendor=typeof gpuDriverVendors[number];
export const gpuDriverVendorNames:Record<GpuDriverVendor,string>={nvidia:'NVIDIA',amd:'AMD'};
export const isGpuDriverVendor=(value:unknown):value is GpuDriverVendor=>value==='nvidia'||value==='amd';

/** A vendor driver version: one to four numeric segments (581.57, 25.10.1). Also the job parameter rule. */
export const gpuDriverVersionPattern=/^\d{1,4}(\.\d{1,5}){1,3}$/;
export const validGpuDriverVersion=(value:unknown):value is string=>typeof value==='string'&&gpuDriverVersionPattern.test(value);

/**
 * The NVIDIA version of a Windows driver version: the last five digits of the
 * last two fields, as three and two digits (32.0.15.8157 → 581.57). Null for
 * any other form.
 */
export function nvidiaVersionFromWindows(value:unknown):string|null{
 if(typeof value!=='string')return null;
 const fields=value.trim().split('.');
 if(fields.length!==4||!fields.every(field=>/^\d{1,5}$/.test(field))||fields[3].length>4)return null;
 const digits=(fields[2]+fields[3].padStart(4,'0')).slice(-5);
 if(digits.length!==5||digits.startsWith('0'))return null;
 return digits.slice(0,3)+'.'+digits.slice(3);
}

/** Compares two versions numerically, segment by segment; a missing segment counts as 0. */
export function compareGpuDriverVersions(a:string,b:string):number{
 const left=a.split('.').map(Number),right=b.split('.').map(Number);
 for(let index=0;index<Math.max(left.length,right.length);index++){
  const difference=(left[index]??0)-(right[index]??0);
  if(difference)return difference<0?-1:1;
 }
 return 0;
}

/** The fields of one gpuDetails row that this module reads. */
export type GpuDriverDetails={driverVersion?:unknown;vendorDriverVersion?:unknown};
/**
 * The installed vendor version of one GPU. NVIDIA: the newer of
 * vendorDriverVersion (NVML) and the version derived from the Windows driver
 * version, else the one that is valid; NVML can lag behind after a driver
 * update without a restart, never run ahead. AMD: only vendorDriverVersion
 * (the AMD Software version from agent 4.13.0). Null when no value can be read.
 */
export function installedGpuDriverVersion(vendor:GpuDriverVendor,details:GpuDriverDetails|null|undefined):string|null{
 const raw=typeof details?.vendorDriverVersion==='string'?details.vendorDriverVersion.trim():null,reported=validGpuDriverVersion(raw)?raw:null;
 if(vendor!=='nvidia')return reported;
 const windows=nvidiaVersionFromWindows(details?.driverVersion);
 if(reported===null||windows===null)return reported??windows;
 return compareGpuDriverVersions(windows,reported)>0?windows:reported;
}

/** The oldest of the known versions; null when none is known. */
export function oldestGpuDriverVersion(versions:readonly (string|null)[]):string|null{
 const known=versions.filter((version):version is string=>version!==null);
 return known.length?known.reduce((oldest,version)=>compareGpuDriverVersions(version,oldest)<0?version:oldest):null;
}

export type GpuDriverGpu={id:string;name:string;deviceId:number|null;installed:string|null};
export type GpuDriverGroup={vendor:GpuDriverVendor;gpus:GpuDriverGpu[];installed:string|null};
type SnapshotLike={gpus?:unknown;gpuDetails?:unknown}|null|undefined;
const record=(value:unknown):Record<string,unknown>|null=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
/**
 * The NVIDIA and AMD GPUs of a snapshot, grouped by vendor in the order of the
 * first GPU of each vendor. The group's installed version is the oldest known
 * version among its GPUs: one vendor package updates all of them.
 */
export function gpuDriverGroups(snapshot:SnapshotLike):GpuDriverGroup[]{
 const gpus=Array.isArray(snapshot?.gpus)?snapshot.gpus.slice(0,16):[],details=Array.isArray(snapshot?.gpuDetails)?snapshot.gpuDetails.slice(0,16):[];
 const groups=new Map<GpuDriverVendor,GpuDriverGpu[]>(),seen=new Set<string>();
 for(const candidate of gpus){
  const gpu=record(candidate);if(!gpu)continue;
  const {id,name,vendor}=gpu;
  if(typeof id!=='string'||!id.trim()||typeof name!=='string'||!name.trim()||!isGpuDriverVendor(vendor)||seen.has(id))continue;
  seen.add(id);
  const row=record(details.find(item=>record(item)?.id===id)),deviceId=row?.deviceId;
  const list=groups.get(vendor)??[];
  list.push({id,name:name.trim(),deviceId:typeof deviceId==='number'&&Number.isInteger(deviceId)&&deviceId>=0&&deviceId<=65535?deviceId:null,installed:installedGpuDriverVersion(vendor,row as GpuDriverDetails|null)});
  groups.set(vendor,list);
 }
 return [...groups].map(([vendor,list])=>({vendor,gpus:list,installed:oldestGpuDriverVersion(list.map(gpu=>gpu.installed))}));
}

/** A successful install-gpu-driver job of the last 24 hours (lib/server/devices/gpu-drivers/device.ts): its version and finish time. */
export type GpuDriverRecentInstall={version:string;finishedAt:number};
/**
 * The effective installed version of a vendor group: while a recent install
 * exists and the device reports no version or an older one, the recent
 * install's version, pending until the inventory reports it. Otherwise the
 * reported version, and nothing is pending.
 */
export function effectiveGpuDriverVersion(reported:string|null,recent:GpuDriverRecentInstall|null|undefined):{installed:string|null;pending:GpuDriverRecentInstall|null}{
 if(recent&&(reported===null||compareGpuDriverVersions(reported,recent.version)<0))return {installed:recent.version,pending:{version:recent.version,finishedAt:recent.finishedAt}};
 return {installed:reported,pending:null};
}

export type GpuDriverStatus='current'|'outdated'|'unknown'|'unsupported';
export type GpuDriverReason='installed-unknown'|'lookup-failed'|'unsupported-model'|'unsupported-os';
/** A lookup result without the download data. */
export type GpuDriverLatest={ok:true;version:string;releasedAt:string|null}|{ok:false;reason:'lookup-failed'|'unsupported-model'|'unsupported-os'};
/**
 * The status rules: no installed version → unknown (installed-unknown); a
 * failed lookup → unknown (lookup-failed); an unsupported model or OS →
 * unsupported with its reason; installed < latest → outdated; else current
 * (a newer installed version counts as current).
 */
export function gpuDriverStatus(installed:string|null,latest:GpuDriverLatest):{status:GpuDriverStatus;reason:GpuDriverReason|null}{
 if(installed===null)return {status:'unknown',reason:'installed-unknown'};
 if(!latest.ok)return latest.reason==='lookup-failed'?{status:'unknown',reason:'lookup-failed'}:{status:'unsupported',reason:latest.reason};
 return {status:compareGpuDriverVersions(installed,latest.version)<0?'outdated':'current',reason:null};
}

/**
 * The 1-based position of the first NVIDIA or AMD GPU in the GPU list of the
 * Hardware area (the filter of deviceOverviewGpus: valid id and name, Intel
 * only for Arc, no duplicates, at most 16), or 0 when there is none.
 */
export function gpuDriverPosition(snapshot:SnapshotLike):number{
 const gpus=Array.isArray(snapshot?.gpus)?snapshot.gpus.slice(0,16):[],seen=new Set<string>();let position=0;
 for(const candidate of gpus){
  const gpu=record(candidate);if(!gpu)continue;
  const {id,name,vendor}=gpu;
  if(typeof id!=='string'||!id.trim()||typeof name!=='string'||!name.trim()||vendor!=='nvidia'&&vendor!=='amd'&&vendor!=='intel'||seen.has(id)||vendor==='intel'&&!/\barc\b/i.test(name))continue;
  seen.add(id);position++;
  if(isGpuDriverVendor(vendor))return position;
 }
 return 0;
}
