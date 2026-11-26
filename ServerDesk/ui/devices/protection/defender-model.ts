// The Defender actions as the console offers them: why the viewer cannot start an action on a
// device, the blocked texts, whether the viewer may control Defender on any device, and the plan of
// a bulk action with its skip sentences. This is UI code: the client shapes the interface with
// isOwner (ui/base/access-capabilities.ts); the server decides through
// lib/server/identity/policy/can.ts and checks only the Defender state (defenderStateBlock in
// lib/defender.ts).
import type {Server,Viewer} from '@/lib/types';
import {connectionKind} from '@/lib/device-connection';
import {isOwner} from '@/ui/base/access-capabilities';
import {defaultLocale,type Locale} from '@/lib/i18n/locale';
import {translate,type MessageKey} from '@/lib/i18n/translate';
import {defenderControlRight,defenderStateBlock,type DefenderJobKind,type DefenderStateBlock} from '@/lib/defender';

export type DefenderBlock='demo'|'saving'|'right'|'read-only'|'offline'|'agent'|DefenderStateBlock;
export const defenderBlockKeys:Record<DefenderBlock,MessageKey>={demo:'kit.unavailable.demo',saving:'fleet.menu.saving',right:'defender.blocked.right','read-only':'defender.blocked.readOnly',offline:'device.offline',agent:'defender.blocked.agent',unavailable:'defender.blocked.unavailable','scan-running':'defender.blocked.scanRunning','no-detections':'defender.blocked.noDetections'};
export type DefenderActionDevice=Pick<Server,'management'|'snapshot'|'lastSeen'|'maintenance'>&{permissions?:string[]};
type DefenderViewer=Pick<Viewer,'permissions'>;
// The Owner holds every right (isOwner, as the console's other views); otherwise the device's own permissions decide.
const holdsControl=(device:DefenderActionDevice,viewer:DefenderViewer)=>isOwner(viewer)||device.permissions?.includes(defenderControlRight)===true;

/**
 * The first reason why the viewer cannot start the action on the device, or
 * null: demo, saving, the right, ReadOnly, offline, the agent capability, then
 * the Defender state (defenderStateBlock).
 */
export function defenderActionBlock(device:DefenderActionDevice,viewer:DefenderViewer,kind:DefenderJobKind,{demo,saving,now}:{demo:boolean;saving:boolean;now:number}):DefenderBlock|null{
 if(demo)return 'demo';
 if(saving)return 'saving';
 if(!holdsControl(device,viewer))return 'right';
 const snapshot=device.snapshot;
 if(device.management!==1||snapshot?.mode!=='Management')return 'read-only';
 if(connectionKind(device,now)!=='online')return 'offline';
 if(!snapshot.agentCapabilities?.includes(kind))return 'agent';
 return defenderStateBlock(snapshot,kind);
}
export const defenderBlockText=(block:DefenderBlock|null,locale:Locale=defaultLocale):string|undefined=>block===null?undefined:translate(locale,defenderBlockKeys[block]);
/** Whether the viewer has defender.control on at least one of the devices. */
export const canControlDefender=(devices:readonly DefenderActionDevice[],viewer:DefenderViewer)=>devices.some(device=>holdsControl(device,viewer));

type DeviceSkip=Exclude<DefenderBlock,'demo'|'saving'>;
const skipOrder:readonly DeviceSkip[]=['right','read-only','offline','agent','unavailable','scan-running','no-detections'];
const skipKeys:Record<DeviceSkip,MessageKey>={right:'defender.bulk.skip.right','read-only':'defender.bulk.skip.readOnly',offline:'defender.bulk.skip.offline',agent:'defender.bulk.skip.agent',unavailable:'defender.bulk.skip.unavailable','scan-running':'defender.bulk.skip.scanRunning','no-detections':'defender.bulk.skip.noDetections'};
export type DefenderBulkPlan<T>={eligible:T[];skipped:{reason:DeviceSkip;count:number}[]};
/** The selected devices that can run the action and the skip counts per reason, in the order of defenderActionBlock. */
export function defenderBulkPlan<T extends DefenderActionDevice>(devices:readonly T[],viewer:DefenderViewer,kind:DefenderJobKind,now:number):DefenderBulkPlan<T>{
 const eligible:T[]=[],counts=new Map<DeviceSkip,number>();
 for(const device of devices){const block=defenderActionBlock(device,viewer,kind,{demo:false,saving:false,now}) as DeviceSkip|null;if(block===null)eligible.push(device);else counts.set(block,(counts.get(block)??0)+1);}
 return {eligible,skipped:skipOrder.filter(reason=>counts.has(reason)).map(reason=>({reason,count:counts.get(reason)!}))};
}
/** One sentence per skip reason with its count. */
export const defenderSkipSentences=(plan:Pick<DefenderBulkPlan<unknown>,'skipped'>,locale:Locale=defaultLocale)=>plan.skipped.map(({reason,count})=>translate(locale,skipKeys[reason],{count}));
