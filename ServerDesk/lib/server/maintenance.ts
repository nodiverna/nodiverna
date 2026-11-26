import {maintenanceAuditAction} from '../audit-actions';
import {env} from 'cloudflare:workers';
import {HttpError,now} from './context';
import {auditEvent} from './audit';
import {can,viewerCanSql} from './identity/policy/can';
import {errorCatalog,type ErrorCode} from '../errors/codes';
import {maintenanceStatus} from './maintenance-runs';
import type {Viewer} from '../types';
import {commitAll,db,sql,type Step} from './db';
import {accountMatchSql,accountNameSql} from './identity/account-names';
import {agentIntegrityRetentionDays,assistantScriptRetentionDays,environmentRetentionView,knownTimeZone,maintenanceRunAuditAction,readMaintenanceSettings,retentionSourceView,startMaintenance,storedMaintenanceError} from '../../runtime/maintenance.mjs';
import {customerRetention,maintenanceStorage,type CustomerRetention,type MaintenanceStorage} from './maintenance-storage';
import {nextMaintenanceRun} from '../../runtime/maintenance-scheduler.mjs';
import {maintenanceSetNeedsStepUp} from '../step-up';
import {mfaSessionFence,requireLiveSessions} from './identity/mfa';

// The page Settings → Maintenance (docs/self-hosting.md, "Maintenance").
// Only global Owners read or change it. Saving needs a fresh step-up proof
// only when the audit or the job retention gets shorter (maintenanceSetNeedsStepUp
// in lib/step-up.ts, rule 6: a shorter retention deletes audit evidence); any
// other save and Run now rely on the live MFA login session.
// The run itself lives in runtime/maintenance.mjs and continues in this process
// after the 202 reply; its 'manual' row and the audit row
// maintenanceRunAuditAction commit together there (openRun).
export {maintenanceAuditAction};
export type {CustomerRetention,MaintenanceStorage,RetainedTable,TableStorage} from './maintenance-storage';
export {maintenanceRunAuditAction};
export const maintenanceHistoryLength=20;
const timePattern=/^([01]\d|2[0-3]):[0-5]\d$/;

