// Display helpers of the health signals (docs/device-health-signals.md): the
// BitLocker state of a volume and of a device, the OS support text, the crash
// list, disk and battery health, certificates and the rows of the analysis tabs. Pure and without React: the fleet
// table, the device page, the analysis tabs and the tests share them.
import type {BitLockerProtector,BitLockerState,BitLockerVolume,CertificateBinding,CertificateEntry,CollectorError,CrashEntry,DiskHealth,OsSupport,OsSupportChannel,PhysicalDiskHealth,Server} from '@/lib/types';
import {defaultLocale,type Locale} from '@/lib/i18n/locale';
import {translate,type MessageKey} from '@/lib/i18n/translate';
import {EMPTY_VALUE,formatNumber,formatPercent} from '@/lib/i18n/format';
import {certificateDaysLeft} from '@/lib/alert-rules';
import {formatSupportDate} from '@/ui/base/ui-device';

/** The collector error of the snapshot for a collector id ("drivers", "software-inventory"), or null (agent 4.11.1). */
export function collectorError(snapshot:{collectorErrors?:readonly CollectorError[]}|null|undefined,id:string):CollectorError|null{
 return snapshot?.collectorErrors?.find(entry=>entry.collector===id)??null;
}
export type HealthTone='ok'|'warning'|'critical'|'neutral';
const dayMs=86400000;

// ---- BitLocker ----
/** The state of a device for the fleet column, the filter and the encryption tab: its system drive. */
export type BitLockerStatus='encrypted'|'encrypting'|'not-encrypted'|'suspended'|'not-available'|'not-reported';
export const bitlockerStatuses:readonly BitLockerStatus[]=['encrypted','encrypting','not-encrypted','suspended','not-available','not-reported'];
export const systemVolume=(state:BitLockerState|undefined)=>state?.available?state.volumes.find(volume=>volume.volumeType==='os')??null:null;
export function bitlockerStatus(state:BitLockerState|undefined|null):BitLockerStatus{
 if(!state)return 'not-reported';
 if(!state.available)return 'not-available';
 const system=systemVolume(state);
 if(!system)return 'not-reported';
 if(system.protection==='suspended')return 'suspended';
 if(system.conversion==='encrypted')return 'encrypted';
 if(system.conversion==='encrypting'||system.conversion==='paused-encrypting')return 'encrypting';
 if(system.conversion==='unknown')return 'not-reported';
 return 'not-encrypted';
}
const statusKeys:Record<BitLockerStatus,MessageKey>={encrypted:'bitlocker.status.encrypted',encrypting:'bitlocker.status.encrypting','not-encrypted':'bitlocker.status.notEncrypted',suspended:'bitlocker.status.suspended','not-available':'bitlocker.status.notAvailable','not-reported':'bitlocker.status.notReported'};
export const bitlockerStatusKey=(status:BitLockerStatus)=>statusKeys[status];
export const bitlockerStatusTone:Record<BitLockerStatus,HealthTone>={encrypted:'ok',encrypting:'neutral','not-encrypted':'warning',suspended:'warning','not-available':'neutral','not-reported':'neutral'};
/** Sort rank of the fleet column: problems first. */
export const bitlockerStatusRank:Record<BitLockerStatus,number>={suspended:0,'not-encrypted':1,encrypting:2,encrypted:3,'not-available':4,'not-reported':5};

