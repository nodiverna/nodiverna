import {db,sql,type Sql} from '../db';
import {now} from '../context';
import {parseGpuHistory} from './gpu-history';
import type {Sample} from '../../types';

/** The last 24 hours of samples of a device (at most 3000), oldest first, while the authorization holds. */
export async function deviceSamples(serverId:string,authorization:Sql){
 const rows=await db().query<Omit<Sample,'gpus'>&{gpus:string|null}>(sql`SELECT server_id AS "serverId",at,cpu,memory,gpus FROM samples WHERE server_id=${serverId} AND at>${now()-86400000} AND ${authorization} ORDER BY at DESC LIMIT 3000`);
 return rows.reverse().map(sample=>({...sample,gpus:parseGpuHistory(sample.gpus)}));
}
