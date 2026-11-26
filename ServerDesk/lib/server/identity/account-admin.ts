import {config,guid,hash,HttpError,now,random,requireViewer} from '../context';
import {globalPermissionGuard,lastOwnerGuard,principal,requireTargetDominance,targetDominanceGuard} from './access';
import {clearLocalAuthCookie,localAuthCookie,hashNewPassword,login,logout,passwordPepper,primaryGuard,rateLimit,revocationStatements,userViewer,username,type LocalUser} from './local-auth';
import {clearMfaSessionCookie,clearMfaTrustCookie,readMfaManagementProof} from './mfa';
import {verifyPassword} from './passwords';
import type {Viewer} from '../../types';
import {auditAfterChange,auditEvent} from '../audit';
import {commitAll,db,dbNow,sql,type Sql,type StepResult} from '../db';
import {isUniqueViolation} from '../errors/db-codes';
import {builtInSignInAllowedSql,emergencyAccountFixed,emergencyFixedSql,entraOnlyActive,entraOnlySql} from './entra/emergency';

// Local accounts (app/api/auth): invitation and reset links, password change
// and the account administration of portal.users.manage.

const id=(value:unknown)=>{if(!guid(value))throw new HttpError('apiError.account.invalidUser');return value;};
const displayName=(value:unknown)=>{if(typeof value!=='string'||!value.trim()||value.trim().length>120||/[\u0000-\u001f\u007f]/.test(value))throw new HttpError('apiError.account.displayName');return value.trim();};
const email=(value:unknown)=>{if(value===undefined||value==='')return '';if(typeof value!=='string'||value.length>254||!/^\S+@\S+\.\S+$/.test(value)||/[\u0000-\u0020\u007f]/.test(value))throw new HttpError('apiError.account.invalidEmail');return value.trim().toLowerCase();};
const invalidToken=()=>new HttpError('apiError.account.invalidToken');
async function uniqueUsername(name:string,except=''){if(await db().one(sql`SELECT 1 FROM local_users WHERE username=${name} AND id<>${except}`))throw new HttpError('apiError.account.usernameTaken');}
async function targetUser(value:unknown){const user=await db().one<LocalUser>(sql`SELECT * FROM local_users WHERE id=${id(value)}`);if(!user)throw new HttpError('apiError.account.userNotFound');return user;}
async function management(request:Request,v:Viewer,token:unknown,permission?:string){
 const proof=await readMfaManagementProof(request,v,token),primary=await primaryGuard(request,v),right=permission?globalPermissionGuard(sql`${principal(v)}`,permission):sql`TRUE`;
 return {...proof,guard:sql`(${proof.guard}) AND (${primary}) AND (${right})`};
}
type Proof=Awaited<ReturnType<typeof management>>;
const consume=(proof:Proof)=>sql`DELETE FROM mfa_management_proofs WHERE token_hash=${proof.tokenHash} AND principal=${proof.key} AND session_hash=${proof.sessionHash}`;
// One portal row of the actor, built by auditEvent (lib/server/audit.ts); spread it into the batch.
const audit=(v:Viewer,action:string,target:string,guard:Sql)=>auditEvent({actor:v.label,action,target,guard});
const changed=(result:StepResult)=>{if(!result.rowCount)throw new HttpError('apiError.account.stateChanged');};
function cleared(){return [clearLocalAuthCookie(),clearMfaSessionCookie(),clearMfaTrustCookie()];}
// Account actions on an existing user commit only while the actor dominates the
// target (targetDominanceGuard). A refused commit is re-checked: a failing rule
// answers with its own 403, anything else stays the generic 409.
async function committed(result:StepResult,v:Viewer,userId:string){if(!result.rowCount)await requireTargetDominance(v,userId);changed(result);}
async function userData(userId:string){return db().one(sql`SELECT id,username,email,display_name AS "displayName",status,(password_hash IS NOT NULL) AS "passwordConfigured",EXISTS(SELECT 1 FROM mfa_accounts WHERE principal=auth_principal) AS "mfaEnabled",identity_source AS "identitySource" FROM local_users WHERE id=${userId}`);}
// Name, email, password and links of an account from Microsoft Entra ID come
// from Entra (docs/entra-id.md); locking and unlocking work as for local accounts.
function refuseEntraManaged(user:LocalUser){if(user.identity_source==='entra')throw new HttpError('apiError.account.entraManaged');}
// While Microsoft sign-in only is on (docs/entra-id.md) no built-in account is
// created or unlocked, and the emergency access account is not locked. The
// committing statements carry the same rules, so a switch that commits first wins.
async function refuseEntraOnly(){if(await entraOnlyActive())throw new HttpError('apiError.account.entraOnly');}
async function refuseEmergencyLock(userId:string){if(await emergencyAccountFixed(userId))throw new HttpError('apiError.account.emergencyAccount');}

