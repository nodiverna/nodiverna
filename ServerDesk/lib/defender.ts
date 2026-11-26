// Microsoft Defender in the console (docs/device-health-signals.md, "Microsoft
// Defender"): the state of the device area, the notices, the detection order,
// the rows, filters and counts of the scope tab "Protection" and the Defender
// row of the overview card "Protection & maintenance". Pure and without React
// or server imports. Filters read server.issues, so they follow each device's
// effective alert rules: the browser never applies a threshold.
import type {DefenderAvailable,DefenderDetection,DefenderMode,DefenderSeverity,DefenderThreatStatus,Job,Server,ServerSnapshot} from './types';
import {defenderCovered,defenderLastScan} from './alert-rules';
import {defaultLocale,type Locale} from './i18n/locale';
import {translate,type MessageKey} from './i18n/translate';

export type DefenderTone='ok'|'warning'|'critical'|'neutral';
/** The capability of agent 4.14.0. */
export const defenderCapability='defender-status';
type DefenderDevice=Pick<Server,'snapshot'>;

/**
 * The state of the device area: no snapshot; an agent without the capability;
 * the capability without a report yet; Defender not installed; a failed read;
 * or the report.
 */
export type DefenderAreaState={kind:'no-snapshot'}|{kind:'old-agent'}|{kind:'not-reported'}|{kind:'not-installed'}|{kind:'error'}|{kind:'available';defender:DefenderAvailable};
export function defenderAreaState(server:DefenderDevice):DefenderAreaState{
 const snapshot=server.snapshot;
 if(!snapshot)return {kind:'no-snapshot'};
 if(!snapshot.agentCapabilities?.includes(defenderCapability))return {kind:'old-agent'};
 const defender=snapshot.defender;
 if(!defender)return {kind:'not-reported'};
 if(!defender.available)return defender.reason==='not-installed'?{kind:'not-installed'}:{kind:'error'};
 return {kind:'available',defender};
}

/** The headline status of a report: Active, Passive, EDR block mode, Off or Not running. */
export type DefenderStatus='active'|'passive'|'edr-block'|'off'|'not-running';
export function defenderStatus(defender:Pick<DefenderAvailable,'mode'|'antivirusEnabled'|'realTimeProtection'>):DefenderStatus{
 if(defender.mode==='passive'||defender.mode==='sxs-passive')return 'passive';
 if(defender.mode==='edr-block')return 'edr-block';
 if(defender.mode==='not-running')return 'not-running';
 return defender.antivirusEnabled&&defender.realTimeProtection?'active':'off';
}
export const defenderStatusKeys:Record<DefenderStatus,MessageKey>={active:'defender.mode.normal',passive:'defender.mode.passive','edr-block':'defender.mode.edrBlock',off:'defender.off','not-running':'defender.mode.notRunning'};
/** The tone of the status tile: off without another product is critical, a covered Defender is neutral. */
export function defenderStatusTone(defender:DefenderAvailable):DefenderTone{
 const status=defenderStatus(defender);
 if(status==='active')return 'ok';
 if(status==='passive'||status==='edr-block')return 'neutral';
 return defenderCovered(defender)?'neutral':'critical';
}
export const defenderModeKeys:Record<DefenderMode,MessageKey>={normal:'defender.mode.normal',passive:'defender.mode.passive','sxs-passive':'defender.mode.sxsPassive','edr-block':'defender.mode.edrBlock','not-running':'defender.mode.notRunning',unknown:'defender.mode.unknown'};
export const defenderSeverityKeys:Record<DefenderSeverity,MessageKey>={low:'defender.severity.low',moderate:'defender.severity.moderate',high:'defender.severity.high',severe:'defender.severity.severe',unknown:'defender.severity.unknown'};
export const defenderThreatStatusKeys:Record<DefenderThreatStatus,MessageKey>={detected:'defender.threatStatus.detected',cleaned:'defender.threatStatus.cleaned',quarantined:'defender.threatStatus.quarantined',removed:'defender.threatStatus.removed',allowed:'defender.threatStatus.allowed',blocked:'defender.threatStatus.blocked',failed:'defender.threatStatus.failed',abandoned:'defender.threatStatus.abandoned',unknown:'defender.threatStatus.unknown'};
/** Severe and high are critical, moderate is a warning, low and unknown are neutral. */
/** The sort rank of a severity: severe highest, unknown lowest (the detections table sorts by it). */
export const defenderSeverityRank:Record<DefenderSeverity,number>={severe:4,high:3,moderate:2,low:1,unknown:0};
export const defenderSeverityTone=(severity:DefenderSeverity):DefenderTone=>severity==='severe'||severity==='high'?'critical':severity==='moderate'?'warning':'neutral';
/** An active detection is critical, failed and abandoned ones are warnings, a resolved one is ok, allowed and unknown are neutral. */
export function defenderDetectionTone(detection:Pick<DefenderDetection,'active'|'status'>):DefenderTone{
 if(detection.active)return 'critical';
 if(detection.status==='failed'||detection.status==='abandoned')return 'warning';
 return detection.status==='cleaned'||detection.status==='quarantined'||detection.status==='removed'||detection.status==='blocked'?'ok':'neutral';
}
/** The name of the first enabled other antivirus, or null. */
export const defenderCoveringName=(defender:Pick<DefenderAvailable,'otherAntivirus'>)=>(defender.otherAntivirus??[]).find(product=>product.enabled)?.name??null;

