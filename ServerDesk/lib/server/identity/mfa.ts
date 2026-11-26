import {config,hash,HttpError,now,random} from '../context';
import {mfaAnchorSql,principal,type SqlGuard} from './access';
import {commitWithAudit,type AuditEntry} from '../security-commit';
import type {ManagementAuthorization} from './rbac';
import type {Viewer} from '../../types';
import {productName} from '../../brand';
import {otpauthUri} from './mfa-uri';
import {grantAllowedSql,MFA_GRANT_LIFETIME_MS,sessionIdleRequiresMfa,sessionIdleTimeoutMs} from './session-settings';
import {createKeyring,decryptWithKeyring,encryptWithKeyring,type Keyring} from '../../../runtime/secret-keyring.mjs';
import {commitAll,db,dbNow,sql,type Sql,type Step,type StepResult} from '../db';
import {emergencyPrincipalFixed,emergencyPrincipalFixedSql,emergencySignInStatements} from './entra/emergency';

const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
// The idle timeout is configurable (lib/server/identity/session-settings.ts, default 15 minutes);
// the absolute session lifetime stays at 24 hours.
export const mfaSessionLifetimeMs=86400000;
// The MFA session and the MFA grant travel only in these HttpOnly cookies
// (docs/portal-sessions.md). No reply body carries them, and no header can
// stand in for them. The remembered browser of older versions used
// __Host-serverdesk-mfa-trust; replies that set or cleared it still clear it.
const sessionCookieName='__Host-serverdesk-mfa',grantCookieName='__Host-serverdesk-mfa-grant',removedTrustCookieName='__Host-serverdesk-mfa-trust';
const maximumAuthenticators=10,managementLifetimeMs=300000;
type AuthenticatorRow={id:string;principal:string;name:string;secret_enc:string;last_counter:number;created_at:number;last_used_at:number|null};
type AuthenticatorChallenge={id:string;principal:string;session_hash:string;authenticator_id:string|null;previous_secret_enc:string|null;name:string;secret_enc:string;expires_at:number};
export const mfaAvailable=()=>config('SESSION_SECRET').length>=32;
// TOTP secrets are encrypted with the keyring (runtime/secret-keyring.mjs):
// new values carry the kid of SESSION_SECRET, values under a secret listed in
// SESSION_SECRET_PREVIOUS or from before the keyring stay readable until the
// offline command rewrap-secrets encrypts them again.
let ringCache:{source:string;ring:Keyring}|null=null;
function keyring(){
 if(!mfaAvailable())throw new HttpError('apiError.mfa.sessionKeyMissing');
 const env={SESSION_SECRET:config('SESSION_SECRET'),SESSION_SECRET_PREVIOUS:config('SESSION_SECRET_PREVIOUS')},source=JSON.stringify(env);
 if(ringCache?.source!==source){
  // Startup (runtime/env.mjs) already rejects a short previous entry.
  try{ringCache={source,ring:createKeyring(env)};}catch{throw new HttpError('apiError.mfa.sessionKeyMissing');}
 }
 return ringCache.ring;
}
export async function encryptSecret(value:string,context:string){return encryptWithKeyring(keyring(),value,context);}
export async function decryptSecret(value:string,context:string){
 const ring=keyring();
 try{return await decryptWithKeyring(ring,value,context);}
 catch{throw new HttpError('apiError.mfa.secretUndecryptable');}
}
function base32(bytes:Uint8Array){let bits=0,value=0,result='';for(const byte of bytes){value=(value<<8)|byte;bits+=8;while(bits>=5){result+=alphabet[(value>>>(bits-5))&31];bits-=5;}}if(bits)result+=alphabet[(value<<(5-bits))&31];return result;}
function decode32(value:string){let bits=0,n=0;const result:number[]=[];for(const c of value){const digit=alphabet.indexOf(c);if(digit<0)throw new Error('Invalid secret');n=(n<<5)|digit;bits+=5;if(bits>=8){result.push((n>>>(bits-8))&255);bits-=8;}}return new Uint8Array(result);}
export async function totp(secret:string,counter:number){
 const bytes=new Uint8Array(8),view=new DataView(bytes.buffer);view.setUint32(0,Math.floor(counter/4294967296));view.setUint32(4,counter>>>0);
 const key=await crypto.subtle.importKey('raw',decode32(secret),{name:'HMAC',hash:'SHA-1'},false,['sign']);
 const mac=new Uint8Array(await crypto.subtle.sign('HMAC',key,bytes)),offset=mac[19]&15;
 const value=((mac[offset]&127)<<24)|(mac[offset+1]<<16)|(mac[offset+2]<<8)|mac[offset+3];
 return String(value%1000000).padStart(6,'0');
}
function equal(a:string,b:string){let result=a.length^b.length;for(let i=0;i<Math.max(a.length,b.length);i++)result|=(a.charCodeAt(i)||0)^(b.charCodeAt(i)||0);return result===0;}
async function codeCounter(secret:string,code:unknown,lastCounter=-1){
 if(typeof code!=='string'||!/^\d{6}$/.test(code))return null;
 const current=Math.floor(now()/30000);for(const counter of [current,current-1,current+1])if(counter>lastCounter&&equal(await totp(secret,counter),code))return counter;return null;
}
export async function countAttempt(key:string){
 const time=now(),cutoff=time-600000;
 const row=await db().one<{blocked_until:number}>(sql`SELECT blocked_until FROM mfa_attempts WHERE principal = ${key}`);
 if(row&&row.blocked_until>time)throw new HttpError('apiError.mfa.rateLimited');
 const changed=await db().one<{attempts:number;blocked_until:number}>(sql`INSERT INTO mfa_attempts (principal,attempts,window_at,blocked_until) VALUES (${key},1,${time},0) ON CONFLICT(principal) DO UPDATE SET attempts = CASE WHEN mfa_attempts.window_at < ${cutoff} THEN 1 ELSE mfa_attempts.attempts + 1 END,window_at = CASE WHEN mfa_attempts.window_at < ${cutoff} THEN excluded.window_at ELSE mfa_attempts.window_at END,blocked_until = CASE WHEN mfa_attempts.window_at >= ${cutoff} AND mfa_attempts.attempts >= 5 THEN ${time+600000}::bigint ELSE 0 END RETURNING attempts,blocked_until`);
 if(changed&&changed.blocked_until>time)throw new HttpError('apiError.mfa.rateLimited');
}
function cookieValue(request:Request,name:string){
 for(const part of (request.headers.get('cookie')??'').split(';')){const [key,...rest]=part.trim().split('=');if(key===name)return rest.join('=');}return '';
}
// The MFA session token of a request: only the session cookie, also when it has
// expired. A header never authenticates, so a stolen page token cannot either.
const mfaSessionToken=(request:Request)=>cookieValue(request,sessionCookieName);
const validToken=(token:string)=>/^[a-f0-9]{64}$/.test(token);
const cookie=(name:string,token:string,maxAge:number)=>`${name}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0,Math.floor(maxAge))}`;
export const clearMfaSessionCookie=()=>cookie(sessionCookieName,'',0);
/** The MFA session cookie of a new session, for the sign-in with Microsoft Entra ID (lib/server/identity/entra/sign-in.ts). */
export const mfaSessionCookie=(token:string,maxAgeSeconds:number)=>cookie(sessionCookieName,token,maxAgeSeconds);
/** Clears the cookie of the removed remembered browser, so old browsers drop it. */
export const clearMfaTrustCookie=()=>cookie(removedTrustCookieName,'',0);
/** The grant cookie up to the grant's `expiresAt` (app time). */
export const mfaGrantCookie=(token:string,expiresAt:number,time=now())=>cookie(grantCookieName,token,(expiresAt-time)/1000);
export const clearMfaGrantCookie=()=>cookie(grantCookieName,'',0);
type MfaSession={token_hash:string;principal:string;created_at:number;last_activity:number;idle_expires_at:number;expires_at:number};
/** A row of mfa_grants (docs/portal-sessions.md, "What each sign-in asks for"). */
export type MfaGrant={token_hash:string;principal:string;user_id:string;created_at:number;expires_at:number};
/** The SHA-256 of the request's grant cookie, or null without a well-formed one. */
export async function grantCookieHash(request:Request){const token=cookieValue(request,grantCookieName);return validToken(token)?hash(token):null;}
/**
 * SQL: the grant `grantHash` of the principal `key` is live at app time `time`
 * and the switch "Ask for MFA after an automatic sign-out" is off. Every
 * statement that uses a grant carries it, so a delete or a switch to on that
 * commits first wins.
 */
