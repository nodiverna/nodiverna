import {body,failure,HttpError,requireViewer,sameOrigin} from '@/lib/server/context';
import {askAssistant,assistantStatus} from '@/lib/server/devices/assistant';
import {assistantJob,runAssistantCommand} from '@/lib/server/devices/assistant-commands';

// The device assistant (docs/ai-assistant.md): GET tells the device panel
// whether the viewer has a key for questions, or with jobId the state of one
// command the viewer ran; POST ask answers one question or follow-up from the
// data the portal stores for the device, read with the viewer's rights, and
// POST run queues one command after the user's click, with the checks of the
// same action in the console.
const headers={'Cache-Control':'no-store'};
export async function GET(request:Request){try{
 const viewer=await requireViewer(),params=new URL(request.url).searchParams,jobId=params.get('jobId');
 if(jobId!==null)return Response.json(await assistantJob(viewer,params.get('serverId'),jobId),{headers});
 return Response.json(await assistantStatus(viewer,params.get('serverId')),{headers});
}catch(e){return failure(e);}}
export async function POST(request:Request){
 try{
  sameOrigin(request);const viewer=await requireViewer(),p=await body(request,640*1024);
  if(p.action==='ask')return Response.json(await askAssistant(viewer,p),{headers});
  if(p.action==='run')return Response.json(await runAssistantCommand(request,viewer,p),{headers});
  throw new HttpError('apiError.request.unknownAction');
 }catch(e){return failure(e);}
}
