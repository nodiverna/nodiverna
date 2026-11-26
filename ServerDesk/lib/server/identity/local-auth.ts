import {config,hash,HttpError,now,random} from '../context';
import {allowedGroupIds,globalPermissions,principal,viewerRoleNames,type SqlGuard} from './access';
import {can} from './policy/can';
import {auditEvent} from '../audit';
import type {Viewer} from '../../types';
import {dummyPasswordRecord,hashPassword,validatePassword,verifyPassword} from './passwords';
import {commitAll,db,dbNow,runSteps,sql,type Sql,type Step} from '../db';
import {builtInSignInAllowedSql} from './entra/emergency';

export type LocalUser={id:string;username:string;email:string;display_name:string;auth_principal:string;auth_email:string;status:'active'|'invited'|'disabled';password_hash:string|null;auth_version:number;must_reset:number;identity_source?:'local'|'entra';entra_tenant_id?:string|null;entra_object_id?:string|null};
type PrimarySession=LocalUser&{token_hash:string;user_id:string;created_at:number;expires_at:number;pending_until:number;mfa_hash:string|null};
const lifetime=24*60*60_000,pendingLifetime=10*60_000;
const validToken=(value:string)=>/^[a-f0-9]{64}$/.test(value);
// The primary session travels only in this HttpOnly cookie (docs/portal-sessions.md).
// No reply body carries its token, and no header can stand in for it.
const cookieName='__Host-serverdesk-auth';
const cookieValue=(r:Request,name:string)=>r.headers.get('cookie')?.split(';').map(s=>s.trim()).find(s=>s.startsWith(name+'='))?.slice(name.length+1)??null;
function selectedToken(request:Request){return cookieValue(request,cookieName)??'';}
/** The primary session cookie with a lifetime up to `expires` (app time); also used by /api/auth redeem. */
export const localAuthCookie=(token:string,expires=0)=>`${cookieName}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0,Math.floor((expires-now())/1000))}`;
export const clearLocalAuthCookie=()=>localAuthCookie('');
// User names that start with "entra." belong to accounts from Microsoft Entra ID (lib/server/identity/entra/sign-in.ts).
export function username(value:unknown){if(typeof value!=='string')throw new HttpError('apiError.auth.usernameRequired');const normalized=value.trim().toLowerCase();if(!/^[a-z0-9][a-z0-9._@+-]{2,63}$/.test(normalized))throw new HttpError('apiError.auth.usernameFormat');if(normalized.startsWith('entra.'))throw new HttpError('apiError.auth.usernameReserved');return normalized;}
// The sign-in credential of an account row `user` with the primary session row
// `session`: a local account has a password; an account from Microsoft Entra ID
// has none and counts only with a bound session (mfa_hash set), so a pending,
// password-only state never exists for it (docs/entra-id.md).
export const credentialSql=(user:Sql,session:Sql)=>sql`((${user}.identity_source='local' AND ${user}.password_hash IS NOT NULL) OR (${user}.identity_source='entra' AND ${session}.mfa_hash IS NOT NULL))`;
// A primary session counts while it is pending (password only, before
// pending_until) or bound to a live MFA session (docs/portal-sessions.md). Once
// its MFA session passed idle_expires_at or expires_at, or was deleted, the bound
// primary session counts no more: the next sign-in starts with the password,
// after the idle timeout as after Sign out. `session` and `user` are the aliases
// of the local_auth_sessions and local_users rows; `time` is the app clock,
// `alsoDbNow` adds the same deadlines by the SQL clock for committing guards.
const liveStateSql=(session:Sql,user:Sql,time:number,alsoDbNow=false)=>sql`((${session}.mfa_hash IS NULL AND ${session}.pending_until>${time}${alsoDbNow?sql` AND ${session}.pending_until>${dbNow}`:sql``}) OR (${session}.mfa_hash IS NOT NULL AND ${boundMfaLiveSql(session,user,time,alsoDbNow)}))`;
const boundMfaLiveSql=(session:Sql,user:Sql,time:number,alsoDbNow=false)=>sql`EXISTS (SELECT 1 FROM mfa_sessions bound_mfa WHERE bound_mfa.token_hash=${session}.mfa_hash AND bound_mfa.principal=${user}.auth_principal AND bound_mfa.idle_expires_at>${time} AND bound_mfa.expires_at>${time}${alsoDbNow?sql` AND bound_mfa.idle_expires_at>${dbNow} AND bound_mfa.expires_at>${dbNow}`:sql``})`;
export function newPassword(value:unknown){try{return validatePassword(value);}catch(e){throw e instanceof HttpError?e:new HttpError('apiError.password.invalid');}}
export const passwordPepper=()=>config('PASSWORD_PEPPER');
// The built-in roles are seeded on first use (lib/server/identity/rbac.ts). rbac.ts imports this
// module through mfa.ts, so it is loaded lazily.
async function builtinRoles(){const {ensureBuiltinRoles}=await import('./rbac');await ensureBuiltinRoles();}
// The client gates Owner-only pages on '*'; globalPermissions() expands it away,
// so a global Owner (can(v,'instance.owner'), lib/server/identity/policy/can.ts) gets '*' back next to the single rights.
export async function userViewer(user:LocalUser):Promise<Viewer>{const entra=user.identity_source==='entra'&&user.entra_tenant_id&&user.entra_object_id?{tenantId:user.entra_tenant_id,objectId:user.entra_object_id,email:user.email}:null;const v:Viewer={id:user.id,userId:user.id,label:user.auth_email,username:user.username,displayName:user.display_name,principal:user.auth_principal,identitySource:entra?'entra':'local',...(entra?{entra}:{})};const expanded=await globalPermissions(v),permissions=await can(v,'instance.owner')?['*',...expanded]:expanded;return {...v,permissions,canManageDeviceGroups:permissions.includes('groups.manage')||(await allowedGroupIds(v,'groups.manage')).length>0,roles:await viewerRoleNames(user.id)} as Viewer;}
async function primarySession(request:Request){await builtinRoles();const token=selectedToken(request);if(!validToken(token))return null;const time=now();return db().one<PrimarySession>(sql`SELECT u.*,s.token_hash,s.user_id,s.created_at,s.expires_at,s.pending_until,s.mfa_hash FROM local_auth_sessions s JOIN local_users u ON u.id=s.user_id AND u.auth_version=s.auth_version WHERE s.token_hash=${await hash(token)} AND u.status='active' AND ${credentialSql(sql`u`,sql`s`)} AND u.must_reset=0 AND s.expires_at>${time} AND ${liveStateSql(sql`s`,sql`u`,time)}`);}
export async function localIdentity(request:Request){const session=await primarySession(request);if(!session)return null;const viewer=await userViewer(session);Object.defineProperty(viewer,'authorization',{value:{authVersion:session.auth_version,sessionHash:session.token_hash},enumerable:false});return viewer;}
/** The token hash of the request's primary session, when it is the live session of `v` (else signInAgain). */
export async function primarySessionHash(request:Request,v:Viewer){const s=await primarySession(request);if(!s||s.id!==v.userId)throw new HttpError('apiError.auth.signInAgain');return s.token_hash;}
export async function requireBoundLocalMfa(request:Request,v:Viewer,mfaHash?:string){
 const s=await primarySession(request);if(!s||s.id!==v.userId)throw new HttpError('apiError.auth.signInAgain');
 if(!s.mfa_hash)throw new HttpError('apiError.auth.finishMfa');if(mfaHash&&s.mfa_hash!==mfaHash)throw new HttpError('apiError.auth.sessionExpired');
}
export async function primaryGuard(request:Request,v:Viewer){
 const s=await primarySession(request);if(!s||s.id!==v.userId)throw new HttpError('apiError.auth.signInAgain');
 return sql`EXISTS(SELECT 1 FROM local_auth_sessions a JOIN local_users u ON u.id=a.user_id AND u.auth_version=a.auth_version WHERE a.token_hash=${s.token_hash} AND u.id=${s.user_id} AND u.status='active' AND ${credentialSql(sql`u`,sql`a`)} AND u.must_reset=0 AND a.expires_at>${now()} AND a.expires_at>${dbNow} AND a.mfa_hash=${s.mfa_hash??''} AND ${boundMfaLiveSql(sql`a`,sql`u`,now(),true)})`;
}
// MFA issuance may use a still-pending password session, or a bound one while
// its MFA session is live (a step-up), but must not recreate proofs or a grant
// after that exact session/account was revoked.
export async function primaryAuthenticationGuard(request:Request,v:Viewer){
 const s=await primarySession(request);if(!s||s.id!==v.userId)throw new HttpError('apiError.auth.signInAgain');
 return sql`EXISTS(SELECT 1 FROM local_auth_sessions a JOIN local_users u ON u.id=a.user_id AND u.auth_version=a.auth_version WHERE a.token_hash=${s.token_hash} AND u.id=${s.user_id} AND u.status='active' AND ${credentialSql(sql`u`,sql`a`)} AND u.must_reset=0 AND a.expires_at>${dbNow} AND ${liveStateSql(sql`a`,sql`u`,now(),true)})`;
}
// The rows and predicates under which `bind` (bindLocalMfaStatements) copies the
// primary session: the exact session and user, the viewer's principal, an active
// user with a password (or an Entra account with a bound session, credentialSql)
// and no reset, and an unexpired session that is still pending or bound to a live
// MFA session (liveStateSql), by both the app clock (`time`) and the SQL clock.
const bindSource=sql`local_auth_sessions a JOIN local_users u ON u.id=a.user_id AND u.auth_version=a.auth_version`;
function bindPredicates(s:PrimarySession,v:Viewer,time:number):SqlGuard{
 return sql`a.token_hash=${s.token_hash} AND u.id=${s.user_id} AND u.auth_principal=${principal(v)} AND u.status='active' AND ${credentialSql(sql`u`,sql`a`)} AND u.must_reset=0 AND a.expires_at>${time} AND a.expires_at>${dbNow} AND ${liveStateSql(sql`a`,sql`u`,time,true)}`;
}
async function bindablePrimarySession(request:Request,v:Viewer){
 const s=await primarySession(request);if(!s||s.id!==v.userId)throw new HttpError('apiError.auth.signInAgain');return s;
}
// True exactly when `bind` would copy the primary session at app time `time`.
// Statements that commit before `bind` in the same batch and must not outlive a
// refused binding use it, e.g. the account insert of passkeys.ts setupVerify.
// Keep it coupled to `bind`: both are built from bindPredicates, pinned by the
// session-binding refusal scenes in tests/api/passkey-first-setup.mjs.
export async function localBindGuard(request:Request,v:Viewer,time=now()):Promise<SqlGuard>{
 const p=bindPredicates(await bindablePrimarySession(request,v),v,time);
 return sql`EXISTS(SELECT 1 FROM ${bindSource} WHERE ${p})`;
}
// Binding the primary session to a new MFA session commits in the same batch as
// the MFA session itself, so a login is either fully bound or leaves no trace:
// `bind` runs before the MFA session insert and `bound` gates that insert,
// `finish` runs after it. `finish` drops an unused copy when the MFA session was
// not created and retires the pending session only when it was.
export async function bindLocalMfaStatements(request:Request,v:Viewer,mfaHash:string,time=now()){
 const s=await bindablePrimarySession(request,v),token=random(),tokenHash=await hash(token);
 const mfaSession=sql`EXISTS(SELECT 1 FROM mfa_sessions m WHERE m.token_hash=${mfaHash})`;
 // `bind` and localBindGuard share bindPredicates and must stay coupled
 // (the session-binding refusal scenes in tests/api/passkey-first-setup.mjs).
 const predicates=bindPredicates(s,v,time);
 return {
  bind:sql`INSERT INTO local_auth_sessions(token_hash,user_id,auth_version,created_at,expires_at,pending_until,mfa_hash) SELECT ${tokenHash}::text,a.user_id,a.auth_version,a.created_at,a.expires_at,a.pending_until,${mfaHash}::text FROM ${bindSource} WHERE ${predicates}`,
  bound:sql`EXISTS(SELECT 1 FROM local_auth_sessions b WHERE b.token_hash=${tokenHash} AND b.mfa_hash=${mfaHash})`,
  finish:[
   sql`DELETE FROM local_auth_sessions WHERE token_hash=${tokenHash} AND mfa_hash=${mfaHash} AND NOT ${mfaSession}`,
   sql`DELETE FROM local_auth_sessions WHERE token_hash=${s.token_hash} AND ${mfaSession} AND EXISTS(SELECT 1 FROM local_auth_sessions WHERE token_hash=${tokenHash} AND mfa_hash=${mfaHash})`,
  ],
  cookies:[localAuthCookie(token,s.expires_at)],
  // The primary session this binding copies, and whether it was still pending
  // (password only) when it was read: a sign-in MFA (lib/server/identity/mfa.ts) binds a
  // pending session; a step-up binds a bound one.
  source:{tokenHash:s.token_hash,userId:s.user_id,pending:s.mfa_hash===null},
 };
}
/** The client address of a request as the login limiter keys it (clientAddressKey), or 'unknown' without the trusted header. */
export function clientAddress(request:Request){const forwarded=request.headers.get('X-ServerDesk-Client-IP');return forwarded===null||!forwarded.trim()?'unknown':clientAddressKey(forwarded);}
// Failed sign-ins per 10 minutes. The account bucket is per account and client
// address, so a stranger elsewhere cannot lock the account; a cross-address
// ceiling per account caps attackers who rotate addresses. Without a trusted
// client address (no TRUSTED_CLIENT_IP_HEADER) all clients share one address
// bucket, so it gets a higher limit (docs/self-hosting.md).
export const ACCOUNT_ATTEMPT_LIMIT=10,ADDRESS_ATTEMPT_LIMIT=40,SHARED_INGRESS_ATTEMPT_LIMIT=200,ACCOUNT_TOTAL_ATTEMPT_LIMIT=100,ATTEMPT_WINDOW=10*60_000;
export type AttemptReservation={bucket:string;window_at:number};
// lockout gives the target of the bucket's auth.lockout row, or null for none.
type AttemptBucket={bucket:string;max:number;lockout:()=>Promise<string|null>};
// Eight IPv6 groups, or null when the text is not an IPv6 address.
function ipv6Groups(address:string):number[]|null{
 let text=address;const tail=/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
 if(tail){const octets=tail.slice(1).map(Number);if(octets.some(n=>n>255))return null;text=text.slice(0,tail.index)+((octets[0]<<8)|octets[1]).toString(16)+':'+((octets[2]<<8)|octets[3]).toString(16);}
 const halves=text.split('::');if(halves.length>2)return null;
 const head=halves[0]?halves[0].split(':'):[],rest=halves[1]?halves[1].split(':'):[],fill=8-head.length-rest.length;
 if(halves.length===2?fill<1:fill!==0)return null;
 const groups=[...head,...Array<string>(halves.length===2?fill:0).fill('0'),...rest];
 return groups.every(group=>/^[0-9a-f]{1,4}$/.test(group))?groups.map(group=>parseInt(group,16)):null;
}
// IPv6 clients usually hold a whole /64, so the address buckets group IPv6 by
// that prefix. IPv4, also IPv4-mapped IPv6, stays per address.
export function clientAddressKey(ip:string){
 const address=ip.trim().toLowerCase().split('%')[0],groups=address.includes(':')?ipv6Groups(address):null;
 if(!groups)return address;
 if(groups.slice(0,5).every(group=>group===0)&&groups[5]===0xffff)return [groups[6]>>8,groups[6]&255,groups[7]>>8,groups[7]&255].join('.');
 return groups.slice(0,4).map(group=>group.toString(16)).join(':')+'::/64';
}
// Counts one attempt in every bucket atomically; over a limit or inside a block
// gives 429 and the request keeps its count. The counter rises atomically, so per
// bucket and window exactly one request sees attempts===max+1, the first rejected
// try: that request writes the auth.lockout row. The guard also skips the row when
// one for this target already exists in the window, in case a released login
// reservation lets the counter reach max+1 a second time.
async function reserveBuckets(buckets:AttemptBucket[],time:number):Promise<AttemptReservation[]>{
 const window=ATTEMPT_WINDOW;
 // Many requests count in the same bucket rows at once. Under SERIALIZABLE a row
 // lock alone does not help: the snapshot is taken by the first query, before
 // the lock wait, and a newer row version then fails the transaction (40001).
 // LOCK TABLE runs before the first query, so the snapshot is taken after the
 // previous holder committed and reservations queue instead of retrying. The
 // bucket rows are then locked in a fixed order.
 const rows=await db().transaction(async tx=>{await tx.exec(sql`LOCK TABLE local_auth_attempts IN SHARE ROW EXCLUSIVE MODE`);return runSteps(tx,[
  sql`SELECT bucket FROM local_auth_attempts WHERE bucket IN (${sql.join(buckets.map(({bucket})=>sql`${bucket}`))}) ORDER BY bucket FOR UPDATE`,
  ...buckets.map(({bucket,max})=>sql`INSERT INTO local_auth_attempts(bucket,attempts,window_at,blocked_until) VALUES(${bucket},1,${time},0) ON CONFLICT(bucket) DO UPDATE SET attempts=CASE WHEN local_auth_attempts.window_at<=${time-window} THEN 1 ELSE local_auth_attempts.attempts+1 END,window_at=CASE WHEN local_auth_attempts.window_at<=${time-window} THEN ${time} ELSE local_auth_attempts.window_at END,blocked_until=CASE WHEN local_auth_attempts.window_at<=${time-window} THEN 0 WHEN local_auth_attempts.attempts>=${max} THEN GREATEST(local_auth_attempts.blocked_until,local_auth_attempts.window_at+${window}) ELSE local_auth_attempts.blocked_until END RETURNING attempts,window_at,blocked_until`),
 ]);});
 const reserved=rows.slice(1).map(r=>r.rows[0] as {attempts:number;window_at:number;blocked_until:number});
 const lockouts=(await Promise.all(buckets.map(async({max,lockout},i)=>{
  if(reserved[i].attempts!==max+1)return [];const target=await lockout();if(target===null)return [];
  return auditEvent({actor:'System',action:'auth.lockout',target,at:time,guard:sql`NOT EXISTS(SELECT 1 FROM audit WHERE at>=${reserved[i].window_at} AND action='auth.lockout' AND target=${target} AND scope='portal')`});
 }))).flat();
 if(lockouts.length)await commitAll(lockouts);
 if(reserved.some((row,i)=>row.attempts>buckets[i].max||row.blocked_until>time))throw new HttpError('apiError.auth.rateLimited');
 return buckets.map(({bucket},i)=>({bucket,window_at:reserved[i].window_at}));
}
// The account key is '<limiter>:<subject>': login:<typed username>, or redeem:
// and password: with the local_users.id. Only an existing account gets an
// account row, and the row names its id, never the typed name: an unknown name
// may be a mistyped password.
async function lockoutUser(limiter:string,subject:string){
 const row=await db().one<{id:string}>(sql`SELECT id FROM local_users WHERE ${sql.ident(limiter==='login'?'username':'id')}=${subject}`);
 return row?.id??null;
}
// Reserves before the credential check. The cross-address account ceiling is
// only reserved once the address buckets let the request through, so requests
// an address limit already rejects cannot lock the account everywhere.
async function reserveAttempt(request:Request,account:string,limit:number):Promise<AttemptReservation[]>{
 const time=now(),forwarded=request.headers.get('X-ServerDesk-Client-IP'),ip=forwarded===null?'unknown-ingress':clientAddressKey(forwarded);
 const split=account.indexOf(':'),limiter=split<0?account:account.slice(0,split),subject=account.slice(split+1);
 let user:Promise<string|null>|undefined;const userId=()=>user??=lockoutUser(limiter,subject);
 const local=await reserveBuckets([
  {bucket:await hash('account:'+account+'\n'+'ip:'+ip),max:limit,lockout:async()=>{const id=await userId();return id===null?null:`${limiter} account-address user=${id} address=${ip}`;}},
  {bucket:await hash('ip:'+ip),max:forwarded===null?SHARED_INGRESS_ATTEMPT_LIMIT:ADDRESS_ATTEMPT_LIMIT,lockout:async()=>`${limiter} address address=${ip}`},
 ],time);
 const total=await reserveBuckets([{bucket:await hash('account-total:'+account),max:ACCOUNT_TOTAL_ATTEMPT_LIMIT,lockout:async()=>{const id=await userId();return id===null?null:`${limiter} account-total user=${id}`;}}],time);
 await db().exec(sql`DELETE FROM local_auth_attempts WHERE window_at<${time-24*60*60_000}`);
 return [...local,...total];
}
/**
 * One attempt in the address bucket of reserveAttempt, for a sign-in without a
 * typed account: the start of a sign-in with Microsoft Entra ID (limiter
 * 'entra'). Over the limit or inside a block gives 429 like a login.
 */
