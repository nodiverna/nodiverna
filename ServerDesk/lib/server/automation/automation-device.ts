import {now} from '../context';
import {featureDeviceGuard} from '../identity/feature-authorization';
import {automationAssignmentActor,automationFingerprint,effectiveAutomationForDevice,effectiveAutomationGuard} from './automation-scopes';
import type {EffectiveAutomation} from '../../automation-resolution';
import type {Permission} from '../identity/access';
import type {DriftPolicy} from './drift';
import {commitAll,db,sql} from '../db';
import {HttpError} from '../../errors/http-error';
import {storedReason} from '../../server-messages';

type State={server_id:string;kind:string;slot:string;assignment_id:string|null;fingerprint:string|null;resource_id:string|null;resource_fingerprint:string|null;status:string;message:string;updated_at:number};
/** The stored reason of a failed check: the key of an HttpError without params, else its defaultLocale text, else a generic key. */
const message=(error:unknown)=>error instanceof HttpError?storedReason(error):'serverMessage.automation.checkFailed';
const stateFor=async(serverId:string,kind:string,slot:string)=>db().one<State>(sql`SELECT * FROM automation_device_state WHERE server_id=${serverId} AND kind=${kind} AND slot=${slot}`);
async function status(serverId:string,e:Pick<EffectiveAutomation,'kind'|'slot'|'id'>,state:string,note:string,resourceId:string|null=null){
 await db().exec(sql`INSERT INTO automation_device_state(server_id,kind,slot,assignment_id,status,message,resource_id,updated_at) VALUES(${serverId},${e.kind},${e.slot},${e.id},${state},${note},${resourceId},${now()}) ON CONFLICT(server_id,kind,slot) DO UPDATE SET assignment_id=excluded.assignment_id,status=excluded.status,message=excluded.message,updated_at=excluded.updated_at`);
}
async function suspend(serverId:string,previous:State|null,e:Pick<EffectiveAutomation,'kind'|'slot'|'id'>,state:string,note:string){
 const d=db();
 // A withdrawn inherited source stops collection or future checks, but never
 // modifies the local Windows configuration or interrupts a claimed job.
 if(previous?.resource_id){
  if(e.kind==='drift')await d.exec(sql`UPDATE drift_policies SET enabled=0,policy=jsonb_set(policy::jsonb,'{enabled}','false'::jsonb)::text WHERE server_id=${serverId} AND id||':'||version=${previous.resource_id} AND policy=${previous.resource_fingerprint}`);
  if(e.kind==='desired')await d.exec(sql`UPDATE desired_assignments SET enabled=0,interval_seconds=0 WHERE server_id=${serverId} AND id=${previous.resource_id} AND version_id||':'||interval_seconds=${previous.resource_fingerprint} AND enabled=1`);
 }
 await status(serverId,e,state,note,previous?.resource_id??null);
}

