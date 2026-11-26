import {commitAll,type Step,type StepResult} from './db';
import {auditEvent} from './audit';
import type {SqlGuard} from './identity/access';

// Security changes and their audit row commit in one transaction: either both
// are final or neither is. A failing statement, including the audit insert,
// rolls back the whole transaction and propagates; this module never catches it.
//
// Guard contract for the audit row: the guard must be true exactly when this
// transaction's effect happened.
// - Inserts and updates: an effect marker evaluated after the mutation, i.e. a
//   unique value the transaction writes (the new recovery-hash JSON, the new
//   session token_hash). Pass no `at`, so the audit row runs after the mutation.
// - Deletes: the mutation's own guard evaluated before the mutation, because
//   "row absent" does not prove that this transaction removed it. Pass `at`
//   equal to the delete's index so the audit row runs right before it.
// - Any single-statement effect: auditAfterChange (lib/server/audit.ts) with `at` equal
//   to the effect's index plus one, so the audit row directly follows it.
// Callers still check `results[i].rowCount` of their effect statement and
// throw their existing HttpError when it is 0.
export type AuditEntry={actor:string;action:string;target:string;customerId?:string|null};
// A portal row built by auditEvent (lib/server/audit.ts); customerId becomes customer_id.
function auditStep(entry:AuditEntry,guard:SqlGuard):Step{
 const [step]=auditEvent({actor:entry.actor,action:entry.action,target:entry.target,customerId:entry.customerId,guard});
 return step;
}
export function auditStatement(entry:AuditEntry,guard:SqlGuard):Step{return auditStep(entry,guard);}
/** Runs the statements with the audit row at position `at` in one transaction; results has the row count and rows of each caller statement. */
export async function commitWithAudit(statements:readonly Step[],{audit,guard,at=statements.length}:{audit:AuditEntry;guard:SqlGuard;at?:number}):Promise<{results:StepResult[];audited:boolean}>{
 if(!Number.isInteger(at)||at<0||at>statements.length)throw new RangeError('Ungültige Position für den Audit-Eintrag.');
 const results=await commitAll([...statements.slice(0,at),auditStep(audit,guard),...statements.slice(at)]);
 return {results:[...results.slice(0,at),...results.slice(at+1)],audited:results[at].rowCount>0};
}
