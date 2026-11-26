import {body,failure,HttpError,requireAuthIdentity,sameOrigin} from '@/lib/server/context';
import {beginEntraConfirm,claimEntraConfirm,clearEntraConfirmCookie} from '@/lib/server/identity/entra/confirm';
import {beginAuthenticator,beginMfa,cancelAuthenticator,clearMfaGrantCookie,clearMfaSessionCookie,clearMfaTrustCookie,confirmAuthenticator,confirmMfa,deleteAuthenticator,disableMfa,logoutMfa,mfaStatus,recordMfaActivity,regenerateRecovery,renameAuthenticator,verifyMfa} from '@/lib/server/identity/mfa';
const headers={'Cache-Control':'no-store'};
function response(data:unknown,cookies:string[]=[]){const h=new Headers(headers);for(const cookie of cookies)h.append('Set-Cookie',cookie);return Response.json(data,{headers:h});}
export async function GET(request:Request){try{const v=await requireAuthIdentity(request);return response(await mfaStatus(request,v));}catch(e){return failure(e);}}
export async function POST(request:Request){try{
 sameOrigin(request);const v=await requireAuthIdentity(request),p=await body(request,8192);
 // A remember24 field of older clients is ignored: the MFA grant of a sign-in (docs/portal-sessions.md) needs no choice.
 if(p.action==='begin')return Response.json(await beginMfa(request,v),{headers});
 if(p.action==='confirm'||p.action==='verify'){
  // The audit row commits inside the login batch, see issueSession.
  const result=p.action==='confirm'?await confirmMfa(request,v,p.code):await verifyMfa(v,p.code,p.recoveryCode,request);
  const {cookies,...data}=result;return response({ok:true,...data},cookies);
 }
 // Confirm with Microsoft (lib/server/identity/entra/confirm.ts): an Entra account starts a fresh
 // Microsoft sign-in and claims its result. Neither needs a live MFA session.
 if(p.action==='entra-begin'){const {cookies,...data}=await beginEntraConfirm(request,v);return response(data,cookies);}
 if(p.action==='entra-claim'){
  const result=await claimEntraConfirm(request,v,p.flow);
  if('pending' in result)return response(result);
  const {cookies,...data}=result;return response({ok:true,...data},[...cookies,clearEntraConfirmCookie()]);
 }
 if(p.action==='activity')return response({ok:true,...await recordMfaActivity(request,v)});
 if(p.action==='authenticator-begin')return response(await beginAuthenticator(request,v,p));
 // Confirm, delete and disable commit their audit row inside the guarded batch.
 if(p.action==='authenticator-confirm')return response(await confirmAuthenticator(request,v,p));
 if(p.action==='authenticator-cancel')return response(await cancelAuthenticator(request,v,p));
 // The rename commits its audit row inside the guarded batch.
 if(p.action==='authenticator-rename')return response(await renameAuthenticator(request,v,p));
 if(p.action==='authenticator-delete')return response(await deleteAuthenticator(request,v,p));
 if(p.action==='logout'){
  if(p.idle!==undefined&&typeof p.idle!=='boolean')throw new HttpError('apiError.mfa.invalidSignOutOption');
  const cookies=await logoutMfa(request,v,p.idle===true);
  return response({ok:true,authenticated:false},cookies);
 }
 if(p.action==='disable'){await disableMfa(request,v,p.managementToken);return response({ok:true,authenticated:false},[clearMfaSessionCookie(),clearMfaGrantCookie(),clearMfaTrustCookie()]);}
 if(p.action==='regenerate-recovery'){const recoveryCodes=await regenerateRecovery(request,v,p.managementToken);return Response.json({ok:true,recoveryCodes},{headers});}
 throw new HttpError('apiError.mfa.unknownAction');
}catch(e){return failure(e);}}
