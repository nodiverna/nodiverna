import {HttpError} from '../context';
import {dbFailure,type DbConflictKey} from '../errors/db-codes';
import {db,sql,type Sql} from '../db';

export const maximumDeviceGroupDepth=4;
// The two facts of deviceGroupDeleteNeedsStepUp (lib/step-up.ts) as SQL on the
// group id `group`: a device membership of any device (every customer, also
// ones the actor cannot see) and a devicegroup role assignment on the group.
// The proof-free delete carries NOT of both in its committing statement;
// GET /api/access and the console read both for stepUpOnDelete.
export const deviceGroupHasMembersSql=(group:Sql)=>sql`EXISTS (SELECT 1 FROM device_group_members risk_member WHERE risk_member.group_id=${group})`;
export const deviceGroupHasAssignmentsSql=(group:Sql)=>sql`EXISTS (SELECT 1 FROM role_assignments risk_assignment WHERE risk_assignment.scope_type='devicegroup' AND risk_assignment.scope_id=${group})`;
export async function deviceGroupAncestors(id:string):Promise<{id:string;depth:number}[]>{
 return (await db().query<{id:string;depth:number}>(sql`SELECT ancestor_id AS id,depth FROM device_group_ancestors WHERE group_id=${id} ORDER BY depth`));
}
export async function deviceGroupDeviceIds(id:string):Promise<string[]>{
 return (await db().query<{id:string}>(sql`SELECT DISTINCT m.server_id AS id FROM device_group_ancestors a JOIN device_group_members m ON m.group_id=a.group_id JOIN servers s ON s.id=m.server_id WHERE a.ancestor_id=${id} AND s.revoked=0 ORDER BY m.server_id`)).map(row=>row.id);
}
export async function deviceGroupPath(id:string):Promise<{id:string;name:string;depth:number}[]>{
 return (await db().query<{id:string;name:string;depth:number}>(sql`SELECT g.id,g.name,a.depth FROM device_group_ancestors a JOIN device_groups g ON g.id=a.ancestor_id WHERE a.group_id=${id} ORDER BY a.depth DESC`));
}
// The trigger texts live in the error catalog (lib/errors/codes.ts):
// customer-mismatch (0029), customer-disabled (0031), device-group-member-missing (0032).
export {customerDisabledMessage,customerMismatchMessage,deviceGroupMemberMissingMessage} from '../../errors/codes';
/** UNIQUE device_group_members.server_id: the device joined another group concurrently. The text lives in the error catalog. */
export {deviceGroupMembershipTakenMessage as membershipConflictMessage} from '../../errors/codes';
// Trigger codes of the device group hierarchy and the one-group-per-device
// UNIQUE, all 409 with the registry text and code.
const hierarchyConflicts=['customer-mismatch','device-group-member-missing','customer-disabled','device-group-depth-limit','device-group-cycle','device-group-parent-missing','device-group-has-children','device-group-membership-path-conflict','UNIQUE idx_device_group_members_server'] as const satisfies readonly DbConflictKey[];
/** The 409 for a hierarchy trigger or a concurrent second membership, with its registry code, else null. */
export function deviceGroupConflict(error:unknown):HttpError|null{
 const conflict=dbFailure(error,{},hierarchyConflicts);
 return conflict?new HttpError(conflict.key):null;
}
