import {jobDisplayInput} from '../../job-input';
import {featureTargetsGuard,featureWriteGuard} from '../identity/feature-authorization';
import {z} from 'zod';
import {config,guid,hash,HttpError,log,now} from '../context';
import type {ApiErrorKey} from '../../errors/api-error-keys';
import type {ApiErrorParams} from '../../errors/http-error';
import {allowedDeviceIds,principal,requireDevice,resolvePrincipal,devicePermissionGuard,anyDevicePermissionGuard,globalPermissionGuard,hasGlobalPermission,type Permission,type SqlGuard} from '../identity/access';
import {can,canSql,requireCan} from '../identity/policy/can';
import {isMfaEnabled} from '../identity/mfa';
import {authorizeTargetCustomers,customerEntries,recheckCrossCustomer} from '../identity/cross-customer';
import {sealAgentSecrets} from '../agent/agent-crypto';
import {desiredEngine,desiredParameters,validateDesiredContent} from '../../desired-state-operations';
import {agentResultFields} from '../../agent-messages';
import type {ServerSnapshot,Viewer} from '../../types';
import type {EffectiveAutomation} from '../../automation-resolution';
import {commitAll,db,sql} from '../db';
import {messageFields,serverMessage} from '../../server-messages';

type ConfigRow={id:string;name:string;description:string;created_by:string;created_at:number;archived:number};
type VersionRow={id:string;config_id:string;version:number;engine:z.infer<typeof desiredEngine>;content:string;sha256:string;configuration_name:string|null;parameters:string;source:string;created_at:number;created_by:string};
type VersionMetadata=Omit<VersionRow,'content'|'parameters'>;
type AssignmentRow={id:string;server_id:string;version_id:string;assigned_by:string;assigned_at:number;enabled:number;interval_seconds:number;last_checked_at:number|null;last_job_id:string|null;last_result_state:'succeeded'|'failed'|null;last_result_at:number|null;last_compliant:number|null;last_compliant_at:number|null};
type RunRow={id:string;assignment_id:string;server_id:string;version_id:string;job_id:string;operation:string;created_at:number;state:string;result:string|null;result_code:string|null;result_args:string|null;last_progress:number|null;result_at:number|null;data:string|null;configuration_title:string|null;configuration_version:number|null;configuration_deleted:number|null};
const runMetadata=sql`ver.version AS configuration_version,c.name AS configuration_title,c.archived AS configuration_deleted`;
const runColumns=sql`r.*,j.state,j.result,j.result_code,j.result_args,j.last_progress,o.created_at AS result_at,o.data,${runMetadata}`;
const runJoins=sql`desired_runs r JOIN jobs j ON j.id=r.job_id LEFT JOIN job_outputs o ON o.job_id=r.job_id AND o.server_id=r.server_id LEFT JOIN desired_versions ver ON ver.id=r.version_id LEFT JOIN desired_configs c ON c.id=ver.config_id`;
// The agent output as a jsonb object; anything else counts as an empty object.
const safeOutput=sql`(CASE WHEN o.data IS JSON OBJECT THEN o.data::jsonb ELSE '{}'::jsonb END)`;
const outputText=(field:string,limit=512)=>sql`CASE WHEN jsonb_typeof(${safeOutput}->${field}::text)='string' THEN substring(${safeOutput}->>${field}::text,1,${limit}::int) ELSE NULL END`;
const resourceArray=sql`(CASE WHEN jsonb_typeof(${safeOutput}->'resources')='array' THEN ${safeOutput}->'resources' ELSE '[]'::jsonb END)`;
// Compact at the database boundary, not after loading every full resource list into
// the server. Only the explicitly selected run query uses full runColumns above.
const runSummaryColumns=sql`r.*,j.state,j.result,j.result_code,j.result_args,j.last_progress,o.created_at AS result_at,${runMetadata},CASE WHEN o.data IS JSON OBJECT THEN jsonb_build_object('engine',${outputText('engine',128)},'runtime',${outputText('runtime')},'compliant',(CASE WHEN j.state='succeeded' AND ${safeOutput}->'compliant'='true'::jsonb THEN 'true' WHEN j.state='succeeded' AND ${safeOutput}->'compliant'='false'::jsonb THEN 'false' ELSE 'null' END)::jsonb,'rebootPending',(CASE WHEN ${safeOutput}->'rebootPending'='true'::jsonb THEN 'true' ELSE 'false' END)::jsonb,'checkedAt',${outputText('checkedAt',128)},'resourceDetail',${outputText('resourceDetail',128)},'resourceCount',jsonb_array_length(${resourceArray}),'nonCompliantCount',(SELECT COUNT(*) FROM jsonb_array_elements(${resourceArray}) resource WHERE jsonb_typeof(resource.value)='object' AND resource.value->'inDesiredState'='false'::jsonb)) ELSE NULL END AS data`;

