import {body,failure,HttpError,requireViewer,sameOrigin} from '@/lib/server/context';
import {dashboardLayoutInput,saveOwnDashboardLayout} from '@/lib/server/dashboard-data';

// The Dashboard layout of the signed-in account (lib/server/dashboard-data.ts,
// docs/dashboard.md): exactly {layout}, a full layout or null to follow the
// default layout again. GET /api/console carries it as preferences.dashboard;
// PUT changes only the viewer's own row. No audit row and no MFA step-up (a
// personal display setting).
export async function PUT(request:Request){try{
 sameOrigin(request);const viewer=await requireViewer();
 const input=await body(request,2048).catch(()=>{throw new HttpError('apiError.request.invalid');});
 return Response.json({dashboard:await saveOwnDashboardLayout(viewer,dashboardLayoutInput(input))},{headers:{'Cache-Control':'no-store'}});
}catch(e){return failure(e);}}
