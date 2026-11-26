import {body,failure,HttpError,requireViewer,sameOrigin} from '@/lib/server/context';
import {adSignInStatus,listAdSessions,signInAd,signOutAd} from '@/lib/server/extensions/plugin-ad-sessions';
// AD sign-in for plugin changes (docs/plugin-ad-sign-in.md, lib/server/extensions/plugin-ad-sessions.ts).
// GET lists the active sign-ins of this portal session; GET ?jobId= answers the
// state of one own sign-in job for the dialog's poll. POST sign-in queues the
// check of an account and its password on one device (the password is sealed
// to the device key and never stored); POST sign-out ends one own sign-in.
const headers={'Cache-Control':'no-store'};
export async function GET(request:Request){try{
 const v=await requireViewer(),jobId=new URL(request.url).searchParams.get('jobId');
 if(jobId!==null)return Response.json(await adSignInStatus(request,v,jobId),{headers});
 return Response.json({sessions:await listAdSessions(request,v)},{headers});
}catch(e){return failure(e);}}
export async function POST(request:Request){try{
 sameOrigin(request);const v=await requireViewer(),p=await body(request,8192);
 if(p.action==='sign-in')return Response.json(await signInAd(request,v,{serverId:p.serverId,plugin:p.plugin,account:p.account,password:p.password}),{headers});
 if(p.action==='sign-out')return Response.json(await signOutAd(request,v,p.id),{headers});
 throw new HttpError('apiError.request.unknownAction');
}catch(e){return failure(e);}}
