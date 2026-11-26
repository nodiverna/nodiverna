import {PENDING_JOB_LIFETIME_MS} from './job-expiry';

// Offboarding with a portal uninstall of the agent: the job kind, its result
// code and the state of a device between the request and its revocation.
// Pure: no database and no server bindings, so the console uses the same rules
// as offboardingStatus (lib/server/devices/device-lifecycle.ts).

export const AGENT_UNINSTALL_KIND='agent-uninstall';
/** The only agent result that lets the portal revoke the device. */
export const AGENT_UNINSTALL_STARTED='AGENT_UNINSTALL_STARTED';
/** Stored result of a claim cancelled because the agent no longer lists the capability. */
/** jobs.result of an uninstall that the agent cannot run (a serverMessage key, lib/server-messages.ts). */
export const UNINSTALL_UNSUPPORTED_RESULT='serverMessage.offboarding.unsupported';
/** The same result as rows before the catalog keys. */
const olderUnsupportedResult='Agent unterstützt die Deinstallation nicht';

export type OffboardingState='uninstalled'|'revoked'|'waiting'|'running'|'failed'|'registered';
export type OffboardingReason='offline'|'agent'|'unsupported'|'cancelled';
export type OffboardingEntry={id:string;name:string;state:OffboardingState;reason?:OffboardingReason;code?:string|null;args?:Record<string,string>|null;result?:string|null;jobId?:string};
/** The facts of the latest agent-uninstall job of a device. */
export type UninstallJobFacts={state:string;createdAt:number;notBefore?:number|null;claimedAt?:number|null;result?:string|null};

/** Whether a device snapshot advertises the portal uninstall (protocol 3 and the capability). */
export function canUninstall(snapshot:{protocolVersion?:unknown;agentCapabilities?:unknown}|null|undefined):boolean{
 return snapshot?.protocolVersion===3&&Array.isArray(snapshot.agentCapabilities)&&snapshot.agentCapabilities.includes(AGENT_UNINSTALL_KIND);
}

/** A pending job older than the pending lifetime is never delivered (lib/job-expiry.ts). */
export function pendingExpired(job:Pick<UninstallJobFacts,'createdAt'|'notBefore'>,now:number):boolean{
 return Math.max(job.createdAt,job.notBefore??0)<now-PENDING_JOB_LIFETIME_MS;
}

/** Whether a job keeps a device in the uninstall flow: pending and still deliverable, or running. */
export function uninstallOpen(job:UninstallJobFacts|null|undefined,now:number):boolean{
 return !!job&&(job.state==='running'||job.state==='pending'&&!pendingExpired(job,now));
}

/**
 * The offboarding state of one device from its revoked flag, its current
 * capability and its latest agent-uninstall job.
 */
export function offboardingState({revoked,capable,job,now}:{revoked:boolean;capable:boolean;job:UninstallJobFacts|null;now:number}):{state:OffboardingState;reason?:OffboardingReason}{
 if(revoked)return {state:job?.state==='succeeded'?'uninstalled':'revoked'};
 if(job?.state==='pending')return pendingExpired(job,now)?{state:'failed',reason:'offline'}:{state:'waiting'};
 if(job?.state==='running')return {state:'running'};
 if(job?.state==='failed')return {state:'failed',reason:'agent'};
 if(job?.state==='expired')return {state:'failed',reason:job.claimedAt==null?'offline':'cancelled'};
 if(job?.state==='cancelled')return {state:'failed',reason:job.result===UNINSTALL_UNSUPPORTED_RESULT||job.result===olderUnsupportedResult?'unsupported':'cancelled'};
 // No uninstall job (or a finished one that did not revoke): the capability decides.
 return capable?{state:'registered'}:{state:'failed',reason:'unsupported'};
}

/** Final rows need no more polling: revoked, uninstalled and failed. */
export const offboardingFinal=(state:OffboardingState)=>state==='uninstalled'||state==='revoked'||state==='failed';
