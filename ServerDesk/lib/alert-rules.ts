// The alert rule catalog: the fixed rules that create the issues on a device,
// their defaults, input ranges, the resolution of overrides along the scope
// chain (default → All devices → customer → parent groups → group → device), the shared
// validation and the evaluation against a device snapshot.
// Pure and without server imports: the console route evaluates the rules here,
// the demo data and the tests use the same functions, and the client validates
// the edit drawer with them. Text lives in lib/alert-rules-text.ts.
import type {MessageKey} from './i18n/translate';
import type {AgentIntegrityEvent,DefenderAvailable,PhysicalDiskHealth,Server,ServerSnapshot} from './types';
import {AGENT_INTEGRITY_STOP_KINDS,AGENT_INTEGRITY_WINDOW_MS} from './agent-integrity-contract';
import {connectionKind} from './device-connection';
import {programCrashCounts} from './reliability';
import {daysLeftUntil,evaluationEnd,graceEnd,notActivated} from './windows-license';

export type AlertLevel='info'|'warning'|'critical';
export type AlertRuleId='cpu'|'memory'|'disk-free'|'disk-latency'|'pagefile'|'processor-queue'|'reboot-pending'|'firewall-off'|'defender-off'|'signatures-age'|'updates-pending'|'inventory-incomplete'|'crash-recent'|'os-support-end'|'os-support-unknown'|'windows-evaluation'|'windows-not-activated'|'bitlocker-system-unencrypted'|'bitlocker-suspended'|'bitlocker-no-recovery-password'
 |'device-problem'|'driver-unsigned'|'stability-low'|'app-crash-repeated'|'disk-health-failed'|'ssd-wear'|'disk-errors'|'battery-capacity'|'cert-expiring'|'cert-expiring-no-key'|'autostart-new'|'autostart-new-suspicious'|'threat-detected'|'scan-age'|'dhcp-scope-full'|'dhcp-service-stopped'|'dns-service-stopped'|'agent-stopped'|'agent-removed'|'agent-protection-changed'|'device-offline';
/**
 * `at-least`: value ≥ threshold, `above`: value > threshold, `below`: value < threshold,
 * `within`: an age in days ≤ threshold, `remaining-at-most`: days left ≤ threshold.
 * below, within and remaining-at-most need warning > critical.
 */
export type AlertComparison='at-least'|'above'|'below'|'within'|'remaining-at-most';
/** count and index are plain numbers (crashes, the stability index 1–10). */
export type AlertUnit='percent'|'ms'|'days'|'perProcessor'|'minutes'|'count'|'index';
/**
 * The complete settings of one rule at one scope. Threshold rules use warning and
 * critical (null: the step is not used) and no level; boolean rules use only level;
 * limit rules use warning as their one threshold, critical null and a level.
 * durationMinutes (how long the rule must fire before an alarm opens) and
 * recovery (how far the reading must recover past the opening threshold before
 * the alarm closes) are set only for the alarm threshold rules
 * (alarmSettingsApply) and null for every other rule.
 */
export type AlertRuleSettings={enabled:boolean;warning:number|null;critical:number|null;level:AlertLevel|null;durationMinutes:number|null;recovery:number|null};
export type AlertScopeType='global'|'customer'|'group'|'device';
type RuleBase={id:AlertRuleId;name:MessageKey;metric:string;live:boolean};
export type ThresholdRule=RuleBase&{kind:'threshold';unit:AlertUnit;comparison:AlertComparison;range:{min:number;max:number};defaults:{enabled:boolean;warning:number|null;critical:number|null;level:null;durationMinutes:number|null;recovery:number|null};description:{both:MessageKey;warningOnly:MessageKey;criticalOnly:MessageKey;/** Used instead of both/criticalOnly when critical is 0 (os-support-end: "once it has ended"). */bothEnded?:MessageKey;criticalOnlyEnded?:MessageKey};/** The thresholds that the descriptions use in the German dative ("in den letzten 30 Tagen"). */dative?:readonly ('warning'|'critical')[]};
export type BooleanRule=RuleBase&{kind:'boolean';unit:null;comparison:null;range:null;defaults:{enabled:true;warning:null;critical:null;level:AlertLevel;durationMinutes:null;recovery:null};description:Record<AlertLevel,MessageKey>};
/**
 * One threshold with a selectable level (battery-capacity): stored as
 * warning=<threshold>, critical=null and level, so it needs no migration. Its
 * descriptions take {threshold}. It has no minimum duration or recovery margin.
 */
export type LimitRule=RuleBase&{kind:'limit';unit:AlertUnit;comparison:'below'|'at-least';range:{min:number;max:number};defaults:{enabled:boolean;warning:number;critical:null;level:AlertLevel;durationMinutes:null;recovery:null};description:Record<AlertLevel,MessageKey>};
export type AlertRule=ThresholdRule|BooleanRule|LimitRule;

/** alarm: the default [minimum duration in minutes, recovery margin in the rule unit]; null for rules without alarm settings. */
const threshold=(id:AlertRuleId,key:string,metric:string,unit:AlertUnit,comparison:AlertComparison,warning:number|null,critical:number|null,min:number,max:number,live:boolean,alarm:[number,number]|null=null,enabled=true):ThresholdRule=>({
 id,kind:'threshold',name:`alertRules.rule.${key}.name` as MessageKey,metric,unit,comparison,live,range:{min,max},defaults:{enabled,warning,critical,level:null,durationMinutes:alarm?alarm[0]:null,recovery:alarm?alarm[1]:null},
 description:{both:`alertRules.rule.${key}.both` as MessageKey,warningOnly:`alertRules.rule.${key}.warningOnly` as MessageKey,criticalOnly:`alertRules.rule.${key}.criticalOnly` as MessageKey},
});
const boolean=(id:AlertRuleId,key:string,metric:string,level:AlertLevel):BooleanRule=>({
 id,kind:'boolean',name:`alertRules.rule.${key}.name` as MessageKey,metric,unit:null,comparison:null,live:false,range:null,defaults:{enabled:true,warning:null,critical:null,level,durationMinutes:null,recovery:null},
 description:{info:`alertRules.rule.${key}.info` as MessageKey,warning:`alertRules.rule.${key}.warning` as MessageKey,critical:`alertRules.rule.${key}.critical` as MessageKey},
});
const limit=(id:AlertRuleId,key:string,metric:string,unit:AlertUnit,comparison:'below'|'at-least',value:number,level:AlertLevel,min:number,max:number):LimitRule=>({
 id,kind:'limit',name:`alertRules.rule.${key}.name` as MessageKey,metric,unit,comparison,live:false,range:{min,max},defaults:{enabled:true,warning:value,critical:null,level,durationMinutes:null,recovery:null},
 description:{info:`alertRules.rule.${key}.info` as MessageKey,warning:`alertRules.rule.${key}.warning` as MessageKey,critical:`alertRules.rule.${key}.critical` as MessageKey},
});
const withEndedText=(rule:ThresholdRule,key:string):ThresholdRule=>({...rule,description:{...rule.description,bothEnded:`alertRules.rule.${key}.bothEnded` as MessageKey,criticalOnlyEnded:`alertRules.rule.${key}.criticalOnlyEnded` as MessageKey}});

