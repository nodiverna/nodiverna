import {failure,requireViewer} from '@/lib/server/context';
import {deviceDriverView} from '@/lib/server/devices/drivers';
// The driver list of one device (lib/server/devices/drivers.ts).
export async function GET(request:Request){try{
 const v=await requireViewer();
 return Response.json(await deviceDriverView(v,new URL(request.url).searchParams.get('id')),{headers:{'Cache-Control':'no-store'}});
}catch(e){return failure(e);}}
