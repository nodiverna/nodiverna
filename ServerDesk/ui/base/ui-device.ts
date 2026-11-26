import type {DefenderSeverity, Server, Disk} from '@/lib/types';
import {defaultLocale,type Locale} from '@/lib/i18n/locale';
import {translate,type MessageKey,type MessageParams} from '@/lib/i18n/translate';
import {agentReasonLines} from '@/ui/base/agent-reasons';
import {formatDate,formatDateTime,formatDuration,formatNumber,formatPercent,formatRelative} from '@/lib/i18n/format';
import {formatStopCode} from '@/ui/base/bugcheck-codes';
import {deviceProblemText} from '@/ui/base/device-problem-codes';
import type {AlertIssue} from '@/lib/alert-rules';
import {connectionKind} from '@/lib/device-connection';
import {defenderSeverityKeys} from '@/lib/defender';
import {alarmTarget} from '@/ui/base/health-score';
import {deviceDetailOf,type DiagnosticsDetail,type HardwareDetail,type ManagementDetail,type ExtensionsDetail,type SoftwareDetail} from '@/lib/console-route';
import {detectTargets} from '@/lib/extensions';

export function deviceConnection(server:Server, now:number, locale:Locale=defaultLocale) {
 const kind=connectionKind(server,now);
 if(kind==='maintenance')return {kind,label:translate(locale,'device.connection.maintenance')};
 if(kind==='waiting')return {kind,label:translate(locale,server.registration?.expiresAt!=null&&server.registration.expiresAt<=now?'device.registration.expired':'device.connection.firstReportPending')};
 return kind==='online'?{kind,label:translate(locale,'device.connection.online')}:{kind,label:translate(locale,'device.connection.offline')};
}
/** Sub-line for a never-connected device in the device list; null for connected devices. */
export function registrationNote(server:Pick<Server,'registration'>,now:number,locale:Locale=defaultLocale):string|null {
 const registration=server.registration;if(!registration)return null;
 if(registration.expiresAt==null)return translate(locale,'device.registration.noExpiry');
 return registration.expiresAt<=now?translate(locale,'device.registration.expired'):translate(locale,'device.registration.validUntil',{time:formatDateTime(locale,registration.expiresAt)});
}
export function liveValue(server:Server,value:number|null|undefined,now:number):number|null {
 return deviceConnection(server,now).kind==='online'&&typeof value==='number'&&Number.isFinite(value)?value:null;
}
export function diskSummary(server:Server):Disk|null {
 return (server.snapshot?.disks??[]).filter(d=>d.totalGb>0&&Number.isFinite(d.freeGb)).reduce<Disk|null>((lowest,d)=>!lowest||d.freeGb/d.totalGb<lowest.freeGb/lowest.totalGb?d:lowest,null);
}
/** unknown: agent reasons the catalog does not know, as received; the views show them in mono after the title. */
export type DeviceIssue={key:string;title:string;detail:string;unknown?:string[];level:'critical'|'warning'|'info'};
/** The reason a restart is pending (snapshot.rebootReasons), as the health line and the Dashboard name it. */
export const rebootLabels:Record<string,MessageKey>={'windows-servicing':'device.reboot.windowsServicing','windows-update':'device.reboot.windowsUpdate','file-replacement':'device.reboot.fileReplacement','file-operations-unknown':'device.reboot.fileOperations'};
const num=(value:unknown)=>typeof value==='number'?value:Number(value);
const list=(value:unknown)=>Array.isArray(value)?value.map(String):[];
/** A catalog date (YYYY-MM-DD, a calendar day without time zone) in the console language. */
export const formatSupportDate=(locale:Locale,date:string)=>formatDate(locale,date+'T00:00:00Z',{timeZone:'UTC'});
/** Title and detail of one issue the server evaluated (lib/alert-rules.ts), in the given locale. */
export function issueText(issue:Pick<AlertIssue,'ruleId'|'params'>,locale:Locale,now:number):{title:string;detail:string;unknown?:string[]}{
 const t=(key:MessageKey,params?:MessageParams)=>translate(locale,key,params),p=issue.params;
 switch(issue.ruleId){
  case 'cpu':return {title:t('device.issue.cpu'),detail:formatPercent(locale,num(p.value))};
  case 'memory':return {title:t('device.issue.memory'),detail:formatPercent(locale,num(p.value))};
  case 'disk-free':{const name=String(p.name),free=num(p.freeGb),total=num(p.totalGb);return {title:t('device.issue.diskLow',{name}),detail:t('device.issue.diskFree',{size:formatNumber(locale,free,{maximumFractionDigits:1}),percent:formatPercent(locale,free/total*100)})};}
  case 'reboot-pending':return {title:t('device.issue.reboot'),detail:list(p.reasons).map(reason=>Object.hasOwn(rebootLabels,reason)?t(rebootLabels[reason]):'').filter(Boolean).join(' · ')||t('device.issue.rebootDetail')};
  case 'disk-latency':return {title:t('device.issue.latency'),detail:formatDuration(locale,num(p.value))};
  case 'pagefile':return {title:t('device.issue.pagefile'),detail:formatPercent(locale,num(p.value))};
  case 'processor-queue':return {title:t('device.issue.queue'),detail:t('device.issue.queueDetail',{threads:num(p.threads),cores:num(p.cores)})};
  case 'firewall-off':return {title:t('device.issue.firewall'),detail:list(p.profiles).join(', ')};
  case 'defender-off':return {title:t('device.issue.defender'),detail:t('device.issue.defenderDetail')};
  case 'signatures-age':return {title:t('device.issue.signatures',{count:num(p.threshold)}),detail:formatDate(locale,String(p.signatureAt))};
  case 'updates-pending':return {title:t('device.issue.updates',{count:num(p.count)}),detail:t('device.issue.updatesDetail',{date:formatDate(locale,String(p.checkedAt))})};
  // The agent reasons in the console language (ui/base/agent-reasons.ts); unknown ones stay as received and marked.
  case 'inventory-incomplete':{const lines=agentReasonLines(locale,list(p.errors));return {title:t('device.issue.collection'),detail:lines.known.join('\n'),...(lines.unknown.length?{unknown:lines.unknown}:{})};}
  case 'crash-recent':{
   const driver=typeof p.driver==='string'?p.driver:null,time=formatDateTime(locale,String(p.at)),count=num(p.sameDriverCount);
   const title=driver&&count>=2?t('device.issue.crashRepeated',{crashes:count,driver,count:num(p.sameDriverDays)})
    :p.kind==='bugcheck'?(typeof p.stopCode==='number'?t('device.issue.crashBugcheck',{code:formatStopCode(p.stopCode)}):t('crashes.kind.bugcheck'))
    :p.kind==='hardware-error'?t('device.issue.crashHardware'):t('device.issue.crashShutdown');
   return {title,detail:driver?t('device.issue.crashDetailDriver',{time,driver}):t('device.issue.crashDetail',{time})};
  }
  case 'os-support-end':{
   const left=num(p.daysLeft),product=String(p.product),date=formatSupportDate(locale,String(p.date));
   return left>0?{title:t('device.issue.osSupportEnding',{count:left}),detail:t('device.issue.osSupportDetail',{product,date})}:{title:t('device.issue.osSupportEnded'),detail:t('device.issue.osSupportEndedDetail',{product,date})};
  }
  case 'os-support-unknown':return {title:t('device.issue.osSupportUnknown'),detail:t('device.issue.osSupportUnknownDetail',{product:String(p.product),version:String(p.version),build:String(p.build)})};
  case 'bitlocker-system-unencrypted':return {title:t('device.issue.bitlockerSystem'),detail:t('device.issue.bitlockerSystemDetail',{drive:String(p.drive)})};
  case 'bitlocker-suspended':{
   const since=typeof p.suspendedSince==='string'?Date.parse(p.suspendedSince):NaN;
   return {title:t('device.issue.bitlockerSuspended',{drive:String(p.drive)}),detail:Number.isFinite(since)?t('device.issue.bitlockerSuspendedSince',{time:formatDateTime(locale,since),relative:formatRelative(locale,since,now)}):t('device.issue.bitlockerSuspendedNoTime')};
  }
  case 'bitlocker-no-recovery-password':return {title:t('device.issue.bitlockerRecovery',{drive:String(p.drive)}),detail:t('device.issue.bitlockerRecoveryDetail')};
  case 'device-problem':{
   const count=num(p.count),more=num(p.more),name=String(p.name),code=deviceProblemText(num(p.code),locale);
   return {title:t('device.issue.deviceProblem',{count}),detail:more>0?t('device.issue.deviceProblemDetailMore',{name,code,more}):t('device.issue.deviceProblemDetail',{name,code})};
  }
  case 'driver-unsigned':return {title:t('device.issue.driverUnsigned',{count:num(p.count)}),detail:list(p.names).join(', ')};
  case 'stability-low':return {title:t('device.issue.stabilityLow'),detail:t('device.issue.stabilityLowDetail',{index:formatNumber(locale,num(p.index),{minimumFractionDigits:1,maximumFractionDigits:1})})};
  case 'app-crash-repeated':return {title:t('device.issue.appCrash',{program:String(p.program)}),detail:t('device.issue.appCrashDetail',{count:num(p.count),days:num(p.days)})};
  case 'disk-health-failed':{
   const status=list(p.status).map(value=>Object.hasOwn(operationalKeys,value)?t(operationalKeys[value]):value).join(', ')||t('diskHealth.operational.unknown');
   return {title:t('device.issue.diskHealth',{name:String(p.name)}),detail:t('device.issue.diskHealthDetail',{health:t(healthKeys[String(p.health)]??'diskHealth.health.unknown'),status})};
  }
  case 'ssd-wear':return {title:t('device.issue.ssdWear',{name:String(p.name),percent:formatPercent(locale,num(p.percent))}),detail:t('device.issue.ssdWearDetail')};
  case 'disk-errors':{
   const count=num(p.count),disk=String(p.disk),name=String(p.name??'');
   const title=disk==='unknown'?t('device.issue.diskErrorsUnknown'):name?t('device.issue.diskErrors',{name}):t('device.issue.diskErrorsNumber',{number:disk});
   return {title,detail:t('device.issue.diskErrorsDetail',{count})};
  }
  case 'battery-capacity':{
   const percent=formatPercent(locale,num(p.percent)),wh=(value:unknown)=>formatNumber(locale,num(value)/1000,{maximumFractionDigits:1});
   return {title:t('device.issue.battery',{percent}),detail:p.full!==undefined&&p.design!==undefined?t('device.issue.batteryDetail',{full:wh(p.full),design:wh(p.design)}):''};
  }
  case 'cert-expiring':case 'cert-expiring-no-key':{
   const left=num(p.daysLeft),subject=String(p.subject),detail=t('device.issue.certDetail',{date:formatDate(locale,String(p.notAfter)),stores:list(p.stores).join(', ')});
   return {title:left>0?t('device.issue.certExpiring',{subject,count:left}):t('device.issue.certExpired',{subject}),detail};
  }
  case 'dhcp-scope-full':return {title:t('device.issue.dhcpScopeFull',{scope:String(p.scope),percent:formatPercent(locale,num(p.percent))}),detail:t('device.issue.dhcpScopeFullDetail',{inUse:num(p.inUse),total:num(p.total)})};
  case 'dhcp-service-stopped':return {title:t('device.issue.dhcpServiceStopped'),detail:t('device.issue.dhcpServiceStoppedDetail')};
  case 'dns-service-stopped':return {title:t('device.issue.dnsServiceStopped'),detail:t('device.issue.dnsServiceStoppedDetail')};
  // Agent tamper protection (agent 4.18.0): the kind, reason, target and start type of the stored event or snapshot.
  case 'agent-stopped':{
   const service=t(integrityServiceKeys[String(p.service)]??'agentIntegrity.service.broker');
   if(typeof p.startType==='string')return {title:t('device.issue.agentStartType'),detail:t('device.issue.agentStartTypeDetail',{service,startType:t(integrityStartTypeKeys[p.startType]??'agentIntegrity.startType.unknown')})};
   const [title,detail]=integrityStopKeys[String(p.kind)]??integrityStopKeys['service-stopped'];
   return {title:t(title),detail:t(detail,{service,time:formatDateTime(locale,num(p.at))})};
  }
  case 'agent-removed':{
   const time=formatDateTime(locale,num(p.at));
   return {title:t('device.issue.agentRemoved'),detail:p.reason==='local-uninstall'&&typeof p.user==='string'?t('device.issue.agentRemovedLocal',{user:p.user,time}):t('device.issue.agentRemovedService',{time})};
  }
  case 'agent-protection-changed':{
   const time=formatDateTime(locale,num(p.at));
   return {title:t('device.issue.agentProtection',{target:t(integrityTargetKey(String(p.target),typeof p.service==='string'?p.service:null))}),detail:t(p.repaired==='true'?'device.issue.agentProtectionRepaired':'device.issue.agentProtectionOpen',{time})};
  }
  case 'autostart-new':return {title:t('device.issue.autostartNew',{count:num(p.count)}),detail:t('device.issue.autostartDetail',{names:list(p.names).join(', ')})};
  case 'autostart-new-suspicious':return {title:t('device.issue.autostartSuspicious',{count:num(p.count)}),detail:t('device.issue.autostartDetail',{names:list(p.names).join(', ')})};
  case 'threat-detected':{
   const severity=String(p.severity);
   return {title:t('device.issue.threats',{count:num(p.count)}),detail:t('device.issue.threatsDetail',{severity:t(defenderSeverityKeys[severity as DefenderSeverity]??'defender.severity.unknown')})};
  }
  case 'scan-age':return {title:t('device.issue.scanAge',{count:num(p.threshold)}),detail:typeof p.scanAt==='string'?formatDate(locale,p.scanAt):t('device.issue.scanNever')};
  case 'device-offline':return {title:t('device.issue.offline'),detail:t('device.issue.offlineDetail',{time:formatRelative(locale,num(p.lastSeen),now)})};
 }
}
const integrityServiceKeys:Record<string,MessageKey>={broker:'agentIntegrity.service.broker',worker:'agentIntegrity.service.worker'};
const integrityStartTypeKeys:Record<string,MessageKey>={manual:'agentIntegrity.startType.manual',disabled:'agentIntegrity.startType.disabled',unknown:'agentIntegrity.startType.unknown'};
const integrityStopKeys:Record<string,[MessageKey,MessageKey]>={
 'service-stopped':['device.issue.agentStopped','device.issue.agentStoppedDetail'],'service-ended':['device.issue.agentEnded','device.issue.agentEndedDetail'],
 'service-hung':['device.issue.agentHung','device.issue.agentHungDetail'],'service-restarted':['device.issue.agentRestarted','device.issue.agentRestartedDetail'],
 'broker-unresponsive':['device.issue.agentBrokerUnresponsive','device.issue.agentBrokerUnresponsiveDetail'],
};
/** The label of a protection target: per service for the service targets, per folder for the folder targets. */
export function integrityTargetKey(target:string,service:string|null):MessageKey{
 const folders:Record<string,MessageKey>={'folder-agent':'agentIntegrity.target.folderAgent','folder-plugins':'agentIntegrity.target.folderPlugins','folder-staging':'agentIntegrity.target.folderStaging'};
 if(Object.hasOwn(folders,target))return folders[target];
 const worker=service==='worker';
 if(target==='service-sid')return worker?'agentIntegrity.target.workerSid':'agentIntegrity.target.brokerSid';
 if(target==='service-recovery')return worker?'agentIntegrity.target.workerRecovery':'agentIntegrity.target.brokerRecovery';
 return worker?'agentIntegrity.target.workerDacl':'agentIntegrity.target.brokerDacl';
}
const healthKeys:Record<string,MessageKey>={healthy:'diskHealth.health.healthy',warning:'diskHealth.health.warning',unhealthy:'diskHealth.health.unhealthy',unknown:'diskHealth.health.unknown'};
const operationalKeys:Record<string,MessageKey>={ok:'diskHealth.operational.ok',degraded:'diskHealth.operational.degraded','predictive-failure':'diskHealth.operational.predictiveFailure',failed:'diskHealth.operational.failed','lost-communication':'diskHealth.operational.lostCommunication',unknown:'diskHealth.operational.unknown'};
/**
 * The device area an issue links to from the Overview: a Diagnostics, Management or Hardware subarea,
 * a Software subarea (the driver inventory with a driver), or an Extensions subarea (the DHCP server for the DHCP issues).
 */