/** The notice above the cards: passive (with or without the product name), off next to another product, or off without one. */
export type DefenderNotice={tone:'info'|'danger';key:MessageKey;name?:string}|null;
export function defenderNotice(defender:DefenderAvailable):DefenderNotice{
 const status=defenderStatus(defender),name=defenderCoveringName(defender);
 if(status==='passive'||status==='edr-block')return name?{tone:'info',key:'defender.notice.passive',name}:{tone:'info',key:'defender.notice.passiveUnnamed'};
 if(status==='off'||status==='not-running')return name?{tone:'info',key:'defender.notice.offCovered',name}:{tone:'danger',key:'defender.notice.offUncovered'};
 return null;
}

/** The newer of the quick and full scan with its kind, or null when Defender never reported a scan. */
export function defenderLastScanKind(defender:Pick<DefenderAvailable,'quickScanAt'|'fullScanAt'>):{at:string;kind:'quick'|'full'}|null{
 const at=defenderLastScan(defender);
 return at===null?null:{at,kind:at===defender.quickScanAt?'quick':'full'};
}
const time=(value:string|null)=>value===null?Number.NEGATIVE_INFINITY:Date.parse(value);
/** Active detections first, then newest first, then by ID. */
export function sortedDetections(detections:readonly DefenderDetection[]):DefenderDetection[]{
 return [...detections].sort((a,b)=>Number(b.active)-Number(a.active)||time(b.at)-time(a.at)||a.id.localeCompare(b.id));
}

/** The open issue of a rule on the device, from the server's evaluation. */
const issueOf=(server:Pick<Server,'issues'>,ruleId:'defender-off'|'scan-age')=>(server.issues??[]).find(issue=>issue.ruleId===ruleId);
/** The threshold of an open scan-age issue (days), from the issue params; null without one. */
export function scanAgeThreshold(server:Pick<Server,'issues'>):number|null{
 const value=issueOf(server,'scan-age')?.params.threshold;
 return typeof value==='number'?value:null;
}

// ---- Scope tab "Protection" ----
export type ProtectionStatus='threat'|'off'|'scan-old'|'passive'|'protected'|'not-installed'|'update-agent'|'not-reported';
export const protectionStatusKeys:Record<ProtectionStatus,MessageKey>={threat:'protection.status.threat',off:'protection.status.off','scan-old':'protection.status.scanOld',passive:'protection.status.passive',protected:'protection.status.protected','not-installed':'protection.status.notInstalled','update-agent':'protection.status.updateAgent','not-reported':'protection.status.notReported'};
export const protectionStatusTone:Record<ProtectionStatus,DefenderTone>={threat:'critical',off:'critical','scan-old':'warning',passive:'neutral',protected:'ok','not-installed':'neutral','update-agent':'neutral','not-reported':'neutral'};
export type ProtectionFilter='all'|'detections'|'scan-old'|'off'|'passive'|'not-reported';
export const protectionFilters:readonly ProtectionFilter[]=['all','detections','scan-old','off','passive','not-reported'];
type ProtectionDevice=Pick<Server,'id'|'name'|'snapshot'|'issues'>;
const passiveMode=(defender:DefenderAvailable|null)=>!!defender&&(defender.mode==='passive'||defender.mode==='sxs-passive'||defender.mode==='edr-block');
const reported=(server:Pick<Server,'snapshot'>)=>{const defender=server.snapshot?.defender;return defender?.available?defender:null;};