export const liveGrantSql=(grantHash:string,key:string|Sql,time:number)=>sql`EXISTS (SELECT 1 FROM mfa_grants live_grant WHERE live_grant.token_hash=${grantHash} AND live_grant.principal=${key} AND live_grant.expires_at>${time}) AND ${grantAllowedSql}`;
/** The live grant of the request's cookie for the principal `key` (liveGrantSql), or null. A cookie of another account never matches. */
export async function liveGrant(request:Request,key:string,time=now()):Promise<MfaGrant|null>{
 const grantHash=await grantCookieHash(request);if(!grantHash)return null;
 const row=await db().one<MfaGrant>(sql`SELECT token_hash,principal,user_id,created_at,expires_at FROM mfa_grants WHERE token_hash=${grantHash} AND principal=${key} AND expires_at>${time} AND ${grantAllowedSql}`);
 return row?{...row,created_at:Number(row.created_at),expires_at:Number(row.expires_at)}:null;
}
/**
 * SQL of a password sign-in through a grant (lib/server/identity/local-auth.ts, login):
 * the live grant, an enrolled MFA account, and not the emergency access while
 * Microsoft sign-in only is on (docs/entra-id.md).
 */
export const passwordGrantSql=(grantHash:string,key:string,time:number)=>sql`${liveGrantSql(grantHash,key,time)} AND EXISTS (SELECT 1 FROM mfa_accounts grant_account WHERE grant_account.principal=${key}) AND NOT ${emergencyPrincipalFixedSql(key)}`;
/** The pre-check of passwordGrantSql: the grant a password sign-in of `key` may use, or null. */
export async function passwordGrant(request:Request,key:string,time=now()):Promise<MfaGrant|null>{
 const grant=await liveGrant(request,key,time);
 if(!grant)return null;
 return await db().one(sql`SELECT 1 AS usable WHERE ${passwordGrantSql(grant.token_hash,key,time)}`)?grant:null;
}
/** The absolute end of an MFA session opened through `grant`: 24 hours from now, but at most 24 hours after the MFA of the grant. */
export const grantSessionExpiry=(grant:{created_at:number},time:number)=>Math.min(time+mfaSessionLifetimeMs,Number(grant.created_at)+mfaSessionLifetimeMs);
/**
 * A new grant for the principal `key` (account `userId`, an ID or SQL) at app
 * time `time`: its token and cookie, and the insert, which runs only while
 * `guard` holds and the switch is off (grantAllowedSql).
 */
export async function newGrantStatement({key,userId,time,guard}:{key:string;userId:string|Sql;time:number;guard:Sql}){
 const token=random(),tokenHash=await hash(token),expiresAt=time+MFA_GRANT_LIFETIME_MS;
 return {token,tokenHash,expiresAt,cookie:mfaGrantCookie(token,expiresAt,time),
  insert:sql`INSERT INTO mfa_grants(token_hash,principal,user_id,created_at,expires_at) SELECT ${tokenHash}::text,${key}::text,${userId}::text,${time}::bigint,${expiresAt}::bigint WHERE (${guard}) AND ${grantAllowedSql}`};
}
async function liveSession(request:Request,v:Viewer):Promise<MfaSession|null>{
 const token=mfaSessionToken(request);if(!validToken(token))return null;
 const time=now();
 // The anchor is the mfa_accounts row, or the account itself for an account from
 // Microsoft Entra ID, whose MFA ran at Entra (mfaAnchorSql, lib/server/identity/access.ts).
 const session=await db().one<MfaSession>(sql`SELECT s.* FROM mfa_sessions s WHERE s.token_hash = ${await hash(token)} AND s.principal = ${principal(v)} AND s.idle_expires_at > ${time} AND s.expires_at > ${time} AND ${mfaAnchorSql(sql`s.principal`)}`);
 if(session){
  const {requireBoundLocalMfa}=await import('./local-auth');
  try{await requireBoundLocalMfa(request,v,session.token_hash);}
  catch(error){if(error instanceof HttpError&&['MFA_LOGIN_REQUIRED','SESSION_EXPIRED','IDENTITY_LOGIN_REQUIRED'].includes(error.code??''))return null;throw error;}
 }
 return session;
}
function sessionFields(session:MfaSession|null,idleTimeoutMs:number){return {
 authenticated:!!session,verifiedUntil:session?Math.min(session.idle_expires_at,session.expires_at):null,
 idleExpiresAt:session?.idle_expires_at??null,sessionExpiresAt:session?.expires_at??null,
 idleTimeoutMs,serverTime:now(),lastActivityAt:session?.last_activity??null,
 // A non-bearer identifier lets concurrent status/activity replies be merged.
 sessionId:session?.token_hash.slice(0,24)??null,
};}
async function passkeyCount(v:Viewer){return (await db().one<{count:number}>(sql`SELECT COUNT(*) AS count FROM passkey_credentials WHERE principal = ${principal(v)}`))?.count??0;}
// A plain count of the principal's authenticator apps.
export async function authenticatorCount(v:Viewer){return (await db().one<{count:number}>(sql`SELECT COUNT(*) AS count FROM mfa_authenticators WHERE principal = ${principal(v)}`))?.count??0;}
// While MFA is enabled at least one factor remains: a passkey or an authenticator.
// Factor deletes guard their commit with this predicate, so two concurrent
// deletes cannot remove the last two factors.
export const factorsRemainSql=(key:string)=>sql`(SELECT COUNT(*) FROM mfa_authenticators WHERE principal = ${key}) + (SELECT COUNT(*) FROM passkey_credentials WHERE principal = ${key}) > 1`;
// The principal's authenticator apps. The account row in mfa_accounts stays the
// session and recovery anchor; its secret is never used for authentication.
async function authenticatorRows(v:Viewer){
 return (await db().query<AuthenticatorRow>(sql`SELECT * FROM mfa_authenticators WHERE principal = ${principal(v)} ORDER BY created_at,id`));
}
function authenticatorMetadata(rows:AuthenticatorRow[]){return {authenticatorCount:rows.length,maximumAuthenticators,authenticators:rows.map(row=>({id:row.id,name:row.name,createdAt:row.created_at,lastUsedAt:row.last_used_at}))};}
export async function mfaStatus(request:Request,v:Viewer){
 const [enabled,session,idleTimeoutMs]=await Promise.all([isMfaEnabled(v),liveSession(request,v),sessionIdleTimeoutMs()]);
 const rows=enabled?await authenticatorRows(v):[];
 // passkeys.ts imports this module, so it is loaded lazily to avoid an import cycle.
 const {passkeysAvailable}=await import('./passkeys');
 return {enabled,available:mfaAvailable(),passkeysAvailable:passkeysAvailable(),...sessionFields(session,idleTimeoutMs),passkeyCount:enabled?await passkeyCount(v):0,authenticatorCount:rows.length,maximumAuthenticators,authenticators:session?authenticatorMetadata(rows).authenticators:[]};
}
export async function mfaProofUntil(request:Request,v:Viewer):Promise<number|null>{
 const session=await liveSession(request,v);return session?Math.min(session.idle_expires_at,session.expires_at):null;
}
export async function mfaSessionHash(request:Request,v:Viewer){
 const session=await liveSession(request,v);if(!session){await requireMfa(request,v);throw new HttpError('apiError.mfa.sessionExpired');}return session.token_hash;
}
export async function requireMfa(request:Request,v:Viewer){
 const expires=await mfaProofUntil(request,v);
 if(!expires){
  const supplied=validToken(mfaSessionToken(request));
  throw new HttpError(supplied?'apiError.mfa.sessionExpiredSignIn':'apiError.mfa.loginRequired');
 }
 return expires;
}
// An account from Microsoft Entra ID counts as enabled: Entra ran its MFA.
export async function isMfaEnabled(v:Viewer){return !!(await db().one(sql`SELECT 1 AS enabled WHERE ${mfaAnchorSql(sql`${principal(v)}`)}`));}
/**
 * Accounts from Microsoft Entra ID (docs/entra-id.md) have no portal factors:
 * no authenticator app, recovery code or passkey. They confirm with a fresh
 * Microsoft sign-in (lib/server/identity/entra/confirm.ts) instead. Every factor action refuses
 * them before it reads or writes anything.
 */