function publicRun(r:RunRow,detail=false){
 const raw=r.data?parse(r.data):null,output=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw:null,resources=Array.isArray(output?.resources)?output.resources:[],compliant=r.state==='succeeded'&&typeof output?.compliant==='boolean'?output.compliant:null;
 const data=output?(detail?{...output,compliant}:{engine:typeof output.engine==='string'?output.engine:null,runtime:typeof output.runtime==='string'?output.runtime:null,compliant,rebootPending:output.rebootPending===true,checkedAt:typeof output.checkedAt==='string'?output.checkedAt:null,resourceDetail:typeof output.resourceDetail==='string'?output.resourceDetail:null,resourceCount:Array.isArray(output.resources)?resources.length:Number.isSafeInteger(output.resourceCount)&&output.resourceCount>=0?output.resourceCount:0,nonCompliantCount:Array.isArray(output.resources)?resources.filter((resource:unknown)=>!!resource&&typeof resource==='object'&&(resource as {inDesiredState?:unknown}).inDesiredState===false).length:Number.isSafeInteger(output.nonCompliantCount)&&output.nonCompliantCount>=0?output.nonCompliantCount:0}):null;
 return {id:r.id,assignmentId:r.assignment_id,serverId:r.server_id,versionId:r.version_id,jobId:r.job_id,operation:r.operation,createdAt:r.created_at,state:r.state,message:r.result,...agentResultFields(r),lastProgressAt:r.last_progress,resultAt:r.result_at,configuration:r.configuration_title&&r.configuration_version?{name:r.configuration_title,version:r.configuration_version,deleted:!!r.configuration_deleted}:null,data};
}
const parse=(value:string)=>{try{return JSON.parse(value);}catch{return null;}};
const fail=(key:ApiErrorKey,params?:ApiErrorParams):never=>{throw new HttpError(key,params);};
function catalogGuard(v:Viewer,configId?:string,serverId?:string){
 const owner=canSql(sql`authorization_actor.principal`,'instance.owner'),operator=globalPermissionGuard(sql`authorization_actor.principal`,'portal.operator');
 const manage=serverId?devicePermissionGuard(sql`authorization_actor.server_id`,sql`authorization_actor.principal`,'desired.manage'):anyDevicePermissionGuard(sql`authorization_actor.principal`,'desired.manage');
 const assigned=devicePermissionGuard(sql`a.server_id`,sql`authorization_actor.principal`,'desired.manage');
 const management=serverId?manage:sql`(${manage}) OR (${operator})`;
 const owns=configId?sql` AND EXISTS (SELECT 1 FROM desired_configs c WHERE c.id=${configId} AND (c.created_by=authorization_actor.principal OR EXISTS (SELECT 1 FROM desired_assignments a JOIN desired_versions ver ON ver.config_id=c.id AND ver.id=a.version_id WHERE ${assigned})))`:sql``;
 return featureWriteGuard(v,sql`EXISTS (SELECT 1 FROM (SELECT ${principal(v)}::text AS principal,${serverId??''}::text AS server_id) authorization_actor WHERE (${owner}) OR ((${management})${owns}))`);
}
async function mayManage(v:Viewer,serverId?:string){if(serverId){await requireDevice(v,serverId,'desired.manage');return;}if(!(await allowedDeviceIds(v,'desired.manage')).length&&!await can(v,'instance.owner')&&!await hasGlobalPermission(v,'portal.operator'))throw new HttpError('apiError.desired.manageRightRequired');}
async function canReadConfig(v:Viewer,row:ConfigRow,right:'desired.read'|'desired.manage'='desired.read'){
 if(await can(v,'instance.owner'))return true;
 if(row.created_by===principal(v)){if(right==='desired.manage')await mayManage(v);else if(!(await allowedDeviceIds(v,'desired.read')).length&&!await hasGlobalPermission(v,'portal.operator'))return false;return true;}
 const ids=await allowedDeviceIds(v,right);if(!ids.length)return false;
 const matches=await db().one(sql`SELECT a.id FROM desired_assignments a JOIN desired_versions ver ON ver.id=a.version_id WHERE ver.config_id=${row.id} AND a.server_id IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)) LIMIT 1`);return !!matches;
}
async function configuration(v:Viewer,id:string,right:'desired.read'|'desired.manage'='desired.read'){
 if(!guid(id))fail('apiError.desired.invalidConfig');const row=await db().one<ConfigRow>(sql`SELECT * FROM desired_configs WHERE id=${id} AND archived=0`);
 if(!row)throw new HttpError('apiError.desired.configNotFound');if(!await canReadConfig(v,row,right))throw new HttpError('apiError.desired.configForbidden');return row;
}
async function version(v:Viewer,id:string){if(!guid(id))fail('apiError.desired.invalidVersion');const row=await db().one<VersionRow>(sql`SELECT * FROM desired_versions WHERE id=${id}`);if(!row)throw new HttpError('apiError.desired.versionNotFound');await configuration(v,row.config_id);return row;}
const publicVersion=(ver:VersionMetadata&{content?:string;parameters?:string},includeContent=false)=>({id:ver.id,configId:ver.config_id,version:ver.version,engine:ver.engine,sha256:ver.sha256,configurationName:ver.configuration_name,source:parse(ver.source),createdAt:ver.created_at,...(includeContent?{content:ver.content,parameters:parse(ver.parameters??'{}')}:{})});

