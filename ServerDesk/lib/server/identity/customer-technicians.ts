import {guid,HttpError,now} from '../context';
import {principal,type SqlGuard} from './access';
import {can,canSql,requireCan} from './policy/can';
import {commitWithAudit} from '../security-commit';
import {customerById,type Customer} from './customers';
import {affectedAssignmentUsers,invalidateRbacUsers,type ManagementAuthorization} from './rbac';
import type {CustomerTechniciansInput} from './customer-admin';
import type {Viewer} from '../../types';
import {db,sql} from '../db';

// Removing technicians from a customer (docs/customers.md, "Assign
// access"). A request that only takes subjects away comes here; requests that
// add anything go to setCustomerTechnicians in
// lib/server/identity/customer-admin.ts. The route classifies with techniciansRemoveOnly; this module
// recomputes the sets itself and never inserts, so a change between the two
// reads cannot grant anything.

type Subject=['user'|'group',string];
type Plan={customer:Customer;added:Subject[];removed:Subject[]};
const subjectKey=([type,id]:Subject)=>type+':'+id;
// Arrays of GUIDs, at most 1000 per kind; duplicates are dropped. The same rule
// as lib/server/identity/customer-admin.ts. null when the value breaks it.
function subjectIds(value:unknown):string[]|null{
 if(!Array.isArray(value)||value.length>1000||!value.every(item=>guid(item)))return null;
 return [...new Set(value as string[])];
}
function wantedSubjects(input:{userIds?:unknown;groupIds?:unknown}|null|undefined):Subject[]|null{
 const source=input??{},userIds=subjectIds(source.userIds),groupIds=subjectIds(source.groupIds);
 if(!userIds||!groupIds)return null;
 return [...userIds.map(id=>['user',id] as Subject),...groupIds.map(id=>['group',id] as Subject)];
}
async function storedSubjects(customerId:string):Promise<Subject[]>{
 return (await db().query<{principal_type:'user'|'group';principal_id:string}>(sql`SELECT principal_type,principal_id FROM customer_assignments WHERE customer_id=${customerId}`)).map(row=>[row.principal_type,row.principal_id] as Subject);
}
async function plan(customer:Customer,wanted:Subject[]):Promise<Plan>{
 const stored=await storedSubjects(customer.id),storedKeys=new Set(stored.map(subjectKey)),wantedKeys=new Set(wanted.map(subjectKey));
 return {customer,added:wanted.filter(subject=>!storedKeys.has(subjectKey(subject))),removed:stored.filter(subject=>!wantedKeys.has(subjectKey(subject)))};
}

/**
 * True exactly when the wanted set is valid, the customer exists, nothing is
 * added and at least one stored subject is removed. A plain read for routing:
 * it never writes and answers false for bad input instead of throwing.
 */
export async function techniciansRemoveOnly(id:unknown,input:{userIds:unknown;groupIds:unknown}):Promise<boolean>{
 const wanted=wantedSubjects(input);
 if(!wanted)return false;
 const customer=await customerById(id);
 if(!customer)return false;
 const {added,removed}=await plan(customer,wanted);
 return !added.length&&removed.length>0;
}

/**
 * Removes users and user groups from a customer's technicians. Global Owners
 * only, with a management MFA proof and the read customer revision. One batch deletes the removed rows, raises the
 * revision, writes the audit row „Techniker geändert“ and consumes the proof.
 * A set that would add a subject is refused with 409 and nothing is inserted;
 * the stored set again is a success without a write, and the proof stays usable.
 * Removed users and the members of removed groups lose their sessions, MFA
 * proofs and pending jobs.
 */
export async function removeCustomerTechnicians(viewer:Viewer,id:unknown,input:CustomerTechniciansInput,authorization:ManagementAuthorization):Promise<void>{
 await requireCan(viewer,'instance.owner','apiError.customer.ownerOnly');
 const source=(input??{}) as Partial<CustomerTechniciansInput>,wanted=wantedSubjects(source);
 if(!wanted)throw new HttpError('apiError.customer.technicians');
 const current=await customerById(id);
 if(!current)throw new HttpError('apiError.customer.gone');
 const revision=source.revision;
 if(typeof revision!=='number'||!Number.isSafeInteger(revision)||revision!==current.revision)throw new HttpError('apiError.customer.concurrent');
 const {added,removed}=await plan(current,wanted);
 // The wanted set grants something the stored state does not have: that is
 // the setCustomerTechnicians path, and the page read an older state.
 if(added.length)throw new HttpError('apiError.customer.concurrent');
 if(!removed.length)return;
 const owner=canSql(sql`${principal(viewer)}`,'instance.owner');
 // The Owner right, the live proof and the read revision. The assignment rows
 // are not part of it, so it holds for every statement alike; the revision
 // update comes last among the guarded statements because it changes it.
 const guard:SqlGuard=sql`(${owner}) AND (${authorization.guard}) AND EXISTS (SELECT 1 FROM customers bound_customer WHERE bound_customer.id=${current.id} AND bound_customer.revision=${revision})`;
 const at=now();
 const {results}=await commitWithAudit([
  sql`DELETE FROM customer_assignments WHERE customer_id=${current.id} AND EXISTS (SELECT 1 FROM jsonb_array_elements(${JSON.stringify(removed)}::jsonb) removed_subject WHERE removed_subject.value->>0=customer_assignments.principal_type AND removed_subject.value->>1=customer_assignments.principal_id) AND ${guard}`,
  sql`UPDATE customers SET revision=revision+1,updated_at=${at} WHERE id=${current.id} AND ${guard}`,
  sql`DELETE FROM mfa_management_proofs WHERE token_hash=${authorization.tokenHash} AND principal=${authorization.key} AND session_hash=${authorization.sessionHash}`,
 ],{audit:{actor:viewer.label,action:'Techniker geändert',target:`${current.name} (+0 / −${removed.length})`,customerId:current.id},guard,at:0});
 if(!results[1].rowCount){
  // Nothing was written: name the first reason that still applies.
  if(!await can(viewer,'instance.owner',{fresh:true}))throw new HttpError('apiError.customer.ownerOnly');
  const after=await customerById(current.id);
  if(!after)throw new HttpError('apiError.customer.gone');
  if(after.revision!==revision)throw new HttpError('apiError.customer.concurrent');
  throw new HttpError('apiError.mfa.confirmationUsed');
 }
 // As when a role assignment is removed: sessions and pending jobs end at once.
 const affected=(await Promise.all(removed.map(([type,subjectId])=>affectedAssignmentUsers(type,subjectId)))).flat();
 await invalidateRbacUsers(affected);
}
