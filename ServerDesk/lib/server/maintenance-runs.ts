import type {MaintenanceStatus} from '../types';
import {sql,type Queryable} from './db';

// State of the daily maintenance (runtime/maintenance.mjs, table
// maintenance_runs) for the Owner notice in the console. The server decides "stale"; the client only formats the
// time. error and result stay on the server.
export const maintenanceStaleAfterMs=48*3_600_000;

export const maintenanceStatusQueries={
 // Searches the index maintenance_runs_finished (status, finished_at).
 lastSuccess:sql`SELECT max(finished_at) AS "finishedAt" FROM maintenance_runs WHERE status='succeeded'`,
 lastRun:sql`SELECT started_at AS "startedAt",finished_at AS "finishedAt",status FROM maintenance_runs ORDER BY started_at DESC,id DESC LIMIT 1`,
} as const;

type RunRow={startedAt:number;finishedAt:number|null;status:'running'|'succeeded'|'failed'};

/** Stale means no succeeded run yet, or the newest one finished more than 48 hours before now. */
export async function maintenanceStatus(database:Queryable,now:number):Promise<MaintenanceStatus>{
 const [success,run]=await Promise.all([
  database.one<{finishedAt:number|null}>(maintenanceStatusQueries.lastSuccess),
  database.one<RunRow>(maintenanceStatusQueries.lastRun),
 ]);
 const lastSuccessAt=success?.finishedAt??null;
 return {
  lastSuccessAt,
  lastRun:run?{startedAt:run.startedAt,finishedAt:run.finishedAt,status:run.status}:null,
  stale:lastSuccessAt===null||now-lastSuccessAt>maintenanceStaleAfterMs,
 };
}
