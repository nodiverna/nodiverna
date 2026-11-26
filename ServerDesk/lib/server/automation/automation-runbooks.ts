import {z} from 'zod';
import {guid,HttpError,now} from '../context';
import {devicePermissionGuard,mfaAnchorSql,mfaEnrollmentSql,principal,type SqlGuard} from '../identity/access';
import {featureTargetsGuard} from '../identity/feature-authorization';
import {automationAssignmentActor,automationFingerprint,automationScopeGuard,effectiveAutomationForDevice,effectiveAutomationGuard,scopeTargetVisible} from './automation-scopes';
import {resolveAutomation,type AutomationCandidate,type EffectiveAutomation} from '../../automation-resolution';
import {nextScheduleDue,recurrenceSchema,runbookDefinition} from './runbooks';
import type {Viewer} from '../../types';
import {commitAll,db,sql,type Sql,type StepResult} from '../db';
import {storedReason} from '../../server-messages';

export const scopedRunbookTargetLimit=1000;
const json=(value:unknown)=>JSON.stringify(value);
const payloadSchema=z.object({versionId:z.guid(),parameters:z.record(z.string(),z.union([z.string().max(4096),z.number().finite(),z.boolean()])),recurrence:recurrenceSchema.nullable(),catchupSeconds:z.number().int().min(0).max(86400),concurrency:z.number().int().min(1).max(10),failureStop:z.boolean()}).strict();
type Metadata={effective:string;execution_actor:string;auth_version:number};
const combine=(...guards:SqlGuard[]):SqlGuard=>sql.join(guards.map(g=>sql`(${g})`),sql` AND `);
// An internal column reference such as scope_target.value (names only, never input).
const column=(expression:string):Sql=>sql.join(expression.split('.').map(part=>sql.ident(part)),sql`.`);

// Match resolveAutomation's stable tie-breaker as well as its conflict policy.
// Two equal templates assigned through overlapping peer groups execute once.
function winnerGuard(effective:EffectiveAutomation,expression:string):SqlGuard{
 const guard=effectiveAutomationGuard(effective,'',{serverExpression:expression}),server=column(expression);
 return combine(guard,sql`NOT EXISTS (SELECT 1 FROM automation_scope_assignments peer JOIN automation_templates peer_template ON peer_template.id=peer.template_id AND peer_template.archived=0 WHERE peer.kind=${effective.kind} AND peer.slot=${effective.slot} AND peer.id<${effective.id} AND (CASE WHEN peer.scope_type='device' THEN 5 ELSE (SELECT MAX(depth) FROM device_group_ancestors WHERE group_id=peer.scope_id) END)=(SELECT CASE WHEN original.scope_type='device' THEN 5 ELSE (SELECT MAX(depth) FROM device_group_ancestors WHERE group_id=original.scope_id) END FROM automation_scope_assignments original WHERE original.id=${effective.id}) AND ((peer.scope_type='device' AND peer.scope_id=${server}) OR (peer.scope_type='group' AND EXISTS (SELECT 1 FROM device_group_members pm JOIN device_group_ancestors pg ON pg.group_id=pm.group_id WHERE pm.server_id=${server} AND pg.ancestor_id=peer.scope_id))))`);
}
function approvalGuard(effective:EffectiveAutomation,serverExpression:string):SqlGuard{
 const rights=['runbooks.execute','runbooks.manage'].map(right=>devicePermissionGuard(column(serverExpression),sql`approval_actor.principal`,right as 'runbooks.execute'|'runbooks.manage'));
 return sql`EXISTS (SELECT 1 FROM (SELECT ${effective.actor}::text AS principal) approval_actor JOIN local_users approval_user ON approval_user.auth_principal=approval_actor.principal AND approval_user.status='active' AND approval_user.auth_version=${effective.authVersion} WHERE ${mfaEnrollmentSql(sql`approval_actor.principal`,effective.createdAt)} AND ${combine(...rights)})`;
}

