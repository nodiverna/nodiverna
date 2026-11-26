import {failure,requireViewer,sameOrigin} from '@/lib/server/context';
import {requestVulnerabilitySync} from '@/lib/server/devices/vulnerabilities';

// Check now: the scheduler starts the NVD sync within a minute (lib/server/devices/vulnerabilities.ts). Owners only.
export async function POST(request:Request){
 try{sameOrigin(request);const viewer=await requireViewer();return Response.json(await requestVulnerabilitySync(viewer),{headers:{'Cache-Control':'no-store'}});}
 catch(e){return failure(e);}
}
