import type {Server} from '@/lib/types';
import {deviceConnection,deviceIssues,diskSummary,liveValue} from '@/ui/base/ui-device';
import {healthStateRank,listHealth} from '@/ui/base/health-score';
import {deviceManufacturer} from '@/ui/devices/hardware/manufacturer-model';
import {batteryHealth,bitlockerStatus,bitlockerStatusRank,deviceDiskHealth,diskHealthRank,maxWear} from '@/ui/devices/inventory/health-signals';

export type FleetSortKey='name'|'connection'|'issues'|'customer'|'group'|'os'|'manufacturer'|'cpu'|'memory'|'disk'|'agent'|'heartbeat'|'osSupport'|'bitlocker'|'diskHealth'|'ssdWear'|'battery'|'health';
export type FleetSortDirection='asc'|'desc';
const descending=new Set<FleetSortKey>(['issues','cpu','memory','heartbeat','ssdWear']);
const keys=new Set<FleetSortKey>(['name','connection','issues','customer','group','os','manufacturer','cpu','memory','disk','agent','heartbeat','osSupport','bitlocker','diskHealth','ssdWear','battery','health']);
const collator=new Intl.Collator('de',{numeric:true,sensitivity:'base'});

export function fleetSortState(value:string):{key:FleetSortKey;direction:FleetSortDirection}{
 const [candidate,direction]=value.split(':');
 const key=keys.has(candidate as FleetSortKey)?candidate as FleetSortKey:'name';
 return {key,direction:direction==='asc'||direction==='desc'?direction:descending.has(key)?'desc':'asc'};
}
/** The direction of a first press on a column: descending for issues, CPU, RAM, heartbeat and SSD wear, ascending otherwise. */
export function fleetSortFirst(key:FleetSortKey):FleetSortDirection{
 return descending.has(key)?'desc':'asc';
}
/** The sort the fleet applies: a sort by group while the Group column is hidden (groupColumnShows false) sorts by name, so the Device head shows it. */
export function shownFleetSort(value:string,groupColumn:boolean):string{
 return !groupColumn&&fleetSortState(value).key==='group'?'name':value;
}
/** The fleet's string sort ("name", "cpu:desc") as the DataTable's TableSort. */
export function fleetTableSort(value:string):{column:FleetSortKey;direction:FleetSortDirection}{
 const {key,direction}=fleetSortState(value);
 return {column:key,direction};
}
/** A DataTable sort back as the fleet's string sort. */
export function fleetSortValue(sort:{column:string;direction:FleetSortDirection}):string{
 return `${fleetSortState(sort.column).key}:${sort.direction}`;
}
export function nextFleetSort(value:string,key:FleetSortKey):string{
 const current=fleetSortState(value);
 return `${key}:${current.key===key?(current.direction==='asc'?'desc':'asc'):descending.has(key)?'desc':'asc'}`;
}
function value(server:Server,key:FleetSortKey,now:number):string|number|null{
 switch(key){
  case 'name':return server.name;
  case 'connection':return {online:0,maintenance:1,offline:2,waiting:3}[deviceConnection(server,now).kind];
  case 'issues':return server.snapshot?deviceIssues(server,now).reduce((score,issue)=>score+({critical:10000,warning:100,info:1}[issue.level]),0):null;
  case 'customer':return server.customerName?.trim()||null;
  case 'group':return server.groupName?.trim()||null;
  case 'os':return server.snapshot?.os.replace('Microsoft ','').trim()||null;
  // The display name of the manufacturer; none stays at the end.
  case 'manufacturer':return deviceManufacturer(server).manufacturer?.name??null;
  case 'cpu':case 'memory':return liveValue(server,server.snapshot?.[key],now);
  case 'disk':return diskSummary(server)?.freeGb??null;
  case 'agent':return server.snapshot?.agentVersion.trim()||null;
  case 'heartbeat':return server.lastSeen;
  // Days left of the OS support (ended: 0); unknown stays at the end.
  case 'osSupport':return server.osSupport&&server.osSupport.status!=='unknown'?server.osSupport.daysLeft??null:null;
  // Problems first; not reported stays at the end.
  case 'bitlocker':{const status=bitlockerStatus(server.snapshot?.bitlocker);return status==='not-reported'?null:bitlockerStatusRank[status];}
  // Problems first; not available and not reported stay at the end.
  case 'diskHealth':{const status=deviceDiskHealth(server);return status===null||status==='not-available'?null:diskHealthRank[status];}
  // The highest wear; disks without a wear value stay at the end.
  case 'ssdWear':return maxWear(server);
  // The lowest battery health; no battery stays at the end.
  case 'battery':{const health=batteryHealth(server);return typeof health==='number'?health:null;}
  // By level (critical, warning, good), inside a level the lowest score first; no data stays at the end.
  case 'health':{const health=listHealth(server);return health.score===null?null:healthStateRank[health.state]*1000+health.score;}
 }
}
export function compareFleetDevices(a:Server,b:Server,sort:string,now:number):number{
 const {key,direction}=fleetSortState(sort),av=value(a,key,now),bv=value(b,key,now);
 // Missing inventories and stale live readings remain at the end in either direction.
 const missingA=av===null||typeof av==='number'&&!Number.isFinite(av),missingB=bv===null||typeof bv==='number'&&!Number.isFinite(bv);
 if(missingA!==missingB)return missingA?1:-1;
 const order=missingA?0:typeof av==='number'&&typeof bv==='number'?av-bv:collator.compare(String(av),String(bv));
 return order!==0?(direction==='asc'?order:-order):collator.compare(a.name,b.name)||collator.compare(a.id,b.id);
}
