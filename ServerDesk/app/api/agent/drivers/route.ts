import {body,failure,HttpError,guid,now} from '@/lib/server/context';
import {ingestDrivers} from '@/lib/server/devices/drivers';
import {agentFromBearer} from '@/lib/server/agent/agent-protocol';
// The agent's driver list (lib/server/devices/drivers.ts), sent only when its checksum changed.
// Authenticate from the headers before reading up to 1 MiB of body.
export async function POST(request:Request){try{
 const d=await agentFromBearer(request,{allowTokenRetry:true});
 const p=await body(request,1048576);
 const {serverId,...report}=p;if(!guid(serverId))throw new HttpError('apiError.agent.invalid');
 if(serverId!==d.id)throw new HttpError('apiError.agent.notApproved');
 return Response.json(await ingestDrivers(d.id,report,now()),{headers:{'Cache-Control':'no-store'}});
}catch(e){return failure(e);}}
