// What the widgets of the Dashboard count and list (ui/devices/dashboard/dashboard-widgets.tsx, docs/dashboard.md), beyond
// the first five of dashboard-model.ts. Every model reads only what the console already carries (the devices with their
// snapshots as the server scoped them, the jobs, the audit entries, the pinned devices, the customers), counts no
// revoked device, and returns its whole sorted list: the widget shows as many rows as its size holds. Pure: no React,
// no fetch, no text; the views format and translate.
import {compareAgentVersions} from '@/lib/agent-update-state';
import {protectionStatus,protectionStatusRank,type ProtectionStatus} from '@/lib/defender';
import {connectionKind} from '@/lib/device-connection';
import {jobCounts} from '@/lib/job-display';
import type {AuditEntry,AutostartSummary,CertificateEntry,Disk,Job,OsSupport} from '@/lib/types';
import {listHealth,problemRows,type HealthState,type ProblemRow} from '@/ui/base/health-score';
import {bitlockerStatus,deviceDiskHealth,diskHealthRank,encryptionStatusRank,fleetCertificateRows,osSupportStatusRank,recentCrashes,type BitLockerStatus,type CertificateStatus,type DiskHealthStatus} from '@/ui/devices/inventory/health-signals';
import {byDeviceName,dashboardDevices,type DashboardDevice,type WeekGrid} from '@/ui/devices/dashboard/dashboard-model';

/** The tone of one part of a breakdown: a state (ok, warning, critical), no state (neutral) or a plain share (data). */
export type BreakdownTone='ok'|'warning'|'critical'|'neutral'|'data';
/** One part of a breakdown bar: its id (the view names it), how many it holds and its tone. Parts with 0 stay in the list; the view leaves them out. */
export type BreakdownPart<K extends string=string>={id:K;count:number;tone:BreakdownTone};
const part=<K extends string>(id:K,count:number,tone:BreakdownTone):BreakdownPart<K>=>({id,count,tone});
const dayMs=86_400_000;

// ---- Monitoring ----------------------------------------------------------------------

export type AlarmTrend={today:number;total:number;max:number;days:{at:number;count:number}[]};
/** Alarms per day: the seven local days of the heatmap grid, the oldest first; today is the last. */
export function alarmTrend(grid:WeekGrid):AlarmTrend{
 const days=grid.days.map(day=>({at:day.at,count:day.cells.reduce((sum,cell)=>sum+cell.count,0)}));
 return {today:days.at(-1)?.count??0,total:grid.total,max:Math.max(0,...days.map(day=>day.count)),days};
}

export type HealthWidget<D extends DashboardDevice>={count:number;critical:number;parts:BreakdownPart<HealthState>[];rows:ProblemRow<D>[]};
/** Device health: the devices with a warning or critical alarm, worst first (the Problems worklist), and every device by its health level. */
export function healthWidget<D extends DashboardDevice>(servers:readonly D[]):HealthWidget<D>{
 const devices=dashboardDevices(servers),rows=problemRows(devices),counts:Record<HealthState,number>={critical:0,warning:0,good:0,unknown:0};
 for(const device of devices)counts[listHealth(device).state]++;
 return {count:rows.length,critical:counts.critical,rows,parts:[part('critical',counts.critical,'critical'),part('warning',counts.warning,'warning'),part('good',counts.good,'ok'),part('unknown',counts.unknown,'neutral')]};
}

// ---- Devices -------------------------------------------------------------------------

export type ConnectionPart='online'|'offline'|'maintenance'|'waiting';
export type StatusWidget={online:number;devices:number;parts:BreakdownPart<ConnectionPart>[]};
/** Device status: every device by its connection (connectionKind). */
export function statusWidget(servers:readonly DashboardDevice[],now:number):StatusWidget{
 const devices=dashboardDevices(servers),counts:Record<ConnectionPart,number>={online:0,offline:0,maintenance:0,waiting:0};
 for(const device of devices)counts[connectionKind(device,now)]++;
 return {online:counts.online,devices:devices.length,parts:[part('online',counts.online,'ok'),part('offline',counts.offline,'warning'),part('maintenance',counts.maintenance,'data'),part('waiting',counts.waiting,'neutral')]};
}

