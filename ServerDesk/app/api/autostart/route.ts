import {failure,requireViewer} from '@/lib/server/context';
import {autostartFleetView} from '@/lib/server/devices/autostart';
// The autostart entries of the visible devices in one scope, rare entries first (lib/server/devices/autostart.ts).
export async function GET(request:Request){try{
 const v=await requireViewer();
 return Response.json(await autostartFleetView(v,new URL(request.url).searchParams),{headers:{'Cache-Control':'no-store'}});
}catch(e){return failure(e);}}
