import {jobDisplayInput} from '../../job-input';
import {featureTargetsGuard,featureWriteGuard} from '../identity/feature-authorization';
import {z} from 'zod';
import {now,guid,HttpError,log} from '../context';
import type {ApiErrorKey} from '../../errors/api-error-keys';
import type {ApiErrorParams} from '../../errors/http-error';
import {requireDevice,allowedDeviceIds,principal,resolvePrincipal,devicePermissionGuard,anyDevicePermissionGuard,customerAccessGuard,globalPermissionGuard,hasGlobalPermission} from '../identity/access';
import {can,canSql} from '../identity/policy/can';
import {catalogCommit,catalogOwner,catalogOwnership,catalogVisibleGuard,catalogWriteFailure,catalogWriteGuard,requireCatalogWrite,requireSameCatalogOwner} from '../catalog-ownership';
import {sealAgentSecrets} from '../agent/agent-crypto';
import {operations} from '../../management';
import {diagnosisOperations} from '../../jobs/runbook-step';
import {isMfaEnabled} from '../identity/mfa';
import {serverMessage,type ServerMessage,messageFields} from '../../server-messages';
import {authorizeTargetCustomers,customerEntries,recheckCrossCustomer,singleCustomerTargets,targetCustomers} from '../identity/cross-customer';
import {agentResultFields} from '../../agent-messages';
import type {ServerSnapshot,Viewer} from '../../types';
import {commitAll,db,sql} from '../db';

