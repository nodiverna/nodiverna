import {failure,HttpError,body} from '@/lib/server/context';
import {agent,assertAgentActive,MAX_TRANSFER,securityFile,type AgentDevice} from '@/lib/server/agent/agent-protocol';
import {getTransfer,chunkNumber,getAuthorizedChunk,putChunk,verifyTransfer,assertTransferAuthorized,startDownload,completeTransfer} from '@/lib/server/devices/transfers';
import {resolvePrincipal,requireDevice} from '@/lib/server/identity/access';
import {requireFileAccess} from '@/lib/server/devices/file-access';
async function authorized(request:Request,serverId:string,id:string,admitted?:AgentDevice){const d=admitted?await assertAgentActive(admitted):await agent(request,serverId,{allowTokenRetry:true}),t=await getTransfer(id);if(t.server_id!==d.id)throw new HttpError('apiError.transfer.notFound');const v=await resolvePrincipal(t.principal);if(!v)throw new HttpError('apiError.transfer.userApprovalRevoked');await requireFileAccess(v,t.server_id,t.path,t.direction==='upload'?'files.write':'files.read');if(securityFile(t.path))await requireDevice(v,t.server_id,'security.events');if(t.direction==='upload'&&!d.management)throw new HttpError('apiError.transfer.agentReadOnly');return {device:d,transfer:t};}
export async function GET(request:Request){try{const q=new URL(request.url).searchParams,{transfer:t}=await authorized(request,q.get('serverId')??'',q.get('id')??'');if(t.direction!=='upload'||!['ready','active'].includes(t.state))throw new HttpError('apiError.transfer.notApprovedYet');const r=await getAuthorizedChunk(t,chunkNumber(q));if(!r)throw new HttpError('apiError.transfer.blockMissing');return new Response(r.body,{headers:{'Content-Type':'application/octet-stream','Cache-Control':'no-store'}});}catch(e){return failure(e);}}
export async function PUT(request:Request){try{const q=new URL(request.url).searchParams,{transfer:t}=await authorized(request,q.get('serverId')??'',q.get('id')??'');if(t.direction!=='download'||!['pending','active'].includes(t.state))throw new HttpError('apiError.transfer.notOpen');await putChunk(request,t,chunkNumber(q));return Response.json({ok:true});}catch(e){return failure(e);}}
export async function POST(request:Request){try{
 const p=await body(request),{transfer:t,device:d}=await authorized(request,p.serverId,p.id);
 if(p.action==='authorize'){if(!['pending','ready','active'].includes(t.state))throw new HttpError('apiError.transfer.noLongerApproved');await assertTransferAuthorized(t);return Response.json({ok:true,state:t.state});}
 if(p.action==='prepare'){
  if(t.direction!=='download'||!['pending','active'].includes(t.state)||!Number.isSafeInteger(p.size)||p.size<0||p.size>MAX_TRANSFER||! /^[a-f0-9]{64}$/.test(p.sha256))throw new HttpError('apiError.transfer.invalidMetadata');
  if(t.size!==null&&(t.size!==p.size||t.sha256!==p.sha256))throw new HttpError('apiError.transfer.sourceChanged');
  const changed=await startDownload(t,p.size,p.sha256);
  if(!changed)throw new HttpError('apiError.transfer.endedOrChanged');
  return Response.json({ok:true});
 }
 if(p.action==='complete'){
  if(!['ready','active'].includes(t.state))throw new HttpError('apiError.transfer.notReady');
  if(t.direction==='download')await verifyTransfer(t);
  if(p.sha256!==t.sha256||p.size!==t.size)throw new HttpError('apiError.transfer.targetCheckMismatch');
  await authorized(request,p.serverId,p.id,d);
  const changed=await completeTransfer(t,p.size,p.sha256);
  if(!changed)throw new HttpError('apiError.transfer.endedOrChanged');
  return Response.json({ok:true});
 }
 throw new HttpError('apiError.transfer.invalidAgentAction');
}catch(e){return failure(e);}}
