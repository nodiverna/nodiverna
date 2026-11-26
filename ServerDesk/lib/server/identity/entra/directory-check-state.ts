// The state of the account check through Microsoft Graph (lib/server/identity/entra/directory-check.ts)
// for the settings view: the limits of a run and the card data built from the
// single row entra_directory_check. No SQL and no Graph access here, so both
// lib/server/identity/entra/settings.ts and the check import it.

/** The limits of the account check (docs/entra-id.md, "Account check"). */
export const directoryCheckLimits={
 /** A run starts at the first scheduler tick at least this long after the last start. */
 intervalMs:15*60_000,
 /** The lease of one run; longer than its time budget. */
 leaseMs:10*60_000,
 /** A run stops checking new accounts after this time. */
 budgetMs:8*60_000,
 /** At most this many accounts per run; the rest come first in the next run. */
 maxAccounts:5000,
 /** At most this many group IDs per checkMemberGroups request. */
 groupBatch:20,
 /** At most this many Graph requests in flight at a time. */
 concurrency:4,
} as const;

/** The result of a finished run: ok, or the failure that stopped it. */
export type DirectoryCheckResult='ok'|'permissionMissing'|'credentialRefused'|'secretExpired'|'certificateRefused'|'unavailable';
export const directoryCheckResults:readonly DirectoryCheckResult[]=['ok','permissionMissing','credentialRefused','secretExpired','certificateRefused','unavailable'];
export type DirectoryCheckState='off'|'waiting'|'ok'|'failed';
/** An account the check keeps active although Entra reports it disabled or deleted, because it holds the last Owner assignment. name is '' when the account has no shown name. */
export type KeptOwner={id:string;name:string;since:number};
export type DirectoryCheckView={
 state:DirectoryCheckState;result:DirectoryCheckResult|null;lastRunAt:number|null;lastOkAt:number|null;nextRunAt:number|null;
 checked:number;locked:number;groupChanges:number;remaining:number;
 /** The kept last Owners in name order; empty while sign-in is off. */
 keptOwners:KeptOwner[];
};
export type DirectoryCheckRow={last_started_at:number|null;last_finished_at:number|null;last_result:DirectoryCheckResult|null;last_ok_at:number|null;checked_count:number;locked_count:number;group_change_count:number;remaining_count:number};

const numberOrNull=(value:unknown)=>value===null||value===undefined?null:Number(value);
/**
 * The card data of the account check. state is off while sign-in is off,
 * waiting before the first finished run, else ok or failed by the last result.
 * nextRunAt (only while on) is the last start plus 15 minutes, or the next
 * scheduler tick when no run started since sign-in turned on. keptOwners
 * (only while on) are the accounts with entra_kept_owner_since.
 */
export function directoryCheckView(row:DirectoryCheckRow|null,enabled:boolean,nextTickAt:number,keptOwners:readonly KeptOwner[]=[]):DirectoryCheckView{
 const result=row?.last_result??null,started=numberOrNull(row?.last_started_at);
 const state:DirectoryCheckState=!enabled?'off':result===null?'waiting':result==='ok'?'ok':'failed';
 return {
  state,result,lastRunAt:numberOrNull(row?.last_finished_at),lastOkAt:numberOrNull(row?.last_ok_at),
  nextRunAt:!enabled?null:started===null?nextTickAt:Math.max(started+directoryCheckLimits.intervalMs,nextTickAt),
  checked:Number(row?.checked_count??0),locked:Number(row?.locked_count??0),groupChanges:Number(row?.group_change_count??0),remaining:Number(row?.remaining_count??0),
  keptOwners:enabled?keptOwners.map(owner=>({id:owner.id,name:owner.name,since:Number(owner.since)})):[],
 };
}
