import {db,sql} from '../db';

/**
 * Takes the admission slot `slot` of an active device in agent_channels when
 * its last use is older than `notAfter` (inclusive with `orEqual`). It is
 * atomic across replicas. agent_channels has no foreign key; the slot names
 * are internal and cannot be chosen by a browser or an unauthenticated agent.
 */
export async function takeChannelSlot(slot:string,serverId:string,time:number,notAfter:number,orEqual=false):Promise<boolean>{
 const active=sql`EXISTS (SELECT 1 FROM servers WHERE id=${serverId} AND revoked=0)`;
 const older=orEqual?sql`agent_channels.last_at <= ${notAfter}`:sql`agent_channels.last_at < ${notAfter}`;
 return !!await db().one(sql`INSERT INTO agent_channels (server_id,last_at) SELECT ${slot},${time} WHERE ${active} ON CONFLICT(server_id) DO UPDATE SET last_at=excluded.last_at WHERE ${older} AND ${active} RETURNING server_id`);
}
/** Whether the device exists and is not revoked. */
export async function deviceActive(serverId:string){return !!await db().one(sql`SELECT 1 AS active FROM servers WHERE id=${serverId} AND revoked=0`);}