/**
 * The 41 rules in catalog order, Device offline last. The defaults of the first
 * 12 are the behavior before rules could be changed. The alarm argument of the
 * alarm threshold rules is [minimum duration in minutes, recovery margin in the rule unit].
 */
export const alertRules:readonly AlertRule[]=[
 threshold('cpu','cpu','snapshot.cpu','percent','at-least',80,90,1,100,true,[5,5]),
 threshold('memory','memory','snapshot.memory','percent','at-least',80,90,1,100,true,[5,5]),
 threshold('disk-free','diskFree','snapshot.disks[].freeGb / totalGb','percent','below',15,5,1,99,false,[0,2]),
 threshold('disk-latency','diskLatency','performance.diskLatencyMs','ms','at-least',50,100,1,60000,true,[5,10]),
 threshold('pagefile','pagefile','performance.pagefilePercent','percent','at-least',80,90,1,100,true,[5,5]),
 threshold('processor-queue','processorQueue','performance.processorQueue / cores','perProcessor','above',2,null,1,100,true,[5,0]),
 boolean('reboot-pending','rebootPending','snapshot.rebootPending','warning'),
 boolean('firewall-off','firewallOff','security.firewall[].enabled','warning'),
 // From agent 4.14.0 both read snapshot.defender (a passive Defender next to another antivirus is not off); older agents keep security.defender.
 boolean('defender-off','defenderOff','defender / security.defender','warning'),
 threshold('signatures-age','signaturesAge','defender.signatureAt / security.defender.signatureAt','days','above',7,null,1,365,false,[0,0]),
 boolean('updates-pending','updatesPending','updates.pendingCount','warning'),
 boolean('inventory-incomplete','inventoryIncomplete','collectionErrors','info'),
 // Health signals of agent 4.10.0 (docs/device-health-signals.md). They stay silent while their snapshot field is absent.
 {...threshold('crash-recent','crashRecent','crashes[].at','days','within',30,7,1,30,false),dative:['warning','critical']},
 {...withEndedText(threshold('os-support-end','osSupportEnd','osSupport.effectiveEnd','days','remaining-at-most',180,0,0,1825,false),'osSupportEnd'),dative:['warning']},
 boolean('os-support-unknown','osSupportUnknown','osSupport.status','info'),
 // Windows activation of agent 4.22.0 (docs/alert-rules.md, lib/windows-license.ts). Silent without
 // snapshot.windowsLicense (older agents) and while it is not available.
 {...withEndedText(threshold('windows-evaluation','windowsEvaluation','windowsLicense.expiresAt / evaluationEndsAt','days','remaining-at-most',180,14,0,365,false),'windowsEvaluation'),dative:['warning']},
 boolean('windows-not-activated','windowsNotActivated','windowsLicense.status','warning'),
 boolean('bitlocker-system-unencrypted','bitlockerSystemUnencrypted','bitlocker.volumes[os].conversion','warning'),
 boolean('bitlocker-suspended','bitlockerSuspended','bitlocker.volumes[].protection','warning'),
 boolean('bitlocker-no-recovery-password','bitlockerNoRecoveryPassword','bitlocker.volumes[].protectors','info'),
 // Health signals of agent 4.11.0 (docs/device-health-signals.md). They stay silent while their field is
 // absent (older agent) or reported as not available. The slow readings (stability index, crash count,
 // wear) have alarm settings that open and close at once by default ([0,0]); the date and limit rules have none.
 boolean('device-problem','deviceProblem','driverHealth.problems','warning'),
 boolean('driver-unsigned','driverUnsigned','driverHealth.unsignedCount','info'),
 threshold('stability-low','stabilityLow','reliability.stability.current','index','below',5,null,1,10,false,[0,0]),
 threshold('app-crash-repeated','appCrashRepeated','reliability.events[crash] per program, 7 days','count','at-least',3,null,1,100,false,[0,0]),
 boolean('disk-health-failed','diskHealthFailed','diskHealth.disks[].health / operationalStatus','critical'),
 threshold('ssd-wear','ssdWear','diskHealth.disks[].wearPercent','percent','at-least',80,95,1,100,false,[0,0]),
 boolean('disk-errors','diskErrors','diskHealth.events.counts','warning'),
 limit('battery-capacity','batteryCapacity','battery.batteries[].healthPercent','percent','below',60,'info',1,99),
 {...threshold('cert-expiring','certExpiring','certificates.items[hasPrivateKey].notAfter','days','remaining-at-most',30,7,0,365,false),dative:['warning']},
 // Off by default: expired intermediate and third-party certificates create no issues.
 {...threshold('cert-expiring-no-key','certExpiringNoKey','certificates.items[!hasPrivateKey].notAfter','days','remaining-at-most',30,7,0,365,false,null,false),dative:['warning']},
 boolean('autostart-new','autostartNew','autostart.newCount - suspiciousNewCount','info'),
 boolean('autostart-new-suspicious','autostartNewSuspicious','autostart.suspiciousNewCount','warning'),
 // Microsoft Defender of agent 4.14.0 (docs/alert-rules.md). Silent for older agents (no snapshot.defender).
 // The issue params hold no detection name, path or user: they reach viewers without defender.read.
 boolean('threat-detected','threatDetected','defender.activeCount','critical'),
 threshold('scan-age','scanAge','defender.quickScanAt / fullScanAt','days','above',7,null,1,365,false,[0,0]),
 // The DHCP plugin (docs/alert-rules.md): the stored read of at most 60 minutes. The issue params hold
 // the scope id and the numbers, no scope name: they reach viewers without dhcp.read.
 threshold('dhcp-scope-full','dhcpScopeFull','dhcp.ipv4.scopes[active].usage.percent','percent','at-least',90,null,1,100,false,[0,5]),
 boolean('dhcp-service-stopped','dhcpServiceStopped','dhcp.service','critical'),
 // The DNS plugin (docs/alert-rules.md): the stored server read of at most 60 minutes, no params.
 boolean('dns-service-stopped','dnsServiceStopped','dns.service','critical'),
 // Agent tamper protection of agent 4.18.0 (docs/alert-rules.md): the stored integrity events of the last 24 hours
 // (or since the last Heartbeat) and snapshot.agentIntegrity. Silent for older agents.
 boolean('agent-stopped','agentStopped','agentIntegrity.events / services[].startType','warning'),
 boolean('agent-removed','agentRemoved','agentIntegrity.events[agent-removed]','critical'),
 boolean('agent-protection-changed','agentProtectionChanged','agentIntegrity.events[protection-changed] / findings','critical'),
 // Whole minutes since the last Heartbeat. It fires only while the device is
 // offline, never while it waits for its first Heartbeat or an agent update runs.
 // Its threshold already is a duration, so it has no minimum duration or recovery margin.
 threshold('device-offline','deviceOffline','lastSeen','minutes','at-least',null,15,3,10080,false),
];
export const alertRuleIds=alertRules.map(rule=>rule.id);
export const alertLevels:readonly AlertLevel[]=['info','warning','critical'];
export const alertScopeTypes:readonly AlertScopeType[]=['global','customer','group','device'];
const byId=new Map<string,AlertRule>(alertRules.map(rule=>[rule.id,rule]));
export const isAlertRuleId=(value:unknown):value is AlertRuleId=>typeof value==='string'&&byId.has(value);
export const isAlertScopeType=(value:unknown):value is AlertScopeType=>typeof value==='string'&&(alertScopeTypes as readonly string[]).includes(value);
export function alertRule(id:AlertRuleId):AlertRule{return byId.get(id)!;}
export type AlertRuleSettingsMap=Record<AlertRuleId,AlertRuleSettings>;
const settingsOf=(rule:AlertRule):AlertRuleSettings=>({enabled:rule.defaults.enabled,warning:rule.defaults.warning,critical:rule.defaults.critical,level:rule.defaults.level,durationMinutes:rule.defaults.durationMinutes,recovery:rule.defaults.recovery});
/**
 * Whether the rule has a minimum duration and a recovery margin: the threshold
 * rules that compare a reading with at-least, above or below, except
 * device-offline. The boolean rules and the age and date rules (crash-recent,
 * os-support-end) open and close their alarm at once.
 */
