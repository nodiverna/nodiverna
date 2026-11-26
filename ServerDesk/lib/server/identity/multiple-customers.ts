import {multipleCustomersAuditActions} from '../../audit-actions';
import {defaultCustomerId} from '../../default-customer';
import type {ApiErrorKey} from '../../errors/api-error-keys';
import type {Viewer} from '../../types';
import {auditAfterChange} from '../audit';
import {HttpError,now} from '../context';
import {db,sql} from '../db';
import {dbFailure} from '../errors/db-codes';
import {commitWithAudit} from '../security-commit';
import {principal} from './access';
import {can,requireCan,viewerCanSql} from './policy/can';
import type {ManagementAuthorization} from './rbac';

// The setting "Multiple customers" (docs/customers.md, "Multiple customers"):
// one row in customer_settings. While it is off, no customer other than the
// default customer exists; the triggers of the migration hold that rule, and
// the checks here only give the error early. Only a global Owner changes it,
// with a management MFA proof; the change, its revision, the use of the proof
// and one audit row commit in one batch. All SQL of the setting is here.
export const multipleCustomersMessages={
 ownerOnly:'apiError.customer.ownerOnly',
 invalid:'apiError.request.invalid',
 changed:'apiError.customer.multipleCustomersChanged',
 off:'apiError.customer.multipleCustomersOff',
 inUse:'apiError.customer.multipleCustomersInUse',
 proofUsed:'apiError.mfa.confirmationUsed',
} as const satisfies Record<string,ApiErrorKey>;

/** The setting as GET /api/customers answers it. otherCustomers: customers other than the default customer, active and deactivated. */
export type MultipleCustomersView={enabled:boolean;otherCustomers:number;revision:number};

/** The stored setting and the number of other customers, read in one statement. */
export async function multipleCustomersSetting():Promise<MultipleCustomersView>{
 const row=await db().one<{enabled:boolean;revision:number|string;others:number|string}>(sql`SELECT setting.multiple_customers AS enabled,setting.revision,
  (SELECT count(*) FROM customers other_customer WHERE other_customer.id<>${defaultCustomerId}) AS others FROM customer_settings setting WHERE setting.id=1`);
 // The migration seeds the row and a trigger refuses its delete.
 if(!row)throw new Error('The customer_settings row is missing.');
 return {enabled:row.enabled===true,otherCustomers:Number(row.others),revision:Number(row.revision)};
}

/** Throws 409 MULTIPLE_CUSTOMERS_OFF while the setting is off (createCustomer, before its commit). */
export async function requireMultipleCustomers():Promise<void>{
 if(!(await multipleCustomersSetting()).enabled)throw new HttpError(multipleCustomersMessages.off);
}

/**
 * Turns "Multiple customers" on or off. Global Owners only (403), enabled a boolean (400), revision the stored one
 * (409 multipleCustomersChanged). The stored value again writes nothing and returns the state. Off while other
 * customers exist answers 409 MULTIPLE_CUSTOMERS_IN_USE; the update trigger answers the same when a customer appears
 * between this check and the commit. The batch holds the update (guarded by the live Owner right, the proof and the
 * read revision), the audit row right after it and the use of the proof.
 */
// The batch with its audit row; the update trigger's refusal (a customer created between the check and the commit)
// becomes the keyed 409 of the check.
async function commit(...args:Parameters<typeof commitWithAudit>){
 try{return await commitWithAudit(...args);}
 catch(error){
  const conflict=dbFailure(error,{},['multiple-customers-in-use']);
  if(conflict)throw new HttpError(multipleCustomersMessages.inUse);
  throw error;
 }
}

export async function setMultipleCustomers(viewer:Viewer,enabled:unknown,revision:unknown,authorization:ManagementAuthorization):Promise<MultipleCustomersView>{
 await requireCan(viewer,'instance.owner',multipleCustomersMessages.ownerOnly);
 if(typeof enabled!=='boolean')throw new HttpError(multipleCustomersMessages.invalid);
 const current=await multipleCustomersSetting();
 if(typeof revision!=='number'||!Number.isSafeInteger(revision)||revision!==current.revision)throw new HttpError(multipleCustomersMessages.changed);
 if(current.enabled===enabled)return current;
 if(!enabled&&current.otherCustomers>0)throw new HttpError(multipleCustomersMessages.inUse);
 const guard=sql`(${viewerCanSql(viewer,'instance.owner')}) AND (${authorization.guard})`;
 const {results}=await commit([
  sql`UPDATE customer_settings SET multiple_customers=${enabled},revision=revision+1,updated_at=${now()},updated_by=${principal(viewer)} WHERE id=1 AND revision=${revision} AND ${guard}`,
  // Used exactly when the update and its audit row were written.
  {afterChange:sql`DELETE FROM mfa_management_proofs WHERE token_hash=${authorization.tokenHash} AND principal=${authorization.key} AND session_hash=${authorization.sessionHash}`},
 ],{audit:{actor:viewer.label,action:enabled?multipleCustomersAuditActions.enable:multipleCustomersAuditActions.disable,target:''},guard:auditAfterChange,at:1});
 if(results[0].rowCount)return {...current,enabled,revision:current.revision+1};
 // Nothing was written: the first reason that still applies.
 if(!await can(viewer,'instance.owner',{fresh:true}))throw new HttpError(multipleCustomersMessages.ownerOnly);
 if((await multipleCustomersSetting()).revision!==revision)throw new HttpError(multipleCustomersMessages.changed);
 throw new HttpError(multipleCustomersMessages.proofUsed);
}
