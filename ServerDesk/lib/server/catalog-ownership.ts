import {guid,HttpError} from './context';
import {defaultLocale} from '../i18n/locale';
import {translate} from '../i18n/translate';
import {customerAccessGuard,principal,type SqlGuard} from './identity/access';
import {can,canSql} from './identity/policy/can';
import {customerUnavailableMessage,visibleCustomers} from './identity/customers';
import type {Viewer} from '../types';
import {catalogOwnerImmutableMessage,customerRolePermissionsMessage,customerRoleScopeMessage,templateScopeCustomerMessage} from '../errors/codes';
import {dbFailure,type DbTriggerCode} from './errors/db-codes';
import type {ApiErrorKey} from '../errors/api-error-keys';
import {customerSeparationSql} from '../../runtime/customer-separation.mjs';
import {db,sql,type Sql} from './db';

// MSP library and customer catalogs (docs/customers.md). Runbooks,
// automation templates and roles belong to the MSP library (customer_id NULL)
// or to one customer. While only the default customer exists, everything is
// library and the write rules of each catalog stay as they were.
export {customerUnavailableMessage};
export const libraryOwnerOnlyMessage=translate(defaultLocale,'apiError.catalog.libraryOwnerOnly');
export const catalogCustomerDisabledMessage=translate(defaultLocale,'apiError.catalog.customerDisabled');
// The texts of the catalog triggers live in the error catalog (lib/errors/codes.ts).
export {catalogOwnerImmutableMessage,customerRolePermissionsMessage,customerRoleScopeMessage,templateScopeCustomerMessage};
export const runbookCustomerTargetsMessage=translate(defaultLocale,'apiError.catalog.runbookCustomerTargets');
export const templateRunbookCustomerMessage=translate(defaultLocale,'apiError.catalog.templateRunbookCustomer');
export const driftTemplateCustomerMessage=translate(defaultLocale,'apiError.catalog.driftTemplateCustomer');
export const runCancelPartialMessage=translate(defaultLocale,'apiError.catalog.runCancelPartial');
export const scheduleCancelPartialMessage=translate(defaultLocale,'apiError.catalog.scheduleCancelPartial');
export const assignmentMissingMessage=translate(defaultLocale,'apiError.catalog.assignmentGone');

/** Catalogs are separated once a second customer exists (customerSeparationSql, the same condition as the customer boundary). */
export async function catalogSeparated():Promise<boolean>{return !!await db().one(sql`SELECT 1 AS separated WHERE ${customerSeparationSql}`);}
const isOwner=(v:Viewer)=>can(v,'instance.owner');

/**
 * Visibility of a catalog entry: library entries for everyone, customer entries
 * under the customer boundary (customerAccessGuard), whatever the customer status.
 */
export function catalogVisibleGuard(customerExpression:Sql,principalExpression:Sql):SqlGuard{
 const boundary=customerAccessGuard(sql`catalog_visible.customer_id`,sql`catalog_visible.principal`);
 return sql`EXISTS (SELECT 1 FROM (SELECT (${customerExpression})::text AS customer_id,(${principalExpression})::text AS principal) catalog_visible WHERE catalog_visible.customer_id IS NULL OR ${boundary})`;
}
/**
 * Live write rule for an entry owned by `customerId` (null: library), meant for
 * the committing statement: the library only while only the default customer
 * exists or by a global Owner, a customer entry only while the customer is visible. The
 * catalog's own rights are checked by its existing guards.
 */
export function catalogWriteGuard(v:Viewer,customerId:string|null):SqlGuard{
 const owner=canSql(sql`catalog_writer.principal`,'instance.owner'),boundary=customerAccessGuard(sql`catalog_writer.customer_id`,sql`catalog_writer.principal`);
 return sql`EXISTS (SELECT 1 FROM (SELECT nullif(${customerId??''}::text,'') AS customer_id,${principal(v)}::text AS principal) catalog_writer WHERE (catalog_writer.customer_id IS NULL AND (NOT ${customerSeparationSql} OR (${owner}))) OR (catalog_writer.customer_id IS NOT NULL AND ${boundary}))`;
}
async function writable(v:Viewer,customerId:string|null){return !!await db().one(sql`SELECT 1 AS allowed WHERE ${catalogWriteGuard(v,customerId)}`);}

