import {body,failure,HttpError,guid,now} from '@/lib/server/context';
import {ingestAutostart} from '@/lib/server/devices/autostart';
import {syncDeviceAlerts} from '@/lib/server/devices/alerts';
import {agentFromBearer} from '@/lib/server/agent/agent-protocol';
// The agent's autostart list (lib/server/devices/autostart.ts), sent only when its checksum changed.
// Authenticate from the headers before reading up to 1 MiB of body.
export async function POST(request:Request){try{
 const d=await agentFromBearer(request,{allowTokenRetry:true});
 const p=await body(request,1048576);
 const {serverId,...report}=p;if(!guid(serverId))throw new HttpError('apiError.agent.invalid');
 if(serverId!==d.id)throw new HttpError('apiError.agent.notApproved');
 const time=now(),result=await ingestAutostart(d.id,report,time);
 // New entries open their alarm at once; the periodic alarm check catches up on a failure.
 if(result.added||result.removed){try{await syncDeviceAlerts(d.id,time);}catch(error){console.error(`ServerDesk: The alarm state of device ${d.id} could not be updated: ${error instanceof Error?error.message:String(error)}`);}}
 return Response.json(result,{headers:{'Cache-Control':'no-store'}});
}catch(e){return failure(e);}}
