import {body,failure,HttpError,guid} from '@/lib/server/context';
import {ingestDrift} from '@/lib/server/automation/drift';
import {agentFromBearer} from '@/lib/server/agent/agent-protocol';
export async function POST(request:Request){try{
 const d=await agentFromBearer(request,{allowTokenRetry:true});
 const p=await body(request,2097152);if(!p||typeof p!=='object'||!guid(p.serverId))throw new HttpError('apiError.agent.invalid');
 const {serverId,...report}=p;if(serverId!==d.id)throw new HttpError('apiError.agent.notApproved');
 return Response.json(await ingestDrift(d.id,report),{headers:{'Cache-Control':'no-store'}});
}catch(e){return failure(e);}}