async function applyDrift(serverId:string,e:EffectiveAutomation,previous:State|null){
 const actor=await automationAssignmentActor(e,serverId);if(!actor){await suspend(serverId,previous,e,'blocked','serverMessage.automation.approvalMissing');return;}
 const d=db(),policy=e.payload.policy as DriftPolicy,current=await d.one<{id:string;version:number;policy:string;created_at:number}>(sql`SELECT id,version,policy,created_at FROM drift_policies WHERE server_id=${serverId}`);
 const currentResource=current?current.id+':'+current.version:null;
 if(previous?.assignment_id===e.id&&['applied','local_override'].includes(previous.status)&&previous.resource_id&&current&&(currentResource!==previous.resource_id||current.policy!==previous.resource_fingerprint)){await status(serverId,e,'local_override','serverMessage.automation.localPolicy');return;}
 if(current&&e.scopeType==='group'&&(!previous?.resource_id||currentResource!==previous.resource_id)){
  await status(serverId,e,'local_override','serverMessage.automation.localPolicy');return;
 }
 const rights:Permission[]=['drift.manage'];if(policy.includeConfigValues||policy.paths.some(p=>p.includeText)||policy.registry.some(r=>r.includeValues))rights.push('drift.contents');
 const feature=featureDeviceGuard(actor,serverId,rights),effective=effectiveAutomationGuard(e,serverId),fingerprint=await automationFingerprint(e),at=now(),id=current?.id??crypto.randomUUID(),version=(current?.version??0)+1,baselineId=crypto.randomUUID();
 if(previous?.fingerprint===fingerprint&&currentResource===previous.resource_id&&previous.status==='applied')return;
 const guard=sql`(${feature}) AND (${effective})`;
 const oldFence=current?sql`EXISTS (SELECT 1 FROM drift_policies WHERE server_id=${serverId} AND id=${current.id} AND version=${current.version} AND policy=${current.policy})`:sql`NOT EXISTS (SELECT 1 FROM drift_policies WHERE server_id=${serverId})`;
 const resource=id+':'+version,receipt=crypto.randomUUID();
 const saved=await commitAll([
  sql`INSERT INTO drift_policies(server_id,id,version,enabled,policy,created_at,updated_at,updated_by) SELECT ${serverId},${id},${version},${policy.enabled?1:0},${JSON.stringify(policy)},${current?.created_at??at},${at},${e.actor} WHERE ${guard} AND ${oldFence} ON CONFLICT(server_id) DO UPDATE SET version=excluded.version,enabled=excluded.enabled,policy=excluded.policy,updated_at=excluded.updated_at,updated_by=excluded.updated_by`,
  // Written only when the policy write above changed its row (replaces a changed-rows check).
  {afterChange:sql`INSERT INTO automation_device_state(server_id,kind,slot,assignment_id,fingerprint,resource_id,resource_fingerprint,status,message,updated_at) VALUES(${serverId},'drift',${e.slot},${e.id},${fingerprint},${resource},${JSON.stringify(policy)},'applying',${receipt},${at}) ON CONFLICT(server_id,kind,slot) DO UPDATE SET assignment_id=excluded.assignment_id,fingerprint=excluded.fingerprint,resource_id=excluded.resource_id,resource_fingerprint=excluded.resource_fingerprint,status='applying',message=excluded.message,updated_at=excluded.updated_at`},
  ...(Array.isArray(e.payload.baseline)?[sql`INSERT INTO drift_baselines(id,server_id,policy_version,report_id,entries,created_at,created_by) SELECT ${baselineId},${serverId},${version},${e.payload.sourceReportId as string},${JSON.stringify(e.payload.baseline)},${at},${e.actor} WHERE EXISTS (SELECT 1 FROM automation_device_state WHERE server_id=${serverId} AND kind='drift' AND slot=${e.slot} AND assignment_id=${e.id} AND status='applying' AND message=${receipt})`]:[]),
  sql`UPDATE automation_device_state SET status='applied',message='' WHERE server_id=${serverId} AND kind='drift' AND slot=${e.slot} AND assignment_id=${e.id} AND status='applying' AND message=${receipt}`
 ]);
 if(!saved[0].rowCount)await status(serverId,e,'pending','serverMessage.automation.recheckNextReport');
}