/** The BitLocker cell of one volume in the storage area, with its tone. */
export function volumeBitlockerText(volume:BitLockerVolume|null|undefined,state:BitLockerState|undefined,locale:Locale=defaultLocale):{text:string;tone:HealthTone}{
 const t=(key:MessageKey,params?:Record<string,string|number>)=>translate(locale,key,params);
 if(!state)return {text:t('bitlocker.notReported'),tone:'neutral'};
 if(!state.available)return {text:t('bitlocker.notAvailable'),tone:'neutral'};
 if(!volume)return {text:t('bitlocker.notReported'),tone:'neutral'};
 const percent=formatPercent(locale,volume.percent??0);
 if(volume.protection==='suspended')return {text:t('bitlocker.suspended'),tone:'warning'};
 switch(volume.conversion){
  case 'encrypted':return {text:t('bitlocker.encrypted'),tone:'ok'};
  case 'encrypting':case 'paused-encrypting':return {text:t('bitlocker.encrypting',{percent}),tone:'neutral'};
  case 'decrypting':case 'paused-decrypting':return {text:t('bitlocker.decrypting',{percent}),tone:'warning'};
  case 'decrypted':return {text:t('bitlocker.notEncrypted'),tone:volume.volumeType==='os'?'warning':'neutral'};
  default:return {text:t('bitlocker.unknown'),tone:'neutral'};
 }
}
/** The volume of a drive letter ("C:" or "C:\"), case-insensitive. */
export function bitlockerVolume(state:BitLockerState|undefined,drive:string|null|undefined):BitLockerVolume|null{
 const letter=/^([A-Za-z]):/.exec(drive??'')?.[1]?.toUpperCase();
 return letter&&state?.available?state.volumes.find(volume=>volume.drive===letter+':')??null:null;
}
/** "Protection suspended for 3 days": the time since the agent first saw the suspension. */
export function suspendedDuration(since:string,now:number,locale:Locale=defaultLocale):string{
 const elapsed=Math.max(0,now-Date.parse(since));
 if(elapsed>=dayMs)return translate(locale,'bitlocker.duration.days',{count:Math.floor(elapsed/dayMs)});
 if(elapsed>=3600000)return translate(locale,'bitlocker.duration.hours',{count:Math.floor(elapsed/3600000)});
 return translate(locale,'bitlocker.duration.lessThanHour');
}
const protectorKeys:Record<BitLockerProtector,MessageKey|null>={tpm:'bitlocker.protector.tpm','tpm-pin':'bitlocker.protector.tpmPin','tpm-startup-key':'bitlocker.protector.tpmStartupKey','tpm-pin-startup-key':'bitlocker.protector.tpmPinStartupKey','external-key':'bitlocker.protector.externalKey','numerical-password':'bitlocker.protector.numericalPassword',passphrase:'bitlocker.protector.passphrase','public-key':'bitlocker.protector.publicKey','tpm-certificate':'bitlocker.protector.tpmCertificate','ad-account':'bitlocker.protector.adAccount',unknown:null};
export const protectorLabels=(protectors:readonly BitLockerProtector[],locale:Locale=defaultLocale)=>protectors.flatMap(protector=>{const key=protectorKeys[protector];return key?[translate(locale,key)]:[];});
const methodLabels:Record<BitLockerVolume['method'],string>={none:EMPTY_VALUE,'aes-128-diffuser':'AES 128 (Diffuser)','aes-256-diffuser':'AES 256 (Diffuser)','aes-128':'AES 128','aes-256':'AES 256',hardware:'Hardware','xts-aes-128':'XTS-AES 128','xts-aes-256':'XTS-AES 256',unknown:EMPTY_VALUE};
export const methodLabel=(method:BitLockerVolume['method'])=>methodLabels[method];

export type EncryptionRow={id:string;name:string;status:BitLockerStatus;protection:BitLockerVolume['protection']|null;method:string;protectors:string[];recoveryPassword:boolean|null;encrypted:number;volumes:number};
/** One row of the encryption tab per device. */
export function encryptionRow(server:Pick<Server,'id'|'name'|'snapshot'>,locale:Locale=defaultLocale):EncryptionRow{
 const state=server.snapshot?.bitlocker,system=systemVolume(state),volumes=state?.available?state.volumes:[];
 return {id:server.id,name:server.name,status:bitlockerStatus(state),protection:system?.protection??null,method:system?methodLabel(system.method):EMPTY_VALUE,protectors:system?protectorLabels(system.protectors,locale):[],
  recoveryPassword:system?system.protectors.includes('numerical-password'):null,encrypted:volumes.filter(volume=>volume.conversion==='encrypted').length,volumes:volumes.length};
}
/** The sort rank of the System drive column of the Encryption tab, worst first: not encrypted, suspended, encrypting, not reported, not available, encrypted. */
export const encryptionStatusRank:Record<BitLockerStatus,number>={'not-encrypted':0,suspended:1,encrypting:2,'not-reported':3,'not-available':4,encrypted:5};
/** The number of devices per status, for the status filter of the encryption tab. */
export function encryptionCounts(servers:readonly Pick<Server,'snapshot'>[]):Record<BitLockerStatus|'all',number>{
 const counts=Object.fromEntries([['all',servers.length],...bitlockerStatuses.map(status=>[status,0])]) as Record<BitLockerStatus|'all',number>;
 for(const server of servers)counts[bitlockerStatus(server.snapshot?.bitlocker)]++;
 return counts;
}

