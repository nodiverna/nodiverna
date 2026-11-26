// Microsoft sign-in only and the emergency access account (docs/entra-id.md).
// The SQL guards here go into the committing statements of the sign-in, the
// account actions, the role assignments and the factor actions, so a switch
// that commits first always wins. This module imports only the data layer and
// the audit writer: lib/server/identity/local-auth.ts, lib/server/identity/mfa.ts, lib/server/identity/rbac.ts and
// lib/server/identity/account-admin.ts all use it without an import cycle.
import {auditEvent} from '../../audit';
import {db,sql,type Sql,type Step} from '../../db';

/** True while Microsoft sign-in only is on. */
export const entraOnlySql:Sql=sql`EXISTS (SELECT 1 FROM entra_settings entra_only_row WHERE entra_only_row.id=1 AND entra_only_row.entra_only=1)`;
/** True while Microsoft sign-in only is on and the account `userId` (an SQL expression) is the emergency access. */
export const emergencyFixedSql=(userId:Sql):Sql=>sql`EXISTS (SELECT 1 FROM entra_settings emergency_row WHERE emergency_row.id=1 AND emergency_row.entra_only=1 AND emergency_row.emergency_user_id=${userId})`;
/** emergencyFixedSql by the account's principal (mfa_accounts.principal, auth_principal). */
export const emergencyPrincipalFixedSql=(principal:string):Sql=>sql`EXISTS (SELECT 1 FROM entra_settings emergency_row JOIN local_users emergency_user ON emergency_user.id=emergency_row.emergency_user_id WHERE emergency_row.id=1 AND emergency_row.entra_only=1 AND emergency_user.auth_principal=${principal})`;
/**
 * A sign-in of the account `userId` (an SQL expression) may create a session:
 * Microsoft sign-in only is off, or the account is the emergency access.
 */
export const builtInSignInAllowedSql=(userId:Sql):Sql=>sql`NOT EXISTS (SELECT 1 FROM entra_settings sign_in_row WHERE sign_in_row.id=1 AND sign_in_row.entra_only=1 AND sign_in_row.emergency_user_id IS DISTINCT FROM ${userId})`;
/**
 * The account `userId` (an SQL expression) can be the emergency access: a
 * built-in, active account with a password, no forced reset, an mfa_accounts
 * row and a direct, global assignment of the built-in Owner role.
 */
export const emergencyQualifiesSql=(userId:Sql):Sql=>sql`EXISTS (SELECT 1 FROM local_users qualified_user WHERE qualified_user.id=${userId} AND qualified_user.identity_source='local' AND qualified_user.status='active' AND qualified_user.password_hash IS NOT NULL AND qualified_user.must_reset=0
 AND EXISTS (SELECT 1 FROM mfa_accounts qualified_mfa WHERE qualified_mfa.principal=qualified_user.auth_principal)
 AND EXISTS (SELECT 1 FROM role_assignments qualified_owner WHERE qualified_owner.principal_type='user' AND qualified_owner.principal_id=qualified_user.id AND qualified_owner.role_id='builtin-owner' AND qualified_owner.scope_type='global' AND qualified_owner.scope_id='*'))`;

/** Pre-check of emergencyFixedSql. */
export async function emergencyAccountFixed(userId:string):Promise<boolean>{return !!await db().one(sql`SELECT 1 AS fixed WHERE ${emergencyFixedSql(sql`${userId}`)}`);}
/** Pre-check of emergencyPrincipalFixedSql. */
export async function emergencyPrincipalFixed(principal:string):Promise<boolean>{return !!await db().one(sql`SELECT 1 AS fixed WHERE ${emergencyPrincipalFixedSql(principal)}`);}
/** Pre-check of entraOnlySql. */
export async function entraOnlyActive():Promise<boolean>{return !!await db().one(sql`SELECT 1 AS active WHERE ${entraOnlySql}`);}

/**
 * The statements of an emergency sign-in (lib/server/identity/mfa.ts issueSession): the
 * security alarm, the pending notification event and the audit row. `guard`
 * is true exactly when this batch bound a pending primary session of the
 * emergency access while Microsoft sign-in only is on; every statement depends
 * on it or on the alarm row it wrote, so a refused sign-in leaves none of them.
 * `actor` is the account's auth email (the viewer label), `address` the client
 * address key or 'unknown'.
 */
export function emergencySignInStatements({userId,actor,address,time,guard}:{userId:string;actor:string;address:string;time:number;guard:Sql}):Step[]{
 const alarmId=crypto.randomUUID(),eventId=crypto.randomUUID(),written=sql`EXISTS (SELECT 1 FROM security_alarms WHERE id=${alarmId})`;
 return [
  sql`INSERT INTO security_alarms(id,kind,user_id,actor,display_name,address,occurred_at) SELECT ${alarmId}::text,'emergencySignIn',alarm_user.id,alarm_user.auth_email,alarm_user.display_name,${address}::text,${time}::bigint FROM local_users alarm_user WHERE alarm_user.id=${userId} AND ${emergencyFixedSql(sql`alarm_user.id`)} AND (${guard})`,
  sql`INSERT INTO notification_events(id,kind,level,security_alarm_id,occurred_at,status) SELECT ${eventId}::text,'emergency','critical',${alarmId}::text,${time}::bigint,'pending' WHERE ${written}`,
  ...auditEvent({actor,action:'auth.emergency.login',target:`user=${userId} address=${address} alarm=${alarmId}`,guard:written,at:time}),
 ];
}
