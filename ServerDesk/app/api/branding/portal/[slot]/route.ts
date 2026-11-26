import {failure,HttpError,requireViewer,sameOrigin} from '@/lib/server/context';
import {assetResponse,portalAsset,prepareBrandingWrite,readBrandingBody,removeBrandingAsset,setBrandingAsset} from '@/lib/server/branding';

// One portal image (docs/branding.md): light, dark or icon. GET is public (the
// sign-in page and the emails show the logo); PUT takes the raw file as the
// body, DELETE removes it. Both writes are for global Owners and answer with
// the state of the Branding page.
type Context={params:Promise<{slot:string}>};
const portal={customerId:null};
const headers={'Cache-Control':'no-store'};
export async function GET(request:Request,context:Context){try{
 const asset=await portalAsset((await context.params).slot,request);
 if(!asset)throw new HttpError('apiError.generic.notFound');
 return assetResponse(request,asset,{visibility:'public'});
}catch(e){return failure(e);}}
export async function PUT(request:Request,context:Context){try{
 sameOrigin(request);const viewer=await requireViewer();
 const slot=await prepareBrandingWrite(viewer,portal,(await context.params).slot);
 return Response.json(await setBrandingAsset(viewer,portal,slot,await readBrandingBody(request,slot)),{headers});
}catch(e){return failure(e);}}
export async function DELETE(request:Request,context:Context){try{
 sameOrigin(request);const viewer=await requireViewer();
 const slot=await prepareBrandingWrite(viewer,portal,(await context.params).slot);
 return Response.json(await removeBrandingAsset(viewer,portal,slot),{headers});
}catch(e){return failure(e);}}