/** The sort rank of a status in the priority of protectionStatus: Threat active first, Not reported last. */
export const protectionStatusRank:Record<ProtectionStatus,number>={threat:0,off:1,'scan-old':2,passive:3,protected:4,'not-installed':5,'update-agent':6,'not-reported':7};
/** Status by priority: Threat active > Off > Scan too old > Passive > Protected > Not installed > Update agent > Not reported. */
export function protectionStatus(server:ProtectionDevice):ProtectionStatus{
 const defender=reported(server);
 if(defender&&defender.activeCount>0)return 'threat';
 if(issueOf(server,'defender-off'))return 'off';
 if(issueOf(server,'scan-age'))return 'scan-old';
 if(passiveMode(defender))return 'passive';
 if(defender)return 'protected';
 const raw=server.snapshot?.defender;
 if(raw&&!raw.available&&raw.reason==='not-installed')return 'not-installed';
 if(server.snapshot&&!server.snapshot.agentCapabilities?.includes(defenderCapability))return 'update-agent';
 return 'not-reported';
}
/** Whether a device belongs to a filter; a device can be in more than one. */
export function matchesProtectionFilter(server:ProtectionDevice,filter:ProtectionFilter):boolean{
 const defender=reported(server);
 switch(filter){
  case 'all':return true;
  case 'detections':return !!defender&&defender.activeCount>0;
  case 'scan-old':return !!issueOf(server,'scan-age');
  case 'off':return !!issueOf(server,'defender-off');
  case 'passive':return passiveMode(defender);
  case 'not-reported':return !server.snapshot?.defender?.available;
 }
}
export function protectionCounts(devices:readonly ProtectionDevice[]):Record<ProtectionFilter,number>{
 return Object.fromEntries(protectionFilters.map(filter=>[filter,devices.filter(device=>matchesProtectionFilter(device,filter)).length])) as Record<ProtectionFilter,number>;
}
export type ProtectionRow={id:string;name:string;status:ProtectionStatus;
 /** The enabled other antivirus of a passive device. */
 coveredBy:string|null;
 activeCount:number|null;
 /** The newest active detection: a name, null without a name, undefined when the list is not there (no defender.read) or holds no active detection. */
 newest:string|null|undefined;
 lastScan:string|null;signatureAt:string|null;tamperProtected:boolean|null;
 /** A scan that the portal started still runs (snapshot.defenderScan, agent 4.15.0). */
 scanRunning:boolean};
export function protectionRow(server:ProtectionDevice):ProtectionRow{
 const defender=reported(server),status=protectionStatus(server);
 const newest=defender?.detections?sortedDetections(defender.detections.filter(item=>item.active))[0]:undefined;
 return {id:server.id,name:server.name,status,coveredBy:status==='passive'&&defender?defenderCoveringName(defender):null,activeCount:defender?defender.activeCount:null,
  newest:newest===undefined?undefined:newest.name,lastScan:defender?defenderLastScan(defender):null,signatureAt:defender?.signatureAt??null,tamperProtected:defender?defender.tamperProtected:null,scanRunning:!!server.snapshot?.defenderScan};
}

// ---- The Defender row of the overview card "Protection & maintenance" ----
export type DefenderProtectionRow={value:string;detail?:string;tone:DefenderTone;target?:{section:'management';management:'defender'}};
const dayMs=86400000;
/**
 * The Defender row from snapshot.defender (agent 4.14.0), with the link to the
 * Defender area; from security.defender for older agents; null without either.
 */
