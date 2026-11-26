import {commitAll,db,sql,type Sql,type StepResult} from './db';
import {maintenanceStatus} from './maintenance-runs';
import {auditSelect,portalAuditGuard} from './audit-scope';
import {isInternalAccountValue} from '../account-display';
import type {Viewer} from '../types';
import {accountNameSql,accountNamesOf} from './identity/account-names';
import {customerSeparationSql} from '../../runtime/customer-separation.mjs';
import {previousSecretRemovable} from '../../runtime/previous-secret.mjs';
import type {RunbookHistoryRow,RunbookHistoryStep} from './automation/runbook-history';
import {previousNameLimit} from '../device-name';

// Reads and writes of the console route (app/api/console). `scope` is the JSON
// array of the device IDs the viewer sees.
// 1 when scope.<key> of the agent output (lib/server/agent/agent-channel.ts) is truthy as a JS value (true, a
// non-zero number, a non-empty string, an object or array), else 0.
const outputScopeFlag=(key:'security'|'management')=>{
 const value=key==='security'?sql`(o.data::jsonb #> '{scope,security}')`:sql`(o.data::jsonb #> '{scope,management}')`;
 return sql`(CASE WHEN o.data IS JSON OBJECT THEN (CASE jsonb_typeof(${value}) WHEN 'boolean' THEN (CASE WHEN ${value}='true'::jsonb THEN 1 ELSE 0 END) WHEN 'number' THEN (CASE WHEN ${value}<>'0'::jsonb THEN 1 ELSE 0 END) WHEN 'string' THEN (CASE WHEN ${value}<>'""'::jsonb THEN 1 ELSE 0 END) WHEN 'object' THEN 1 WHEN 'array' THEN 1 ELSE 0 END) ELSE 0 END)`;
};
const outputSecurity=outputScopeFlag('security'),outputManagement=outputScopeFlag('management');
export async function consoleJobs(scope:string):Promise<Record<string,unknown>[]>{
 return db().query(sql`SELECT j.id,j.server_id AS "serverId",j.action,j.target,j.state,j.created_at AS "createdAt",j.claimed_at AS "claimedAt",j.not_before AS "notBefore",j.last_progress AS "lastProgress",j.result,j.result_code,j.result_args,coalesce(${accountNameSql(sql`actor_user`,sql`j.actor`)},'') AS actor,j.parameters AS "accessParameters",j.display_input AS "displayInput",${outputSecurity} AS "outputSecurity",${outputManagement} AS "outputManagement",0 AS "scriptOutput" FROM jobs j LEFT JOIN local_users actor_user ON actor_user.auth_email=j.actor_email LEFT JOIN job_outputs o ON o.job_id = j.id AND o.server_id = j.server_id WHERE j.action NOT IN ('runbook-step','list-files','storage-inspect') AND j.server_id IN (SELECT value FROM jsonb_array_elements_text(${scope}::jsonb)) AND (j.state IN ('pending','running') OR j.id IN (SELECT id FROM jobs WHERE action NOT IN ('runbook-step','list-files','storage-inspect') AND server_id IN (SELECT value FROM jsonb_array_elements_text(${scope}::jsonb)) ORDER BY created_at DESC LIMIT 80)) ORDER BY j.created_at DESC`);
}
/**
 * One job of one device with the columns of consoleJobs (accessParameters, displayInput, outputSecurity, outputManagement) and its
 * stored output (data), for the job drawer (lib/server/devices/job-detail.ts); null when it does not exist or is a kind the list hides.
 */
