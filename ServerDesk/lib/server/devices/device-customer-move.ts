import {guid,HttpError,now} from '../context';
import {customerAccessGuard,customerPermissionGuard,devicePermissionGuard,effectivePermissions,groupPermissionGuard,guardPasses,principal,type Permission,type SqlGuard} from '../identity/access';
import {featureTargetsGuard} from '../identity/feature-authorization';
import {authorizeTargetCustomers,recheckCrossCustomer} from '../identity/cross-customer';
import type {ManagementAuthorization} from '../identity/rbac';
import {auditEvent} from '../audit';
import {dbFailure} from '../errors/db-codes';
import {deviceCustomerAuditActions} from '../../audit-actions';
import {sweepTransfers} from './transfers';
import type {Viewer} from '../../types';
import {commitAll,db,sql,type Step,type StepResult} from '../db';

// Moving enrolled devices to another customer (docs/customers.md "Move devices to
// another customer"). The agent keeps its token, key and mode, so nothing is
// reinstalled and no job is queued. What is bound to the old customer ends: the
// group membership (and with it every inherited right, tag, rule and automation),
// the role and automation assignments set on the device itself, the Desired State
// assignments and the waiting work. What describes the machine stays: inventory,
// metrics, alarms, job history, own tags, alert and ESU overrides, drift data and
// the earlier audit rows. The move changes which technicians see the devices, so it
// needs a fresh step-up proof (lib/step-up.ts, rule 1), which the batch consumes.

/** The rights a move needs on every device and on the target (group, or the customer without a group). */
export const deviceCustomerMoveRights:readonly Permission[]=['manage','groups.manage'];
export type DeviceCustomerMove={ids:string[];customerId:string;groupId:string|null};
/**
 * The syntactic check of a move request: 1–100 device GUIDs (duplicates merged, the
 * first position counts), an explicit confirm, the target customer as a GUID and the
 * target group as a GUID or null ("Ungrouped"). The console route runs it before
 * requireMfa and before it reads the step-up proof, so a request that can never
 * succeed gets its 400 without asking for MFA; moveDevicesToCustomer runs it again.
 */
export function validateDeviceCustomerMove(input:{ids?:unknown;customerId?:unknown;groupId?:unknown;confirm?:unknown}):DeviceCustomerMove{
 const value=input.ids;
 if(!Array.isArray(value)||!value.length||value.length>100||value.some(id=>!guid(id)))throw new HttpError('apiError.devices.selectRange');
 if(input.confirm!==true)throw new HttpError('apiError.devices.moveConfirm');
 if(!guid(input.customerId))throw new HttpError('apiError.customer.invalid');
 if(input.groupId!==null&&!guid(input.groupId))throw new HttpError('apiError.devices.moveGroupInvalid');
 return {ids:[...new Set(value as string[])],customerId:input.customerId as string,groupId:input.groupId as string|null};
}

type MovedDevice={id:string;name:string;customer_id:string;customer_name:string|null};
/** The name of the transaction-local setting that carries the admission receipt of one move. */
const receiptSetting='serverdesk.device_move';
const reason='serverMessage.device.movedCustomer';

/**
 * Moves 1–100 devices to the target customer and, with groupId, into one of its
 * groups. The pre-checks answer in this order: a device that is unknown, removed or
 * not visible (404), the target customer (404, or 409 when disabled), the group
 * (404, or 400 when it belongs to another customer), a device already in the target
 * customer (400), the rights (403) and, for devices of two or more customers, the
 * cross-customer gate (403).
 *
 * One batch commits the move. Its first statement is the admission: it checks every
 * condition live (proof, session, rights on every device and on the target, the
 * customer boundary of the target, the cross-customer right, and that no device,
 * customer or target group changed since the read) and only then sets a
 * transaction-local receipt (set_config, a fresh UUID). Every later statement runs
 * only while the receipt holds, so a refused admission changes nothing and a
 * statement that removes the actor's own right (a device assignment, the old
 * membership) cannot stop the batch halfway. A retry of the transaction starts
 * without the receipt and runs the admission again.
 */
