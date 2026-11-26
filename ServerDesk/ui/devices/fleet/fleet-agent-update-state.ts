import type {Job, Server, Viewer} from '@/lib/types';
import {deviceConnection} from '@/ui/base/ui-device';
import {deviceUpdateState, latestDeviceReleases, usableDeviceRelease, type DeviceRelease, type DeviceUpdateCampaign, type UpdateReceipt} from '@/lib/agent-update-state';
import {deviceUpdateBlockReason, inspectDeviceUpdates} from '@/ui/devices/device/agent-update-model';

import {translate} from '@/lib/i18n/translate';
import {defaultLocale,type Locale} from '@/lib/i18n/locale';
export const fleetUpdateLimit=20;
export const activeUpdatePhases=new Set(['scheduled','queued','installing','waiting']);

/** Release manifests list supported Windows families, with installed edition suffixes allowed. */
export function compatibleDeviceRelease(server:Server,release:DeviceRelease){
 if(!usableDeviceRelease(release))return false;
 const manifest=typeof release.manifest==='string'?JSON.parse(release.manifest):release.manifest;
 const normalize=(value:string)=>value.replace(/^Microsoft\s+/i,'').replace(/\s+/g,' ').trim().toLowerCase();
 const os=normalize(server.snapshot?.os??'');
 return !!os&&Array.isArray(manifest.os)&&manifest.os.some((value:unknown)=>typeof value==='string'&&(os===normalize(value)||os.startsWith(normalize(value)+' ')));
}

/** devBuilds: Import dev builds is on (GET /api/releases), so dev builds are offered too. */
export function fleetDeviceUpdate(server:Server,viewer:Viewer,demo:boolean,releases:DeviceRelease[],jobs:Job[],campaigns:DeviceUpdateCampaign[],receipt:UpdateReceipt|null,now:number,locale:Locale=defaultLocale,devBuilds=false){
 const inspect=inspectDeviceUpdates(server,viewer,demo);
 const candidates=inspect?releases.filter(release=>compatibleDeviceRelease(server,release)):[];
 const {update,migration}=latestDeviceReleases(server.snapshot?.agentVersion,candidates,server.snapshot?.agentCapabilities,{devBuilds});
 const state=inspect?deviceUpdateState(server,jobs,campaigns,receipt,now):null;
 const active=!!state&&activeUpdatePhases.has(state.phase);
 const reason=deviceUpdateBlockReason(server,viewer,deviceConnection(server,now).kind==='online',demo,locale)||(server.revoked===1?translate(locale,'agentUpdates.fleet.revoked'):'')||
  (active?translate(locale,'agentUpdates.notice.active'):!server.snapshot?.os?translate(locale,'agentUpdates.fleet.noOs'):'');
 return {server,inspect,update,migration,state,active,reason,eligible:inspect&&!!update&&!reason};
}

export type FleetUpdateTarget={serverId:string;serverName:string;installed:string;release:DeviceRelease};
export type FleetUpdateGroup={release:DeviceRelease;targets:FleetUpdateTarget[]};
export function groupFleetUpdates(targets:FleetUpdateTarget[]):FleetUpdateGroup[]{
 const groups=new Map<string,FleetUpdateGroup>();
 for(const target of targets){const group=groups.get(target.release.id)??{release:target.release,targets:[]};group.targets.push(target);groups.set(target.release.id,group);}
 return [...groups.values()];
}