export type MaintenanceSource='stored'|'env'|'default';
export type MaintenanceTrigger='schedule'|'continuation'|'manual'|'cli';
export type MaintenanceArea={deleted:number;more:boolean};
export type MaintenanceResult={
 retention?:{auditDays:number;jobDays:number;softwareDays?:number;alertDays?:number};
 audit?:MaintenanceArea;
 /** One pass per customer with its own retention; customerName is added for the page (null for a removed customer). */
 customerAudit?:(MaintenanceArea&{customerId:string;auditDays:number;customerName?:string|null})[];
 jobs?:MaintenanceArea;
 jobOutputs?:MaintenanceArea;
 /** The scripts removed from the kept input of ended assistant jobs (assistantScriptRetentionDays); missing in runs from before 0033. */
 assistantScripts?:{cleared:number;more:boolean};
 /** The software change history (SOFTWARE_CHANGE_RETENTION_DAYS); missing in runs from before the software inventory. */
 softwareChanges?:MaintenanceArea;
 /** Closed alarms (ALERT_RETENTION_DAYS); missing in runs from before the alarms. */
 alerts?:MaintenanceArea;
 /** Notification events and their deliveries (the alarm retention); missing in runs from before the notifications. */
 notifications?:MaintenanceArea;
 /** Agent service events (agentIntegrityRetentionDays); missing in runs from before the integrity events. */
 integrityEvents?:MaintenanceArea;
 transfers?:{cleared:number;failed:number;more:boolean};
 usageReport?:{status:string;error?:string};
 /** The check for new agent releases (runtime/release-import.mjs); missing in runs from before the import. */
 releaseImport?:{status:string;imported?:number;present?:number;failed?:number};
};
/** The failure reasons of a run (runtime/maintenance.mjs, maintenanceFailures). */
export type MaintenanceFailureReason='retentionInvalid'|'lockLost'|'lockExpired'|'transfersFailed'|'internal';
/** The stored key of a failed run; the page shows its catalog text. */
export type MaintenanceErrorKey=`serverMessage.maintenance.${MaintenanceFailureReason}`;
export type MaintenanceRun={id:number;startedAt:number;finishedAt:number|null;status:'running'|'succeeded'|'failed';trigger:MaintenanceTrigger;requestedBy:string|null;result:MaintenanceResult|null;error:MaintenanceErrorKey|null};
export type MaintenanceView={
 settings:{auditDays:number|null;jobDays:number|null;runAt:string;timeZone:string;revision:number;source:{auditDays:MaintenanceSource;jobDays:MaintenanceSource}};
 envInvalid:{auditDays:boolean;jobDays:boolean};
 status:{lastRun:MaintenanceRun|null;lastSuccessAt:number|null;running:boolean;nextRunAt:number|null;stale:boolean};
 history:MaintenanceRun[];
 /** The size facts of the retained tables; null values where the statistics could not be read. */
 storage:MaintenanceStorage;
 /** The retention of the areas the page cannot change: software changes and alarms (environment or default), and the two fixed ones. */
 areaRetention:{softwareDays:EnvironmentRetention;alertDays:EnvironmentRetention;assistantScriptDays:number;integrityDays:number};
 customerRetention:CustomerRetention;
};
/** A retention that only an environment variable sets (SOFTWARE_CHANGE_RETENTION_DAYS, ALERT_RETENTION_DAYS); days is null for an invalid value. */
export type EnvironmentRetention={days:number|null;source:'env'|'default';envInvalid:boolean};
type RunRow={id:number;started_at:number;finished_at:number|null;status:MaintenanceRun['status'];trigger:MaintenanceTrigger;requested_by:string|null;result:string|null;error:string|null};

const coded=(code:ErrorCode)=>new HttpError(errorCatalog[code].key);
// The re-check after a refused commit asks the database again (fresh): a demoted Owner gets 403, not a conflict.
async function requireOwner(viewer:Viewer,fresh=false){if(!await can(viewer,'instance.owner',{fresh}))throw coded('MAINTENANCE_OWNER_ONLY');}
/** 403 MAINTENANCE_OWNER_ONLY unless the viewer is a global Owner. */
export const requireMaintenanceOwner=(viewer:Viewer)=>requireOwner(viewer);
const stepUpExpired=()=>new HttpError('apiError.mfa.proofExpired');
// The portal environment: AUDIT_RETENTION_DAYS, JOB_RETENTION_DAYS and LICENSE_SERVER_URL of this process.
const runtimeEnv=()=>env as unknown as Record<string,string|undefined>;
const storage=()=>(env as unknown as {BUCKET:unknown}).BUCKET;

/** "HH:MM" of minutes after midnight. */
export const timeText=(minutes:number)=>`${String(Math.floor(minutes/60)).padStart(2,'0')}:${String(minutes%60).padStart(2,'0')}`;
const minutesOf=(text:string)=>Number(text.slice(0,2))*60+Number(text.slice(3,5));
const validDays=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=1&&value<=3650;
/** A zone that Intl accepts and that is in Intl.supportedValuesOf('timeZone'), or UTC. */
export function validTimeZone(value:unknown):value is string{
 if(typeof value!=='string'||!knownTimeZone(value))return false;
 return value==='UTC'||Intl.supportedValuesOf('timeZone').includes(value);
}

// Run results stay English operator text. Of the usage report only its status
// and error code leave the server.
function publicResult(text:string|null):MaintenanceResult|null{
 let parsed:unknown;
 try{parsed=text===null?null:JSON.parse(text);}catch{return null;}
 if(!parsed||typeof parsed!=='object')return null;
 const result={...parsed} as MaintenanceResult&Record<string,unknown>;
 const report=result.usageReport;
 if(report&&typeof report==='object'){
  const code=typeof report.error==='string'&&/^[a-z0-9-]{1,40}$/.test(report.error)?report.error:undefined;
  result.usageReport={status:String(report.status),...(report.status==='failed'?{error:code??'internal'}:{})};
 }
 return result;
}

