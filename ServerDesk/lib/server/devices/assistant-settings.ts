// The provider keys of the device assistant (docs/ai-assistant.md). One
// organization key and, once a second customer exists, one key per customer,
// which only global Owners change: saving one needs a fresh step-up proof
// (lib/step-up.ts, rule 6: it decides which provider account receives device
// data), removing one relies on the live MFA login session (it only stops the
// assistant); and one personal key per user, which only that
// user reads or changes, guarded by the login session. A key is stored only as
// keyring ciphertext with the context assistant-key:organization,
// assistant-key:user:<userId> or assistant-key:customer:<customerId>; no
// answer, audit row, log line or error carries it, only its last 4 characters
// (key_hint). Every change commits with exactly one portal audit row, guarded
// by the revision read before.
// app/api/assistant/settings/route.ts is a thin adapter.
import {assistantAuditActions} from '../../audit-actions';
import {guid,HttpError,now} from '../context';
import {customerAccessGuard,principal,viewerWriteGuard,type SqlGuard} from '../identity/access';
import {auditAfterChange,auditEvent} from '../audit';
import {can,viewerCanSql} from '../identity/policy/can';
import {decryptSecret,encryptSecret,mfaSessionFence,requireLiveSessions} from '../identity/mfa';
import {assistantSettingsActionNeedsStepUp} from '../../step-up';
import {multipleCustomers} from '../console-data';
import {customerSeparationSql} from '../../../runtime/customer-separation.mjs';
import {db,sql,type Sql} from '../db';
import type {Viewer} from '../../types';
import {assistantKeyHint,assistantLimits,assistantProviderNames,isAssistantProvider,validAssistantKey,validAssistantModel,type AssistantProvider,type AssistantScope} from '../../assistant-config';
import {AssistantProviderError,assistantErrorKey,checkProviderModel} from './assistant-provider';

/** What a client sees of a stored key. */
export type AssistantKeyView={provider:AssistantProvider;model:string;keyHint:string;revision:number;updatedAt:number};
export type AssistantCustomerKey={customerId:string;customerName:string;customerDisabled:boolean;key:AssistantKeyView|null};
/** GET /api/assistant/settings: the viewer's personal key, and for Owners the organization key and the customer keys. */
export type AssistantSettingsView={personal:AssistantKeyView|null;organization?:AssistantKeyView|null;customerKeys?:{visible:boolean;customers:AssistantCustomerKey[]}};
type KeyRow={id:string;scope:AssistantScope;user_id:string|null;customer_id:string|null;provider:AssistantProvider;model:string;secret:string;key_hint:string;revision:number|string;updated_at:number|string};
export type AssistantField='provider'|'model'|'key'|'revision';
type Customer={id:string;name:string;status:string};
type Target={scope:'organization'}|{scope:'personal';userId:string}|{scope:'customer';customer:Customer};

export {assistantAuditActions};
/** The keyring context of a stored key. */
export function assistantKeyContext(scope:AssistantScope,id?:string|null):string{
 return scope==='organization'?'assistant-key:organization':scope==='personal'?`assistant-key:user:${id}`:`assistant-key:customer:${id}`;
}
const targetContext=(target:Target)=>assistantKeyContext(target.scope,target.scope==='personal'?target.userId:target.scope==='customer'?target.customer.id:null);
const rowContext=(row:KeyRow)=>assistantKeyContext(row.scope,row.scope==='personal'?row.user_id:row.customer_id);
/** Key tests per principal: at most 5 in a fixed window of 60 s, across every scope. */
export const assistantTestLimit={attempts:assistantLimits.testsPerWindow,windowMs:assistantLimits.testWindowSeconds*1000};

const invalid=(field:AssistantField)=>new HttpError('apiError.assistant.fieldInvalid',{field});
const changed=()=>new HttpError('apiError.assistant.changed');
const forbidden=()=>new HttpError('apiError.assistant.forbidden');
const undecryptable=()=>new HttpError('apiError.assistant.secretUndecryptable');
const customerKeysUnavailable=()=>new HttpError('apiError.assistant.customerKeysUnavailable');
// The re-check after a refused commit asks the database again (fresh): a demoted Owner gets 403, not a conflict.
async function requireOwner(v:Viewer,fresh=false){if(!await can(v,'instance.owner',{fresh}))throw forbidden();}
/** The user a personal key belongs to. Every signed-in portal account has one. */
function personalUser(v:Viewer):string{if(!v.userId)throw new HttpError('apiError.policy.permissionMissing');return v.userId;}

