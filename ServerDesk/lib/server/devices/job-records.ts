import {jobDisplayInput} from '../../job-input';
import {commitAll,db,sql,type Sql} from '../db';

// Storage of the job routes that queue and list device jobs (app/api/diagnostics, lib/server/devices/device-job-queue.ts, lib/server/devices/assistant-commands.ts).
export type JobListRow={id:string;kind:string;state:string;createdAt:number;claimedAt:number|null;result:string|null;result_code:string|null;result_args:string|null;parameters:string;data:string|null};
/** The 30 newest jobs of a device (or the one with jobId), with their agent output. */
export async function deviceJobs(serverId:string,jobId:string|null){
 return db().query<JobListRow>(sql`SELECT j.id,j.action AS kind,j.state,j.created_at AS "createdAt",j.claimed_at AS "claimedAt",j.result,j.result_code,j.result_args,j.parameters,o.data FROM jobs j LEFT JOIN job_outputs o ON o.job_id=j.id AND o.server_id=j.server_id WHERE j.server_id=${serverId} ${jobId?sql`AND j.id=${jobId}`:sql``} ORDER BY j.created_at DESC LIMIT 30`);
}
export type OwnJobRow=JobListRow&{target:string|null};
/** One job of a device that this actor queued (jobs.actor), with its target and agent output; null for any other job. */
export async function ownDeviceJob(serverId:string,jobId:string,actor:string){
 return db().one<OwnJobRow>(sql`SELECT j.id,j.action AS kind,j.state,j.target,j.created_at AS "createdAt",j.claimed_at AS "claimedAt",j.result,j.result_code,j.result_args,j.parameters,o.data FROM jobs j LEFT JOIN job_outputs o ON o.job_id=j.id AND o.server_id=j.server_id WHERE j.server_id=${serverId} AND j.id=${jobId} AND j.actor=${actor}`);
}
/** Pending and running jobs of a device. */
export async function waitingJobCount(serverId:string){return Number((await db().one<{n:number}>(sql`SELECT count(*) AS n FROM jobs WHERE server_id=${serverId} AND state IN ('pending','running')`))?.n??0);}
// actorPrincipal is principal(v) of the queuing viewer (lib/server/identity/access.ts); every claim guard reads it.
export type NewJob={id:string;serverId:string;kind:string;target:string;parameters:string;at:number;actor:string;actorEmail:string;actorPrincipal:string};
export type JobAudit={actor:string;action:string;target:string};
/**
 * Queues a job and its device audit row in one transaction when the
 * authorization holds and fewer than maxQueued jobs wait. More device audit
 * rows (for example assistant.run) follow in the same transaction, only with
 * the job. False when nothing was written.
 */
export async function queueAuditedJob(job:NewJob,authorization:Sql,maxQueued:number,audit:JobAudit,more:readonly JobAudit[]=[]){
 const results=await commitAll([
  sql`INSERT INTO jobs (id,server_id,action,target,parameters,display_input,created_at,actor,actor_email,actor_principal) SELECT ${job.id},${job.serverId},${job.kind},${job.target},${job.parameters},${jobDisplayInput(job.kind,job.parameters)},${job.at},${job.actor},${job.actorEmail},${job.actorPrincipal} WHERE ${authorization} AND (SELECT count(*) FROM jobs WHERE server_id=${job.serverId} AND state IN ('pending','running'))<${maxQueued}`,
  ...[audit,...more].map(row=>sql`INSERT INTO audit (at,actor,action,target,server_id,scope) SELECT ${job.at},${row.actor},${row.action},${row.target},${job.serverId},'device' WHERE EXISTS (SELECT 1 FROM jobs WHERE id=${job.id})`)
 ]);
 return results[0].rowCount>0;
}
/** A fresh step-up proof as lib/server/identity/rbac.ts prepares it: the proof row and the guard that it is still live. */
export type JobProof={tokenHash:string;key:string;sessionHash:string;guard:Sql};
/**
 * queueAuditedJob for a job that needs a fresh step-up proof (lib/step-up.ts):
 * the proof is part of the job's admission and consumed in the same
 * transaction, only when the job was written. confirmed is false when the
 * proof was no longer live.
 */
export async function queueAuditedJobWithProof(job:NewJob,authorization:Sql,maxQueued:number,audit:JobAudit,more:readonly JobAudit[],proof:JobProof){
 const results=await commitAll([
  sql`SELECT 1 AS confirmed WHERE ${proof.guard}`,
  sql`INSERT INTO jobs (id,server_id,action,target,parameters,display_input,created_at,actor,actor_email,actor_principal) SELECT ${job.id},${job.serverId},${job.kind},${job.target},${job.parameters},${jobDisplayInput(job.kind,job.parameters)},${job.at},${job.actor},${job.actorEmail},${job.actorPrincipal} WHERE ${authorization} AND (${proof.guard}) AND (SELECT count(*) FROM jobs WHERE server_id=${job.serverId} AND state IN ('pending','running'))<${maxQueued}`,
  ...[audit,...more].map(row=>sql`INSERT INTO audit (at,actor,action,target,server_id,scope) SELECT ${job.at},${row.actor},${row.action},${row.target},${job.serverId},'device' WHERE EXISTS (SELECT 1 FROM jobs WHERE id=${job.id})`),
  sql`DELETE FROM mfa_management_proofs WHERE token_hash=${proof.tokenHash} AND principal=${proof.key} AND session_hash=${proof.sessionHash} AND EXISTS (SELECT 1 FROM jobs WHERE id=${job.id})`,
 ]);
 return {inserted:results[1].rowCount>0,confirmed:results[0].rows.length>0};
}
