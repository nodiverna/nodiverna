// The client side of the alarms (lib/server/devices/alerts.ts), without React: the rows of the
// scope tab "Alarms" from the console data, their sort order, the level,
// customer and group filters, the texts of a row (title, peak, status, duration,
// close reason) and the CSV export. ui/devices/monitoring/alarms.tsx renders them; the
// tests call them directly.
import {alertRule,isAlertRuleId,type AlertLevel} from '@/lib/alert-rules';
import {alertRuleName,formatAlertThreshold} from '@/lib/alert-rules-text';
import {issueText} from '@/ui/base/ui-device';
import {cell,quote} from '@/ui/devices/fleet/fleet-csv';
import {formatDateTime} from '@/lib/i18n/format';
import {defaultLocale,type Locale} from '@/lib/i18n/locale';
import {translate,type MessageKey} from '@/lib/i18n/translate';
import type {AlertHistoryEntry,OpenAlert,Server} from '@/lib/types';

export type AlarmDevice=Pick<Server,'id'|'name'|'customerId'|'customerName'|'groupId'|'groupName'|'groups'|'alerts'|'permissions'>;
export type AlarmRow<D extends AlarmDevice=AlarmDevice>={alert:OpenAlert;device:D};
export type AlarmLevelFilter='all'|AlertLevel;
export type AlarmFilter={level:AlarmLevelFilter;customer:string;group:string};
export const noAlarmFilter:AlarmFilter={level:'all',customer:'',group:''};

const rank:Record<AlertLevel,number>={critical:0,warning:1,info:2};
/** Critical before warning before info, then the oldest start first. */
export function compareAlarmRows(a:AlarmRow,b:AlarmRow):number{
 return rank[a.alert.level]-rank[b.alert.level]||a.alert.startedAt-b.alert.startedAt||a.device.name.localeCompare(b.device.name,'en',{numeric:true})||a.alert.id.localeCompare(b.alert.id);
}
/** The open alarms of the devices, sorted. */
export function alarmRows<D extends AlarmDevice>(devices:readonly D[]):AlarmRow<D>[]{
 return devices.flatMap(device=>(device.alerts??[]).map(alert=>({alert,device}))).sort(compareAlarmRows);
}
/**
 * The count of the scope tab "Alarms": every open alarm of the devices (acknowledged and muted
 * included) and the tone of the worst level: critical, else warning, else none. Without an open alarm
 * the tab shows no count (null).
 */
export function alarmTabCount(devices:readonly Pick<Server,'alerts'>[]):{count:number;tone?:'critical'|'warning'}|null{
 let count=0,critical=false,warning=false;
 for(const device of devices)for(const alert of device.alerts??[]){
  count++;
  if(alert.level==='critical')critical=true;
  else if(alert.level==='warning')warning=true;
 }
 if(!count)return null;
 return critical?{count,tone:'critical'}:warning?{count,tone:'warning'}:{count};
}
export function alarmCounts(rows:readonly AlarmRow[]):Record<AlarmLevelFilter,number>{
 const counts={all:rows.length,critical:0,warning:0,info:0};
 for(const row of rows)counts[row.alert.level]++;
 return counts;
}
/** A group matches the devices of its subgroups too: groups lists every group on the device's group path. */
const inGroup=(device:AlarmDevice,group:string)=>device.groupId===group||!!device.groups?.some(item=>item.id===group);
export function filterAlarmRows<D extends AlarmDevice>(rows:readonly AlarmRow<D>[],filter:AlarmFilter):AlarmRow<D>[]{
 return rows.filter(({alert,device})=>(filter.level==='all'||alert.level===filter.level)&&(!filter.customer||device.customerId===filter.customer)&&(!filter.group||inGroup(device,filter.group)));
}
const byName=(a:{name:string},b:{name:string})=>a.name.localeCompare(b.name,'en',{numeric:true,sensitivity:'base'});
/** The customers of the devices that have alarms, by name. */
export function alarmCustomerOptions(rows:readonly AlarmRow[]):{id:string;name:string}[]{
 const options=new Map<string,string>();
 for(const {device} of rows)if(device.customerId)options.set(device.customerId,device.customerName?.trim()||device.customerId);
 return [...options].map(([id,name])=>({id,name})).sort(byName);
}
/** The groups on the group paths of the devices that have alarms, by name. */
export function alarmGroupOptions(rows:readonly AlarmRow[]):{id:string;name:string}[]{
 const options=new Map<string,string>();
 for(const {device} of rows){
  for(const group of device.groups??[])options.set(group.id,group.name);
  if(device.groupId&&!options.has(device.groupId))options.set(device.groupId,device.groupName??device.groupId);
 }
 return [...options].map(([id,name])=>({id,name})).sort(byName);
}