/** Pinned devices: the account's pins in pin order; a pin whose device is gone or revoked is left out. */
export function pinnedWidget<D extends DashboardDevice>(servers:readonly D[],pinnedIds:readonly string[]):{count:number;rows:D[]}{
 const byId=new Map(dashboardDevices(servers).map(device=>[device.id,device]));
 const rows=pinnedIds.flatMap(id=>{const device=byId.get(id);return device?[device]:[];});
 return {count:rows.length,rows};
}

export type CustomerRow={id:string;name:string;devices:number;alarms:number;critical:number;offline:number};
/** Customers: one row per visible customer with its devices, open alarms and offline devices; the customer with the most open alarms first. */
export function customersWidget(servers:readonly DashboardDevice[],customers:readonly {id:string;name:string}[],now:number):{count:number;rows:CustomerRow[]}{
 const rows=new Map<string,CustomerRow>(customers.map(customer=>[customer.id,{id:customer.id,name:customer.name,devices:0,alarms:0,critical:0,offline:0}]));
 for(const device of dashboardDevices(servers)){
  const row=device.customerId?rows.get(device.customerId):undefined;
  if(!row)continue;
  row.devices++;
  if(connectionKind(device,now)==='offline')row.offline++;
  for(const alert of device.alerts??[]){row.alarms++;if(alert.level==='critical')row.critical++;}
 }
 return {count:rows.size,rows:[...rows.values()].sort((a,b)=>b.alarms-a.alarms||b.offline-a.offline||byDeviceName(a,b))};
}

/** The load from which a device counts as under high load, as the critical level of the kit Meter. */
export const highLoadPercent=90;
const live=(value:unknown):number|null=>typeof value==='number'&&Number.isFinite(value)?Math.max(0,Math.min(100,value)):null;
export type LoadRow<D extends DashboardDevice>={device:D;cpu:number|null;memory:number|null;peak:number};
/** Highest load: the online devices that report CPU or memory, the higher of both first. count: those at 90 % or more. */
export function loadWidget<D extends DashboardDevice>(servers:readonly D[],now:number):{count:number;online:number;rows:LoadRow<D>[]}{
 const rows=dashboardDevices(servers).filter(device=>connectionKind(device,now)==='online').flatMap(device=>{
  const cpu=live(device.snapshot?.cpu),memory=live(device.snapshot?.memory);
  return cpu===null&&memory===null?[]:[{device,cpu,memory,peak:Math.max(cpu??0,memory??0)}];
 }).sort((a,b)=>b.peak-a.peak||byDeviceName(a.device,b.device));
 return {count:rows.filter(row=>row.peak>=highLoadPercent).length,online:rows.length,rows};
}

/** The used share from which a volume counts as nearly full, as the critical level of the kit Meter. */
export const fullDiskPercent=90;
export type DiskRow<D extends DashboardDevice>={device:D;disk:Disk;used:number};
/** Disk space: every volume with a size, the fullest first. count: the volumes at 90 % or more used, on `devices` devices. */
export function diskSpaceWidget<D extends DashboardDevice>(servers:readonly D[]):{count:number;devices:number;rows:DiskRow<D>[]}{
 const rows=dashboardDevices(servers).flatMap(device=>(device.snapshot?.disks??[]).filter(disk=>disk.totalGb>0&&Number.isFinite(disk.freeGb))
  .map(disk=>({device,disk,used:Math.max(0,Math.min(100,100-disk.freeGb/disk.totalGb*100))})))
  .sort((a,b)=>b.used-a.used||byDeviceName(a.device,b.device)||a.disk.name.localeCompare(b.disk.name));
 const full=rows.filter(row=>row.used>=fullDiskPercent);
 return {count:full.length,devices:new Set(full.map(row=>row.device.id)).size,rows};
}

