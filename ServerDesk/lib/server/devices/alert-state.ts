// The alarm state machine: from the issues and readings of one evaluation
// (lib/alert-rules.ts) and the device's alarms that are not closed yet, the rows
// to insert, update, close and delete. Pure and without server imports, so the
// tests run it without a database; lib/server/devices/alerts.ts applies the result in one
// transaction per device. docs/alert-rules.md describes the rules.
import {alarmSettingsApply,alertRule,isAlertRuleId,type AlertIssue,type AlertIssueParams,type AlertLevel,type AlertReading,type AlertRule,type AlertRuleId,type AlertRuleSettingsMap} from '../../alert-rules';
import {connectionKind} from '../../device-connection';
import type {Server} from '../../types';

export type AlertState='pending'|'open'|'closed';
export type AlertCloseReason='recovered'|'rule-off'|'no-data';
/** One alarm that is not closed, as lib/server/devices/alerts.ts reads it. */
export type ActiveAlert={
 id:string;ruleId:string;key:string;state:'pending'|'open';level:AlertLevel;peakLevel:AlertLevel;peakValue:number|null;threshold:number|null;
 params:AlertIssueParams;startedAt:number;openedAt:number|null;acknowledgedAt:number|null;
};
export type AlertInsert={ruleId:AlertRuleId;key:string;state:'pending'|'open';level:AlertLevel;peakLevel:AlertLevel;peakValue:number|null;threshold:number|null;params:AlertIssueParams;startedAt:number;openedAt:number|null};
/** The new values of a changed alarm; clearAcknowledgement after an escalation. */
export type AlertUpdate={id:string;state:'pending'|'open';level:AlertLevel;peakLevel:AlertLevel;peakValue:number|null;threshold:number|null;params:AlertIssueParams;openedAt:number|null;clearAcknowledgement:boolean};
export type AlertClose={id:string;reason:AlertCloseReason};
export type AlertTransitions={inserts:AlertInsert[];updates:AlertUpdate[];closes:AlertClose[];
 /** Pending alarms whose rule stopped firing before the minimum duration: deleted, no history entry. */
 deletes:string[]};
export type AlertEvaluation={
 server:Pick<Server,'snapshot'|'lastSeen'|'maintenance'>;
 alerts:readonly ActiveAlert[];
 issues:readonly AlertIssue[];
 readings:readonly AlertReading[];
 settings:AlertRuleSettingsMap;
 now:number;
};

const rank:Record<AlertLevel,number>={info:0,warning:1,critical:2};
const minuteMs=60000;
const slot=(ruleId:string,key:string)=>`${ruleId}\u0000${key}`;
/** Lower readings are worse for below, within and remaining-at-most; higher ones for at-least and above. */
const lowerIsWorse=(rule:AlertRule)=>rule.kind!=='boolean'&&(rule.comparison==='below'||rule.comparison==='within'||rule.comparison==='remaining-at-most');
function worse(rule:AlertRule,current:number|null,reading:number|null):number|null{
 if(rule.kind==='boolean'||reading===null)return current;
 if(current===null)return reading;
 return lowerIsWorse(rule)?Math.min(current,reading):Math.max(current,reading);
}
/** The threshold of a level: warning or critical of a threshold rule, the one threshold of a limit rule, null for boolean rules. */
const levelThreshold=(rule:AlertRule,settings:AlertRuleSettingsMap,level:AlertLevel)=>rule.kind==='limit'?settings[rule.id].warning:rule.kind==='threshold'&&level!=='info'?settings[rule.id][level]:null;
/**
 * Whether an open threshold alarm may close: the reading has recovered past the
 * margin r from the opening threshold T (warning if set, else critical).
 * at-least: reading < T − r; above: reading ≤ T − r; below: reading ≥ T + r.
 */