// ---- Crashes ----
/** The crashes within the last `days` days at `now`. */
export const recentCrashes=(server:Pick<Server,'snapshot'>,now:number,days=30):CrashEntry[]=>(server.snapshot?.crashes??[]).filter(crash=>{const at=Date.parse(crash.at);return Number.isFinite(at)&&now-at<=days*dayMs;});
const crashKindKeys:Record<CrashEntry['kind'],MessageKey>={bugcheck:'crashes.kind.bugcheck','unexpected-shutdown':'crashes.kind.unexpectedShutdown','hardware-error':'crashes.kind.hardwareError'};
export const crashKindKey=(kind:CrashEntry['kind'])=>crashKindKeys[kind];
const crashSourceKeys:Record<CrashEntry['source'],MessageKey>={event:'crashes.source.event',minidump:'crashes.source.minidump','event+minidump':'crashes.source.both'};
export const crashSourceKey=(source:CrashEntry['source'])=>crashSourceKeys[source];

// ---- OS support ----
export type OsSupportFilter='all'|'supported'|'ending'|'ended'|'unknown';
export const osSupportStatusTone:Record<OsSupport['status'],HealthTone>={supported:'ok',ending:'warning',ended:'critical',unknown:'neutral'};
/** The fact text, its tone and the hint of an unknown status. */
export function osSupportText(support:OsSupport|undefined,locale:Locale=defaultLocale):{text:string;tone:HealthTone;hint?:string}{
 const t=(key:MessageKey,params?:Record<string,string|number>)=>translate(locale,key,params);
 if(!support||support.status==='unknown')return {text:t('osSupport.unknown'),tone:'neutral',hint:t(support?.reason==='no-entry'?'osSupport.unknownNoEntry':'osSupport.unknownNotReported')};
 const date=formatSupportDate(locale,support.effectiveEnd??support.entry?.securityEnd??'');
 if(support.status==='ended')return {text:t('osSupport.ended',{date}),tone:'critical'};
 if(support.status==='ending')return {text:t('osSupport.ending',{count:support.daysLeft??0}),tone:'warning'};
 return {text:t('osSupport.supported',{date}),tone:'ok'};
}
const channelKeys:Record<OsSupportChannel,MessageKey>={'home-pro':'osSupport.channel.homePro','enterprise-education':'osSupport.channel.enterpriseEducation',ltsc:'osSupport.channel.ltsc',server:'osSupport.channel.server'};
export const osSupportChannelKey=(channel:OsSupportChannel)=>channelKeys[channel];
export type OsSupportGroup={key:string;entry:NonNullable<OsSupport['entry']>|null;status:OsSupport['status'];securityEnd:string|null;deviceIds:string[]};
/**
 * The rows of the OS support tab: one per catalog entry (status of the entry
 * itself; ESU dates show per device in the drawer) and one row for every
 * unknown device. Sorted by status (ended first), then security end.
 */
export function osSupportGroups(servers:readonly Pick<Server,'id'|'osSupport'>[]):OsSupportGroup[]{
 const groups=new Map<string,OsSupportGroup>();
 for(const server of servers){
  const support=server.osSupport,entry=support?.status!=='unknown'?support?.entry??null:null,key=entry?entry.id:'unknown';
  const group=groups.get(key)??{key,entry,status:entry?support!.status:'unknown',securityEnd:entry?.securityEnd??null,deviceIds:[]};
  // The worst status of the row's devices (an ESU date can keep one device supported).
  if(entry&&statusRank[support!.status]<statusRank[group.status])group.status=support!.status;
  group.deviceIds.push(server.id);groups.set(key,group);
 }
 return [...groups.values()].sort((a,b)=>statusRank[a.status]-statusRank[b.status]||(a.securityEnd??'9999').localeCompare(b.securityEnd??'9999')||a.key.localeCompare(b.key));
}
/** The sort rank of an OS support status, worst first (the order of osSupportGroups). */
export const osSupportStatusRank:Record<OsSupport['status'],number>={ended:0,ending:1,supported:2,unknown:3};
const statusRank=osSupportStatusRank;
export function osSupportCounts(servers:readonly Pick<Server,'osSupport'>[]):Record<OsSupportFilter,number>{
 const counts:Record<OsSupportFilter,number>={all:servers.length,supported:0,ending:0,ended:0,unknown:0};
 for(const server of servers)counts[server.osSupport?.status??'unknown']++;
 return counts;
}

