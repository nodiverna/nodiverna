// The state of the maintenance command for the Owner notice, against
// the real lib/server/maintenance-runs.ts on a PostgreSQL test database.
import assert from 'node:assert/strict';
import {sourceDatabase,sourceLoader} from '../support/source-database.mjs';
import {sql} from '../../runtime/database.mjs';

const d=await sourceDatabase();
let checks=0;
const check=(value,expected,label)=>{assert.deepEqual(value,expected,label);checks++;};
try{
 const hour=3_600_000,now=Date.now();
 const runs=sourceLoader()('lib/server/maintenance-runs.ts',{});
 const status=()=>runs.maintenanceStatus(d,now);
 const reset=()=>d.exec(sql`DELETE FROM maintenance_runs`);
 const insert=(startedAt,finishedAt,state,extra={})=>d.exec(sql`INSERT INTO maintenance_runs(started_at,finished_at,status,result,error) VALUES(${startedAt},${finishedAt},${state},${extra.result??null},${extra.error??null})`);
 check(runs.maintenanceStaleAfterMs,48*hour,'the threshold is 48 hours');

 check(await status(),{lastSuccessAt:null,lastRun:null,stale:true},'no run yet: never succeeded');

 // Strictly older than 48 hours is stale, measured at finished_at.
 for(const [age,stale] of [[47*hour,false],[48*hour,false],[48*hour+1,true]]){
  await reset();await insert(now-age-5000,now-age,'succeeded',{result:'{}'});
  check(await status(),{lastSuccessAt:now-age,lastRun:{startedAt:now-age-5000,finishedAt:now-age,status:'succeeded'},stale},`a success ${age} ms ago`);
 }

 // A later failure is the last run; the success before it still counts.
 await reset();await insert(now-10*hour,now-9*hour,'succeeded',{result:'{"ok":1}'});await insert(now-2*hour,now-hour,'failed',{error:'Transfers konnten nicht bereinigt werden.'});
 const failed=await status();
 check(failed,{lastSuccessAt:now-9*hour,lastRun:{startedAt:now-2*hour,finishedAt:now-hour,status:'failed'},stale:false},'a failure after a success');
 check([Object.keys(failed),Object.keys(failed.lastRun)],[['lastSuccessAt','lastRun','stale'],['startedAt','finishedAt','status']],'neither error nor result leave the server');
 check(JSON.stringify(failed).includes('Transfers'),false,'the error text is not in the state');

 // A running row never counts as a success.
 await reset();await insert(now-hour,null,'running');
 check(await status(),{lastSuccessAt:null,lastRun:{startedAt:now-hour,finishedAt:null,status:'running'},stale:true},'only a running row');

 // The newest success wins, even if an older one finished later in id order; equal starts take the larger id.
 await reset();await insert(now-3*hour,now-2*hour,'succeeded');await insert(now-60*hour,now-59*hour,'succeeded');await insert(now-hour,null,'running');await insert(now-hour,now-1000,'failed');
 const newest=await status();
 check([newest.lastSuccessAt,newest.lastRun.status,newest.lastRun.finishedAt],[now-2*hour,'failed',now-1000],'max(finished_at) and the larger id on equal starts');

 // The trigger column: one of four values, 'cli' by default; requested_by is free text. The state ignores both.
 await reset();
 await assert.rejects(d.exec(sql`INSERT INTO maintenance_runs(started_at,status,trigger) VALUES(${now},'running','cron')`),error=>error.code==='23514'&&error.constraint_name==='maintenance_runs_trigger');checks++;
 await assert.rejects(d.exec(sql`INSERT INTO maintenance_runs(started_at,status,trigger) VALUES(${now},'running',NULL)`),error=>error.code==='23502');checks++;
 await d.exec(sql`INSERT INTO maintenance_runs(started_at,status) VALUES(${now-hour},'running')`);
 check((await d.one(sql`SELECT trigger,requested_by FROM maintenance_runs`)),{trigger:'cli',requested_by:null},'the default trigger is cli');
 for(const trigger of ['schedule','continuation','manual'])await d.exec(sql`INSERT INTO maintenance_runs(started_at,finished_at,status,trigger,requested_by) VALUES(${now-hour},${now-hour+1},'succeeded',${trigger},${trigger==='manual'?'owner@example.test':null})`);
 check(await status(),{lastSuccessAt:now-hour+1,lastRun:{startedAt:now-hour,finishedAt:now-hour+1,status:'succeeded'},stale:false},'maintenanceStatus is unchanged by the new columns');

 // lastSuccessAt reads the index instead of scanning the table.
 // Sequential scans are off, so the plan shows whether the index can answer the query.
 const plan=await d.transaction(async tx=>{await tx.exec(sql`SET LOCAL enable_seqscan=off`);return (await tx.query(sql`EXPLAIN ${runs.maintenanceStatusQueries.lastSuccess}`)).map(row=>row['QUERY PLAN']).join('\n');});
 assert.match(plan,/Index (?:Only )?Scan(?: Backward)? using maintenance_runs_finished on maintenance_runs/,plan);
 assert.doesNotMatch(plan,/Seq Scan on maintenance_runs\b/,plan);checks+=2;
 console.log(`PASS ${checks} maintenance state checks: never, 47/48/48h+1ms, failure after success, running only, no error or result, trigger CHECK, index for the last success.`);
}finally{d.close();}