async function targetsFor(effective:EffectiveAutomation){
 // One catalog read resolves the entire fleet; no 1000 per-device schedule or
 // authorization queries are needed to construct a campaign.
 const rows=await db().query<Omit<AutomationCandidate,'payload'|'disabled'>&{serverId:string;payload:string;disabled:number}>(sql`SELECT device.id AS "serverId",a.id,a.kind,a.slot,a.scope_type AS "scopeType",a.scope_id AS "scopeId",a.template_id AS "templateId",t.name AS "templateName",t.payload,a.disabled,a.actor,a.auth_version AS "authVersion",a.created_at AS "createdAt",CASE WHEN a.scope_type='device' THEN 5 ELSE (SELECT MAX(depth) FROM device_group_ancestors WHERE group_id=a.scope_id) END AS priority FROM servers device JOIN automation_scope_assignments a ON a.kind='runbook' AND a.slot=${effective.slot} AND ((a.scope_type='device' AND a.scope_id=device.id) OR (a.scope_type='group' AND EXISTS (SELECT 1 FROM device_group_members m JOIN device_group_ancestors g ON g.group_id=m.group_id WHERE m.server_id=device.id AND g.ancestor_id=a.scope_id))) JOIN automation_templates t ON t.id=a.template_id AND t.archived=0 WHERE device.revoked=0 ORDER BY device.id,a.id`);
 const candidates=new Map<string,AutomationCandidate[]>();
 for(const row of rows){const list=candidates.get(row.serverId)??[];list.push({...row,payload:JSON.parse(row.payload),disabled:!!row.disabled});candidates.set(row.serverId,list);}
 const targets=[...candidates].filter(([,list])=>{const winner=resolveAutomation(list)[0];return winner.id===effective.id&&!winner.conflict&&!winner.disabled;}).map(([id])=>id);
 if(targets.length>scopedRunbookTargetLimit)throw new HttpError('apiError.runbook.scopeTooLarge');
 return targets;
}
async function assignment(id:string){
 const row=await db().one<Omit<EffectiveAutomation,'payload'|'disabled'|'conflict'|'candidateIds'>&{payload:string;disabled:number}>(sql`SELECT a.id,a.kind,a.slot,a.scope_type AS "scopeType",a.scope_id AS "scopeId",a.template_id AS "templateId",t.name AS "templateName",t.payload,a.disabled,a.actor,a.auth_version AS "authVersion",a.created_at AS "createdAt",CASE WHEN a.scope_type='device' THEN 5 ELSE (SELECT MAX(depth) FROM device_group_ancestors WHERE group_id=a.scope_id) END AS priority FROM automation_scope_assignments a JOIN automation_templates t ON t.id=a.template_id AND t.archived=0 WHERE a.id=${id} AND a.kind='runbook'`);
 if(!row)throw new HttpError('apiError.runbook.assignmentGone');
 return {...row,payload:JSON.parse(row.payload),disabled:!!row.disabled,conflict:false,candidateIds:[row.id]} as EffectiveAutomation;
}
async function runId(key:string){const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key))),hex=Array.from(digest,b=>b.toString(16).padStart(2,'0')).join('');return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;}
async function state(effective:EffectiveAutomation,serverId:string,status:string,message:string,resourceId:string|null=null){
 await db().exec(sql`INSERT INTO automation_device_state(server_id,kind,slot,assignment_id,fingerprint,resource_id,status,message,updated_at) SELECT ${serverId},'runbook',${effective.slot},${effective.id},${await automationFingerprint(effective)},${resourceId},${status},${message},${now()} WHERE EXISTS (SELECT 1 FROM servers WHERE id=${serverId} AND revoked=0) ON CONFLICT(server_id,kind,slot) DO UPDATE SET assignment_id=excluded.assignment_id,fingerprint=excluded.fingerprint,resource_id=excluded.resource_id,status=excluded.status,message=excluded.message,updated_at=excluded.updated_at`);
}