export async function listDesiredState(v:Viewer,serverId?:string,versionId?:string,runId?:string){
 if(serverId)await requireDevice(v,serverId,'desired.read');
 if(runId){
  if(!guid(runId))fail('apiError.desired.invalidRun');
  const run=await db().one<RunRow>(sql`SELECT ${runColumns} FROM ${runJoins} WHERE r.id=${runId}`);if(!run)throw new HttpError('apiError.desired.runNotFound');
  await requireDevice(v,run.server_id,'desired.read');if(serverId&&run.server_id!==serverId)throw new HttpError('apiError.desired.runOtherDevice');
  return {selectedRun:publicRun(run,true),...(versionId?{selectedVersion:publicVersion(await version(v,versionId),true)}:{})};
 }
 const instanceOwner=await can(v,'instance.owner'),portalOperator=await hasGlobalPermission(v,'portal.operator'),devices=serverId?[serverId]:await allowedDeviceIds(v,'desired.read'),configDevices=serverId?await allowedDeviceIds(v,'desired.read'):devices,scope=JSON.stringify(devices),configScope=JSON.stringify(configDevices);
 // Scope once, then rank metadata in SQL. Polling does not repeat access queries or
 // fetch configuration source for every configuration/version in the library.
 const rows=(await db().query<ConfigRow>(sql`WITH visible AS (SELECT c.* FROM desired_configs c WHERE c.archived=0 AND (${instanceOwner} OR (${configDevices.length>0||portalOperator} AND c.created_by=${principal(v)}) OR EXISTS (SELECT 1 FROM desired_assignments a JOIN desired_versions ver ON ver.id=a.version_id WHERE ver.config_id=c.id AND a.server_id IN (SELECT value FROM jsonb_array_elements_text(${configScope}::jsonb))))) SELECT * FROM visible WHERE id IN (SELECT id FROM visible ORDER BY created_at DESC LIMIT 200) OR id IN (SELECT ver.config_id FROM desired_assignments a JOIN desired_versions ver ON ver.id=a.version_id WHERE a.enabled=1 AND a.server_id IN (SELECT value FROM jsonb_array_elements_text(${scope}::jsonb))) ORDER BY created_at DESC`));
 const versions=rows.length?(await db().query<VersionMetadata&{version_count:number}>(sql`WITH ranked AS (SELECT id,config_id,version,engine,sha256,configuration_name,source,created_at,created_by,ROW_NUMBER() OVER (PARTITION BY config_id ORDER BY version DESC) AS rank,COUNT(*) OVER (PARTITION BY config_id) AS version_count FROM desired_versions WHERE config_id IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(rows.map(r=>r.id))}::jsonb))) SELECT * FROM ranked WHERE rank<=60 OR id IN (SELECT version_id FROM desired_assignments WHERE enabled=1 AND server_id IN (SELECT value FROM jsonb_array_elements_text(${scope}::jsonb))) ORDER BY version DESC`)):[];
 const manageable=instanceOwner?[]:await allowedDeviceIds(v,'desired.manage');
 const impacts=rows.length?(await db().query<{config_id:string;assignment_count:number;visible_count:number;outside_scope:number}>(sql`SELECT ver.config_id,COUNT(*) AS assignment_count,SUM(CASE WHEN a.server_id IN (SELECT value FROM jsonb_array_elements_text(${configScope}::jsonb)) THEN 1 ELSE 0 END) AS visible_count,SUM(CASE WHEN a.server_id IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(manageable)}::jsonb)) THEN 0 ELSE 1 END) AS outside_scope FROM desired_assignments a JOIN desired_versions ver ON ver.id=a.version_id WHERE a.enabled=1 AND ver.config_id IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(rows.map(r=>r.id))}::jsonb)) GROUP BY ver.config_id`)):[];
 const configs=rows.map(row=>{const impact=impacts.find(i=>i.config_id===row.id),owner=row.created_by===principal(v),canDelete=instanceOwner||owner&&(manageable.length>0||portalOperator)&&!impact?.outside_scope;return {id:row.id,name:row.name,description:row.description,createdAt:row.created_at,versionCount:versions.find(v=>v.config_id===row.id)?.version_count??0,assignmentCount:canDelete?impact?.assignment_count??0:impact?.visible_count??0,canDelete,deleteReason:canDelete?undefined:serverMessage(!owner?'serverMessage.desired.deleteCreatorOnly':'serverMessage.desired.deleteNeedsRights'),versions:versions.filter(v=>v.config_id===row.id).map(v=>publicVersion(v))};});
 const assignments=devices.length?(await db().query<AssignmentRow>(sql`SELECT * FROM desired_assignments WHERE server_id IN (SELECT value FROM jsonb_array_elements_text(${scope}::jsonb)) ORDER BY assigned_at DESC`)):[];
 const history=devices.length?(await db().query<RunRow>(sql`SELECT ${runSummaryColumns} FROM ${runJoins} WHERE r.server_id IN (SELECT value FROM jsonb_array_elements_text(${scope}::jsonb)) ORDER BY r.created_at DESC,r.id DESC LIMIT 100`)):[];
 // Latest operation and last real compliance result are independent of the fleet's
 // 100-entry history window, and always belong to this exact active assignment/version.
 const current=devices.length?(await db().query<RunRow>(sql`WITH current AS (SELECT r.id,r.assignment_id,r.version_id,r.created_at,j.state,jsonb_typeof(${safeOutput}->'compliant') AS compliance_type FROM desired_runs r JOIN desired_assignments a ON a.id=r.assignment_id AND a.enabled=1 AND a.version_id=r.version_id JOIN jobs j ON j.id=r.job_id LEFT JOIN job_outputs o ON o.job_id=r.job_id AND o.server_id=r.server_id WHERE r.server_id IN (SELECT value FROM jsonb_array_elements_text(${scope}::jsonb))),latest AS (SELECT id,ROW_NUMBER() OVER (PARTITION BY assignment_id,version_id ORDER BY created_at DESC,id DESC) AS rank FROM current),compliance AS (SELECT id,ROW_NUMBER() OVER (PARTITION BY assignment_id,version_id ORDER BY created_at DESC,id DESC) AS rank FROM current WHERE state='succeeded' AND compliance_type='boolean'),selected AS (SELECT id FROM latest WHERE rank=1 UNION SELECT id FROM compliance WHERE rank=1) SELECT ${runSummaryColumns} FROM ${runJoins} WHERE r.id IN (SELECT id FROM selected) ORDER BY r.created_at DESC,r.id DESC`)):[];
 const runs=[...new Map([...history,...current].map(r=>[r.id,r])).values()].sort((a,b)=>b.created_at-a.created_at||b.id.localeCompare(a.id)),latest=(a:AssignmentRow,compliance=false)=>{const r=current.find(r=>r.assignment_id===a.id&&r.version_id===a.version_id&&(!compliance||r.state==='succeeded'&&typeof parse(r.data??'')?.compliant==='boolean'));return r?publicRun(r):null;};
 return {configs,assignments:assignments.map(a=>({id:a.id,serverId:a.server_id,versionId:a.version_id,assignedAt:a.assigned_at,enabled:!!a.enabled,intervalSeconds:a.interval_seconds,lastCheckedAt:a.last_checked_at,lastJobId:a.last_job_id,lastResultState:a.last_result_state,lastResultAt:a.last_result_at,lastCompliant:a.last_compliant===null?null:a.last_compliant===1,lastCompliantAt:a.last_compliant_at,latestRun:latest(a),latestComplianceRun:latest(a,true)})),runs:runs.map(r=>publicRun(r)),...(versionId?{selectedVersion:publicVersion(await version(v,versionId),true)}:{}),github:{privateAvailable:instanceOwner&&!!config('DESIRED_STATE_GITHUB_TOKEN')&&!!config('DESIRED_STATE_GITHUB_REPOSITORIES').trim()}};
}

export async function createDesiredVersion(v:Viewer,p:Record<string,unknown>,source:Record<string,string>={kind:'portal'}){
 await mayManage(v,typeof p.serverId==='string'?p.serverId:undefined);
 const input=z.object({name:z.string().trim().min(1).max(120),description:z.string().max(2000).default(''),engine:desiredEngine,content:z.string(),configurationName:z.string().max(64).optional(),parameters:desiredParameters.default({})}).safeParse(p);
 if(!input.success)fail('apiError.desired.checkInput');const value=input.data!;try{validateDesiredContent(value.engine,value.content,value.configurationName);}catch(e){if(e instanceof HttpError)throw e;fail('apiError.desired.invalidConfig');}
 if(value.engine==='mof'&&Object.keys(value.parameters).length)fail('apiError.desired.mofNoParameters');
 const digest=await hash(value.content),at=now(),versionId=crypto.randomUUID(),configId=typeof p.configId==='string'?p.configId:crypto.randomUUID();
 if(p.configId)await configuration(v,configId,'desired.manage');
 const previous=await db().one<{version:number|null}>(sql`SELECT max(version) AS version FROM desired_versions WHERE config_id=${configId}`),number=(previous?.version??0)+1;
 const catalogAuthorization=catalogGuard(v,p.configId?configId:undefined,typeof p.serverId==='string'?p.serverId:undefined),privateSource=source.kind==='github'&&source.authenticated==='true',privateOwner=canSql(sql`import_actor.principal`,'instance.owner');
 const authorization=privateSource?sql`(${catalogAuthorization}) AND EXISTS (SELECT 1 FROM (SELECT ${principal(v)}::text AS principal) import_actor WHERE ${privateOwner})`:catalogAuthorization;
 try{const result=await commitAll([...(p.configId?[]:[sql`INSERT INTO desired_configs (id,name,description,created_by,created_at) SELECT ${configId},${value.name},${value.description},${principal(v)},${at} WHERE ${authorization}`]),sql`INSERT INTO desired_versions (id,config_id,version,engine,content,sha256,configuration_name,parameters,source,created_by,created_at) SELECT ${versionId},${configId},${number},${value.engine},${value.content},${digest},${value.engine==='powershell-dsc'?value.configurationName??null:null},${JSON.stringify(value.parameters)},${JSON.stringify(source)},${principal(v)},${at} WHERE EXISTS (SELECT 1 FROM desired_configs WHERE id=${configId} AND archived=0) AND ${authorization}`]);if(!result[result.length-1].rowCount)throw new HttpError('apiError.desired.configDeleted');}catch{throw new HttpError('apiError.desired.configConcurrent');}
 await log(v.id,'Desired-State-Version gespeichert',`${configId} / v${number} / ${digest}`);return {configId,versionId,version:number,sha256:digest};
}