export async function consoleJobRow(serverId:string,jobId:string):Promise<Record<string,unknown>|null>{
 return db().one(sql`SELECT j.id,j.server_id AS "serverId",j.action,j.target,j.state,j.parameters AS "accessParameters",j.display_input AS "displayInput",${outputSecurity} AS "outputSecurity",${outputManagement} AS "outputManagement",0 AS "scriptOutput",o.data AS "outputData" FROM jobs j LEFT JOIN job_outputs o ON o.job_id = j.id AND o.server_id = j.server_id WHERE j.id=${jobId} AND j.server_id=${serverId} AND j.action NOT IN ('runbook-step','list-files','storage-inspect')`);
}
export async function consoleRunbookJobs(scope:string){
 // Parent runs and ordinary jobs have independent history windows. Thirty
 // child steps therefore cannot displace thirty unrelated historical jobs.
 const runs=await db().query<RunbookHistoryRow>(sql`WITH recent AS (SELECT rd.run_id,rd.server_id FROM runbook_run_devices rd JOIN runbook_runs r ON r.id = rd.run_id WHERE rd.server_id IN (SELECT value FROM jsonb_array_elements_text(${scope}::jsonb)) ORDER BY r.created_at DESC LIMIT 80) SELECT rd.run_id AS "runId",rd.server_id AS "serverId",b.name,CASE WHEN v.definition IS JSON OBJECT THEN (SELECT jsonb_build_object('steps',coalesce(jsonb_agg(jsonb_build_object('name',step.value->'name','kind',step.value->'kind') ORDER BY step.ordinality),'[]'::jsonb)) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v.definition::jsonb->'steps')='array' THEN v.definition::jsonb->'steps' ELSE '[]'::jsonb END) WITH ORDINALITY step) ELSE NULL END AS definition,coalesce(${accountNameSql(sql`actor_user`,sql`r.actor`)},'') AS actor,rd.state,r.state AS "runState",r.cancel_requested AS "cancelRequested",rd.step_index AS "stepIndex",r.created_at AS "createdAt",rd.started_at AS "startedAt",rd.finished_at AS "finishedAt",r.finished_at AS "runFinishedAt",rd.job_id AS "jobId",j.state AS "currentJobState" FROM runbook_run_devices rd JOIN runbook_runs r ON r.id = rd.run_id LEFT JOIN local_users actor_user ON actor_user.auth_principal=r.actor LEFT JOIN runbook_versions v ON v.id = r.version_id LEFT JOIN runbooks b ON b.id = v.runbook_id LEFT JOIN jobs j ON j.id = rd.job_id AND j.server_id = rd.server_id WHERE rd.server_id IN (SELECT value FROM jsonb_array_elements_text(${scope}::jsonb)) AND (rd.state IN ('queued','running') OR EXISTS (SELECT 1 FROM recent h WHERE h.run_id = rd.run_id AND h.server_id = rd.server_id)) ORDER BY r.created_at DESC,rd.server_id`);
 if(!runs.length)return {runs,steps:[] as RunbookHistoryStep[]};
 const keys=JSON.stringify(runs.map(r=>`${r.runId}:${r.serverId}`));
 const steps=await db().query<RunbookHistoryStep>(sql`SELECT s.run_id AS "runId",s.server_id AS "serverId",s.step_index AS "stepIndex",coalesce(j.state,s.state) AS state,j.claimed_at AS "claimedAt",j.last_progress AS "lastProgress",s.completed_at AS "completedAt",${outputSecurity} AS "outputSecurity" FROM runbook_step_results s LEFT JOIN jobs j ON j.id = s.job_id AND j.server_id = s.server_id LEFT JOIN job_outputs o ON o.job_id = s.job_id AND o.server_id = s.server_id WHERE (s.run_id || ':' || s.server_id) IN (SELECT value FROM jsonb_array_elements_text(${keys}::jsonb)) ORDER BY s.step_index`);
 return {runs,steps};
}
/** The visible, not removed devices with their customer, group path ("groups" is JSON text), name source and previous names (newest first). */
export async function consoleDevices(scope:string):Promise<Record<string,unknown>[]>{
 return db().query(sql`SELECT s.id,s.name,s.created_at AS "createdAt",s.last_seen AS "lastSeen",s.snapshot,s.revoked,s.management,s.customer_id AS "customerId",c.name AS "customerName",c.status AS "customerStatus",s.description,s.name_source AS "nameSource",
 (SELECT coalesce(jsonb_agg(p.name ORDER BY p.replaced_at DESC,p.name_key),'[]'::jsonb) FROM (SELECT name,name_key,replaced_at FROM device_previous_names WHERE server_id=s.id ORDER BY replaced_at DESC,name_key LIMIT ${previousNameLimit}) p) AS "previousNames",
 (s.last_seen IS NULL AND s.agent_public_key IS NULL) AS "neverConnected",s.token_expires_at AS "registrationExpiresAt",
 (SELECT m.group_id FROM device_group_members m JOIN device_groups g ON g.id=m.group_id WHERE m.server_id=s.id ORDER BY (SELECT MAX(depth) FROM device_group_ancestors WHERE group_id=g.id) DESC,g.name,g.id LIMIT 1) AS "groupId",
 (SELECT g.name FROM device_group_members m JOIN device_groups g ON g.id=m.group_id WHERE m.server_id=s.id ORDER BY (SELECT MAX(depth) FROM device_group_ancestors WHERE group_id=g.id) DESC,g.name,g.id LIMIT 1) AS "groupName",
 (SELECT coalesce(jsonb_agg(jsonb_build_object('id',g.id,'name',g.name,'parentId',g.parent_id,'depth',(SELECT MAX(depth) FROM device_group_ancestors WHERE group_id=g.id),'direct',EXISTS(SELECT 1 FROM device_group_members direct WHERE direct.server_id=s.id AND direct.group_id=g.id))),'[]'::jsonb) FROM device_groups g WHERE EXISTS (SELECT 1 FROM device_group_members m JOIN device_group_ancestors a ON a.group_id=m.group_id WHERE m.server_id=s.id AND a.ancestor_id=g.id)) AS groups
 FROM servers s LEFT JOIN customers c ON c.id=s.customer_id WHERE s.revoked=0 AND s.id IN (SELECT value FROM jsonb_array_elements_text(${scope}::jsonb)) ORDER BY s.name,s.id`);
}
export async function consoleAudit(authorization:Sql,limit:number){return db().query(sql`${auditSelect} WHERE ${authorization} ORDER BY a.at DESC,a.id DESC LIMIT ${limit}`);}
/**
 * The portal audit rows with targetName: the shown name of a target that is an internal account value
 * (isInternalAccountValue), read in one query for all such targets (accountNamesOf); null when the account
 * has no name. Device audit rows never get it, so a device view cannot read account names across customers.
 */
