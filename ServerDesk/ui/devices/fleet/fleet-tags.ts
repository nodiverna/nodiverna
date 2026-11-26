import type {EffectiveTag} from '@/lib/tags';
import {compareTagNames,tagKey} from '@/lib/tags';

// The tag filter of the fleet toolbar (ui/devices/fleet/fleet.tsx). It works on the
// effective tags the console sends with every device (own and inherited), so
// it matches what the server resolved. Names compare without regard to case,
// values exactly. Pure: no I/O.

/** The chosen filter: a tag name and a value, or null for any value. */
export type FleetTagFilter={name:string;value:string|null};
type Tagged={tags?:readonly EffectiveTag[]};

/** The tag names of the devices, de-duplicated without regard to case and sorted; the first casing in sort order is shown. */
export function fleetTagNames(devices:readonly Tagged[]):string[]{
 const names=new Map<string,string>();
 for(const name of devices.flatMap(device=>(device.tags??[]).map(tag=>tag.name)).sort((a,b)=>compareTagNames({name:a},{name:b})))if(!names.has(tagKey(name)))names.set(tagKey(name),name);
 return [...names.values()];
}

/** The non-empty values of one tag name on the devices, de-duplicated and sorted. */
export function fleetTagValues(devices:readonly Tagged[],name:string):string[]{
 const key=tagKey(name);
 return [...new Set(devices.flatMap(device=>(device.tags??[]).filter(tag=>tagKey(tag.name)===key&&tag.value).map(tag=>tag.value)))].sort((a,b)=>compareTagNames({name:a},{name:b}));
}

/** True when the device has an effective tag with the name (any case) and, unless value is null, exactly this value. No filter matches every device. */
export function matchesFleetTagFilter(device:Tagged,filter:FleetTagFilter|null):boolean{
 if(!filter)return true;
 const key=tagKey(filter.name);
 return (device.tags??[]).some(tag=>tagKey(tag.name)===key&&(filter.value===null||tag.value===filter.value));
}
