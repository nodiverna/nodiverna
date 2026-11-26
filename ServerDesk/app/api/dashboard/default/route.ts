import {body,failure,HttpError,requireViewer,sameOrigin} from '@/lib/server/context';
import {dashboardLayoutInput,requireDashboardOwner,saveDefaultDashboardLayout} from '@/lib/server/dashboard-data';

// The default Dashboard layout of the portal (lib/server/dashboard-data.ts,
// docs/dashboard.md): exactly {layout}, a full layout or null for the built-in
// one. Accounts without their own layout see it. Global Owners only, with one
// audit row; no MFA step-up (lib/step-up.ts).
export async function PUT(request:Request){try{
 sameOrigin(request);const viewer=await requireViewer();
 await requireDashboardOwner(viewer);
 const input=await body(request,2048).catch(()=>{throw new HttpError('apiError.request.invalid');});
 return Response.json({dashboard:await saveDefaultDashboardLayout(viewer,dashboardLayoutInput(input))},{headers:{'Cache-Control':'no-store'}});
}catch(e){return failure(e);}}