export function alarmSettingsApply(rule:AlertRule):rule is ThresholdRule{
 return rule.kind==='threshold'&&rule.id!=='device-offline'&&(rule.comparison==='at-least'||rule.comparison==='above'||rule.comparison==='below');
}
/** The longest minimum duration: one day. */
export const maxAlarmDurationMinutes=1440;
/** The default settings of every rule. */
export function defaultAlertSettings():AlertRuleSettingsMap{return Object.fromEntries(alertRules.map(rule=>[rule.id,settingsOf(rule)])) as AlertRuleSettingsMap;}

// ---- Resolution ------------------------------------------------------------

/** One stored override (a row of alert_rule_overrides). */
export type AlertRuleOverride=AlertRuleSettings&{ruleId:AlertRuleId;scopeType:AlertScopeType;scopeId:string;updatedAt:number};
/** One step of the chain after the default, outermost first: global ('*'), the customer, group ancestors, the group, the device. */
export type AlertScope={type:AlertScopeType;id:string};
export type AlertOrigin={type:'default'}|{type:AlertScopeType;id:string};
export type ResolvedAlertRule={settings:AlertRuleSettings;origin:AlertOrigin};
export type ResolvedAlertRules=Record<AlertRuleId,ResolvedAlertRule>;
/**
 * The effective settings per rule: the last override along the chain wins as a
 * whole and is the origin; without one the default applies.
 */
export function resolveAlertRules(overrides:readonly AlertRuleOverride[],chain:readonly AlertScope[]):ResolvedAlertRules{
 const lookup=new Map(overrides.map(row=>[`${row.ruleId}\u0000${row.scopeType}\u0000${row.scopeId}`,row]));
 return Object.fromEntries(alertRules.map(rule=>{
  let resolved:ResolvedAlertRule={settings:settingsOf(rule),origin:{type:'default'}};
  for(const scope of chain){const row=lookup.get(`${rule.id}\u0000${scope.type}\u0000${scope.id}`);if(row)resolved={settings:{enabled:row.enabled,warning:row.warning,critical:row.critical,level:row.level,durationMinutes:row.durationMinutes,recovery:row.recovery},origin:{type:scope.type,id:scope.id}};}
  return [rule.id,resolved];
 })) as ResolvedAlertRules;
}
export function effectiveAlertSettings(resolved:ResolvedAlertRules):AlertRuleSettingsMap{return Object.fromEntries(alertRuleIds.map(id=>[id,resolved[id].settings])) as AlertRuleSettingsMap;}
/**
 * The chain of a device: global, then its customer (when given), then its group
 * path from the outermost group to its own group (`groups` with depth from the
 * root), then the device. Without a customer id the customer step is left out.
 */
export function deviceAlertChain(deviceId:string,groups:readonly {id:string;depth:number}[]=[],customerId?:string|null):AlertScope[]{
 return [{type:'global',id:'*'},...(customerId?[{type:'customer' as const,id:customerId}]:[]),...[...groups].sort((a,b)=>a.depth-b.depth).map(group=>({type:'group' as const,id:group.id})),{type:'device',id:deviceId}];
}

// ---- Wire format of GET /api/alert-rules (lib/server/devices/alert-rule-overrides.ts) ----

/** The origin of a value as the client shows it: its name and whether the viewer can open that scope. */
export type AlertOriginView={type:'default'}|{type:AlertScopeType;id:string;name:string;visible:boolean};
export type AlertRuleRow={ruleId:AlertRuleId;effective:AlertRuleSettings;origin:AlertOriginView;override:(AlertRuleSettings&{updatedAt:number})|null;inherited:{settings:AlertRuleSettings;origin:AlertOriginView}};
/**
 * Why the viewer cannot change the rules on a scope. customer-right: a customer
 * needs the global alerts.manage. read-only is reserved for a portal write gate;
 * no scope sends it yet.
 */
export type AlertEditReason='right'|'customer-right'|'customer-boundary'|'read-only';
export type AlertRuleView={scope:{type:AlertScopeType;id:string;name:string};rules:AlertRuleRow[];canEdit:boolean;reason:AlertEditReason|null};
/** The rule table of a scope without any override, for the sample devices. */
export function defaultAlertRuleView(scope:{type:AlertScopeType;id:string;name:string}):AlertRuleView{
 return {scope,rules:alertRules.map(rule=>({ruleId:rule.id,effective:settingsOf(rule),origin:{type:'default'},override:null,inherited:{settings:settingsOf(rule),origin:{type:'default'}}})),canEdit:false,reason:null};
}

// ---- Validation ------------------------------------------------------------

export type AlertRuleField='ruleId'|'enabled'|'warning'|'critical'|'level'|'durationMinutes'|'recovery';
/**
 * range: not a whole number in range; order/orderBelow: warning not before
 * critical; required: no threshold on an enabled rule, or no minimum duration or
 * recovery margin; recovery: the margin is not below the opening threshold;
 * recoverySum: threshold and margin of a below rule exceed 100 %.
 */
