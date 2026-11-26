import {guid,HttpError,now} from '../context';
import {principal,type SqlGuard} from './access';
import {can,canSql,requireCan} from './policy/can';
import {commitWithAudit} from '../security-commit';
import {auditAfterChange} from '../audit';
import {customerAuditActions} from '../../audit-actions';
import {customerById,defaultCustomerId,maintenanceDaysMask,type Customer,type MaintenanceWindow} from './customers';
import {requireMultipleCustomers} from './multiple-customers';
import {affectedAssignmentUsers,customerGainStatements,invalidateRbacUsers,prepareManagementAuthorization,type ManagementAuthorization} from './rbac';
import {mfaSessionFence,requireLiveSessions} from './mfa';
import {customerUpdateNeedsStepUp} from '../../step-up';
import type {ApiErrorKey} from '../../errors/api-error-keys';
import {dbFailure} from '../errors/db-codes';
import type {Viewer} from '../../types';
import {db,sql} from '../db';

// Customer administration (docs/customers.md): create, edit, disable and delete
// customers, and assign the technicians that see them (customer boundary).
// Global Owners only. The technicians and the delete need a management MFA proof; an edit
// needs one only when it shortens the customer's audit retention
// (customerUpdateNeedsStepUp in lib/step-up.ts); create, any other edit and
// the status rely on the live MFA login session (mfaSessionFence). Each write
// is one batch with its portal audit row and, with a proof, its consumption.
// The audit row carries the customer, so it follows the customer's retention;
// only the delete row has no customer, because the customer is gone after it.
// This code never sets customer_id on devices or groups.
// The message keys of the errors (lib/i18n/messages/en-server.ts); the code
// and the status come from the key (lib/errors/api-error-keys.ts).
export const customerMessages={
 ownerOnly:'apiError.customer.ownerOnly',
 name:'apiError.customer.name',
 duplicate:'apiError.customer.nameTaken',
 contactName:'apiError.customer.contactName',
 contactEmail:'apiError.customer.contactEmail',
 contactPhone:'apiError.customer.contactPhone',
 controlCharacters:'apiError.customer.controlCharacters',
 retention:'apiError.customer.retention',
 maintenanceWindow:'apiError.customer.maintenanceWindow',
 status:'apiError.customer.status',
 defaultProtected:'apiError.customer.defaultProtected',
 defaultDeleteProtected:'apiError.customer.defaultDeleteProtected',
 inUse:'apiError.customer.inUse',
 missing:'apiError.customer.gone',
 concurrent:'apiError.customer.concurrent',
 proofUsed:'apiError.mfa.confirmationUsed',
 technicians:'apiError.customer.technicians',
} as const satisfies Record<string,ApiErrorKey>;

/** Raw request values; customerSettings validates and normalizes them (docs/customers.md). */
export type CustomerInput={name:unknown;contactName:unknown;contactEmail:unknown;contactPhone:unknown;auditRetentionDays:unknown;maintenanceWindow:unknown};
/** An update also names the customer revision it was based on. */
export type CustomerUpdateInput=CustomerInput&{revision:unknown};
/** The complete set of users and user groups that see the customer, and the customer revision it was based on. */
export type CustomerTechniciansInput={userIds:unknown;groupIds:unknown;revision:unknown};

export type CustomerSettings={name:string;contactName:string;contactEmail:string;contactPhone:string;auditRetentionDays:number|null;maintenanceWindow:MaintenanceWindow|null};

// ---- Input rules -----------------------------------------------------------
const characters=(text:string)=>[...text].length;
/** True when the text has a control character (below U+0020 or U+007F). */
export const hasControlCharacter=(text:string)=>[...text].some(character=>{const code=character.codePointAt(0)??0;return code<0x20||code===0x7f;});
/** The HttpError of a broken input rule, by its apiError key. */
export const invalid=(key:ApiErrorKey)=>new HttpError(key);
// Texts are trimmed; a missing value counts as empty. Control characters are
// refused everywhere, also where the field rule would allow the length.
function text(value:unknown,key:ApiErrorKey):string{
 if(value===undefined||value===null)return '';
 if(typeof value!=='string')throw invalid(key);
 const trimmed=value.trim();
 if(hasControlCharacter(trimmed))throw invalid(customerMessages.controlCharacters);
 return trimmed;
}
const emailPattern=/^[^\s@]+@[^\s@]+\.[^\s@]+$/,phonePattern=/^[0-9+()/\-. ]{3,40}$/,startPattern=/^(?:[01]\d|2[0-3]):(?:00|15|30|45)$/;
const windowKeys=['days','durationMinutes','start','timeZone'].join();