export type IssueTarget={section:'diagnostics';diagnosis:DiagnosticsDetail}|{section:'hardware';hardware:HardwareDetail}|{section:'management';management:ManagementDetail}|{section:'software';software:SoftwareDetail;driver?:string}|{section:'extensions';extensions:ExtensionsDetail};
/**
 * Where an issue links on the device page, or null: the area of its rule (alarmTarget), so
 * every rule whose area is not the Overview gets a link. A recent crash with a driver opens
 * the driver inventory with that driver when the device reports drivers; without it the crash
 * opens Events like the other stability rules. The disk rules open Storage, the battery rule
 * the hardware overview. The DHCP rules open the DHCP server of the Extensions area, the DNS rule the
 * DNS server, but only when the device has the detected role (detectTargets): without it the
 * Extensions area is hidden or shows no such server, so the issue gets no link.
 */
export function issueTarget(issue:Pick<AlertIssue,'ruleId'|'params'>,server:Pick<Server,'snapshot'|'serverSoftware'>):IssueTarget|null{
 if(issue.ruleId==='crash-recent'&&typeof issue.params.driver==='string'&&server.snapshot?.driverHealth)return {section:'software',software:'drivers',driver:issue.params.driver};
 const area=alarmTarget(issue.ruleId,issue.params,server);
 if(area.section==='diagnostics')return {section:'diagnostics',diagnosis:deviceDetailOf('diagnostics',area.detail)};
 if(area.section==='hardware')return {section:'hardware',hardware:deviceDetailOf('hardware',area.detail)};
 if(area.section==='management')return {section:'management',management:deviceDetailOf('management',area.detail)};
 if(area.section==='software')return {section:'software',software:deviceDetailOf('software',area.detail)};
 if(area.section==='extensions'){
  const extensions=deviceDetailOf('extensions',area.detail),detected=detectTargets(server);
  // The Extensions area shows only with a detected target, its DHCP or DNS server only with that role.
  return detected.length&&(extensions==='overview'||detected.some(entry=>entry.id===extensions))?{section:'extensions',extensions}:null;
 }
 return null;
}
/**
 * The issues of a device as the server evaluated them (server.issues), formatted
 * in the given locale. No thresholds apply here: the browser only drops live
 * issues when the device is not online at `now`, so a device that went offline
 * since the last poll loses them at once, and drops Device offline once the
 * device is online again.
 */