async function applyDesired(serverId:string,e:EffectiveAutomation,previous:State|null){
 const actor=await automationAssignmentActor(e,serverId);if(!actor){await suspend(serverId,previous,e,'blocked','serverMessage.automation.approvalMissing');return;}
 const d=db(),current=await d.one<{id:string;version_id:string;interval_seconds:number;enabled:number}>(sql`SELECT id,version_id,interval_seconds,enabled FROM desired_assignments WHERE server_id=${serverId}`);
 if(previous?.assignment_id===e.id&&['applied','local_override'].includes(previous.status)&&previous.resource_id&&current&&(current.id!==previous.resource_id||!current.enabled||current.version_id+':'+current.interval_seconds!==previous.resource_fingerprint)){await status(serverId,e,'local_override','serverMessage.automation.localConfiguration');return;}
 if(current?.enabled&&e.scopeType==='group'&&current.id!==previous?.resource_id){await status(serverId,e,'local_override','serverMessage.automation.localConfiguration');return;}
 const fingerprint=await automationFingerprint(e);if(previous?.fingerprint===fingerprint&&current?.id===previous.resource_id&&current.enabled&&current.version_id===e.payload.versionId&&current.interval_seconds===e.payload.intervalSeconds&&previous.status==='applied')return;
 const interval=Number(e.payload.intervalSeconds),device=await d.one<{management:number;snapshot:string|null}>(sql`SELECT management,snapshot FROM servers WHERE id=${serverId} AND revoked=0`),snapshot=device?.snapshot?JSON.parse(device.snapshot):null;
 if(interval&&(!device?.management||snapshot?.mode!=='Management'||!snapshot?.agentCapabilities?.includes('desired-state-test'))){await suspend(serverId,previous,e,'blocked','serverMessage.automation.managementRequired');return;}
 const feature=featureDeviceGuard(actor,serverId,interval?['desired.manage','desired.apply']:['desired.manage']),effective=effectiveAutomationGuard(e,serverId),guard=sql`(${feature}) AND (${effective})`,id=crypto.randomUUID(),at=now();
 const fence=current?sql`EXISTS (SELECT 1 FROM desired_assignments WHERE server_id=${serverId} AND id=${current.id} AND version_id=${current.version_id} AND interval_seconds=${current.interval_seconds} AND enabled=${current.enabled})`:sql`NOT EXISTS (SELECT 1 FROM desired_assignments WHERE server_id=${serverId})`;
 const saved=await commitAll([
  sql`INSERT INTO desired_assignments(id,server_id,version_id,assigned_by,assigned_at,enabled,interval_seconds,last_checked_at) SELECT ${id},${serverId},${e.payload.versionId as string},${e.actor},${at},1,${interval},NULL WHERE ${guard} AND ${fence} AND EXISTS (SELECT 1 FROM desired_versions v JOIN desired_configs c ON c.id=v.config_id WHERE v.id=${e.payload.versionId as string} AND c.archived=0) AND NOT EXISTS (SELECT 1 FROM desired_runs r JOIN jobs j ON j.id=r.job_id WHERE r.server_id=${serverId} AND j.state='running') ON CONFLICT(server_id) DO UPDATE SET id=excluded.id,version_id=excluded.version_id,assigned_by=excluded.assigned_by,assigned_at=excluded.assigned_at,enabled=1,interval_seconds=excluded.interval_seconds,last_checked_at=NULL,last_job_id=NULL,last_result_state=NULL,last_result_at=NULL,last_compliant=NULL,last_compliant_at=NULL`,
  sql`UPDATE jobs SET state='cancelled',parameters='{}',result='serverMessage.automation.assignmentChanged' WHERE server_id=${serverId} AND state='pending' AND id IN (SELECT job_id FROM desired_runs WHERE server_id=${serverId} AND assignment_id<>${id}) AND EXISTS (SELECT 1 FROM desired_assignments WHERE id=${id})`,
  sql`INSERT INTO automation_device_state(server_id,kind,slot,assignment_id,fingerprint,resource_id,resource_fingerprint,status,message,updated_at) SELECT ${serverId},'desired',${e.slot},${e.id},${fingerprint},${id},${e.payload.versionId+':'+interval},'applied','',${at} WHERE EXISTS (SELECT 1 FROM desired_assignments WHERE id=${id}) AND ${guard} ON CONFLICT(server_id,kind,slot) DO UPDATE SET assignment_id=excluded.assignment_id,fingerprint=excluded.fingerprint,resource_id=excluded.resource_id,resource_fingerprint=excluded.resource_fingerprint,status='applied',message='',updated_at=excluded.updated_at`
 ]);
 if(!saved[0].rowCount)await status(serverId,e,'pending','serverMessage.automation.checkRunning');
}