// ---- Disk health (agent 4.11.0) ----
export type DiskHealthStatus='failed'|'warning'|'healthy'|'not-available';
/** Sort rank of the fleet column: problems first; not available last (not reported has no value). */
export const diskHealthRank:Record<DiskHealthStatus,number>={failed:0,warning:1,healthy:2,'not-available':3};
/** The error state of the rule disk-health-failed and the fleet filter: health warning or unhealthy, or operational status predictive failure or failed. */
export function diskInErrorState(disk:Pick<PhysicalDiskHealth,'health'|'operationalStatus'>):boolean{
 const status=disk.operationalStatus??[];
 return disk.health==='warning'||disk.health==='unhealthy'||status.includes('predictive-failure')||status.includes('failed');
}
/**
 * The status pill of one disk: failed (unhealthy, predictive failure or failed),
 * warning (health warning, degraded or lost communication), healthy, or not
 * available when Windows reports no health and the disk has no counters.
 */
export function diskHealthStatus(disk:Pick<PhysicalDiskHealth,'health'|'operationalStatus'|'countersAvailable'>):DiskHealthStatus{
 const status=disk.operationalStatus??[];
 if(disk.health==='unhealthy'||status.includes('predictive-failure')||status.includes('failed'))return 'failed';
 if(disk.health==='warning'||status.includes('degraded')||status.includes('lost-communication'))return 'warning';
 if(disk.health==='unknown'&&!disk.countersAvailable)return 'not-available';
 return 'healthy';
}
export const diskHealthTone:Record<DiskHealthStatus,HealthTone>={failed:'critical',warning:'warning',healthy:'ok','not-available':'neutral'};
const diskStatusKeys:Record<DiskHealthStatus,MessageKey>={failed:'diskHealth.status.failed',warning:'diskHealth.status.warning',healthy:'diskHealth.status.healthy','not-available':'diskHealth.status.notAvailable'};
export const diskHealthStatusKey=(status:DiskHealthStatus)=>diskStatusKeys[status];
/** The worst disk of a device; null when the device does not report disk health (older agent). */
export function deviceDiskHealth(server:Pick<Server,'snapshot'>):DiskHealthStatus|null{
 const health=server.snapshot?.diskHealth;
 if(!health)return null;
 return health.disks.map(diskHealthStatus).reduce<DiskHealthStatus>((worst,status)=>diskHealthRank[status]<diskHealthRank[worst]?status:worst,'not-available');
}
/** The highest wear in percent over the disks that report one; null when none does. */
export function maxWear(server:Pick<Server,'snapshot'>):number|null{
 const values=(server.snapshot?.diskHealth?.disks??[]).map(disk=>disk.wearPercent).filter((value):value is number=>typeof value==='number');
 return values.length?Math.max(...values):null;
}
/** The disk events of the last 30 days over all disks. */
export const diskErrorCount=(server:Pick<Server,'snapshot'>)=>Object.values(server.snapshot?.diskHealth?.events?.counts??{}).reduce((sum,count)=>sum+(Number(count)||0),0);
/** The disk of a drive letter ("C:" or "C:\"), case-insensitive. */
export function diskOfDrive(health:DiskHealth|undefined,drive:string|null|undefined):PhysicalDiskHealth|null{
 const letter=/^([A-Za-z]):/.exec(drive??'')?.[1]?.toUpperCase();
 return letter&&health?health.disks.find(disk=>disk.driveLetters.includes(letter+':'))??null:null;
}