export type AlertValidationCode='unknown-rule'|'enabled'|'range'|'order'|'orderBelow'|'required'|'level'|'not-allowed'|'recovery'|'recoverySum';
export type AlertValidationError={field:AlertRuleField;code:AlertValidationCode};
export type AlertRuleInput={enabled?:unknown;warning?:unknown;critical?:unknown;level?:unknown;durationMinutes?:unknown;recovery?:unknown};
export type AlertValidation={ok:true;ruleId:AlertRuleId;settings:AlertRuleSettings}|{ok:false;errors:AlertValidationError[]};
const absent=(value:unknown)=>value===undefined||value===null;
/**
 * The one validation of the server and the edit drawer. A disabled rule keeps its
 * values (they are validated the same way) but needs no threshold.
 */
export function validateAlertRuleSettings(ruleId:unknown,input:AlertRuleInput):AlertValidation{
 if(!isAlertRuleId(ruleId))return {ok:false,errors:[{field:'ruleId',code:'unknown-rule'}]};
 const rule=alertRule(ruleId),errors:AlertValidationError[]=[];
 if(typeof input.enabled!=='boolean')errors.push({field:'enabled',code:'enabled'});
 const enabled=input.enabled===true;
 if(rule.kind==='threshold'){
  if(!absent(input.level))errors.push({field:'level',code:'not-allowed'});
  const number=(field:'warning'|'critical'):number|null=>{
   const value=input[field];if(absent(value))return null;
   if(typeof value!=='number'||!Number.isInteger(value)||value<rule.range.min||value>rule.range.max){errors.push({field,code:'range'});return null;}
   return value;
  };
  const warning=number('warning'),critical=number('critical');
  if(enabled&&absent(input.warning)&&absent(input.critical))errors.push({field:'warning',code:'required'});
  const descending=rule.comparison==='below'||rule.comparison==='within'||rule.comparison==='remaining-at-most';
  if(warning!==null&&critical!==null&&(descending?warning<=critical:warning>=critical))errors.push({field:'critical',code:descending?'orderBelow':'order'});
  let durationMinutes:number|null=null,recovery:number|null=null;
  if(alarmSettingsApply(rule)){
   const whole=(field:'durationMinutes'|'recovery',max:number):number|null=>{
    const value=input[field];
    if(absent(value)){errors.push({field,code:'required'});return null;}
    if(typeof value!=='number'||!Number.isInteger(value)||value<0||value>max){errors.push({field,code:'range'});return null;}
    return value;
   };
   durationMinutes=whole('durationMinutes',maxAlarmDurationMinutes);recovery=whole('recovery',rule.range.max);
   // The margin is relative to the opening threshold: warning if set, else critical.
   const opening=warning??critical;
   if(recovery!==null&&opening!==null){
    if(rule.comparison==='below'){if(rule.unit==='percent'&&opening+recovery>100)errors.push({field:'recovery',code:'recoverySum'});}
    else if(recovery>=opening)errors.push({field:'recovery',code:'recovery'});
   }
  }else{
   if(!absent(input.durationMinutes))errors.push({field:'durationMinutes',code:'not-allowed'});
   if(!absent(input.recovery))errors.push({field:'recovery',code:'not-allowed'});
  }
  if(errors.length)return {ok:false,errors};
  return {ok:true,ruleId,settings:{enabled,warning,critical,level:null,durationMinutes,recovery}};
 }
 const validLevel=typeof input.level==='string'&&(alertLevels as readonly string[]).includes(input.level);
 if(rule.kind==='limit'){
  // One threshold (stored in warning) plus a level; critical, duration and margin do not apply.
  let value:number|null=null;
  if(absent(input.warning)){if(enabled)errors.push({field:'warning',code:'required'});}
  else if(typeof input.warning!=='number'||!Number.isInteger(input.warning)||input.warning<rule.range.min||input.warning>rule.range.max)errors.push({field:'warning',code:'range'});
  else value=input.warning;
  if(!absent(input.critical))errors.push({field:'critical',code:'not-allowed'});
  if(!absent(input.durationMinutes))errors.push({field:'durationMinutes',code:'not-allowed'});
  if(!absent(input.recovery))errors.push({field:'recovery',code:'not-allowed'});
  if(!validLevel)errors.push({field:'level',code:'level'});
  if(errors.length)return {ok:false,errors};
  return {ok:true,ruleId,settings:{enabled,warning:value,critical:null,level:input.level as AlertLevel,durationMinutes:null,recovery:null}};
 }
 if(!absent(input.warning))errors.push({field:'warning',code:'not-allowed'});
 if(!absent(input.critical))errors.push({field:'critical',code:'not-allowed'});
 if(!absent(input.durationMinutes))errors.push({field:'durationMinutes',code:'not-allowed'});
 if(!absent(input.recovery))errors.push({field:'recovery',code:'not-allowed'});
 if(!validLevel)errors.push({field:'level',code:'level'});
 if(errors.length)return {ok:false,errors};
 return {ok:true,ruleId,settings:{enabled,warning:null,critical:null,level:input.level as AlertLevel,durationMinutes:null,recovery:null}};
}
export const sameAlertSettings=(a:AlertRuleSettings,b:AlertRuleSettings)=>a.enabled===b.enabled&&a.warning===b.warning&&a.critical===b.critical&&a.level===b.level&&a.durationMinutes===b.durationMinutes&&a.recovery===b.recovery;

// ---- Evaluation ------------------------------------------------------------

/** null only where a rule documents it (scan-age: scanAt null when Defender never reported a scan). */
export type AlertIssueParams=Record<string,string|number|string[]|null>;
/** One issue as the server sends it: no text, only the raw values the text needs (ui/base/ui-device.ts formats it). */
export type AlertIssue={key:string;ruleId:AlertRuleId;level:AlertLevel;live:boolean;params:AlertIssueParams};
const levelRank:Record<AlertLevel,number>={critical:0,warning:1,info:2};
const dayMs=86400000;
// The step that fires: critical before warning. `passes` compares the reading with one threshold.
function firedLevel(settings:AlertRuleSettings,passes:(threshold:number)=>boolean):{level:AlertLevel;threshold:number}|null{
 if(settings.critical!==null&&passes(settings.critical))return {level:'critical',threshold:settings.critical};
 if(settings.warning!==null&&passes(settings.warning))return {level:'warning',threshold:settings.warning};
 return null;
}
/**
 * The issues of one device under the given settings at `now`, sorted critical →
 * warning → info (stable within a level). Live rules fire only while the device
 * is online. Without a snapshot only Device offline can fire. A partial snapshot (a missing
 * list) never throws: the console answer must not fail because of one device.
 */
