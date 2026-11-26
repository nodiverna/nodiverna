import {body,failure,HttpError,requireViewer,sameOrigin} from '@/lib/server/context';
import {requireMfa} from '@/lib/server/identity/mfa';
import {createAutomationTemplate,assignAutomationScope,removeAutomationScope,listAutomationScopes} from '@/lib/server/automation/automation-scopes';
import {startAutomationRun} from '@/lib/server/automation/automation-runbooks';
import {ZodError} from 'zod';
const headers={'Cache-Control':'no-store'};
export async function GET(){try{return Response.json(await listAutomationScopes(await requireViewer()),{headers});}catch(error){return failure(error);}}
export async function POST(request:Request){try{
 sameOrigin(request);const viewer=await requireViewer(),input=await body(request);await requireMfa(request,viewer);
 let result;switch(input.action){case 'create-template':result=await createAutomationTemplate(viewer,input);break;case 'assign':result=await assignAutomationScope(viewer,input);break;case 'remove-assignment':result=await removeAutomationScope(viewer,input);break;case 'run':case 'run-scope':result=await startAutomationRun(viewer,input);break;default:throw new HttpError('apiError.automation.unknownAction');}
 return Response.json(result,{headers});
}catch(error){return failure(error instanceof ZodError?new HttpError('apiError.automation.checkInput'):error);}}