type AccountToken=LocalUser&{token_hash:string;kind:'invite'|'reset';expires_at:number;token_version:number};
async function accountToken(value:unknown){
 if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw invalidToken();
 const token=await db().one<AccountToken>(sql`SELECT u.*,t.token_hash,t.kind,t.expires_at,t.auth_version AS token_version FROM local_account_tokens t JOIN local_users u ON u.id=t.user_id AND u.auth_version=t.auth_version WHERE t.token_hash=${await hash(value)} AND t.used_at IS NULL AND t.expires_at>${now()} AND t.expires_at>${dbNow} AND u.identity_source='local' AND ((t.kind='invite' AND u.status='invited' AND u.password_hash IS NULL) OR (t.kind='reset' AND u.status='active'))`);if(!token)throw invalidToken();return token;
}
async function redeem(request:Request,p:Record<string,unknown>){
 const user=await accountToken(p.token);await rateLimit(request,'redeem:'+user.id);const name=username(p.username);if(user.kind==='reset'&&name!==user.username)throw invalidToken();await uniqueUsername(name,user.id);const record=await hashNewPassword(p.password),time=now(),nextVersion=user.auth_version+1;
 const proof=sql`EXISTS(SELECT 1 FROM local_account_tokens t WHERE t.token_hash=${user.token_hash} AND t.user_id=local_users.id AND t.kind=${user.kind} AND t.auth_version=local_users.auth_version AND t.used_at IS NULL AND t.expires_at>${time} AND t.expires_at>${dbNow})`;
 const postGuard=sql`EXISTS(SELECT 1 FROM local_users WHERE id=${user.id} AND password_hash=${record} AND auth_version=${nextVersion})`;
 const token=random(),digest=await hash(token),expiresAt=time+24*60*60_000;
 const statements=[
  sql`UPDATE local_users SET username=${name},password_hash=${record},status='active',must_reset=0,auth_version=auth_version+1,updated_at=${time} WHERE id=${user.id} AND auth_version=${user.auth_version} AND identity_source='local' AND ${builtInSignInAllowedSql(sql`local_users.id`)} AND ${proof} AND ${user.kind==='invite'?sql`status='invited' AND password_hash IS NULL`:sql`status='active'`}`,
  sql`UPDATE local_account_tokens SET used_at=${time} WHERE user_id=${user.id} AND used_at IS NULL AND ${postGuard}`,
  ...revocationStatements(user,postGuard),
  ...auditEvent({actor:user.auth_email,action:user.kind==='invite'?'auth.invitation.redeem':'auth.password.reset',target:user.id,guard:postGuard})
 ];
 if(user.kind==='invite')statements.push(sql`INSERT INTO local_auth_sessions(token_hash,user_id,auth_version,created_at,expires_at,pending_until,mfa_hash) SELECT ${digest},id,auth_version,${time},${expiresAt},${time+10*60_000},NULL FROM local_users WHERE id=${user.id} AND password_hash=${record} AND auth_version=${nextVersion} AND status='active'`);
 const result=await commitAll(statements);if(!result[0].rowCount)throw invalidToken();if(user.kind==='reset')return {ok:true,loginRequired:true,cookies:cleared()};
 // The new primary session leaves only as the HttpOnly cookie of local-auth's login.
 return {ok:true,viewer:await userViewer(await targetUser(user.id)),expiresAt,cookies:[localAuthCookie(token,expiresAt),clearMfaSessionCookie()]};
}
async function passwordChange(request:Request,p:Record<string,unknown>){
 const v=await requireViewer(),user=await targetUser(v.userId);refuseEntraManaged(user);await rateLimit(request,'password:'+user.id);if(!await verifyPassword(p.currentPassword,user.password_hash,passwordPepper()))throw new HttpError('apiError.account.currentPasswordInvalid');
 const record=await hashNewPassword(p.newPassword),proof=await management(request,v,p.managementToken),version=user.auth_version+1,time=now(),guard=sql`EXISTS(SELECT 1 FROM local_users WHERE id=${user.id} AND auth_version=${version} AND password_hash=${record})`;
 const result=await commitAll([
  sql`UPDATE local_users SET password_hash=${record},auth_version=auth_version+1,updated_at=${time} WHERE id=${user.id} AND auth_version=${user.auth_version} AND password_hash=${user.password_hash} AND ${proof.guard}`,
  sql`UPDATE local_account_tokens SET used_at=${time} WHERE user_id=${user.id} AND used_at IS NULL AND ${guard}`,
  ...revocationStatements(user,guard),...audit(v,'auth.password.change',user.id,guard),consume(proof)
 ]);changed(result[0]);return {ok:true,loginRequired:true,cookies:cleared()};
}
async function manageUser(request:Request,p:Record<string,unknown>){
 const v=await requireViewer(),proof=await management(request,v,p.managementToken,'portal.users.manage'),time=now();
 if(p.action==='create-user'){
  const name=username(p.username),nameLabel=displayName(p.displayName),contact=email(p.email);await refuseEntraOnly();await uniqueUsername(name);const userId=crypto.randomUUID(),authEmail=userId+'@local.serverdesk.invalid',token=random(),digest=await hash(token),expiresAt=time+24*60*60_000;
  const guard=sql`EXISTS(SELECT 1 FROM local_users WHERE id=${userId})`;
  const result=await commitAll([
   sql`INSERT INTO local_users(id,username,email,display_name,auth_principal,auth_email,status,password_hash,auth_version,must_reset,created_at,updated_at) SELECT ${userId},${name},${contact},${nameLabel},${'private:'+authEmail},${authEmail},'invited',NULL,1,0,${time},${time} WHERE ${proof.guard} AND NOT ${entraOnlySql}`,
   sql`INSERT INTO local_account_tokens(token_hash,user_id,kind,created_at,expires_at,auth_version) SELECT ${digest},id,'invite',${time},${expiresAt},auth_version FROM local_users WHERE id=${userId}`,...audit(v,'auth.user.create',userId,guard),consume(proof)
  ]);if(!result[0].rowCount)await refuseEntraOnly();changed(result[0]);return {ok:true,user:await userData(userId),invitationUrl:config('SITE_ORIGIN')+'/#invite='+token,expiresAt};
 }
 const user=await targetUser(p.userId);
 if(p.action==='reset-link'){
  refuseEntraManaged(user);if(user.status==='disabled')throw new HttpError('apiError.account.lockedNoPasswordLink');const dominance=targetDominanceGuard(v,user.id);await requireTargetDominance(v,user.id,dominance);
  const kind=user.status==='invited'?'invite':'reset',token=random(),digest=await hash(token),expiresAt=time+(kind==='invite'?24*60*60_000:60*60_000);
  const result=await commitAll([
   sql`INSERT INTO local_account_tokens(token_hash,user_id,kind,created_at,expires_at,auth_version) SELECT ${digest},id,${kind},${time},${expiresAt},auth_version FROM local_users WHERE id=${user.id} AND status=${user.status} AND auth_version=${user.auth_version} AND ${proof.guard} AND ${dominance}`,
   sql`UPDATE local_account_tokens SET used_at=${time} WHERE user_id=${user.id} AND token_hash<>${digest} AND used_at IS NULL AND EXISTS(SELECT 1 FROM local_account_tokens WHERE token_hash=${digest})`,...audit(v,'auth.user.password-link',user.id,sql`EXISTS(SELECT 1 FROM local_account_tokens WHERE token_hash=${digest})`),consume(proof)
  ]);await committed(result[0],v,user.id);return {ok:true,invitationUrl:config('SITE_ORIGIN')+'/#invite='+token,expiresAt};
 }
 if(p.action==='update-user'){
  refuseEntraManaged(user);const name=displayName(p.displayName),contact=email(p.email),dominance=targetDominanceGuard(v,user.id);await requireTargetDominance(v,user.id,dominance);
  // The audit row needs the row exactly as this UPDATE wrote it, so a refused update leaves none.
  const guard=sql`EXISTS(SELECT 1 FROM local_users WHERE id=${user.id} AND auth_version=${user.auth_version} AND updated_at=${time} AND display_name=${name} AND email=${contact}) AND ${proof.guard} AND ${dominance}`;
  const result=await commitAll([sql`UPDATE local_users SET display_name=${name},email=${contact},updated_at=${time} WHERE id=${user.id} AND auth_version=${user.auth_version} AND ${proof.guard} AND ${dominance}`,...audit(v,'auth.user.update',user.id,guard),consume(proof)]);await committed(result[0],v,user.id);return {ok:true,user:await userData(user.id)};
 }
 if(p.action==='disable-user'){
  if(typeof p.disabled!=='boolean')throw new HttpError('apiError.account.lockStateMissing');const dominance=targetDominanceGuard(v,user.id);await requireTargetDominance(v,user.id,dominance);
  // Microsoft sign-in only: a built-in account is not unlocked, the emergency access is not locked.
  const local=user.identity_source!=='entra',entraOnlyRule=p.disabled?sql`NOT ${emergencyFixedSql(sql`local_users.id`)}`:local?sql`NOT ${entraOnlySql}`:sql`TRUE`;
  const refusal=async()=>{if(p.disabled)await refuseEmergencyLock(user.id);else if(local)await refuseEntraOnly();};
  await refusal();
  const owner=lastOwnerGuard(user.id),commit=p.disabled?sql`${owner} AND ${dominance} AND ${entraOnlyRule}`:sql`${dominance} AND ${entraOnlyRule}`,status=p.disabled?'disabled':user.password_hash?'active':user.status==='invited'?'invited':'active',version=user.auth_version+1;
  if(status===user.status){
   // Already in the target state: no bump, no revocation, no audit row. The
   // committing statement still needs the full authorization (proof,
   // portal.users.manage and primary session in proof.sql, dominance) and the
   // unchanged account; it writes the row back as it is. So a no-op answers 200
   // only where a change would have committed and a concurrent change still
   // answers 409. The proof is consumed unconditionally, as for every account
   // action, so whether it survives does not reveal the target's status.
   const result=await commitAll([
    sql`UPDATE local_users SET auth_version=auth_version WHERE id=${user.id} AND auth_version=${user.auth_version} AND status=${status} AND ${proof.guard} AND ${commit}`,
    consume(proof)
   ]);if(!result[0].rowCount)await refusal();await committed(result[0],v,user.id);return {ok:true,user:await userData(user.id)};
  }
  const guard=sql`EXISTS(SELECT 1 FROM local_users WHERE id=${user.id} AND auth_version=${version} AND status=${status})`;
  // The audit row directly follows the UPDATE and exists only when this batch
  // changed the account; a concurrent change to the same state writes none.
  const result=await commitAll([
   sql`UPDATE local_users SET status=${status},auth_version=auth_version+1,updated_at=${time} WHERE id=${user.id} AND auth_version=${user.auth_version} AND ${proof.guard} AND ${commit}`,
   ...audit(v,p.disabled?'auth.user.disable':'auth.user.enable',user.id,auditAfterChange),
   sql`UPDATE local_account_tokens SET used_at=${time} WHERE user_id=${user.id} AND used_at IS NULL AND ${guard}`,...revocationStatements(user,guard),consume(proof)
  ]);if(!result[0].rowCount)await refusal();await committed(result[0],v,user.id);return {ok:true,user:await userData(user.id),...(user.id===v.userId?{cookies:cleared()}:{})};
 }
 throw new HttpError('apiError.account.unknownAction');
}

/**
 * One account action of POST /api/auth. The answer may carry `cookies` for the
 * route to set. A username taken concurrently (unique index local_users_username)
 * answers 409 like the pre-check.
 */
export async function accountAction(request:Request,p:Record<string,unknown>):Promise<Record<string,unknown>>{
 try{
  if(p.action==='login')return await login(request,p);
  if(p.action==='logout')return await logout(request);
  if(p.action==='invitation-info'){const token=await accountToken(p.token);return {valid:true,kind:token.kind,username:token.username,displayName:token.display_name,expiresAt:token.expires_at};}
  if(p.action==='redeem')return await redeem(request,p);
  if(p.action==='password-change')return await passwordChange(request,p);
  return await manageUser(request,p);
 }catch(e){if(isUniqueViolation(e,'local_users_username'))throw new HttpError('apiError.account.usernameTaken');throw e;}
}