async function history():Promise<MaintenanceRun[]>{
 const rows=await db().query<RunRow>(sql`SELECT r.id,r.started_at,r.finished_at,r.status,r.trigger,${accountNameSql(sql`u`,sql`r.requested_by`)} AS requested_by,r.result,r.error FROM maintenance_runs r LEFT JOIN LATERAL (SELECT * FROM local_users u WHERE ${accountMatchSql(sql`u`,sql`r.requested_by`)} LIMIT 1) u ON TRUE ORDER BY r.started_at DESC,r.id DESC LIMIT ${maintenanceHistoryLength}`);
 // requested_by keeps the stored label; the run shows the account's name or null (lib/server/identity/account-names.ts).
 // The error leaves the server only as a reason key: rows from before the keys are mapped, raw text never.
 const runs=rows.map(row=>({id:row.id,startedAt:row.started_at,finishedAt:row.finished_at,status:row.status,trigger:row.trigger,requestedBy:row.requested_by,result:publicResult(row.result),error:storedMaintenanceError(row.error) as MaintenanceErrorKey|null}));
 const ids=[...new Set(runs.flatMap(run=>(run.result?.customerAudit??[]).map(pass=>pass.customerId)).filter(id=>typeof id==='string'))];
 if(ids.length){
  const names=new Map((await db().query<{id:string;name:string}>(sql`SELECT id,name FROM customers WHERE id IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))`)).map(row=>[row.id,row.name]));
  for(const run of runs)if(run.result?.customerAudit)run.result.customerAudit=run.result.customerAudit.map(pass=>({...pass,customerName:names.get(pass.customerId)??null}));
 }
 return runs;
}

async function view():Promise<MaintenanceView>{
 const database=db(),time=now();
 const settings=await readMaintenanceSettings(database);
 const {values,source,envInvalid}=retentionSourceView(settings,runtimeEnv());
 const [runs,state,lock,storage_,customers]=await Promise.all([
  history(),
  maintenanceStatus(database,time),
  database.one<{running:boolean}>(sql`SELECT (holder IS NOT NULL AND expires_at>=${time}) AS running FROM maintenance_lock WHERE id=1`),
  maintenanceStorage(database),
  customerRetention(database),
 ]);
 const fixed=environmentRetentionView(runtimeEnv());
 const scheduler=String(runtimeEnv().MAINTENANCE_SCHEDULER??'').trim().toLowerCase()!=='off';
 return {
  settings:{auditDays:values.auditDays,jobDays:values.jobDays,runAt:timeText(settings.runAt),timeZone:settings.timeZone,revision:settings.revision,source:{auditDays:source.auditDays,jobDays:source.jobDays}},
  envInvalid:{auditDays:envInvalid.auditDays,jobDays:envInvalid.jobDays},
  status:{lastRun:runs[0]??null,lastSuccessAt:state.lastSuccessAt,running:!!lock?.running,nextRunAt:scheduler?await nextMaintenanceRun(database,time,settings):null,stale:state.stale},
  history:runs,
  storage:storage_,
  areaRetention:{softwareDays:fixed.softwareDays,alertDays:fixed.alertDays,assistantScriptDays:assistantScriptRetentionDays,integrityDays:agentIntegrityRetentionDays},
  customerRetention:customers,
 };
}

/**
 * The instance audit retention that applies to a customer without its own
 * value: days is the stored, environment or default value (null for an invalid
 * environment value, which deletes nothing), stored is maintenance_settings.audit_days
 * as read, so a write can check that it did not change before its commit.
 */