const columns=sql`id,scope,user_id,customer_id,provider,model,secret,key_hint,revision,updated_at`;
const organizationRow=()=>db().one<KeyRow>(sql`SELECT ${columns} FROM assistant_keys WHERE scope='organization'`);
const personalRow=(userId:string)=>db().one<KeyRow>(sql`SELECT ${columns} FROM assistant_keys WHERE scope='personal' AND user_id=${userId}`);
const customerRow=(customerId:string)=>db().one<KeyRow>(sql`SELECT ${columns} FROM assistant_keys WHERE scope='customer' AND customer_id=${customerId}`);
const rowFor=(target:Target)=>target.scope==='organization'?organizationRow():target.scope==='personal'?personalRow(target.userId):customerRow(target.customer.id);
const viewOf=(row:KeyRow|null):AssistantKeyView|null=>row?{provider:row.provider,model:row.model,keyHint:row.key_hint,revision:Number(row.revision),updatedAt:Number(row.updated_at)}:null;

/** The customer of a customer key action inside the viewer's customer boundary: 400 for a value that is no GUID, 404 for an unknown or unseen customer. */
async function boundaryCustomer(v:Viewer,value:unknown):Promise<Customer>{
 if(!guid(value))throw new HttpError('apiError.customer.invalid');
 const customer=await db().one<Customer>(sql`SELECT id,name,status FROM customers WHERE id=${value} AND ${customerAccessGuard(sql`customers.id`,sql`${principal(v)}`)}`);
 if(!customer)throw new HttpError('apiError.customer.unavailable');
 return customer;
}
/** Whether the customer keys section shows: once a second customer exists, or while a customer key exists. */
async function customerKeysVisible():Promise<boolean>{
 return await multipleCustomers()||!!await db().one(sql`SELECT 1 AS found FROM assistant_keys WHERE scope='customer' LIMIT 1`);
}

/** GET /api/assistant/settings. organization and customerKeys only for Owners. */
export async function assistantSettingsView(v:Viewer):Promise<AssistantSettingsView>{
 const personal=v.userId?viewOf(await personalRow(v.userId)):null;
 if(!await can(v,'instance.owner'))return {personal};
 const visible=await customerKeysVisible();
 const customers=visible?await db().query<{id:string;name:string;status:string}&Partial<KeyRow>&{key_id:string|null}>(sql`SELECT c.id,c.name,c.status,k.id AS key_id,k.provider,k.model,k.key_hint,k.revision,k.updated_at FROM customers c LEFT JOIN assistant_keys k ON k.scope='customer' AND k.customer_id=c.id ORDER BY lower(c.name),c.id`):[];
 return {personal,organization:viewOf(await organizationRow()),customerKeys:{visible,customers:customers.map(row=>({customerId:row.id,customerName:row.name,customerDisabled:row.status==='disabled',
  key:row.key_id?{provider:row.provider!,model:row.model!,keyHint:row.key_hint!,revision:Number(row.revision),updatedAt:Number(row.updated_at)}:null}))}};
}

/** Decrypts a stored key; a value that does not decrypt throws apiError.assistant.secretUndecryptable. */
async function readKey(row:KeyRow):Promise<string>{
 try{return await decryptSecret(row.secret,rowContext(row));}
 catch{throw undecryptable();}
}

type Parsed={provider:AssistantProvider;model:string;newKey:string|null};
/**
 * Validates provider, model and key. An empty or omitted key keeps the stored
 * key while the provider stays; a new provider needs a new key.
 */
