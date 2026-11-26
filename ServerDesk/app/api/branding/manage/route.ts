import {body,failure,HttpError,requireViewer,sameOrigin} from '@/lib/server/context';
import {brandingManage,brandingManageAction,requireBrandingOwner,runBrandingManageAction} from '@/lib/server/branding';

// The Branding page (docs/branding.md). GET: the portal images, the setting
// Multiple customers, every customer other than the default customer with its
// logos, the background of each area and the brand color scheme. POST: one of
// setBackground, setScheme, clearScheme or measureBackground (the measured
// console background upload, no audit row) as JSON; answers the same state.
// Global Owners only; no MFA step-up (lib/step-up.ts).
const headers={'Cache-Control':'no-store'};
export async function GET(){try{const viewer=await requireViewer();return Response.json(await brandingManage(viewer),{headers});}catch(e){return failure(e);}}
export async function POST(request:Request){try{
 sameOrigin(request);const viewer=await requireViewer();
 await requireBrandingOwner(viewer);
 const input=await body(request,4096).catch(()=>{throw new HttpError('apiError.request.invalid');});
 return Response.json(await runBrandingManageAction(viewer,brandingManageAction(input)),{headers});
}catch(e){return failure(e);}}
