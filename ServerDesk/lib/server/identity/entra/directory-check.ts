// The account check through Microsoft Graph (docs/entra-id.md, "Account check").
// The portal scheduler (runtime/maintenance-scheduler.mjs, instrumentation.ts)
// calls runEntraDirectoryCheck on every tick; a run starts at most every 15
// minutes, only while sign-in with Microsoft is on, and holds a lease in
// entra_directory_check so that two processes or replicas never run at the same
// time. It asks Graph for every active Entra account of the configured tenant
// whether the account is still enabled and still in its mapped groups:
// - disabled or deleted in Entra: the account is locked (unless it holds the
//   last direct global Owner assignment), its sessions and pending work end, its
//   groups and Entra roles go;
// - left a mapped group: that group and the roles it gave go, the sessions end.
// The check never adds groups or roles and never unlocks. Every account commits
// on its own, guarded by the settings revision, the account's auth_version and
// its last sign-in. A Graph failure stops the run and changes nothing more.
// A kept last Owner gets entra_kept_owner_since: its keptLastOwner audit rows
// are written once, when that state starts; later runs end its sessions again
// without a new row. The marker goes when the account is enabled or locked.
import {now} from '../../context';
import {auditEvent} from '../../audit';
import {lastOwnerGuard,type SqlGuard} from '../access';
import {revocationStatements,type LocalUser} from '../local-auth';
import {db,runSteps,sql} from '../../db';
import {entraSettingsRow,savedCredential,settingsComplete} from './settings';
import {roleSyncStatement} from './role-sync';
import {GraphFailure,graphAccountState,graphMemberGroups,type GraphFailureCode,type GraphSession} from './graph';
import {directoryCheckLimits,type DirectoryCheckResult} from './directory-check-state';

export type DirectoryCheckRun=
 |{status:'skipped'}
 |{status:'stopped'}
 |{status:'ran';result:DirectoryCheckResult;checked:number;locked:number;groupChanges:number;remaining:number};
type Account=Pick<LocalUser,'id'|'auth_principal'|'auth_email'|'auth_version'>&{entra_object_id:string};
type Outcome='unchanged'|'locked'|'keptLastOwner'|'groups'|'skipped';

/**
 * One run of the account check at `time`. `clock` gives the current time for
 * the time budget, the commit times and the sign-in guard (tests move it).
 * Returns skipped when no run is due or allowed, stopped when the settings
 * changed during the run, else the result and the counts it stored.
 */