function retention(value:unknown):number|null{
 if(value===undefined||value===null)return null;
 if(typeof value!=='number'||!Number.isInteger(value)||value<1||value>3650)throw invalid(customerMessages.retention);
 return value;
}
function maintenanceWindow(value:unknown):MaintenanceWindow|null{
 if(value===undefined||value===null)return null;
 const failure=invalid(customerMessages.maintenanceWindow);
 if(typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join()!==windowKeys)throw failure;
 const {days,start,durationMinutes,timeZone}=value as Record<string,unknown>;
 if(!Array.isArray(days)||days.length<1||days.length>7||!days.every(day=>typeof day==='number'&&Number.isInteger(day)&&day>=1&&day<=7)||new Set(days).size!==days.length)throw failure;
 if(typeof start!=='string'||!startPattern.test(start))throw failure;
 if(typeof durationMinutes!=='number'||!Number.isInteger(durationMinutes)||durationMinutes<15||durationMinutes>720||durationMinutes%15!==0)throw failure;
 if(typeof timeZone!=='string')throw failure;
 const zone=timeZone.trim();
 if(!zone||characters(zone)>64||hasControlCharacter(zone))throw failure;
 // Intl knows the IANA zones of the runtime; the canonical spelling is stored.
 let resolved:string;
 try{resolved=new Intl.DateTimeFormat('en',{timeZone:zone}).resolvedOptions().timeZone;}catch{throw failure;}
 if(!resolved||characters(resolved)>64)throw failure;
 return {days:[...(days as number[])].sort((a,b)=>a-b),start,durationMinutes,timeZone:resolved};
}

/** Validates and normalizes raw input. Throws HttpError 400 with the message key of the first broken rule. */
export function customerSettings(input:CustomerInput):CustomerSettings{
 const source=(input??{}) as Partial<CustomerInput>;
 const name=text(source.name,customerMessages.name);
 if(characters(name)<1||characters(name)>80)throw invalid(customerMessages.name);
 const contactName=text(source.contactName,customerMessages.contactName);
 if(characters(contactName)>120)throw invalid(customerMessages.contactName);
 const contactEmail=text(source.contactEmail,customerMessages.contactEmail);
 if(contactEmail&&(characters(contactEmail)>254||!emailPattern.test(contactEmail)))throw invalid(customerMessages.contactEmail);
 const contactPhone=text(source.contactPhone,customerMessages.contactPhone);
 if(contactPhone&&(!phonePattern.test(contactPhone)||(contactPhone.match(/\d/g)??[]).length<3))throw invalid(customerMessages.contactPhone);
 return {name,contactName,contactEmail,contactPhone,auditRetentionDays:retention(source.auditRetentionDays),maintenanceWindow:maintenanceWindow(source.maintenanceWindow)};
}

// ---- Binding and diagnosis --------------------------------------------------
type Bound={id:string;revision:number};
export const holds=async(guard:SqlGuard)=>!!await db().one(sql`SELECT 1 AS ok WHERE ${guard}`);
const customerRevisionGuard=({id,revision}:Bound):SqlGuard=>(sql`EXISTS (SELECT 1 FROM customers bound_customer WHERE bound_customer.id=${id} AND bound_customer.revision=${revision})`);