/** The DHCP data are read only while they are at most this old (four collection cycles). */
export const DHCP_ALERT_MAX_AGE_MS=60*60_000;
/** The stored DHCP data when they are fresh enough for the DHCP rules, else null. */
export const freshDhcpAlerts=(data:Server['dhcpAlerts'],now:number)=>data&&data.collectedAt>=now-DHCP_ALERT_MAX_AGE_MS?data:null;
/** The stored DNS data when they are fresh enough (the same 60 minutes) for the DNS rule, else null. */
export const freshDnsAlerts=(data:Server['dnsAlerts'],now:number)=>data&&data.collectedAt>=now-DHCP_ALERT_MAX_AGE_MS?data:null;
export function evaluateAlertRules(server:Pick<Server,'snapshot'|'lastSeen'|'maintenance'|'osSupport'|'autostart'|'dhcpAlerts'|'dnsAlerts'|'agentIntegrity'>,settings:AlertRuleSettingsMap,now:number):AlertIssue[]{
 const issues:AlertIssue[]=[],kind=connectionKind(server,now),online=kind==='online';
 const add=(ruleId:AlertRuleId,key:string,level:AlertLevel,params:AlertIssueParams)=>issues.push({key,ruleId,level,live:alertRule(ruleId).live,params});
 // Device offline: whole minutes since the last Heartbeat, only while the device is offline.
 if(settings['device-offline'].enabled&&kind==='offline'&&server.lastSeen){
  const minutes=offlineMinutes(server.lastSeen,now),fired=firedLevel(settings['device-offline'],threshold=>minutes>=threshold);
  if(fired)add('device-offline','offline',fired.level,{lastSeen:server.lastSeen,minutes});
 }
 // Agent tamper protection: the events also count while the device sends no Heartbeat.
 for(const issue of agentIntegrityIssues(server,now)){const own=settings[issue.ruleId];if(own.enabled)add(issue.ruleId,issue.key,own.level??alertRule(issue.ruleId).defaults.level??'warning',issue.params);}
 const s=server.snapshot;if(!s)return issues;
 const active=(id:AlertRuleId)=>{const rule=alertRule(id);return settings[id].enabled&&(!rule.live||online);};
 const atLeast=(id:AlertRuleId,key:string,value:number|null|undefined)=>{
  if(!active(id)||typeof value!=='number')return;
  const fired=firedLevel(settings[id],threshold=>value>=threshold);if(fired)add(id,key,fired.level,{value});
 };
 const flag=(id:AlertRuleId,key:string,condition:boolean,params:AlertIssueParams={})=>{if(active(id)&&condition)add(id,key,settings[id].level??alertRule(id).defaults.level??'warning',params);};
 // The order of the checks is the order of the former deviceIssues; the sort below keeps it within a level.
 atLeast('cpu','cpu',s.cpu);
 atLeast('memory','memory',s.memory);
 const list=<T,>(value:T[]|undefined|null):T[]=>Array.isArray(value)?value:[];
 if(active('disk-free'))for(const disk of list(s.disks)){
  if(!(disk.totalGb>0))continue;
  const ratio=disk.freeGb/disk.totalGb,fired=firedLevel(settings['disk-free'],threshold=>ratio<threshold/100);
  if(fired)add('disk-free','disk-'+disk.name,fired.level,{name:disk.name,freeGb:disk.freeGb,totalGb:disk.totalGb});
 }
 flag('reboot-pending','reboot',!!s.rebootPending,{reasons:[...list(s.rebootReasons)]});
 const p=s.performance;
 atLeast('disk-latency','latency',p?.diskLatencyMs);
 atLeast('pagefile','pagefile',p?.pagefilePercent);
 if(active('processor-queue')&&p?.processorQueue!=null&&s.cores>0){
  const queue=p.processorQueue,fired=firedLevel(settings['processor-queue'],threshold=>queue>s.cores*threshold);
  if(fired)add('processor-queue','queue',fired.level,{threads:queue,cores:s.cores});
 }
 const profiles=list(s.security?.firewall).filter(profile=>!profile.enabled);
 flag('firewall-off','firewall',profiles.length>0,{profiles:profiles.map(profile=>profile.name)});
 const defender=s.security?.defender,full=reportedDefender(s);
 // With snapshot.defender (agent 4.14.0) a passive Defender or one next to an enabled other antivirus is covered, not off.
 if(s.defender)flag('defender-off','defender',!!full&&!defenderCovered(full)&&(!full.antivirusEnabled||!full.realTimeProtection));
 else flag('defender-off','defender',!!defender?.available&&(!defender.enabled||!defender.realTimeProtection));
 const signatureAt=defenderSignatureAt(s);
 if(active('signatures-age')&&signatureAt){
  const age=now-Date.parse(signatureAt),fired=firedLevel(settings['signatures-age'],threshold=>age>threshold*dayMs);
  if(fired)add('signatures-age','signatures',fired.level,{signatureAt,threshold:fired.threshold});
 }
 const updates=s.updates;
 flag('updates-pending','updates',!!updates?.checkedAt&&updates.pendingCount>0,updates?{count:updates.pendingCount,checkedAt:updates.checkedAt}:{});
 const errors=list(s.collectionErrors);
 flag('inventory-incomplete','collection',errors.length>0,{errors:[...errors]});
 // ---- Health signals (agent 4.10.0); an absent field creates no issue ----
 const crashes=list(s.crashes).filter(crash=>Number.isFinite(Date.parse(crash.at)));
 if(active('crash-recent')&&crashes.length){
  const crashSettings=settings['crash-recent'],newest=crashes.reduce((a,b)=>Date.parse(b.at)>Date.parse(a.at)?b:a),age=now-Date.parse(newest.at);
  const fired=firedLevel(crashSettings,threshold=>age<=threshold*dayMs);
  if(fired){
   const params:AlertIssueParams={at:newest.at,kind:newest.kind};
   if(newest.stopCode!=null)params.stopCode=newest.stopCode;
   if(newest.driver?.name){
    params.driver=newest.driver.name;
    // Crashes pile up: the same driver (case-insensitive) at least twice inside the warning window.
    const windowDays=crashSettings.warning??crashSettings.critical??30,name=newest.driver.name.toLowerCase();
    const same=crashes.filter(crash=>crash.driver?.name?.toLowerCase()===name&&now-Date.parse(crash.at)<=windowDays*dayMs);
    if(same.length>=2){const oldest=Math.min(...same.map(crash=>Date.parse(crash.at)));params.sameDriverCount=same.length;params.sameDriverDays=Math.max(1,Math.ceil((now-oldest)/dayMs));}
   }
   add('crash-recent','crash',fired.level,params);
  }
 }
 const support=server.osSupport;
 if(active('os-support-end')&&support?.entry&&support.effectiveEnd){
  const left=osSupportDaysLeft(support.effectiveEnd,now),fired=firedLevel(settings['os-support-end'],threshold=>left<=threshold);
  if(fired)add('os-support-end','os-support',fired.level,{product:`${support.entry.product} ${support.entry.version}`.trim(),date:support.effectiveEnd,daysLeft:left});
 }
 const osInfo=s.osInfo;
 flag('os-support-unknown','os-support-unknown',!!osInfo&&support?.status==='unknown'&&support.reason==='no-entry',{product:osInfo?.productName??s.os??'',version:osInfo?.displayVersion??'',build:osInfo?.currentBuild??s.build??''});
 // ---- Windows activation (agent 4.22.0); silent without the field or while it is not available ----
 const license=s.windowsLicense;
 if(license?.available){
  const end=evaluationEnd(license,osInfo,now),own=settings['windows-evaluation'],product=osInfo?.productName??s.os??'';
  if(active('windows-evaluation')&&end){
   // Without a reported end the evaluation still needs a full license: the warning step, if set.
   if(end.state==='unknown'){if(own.warning!==null)add('windows-evaluation','windows-evaluation','warning',{product,date:null,daysLeft:null,ended:'false'});}
   else{
    const fired=firedLevel(own,threshold=>end.daysLeft<=threshold);
    if(fired)add('windows-evaluation','windows-evaluation',fired.level,{product,date:end.date,daysLeft:end.daysLeft,ended:end.state==='ended'?'true':'false'});
   }
  }
  const grace=graceEnd(license);
  flag('windows-not-activated','windows-not-activated',notActivated(license),{status:license.status,channel:license.channel,date:grace,daysLeft:grace?daysLeftUntil(grace,now):null});
 }
 const bitlocker=s.bitlocker;
 if(bitlocker?.available){
  const volumes=list(bitlocker.volumes),system=volumes.find(volume=>volume.volumeType==='os');
  flag('bitlocker-system-unencrypted','bitlocker-system',!!system&&(['decrypted','decrypting','paused-decrypting'] as string[]).includes(system.conversion),{drive:system?.drive??''});
  volumes.forEach((volume,index)=>{if(volume.protection==='suspended')flag('bitlocker-suspended','bitlocker-suspended-'+(volume.drive??String(index)),true,volume.suspendedSince?{drive:volume.drive??'',suspendedSince:volume.suspendedSince}:{drive:volume.drive??''});});
  volumes.forEach((volume,index)=>{
   const encrypted=(['encrypted','encrypting','paused-encrypting'] as string[]).includes(volume.conversion);
   if((volume.volumeType==='os'||volume.volumeType==='fixed')&&encrypted&&!list(volume.protectors).includes('numerical-password'))flag('bitlocker-no-recovery-password','bitlocker-recovery-'+(volume.drive??String(index)),true,{drive:volume.drive??''});
  });
 }
 // ---- Health signals (agent 4.11.0); an absent or unavailable field creates no issue ----
 const drivers=s.driverHealth;
 if(drivers){
  const problems=list(drivers.problems);
  if(problems.length){const first=problems[0];flag('device-problem','device-problem',true,{count:problems.length,name:first.name,code:first.code,more:problems.length-1});}
  const unsigned=list(drivers.unsigned);
  flag('driver-unsigned','driver-unsigned',drivers.unsignedCount>0,{count:drivers.unsignedCount,names:unsigned.slice(0,3).map(driver=>driver.infName??driver.file??driver.deviceName)});
 }
 const reliability=s.reliability;
 if(active('stability-low')&&reliability?.stability?.available&&typeof reliability.stability.current==='number'){
  const index=reliability.stability.current,fired=firedLevel(settings['stability-low'],threshold=>index<threshold);
  if(fired)add('stability-low','stability',fired.level,{index});
 }
 if(active('app-crash-repeated')&&reliability)for(const program of programCrashCounts(list(reliability.events),now,7)){
  const fired=firedLevel(settings['app-crash-repeated'],threshold=>program.count>=threshold);
  if(fired)add('app-crash-repeated','app-crash-'+program.key,fired.level,{program:program.program,count:program.count,days:7});
 }
 const diskHealth=s.diskHealth;
 if(diskHealth){
  const disks=list(diskHealth.disks);
  for(const disk of disks){
   const status=list(disk.operationalStatus),failed=disk.health==='warning'||disk.health==='unhealthy'||status.includes('predictive-failure')||status.includes('failed');
   flag('disk-health-failed','disk-health-'+disk.id,failed,{name:diskLabel(disk),health:disk.health,status:[...status]});
  }
  if(active('ssd-wear'))for(const disk of disks){
   const wear=disk.wearPercent;if(typeof wear!=='number')continue;
   const fired=firedLevel(settings['ssd-wear'],threshold=>wear>=threshold);
   if(fired)add('ssd-wear','ssd-wear-'+disk.id,fired.level,{name:diskLabel(disk),percent:wear});
  }
  const counts=diskHealth.events?.counts??{};
  for(const [key,count] of Object.entries(counts)){
   if(!(typeof count==='number'&&count>0))continue;
   const disk=key==='unknown'?undefined:disks.find(item=>item.number===Number(key));
   flag('disk-errors','disk-errors-'+key,true,{disk:key,name:disk?diskLabel(disk):'',count});
  }
 }
 const battery=s.battery;
 if(active('battery-capacity')&&battery?.present){
  const own=settings['battery-capacity'],threshold=own.warning;
  if(threshold!==null)for(const item of list(battery.batteries)){
   const percent=item.healthPercent;
   if(typeof percent!=='number'||!(percent<threshold))continue;
   const params:AlertIssueParams={percent};
   if(item.fullChargeCapacityMWh!=null)params.full=item.fullChargeCapacityMWh;
   if(item.designCapacityMWh!=null)params.design=item.designCapacityMWh;
   add('battery-capacity','battery-'+item.id,own.level??'info',params);
  }
 }
 const certificates=s.certificates;
 if(certificates){
  const seen=new Set<string>();
  for(const cert of list(certificates.items)){
   if(seen.has(cert.thumbprint)||!Number.isFinite(Date.parse(cert.notAfter)))continue;
   seen.add(cert.thumbprint);
   const id:AlertRuleId=cert.hasPrivateKey?'cert-expiring':'cert-expiring-no-key';
   if(!active(id))continue;
   const left=certificateDaysLeft(cert.notAfter,now),fired=firedLevel(settings[id],threshold=>left<=threshold);
   if(fired)add(id,'cert-'+cert.thumbprint,fired.level,{subject:cert.subject,notAfter:cert.notAfter,daysLeft:left,stores:[...list(cert.stores)]});
  }
 }
 const autostart=server.autostart;
 if(autostart){
  const fresh=list(autostart.newEntries),plain=autostart.newCount-autostart.suspiciousNewCount;
  flag('autostart-new','autostart-new',plain>0,{count:plain,names:fresh.filter(entry=>!entry.suspicious).slice(0,3).map(entry=>entry.name)});
  flag('autostart-new-suspicious','autostart-suspicious',autostart.suspiciousNewCount>0,{count:autostart.suspiciousNewCount,names:fresh.filter(entry=>entry.suspicious).slice(0,3).map(entry=>entry.name)});
 }
 // ---- The DHCP plugin: fresh stored data only; the scope id and numbers, never the scope name ----
 const dhcp=freshDhcpAlerts(server.dhcpAlerts,now);
 if(dhcp){
  if(active('dhcp-scope-full'))for(const scope of dhcp.scopes){
   if(scope.state!=='active'||!(scope.total>0))continue;
   const fired=firedLevel(settings['dhcp-scope-full'],threshold=>scope.percent>=threshold);
   if(fired)add('dhcp-scope-full','dhcp-scope-'+scope.scopeId,fired.level,{scope:scope.scopeId,inUse:scope.inUse,total:scope.total,percent:scope.percent});
  }
  flag('dhcp-service-stopped','dhcp-service',dhcp.service==='stopped');
 }
 // ---- The DNS plugin: fresh stored data only ----
 const dns=freshDnsAlerts(server.dnsAlerts,now);
 if(dns)flag('dns-service-stopped','dns-service',dns.service==='stopped');
 // ---- Microsoft Defender (agent 4.14.0); only counts and times, never a name, path or user ----
 if(full){
  flag('threat-detected','threats',full.activeCount>0,{count:full.activeCount,severity:full.highestActiveSeverity??'unknown'});
  if(active('scan-age')&&full.mode==='normal'){
   const scan=defenderLastScan(full),own=settings['scan-age'];
   if(scan===null){
    // Never scanned: the highest set level, without a reading, so an open alarm stays open.
    const level:AlertLevel|null=own.critical!==null?'critical':own.warning!==null?'warning':null;
    if(level)add('scan-age','scan',level,{scanAt:null,threshold:own[level]!});
   }else{
    const age=now-Date.parse(scan),fired=firedLevel(own,threshold=>age>threshold*dayMs);
    if(fired)add('scan-age','scan',fired.level,{scanAt:scan,threshold:fired.threshold});
   }
  }
 }
 return issues.sort((a,b)=>levelRank[a.level]-levelRank[b.level]);
}
/** One issue of the three agent rules before the settings: rule, key and params. */
export type AgentIntegrityIssue={ruleId:'agent-stopped'|'agent-removed'|'agent-protection-changed';key:string;params:AlertIssueParams};
const integrityStopKinds:readonly string[]=AGENT_INTEGRITY_STOP_KINDS;
/** The key of a protection issue: the target and the service, or "folder" for a folder target. */
export const agentProtectionKey=(target:string,service:string|null|undefined)=>'agent-protection-'+target+'-'+(target.startsWith('folder-')?'folder':service??'broker');
/**
 * The issues of the three agent rules (docs/alert-rules.md, "Agent tamper protection"):
 * - agent-stopped, key agent-stopped: a stop, end, hang, watchdog restart or broker outage
 *   reached the portal in the last 24 hours, or the newest service-stopped or
 *   broker-unresponsive event came after the last Heartbeat. Params of the newest such event.
 * - agent-stopped, key agent-start-type-<service>: the snapshot reports manual, disabled or
 *   unknown, or the newest start-type-changed event of the service came after the last Heartbeat.
 * - agent-removed: the newest agent-removed event is less than 24 hours old or came after the last Heartbeat.
 * - agent-protection-changed, key agent-protection-<target>-<service|folder>: each
 *   protection-changed event of the last 24 hours and each open snapshot finding (which wins).
 * Silent without events and without snapshot.agentIntegrity (older agents). Pure.
 */
