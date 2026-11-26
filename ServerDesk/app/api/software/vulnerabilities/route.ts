import {failure,requireViewer} from '@/lib/server/context';
import {softwareVulnerabilityDetail} from '@/lib/server/devices/vulnerabilities';
// The CVEs of one program version on a device or in a scope (lib/server/devices/vulnerabilities.ts).
export async function GET(request:Request){try{
 const v=await requireViewer();
 return Response.json(await softwareVulnerabilityDetail(v,new URL(request.url).searchParams),{headers:{'Cache-Control':'no-store'}});
}catch(e){return failure(e);}}