export async function admit(viewer:Viewer):Promise<void>{
 await requireCan(viewer,'instance.owner',customerMessages.ownerOnly);
}
// One guard for the change and its audit row: the Owner right, the admission
// (the live MFA proof or the live session fence) and, for existing customers,
// the read revision.
export function bind(viewer:Viewer,authorization:Pick<ManagementAuthorization,'guard'>,customer?:Bound):SqlGuard{
 const owner=canSql(sql`${principal(viewer)}`,'instance.owner');
 const parts:SqlGuard[]=[owner,authorization.guard,...(customer?[customerRevisionGuard(customer)]:[])];
 return sql.join(parts.map(part=>sql`(${part})`),sql` AND `);
}
// Nothing was written: name the first reason that still applies. `extra` is a
// guard of the write itself that is checked last, before the admission. A
// write behind the session fence (`session`) answers the session's own error
// there, a write with a proof the used proof.
async function diagnose(viewer:Viewer,customer?:Bound,extra?:{guard:SqlGuard;failure:HttpError},session?:Request):Promise<never>{
 if(!await can(viewer,'instance.owner',{fresh:true}))throw new HttpError(customerMessages.ownerOnly);
 if(customer){
  const current=await customerById(customer.id);
  if(!current)throw new HttpError(customerMessages.missing);
  if(current.revision!==customer.revision)throw new HttpError(customerMessages.concurrent);
 }
 if(extra&&!await holds(extra.guard))throw extra.failure;
 if(session){await requireLiveSessions(session,viewer);throw new HttpError(customerMessages.concurrent);}
 throw new HttpError(customerMessages.proofUsed);
}
// Constraint errors of the batch as UI messages; the batch rolled back.
async function commit(statements:Parameters<typeof commitWithAudit>[0],options:Parameters<typeof commitWithAudit>[1],defaultProtected:ApiErrorKey=customerMessages.defaultProtected){
 try{return await commitWithAudit(statements,options);}
 catch(error){
  // The keys are the ones of the pre-checks: customerMessages.duplicate
  // (CUSTOMER_NAME_TAKEN), customerMessages.defaultProtected or, for the delete,
  // defaultDeleteProtected (CUSTOMER_DEFAULT_PROTECTED), the setting "Multiple customers"
  // turned off before the commit (MULTIPLE_CUSTOMERS_OFF) and data added to a customer
  // between the counts of a delete and its commit (CUSTOMER_IN_USE).
  const conflict=dbFailure(error,{'UNIQUE customers_name':{key:customerMessages.duplicate},'customer-default-protected':{key:defaultProtected},'customer-in-use':{key:customerMessages.inUse}},['UNIQUE customers_name','customer-default-protected','multiple-customers-off','customer-in-use']);
  if(conflict)throw new HttpError(conflict.key);
  throw error;
 }
}
export const consumeProof=(authorization:ManagementAuthorization)=>sql`DELETE FROM mfa_management_proofs WHERE token_hash=${authorization.tokenHash} AND principal=${authorization.key} AND session_hash=${authorization.sessionHash}`;

// Names are unique without regard to case. The unique index customers_name is
// on lower(name); this check also treats accents alike (Ä/ä).
async function requireFreeName(name:string,ownId:string|null){
 const rows=(await db().query<{id:string;name:string}>(sql`SELECT id,name FROM customers`));
 if(rows.some(row=>row.id!==ownId&&row.name.localeCompare(name,'de',{sensitivity:'accent'})===0))throw new HttpError(customerMessages.duplicate);
}
async function existing(id:unknown):Promise<Customer>{
 const customer=await customerById(id);
 if(!customer)throw new HttpError(customerMessages.missing);
 return customer;
}
function readRevision(value:unknown,customer:Customer):number{
 if(typeof value!=='number'||!Number.isSafeInteger(value)||value!==customer.revision)throw new HttpError(customerMessages.concurrent);
 return value;
}
const settingsColumns=(settings:CustomerSettings)=>{
 const window=settings.maintenanceWindow,[hours,minutes]=window?window.start.split(':').map(Number):[0,0];
 return [settings.name,settings.contactName,settings.contactEmail,settings.contactPhone,settings.auditRetentionDays,
  window?maintenanceDaysMask(window.days):null,window?hours*60+minutes:null,window?.durationMinutes??null,window?.timeZone??null];
};