const identifier=z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/).refine(v=>!['__proto__','constructor','prototype'].includes(v),'Reservierter Name.');
const parameter=z.object({name:identifier,type:z.enum(['string','number','boolean']),required:z.boolean().default(false),secret:z.boolean().default(false),default:z.union([z.string().max(4096),z.number().finite(),z.boolean()]).optional()}).strict().superRefine((v,c)=>{if(v.secret&&(v.type!=='string'||v.default!==undefined))c.addIssue({code:'custom',message:'Secret-Parameter müssen Strings ohne Standardwert sein.'});if(v.default!==undefined&&typeof v.default!==v.type)c.addIssue({code:'custom',message:'Standardwert hat einen anderen Typ.'});});
const preconditions=z.object({osFamily:z.enum(['server','windows11']).optional(),domainJoined:z.boolean().optional(),rebootPending:z.boolean().optional()}).strict();
const step=z.object({id:identifier,name:z.string().trim().min(1).max(120),kind:z.enum(['powershell','diagnosis']),script:z.string().min(1).max(32768).optional(),operation:z.enum(diagnosisOperations).optional(),operationParameters:z.record(z.string(),z.unknown()).default({}),timeoutSeconds:z.number().int().min(5).max(3600).default(300),preconditions:preconditions.optional()}).strict().superRefine((v,c)=>{
 if(v.kind==='powershell'&&(!v.script||v.operation))c.addIssue({code:'custom',message:'PowerShell-Schritt benötigt ausschließlich ein Script.'});
 if(v.kind==='diagnosis'){if(v.script||!v.operation)c.addIssue({code:'custom',message:'Diagnoseschritt benötigt eine feste Diagnoseoperation.'});else if(!operations[v.operation].schema.safeParse(v.operationParameters).success)c.addIssue({code:'custom',message:'Ungültige Diagnoseparameter.'});}
});
export const runbookDefinition=z.object({steps:z.array(step).min(1).max(30),parameters:z.array(parameter).max(30).default([])}).strict().superRefine((v,c)=>{for(const key of ['steps','parameters'] as const){const ids=v[key].map(x=>'id'in x?x.id:x.name);if(new Set(ids).size!==ids.length)c.addIssue({code:'custom',message:'Schritte und Parameter benötigen eindeutige Namen.'});}});
export type RunbookDefinition=z.infer<typeof runbookDefinition>;
export const recurrenceSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('interval'),minutes:z.number().int().min(5).max(10080)}).strict(),
 z.object({kind:z.literal('daily'),timeZone:z.string().min(1).max(80),hour:z.number().int().min(0).max(23),minute:z.number().int().min(0).max(59),weekdays:z.array(z.number().int().min(0).max(6)).min(1).max(7).default([0,1,2,3,4,5,6])}).strict()
]);
type Recurrence=z.infer<typeof recurrenceSchema>;
type VersionRow={id:string;runbook_id:string;version:number;definition:string;name:string;description:string;customer_id:string|null};
type DeviceRun={run_id:string;server_id:string;state:string;step_index:number;job_id:string|null;sealed_secrets:string;result:string|null;started_at:number|null};
const json=(value:unknown)=>JSON.stringify(value);
const parse=<T>(value:string):T=>JSON.parse(value) as T;
const fail=(key:ApiErrorKey,params?:ApiErrorParams):never=>{throw new HttpError(key,params);};
// Internal expression-based guards re-evaluate current user, group membership,
// assignment scope and role permissions in the statement that commits work.
function catalogGuard(v:Viewer,runbookId?:string){
 const owner=canSql(sql`authorization_actor.principal`,'instance.owner'),manage=anyDevicePermissionGuard(sql`authorization_actor.principal`,'runbooks.manage'),operator=globalPermissionGuard(sql`authorization_actor.principal`,'portal.operator');
 return featureWriteGuard(v,sql`EXISTS (SELECT 1 FROM (SELECT ${principal(v)}::text AS principal) authorization_actor WHERE (${owner}) OR (((${manage}) OR (${operator}))${runbookId?sql` AND EXISTS (SELECT 1 FROM runbooks WHERE id=${runbookId} AND created_by=authorization_actor.principal)`:sql``}))`);
}
const timeFormatters=new Map<string,Intl.DateTimeFormat>();
function wall(time:number,timeZone:string){let formatter=timeFormatters.get(timeZone);if(!formatter){formatter=new Intl.DateTimeFormat('en-US',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',weekday:'short',hourCycle:'h23'});if(timeFormatters.size>=32)timeFormatters.delete(timeFormatters.keys().next().value!);timeFormatters.set(timeZone,formatter);}const parts=formatter.formatToParts(new Date(time)),p=Object.fromEntries(parts.map(x=>[x.type,x.value]));return {date:`${p.year}-${p.month}-${p.day}`,year:Number(p.year),month:Number(p.month),day:Number(p.day),hour:Number(p.hour),minute:Number(p.minute),weekday:['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(p.weekday)};}
// Resolve each local calendar occurrence against observed UTC offsets. Missing
// spring-transition times are skipped; autumn folds execute once per local date.
export function nextScheduleDue(after:number,recurrence:Recurrence,afterOccurrence=false){
 if(recurrence.kind==='interval')return after+recurrence.minutes*60000;
 let local:ReturnType<typeof wall>;try{local=wall(after,recurrence.timeZone);}catch{throw new HttpError('apiError.runbook.invalidTimeZone');}
 const skipDate=afterOccurrence?local.date:local.hour*60+local.minute>=recurrence.hour*60+recurrence.minute?local.date:null;
 const firstDate=Date.UTC(local.year,local.month-1,local.day);
 for(let day=0;day<9;day++){
  const date=new Date(firstDate+day*86400000),year=date.getUTCFullYear(),month=date.getUTCMonth()+1,dateNumber=date.getUTCDate(),dateKey=`${year}-${String(month).padStart(2,'0')}-${String(dateNumber).padStart(2,'0')}`;
  if(dateKey===skipDate||!recurrence.weekdays.includes(date.getUTCDay()))continue;
  const nominal=Date.UTC(year,month-1,dateNumber,recurrence.hour,recurrence.minute),offsets=new Set<number>();
  for(const delta of [-172800000,-43200000,0,43200000,172800000]){const stamp=nominal+delta,c=wall(stamp,recurrence.timeZone);offsets.add(Date.UTC(c.year,c.month-1,c.day,c.hour,c.minute)-Math.floor(stamp/60000)*60000);}
  const candidates=[...offsets].map(offset=>nominal-offset).filter(at=>{if(at<=after)return false;const c=wall(at,recurrence.timeZone);return c.date===dateKey&&c.hour===recurrence.hour&&c.minute===recurrence.minute;}).sort((a,b)=>a-b);
  if(candidates.length)return candidates[0];
 }
 throw new HttpError('apiError.runbook.nextRunUnknown');
}
function snapshotOf(row:{snapshot:string|null}):ServerSnapshot|null{try{return row.snapshot?parse<ServerSnapshot>(row.snapshot):null;}catch{return null;}}
function preconditionErrors(s:ServerSnapshot|null,conditions:z.infer<typeof preconditions>|undefined){
 const errors:ServerMessage[]=[];if(!conditions)return errors;if(!s)return [serverMessage('serverMessage.runbook.preconditionInventory')];
 if(conditions.osFamily==='server'&&!/Windows Server/i.test(s.os)||conditions.osFamily==='windows11'&&!/Windows 11/i.test(s.os))errors.push(serverMessage('serverMessage.runbook.preconditionOs'));
 if(conditions.domainJoined!==undefined&&s.security?.domainJoined!==conditions.domainJoined)errors.push(serverMessage('serverMessage.runbook.preconditionDomain'));
 if(conditions.rebootPending!==undefined&&s.rebootPending!==conditions.rebootPending)errors.push(serverMessage('serverMessage.runbook.preconditionReboot'));return errors;
}
// With a viewer, only versions of runbooks it sees; others answer
// like an unknown id. The agent tick passes none: the run was admitted already.
async function version(id:string,v?:Viewer){if(!guid(id))fail('apiError.runbook.invalidVersion');const visible=v?sql` AND ${catalogVisibleGuard(sql`r.customer_id`,sql`${principal(v)}`)}`:sql``;const row=await db().one<VersionRow>(sql`SELECT v.*,r.name,r.description,r.customer_id FROM runbook_versions v JOIN runbooks r ON r.id = v.runbook_id WHERE v.id = ${id} AND r.archived = 0${visible}`);if(!row)throw new HttpError('apiError.runbook.versionNotFound');return {...row,definition:parse<RunbookDefinition>(row.definition)};}
// A customer runbook runs only on devices of its customer; library runbooks anywhere.
async function requireRunbookTargets(customerId:string|null,targets:string[]){
 if(customerId===null)return;
 const foreign=await db().one(sql`SELECT 1 AS foreign_target FROM jsonb_array_elements_text(${json(targets)}::jsonb) target WHERE NOT EXISTS (SELECT 1 FROM servers device WHERE device.id=target.value AND device.customer_id=${customerId}) LIMIT 1`);
 if(foreign)fail('apiError.catalog.runbookCustomerTargets');
}
// The same rule in the committing statement: the version's runbook is active and
// every target belongs to its customer. Placeholders: version id, targets.
const runnableVersion=(versionId:string,targets:string[])=>sql`EXISTS (SELECT 1 FROM runbook_versions v JOIN runbooks r ON r.id = v.runbook_id WHERE v.id = ${versionId} AND r.archived = 0 AND (r.customer_id IS NULL OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(${json(targets)}::jsonb) run_target WHERE NOT EXISTS (SELECT 1 FROM servers run_device WHERE run_device.id = run_target.value AND run_device.customer_id = r.customer_id))))`;
function argumentsFor(definition:RunbookDefinition,raw:unknown,secretRaw:unknown){
 const regular=z.record(z.string(),z.union([z.string().max(4096),z.number().finite(),z.boolean()])).safeParse(raw??{}),secret=z.record(z.string(),z.string().max(4096)).safeParse(secretRaw??{});
 if(!regular.success||!secret.success)fail('apiError.runbook.invalidParameters');const params=regular.data!,secrets=secret.data!,names=new Set(definition.parameters.map(p=>p.name));
 if([...Object.keys(params),...Object.keys(secrets)].some(k=>!names.has(k)))fail('apiError.runbook.unknownParameter');
 for(const p of definition.parameters){if(p.secret){if(Object.hasOwn(params,p.name))fail('apiError.runbook.secretSeparate');if(p.required&&!secrets[p.name])fail('apiError.runbook.secretMissing',{name:p.name});}else{if(Object.hasOwn(secrets,p.name))fail('apiError.runbook.normalNotSecret');if(params[p.name]===undefined&&p.default!==undefined)params[p.name]=p.default;if(params[p.name]===undefined){if(p.required)fail('apiError.runbook.parameterMissing',{name:p.name});}else if(typeof params[p.name]!==p.type)fail('apiError.runbook.parameterType',{name:p.name});}}
 return {parameters:params,secrets};
}
export async function previewRun(v:Viewer,p:Record<string,unknown>){
 const ver=await version(String(p.versionId??''),v),targets=z.array(z.guid()).min(1).max(100).safeParse(p.targets);if(!targets.success)fail('apiError.runbook.selectDevices');
 const ids=[...new Set(targets.data!)],args=argumentsFor(ver.definition,p.parameters,p.secrets),rows=[];
 for(const id of ids){const s=await requireDevice(v,id,'runbooks.execute'),snapshot=snapshotOf(s);rows.push({serverId:id,name:s.name,online:!!s.last_seen&&now()-s.last_seen<120000,mode:snapshot?.mode??(s.management?'Management':'ReadOnly'),steps:ver.definition.steps.map(x=>({id:x.id,name:x.name,kind:x.kind,timeoutSeconds:x.timeoutSeconds})),preconditionErrors:ver.definition.steps.flatMap(x=>preconditionErrors(snapshot,x.preconditions))});}
 await requireRunbookTargets(ver.customer_id,ids);
 // Cross-customer: the gate runs here without writing, so its error shows before the confirmation.
 const customers=await authorizeTargetCustomers(v,ids);
 const custom=ver.definition.steps.some(x=>x.kind==='powershell');return {version:ver.id,targets:rows,warnings:[...(customers.crossCustomer?[serverMessage('serverMessage.runbook.crossCustomerWarning',{customers:customers.customers.length})]:[]),...(custom?[serverMessage('serverMessage.runbook.powershellWarning')]:[]),...(rows.some(x=>!x.online)?[serverMessage('serverMessage.runbook.offlineWarning')]:[])],parameters:args.parameters,secretParameterNames:Object.keys(args.secrets)};
}
async function prepare(v:Viewer,p:Record<string,unknown>){
 const ver=await version(String(p.versionId??''),v),targetParse=z.array(z.guid()).min(1).max(100).safeParse(p.targets);if(!targetParse.success)fail('apiError.runbook.selectDevices');
 const targets=[...new Set(targetParse.data!)],args=argumentsFor(ver.definition,p.parameters,p.secrets),sealed:Record<string,unknown>={};
 const concurrency=z.number().int().min(1).max(10).safeParse(p.concurrency??1);if(!concurrency.success)fail('apiError.runbook.parallelism');
 const failureStop=p.failureStop??true;if(typeof failureStop!=='boolean')fail('apiError.runbook.invalidFailureStrategy');
 for(const id of targets){const device=await requireDevice(v,id,'runbooks.execute'),snapshot=snapshotOf(device);
  if(snapshot?.protocolVersion!==3||!snapshot?.agentCapabilities?.includes('runbook-step'))throw new HttpError('apiError.runbook.agentV3Required');
  if(ver.definition.steps.some(x=>x.kind==='powershell')&&(!device.management||snapshot.mode!=='Management'))throw new HttpError('apiError.runbook.scriptsNeedManagement');
  if(Object.keys(args.secrets).length)sealed[id]=await sealAgentSecrets(args.secrets,snapshot?.publicKey);
 }
 await requireRunbookTargets(ver.customer_id,targets);
 return {ver,targets,parameters:args.parameters,sealed,concurrency:concurrency.data!,failureStop:failureStop as boolean};
}
export async function createRunbookVersion(v:Viewer,p:Record<string,unknown>){
 const name=z.string().trim().min(1).max(120).safeParse(p.name),description=z.string().max(2000).safeParse(p.description??''),definition=runbookDefinition.safeParse(p.definition);
 if(!name.success||!description.success||!definition.success)fail('apiError.runbook.invalidDefinition');
 const instanceOwner=await can(v,'instance.owner'),allowed=await allowedDeviceIds(v,'runbooks.manage');if(!instanceOwner&&!allowed.length&&!await hasGlobalPermission(v,'portal.operator'))throw new HttpError('apiError.runbook.manageRightMissing');
 const id=typeof p.runbookId==='string'?p.runbookId:crypto.randomUUID();if(!guid(id))fail('apiError.runbook.invalid');
 // A runbook of a customer the viewer does not see answers like an unknown one.
 const current=await db().one<{id:string;created_by:string;customer_id:string|null}>(sql`SELECT id,created_by,customer_id FROM runbooks WHERE id = ${id} AND archived = 0 AND ${catalogVisibleGuard(sql`customer_id`,sql`${principal(v)}`)}`);
 if(p.runbookId&&!current)throw new HttpError('apiError.runbook.notFound');
 // Creation is workspace-wide, but editing another author's catalog entry is admin-only.
 if(current&&!instanceOwner&&current.created_by!==principal(v))throw new HttpError('apiError.runbook.versionCreatorOnly');
 let customerId:string|null;
 if(current){requireSameCatalogOwner(p.customerId,current.customer_id);customerId=current.customer_id;await requireCatalogWrite(v,customerId);}
 else customerId=await catalogOwner(v,p.customerId);
 const at=now(),versionId=crypto.randomUUID(),actor=principal(v);
 const catalog=catalogGuard(v,current?id:undefined),owner=catalogWriteGuard(v,customerId),authorization=sql`(${catalog}) AND (${owner})`;
 const result=await catalogCommit(()=>commitAll([current?sql`UPDATE runbooks SET name = ${name.data!},description = ${description.data!} WHERE id = ${id} AND archived = 0 AND customer_id IS NOT DISTINCT FROM ${customerId} AND ${authorization}`:sql`INSERT INTO runbooks (id,name,description,created_at,created_by,customer_id) SELECT ${id},${name.data!},${description.data!},${at},${actor},${customerId} WHERE ${authorization}`,sql`INSERT INTO runbook_versions (id,runbook_id,version,definition,created_at,created_by) SELECT ${versionId}, ${id},COALESCE((SELECT max(version) FROM runbook_versions WHERE runbook_id = ${id}),0)+1,${json(definition.data)},${at},${actor} WHERE EXISTS (SELECT 1 FROM runbooks WHERE id = ${id} AND archived = 0 AND customer_id IS NOT DISTINCT FROM ${customerId}) AND ${authorization}`]));
 if(!result[1].rowCount)throw await catalogWriteFailure(v,customerId)??new HttpError('apiError.runbook.changed');
 await log(v.label,'Runbook-Version erstellt',id);return {id,versionId};
}
export async function startRun(v:Viewer,p:Record<string,unknown>){
 if(p.confirm!==true)fail('apiError.runbook.confirmRun');const x=await prepare(v,p),id=crypto.randomUUID(),at=now();
 const requestId=p.requestId;if(requestId!==undefined&&!guid(requestId))fail('apiError.request.invalidRequestId');const dueKey=requestId?`manual:${principal(v)}:${requestId}`:null,authorization=featureTargetsGuard(v,x.targets,['runbooks.execute']);
 // Cross-customer: gate after the per-device checks, its guard in the run, one customer entry per customer in the same batch.
 const customers=await authorizeTargetCustomers(v,x.targets);
 const result=await commitAll([sql`INSERT INTO runbook_runs (id,version_id,due_key,actor,parameters,concurrency,failure_stop,created_at,expires_at) SELECT ${id},${x.ver.id},${dueKey},${principal(v)},${json(x.parameters)},${x.concurrency},${x.failureStop?1:0},${at},${at+86400000} WHERE ${runnableVersion(x.ver.id,x.targets)} AND ${authorization} AND ${customers.guard}`,...x.targets.map(serverId=>sql`INSERT INTO runbook_run_devices (run_id,server_id,sealed_secrets) SELECT ${id},${serverId},${json(x.sealed[serverId]??{})} WHERE EXISTS (SELECT 1 FROM runbook_runs WHERE id = ${id})`),
  ...customerEntries(customers,{actor:v.label,action:'Runbook kundenübergreifend gestartet',target:`${x.ver.name} / v${x.ver.version} / ${id}`,condition:sql`EXISTS (SELECT 1 FROM runbook_runs WHERE id = ${id})`})]);
 if(!result[0].rowCount){await recheckCrossCustomer(v,customers);throw new HttpError('apiError.runbook.targetRemoved');}
 await log(v.label,'Runbook gestartet',`${x.ver.name} / v${x.ver.version} / ${id}`,x.targets);return {id};
}
export async function createSchedule(v:Viewer,p:Record<string,unknown>){
 if(p.confirm!==true)fail('apiError.runbook.confirmSchedule');const x=await prepare(v,p);for(const target of x.targets)await requireDevice(v,target,'runbooks.manage');
 // A schedule serves one customer, also for Owners: it would keep acting after the right ended.
 if((await targetCustomers(x.targets)).length>1)fail('apiError.crossCustomer.schedule');
 const rec=recurrenceSchema.safeParse(p.recurrence),catchup=z.number().int().min(0).max(86400).safeParse(p.catchupSeconds??21600);if(!rec.success||!catchup.success)fail('apiError.runbook.invalidSchedule');
 const at=now(),start=z.number().int().min(at-60000).max(at+366*86400000).safeParse(p.startAt??at);if(!start.success)fail('apiError.runbook.invalidStart');
 const nextDue=nextScheduleDue(start.data!,rec.data!),id=crypto.randomUUID(),authorization=featureTargetsGuard(v,x.targets,['runbooks.execute','runbooks.manage']);
 const result=await db().exec(sql`INSERT INTO runbook_schedules (id,version_id,actor,targets,parameters,sealed_secrets,recurrence,next_due,catchup_seconds,concurrency,failure_stop,approved_at,created_at) SELECT ${id},${x.ver.id},${principal(v)},${json(x.targets)},${json(x.parameters)},${json(x.sealed)},${json(rec.data)},${nextDue},${catchup.data!},${x.concurrency},${x.failureStop?1:0},${at},${at} WHERE ${runnableVersion(x.ver.id,x.targets)} AND ${authorization} AND ${singleCustomerTargets(x.targets)}`);
 if(!result.rowCount)throw new HttpError('apiError.runbook.targetRemoved');
 await log(v.label,'Runbook-Zeitplan mit MFA freigegeben',`${x.ver.name} / v${x.ver.version} / ${id}`,x.targets);return {id,nextDue};
}
// Targets inside the viewer's customer boundary, revoked devices included. A run
// or schedule without such a target answers like an unknown id.
async function visibleTargetCount(v:Viewer,targets:string[]){const boundary=customerAccessGuard(sql`device.customer_id`,sql`${principal(v)}`);return Number((await db().one<{n:number}>(sql`SELECT count(*) AS n FROM jsonb_array_elements_text(${json(targets)}::jsonb) target WHERE EXISTS (SELECT 1 FROM servers device WHERE device.id = target.value AND ${boundary})`))?.n??0);}
export async function cancelRun(v:Viewer,id:string){
 if(!guid(id))fail('apiError.runbook.invalidRun');const d=db(),targets=await d.query<{server_id:string}>(sql`SELECT server_id FROM runbook_run_devices WHERE run_id = ${id}`).then(results=>({results}));
 const visible=targets.results.length?await visibleTargetCount(v,targets.results.map(t=>t.server_id)):0;if(!visible)throw new HttpError('apiError.runbook.runNotFound');if(visible<targets.results.length)throw new HttpError('apiError.catalog.runCancelPartial');
 for(const t of targets.results)await requireDevice(v,t.server_id,'runbooks.execute');
 const right=devicePermissionGuard(sql`active_target.server_id`,sql`cancel_actor.principal`,'runbooks.execute'),authorization=featureWriteGuard(v,sql`EXISTS (SELECT 1 FROM (SELECT ${principal(v)}::text AS principal) cancel_actor WHERE NOT EXISTS (SELECT 1 FROM runbook_run_devices active_target WHERE active_target.run_id=${id} AND NOT (${right})))`);
 const results=await commitAll([sql`UPDATE runbook_runs SET cancel_requested = 1 WHERE id = ${id} AND state IN ('queued','running') AND ${authorization}`,sql`UPDATE jobs SET state = 'cancelled',parameters = '{}',result = 'serverMessage.runbook.cancelled' WHERE state = 'pending' AND id IN (SELECT job_id FROM runbook_run_devices WHERE run_id = ${id}) AND ${authorization}`,sql`UPDATE runbook_run_devices SET state = 'cancelled',finished_at = ${now()} WHERE run_id = ${id} AND state = 'queued' AND job_id IS NULL AND ${authorization}`,sql`UPDATE runbook_run_devices SET state = 'cancelled',finished_at = ${now()},result = 'serverMessage.runbook.stepCancelled',result_code = NULL,result_args = NULL,sealed_secrets = '{}' WHERE run_id = ${id} AND state = 'running' AND job_id IN (SELECT id FROM jobs WHERE state = 'cancelled') AND ${authorization}`]);
 if(!results[0].rowCount&&!await d.one(sql`SELECT 1 AS allowed WHERE ${authorization}`))throw new HttpError('apiError.runbook.executeRightsChanged');
 await finishRuns([id]);await log(v.label,'Runbook-Abbruch angefordert',id,targets.results.map(t=>t.server_id));return {ok:true,...messageFields('serverMessage.runbook.cancelRequested')};
}
export async function cancelSchedule(v:Viewer,id:string){
 if(!guid(id))fail('apiError.runbook.invalidSchedule');const s=await db().one<{targets:string}>(sql`SELECT targets FROM runbook_schedules WHERE id = ${id}`),scheduled=s?parse<string[]>(s.targets):[];
 const visible=scheduled.length?await visibleTargetCount(v,scheduled):0;if(!s||!visible)throw new HttpError('apiError.runbook.scheduleNotFound');if(visible<scheduled.length)throw new HttpError('apiError.catalog.scheduleCancelPartial');
 for(const serverId of parse<string[]>(s.targets))await requireDevice(v,serverId,'runbooks.manage');
 const authorization=featureTargetsGuard(v,parse<string[]>(s.targets),['runbooks.manage']);const changed=await db().exec(sql`UPDATE runbook_schedules SET enabled = 0 WHERE id = ${id} AND targets=${s.targets} AND ${authorization}`);if(!changed.rowCount)throw new HttpError('apiError.runbook.scheduleChanged');await log(v.label,'Runbook-Zeitplan deaktiviert',id,parse<string[]>(s.targets));return {ok:true};
}
export async function deleteRunbook(v:Viewer,p:Record<string,unknown>){
 if(p.confirm!==true)fail('apiError.runbook.confirmDelete');const id=typeof p.runbookId==='string'?p.runbookId:'';if(!guid(id))fail('apiError.runbook.invalid');
 const d=db(),entry=await d.one<{created_by:string;archived:number;customer_id:string|null}>(sql`SELECT created_by,archived,customer_id FROM runbooks WHERE id = ${id} AND ${catalogVisibleGuard(sql`customer_id`,sql`${principal(v)}`)}`);if(!entry)throw new HttpError('apiError.runbook.notFound');
 const instanceOwner=await can(v,'instance.owner'),managed=instanceOwner?[]:await allowedDeviceIds(v,'runbooks.manage'),portalOperator=await hasGlobalPermission(v,'portal.operator');
 if(!instanceOwner&&(entry.created_by!==principal(v)||!managed.length&&!portalOperator))throw new HttpError('apiError.runbook.deleteCreatorOnly');
 await requireCatalogWrite(v,entry.customer_id);
 const affected=sql`SELECT t.value AS server_id FROM runbook_schedules s JOIN runbook_versions v ON v.id = s.version_id CROSS JOIN LATERAL jsonb_array_elements_text(s.targets::jsonb) t JOIN servers device ON device.id = t.value WHERE v.runbook_id = ${id} AND s.enabled = 1 AND device.revoked = 0 UNION SELECT rd.server_id FROM runbook_run_devices rd JOIN runbook_runs r ON r.id = rd.run_id JOIN runbook_versions v ON v.id = r.version_id JOIN servers device ON device.id = rd.server_id WHERE v.runbook_id = ${id} AND r.state IN ('queued','running') AND rd.state IN ('queued','running') AND device.revoked = 0`;
 if(!instanceOwner&&await d.one(sql`SELECT 1 AS outside FROM (${affected}) active WHERE active.server_id NOT IN (SELECT jsonb_array_elements_text(${json(managed)}::jsonb)) LIMIT 1`))throw new HttpError('apiError.runbook.deleteActiveRights');
 const catalog=catalogGuard(v,id),owner=catalogWriteGuard(v,entry.customer_id),liveGrant=devicePermissionGuard(sql`active.server_id`,sql`deletion_actor.principal`,'runbooks.manage');
 const guard=sql`(${catalog}) AND (${owner}) AND EXISTS (SELECT 1 FROM (SELECT ${principal(v)}::text AS principal) deletion_actor WHERE NOT EXISTS (SELECT 1 FROM (${affected}) active WHERE NOT (${liveGrant})))`;
 const at=now(),versions=sql`SELECT id FROM runbook_versions WHERE runbook_id = ${id}`,runs=sql`SELECT id FROM runbook_runs WHERE version_id IN (${versions})`;
 // The tombstone and cancellation are one transaction. Claimed Windows actions
 // keep their actual state; only work that has not been claimed is cancelled.
 const results=await commitAll([
  sql`SELECT server_id FROM (${affected}) affected_device`,
  sql`UPDATE runbooks SET archived = 1 WHERE id = ${id} AND ${guard}`,
  sql`UPDATE runbook_schedules SET enabled = 0,parameters = '{}',sealed_secrets = '{}' WHERE version_id IN (${versions}) AND ${guard}`,
  sql`UPDATE runbook_runs SET cancel_requested = 1,parameters = '{}' WHERE version_id IN (${versions}) AND state IN ('queued','running') AND ${guard}`,
  sql`UPDATE jobs SET state = 'cancelled',parameters = '{}',result = 'serverMessage.runbook.deletedStepCancelled' WHERE state = 'pending' AND id IN (SELECT job_id FROM runbook_run_devices WHERE run_id IN (${runs})) AND ${guard}`,
  sql`UPDATE runbook_run_devices SET state = 'cancelled',finished_at = ${at},result = 'serverMessage.runbook.deletedRunStopped',result_code = NULL,result_args = NULL WHERE run_id IN (${runs}) AND (state = 'queued' AND job_id IS NULL OR state = 'running' AND job_id IN (SELECT id FROM jobs WHERE state = 'cancelled')) AND ${guard}`,
  sql`UPDATE runbook_run_devices SET sealed_secrets = '{}' WHERE run_id IN (${runs}) AND ${guard}`,
  sql`UPDATE runbook_step_results SET state = 'cancelled',completed_at = ${at},result = 'serverMessage.runbook.deletedStepCancelled' WHERE run_id IN (${runs}) AND job_id IN (SELECT id FROM jobs WHERE state = 'cancelled') AND state IN ('pending','running') AND ${guard}`
 ]);
 if(!results[1].rowCount)throw await catalogWriteFailure(v,entry.customer_id)??new HttpError('apiError.runbook.approvalChanged');
 const active=await d.query<{id:string}>(sql`SELECT id FROM runbook_runs WHERE version_id IN (${versions}) AND state IN ('queued','running')`);await finishRuns(active.map(x=>x.id));
 const claimed=await d.one<{n:number}>(sql`SELECT count(*) AS n FROM jobs WHERE state = 'running' AND id IN (SELECT job_id FROM runbook_run_devices WHERE run_id IN (${runs}))`);
 const affectedDevices=(results[0].rows as {server_id:string}[]).map(r=>r.server_id);
 if(!entry.archived)await log(v.label,'Runbook gelöscht',id,affectedDevices.length?affectedDevices:undefined);
 return {ok:true,runningSteps:claimed?.n??0,...messageFields('serverMessage.runbook.deletedNotice')};
}
async function scheduleTick(serverId:string){
 const d=db(),at=now(),schedules=await d.query<{id:string;version_id:string;actor:string;targets:string;parameters:string;sealed_secrets:string;recurrence:string;next_due:number;catchup_seconds:number;concurrency:number;failure_stop:number}>(sql`SELECT * FROM runbook_schedules WHERE enabled = 1 AND next_due <= ${at} AND version_id IN (SELECT v.id FROM runbook_versions v JOIN runbooks r ON r.id = v.runbook_id WHERE r.archived = 0) AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(targets::jsonb) schedule_target WHERE schedule_target.value = ${serverId}) ORDER BY next_due LIMIT 10`).then(results=>({results}));
 for(const s of schedules.results){const actor=await resolvePrincipal(s.actor),targets=parse<string[]>(s.targets),rec=parse<Recurrence>(s.recurrence),due=s.next_due;
  // Schedules serve one customer. One over several (direct SQL or older data) starts nothing and is switched off.
  if((await targetCustomers(targets)).length>1){const changed=await d.exec(sql`UPDATE runbook_schedules SET enabled = 0 WHERE id = ${s.id} AND targets = ${s.targets} AND enabled = 1`);if(changed.rowCount)await log('System','Runbook-Zeitplan über mehrere Kunden deaktiviert',s.id,targets);continue;}
  let revoked=!actor||!!actor&&!await isMfaEnabled(actor);if(actor)for(const target of targets){try{await requireDevice(actor,target,'runbooks.execute');}catch{revoked=true;break;}}
  if(revoked){const changed=await d.exec(sql`UPDATE runbook_schedules SET enabled = 0 WHERE id = ${s.id} AND targets = ${s.targets} AND enabled = 1`);if(changed.rowCount)await log('System','Runbook-Zeitplan wegen entzogener Rechte deaktiviert',s.id,targets);continue;}
  const next=nextScheduleDue(Math.max(at,due),rec,true);
  if(at-due>Math.max(30000,s.catchup_seconds*1000)){const changed=await d.exec(sql`UPDATE runbook_schedules SET next_due = ${next},last_due = ${due} WHERE id = ${s.id} AND next_due = ${due}`);if(changed.rowCount)await log('System','Runbook-Termin außerhalb Nachholfenster übersprungen',s.id,targets);continue;}
  const authorization=featureTargetsGuard(actor!,targets,['runbooks.execute']);
  const dueKey=`${s.id}:${due}`,digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(dueKey))),hex=Array.from(digest,b=>b.toString(16).padStart(2,'0')).join(''),id=`${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`,sealed=parse<Record<string,unknown>>(s.sealed_secrets);
  const results=await commitAll([sql`INSERT INTO runbook_runs (id,version_id,schedule_id,due_key,actor,parameters,concurrency,failure_stop,created_at,expires_at) SELECT ${id},${s.version_id},${s.id},${dueKey},${s.actor},${s.parameters},${s.concurrency},${s.failure_stop},${at},${due+Math.max(30,s.catchup_seconds)*1000} WHERE EXISTS (SELECT 1 FROM runbook_schedules s JOIN runbook_versions v ON v.id = s.version_id JOIN runbooks r ON r.id = v.runbook_id WHERE s.id = ${s.id} AND s.enabled = 1 AND s.next_due = ${due} AND s.targets = ${s.targets} AND r.archived = 0) AND ${authorization} AND ${singleCustomerTargets(s.targets)} ON CONFLICT DO NOTHING`,...targets.map(target=>sql`INSERT INTO runbook_run_devices (run_id,server_id,sealed_secrets) SELECT ${id},${target},${json(sealed[target]??{})} WHERE EXISTS (SELECT 1 FROM runbook_runs rr JOIN runbook_versions v ON v.id = rr.version_id JOIN runbooks r ON r.id = v.runbook_id WHERE rr.id = ${id} AND rr.state IN ('queued','running') AND rr.cancel_requested = 0 AND r.archived = 0) AND EXISTS (SELECT 1 FROM servers WHERE id = ${target} AND revoked = 0) AND EXISTS (SELECT 1 FROM runbook_schedules s CROSS JOIN LATERAL jsonb_array_elements_text(s.targets::jsonb) t WHERE s.id = ${s.id} AND s.enabled = 1 AND t.value = ${target}) ON CONFLICT DO NOTHING`),sql`UPDATE runbook_schedules SET next_due = ${next},last_due = ${due} WHERE id = ${s.id} AND next_due = ${due} AND enabled = 1 AND targets = ${s.targets}`]);
  const startedDevices=targets.filter((_,index)=>results[index+1].rowCount);
  if(results[0].rowCount&&startedDevices.length)await log('System','Runbook-Zeitplan gestartet',`${s.id} / ${id}`,startedDevices);
 }
}
async function finishRuns(ids:string[]){
 for(const id of new Set(ids)){const counts=await db().query<{state:string;n:number}>(sql`SELECT state,count(*) AS n FROM runbook_run_devices WHERE run_id = ${id} GROUP BY state`).then(results=>({results})),r=await db().one<{cancel_requested:number;failure_stop:number}>(sql`SELECT cancel_requested,failure_stop FROM runbook_runs WHERE id = ${id}`);if(!r)continue;const map=new Map(counts.results.map(x=>[x.state,x.n]));
  if(r.failure_stop&&(map.has('failed')||map.has('unknown'))){await commitAll([sql`UPDATE jobs SET state = 'cancelled',parameters = '{}',result = 'serverMessage.runbook.campaignStopped' WHERE state = 'pending' AND id IN (SELECT job_id FROM runbook_run_devices WHERE run_id = ${id})`,sql`UPDATE runbook_run_devices SET state = 'cancelled',finished_at = ${now()},result = 'serverMessage.runbook.campaignStopped',result_code = NULL,result_args = NULL,sealed_secrets = '{}' WHERE run_id = ${id} AND (state = 'queued' AND job_id IS NULL OR state = 'running' AND job_id IN (SELECT id FROM jobs WHERE state = 'cancelled'))`]);}
  const remaining=await db().one<{n:number}>(sql`SELECT count(*) AS n FROM runbook_run_devices WHERE run_id = ${id} AND state IN ('queued','running')`);
  if(!remaining?.n){const state=map.has('unknown')?'unknown':map.has('failed')?'failed':r.cancel_requested||map.has('cancelled')?'cancelled':'succeeded';await db().exec(sql`UPDATE runbook_runs SET state = ${state},finished_at = ${now()},parameters = '{}' WHERE id = ${id} AND state IN ('queued','running')`);await db().exec(sql`UPDATE runbook_run_devices SET sealed_secrets = '{}' WHERE run_id = ${id}`);}
 }
}
// Called by the authenticated agent's fast channel, never by a browser timer.
// Durable unique job IDs + device step CAS make retries safe without replaying writes.
export async function tickAutomation(serverId:string,snapshot:ServerSnapshot){
 // Defer the scope scheduler import: its immutable template validator imports
 // the shared recurrence schema, and historical manual-run fixtures remain valid.
 const scoped=await import('./automation-runbooks');
 await scoped.tickScopedRunbooks(serverId);await scheduleTick(serverId);const d=db(),at=now(),runs=await d.query<DeviceRun&{version_id:string;actor:string;parameters:string;concurrency:number;failure_stop:number;cancel_requested:number;run_created_at:number;expires_at:number}>(sql`SELECT rd.*,r.version_id,r.actor,r.parameters,r.concurrency,r.failure_stop,r.cancel_requested,r.created_at AS run_created_at,r.expires_at FROM runbook_run_devices rd JOIN runbook_runs r ON r.id = rd.run_id WHERE rd.server_id = ${serverId} AND rd.state IN ('queued','running') AND r.state IN ('queued','running') ORDER BY r.created_at LIMIT 20`).then(results=>({results})),touched:string[]=[];
 for(const rd of runs.results){touched.push(rd.run_id);
  const scopeAuthorization=await scoped.scopedRunbookGuard(rd.run_id,serverId);
  const scopeAllowed=!!await d.one(sql`SELECT 1 WHERE ${scopeAuthorization}`);
  if(!scopeAllowed){
   await commitAll([
    sql`UPDATE jobs SET state='cancelled',parameters='{}',result='serverMessage.runbook.assignmentChanged' WHERE id=${rd.job_id??''} AND server_id=${serverId} AND state='pending'`,
    sql`UPDATE runbook_run_devices SET state='cancelled',finished_at=${at},result='serverMessage.runbook.assignmentChanged',result_code=NULL,result_args=NULL,sealed_secrets='{}' WHERE run_id=${rd.run_id} AND server_id=${serverId} AND (job_id IS NULL OR job_id IN (SELECT id FROM jobs WHERE state='cancelled'))`,
    sql`UPDATE runbook_step_results SET state='cancelled',completed_at=${at},result='serverMessage.runbook.assignmentChanged' WHERE run_id=${rd.run_id} AND server_id=${serverId} AND job_id IN (SELECT id FROM jobs WHERE state='cancelled')`
   ]);
   if(!rd.job_id||await d.one(sql`SELECT id FROM jobs WHERE id=${rd.job_id} AND state='cancelled'`))continue;
   // Already claimed Windows actions retain their actual outcome; no new step
   // can be prepared under the withdrawn approval after that outcome arrives.
  }
  if(rd.job_id){const job=await d.one<{state:string;result:string|null;result_code:string|null;result_args:string|null}>(sql`SELECT state,result,result_code,result_args FROM jobs WHERE id = ${rd.job_id} AND server_id = ${serverId}`);
   // The step keeps the agent's message code and arguments with its text.
   await d.exec(sql`UPDATE runbook_step_results SET state = ${job?.state??'unknown'},result = ${job?.result??'serverMessage.runbook.resultUnknown'},result_code = ${job?.result_code??null},result_args = ${job?.result_args??null},completed_at = ${job&&['pending','running'].includes(job.state)?null:at} WHERE job_id = ${rd.job_id} AND server_id = ${serverId}`);
   if(!job||['failed','expired','cancelled'].includes(job.state)){const state=job?.state==='cancelled'?'cancelled':!job||job.state==='expired'?'unknown':'failed';await d.exec(sql`UPDATE runbook_run_devices SET state = ${state},result = ${job?.result??'serverMessage.runbook.resultUnknownNoRetry'},result_code = ${job?.result_code??null},result_args = ${job?.result_args??null},finished_at = ${at},sealed_secrets = ${'{}'} WHERE run_id = ${rd.run_id} AND server_id = ${serverId} AND job_id = ${rd.job_id}`);continue;}
   if(job.state!=='succeeded')continue;
   const changed=await d.one<{step_index:number}>(sql`UPDATE runbook_run_devices SET step_index = step_index + 1,job_id = NULL,state = 'queued',result = ${job.result},result_code = ${job.result_code},result_args = ${job.result_args} WHERE run_id = ${rd.run_id} AND server_id = ${serverId} AND job_id = ${rd.job_id} AND state = 'running' RETURNING step_index`);if(!changed)continue;rd.step_index=changed.step_index;rd.job_id=null;rd.state='queued';
  }
  const actor=await resolvePrincipal(rd.actor);let authorized=!!actor&&scopeAllowed;if(actor){try{await requireDevice(actor,serverId,'runbooks.execute');}catch{authorized=false;}}
  const failed=rd.failure_stop?await d.one(sql`SELECT server_id FROM runbook_run_devices WHERE run_id = ${rd.run_id} AND state IN ('failed','unknown') LIMIT 1`):null;
  if(!authorized||rd.cancel_requested||failed||(!rd.started_at&&at>rd.expires_at)||at-rd.run_created_at>86400000){await d.exec(sql`UPDATE runbook_run_devices SET state = 'cancelled',result = ${!authorized?'Berechtigung entzogen':failed?'Kampagne bei Fehler angehalten':rd.cancel_requested?'Abgebrochen':'Auftragsfenster abgelaufen'},result_code = NULL,result_args = NULL,finished_at = ${at},sealed_secrets = '{}' WHERE run_id = ${rd.run_id} AND server_id = ${serverId} AND job_id IS NULL`);continue;}
  let ver:Awaited<ReturnType<typeof version>>;try{ver=await version(rd.version_id);}catch(error){if(!(error instanceof HttpError&&error.status===404))throw error;await d.exec(sql`UPDATE runbook_run_devices SET state = 'cancelled',result = 'serverMessage.runbook.deletedRunStopped',result_code = NULL,result_args = NULL,finished_at = ${at},sealed_secrets = '{}' WHERE run_id = ${rd.run_id} AND server_id = ${serverId} AND job_id IS NULL`);continue;}
  const item=ver.definition.steps[rd.step_index];if(!item){await d.exec(sql`UPDATE runbook_run_devices SET state = 'succeeded',finished_at = ${at},sealed_secrets = '{}' WHERE run_id = ${rd.run_id} AND server_id = ${serverId} AND job_id IS NULL`);continue;}
  const errors=preconditionErrors(snapshot,item.preconditions);if(errors.length){await d.exec(sql`UPDATE runbook_run_devices SET state = 'failed',result = ${errors.length===1?errors[0].key:'serverMessage.runbook.preconditionsNotMet'},result_code = NULL,result_args = NULL,finished_at = ${at},sealed_secrets = '{}' WHERE run_id = ${rd.run_id} AND server_id = ${serverId} AND job_id IS NULL`);continue;}
  if(!snapshot.agentCapabilities?.includes('runbook-step')||item.kind==='powershell'&&(!snapshot.management||snapshot.mode!=='Management')){await d.exec(sql`UPDATE runbook_run_devices SET state = 'failed',result = 'serverMessage.runbook.agentChanged',result_code = NULL,result_args = NULL,finished_at = ${at},sealed_secrets = '{}' WHERE run_id = ${rd.run_id} AND server_id = ${serverId} AND job_id IS NULL`);continue;}
  const ordinaryAuthorization=featureTargetsGuard(actor!,[serverId],['runbooks.execute']);
  const authorization=sql`(${ordinaryAuthorization}) AND (${scopeAuthorization})`;
  const jobId=crypto.randomUUID(),params={runId:rd.run_id,stepId:item.id,kind:item.kind,...(item.kind==='powershell'?{script:item.script}:{operation:item.operation,operationParameters:item.operationParameters}),parameters:parse(rd.parameters),timeoutSeconds:item.timeoutSeconds,...(rd.sealed_secrets!=='{}'?{secretParameters:parse(rd.sealed_secrets)}:{})};
  await commitAll([
   sql`UPDATE runbook_run_devices SET job_id = ${jobId},state = 'running',started_at = COALESCE(started_at,${at}) WHERE run_id = ${rd.run_id} AND server_id = ${serverId} AND state = 'queued' AND job_id IS NULL AND step_index = ${rd.step_index} AND EXISTS (SELECT 1 FROM runbook_runs rr JOIN runbook_versions v ON v.id = rr.version_id JOIN runbooks r ON r.id = v.runbook_id WHERE rr.id = ${rd.run_id} AND rr.state IN ('queued','running') AND rr.cancel_requested = 0 AND r.archived = 0) AND (SELECT count(*) FROM runbook_run_devices WHERE run_id = ${rd.run_id} AND state = 'running') < ${rd.concurrency} AND NOT EXISTS (SELECT 1 FROM jobs WHERE server_id = ${serverId} AND state IN ('pending','running')) AND ${authorization}`,
   sql`INSERT INTO jobs (id,server_id,action,target,parameters,display_input,created_at,actor,actor_email,actor_principal) SELECT ${jobId},${serverId},'runbook-step',${`${ver.name} / ${item.name}`.slice(0,240)},${json(params)},${jobDisplayInput('runbook-step',{...params,name:item.name})},${at},${actor!.id},${actor!.label.trim().toLowerCase()},${principal(actor!)} WHERE EXISTS (SELECT 1 FROM runbook_run_devices WHERE run_id = ${rd.run_id} AND server_id = ${serverId} AND job_id = ${jobId})`,
   sql`INSERT INTO runbook_step_results (run_id,server_id,step_index,job_id,created_at) SELECT ${rd.run_id},${serverId},${rd.step_index},${jobId},${at} WHERE EXISTS (SELECT 1 FROM runbook_run_devices WHERE run_id = ${rd.run_id} AND server_id = ${serverId} AND job_id = ${jobId})`,
   sql`UPDATE runbook_runs SET state = 'running' WHERE id = ${rd.run_id} AND state = 'queued' AND EXISTS (SELECT 1 FROM runbook_run_devices WHERE run_id = ${rd.run_id} AND job_id = ${jobId})`
  ]);
 }
 await finishRuns(touched);
}
export async function listRunbooks(v:Viewer,serverId?:string,runId?:string){
 if(runId&&!guid(runId))throw new HttpError('apiError.runbook.invalidRun');
 const ids=serverId?[serverId]:await allowedDeviceIds(v,'runbooks.read');if(serverId)await requireDevice(v,serverId,'runbooks.read');const ownership=await catalogOwnership(v),instanceOwner=await can(v,'instance.owner');if(!ids.length&&!instanceOwner&&!await hasGlobalPermission(v,'portal.operator'))return {runbooks:[],runs:[],schedules:[],catalog:ownership};
 // Only runbooks the viewer sees; the limits apply after this filter.
 const d=db(),idsJson=json(ids),visibleBook=catalogVisibleGuard(sql`b.customer_id`,sql`${principal(v)}`),catalog={results:await d.query<Record<string,unknown>>(sql`SELECT b.id,b.name,b.description,b.created_at AS "createdAt",b.created_by AS "createdBy",b.customer_id AS "customerId",c.name AS "customerName" FROM runbooks b LEFT JOIN customers c ON c.id = b.customer_id WHERE b.archived = 0 AND ${visibleBook} ORDER BY b.name LIMIT 100`)},versions={results:await d.query<Record<string,unknown>>(sql`SELECT id,runbook_id AS "runbookId",version,created_at AS "createdAt",created_by AS "createdBy",definition FROM runbook_versions WHERE runbook_id IN (SELECT b.id FROM runbooks b WHERE b.archived = 0 AND ${visibleBook} ORDER BY b.name LIMIT 100) ORDER BY version DESC LIMIT 500`)};
 const runs={results:ids.length?await d.query<Record<string,unknown>>(sql`SELECT DISTINCT r.id,r.version_id AS "versionId",r.state,r.created_at AS "createdAt",r.finished_at AS "finishedAt",r.cancel_requested AS "cancelRequested",b.name AS "runbookName",b.archived AS "runbookArchived" FROM runbook_runs r JOIN runbook_run_devices rd ON rd.run_id = r.id JOIN runbook_versions v ON v.id = r.version_id JOIN runbooks b ON b.id = v.runbook_id WHERE rd.server_id IN (SELECT jsonb_array_elements_text(${idsJson}::jsonb))${runId?sql` AND r.id = ${runId}`:sql``} ORDER BY r.created_at DESC LIMIT 50`):[]};
 const runIds=runs.results.map(x=>String(x.id)),runIdsJson=json(runIds),devices=runIds.length?await d.query<Record<string,unknown>>(sql`SELECT run_id AS "runId",server_id AS "serverId",state,step_index AS "stepIndex",job_id AS "jobId",result,result_code,result_args FROM runbook_run_devices WHERE run_id IN (SELECT value FROM jsonb_array_elements_text(${runIdsJson}::jsonb)) AND server_id IN (SELECT value FROM jsonb_array_elements_text(${idsJson}::jsonb))`).then(results=>({results})):{results:[]};
 const steps=runIds.length?await d.query<Record<string,unknown>>(sql`SELECT s.run_id AS "runId",s.server_id AS "serverId",s.step_index AS "stepIndex",s.job_id AS "jobId",s.state,s.result,s.result_code,s.result_args,s.created_at AS "createdAt",s.completed_at AS "completedAt"${runId?sql`,o.data AS output`:sql``} FROM runbook_step_results s${runId?sql` LEFT JOIN job_outputs o ON o.job_id = s.job_id AND o.server_id = s.server_id`:sql``} WHERE s.run_id IN (SELECT value FROM jsonb_array_elements_text(${runIdsJson}::jsonb)) AND s.server_id IN (SELECT value FROM jsonb_array_elements_text(${idsJson}::jsonb)) ORDER BY s.step_index`).then(results=>({results})):{results:[]};
 const runDefinitions=runIds.length?await d.query<{runId:string;definition:string}>(sql`SELECT r.id AS "runId",v.definition FROM runbook_runs r JOIN runbook_versions v ON v.id = r.version_id WHERE r.id IN (SELECT value FROM jsonb_array_elements_text(${runIdsJson}::jsonb))`).then(results=>({results})):{results:[]};const definitionMap=new Map(runDefinitions.results.map(r=>[r.runId,parse<RunbookDefinition>(r.definition)])),outputIds=new Set(await allowedDeviceIds(v,'runbooks.outputs'));
 const schedules=await d.query<Record<string,unknown>>(sql`SELECT s.id,s.version_id AS "versionId",s.targets,s.recurrence,s.next_due AS "nextDue",s.catchup_seconds AS "catchupSeconds",s.enabled,s.actor,b.name AS "runbookName",b.archived AS "runbookArchived" FROM runbook_schedules s JOIN runbook_versions v ON v.id = s.version_id JOIN runbooks b ON b.id = v.runbook_id WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN s.targets IS JSON ARRAY THEN s.targets::jsonb ELSE '[]'::jsonb END) t WHERE t.value NOT IN (SELECT value FROM jsonb_array_elements_text(${idsJson}::jsonb))) ORDER BY s.created_at DESC LIMIT 100`).then(results=>({results}));
 const manageable=new Set(instanceOwner?[]:await allowedDeviceIds(v,'runbooks.manage')),mayManage=instanceOwner||manageable.size>0||await hasGlobalPermission(v,'portal.operator');
 const activeTargets=instanceOwner?{results:[] as {runbook_id:string;server_id:string}[]}:await d.query<{runbook_id:string;server_id:string}>(sql`SELECT v.runbook_id,t.value AS server_id FROM runbook_schedules s JOIN runbook_versions v ON v.id = s.version_id CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN s.targets IS JSON ARRAY THEN s.targets::jsonb ELSE '[]'::jsonb END) t JOIN servers device ON device.id = t.value WHERE s.enabled = 1 AND device.revoked = 0 UNION SELECT v.runbook_id,rd.server_id FROM runbook_run_devices rd JOIN runbook_runs r ON r.id = rd.run_id JOIN runbook_versions v ON v.id = r.version_id JOIN servers device ON device.id = rd.server_id WHERE r.state IN ('queued','running') AND rd.state IN ('queued','running') AND device.revoked = 0`).then(results=>({results}));
 function catalogVersion(x:Record<string,unknown>){const definition=parse<RunbookDefinition>(String(x.definition)),sourceAllowed=instanceOwner||x.createdBy===principal(v);return {...x,definition:sourceAllowed?definition:{...definition,steps:definition.steps.map(step=>{const redacted={...step};delete redacted.script;return redacted;}),parameters:definition.parameters.map(parameter=>{const redacted={...parameter};delete redacted.default;return redacted;})},sourceRedacted:!sourceAllowed};}
 function publicStep({result_code,result_args,...row}:Record<string,unknown>){const kind=definitionMap.get(String(row.runId))?.steps[Number(row.stepIndex)]?.kind,redacted=kind!=='diagnosis'&&!outputIds.has(String(row.serverId));return {...row,...agentResultFields({result_code,result_args}),...(redacted?{result:null,resultCode:null,resultArgs:null,output:undefined,outputRedacted:true}:row.output?{output:parse(String(row.output))}:{})};}
 function publicDevice({result_code,result_args,...device}:Record<string,unknown>){const rows=steps.results.filter(s=>s.runId===device.runId&&s.serverId===device.serverId),completed=[...rows].filter(s=>s.completedAt!==null&&s.completedAt!==undefined).sort((a,b)=>Number(b.stepIndex)-Number(a.stepIndex)),latest=completed[0],summaryRedacted=!!device.result&&!!latest&&definitionMap.get(String(device.runId))?.steps[Number(latest.stepIndex)]?.kind!=='diagnosis'&&!outputIds.has(String(device.serverId));return {...device,...agentResultFields({result_code,result_args}),...(summaryRedacted?{result:null,resultCode:null,resultArgs:null,outputRedacted:true}:{}),steps:rows.map(publicStep)};}
 return {catalog:ownership,runbooks:catalog.results.map(r=>{const canManage=mayManage&&(instanceOwner||r.createdBy===principal(v))&&(r.customerId!==null||ownership.libraryWritable),canDelete=canManage&&(instanceOwner||!activeTargets.results.some(t=>t.runbook_id===r.id&&!manageable.has(t.server_id)));return {...r,canManage,canDelete,...(canManage&&!canDelete?{deleteReason:serverMessage('serverMessage.runbook.deleteReason')}:{}),versions:versions.results.filter(x=>x.runbookId===r.id).map(catalogVersion)};}),runs:runs.results.map(r=>({...r,devices:devices.results.filter(x=>x.runId===r.id).map(publicDevice)})),schedules:schedules.results.map(s=>({...s,targets:parse(String(s.targets)),recurrence:parse(String(s.recurrence)),enabled:!!s.enabled}))};
}