export function agentIntegrityIssues(server:Pick<Server,'snapshot'|'lastSeen'|'agentIntegrity'>,now:number):AgentIntegrityIssue[]{
 const order=(a:AgentIntegrityEvent,b:AgentIntegrityEvent)=>a.receivedAt-b.receivedAt||a.occurredAt-b.occurredAt;
 const events=[...(server.agentIntegrity?.events??[])].sort(order),snapshot=server.snapshot?.agentIntegrity;
 const issues:AgentIntegrityIssue[]=[],windowStart=now-AGENT_INTEGRITY_WINDOW_MS,lastSeen=server.lastSeen??0;
 const recent=(event:AgentIntegrityEvent)=>event.receivedAt>=windowStart,afterHeartbeat=(event:AgentIntegrityEvent)=>event.receivedAt>lastSeen;
 const newest=(match:(event:AgentIntegrityEvent)=>boolean)=>events.filter(match).at(-1);
 // Stopped, ended, hung, restarted or unresponsive.
 const causes=events.filter(event=>integrityStopKinds.includes(event.kind)&&recent(event));
 const silent=newest(event=>event.kind==='service-stopped'||event.kind==='broker-unresponsive');
 if(silent&&afterHeartbeat(silent)&&!causes.includes(silent))causes.push(silent);
 const cause=causes.sort(order).at(-1);
 if(cause)issues.push({ruleId:'agent-stopped',key:'agent-stopped',params:{kind:cause.kind,service:cause.service,at:cause.occurredAt}});
 // The start type of each service.
 for(const service of ['broker','worker'] as const){
  const reported=snapshot?.services?.find(item=>item.service===service)?.startType;
  const changed=newest(event=>event.kind==='start-type-changed'&&event.service===service);
  const startType=reported==='manual'||reported==='disabled'||reported==='unknown'?reported:changed&&afterHeartbeat(changed)?changed.startType??'unknown':null;
  if(startType)issues.push({ruleId:'agent-stopped',key:'agent-start-type-'+service,params:{service,startType}});
 }
 const removed=newest(event=>event.kind==='agent-removed');
 if(removed&&(recent(removed)||afterHeartbeat(removed))){
  const params:AlertIssueParams={reason:removed.reason??'service-deleted',at:removed.occurredAt};
  if(removed.user)params.user=removed.user;
  issues.push({ruleId:'agent-removed',key:'agent-removed',params});
 }
 // One issue per target and service (or folder): the newest event, then an open snapshot finding over it.
 const protection=new Map<string,AlertIssueParams>();
 for(const event of events)if(event.kind==='protection-changed'&&event.target&&recent(event)){
  const params:AlertIssueParams={target:event.target,at:event.occurredAt,repaired:event.repaired===true?'true':'false'};
  if(event.service)params.service=event.service;
  protection.set(agentProtectionKey(event.target,event.service),params);
 }
 const checkedAt=snapshot?Date.parse(snapshot.checkedAt):Number.NaN;
 for(const finding of snapshot?.findings??[]){
  const params:AlertIssueParams={target:finding.target,at:Number.isFinite(checkedAt)?checkedAt:now,repaired:'false'};
  if(finding.service)params.service=finding.service;
  protection.set(agentProtectionKey(finding.target,finding.service),params);
 }
 for(const [key,params] of protection)issues.push({ruleId:'agent-protection-changed',key,params});
 return issues;
}
/** snapshot.defender when the agent read Defender (available), else null. */
export const reportedDefender=(s:Pick<ServerSnapshot,'defender'>):DefenderAvailable|null=>s.defender?.available?s.defender:null;
/** Passive, side-by-side passive and EDR block mode, or any enabled other antivirus: another product protects the device. */
export const defenderCovered=(defender:Pick<DefenderAvailable,'mode'|'otherAntivirus'>)=>defender.mode==='passive'||defender.mode==='sxs-passive'||defender.mode==='edr-block'||(defender.otherAntivirus??[]).some(product=>product.enabled);
/** The newer of the last quick and full scan (ISO), or null. */
export function defenderLastScan(defender:Pick<DefenderAvailable,'quickScanAt'|'fullScanAt'>):string|null{
 const times=[defender.quickScanAt,defender.fullScanAt].filter((value):value is string=>!!value&&Number.isFinite(Date.parse(value)));
 return times.length?times.reduce((a,b)=>Date.parse(b)>Date.parse(a)?b:a):null;
}
/** The signature time of signatures-age: snapshot.defender when the agent sends it, else security.defender (older agents). */
function defenderSignatureAt(s:Pick<ServerSnapshot,'defender'|'security'>):string|null{
 const at=s.defender?(s.defender.available?s.defender.signatureAt:null):s.security?.defender?.available?s.security.defender.signatureAt:null;
 return at&&Number.isFinite(Date.parse(at))?at:null;
}
/** The name of a disk in an issue: its model, else its disk number, else its ID. */
export const diskLabel=(disk:Pick<PhysicalDiskHealth,'model'|'number'|'id'>)=>disk.model.trim()||(disk.number!==null?String(disk.number):disk.id);
/**
 * Whole days left until a certificate expires (notAfter), rounded up; 0 or
 * less once it has expired.
 */
