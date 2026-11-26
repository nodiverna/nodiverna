// Queueing of one job on one device, as the console starts it: the console
// action job (app/api/console/route.ts), POST /api/diagnostics and the run of
// an assistant command (lib/server/devices/assistant-commands.ts) call these functions, so a
// command from the assistant gets exactly the checks, error keys and audit
// rows of the same action in the console. The checks keep the order the two
// routes had: rights, connection, protocol, MFA, maintenance, mode,
// capabilities, confirmation, parameters, kind rules, queue limit and the
// guarded write.
import type {z} from 'zod';
import {guid,HttpError,now} from '../context';
import {sql} from '../db';
import {principal,requireDevice} from '../identity/access';
import {featureDeviceGuard} from '../identity/feature-authorization';
import {requireMfa} from '../identity/mfa';
import {maintenanceBusy} from '../agent/agent-protocol';
import {operations,safeTarget} from '../../management';
import {sealAgentSecrets} from '../agent/agent-crypto';
import {jobRequirements,securityEventsPermission} from '../../jobs/requirements';
import {MAX_QUEUED_JOBS,queueFullError} from './jobs/queue';
import {issueFields} from '../errors/issues';
import {gpuDriverJobActive,noActiveGpuDriverJob,resolveGpuDriverJob} from './gpu-drivers/device';
import {defenderStateBlock,isDefenderJobKind,type DefenderStateBlock} from '../../defender';
import {diagnosticDefinitions,diagnosticTarget,isDiagnosticKind,type DiagnosticKind} from '../../diagnostics';
import {queueAuditedJob,queueAuditedJobWithProof,waitingJobCount,type JobAudit} from './job-records';
import type {ApiErrorKey} from '../../errors/api-error-keys';
import type {ServerSnapshot,Viewer} from '../../types';

// The Defender state of the last report refuses an action Defender cannot run (lib/defender.ts).
const defenderStateErrors:Record<DefenderStateBlock,ApiErrorKey>={unavailable:'apiError.defender.unavailable','scan-running':'apiError.defender.scanRunning','no-detections':'apiError.defender.noActiveDetections'};
// Kinds that would change the identity of a domain controller.
const notOnDomainController=['join-domain','leave-domain','rename-computer','create-local-user','set-local-user','reset-local-password','delete-local-user','local-group-add','local-group-remove'];

/** The input of one queue call: the device, the kind, its raw parameters and the confirmation flag. */
export type DeviceJobInput={serverId:unknown;kind:unknown;params:unknown;confirm:unknown};
/**
 * more: device audit rows that commit with the job, built from the new job ID
 * (for example assistant.run). stepUp: the job is unrestricted execution and
 * needs a fresh step-up proof (lib/step-up.ts), read after every other check
 * and consumed with the job.
 */
export type QueueOptions={more?:(jobId:string)=>JobAudit[];stepUp?:{managementToken:unknown}};
/** The definition of an operation job: the audit action, whether it only reads, and its parameter schema. */
export type OperationDefinition={label:string;readOnly:boolean;schema:z.ZodTypeAny};

/**
 * The console action job for a kind of lib/management.ts (POST /api/console
 * {action:'job'}). Answers the new job ID.
 */
export async function queueDeviceOperation(request:Request,v:Viewer,input:DeviceJobInput,options:QueueOptions={}):Promise<{id:string}>{
 if(!guid(input.serverId)||typeof input.kind!=='string'||!Object.hasOwn(operations,input.kind))throw new HttpError('apiError.request.invalidAction');
 if(input.kind.startsWith('desired-state-'))throw new HttpError('apiError.job.desiredStateViaVersion');
 return queueOperationJob(request,v,{serverId:input.serverId,kind:input.kind,definition:operations[input.kind],params:input.params,confirm:input.confirm},options);
}

/**
 * The checks and the write of an operation job. queueDeviceOperation calls it
 * for the kinds of lib/management.ts; the assistant calls it for its
 * PowerShell job with its own definition and target.
 */
