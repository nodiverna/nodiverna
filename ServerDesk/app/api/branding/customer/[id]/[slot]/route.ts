import {failure,requireViewer,sameOrigin} from '@/lib/server/context';
import {assetResponse,customerAsset,prepareBrandingWrite,readBrandingBody,removeBrandingAsset,setBrandingAsset} from '@/lib/server/branding';

// One customer logo (docs/branding.md): light or dark. GET needs a live viewer
// who sees the customer, or a global Owner; anyone else gets 404. PUT takes the
// raw file as the body, DELETE removes it; both are for global Owners, never
// for the default customer, and answer with the state of the Branding page.
type Context={params:Promise<{id:string;slot:string}>};
const headers={'Cache-Control':'no-store'};
export async function GET(request:Request,context:Context){try{
 const viewer=await requireViewer(),{id,slot}=await context.params;
 return assetResponse(request,await customerAsset(viewer,id,slot,request),{visibility:'private'});
}catch(e){return failure(e);}}
export async function PUT(request:Request,context:Context){try{
 sameOrigin(request);const viewer=await requireViewer(),{id,slot}=await context.params,owner={customerId:id};
 const checked=await prepareBrandingWrite(viewer,owner,slot);
 return Response.json(await setBrandingAsset(viewer,owner,checked,await readBrandingBody(request,checked)),{headers});
}catch(e){return failure(e);}}
export async function DELETE(request:Request,context:Context){try{
 sameOrigin(request);const viewer=await requireViewer(),{id,slot}=await context.params,owner={customerId:id};
 const checked=await prepareBrandingWrite(viewer,owner,slot);
 return Response.json(await removeBrandingAsset(viewer,owner,checked),{headers});
}catch(e){return failure(e);}}