export function certificateDaysLeft(notAfter:string,now:number):number{
 return daysLeftUntil(notAfter,now);
}
/**
 * Whole days left until an end date (YYYY-MM-DD; support ends at 00:00 UTC of
 * that day), rounded up; 0 on or after that moment.
 */
export function osSupportDaysLeft(endDate:string,now:number):number{
 const end=Date.parse(endDate+'T00:00:00Z');
 return now>=end?0:Math.ceil((end-now)/dayMs);
}
/** Whole minutes since the last Heartbeat. */
export const offlineMinutes=(lastSeen:number,now:number)=>Math.max(0,Math.floor((now-lastSeen)/60000));

/** The reading of one threshold rule and issue key, in the rule unit. */
export type AlertReading={ruleId:AlertRuleId;key:string;value:number};
/**
 * The numeric reading per threshold rule and issue key at `now`, also when the
 * rule does not fire and whatever the settings: CPU, memory and page file in %,
 * free space in % per volume, disk latency in ms, threads per processor, the
 * signature age and the age of the newest crash in days, the days left of OS
 * support, of a Windows evaluation and of every certificate, the minutes since the last Heartbeat, the
 * stability index, the crashes per program, the SSD wear and the battery health. The alarm state
 * (lib/server/devices/alert-state.ts) uses it for the peak and the recovery margin. Live
 * readings are returned whether the device is online or not; the alarm state
 * decides. A missing value has no reading.
 */
