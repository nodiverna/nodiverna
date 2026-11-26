// The "Graphics driver" card of Hardware → GPU (ui/devices/hardware/device-gpu-driver.tsx):
// blocked reasons, the confirmation, the job state and the sample data. Pure,
// so tests/ui/devices/gpu-driver-view.mjs runs it without a render.
import type {Job,Server,Viewer} from '@/lib/types';
import {deviceConnection} from '@/ui/base/ui-device';
import {isOwner} from '@/ui/base/access-capabilities';
import {translate,type MessageKey} from '@/lib/i18n/translate';
import {defaultLocale,type Locale} from '@/lib/i18n/locale';
import {gpuDriverGroups,gpuDriverStatus,gpuDriverVendorNames,type GpuDriverReason,type GpuDriverStatus,type GpuDriverVendor} from '@/lib/gpu-drivers/installed';
import type {GpuDriverEntry,GpuDriverView} from '@/lib/server/devices/gpu-drivers/device';
import {EMPTY_VALUE} from '@/lib/i18n/format';

export const GPU_DRIVER_KIND='install-gpu-driver';
export type GpuDriverContext={server:Server;viewer:Viewer;demo:boolean;now:number;jobs:Job[]};

/** The GPU driver jobs of the device, newest first. */
export const gpuDriverJobs=(context:Pick<GpuDriverContext,'server'|'jobs'>)=>context.jobs.filter(job=>job.serverId===context.server.id&&job.action===GPU_DRIVER_KIND).sort((a,b)=>b.createdAt-a.createdAt);
/** A GPU driver job of the device that waits or runs, whatever the vendor. */
export const activeGpuDriverJob=(context:Pick<GpuDriverContext,'server'|'jobs'>)=>gpuDriverJobs(context).find(job=>job.state==='pending'||job.state==='running');
/** The newest finished GPU driver job of the device. */
export const finishedGpuDriverJob=(context:Pick<GpuDriverContext,'server'|'jobs'>)=>gpuDriverJobs(context).find(job=>job.state!=='pending'&&job.state!=='running');

/**
 * Why "Update driver" is blocked, in this order: sample device, removed device,
 * missing manage, offline, agent without the capability, not in Management
 * mode, a GPU driver job pending or running, status not outdated. '' = allowed.
 */
export function gpuDriverActionReason(context:GpuDriverContext,entry:Pick<GpuDriverEntry,'status'>|null,locale:Locale=defaultLocale):string{
 const {server,viewer,demo,now}=context,snapshot=server.snapshot;
 if(demo)return translate(locale,'network.blocked.demo');
 if(server.revoked)return translate(locale,'services.blocked.removed');
 if(!(isOwner(viewer)||server.permissions?.includes('manage')))return translate(locale,'services.blocked.manage');
 if(deviceConnection(server,now).kind!=='online')return translate(locale,'network.blocked.offline');
 if(!snapshot?.agentCapabilities?.includes(GPU_DRIVER_KIND))return translate(locale,'hardware.gpuDriver.blocked.agent');
 if(server.management!==1||snapshot.mode!=='Management')return translate(locale,'updates.blocked.management');
 if(activeGpuDriverJob(context))return translate(locale,'hardware.gpuDriver.blocked.active');
 if(entry?.status!=='outdated')return translate(locale,'hardware.gpuDriver.blocked.current');
 return '';
}

/** "Update driver" is shown for these states; unknown and unsupported have nothing to update. */
export const gpuDriverUpdateVisible=(status:GpuDriverStatus)=>status==='outdated'||status==='current';

/** The shared confirmation of the update, or null while it is blocked. */
export function gpuDriverConfirmation(context:GpuDriverContext,entry:GpuDriverEntry,locale:Locale=defaultLocale){
 if(gpuDriverActionReason(context,entry,locale)||!entry.latest)return null;
 const vendor=gpuDriverVendorNames[entry.vendor];
 const lines=[translate(locale,'hardware.gpuDriver.confirm.device',{name:context.server.name}),translate(locale,'hardware.gpuDriver.confirm.version',{from:entry.installed??EMPTY_VALUE,to:entry.latest.version}),'',translate(locale,'hardware.gpuDriver.confirm.warning')];
 return {title:translate(locale,'hardware.gpuDriver.confirm.title',{vendor}),description:lines.join('\n'),confirmLabel:translate(locale,'hardware.gpuDriver.update'),payload:{action:'job',id:context.server.id,kind:GPU_DRIVER_KIND,params:{vendor:entry.vendor,version:entry.latest.version},confirm:true}};
}

