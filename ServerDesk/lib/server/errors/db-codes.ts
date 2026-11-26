import {defaultLocale} from '../../i18n/locale';
import {translate} from '../../i18n/translate';
import {apiErrorCodes,type ApiErrorKey} from '../../errors/api-error-keys';
import {errorCatalog,type ErrorCode} from '../../errors/codes';

// Every RAISE EXCEPTION literal of a trigger function in drizzle/NNNN_*.sql has
// exactly one entry here (tests/repo/error-codes.mjs checks both directions). Like
// codes.ts this module imports nothing server-only.
//
// - conflict: a request can reach the exception, usually through a race.
//   failure() in lib/server/context.ts answers with the catalog status, code and
//   default message key; call sites may override the key (and with it the
//   code), never the status.
// - invariant: only a programming error reaches the exception. failure()
//   answers 500 INTERNAL_ERROR with a reference, because a user-facing text
//   would promise a cause the user cannot fix.
export type DbTriggerEntry={readonly kind:'conflict';readonly code:ErrorCode}|{readonly kind:'invariant'};

const conflict=(code:ErrorCode):DbTriggerEntry=>({kind:'conflict',code});
const invariant:DbTriggerEntry={kind:'invariant'};

export const dbTriggerCodes={
 // Customer boundary.
 'customer-disabled':conflict('CUSTOMER_DISABLED'),
 'customer-missing':conflict('CUSTOMER_MISSING'),
 'customer-mismatch':conflict('CUSTOMER_MISMATCH'),
 'customer-default-protected':conflict('CUSTOMER_DEFAULT_PROTECTED'),
 'customer-assignment-subject-missing':conflict('CUSTOMER_ASSIGNMENT_SUBJECT_MISSING'),
 'customer-installer-group-mismatch':conflict('CUSTOMER_INSTALLER_GROUP_MISMATCH'),
 // A customer delete (deleteCustomer in lib/server/identity/customer-admin.ts) while live
 // data holds the customer, in a race with its count check.
 'customer-in-use':conflict('CUSTOMER_IN_USE'),
 'audit-customer-immutable':invariant,
 // The tombstones of deleted customers never change, and their ids are never used again.
 'removed-customer-immutable':invariant,
 'customer-id-removed':invariant,
 // revokeInstaller guards revoked_at IS NULL.
 'customer-installer-immutable':invariant,
 'customer-installer-revoked':invariant,
 // The setting "Multiple customers" (lib/server/identity/multiple-customers.ts): a create
 // while it is off, and a switch-off while other customers exist, in a race with the check.
 'multiple-customers-off':conflict('MULTIPLE_CUSTOMERS_OFF'),
 'multiple-customers-in-use':conflict('MULTIPLE_CUSTOMERS_IN_USE'),
 // The setting row is never deleted.
 'customer-settings-protected':invariant,
 // Customer catalogs.
 'customer-role-permissions':conflict('CUSTOMER_ROLE_PERMISSIONS'),
 'customer-role-scope':conflict('CUSTOMER_ROLE_SCOPE'),
 'customer-catalog-mismatch':conflict('CUSTOMER_CATALOG_MISMATCH'),
 'customer-catalog-immutable':conflict('CUSTOMER_CATALOG_IMMUTABLE'),
 // Device group hierarchy.
 'device-group-cycle':conflict('DEVICE_GROUP_CYCLE'),
 'device-group-depth-limit':conflict('DEVICE_GROUP_DEPTH_LIMIT'),
 'device-group-has-children':conflict('DEVICE_GROUP_HAS_CHILDREN'),
 'device-group-member-missing':conflict('DEVICE_GROUP_MEMBER_MISSING'),
 'device-group-membership-path-conflict':conflict('DEVICE_GROUP_MEMBERSHIP_PATH_CONFLICT'),
 'device-group-parent-missing':conflict('DEVICE_GROUP_PARENT_MISSING'),
 // Usage data: rows are never inserted or deleted.
 'usage-data-protected':invariant,
 'usage-instance-immutable':invariant,
 // Direct WebRTC sessions never store stream rows.
 'Direct WebRTC sessions cannot store stream payloads':invariant,
 'Direct WebRTC sessions cannot store stream receipts':invariant,
} as const satisfies Record<string,DbTriggerEntry>;

// UNIQUE and CHECK constraints a request can reach through a race, keyed by
// constraint type and constraint name (SQLSTATE 23505 and 23514). Only
// conflicts: every other constraint error stays a 500 INTERNAL_ERROR.
export const dbConstraintCodes={
 // One group per device; a concurrent move assigned it elsewhere.
 'UNIQUE idx_device_group_members_server':conflict('DEVICE_GROUP_MEMBERSHIP_TAKEN'),
 // Names are unique without regard to case (unique index on lower(name)).
 'UNIQUE customers_name':conflict('CUSTOMER_NAME_TAKEN'),
 // A concurrent enrollment used the installer's last device.
 'CHECK customer_installers_enrollments':conflict('INSTALLER_EXHAUSTED'),
 // Retention and maintenance window of a customer (constraint customers_settings_valid).
 'CHECK customers_settings_valid':conflict('CUSTOMER_SETTINGS_INVALID'),
} as const satisfies Record<`${'UNIQUE'|'CHECK'} ${string}`,DbTriggerEntry>;

