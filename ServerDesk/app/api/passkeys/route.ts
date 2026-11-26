import {body,failure,HttpError,requireAuthIdentity,sameOrigin} from '@/lib/server/context';
import {authenticationOptions,authenticationVerify,deletePasskey,passkeyStatus,registrationOptions,registrationVerify,renamePasskey,setupOptions,setupVerify} from '@/lib/server/identity/passkeys';
function reply(result:Record<string,unknown>){const {cookies,...data}=result,h=new Headers({'Cache-Control':'no-store'});for(const cookie of (cookies as string[]|undefined)??[])h.append('Set-Cookie',cookie);return Response.json(data,{headers:h});}
export async function GET(request:Request){try{return reply(await passkeyStatus(request,await requireAuthIdentity(request)));}catch(e){return failure(e);}}
export async function POST(request:Request){try{
 sameOrigin(request);const v=await requireAuthIdentity(request),p=await body(request,32768);
 // A remember24 field of older clients is ignored (docs/portal-sessions.md).
 if(p.action==='registration-options')return reply(await registrationOptions(request,v,p));
 // The registration commits its audit row inside the guarded batch.
 if(p.action==='registration-verify')return reply(await registrationVerify(request,v,p));
 // First enrollment with a passkey needs only the primary session, no MFA proof.
 if(p.action==='setup-options')return reply(await setupOptions(request,v,p));
 // Account, credential, session and audit row commit in one batch (issueSession).
 if(p.action==='setup-verify'){const result=await setupVerify(request,v,p);return reply({ok:true,...result});}
 if(p.action==='authentication-options')return reply(await authenticationOptions(request,v,p));
 if(p.action==='authentication-verify'){const result=await authenticationVerify(request,v,p);return reply({ok:true,...result});}
 // Rename and delete commit their audit row inside the guarded batch.
 if(p.action==='rename')return reply(await renamePasskey(request,v,p));
 if(p.action==='delete')return reply(await deletePasskey(request,v,p));
 throw new HttpError('apiError.passkey.unknownAction');
}catch(e){return failure(e);}}