const reasonKeys:Record<GpuDriverReason,MessageKey>={'installed-unknown':'hardware.gpuDriver.reason.installedUnknown','lookup-failed':'hardware.gpuDriver.reason.lookupFailed','unsupported-model':'hardware.gpuDriver.reason.unsupportedModel','unsupported-os':'hardware.gpuDriver.reason.unsupportedOs'};
const statusKeys:Record<GpuDriverStatus,MessageKey>={current:'hardware.gpuDriver.status.current',outdated:'hardware.gpuDriver.status.outdated',unknown:'hardware.gpuDriver.status.unknown',unsupported:'hardware.gpuDriver.status.unsupported'};
export const gpuDriverStatusText=(status:GpuDriverStatus,locale:Locale=defaultLocale)=>translate(locale,statusKeys[status]);
/**
 * The sentence under the versions: the reason of unknown and unsupported, then
 * the pending sentence while the device has not reported a recent install,
 * else the current or outdated sentence.
 */
export function gpuDriverSentence(entry:Pick<GpuDriverEntry,'vendor'|'status'|'reason'>&Partial<Pick<GpuDriverEntry,'pendingInventory'>>,locale:Locale=defaultLocale):string{
 const vendor=gpuDriverVendorNames[entry.vendor];
 if(entry.reason)return translate(locale,reasonKeys[entry.reason],{vendor});
 if(entry.pendingInventory)return translate(locale,'hardware.gpuDriver.pending.sentence',{vendor,version:entry.pendingInventory.version});
 return translate(locale,entry.status==='outdated'?'hardware.gpuDriver.sentence.outdated':'hardware.gpuDriver.sentence.current',{vendor});
}
/** The meta line of the pending row: the version the device still reports, or null. */
export const gpuDriverPendingReported=(entry:Pick<GpuDriverEntry,'reported'|'pendingInventory'>,locale:Locale=defaultLocale)=>entry.pendingInventory&&entry.reported!==null?translate(locale,'hardware.gpuDriver.pending.reported',{version:entry.reported}):null;
/** Refusals of the update after which the card loads its status again: the server knows more than the card showed. */
export const gpuDriverReloadCodes:readonly string[]=['GPU_DRIVER_ALREADY_INSTALLED','GPU_DRIVER_JOB_ACTIVE','GPU_DRIVER_VERSION_CHANGED'];
/** The note for several GPUs of one vendor: one package updates all of them. */
export const gpuDriverMultiGpu=(entry:Pick<GpuDriverEntry,'vendor'|'gpuIds'>,locale:Locale=defaultLocale)=>entry.gpuIds.length>1?translate(locale,'hardware.gpuDriver.multiGpu',{vendor:gpuDriverVendorNames[entry.vendor]}):null;

/** The vendor of the selected GPU when it has driver updates. */
export const gpuDriverVendorOf=(vendor:string):GpuDriverVendor|null=>vendor==='nvidia'||vendor==='amd'?vendor:null;

/** The fixed latest NVIDIA driver of the sample devices. */
export const demoGpuDriverLatest={version:'581.80',releasedAt:'2026-10-21'};
/** Sample devices: fixed data, no request to the vendor or the API. NVIDIA is outdated; another vendor is unsupported. */
export function demoGpuDriverView(server:Pick<Server,'snapshot'>,now:number):GpuDriverView{
 return {entries:gpuDriverGroups(server.snapshot).map(group=>{
  const latest=group.vendor==='nvidia'?{ok:true as const,...demoGpuDriverLatest}:{ok:false as const,reason:'unsupported-model' as const};
  const {status,reason}=gpuDriverStatus(group.installed,latest);
  return {vendor:group.vendor,gpuIds:group.gpus.map(gpu=>gpu.id),gpuNames:group.gpus.map(gpu=>gpu.name),installed:group.installed,reported:group.installed,pendingInventory:null,latest:latest.ok?{version:latest.version,releasedAt:latest.releasedAt}:null,status,reason,checkedAt:now-12*60_000};
 })};
}