export async function withAuditTargetNames<T extends {target?:unknown}>(rows:T[]):Promise<(T&{targetName?:string|null})[]>{
 const internal=rows.map(row=>String(row.target??'')).filter(isInternalAccountValue);
 if(!internal.length)return rows;
 const names=await accountNamesOf(internal);
 return rows.map(row=>{const target=String(row.target??'');return isInternalAccountValue(target)?{...row,targetName:names.get(target)??null}:row;});
}
/**
 * "Load older entries" of the audit log page: the next `limit` portal audit rows before (at, id), newest first,
 * under the same portalAuditGuard as the console load, with targetName. A viewer without the portal audit right
 * gets an empty list.
 */
export async function consolePortalAuditBefore(viewer:Viewer,at:number,id:number,limit:number){
 return withAuditTargetNames(await db().query(sql`${auditSelect} WHERE ${portalAuditGuard(viewer)} AND (a.at,a.id)<(${at}::bigint,${id}::bigint) ORDER BY a.at DESC,a.id DESC LIMIT ${limit}`));
}
/** The cursor of "Load older entries": "<at>.<id>" with two non-negative safe integers, else null. */
export function auditCursor(value:string|null):{at:number;id:number}|null{
 const match=/^(\d{1,16})\.(\d{1,16})$/.exec(value??'');
 if(!match)return null;
 const at=Number(match[1]),id=Number(match[2]);
 return Number.isSafeInteger(at)&&Number.isSafeInteger(id)?{at,id}:null;
}
export async function pendingAgentUpdates(scope:string){
 return db().query<{server_id:string;state:string;version:string;notBefore:number}>(sql`SELECT server_id,state,target AS version,not_before AS "notBefore" FROM jobs WHERE server_id IN (SELECT value FROM jsonb_array_elements_text(${scope}::jsonb)) AND action = 'agent-update' AND state IN ('pending','running') ORDER BY created_at DESC`);
}
/** The one separation rule (runtime/customer-separation.mjs): once a second customer exists the fleet shows customer names. */
export async function multipleCustomers(){return Number((await db().one<{separated:number}>(sql`SELECT ${customerSeparationSql} AS separated`))?.separated)===1;}