export function parseKeyInput(p:Record<string,unknown>,current:Pick<KeyRow,'provider'>|null):Parsed{
 if(!isAssistantProvider(p.provider))throw invalid('provider');
 const provider=p.provider,model=typeof p.model==='string'?p.model.trim():'';
 if(!validAssistantModel(model))throw invalid('model');
 const given=p.key!==undefined&&p.key!==null&&p.key!=='';
 if(given&&(typeof p.key!=='string'||!validAssistantKey(provider,p.key.trim())))throw invalid('key');
 const newKey=given?(p.key as string).trim():null;
 if(!newKey&&(!current||current.provider!==provider))throw invalid('key');
 return {provider,model,newKey};
}
/** The revision a change expects: the stored revision, or null when no key is stored. */
function checkRevision(current:KeyRow|null,value:unknown){
 if(value!==null&&value!==undefined&&(typeof value!=='number'||!Number.isSafeInteger(value)||value<0))throw invalid('revision');
 if((current?Number(current.revision):null)!==(value??null))throw changed();
}
const unchanged=(parsed:Parsed|null,current:KeyRow|null)=>!!parsed&&!parsed.newKey&&!!current&&current.model===parsed.model;

const actions:Record<AssistantScope,{set:string;removed:string}>={
 organization:{set:assistantAuditActions.organizationSet,removed:assistantAuditActions.organizationRemoved},
 personal:{set:assistantAuditActions.personalSet,removed:assistantAuditActions.personalRemoved},
 customer:{set:assistantAuditActions.customerSet,removed:assistantAuditActions.customerRemoved},
};
type Change={statement:Sql;audit:ReturnType<typeof auditEvent>;view:AssistantKeyView|null};
/**
 * The insert or the compare-and-set update (or delete) of one key under
 * `guard`, with its audit row. A customer row names the customer in the
 * target and in the audit column customer_id.
 */
async function plannedChange(v:Viewer,target:Target,current:KeyRow|null,parsed:Parsed|null,guard:SqlGuard,time:number):Promise<Change>{
 const customer=target.scope==='customer'?target.customer:null;
 const audit=(action:string,details:Record<string,unknown>)=>auditEvent({actor:v.label,action,target:JSON.stringify({...(customer?{customer:customer.name}:{}),...details}),customerId:customer?.id??null,guard:auditAfterChange,at:time});
 if(!parsed){
  const row=current!;
  return {statement:sql`DELETE FROM assistant_keys WHERE id=${row.id} AND revision=${Number(row.revision)} AND (${guard}) RETURNING revision`,
   audit:audit(actions[target.scope].removed,{provider:row.provider,model:row.model,keyHint:row.key_hint}),view:null};
 }
 const secret=parsed.newKey?await encryptSecret(parsed.newKey,targetContext(target)):current!.secret;
 const keyHint=parsed.newKey?assistantKeyHint(parsed.newKey):current!.key_hint;
 const userId=target.scope==='personal'?target.userId:null,customerId=customer?.id??null;
 const statement=current
  ?sql`UPDATE assistant_keys SET provider=${parsed.provider},model=${parsed.model},secret=${secret},key_hint=${keyHint},revision=revision+1,updated_at=${time},updated_by=${v.label} WHERE id=${current.id} AND revision=${Number(current.revision)} AND (${guard}) RETURNING revision`
  :sql`INSERT INTO assistant_keys(id,scope,user_id,customer_id,provider,model,secret,key_hint,revision,updated_at,updated_by) SELECT ${crypto.randomUUID()},${target.scope}::text,${userId}::text,${customerId}::text,${parsed.provider}::text,${parsed.model}::text,${secret}::text,${keyHint}::text,0,${time}::bigint,${v.label}::text WHERE ${guard} ON CONFLICT DO NOTHING RETURNING revision`;
 return {statement,audit:audit(actions[target.scope].set,{provider:parsed.provider,model:parsed.model,keyHint}),
  view:{provider:parsed.provider,model:parsed.model,keyHint,revision:current?Number(current.revision)+1:0,updatedAt:time}};
}

/**
 * set-/remove-organization-key and set-/remove-customer-key. The Owner check
 * comes before the body (403 before 400). Saving a key needs a step-up proof
 * (assistantSettingsActionNeedsStepUp), read after the validation, so a broken
 * request never asks for MFA; removing one commits behind the live session
 * fence and ignores a supplied managementToken. The committing statement
 * holds only while the proof or the session fence, the live Owner right, the
 * session and the revision hold, for a customer also the customer boundary
 * and, to set a key, a second customer; its audit row commits with it.
 */
