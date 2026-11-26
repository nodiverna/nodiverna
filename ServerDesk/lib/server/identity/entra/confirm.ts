// "Confirm with Microsoft" (docs/entra-id.md): the step-up of an account from
// Microsoft Entra ID. The console opens a window,
// POST /api/mfa entra-begin creates a confirm flow (a forced new sign-in:
// prompt=login; no max_age, because with max_age=0 Entra ID gives an id_token
// that expires at auth_time; the auth_time window of authTimeLimits proves the
// fresh sign-in), Microsoft returns to the single redirect URI
// /api/auth/entra/callback, and the callback records the result on the flow row.
// The console polls entra-claim with the claim handle; a confirmed flow gives a
// new MFA session bound to the same primary session and a 5-minute
// managementToken, as a local verify does (issueSession with an entraGrant).
// It never creates an MFA grant (docs/portal-sessions.md).
// The purpose of a callback comes only from the stored flow row.
import {failure,hash,HttpError,now,random} from '../../context';
import {primaryAuthenticationGuard,primarySessionHash,reserveAddressAttempt} from '../local-auth';
import {encryptSecret,decryptSecret,isEntraViewer,issueSession,mfaAvailable} from '../mfa';
import {principal} from '../access';
import {auditEvent} from '../../audit';
import {translate} from '../../../i18n/translate';
import type {MessageKey} from '../../../i18n/translate';
import type {Locale} from '../../../i18n/locale';
import type {Viewer} from '../../../types';
import {commitAll,db,sql} from '../../db';
import {apiSetupError,authorizeUrlOf,callbackRejected,EntraFailure,redeemCode,timeOffset,timeRejected,tokenRejected,unavailableError,verifyAccessToken,verifyIdToken,type IdTokenClaims,type RefusalContext} from './oidc';
import {entraRedirectUri,savedCredential} from './settings';
import {activeSettings,authorizeQuery,authTimeLimits,codeVerifierContext,cookieValue,entraFlowLimits,escapeHtml,finishEntraSignIn,pkcePair,refusalDetail,validToken,type EntraOutcome} from './sign-in';
import {amrDetail,parseAmrDiagnostic} from '../../../entra/amr';

export const entraConfirmCookieName='__Host-serverdesk-entra-confirm';
/** The refusal codes of a confirmation; the claim answers apiError.entra.confirm.<code>. */
export type ConfirmOutcome='cancelled'|'expired'|'mfaMissing'|'apiSetupMissing'|'wrongTenant'|'wrongAccount'|'staleSignIn'|'accountDisabled'|'tokenRejected'|'unavailable'|'notConfigured';
/** Refusals after a valid flow that write auth.entra.confirm.refused. */
const auditedRefusals:ReadonlySet<ConfirmOutcome>=new Set(['wrongAccount','staleSignIn','mfaMissing','apiSetupMissing','wrongTenant','accountDisabled','tokenRejected']);
export {authTimeLimits};

