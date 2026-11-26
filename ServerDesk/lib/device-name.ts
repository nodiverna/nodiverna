// The portal name of a device (servers.name) and where it comes from
// (servers.name_source): the name rule of enrollment and of the rename, the
// computer name that the agent reports in every heartbeat (snapshot.hostname)
// and the limits of the previous names. Shared by the heartbeat
// (lib/server/agent/heartbeat.ts), the enrollment paths, the rename (lib/server/devices/device-name-store.ts)
// and the rename drawer (ui/devices/device/device-name.tsx). Pure: no imports, no I/O.

/** 1 to 64 letters, digits, periods, spaces, underscores or hyphens, after trim. */
export const deviceNamePattern=/^[a-zA-Z0-9._ -]{1,64}$/;
export const deviceNameMax=64;

/**
 * hostname: the name follows the computer name of every heartbeat.
 * custom: a name chosen in the portal; heartbeats never change it.
 * pending: a personal registration before its first heartbeat; that heartbeat
 * resolves it to hostname (the typed name equals the computer name) or custom.
 */
export const deviceNameSources=['hostname','custom','pending'] as const;
export type DeviceNameSource=typeof deviceNameSources[number];
export const isDeviceNameSource=(value:unknown):value is DeviceNameSource=>typeof value==='string'&&(deviceNameSources as readonly string[]).includes(value);

/** At most this many previous names are kept per device, newest first. */
export const previousNameLimit=5;

/** The trimmed name when it matches the rule, else null. */
export function validDeviceName(input:unknown):string|null{
 if(typeof input!=='string')return null;
 const name=input.trim();
 return deviceNamePattern.test(name)?name:null;
}

/**
 * The computer name of a snapshot (the agent sends Environment.MachineName as
 * `hostname`), trimmed, or null when it is missing or fails the name rule.
 */
export function reportedHostname(snapshot:unknown):string|null{
 if(!snapshot||typeof snapshot!=='object')return null;
 return validDeviceName((snapshot as {hostname?:unknown}).hostname);
}

/** Names that differ only in case are the same name: case-only changes never rename. */
export const sameDeviceName=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();

