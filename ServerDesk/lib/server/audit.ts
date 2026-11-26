import {guid,now} from './context';
import {sql,type Step} from './db';
import type {SqlGuard} from './identity/access';

// The audit writer for changes that must not take effect without their audit
// row. It only builds steps; the caller puts them into the transaction of the
// change (commitAll or commitWithAudit), so the change and its row commit
// together or not at all. Nothing here runs a statement or catches an error: a
// failing audit insert rolls back the caller's transaction and propagates.
//
// The guard decides whether a row is written. It must be true exactly when the
// change of this transaction happened (see lib/server/security-commit.ts for the rules).
// log() in lib/server/context.ts remains for writers that are not converted yet.
// `at` defaults to now(). A caller passes its own only when a later statement of
// the same transaction looks the row up by it (an index-backed admission receipt).
export type AuditEvent={actor:string;action:string;target:string;serverIds?:string|string[];customerId?:string|null;guard:SqlGuard;at?:number};

/**
 * Without serverIds: one portal row (server_id NULL). With serverIds: one device
 * row per distinct ID; an empty array gives no step. customerId goes into
 * customer_id; without it NULL is inserted and a trigger fills in the customer
 * of the device for device rows. All rows of one call share `at`.
 */
export function auditEvent({actor,action,target,serverIds,customerId,guard,at=now()}:AuditEvent):Step[]{
 const ids=serverIds===undefined?[null]:[...new Set(Array.isArray(serverIds)?serverIds:[serverIds])];
 if(ids.some(id=>id!==null&&!guid(id)))throw new Error('Ungültige Gerätezuordnung für das Zugriffsprotokoll.');
 return ids.map(id=>{
  const values=sql`${at}::bigint,${actor}::text,${action}::text,${target}::text,${id}::text,${id===null?'portal':'device'}::text,${customerId??null}::text`;
  if(guard===auditAfterChange)return {afterChange:sql`INSERT INTO audit (at,actor,action,target,server_id,scope,customer_id) VALUES(${values})`};
  return sql`INSERT INTO audit (at,actor,action,target,server_id,scope,customer_id) SELECT ${values} WHERE (${guard})`;
 });
}

/**
 * One portal row per row of `targets`, a SELECT whose only column is the
 * target. For changes that hit a set of accounts only known inside the
 * transaction: the SELECT is the change's own predicate, so each row exists
 * exactly when the change affects that target. No customer.
 */
export function auditEachTarget({actor,action,targets}:{actor:string;action:string;targets:SqlGuard}):Step{
 return sql`INSERT INTO audit (at,actor,action,target,server_id,scope,customer_id) SELECT ${now()}::bigint,${actor}::text,${action}::text,audit_target.target,NULL,'portal',NULL FROM (${targets}) audit_target`;
}

/**
 * True when the step right before it in the transaction changed at least one
 * row: auditEvent turns it into a step that runs only then (runSteps in
 * lib/server/db.ts). Only valid when the audit step directly follows the effect
 * statement. With several serverIds each device row follows the row before it,
 * which is written exactly when the first is. It is a marker, never SQL: as SQL
 * text it fails.
 */
export const auditAfterChange:SqlGuard=sql`audit_after_change_is_resolved_by_run_steps`;