// ---- Writes --------------------------------------------------------------------
// Creating a customer opens no access and runs no code: it commits behind the
// live session fence (lib/step-up.ts), and a supplied managementToken is ignored.
export async function createCustomer(request:Request,viewer:Viewer,input:CustomerInput):Promise<string>{
 await admit(viewer);
 // While "Multiple customers" is off, no customer is created (409 MULTIPLE_CUSTOMERS_OFF). The insert trigger
 // customers_insert_multiple_customers answers the same when the setting goes off before the commit.
 await requireMultipleCustomers();
 const settings=customerSettings(input);
 await requireFreeName(settings.name,null);
 const id=crypto.randomUUID(),at=now(),guard=bind(viewer,{guard:await mfaSessionFence(request,viewer)});
 // The audit row directly follows the insert (auditAfterChange): it exists exactly
 // when the customer was created, and the customer it names exists by then.
 const {results}=await commit([
  sql`INSERT INTO customers(id,name,contact_name,contact_email,contact_phone,audit_retention_days,maintenance_days,maintenance_start,maintenance_duration,maintenance_time_zone,status,revision,created_at,updated_at) SELECT ${id},${sql.join(settingsColumns(settings).map(value=>sql`${value}`))},'active',0,${at},${at} WHERE ${guard}`,
 ],{audit:{actor:viewer.label,action:'Kunde angelegt',target:settings.name,customerId:id},guard:auditAfterChange,at:1});
 if(!results[0].rowCount)await diagnose(viewer,undefined,undefined,request);
 return id;
}

// An edit needs a fresh proof only when the customer's audit retention gets
// shorter than the one that applied before (customerUpdateNeedsStepUp): its own
// value, else the instance audit retention. The proof is read after the
// validation and the checks. A harmless edit commits behind the live session
// fence; the customer revision covers a concurrent edit, and when the decision
// read the instance retention, the stored instance value must still be the
// same at the commit, or the edit fails as stale (customerMessages.concurrent).
export async function updateCustomer(request:Request,viewer:Viewer,id:unknown,input:CustomerUpdateInput,managementToken:unknown):Promise<void>{
 await admit(viewer);
 const settings=customerSettings(input),current=await existing(id),revision=readRevision(input?.revision,current);
 await requireFreeName(settings.name,current.id);
 const {instanceAuditRetention}=await import('../maintenance'),instance=await instanceAuditRetention();
 const effective=(days:number|null)=>days??instance.days;
 const proof=customerUpdateNeedsStepUp(effective(current.auditRetentionDays),effective(settings.auditRetentionDays))?await prepareManagementAuthorization(request,viewer,managementToken):null;
 const readsInstance=current.auditRetentionDays===null||settings.auditRetentionDays===null;
 const instanceGuard=sql`EXISTS (SELECT 1 FROM maintenance_settings instance_retention WHERE instance_retention.id=1 AND instance_retention.audit_days IS NOT DISTINCT FROM ${instance.stored}::integer)`;
 const stale=readsInstance&&!proof?{guard:instanceGuard,failure:new HttpError(customerMessages.concurrent)}:undefined;
 const fence=proof?null:await mfaSessionFence(request,viewer);
 const admission=proof??{guard:stale?sql`(${fence}) AND (${instanceGuard})`:fence!};
 const bound={id:current.id,revision},guard=bind(viewer,admission,bound);
 const {results}=await commit([
  sql`UPDATE customers SET (name,contact_name,contact_email,contact_phone,audit_retention_days,maintenance_days,maintenance_start,maintenance_duration,maintenance_time_zone)=(${sql.join(settingsColumns(settings).map(value=>sql`${value}`))}),revision=revision+1,updated_at=${now()} WHERE id=${current.id} AND ${guard}`,
  ...(proof?[consumeProof(proof)]:[]),
 ],{audit:{actor:viewer.label,action:'Kunde geändert',target:current.name===settings.name?settings.name:`${current.name} → ${settings.name}`,customerId:current.id},guard,at:0});
 if(!results[0].rowCount)await diagnose(viewer,bound,stale,proof?undefined:request);
}

