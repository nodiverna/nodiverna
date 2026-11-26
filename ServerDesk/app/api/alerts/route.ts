import {body,failure,HttpError,requireViewer,sameOrigin} from '@/lib/server/context';
import {alertHistory,changeAlert} from '@/lib/server/devices/alerts';
const headers={'Cache-Control':'no-store'};
// Alarms (lib/server/devices/alerts.ts): the alarm history of one device; acknowledge, mute and unmute one alarm.
export async function GET(request:Request){try{
 const v=await requireViewer();
 return Response.json(await alertHistory(v,new URL(request.url).searchParams),{headers});
}catch(e){return failure(e);}}
export async function POST(request:Request){try{
 sameOrigin(request);const v=await requireViewer(),p=await body(request);
 if(!p||typeof p!=='object'||Array.isArray(p))throw new HttpError('apiError.alarms.invalid');
 return Response.json(await changeAlert(request,v,p),{headers});
}catch(e){return failure(e);}}
