import {body,failure,requireViewer,sameOrigin} from '@/lib/server/context';
import {acknowledgeSecurityAlarm} from '@/lib/server/identity/security-alarms';

// Security alarms of the portal (lib/server/identity/security-alarms.ts, docs/entra-id.md).
// acknowledge: global Owners with live sessions, no step-up; never the alarm of
// the viewer's own emergency sign-in.
const headers={'Cache-Control':'no-store'};
export async function POST(request:Request){
 try{
  sameOrigin(request);const viewer=await requireViewer(),p=await body(request,4*1024);
  return Response.json(await acknowledgeSecurityAlarm(request,viewer,p),{headers});
 }catch(e){return failure(e);}
}
