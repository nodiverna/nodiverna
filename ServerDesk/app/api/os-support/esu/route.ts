import {body,failure,HttpError,requireViewer,sameOrigin} from '@/lib/server/context';
import {changeEsu,esuView} from '@/lib/server/devices/os-esu';
const headers={'Cache-Control':'no-store'};
// ESU dates per group or device (lib/server/devices/os-esu.ts): read the value with its origin, set or clear it.
export async function GET(request:Request){try{
 const v=await requireViewer();
 return Response.json(await esuView(v,new URL(request.url).searchParams),{headers});
}catch(e){return failure(e);}}
export async function POST(request:Request){try{
 sameOrigin(request);const v=await requireViewer(),p=await body(request);
 if(!p||typeof p!=='object'||Array.isArray(p))throw new HttpError('apiError.request.invalid');
 return Response.json(await changeEsu(request,v,p),{headers});
}catch(e){return failure(e);}}
