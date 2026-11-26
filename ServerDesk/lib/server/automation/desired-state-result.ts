import {sql} from '../db';
// The agent channel stores a Desired-State result on its assignment in the same
// batch as the job result. Jobs and their outputs expire with the job retention of
// the maintenance page (Settings → Maintenance, JOB_RETENTION_DAYS as start value);
// these assignment columns keep the last result and verdict (migration 0037).
// Kept free of runtime imports so the channel's schedulers stay stubbable in tests.

export const desiredResultActions=new Set(['desired-state-test','desired-state-apply']);

/** The verdict a result carries: only a successful result with a boolean compliant. */
export function desiredResultCompliance(ok:boolean,data:unknown):0|1|null{
 if(!ok||!data||typeof data!=='object'||Array.isArray(data))return null;
 const compliant=(data as {compliant?:unknown}).compliant;
 return typeof compliant==='boolean'?(compliant?1:0):null;
}

/**
 * Updates exactly the assignment of the job's run, while that assignment still
 * has the run's device and version and is enabled, the job is still running on
 * this device and the device is active. Must run before the job's state update
 * in the same batch, which ends the 'running' state this guard reads.
 */
export function desiredResultStatement({jobId,serverId,ok,data,time}:{jobId:string;serverId:string;ok:boolean;data:unknown;time:number}){
 const compliant=desiredResultCompliance(ok,data);
 return sql`UPDATE desired_assignments SET last_job_id=${jobId},last_result_state=${ok?'succeeded':'failed'},last_result_at=${time},last_compliant=${compliant===null?sql`last_compliant`:sql`${compliant}`},last_compliant_at=${compliant===null?sql`last_compliant_at`:sql`${time}`}
 WHERE id=(SELECT assignment_id FROM desired_runs WHERE job_id=${jobId} AND server_id=${serverId}) AND enabled=1
 AND EXISTS (SELECT 1 FROM desired_runs r WHERE r.job_id=${jobId} AND r.assignment_id=desired_assignments.id AND r.server_id=desired_assignments.server_id AND r.version_id=desired_assignments.version_id)
 AND EXISTS (SELECT 1 FROM jobs WHERE id=${jobId} AND server_id=${serverId} AND state='running' AND action IN ('desired-state-test','desired-state-apply'))
 AND EXISTS (SELECT 1 FROM servers WHERE id=${serverId} AND revoked=0)`;
}