export async function moveDevicesToCustomer(actor:Viewer,input:{ids?:unknown;customerId?:unknown;groupId?:unknown;confirm?:unknown},proof:ManagementAuthorization){
 const {ids,customerId,groupId}=validateDeviceCustomerMove(input);
 const d=db(),me=sql`${principal(actor)}`,scope=JSON.stringify(ids),targets=sql`IN (SELECT jsonb_array_elements_text(${scope}::jsonb))`;
 // A device outside the boundary or without view answers as if it did not exist.
 const rows=await d.query<MovedDevice>(sql`SELECT device.id,device.name,device.customer_id,source.name AS customer_name FROM servers device LEFT JOIN customers source ON source.id=device.customer_id WHERE device.id ${targets} AND device.revoked=0 AND ${customerAccessGuard(sql`device.customer_id`,me)} AND ${devicePermissionGuard(sql`device.id`,me,'view')}`);
 if(rows.length!==ids.length)throw new HttpError('apiError.devices.moveNotFound');
 const byId=new Map(rows.map(row=>[row.id,row])),devices=ids.map(id=>byId.get(id)!);
 const target=await d.one<{id:string;name:string;status:string}>(sql`SELECT id,name,status FROM customers WHERE id=${customerId} AND ${customerAccessGuard(sql`customers.id`,me)}`);
 if(!target)throw new HttpError('apiError.customer.unavailable');
 if(target.status==='disabled')throw new HttpError('apiError.customer.disabled');
 if(groupId!==null){
  const group=await d.one<{customer_id:string}>(sql`SELECT customer_id FROM device_groups WHERE id=${groupId} AND ${customerAccessGuard(sql`device_groups.customer_id`,me)}`);
  if(!group)throw new HttpError('apiError.group.notFound');
  if(group.customer_id!==customerId)throw new HttpError('apiError.devices.moveGroupInvalid');
 }
 const same=devices.find(device=>device.customer_id===customerId);
 if(same)throw new HttpError('apiError.devices.moveSameCustomer',{name:same.name});
 // Rights: both on every device (device, group or global scope inside the boundary) and on the target.
 const rights=[...deviceCustomerMoveRights],granted=await effectivePermissions(actor,ids);
 const targetRights:SqlGuard=sql.join(rights.map(right=>sql`(${groupId===null?customerPermissionGuard(sql`${customerId}`,me,right):groupPermissionGuard(sql`${groupId}`,me,right)})`),sql` AND `);
 if(ids.some(id=>rights.some(right=>!granted.get(id)?.includes(right)))||!await guardPasses(targetRights))throw new HttpError('apiError.devices.moveForbidden');
 // Devices of two or more customers go through the cross-customer gate; one source customer never reaches it.
 const sources=await authorizeTargetCustomers(actor,ids);

 const at=now(),marker=crypto.randomUUID(),action=deviceCustomerAuditActions.move;
 // The read set at commit: every device still live in the customer read above,
 // the target customer, and the target group with its ancestry in the target customer.
 const expected=JSON.stringify(devices.map(device=>({id:device.id,customer:device.customer_id})));
 const fences:SqlGuard[]=[
  sql`NOT EXISTS (SELECT 1 FROM jsonb_array_elements(${expected}::jsonb) expected LEFT JOIN servers live ON live.id=expected.value->>'id' WHERE live.id IS NULL OR live.revoked<>0 OR live.customer_id<>expected.value->>'customer')`,
  sql`EXISTS (SELECT 1 FROM customers target_customer WHERE target_customer.id=${customerId})`
 ];
 if(groupId!==null){
  const ancestry=JSON.stringify((await d.query<{ancestor_id:string;depth:number}>(sql`SELECT ancestor_id,depth FROM device_group_ancestors WHERE group_id=${groupId} ORDER BY depth,ancestor_id`)).map(path=>[path.ancestor_id,Number(path.depth)]));
  fences.push(sql`EXISTS (SELECT 1 FROM device_groups target_group WHERE target_group.id=${groupId} AND target_group.customer_id=${customerId})`,
   sql`coalesce((SELECT jsonb_agg(jsonb_build_array(ancestor_id,depth) ORDER BY depth,ancestor_id) FROM device_group_ancestors WHERE group_id=${groupId}),'[]'::jsonb)=${ancestry}::jsonb`);
 }
 const admission=sql.join([proof.guard,featureTargetsGuard(actor,ids,rights),targetRights,customerAccessGuard(sql`${customerId}`,me),sources.guard,...fences].map(guard=>sql`(${guard})`),sql` AND `);
 const receipt=sql`current_setting(${receiptSetting},true)=${marker}`;
 const steps:Step[]=[
  sql`SELECT set_config(${receiptSetting},${marker},true) AS admitted WHERE ${admission}`,
  // Before the customer changes: its triggers refuse a membership in a group of
  // another customer and a device assignment of a customer role or template of the old customer.
  sql`DELETE FROM device_group_members WHERE server_id ${targets} AND ${receipt}`,
  sql`DELETE FROM role_assignments WHERE scope_type='device' AND scope_id ${targets} AND ${receipt}`,
  sql`DELETE FROM automation_scope_assignments WHERE scope_type='device' AND scope_id ${targets} AND ${receipt}`,
  sql`UPDATE desired_assignments SET enabled=0,interval_seconds=0 WHERE server_id ${targets} AND ${receipt}`,
  // Waiting work ends; running jobs and running runbook entries finish on the agent.
  sql`UPDATE jobs SET state='cancelled',parameters='{}',result=${reason} WHERE server_id ${targets} AND state='pending' AND ${receipt}`,
  sql`DELETE FROM terminal_frames WHERE session_id IN (SELECT id FROM terminal_sessions WHERE server_id ${targets} AND state IN ('opening','open')) AND ${receipt}`,
  sql`UPDATE terminal_sessions SET state='closed',last_activity=${at},expires_at=${at},error=${reason} WHERE server_id ${targets} AND state IN ('opening','open') AND ${receipt}`,
  sql`DELETE FROM rdp_frames WHERE session_id IN (SELECT id FROM rdp_sessions WHERE server_id ${targets} AND state IN ('opening','open')) AND ${receipt}`,
  sql`DELETE FROM rdp_receipts WHERE session_id IN (SELECT id FROM rdp_sessions WHERE server_id ${targets} AND state IN ('opening','open')) AND ${receipt}`,
  sql`UPDATE rdp_sessions SET state='closed',key_envelope=NULL,last_presence=${at},expires_at=${at},error=${reason} WHERE server_id ${targets} AND state IN ('opening','open') AND ${receipt}`,
  // Cancelled transfers form the cleanup queue of sweepTransfers below.
  sql`UPDATE transfers SET state='cancelled',updated_at=${at},expires_at=${at},message=${reason} WHERE server_id ${targets} AND state NOT IN ('completed','cancelled','failed','expired') AND ${receipt}`,
  sql`DELETE FROM plugin_ad_sessions WHERE server_id ${targets} AND ${receipt}`,
  // The devices leave every runbook schedule with their sealed secrets; a schedule without targets is disabled (as in the removal).
  sql`UPDATE runbook_schedules SET targets=(SELECT COALESCE(jsonb_agg(remaining.value),'[]'::jsonb)::text FROM jsonb_array_elements_text(runbook_schedules.targets::jsonb) remaining WHERE remaining.value NOT ${targets}),sealed_secrets=(SELECT COALESCE(jsonb_object_agg(sealed.key,sealed.value),'{}'::jsonb)::text FROM jsonb_each(runbook_schedules.sealed_secrets::jsonb) sealed WHERE sealed.key NOT ${targets}),enabled=CASE WHEN (SELECT count(*) FROM jsonb_array_elements_text(runbook_schedules.targets::jsonb) remaining WHERE remaining.value NOT ${targets})=0 THEN 0 ELSE enabled END WHERE EXISTS (SELECT 1 FROM jsonb_array_elements_text(runbook_schedules.targets::jsonb) target WHERE target.value ${targets}) AND ${receipt}`,
  sql`UPDATE runbook_run_devices SET state='cancelled',finished_at=${at},sealed_secrets='{}',result=${reason},result_code=NULL,result_args=NULL WHERE server_id ${targets} AND state='queued' AND ${receipt}`,
  sql`UPDATE runbook_runs SET state=CASE WHEN EXISTS (SELECT 1 FROM runbook_run_devices x WHERE x.run_id=runbook_runs.id AND x.state='unknown') THEN 'unknown' WHEN EXISTS (SELECT 1 FROM runbook_run_devices x WHERE x.run_id=runbook_runs.id AND x.state='failed') THEN 'failed' WHEN EXISTS (SELECT 1 FROM runbook_run_devices x WHERE x.run_id=runbook_runs.id AND x.state='cancelled') THEN 'cancelled' ELSE 'succeeded' END,finished_at=${at} WHERE state IN ('queued','running') AND id IN (SELECT run_id FROM runbook_run_devices WHERE server_id ${targets}) AND NOT EXISTS (SELECT 1 FROM runbook_run_devices x WHERE x.run_id=runbook_runs.id AND x.state IN ('queued','running')) AND ${receipt}`,
  // The source customer's row is a portal row: a device row must carry the device's current customer (audit_insert_customer).
  ...devices.flatMap(device=>auditEvent({actor:actor.label,action,target:`${device.name} / ${device.id} → ${target.name}`,customerId:device.customer_id,guard:receipt,at})),
  sql`UPDATE servers SET customer_id=${customerId} WHERE id ${targets} AND revoked=0 AND ${receipt}`,
  ...(groupId===null?[]:[sql`INSERT INTO device_group_members(server_id,group_id) SELECT value,${groupId}::text FROM jsonb_array_elements_text(${scope}::jsonb) WHERE ${receipt}`]),
  ...devices.flatMap(device=>auditEvent({actor:actor.label,action,target:`${device.name} / ${device.id} ← ${device.customer_name??''}`,serverIds:device.id,customerId,guard:receipt,at})),
  sql`DELETE FROM mfa_management_proofs WHERE token_hash=${proof.tokenHash} AND principal=${proof.key} AND session_hash=${proof.sessionHash} AND ${receipt}`,
  sql`SELECT 1 AS moved WHERE ${receipt}`
 ];
 let results:StepResult[];
 try{results=await commitAll(steps);}
 catch(error){
  // A trigger of the customer change: the target customer was disabled or deleted, or a binding to the old customer appeared.
  const conflict=dbFailure(error,{'customer-mismatch':{key:'apiError.devices.moveChanged'}},['customer-disabled','customer-missing','customer-mismatch']);
  if(conflict)throw new HttpError(conflict.key);
  throw error;
 }
 if(!results[0]?.rows.length){
  if(!await guardPasses(proof.guard))throw new HttpError('apiError.mfa.proofExpired');
  await recheckCrossCustomer(actor,sources);
  throw new HttpError('apiError.devices.moveChanged');
 }
 // The object storage of the cancelled transfers; a failure is retried by the regular sweeps.
 for(const id of ids){try{await sweepTransfers(id);}catch{console.error('Transfer cleanup after a customer move is retried later.');}}
 return {ok:true as const,ids,customerId,groupId};
}