// ---- Battery (agent 4.11.0) ----
/** The lowest health percent of the batteries, or not-available (no battery, not supported, no value, older agent). */
export function batteryHealth(server:Pick<Server,'snapshot'>):number|'not-available'{
 const battery=server.snapshot?.battery;
 if(!battery?.present)return 'not-available';
 const values=battery.batteries.map(item=>item.healthPercent).filter((value):value is number=>typeof value==='number');
 return values.length?Math.min(...values):'not-available';
}
/** mWh as Wh with up to one decimal, in the console language. */
export const formatWh=(locale:Locale,mWh:number)=>formatNumber(locale,mWh/1000,{maximumFractionDigits:1});

// ---- Certificates (agent 4.11.0) ----
export type CertificateStatus='expired'|'expiring'|'valid';
/** The fixed window of the pill "Expires in n days" and the fleet filter "Expiring in 30 days". */
export const certificateWindowDays=30;
export function certificateStatus(cert:Pick<CertificateEntry,'notAfter'>,now:number):{status:CertificateStatus;daysLeft:number}{
 const daysLeft=certificateDaysLeft(cert.notAfter,now);
 return {status:daysLeft<=0?'expired':daysLeft<=certificateWindowDays?'expiring':'valid',daysLeft};
}
export const certificateStatusTone:Record<CertificateStatus,HealthTone>={expired:'critical',expiring:'warning',valid:'ok'};
/** The pill text: Expired, Expires in n days, Valid. */
export function certificateStatusText(cert:Pick<CertificateEntry,'notAfter'>,now:number,locale:Locale=defaultLocale):string{
 const {status,daysLeft}=certificateStatus(cert,now);
 if(status==='expired')return translate(locale,'certificates.expired');
 if(status==='expiring')return translate(locale,'certificates.expiresIn',{count:daysLeft});
 return translate(locale,'certificates.valid');
}
/** "HTTPS 0.0.0.0:443", "Remote Desktop". */
export const certificateBindingText=(binding:CertificateBinding,locale:Locale=defaultLocale)=>binding.type==='rdp'?translate(locale,'certificates.binding.rdp'):translate(locale,'certificates.binding.https',{endpoint:binding.endpoint});
/** The certificates of a device, one per thumbprint, by expiry (soonest first). */
export function deviceCertificates(server:Pick<Server,'snapshot'>):CertificateEntry[]{
 const seen=new Set<string>(),result:CertificateEntry[]=[];
 for(const cert of server.snapshot?.certificates?.items??[])if(!seen.has(cert.thumbprint)){seen.add(cert.thumbprint);result.push(cert);}
 return result.sort((a,b)=>Date.parse(a.notAfter)-Date.parse(b.notAfter)||a.thumbprint.localeCompare(b.thumbprint));
}
export type CertificateFilter='expiring'|'expired'|'all';
export type FleetCertificateRow={deviceId:string;deviceName:string;cert:CertificateEntry;status:CertificateStatus;daysLeft:number};
/** The rows of the scope tab "Certificates": every certificate of every scoped device, by expiry. */
export function fleetCertificateRows(servers:readonly Pick<Server,'id'|'name'|'snapshot'>[],now:number):FleetCertificateRow[]{
 return servers.flatMap(server=>deviceCertificates(server).map(cert=>({deviceId:server.id,deviceName:server.name,cert,...certificateStatus(cert,now)})))
  .sort((a,b)=>Date.parse(a.cert.notAfter)-Date.parse(b.cert.notAfter)||a.deviceName.localeCompare(b.deviceName)||a.cert.thumbprint.localeCompare(b.cert.thumbprint));
}
/** True when a row passes the filter: expiring = 1 to 30 days left, expired = 0 or less; onlyWithKey drops certificates without a private key. */
export const certificateRowShown=(row:FleetCertificateRow,filter:CertificateFilter,onlyWithKey:boolean)=>(!onlyWithKey||row.cert.hasPrivateKey)&&(filter==='all'||row.status===filter);
export function certificateFilterCounts(rows:readonly FleetCertificateRow[],onlyWithKey:boolean):Record<CertificateFilter,number>{
 const counts:Record<CertificateFilter,number>={expiring:0,expired:0,all:0};
 for(const row of rows){if(onlyWithKey&&!row.cert.hasPrivateKey)continue;counts.all++;if(row.status!=='valid')counts[row.status]++;}
 return counts;
}
