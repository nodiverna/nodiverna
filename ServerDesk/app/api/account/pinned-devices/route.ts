import {body,failure,HttpError,requireViewer,sameOrigin} from '@/lib/server/context';
import {devicePinInput,setDevicePin} from '@/lib/server/pinned-devices';

// The devices the signed-in account pinned (lib/server/pinned-devices.ts).
// GET /api/console carries them as preferences.pinnedDeviceIds; PUT pins or
// unpins one device of the viewer's own list. No audit row and no MFA step-up
// (a personal display setting).
export async function PUT(request:Request){try{
 sameOrigin(request);const viewer=await requireViewer();
 const input=await body(request,1024).catch(()=>{throw new HttpError('apiError.request.invalid');});
 const {deviceId,pinned}=devicePinInput(input);
 return Response.json({pinnedDeviceIds:await setDevicePin(viewer,deviceId,pinned)},{headers:{'Cache-Control':'no-store'}});
}catch(e){return failure(e);}}
