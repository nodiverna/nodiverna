import type {Viewer} from '../../types';
import {now} from '../context';
import {primaryMfaSessionGuard,featureWriteGuard} from '../identity/feature-authorization';
import {devicePermissionGuard,mfaAnchorSql} from '../identity/access';
import {commitAll,db,jsonArrayText,jsonPath,jsonText,sql} from '../db';

// Browser presence is separate from agent activity. Agent polling after a
// browser disappears must not keep an abandoned SYSTEM shell alive.
export const MAX_TERMINALS=4;
export const TERMINAL_PRESENCE_GRACE_MS=120_000;
export const TERMINAL_PRESENCE_TOUCH_MS=15_000;
export const TERMINAL_ABSOLUTE_LIFETIME_MS=3_600_000;
export type TerminalSession={
 id:string;server_id:string;principal:string;mfa_hash:string|null;state:string;cols:number;rows:number;
 input_seq:number;input_ack:number;output_seq:number;created_at:number;
 last_activity:number;expires_at:number;error:string|null;
};

export function terminalIsActive(s:Pick<TerminalSession,'state'|'last_activity'|'expires_at'>,time=now()){
 return ['opening','open'].includes(s.state)&&s.expires_at>time&&s.last_activity>=time-TERMINAL_PRESENCE_GRACE_MS;
}

export function terminalAccessGuard(alias:string,time=now()){
 const row=sql.ident(alias);
 const device=devicePermissionGuard(sql`${row}.server_id`,sql`${row}.principal`,'terminal'),primary=primaryMfaSessionGuard(sql`${row}.principal`,sql`${row}.mfa_hash`,time);
 return sql`(${device}) AND (${primary})
 AND EXISTS (SELECT 1 FROM mfa_sessions guard_mfa WHERE ${mfaAnchorSql(sql`guard_mfa.principal`)} AND guard_mfa.token_hash=${row}.mfa_hash AND guard_mfa.principal=${row}.principal AND guard_mfa.idle_expires_at>${time} AND guard_mfa.expires_at>${time})
 AND EXISTS (SELECT 1 FROM servers guard_mode WHERE guard_mode.id=${row}.server_id AND guard_mode.management=1 AND ${jsonText(sql`guard_mode.snapshot`,'mode')}='Management')`;
}

export function terminalWriteGuard(alias:string,time=now()){
 const row=sql.ident(alias);
 return sql`${row}.state IN ('opening','open') AND ${row}.expires_at>${time} AND ${row}.last_activity>=${time-TERMINAL_PRESENCE_GRACE_MS} AND (${terminalAccessGuard(alias,time)})`;
}

export async function touchTerminalPresence(id:string,time=now(),v?:Viewer){
 // Renew an authenticated owner GET before the sweep: older agents recorded
 // only user input here. A session already closed is never revived.
 const current=terminalWriteGuard('terminal_sessions',time),guard=v?featureWriteGuard(v,current):current;
 await db().exec(sql`UPDATE terminal_sessions SET last_activity=${time} WHERE id=${id} AND ${guard} AND last_activity<=${time-TERMINAL_PRESENCE_TOUCH_MS}`);
}

export async function sweepTerminalSessions(serverId:string,time=now()){
 const guard=terminalWriteGuard('terminal_sessions',time);
 await commitAll([
  sql`UPDATE terminal_sessions SET state='closed',error=COALESCE(error,'Sitzung, MFA oder Berechtigung beendet') WHERE server_id=${serverId} AND state IN ('opening','open') AND NOT (${guard})`,
  // Retire the terminal leases of abandoned, missing or upgraded shells.
  // Never clear a job/maintenance lease as part of terminal cleanup.
  sql`DELETE FROM device_leases WHERE server_id=${serverId} AND owner_kind='terminal' AND (expires_at<=${time} OR NOT EXISTS (SELECT 1 FROM terminal_sessions t WHERE t.id=device_leases.owner_id AND t.server_id=device_leases.server_id AND t.state IN ('opening','open') AND t.expires_at>${time} AND t.last_activity>=${time-TERMINAL_PRESENCE_GRACE_MS}) OR EXISTS (SELECT 1 FROM servers s CROSS JOIN LATERAL ${jsonArrayText(jsonPath(sql`s.snapshot`,'agentCapabilities'))} c WHERE s.id=device_leases.server_id AND c.value='terminal-multi'))`,
 ]);
}