export const isEntraViewer=(v:Viewer)=>v.identitySource==='entra';
export function refuseEntraFactors(v:Viewer){if(isEntraViewer(v))throw new HttpError('apiError.mfa.entraManaged');}
// The SQL side of refuseEntraFactors for the statements that create an mfa_accounts row.
const notEntraSql=(key:string)=>sql`NOT EXISTS (SELECT 1 FROM local_users entra_account WHERE entra_account.auth_principal = ${key} AND entra_account.identity_source = 'entra')`;
export const localFactorsSql=notEntraSql;
export type PasskeySessionGrant={challengeId:string;browserHash:string;credentialId:string;counter:number;newCounter:number;backedUp:boolean};
// `consume` advances the TOTP counter inside the login batch; without it the
// grant only proves that a just-enrolled authenticator exists.
type AuthenticatorSessionGrant={id:string;secretEnc:string;counter:number;consume?:boolean};
// The recovery hash list before and after removing the used code.
type RecoverySessionGrant={previous:string;next:string};
// Statements that must commit together with the session, e.g. a first enrollment.
// `check` sees their results before the session insert is checked.
type SessionPrelude={statements:Step[];check?:(results:StepResult[])=>void};
// A passkey that the prelude enrolls (first setup). The session records it and is
// inserted only when this batch's credential row exists.
type PasskeySetupGrant={credentialId:string;createdAt:number};
/**
 * A confirmed fresh Microsoft sign-in (lib/server/identity/entra/confirm.ts): the confirm flow
 * with this claim hash, started from the primary session `primaryHash` by the
 * Entra account `userId`. It stands in for the mfa_accounts anchor of the
 * session insert, which an Entra account never has. The flow row goes and the
 * attempt reservation of its start comes back in the same batch.
 */