// ---- Updates and lifecycle -----------------------------------------------------------

/** Restart required: the devices that report a pending restart, by name, each with its first reason (null without one). */
export function restartWidget<D extends DashboardDevice>(servers:readonly D[]):{count:number;rows:{device:D;reason:string|null}[]}{
 const rows=dashboardDevices(servers).filter(device=>device.snapshot?.rebootPending===true).map(device=>({device,reason:device.snapshot?.rebootReasons?.[0]??null})).sort((a,b)=>byDeviceName(a.device,b.device));
 return {count:rows.length,rows};
}

type SupportStatus=OsSupport['status'];
const supportEnd=(support:OsSupport)=>support.effectiveEnd??support.entry?.securityEnd??'';
export type OsSupportWidget<D extends DashboardDevice>={count:number;ended:number;parts:BreakdownPart<SupportStatus>[];rows:{device:D;support:OsSupport}[]};
/** Operating system support: the devices whose support ended or ends soon, ended first, then the earlier date; and every device by its status. */
export function osSupportWidget<D extends DashboardDevice>(servers:readonly D[]):OsSupportWidget<D>{
 const devices=dashboardDevices(servers),counts:Record<SupportStatus,number>={ended:0,ending:0,supported:0,unknown:0};
 for(const device of devices)counts[device.osSupport?.status??'unknown']++;
 const rows=devices.flatMap(device=>device.osSupport&&(device.osSupport.status==='ended'||device.osSupport.status==='ending')?[{device,support:device.osSupport}]:[])
  .sort((a,b)=>osSupportStatusRank[a.support.status]-osSupportStatusRank[b.support.status]||supportEnd(a.support).localeCompare(supportEnd(b.support))||byDeviceName(a.device,b.device));
 return {count:rows.length,ended:counts.ended,rows,parts:[part('ended',counts.ended,'critical'),part('ending',counts.ending,'warning'),part('supported',counts.supported,'ok'),part('unknown',counts.unknown,'neutral')]};
}

export type AgentsWidget={count:number;devices:number;newest:string|null;parts:BreakdownPart<'newest'|'older'>[];rows:{version:string;count:number}[]};
/** Agent versions: the versions the devices report, the newest first. count: the devices that do not run the newest reported version. */
export function agentsWidget(servers:readonly DashboardDevice[]):AgentsWidget{
 const counts=new Map<string,number>();
 for(const device of dashboardDevices(servers)){const version=device.snapshot?.agentVersion;if(typeof version==='string'&&version)counts.set(version,(counts.get(version)??0)+1);}
 const rows=[...counts].map(([version,count])=>({version,count})).sort((a,b)=>(compareAgentVersions(b.version,a.version)??0)||b.version.localeCompare(a.version,'en',{numeric:true}));
 const devices=rows.reduce((sum,row)=>sum+row.count,0),newest=rows[0]??null,older=devices-(newest?.count??0);
 return {count:older,devices,newest:newest?.version??null,rows,parts:[part('newest',newest?.count??0,'data'),part('older',older,'neutral')]};
}

// ---- Security ------------------------------------------------------------------------

export type DefenderPart='threat'|'off'|'scan-old'|'protected'|'other';
const defenderAttention:readonly ProtectionStatus[]=['threat','off','scan-old'];
export type DefenderWidget<D extends DashboardDevice>={count:number;urgent:number;parts:BreakdownPart<DefenderPart>[];rows:{device:D;status:ProtectionStatus}[]};
/** Microsoft Defender: the devices with an active threat, protection off or a scan that is too old, worst first; and every device by its status. */
export function defenderWidget<D extends DashboardDevice>(servers:readonly D[]):DefenderWidget<D>{
 const counts:Record<DefenderPart,number>={threat:0,off:0,'scan-old':0,protected:0,other:0},rows:{device:D;status:ProtectionStatus}[]=[];
 for(const device of dashboardDevices(servers)){
  const status=protectionStatus(device);
  counts[status==='threat'||status==='off'||status==='scan-old'||status==='protected'?status:'other']++;
  if(defenderAttention.includes(status))rows.push({device,status});
 }
 rows.sort((a,b)=>protectionStatusRank[a.status]-protectionStatusRank[b.status]||byDeviceName(a.device,b.device));
 return {count:rows.length,urgent:counts.threat+counts.off,rows,parts:[part('threat',counts.threat,'critical'),part('off',counts.off,'critical'),part('scan-old',counts['scan-old'],'warning'),part('protected',counts.protected,'ok'),part('other',counts.other,'neutral')]};
}

