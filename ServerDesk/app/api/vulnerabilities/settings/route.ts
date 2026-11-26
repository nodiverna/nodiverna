import {body,failure,requireViewer,sameOrigin} from '@/lib/server/context';
import {setVulnerabilitySettings,vulnerabilitySettingsView} from '@/lib/server/devices/vulnerabilities';

// The settings of the vulnerability check (lib/server/devices/vulnerabilities.ts). Owners only;
// the NVD API key never leaves the server.
const headers={'Cache-Control':'no-store'};
export async function GET(){try{const viewer=await requireViewer();return Response.json(await vulnerabilitySettingsView(viewer),{headers});}catch(e){return failure(e);}}
export async function PUT(request:Request){
 try{
  sameOrigin(request);const viewer=await requireViewer(),p=await body(request,4096);
  return Response.json(await setVulnerabilitySettings(viewer,{enabled:p.enabled,apiKey:p.apiKey,revision:p.revision,secondSource:p.secondSource}),{headers});
 }catch(e){return failure(e);}
}
