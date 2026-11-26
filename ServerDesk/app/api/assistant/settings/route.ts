import {body,failure,HttpError,requireViewer,sameOrigin} from '@/lib/server/context';
import {assistantSettingsView,changeCustomerKey,changeOrganizationKey,changePersonalKey,testAssistantKey} from '@/lib/server/devices/assistant-settings';

// The provider keys of the device assistant (docs/ai-assistant.md). The
// organization key and the customer keys belong to Owners; saving one needs a fresh step-up
// proof (lib/step-up.ts, rule 6), removing one relies on the login session; the
// personal key belongs to the signed-in user. No answer carries a key, only its last 4 characters.
const headers={'Cache-Control':'no-store'};
export async function GET(){try{const viewer=await requireViewer();return Response.json(await assistantSettingsView(viewer),{headers});}catch(e){return failure(e);}}
export async function POST(request:Request){
 try{
  sameOrigin(request);const viewer=await requireViewer(),p=await body(request,8192);
  switch(p.action){
   case 'set-organization-key':return Response.json({key:await changeOrganizationKey(request,viewer,'set',p)},{headers});
   case 'remove-organization-key':return Response.json({key:await changeOrganizationKey(request,viewer,'remove',p)},{headers});
   case 'test-organization-key':return Response.json(await testAssistantKey(viewer,'organization',p),{headers});
   case 'set-customer-key':return Response.json({key:await changeCustomerKey(request,viewer,'set',p)},{headers});
   case 'remove-customer-key':return Response.json({key:await changeCustomerKey(request,viewer,'remove',p)},{headers});
   case 'test-customer-key':return Response.json(await testAssistantKey(viewer,'customer',p),{headers});
   case 'set-personal-key':return Response.json({key:await changePersonalKey(viewer,'set',p)},{headers});
   case 'remove-personal-key':return Response.json({key:await changePersonalKey(viewer,'remove',p)},{headers});
   case 'test-personal-key':return Response.json(await testAssistantKey(viewer,'personal',p),{headers});
   default:throw new HttpError('apiError.request.unknownAction');
  }
 }catch(e){return failure(e);}
}
