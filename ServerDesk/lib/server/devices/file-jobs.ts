import {jobDisplayInput} from '../../job-input';
import {db,sql,type Sql} from '../db';

// Storage of the file job routes (app/api/files): the job row with its agent
// output, and the guarded insert that respects the device's job queue limit.
export type FileJobRow={id:string;action:string;state:string;result:string|null;result_code:string|null;result_args:string|null;actor_principal:string|null;parameters:string;target:string;data:string|null};
export async function fileJob(serverId:string,id:string){
 return db().one<FileJobRow>(sql`SELECT j.id,j.action,j.state,j.result,j.result_code,j.result_args,j.actor_principal,j.parameters,j.target,o.data FROM jobs j LEFT JOIN job_outputs o ON o.job_id=j.id AND o.server_id=j.server_id WHERE j.server_id=${serverId} AND j.id=${id}`);
}
// actorPrincipal is principal(v) of the queuing viewer (lib/server/identity/access.ts): the claim and the result read check it.
export type NewFileJob={id:string;serverId:string;kind:string;target:string;parameters:string;at:number;actor:string;actorEmail:string;actorPrincipal:string};
/** Queues the job when the authorization holds and the queue has room; the audit row, if given, commits with it. */
export async function queueFileJob(job:NewFileJob,authorization:Sql,maxQueued:number,audit:{actor:string;action:string;target:string}|null){
 return db().transaction(async tx=>{
  const inserted=await tx.one(sql`INSERT INTO jobs (id,server_id,action,target,parameters,display_input,created_at,actor,actor_email,actor_principal) SELECT ${job.id},${job.serverId},${job.kind},${job.target},${job.parameters},${jobDisplayInput(job.kind,job.parameters)},${job.at},${job.actor},${job.actorEmail},${job.actorPrincipal} WHERE ${authorization} AND (SELECT count(*) FROM jobs WHERE server_id=${job.serverId} AND state IN ('pending','running'))<${maxQueued} RETURNING id`);
  if(inserted&&audit)await tx.exec(sql`INSERT INTO audit (at,actor,action,target,server_id,scope) VALUES (${job.at},${audit.actor},${audit.action},${audit.target},${job.serverId},'device')`);
  return !!inserted;
 });
}