const confirmCookie=(token:string,maxAge:number)=>`${entraConfirmCookieName}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
export const clearEntraConfirmCookie=()=>confirmCookie('',0);
const expired=()=>new HttpError('apiError.entra.confirm.expired');

/**
 * POST /api/mfa entra-begin. Needs the bound primary session of an Entra account,
 * which counts only while its MFA session is live (lib/server/identity/local-auth.ts):
 * after the idle timeout the account signs in again instead. Counts one
 * attempt in the address bucket, then deletes the expired flows and the open
 * confirm flows of this primary session and inserts the confirm flow, in one
 * transaction. Only hashes and the encrypted PKCE verifier are stored.
 */
export async function beginEntraConfirm(request:Request,v:Viewer):Promise<{flow:string;url:string;expiresAt:number;cookies:string[]}>{
 if(!isEntraViewer(v))throw new HttpError('apiError.mfa.entraOnly');
 const settings=await activeSettings();
 if(!settings||!mfaAvailable())throw new HttpError('apiError.entra.confirm.notConfigured');
 const primaryHash=await primarySessionHash(request,v),authentication=await primaryAuthenticationGuard(request,v);
 const [{bucket,window_at}]=await reserveAddressAttempt(request,'entra');
 const state=random(),nonce=random(),browser=random(),claim=random(),{verifier,challenge}=await pkcePair(),time=now(),expiresAt=time+entraFlowLimits.lifetimeMs;
 const account=await db().one<{email:string}>(sql`SELECT email FROM local_users WHERE id=${v.userId??''} AND auth_principal=${principal(v)} AND identity_source='entra'`);
 if(!account)throw new HttpError('apiError.auth.signInAgain');
 const owner=sql`EXISTS (SELECT 1 FROM local_users confirm_user WHERE confirm_user.id=${v.userId??''} AND confirm_user.auth_principal=${principal(v)} AND confirm_user.identity_source='entra' AND confirm_user.status='active')`;
 const values=sql`${await hash(state)},${await hash(browser)},${await hash(nonce)},${await encryptSecret(verifier,codeVerifierContext)},${time},${expiresAt},${bucket},${window_at},'confirm',${v.userId??''},${primaryHash},${await hash(claim)},${settings.revision}`;
 const results=await db().transaction(async tx=>{
  await tx.exec(sql`DELETE FROM entra_sign_in_flows WHERE expires_at<=${time}`);
  await tx.exec(sql`DELETE FROM entra_sign_in_flows WHERE purpose='confirm' AND primary_hash=${primaryHash}`);
  const full=Number((await tx.one<{n:number}>(sql`SELECT count(*) AS n FROM entra_sign_in_flows`))?.n??0)>=entraFlowLimits.open;
  if(full)return {full,rowCount:0};
  const inserted=await tx.exec(sql`INSERT INTO entra_sign_in_flows(state_hash,browser_hash,nonce_hash,code_verifier_enc,created_at,expires_at,attempt_bucket,attempt_window_at,purpose,user_id,primary_hash,claim_hash,settings_revision) SELECT ${values} WHERE (${authentication}) AND ${owner} AND (SELECT count(*) FROM entra_sign_in_flows)<${entraFlowLimits.open}`);
  return {full:false,rowCount:inserted.rowCount};
 });
 if(results.full)throw new HttpError('apiError.entra.busy');
 if(!results.rowCount)throw new HttpError('apiError.auth.signInAgain');
 const query=authorizeQuery(settings.client_id,{state,nonce,challenge});
 query.set('prompt','login');
 if(account.email)query.set('login_hint',account.email);
 return {flow:claim,url:`${authorizeUrlOf(settings.tenant_id)}?${query}`,expiresAt,cookies:[confirmCookie(browser,entraFlowLimits.lifetimeMs/1000)]};
}

type ConfirmFlow={state_hash:string;nonce_hash:string;code_verifier_enc:string;created_at:number;user_id:string;settings_revision:number};
class ConfirmRefused extends Error{constructor(readonly outcome:ConfirmOutcome,readonly detail?:string){super(outcome);}}
/**
 * The EntraFailure codes of the token checks that keep their own outcome in a
 * confirmation; any other reads as tokenRejected. The only other code of the
 * checks, groupsOverage, does not occur: the confirmation ignores the groups claim.
 */
const confirmFailures:ReadonlySet<string>=new Set(['mfaMissing','apiSetupMissing','wrongTenant','unavailable','expired','tokenRejected']);
const refusedBy=(failure:EntraFailure)=>confirmFailures.has(failure.code)?new ConfirmRefused(failure.code as ConfirmOutcome,failure.detail):new ConfirmRefused('tokenRejected',failure.detail);
/**
 * A refused time check of a token (timeRejected) also names the start of the
 * flow: " start=<n>", created_at as an offset from the same `time` (timeOffset).
 * Every other refusal is refusedBy unchanged.
 */
const refusedAt=(failure:EntraFailure,flow:ConfirmFlow,time:number)=>timeRejected(failure)?new ConfirmRefused('tokenRejected',`${failure.detail} start=${timeOffset(Number(flow.created_at)/1000,time)}`):refusedBy(failure);

/**
 * GET /api/auth/entra/callback: finds the flow by the state hash only, deletes
 * nothing yet, and hands it to the sign-in or the confirmation by the purpose of
 * the stored row. A request parameter never chooses the purpose.
 */
export async function entraCallback(request:Request):Promise<{purpose:'sign-in';outcome:'ok'|EntraOutcome;cookies:string[];amr?:string}|{purpose:'confirm';outcome:'ok'|ConfirmOutcome;cookies:string[];amr?:string}>{
 const state=new URL(request.url).searchParams.get('state')??'';
 const found=validToken(state)?await db().one<{purpose:string}>(sql`SELECT purpose FROM entra_sign_in_flows WHERE state_hash=${await hash(state)}`):null;
 if(found?.purpose==='confirm')return {purpose:'confirm',...await finishEntraConfirm(request,state)};
 return {purpose:'sign-in',...await finishEntraSignIn(request)};
}

/**
 * The callback of a confirm flow. The flow cookie of the confirmation must match
 * the flow. The flow is taken once: its encrypted verifier is emptied, so a
 * second callback for the same state ends with expired. The code is redeemed and
 * the id_token and the access token of the portal API checked as at the
 * sign-in (the groups claim is ignored), then also: the same account (oid,
 * tid), auth_time after the start, an active account and the settings revision
 * of the start. The result goes onto the flow row (confirmed_at or outcome); no
 * session cookie is set. A mfaMissing refusal returns its amr diagnostic for
 * the page.
 */
async function finishEntraConfirm(request:Request,state:string):Promise<{outcome:'ok'|ConfirmOutcome;cookies:string[];amr?:string}>{
 const cookies=[clearEntraConfirmCookie()],browser=cookieValue(request,entraConfirmCookieName),time=now(),params=new URL(request.url).searchParams;
 if(!validToken(browser))return {outcome:'expired',cookies};
 const stateHash=await hash(state),browserHash=await hash(browser);
 const flow=await db().one<ConfirmFlow>(sql`SELECT state_hash,nonce_hash,code_verifier_enc,created_at,user_id,settings_revision FROM entra_sign_in_flows WHERE state_hash=${stateHash} AND purpose='confirm' AND browser_hash=${browserHash} AND expires_at>${time} AND code_verifier_enc<>'' AND confirmed_at IS NULL AND outcome IS NULL`);
 if(!flow)return {outcome:'expired',cookies};
 const taken=await db().exec(sql`UPDATE entra_sign_in_flows SET code_verifier_enc='' WHERE state_hash=${stateHash} AND browser_hash=${browserHash} AND code_verifier_enc=${flow.code_verifier_enc} AND expires_at>${time}`);
 if(!taken.rowCount)return {outcome:'expired',cookies};
 const record=(outcome:ConfirmOutcome)=>db().exec(sql`UPDATE entra_sign_in_flows SET outcome=${outcome} WHERE state_hash=${stateHash} AND confirmed_at IS NULL AND outcome IS NULL`);
 const context:RefusalContext={tenant:'-',object:'-'};
 try{
  await confirmFlow(flow,params,stateHash,time,context);
  return {outcome:'ok',cookies};
 }catch(error){
  // An unexpected failure is logged and ends the flow as unavailable, so the waiting console stops.
  if(!(error instanceof ConfirmRefused))failure(error);
  const outcome=error instanceof ConfirmRefused?error.outcome:'unavailable',detail=error instanceof ConfirmRefused?error.detail:undefined;
  await record(outcome);
  if(auditedRefusals.has(outcome))await commitAll(auditEvent({actor:'System',action:'auth.entra.confirm.refused',target:`reason=${outcome} user=${flow.user_id} tenant=${context.tenant} object=${context.object}${refusalDetail(outcome,detail)}`,guard:sql`TRUE`}));
  return {outcome,cookies,...(outcome==='mfaMissing'&&detail!==undefined?{amr:detail}:{})};
 }
}

async function confirmFlow(flow:ConfirmFlow,params:URLSearchParams,stateHash:string,time:number,context:RefusalContext){
 const error=params.get('error'),code=params.get('code')??'';
 if(error==='access_denied')throw new ConfirmRefused('cancelled');
 if(apiSetupError(error))throw new ConfirmRefused('apiSetupMissing','refused');
 if(unavailableError(error))throw new ConfirmRefused('unavailable');
 if(error!==null)throw refusedBy(callbackRejected(error,params.get('error_description')));
 if(!code||code.length>8192)throw refusedBy(tokenRejected('code'));
 const settings=await activeSettings();
 if(!settings||settings.revision!==Number(flow.settings_revision))throw new ConfirmRefused('notConfigured');
 const codeVerifier=await decryptSecret(flow.code_verifier_enc,codeVerifierContext);
 let claims:IdTokenClaims;
 try{
  const tokens=await redeemCode({tenant:settings.tenant_id,clientId:settings.client_id,credential:await savedCredential(settings),code,codeVerifier,redirectUri:entraRedirectUri()},time);
  claims=await verifyIdToken(tokens.idToken,{tenant:settings.tenant_id,clientId:settings.client_id,nonceHash:flow.nonce_hash,time,context,ignoreGroups:true});
  // The MFA signal: amr of the v1.0 access token of the portal API from the same answer.
  await verifyAccessToken(tokens.accessToken,{tenant:settings.tenant_id,clientId:settings.client_id,time,identity:claims});
 }catch(failed){
  if(failed instanceof EntraFailure)throw refusedAt(failed,flow,time);
  throw failed;
 }
 const user=await db().one<{status:string;entra_tenant_id:string;entra_object_id:string}>(sql`SELECT status,entra_tenant_id,entra_object_id FROM local_users WHERE id=${flow.user_id} AND identity_source='entra'`);
 if(!user||user.entra_object_id!==claims.oid||user.entra_tenant_id!==claims.tid)throw new ConfirmRefused('wrongAccount');
 const seconds=Math.floor(time/1000),started=Math.floor(Number(flow.created_at)/1000);
 if(claims.authTime===null||claims.authTime<started-authTimeLimits.beforeStartSeconds||claims.authTime>seconds+authTimeLimits.aheadSeconds)throw new ConfirmRefused('staleSignIn');
 if(user.status!=='active')throw new ConfirmRefused('accountDisabled');
 // The account, the settings revision and the open flow are checked again in the statement that confirms.
 const confirmed=await db().exec(sql`UPDATE entra_sign_in_flows SET confirmed_at=${time} WHERE state_hash=${stateHash} AND confirmed_at IS NULL AND outcome IS NULL AND expires_at>${time} AND EXISTS (SELECT 1 FROM local_users WHERE id=${flow.user_id} AND identity_source='entra' AND status='active' AND entra_tenant_id=${claims.tid} AND entra_object_id=${claims.oid}) AND EXISTS (SELECT 1 FROM entra_settings WHERE id=1 AND enabled=1 AND revision=${flow.settings_revision})`);
 if(confirmed.rowCount)return;
 const latest=await db().one<{status:string}>(sql`SELECT status FROM local_users WHERE id=${flow.user_id}`);
 if(latest&&latest.status!=='active')throw new ConfirmRefused('accountDisabled');
 const current=await activeSettings();
 throw new ConfirmRefused(!current||current.revision!==Number(flow.settings_revision)?'notConfigured':'expired');
}

type ClaimRow={confirmed_at:number|null;outcome:ConfirmOutcome|null;attempt_bucket:string;attempt_window_at:number};
/**
 * POST /api/mfa entra-claim with {flow}: the claim handle is the bearer, and the
 * flow must belong to the request's primary session and the viewer's account
 * and be unexpired. Pending: {pending:true}. A refusal deletes the row and
 * answers its code. A confirmed flow issues the MFA session and the proof.
 */
export async function claimEntraConfirm(request:Request,v:Viewer,flow:unknown){
 if(!isEntraViewer(v))throw new HttpError('apiError.mfa.entraOnly');
 if(typeof flow!=='string'||!validToken(flow))throw expired();
 const claimHash=await hash(flow),primaryHash=await primarySessionHash(request,v).catch(()=>null),userId=v.userId??'',time=now();
 if(!primaryHash)throw expired();
 const owned=sql`claim_hash=${claimHash} AND purpose='confirm' AND primary_hash=${primaryHash} AND user_id=${userId}`;
 const row=await db().one<ClaimRow>(sql`SELECT confirmed_at,outcome,attempt_bucket,attempt_window_at FROM entra_sign_in_flows WHERE ${owned} AND expires_at>${time}`);
 if(!row)throw expired();
 if(row.outcome){
  const deleted=await db().exec(sql`DELETE FROM entra_sign_in_flows WHERE ${owned} AND outcome=${row.outcome}`);
  if(!deleted.rowCount)throw expired();
  throw new HttpError(`apiError.entra.confirm.${row.outcome}` as const);
 }
 if(row.confirmed_at===null)return {pending:true as const};
 return issueSession(v,{resetAttempts:true,request,entraGrant:{claimHash,primaryHash,userId,attempt:{bucket:row.attempt_bucket,window_at:Number(row.attempt_window_at)}},audit:{actor:v.label,action:'auth.entra.confirm',target:userId},conflict:expired()});
}

/**
 * The callback page of a confirm flow: a 200 same-origin HTML page with no meta
 * refresh and no script. The console learns the result by polling entra-claim;
 * the person closes this window (the console closes it after the claim).
 * mfaMissing adds the amr detail line (lib/entra/amr.ts) when the diagnostic parses.
 */
export function confirmPage(outcome:'ok'|ConfirmOutcome,locale:Locale,cookies:string[],amr?:string):Response{
 const text=(key:MessageKey,params?:Record<string,string>)=>escapeHtml(translate(locale,key,params));
 const title=text(outcome==='ok'?'entra.confirm.doneTitle':'entra.confirm.failedTitle');
 const diagnostic=outcome==='mfaMissing'&&amr!==undefined?parseAmrDiagnostic(amr):null,detail=diagnostic===null?null:amrDetail(diagnostic);
 const detailLine=detail===null?[]:[detail.key==='entra.error.amrValues'?text(detail.key,{methods:detail.methods}):text(detail.key)];
 const lines=outcome==='ok'?[text('entra.confirm.doneText')]:[text(`entra.error.${outcome}`),...detailLine,text('entra.confirm.failedText')];
 const body=`<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title></head><body><main><h1>${title}</h1>${lines.map(line=>`<p>${line}</p>`).join('')}</main></body></html>`;
 const headers=new Headers({'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});
 for(const cookie of cookies)headers.append('Set-Cookie',cookie);
 return new Response(body,{status:200,headers});
}
