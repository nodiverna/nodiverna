import {body,failure,HttpError,requireViewer,sameOrigin} from '@/lib/server/context';
import {requireMfa} from '@/lib/server/identity/mfa';
import {createRunbookVersion,previewRun,startRun,createSchedule,cancelRun,cancelSchedule,deleteRunbook,listRunbooks} from '@/lib/server/automation/runbooks';
const headers={'Cache-Control':'no-store'};
export async function GET(request:Request){try{return Response.json(await listRunbooks(await requireViewer(),new URL(request.url).searchParams.get('serverId')??undefined,new URL(request.url).searchParams.get('runId')??undefined),{headers});}catch(e){return failure(e);}}
export async function POST(request:Request){try{sameOrigin(request);const v=await requireViewer(),p=await body(request);if(!p||typeof p!=='object'||Array.isArray(p))throw new HttpError('apiError.request.invalid');let result;
 switch(p.action){case 'create-version':await requireMfa(request,v);result=await createRunbookVersion(v,p);break;case 'dryrun':result=await previewRun(v,p);break;case 'run':await requireMfa(request,v);result=await startRun(v,p);break;case 'schedule':await requireMfa(request,v);result=await createSchedule(v,p);break;case 'delete':await requireMfa(request,v);result=await deleteRunbook(v,p);break;case 'cancel':result=await cancelRun(v,p.runId);break;case 'cancel-schedule':result=await cancelSchedule(v,p.scheduleId);break;default:throw new HttpError('apiError.runbook.unknownAction');}
 return Response.json(result,{headers});}catch(e){return failure(e);}}