export async function deleteDesiredConfiguration(v:Viewer,p:Record<string,unknown>){
 if(p.confirmDelete!==true)fail('apiError.desired.confirmDeleteConfig');
 const row=await configuration(v,String(p.configId??''),'desired.manage');
 const instanceOwner=await can(v,'instance.owner');
 if(!instanceOwner&&row.created_by!==principal(v))throw new HttpError('apiError.desired.deleteCreatorOnly');
 const manageable=instanceOwner?[]:await allowedDeviceIds(v,'desired.manage');
 const assigned=(await db().query<{server_id:string}>(sql`SELECT DISTINCT a.server_id FROM desired_assignments a JOIN desired_versions ver ON ver.id=a.version_id WHERE ver.config_id=${row.id} AND a.enabled=1`));
 for(const assignment of assigned)await requireDevice(v,assignment.server_id,'desired.manage');
 const owner=canSql(sql`deletion_actor.principal`,'instance.owner'),operator=globalPermissionGuard(sql`deletion_actor.principal`,'portal.operator'),any=anyDevicePermissionGuard(sql`deletion_actor.principal`,'desired.manage'),right=devicePermissionGuard(sql`a.server_id`,sql`deletion_actor.principal`,'desired.manage');
 const authorization=featureWriteGuard(v,sql`EXISTS (SELECT 1 FROM (SELECT ${principal(v)}::text AS principal) deletion_actor WHERE ((${owner}) OR (EXISTS (SELECT 1 FROM desired_configs WHERE id=${row.id} AND created_by=deletion_actor.principal) AND ((${any}) OR (${operator})))) AND NOT EXISTS (SELECT 1 FROM desired_assignments a JOIN desired_versions ver ON ver.id=a.version_id WHERE a.enabled=1 AND ver.config_id=${row.id} AND NOT (${right})))`);
 const guard=authorization;
 // Archival and cleanup share one transaction. A concurrent claim either wins
 // first and blocks deletion, or sees cancelled work and the archived library row.
 const results=await commitAll([
  sql`UPDATE desired_configs SET archived=1 WHERE id=${row.id} AND archived=0 AND NOT EXISTS (SELECT 1 FROM desired_runs r JOIN desired_versions ver ON ver.id=r.version_id JOIN jobs j ON j.id=r.job_id WHERE ver.config_id=${row.id} AND j.state='running') AND (${instanceOwner} OR NOT EXISTS (SELECT 1 FROM desired_assignments a JOIN desired_versions ver ON ver.id=a.version_id WHERE ver.config_id=${row.id} AND a.enabled=1 AND a.server_id NOT IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(manageable)}::jsonb)))) AND ${guard}`,
  sql`UPDATE desired_assignments SET enabled=0,interval_seconds=0 WHERE enabled=1 AND version_id IN (SELECT id FROM desired_versions WHERE config_id=${row.id}) AND EXISTS (SELECT 1 FROM desired_configs WHERE id=${row.id} AND archived=1) AND ${guard} RETURNING server_id`,
  sql`UPDATE jobs SET state='cancelled',parameters='{}',result='serverMessage.desired.configDeleted' WHERE state='pending' AND id IN (SELECT r.job_id FROM desired_runs r JOIN desired_versions ver ON ver.id=r.version_id WHERE ver.config_id=${row.id}) AND EXISTS (SELECT 1 FROM desired_configs WHERE id=${row.id} AND archived=1) AND ${guard} RETURNING server_id`
 ]);
 if(!results[0].rowCount){if(!await db().one(sql`SELECT 1 AS allowed WHERE ${guard}`))throw new HttpError('apiError.desired.deleteApprovalChanged');if(await db().one(sql`SELECT r.id FROM desired_runs r JOIN desired_versions ver ON ver.id=r.version_id JOIN jobs j ON j.id=r.job_id WHERE ver.config_id=${row.id} AND j.state='running' LIMIT 1`))throw new HttpError('apiError.desired.deleteRunning');if(await db().one(sql`SELECT id FROM desired_configs WHERE id=${row.id} AND archived=0`))throw new HttpError('apiError.desired.deleteAssignmentsChanged');throw new HttpError('apiError.desired.deleteGone');}
 const affectedDevices=[...new Set(([...results[1].rows,...results[2].rows] as {server_id:string}[]).map(r=>r.server_id))];
 await log(v.id,'Desired-State-Konfiguration gelöscht',`${row.name} / ${row.id}`,affectedDevices.length?affectedDevices:undefined);
 return {ok:true,configId:row.id,status:'deleted',removedAssignments:results[1].rowCount,cancelledJobs:results[2].rowCount,...messageFields('serverMessage.desired.configDeletedNotice')};
}

