import {body,failure,HttpError,requireViewer,sameOrigin} from '@/lib/server/context';
import {preferencesInput,saveAccountPreferences} from '@/lib/server/account-preferences';

// The personal display preferences of the signed-in account
// (lib/server/account-preferences.ts): {consoleBackground}. GET /api/console
// carries them as `preferences`; PUT changes only the viewer's own row. No
// audit row and no MFA step-up (a personal display preference).
export async function PUT(request:Request){try{
 sameOrigin(request);const viewer=await requireViewer();
 const input=await body(request,1024).catch(()=>{throw new HttpError('apiError.request.invalid');});
 return Response.json(await saveAccountPreferences(viewer,preferencesInput(input)),{headers:{'Cache-Control':'no-store'}});
}catch(e){return failure(e);}}
