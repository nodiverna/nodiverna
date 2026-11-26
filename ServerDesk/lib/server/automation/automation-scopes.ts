import {z} from 'zod';
import {guid,hash,HttpError,log,now} from '../context';
import type {ApiErrorKey} from '../../errors/api-error-keys';
import type {ApiErrorParams} from '../../errors/http-error';
import {allowedDeviceIds,customerAccessGuard,devicePermissionGuard,groupPermissionGuard,mfaEnrollmentSql,principal,requireDevice,resolvePrincipal,type Permission,type SqlGuard} from '../identity/access';
import {catalogCommit,catalogOwner,catalogOwnership,catalogSeparated,catalogVisibleGuard,catalogWriteFailure,catalogWriteGuard} from '../catalog-ownership';
import {deviceCustomerId} from '../identity/customers';
import {featureDeviceGuard,featureWriteGuard} from '../identity/feature-authorization';
import {canSql,viewerCanSql} from '../identity/policy/can';
import {driftPolicySchema,type DriftPolicy,type DriftEntry} from './drift';
import {isMfaEnabled} from '../identity/mfa';
import {recurrenceSchema} from './runbooks';
import {resolveAutomation,type AutomationCandidate,type AutomationKind,type EffectiveAutomation} from '../../automation-resolution';
import type {Viewer} from '../../types';
import {db,sql} from '../db';

const kinds=z.enum(['drift','desired','runbook']);
const permissions:Record<AutomationKind,Permission[]>={drift:['drift.manage'],desired:['desired.manage'],runbook:['runbooks.manage','runbooks.execute']};
const nameSchema=z.string().trim().min(1).max(120);
type TemplateRow={id:string;kind:AutomationKind;slot:string;name:string;payload:string;created_by:string;created_at:number;archived:number;customer_id:string|null};
const parse=(value:string)=>JSON.parse(value) as Record<string,unknown>;
const fail=(key:ApiErrorKey,params?:ApiErrorParams):never=>{throw new HttpError(key,params);};

// Session-bound on purpose: the Owner right and the viewer's session stamp, in one query.
async function currentOwner(v:Viewer){const guard=viewerCanSql(v,'instance.owner');return !!await db().one(sql`SELECT 1 WHERE ${guard}`);}
async function template(v:Viewer,id:unknown){
 if(!guid(id))fail('apiError.automation.selectTemplate');
 // A template of a customer the viewer does not see answers like an unknown one.
 const row=await db().one<TemplateRow>(sql`SELECT * FROM automation_templates WHERE id=${id as string} AND archived=0 AND ${catalogVisibleGuard(sql`customer_id`,sql`${principal(v)}`)}`);
 if(!row)throw new HttpError('apiError.automation.templateGone');
 if(row.created_by!==principal(v)&&!await currentOwner(v)){
  if(row.kind==='drift')throw new HttpError('apiError.automation.driftTemplateAssign');
  const right=row.kind==='runbook'?'runbooks.read':row.kind==='desired'?'desired.read':'drift.read';
  if(!(await allowedDeviceIds(v,right)).length)throw new HttpError('apiError.automation.templateUnavailable');
 }
 return row;
}
function templateAssignmentGuard(v:Viewer,row:TemplateRow):SqlGuard{
 const owner=canSql(sql`template_actor.principal`,'instance.owner');
 return featureWriteGuard(v,sql`EXISTS (SELECT 1 FROM (SELECT ${principal(v)}::text AS principal) template_actor JOIN automation_templates t ON t.id=${row.id} AND t.kind=${row.kind} AND t.payload=${row.payload} AND t.archived=0 WHERE t.kind<>'drift' OR t.created_by=template_actor.principal OR (${owner}))`);
}
function templatePermissions(row:TemplateRow):Permission[]{
 const rights=[...permissions[row.kind]],payload=parse(row.payload);
 if(row.kind==='drift'){const p=payload.policy as DriftPolicy;if(p?.includeConfigValues||p?.paths?.some(x=>x.includeText)||p?.registry?.some(x=>x.includeValues))rights.push('drift.contents');}
 if(row.kind==='desired'&&Number(payload.intervalSeconds)>0)rights.push('desired.apply');
 return rights;
}
export function automationScopeGuard(v:Viewer,scopeType:'group'|'device',scopeId:string,rights:Permission[]):SqlGuard{
 const actor=principal(v),guards=rights.map(permission=>devicePermissionGuard(sql`scope_device.id`,sql`scope_actor.principal`,permission));
 const all=(list:SqlGuard[])=>sql.join(list.map(g=>sql`(${g})`),sql` AND `);
 if(scopeType==='device')return featureWriteGuard(v,sql`EXISTS (SELECT 1 FROM (SELECT ${actor}::text AS principal) scope_actor JOIN servers scope_device ON scope_device.id=${scopeId} AND scope_device.revoked=0 WHERE ${all(guards)})`);
 const groupRights=rights.map(permission=>groupPermissionGuard(sql`scope_group.id`,sql`scope_actor.principal`,permission));
 return featureWriteGuard(v,sql`EXISTS (SELECT 1 FROM (SELECT ${actor}::text AS principal) scope_actor JOIN device_groups scope_group ON scope_group.id=${scopeId} WHERE ${all(groupRights)} AND NOT EXISTS (SELECT 1 FROM servers scope_device WHERE scope_device.revoked=0 AND EXISTS (SELECT 1 FROM device_group_members sm JOIN device_group_ancestors sa ON sa.group_id=sm.group_id WHERE sm.server_id=scope_device.id AND sa.ancestor_id=scope_group.id) AND NOT (${all(guards)})))`);
}
/** The group or device of an assignment exists and lies within the viewer's customer boundary (revoked devices included). */
export async function scopeTargetVisible(v:Viewer,type:'group'|'device',id:string){const table=sql.ident(type==='group'?'device_groups':'servers'),boundary=customerAccessGuard(sql`scope_target.customer_id`,sql`${principal(v)}`);return !!await db().one(sql`SELECT 1 AS visible FROM ${table} scope_target WHERE scope_target.id=${id} AND ${boundary}`);}
async function requireScope(v:Viewer,type:'group'|'device',id:string,rights:Permission[]){const guard=automationScopeGuard(v,type,id,rights);if(!await db().one(sql`SELECT 1 WHERE ${guard}`))throw new HttpError('apiError.automation.scopeRightsMissing');return guard;}