function checkInterval(value:unknown){const interval=z.union([z.literal(0),z.number().int().min(900).max(86400)]).safeParse(value??0);if(!interval.success)fail('apiError.desired.intervalRange');return interval.data!;}
async function authorizeSchedule(v:Viewer,serverId:string,interval:number,confirmed:unknown){
 const device=await requireDevice(v,serverId,'desired.manage');
 if(interval){await requireDevice(v,serverId,'desired.apply');const snapshot=device.snapshot?parse(device.snapshot):null;if(!device.management||snapshot?.mode!=='Management'||!snapshot?.agentCapabilities?.includes('desired-state-test'))throw new HttpError('apiError.desired.autoCheckAgent');if(confirmed!==true)fail('apiError.desired.approveAutoChecks');}
}
async function assignmentConflict(targets:string[],versionId:string,interval:number){
 const rows=(await db().query<{server_id:string;version_id:string;interval_seconds:number;name:string}>(sql`SELECT a.server_id,a.version_id,a.interval_seconds,s.name FROM desired_assignments a JOIN servers s ON s.id=a.server_id WHERE a.server_id IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(targets)}::jsonb)) AND a.enabled=1 AND (a.version_id<>${versionId} OR a.interval_seconds<>${interval})`));
 if(rows.length){const names=rows.slice(0,5).map(r=>r.name).join(', '),more=rows.length-5,different=rows.some(r=>r.version_id!==versionId);throw more>0?new HttpError(different?'apiError.desired.otherVersionAssignedMore':'apiError.desired.otherIntervalAssignedMore',{names,count:more}):new HttpError(different?'apiError.desired.otherVersionAssigned':'apiError.desired.otherIntervalAssigned',{names});}
}
export async function assignDesiredState(v:Viewer,p:Record<string,unknown>){
 const parsed=z.array(z.guid()).min(1).max(100).safeParse(p.targets);if(!parsed.success)fail('apiError.desired.selectTargets');const targets=[...new Set(parsed.data!)],ver=await version(v,String(p.versionId??'')),interval=checkInterval(p.intervalSeconds);
 for(const id of targets)await authorizeSchedule(v,id,interval,p.confirmSystem);
 // Cross-customer: gate after the per-device checks, its guard in the insert, one customer entry per customer in the same batch.
 const customers=await authorizeTargetCustomers(v,targets);
 await assignmentConflict(targets,ver.id,interval);
 const authorization=featureTargetsGuard(v,targets,interval?['desired.manage','desired.apply']:['desired.manage']);
 const at=now(),candidate=targets.map(serverId=>({id:crypto.randomUUID(),serverId})),encoded=JSON.stringify(candidate);
 // One statement guards the entire target set. Concurrent requests cannot replace an
 // enabled assignment or leave a partially assigned bulk operation behind.
 const insertion=sql`INSERT INTO desired_assignments (id,server_id,version_id,assigned_by,assigned_at,enabled,interval_seconds,last_checked_at)
 SELECT target.value->>'id',target.value->>'serverId',${ver.id},${principal(v)},${at},1,${interval},NULL FROM jsonb_array_elements(${encoded}::jsonb) target
 WHERE EXISTS (SELECT 1 FROM desired_configs c JOIN desired_versions ver ON ver.config_id=c.id WHERE ver.id=${ver.id} AND c.archived=0)
 AND ${authorization}
 AND ${customers.guard}
 AND NOT EXISTS (SELECT 1 FROM desired_assignments WHERE server_id IN (SELECT value->>'serverId' FROM jsonb_array_elements(${encoded}::jsonb)) AND enabled=1 AND (version_id<>${ver.id} OR interval_seconds<>${interval}))
 AND NOT EXISTS (SELECT 1 FROM jobs j JOIN desired_runs r ON r.job_id=j.id WHERE j.state='running' AND j.server_id IN (SELECT value->>'serverId' FROM jsonb_array_elements(${encoded}::jsonb)) AND NOT EXISTS (SELECT 1 FROM desired_assignments a WHERE a.server_id=j.server_id AND a.enabled=1 AND a.version_id=${ver.id} AND a.interval_seconds=${interval}))
 ON CONFLICT(server_id) DO UPDATE SET id=excluded.id,version_id=excluded.version_id,assigned_by=excluded.assigned_by,assigned_at=excluded.assigned_at,enabled=1,interval_seconds=excluded.interval_seconds,last_checked_at=NULL,last_job_id=NULL,last_result_state=NULL,last_result_at=NULL,last_compliant=NULL,last_compliant_at=NULL WHERE desired_assignments.enabled=0
 RETURNING id,server_id`;
 // The customer entries exist only if this statement assigned at least one device (a fresh candidate id).
 const entries=customerEntries(customers,{actor:v.id,action:'Desired State kundenübergreifend zugewiesen',target:`${ver.id} / v${ver.version}`,condition:sql`EXISTS (SELECT 1 FROM desired_assignments WHERE id IN (SELECT value->>'id' FROM jsonb_array_elements(${encoded}::jsonb)))`});
 const results=await commitAll([insertion,sql`SELECT * FROM desired_assignments WHERE server_id IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(targets)}::jsonb)) AND enabled=1 AND ${authorization}`,...entries]),assignments=results[1].rows as unknown as AssignmentRow[];
 if(assignments.length!==targets.length||assignments.some(a=>a.version_id!==ver.id||a.interval_seconds!==interval)){if(!results[0].rows.length)await recheckCrossCustomer(v,customers);await assignmentConflict(targets,ver.id,interval);throw new HttpError('apiError.desired.assignBusy');}
 const inserted=new Set((results[0].rows as unknown as {id:string;server_id:string}[]).map(r=>r.id)),devices=targets.map(serverId=>{const assignment=assignments.find(a=>a.server_id===serverId)!;return {serverId,assignmentId:assignment.id,status:inserted.has(assignment.id)?'assigned' as const:'unchanged' as const};}),assigned=devices.filter(d=>d.status==='assigned').length,unchanged=devices.length-assigned;
 if(assigned)await log(v.id,'Desired-State-Version zugewiesen',`${ver.id} / v${ver.version}`,devices.filter(d=>d.status==='assigned').map(d=>d.serverId));
 return {ok:true,versionId:ver.id,summary:{assigned,unchanged},devices,...(assigned?unchanged?messageFields('serverMessage.desired.assignedSomeUnchanged',{version:ver.version,count:assigned,unchanged}):messageFields('serverMessage.desired.assigned',{version:ver.version,count:assigned}):messageFields('serverMessage.desired.alreadyAssigned'))};
}
export async function updateDesiredSchedule(v:Viewer,p:Record<string,unknown>){
 if(!guid(p.assignmentId)||!guid(p.versionId))fail('apiError.desired.invalidAssignmentOrVersion');
 if(typeof p.expectedIntervalSeconds!=='number')fail('apiError.desired.previousIntervalMissing');const interval=checkInterval(p.intervalSeconds),expected=checkInterval(p.expectedIntervalSeconds);
 const row=await db().one<AssignmentRow>(sql`SELECT * FROM desired_assignments WHERE id=${p.assignmentId as string} AND enabled=1`);if(!row)throw new HttpError('apiError.desired.activeAssignmentNotFound');
 await authorizeSchedule(v,row.server_id,interval,p.confirmSystem);
 if(row.version_id!==p.versionId||row.interval_seconds!==expected)throw new HttpError('apiError.desired.intervalChanged');
 if(interval===expected)return {ok:true,assignmentId:row.id,serverId:row.server_id,status:'unchanged',intervalSeconds:interval,...messageFields('serverMessage.desired.intervalUnchanged')};
 const authorization=featureTargetsGuard(v,[row.server_id],interval?['desired.manage','desired.apply']:['desired.manage']);
 const result=await db().exec(sql`UPDATE desired_assignments SET interval_seconds=${interval},assigned_by=${principal(v)},last_checked_at=NULL WHERE id=${row.id} AND enabled=1 AND version_id=${p.versionId} AND interval_seconds=${expected} AND EXISTS (SELECT 1 FROM desired_versions ver JOIN desired_configs c ON c.id=ver.config_id WHERE ver.id=desired_assignments.version_id AND c.archived=0) AND ${authorization}`);
 if(!result.rowCount)throw new HttpError('apiError.desired.intervalChanged');
 await log(v.id,'Desired-State-Prüfintervall geändert',`${row.version_id} / ${interval}`,row.server_id);return {ok:true,assignmentId:row.id,serverId:row.server_id,status:'updated',intervalSeconds:interval,...(interval?messageFields('serverMessage.desired.intervalChanged',{minutes:interval/60}):messageFields('serverMessage.desired.autoChecksOff'))};
}
export async function removeDesiredAssignment(v:Viewer,id:unknown){
 if(!guid(id))fail('apiError.desired.invalidAssignment');const row=await db().one<AssignmentRow>(sql`SELECT * FROM desired_assignments WHERE id=${id as string}`);if(!row)throw new HttpError('apiError.desired.assignmentNotFound');await requireDevice(v,row.server_id,'desired.manage');
 const authorization=featureTargetsGuard(v,[row.server_id],['desired.manage']);
 const results=await commitAll([sql`UPDATE desired_assignments SET enabled=0,interval_seconds=0 WHERE id=${id as string} AND enabled=1 AND NOT EXISTS (SELECT 1 FROM desired_runs r JOIN jobs j ON j.id=r.job_id WHERE r.assignment_id=${id as string} AND j.state='running') AND ${authorization}`,sql`UPDATE jobs SET state='cancelled',parameters='{}',result='serverMessage.desired.assignmentRemoved' WHERE state='pending' AND id IN (SELECT job_id FROM desired_runs WHERE assignment_id=${id as string}) AND NOT EXISTS (SELECT 1 FROM desired_assignments WHERE id=${id as string} AND enabled=1) AND ${authorization}`]);
 if(!results[0].rowCount&&!await db().one(sql`SELECT 1 WHERE ${authorization}`))throw new HttpError('apiError.desired.rightsChanged');
 if(!results[0].rowCount&&await db().one(sql`SELECT id FROM desired_assignments WHERE id=${id as string} AND enabled=1`))throw new HttpError('apiError.desired.removeRunning');
 const removed=!!results[0].rowCount;if(removed)await log(v.id,'Desired-State-Zuweisung entfernt',String(id),row.server_id);return {ok:true,assignmentId:id,serverId:row.server_id,status:removed?'removed':'unchanged',...messageFields(removed?'serverMessage.desired.assignmentRemovedNotice':'serverMessage.desired.assignmentAlreadyRemoved')};
}