async function createCampaign(effective:EffectiveAutomation,actor:Viewer,targets:string[],key:string,expiresAt:number,schedule?:{due:number;next:number}){
 if(!targets.length)throw new HttpError('apiError.runbook.noDevicesForAssignment');
 if(!Number.isSafeInteger(actor.authorization?.authVersion)||!actor.authorization?.authVersion)throw new HttpError('apiError.runbook.activeAccountApproval');
 const payload=payloadSchema.parse(effective.payload),ver=await db().one<{definition:string;version:number;name:string}>(sql`SELECT v.definition,v.version,r.name FROM runbook_versions v JOIN runbooks r ON r.id=v.runbook_id WHERE v.id=${payload.versionId} AND v.runbook_id=${effective.slot} AND r.archived=0`);
 if(!ver)throw new HttpError('apiError.runbook.versionGone');
 const definition=runbookDefinition.parse(JSON.parse(ver.definition));
 if(definition.parameters.some(p=>p.secret&&p.required))throw new HttpError('apiError.runbook.secretsNeedCampaign');
 const keys=new Set(definition.parameters.filter(p=>!p.secret).map(p=>p.name));
 if(Object.keys(payload.parameters).some(name=>!keys.has(name)))throw new HttpError('apiError.runbook.parametersMismatch');
 for(const p of definition.parameters){if(p.secret)continue;if(p.required&&payload.parameters[p.name]===undefined||payload.parameters[p.name]!==undefined&&typeof payload.parameters[p.name]!==p.type)throw new HttpError('apiError.runbook.checkParameterConflict',{name:p.name});}
 const d=db(),at=now(),id=await runId(key),token=crypto.randomUUID(),targetJson=json(targets),winner=winnerGuard(effective,'scope_target.value'),approval=approvalGuard(effective,'scope_target.value'),allDevices=winnerGuard(effective,'scope_device.id'),caller=featureTargetsGuard(actor,targets,['runbooks.execute','runbooks.manage']);
 // Exactly this membership is frozen at commit. Concurrent additions/removals,
 // overrides, conflicting peer scopes, password resets or RBAC changes cause a
 // no-op transaction; an automatic retry recomputes the targets from scratch.
 const guard=combine(caller,mfaEnrollmentSql(sql`${principal(actor)}`,at),sql`NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(${targetJson}::jsonb) scope_target WHERE NOT ((${winner}) AND (${approval}))) AND NOT EXISTS (SELECT 1 FROM servers scope_device WHERE scope_device.revoked=0 AND (${allDevices}) AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(${targetJson}::jsonb) frozen_target WHERE frozen_target.value=scope_device.id))`);
 const scheduled=schedule?sql`EXISTS (SELECT 1 FROM automation_runbook_schedules WHERE assignment_id=${effective.id} AND next_due=${schedule.due})`:sql`TRUE`;
 const statements=[
  sql`INSERT INTO runbook_runs(id,version_id,due_key,actor,parameters,concurrency,failure_stop,created_at,expires_at) SELECT ${id},${payload.versionId},${key},${principal(actor)},${json(payload.parameters)},${payload.concurrency},${payload.failureStop?1:0},${at},${expiresAt} WHERE EXISTS (SELECT 1 FROM runbook_versions v JOIN runbooks r ON r.id=v.runbook_id WHERE v.id=${payload.versionId} AND v.runbook_id=${effective.slot} AND r.archived=0) AND (${guard}) AND (${scheduled}) ON CONFLICT DO NOTHING`,
  // Only when the run row above was inserted now (replaces a changed-rows check).
  {afterChange:sql`INSERT INTO automation_runbook_runs(run_id,assignment_id,effective,execution_actor,auth_version,creation_token) SELECT ${id},${effective.id},${json(effective)},${principal(actor)},${actor.authorization?.authVersion??0},${token} WHERE EXISTS (SELECT 1 FROM runbook_runs WHERE id=${id}) ON CONFLICT DO NOTHING`},
  sql`INSERT INTO runbook_run_devices(run_id,server_id,sealed_secrets) SELECT ${id},value,'{}' FROM jsonb_array_elements_text(${targetJson}::jsonb) WHERE EXISTS (SELECT 1 FROM automation_runbook_runs WHERE run_id=${id} AND creation_token=${token}) ON CONFLICT DO NOTHING`,
  // One device audit row per frozen target, guarded by this call's creation
  // token: a deduplicated retry or a second tick for the same due writes none,
  // and a failing audit insert rolls the whole campaign back.
  sql`INSERT INTO audit (at,actor,action,target,server_id,scope) SELECT ${at},${schedule?'System':actor.label},${schedule?'Runbook-Zuweisung per Zeitplan gestartet':'Runbook über Zuweisung gestartet'},${`${ver.name} / v${ver.version} / ${id}`},server_id,'device' FROM runbook_run_devices WHERE run_id=${id} AND EXISTS (SELECT 1 FROM automation_runbook_runs WHERE run_id=${id} AND creation_token=${token})`,
  ...(schedule?[sql`UPDATE automation_runbook_schedules SET next_due=${schedule.next},last_due=${schedule.due} WHERE assignment_id=${effective.id} AND next_due=${schedule.due} AND EXISTS (SELECT 1 FROM automation_runbook_runs WHERE run_id=${id} AND assignment_id=${effective.id})`]:[])
 ];
 // The batch is atomic, so any failure here (audit, storage, ...) means
 // nothing was started. Keep the cause in the server log only.
 let results:StepResult[];
 try{results=await commitAll(statements);}catch(error){console.error('Runbook campaign batch failed:',error instanceof Error?error.message:error);throw new HttpError('apiError.runbook.campaignNotStarted');}
 if(!results[0].rowCount){const existing=await d.one<{run_id:string}>(sql`SELECT run_id FROM automation_runbook_runs WHERE run_id=${id} AND assignment_id=${effective.id}`);if(existing)return {id,targets:targets.length,deduplicated:true};throw new HttpError('apiError.runbook.assignmentChanged');}
 return {id,targets:targets.length,deduplicated:false};
}

