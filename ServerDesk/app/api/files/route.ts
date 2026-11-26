import {body,failure,guid,HttpError,now,requireViewer,sameOrigin} from '@/lib/server/context';
import {principal,requireDevice} from '@/lib/server/identity/access';
import {featureDeviceGuard} from '@/lib/server/identity/feature-authorization';
import {requireMfa} from '@/lib/server/identity/mfa';
import {maintenanceBusy,modern} from '@/lib/server/agent/agent-protocol';
import {fileDefinitions,isFileKind,type FileKind} from '@/lib/server/devices/files';
import {jobRequirements,jobViewRequirements} from '@/lib/jobs/requirements';
import {MAX_QUEUED_JOBS} from '@/lib/server/devices/jobs/queue';
import {issueFields} from '@/lib/server/errors/issues';
import {agentResultFields} from '@/lib/agent-messages';
import {fileJob,queueFileJob} from '@/lib/server/devices/file-jobs';

const headers={'Cache-Control':'no-store'};
export async function GET(request:Request){try{
 const viewer=await requireViewer(),query=new URL(request.url).searchParams,serverId=query.get('serverId'),id=query.get('jobId');
 if(!guid(serverId)||!guid(id))throw new HttpError('apiError.files.invalidDeviceOrJob');
 const row=await fileJob(serverId,id);
 if(!row||!isFileKind(row.action)||row.actor_principal!==principal(viewer))throw new HttpError('apiError.files.jobNotFound');
 let params:Record<string,unknown>={},data:Record<string,unknown>|null=null;try{params=JSON.parse(row.parameters||'{}');data=row.data?JSON.parse(row.data):null;}catch{}
 // The full set from the stored parameters, plus the target and output scope that outlive them.
 for(const right of jobViewRequirements(row.action,params,{target:row.target,outputScope:data?.scope}).permissions)await requireDevice(viewer,serverId,right);
 return Response.json({job:{id:row.id,kind:row.action,state:row.state,result:row.result,...agentResultFields(row),data}},{headers});
}catch(error){return failure(error);}}
export async function POST(request:Request){try{
 sameOrigin(request);const viewer=await requireViewer(),p=await body(request,12000);
 if(!guid(p.serverId)||!isFileKind(p.kind))throw new HttpError('apiError.files.invalidAction');
 const kind=p.kind as FileKind,definition=fileDefinitions[kind],parsed=definition.schema.safeParse(p.params??{});
 if(!parsed.success)throw new HttpError('apiError.files.invalidParameters',{fields:issueFields(parsed.error.issues,3)});
 // The base right loads the device; the path-dependent rights follow the agent check.
 const params=parsed.data as Record<string,unknown>,required=jobRequirements(kind,params),[deviceRight,...rights]=required.permissions,device=await requireDevice(viewer,p.serverId,deviceRight),snapshot=modern(device);
 for(const capability of required.capabilities)modern(device,capability);
 for(const right of rights)await requireDevice(viewer,p.serverId,right);
 if(required.mfa)await requireMfa(request,viewer);
 if(required.managementMode&&(!device.management||snapshot.mode!=='Management'))throw new HttpError('apiError.files.managementRequired');
 if(!definition.readOnly){
  if(p.confirm!==true)throw new HttpError('apiError.files.confirmChange');
  if(typeof params.path==='string'&&/^[a-z]:\\$/i.test(params.path))throw new HttpError('apiError.files.driveRoot');
 }
 if(await maintenanceBusy(p.serverId))throw new HttpError('apiError.agent.maintenance');
 const id=crypto.randomUUID(),at=now(),target=String(params.path??'Lokale Laufwerke');
 const authorization=featureDeviceGuard(viewer,p.serverId,required.permissions);
 const inserted=await queueFileJob({id,serverId:p.serverId,kind,target,parameters:JSON.stringify(params),at,actor:viewer.id,actorEmail:viewer.label.trim().toLowerCase(),actorPrincipal:principal(viewer)},authorization,MAX_QUEUED_JOBS,definition.readOnly?null:{actor:viewer.label,action:definition.label,target:device.name+' / '+target});
 if(!inserted)throw new HttpError('apiError.console.queueChanged');
 return Response.json({id},{headers});
}catch(error){return failure(error);}}