export async function createAutomationTemplate(v:Viewer,input:Record<string,unknown>){
 const kind=kinds.parse(input.kind),name=nameSchema.parse(input.name);let payload:Record<string,unknown>,slot='default',sourceGuard:SqlGuard=sql`TRUE`,owner:string|null;
 if(!(await allowedDeviceIds(v,permissions[kind][0])).length&&!await currentOwner(v))throw new HttpError('apiError.automation.rightsRequired');
 if(kind==='drift'){
  const sourceServerId=z.guid().parse(input.sourceServerId);
  await requireDevice(v,sourceServerId,'drift.manage');
  // A drift baseline holds data of its reference device: once separated it
  // always belongs to that device's customer, also when an Owner creates it.
  owner=await catalogSeparated()?await deviceCustomerId(sourceServerId):null;
  if(input.customerId!==undefined&&(input.customerId===null?null:typeof input.customerId==='string'?input.customerId.toLowerCase():'')!==owner)fail('apiError.catalog.driftTemplateCustomer');
  const source=await db().one<{id:string;version:number;policy:string}>(sql`SELECT id,version,policy FROM drift_policies WHERE server_id=${sourceServerId}`);
  if(!source)throw new HttpError('apiError.automation.referenceSources');
  // A source policy saved before the current schema limits (e.g. exclude
  // bounds) is reported like in ingestDrift, not as an unhandled error.
  const stored=driftPolicySchema.safeParse({...parse(source.policy),enabled:true});if(!stored.success)throw new HttpError('apiError.drift.policyNeedsFix');const policy=stored.data;
  const contents=policy.includeConfigValues||policy.paths.some(p=>p.includeText)||policy.registry.some(r=>r.includeValues);
  if(contents)await requireDevice(v,sourceServerId,'drift.contents');
  let baseline:DriftEntry[]|null=null,sourceReportId:string|null=null;
  if(input.includeBaseline!==false){
   const report=await db().one<{id:string;entries:string}>(sql`SELECT id,entries FROM drift_reports WHERE server_id=${sourceServerId} AND policy_version=${source.version} AND complete=1 ORDER BY received_at DESC,id DESC LIMIT 1`);
   if(!report)throw new HttpError('apiError.automation.baselineNeedsScan');
   baseline=JSON.parse(report.entries);sourceReportId=report.id;
  }
  payload={policy,baseline,sourceServerId,sourceReportId};
  const rights=featureDeviceGuard(v,sourceServerId,contents?['drift.manage','drift.contents']:['drift.manage']);
  sourceGuard=sql`(${rights}) AND EXISTS (SELECT 1 FROM drift_policies WHERE server_id=${sourceServerId} AND id=${source.id} AND version=${source.version} AND policy=${source.policy})${sourceReportId?sql` AND EXISTS (SELECT 1 FROM drift_reports WHERE id=${sourceReportId} AND server_id=${sourceServerId} AND policy_version=${source.version} AND complete=1 AND entries=${JSON.stringify(baseline)})`:sql``}${owner?sql` AND EXISTS (SELECT 1 FROM servers WHERE id=${sourceServerId} AND customer_id=${owner})`:sql``}`;
 }else if(kind==='desired'){
  owner=await catalogOwner(v,input.customerId);
  if(!guid(input.versionId))fail('apiError.automation.selectConfigVersion');
  const version=await db().one(sql`SELECT v.id FROM desired_versions v JOIN desired_configs c ON c.id=v.config_id WHERE v.id=${input.versionId as string} AND c.archived=0`);if(!version)throw new HttpError('apiError.automation.configVersionUnavailable');
  const interval=z.union([z.literal(0),z.number().int().min(900).max(86400)]).parse(input.intervalSeconds??0);
  payload={versionId:input.versionId,intervalSeconds:interval};
 }else{
  owner=await catalogOwner(v,input.customerId);
  if(!guid(input.versionId))fail('apiError.automation.selectRunbookVersion');
  const version=await db().one<{id:string;runbook_id:string;definition:string;customer_id:string|null}>(sql`SELECT v.id,v.runbook_id,v.definition,r.customer_id FROM runbook_versions v JOIN runbooks r ON r.id=v.runbook_id WHERE v.id=${input.versionId as string} AND r.archived=0 AND ${catalogVisibleGuard(sql`r.customer_id`,sql`${principal(v)}`)}`);if(!version)throw new HttpError('apiError.automation.runbookVersionUnavailable');
  // A library template uses library runbooks only, a customer template also its own.
  if(version.customer_id!==null&&version.customer_id!==owner)fail('apiError.catalog.templateRunbookCustomer');
  const definition=JSON.parse(version.definition);if(definition.parameters.some((p:{secret:boolean;required:boolean})=>p.secret&&p.required))fail('apiError.automation.secretsNeedCampaign');
  const params=z.record(z.string(),z.union([z.string().max(4096),z.number().finite(),z.boolean()])).parse(input.parameters??{});
  if(Object.keys(params).some(key=>!definition.parameters.some((p:{name:string;secret:boolean})=>p.name===key&&!p.secret)))fail('apiError.automation.unknownOrSecretParameter');
  for(const p of definition.parameters as {name:string;type:string;secret:boolean;required:boolean;default?:unknown}[]){if(p.secret)continue;if(params[p.name]===undefined&&p.default!==undefined)params[p.name]=p.default as string|number|boolean;if(p.required&&params[p.name]===undefined||params[p.name]!==undefined&&typeof params[p.name]!==p.type)fail('apiError.automation.checkParameter',{name:p.name});}
  payload={versionId:input.versionId,parameters:params,recurrence:input.recurrence?recurrenceSchema.parse(input.recurrence):null,catchupSeconds:z.number().int().min(0).max(86400).parse(input.catchupSeconds??3600),concurrency:z.number().int().min(1).max(10).parse(input.concurrency??2),failureStop:z.boolean().parse(input.failureStop??true)};slot=version.runbook_id;
 }
 const id=crypto.randomUUID(),at=now(),globalOwner=canSql(sql`template_actor.principal`,'instance.owner'),management=devicePermissionGuard(sql`template_device.id`,sql`template_actor.principal`,permissions[kind][0]);
 const authorization=featureWriteGuard(v,sql`EXISTS (SELECT 1 FROM (SELECT ${principal(v)}::text AS principal) template_actor WHERE (${globalOwner}) OR EXISTS (SELECT 1 FROM servers template_device WHERE ${management}))`),ownerRule=catalogWriteGuard(v,owner);
 const saved=await catalogCommit(()=>db().exec(sql`INSERT INTO automation_templates(id,kind,slot,name,payload,created_by,created_at,customer_id) SELECT ${id},${kind},${slot},${name},${JSON.stringify(payload)},${principal(v)},${at},${owner} WHERE ${authorization} AND ${sourceGuard} AND ${ownerRule}`),'apiError.catalog.templateRunbookCustomer');
 if(!saved.rowCount)throw await catalogWriteFailure(v,owner)??new HttpError('apiError.automation.approvalChanged');
 await log(v.label,'Automatisierungsvorlage erstellt',name);return {id};
}