// Caller must be admitted with requireMfa by the API. This explicit operation is
// also how recurrence:null templates are run; assigning them never runs scripts.
export async function startAutomationRun(viewer:Viewer,input:Record<string,unknown>){
 if(input.confirm!==true||!guid(input.assignmentId))throw new HttpError('apiError.runbook.selectAndConfirm');
 if(input.requestId!==undefined&&!guid(input.requestId))throw new HttpError('apiError.request.invalidRequestId');
 const effective=await assignment(input.assignmentId);
 // A target outside the viewer's customers answers like an unknown assignment.
 if(!await scopeTargetVisible(viewer,effective.scopeType,effective.scopeId))throw new HttpError('apiError.runbook.assignmentGone');
 const scope=automationScopeGuard(viewer,effective.scopeType,effective.scopeId,['runbooks.execute','runbooks.manage']);
 if(!await db().one(sql`SELECT 1 WHERE ${scope}`))throw new HttpError('apiError.runbook.manageRightsMissing');
 // The MFA anchor: an mfa_accounts row, or an account from Microsoft Entra ID (lib/server/identity/access.ts).
 if(!await db().one(sql`SELECT 1 AS anchored WHERE ${mfaAnchorSql(sql`${principal(viewer)}`)}`))throw new HttpError('apiError.mfa.setupRequired');
 const targets=await targetsFor(effective);
 return createCampaign(effective,viewer,targets,`scope-manual:${effective.id}:${principal(viewer)}:${input.requestId??crypto.randomUUID()}`,now()+86400000);
}