export async function reserveAddressAttempt(request:Request,limiter:string):Promise<AttemptReservation[]>{
 const time=now(),forwarded=request.headers.get('X-ServerDesk-Client-IP'),ip=forwarded===null?'unknown-ingress':clientAddressKey(forwarded);
 const reserved=await reserveBuckets([{bucket:await hash('ip:'+ip),max:forwarded===null?SHARED_INGRESS_ATTEMPT_LIMIT:ADDRESS_ATTEMPT_LIMIT,lockout:async()=>`${limiter} address address=${ip}`}],time);
 await db().exec(sql`DELETE FROM local_auth_attempts WHERE window_at<${time-24*60*60_000}`);
 return reserved;
}
// Gives a login's reservation back once its session row exists, only while the
// reserved window is still the current one.
export const releaseAttemptStatements=(reservation:AttemptReservation[],sessionHash:string)=>releaseAttempt(reservation,sessionHash);
const releaseAttempt=(reservation:AttemptReservation[],sessionHash:string)=>reservation.map(({bucket,window_at})=>sql`UPDATE local_auth_attempts SET attempts=GREATEST(attempts-1,0) WHERE bucket=${bucket} AND window_at=${window_at} AND EXISTS(SELECT 1 FROM local_auth_sessions WHERE token_hash=${sessionHash})`);
// Token redemption and password change still count every attempt, not only failures.
export async function rateLimit(request:Request,account:string,limit=ACCOUNT_ATTEMPT_LIMIT){await reserveAttempt(request,account,limit);}
// While Microsoft sign-in only is on, only the emergency access account gets a
// session (builtInSignInAllowedSql in the insert). Every other account answers
// invalidCredentials like a wrong password, so the reply does not show that it exists.
//
// With a live MFA grant of this account in this browser (docs/portal-sessions.md,
// "What each sign-in asks for": the switch off, MFA enrolled, not the emergency
// access under Microsoft sign-in only), the same batch opens the primary session
// already bound and a new MFA session that ends at most 24 hours after the MFA of
// the grant. The bound insert carries the grant rules again; when a delete or the
// switch commits first, the next statement opens the normal pending session, and
// the second factor follows as without a grant.
export async function login(request:Request,p:Record<string,unknown>){
 await builtinRoles();const name=typeof p.username==='string'?p.username.trim().toLowerCase().slice(0,256):'';const reservation=await reserveAttempt(request,'login:'+name,ACCOUNT_ATTEMPT_LIMIT);
 const user=await db().one<LocalUser>(sql`SELECT * FROM local_users WHERE username=${name}`);
 const record=user?.status==='active'&&!user.must_reset&&user.password_hash?user.password_hash:await dummyPasswordRecord(passwordPepper());
 const correct=await verifyPassword(p.password,record,passwordPepper());if(!correct||!user||user.status!=='active'||!user.password_hash||user.must_reset)throw new HttpError('apiError.auth.invalidCredentials');
 const token=random(),digest=await hash(token),time=now(),expiresAt=time+lifetime;
 const mfa=await import('./mfa'),grant=await mfa.passwordGrant(request,user.auth_principal,time);
 const account=sql`FROM local_users WHERE id=${user.id} AND auth_version=${user.auth_version} AND password_hash=${user.password_hash} AND status='active' AND must_reset=0 AND identity_source='local' AND ${builtInSignInAllowedSql(sql`local_users.id`)}`;
 const statements:Step[]=[];let granted:{token:string;expires:number}|null=null;
 if(grant){
  const {sessionIdleTimeoutMs}=await import('./session-settings');
  const mfaToken=random(),mfaHash=await hash(mfaToken),mfaExpires=mfa.grantSessionExpiry(grant,time),idleExpires=Math.min(mfaExpires,time+await sessionIdleTimeoutMs());
  statements.push(
   sql`INSERT INTO local_auth_sessions(token_hash,user_id,auth_version,created_at,expires_at,pending_until,mfa_hash) SELECT ${digest},id,auth_version,${time},${expiresAt},${time},${mfaHash} ${account} AND ${mfa.passwordGrantSql(grant.token_hash,user.auth_principal,time)}`,
   sql`INSERT INTO mfa_sessions(token_hash,principal,created_at,last_activity,idle_expires_at,expires_at,passkey_id) SELECT ${mfaHash}::text,${user.auth_principal}::text,${time}::bigint,${time}::bigint,${idleExpires}::bigint,${mfaExpires}::bigint,NULL WHERE EXISTS (SELECT 1 FROM local_auth_sessions WHERE token_hash=${digest} AND mfa_hash=${mfaHash})`,
  );
  granted={token:mfaToken,expires:mfaExpires};
 }
 const pendingInsert=statements.length;
 const result=await commitAll([
  ...statements,
  sql`INSERT INTO local_auth_sessions(token_hash,user_id,auth_version,created_at,expires_at,pending_until,mfa_hash) SELECT ${digest},id,auth_version,${time},${expiresAt},${time+pendingLifetime},NULL ${account} AND NOT EXISTS (SELECT 1 FROM local_auth_sessions WHERE token_hash=${digest})`,
  sql`UPDATE local_users SET last_login_at=${time} WHERE id=${user.id} AND EXISTS(SELECT 1 FROM local_auth_sessions WHERE token_hash=${digest})`,
  sql`INSERT INTO audit(at,actor,action,target) SELECT ${time},${user.auth_email},'auth.login',${user.id} WHERE EXISTS (SELECT 1 FROM local_auth_sessions WHERE token_hash=${digest})`,
  // Only failed sign-ins count: the reservation goes back in the batch that creates the session.
  ...releaseAttempt(reservation,digest)
 ]);
 const bound=granted!==null&&!!result[0].rowCount;
 if(!bound&&!result[pendingInsert].rowCount)throw new HttpError('apiError.auth.invalidCredentials');
 const viewer=await userViewer(user),cookies=[localAuthCookie(token,expiresAt),bound?mfa.mfaSessionCookie(granted!.token,(granted!.expires-time)/1000):mfa.clearMfaSessionCookie()];
 return {ok:true,viewer,expiresAt,cookies};
}
// Every statement stays inside the same transaction as the guarded account change.
export function revocationStatements(user:Pick<LocalUser,'id'|'auth_principal'>,guard:SqlGuard=sql`TRUE`):Step[]{return [
 sql`DELETE FROM local_auth_sessions WHERE user_id=${user.id} AND (${guard})`,
 ...['mfa_authenticator_challenges','mfa_management_proofs','mfa_proofs','mfa_sessions','mfa_grants','passkey_challenges','mfa_challenges'].map(table=>sql`DELETE FROM ${sql.ident(table)} WHERE principal=${user.auth_principal} AND (${guard})`),
 sql`UPDATE terminal_sessions SET state='closed',error='serverMessage.account.changed' WHERE principal=${user.auth_principal} AND state IN ('opening','open') AND (${guard})`,
 sql`UPDATE rdp_sessions SET state='closed',key_envelope=NULL,error='serverMessage.account.changed' WHERE principal=${user.auth_principal} AND state IN ('opening','open') AND (${guard})`,
 ...['rdp_frames','rdp_receipts'].map(table=>sql`DELETE FROM ${sql.ident(table)} WHERE session_id IN(SELECT id FROM rdp_sessions WHERE principal=${user.auth_principal}) AND (${guard})`),
 sql`UPDATE jobs SET state='cancelled',parameters='{}',result='serverMessage.job.accountChanged' WHERE actor_principal=${user.auth_principal} AND state='pending' AND (${guard})`,
 sql`UPDATE transfers SET state='cancelled',updated_at=${now()},message='serverMessage.account.changed' WHERE principal=${user.auth_principal} AND state NOT IN ('completed','cancelled','failed','expired') AND (${guard})`,
 sql`UPDATE runbook_runs SET cancel_requested=1 WHERE actor=${user.auth_principal} AND state IN ('queued','running') AND (${guard})`
 ];}
