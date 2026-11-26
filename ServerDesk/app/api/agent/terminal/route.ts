import {z} from 'zod';
import {body,failure,HttpError,now,config} from '@/lib/server/context';
import {dispatchSigner,signingKeyFailure,TERMINAL_LEASE_SECONDS} from '@/lib/server/agent/agent-dispatch';
import {agentFromBearer,assertAgentActive,snapshot} from '@/lib/server/agent/agent-protocol';
import {terminalReport,exchangeTerminals} from '@/lib/server/devices/terminal-channel';
import {sweepTerminalSessions} from '@/lib/server/devices/terminal-lifecycle';
import {takeChannelSlot} from '@/lib/server/agent/agent-admission';

const schema=z.object({serverId:z.guid(),terminals:z.array(terminalReport).max(8).refine(reports=>new Set(reports.map(report=>report.id)).size===reports.length)}).strict();
// Keep rapid terminal traffic apart from the general channel's admission clock.
// agent_channels has no foreign key; the namespace is internal and cannot be
// chosen by a browser or unauthenticated agent.
export async function POST(request:Request){try{
 const d=await agentFromBearer(request,{allowTokenRetry:true});
 const parsed=schema.safeParse(await body(request,1572864));if(!parsed.success)throw new HttpError('apiError.agent.invalidTerminalChannel');
 const p=parsed.data;if(p.serverId!==d.id)throw new HttpError('apiError.agent.notApproved');
 const s=snapshot(d),time=now();
 if(s?.protocolVersion!==3||!s.agentCapabilities?.includes('terminal-live'))throw new HttpError('apiError.agent.terminalRequired');
 let signer;try{signer=dispatchSigner(config('AGENT_JOB_SIGNING_KEY'));}catch(error){throw signingKeyFailure(error);}
 if(s.agentCapabilities?.includes('signed-dispatch')&&!signer)throw new HttpError('apiError.signing.keyMissing');
 const rate=await takeChannelSlot('terminal:'+d.id,d.id,time,time-60);
 if(!rate){await assertAgentActive(d);throw new HttpError('apiError.agent.terminalChannelTooFrequent');}
 await sweepTerminalSessions(d.id,time);
 const terminals=await exchangeTerminals(d,s,p.terminals,time),active=terminals.some(command=>['opening','open'].includes(command.state)),input=terminals.some(command=>command.input.length>0),output=p.terminals.some(report=>report.output.length>0);
 // An admitted request may outlive offboarding; no buffered terminal input
 // may be dispatched after the device's credentials have been revoked.
 await assertAgentActive(d);
 // A short signed lease names the shells the broker may keep open. Each poll
 // renews it; without polls the broker closes them when the lease expires.
 const terminalLease=signer?.sign(d.id,'terminal',{sessions:terminals.filter(command=>['opening','open'].includes(command.state)).map(command=>command.id)},TERMINAL_LEASE_SECONDS,now());
 return Response.json({ok:true,terminals,...(terminalLease?{terminalLease}:{}),intervalMs:active?(input||output?100:180):1000},{headers:{'Cache-Control':'no-store'}});
}catch(error){return failure(error);}}
