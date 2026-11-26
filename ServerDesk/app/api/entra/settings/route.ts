import {body,failure,HttpError,requireViewer,sameOrigin} from '@/lib/server/context';
import {addEntraMapping,entraSettingsView,removeEntraMapping,saveEntraSettings,setEmergencyAccount,setEntraEnabled,setEntraOnly,testEntraSettings} from '@/lib/server/identity/entra/settings';

// Settings → Microsoft Entra ID (docs/entra-id.md). Owners only. save,
// set-enabled, add-mapping, remove-mapping, set-emergency-account and
// set-entra-only need a fresh step-up proof (entraSettingsStepUpActions in
// lib/step-up.ts); test relies on the login session.
const headers={'Cache-Control':'no-store'};
export async function GET(){try{const viewer=await requireViewer();return Response.json(await entraSettingsView(viewer),{headers});}catch(e){return failure(e);}}
export async function POST(request:Request){
 try{
  sameOrigin(request);const viewer=await requireViewer(),p=await body(request,64*1024);
  if(p.action==='save')return Response.json(await saveEntraSettings(request,viewer,p),{headers});
  if(p.action==='test')return Response.json(await testEntraSettings(request,viewer),{headers});
  if(p.action==='set-enabled')return Response.json(await setEntraEnabled(request,viewer,p),{headers});
  if(p.action==='add-mapping')return Response.json(await addEntraMapping(request,viewer,p),{headers});
  if(p.action==='remove-mapping')return Response.json(await removeEntraMapping(request,viewer,p),{headers});
  if(p.action==='set-emergency-account')return Response.json(await setEmergencyAccount(request,viewer,p),{headers});
  if(p.action==='set-entra-only')return Response.json(await setEntraOnly(request,viewer,p),{headers});
  throw new HttpError('apiError.request.unknownAction');
 }catch(e){return failure(e);}
}
