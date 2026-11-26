import {failure,requireViewer} from '@/lib/server/context';
import {softwareFleetView} from '@/lib/server/devices/software';
// The programs of the visible devices in one scope, grouped by product and version (lib/server/devices/software.ts).
export async function GET(request:Request){try{
 const v=await requireViewer();
 return Response.json(await softwareFleetView(v,new URL(request.url).searchParams),{headers:{'Cache-Control':'no-store'}});
}catch(e){return failure(e);}}
