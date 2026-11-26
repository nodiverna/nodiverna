// Sign-in with Microsoft Entra ID (docs/entra-id.md): OIDC authorization code
// flow with PKCE. /api/auth/entra/start creates a flow and sends the browser to
// Microsoft; /api/auth/entra/callback takes the flow once, redeems the code,
// checks the id_token (lib/server/identity/entra/oidc.ts), finds or creates the password-less
// account entra:<tid>:<oid> and commits the bound session pair, the groups, the
// role sync and the audit row in one transaction. The Entra MFA (amr "mfa" in
// the v1.0 access token of the portal API, verifyAccessToken) is the bound MFA
// of the portal session; the account has no portal factors.
//
// The MFA grant (docs/portal-sessions.md, "What each sign-in asks for"): a start
// with a live grant of an Entra account in this browser sends no prompt, and
// Microsoft may answer from its own sign-in session. Every other start forces a
// new Microsoft sign-in (prompt=login); its callback needs a fresh auth_time
// (authTimeLimits) and gives the browser a new grant.
import {hash,HttpError,now,random} from '../../context';
import {localAuthCookie,releaseAttemptStatements,reserveAddressAttempt} from '../local-auth';
import {clearMfaTrustCookie,decryptSecret,encryptSecret,grantCookieHash,grantSessionExpiry,liveGrantSql,mfaAvailable,mfaSessionCookie,mfaSessionLifetimeMs,newGrantStatement} from '../mfa';
import {grantAllowedSql,sessionIdleTimeoutMs} from '../session-settings';
import {auditEvent} from '../../audit';
import {negotiateLocale,localeCookieName,type Locale} from '../../../i18n/locale';
import {translate} from '../../../i18n/translate';
import {commitAll,db,runSteps,sql,type Step,type StepResult} from '../../db';
import {apiSetupError,authorizeUrlOf,callbackRejected,EntraFailure,redeemCode,signInScopeOf,tokenRejected,unavailableError,verifyAccessToken,verifyIdToken,type IdTokenClaims,type RefusalContext} from './oidc';
import {parseAmrDiagnostic} from '../../../entra/amr';
import {entraRedirectUri,entraSettingsRow,savedCredential,settingsComplete,type EntraSettingsRow} from './settings';
import {roleSyncStatement} from './role-sync';

export const entraFlowCookieName='__Host-serverdesk-entra';
/** A flow is valid 10 minutes and used once; at most 1000 are open at the same time. */
export const entraFlowLimits={lifetimeMs:10*60_000,open:1000};
const sessionLifetimeMs=24*60*60_000;
export const codeVerifierContext='entra:code-verifier';
/**
 * The outcomes of a sign-in; the sign-in card shows entra.error.<code> (busy and rateLimited: their server texts).
 * reauthenticate: a sign-in through an MFA grant that no longer applies; the
 * callback page sends the browser to a new start with a forced Microsoft sign-in.
 */
export type EntraOutcome='notConfigured'|'cancelled'|'expired'|'mfaMissing'|'apiSetupMissing'|'wrongTenant'|'accountDisabled'|'groupsOverage'|'tokenRejected'|'staleSignIn'|'unavailable'|'busy'|'rateLimited'|'reauthenticate';
/** Refusals after a valid flow that write auth.entra.login.refused. */
const auditedRefusals:ReadonlySet<string>=new Set(['wrongTenant','mfaMissing','apiSetupMissing','accountDisabled','groupsOverage','tokenRejected','staleSignIn']);
/** auth_time of a forced sign-in or a confirmation may be at most 60 s before the start of its flow and at most 5 minutes ahead of the portal clock. */
export const authTimeLimits={beforeStartSeconds:60,aheadSeconds:300};
/** The start that forces a new Microsoft sign-in and ignores an MFA grant. */
export const freshEntraStartPath='/api/auth/entra/start?fresh=1';
/**
 * The end of a refused audit target: " amr=<diagnostic>" for mfaMissing,
 * " detail=<missing|refused|version|audience|scope>" for apiSetupMissing,
 * " check=<check>[ error=<oauth>][ aadsts=<n>,...]" for tokenRejected (the
 * failed check of lib/server/identity/entra/oidc.ts, TokenCheck; after a time check
 * " exp=<n> iat=<n> nbf=<n>[ auth=<n>]", and " start=<n>" for a confirmation), nothing for the other
 * refusals. The detail is built from values of fixed lists and digits
 * (EntraFailure), never token or Microsoft text.
 */