export function deviceIssues(server:Server,now:number,locale:Locale=defaultLocale):DeviceIssue[] {
 const issues=server.issues??[];if(!issues.length)return [];
 const online=connectionKind(server,now)==='online';
 return issues.filter(issue=>issueShown(issue,online)).map(issue=>({key:issue.key,...issueText(issue,locale,now),level:issue.level}));
}
const issueShown=(issue:Pick<AlertIssue,'ruleId'|'live'>,online:boolean)=>issue.ruleId==='device-offline'?!online:!issue.live||online;
/** Whether deviceIssues has an entry at `now`, without building the texts: cheap enough for a clock selector over a whole fleet. */
export function deviceHasIssues(server:Pick<Server,'issues'|'lastSeen'|'maintenance'>,now:number):boolean{
 const issues=server.issues??[];if(!issues.length)return false;
 const online=connectionKind(server,now)==='online';
 return issues.some(issue=>issueShown(issue,online));
}
/**
 * Everything a device's list row or card derives from the clock, as one string: the connection state, whether its
 * registration expired, and the relative "last seen" text. deviceConnection, deviceIssues, liveValue, registrationNote
 * and relativeTime of the device give the same result for two times with the same state, so a row renders again
 * only when this string changes.
 */
export function deviceClockState(server:Pick<Server,'lastSeen'|'maintenance'|'registration'>,now:number,locale:Locale=defaultLocale):string{
 return deviceToneState(server,now)+'|'+formatRelative(locale,server.lastSeen,now);
}
/** The part of deviceClockState that the connection dot of the navigator tree shows: the connection state and the expired registration. */
export function deviceToneState(server:Pick<Server,'lastSeen'|'maintenance'|'registration'>,now:number):string{
 return connectionKind(server,now)+(server.registration?.expiresAt!=null&&server.registration.expiresAt<=now?':expired':'');
}