export async function tickScopedRunbooks(serverId:string){
 const effective=(await effectiveAutomationForDevice(serverId,'runbook')).slice(0,20);
 for(const item of effective){
  if(item.disabled||item.conflict){await state(item,serverId,item.conflict?'conflict':'disabled',item.conflict?'serverMessage.automation.conflictShort':'serverMessage.automation.paused');continue;}
  try{
   const payload=payloadSchema.parse(item.payload);if(!payload.recurrence)continue;
   const actor=await automationAssignmentActor(item,serverId);if(!actor){await state(item,serverId,'blocked','serverMessage.automation.approvalInvalid');continue;}
   const next=nextScheduleDue(item.createdAt,payload.recurrence),initial=winnerGuard(item,'schedule_device.id');
   await db().exec(sql`INSERT INTO automation_runbook_schedules(assignment_id,next_due,created_at) SELECT ${item.id},${next},${item.createdAt} WHERE EXISTS (SELECT 1 FROM servers schedule_device WHERE schedule_device.id=${serverId} AND (${initial})) ON CONFLICT DO NOTHING`);
   const schedule=await db().one<{next_due:number}>(sql`SELECT next_due FROM automation_runbook_schedules WHERE assignment_id=${item.id}`);if(!schedule)continue;
   const at=now(),due=schedule.next_due;if(due>at)continue;
   const nextDue=nextScheduleDue(Math.max(at,due),payload.recurrence,true);
   if(at-due>Math.max(30000,payload.catchupSeconds*1000)){
    await db().exec(sql`UPDATE automation_runbook_schedules SET next_due=${nextDue},last_due=${due} WHERE assignment_id=${item.id} AND next_due=${due}`);await state(item,serverId,'skipped','serverMessage.automation.catchupExpired');continue;
   }
   const targets=await targetsFor(item),result=await createCampaign(item,actor,targets,`scope:${item.id}:${due}`,due+Math.max(30,payload.catchupSeconds)*1000,{due,next:nextDue});
   await state(item,serverId,'scheduled','serverMessage.automation.scheduleStarted',result.id);
  }catch(error){if(!(error instanceof HttpError||error instanceof z.ZodError))throw error;await state(item,serverId,'blocked',error instanceof HttpError?storedReason(error):'serverMessage.automation.invalidSchedule');}
 }
}

export async function scopedRunbookGuard(runId:string,serverId:string,options?:{serverExpression:string}):Promise<SqlGuard>{
 const row=await db().one<Metadata>(sql`SELECT effective,execution_actor,auth_version FROM automation_runbook_runs WHERE run_id=${runId}`);if(!row)return sql`TRUE`;
 let effective:EffectiveAutomation;try{effective=JSON.parse(row.effective);if(effective.kind!=='runbook'||!guid(effective.id)||effective.disabled||effective.conflict)throw new Error('Invalid approval');}catch{return sql`FALSE`;}
 const expression=options?.serverExpression??'execution_target.id';
 const winner=winnerGuard(effective,expression),approval=approvalGuard(effective,expression),executionRights=['runbooks.manage','runbooks.execute'].map(p=>devicePermissionGuard(column(expression),sql`execution_user.auth_principal`,p as 'runbooks.manage'|'runbooks.execute'));
 // A manually confirmed campaign may have a different executor from the scope
 // author. Resetting either MFA enrollment invalidates its existing approval.
 const guard=combine(winner,approval,sql`EXISTS (SELECT 1 FROM local_users execution_user JOIN runbook_runs execution_campaign ON execution_campaign.id=${runId} WHERE ${mfaEnrollmentSql(sql`execution_user.auth_principal`,sql`execution_campaign.created_at`)} AND execution_user.auth_principal=${row.execution_actor} AND execution_user.status='active' AND execution_user.auth_version=${row.auth_version} AND ${combine(...executionRights)})`);
 return options?guard:sql`EXISTS (SELECT 1 FROM servers execution_target WHERE execution_target.id=${serverId} AND (${guard}))`;
}

// Apply the same live approval at the final agent job claim and delivery checks.
export async function scopedRunbookClaimGuard(jobId:string,serverId:string,runId:unknown):Promise<SqlGuard>{
 if(!guid(runId))return sql`FALSE`;
 const scope=await scopedRunbookGuard(runId,serverId,{serverExpression:'jobs.server_id'});
 return combine(scope,sql`EXISTS (SELECT 1 FROM runbook_run_devices claimed_device JOIN runbook_runs claimed_run ON claimed_run.id=claimed_device.run_id WHERE claimed_device.run_id=${runId} AND claimed_device.server_id=jobs.server_id AND claimed_device.job_id=${jobId} AND claimed_device.state='running' AND claimed_run.state IN ('queued','running') AND claimed_run.cancel_requested=0)`);
}