// The status of a customer changes no visibility (docs/customers.md): it
// commits behind the live session fence, and a supplied managementToken is ignored.
export async function setCustomerStatus(request:Request,viewer:Viewer,id:unknown,status:unknown,revision:unknown):Promise<void>{
 await admit(viewer);
 if(status!=='active'&&status!=='disabled')throw invalid(customerMessages.status);
 const current=await existing(id);
 if(status==='disabled'&&current.id===defaultCustomerId)throw new HttpError(customerMessages.defaultProtected);
 if(current.status===status)return;
 const bound={id:current.id,revision:readRevision(revision,current)},guard=bind(viewer,{guard:await mfaSessionFence(request,viewer)},bound);
 const {results}=await commit([
  sql`UPDATE customers SET status=${status},revision=revision+1,updated_at=${now()} WHERE id=${current.id} AND ${guard}`,
 ],{audit:{actor:viewer.label,action:status==='disabled'?'Kunde deaktiviert':'Kunde aktiviert',target:current.name,customerId:current.id},guard,at:0});
 if(!results[0].rowCount)await diagnose(viewer,bound,undefined,request);
}

// ---- Delete ----------------------------------------------------------------------
/** The data that keeps a customer from being deleted (docs/customers.md, "Delete a customer"). */
export const customerHoldsData=(customer:Pick<Customer,'deviceCount'|'groupCount'|'runbookCount'|'templateCount'|'roleCount'>)=>
 customer.deviceCount+customer.groupCount+customer.runbookCount+customer.templateCount+customer.roleCount>0;

// Deleting a customer needs a management MFA proof: it can end the customer
// boundary. Checks in this order: Owner (403), the proof (read by the route),
// a known id (404) and the read revision (409), not the default customer (409
// defaultDeleteProtected), and no live data (409 CUSTOMER_IN_USE). The triggers
// customers_delete_guard and customers_delete_catalog_guard refuse the same in a
// race; commit() maps them. History stays: audit rows, notification events,
// revoked device tombstones and archived catalog entries keep the customer id,
// and the trigger customers_delete_tombstone writes removed_customers. The
// triggers of the delete remove the installers, technician assignments, customer
// notification rules, alert rule and ESU overrides, and the FK the customer AI key.
//
// One batch, every statement bound by the same guard (Owner, proof, revision):
// - when no customer other than the default customer and this one exists, the
//   boundary ends with the delete. The statements of customerGainStatements
//   ('boundary-end') run right before the delete, because the revision guard
//   names the row that the delete removes; they judge the state after the
//   delete (see CustomerGain in lib/server/identity/rbac.ts). Otherwise they
//   change nothing.
// - the delete, its audit row right after it (customer_id NULL, target the
//   name, so it stays under the instance retention), then the use of the
//   proof, which runs only when the audit row was written.
export async function deleteCustomer(viewer:Viewer,id:unknown,revision:unknown,authorization:ManagementAuthorization):Promise<void>{
 await admit(viewer);
 const current=await existing(id),bound={id:current.id,revision:readRevision(revision,current)};
 if(current.id===defaultCustomerId)throw new HttpError(customerMessages.defaultDeleteProtected);
 if(customerHoldsData(current))throw new HttpError(customerMessages.inUse);
 const guard=bind(viewer,authorization,bound),boundary=customerGainStatements(viewer,{kind:'boundary-end',customerId:current.id},now(),guard);
 const deleteIndex=boundary.length;
 const {results}=await commit([
  ...boundary,
  sql`DELETE FROM customers WHERE id=${current.id} AND ${guard}`,
  {afterChange:consumeProof(authorization)},
 ],{audit:{actor:viewer.label,action:customerAuditActions.delete,target:current.name,customerId:null},guard:auditAfterChange,at:deleteIndex+1},customerMessages.defaultDeleteProtected);
 if(!results[deleteIndex].rowCount)await diagnose(viewer,bound);
}

// ---- Technicians (customer boundary) ------------------------------------------
type Subject=['user'|'group',string];
const subjectKey=([type,id]:Subject)=>type+':'+id;
// Arrays of GUIDs, at most 1000 per kind; duplicates are dropped.
function subjectIds(value:unknown):string[]{
 if(!Array.isArray(value)||value.length>1000||!value.every(item=>guid(item)))throw invalid(customerMessages.technicians);
 return [...new Set(value as string[])];
}
// True while every subject in the JSON array of [type,id] pairs exists (users with any status).
const subjectsExistGuard=(subjects:Subject[]):SqlGuard=>(sql`NOT EXISTS (SELECT 1 FROM jsonb_array_elements(${JSON.stringify(subjects)}::jsonb) added_subject WHERE NOT ((added_subject.value->>0='user' AND EXISTS (SELECT 1 FROM local_users added_user WHERE added_user.id=added_subject.value->>1)) OR (added_subject.value->>0='group' AND EXISTS (SELECT 1 FROM user_groups added_group WHERE added_group.id=added_subject.value->>1))))`);