/**
 * revocationStatements for every account that `users` selects: a SELECT with
 * the columns id and auth_principal, read inside the transaction.
 * Sign-in with Microsoft Entra ID uses it to end every Entra account at once
 * (lib/server/identity/entra/settings.ts), also accounts created after the caller read the list.
 */
export function revocationStatementsFor(users:Sql,guard:SqlGuard=sql`TRUE`):Step[]{
 const column=(name:'id'|'auth_principal')=>sql`IN (SELECT ${sql.ident(name)} FROM (${users}) revoked_user)`;
 return [
  sql`DELETE FROM local_auth_sessions WHERE user_id ${column('id')} AND (${guard})`,
  ...['mfa_authenticator_challenges','mfa_management_proofs','mfa_proofs','mfa_sessions','mfa_grants','passkey_challenges','mfa_challenges'].map(table=>sql`DELETE FROM ${sql.ident(table)} WHERE principal ${column('auth_principal')} AND (${guard})`),
  sql`UPDATE terminal_sessions SET state='closed',error='serverMessage.account.changed' WHERE principal ${column('auth_principal')} AND state IN ('opening','open') AND (${guard})`,
  sql`UPDATE rdp_sessions SET state='closed',key_envelope=NULL,error='serverMessage.account.changed' WHERE principal ${column('auth_principal')} AND state IN ('opening','open') AND (${guard})`,
  ...['rdp_frames','rdp_receipts'].map(table=>sql`DELETE FROM ${sql.ident(table)} WHERE session_id IN(SELECT id FROM rdp_sessions WHERE principal ${column('auth_principal')}) AND (${guard})`),
  sql`UPDATE jobs SET state='cancelled',parameters='{}',result='serverMessage.job.accountChanged' WHERE actor_principal ${column('auth_principal')} AND state='pending' AND (${guard})`,
  sql`UPDATE transfers SET state='cancelled',updated_at=${now()},message='serverMessage.account.changed' WHERE principal ${column('auth_principal')} AND state NOT IN ('completed','cancelled','failed','expired') AND (${guard})`,
  sql`UPDATE runbook_runs SET cancel_requested=1 WHERE actor ${column('auth_principal')} AND state IN ('queued','running') AND (${guard})`
 ];
}
export async function revokeLocalSessions(userId:string){const user=await db().one<LocalUser>(sql`SELECT id,auth_principal,auth_email FROM local_users WHERE id=${userId}`);if(user)await commitAll(revocationStatements(user));}
// Sign out (docs/portal-sessions.md): the primary session, its MFA session and
// the MFA grant of this browser end, so the next sign-in asks for MFA again.
export async function logout(request:Request){
 const token=selectedToken(request),digest=validToken(token)?await hash(token):null,queries:Step[]=[];
 // A selected bearer may revoke its own rows even after its login deadline or
 // account suspension. This lookup never grants authentication or permissions.
 const user=digest?await db().one<LocalUser&{mfa_hash:string|null}>(sql`SELECT u.*,s.mfa_hash FROM local_auth_sessions s JOIN local_users u ON u.id=s.user_id WHERE s.token_hash=${digest}`):null;
 const {clearMfaGrantCookie,clearMfaSessionCookie,clearMfaTrustCookie,grantLogoutStatements,logoutMfaStatements}=await import('./mfa');
 if(digest)queries.push(sql`DELETE FROM local_auth_sessions WHERE token_hash=${digest}`);
 // logoutMfaStatements ends the grant too; without a known account the grant cookie alone ends it.
 if(user)queries.push(...(await logoutMfaStatements(request,await userViewer(user),false,user.mfa_hash??undefined)).queries);
 else queries.push(...await grantLogoutStatements(request));
 if(queries.length)await commitAll(queries);
 return {ok:true,cookies:[clearLocalAuthCookie(),clearMfaSessionCookie(),clearMfaGrantCookie(),clearMfaTrustCookie()]};
}
export async function hashNewPassword(value:unknown){return hashPassword(newPassword(value),passwordPepper());}
