import {body,failure,HttpError,requireViewer,sameOrigin} from '@/lib/server/context';
import {setDeviceName} from '@/lib/server/devices/device-name-store';
const headers={'Cache-Control':'no-store'};
// The manual rename of a device (lib/server/devices/device-name-store.ts).
export async function POST(request:Request){try{
 sameOrigin(request);const v=await requireViewer(),p=await body(request);
 if(!p||typeof p!=='object'||Array.isArray(p))throw new HttpError('apiError.request.invalid');
 return Response.json(await setDeviceName(request,v,p),{headers});
}catch(e){return failure(e);}}
