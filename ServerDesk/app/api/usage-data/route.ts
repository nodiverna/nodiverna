import {body,failure,HttpError,requireViewer,sameOrigin} from '@/lib/server/context';
import {setUsageConsent,usageDataStatus} from '@/lib/server/usage-data';

// Usage data for product improvement (docs/usage-data.md). Owners only. The
// usage data server URL and the deciding account never leave the server.
const headers={'Cache-Control':'no-store'};
export async function GET(){try{const viewer=await requireViewer();return Response.json(await usageDataStatus(viewer),{headers});}catch(e){return failure(e);}}
export async function POST(request:Request){
 try{
  sameOrigin(request);const viewer=await requireViewer(),p=await body(request,4096);
  if(p.action!=='set')throw new HttpError('apiError.request.unknownAction');
  return Response.json(await setUsageConsent(viewer,p.enabled,p.revision),{headers});
 }catch(e){return failure(e);}
}
