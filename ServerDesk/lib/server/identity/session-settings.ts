import {sessionIdleRequiresMfaAuditAction,sessionIdleTimeoutAuditAction} from '../../audit-actions';
import {HttpError,now} from '../context';
import {defaultLocale} from '../../i18n/locale';
import {translate} from '../../i18n/translate';
import type {SqlGuard} from './access';
import {auditEvent} from '../audit';
import {can,viewerCanSql} from './policy/can';
import type {Viewer} from '../../types';
import {commitAll,db,sql,type Step} from '../db';

// Automatic logout after inactivity (docs/portal-sessions.md). One value for the
// whole installation, stored as text in identity_settings, so no migration is
// needed. Anything that is not exactly one of the options counts as the default:
// a broken row never yields "no timeout". Only global Owners read or change it,
// and a change needs a fresh step-up proof (lib/step-up.ts, rule 6).
export const sessionIdleTimeoutKey='session_idle_timeout_minutes';
export const sessionIdleTimeoutOptions=[5,15,30,45] as const;
export const defaultSessionIdleTimeoutMinutes=15;
export const sessionSettingsOwnerOnlyMessage=translate(defaultLocale,'apiError.settings.ownerOnly');
export const sessionIdleTimeoutInvalidMessage=translate(defaultLocale,'apiError.settings.idleTimeoutInvalid');
export const sessionSettingsUnknownActionMessage=translate(defaultLocale,'apiError.request.unknownAction');
export const sessionSettingsConflictMessage=translate(defaultLocale,'apiError.settings.conflict');
export {sessionIdleTimeoutAuditAction};
/**
 * The stored audit targets of the two settings. Stored rows keep this German text; the audit log shows it in the
 * viewer's language (ui/devices/history/audit-display.ts auditTargetView reads exactly this form).
 */
export const idleTimeoutAuditTarget=(before:number,after:number)=>`${before} → ${after} Minuten`;
const onOff=(value:boolean)=>value?'an':'aus';
export const idleMfaAuditTarget=(before:boolean,after:boolean)=>`${onOff(before)} → ${onOff(after)}`;

// The MFA grant (docs/portal-sessions.md, "What each sign-in asks for"): a
// sign-in MFA stays valid this long for that account in that browser. Every
// grant expiry and every displayed value reads this constant.
export const MFA_GRANT_LIFETIME_MS=8*60*60_000;
export const mfaGrantHours=MFA_GRANT_LIFETIME_MS/(60*60_000);

// "Ask for MFA after an automatic sign-out" (docs/portal-sessions.md). On means:
// no MFA grant is created or used, so every sign-in asks for MFA. Off (the
// default) lets the 8-hour grant apply. Exact "0" or a missing row means off;
// "1" and any other text mean on, so a broken row never weakens the setting.
// Owner-only with step-up (lib/step-up.ts, rule 6).
export const sessionIdleRequiresMfaKey='session_idle_requires_mfa';
export const sessionIdleRequiresMfaInvalidMessage=translate(defaultLocale,'apiError.settings.idleRequiresMfaInvalid');
export {sessionIdleRequiresMfaAuditAction};
/** SQL guard: the stored switch is off (no row, or exactly "0"), so an MFA grant may be created or used. */
export const grantAllowedSql=sql`NOT EXISTS (SELECT 1 FROM identity_settings grant_switch WHERE grant_switch.key='session_idle_requires_mfa' AND grant_switch.value<>'0')`;

export type SessionSettingsView={idleTimeoutMinutes:number;options:number[];defaultMinutes:number;idleRequiresMfa:boolean;mfaGrantHours:number};

