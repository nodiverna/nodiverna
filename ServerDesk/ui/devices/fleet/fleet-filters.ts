// The "Filter" select of the fleet toolbar (ui/devices/fleet/fleet.tsx): health
// signal filters that combine with status, type and search. Pure.
import type {Server} from '@/lib/types';
import type {MessageKey} from '@/lib/i18n/translate';
import {deviceHealth} from '@/ui/base/health-score';
import {batteryHealth,bitlockerStatus,diskErrorCount,diskInErrorState,maxWear,recentCrashes} from '@/ui/devices/inventory/health-signals';

export const fleetFilters=['all','health-critical','health-warning','health-good','crashes','support-ended','support-ending','support-unknown','not-encrypted','bitlocker-suspended','disk-failed','ssd-wear','disk-errors','battery'] as const;
export type FleetFilter=typeof fleetFilters[number];
export const fleetFilterLabels:Record<FleetFilter,MessageKey>={all:'fleet.filter.all','health-critical':'fleet.filter.healthCritical','health-warning':'fleet.filter.healthWarning','health-good':'fleet.filter.healthGood',crashes:'fleet.filter.crashes','support-ended':'fleet.filter.supportEnded','support-ending':'fleet.filter.supportEnding','support-unknown':'fleet.filter.supportUnknown','not-encrypted':'fleet.filter.notEncrypted','bitlocker-suspended':'fleet.filter.bitlockerSuspended','disk-failed':'fleet.filter.diskFailed','ssd-wear':'fleet.filter.ssdWear','disk-errors':'fleet.filter.diskErrors',battery:'fleet.filter.battery'};
export const isFleetFilter=(value:unknown):value is FleetFilter=>typeof value==='string'&&(fleetFilters as readonly string[]).includes(value);

/**
 * True when the device passes the filter at `now`. "Crashes" is fixed to 30
 * days, whatever the rule settings; "not encrypted" counts only devices that
 * report BitLocker (not available is no finding). The disk and battery filters
 * use fixed values too: SSD wear 80 % or more, disk errors in the 30-day
 * window, battery below 60 %; a value that is not available never matches.
 * The health filters match the state of deviceHealth exactly; no data matches none.
 */
export function fleetFilterMatch(server:Pick<Server,'snapshot'|'osSupport'|'alerts'|'lastSeen'>,filter:FleetFilter,now:number):boolean{
 switch(filter){
  case 'all':return true;
  case 'health-critical':return deviceHealth(server).state==='critical';
  case 'health-warning':return deviceHealth(server).state==='warning';
  case 'health-good':return deviceHealth(server).state==='good';
  case 'crashes':return recentCrashes(server,now,30).length>0;
  case 'support-ended':return server.osSupport?.status==='ended';
  case 'support-ending':return server.osSupport?.status==='ending';
  case 'support-unknown':return !server.osSupport||server.osSupport.status==='unknown';
  case 'not-encrypted':return bitlockerStatus(server.snapshot?.bitlocker)==='not-encrypted';
  case 'bitlocker-suspended':return !!server.snapshot?.bitlocker?.available&&server.snapshot.bitlocker.volumes.some(volume=>volume.protection==='suspended');
  case 'disk-failed':return (server.snapshot?.diskHealth?.disks??[]).some(diskInErrorState);
  case 'ssd-wear':{const wear=maxWear(server);return wear!==null&&wear>=80;}
  case 'disk-errors':return diskErrorCount(server)>0;
  case 'battery':{const health=batteryHealth(server);return typeof health==='number'&&health<60;}
 }
}
