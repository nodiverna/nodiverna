import {jobDisplayInput} from '../../job-input';
import {db,sql,runSteps,type Sql} from '../db';
import {customerEntries,type CustomerScope} from '../identity/cross-customer';
import type {NewJob} from './job-records';

// Storage of the bulk Defender actions of the scope tab "Protection"
// (POST /api/console {action:'defender-jobs'}, docs/device-health-signals.md).
// One transaction writes, for every device, the job and its device audit row,
// plus one customer entry per customer of a cross-customer request. It is all
// or nothing: when one job is refused by its guard, nothing is written.
class NothingWritten extends Error{}

export type DefenderBulkJob=NewJob&{deviceName:string};
/**
 * Queues the jobs when every one passes `authorization` (the device rights of
 * all targets), the cross-customer guard and the per-device queue limit.
 * `label` is the German operation label of lib/management.ts for the audit.
 * False when nothing was written.
 */
export async function queueDefenderJobs(input:{jobs:DefenderBulkJob[];authorization:Sql;customers:CustomerScope;maxQueued:number;actor:string;label:string}):Promise<boolean>{
 const {jobs,authorization,customers,maxQueued,actor,label}=input;
 const ids=JSON.stringify(jobs.map(job=>job.id));
 try{
  await db().transaction(async tx=>{
   for(const job of jobs){
    const [inserted]=await runSteps(tx,[sql`INSERT INTO jobs (id,server_id,action,target,parameters,display_input,created_at,actor,actor_email,actor_principal) SELECT ${job.id},${job.serverId},${job.kind},${job.target},${job.parameters},${jobDisplayInput(job.kind,job.parameters)},${job.at},${job.actor},${job.actorEmail},${job.actorPrincipal} WHERE ${authorization} AND ${customers.guard} AND (SELECT count(*) FROM jobs WHERE server_id=${job.serverId} AND state IN ('pending','running'))<${maxQueued}`]);
    if(!inserted.rowCount)throw new NothingWritten();
    await runSteps(tx,[sql`INSERT INTO audit (at,actor,action,target,server_id,scope) VALUES (${job.at},${actor},${label},${job.deviceName},${job.serverId},'device')`]);
   }
   await runSteps(tx,customerEntries(customers,{actor,action:'Defender-Aktion kundenübergreifend gestartet',target:label,condition:sql`(SELECT count(*) FROM jobs WHERE id IN (SELECT value FROM jsonb_array_elements_text(${ids}::jsonb)))=${jobs.length}`}));
  });
  return true;
 }catch(error){if(error instanceof NothingWritten)return false;throw error;}
}
