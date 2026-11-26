// The account name rule of lib/account-display.ts as SQL, for server queries
// that turn a stored actor label or principal into a name for the UI. The
// stored value stays as it is (audit and guards depend on it); only the shown
// name changes. tests/lib/account-display.mjs checks that both forms agree.
import {db,sql,type Sql} from '../db';

const guidPattern='^entra[.][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

/** SQL twin of isInternalAccountValue: a *.serverdesk.invalid address, an entra: or local: principal, or an entra.<GUID> username. */
export const internalAccountSql=(value:Sql)=>sql`(lower(btrim(${value})) LIKE '%.serverdesk.invalid' OR lower(btrim(${value})) LIKE 'entra:%' OR lower(btrim(${value})) LIKE 'local:%' OR btrim(${value}) ~* ${guidPattern}::text)`;

/** The trimmed value when it is non-empty and not internal, else NULL. */
const shown=(value:Sql)=>sql`CASE WHEN btrim(coalesce(${value},''))<>'' AND NOT ${internalAccountSql(value)} THEN btrim(${value}) END`;

/** SQL twin of storedActorName: NULL for an internal value, the email of a private:<email> principal, any other value unchanged. */
export const storedActorNameSql=(stored:Sql)=>sql`CASE WHEN ${stored} LIKE 'private:%' THEN (CASE WHEN NOT ${internalAccountSql(sql`substr(${stored},9)`)} THEN substr(${stored},9) END) WHEN NOT ${internalAccountSql(stored)} THEN ${stored} END`;

/**
 * The shown name of a stored actor: with a joined local_users row (alias
 * `user`), its display name, email or username, whichever comes first and is
 * not internal (NULL when none is); without a match, storedActorNameSql.
 */
export const accountNameSql=(user:Sql,stored:Sql)=>sql`(CASE WHEN ${user}.id IS NOT NULL THEN coalesce(${shown(sql`${user}.display_name`)},${shown(sql`${user}.email`)},${shown(sql`${user}.username`)}) ELSE ${storedActorNameSql(stored)} END)`;

/** The join condition that finds the account of a stored actor by auth email, principal or ID. */
export const accountMatchSql=(user:Sql,stored:Sql)=>sql`(${user}.auth_email=${stored} OR ${user}.auth_principal=${stored} OR ${user}.id=${stored})`;

/**
 * The shown names of stored actor values (labels, principals or account IDs),
 * read in one query; a value without a name maps to null. For lists whose own
 * row query must stay as it is (terminal and RDP sessions).
 */
export async function accountNamesOf(values:readonly string[]):Promise<Map<string,string|null>>{
 const distinct=[...new Set(values)];if(!distinct.length)return new Map();
 const rows=await db().query<{actor:string;name:string|null}>(sql`SELECT stored.actor,${accountNameSql(sql`u`,sql`stored.actor`)} AS name FROM jsonb_array_elements_text(${JSON.stringify(distinct)}::jsonb) AS stored(actor) LEFT JOIN LATERAL (SELECT * FROM local_users u WHERE ${accountMatchSql(sql`u`,sql`stored.actor`)} LIMIT 1) u ON TRUE`);
 return new Map(rows.map(row=>[row.actor,row.name]));
}
