// Routing of one notification event (docs/notifications.md): pure and without
// server imports, so the tests run it without a database. lib/server/notifications/notifications.ts
// loads the rules and the context of an event and applies the result once:
// the event becomes routed with one delivery per channel, or suppressed with
// its reason. A suppressed event is never sent later.
import type {AlertLevel} from '../../alert-rules';

/** The weekly window of a customer (lib/server/identity/customers.ts MaintenanceWindow): ISO weekdays, HH:MM start, minutes, IANA zone. */
export type RoutingWindow={days:readonly number[];start:string;durationMinutes:number;timeZone:string};
export type RoutingScopeType='all'|'customer'|'group';
export type RoutingRule={
 id:string;scopeType:RoutingScopeType;scopeId:string;channelId:string;levels:readonly AlertLevel[];
 onOpen:boolean;onClose:boolean;onEscalate:boolean;enabled:boolean;
 /** Whether the rule's channel is on. */
 channelEnabled:boolean;
};
export type RoutingEvent={kind:'open'|'escalate'|'close';level:AlertLevel;occurredAt:number};
export type RoutingContext={
 /** alerts.muted_until of the alarm; null when not muted or the alarm is gone. */
 mutedUntil:number|null;
 /** The maintenance window of the device's customer. */
 maintenanceWindow:RoutingWindow|null;
 customerId:string|null;
 /** Customer rules apply only once a second customer exists. */
 multipleCustomers:boolean;
 /** Every group the device belongs to, directly or through a subgroup. */
 groupIds:readonly string[];
 /** Channels that already have a sent or failed delivery of an earlier event of this alarm. */
 notifiedChannels:ReadonlySet<string>;
};
/** no-recipient: an emergency event (lib/server/notifications/notifications.ts) without any channel to send it through. */
export type SuppressedReason='muted'|'maintenance-window'|'not-notified'|'no-rule'|'no-recipient';
export type RouteResult={status:'suppressed';reason:SuppressedReason}|{status:'routed';channelIds:string[]};

const minuteMs=60_000;
const formatters=new Map<string,Intl.DateTimeFormat>();
function formatter(timeZone:string){
 let value=formatters.get(timeZone);
 if(!value){value=new Intl.DateTimeFormat('en-US',{timeZone,hourCycle:'h23',year:'numeric',month:'numeric',day:'numeric',hour:'numeric',minute:'numeric',second:'numeric'});formatters.set(timeZone,value);}
 return value;
}
/** The wall clock of `time` in the zone. */
function wallClock(time:number,timeZone:string){
 const parts=Object.fromEntries(formatter(timeZone).formatToParts(new Date(time)).filter(part=>part.type!=='literal').map(part=>[part.type,Number(part.value)]));
 return {year:parts.year,month:parts.month,day:parts.day,hour:parts.hour%24,minute:parts.minute,second:parts.second};
}
/** Zone time minus UTC at `time`, in milliseconds. */
function zoneOffset(time:number,timeZone:string){
 const wall=wallClock(time,timeZone);
 return Date.UTC(wall.year,wall.month-1,wall.day,wall.hour,wall.minute,wall.second)-Math.floor(time/1000)*1000;
}
/** The instant of a wall clock time in the zone (a time in a DST gap moves forward by the gap). */
function instantOf(year:number,month:number,day:number,minutes:number,timeZone:string){
 const guess=Date.UTC(year,month-1,day,0,minutes);
 const first=guess-zoneOffset(guess,timeZone);
 return guess-zoneOffset(first,timeZone);
}

/**
 * Whether `time` lies in the weekly window: a window starts on each listed
 * weekday at `start` wall clock time in its zone and lasts durationMinutes real
 * minutes, so it can cross midnight into the next day, and a DST change inside it
 * does not stretch or shorten it. The start minute belongs to the window, the end
 * minute does not. An unknown zone never matches.
 */
export function inMaintenanceWindow(window:RoutingWindow|null,time:number):boolean{
 if(!window)return false;
 const match=/^(\d{2}):(\d{2})$/.exec(window.start);
 if(!match)return false;
 const start=Number(match[1])*60+Number(match[2]);
 try{
  const today=wallClock(time,window.timeZone),base=Date.UTC(today.year,today.month-1,today.day);
  // The window of today and the one of yesterday (it may reach into today).
  for(const back of [0,1]){
   const date=new Date(base-back*86_400_000),weekday=(date.getUTCDay()+6)%7+1;
   if(!window.days.includes(weekday))continue;
   const from=instantOf(date.getUTCFullYear(),date.getUTCMonth()+1,date.getUTCDate(),start,window.timeZone);
   if(time>=from&&time<from+window.durationMinutes*minuteMs)return true;
  }
  return false;
 }catch{return false;}
}

const flag=(rule:RoutingRule,kind:RoutingEvent['kind'])=>kind==='open'?rule.onOpen:kind==='close'?rule.onClose:rule.onEscalate;
/** Whether the rule's scope covers the device: All devices, its customer (only with several customers) or one of its groups. */
export function ruleCovers(rule:RoutingRule,context:Pick<RoutingContext,'customerId'|'multipleCustomers'|'groupIds'>):boolean{
 if(rule.scopeType==='all')return true;
 if(rule.scopeType==='customer')return context.multipleCustomers&&context.customerId!==null&&rule.scopeId===context.customerId;
 return context.groupIds.includes(rule.scopeId);
}
/**
 * The channels of the rules that match the event: rules are additive along the
 * device's chain, and a channel matched by several rules is listed once.
 * Disabled rules and rules of disabled channels match nothing.
 */
export function matchingChannels(event:RoutingEvent,rules:readonly RoutingRule[],context:Pick<RoutingContext,'customerId'|'multipleCustomers'|'groupIds'>):string[]{
 const channels=new Set<string>();
 for(const rule of rules)if(rule.enabled&&rule.channelEnabled&&ruleCovers(rule,context)&&rule.levels.includes(event.level)&&flag(rule,event.kind))channels.add(rule.channelId);
 return [...channels].sort();
}

/**
 * Routes one event, in this order: a muted alarm is suppressed (muted); an
 * event inside the maintenance window of the device's customer is suppressed
 * (maintenance-window); an escalation or close goes only to channels that got an
 * earlier event of the alarm, and without such a channel it is suppressed
 * (not-notified); without a matching rule it is suppressed (no-rule); otherwise
 * it is routed to every matching channel.
 */
export function routeEvent(event:RoutingEvent,rules:readonly RoutingRule[],context:RoutingContext):RouteResult{
 if(context.mutedUntil!==null&&context.mutedUntil>event.occurredAt)return {status:'suppressed',reason:'muted'};
 if(inMaintenanceWindow(context.maintenanceWindow,event.occurredAt))return {status:'suppressed',reason:'maintenance-window'};
 const follow=event.kind!=='open';
 if(follow&&context.notifiedChannels.size===0)return {status:'suppressed',reason:'not-notified'};
 const matched=matchingChannels(event,rules,context);
 const channels=follow?matched.filter(id=>context.notifiedChannels.has(id)):matched;
 if(!channels.length)return {status:'suppressed',reason:matched.length?'not-notified':'no-rule'};
 return {status:'routed',channelIds:channels};
}