export function recoveredPastMargin(rule:AlertRule,settings:AlertRuleSettingsMap,reading:number):boolean{
 if(rule.kind!=='threshold')return true;
 const values=settings[rule.id],opening=values.warning??values.critical,margin=values.recovery??0;
 if(opening===null)return true;
 if(rule.comparison==='at-least')return reading<opening-margin;
 if(rule.comparison==='above')return reading<=opening-margin;
 if(rule.comparison==='below')return reading>=opening+margin;
 return true;
}
const sameParams=(a:AlertIssueParams,b:AlertIssueParams)=>JSON.stringify(a)===JSON.stringify(b);

/**
 * The transitions of one device at `now`:
 * - a firing rule without an alarm opens one, or a pending one while its minimum
 *   duration has not passed;
 * - a pending alarm opens once the duration has passed while the rule still
 *   fires, and is deleted when the rule stops firing first;
 * - an open threshold alarm with a recovery margin closes (recovered) only past
 *   the margin and keeps its level inside the band; other rules close at once;
 * - a turned-off rule closes with rule-off; a live rule on a device that is not
 *   online, or a device without a snapshot, closes with no-data;
 * - while an agent update runs (maintenance) nothing opens or closes.
 * The peak keeps the worst reading and the highest level with its threshold; a
 * rising level clears the acknowledgement. An unchanged alarm is not written.
 */
export function alertTransitions({server,alerts,issues,readings,settings,now}:AlertEvaluation):AlertTransitions{
 const result:AlertTransitions={inserts:[],updates:[],closes:[],deletes:[]};
 const kind=connectionKind(server,now);
 if(kind==='maintenance')return result;
 const fired=new Map(issues.map(issue=>[slot(issue.ruleId,issue.key),issue]));
 const values=new Map(readings.map(reading=>[slot(reading.ruleId,reading.key),reading.value]));
 const known=new Set<string>();
 for(const alert of alerts){
  known.add(slot(alert.ruleId,alert.key));
  const remove=(reason:AlertCloseReason)=>{if(alert.state==='pending')result.deletes.push(alert.id);else result.closes.push({id:alert.id,reason});};
  if(!isAlertRuleId(alert.ruleId)){remove('rule-off');continue;}
  const rule=alertRule(alert.ruleId),own=settings[rule.id];
  if(!own.enabled){remove('rule-off');continue;}
  const reading=values.get(slot(alert.ruleId,alert.key))??null,issue=fired.get(slot(alert.ruleId,alert.key));
  if(issue){
   const duration=alarmSettingsApply(rule)?own.durationMinutes??0:0;
   const state=alert.state==='open'||now-alert.startedAt>=duration*minuteMs?'open':'pending';
   const higherPeak=rank[issue.level]>rank[alert.peakLevel];
   const update:AlertUpdate={
    id:alert.id,state,level:issue.level,
    peakLevel:higherPeak?issue.level:alert.peakLevel,threshold:higherPeak?levelThreshold(rule,settings,issue.level):alert.threshold,
    peakValue:worse(rule,alert.peakValue,reading),params:issue.params,
    openedAt:alert.state==='pending'&&state==='open'?now:alert.openedAt,
    clearAcknowledgement:alert.state==='open'&&alert.acknowledgedAt!==null&&rank[issue.level]>rank[alert.level],
   };
   if(update.state!==alert.state||update.level!==alert.level||update.peakLevel!==alert.peakLevel||update.threshold!==alert.threshold||update.peakValue!==alert.peakValue||update.clearAcknowledgement||!sameParams(update.params,alert.params))result.updates.push(update);
   continue;
  }
  // The rule does not fire now.
  if(alert.state==='pending'){result.deletes.push(alert.id);continue;}
  if(rule.id==='device-offline'){result.closes.push({id:alert.id,reason:'recovered'});continue;}
  if(rule.live&&kind!=='online'||!server.snapshot){result.closes.push({id:alert.id,reason:'no-data'});continue;}
  if(!alarmSettingsApply(rule)){result.closes.push({id:alert.id,reason:'recovered'});continue;}
  if(reading===null){result.closes.push({id:alert.id,reason:'no-data'});continue;}
  if(recoveredPastMargin(rule,settings,reading))result.closes.push({id:alert.id,reason:'recovered'});
  // Inside the band the alarm stays open with its level; the peak cannot move there.
 }
 for(const issue of issues){
  if(known.has(slot(issue.ruleId,issue.key)))continue;
  const rule=alertRule(issue.ruleId),duration=alarmSettingsApply(rule)?settings[rule.id].durationMinutes??0:0,open=duration<=0;
  result.inserts.push({
   ruleId:issue.ruleId,key:issue.key,state:open?'open':'pending',level:issue.level,peakLevel:issue.level,
   peakValue:rule.kind!=='boolean'?values.get(slot(issue.ruleId,issue.key))??null:null,threshold:levelThreshold(rule,settings,issue.level),
   params:issue.params,startedAt:now,openedAt:open?now:null,
  });
 }
 return result;
}
export type AlertEventKind='open'|'escalate'|'close';
/**
 * A transition that can notify (docs/notifications.md). The alarm is an
 * existing ID (alertId) or the index of its row in transitions.inserts (insert),
 * because a new alarm gets its ID only when lib/server/devices/alerts.ts writes it.
 */
