// Entra group mappings → portal roles (docs/entra-id.md). The sync turns the
// rows of entra_group_roles whose group is in an account's entra_user_groups
// (the groups of its last sign-in) into role_assignments with source 'entra',
// and removes the account's 'entra' rows that are no longer wanted. Manual
// assignments are never touched, and an identical manual row is not
// duplicated. The last active direct global Owner assignment is never removed:
// it stays, and the audit row says keptLastOwner. Every permission guard of the
// portal reads role_assignments, so the rights follow at once.
import {roleSyncAuditAction} from '../../../audit-actions';
import {permissionElements,type SqlGuard} from '../access';
import {sql,type Sql} from '../../db';

export {roleSyncAuditAction};
/** The created_by of the rows the sync writes. */
export const roleSyncCreator='entra:sync';
const ownerRole=(role:Sql)=>sql`EXISTS (SELECT 1 FROM ${permissionElements(role)} sync_right WHERE sync_right.value='*')`;
const scopeLabel=(row:Sql)=>sql`(${row}.role_id||'@'||CASE WHEN ${row}.scope_type='global' THEN 'global' ELSE ${row}.scope_type||':'||${row}.scope_id END)`;

/**
 * One statement that syncs the roles of one Entra account (`userId`, an ID or a scalar subquery) or of every
 * Entra account (no userId), only while `guard` holds. It writes one
 * auth.entra.roles.sync row per account whose assignments changed or whose last
 * Owner row was kept: target "user=<id> added=<role>@<scope>,… removed=…" and
 * " keptLastOwner" when it applies. It returns the target of each row.
 *
 * All parts see one snapshot, so the Owner rule is decided for the whole set:
 * the stale Owner rows go only when an active direct global Owner assignment
 * remains outside them; otherwise all of them stay.
 *
 * keptOnlyRow=false leaves out the row of an account whose only change is the
 * kept Owner row ("added= removed= keptLastOwner"): the account check passes it
 * while it already reported that state (docs/entra-id.md, "The last Owner").
 * A row that adds or removes an assignment is still written.
 */
export function roleSyncStatement({userId,actor,at,guard=sql`TRUE`,keptOnlyRow=true}:{userId?:string|Sql;actor:string;at:number;guard?:SqlGuard;keptOnlyRow?:boolean}):Sql{
 // userId: an ID, or a scalar subquery that selects one.
 const only=userId===undefined?sql``:sql` AND sync_account.id=${userId}`;
 return sql`WITH sync_user AS (SELECT sync_account.id FROM local_users sync_account WHERE sync_account.identity_source='entra'${only} AND (${guard})),
 wanted AS (SELECT DISTINCT g.user_id,m.role_id,m.scope_type,m.scope_id FROM sync_user u JOIN entra_user_groups g ON g.user_id=u.id JOIN entra_group_roles m ON m.group_object_id=g.group_object_id),
 held AS (SELECT a.id,a.principal_id AS user_id,a.role_id,a.scope_type,a.scope_id,a.source FROM role_assignments a JOIN sync_user u ON a.principal_type='user' AND a.principal_id=u.id),
 stale AS (SELECT h.id,h.user_id,h.role_id,h.scope_type,h.scope_id FROM held h WHERE h.source='entra' AND NOT EXISTS (SELECT 1 FROM wanted w WHERE w.user_id=h.user_id AND w.role_id=h.role_id AND w.scope_type=h.scope_type AND w.scope_id=h.scope_id)),
 stale_owner AS (SELECT s.id,s.user_id FROM stale s JOIN rbac_roles stale_role ON stale_role.id=s.role_id WHERE s.scope_type='global' AND s.scope_id='*' AND ${ownerRole(sql`stale_role`)}),
 owner_remains AS (SELECT EXISTS (SELECT 1 FROM role_assignments remaining JOIN local_users remaining_user ON remaining_user.id=remaining.principal_id JOIN rbac_roles remaining_role ON remaining_role.id=remaining.role_id WHERE remaining.principal_type='user' AND remaining.scope_type='global' AND remaining.scope_id='*' AND remaining_user.status='active' AND ${ownerRole(sql`remaining_role`)} AND remaining.id NOT IN (SELECT id FROM stale_owner)) AS remains),
 removed AS (DELETE FROM role_assignments gone USING stale s WHERE gone.id=s.id AND gone.source='entra' AND (NOT EXISTS (SELECT 1 FROM stale_owner o WHERE o.id=s.id) OR (SELECT remains FROM owner_remains)) RETURNING gone.principal_id AS user_id,gone.role_id,gone.scope_type,gone.scope_id),
 kept AS (SELECT DISTINCT o.user_id FROM stale_owner o WHERE NOT (SELECT remains FROM owner_remains)),
 added AS (INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by,source)
  SELECT gen_random_uuid()::text,'user',w.user_id,w.role_id,w.scope_type,w.scope_id,${at}::bigint,${roleSyncCreator}::text,'entra' FROM wanted w
  WHERE NOT EXISTS (SELECT 1 FROM held h WHERE h.user_id=w.user_id AND h.role_id=w.role_id AND h.scope_type=w.scope_type AND h.scope_id=w.scope_id)
  ON CONFLICT DO NOTHING RETURNING principal_id AS user_id,role_id,scope_type,scope_id),
 changed AS (SELECT user_id FROM added UNION SELECT user_id FROM removed${keptOnlyRow?sql` UNION SELECT user_id FROM kept`:sql``})
 INSERT INTO audit(at,actor,action,target,server_id,scope,customer_id)
 SELECT ${at}::bigint,${actor}::text,${roleSyncAuditAction}::text,
  'user='||c.user_id
  ||' added='||COALESCE((SELECT string_agg(${scopeLabel(sql`a`)},',' ORDER BY ${scopeLabel(sql`a`)}) FROM added a WHERE a.user_id=c.user_id),'')
  ||' removed='||COALESCE((SELECT string_agg(${scopeLabel(sql`r`)},',' ORDER BY ${scopeLabel(sql`r`)}) FROM removed r WHERE r.user_id=c.user_id),'')
  ||CASE WHEN EXISTS (SELECT 1 FROM kept k WHERE k.user_id=c.user_id) THEN ' keptLastOwner' ELSE '' END,
  NULL,'portal',NULL
 FROM changed c RETURNING target`;
}
/** The account IDs of the rows a roleSyncStatement returned. */
export const syncedUserIds=(rows:readonly Record<string,unknown>[])=>rows.map(row=>/^user=(\S+) /.exec(String(row.target))?.[1]).filter((id):id is string=>!!id);