export type EntraSessionGrant={claimHash:string;primaryHash:string;userId:string;attempt:{bucket:string;window_at:number}};
// One batch holds the proof consumption, the session, management proof, MFA
// grant, the primary-session binding of local viewers and, if given, the audit row.
// `at` fixes the app time, so a prelude guarded by localBindGuard at the same
// time is refused exactly when the binding is.
// Each consumption is guarded by its unused state before the session insert and
// applied after it only if the session exists, so a failed batch leaves every
// code, counter and challenge reusable.
export async function issueSession(v:Viewer,{resetAttempts=false,request,passkeyGrant,passkeySetup,authenticatorGrant,recoveryGrant,entraGrant,prelude,audit,conflict,at}:{resetAttempts?:boolean;request?:Request;passkeyGrant?:PasskeySessionGrant;passkeySetup?:PasskeySetupGrant;authenticatorGrant?:AuthenticatorSessionGrant;recoveryGrant?:RecoverySessionGrant;entraGrant?:EntraSessionGrant;prelude?:SessionPrelude;audit?:AuditEntry;conflict?:HttpError;at?:number}={}){
 if(!request)throw new HttpError('apiError.auth.passwordFirst');
 const token=random(),key=principal(v),time=at??now(),[idleTimeoutMs,idleRequiresMfa,emergency]=await Promise.all([sessionIdleTimeoutMs(),sessionIdleRequiresMfa(),entraGrant?false:emergencyPrincipalFixed(principal(v))]),expires=time+mfaSessionLifetimeMs,idleExpires=Math.min(expires,time+idleTimeoutMs);
 const sessionHash=await hash(token),cookies=[cookie(sessionCookieName,token,(expires-time)/1000)];
 const {bindLocalMfaStatements,clientAddress,primaryAuthenticationGuard}=await import('./local-auth');
 const authentication=await primaryAuthenticationGuard(request,v);
 const binding=await bindLocalMfaStatements(request,v,sessionHash,time);
 const sessionExists=sql`EXISTS (SELECT 1 FROM mfa_sessions WHERE token_hash = ${sessionHash} AND principal = ${key})`;
 // Row locks on the counters this login consumes; they only spare a retry.
 const locks=[...authenticatorGrant?.consume?[sql`SELECT id FROM mfa_authenticators WHERE id = ${authenticatorGrant.id} FOR UPDATE`]:[],...recoveryGrant?[sql`SELECT principal FROM mfa_accounts WHERE principal = ${key} FOR UPDATE`]:[]];
 const queries:Step[]=[...prelude?.statements??[],...locks,sql`DELETE FROM mfa_sessions WHERE expires_at <= ${time} OR idle_expires_at <= ${time}`,sql`DELETE FROM mfa_grants WHERE expires_at <= ${time}`,sql`DELETE FROM mfa_management_proofs WHERE expires_at <= ${time} OR NOT EXISTS (SELECT 1 FROM mfa_sessions s WHERE s.token_hash = mfa_management_proofs.session_hash AND s.idle_expires_at > ${time} AND s.expires_at > ${time})`,sql`DELETE FROM mfa_authenticator_challenges WHERE expires_at <= ${time} OR NOT EXISTS (SELECT 1 FROM mfa_sessions s WHERE s.token_hash = mfa_authenticator_challenges.session_hash AND s.idle_expires_at > ${time} AND s.expires_at > ${time})`];
 const bindInsert=queries.length;if(binding)queries.push(binding.bind);
 const sessionInsert=queries.length;
 const none=sql``;
 const passkeyGuard=passkeyGrant?sql` AND EXISTS (SELECT 1 FROM passkey_challenges WHERE id = ${passkeyGrant.challengeId} AND principal = ${key} AND purpose = 'authentication' AND browser_hash = ${passkeyGrant.browserHash} AND expires_at > ${time}) AND EXISTS (SELECT 1 FROM passkey_credentials WHERE id = ${passkeyGrant.credentialId} AND principal = ${key} AND counter = ${passkeyGrant.counter})`:none;
 const authenticatorGuard=authenticatorGrant?sql` AND EXISTS (SELECT 1 FROM mfa_authenticators WHERE id = ${authenticatorGrant.id} AND principal = ${key} AND secret_enc = ${authenticatorGrant.secretEnc} AND last_counter ${authenticatorGrant.consume?sql`<`:sql`>=`} ${authenticatorGrant.counter})`:none;
 const recoveryGuard=recoveryGrant?sql` AND EXISTS (SELECT 1 FROM mfa_accounts WHERE principal = ${key} AND recovery_hashes = ${recoveryGrant.previous})`:none;
 const setupGuard=passkeySetup?sql` AND EXISTS (SELECT 1 FROM passkey_credentials WHERE id = ${passkeySetup.credentialId} AND principal = ${key} AND created_at = ${passkeySetup.createdAt})`:none;
 const passkeyId=passkeyGrant?.credentialId??passkeySetup?.credentialId??null;
 // The anchor of the new session: the mfa_accounts row, or for an entraGrant the
 // confirmed flow of this claim, primary session and account, an active Entra
 // account with this principal, and the settings revision the flow started under.
 const anchor=entraGrant?sql`EXISTS (SELECT 1 FROM entra_sign_in_flows grant_flow JOIN local_users grant_user ON grant_user.id = grant_flow.user_id JOIN entra_settings grant_settings ON grant_settings.id = 1 AND grant_settings.enabled = 1 AND grant_settings.revision = grant_flow.settings_revision WHERE grant_flow.claim_hash = ${entraGrant.claimHash} AND grant_flow.primary_hash = ${entraGrant.primaryHash} AND grant_flow.user_id = ${entraGrant.userId} AND grant_flow.purpose = 'confirm' AND grant_flow.confirmed_at IS NOT NULL AND grant_flow.outcome IS NULL AND grant_flow.expires_at > ${time} AND grant_user.auth_principal = ${key} AND grant_user.identity_source = 'entra' AND grant_user.status = 'active')`:sql`EXISTS (SELECT 1 FROM mfa_accounts WHERE principal = ${key})`;
 queries.push(sql`INSERT INTO mfa_sessions (token_hash,principal,created_at,last_activity,idle_expires_at,expires_at,passkey_id) SELECT ${sessionHash}::text,${key}::text,${time}::bigint,${time}::bigint,${idleExpires}::bigint,${expires}::bigint,${passkeyId}::text WHERE ${anchor}${passkeyGuard}${setupGuard}${authenticatorGuard}${recoveryGuard} AND (${authentication})${binding?sql` AND ${binding.bound}`:none}`);
 if(resetAttempts)queries.push(sql`DELETE FROM mfa_attempts WHERE principal = ${key} AND ${sessionExists}`);
 if(entraGrant)queries.push(
  sql`DELETE FROM entra_sign_in_flows WHERE claim_hash = ${entraGrant.claimHash} AND primary_hash = ${entraGrant.primaryHash} AND user_id = ${entraGrant.userId} AND ${sessionExists}`,
  sql`UPDATE local_auth_attempts SET attempts = GREATEST(attempts-1,0) WHERE bucket = ${entraGrant.attempt.bucket} AND window_at = ${entraGrant.attempt.window_at} AND ${sessionExists}`,
 );
 if(recoveryGrant)queries.push(sql`UPDATE mfa_accounts SET recovery_hashes = ${recoveryGrant.next} WHERE principal = ${key} AND recovery_hashes = ${recoveryGrant.previous} AND ${sessionExists}`);
 if(authenticatorGrant?.consume)queries.push(sql`UPDATE mfa_authenticators SET last_counter = ${authenticatorGrant.counter},last_used_at = ${time} WHERE id = ${authenticatorGrant.id} AND principal = ${key} AND secret_enc = ${authenticatorGrant.secretEnc} AND last_counter < ${authenticatorGrant.counter} AND ${sessionExists}`);
 const managementToken=resetAttempts?random():undefined,managementExpiresAt=resetAttempts?Math.min(time+managementLifetimeMs,idleExpires,expires):undefined;
 if(managementToken)queries.push(sql`INSERT INTO mfa_management_proofs (token_hash,principal,session_hash,expires_at) SELECT ${await hash(managementToken)}::text,${key}::text,${sessionHash}::text,${managementExpiresAt!}::bigint WHERE EXISTS (SELECT 1 FROM mfa_sessions WHERE token_hash = ${sessionHash} AND principal = ${key} AND idle_expires_at > ${time} AND expires_at > ${time}) AND (${authentication})`);
 if(passkeyGrant){
  queries.push(sql`UPDATE passkey_credentials SET counter = ${passkeyGrant.newCounter},backed_up = ${passkeyGrant.backedUp?1:0},last_used_at = ${time} WHERE id = ${passkeyGrant.credentialId} AND principal = ${key} AND counter = ${passkeyGrant.counter} AND EXISTS (SELECT 1 FROM mfa_sessions WHERE token_hash = ${sessionHash})`);
  queries.push(sql`DELETE FROM passkey_challenges WHERE id = ${passkeyGrant.challengeId} AND principal = ${key}`);
 }
 // The new session token_hash is this batch's effect marker. For local viewers
 // the bound primary session must exist too, or no login happened.
 const issued=sql`${sessionExists}${binding?sql` AND ${binding.bound}`:none}`;
 // A sign-in MFA (docs/portal-sessions.md): this batch binds a primary session
 // that is still pending (password only). It ends the grant of the browser's
 // cookie and gives the browser a new grant for MFA_GRANT_LIFETIME_MS, while the
 // switch is off and the account is not the emergency access under Microsoft
 // sign-in only. A step-up binds a bound session and touches no grant; a
 // confirmation with Microsoft (entraGrant) never binds a pending one.
 let grantInsert=-1;
 if(binding?.source.pending&&!entraGrant){
  const previousGrant=await grantCookieHash(request);
  if(previousGrant)queries.push(sql`DELETE FROM mfa_grants WHERE token_hash = ${previousGrant} AND ${issued}`);
  if(!idleRequiresMfa&&!emergency){
   const grant=await newGrantStatement({key,userId:binding.source.userId,time,guard:sql`${issued} AND EXISTS (SELECT 1 FROM mfa_accounts WHERE principal = ${key}) AND NOT ${emergencyPrincipalFixedSql(key)}`});
   grantInsert=queries.length;queries.push(grant.insert);cookies.push(grant.cookie);
  }else if(previousGrant)cookies.push(clearMfaGrantCookie());
 }
 cookies.push(clearMfaTrustCookie());
 // An emergency sign-in (docs/entra-id.md): this batch binds a primary session
 // that is still pending (password only) of the emergency access account while
 // Microsoft sign-in only is on. The alarm, its notification event and the audit
 // row commit with the session or not at all. They run before `finish`, which
 // retires the pending session the guard reads. A step-up binds an already bound
 // session and writes none of them.
 if(binding?.source.pending&&!entraGrant)queries.push(...emergencySignInStatements({userId:binding.source.userId,actor:v.label,address:clientAddress(request),time,
  guard:sql`${issued} AND EXISTS (SELECT 1 FROM local_auth_sessions pending_source WHERE pending_source.token_hash = ${binding.source.tokenHash} AND pending_source.mfa_hash IS NULL)`}));
 // The MFA session this browser had before ends with this batch. It goes after
 // every statement that reads `authentication`: a bound primary session counts
 // only while its MFA session is live, and a step-up binds exactly that one.
 const previous=mfaSessionToken(request);if(validToken(previous)){
  const previousHash=await hash(previous);
  queries.push(...['mfa_management_proofs','mfa_authenticator_challenges'].map(table=>sql`DELETE FROM ${sql.ident(table)} WHERE session_hash = ${previousHash} AND principal = ${key}`),sql`DELETE FROM mfa_sessions WHERE token_hash = ${previousHash} AND principal = ${key}`);
 }
 if(binding)queries.push(...binding.finish);
 const results=audit?(await commitWithAudit(queries,{audit,guard:issued})).results:await commitAll(queries);
 prelude?.check?.(results);
 if(!results[sessionInsert]?.rowCount){
  // A password reset, logout or concurrent account suspension leaves no
  // binding, and without it no MFA session, proof or grant was created.
  if(binding&&!results[bindInsert]?.rowCount)throw new HttpError('apiError.auth.loginExpired');
  throw conflict??new HttpError('apiError.mfa.loginRequired');
 }
 // A switch to on that committed between the read above and this batch left no
 // grant row: the browser drops the new cookie instead.
 if(grantInsert>=0&&!results[grantInsert]?.rowCount){const index=cookies.findIndex(value=>value.startsWith(grantCookieName+'='));cookies.splice(index,1,clearMfaGrantCookie());}
 if(binding)cookies.push(...binding.cookies);
 // The session tokens leave only as HttpOnly cookies, never in the reply body.
 return {enabled:true,available:mfaAvailable(),...sessionFields({token_hash:sessionHash,principal:key,created_at:time,last_activity:time,idle_expires_at:idleExpires,expires_at:expires},idleTimeoutMs),cookies,passkeyCount:await passkeyCount(v),...(managementToken?{managementToken,managementExpiresAt}:{})};
}
export async function recordMfaActivity(request:Request,v:Viewer){
 await requireMfa(request,v);const token=mfaSessionToken(request);
 const time=now(),idleTimeoutMs=await sessionIdleTimeoutMs();
 // The deadline condition and update share one atomic statement: activity cannot
 // resurrect a session that expired while another tab was still polling.
 const session=await db().one<MfaSession>(sql`UPDATE mfa_sessions SET last_activity = GREATEST(last_activity,${time}),idle_expires_at = LEAST(expires_at,GREATEST(idle_expires_at,${time+idleTimeoutMs})) WHERE token_hash = ${await hash(token)} AND principal = ${principal(v)} AND idle_expires_at > ${time} AND expires_at > ${time} AND ${mfaAnchorSql(sql`${principal(v)}`)} RETURNING *`);
 if(!session)throw new HttpError('apiError.mfa.sessionExpiredSignIn');
 return {enabled:true,available:mfaAvailable(),...sessionFields(session,idleTimeoutMs),passkeyCount:await passkeyCount(v)};
}
/** Sign out ends the grant of the request's cookie, whichever account it belongs to: the bearer holds its token. */
export async function grantLogoutStatements(request:Request):Promise<Step[]>{const grantHash=await grantCookieHash(request);return grantHash?[sql`DELETE FROM mfa_grants WHERE token_hash = ${grantHash}`]:[];}
export async function logoutMfaStatements(request:Request,v:Viewer,idle=false,boundSessionHash?:string){
 const key=principal(v),token=mfaSessionToken(request),queries:Step[]=[];
 const passkeyBrowser=cookieValue(request,'__Host-serverdesk-passkey');
 if(validToken(passkeyBrowser))queries.push(sql`DELETE FROM passkey_challenges WHERE principal = ${key} AND browser_hash = ${await hash(passkeyBrowser)}`);
 const sessions=new Set<string>();if(validToken(token))sessions.add(await hash(token));if(boundSessionHash&&validToken(boundSessionHash))sessions.add(boundSessionHash);
 for(const sessionHash of sessions){
  queries.push(...['mfa_management_proofs','mfa_authenticator_challenges'].map(table=>sql`DELETE FROM ${sql.ident(table)} WHERE session_hash = ${sessionHash} AND principal = ${key}`),sql`DELETE FROM mfa_sessions WHERE token_hash = ${sessionHash} AND principal = ${key}`);
 }
 // An explicit sign-out also ends the MFA grant of this browser; an idle one keeps it.
 if(!idle)queries.push(...await grantLogoutStatements(request));
 return {queries,cookies:idle?[clearMfaSessionCookie()]:[clearMfaSessionCookie(),clearMfaGrantCookie(),clearMfaTrustCookie()]};
}
export async function logoutMfa(request:Request,v:Viewer,idle=false){
 const {queries,cookies}=await logoutMfaStatements(request,v,idle);if(queries.length)await commitAll(queries);return cookies;
}
export async function recoveryCodes(key:string){
 const codes=Array.from({length:10},()=>random().slice(0,32).toUpperCase().match(/.{4}/g)!.join('-'));
 return {codes,hashes:JSON.stringify(await Promise.all(codes.map(c=>hash(key+'\0'+c.replace(/-/g,'')))))};
}
export async function beginMfa(request:Request,v:Viewer){
 refuseEntraFactors(v);
 if(await isMfaEnabled(v))throw new HttpError('apiError.mfa.alreadySetUp');
 const key=principal(v),secret=base32(crypto.getRandomValues(new Uint8Array(20))),expiresAt=now()+600000;
 const secretEnc=await encryptSecret(secret,key),{primaryAuthenticationGuard}=await import('./local-auth'),authentication=await primaryAuthenticationGuard(request,v);
 const result=await db().exec(sql`INSERT INTO mfa_challenges (principal,secret_enc,expires_at) SELECT ${key}::text,${secretEnc}::text,${expiresAt}::bigint WHERE (${authentication}) AND NOT EXISTS (SELECT 1 FROM mfa_accounts WHERE principal = ${key}) ON CONFLICT(principal) DO UPDATE SET secret_enc = excluded.secret_enc,expires_at = excluded.expires_at`);
 if(!result.rowCount)throw new HttpError('apiError.auth.loginExpiredSignIn');
 return {secret,uri:otpauthUri(productName+':'+(v.username??v.label),secret),expiresAt};
}
export async function confirmMfa(request:Request,v:Viewer,code:unknown){
 refuseEntraFactors(v);
 const key=principal(v);if(await isMfaEnabled(v))throw new HttpError('apiError.mfa.alreadySetUp');await countAttempt(key);
 const challenge=await db().one<{secret_enc:string;expires_at:number}>(sql`SELECT secret_enc,expires_at FROM mfa_challenges WHERE principal = ${key}`);
 if(!challenge||challenge.expires_at<=now())throw new HttpError('apiError.mfa.setupExpired');
 const counter=await codeCounter(await decryptSecret(challenge.secret_enc,key),code);if(counter===null)throw new HttpError('apiError.mfa.codeInvalid');
 const recovery=await recoveryCodes(key),time=now(),id=random();
 const {primaryAuthenticationGuard}=await import('./local-auth'),authentication=await primaryAuthenticationGuard(request,v);
 // The enrollment, the challenge delete, the session and the audit row commit
 // together: a failed login transaction leaves the challenge open for a new code.
 const enrollment=[
  sql`INSERT INTO mfa_accounts (principal,secret_enc,recovery_hashes,last_counter,created_at,authenticators_migrated) SELECT ${key}::text,${challenge.secret_enc}::text,${recovery.hashes}::text,${counter}::bigint,${time}::bigint,1 WHERE EXISTS (SELECT 1 FROM mfa_challenges WHERE principal = ${key} AND secret_enc = ${challenge.secret_enc} AND expires_at > ${time} AND expires_at > ${dbNow}) AND NOT EXISTS (SELECT 1 FROM mfa_accounts WHERE principal = ${key}) AND ${notEntraSql(key)} AND (${authentication})`,
  sql`INSERT INTO mfa_authenticators (id,principal,name,secret_enc,last_counter,created_at,last_used_at) SELECT ${id}::text,${key}::text,'Authenticator',${challenge.secret_enc}::text,${counter}::bigint,${time}::bigint,${time}::bigint WHERE EXISTS (SELECT 1 FROM mfa_challenges WHERE principal = ${key} AND secret_enc = ${challenge.secret_enc} AND expires_at > ${time} AND expires_at > ${dbNow}) AND EXISTS (SELECT 1 FROM mfa_accounts WHERE principal = ${key} AND secret_enc = ${challenge.secret_enc}) AND NOT EXISTS (SELECT 1 FROM mfa_authenticators WHERE principal = ${key}) AND (${authentication})`,
  sql`UPDATE mfa_accounts SET secret_enc = 'migrated:authenticator-managed',last_counter = -1 WHERE principal = ${key} AND secret_enc = ${challenge.secret_enc} AND EXISTS (SELECT 1 FROM mfa_authenticators WHERE id = ${id} AND principal = ${key})`,
  sql`DELETE FROM mfa_challenges WHERE principal = ${key} AND secret_enc = ${challenge.secret_enc}`,
 ];
 const check=(results:StepResult[])=>{if(!results[0]?.rowCount||!results[1]?.rowCount)throw new HttpError('apiError.mfa.setupUsed');};
 const session=await issueSession(v,{resetAttempts:true,request,authenticatorGrant:{id,secretEnc:challenge.secret_enc,counter},prelude:{statements:enrollment,check},audit:{actor:v.label,action:'MFA eingerichtet',target:v.label}});
 return {...session,recoveryCodes:recovery.codes,...authenticatorMetadata(await authenticatorRows(v))};
}
export async function verifyMfa(v:Viewer,code:unknown,recoveryCode:unknown,request?:Request){
 refuseEntraFactors(v);
 const key=principal(v);await countAttempt(key);
 const account=await db().one<{recovery_hashes:string}>(sql`SELECT recovery_hashes FROM mfa_accounts WHERE principal = ${key}`);
 if(!account)throw new HttpError('apiError.mfa.setUpFirst');
 // The code is only checked here. It is consumed in the login batch, together
 // with the session and the audit row, so a failed batch keeps it usable.
 const audit={actor:v.label,action:'MFA angemeldet',target:v.label};
 let grant:{recoveryGrant:RecoverySessionGrant}|{authenticatorGrant:AuthenticatorSessionGrant}|undefined,conflict:HttpError;
 if(typeof recoveryCode==='string'&&recoveryCode){
  const normalized=recoveryCode.toUpperCase().replace(/-/g,'');if(!/^[A-F0-9]{32}$/.test(normalized))throw new HttpError('apiError.mfa.recoveryInvalid');
  const digest=await hash(key+'\0'+normalized),hashes=JSON.parse(account.recovery_hashes) as string[];
  if(!hashes.includes(digest))throw new HttpError('apiError.mfa.recoveryInvalidOrUsed');
  grant={recoveryGrant:{previous:account.recovery_hashes,next:JSON.stringify(hashes.filter(h=>h!==digest))}};
  conflict=new HttpError('apiError.mfa.recoveryConcurrent');
 }else{
  const rows=await authenticatorRows(v);
  // Every enrolled app has its own secret and replay counter; the default
  // credential is not also checked through the account row.
  for(const row of rows){
   const counter=await codeCounter(await decryptSecret(row.secret_enc,key),code,row.last_counter);if(counter===null)continue;
   grant={authenticatorGrant:{id:row.id,secretEnc:row.secret_enc,counter,consume:true}};break;
  }
  if(!grant)throw new HttpError('apiError.mfa.codeInvalidOrUsed');
  conflict=new HttpError('apiError.mfa.codeUsedOrChanged');
 }
 return {...await issueSession(v,{resetAttempts:true,request,...grant,audit,conflict}),...authenticatorMetadata(await authenticatorRows(v))};
}
function authenticatorName(value:unknown){
 if(typeof value!=='string'||!value.trim()||value.trim().length>80||/[\u0000-\u001f\u007f]/.test(value))throw new HttpError('apiError.mfa.authenticatorName');
 return value.trim();
}
function authenticatorId(value:unknown){if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw new HttpError('apiError.mfa.invalidAuthenticator');return value;}
const managementGuard=(tokenHash:string,key:string,sessionHash:string,time:number)=>sql`EXISTS (SELECT 1 FROM mfa_management_proofs p JOIN mfa_sessions s ON s.token_hash = p.session_hash AND s.principal = p.principal WHERE p.token_hash = ${tokenHash} AND p.principal = ${key} AND p.session_hash = ${sessionHash} AND p.expires_at > ${time} AND s.idle_expires_at > ${time} AND s.expires_at > ${time} AND LEAST(p.expires_at,s.idle_expires_at,s.expires_at)>${dbNow} AND ${mfaAnchorSql(sql`p.principal`)})`;
// The proof of an account from Microsoft Entra ID comes from a fresh Microsoft
// sign-in (lib/server/identity/entra/confirm.ts, docs/entra-id.md); it is checked like any other.
async function managementProof(request:Request,v:Viewer,value:unknown){
 const sessionHash=await mfaSessionHash(request,v),key=principal(v),time=now();
 if(typeof value!=='string'||!validToken(value))throw new HttpError('apiError.mfa.confirmChange');
 const tokenHash=await hash(value),guard=managementGuard(tokenHash,key,sessionHash,time);
 if(!await db().one(sql`SELECT 1 AS valid WHERE ${guard}`))throw new HttpError('apiError.mfa.proofExpired');
 return {sessionHash,key,tokenHash,time,guard};
}
// IAM/password writes use the proof's guard in their committing transaction, then
// consume the proof once. A prior read alone never authorizes a later mutation.
export const readMfaManagementProof=managementProof;
// Proof-based account-security writes guard every effect with this predicate:
// the live proof, its MFA session and the request's primary session (rbac.ts).
// rbac.ts imports this module, so rbac is loaded lazily to avoid an import cycle.
export async function managementAuthorization(request:Request,v:Viewer,value:unknown){
 const {prepareManagementAuthorization}=await import('./rbac');return prepareManagementAuthorization(request,v,value);
}
// Consumes the request's own proof. It is the last statement of each committing
// batch and runs unconditionally: a stale request may lose only its own proof.
export const ownProofDelete=(auth:ManagementAuthorization)=>sql`DELETE FROM mfa_management_proofs WHERE token_hash = ${auth.tokenHash} AND principal = ${auth.key} AND session_hash = ${auth.sessionHash}`;
// Read-only re-check after a commit changed nothing: throws the existing 401
// when the request's MFA session or its bound primary session is no longer live.
export async function requireLiveSessions(request:Request,v:Viewer){
 await mfaSessionHash(request,v);const {primaryGuard}=await import('./local-auth');await primaryGuard(request,v);
}
export async function beginAuthenticator(request:Request,v:Viewer,p:Record<string,unknown>){
 refuseEntraFactors(v);
 const auth=await managementAuthorization(request,v,p.managementToken),name=authenticatorName(p.name),rows=await authenticatorRows(v),time=now();
 const target=p.id===undefined?null:rows.find(row=>row.id===authenticatorId(p.id));
 if(p.id!==undefined&&!target)throw new HttpError('apiError.mfa.authenticatorNotFound');
 if(!target&&rows.length>=maximumAuthenticators)throw new HttpError('apiError.mfa.authenticatorLimit');
 const id=random(),secret=base32(crypto.getRandomValues(new Uint8Array(20))),encrypted=await encryptSecret(secret,auth.key),expiresAt=time+managementLifetimeMs;
 const targetGuard=target?sql`EXISTS (SELECT 1 FROM mfa_authenticators WHERE id = ${target.id} AND principal = ${auth.key} AND secret_enc = ${target.secret_enc})`:sql`(SELECT COUNT(*) FROM mfa_authenticators WHERE principal = ${auth.key}) < ${maximumAuthenticators}`;
 // The pending challenge has no audit row, so a plain transaction commits it.
 const results=await commitAll([
  sql`DELETE FROM mfa_management_proofs WHERE expires_at <= ${time}`,
  sql`DELETE FROM mfa_authenticator_challenges WHERE expires_at <= ${time}`,
  sql`INSERT INTO mfa_authenticator_challenges (id,principal,session_hash,authenticator_id,previous_secret_enc,name,secret_enc,expires_at) SELECT ${id}::text,${auth.key}::text,${auth.sessionHash}::text,${target?.id??null}::text,${target?.secret_enc??null}::text,${name}::text,${encrypted}::text,${expiresAt}::bigint WHERE (${auth.guard}) AND ${targetGuard}`,
  ownProofDelete(auth),
 ]);
 if(!results[2]?.rowCount){
  if(!results[3]?.rowCount)throw new HttpError('apiError.mfa.stepUpRequired');
  await requireLiveSessions(request,v);
  throw new HttpError('apiError.mfa.loginOrAuthenticatorChanged');
 }
 return {challengeId:id,secret,uri:otpauthUri(productName+':'+v.label+' ('+name+')',secret),expiresAt};
}
const authenticatorChallengeGuard=(id:string,key:string,sessionHash:string,time:number)=>sql`EXISTS (SELECT 1 FROM mfa_authenticator_challenges c JOIN mfa_sessions s ON s.token_hash = c.session_hash AND s.principal = c.principal JOIN mfa_accounts a ON a.principal = c.principal WHERE c.id = ${id} AND c.principal = ${key} AND c.session_hash = ${sessionHash} AND c.expires_at > ${time} AND s.idle_expires_at > ${time} AND s.expires_at > ${time})`;
export async function confirmAuthenticator(request:Request,v:Viewer,p:Record<string,unknown>){
 refuseEntraFactors(v);
 const sessionHash=await mfaSessionHash(request,v),key=principal(v),id=authenticatorId(p.challengeId),time=now();
 const challenge=await db().one<AuthenticatorChallenge>(sql`SELECT * FROM mfa_authenticator_challenges WHERE id = ${id} AND principal = ${key} AND session_hash = ${sessionHash} AND expires_at > ${time}`);
 if(!challenge)throw new HttpError('apiError.mfa.addSetupExpired');
 // Failed codes must count, so the attempt stays a standalone write.
 await countAttempt(key);
 const counter=await codeCounter(await decryptSecret(challenge.secret_enc,key),p.code);
 if(counter===null)throw new HttpError('apiError.mfa.newCodeInvalid');
 const fence=await mfaSessionFence(request,v),credentialId=challenge.authenticator_id??random(),challengeGuard=authenticatorChallengeGuard(id,key,sessionHash,time);
 const mutation=challenge.authenticator_id
  ?sql`UPDATE mfa_authenticators SET name = ${challenge.name},secret_enc = ${challenge.secret_enc},last_counter = ${counter},last_used_at = ${time} WHERE id = ${credentialId} AND principal = ${key} AND secret_enc = ${challenge.previous_secret_enc} AND ${challengeGuard} AND (${fence})`
  :sql`INSERT INTO mfa_authenticators (id,principal,name,secret_enc,last_counter,created_at,last_used_at) SELECT ${credentialId}::text,${key}::text,${challenge.name}::text,${challenge.secret_enc}::text,${counter}::bigint,${time}::bigint,${time}::bigint WHERE ${challengeGuard} AND (${fence}) AND (SELECT COUNT(*) FROM mfa_authenticators WHERE principal = ${key}) < ${maximumAuthenticators}`;
 // Effect marker: the challenge is still open and the authenticator holds its
 // new secret. Only the transaction that deletes the challenge sees both, so a
 // concurrent confirm of the same challenge finds the marker false.
 const committed=sql`${challengeGuard} AND EXISTS (SELECT 1 FROM mfa_authenticators WHERE id = ${credentialId} AND principal = ${key} AND secret_enc = ${challenge.secret_enc})`;
 const queries:Step[]=[mutation];
 if(challenge.authenticator_id){
  // A reset only becomes effective after proof of the new secret. Keep this
  // browser session, but invalidate all other sessions, every MFA grant and pending work.
  queries.push(
   sql`DELETE FROM mfa_sessions WHERE principal = ${key} AND token_hash != ${sessionHash} AND ${committed}`,
   ...['mfa_grants','mfa_management_proofs','passkey_challenges'].map(table=>sql`DELETE FROM ${sql.ident(table)} WHERE principal = ${key} AND ${committed}`),
   sql`DELETE FROM mfa_authenticator_challenges WHERE principal = ${key} AND id != ${id} AND ${committed}`,
  );
 }
 queries.push(
  sql`DELETE FROM mfa_attempts WHERE principal = ${key} AND ${committed}`,
  sql`DELETE FROM mfa_authenticator_challenges WHERE id = ${id} AND principal = ${key} AND session_hash = ${sessionHash}`,
 );
 // at:1 puts the audit row right after the mutation and before the challenge
 // delete. The cleanup deletes touch neither the fence's rows nor this
 // challenge, so the fence and the marker read the same until then.
 const {results,audited}=await commitWithAudit(queries,{audit:{actor:v.label,action:'Authenticator eingerichtet oder zurückgesetzt',target:v.label},guard:sql`(${fence}) AND ${committed}`,at:1});
 if(!audited||!results[0]?.rowCount){
  await requireLiveSessions(request,v);
  throw new HttpError('apiError.mfa.authenticatorChangedRestart');
 }
 return {ok:true,...authenticatorMetadata(await authenticatorRows(v))};
}
export async function cancelAuthenticator(request:Request,v:Viewer,p:Record<string,unknown>){
 refuseEntraFactors(v);
 const sessionHash=await mfaSessionHash(request,v),id=authenticatorId(p.challengeId);
 await db().exec(sql`DELETE FROM mfa_authenticator_challenges WHERE id = ${id} AND principal = ${principal(v)} AND session_hash = ${sessionHash}`);
 return {ok:true};
}
// Live-session fence for writes without a management proof: the request's
// primary session (primaryGuard) and its MFA session, both live by the SQL
// clock at commit time. It is prepareManagementAuthorization minus the proof.
export async function mfaSessionFence(request:Request,v:Viewer):Promise<SqlGuard>{
 const sessionHash=await mfaSessionHash(request,v),{primaryGuard}=await import('./local-auth'),primary=await primaryGuard(request,v);
 return sql`(${primary}) AND EXISTS (SELECT 1 FROM mfa_sessions live_session WHERE live_session.token_hash=${sessionHash} AND live_session.principal=${principal(v)} AND live_session.idle_expires_at>${dbNow} AND live_session.expires_at>${dbNow} AND ${mfaAnchorSql(sql`live_session.principal`)})`;
}
export async function renameAuthenticator(request:Request,v:Viewer,p:Record<string,unknown>){
 refuseEntraFactors(v);
 await requireMfa(request,v);await authenticatorRows(v);
 const name=authenticatorName(p.name),id=authenticatorId(p.id),key=principal(v),fence=await mfaSessionFence(request,v);
 // at:0 is valid: the rename changes neither the fence nor the row's existence,
 // so the guard reads the same before and after the update.
 const {results,audited}=await commitWithAudit([
  sql`UPDATE mfa_authenticators SET name = ${name} WHERE id = ${id} AND principal = ${key} AND ${fence}`,
 ],{audit:{actor:v.label,action:'Authenticator umbenannt',target:v.label},guard:sql`(${fence}) AND EXISTS (SELECT 1 FROM mfa_authenticators WHERE id = ${id} AND principal = ${key})`,at:0});
 if(!audited||!results[0]?.rowCount){
  if(!await db().one(sql`SELECT 1 AS found FROM mfa_authenticators WHERE id = ${id} AND principal = ${key}`))throw new HttpError('apiError.mfa.authenticatorNotFound');
  throw new HttpError('apiError.auth.signInAgain');
 }
 return {ok:true,...authenticatorMetadata(await authenticatorRows(v))};
}
export async function deleteAuthenticator(request:Request,v:Viewer,p:Record<string,unknown>){
 refuseEntraFactors(v);
 const auth=await managementAuthorization(request,v,p.managementToken),id=authenticatorId(p.id),rows=await authenticatorRows(v),key=auth.key;
 // Unknown ids and the last factor write nothing and leave the proof unused. The
 // last authenticator may go while a passkey remains that can be used at this
 // SITE_ORIGIN. passkeysAvailable() depends only on configuration, so this
 // pre-check needs no SQL guard.
 if(!rows.some(row=>row.id===id))throw new HttpError('apiError.mfa.authenticatorNotFound');
 if(rows.length<=1){
  if(await passkeyCount(v)===0)throw new HttpError(await emergencyPrincipalFixed(key)?'apiError.mfa.emergencyFactorRequired':'apiError.mfa.lastAuthenticator');
  // passkeys.ts imports this module, so it is loaded lazily to avoid an import cycle.
  const {passkeysAvailable}=await import('./passkeys');
  if(!passkeysAvailable())throw new HttpError('apiError.mfa.passkeysUnusableHere');
 }
 // G: live proof, MFA and primary session, the authenticator and a second factor.
 const guard=sql`(${auth.guard}) AND EXISTS (SELECT 1 FROM mfa_authenticators WHERE id = ${id} AND principal = ${key}) AND ${factorsRemainSql(key)}`;
 // at:0 is valid: no cleanup delete removes a row G reads (current session, own
 // proof, account, authenticators, passkeys), so the audit row at index 0 sees the same G
 // as the authenticator delete (delete rule of commitWithAudit).
 const {results,audited}=await commitWithAudit([
  sql`DELETE FROM mfa_sessions WHERE principal = ${key} AND token_hash != ${auth.sessionHash} AND ${guard}`,
  ...['mfa_grants','mfa_authenticator_challenges','passkey_challenges'].map(table=>sql`DELETE FROM ${sql.ident(table)} WHERE principal = ${key} AND ${guard}`),
  // Other browsers' proofs go only together with the authenticator.
  sql`DELETE FROM mfa_management_proofs WHERE principal = ${key} AND token_hash != ${auth.tokenHash} AND ${guard}`,
  sql`DELETE FROM mfa_authenticators WHERE id = ${id} AND principal = ${key} AND ${guard}`,
  ownProofDelete(auth),
 ],{audit:{actor:v.label,action:'Authenticator entfernt',target:v.label},guard,at:0});
 if(!audited||!results[5]?.rowCount){
  if(!results[6]?.rowCount)throw new HttpError('apiError.mfa.stepUpRequired');
  await requireLiveSessions(request,v);
  throw new HttpError('apiError.mfa.authenticatorChangedConfirm');
 }
 return {ok:true,...authenticatorMetadata(await authenticatorRows(v))};
}
export async function disableMfa(request:Request,v:Viewer,managementToken:unknown){
 refuseEntraFactors(v);
 const auth=await managementAuthorization(request,v,managementToken),key=auth.key;
 // The emergency access account keeps its second factor while Microsoft sign-in
 // only is on (docs/entra-id.md): refused before and in every delete.
 if(await emergencyPrincipalFixed(key))throw new HttpError('apiError.mfa.emergencyFactorRequired');
 const guard=sql`(${auth.guard}) AND NOT ${emergencyPrincipalFixedSql(key)}`;
 // Every credential delete and the account delete are guarded by `guard`. at:0 is
 // valid: `guard` reads none of the seven tables, so the audit row sees the same
 // guard as the account delete. Deleting the account ends `auth`, so the session
 // and proof cleanup after it depends only on the account being gone.
 const tables=['mfa_authenticator_challenges','mfa_authenticators','mfa_challenges','mfa_proofs','mfa_grants','passkey_credentials','passkey_challenges'];
 const {results,audited}=await commitWithAudit([
  ...tables.map(table=>sql`DELETE FROM ${sql.ident(table)} WHERE principal = ${key} AND ${guard}`),
  sql`DELETE FROM mfa_accounts WHERE principal = ${key} AND ${guard}`,
  sql`DELETE FROM mfa_sessions WHERE principal = ${key} AND NOT EXISTS (SELECT 1 FROM mfa_accounts WHERE principal = ${key})`,
  sql`DELETE FROM mfa_management_proofs WHERE principal = ${key} AND NOT EXISTS (SELECT 1 FROM mfa_accounts WHERE principal = ${key})`,
 ],{audit:{actor:v.label,action:'MFA deaktiviert',target:v.label},guard,at:0});
 if(audited&&results[tables.length]?.rowCount)return;
 if(await emergencyPrincipalFixed(key))throw new HttpError('apiError.mfa.emergencyFactorRequired');
 // A stale disable consumes nothing, so the proof is checked read-only here.
 const time=now();
 if(!await db().one(sql`SELECT 1 AS valid WHERE ${managementGuard(auth.tokenHash,key,auth.sessionHash,time)}`))throw new HttpError('apiError.mfa.stepUpRequired');
 await requireLiveSessions(request,v);
 throw new HttpError('apiError.mfa.stepUpRequired');
}
export async function regenerateRecovery(request:Request,v:Viewer,managementToken:unknown){
 refuseEntraFactors(v);
 const auth=await managementAuthorization(request,v,managementToken),recovery=await recoveryCodes(auth.key);
 // The update is fenced by the live proof, MFA and primary session. The new hash
 // list is unique to this renewal and marks its effect. A failed audit row rolls
 // back the hashes and keeps the proof for a retry.
 // at:1 puts the audit row before the own-proof delete; the marker does not read the proof, so it reads the same at either position.
 const {results,audited}=await commitWithAudit([
  sql`UPDATE mfa_accounts SET recovery_hashes = ${recovery.hashes} WHERE principal = ${auth.key} AND (${auth.guard})`,
  ownProofDelete(auth),
 ],{audit:{actor:v.label,action:'MFA-Wiederherstellungscodes erneuert',target:v.label},guard:sql`EXISTS (SELECT 1 FROM mfa_accounts WHERE principal = ${auth.key} AND recovery_hashes = ${recovery.hashes})`,at:1});
 if(!audited||!results[0]?.rowCount){
  if(!results[1]?.rowCount)throw new HttpError('apiError.mfa.stepUpRequired');
  await requireLiveSessions(request,v);
  throw new HttpError('apiError.mfa.stepUpRequired');
 }
 return recovery.codes;
}