export type AlertEvent={
 kind:AlertEventKind;alertId:string|null;insert:number|null;ruleId:string;key:string;
 /** open: the level; escalate: the new level; close: the peak level. */
 level:AlertLevel;
 /** The reading at the event (the peak when there is no reading); close: the peak. */
 value:number|null;threshold:number|null;closeReason:AlertCloseReason|null;
};
/**
 * The notification events of one evaluation, from the alarms before it and its
 * transitions: open for an insert that opens at once and for a pending alarm
 * that opens; escalate for an open alarm whose level rises; close for every
 * close with its reason. Pending inserts, deletes, level drops and peak or
 * params updates give none. `readings` give the value at the event.
 */
export function alertEvents(before:readonly ActiveAlert[],transitions:AlertTransitions,readings:readonly AlertReading[]=[]):AlertEvent[]{
 const previous=new Map(before.map(alert=>[alert.id,alert])),values=new Map(readings.map(reading=>[slot(reading.ruleId,reading.key),reading.value]));
 const reading=(ruleId:string,key:string,fallback:number|null)=>values.get(slot(ruleId,key))??fallback;
 const events:AlertEvent[]=[];
 transitions.inserts.forEach((row,index)=>{
  if(row.state==='open')events.push({kind:'open',alertId:null,insert:index,ruleId:row.ruleId,key:row.key,level:row.level,value:reading(row.ruleId,row.key,row.peakValue),threshold:row.threshold,closeReason:null});
 });
 for(const row of transitions.updates){
  const old=previous.get(row.id);
  if(!old||row.state!=='open')continue;
  const base={alertId:row.id,insert:null,ruleId:old.ruleId,key:old.key,level:row.level,value:reading(old.ruleId,old.key,row.peakValue),threshold:row.threshold,closeReason:null};
  if(old.state==='pending')events.push({kind:'open',...base});
  else if(rank[row.level]>rank[old.level])events.push({kind:'escalate',...base});
 }
 for(const row of transitions.closes){
  const old=previous.get(row.id);
  if(!old||old.state!=='open')continue;
  events.push({kind:'close',alertId:row.id,insert:null,ruleId:old.ruleId,key:old.key,level:old.peakLevel,value:old.peakValue,threshold:old.threshold,closeReason:row.reason});
 }
 return events;
}
/** True when the evaluation changes nothing. */
export const noTransitions=(transitions:AlertTransitions)=>!transitions.inserts.length&&!transitions.updates.length&&!transitions.closes.length&&!transitions.deletes.length;