async function changeOwnerKey(request:Request,v:Viewer,target:Target,action:'set'|'remove',p:Record<string,unknown>):Promise<AssistantKeyView|null>{
 if(target.scope==='customer'&&action==='set'&&!await multipleCustomers())throw customerKeysUnavailable();
 const current=await rowFor(target);
 checkRevision(current,p.revision);
 const parsed=action==='set'?parseKeyInput(p,current):null;
 if(action==='remove'&&!current)return null;
 // A model that stays and no new key change nothing, so no proof is read or consumed.
 if(unchanged(parsed,current))return viewOf(current);
 const {prepareManagementAuthorization,commitManagementChange,commitSessionChange}=await import('../identity/rbac');
 const time=now(),proof=assistantSettingsActionNeedsStepUp(`${action}-${target.scope}-key`)?await prepareManagementAuthorization(request,v,p.managementToken):null;
 const admission=proof?proof.guard:await mfaSessionFence(request,v);
 const scopeGuard=target.scope==='customer'?sql` AND (${customerAccessGuard(sql`${target.customer.id}`,sql`${principal(v)}`)}) AND EXISTS (SELECT 1 FROM customers WHERE id=${target.customer.id})${action==='set'?sql` AND (${customerSeparationSql})`:sql``}`:sql``;
 const guard=sql`(${admission}) AND (${viewerCanSql(v,'instance.owner')}) AND (${viewerWriteGuard(v)})${scopeGuard}`;
 const change=await plannedChange(v,target,current,parsed,guard,time);
 const row=proof?await commitManagementChange(change.statement,proof,change.audit):await commitSessionChange(change.statement,change.audit);
 if(!row){
  if(!proof)await requireLiveSessions(request,v);
  await requireOwner(v,true);
  if(target.scope==='customer'){await boundaryCustomer(v,target.customer.id);if(action==='set'&&!await multipleCustomers())throw customerKeysUnavailable();}
  throw changed();
 }
 return change.view;
}
/** set-organization-key (Owners, step-up) and remove-organization-key (Owners, login session). */
export async function changeOrganizationKey(request:Request,v:Viewer,action:'set'|'remove',p:Record<string,unknown>):Promise<AssistantKeyView|null>{
 await requireOwner(v);
 return changeOwnerKey(request,v,{scope:'organization'},action,p);
}
/** set-customer-key (Owners, step-up) and remove-customer-key (Owners, login session), inside the customer boundary. Setting needs a second customer. */
export async function changeCustomerKey(request:Request,v:Viewer,action:'set'|'remove',p:Record<string,unknown>):Promise<AssistantKeyView|null>{
 await requireOwner(v);
 return changeOwnerKey(request,v,{scope:'customer',customer:await boundaryCustomer(v,p.customerId)},action,p);
}

/** set-personal-key and remove-personal-key: the viewer's own row, guarded by the login session, one audit row. */
export async function changePersonalKey(v:Viewer,action:'set'|'remove',p:Record<string,unknown>):Promise<AssistantKeyView|null>{
 const target:Target={scope:'personal',userId:personalUser(v)},current=await rowFor(target);
 checkRevision(current,p.revision);
 const parsed=action==='set'?parseKeyInput(p,current):null;
 if(action==='remove'&&!current)return null;
 if(unchanged(parsed,current))return viewOf(current);
 const change=await plannedChange(v,target,current,parsed,viewerWriteGuard(v),now());
 const {commitSessionChange}=await import('../identity/rbac');
 if(!await commitSessionChange(change.statement,change.audit))throw changed();
 return change.view;
}

/**
 * Reserves one attempt in the fixed window of `kind` for the viewer's
 * principal. The upsert holds only under `guard`; a refused guard answers
 * null. Returns the attempts of the window, this one included.
 */