function desiredAutomationApproval(value:unknown):EffectiveAutomation|null{
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const e=value as EffectiveAutomation;
 if(e.kind!=='desired'||e.slot!=='default'||!guid(e.id)||!guid(e.templateId)||!guid(e.scopeId)||!['group','device'].includes(e.scopeType)||typeof e.actor!=='string'||!/^(?:private|entra):/.test(e.actor)||!Number.isSafeInteger(e.authVersion)||e.authVersion<1||!Number.isSafeInteger(e.createdAt)||e.createdAt<0||e.disabled!==false||e.conflict!==false||!e.payload||!guid(e.payload.versionId)||!Number.isSafeInteger(e.payload.intervalSeconds)||Number(e.payload.intervalSeconds)<=0)return null;
 return e;
}
async function desiredAutomationGuard(e:EffectiveAutomation,serverId:string,assignmentId:string,options?:{serverExpression:string}):Promise<SqlGuard>{
 const {effectiveAutomationGuard}=await import('./automation-scopes');
 const effective=effectiveAutomationGuard(e,serverId,options),expression=options?sql.join(options.serverExpression.split('.').map(part=>sql.ident(part)),sql`.`):sql`${serverId}::text`;
 const rights=['desired.manage','desired.apply'].map(right=>devicePermissionGuard(sql`desired_approval.server_id`,sql`desired_approval.principal`,right as Permission));
 // Keep the central source, its approval and the exact derived local schedule
 // alive through the last delivery read. A local edit never inherits this grant.
 return sql`(${effective}) AND EXISTS (SELECT 1 FROM (SELECT ${e.actor}::text AS principal,${expression} AS server_id) desired_approval JOIN desired_assignments a ON a.server_id=desired_approval.server_id AND a.id=${assignmentId} AND a.enabled=1 AND a.assigned_by=desired_approval.principal AND a.version_id=${String(e.payload.versionId)} AND a.interval_seconds=${Number(e.payload.intervalSeconds)} JOIN automation_device_state state ON state.server_id=a.server_id AND state.kind='desired' AND state.slot=${e.slot} AND state.assignment_id=${e.id} AND state.resource_id=a.id AND state.resource_fingerprint=a.version_id||':'||a.interval_seconds AND state.status='applied' WHERE ${sql.join(rights.map(right=>sql`(${right})`),sql` AND `)})`;
}

