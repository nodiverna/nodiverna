import {failure,requireViewer} from '@/lib/server/context';
import {gpuDriverDeviceView} from '@/lib/server/devices/gpu-drivers/device';
// The graphics driver status of one device (lib/server/devices/gpu-drivers/device.ts).
export async function GET(request:Request){try{
 const v=await requireViewer(),params=new URL(request.url).searchParams;
 return Response.json(await gpuDriverDeviceView(v,params.get('serverId'),params.get('refresh')==='1'),{headers:{'Cache-Control':'no-store'}});
}catch(e){return failure(e);}}