/** The rule name and the issue title and detail of an alarm, from the same formatter as the issues (ui/base/ui-device.ts). */
export function alarmText(alert:Pick<OpenAlert,'ruleId'|'params'>,locale:Locale=defaultLocale,now:number=Date.now()):{rule:string;title:string;detail:string;unknown?:string[]}{
 if(!isAlertRuleId(alert.ruleId))return {rule:alert.ruleId,title:alert.ruleId,detail:''};
 return {rule:alertRuleName(alert.ruleId,locale),...issueText({ruleId:alert.ruleId,params:alert.params},locale,now)};
}
/**
 * The peak in the rule unit, or null for boolean rules and alarms without a reading. A days-left rule
 * (remaining-at-most: certificates, OS support) past its date says "20 days overdue", never a negative number.
 */
export function alarmPeak(alert:Pick<OpenAlert,'ruleId'|'peakValue'>,locale:Locale=defaultLocale):string|null{
 if(!isAlertRuleId(alert.ruleId)||alert.peakValue===null)return null;
 const rule=alertRule(alert.ruleId);
 if(rule.kind==='boolean')return null;
 const value=rule.unit==='days'||rule.unit==='minutes'?Math.floor(alert.peakValue):Math.round(alert.peakValue*10)/10;
 if(rule.comparison==='remaining-at-most'&&rule.unit==='days'&&value<0)return translate(locale,'alarms.peak.overdue',{count:-value});
 return formatAlertThreshold(rule,value,locale);
}
/** "Open", "Acknowledged by …", "Muted until …" or both, as one sentence. */
export function alarmStatus(alert:Pick<OpenAlert,'acknowledged'|'muted'>,locale:Locale=defaultLocale):string{
 const name=alert.acknowledged?.by??'',time=alert.muted?formatDateTime(locale,alert.muted.until):'';
 if(alert.acknowledged&&alert.muted)return translate(locale,'alarms.status.acknowledgedMuted',{name,time});
 if(alert.acknowledged)return translate(locale,'alarms.status.acknowledged',{name});
 if(alert.muted)return translate(locale,'alarms.status.muted',{time});
 return translate(locale,'alarms.status.open');
}
/** A duration: "12 min", "3 h 5 min", "2 d 4 h". */
export function alarmDuration(start:number,end:number,locale:Locale=defaultLocale):string{
 const minutes=Math.max(0,Math.floor((end-start)/60000));
 if(minutes<60)return translate(locale,'alarms.duration.minutes',{minutes});
 if(minutes<1440)return translate(locale,'alarms.duration.hours',{hours:Math.floor(minutes/60),minutes:minutes%60});
 return translate(locale,'alarms.duration.days',{days:Math.floor(minutes/1440),hours:Math.floor(minutes%1440/60)});
}
export const closeReasonKeys:Record<NonNullable<AlertHistoryEntry['closeReason']>,MessageKey>={recovered:'alarms.reason.recovered','rule-off':'alarms.reason.ruleOff','no-data':'alarms.reason.noData'};
export const alarmLevelKeys:Record<AlertLevel,MessageKey>={critical:'alertRules.level.critical',warning:'alertRules.level.warning',info:'alertRules.level.info'};
/** Open rows first (newest start first), then the closed ones in the order of the history. */
export function alarmHistoryRows(open:readonly OpenAlert[],history:readonly AlertHistoryEntry[]):AlertHistoryEntry[]{
 const openIds=new Set(open.map(alert=>alert.id));
 return [
  ...[...open].sort((a,b)=>b.startedAt-a.startedAt).map(alert=>({...alert,state:'open' as const,closedAt:null,closeReason:null})),
  ...history.filter(entry=>entry.state==='closed'&&!openIds.has(entry.id)),
 ];
}

/**
 * CSV of the given rows in their order (the visible rows of the tab), with the
 * protections of ui/devices/fleet/fleet-csv.ts: level, device, customer (only with
 * `customer`), rule, alarm, peak, since (ISO) and status.
 */
export function alarmsCsv(rows:readonly AlarmRow[],{customer=false}:{customer?:boolean}={},locale:Locale=defaultLocale,now:number=Date.now()):string{
 const header:MessageKey[]=['alarms.column.level','alarms.column.device',...(customer?['alarms.column.customer' as const]:[]),'alertRules.column.rule','alarms.column.alarm','alarms.column.peak','alarms.column.since','alarms.column.status'];
 const lines=rows.map(({alert,device})=>{
  const text=alarmText(alert,locale,now);
  return [translate(locale,alarmLevelKeys[alert.level]),device.name,...(customer?[device.customerName??'']:[]),text.rule,text.title,alarmPeak(alert,locale)??'',new Date(alert.startedAt).toISOString(),alarmStatus(alert,locale)].map(cell);
 });
 return '﻿'+[header.map(key=>quote(translate(locale,key))),...lines].map(line=>line.join(';')).join('\r\n');
}
export function alarmsCsvFileName(now:number,locale:Locale=defaultLocale):string{
 const date=new Date(now),pad=(value:number)=>String(value).padStart(2,'0');
 return translate(locale,'alarms.csvFileName',{date:`${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`});
}
