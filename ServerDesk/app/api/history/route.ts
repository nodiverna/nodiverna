import {requireViewer,guid,failure,HttpError} from '@/lib/server/context';
import {requireDevice} from '@/lib/server/identity/access';
import {featureDeviceGuard} from '@/lib/server/identity/feature-authorization';
import {deviceSamples} from '@/lib/server/devices/device-history';

export async function GET(request:Request){try{
 const v=await requireViewer(),id=new URL(request.url).searchParams.get('serverId');
 if(!guid(id))throw new HttpError('apiError.request.invalidServer');
 await requireDevice(v,id,'view');
 const authorization=featureDeviceGuard(v,id,['view']);
 return Response.json({samples:await deviceSamples(id,authorization)},{headers:{'Cache-Control':'no-store'}});
}catch(e){return failure(e);}}
