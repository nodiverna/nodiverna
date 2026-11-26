// Reliability and program crashes of agent 4.11.0 (docs/device-health-signals.md):
// the program summary of one device (the card "Reliability" in the area Events),
// the crash count per program that the rule app-crash-repeated uses, and the
// fleet view of the scope tab "Reliability". Pure and without server imports.
import type {ReliabilityEvent,ReliabilityEventKind,Server} from './types';

const dayMs=86400000;
/** The stability index below which a device counts as unstable in the fleet head line (fixed, like the fleet filters). */
export const lowStabilityIndex=5;
/** The program key: case-insensitive. */
export const programKey=(program:string)=>program.normalize('NFKC').toLowerCase();
const within=(event:Pick<ReliabilityEvent,'at'>,now:number,days:number)=>{const at=Date.parse(event.at);return Number.isFinite(at)&&at<=now&&now-at<=days*dayMs;};
/** The most frequent spelling of a program name; ties go to the first one seen. */
function displayName(spellings:Map<string,number>):string{
 let best='',count=-1;
 for(const [name,seen] of spellings)if(seen>count){best=name;count=seen;}
 return best;
}

export type ProgramSummary={key:string;program:string;crashes:number;hangs:number;installFailures:number;last:string;events:ReliabilityEvent[]};
/**
 * The events of the last `days` days grouped by program (case-insensitive; the
 * display name is the most frequent spelling): crash, hang and failed
 * installation counts, the newest time and the single events newest first.
 * Sorted by crashes, then all events, descending, then by name.
 */
export function programSummary(events:readonly ReliabilityEvent[],now:number,days:number):ProgramSummary[]{
 const groups=new Map<string,{spellings:Map<string,number>;crashes:number;hangs:number;installFailures:number;last:number;events:ReliabilityEvent[]}>();
 for(const event of events){
  if(!within(event,now,days)||!event.program)continue;
  const key=programKey(event.program),group=groups.get(key)??{spellings:new Map<string,number>(),crashes:0,hangs:0,installFailures:0,last:-Infinity,events:[] as ReliabilityEvent[]};
  group.spellings.set(event.program,(group.spellings.get(event.program)??0)+1);
  if(event.kind==='crash')group.crashes++;else if(event.kind==='hang')group.hangs++;else group.installFailures++;
  group.last=Math.max(group.last,Date.parse(event.at));group.events.push(event);
  groups.set(key,group);
 }
 return [...groups.entries()].map(([key,group])=>({key,program:displayName(group.spellings),crashes:group.crashes,hangs:group.hangs,installFailures:group.installFailures,last:new Date(group.last).toISOString(),
  events:[...group.events].sort((a,b)=>Date.parse(b.at)-Date.parse(a.at))}))
  .sort((a,b)=>b.crashes-a.crashes||b.events.length-a.events.length||a.program.localeCompare(b.program));
}
/** The crashes (kind crash only; hangs and failed installations do not count) per program within `days` days of `now`. */
export function programCrashCounts(events:readonly ReliabilityEvent[],now:number,days:number):{key:string;program:string;count:number}[]{
 return programSummary(events.filter(event=>event.kind==='crash'),now,days).map(summary=>({key:summary.key,program:summary.program,count:summary.crashes}));
}

export type FleetProgramRow={key:string;program:string;crashes:number;hangs:number;devices:number;last:string;perDevice:{id:string;crashes:number;hangs:number;last:string}[]};
export type FleetReliability={rows:FleetProgramRow[];lowStability:number;noStability:number};
/**
 * The scope tab "Reliability" over the scoped devices: per program the crashes
 * and hangs of the last 30 days, the number of devices with one of them, the
 * newest occurrence and the counts per device; sorted by crashes, then devices.
 * Also the devices with a stability index below 5 and those without stability
 * data (older agent or not available).
 */
export function fleetReliability(servers:readonly Pick<Server,'id'|'snapshot'>[],now:number):FleetReliability{
 const rows=new Map<string,{spellings:Map<string,number>;crashes:number;hangs:number;last:number;perDevice:Map<string,{crashes:number;hangs:number;last:number}>}>();
 let lowStability=0,noStability=0;
 for(const server of servers){
  const reliability=server.snapshot?.reliability,stability=reliability?.stability;
  if(stability?.available){if(stability.current<lowStabilityIndex)lowStability++;}else noStability++;
  for(const event of reliability?.events??[]){
   if(event.kind==='install-failure'||!within(event,now,30)||!event.program)continue;
   const key=programKey(event.program),row=rows.get(key)??{spellings:new Map(),crashes:0,hangs:0,last:-Infinity,perDevice:new Map()};
   const device=row.perDevice.get(server.id)??{crashes:0,hangs:0,last:-Infinity},at=Date.parse(event.at),kind:ReliabilityEventKind=event.kind;
   row.spellings.set(event.program,(row.spellings.get(event.program)??0)+1);
   if(kind==='crash'){row.crashes++;device.crashes++;}else{row.hangs++;device.hangs++;}
   row.last=Math.max(row.last,at);device.last=Math.max(device.last,at);
   row.perDevice.set(server.id,device);rows.set(key,row);
  }
 }
 return {
  rows:[...rows.entries()].map(([key,row])=>({key,program:displayName(row.spellings),crashes:row.crashes,hangs:row.hangs,devices:row.perDevice.size,last:new Date(row.last).toISOString(),
   perDevice:[...row.perDevice.entries()].map(([id,device])=>({id,crashes:device.crashes,hangs:device.hangs,last:new Date(device.last).toISOString()})).sort((a,b)=>b.crashes-a.crashes||b.hangs-a.hangs||a.id.localeCompare(b.id))}))
   .sort((a,b)=>b.crashes-a.crashes||b.devices-a.devices||a.program.localeCompare(b.program)),
  lowStability,noStability,
 };
}