/**
 * The stored audit target of an assignment ("{template} · Gruppe" or "· Gerät"). Stored rows keep this German text;
 * the audit log shows the scope in the viewer's language (ui/devices/history/audit-display.ts auditTargetView).
 */
export const automationAssignmentAuditTarget=(name:string,scopeType:'group'|'device')=>name+(scopeType==='group'?' · Gruppe':' · Gerät');
export async function assignAutomationScope(v:Viewer,input:Record<string,unknown>){
 if(input.confirm!==true)fail('apiError.automation.confirmAssignment');
 const row=await template(v,input.templateId),scopeType=z.enum(['group','device']).parse(input.scopeType),scopeId=z.guid().parse(input.scopeId),disabled=z.boolean().parse(input.disabled??false);
 const scopeAuthorization=await requireScope(v,scopeType,scopeId,templatePermissions(row)),catalogAuthorization=templateAssignmentGuard(v,row);
 // A customer template hangs only on groups and devices of its customer; 0034 enforces the same at the commit.
 if(row.customer_id!==null&&await db().one<{"customer_id":string}>(sql`SELECT customer_id FROM ${scopeType==='group'?sql`device_groups`:sql`servers`} WHERE id=${scopeId}`).then(row=>row===null?null:row.customer_id)!==row.customer_id)fail('apiError.customer.templateScope');
 const authorization=sql`(${scopeAuthorization}) AND (${catalogAuthorization})`;
 const actor=principal(v),user=await db().one<{auth_version:number}>(sql`SELECT auth_version FROM local_users WHERE auth_principal=${actor} AND status='active'`);if(!user)throw new HttpError('apiError.automation.activeAccountRequired');
 const version=v.authorization?.authVersion??user.auth_version,id=crypto.randomUUID(),at=now();
 const saved=await catalogCommit(()=>db().one<{id:string}>(sql`INSERT INTO automation_scope_assignments(id,kind,slot,scope_type,scope_id,template_id,disabled,actor,auth_version,created_at) SELECT ${id},${row.kind},${row.slot},${scopeType},${scopeId},${row.id},${disabled?1:0},${actor},${version},${at} WHERE ${authorization} AND EXISTS (SELECT 1 FROM automation_templates WHERE id=${row.id} AND archived=0) ON CONFLICT(kind,slot,scope_type,scope_id) DO UPDATE SET id=excluded.id,template_id=excluded.template_id,disabled=excluded.disabled,actor=excluded.actor,auth_version=excluded.auth_version,created_at=excluded.created_at RETURNING id`),'apiError.customer.templateScope');
 if(!saved)throw new HttpError('apiError.automation.scopeChanged');
 await log(v.label,disabled?'Geerbte Automatisierung ausgesetzt':'Automatisierung zugewiesen',automationAssignmentAuditTarget(row.name,scopeType),scopeType==='device'?scopeId:undefined);return {id:saved.id};
}
export async function removeAutomationScope(v:Viewer,input:Record<string,unknown>){
 if(!guid(input.assignmentId)||input.confirm!==true)fail('apiError.automation.selectAndConfirmRemoval');
 const row=await db().one<TemplateRow&{scope_type:'group'|'device';scope_id:string}>(sql`SELECT a.*,t.payload FROM automation_scope_assignments a JOIN automation_templates t ON t.id=a.template_id WHERE a.id=${input.assignmentId as string}`);
 // An unknown id and one whose target lies outside the viewer's customers (or is gone) answer alike.
 if(!row||!await scopeTargetVisible(v,row.scope_type,row.scope_id))throw new HttpError('apiError.catalog.assignmentGone');
 const authorization=await requireScope(v,row.scope_type,row.scope_id,templatePermissions(row));
 const saved=await db().exec(sql`DELETE FROM automation_scope_assignments WHERE id=${input.assignmentId as string} AND ${authorization}`);if(!saved.rowCount)throw new HttpError('apiError.automation.assignmentChanged');
 await log(v.label,'Automatisierungszuweisung entfernt',String(input.assignmentId),row.scope_type==='device'?row.scope_id:undefined);return {ok:true};
}

