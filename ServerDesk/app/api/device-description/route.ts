import {body,failure,HttpError,requireViewer,sameOrigin} from '@/lib/server/context';
import {setDeviceDescription} from '@/lib/server/devices/device-description-store';
const headers={'Cache-Control':'no-store'};
// The free-text description of a device (lib/server/devices/device-description-store.ts).
export async function POST(request:Request){try{
 sameOrigin(request);const v=await requireViewer(),p=await body(request);
 if(!p||typeof p!=='object'||Array.isArray(p))throw new HttpError('apiError.request.invalid');
 return Response.json(await setDeviceDescription(request,v,p),{headers});
}catch(e){return failure(e);}}