export async function runEntraDirectoryCheck(time:number=now(),{clock=now}:{clock?:()=>number}={}):Promise<DirectoryCheckRun>{
 const settings=await entraSettingsRow();
 if(settings?.enabled!==1||!settingsComplete(settings))return {status:'skipped'};
 const revision=Number(settings.revision),tenant=settings.tenant_id,leaseUntil=time+directoryCheckLimits.leaseMs;
 // One statement takes the lease: due by the last start, no lease held, and the settings still as read.
 const lease=await db().one<{last_result:DirectoryCheckResult|null}>(sql`UPDATE entra_directory_check SET last_started_at=${time},lease_until=${leaseUntil},settings_revision=${revision}
  WHERE id=1 AND (last_started_at IS NULL OR last_started_at<=${time-directoryCheckLimits.intervalMs}) AND (lease_until IS NULL OR lease_until<=${time})
  AND EXISTS (SELECT 1 FROM entra_settings WHERE id=1 AND enabled=1 AND revision=${revision} AND tenant_id=${tenant})
  RETURNING last_result`);
 if(!lease)return {status:'skipped'};
 const ours=sql`id=1 AND lease_until=${leaseUntil} AND settings_revision=${revision}`;
 const release=()=>db().exec(sql`UPDATE entra_directory_check SET lease_until=NULL WHERE ${ours}`);
 try{
  return await checkAccounts();
 }catch(error){
  // An unexpected error (no Graph failure) frees the lease and goes to the scheduler log.
  await release().catch(()=>undefined);
  throw error;
 }

 async function checkAccounts():Promise<DirectoryCheckRun>{
  const settingsGuard:SqlGuard=sql`EXISTS (SELECT 1 FROM entra_settings WHERE id=1 AND enabled=1 AND revision=${revision} AND tenant_id=${tenant})`;
  const eligible=sql`identity_source='entra' AND status='active' AND entra_tenant_id=${tenant}`;
  let failure:GraphFailureCode|null=null,stopped=false,checked=0,locked=0,groupChanges=0,next=0;
  let session:GraphSession|null=null;
  try{session={tenant,clientId:settings!.client_id!,credential:await savedCredential(settings!),revision,clock};}
  catch{failure='credentialRefused';}
  const total=Number((await db().one<{n:number}>(sql`SELECT count(*)::int AS n FROM local_users WHERE ${eligible}`))?.n??0);
  const accounts=session?await db().query<{id:string}>(sql`SELECT id FROM local_users WHERE ${eligible} ORDER BY entra_checked_at ASC NULLS FIRST,id LIMIT ${directoryCheckLimits.maxAccounts}`):[];
  const halted=()=>failure!==null||stopped;

  /** Checks one account and commits its result; skipped when it changed, the run stopped or the settings moved. */
  async function checkAccount(id:string):Promise<Outcome>{
   // Taken before the account and Graph are read: a sign-in from this moment on wins over the answer.
   const readAt=clock();
   const account=await db().one<Account>(sql`SELECT id,auth_principal,auth_email,auth_version,entra_object_id FROM local_users WHERE id=${id} AND ${eligible}`);
   if(!account)return 'skipped';
   const asked=(await db().query<{group_object_id:string}>(sql`SELECT g.group_object_id FROM entra_user_groups g WHERE g.user_id=${id} AND EXISTS (SELECT 1 FROM entra_group_roles m WHERE m.group_object_id=g.group_object_id) ORDER BY g.group_object_id`)).map(row=>row.group_object_id);
   const state=await graphAccountState(session!,account.entra_object_id);
   const member=state==='enabled'&&asked.length?await graphMemberGroups(session!,account.entra_object_id,asked):null;
   const removed=member?asked.filter(group=>!member.has(group)):[];
   // Another account stopped the run: nothing more is committed.
   if(halted())return 'skipped';
   // A sign-in since the account and Graph were read, or any account change since then, wins.
   const guard:SqlGuard=sql`${settingsGuard} AND EXISTS (SELECT 1 FROM local_users WHERE id=${id} AND ${eligible} AND auth_version=${account.auth_version} AND (last_login_at IS NULL OR last_login_at<=${readAt}))`;
   const checkedAt=clock(),oid=account.entra_object_id;
   let outcome:Outcome|null;
   if(state!=='enabled'){
    const owner=lastOwnerGuard(id);
    outcome=await db().transaction(async tx=>{
     // The marker of a kept last Owner keeps its first time; a locked account loses it. kept_before is the value before this update.
     const row=await tx.one<{status:string;kept_before:number|null}>(sql`UPDATE local_users target SET status=CASE WHEN ${owner} THEN 'disabled' ELSE target.status END,auth_version=CASE WHEN ${owner} THEN target.auth_version+1 ELSE target.auth_version END,
      updated_at=CASE WHEN ${owner} THEN ${checkedAt}::bigint ELSE target.updated_at END,entra_checked_at=${checkedAt},
      entra_kept_owner_since=CASE WHEN ${owner} THEN NULL ELSE coalesce(target.entra_kept_owner_since,${checkedAt}::bigint) END
      FROM (SELECT entra_kept_owner_since FROM local_users WHERE id=${id}) old_marker WHERE target.id=${id} AND ${guard} RETURNING target.status,old_marker.entra_kept_owner_since AS kept_before`);
     if(!row)return null;
     const kept=row.status==='active',reported=kept&&row.kept_before!==null;
     // Sessions end on every run; the audit rows of a kept last Owner only when that state starts.
     await runSteps(tx,[
      ...revocationStatements(account),
      sql`DELETE FROM entra_user_groups WHERE user_id=${id}`,
      roleSyncStatement({userId:id,actor:'System',at:checkedAt,keptOnlyRow:!reported}),
      ...(reported?[]:auditEvent({actor:'System',action:'auth.entra.check.locked',target:`user=${id} tenant=${tenant} object=${oid} state=${state}${kept?' keptLastOwner':''}`,guard:sql`TRUE`,at:checkedAt})),
     ]);
     return kept?'keptLastOwner':'locked';
    });
   }else if(removed.length){
    outcome=await db().transaction(async tx=>{
     const row=await tx.one(sql`UPDATE local_users SET entra_checked_at=${checkedAt},entra_kept_owner_since=NULL WHERE id=${id} AND ${guard} RETURNING id`);
     if(!row)return null;
     await runSteps(tx,[
      sql`DELETE FROM entra_user_groups WHERE user_id=${id} AND group_object_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(removed)}::jsonb))`,
      roleSyncStatement({userId:id,actor:'System',at:checkedAt}),
      ...revocationStatements(account),
      ...auditEvent({actor:'System',action:'auth.entra.check.groups',target:`user=${id} object=${oid} removed=${removed.join(',')}`,guard:sql`TRUE`,at:checkedAt}),
     ]);
     return 'groups';
    });
   }else{
    outcome=(await db().exec(sql`UPDATE local_users SET entra_checked_at=${checkedAt},entra_kept_owner_since=NULL WHERE id=${id} AND ${guard}`)).rowCount?'unchanged':null;
   }
   if(outcome)return outcome;
   // Not committed: the settings moved (the run stops) or the account changed (checked again next run).
   if(!await db().one(sql`SELECT 1 AS current WHERE ${settingsGuard}`))stopped=true;
   return 'skipped';
  }

  let unexpected:unknown=null;
  async function worker(){
   while(!halted()&&unexpected===null&&next<accounts.length){
    if(clock()-time>=directoryCheckLimits.budgetMs)return;
    const id=accounts[next++].id;
    try{
     const outcome=await checkAccount(id);
     if(outcome==='skipped')continue;
     checked++;
     if(outcome==='locked')locked++;
     if(outcome==='groups')groupChanges++;
    }catch(error){
     if(error instanceof GraphFailure)failure??=error.code;
     else unexpected??=error;
     return;
    }
   }
  }
  await Promise.all(Array.from({length:directoryCheckLimits.concurrency},worker));
  if(unexpected!==null)throw unexpected;
  if(stopped){await release();return {status:'stopped'};}

  const result:DirectoryCheckResult=failure??'ok',remaining=Math.max(0,total-checked),finishedAt=clock(),previous=lease!.last_result;
  await db().transaction(async tx=>{
   const row=await tx.one(sql`UPDATE entra_directory_check SET last_finished_at=${finishedAt},last_result=${result},last_ok_at=${result==='ok'?sql`${finishedAt}::bigint`:sql`last_ok_at`},
    checked_count=${checked},locked_count=${locked},group_change_count=${groupChanges},remaining_count=${remaining},lease_until=NULL WHERE ${ours} RETURNING id`);
   // One run row only when the result changed: into a failure, or from a failure back to ok.
   if(!row||previous===result||(result==='ok'&&previous===null))return;
   await runSteps(tx,auditEvent(result==='ok'
    ?{actor:'System',action:'auth.entra.check.restored',target:`result=ok previous=${previous}`,guard:sql`TRUE`,at:finishedAt}
    :{actor:'System',action:'auth.entra.check.failed',target:`result=${result}`,guard:sql`TRUE`,at:finishedAt}));
  });
  return {status:'ran',result,checked,locked,groupChanges,remaining};
 }
}