export async function queueOperationJob(request:Request,v:Viewer,input:{serverId:string;kind:string;definition:OperationDefinition;params:unknown;confirm:unknown;target?:(params:Record<string,unknown>)=>string},options:QueueOptions={}):Promise<{id:string}>{
 const {serverId,kind:jobKind,definition}=input;
 // The base right loads the device; rights that depend on parameters follow after parsing.
 const kind=jobRequirements(jobKind,{}),[deviceRight,...baseRights]=kind.permissions;
 const s=await requireDevice(v,serverId,deviceRight);for(const right of baseRights)await requireDevice(v,serverId,right);
 if(!s||!s.last_seen||now()-s.last_seen>120000)throw new HttpError('apiError.agent.notConnected');
 const snapshot:ServerSnapshot|null=s.snapshot?JSON.parse(s.snapshot):null;
 if(snapshot?.protocolVersion!==3)throw new HttpError('apiError.agent.v3Required');
 if(kind.mfa)await requireMfa(request,v);
 if(await maintenanceBusy(serverId))throw new HttpError('apiError.agent.maintenanceRetry');
 if(kind.managementMode&&!s.management)throw new HttpError('apiError.agent.readOnlyEnableManagement');
 if(!kind.capabilities.every(capability=>snapshot.agentCapabilities?.includes(capability))||kind.managementMode&&snapshot.mode!=='Management')throw new HttpError('apiError.agent.functionUnavailable');
 if(!definition.readOnly&&input.confirm!==true)throw new HttpError('apiError.console.confirmServerChange');
 const raw=input.params??{};const parsed=definition.schema.safeParse(raw);
 if(!parsed.success)throw new HttpError('apiError.console.invalidParameters',{fields:issueFields(parsed.error.issues,5)});
 const params=parsed.data as Record<string,unknown>,required=jobRequirements(jobKind,params);
 // A GPU driver job gets its download (url, sizeBytes) only from the server's own vendor lookup,
 // and only while no other driver job waits or runs and the version is not installed already.
 const gpuDriver=jobKind==='install-gpu-driver';
 if(gpuDriver)Object.assign(params,await resolveGpuDriverJob(serverId,snapshot,parsed.data as {vendor:'nvidia'|'amd';version:string}));
 // Only install-updates with all:true adds a capability (install-all-updates) to the kind's own.
 if(!required.capabilities.every(capability=>snapshot.agentCapabilities?.includes(capability)))throw new HttpError('apiError.console.updatesNeedNewAgent');
 // Defender actions: the state of the last report, with the same function as the UI.
 if(isDefenderJobKind(jobKind)){const block=defenderStateBlock(snapshot,jobKind);if(block)throw new HttpError(defenderStateErrors[block]);}
 for(const right of required.permissions)if(!kind.permissions.includes(right))await requireDevice(v,serverId,right);
 if(snapshot?.security?.domainRole!==undefined&&snapshot.security.domainRole>=4&&notOnDomainController.includes(jobKind))throw new HttpError('apiError.console.notOnDomainController');
 const secret:Record<string,string>={};for(const key of ['username','password'])if(typeof params[key]==='string'){secret[key]=params[key] as string;delete params[key];}
 if(Object.keys(secret).length)params.secrets=await sealAgentSecrets(secret,snapshot?.publicKey);
 const target=input.target?input.target(params):jobKind==='refresh'?'':safeTarget(jobKind,params),id=crypto.randomUUID(),time=now();
 if(await waitingJobCount(serverId)>=MAX_QUEUED_JOBS)throw queueFullError();
 // The active driver job check is part of the INSERT, so two concurrent requests write at most one driver job.
 const authorization=gpuDriver?sql`${featureDeviceGuard(v,serverId,required.permissions)} AND ${noActiveGpuDriverJob(serverId)}`:featureDeviceGuard(v,serverId,required.permissions);
 // A refused write of a driver job names the driver job that won the race.
 const refused=async()=>gpuDriver&&await gpuDriverJobActive(serverId)?new HttpError('apiError.gpuDriver.jobActive'):new HttpError('apiError.console.queueChanged');
 const job={id,serverId,kind:jobKind,target,parameters:JSON.stringify(params),at:time,actor:v.id,actorEmail:v.label.trim().toLowerCase(),actorPrincipal:principal(v)},audit={actor:v.label,action:definition.label,target:s.name+(target?' / '+target:'')},more=options.more?.(id)??[];
 if(options.stepUp){
  // A missing or used proof answers MFA_STEP_UP_REQUIRED: the client opens the step-up dialog and resends once with the new token.
  const {prepareManagementAuthorization}=await import('../identity/rbac');
  const proof=await prepareManagementAuthorization(request,v,options.stepUp.managementToken);
  const written=await queueAuditedJobWithProof(job,authorization,MAX_QUEUED_JOBS,audit,more,proof);
  if(!written.confirmed)throw new HttpError('apiError.mfa.proofExpired');
  if(!written.inserted)throw await refused();
  return {id};
 }
 const inserted=await queueAuditedJob(job,authorization,MAX_QUEUED_JOBS,audit,more);
 if(!inserted)throw await refused();
 return {id};
}