export async function reserveAssistantAttempt(v:Viewer,kind:'question'|'test',windowMs:number,guard:SqlGuard):Promise<number|null>{
 const time=now(),cutoff=time-windowMs;
 const row=await db().one<{attempts:number|string}>(sql`INSERT INTO assistant_limits(principal,kind,attempts,window_at) SELECT ${principal(v)},${kind}::text,1,${time}::bigint WHERE ${guard}
  ON CONFLICT(principal,kind) DO UPDATE SET attempts=CASE WHEN assistant_limits.window_at<=${cutoff} THEN 1 ELSE assistant_limits.attempts+1 END,
  window_at=CASE WHEN assistant_limits.window_at<=${cutoff} THEN excluded.window_at ELSE assistant_limits.window_at END RETURNING attempts`);
 return row?Number(row.attempts):null;
}

/** The catalog error of a failed provider call, with the provider's name and the model. Other errors pass. */
export function providerHttpError(error:unknown,provider:AssistantProvider,model:string):unknown{
 return error instanceof AssistantProviderError?new HttpError(assistantErrorKey(error.reason),{provider:assistantProviderNames[provider],model}):error;
}

/**
 * test-organization-key and test-customer-key (Owners) and test-personal-key:
 * checks the entered key, or the stored key of that scope when the field is
 * empty, against the provider's model endpoint. Uses no tokens and stores
 * nothing but the attempt: at most 5 tests per principal in 60 s, shared by
 * every scope.
 */
export async function testAssistantKey(v:Viewer,scope:AssistantScope,p:Record<string,unknown>):Promise<{ok:true}>{
 if(scope!=='personal')await requireOwner(v);
 const target:Target=scope==='organization'?{scope}:scope==='personal'?{scope,userId:personalUser(v)}:{scope,customer:await boundaryCustomer(v,p.customerId)};
 const current=await rowFor(target),parsed=parseKeyInput(p,current);
 const guard=scope==='personal'?viewerWriteGuard(v):sql`(${viewerCanSql(v,'instance.owner')}) AND (${viewerWriteGuard(v)})`;
 const attempts=await reserveAssistantAttempt(v,'test',assistantTestLimit.windowMs,guard);
 if(attempts===null)throw scope==='personal'?new HttpError('apiError.policy.permissionMissing'):forbidden();
 if(attempts>assistantTestLimit.attempts)throw new HttpError('apiError.assistant.testRateLimited');
 const key=parsed.newKey??await readKey(current!);
 try{await checkProviderModel({provider:parsed.provider,model:parsed.model,key});}
 catch(error){throw providerHttpError(error,parsed.provider,parsed.model);}
 return {ok:true};
}

export type ResolvedAssistantKey={source:AssistantScope;provider:AssistantProvider;model:string;customerName?:string;row:KeyRow};
/**
 * The key a question of this viewer about this device uses: the key of the
 * device's customer (read now, not cached), else the personal key, else the
 * organization key, else null. Nothing is decrypted. The caller checks the
 * device rights first.
 */
export async function assistantKeyFor(v:Viewer,serverId:string):Promise<ResolvedAssistantKey|null>{
 const customer=await db().one<KeyRow&{customer_name:string}>(sql`SELECT k.id,k.scope,k.user_id,k.customer_id,k.provider,k.model,k.secret,k.key_hint,k.revision,k.updated_at,c.name AS customer_name FROM servers s JOIN assistant_keys k ON k.scope='customer' AND k.customer_id=s.customer_id JOIN customers c ON c.id=s.customer_id WHERE s.id=${serverId}`);
 if(customer)return {source:'customer',provider:customer.provider,model:customer.model,customerName:customer.customer_name,row:customer};
 const personal=v.userId?await personalRow(v.userId):null;
 if(personal)return {source:'personal',provider:personal.provider,model:personal.model,row:personal};
 const organization=await organizationRow();
 return organization?{source:'organization',provider:organization.provider,model:organization.model,row:organization}:null;
}
/**
 * The resolved key with its plaintext for one question. No key answers 409
 * apiError.assistant.notConfigured. A key that does not decrypt answers
 * apiError.assistant.secretUndecryptable and never falls back to the next key.
 */
export async function resolveAssistantKey(v:Viewer,serverId:string):Promise<Omit<ResolvedAssistantKey,'row'>&{key:string}>{
 const resolved=await assistantKeyFor(v,serverId);
 if(!resolved)throw new HttpError('apiError.assistant.notConfigured');
 const {row,...rest}=resolved;
 return {...rest,key:await readKey(row)};
}