export type DbTriggerCode=keyof typeof dbTriggerCodes;
export type DbConstraintKey=keyof typeof dbConstraintCodes;
/** A trigger literal or a constraint key: what dbFailure() translates. */
export type DbConflictKey=DbTriggerCode|DbConstraintKey;
/** `message` is the defaultLocale text of `key`, kept for the text form of HttpError. */
export type DbFailure={status:number;code:string;key:ApiErrorKey;message:string};
/**
 * Call sites override the message key; the code follows the key. `message`
 * and `code` exist only for callers that still pass texts.
 */
export type DbFailureOverrides=Partial<Record<DbConflictKey,{key?:ApiErrorKey;message?:string;code?:string}>>;

const field=(value:unknown,key:string):unknown=>value!==null&&typeof value==='object'?(value as Record<string,unknown>)[key]:undefined;
const sqlState=/^[0-9A-Z]{5}$/;
/** A PostgreSQL server error of the driver: a five-character SQLSTATE and a severity. */
const driverError=(value:unknown)=>typeof field(value,'code')==='string'&&sqlState.test(field(value,'code') as string)&&typeof field(value,'severity')==='string';
/** The driver error itself or its cause. */
const driverErrorOf=(error:unknown):Record<string,unknown>|null=>[error,field(error,'cause')].find(driverError) as Record<string,unknown>|undefined??null;

/** code of the error and of its cause: SQLSTATE values and connection codes such as ECONNREFUSED. */
export function dbDriverCodes(error:unknown):string[]{
 return [error,field(error,'cause')].map(item=>field(item,'code')).filter((code):code is string=>typeof code==='string');
}

/** The SQLSTATE of a driver error (or its cause), or null. */
export function dbSqlState(error:unknown):string|null{const driver=driverErrorOf(error);return driver?driver.code as string:null;}

/** The constraint name of a driver error (or its cause), or null. */
export function dbConstraintName(error:unknown):string|null{const name=driverErrorOf(error)?.constraint_name;return typeof name==='string'&&name?name:null;}

/**
 * Whether an error is a unique violation (SQLSTATE 23505) of the driver, and
 * with `constraint` of exactly that constraint or unique index.
 */
export function isUniqueViolation(error:unknown,constraint?:string):boolean{
 return dbSqlState(error)==='23505'&&(constraint===undefined||dbConstraintName(error)===constraint);
}

/**
 * Whether an error comes from a database constraint or trigger: a driver error
 * (or its cause) with SQLSTATE class 23 or P0001. Anything else, such as a
 * TypeError that echoes a literal, never counts as a trigger or constraint.
 */
export function isDbConstraintError(error:unknown):boolean{
 const state=dbSqlState(error);
 return state!==null&&(state.startsWith('23')||state==='P0001');
}

/** The registered literal a trigger raised (SQLSTATE P0001, the message is the literal), or null. */
export function dbTriggerCode(error:unknown):DbTriggerCode|null{
 const driver=driverErrorOf(error);
 if(!driver||driver.code!=='P0001'||typeof driver.message!=='string')return null;
 return Object.hasOwn(dbTriggerCodes,driver.message)?driver.message as DbTriggerCode:null;
}

/** 'UNIQUE <name>' for 23505 and 'CHECK <name>' for 23514 when registered in dbConstraintCodes, else null. */
export function dbConstraintKey(error:unknown):DbConstraintKey|null{
 const state=dbSqlState(error),name=dbConstraintName(error);
 if(!name||(state!=='23505'&&state!=='23514'))return null;
 const key=`${state==='23505'?'UNIQUE':'CHECK'} ${name}`;
 return Object.hasOwn(dbConstraintCodes,key)?key as DbConstraintKey:null;
}

/** The registered trigger literal or constraint key of an error, or null. */
export function dbConflictKey(error:unknown):DbConflictKey|null{return dbTriggerCode(error)??dbConstraintKey(error);}

const entryOf=(key:DbConflictKey):DbTriggerEntry=>Object.hasOwn(dbTriggerCodes,key)?dbTriggerCodes[key as DbTriggerCode]:dbConstraintCodes[key as DbConstraintKey];

/**
 * The HTTP answer for a conflict trigger or a registered constraint, or null
 * for an invariant trigger and for anything else. `overrides` adapts the message
 * key (and with it the code) to the call site; the status always comes from the registry. `only`
 * limits the translation to the keys a call site handles; others return null.
 */
export function dbFailure(error:unknown,overrides:DbFailureOverrides={},only?:readonly DbConflictKey[]):DbFailure|null{
 const key=dbConflictKey(error);
 if(!key||only&&!only.includes(key))return null;
 const entry=entryOf(key);
 if(entry.kind!=='conflict')return null;
 const override=overrides[key],defaults=errorCatalog[entry.code],messageKey=override?.key??defaults.key;
 return {status:defaults.status,code:override?.code??(override?.key?apiErrorCodes[override.key]:entry.code),key:messageKey,message:override?.message??translate(defaultLocale,messageKey)};
}