/** The minutes a stored value stands for: exactly "5", "15", "30" or "45", otherwise the default. */
export function idleTimeoutMinutesFrom(value:unknown):number{
 return typeof value==='string'&&sessionIdleTimeoutOptions.some(option=>String(option)===value)?Number(value):defaultSessionIdleTimeoutMinutes;
}
const storedValue=async(key=sessionIdleTimeoutKey)=>(await db().one<{value:string}>(sql`SELECT value FROM identity_settings WHERE key=${key}`))?.value??null;
/** The configured idle timeout in minutes. */
export async function sessionIdleTimeoutMinutes(){return idleTimeoutMinutesFrom(await storedValue());}
/** Whether a stored value means "ask for MFA after an automatic sign-out": a row with any text except exactly "0". */
export function idleRequiresMfaFrom(value:unknown):boolean{return value!==null&&value!==undefined&&value!=='0';}
/** Whether every sign-in asks for MFA (default off). Off lets the MFA grant of a browser apply. */
export async function sessionIdleRequiresMfa(){return idleRequiresMfaFrom(await storedValue(sessionIdleRequiresMfaKey));}
/** The configured idle timeout in milliseconds, used by every MFA session (lib/server/identity/mfa.ts). */
export async function sessionIdleTimeoutMs(){return (await sessionIdleTimeoutMinutes())*60_000;}

const view=(minutes:number,idleRequiresMfa:boolean):SessionSettingsView=>({idleTimeoutMinutes:minutes,options:[...sessionIdleTimeoutOptions],defaultMinutes:defaultSessionIdleTimeoutMinutes,idleRequiresMfa,mfaGrantHours});
// Compare-and-set against the value read before; a missing row is its own value.
const unchangedGuard=(key:string,previous:string|null):SqlGuard=>previous===null?sql`NOT EXISTS (SELECT 1 FROM identity_settings WHERE key=${key})`:sql`EXISTS (SELECT 1 FROM identity_settings WHERE key=${key} AND value=${previous})`;
const stepUpExpired=()=>new HttpError('apiError.mfa.proofExpired');
// The re-check after a refused commit asks the database again (fresh): a demoted Owner gets 403, not a conflict.
async function requireOwner(viewer:Viewer,fresh=false){if(!await can(viewer,'instance.owner',{fresh}))throw new HttpError('apiError.settings.ownerOnly');}

/** GET /api/session-settings. Owners only. */
export async function sessionSettingsStatus(viewer:Viewer):Promise<SessionSettingsView>{await requireOwner(viewer);return view(await sessionIdleTimeoutMinutes(),await sessionIdleRequiresMfa());}

/**
 * Sets the idle timeout. One batch holds the new value (compare-and-set against
 * the value read here, guarded by the proof and the live Owner right), its audit
 * row, the clamp of every live MFA session to its last input plus the new
 * timeout, and the consumption of the proof. A shorter value therefore applies
 * at once to accounts that are already idle; no deadline is ever lengthened.
 */