export type EncryptionPart='encrypted'|'encrypting'|'not-encrypted'|'suspended'|'none';
export type EncryptionWidget<D extends DashboardDevice>={count:number;parts:BreakdownPart<EncryptionPart>[];rows:{device:D;status:BitLockerStatus}[]};
/** Drive encryption: the devices whose system drive is not encrypted or whose protection is suspended; and every device by its BitLocker status. */
export function encryptionWidget<D extends DashboardDevice>(servers:readonly D[]):EncryptionWidget<D>{
 const counts:Record<EncryptionPart,number>={encrypted:0,encrypting:0,'not-encrypted':0,suspended:0,none:0},rows:{device:D;status:BitLockerStatus}[]=[];
 for(const device of dashboardDevices(servers)){
  const status=bitlockerStatus(device.snapshot?.bitlocker);
  counts[status==='not-available'||status==='not-reported'?'none':status]++;
  if(status==='not-encrypted'||status==='suspended')rows.push({device,status});
 }
 rows.sort((a,b)=>encryptionStatusRank[a.status]-encryptionStatusRank[b.status]||byDeviceName(a.device,b.device));
 return {count:rows.length,rows,parts:[part('not-encrypted',counts['not-encrypted'],'warning'),part('suspended',counts.suspended,'warning'),part('encrypting',counts.encrypting,'data'),part('encrypted',counts.encrypted,'ok'),part('none',counts.none,'neutral')]};
}

export type CertificateRow={deviceId:string;deviceName:string;cert:CertificateEntry;status:Exclude<CertificateStatus,'valid'>;daysLeft:number};
/** Certificates: the certificates that expired or expire within 30 days, expired first, then the fewest days left. */
export function certificatesWidget(servers:readonly DashboardDevice[],now:number):{count:number;expired:number;expiring:number;rows:CertificateRow[]}{
 const rows=fleetCertificateRows(dashboardDevices(servers),now).filter((row):row is CertificateRow=>row.status!=='valid');
 const expired=rows.filter(row=>row.status==='expired').length;
 return {count:rows.length,expired,expiring:rows.length-expired,rows};
}

export type AutostartRow<D extends DashboardDevice>={device:D;entry:AutostartSummary['newEntries'][number]};
/** New autostart entries: the new entries of all devices, suspicious first, then the newest. count and suspicious are the devices' own totals (a device lists only its first new entries). */
export function autostartWidget<D extends DashboardDevice>(servers:readonly D[]):{count:number;suspicious:number;rows:AutostartRow<D>[]}{
 let count=0,suspicious=0;const rows:AutostartRow<D>[]=[];
 for(const device of dashboardDevices(servers)){
  const summary=device.autostart;
  if(!summary)continue;
  count+=Math.max(0,Number(summary.newCount)||0);suspicious+=Math.max(0,Number(summary.suspiciousNewCount)||0);
  for(const entry of summary.newEntries??[])rows.push({device,entry});
 }
 rows.sort((a,b)=>Number(b.entry.suspicious)-Number(a.entry.suspicious)||b.entry.firstSeen-a.entry.firstSeen||byDeviceName(a.device,b.device)||a.entry.id.localeCompare(b.entry.id));
 return {count,suspicious,rows};
}

// ---- Hardware ------------------------------------------------------------------------