export async function reconcileDeviceAutomation(serverId:string){
 const effective=(await effectiveAutomationForDevice(serverId)).filter(e=>e.kind!=='runbook'),keys=new Set(effective.map(e=>e.kind+':'+e.slot));
 const old=(await db().query<State>(sql`SELECT * FROM automation_device_state WHERE server_id=${serverId} AND kind IN ('drift','desired')`));
 for(const previous of old)if(!keys.has(previous.kind+':'+previous.slot))await suspend(serverId,previous,{kind:previous.kind as 'drift'|'desired',slot:previous.slot,id:previous.assignment_id??''},'removed','serverMessage.automation.noInheritedAssignment');
 for(const e of effective){const previous=await stateFor(serverId,e.kind,e.slot);try{
  if(e.conflict||e.disabled){await suspend(serverId,previous,e,e.conflict?'conflict':'paused',e.conflict?'serverMessage.automation.conflict':'serverMessage.automation.paused');continue;}
  if(e.kind==='drift')await applyDrift(serverId,e,previous);else await applyDesired(serverId,e,previous);
 }catch(error){await suspend(serverId,previous,e,'blocked',message(error));}}
}

// Reconciliation materializes a policy; it does not grant a durable right to
// collect. Decide authorization and enabled from one final database snapshot,
// after all asynchronous account/MFA checks. A local edit changes its exact
// resource identity or policy and remains independent of the inherited source.
export async function getAutomationDriftPolicy(serverId:string){
 const previous=await stateFor(serverId,'drift','default'),choice=(await effectiveAutomationForDevice(serverId,'drift')).find(e=>e.slot==='default');
 let authorization=sql`FALSE`,assignmentId='',fingerprint='';
 if(choice){
  const actor=await automationAssignmentActor(choice,serverId);
  if(actor){
   const policy=choice.payload.policy as DriftPolicy,rights:Permission[]=['drift.manage'];
   if(policy.includeConfigValues||policy.paths.some(p=>p.includeText)||policy.registry.some(r=>r.includeValues))rights.push('drift.contents');
   const feature=featureDeviceGuard(actor,serverId,rights),effective=effectiveAutomationGuard(choice,serverId);
   authorization=sql`(${feature}) AND (${effective}) AND EXISTS (SELECT 1 FROM automation_scope_assignments delivery_assignment JOIN automation_templates delivery_template ON delivery_template.id=delivery_assignment.template_id AND delivery_template.archived=0 WHERE delivery_assignment.id=${choice.id} AND delivery_template.payload=${JSON.stringify(choice.payload)})`;
   assignmentId=choice.id;fingerprint=await automationFingerprint(choice);
  }
 }
 const row=await db().one<{id:string;version:number;enabled:number;policy:string}>(sql`SELECT policy.id,policy.version,policy.policy,
  CASE WHEN policy.enabled=1 AND EXISTS (SELECT 1 FROM servers WHERE id=policy.server_id AND revoked=0) AND (
   (NOT (policy.id||':'||policy.version=${previous?.resource_id??''} AND policy.policy=${previous?.resource_fingerprint??''}) AND NOT EXISTS (
    SELECT 1 FROM automation_device_state inherited WHERE inherited.server_id=policy.server_id AND inherited.kind='drift' AND inherited.slot='default' AND inherited.resource_id=policy.id||':'||policy.version AND inherited.resource_fingerprint=policy.policy
   )) OR EXISTS (
    SELECT 1 FROM automation_device_state approved WHERE approved.server_id=policy.server_id AND approved.kind='drift' AND approved.slot='default' AND approved.status='applied' AND approved.assignment_id=${assignmentId} AND approved.fingerprint=${fingerprint} AND approved.resource_id=policy.id||':'||policy.version AND approved.resource_fingerprint=policy.policy AND (${authorization})
   )
  ) THEN 1 ELSE 0 END AS enabled
  FROM drift_policies policy WHERE policy.server_id=${serverId}`);
 if(!row)return {enabled:false};
 return {policyId:row.id,version:row.version,...JSON.parse(row.policy) as DriftPolicy,enabled:!!row.enabled};
}
