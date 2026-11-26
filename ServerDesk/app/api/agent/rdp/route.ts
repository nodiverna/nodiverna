import {z} from 'zod';
import {body,failure,HttpError} from '@/lib/server/context';
import {agentFromBearer,assertAgentActive,snapshot} from '@/lib/server/agent/agent-protocol';
import {agentRdpExchange,rdpReport} from '@/lib/server/devices/rdp';
const schema=z.object({serverId:z.guid(),sessions:z.array(rdpReport).max(4).refine(items=>new Set(items.map(item=>item.id)).size===items.length)}).strict();
export async function POST(request:Request){try{
 const d=await agentFromBearer(request,{allowTokenRetry:true});
 const parsed=schema.safeParse(await body(request,1_500_000));if(!parsed.success)throw new HttpError('apiError.agent.invalidRdpChannel');const p=parsed.data;if(p.serverId!==d.id)throw new HttpError('apiError.agent.notApproved');const s=snapshot(d);
 if(s?.protocolVersion!==3||!s.agentCapabilities?.some(capability=>capability==='rdp-browser'||capability==='rdp-webrtc'))throw new HttpError('apiError.agent.rdpRequired');
 const result=await agentRdpExchange(d,p.sessions);await assertAgentActive(d);return Response.json(result,{headers:{'Cache-Control':'no-store'}});
}catch(e){return failure(e);}}