// automationApproval is an internal argument, never copied from a request body.
export async function queueDesiredState(v:Viewer,p:Record<string,unknown>,automationApproval?:EffectiveAutomation){
 if(p.confirmSystem!==true)throw new HttpError('apiError.desired.approveSystem');
 if(p.action==='apply'&&p.confirmMaintenance!==true)throw new HttpError('apiError.desired.approveMaintenance');
 if(!guid(p.assignmentId))fail('apiError.desired.invalidAssignment');const a=await db().one<AssignmentRow>(sql`SELECT * FROM desired_assignments WHERE id=${p.assignmentId as string} AND enabled=1`);if(!a)throw new HttpError('apiError.desired.activeAssignmentNotFound');
 const device=await requireDevice(v,a.server_id,'desired.apply'),ver=await version(v,a.version_id),snapshot=device.snapshot?parse(device.snapshot) as ServerSnapshot:null;
 const operation=p.action==='apply'?'apply':'test',action='desired-state-'+operation;
 if(!device.management||snapshot?.mode!=='Management')throw new HttpError('apiError.desired.managementRequired');
 if(snapshot?.protocolVersion!==3||!snapshot.agentCapabilities?.includes(action))throw new HttpError('apiError.desired.agentUnsupported');
 if(!/Windows (?:Server (?:2022|2025)|11)/i.test(snapshot.os))throw new HttpError('apiError.desired.osUnsupported');
 if(automationApproval&&(!desiredAutomationApproval(automationApproval)||operation!=='test'||automationApproval.actor!==principal(v)||automationApproval.payload.versionId!==ver.id))throw new HttpError('apiError.desired.approvalChanged');
 const feature=featureTargetsGuard(v,[a.server_id],['desired.apply']),scope=automationApproval?await desiredAutomationGuard(automationApproval,a.server_id,a.id):sql`TRUE`;
 const authorization=sql`(${feature}) AND (${scope})`;
 const envelope=await sealAgentSecrets({content:ver.content},snapshot.publicKey),jobId=crypto.randomUUID(),runId=crypto.randomUUID(),at=now(),parameters={assignmentId:a.id,versionId:ver.id,engine:ver.engine,contentSha256:ver.sha256,...(ver.configuration_name?{configurationName:ver.configuration_name}:{}),parameters:parse(ver.parameters)??{},timeoutSeconds:900,configuration:envelope,...(automationApproval?{automationApproval}:{})};
 await commitAll([sql`INSERT INTO jobs (id,server_id,action,target,parameters,display_input,created_at,actor,actor_email,actor_principal) SELECT ${jobId},${a.server_id},${action},${`${ver.engine} / v${ver.version}`},${JSON.stringify(parameters)},${jobDisplayInput(action,parameters)},${at},${v.id},${v.label.trim().toLowerCase()},${principal(v)} WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE server_id=${a.server_id} AND state IN ('pending','running')) AND EXISTS (SELECT 1 FROM desired_assignments a JOIN desired_versions ver ON ver.id=a.version_id JOIN desired_configs c ON c.id=ver.config_id WHERE a.id=${a.id} AND a.enabled=1 AND a.version_id=${ver.id} AND c.archived=0) AND ${authorization}`,sql`INSERT INTO desired_runs (id,assignment_id,server_id,version_id,job_id,operation,created_at,created_by) SELECT ${runId},${a.id},${a.server_id},${ver.id},${jobId},${operation},${at},${principal(v)} WHERE EXISTS (SELECT 1 FROM jobs WHERE id=${jobId})`,sql`UPDATE desired_assignments SET last_checked_at=${at} WHERE id=${a.id} AND EXISTS (SELECT 1 FROM jobs WHERE id=${jobId})`]);
 if(!await db().one(sql`SELECT id FROM desired_runs WHERE id=${runId}`)){const current=await db().one(sql`SELECT id FROM desired_assignments WHERE id=${a.id} AND enabled=1 AND version_id=${ver.id}`);throw new HttpError(current?'apiError.desired.deviceBusy':'apiError.desired.assignmentChangedRestart');}
 await log(v.id,operation==='apply'?'Desired State anwenden':'Desired State prüfen',`${ver.id} / ${jobId}`,a.server_id);return {runId,jobId,assignmentId:a.id,serverId:a.server_id,versionId:ver.id,operation,state:'pending',...messageFields(operation==='apply'?'serverMessage.desired.applyScheduled':'serverMessage.desired.testScheduled')};
}

export async function advanceDesiredState(serverId:string){
 const a=await db().one<AssignmentRow>(sql`SELECT * FROM desired_assignments WHERE server_id=${serverId} AND enabled=1 AND interval_seconds>0 AND (last_checked_at IS NULL OR last_checked_at + interval_seconds*1000<=${now()})`);if(!a)return;
 const source=await db().one<{assignment_id:string|null;resource_id:string|null;resource_fingerprint:string|null;status:string}>(sql`SELECT assignment_id,resource_id,resource_fingerprint,status FROM automation_device_state WHERE server_id=${serverId} AND kind='desired' AND slot='default'`);
 let automationApproval:EffectiveAutomation|undefined;
 if(source?.resource_id===a.id&&source.status!=='local_override'){
  if(source.status!=='applied'||source.resource_fingerprint!==a.version_id+':'+a.interval_seconds)return;
  const {effectiveAutomationForDevice}=await import('./automation-scopes');
  const effective=(await effectiveAutomationForDevice(serverId,'desired')).find(e=>e.slot==='default');
  if(!effective||!desiredAutomationApproval(effective)||effective.id!==source.assignment_id||effective.actor!==a.assigned_by||effective.payload.versionId!==a.version_id||effective.payload.intervalSeconds!==a.interval_seconds)return;
  automationApproval=effective;
 }
 const actor=await resolvePrincipal(a.assigned_by);try{if(!actor||!await isMfaEnabled(actor))throw new HttpError('apiError.desired.approvalRevoked');await requireDevice(actor,serverId,'desired.apply');}catch{const stopped=await db().exec(sql`UPDATE desired_assignments SET interval_seconds=0 WHERE id=${a.id} AND assigned_by=${a.assigned_by} AND version_id=${a.version_id} AND interval_seconds=${a.interval_seconds} AND enabled=1`);if(stopped.rowCount)await log('System','Desired-State-Prüfplan wegen entzogener Rechte deaktiviert',a.id,serverId);return;}
 try{await queueDesiredState(actor!,{action:'test',assignmentId:a.id,confirmSystem:true},automationApproval);}catch(e){if(e instanceof HttpError&&[403,409].includes(e.status))return;throw e;}
}

type DesiredJob={id:string;server_id:string;action:string;actor_principal:string|null;parameters:string};
async function pendingDesiredDefinition(job:DesiredJob){
 const row=await db().one<{created_by:string;operation:string;version_id:string;assignment_id:string;engine:string;sha256:string;configuration_name:string|null;parameters:string}>(sql`SELECT r.created_by,r.operation,r.version_id,r.assignment_id,v.engine,v.sha256,v.configuration_name,v.parameters FROM desired_runs r JOIN desired_assignments a ON a.id=r.assignment_id JOIN desired_versions v ON v.id=r.version_id JOIN desired_configs c ON c.id=v.config_id AND c.archived=0 WHERE r.job_id=${job.id} AND r.server_id=${job.server_id} AND a.server_id=r.server_id AND a.enabled=1 AND a.version_id=r.version_id`);
 const p=parse(job.parameters);return row&&job.actor_principal!==null&&row.created_by===job.actor_principal&&job.action==='desired-state-'+row.operation&&p?.assignmentId===row.assignment_id&&p.versionId===row.version_id&&p.contentSha256===row.sha256&&p.engine===row.engine&&(p.configurationName??null)===row.configuration_name&&JSON.stringify(p.parameters??{})===JSON.stringify(parse(row.parameters)??{})?row:null;
}