export type Enrollment={id:string;name:string;tokenHash:string;createdAt:number;expiresAt:number;groupId:string|null;customerId:string|null};
/** The customer of an enrollment target before the commit: whether the customer exists and the group's customer (null without a group or for an unknown group). */
export async function enrollmentTarget(customerId:string|null,groupId:string|null):Promise<{customerExists:boolean;groupCustomerId:string|null}>{
 const row=await db().one<{customer:number;group_customer:string|null}>(sql`SELECT ${customerId===null?sql`1`:sql`(SELECT count(*) FROM customers WHERE id=${customerId})`} AS customer,${groupId===null?sql`NULL`:sql`(SELECT customer_id FROM device_groups WHERE id=${groupId})`} AS group_customer`);
 return {customerExists:Number(row?.customer)>0,groupCustomerId:row?.group_customer??null};
}
/**
 * Creates the device row and, with a group, its membership in one transaction.
 * The row belongs to `customerId`, else to the group's customer, else to the
 * column default; the default is only allowed while only the default customer
 * exists (customerSeparationSql in the insert, so a second customer created
 * after the route's pre-check creates no row). A disabled customer and a group of another
 * customer roll the batch back through their triggers. With a proof the first
 * statement reports whether it still held and the last consumes it, only once
 * the device row exists. Returns whether the proof held and the device row's result.
 * The typed name is 'pending' until the first heartbeat compares it with the
 * computer name (lib/server/agent/heartbeat.ts).
 */
export async function enrollDevice(e:Enrollment,authorization:Sql,proof:{guard:Sql;tokenHash:string;key:string;sessionHash:string}|null):Promise<{confirmed:boolean;created:StepResult}>{
 const groupGuard=e.groupId===null?sql`TRUE`:sql`EXISTS (SELECT 1 FROM device_groups WHERE id=${e.groupId})`,proven=proof?proof.guard:sql`TRUE`;
 const customer=e.customerId!==null?sql`${e.customerId}`:e.groupId!==null?sql`(SELECT customer_id FROM device_groups WHERE id=${e.groupId})`:null;
 const enrollment=customer===null
  ?sql`INSERT INTO servers (id,name,name_source,token_hash,created_at,token_expires_at) SELECT ${e.id},${e.name},'pending',${e.tokenHash},${e.createdAt},${e.expiresAt} WHERE ${authorization} AND ${groupGuard} AND (${proven}) AND NOT (${customerSeparationSql})`
  :sql`INSERT INTO servers (id,name,name_source,token_hash,created_at,token_expires_at,customer_id) SELECT ${e.id},${e.name},'pending',${e.tokenHash},${e.createdAt},${e.expiresAt},${customer} WHERE ${authorization} AND ${groupGuard} AND (${proven})`;
 const results=await commitAll([
  ...(proof?[sql`SELECT 1 AS confirmed WHERE ${proof.guard}`]:[]),
  enrollment,
  ...(e.groupId===null?[]:[sql`INSERT INTO device_group_members(server_id,group_id) SELECT id,(SELECT id FROM device_groups WHERE id=${e.groupId}) FROM servers WHERE id=${e.id}`]),
  ...(proof?[sql`DELETE FROM mfa_management_proofs WHERE token_hash=${proof.tokenHash} AND principal=${proof.key} AND session_hash=${proof.sessionHash} AND EXISTS (SELECT 1 FROM servers WHERE id=${e.id})`]:[]),
 ]);
 return {confirmed:!proof||results[0].rows.length>0,created:results[proof?1:0]};
}
/** The Owner notice about the daily maintenance. */
export async function consoleMaintenance(now:number){return maintenanceStatus(db(),now);}
/** True when SESSION_SECRET_PREVIOUS is set but every stored secret uses the current key. Without a previous secret no query runs. */
export async function consolePreviousSecretRemovable(env:{SESSION_SECRET:string;SESSION_SECRET_PREVIOUS:string}){return previousSecretRemovable(db(),env);}
export async function jobById(id:string){return db().one<{server_id:string;action:string;parameters:string}>(sql`SELECT server_id,action,parameters FROM jobs WHERE id = ${id}`);}
/** Cancels a job that has not started; null when it started or the authorization no longer holds. */
export async function cancelPendingJob(id:string,job:{server_id:string;action:string},authorization:Sql){
 return db().one<{server_id:string}>(sql`UPDATE jobs SET state = 'cancelled',parameters = '{}',result = 'serverMessage.job.pendingCancelled' WHERE id = ${id} AND server_id=${job.server_id} AND action=${job.action} AND state = 'pending' AND ${authorization} RETURNING server_id`);
}