export async function setSessionIdleTimeout(request:Request,viewer:Viewer,minutes:unknown,managementToken:unknown):Promise<SessionSettingsView>{
 if(typeof minutes!=='number'||!sessionIdleTimeoutOptions.some(option=>option===minutes))throw new HttpError('apiError.settings.idleTimeoutInvalid');
 await requireOwner(viewer);
 const previous=await storedValue(),before=idleTimeoutMinutesFrom(previous),idleRequiresMfa=await sessionIdleRequiresMfa();
 if(before===minutes)return view(before,idleRequiresMfa);
 // lib/server/identity/rbac.ts reaches lib/server/identity/mfa.ts, which reads this module's timeout.
 const {prepareManagementAuthorization}=await import('./rbac'),proof=await prepareManagementAuthorization(request,viewer,managementToken);
 const unchanged=unchangedGuard(sessionIdleTimeoutKey,previous);
 const guard:SqlGuard=sql`(${proof.guard}) AND (${viewerCanSql(viewer,'instance.owner')}) AND (${unchanged})`;
 const time=now();
 // Every statement before the upsert sees the state the guard was read from.
 // The clamp leaves the Owner's own session live at commit: the step-up set its
 // last_activity, and the proof expires before last_activity + 5 minutes. From
 // then on it idles like any session until the next genuine input.
 const results=await commitAll([
  sql`SELECT 1 AS confirmed WHERE ${proof.guard}`,
  ...auditEvent({actor:viewer.label,action:sessionIdleTimeoutAuditAction,target:idleTimeoutAuditTarget(before,minutes),guard}),
  sql`UPDATE mfa_sessions SET idle_expires_at=LEAST(idle_expires_at,last_activity+${minutes*60_000}) WHERE idle_expires_at>${time} AND expires_at>${time} AND (${guard})`,
  sql`INSERT INTO identity_settings(key,value) SELECT ${sessionIdleTimeoutKey}::text,${String(minutes)}::text WHERE ${guard} ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
  // Consumed exactly when the upsert right before it wrote the value.
  {afterChange:sql`DELETE FROM mfa_management_proofs WHERE token_hash=${proof.tokenHash} AND principal=${proof.key} AND session_hash=${proof.sessionHash}`},
 ]);
 if(!results[0].rows.length)throw stepUpExpired();
 if(results[3].rowCount)return view(minutes,idleRequiresMfa);
 await requireOwner(viewer,true);
 throw new HttpError('apiError.settings.conflict');
}

/**
 * Sets "ask for MFA after an automatic sign-out". One batch holds the proof
 * check, the audit row, on a switch to on the delete of every MFA grant
 * (mfa_grants) of the installation, the compare-and-set upsert
 * guarded by the proof and the live Owner right, and the proof consumption right
 * behind the upsert, exactly like setSessionIdleTimeout. Live MFA sessions stay.
 */
export async function setSessionIdleRequiresMfa(request:Request,viewer:Viewer,required:unknown,managementToken:unknown):Promise<SessionSettingsView>{
 if(typeof required!=='boolean')throw new HttpError('apiError.settings.idleRequiresMfaInvalid');
 await requireOwner(viewer);
 const previous=await storedValue(sessionIdleRequiresMfaKey),before=idleRequiresMfaFrom(previous),minutes=await sessionIdleTimeoutMinutes();
 if(before===required)return view(minutes,before);
 const {prepareManagementAuthorization}=await import('./rbac'),proof=await prepareManagementAuthorization(request,viewer,managementToken);
 const unchanged=unchangedGuard(sessionIdleRequiresMfaKey,previous);
 const guard:SqlGuard=sql`(${proof.guard}) AND (${viewerCanSql(viewer,'instance.owner')}) AND (${unchanged})`;
 // Every statement before the upsert sees the state the guard was read from.
 const statements:Step[]=[
  sql`SELECT 1 AS confirmed WHERE ${proof.guard}`,
  ...auditEvent({actor:viewer.label,action:sessionIdleRequiresMfaAuditAction,target:idleMfaAuditTarget(before,required),guard}),
  // Switching on ends every MFA grant at once; switching off deletes nothing.
  ...(required?[sql`DELETE FROM mfa_grants WHERE ${guard}`]:[]),
 ];
 const upsert=statements.length;
 statements.push(
  sql`INSERT INTO identity_settings(key,value) SELECT ${sessionIdleRequiresMfaKey}::text,${required?'1':'0'}::text WHERE ${guard} ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
  // Consumed exactly when the upsert right before it wrote the value.
  {afterChange:sql`DELETE FROM mfa_management_proofs WHERE token_hash=${proof.tokenHash} AND principal=${proof.key} AND session_hash=${proof.sessionHash}`},
 );
 const results=await commitAll(statements);
 if(!results[0].rows.length)throw stepUpExpired();
 if(results[upsert].rowCount)return view(minutes,required);
 await requireOwner(viewer,true);
 throw new HttpError('apiError.settings.conflict');
}

/**
 * Sets both session rules with one proof (Settings › Sessions, one Save). It validates both values like the two
 * setters above and returns the view without a proof when nothing changed. Otherwise one batch holds the proof check,
 * one audit row per changed value (the same actions and target texts as the two setters), the clamp of every live MFA
 * session when the timeout changed, the delete of every MFA grant when MFA turns on, both upserts guarded by
 * the proof, the live Owner right and an unchanged guard for each key, and the proof consumption right behind the
 * last upsert, so it is consumed exactly once and only when the values were written.
 */
export async function setSessionSettings(request:Request,viewer:Viewer,minutes:unknown,required:unknown,managementToken:unknown):Promise<SessionSettingsView>{
 if(typeof minutes!=='number'||!sessionIdleTimeoutOptions.some(option=>option===minutes))throw new HttpError('apiError.settings.idleTimeoutInvalid');
 if(typeof required!=='boolean')throw new HttpError('apiError.settings.idleRequiresMfaInvalid');
 await requireOwner(viewer);
 const previousTimeout=await storedValue(),previousMfa=await storedValue(sessionIdleRequiresMfaKey);
 const beforeMinutes=idleTimeoutMinutesFrom(previousTimeout),beforeMfa=idleRequiresMfaFrom(previousMfa);
 const timeoutChanged=beforeMinutes!==minutes,mfaChanged=beforeMfa!==required;
 if(!timeoutChanged&&!mfaChanged)return view(beforeMinutes,beforeMfa);
 const {prepareManagementAuthorization}=await import('./rbac'),proof=await prepareManagementAuthorization(request,viewer,managementToken);
 const owner=viewerCanSql(viewer,'instance.owner'),mfaUnchanged=unchangedGuard(sessionIdleRequiresMfaKey,previousMfa);
 const guard:SqlGuard=sql`(${proof.guard}) AND (${owner}) AND (${unchangedGuard(sessionIdleTimeoutKey,previousTimeout)}) AND (${mfaUnchanged})`;
 const time=now();
 // Every statement up to the first upsert sees the state the guard was read from.
 const statements:Step[]=[
  sql`SELECT 1 AS confirmed WHERE ${proof.guard}`,
  ...(timeoutChanged?auditEvent({actor:viewer.label,action:sessionIdleTimeoutAuditAction,target:idleTimeoutAuditTarget(beforeMinutes,minutes),guard}):[]),
  ...(mfaChanged?auditEvent({actor:viewer.label,action:sessionIdleRequiresMfaAuditAction,target:idleMfaAuditTarget(beforeMfa,required),guard}):[]),
  // A new timeout clamps every live MFA session to its last input plus the new value; no deadline is lengthened.
  ...(timeoutChanged?[sql`UPDATE mfa_sessions SET idle_expires_at=LEAST(idle_expires_at,last_activity+${minutes*60_000}) WHERE idle_expires_at>${time} AND expires_at>${time} AND (${guard})`]:[]),
  // Switching MFA on ends every MFA grant at once; switching it off deletes nothing.
  ...(mfaChanged&&required?[sql`DELETE FROM mfa_grants WHERE ${guard}`]:[]),
  sql`INSERT INTO identity_settings(key,value) SELECT ${sessionIdleTimeoutKey}::text,${String(minutes)}::text WHERE ${guard} ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
  // Only after the first upsert wrote: the timeout key holds the new value now, so this guard checks the proof, the
  // Owner right and the MFA key, which the first guard already found unchanged in this transaction.
  {afterChange:sql`INSERT INTO identity_settings(key,value) SELECT ${sessionIdleRequiresMfaKey}::text,${required?'1':'0'}::text WHERE (${proof.guard}) AND (${owner}) AND (${mfaUnchanged}) ON CONFLICT(key) DO UPDATE SET value=excluded.value`},
  // Consumed exactly when both upserts wrote.
  {afterChange:sql`DELETE FROM mfa_management_proofs WHERE token_hash=${proof.tokenHash} AND principal=${proof.key} AND session_hash=${proof.sessionHash}`},
 ];
 const upsert=statements.length-2;
 const results=await commitAll(statements);
 if(!results[0].rows.length)throw stepUpExpired();
 if(results[upsert].rowCount)return view(minutes,required);
 await requireOwner(viewer,true);
 throw new HttpError('apiError.settings.conflict');
}