/** POST /api/diagnostics: one live diagnosis of lib/diagnostics.ts. Answers the new job ID. */
export async function queueDiagnosticJob(request:Request,v:Viewer,input:DeviceJobInput,options:QueueOptions={}):Promise<{id:string}>{
 if(!guid(input.serverId)||!isDiagnosticKind(input.kind))throw new HttpError('apiError.diagnostics.invalidAction');
 const serverId=input.serverId,kind=input.kind as DiagnosticKind,definition=diagnosticDefinitions[kind],parsed=definition.schema.safeParse(input.params??{});
 if(!parsed.success)throw new HttpError('apiError.diagnostics.invalidParameters',{fields:issueFields(parsed.error.issues,5)});
 // diagnose loads the device and security.events follows at once; manage waits for the agent checks.
 const params=parsed.data as Record<string,unknown>,required=jobRequirements(kind,params),[deviceRight]=required.permissions,early=[deviceRight,...required.securityEvents?[securityEventsPermission]:[]];
 const s=await requireDevice(v,serverId,deviceRight);if(required.securityEvents)await requireDevice(v,serverId,securityEventsPermission);
 const snapshot:ServerSnapshot|null=s.snapshot?JSON.parse(s.snapshot):null;
 if(!s.last_seen||now()-s.last_seen>120000)throw new HttpError('apiError.agent.notConnected');
 if(snapshot?.protocolVersion!==3||!required.capabilities.every(capability=>snapshot.agentCapabilities?.includes(capability)))throw new HttpError('apiError.diagnostics.agentV3Required');
 for(const right of required.permissions)if(!early.includes(right))await requireDevice(v,serverId,right);
 if(required.mfa)await requireMfa(request,v);
 if(required.managementMode&&(!s.management||snapshot.mode!=='Management'))throw new HttpError('apiError.agent.managementRequired');
 if(!definition.readOnly&&input.confirm!==true)throw new HttpError('apiError.diagnostics.confirmChange');
 if(await maintenanceBusy(serverId))throw new HttpError('apiError.agent.maintenanceRetry');
 if(await waitingJobCount(serverId)>=MAX_QUEUED_JOBS)throw queueFullError();
 const id=crypto.randomUUID(),time=now(),target=diagnosticTarget(kind,params);
 const authorization=featureDeviceGuard(v,serverId,required.permissions);
 const admitted=await queueAuditedJob({id,serverId,kind,target,parameters:JSON.stringify(params),at:time,actor:v.id,actorEmail:v.label.trim().toLowerCase(),actorPrincipal:principal(v)},authorization,MAX_QUEUED_JOBS,{actor:v.label,action:definition.label,target:s.name+' / '+target},options.more?.(id));
 if(!admitted)throw new HttpError('apiError.console.queueChanged');
 return {id};
}