export async function setCustomerTechnicians(viewer:Viewer,id:unknown,input:CustomerTechniciansInput,authorization:ManagementAuthorization):Promise<void>{
 await admit(viewer);
 const source=(input??{}) as Partial<CustomerTechniciansInput>;
 const userIds=subjectIds(source.userIds),groupIds=subjectIds(source.groupIds);
 const current=await existing(id),revision=readRevision(source.revision,current),d=db();
 const wanted:Subject[]=[...userIds.map(userId=>['user',userId] as Subject),...groupIds.map(groupId=>['group',groupId] as Subject)];
 if(!await holds(subjectsExistGuard(wanted)))throw invalid(customerMessages.technicians);
 const stored=(await d.query<{principal_type:'user'|'group';principal_id:string}>(sql`SELECT principal_type,principal_id FROM customer_assignments WHERE customer_id=${current.id}`)).map(row=>[row.principal_type,row.principal_id] as Subject);
 const storedKeys=new Set(stored.map(subjectKey)),wantedKeys=new Set(wanted.map(subjectKey));
 const added=wanted.filter(subject=>!storedKeys.has(subjectKey(subject))),removed=stored.filter(subject=>!wantedKeys.has(subjectKey(subject)));
 // The same set again: nothing to write, no audit, and the proof stays usable.
 if(!added.length&&!removed.length)return;
 const bound={id:current.id,revision},base=bind(viewer,authorization,bound),present=subjectsExistGuard(added);
 const guard=sql`(${base}) AND (${present})`,at=now();
 // Every statement carries the guard. The assignment rows are not part of it,
 // so the guard holds for all of them alike; the revision update comes last
 // among the guarded statements because it changes the read revision.
 // Added subjects lose their open account links right after the insert
 // (customerGainStatements: one audit row per account, the voiding, then the end of their MFA grants).
 const gained=added.length?customerGainStatements(viewer,{kind:'customer-subjects',customerId:current.id,subjects:added},at,guard):[],revisionIndex=2+gained.length;
 const {results}=await commit([
  sql`DELETE FROM customer_assignments WHERE customer_id=${current.id} AND EXISTS (SELECT 1 FROM jsonb_array_elements(${JSON.stringify(removed)}::jsonb) removed_subject WHERE removed_subject.value->>0=customer_assignments.principal_type AND removed_subject.value->>1=customer_assignments.principal_id) AND ${guard}`,
  sql`INSERT INTO customer_assignments(customer_id,principal_type,principal_id,created_at,created_by) SELECT ${current.id},new_subject.value->>0,new_subject.value->>1,${at},${principal(viewer)} FROM jsonb_array_elements(${JSON.stringify(added)}::jsonb) new_subject WHERE ${guard} ON CONFLICT(customer_id,principal_type,principal_id) DO NOTHING`,
  ...gained,
  sql`UPDATE customers SET revision=revision+1,updated_at=${at} WHERE id=${current.id} AND ${guard}`,
  consumeProof(authorization),
 ],{audit:{actor:viewer.label,action:'Techniker geändert',target:`${current.name} (+${added.length} / −${removed.length})`,customerId:current.id},guard,at:0});
 if(!results[revisionIndex].rowCount)await diagnose(viewer,bound,{guard:present,failure:invalid(customerMessages.technicians)});
 // Removing ends sessions and pending jobs at once, as when a role assignment is
 // removed. Adding needs nothing more: every guard reads the assignments live.
 const affected=(await Promise.all(removed.map(([type,subjectId])=>affectedAssignmentUsers(type,subjectId)))).flat();
 await invalidateRbacUsers(affected);
}
