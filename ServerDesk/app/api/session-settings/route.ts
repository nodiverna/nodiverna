import {body,failure,HttpError,requireViewer,sameOrigin} from '@/lib/server/context';
import {sessionSettingsStatus,setSessionIdleRequiresMfa,setSessionIdleTimeout,setSessionSettings} from '@/lib/server/identity/session-settings';

// Instance security settings (docs/portal-sessions.md): the automatic logout
// after inactivity and the MFA after an automatic logout. Owners only; a change
// needs a fresh step-up proof (lib/step-up.ts, rule 6) and applies to every
// account at once.
const headers={'Cache-Control':'no-store'};
export async function GET(){try{const viewer=await requireViewer();return Response.json(await sessionSettingsStatus(viewer),{headers});}catch(e){return failure(e);}}
export async function POST(request:Request){
 try{
  sameOrigin(request);const viewer=await requireViewer(),p=await body(request,4096);
  // set: both rules with one proof (the one Save of Settings › Sessions); the two single actions stay for older clients.
  if(p.action==='set')return Response.json(await setSessionSettings(request,viewer,p.idleTimeoutMinutes,p.idleRequiresMfa,p.managementToken),{headers});
  if(p.action==='set-idle-timeout')return Response.json(await setSessionIdleTimeout(request,viewer,p.minutes,p.managementToken),{headers});
  if(p.action==='set-idle-mfa')return Response.json(await setSessionIdleRequiresMfa(request,viewer,p.required,p.managementToken),{headers});
  throw new HttpError('apiError.request.unknownAction');
 }catch(e){return failure(e);}
}
