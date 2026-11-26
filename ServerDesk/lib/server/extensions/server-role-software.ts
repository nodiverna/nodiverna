// Server side of the server roles (docs/extensions.md): the known server
// products of every visible device, read from the software inventory
// (device_software) in one statement for GET /api/console. The SQL prefilter
// uses the catalog prefixes; matchServerSoftware (lib/extensions.ts) then
// applies the exact patterns, so the prefixes only need to cover them.
import {db,sql,type Queryable} from '../db';
import type {ServerSoftwareMatch} from '../../types';
import {matchServerSoftware,detectionSoftwarePrefixes,type ServerSoftwareRow} from '../../extensions';

/** LIKE pattern for a literal prefix: backslash, % and _ are escaped (PostgreSQL's default escape character is the backslash). */
export const prefixLikePattern=(prefix:string)=>prefix.replace(/[\\%_]/g,match=>'\\'+match)+'%';

/**
 * The server products per device of the scope (a JSON array of device ids):
 * one statement reads the device_software rows whose normalized_name (lower
 * case) starts with a catalog prefix. Devices without a match are not in the map.
 */
export async function consoleServerSoftware(scope:string,q:Queryable=db()):Promise<Map<string,ServerSoftwareMatch[]>>{
 const prefixes=sql.join(detectionSoftwarePrefixes.map(prefix=>sql`d.normalized_name LIKE ${prefixLikePattern(prefix)}`),sql` OR `);
 const rows=await q.query<{server_id:string;name:string;version:string|null;normalized_name:string;normalized_version:string|null}>(sql`SELECT d.server_id,d.name,d.version,d.normalized_name,d.normalized_version
  FROM device_software d WHERE d.server_id IN (SELECT value FROM jsonb_array_elements_text(${scope}::jsonb)) AND (${prefixes})
  ORDER BY d.server_id,d.name,d.scope,d.architecture,d.key`);
 const perDevice=new Map<string,ServerSoftwareRow[]>();
 for(const row of rows){
  const id=String(row.server_id),list=perDevice.get(id)??[];
  list.push({name:String(row.name),version:row.version==null?null:String(row.version),normalizedName:String(row.normalized_name),normalizedVersion:row.normalized_version==null?null:String(row.normalized_version)});
  perDevice.set(id,list);
 }
 const result=new Map<string,ServerSoftwareMatch[]>();
 for(const [id,items] of perDevice){const matches=matchServerSoftware(items);if(matches.length)result.set(id,matches);}
 return result;
}
