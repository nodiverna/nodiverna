import {failure,requireViewer} from '@/lib/server/context';
import {deviceSoftwareView} from '@/lib/server/devices/software';
// The software list and change history of one device (lib/server/devices/software.ts).
export async function GET(request:Request){try{
 const v=await requireViewer();
 return Response.json(await deviceSoftwareView(v,new URL(request.url).searchParams.get('id')),{headers:{'Cache-Control':'no-store'}});
}catch(e){return failure(e);}}
