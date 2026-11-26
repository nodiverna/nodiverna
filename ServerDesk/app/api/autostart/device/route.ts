import {body,failure,HttpError,requireViewer,sameOrigin} from '@/lib/server/context';
import {confirmAutostart,deviceAutostartView} from '@/lib/server/devices/autostart';
import {syncDeviceAlerts} from '@/lib/server/devices/alerts';
const headers={'Cache-Control':'no-store'};
// The autostart list of one device and the confirmation of its new entries (lib/server/devices/autostart.ts).
export async function GET(request:Request){try{
 const v=await requireViewer();
 return Response.json(await deviceAutostartView(v,new URL(request.url).searchParams.get('id')),{headers});
}catch(e){return failure(e);}}
export async function POST(request:Request){try{
 sameOrigin(request);const v=await requireViewer(),p=await body(request);
 if(!p||typeof p!=='object'||Array.isArray(p))throw new HttpError('apiError.request.invalid');
 const result=await confirmAutostart(request,v,p);
 // The confirmed entries close their alarms at once; the periodic alarm check catches up on a failure.
 try{await syncDeviceAlerts(String(p.id).toLowerCase());}catch(error){console.error(`ServerDesk: The alarm state of a device could not be updated: ${error instanceof Error?error.message:String(error)}`);}
 return Response.json(result,{headers});
}catch(e){return failure(e);}}
