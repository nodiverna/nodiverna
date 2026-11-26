import {body,failure,guid,HttpError,requireViewer,sameOrigin} from '@/lib/server/context';
import {agentResultFields} from '@/lib/agent-messages';
import {requireDevice,type Permission} from '@/lib/server/identity/access';
import {jobViewRequirements} from '@/lib/jobs/requirements';
import {isDiagnosticKind} from '@/lib/diagnostics';
import {deviceJobs} from '@/lib/server/devices/job-records';
import {queueDiagnosticJob} from '@/lib/server/devices/device-job-queue';

const headers={'Cache-Control':'no-store'};
export async function GET(request:Request){try{
 const v=await requireViewer(),url=new URL(request.url),serverId=url.searchParams.get('serverId'),jobId=url.searchParams.get('jobId');
 if(!guid(serverId)||jobId&&!guid(jobId))throw new HttpError('apiError.diagnostics.invalidServerOrJob');
 // Each right is checked once per request, however many listed jobs need it.
 const checked=new Map<Permission,Promise<unknown>>(),need=(right:Permission)=>{let check=checked.get(right);if(!check){check=requireDevice(v,serverId,right);checked.set(right,check);}return check;};
 await need('diagnose'); // Access to the device's diagnostics at all.
 const rows=await deviceJobs(serverId,jobId);
 const jobs=[];
 for(const row of rows){
  if(!isDiagnosticKind(row.kind))continue;
  // Outputs retain their original scope even after the parameters are wiped on completion.
  let params:Record<string,unknown>={};try{params=JSON.parse(row.parameters||'{}');}catch{}
  let output:Record<string,unknown>|null=null;try{output=row.data?JSON.parse(row.data):null;}catch{}
  const scope=output?.scope as {security?:boolean}|undefined;
  try{
   for(const right of jobViewRequirements(row.kind,params,{outputScope:{security:scope?.security}}).permissions)await need(right);
  }catch(e){if(jobId||!(e instanceof HttpError)||e.status!==403)throw e;continue;}
  const {id,kind,state,createdAt,claimedAt,result}=row;jobs.push({id,kind,state,createdAt,claimedAt,result,...agentResultFields(row),data:output});
 }
 return Response.json({jobs},{headers});
}catch(e){return failure(e);}}

export async function POST(request:Request){try{
 sameOrigin(request);const v=await requireViewer(),p=await body(request,64000);
 // One live diagnosis (lib/server/devices/device-job-queue.ts); the assistant runs its diagnoses through the same checks.
 return Response.json(await queueDiagnosticJob(request,v,{serverId:p.serverId,kind:p.kind,params:p.params,confirm:p.confirm}),{headers});
}catch(e){return failure(e);}}