export type DiskHealthWidget<D extends DashboardDevice>={count:number;failed:number;parts:BreakdownPart<DiskHealthStatus>[];rows:{device:D;status:DiskHealthStatus}[]};
/** Disk health: the devices whose worst disk failed or warns, failed first; and every device by its worst disk (a device that reports no disk health has no data). */
export function diskHealthWidget<D extends DashboardDevice>(servers:readonly D[]):DiskHealthWidget<D>{
 const counts:Record<DiskHealthStatus,number>={failed:0,warning:0,healthy:0,'not-available':0},rows:{device:D;status:DiskHealthStatus}[]=[];
 for(const device of dashboardDevices(servers)){
  const status=deviceDiskHealth(device)??'not-available';
  counts[status]++;
  if(status==='failed'||status==='warning')rows.push({device,status});
 }
 rows.sort((a,b)=>diskHealthRank[a.status]-diskHealthRank[b.status]||byDeviceName(a.device,b.device));
 return {count:rows.length,failed:counts.failed,rows,parts:[part('failed',counts.failed,'critical'),part('warning',counts.warning,'warning'),part('healthy',counts.healthy,'ok'),part('not-available',counts['not-available'],'neutral')]};
}

export type CrashRow<D extends DashboardDevice>={device:D;count:number;last:number};
/** Crashes: the crashes of the last 30 days, the device with the most first. last is the time of its latest crash. */
export function crashesWidget<D extends DashboardDevice>(servers:readonly D[],now:number):{count:number;devices:number;rows:CrashRow<D>[]}{
 const rows=dashboardDevices(servers).flatMap(device=>{
  const crashes=recentCrashes(device,now);
  return crashes.length?[{device,count:crashes.length,last:Math.max(...crashes.map(crash=>Date.parse(crash.at)))}]:[];
 }).sort((a,b)=>b.count-a.count||b.last-a.last||byDeviceName(a.device,b.device));
 return {count:rows.reduce((sum,row)=>sum+row.count,0),devices:rows.length,rows};
}

// ---- Activity ------------------------------------------------------------------------

/** The job states that count as failed (jobStateTone in ui/shell/jobs.tsx gives them the danger tone). */
export const failedJobStates:readonly string[]=['failed','expired','unknown'];
/** When a job last changed: its last progress, else its claim, else its creation. */
const jobTime=(job:Job)=>job.lastProgress??job.claimedAt??job.createdAt;
/** Failed jobs: the jobs that failed in the last 24 hours, the newest first. */
export function failedJobsWidget(jobs:readonly Job[],now:number):{count:number;rows:Job[]}{
 const rows=jobs.filter(job=>failedJobStates.includes(job.state)&&now-jobTime(job)<=dayMs).sort((a,b)=>jobTime(b)-jobTime(a)||a.id.localeCompare(b.id));
 return {count:rows.length,rows};
}

/** Runbook runs: the runbook runs among the jobs, in the order of the job list (the newest first). count: those that run or wait now. */
export function runbooksWidget(jobs:readonly Job[],now:number):{count:number;running:number;waiting:number;rows:Job[]}{
 const rows=jobs.filter(job=>job.action==='runbook-run'&&!!job.metadata?.runbookRunId),{running,waiting}=jobCounts(rows,now);
 return {count:running+waiting,running,waiting,rows:[...rows.filter(job=>job.state==='running'||job.state==='pending'),...rows.filter(job=>job.state!=='running'&&job.state!=='pending')]};
}

/** Recent activity: the audit entries the console carries (portal and device entries, each id once), the newest first. count: the entries of the last 24 hours. */
export function activityWidget(audit:readonly AuditEntry[],deviceAudit:readonly AuditEntry[],now:number):{count:number;rows:AuditEntry[]}{
 const seen=new Set<number>(),rows:AuditEntry[]=[];
 for(const entry of [...audit,...deviceAudit])if(!seen.has(entry.id)){seen.add(entry.id);rows.push(entry);}
 rows.sort((a,b)=>b.at-a.at||b.id-a.id);
 return {count:rows.filter(entry=>now-entry.at<=dayMs).length,rows};
}
