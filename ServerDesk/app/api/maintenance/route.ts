import {body,failure,HttpError,requireViewer,sameOrigin} from '@/lib/server/context';
import {maintenanceView,requireMaintenanceOwner,runMaintenanceNow,setMaintenanceSettings} from '@/lib/server/maintenance';

// The page Settings → Maintenance (docs/self-hosting.md, "Maintenance"). Owners
// only. set needs a fresh step-up proof only when it shortens the audit or the
// job retention (maintenanceSetNeedsStepUp in lib/step-up.ts); run answers 202
// and the run continues in this process.
const headers={'Cache-Control':'no-store'};
export async function GET(){try{const viewer=await requireViewer();return Response.json(await maintenanceView(viewer),{headers});}catch(e){return failure(e);}}
export async function POST(request:Request){
 try{
  sameOrigin(request);const viewer=await requireViewer(),p=await body(request,4096);
  if(p.action==='set')return Response.json(await setMaintenanceSettings(request,viewer,p),{headers});
  if(p.action==='run')return Response.json(await runMaintenanceNow(viewer),{status:202,headers});
  await requireMaintenanceOwner(viewer);
  throw new HttpError('apiError.validationFailed');
 }catch(e){return failure(e);}
}
