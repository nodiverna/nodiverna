// The connection state of a device without any text: the one rule that both the
// UI (ui/base/ui-device.ts, deviceConnection) and the alert rules (lib/alert-rules.ts,
// live rules) use. Imports nothing, so server code, the client and tests share it.
export type ConnectionKind='maintenance'|'waiting'|'online'|'offline';
/** A device counts as online while its last Heartbeat is less than two minutes old. */
export const onlineWindowMs=120000;
export function connectionKind(server:{maintenance?:{state:string}|null;lastSeen:number|null},now:number):ConnectionKind{
 if(server.maintenance?.state==='updating')return 'maintenance';
 if(!server.lastSeen)return 'waiting';
 return now-server.lastSeen<onlineWindowMs?'online':'offline';
}