export async function instanceAuditRetention():Promise<{days:number|null;stored:number|null}>{
 const settings=await readMaintenanceSettings(db());
 return {days:retentionSourceView(settings,runtimeEnv()).values.auditDays,stored:settings.auditDays};
}

/** GET /api/maintenance: settings, status, the last 20 runs, the size facts and the retention of every area. Owners only; nothing is read before the Owner check. */
export async function maintenanceView(viewer:Viewer):Promise<MaintenanceView>{await requireOwner(viewer);return view();}

type SetInput={auditDays?:unknown;jobDays?:unknown;runAt?:unknown;timeZone?:unknown;revision?:unknown;managementToken?:unknown};
const daysText=(value:number|null)=>value===null?'invalid':String(value);

/**
 * Saves retention, time and time zone. Validation runs before anything is
 * read or written. A save that shortens the audit or the job retention
 * (maintenanceSetNeedsStepUp) reads the step-up proof after validation: one
 * batch holds the proof check, the audit row and the compare-and-set update
 * against the revision, both guarded by the proof and the live Owner right,
 * and the proof consumption right behind the update. Any other save commits
 * the same audit row and update behind the live session fence instead, and
 * also only while the settings still have the revision the decision was read
 * at. Unchanged values write nothing.
 */
export async function setMaintenanceSettings(request:Request,viewer:Viewer,input:SetInput):Promise<MaintenanceView>{
 await requireOwner(viewer);
 const {auditDays,jobDays,runAt,timeZone,revision,managementToken}=input;
 if(!validDays(auditDays)||!validDays(jobDays))throw coded('MAINTENANCE_RETENTION_INVALID');
 if(typeof runAt!=='string'||!timePattern.test(runAt))throw coded('MAINTENANCE_TIME_INVALID');
 if(!validTimeZone(timeZone))throw coded('MAINTENANCE_TIME_ZONE_INVALID');
 if(typeof revision!=='number'||!Number.isSafeInteger(revision)||revision<0)throw coded('VALIDATION_FAILED');
 const current=await readMaintenanceSettings(db()),minutes=minutesOf(runAt);
 if(current.auditDays===auditDays&&current.jobDays===jobDays&&current.runAt===minutes&&current.timeZone===timeZone)return view();
 const before=retentionSourceView(current,runtimeEnv()).values;
 // null before is an invalid environment value: the run deletes nothing then, so it counts as no limit.
 if(!maintenanceSetNeedsStepUp(before,{auditDays,jobDays}))return setWithoutProof(request,viewer,{current,before,auditDays,jobDays,runAt,minutes,timeZone,revision});
 const {prepareManagementAuthorization}=await import('./identity/rbac'),proof=await prepareManagementAuthorization(request,viewer,managementToken);
 const target=`Audit ${daysText(before.auditDays)} → ${auditDays} days, jobs ${daysText(before.jobDays)} → ${jobDays} days, daily run ${timeText(current.runAt)} ${current.timeZone} → ${runAt} ${timeZone}`;
 const guard=sql`(${proof.guard}) AND (${viewerCanSql(viewer,'instance.owner')}) AND EXISTS (SELECT 1 FROM maintenance_settings settings_row WHERE settings_row.id=1 AND settings_row.revision=${revision})`;
 // The row is locked first, so parallel saves queue instead of retrying.
 const steps:Step[]=[
  sql`SELECT 1 AS confirmed WHERE ${proof.guard}`,
  sql`SELECT id FROM maintenance_settings WHERE id=1 FOR UPDATE`,
  ...auditEvent({actor:viewer.label,action:maintenanceAuditAction,target,guard}),
 ];
 const update=steps.length;
 steps.push(
  sql`UPDATE maintenance_settings SET audit_days=${auditDays},job_days=${jobDays},run_at=${minutes},time_zone=${timeZone},revision=revision+1,updated_at=${now()},updated_by=${viewer.label} WHERE id=1 AND revision=${revision} AND (${guard})`,
  // Consumed exactly when the update right before it wrote the values.
  {afterChange:sql`DELETE FROM mfa_management_proofs WHERE token_hash=${proof.tokenHash} AND principal=${proof.key} AND session_hash=${proof.sessionHash}`},
 );
 const results=await commitAll(steps);
 if(!results[0].rows.length)throw stepUpExpired();
 if(results[update].rowCount)return view();
 await requireOwner(viewer,true);
 throw coded('MAINTENANCE_SETTINGS_CONFLICT');
}
type CurrentSettings=Awaited<ReturnType<typeof readMaintenanceSettings>>;
// The harmless save: no retention gets shorter. The same audit row and update
// as with a proof, behind the request's live primary and MFA session
// (mfaSessionFence) instead of the proof. The decision was read at
// current.revision; the update needs that revision too, so a save that changed
// the retention in between leaves this one without effect (conflict).
async function setWithoutProof(request:Request,viewer:Viewer,{current,before,auditDays,jobDays,runAt,minutes,timeZone,revision}:{current:CurrentSettings;before:{auditDays:number|null;jobDays:number|null};auditDays:number;jobDays:number;runAt:string;minutes:number;timeZone:string;revision:number}):Promise<MaintenanceView>{
 const fence=await mfaSessionFence(request,viewer);
 const target=`Audit ${daysText(before.auditDays)} → ${auditDays} days, jobs ${daysText(before.jobDays)} → ${jobDays} days, daily run ${timeText(current.runAt)} ${current.timeZone} → ${runAt} ${timeZone}`;
 const guard=sql`(${fence}) AND (${viewerCanSql(viewer,'instance.owner')}) AND EXISTS (SELECT 1 FROM maintenance_settings settings_row WHERE settings_row.id=1 AND settings_row.revision=${revision} AND settings_row.revision=${current.revision})`;
 const steps:Step[]=[
  sql`SELECT id FROM maintenance_settings WHERE id=1 FOR UPDATE`,
  ...auditEvent({actor:viewer.label,action:maintenanceAuditAction,target,guard}),
 ];
 const update=steps.length;
 steps.push(sql`UPDATE maintenance_settings SET audit_days=${auditDays},job_days=${jobDays},run_at=${minutes},time_zone=${timeZone},revision=revision+1,updated_at=${now()},updated_by=${viewer.label} WHERE id=1 AND revision=${revision} AND (${guard})`);
 const results=await commitAll(steps);
 if(results[update].rowCount)return view();
 // The session's own reply first, then a lost Owner right, then the conflict.
 await requireLiveSessions(request,viewer);
 await requireOwner(viewer,true);
 throw coded('MAINTENANCE_SETTINGS_CONFLICT');
}

// Runs started from the page that are still working in this process.
const activeRuns=new Set<Promise<unknown>>();
/** Resolves when every run started with Run now in this process has finished (tests, shutdown). */
export async function settledMaintenanceRuns(){await Promise.all([...activeRuns]);}

/**
 * Run now: checks the migrations, takes the lock and inserts the 'manual' row
 * with the account label and its portal audit row in one transaction, then
 * answers. A refused start (409, 403) writes neither. The run continues in this process;
 * its outcome is in maintenance_runs, and its promise never rejects.
 */
export async function runMaintenanceNow(viewer:Viewer):Promise<{runId:number}>{
 await requireOwner(viewer);
 const started=await startMaintenance(db(),{trigger:'manual',requestedBy:viewer.label,storage:storage(),env:runtimeEnv(),notice:(message:string)=>console.error('ServerDesk: '+message)});
 if(started.status==='migrations-pending')throw coded('MAINTENANCE_MIGRATIONS_PENDING');
 if(started.status!=='started'||!started.finished||typeof started.runId!=='number')throw coded('MAINTENANCE_RUNNING');
 const finished=started.finished;
 activeRuns.add(finished);
 void finished.finally(()=>activeRuns.delete(finished));
 return {runId:started.runId};
}