// This predicate uses the outer jobs alias and is safe for both atomic claim
// and final parameter delivery. It must accompany the channel's live RBAC guard.
export async function desiredJobClaimGuard(jobId:string,serverId:string):Promise<SqlGuard>{
 const job=await db().one<DesiredJob>(sql`SELECT id,server_id,action,actor_principal,parameters FROM jobs WHERE id=${jobId} AND server_id=${serverId}`);
 if(!job||!job.action.startsWith('desired-state-'))return sql`FALSE`;
 const row=await pendingDesiredDefinition(job);if(!row)return sql`FALSE`;
 const p=parse(job.parameters),hasApproval=Object.prototype.hasOwnProperty.call(p,'automationApproval'),approval=hasApproval?desiredAutomationApproval(p.automationApproval):null;
 if(hasApproval&&(!approval||job.action!=='desired-state-test'||approval.actor!==row.created_by||approval.payload.versionId!==row.version_id))return sql`FALSE`;
 const scope=approval?await desiredAutomationGuard(approval,serverId,row.assignment_id,{serverExpression:'jobs.server_id'}):sql`TRUE`;
 return sql`jobs.id=${jobId} AND jobs.server_id=${serverId} AND jobs.parameters=${job.parameters} AND EXISTS (SELECT 1 FROM desired_runs r JOIN desired_assignments a ON a.id=r.assignment_id AND a.server_id=r.server_id AND a.enabled=1 AND a.version_id=r.version_id JOIN desired_versions ver ON ver.id=r.version_id JOIN desired_configs c ON c.id=ver.config_id AND c.archived=0 WHERE r.job_id=jobs.id AND r.server_id=jobs.server_id AND r.created_by=jobs.actor_principal AND jobs.action='desired-state-'||r.operation AND r.assignment_id=${row.assignment_id} AND r.version_id=${row.version_id} AND ver.engine=${row.engine} AND ver.sha256=${row.sha256} AND COALESCE(ver.configuration_name,'')=${row.configuration_name??''} AND ver.parameters=${row.parameters}) AND (${scope})`;
}

export async function checkPendingDesiredJob(job:DesiredJob){
 if(!job.action.startsWith('desired-state-'))return true;
 if(!await pendingDesiredDefinition(job))return false;
 const guard=await desiredJobClaimGuard(job.id,job.server_id);
 return !!await db().one(sql`SELECT 1 FROM jobs WHERE id=${job.id} AND parameters=${job.parameters} AND action=${job.action} AND actor_principal IS NOT DISTINCT FROM ${job.actor_principal} AND (${guard})`);
}

export const githubSourceSchema=z.object({owner:z.string().min(1).max(100).regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/),repository:z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/).refine(v=>v!=='.'&&v!=='..'),ref:z.string().min(1).max(200).regex(/^[A-Za-z0-9_./-]+$/),path:z.string().min(1).max(500).refine(p=>p.split('/').every(part=>!!part&&part!=='.'&&part!=='..'&&!/[\x00-\x1f\\?#]/.test(part)),'Ungültiger Repository-Pfad.')}).strict();
async function githubJson(endpoint:string,usePrivateToken:boolean,v:Viewer){
 if(usePrivateToken&&config('DESIRED_STATE_GITHUB_TOKEN')&&!await can(v,'instance.owner',{fresh:true}))throw new HttpError('apiError.desired.githubRightsChanged');
 const token=usePrivateToken?config('DESIRED_STATE_GITHUB_TOKEN'):'',response=await fetch('https://api.github.com'+endpoint,{headers:{Accept:'application/vnd.github+json','User-Agent':'ServerDesk','X-GitHub-Api-Version':'2022-11-28',...(token?{Authorization:'Bearer '+token}:{})},redirect:'manual',signal:AbortSignal.timeout(12000)});
 if(!response.ok)throw new HttpError(response.status===404?'apiError.desired.githubNotFound':response.status===403||response.status===429?'apiError.desired.githubLimit':'apiError.desired.githubUnreachable');
 const reader=response.body?.getReader(),chunks:Uint8Array[]=[];let length=0;if(!reader)throw new HttpError('apiError.desired.githubNoReply');try{while(true){const item=await reader.read();if(item.done)break;length+=item.value.length;if(length>150000){await reader.cancel();throw new HttpError('apiError.desired.githubFileTooLarge');}chunks.push(item.value);}}finally{reader.releaseLock();}const bytes=new Uint8Array(length);let offset=0;for(const item of chunks){bytes.set(item,offset);offset+=item.length;}try{return JSON.parse(new TextDecoder().decode(bytes)) as Record<string,unknown>;}catch{throw new HttpError('apiError.desired.githubInvalidReply');}
}
export async function importDesiredGithub(v:Viewer,p:Record<string,unknown>){
 await mayManage(v,typeof p.serverId==='string'?p.serverId:undefined);if(p.configId)await configuration(v,String(p.configId),'desired.manage');
 const parsed=githubSourceSchema.safeParse(p.github);if(!parsed.success)fail('apiError.desired.githubCheckInput');const source=parsed.data!,base=`/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repository)}`;
 const privateRepo=config('DESIRED_STATE_GITHUB_REPOSITORIES').split(',').map(r=>r.trim().toLowerCase()).includes((source.owner+'/'+source.repository).toLowerCase());
 if(privateRepo&&config('DESIRED_STATE_GITHUB_TOKEN'))await requireCan(v,'instance.owner','apiError.desired.githubAdminOnly');
 const commit=await githubJson(base+'/commits/'+encodeURIComponent(source.ref),privateRepo,v),sha=String(commit.sha??'');if(!/^[0-9a-f]{40}$/.test(sha))throw new HttpError('apiError.desired.githubCommitAmbiguous');
 const blob=await githubJson(base+'/contents/'+source.path.split('/').map(encodeURIComponent).join('/')+'?ref='+sha,privateRepo,v);if(blob.type!=='file'||blob.encoding!=='base64'||typeof blob.content!=='string'||Number(blob.size)>65536)throw new HttpError('apiError.desired.githubFileSelect');
 let content:string;try{const binary=atob(blob.content.replace(/\s/g,'')),bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));content=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new HttpError('apiError.desired.githubUtf8');}
 return createDesiredVersion(v,{...p,content},{kind:'github',owner:source.owner,repository:source.repository,ref:source.ref,path:source.path,commit:sha,...(privateRepo&&config('DESIRED_STATE_GITHUB_TOKEN')?{authenticated:'true'}:{})});
}