export const refusalDetail=(outcome:string,detail:string|undefined)=>outcome==='mfaMissing'?` amr=${detail??'missing'}`:outcome==='apiSetupMissing'?` detail=${detail??'missing'}`:outcome==='tokenRejected'&&detail!==undefined?` check=${detail}`:'';

const flowCookie=(token:string,maxAge:number)=>`${entraFlowCookieName}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
export const clearEntraFlowCookie=()=>flowCookie('',0);
export const cookieValue=(request:Request,name:string)=>{for(const part of (request.headers.get('cookie')??'').split(';')){const [key,...rest]=part.trim().split('=');if(key===name)return rest.join('=');}return '';};
export const validToken=(value:string)=>/^[a-f0-9]{64}$/.test(value);
const base64url=(bytes:ArrayBuffer)=>Buffer.from(bytes).toString('base64url');
/** A random PKCE verifier (96 hex characters) and its S256 challenge. */
export async function pkcePair(){const verifier=random()+random().slice(0,32);return {verifier,challenge:base64url(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier)))};}
/** The authorize query of a sign-in; the confirmation (lib/server/identity/entra/confirm.ts) appends its own parameters. */
export function authorizeQuery(clientId:string,{state,nonce,challenge}:{state:string;nonce:string;challenge:string}){
 return new URLSearchParams({client_id:clientId,response_type:'code',response_mode:'query',redirect_uri:entraRedirectUri(),scope:signInScopeOf(clientId),state,nonce,code_challenge:challenge,code_challenge_method:'S256'});
}

/** Settings that allow a sign-in now: switched on and complete. */
export async function activeSettings():Promise<(EntraSettingsRow&{tenant_id:string;client_id:string})|null>{
 const row=await entraSettingsRow();
 return row?.enabled===1&&settingsComplete(row)?row:null;
}
/** GET /api/auth: sign-in with Microsoft on, and Microsoft sign-in only on (docs/entra-id.md). Names no tenant, client or account. */
export async function entraSignInState():Promise<{enabled:boolean;entraOnly:boolean}>{
 const row=await entraSettingsRow();
 return {enabled:row?.enabled===1&&settingsComplete(row),entraOnly:row?.entra_only===1};
}

/**
 * The hash of the request's grant cookie when it names a live grant of an Entra
 * account (principal entra:…) and the switch "Ask for MFA after an automatic
 * sign-out" is off; else null. Which Entra account signs in shows only at the
 * callback, so the callback checks that the grant belongs to it.
 */
async function entraGrantHash(request:Request,time:number){
 const grantHash=await grantCookieHash(request);if(!grantHash)return null;
 const row=await db().one<{token_hash:string}>(sql`SELECT token_hash FROM mfa_grants WHERE token_hash=${grantHash} AND principal LIKE 'entra:%' AND expires_at>${time} AND ${grantAllowedSql}`);
 return row?.token_hash??null;
}
/**
 * GET /api/auth/entra/start. Counts one attempt in the address bucket (limiter
 * entra), creates a flow (random state, nonce and PKCE verifier; only their
 * SHA-256 hashes and the encrypted verifier are stored) and sends the browser
 * to the authorize endpoint of the tenant. With a live Entra grant in the
 * browser (entraGrantHash) the flow keeps its hash and the query has no prompt;
 * otherwise, and always with ?fresh=1, the query has prompt=login.
 */
export async function startEntraSignIn(request:Request):Promise<{location:string;cookies:string[]}>{
 const settings=await activeSettings();
 if(!settings||!mfaAvailable())return {location:'/#entra=notConfigured',cookies:[]};
 let reservation;
 try{reservation=await reserveAddressAttempt(request,'entra');}
 catch(error){if(error instanceof HttpError&&error.code==='AUTH_RATE_LIMITED')return {location:'/#entra=rateLimited',cookies:[]};throw error;}
 const state=random(),nonce=random(),browser=random(),{verifier,challenge}=await pkcePair(),time=now();
 const fresh=new URL(request.url).searchParams.get('fresh')==='1',grantHash=fresh?null:await entraGrantHash(request,time);
 const [{bucket,window_at}]=reservation;
 const results=await db().transaction(async tx=>{
  await tx.exec(sql`DELETE FROM entra_sign_in_flows WHERE expires_at<=${time}`);
  return tx.exec(sql`INSERT INTO entra_sign_in_flows(state_hash,browser_hash,nonce_hash,code_verifier_enc,created_at,expires_at,attempt_bucket,attempt_window_at,grant_hash) SELECT ${await hash(state)},${await hash(browser)},${await hash(nonce)},${await encryptSecret(verifier,codeVerifierContext)},${time},${time+entraFlowLimits.lifetimeMs},${bucket},${window_at},${grantHash}::text WHERE (SELECT count(*) FROM entra_sign_in_flows)<${entraFlowLimits.open}`);
 });
 if(!results.rowCount)return {location:'/#entra=busy',cookies:[]};
 const query=authorizeQuery(settings.client_id,{state,nonce,challenge});
 if(!grantHash)query.set('prompt','login');
 return {location:`${authorizeUrlOf(settings.tenant_id)}?${query}`,cookies:[flowCookie(browser,entraFlowLimits.lifetimeMs/1000)]};
}

type Flow={state_hash:string;nonce_hash:string;code_verifier_enc:string;created_at:number;attempt_bucket:string;attempt_window_at:number;grant_hash:string|null};
const controlCharacters=/[\u0000-\u001f\u007f-\u009f]/g;
/** Display name from name, else preferred_username, else the oid: without control characters, trimmed, at most 120 characters. */
export function entraDisplayName(claims:Pick<IdTokenClaims,'name'|'preferredUsername'|'oid'>){
 for(const value of [claims.name,claims.preferredUsername]){const clean=value.replace(controlCharacters,'').trim().slice(0,120).trim();if(clean)return clean;}
 return claims.oid;
}
const emailPattern=/^[^\s@\u0000-\u001f\u007f]{1,64}@[^\s@\u0000-\u001f\u007f]+\.[^\s@\u0000-\u001f\u007f]+$/;
/** Email from email, else preferred_username, when it is an email address; else empty. */
export function entraEmail(claims:Pick<IdTokenClaims,'email'|'preferredUsername'>){
 for(const value of [claims.email,claims.preferredUsername]){const clean=value.trim().toLowerCase();if(clean.length<=254&&emailPattern.test(clean))return clean;}
 return '';
}
async function refusalAudit(code:string,context:RefusalContext,detail:string|undefined){
 if(!auditedRefusals.has(code))return;
 await commitAll(auditEvent({actor:'System',action:'auth.entra.login.refused',target:`reason=${code} tenant=${context.tenant} object=${context.object}${refusalDetail(code,detail)}`,guard:sql`TRUE`}));
}
class SignInRefused extends Error{constructor(readonly outcome:EntraOutcome,readonly detail?:string){super(outcome);}}
const refusedBy=(failure:EntraFailure)=>new SignInRefused(failure.code as EntraOutcome,failure.detail);

/**
 * GET /api/auth/entra/callback for a sign-in flow (lib/server/identity/entra/confirm.ts,
 * entraCallback, picks it by the purpose of the stored row). Takes the flow by
 * the state hash and the flow cookie hash, unexpired, and deletes it in the
 * same statement. Every outcome
 * clears the flow cookie; only a success sets the session cookies.
 */
export async function finishEntraSignIn(request:Request):Promise<{outcome:'ok'|EntraOutcome;cookies:string[];amr?:string}>{
 const url=new URL(request.url),params=url.searchParams,state=params.get('state')??'',error=params.get('error'),code=params.get('code')??'',browser=cookieValue(request,entraFlowCookieName),time=now();
 const cookies=[clearEntraFlowCookie()];
 const flow=validToken(state)&&validToken(browser)?await db().one<Flow>(sql`DELETE FROM entra_sign_in_flows WHERE state_hash=${await hash(state)} AND purpose='sign-in' AND browser_hash=${await hash(browser)} AND expires_at>${time} RETURNING state_hash,nonce_hash,code_verifier_enc,created_at,attempt_bucket,attempt_window_at,grant_hash`):null;
 if(error==='access_denied')return {outcome:'cancelled',cookies};
 if(!flow)return {outcome:'expired',cookies};
 const context:RefusalContext={tenant:'-',object:'-'};
 try{
  if(apiSetupError(error))throw new SignInRefused('apiSetupMissing','refused');
  if(unavailableError(error))throw new SignInRefused('unavailable');
  if(error!==null)throw refusedBy(callbackRejected(error,params.get('error_description')));
  if(!code||code.length>8192)throw refusedBy(tokenRejected('code'));
  const settings=await activeSettings();
  if(!settings)throw new SignInRefused('notConfigured');
  const codeVerifier=await decryptSecret(flow.code_verifier_enc,codeVerifierContext);
  let claims:IdTokenClaims;
  try{
   const tokens=await redeemCode({tenant:settings.tenant_id,clientId:settings.client_id,credential:await savedCredential(settings),code,codeVerifier,redirectUri:entraRedirectUri()},time);
   claims=await verifyIdToken(tokens.idToken,{tenant:settings.tenant_id,clientId:settings.client_id,nonceHash:flow.nonce_hash,time,context});
   await verifyAccessToken(tokens.accessToken,{tenant:settings.tenant_id,clientId:settings.client_id,time,identity:claims});
  }catch(failure){if(failure instanceof EntraFailure)throw refusedBy(failure);throw failure;}
  // A forced sign-in proves a new Microsoft sign-in by auth_time, as the confirmation does.
  const seconds=Math.floor(time/1000),started=Math.floor(Number(flow.created_at)/1000);
  if(flow.grant_hash===null&&(claims.authTime===null||claims.authTime<started-authTimeLimits.beforeStartSeconds||claims.authTime>seconds+authTimeLimits.aheadSeconds))throw new SignInRefused('staleSignIn');
  return {outcome:'ok',cookies:[...cookies,...await commitSignIn(settings,claims,flow,time)]};
 }catch(failure){
  if(!(failure instanceof SignInRefused))throw failure;
  await refusalAudit(failure.outcome,context,failure.detail);
  return {outcome:failure.outcome,cookies,...(failure.outcome==='mfaMissing'&&failure.detail!==undefined?{amr:failure.detail}:{})};
 }
}

/**
 * The success commit: account (found or created), primary session (24 h,
 * pending_until = created, mfa_hash set) and MFA session (idle timeout of
 * lib/server/identity/session-settings.ts, absolute 24 h, no passkey) bound to it,
 * last_login_at, the groups of this sign-in, the role sync, the release of the
 * attempt reservation and auth.entra.login. Everything commits or nothing does.
 *
 * A forced sign-in also gives the browser a new MFA grant (while the switch is
 * off). A sign-in through a grant (flow.grant_hash) creates none: the session
 * insert carries the grant (live, of this account, switch off), the MFA session
 * ends at most 24 hours after the MFA of the grant, and a role sync that adds an
 * assignment rolls everything back and ends the grant, so new rights always
 * need a new Microsoft sign-in.
 */
async function commitSignIn(settings:EntraSettingsRow,claims:IdTokenClaims,flow:Flow,time:number):Promise<string[]>{
 const {tid,oid,groups}=claims,principal=`entra:${tid}:${oid}`,authEmail=`${oid}@${tid}.entra.serverdesk.invalid`,name=entraDisplayName(claims),email=entraEmail(claims);
 const existing=await db().one<{id:string;status:string}>(sql`SELECT id,status FROM local_users WHERE entra_tenant_id=${tid} AND entra_object_id=${oid} AND identity_source='entra'`);
 if(existing&&existing.status!=='active')throw new SignInRefused('accountDisabled');
 const grantHash=flow.grant_hash;
 const grant=grantHash===null?null:await db().one<{created_at:number}>(sql`SELECT created_at FROM mfa_grants WHERE token_hash=${grantHash} AND principal=${principal} AND expires_at>${time} AND ${grantAllowedSql}`);
 if(grantHash!==null&&!grant)throw new SignInRefused('reauthenticate');
 const token=random(),digest=await hash(token),mfaToken=random(),mfaHash=await hash(mfaToken),newId=crypto.randomUUID();
 const expiresAt=time+sessionLifetimeMs,mfaExpiresAt=grant?grantSessionExpiry(grant,time):time+mfaSessionLifetimeMs,idleExpiresAt=Math.min(mfaExpiresAt,time+await sessionIdleTimeoutMs());
 const account=sql`local_users WHERE entra_tenant_id=${tid} AND entra_object_id=${oid} AND identity_source='entra'`;
 // A switch-off or a new revision between the read above and this commit refuses the session.
 const settingsGuard=sql`EXISTS (SELECT 1 FROM entra_settings WHERE id=1 AND enabled=1 AND revision=${settings.revision} AND tenant_id=${tid})`;
 // A grant deleted, expired or switched off between the read above and this commit refuses the session too.
 const grantGuard=grantHash===null?sql``:sql` AND ${liveGrantSql(grantHash,principal,time)}`;
 const session=sql`EXISTS (SELECT 1 FROM local_auth_sessions WHERE token_hash=${digest} AND mfa_hash=${mfaHash})`;
 const statements:Step[]=[
  sql`INSERT INTO local_users(id,username,email,display_name,auth_principal,auth_email,status,password_hash,auth_version,must_reset,created_at,updated_at,identity_source,entra_tenant_id,entra_object_id) SELECT ${newId},${'entra.'+oid},${email},${name},${principal},${authEmail},'active',NULL,1,0,${time},${time},'entra',${tid},${oid} WHERE ${settingsGuard} ON CONFLICT DO NOTHING`,
  sql`UPDATE local_users SET display_name=${name},email=${email},updated_at=${time} WHERE entra_tenant_id=${tid} AND entra_object_id=${oid} AND identity_source='entra' AND status='active' AND id<>${newId} AND (display_name<>${name} OR email<>${email}) AND ${settingsGuard}`,
 ];
 const sessionInsert=statements.length;
 statements.push(
  sql`INSERT INTO local_auth_sessions(token_hash,user_id,auth_version,created_at,expires_at,pending_until,mfa_hash) SELECT ${digest},id,auth_version,${time},${expiresAt},${time},${mfaHash} FROM ${account} AND status='active' AND ${settingsGuard}${grantGuard}`,
  sql`INSERT INTO mfa_sessions(token_hash,principal,created_at,last_activity,idle_expires_at,expires_at,passkey_id) SELECT ${mfaHash}::text,${principal}::text,${time}::bigint,${time}::bigint,${idleExpiresAt}::bigint,${mfaExpiresAt}::bigint,NULL WHERE ${session}`,
  sql`DELETE FROM mfa_sessions WHERE expires_at<=${time} OR idle_expires_at<=${time}`,
  sql`UPDATE local_users SET last_login_at=${time} WHERE entra_tenant_id=${tid} AND entra_object_id=${oid} AND ${session}`,
  sql`DELETE FROM entra_user_groups WHERE user_id=(SELECT id FROM ${account}) AND ${session}`,
  sql`INSERT INTO entra_user_groups(user_id,group_object_id) SELECT (SELECT id FROM ${account}),value FROM jsonb_array_elements_text(${JSON.stringify(groups)}::jsonb) WHERE ${session}`,
 );
 const roleSync=statements.length;
 statements.push(
  roleSyncStatement({userId:sql`(SELECT id FROM ${account})`,actor:'System',at:time,guard:session}),
  ...auditEvent({actor:authEmail,action:'auth.entra.account.create',target:newId,guard:sql`EXISTS (SELECT 1 FROM local_users WHERE id=${newId}) AND ${session}`}),
  sql`INSERT INTO audit(at,actor,action,target,server_id,scope,customer_id) SELECT ${time}::bigint,${authEmail}::text,'auth.entra.login',id,NULL,'portal',NULL FROM ${account} AND ${session}`,
  ...releaseAttemptStatements([{bucket:flow.attempt_bucket,window_at:Number(flow.attempt_window_at)}],digest),
 );
 // A forced sign-in: a new grant for this browser, only with the session and while the switch is off.
 const newGrant=grantHash===null?await newGrantStatement({key:principal,userId:sql`(SELECT id FROM ${account})`,time,guard:session}):null;
 const grantInsert=statements.length;if(newGrant)statements.push(newGrant.insert);
 // Without the session nothing of this batch may stay: the transaction is rolled back.
 const rolledBack=Symbol('rolled back'),raised=Symbol('raised');
 let done:StepResult[]=[];
 try{
  await db().transaction(async tx=>{
   done=await runSteps(tx,statements);
   if(!done[sessionInsert].rowCount)throw rolledBack;
   // A sign-in through a grant never raises privileges: an added assignment needs a new Microsoft sign-in.
   if(grantHash!==null&&done[roleSync].rows.some(row=>/ added=[^ ]/.test(String(row.target))))throw raised;
  });
 }catch(failure){
  if(failure===raised){await db().exec(sql`DELETE FROM mfa_grants WHERE token_hash=${grantHash}`);throw new SignInRefused('reauthenticate');}
  if(failure!==rolledBack)throw failure;
  const current=await db().one<{status:string}>(sql`SELECT status FROM ${account}`);
  if(current&&current.status!=='active')throw new SignInRefused('accountDisabled');
  if(grantHash!==null&&!await db().one(sql`SELECT 1 AS live WHERE ${liveGrantSql(grantHash,principal,time)}`))throw new SignInRefused('reauthenticate');
  throw new SignInRefused('expired');
 }
 return [localAuthCookie(token,expiresAt),mfaSessionCookie(mfaToken,(mfaExpiresAt-time)/1000),...newGrant&&done[grantInsert]?.rowCount?[newGrant.cookie]:[],clearMfaTrustCookie()];
}

export const escapeHtml=(value:string)=>value.replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[character]!);
/** The language of the callback page: the console language cookie, else Accept-Language. */
export function callbackLocale(request:Request):Locale{return negotiateLocale(cookieValue(request,localeCookieName),request.headers.get('accept-language'));}
/**
 * The answer of the callback: a 200 same-origin HTML page, never a redirect.
 * Cookies with SameSite=Strict are not sent inside a redirect chain that began
 * on another site; the meta refresh from this page is a same-site navigation.
 * A visible Continue link is the fallback. No script, so the CSP needs no nonce.
 * mfaMissing carries the amr diagnostic (lib/entra/amr.ts) as #entra=mfaMissing&amr=<diagnostic>,
 * only when it parses, so the fragment holds nothing but allow-listed values.
 * reauthenticate goes to a new start that forces a new Microsoft sign-in (freshEntraStartPath).
 */
export function callbackPage(outcome:'ok'|EntraOutcome,locale:Locale,cookies:string[],amr?:string):Response{
 const target=outcome==='ok'?'/':outcome==='reauthenticate'?freshEntraStartPath:`/#entra=${outcome}${outcome==='mfaMissing'&&amr!==undefined&&parseAmrDiagnostic(amr)!==null?`&amr=${amr}`:''}`,title=escapeHtml(translate(locale,'entra.callback.title')),label=escapeHtml(translate(locale,'entra.callback.continue'));
 const body=`<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta http-equiv="refresh" content="0;url=${escapeHtml(target)}"><title>${title}</title></head><body><main><p>${title}</p><p><a href="${escapeHtml(target)}">${label}</a></p></main></body></html>`;
 const headers=new Headers({'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});
 for(const cookie of cookies)headers.append('Set-Cookie',cookie);
 return new Response(body,{status:200,headers});
}
/** The answer of the start: 302 to Microsoft (or to /#entra=<code>), with no-store. */
export function startRedirect({location,cookies}:{location:string;cookies:string[]}):Response{
 const headers=new Headers({Location:location,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});
 for(const cookie of cookies)headers.append('Set-Cookie',cookie);
 return new Response(null,{status:302,headers});
}
