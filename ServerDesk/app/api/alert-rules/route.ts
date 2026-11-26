import {body,failure,HttpError,requireViewer,sameOrigin} from '@/lib/server/context';
import {alertRuleView,changeAlertRule} from '@/lib/server/devices/alert-rule-overrides';
const headers={'Cache-Control':'no-store'};
// Alert rules per scope (lib/server/devices/alert-rule-overrides.ts): read the rule table, set or reset one override.
export async function GET(request:Request){try{
 const v=await requireViewer();
 return Response.json(await alertRuleView(v,new URL(request.url).searchParams),{headers});
}catch(e){return failure(e);}}
export async function POST(request:Request){try{
 sameOrigin(request);const v=await requireViewer(),p=await body(request);
 if(!p||typeof p!=='object'||Array.isArray(p))throw new HttpError('apiError.request.invalid');
 return Response.json(await changeAlertRule(request,v,p),{headers});
}catch(e){return failure(e);}}