/** The requested owner `customerId` of a new entry: undefined or null is the library. */
export async function catalogOwner(v:Viewer,value:unknown):Promise<string|null>{
 if(value===undefined||value===null){if(!await writable(v,null))throw new HttpError('apiError.catalog.libraryOwnerOnly');return null;}
 if(!guid(value))throw new HttpError('apiError.customer.invalid');
 const id=value.toLowerCase(),boundary=customerAccessGuard(sql`customer.id`,sql`${principal(v)}`);
 const customer=await db().one<{id:string;status:string}>(sql`SELECT customer.id,customer.status FROM customers customer WHERE customer.id=${id} AND ${boundary}`);
 if(!customer)throw new HttpError('apiError.customer.unavailable');
 if(customer.status==='disabled')throw new HttpError('apiError.catalog.customerDisabled');
 return customer.id;
}
/** An existing entry keeps its owner: a supplied customerId must name the stored one. */
export function requireSameCatalogOwner(value:unknown,stored:string|null){
 if(value===undefined)return;
 const requested=value===null?null:typeof value==='string'?value.toLowerCase():Symbol('invalid');
 if(requested!==stored)throw new HttpError('apiError.customer.catalogOwnerImmutable');
}
/** Library entries once a second customer exists: only a global Owner changes them. */
export async function requireCatalogWrite(v:Viewer,customerId:string|null){
 if(!await writable(v,customerId))throw new HttpError(customerId===null?'apiError.catalog.libraryOwnerOnly':'apiError.customer.unavailable');
}
/** Why a committing write found no row, when the catalog rule was the reason. */
export async function catalogWriteFailure(v:Viewer,customerId:string|null):Promise<HttpError|null>{
 if(await writable(v,customerId))return null;
 return customerId===null?new HttpError('apiError.catalog.libraryOwnerOnly'):new HttpError('apiError.customer.unavailable');
}

export type CatalogOwnership={separated:boolean;libraryWritable:boolean;customers:{id:string;name:string}[]};
/** What the viewer may choose as owner of a new entry: the active, visible customers and, if writable, the library. */
export async function catalogOwnership(v:Viewer):Promise<CatalogOwnership>{
 const separated=await catalogSeparated();
 return {separated,libraryWritable:!separated||await isOwner(v),customers:await visibleCustomers(v)};
}

// Trigger codes of the catalogs that a race can carry up to the commit. `mismatch`
// names the message key for customer-catalog-mismatch (template or assignment).
const catalogTriggers=['customer-disabled','customer-missing','customer-role-permissions','customer-role-scope','customer-catalog-mismatch','customer-catalog-immutable'] as const satisfies readonly DbTriggerCode[];
export function catalogFailure(error:unknown,mismatch:ApiErrorKey='apiError.customer.templateScope'):unknown{
 if(error instanceof HttpError||!(error instanceof Error))return error;
 // A customer outside the boundary answers like a missing one, as everywhere in the
 // catalogs: the registry default of customer-missing is customerUnavailableMessage.
 const conflict=dbFailure(error,{'customer-disabled':{key:'apiError.catalog.customerDisabled'},'customer-catalog-mismatch':{key:mismatch}},catalogTriggers);
 return conflict?new HttpError(conflict.key):error;
}
/** Runs a committing write and translates the catalog trigger codes. */
export async function catalogCommit<T>(write:()=>Promise<T>,mismatch?:ApiErrorKey):Promise<T>{try{return await write();}catch(error){throw catalogFailure(error,mismatch);}}
