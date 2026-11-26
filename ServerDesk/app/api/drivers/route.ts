import {failure,requireViewer} from '@/lib/server/context';
import {driverFleetView} from '@/lib/server/devices/drivers';
// The drivers of the visible devices in one scope, grouped by driver, version and provider (lib/server/devices/drivers.ts).
export async function GET(request:Request){try{
 const v=await requireViewer();
 return Response.json(await driverFleetView(v,new URL(request.url).searchParams),{headers:{'Cache-Control':'no-store'}});
}catch(e){return failure(e);}}