export async function effectiveAutomationForDevice(serverId:string,kind?:AutomationKind):Promise<EffectiveAutomation[]>{
 const rows=await db().query<Omit<AutomationCandidate,'payload'|'disabled'>&{payload:string;disabled:number}>(sql`SELECT a.id,a.kind,a.slot,a.scope_type AS "scopeType",a.scope_id AS "scopeId",a.template_id AS "templateId",t.name AS "templateName",t.payload,a.disabled,a.actor,a.auth_version AS "authVersion",a.created_at AS "createdAt",CASE WHEN a.scope_type='device' THEN 5 ELSE (SELECT MAX(depth) FROM device_group_ancestors WHERE group_id=a.scope_id) END AS priority FROM automation_scope_assignments a JOIN automation_templates t ON t.id=a.template_id AND t.archived=0 WHERE (${kind??''}='' OR a.kind=${kind??''}) AND EXISTS (SELECT 1 FROM servers WHERE id=${serverId} AND revoked=0) AND ((a.scope_type='device' AND a.scope_id=${serverId}) OR (a.scope_type='group' AND EXISTS (SELECT 1 FROM device_group_members m JOIN device_group_ancestors g ON g.group_id=m.group_id WHERE m.server_id=${serverId} AND g.ancestor_id=a.scope_id))) ORDER BY a.kind,a.slot,a.id`).then(results=>({results}));
 return resolveAutomation(rows.results.map(row=>({...row,payload:parse(row.payload),disabled:!!row.disabled})));
}
export async function automationAssignmentActor(effective:EffectiveAutomation,serverId:string){
 if(effective.conflict||effective.disabled)return null;
 const actor=await resolvePrincipal(effective.actor);if(!actor||actor.authorization?.authVersion!==effective.authVersion||!await isMfaEnabled(actor))return null;
 const approval=await db().one(sql`SELECT 1 AS enrolled WHERE ${mfaEnrollmentSql(sql`${effective.actor}`,effective.createdAt)}`);if(!approval)return null;
 const row={kind:effective.kind,payload:JSON.stringify(effective.payload)} as TemplateRow;
 try{for(const right of templatePermissions(row))await requireDevice(actor,serverId,right);}catch{return null;}
 return actor;
}
export async function automationFingerprint(effective:EffectiveAutomation){return hash(JSON.stringify([effective.id,effective.templateId,effective.payload,effective.actor,effective.authVersion,effective.disabled,effective.conflict,effective.candidateIds]));}