export function defenderProtectionRow(server:DefenderDevice,now:number,locale:Locale=defaultLocale):DefenderProtectionRow|null{
 const t=(key:MessageKey,params?:Record<string,string|number>)=>translate(locale,key,params),snapshot=server.snapshot;
 const target={section:'management',management:'defender'} as const;
 const signatures=(at:string|null|undefined):string|undefined=>{const value=at?Date.parse(at):NaN;if(!Number.isFinite(value))return undefined;const age=(now-value)/dayMs;return age<1?t('device.protection.signaturesToday'):age<2?t('device.protection.signaturesYesterday'):t('device.signaturesAge',{count:Math.floor(age)});};
 const defender=snapshot?.defender;
 if(defender){
  if(!defender.available)return defender.reason==='not-installed'?{value:t('device.protection.notInstalled'),tone:'neutral',target}:{value:t('common.notAvailable'),detail:t('defender.notice.error'),tone:'neutral',target};
  if(defender.activeCount>0)return {value:t('device.protection.activeDetections',{count:defender.activeCount}),detail:defender.highestActiveSeverity?t('device.issue.threatsDetail',{severity:t(defenderSeverityKeys[defender.highestActiveSeverity])}):undefined,tone:'critical',target};
  const status=defenderStatus(defender),name=defenderCoveringName(defender),covered=name?t('device.protection.covered',{name}):t('device.protection.coveredUnnamed');
  if(status==='passive'||status==='edr-block')return {value:t('device.protection.passive'),detail:covered,tone:'neutral',target};
  if(status==='off'||status==='not-running')return name?{value:t('defender.off'),detail:covered,tone:'neutral',target}:{value:status==='off'?t('defender.off'):t('defender.mode.notRunning'),detail:t('device.issue.defenderDetail'),tone:'critical',target};
  const age=defender.signatureAt?(now-Date.parse(defender.signatureAt))/dayMs:null;
  return {value:t('device.protection.realtimeOn'),detail:signatures(defender.signatureAt),tone:age!=null&&age>=3?'warning':'ok',target};
 }
 const older=snapshot?.security?.defender;
 if(!older)return null;
 if(!older.available)return {value:t('common.notAvailable'),detail:t('device.protection.updateAgentWhy'),tone:'neutral'};
 const age=older.signatureAt?(now-Date.parse(older.signatureAt))/dayMs:null;
 return {value:!older.enabled?t('fleet.disabled'):older.realTimeProtection?t('device.protection.realtimeOn'):t('device.protection.realtimeOff'),detail:signatures(older.signatureAt),tone:!older.enabled||!older.realTimeProtection?'critical':age!=null&&age>=3?'warning':'ok'};
}


// ---- Actions of agent 4.15.0: quick scan, full scan, signature update, clean ----
// The device area, the bulk bar of the scope tab and the console route
// (app/api/console/route.ts) use the same checks, so the UI and the server agree.
export const defenderJobKinds=['defender-quick-scan','defender-full-scan','defender-update-signatures','defender-clean-detections'] as const;
export type DefenderJobKind=typeof defenderJobKinds[number];
export const isDefenderJobKind=(kind:unknown):kind is DefenderJobKind=>typeof kind==='string'&&(defenderJobKinds as readonly string[]).includes(kind);
export const isDefenderScanKind=(kind:DefenderJobKind)=>kind==='defender-quick-scan'||kind==='defender-full-scan';
/** The right that every Defender action needs on the device. */
export const defenderControlRight='defender.control';

/** Why Defender cannot run the action now, from the last report: steps 7–9 of defenderActionBlock. The server uses only these. */
export type DefenderStateBlock='unavailable'|'scan-running'|'no-detections';
export function defenderStateBlock(snapshot:Pick<ServerSnapshot,'defender'|'defenderScan'>|null|undefined,kind:DefenderJobKind):DefenderStateBlock|null{
 const defender=snapshot?.defender;
 if(!defender||!defender.available||defender.mode==='not-running')return 'unavailable';
 if(isDefenderScanKind(kind)&&snapshot?.defenderScan)return 'scan-running';
 if(kind==='defender-clean-detections'&&defender.activeCount===0)return 'no-detections';
 return null;
}

// ---- Several devices at once (scope tab "Protection") ----
/** At most this many devices per request, as for the bulk removal. */
export const DEFENDER_BULK_MAX=100;
/** The value of the confirmation line "Devices": up to 5 names, then "and N more". */
export function defenderDeviceNames(names:readonly string[],locale:Locale=defaultLocale):string{
 const shown=names.slice(0,5).join(', '),rest=names.length-5;
 return rest>0?translate(locale,'defender.bulk.devicesMore',{names:shown,count:rest}):shown;
}

// ---- After a Defender job ----
/** After a Defender job of the device ends, the area asks for a console refresh this often, for this long. */
export const DEFENDER_REFRESH_EVERY_MS=10_000,DEFENDER_REFRESH_FOR_MS=120_000;
type JobState=Pick<Job,'id'|'serverId'|'action'|'state'>;
const waiting=(state:string|undefined)=>state==='pending'||state==='running';
/**
 * The states of the device's Defender jobs, and whether one of them turned
 * from pending or running to an end state since `previous`.
 */
export function defenderJobTransition(previous:ReadonlyMap<string,string>,jobs:readonly JobState[],serverId:string):{ended:boolean;states:Map<string,string>}{
 const states=new Map<string,string>();let ended=false;
 for(const job of jobs){
  if(job.serverId!==serverId||!isDefenderJobKind(job.action))continue;
  states.set(job.id,job.state);
  if(waiting(previous.get(job.id))&&!waiting(job.state))ended=true;
 }
 return {ended,states};
}
