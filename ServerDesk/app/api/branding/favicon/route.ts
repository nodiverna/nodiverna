import {failure} from '@/lib/server/context';
import {assetResponse,portalAsset} from '@/lib/server/branding';

// The browser tab icon (docs/branding.md): the uploaded portal icon, always
// revalidated, so a new icon shows on the next load; without one a redirect
// to the Nodiverna icon. Public. app/layout.tsx links it.
export async function GET(request:Request){try{
 const icon=await portalAsset('icon',request);
 if(!icon)return new Response(null,{status:307,headers:{Location:'/favicon.svg','Cache-Control':'no-cache'}});
 return assetResponse(request,icon,{visibility:'public',revalidate:true});
}catch(e){return failure(e);}}