// Bind the exact resolved assignment at the write boundary. This also rejects
// a more specific choice or a conflicting membership created during validation.
export function effectiveAutomationGuard(effective:EffectiveAutomation,serverId:string,options?:{serverExpression:string}):SqlGuard{
 if(options&&!/^[a-z_][a-z0-9_]*\.(?:value|id|server_id)$/.test(options.serverExpression))throw new Error('Invalid internal server expression');
 const expression=options?sql.join(options.serverExpression.split('.').map(part=>sql.ident(part)),sql`.`):sql`${serverId}`;
 return sql`EXISTS (WITH candidates AS (
 SELECT a.*,CASE WHEN a.scope_type='device' THEN 5 ELSE (SELECT MAX(depth) FROM device_group_ancestors WHERE group_id=a.scope_id) END AS priority
 FROM automation_scope_assignments a JOIN automation_templates t ON t.id=a.template_id AND t.archived=0
 WHERE a.kind=${effective.kind} AND a.slot=${effective.slot} AND ((a.scope_type='device' AND a.scope_id=${expression}) OR (a.scope_type='group' AND EXISTS (SELECT 1 FROM device_group_members m JOIN device_group_ancestors g ON g.group_id=m.group_id WHERE m.server_id=${expression} AND g.ancestor_id=a.scope_id)))
 ) SELECT 1 FROM candidates candidate WHERE candidate.id=${effective.id} AND candidate.template_id=${effective.templateId} AND candidate.actor=${effective.actor} AND candidate.auth_version=${effective.authVersion} AND candidate.disabled=0
 AND EXISTS (SELECT 1 FROM servers WHERE id=${expression} AND revoked=0)
 AND EXISTS (SELECT 1 FROM local_users approval_user WHERE approval_user.auth_principal=candidate.actor AND approval_user.status='active' AND approval_user.auth_version=candidate.auth_version AND ${mfaEnrollmentSql(sql`approval_user.auth_principal`,sql`candidate.created_at`)})
 AND NOT EXISTS (SELECT 1 FROM candidates other WHERE other.priority>candidate.priority OR (other.priority=candidate.priority AND (other.disabled<>candidate.disabled OR other.template_id<>candidate.template_id))))`;
}

