import {body,failure,HttpError,requireViewer,sameOrigin} from '@/lib/server/context';
import {changeTags,tagView} from '@/lib/server/devices/tag-store';
const headers={'Cache-Control':'no-store'};
// Tags of devices and device groups (lib/server/devices/tag-store.ts): read the tags of one
// object; set or remove one tag; set or remove one tag on many devices.
export async function GET(request:Request){try{
 const v=await requireViewer();
 return Response.json(await tagView(v,new URL(request.url).searchParams),{headers});
}catch(e){return failure(e);}}
export async function POST(request:Request){try{
 sameOrigin(request);const v=await requireViewer(),p=await body(request);
 if(!p||typeof p!=='object'||Array.isArray(p))throw new HttpError('apiError.request.invalid');
 return Response.json(await changeTags(request,v,p),{headers});
}catch(e){return failure(e);}}