export function alertReadings(server:Pick<Server,'snapshot'|'lastSeen'|'osSupport'|'dhcpAlerts'>,now:number):AlertReading[]{
 const readings:AlertReading[]=[];
 const add=(ruleId:AlertRuleId,key:string,value:number|null|undefined)=>{if(typeof value==='number'&&Number.isFinite(value))readings.push({ruleId,key,value});};
 if(server.lastSeen)add('device-offline','offline',offlineMinutes(server.lastSeen,now));
 const s=server.snapshot;if(!s)return readings;
 const list=<T,>(value:T[]|undefined|null):T[]=>Array.isArray(value)?value:[];
 add('cpu','cpu',s.cpu);
 add('memory','memory',s.memory);
 for(const disk of list(s.disks))if(disk.totalGb>0)add('disk-free','disk-'+disk.name,disk.freeGb/disk.totalGb*100);
 const p=s.performance;
 add('disk-latency','latency',p?.diskLatencyMs);
 add('pagefile','pagefile',p?.pagefilePercent);
 if(p?.processorQueue!=null&&s.cores>0)add('processor-queue','queue',p.processorQueue/s.cores);
 const signatureAt=defenderSignatureAt(s),full=reportedDefender(s);
 if(signatureAt)add('signatures-age','signatures',(now-Date.parse(signatureAt))/dayMs);
 const scan=full?.mode==='normal'?defenderLastScan(full):null;
 if(scan)add('scan-age','scan',(now-Date.parse(scan))/dayMs);
 const crashes=list(s.crashes).map(crash=>Date.parse(crash.at)).filter(Number.isFinite);
 if(crashes.length)add('crash-recent','crash',(now-Math.max(...crashes))/dayMs);
 const support=server.osSupport;
 if(support?.entry&&support.effectiveEnd)add('os-support-end','os-support',osSupportDaysLeft(support.effectiveEnd,now));
 // The days left of a Windows evaluation; past its end the alarm peak says "N days overdue".
 const end=evaluationEnd(s.windowsLicense,s.osInfo,now);
 if(end&&end.state!=='unknown')add('windows-evaluation','windows-evaluation',end.daysLeft);
 // Health signals of 4.11.0: the stability index, crashes per program in 7 days, the wear per disk,
 // the battery percent and the days left per certificate.
 const stability=s.reliability?.stability;
 if(stability?.available)add('stability-low','stability',stability.current);
 for(const program of programCrashCounts(list(s.reliability?.events),now,7))add('app-crash-repeated','app-crash-'+program.key,program.count);
 for(const disk of list(s.diskHealth?.disks))add('ssd-wear','ssd-wear-'+disk.id,disk.wearPercent);
 if(s.battery?.present)for(const item of list(s.battery.batteries))add('battery-capacity','battery-'+item.id,item.healthPercent);
 const seen=new Set<string>();
 for(const cert of list(s.certificates?.items)){
  if(seen.has(cert.thumbprint)||!Number.isFinite(Date.parse(cert.notAfter)))continue;
  seen.add(cert.thumbprint);add(cert.hasPrivateKey?'cert-expiring':'cert-expiring-no-key','cert-'+cert.thumbprint,certificateDaysLeft(cert.notAfter,now));
 }
 // The percent in use of every active IPv4 DHCP scope with addresses, from fresh stored data.
 for(const scope of freshDhcpAlerts(server.dhcpAlerts,now)?.scopes??[])if(scope.state==='active'&&scope.total>0)add('dhcp-scope-full','dhcp-scope-'+scope.scopeId,scope.percent);
 return readings;
}