/**
 * The automation catalog of the viewer: templates, assignments, groups and device states. A runbook assignment
 * carries nextDue, the cursor of its recurrence (automation_runbook_schedules), or null before the first
 * evaluation; the other kinds carry null.
 */
export async function listAutomationScopes(v:Viewer){
 const owner=await currentOwner(v),actor=principal(v),visible=await allowedDeviceIds(v,'view'),d=db(),catalog=await catalogOwnership(v);
 const groups=(await d.query<{id:string;name:string;parentId:string|null;depth:number;customerId:string}>(sql`SELECT id,name,parent_id AS "parentId",(SELECT MAX(depth) FROM device_group_ancestors a WHERE a.group_id=g.id) AS depth,customer_id AS "customerId" FROM device_groups g ORDER BY name,id`));
 const allowedGroups=new Set<string>();for(const kind of ['drift','desired','runbook'] as const){const guard=groupPermissionGuard(sql`g.id`,sql`${actor}`,permissions[kind][0]);for(const row of await d.query<{id:string}>(sql`SELECT id FROM device_groups g WHERE ${guard}`))allowedGroups.add(row.id);}
 // Templates of customers the viewer does not see are left out; Owners see every customer.
 const visibleTemplate=catalogVisibleGuard(sql`t.customer_id`,sql`${actor}`),templates=(await d.query<TemplateRow&{customer_name:string|null}>(sql`SELECT t.*,c.name AS customer_name FROM automation_templates t LEFT JOIN customers c ON c.id=t.customer_id WHERE t.archived=0 AND ${visibleTemplate} ORDER BY t.created_at DESC,t.id LIMIT 500`)).filter(t=>owner||t.created_by===actor||(visible.length&&t.kind!=='drift'));
 const assignments=(await d.query<Record<string,unknown>>(sql`SELECT a.*,t.name AS "templateName",s.next_due AS "nextDue" FROM automation_scope_assignments a JOIN automation_templates t ON t.id=a.template_id LEFT JOIN automation_runbook_schedules s ON s.assignment_id=a.id ORDER BY a.created_at DESC,a.id`)).filter(a=>owner||a.scope_type==='device'&&visible.includes(String(a.scope_id))||a.scope_type==='group'&&allowedGroups.has(String(a.scope_id)));
 const states=visible.length?(await d.query(sql`SELECT server_id AS "serverId",kind,slot,assignment_id AS "assignmentId",status,message,updated_at AS "updatedAt" FROM automation_device_state WHERE server_id IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(visible)}::jsonb)) ORDER BY server_id,kind,slot`)):[];
 return {catalog,templates:templates.map(t=>{const payload=parse(t.payload);return {id:t.id,kind:t.kind,slot:t.slot,name:t.name,createdAt:t.created_at,customerId:t.customer_id,customerName:t.customer_id===null?null:t.customer_name,payload:{...payload,...(t.kind==='drift'?{baseline:undefined,hasBaseline:Array.isArray(payload.baseline)}:{})}};}),assignments:assignments.map(a=>({id:a.id,kind:a.kind,slot:a.slot,scopeType:a.scope_type,scopeId:a.scope_id,templateId:a.template_id,templateName:a.templateName,disabled:!!a.disabled,createdAt:a.created_at,nextDue:a.kind==='runbook'&&a.nextDue!=null?Number(a.nextDue):null})),groups:groups.filter(g=>owner||allowedGroups.has(g.id)),states};
}
