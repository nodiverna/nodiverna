import {jobDisplayInput} from '../../job-input';
import {commitAll,db,sql,type Sql} from '../db';
import type {Release} from './releases';
import {customerEntries,type CustomerScope} from '../identity/cross-customer';

// ---- Release rollout (app/api/releases) ---------------------------------------
// Rolling out a signed agent release is routine (lib/step-up.ts) and relies on
// the live MFA login session: every job INSERT carries the route's
// mfaSessionFence (lib/server/identity/mfa.ts), so a session that ended before the commit
// admits no job and no customer entry. Releases enter the catalog only through
// the import (runtime/release-import.mjs).
export type ReleaseWrite={written:boolean};
/** The newest 100 agent update jobs of the given devices. */
export async function updateCampaigns(serverIds:string[]){
 return db().query(sql`SELECT id,server_id AS "serverId",target AS version,state,result,not_before AS "notBefore",created_at AS "createdAt" FROM jobs WHERE action='agent-update' AND server_id IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(serverIds)}::jsonb)) ORDER BY created_at DESC LIMIT 100`);
}
/** Whether a device has an open remote desktop session. */
export async function hasOpenRdpSession(serverId:string){return !!await db().one(sql`SELECT id FROM rdp_sessions WHERE server_id=${serverId} AND state IN ('opening','open') LIMIT 1`);}
/** Whether a device has a pending or running agent update. */
export async function hasActiveAgentUpdate(serverId:string){return !!await db().one(sql`SELECT id FROM jobs WHERE server_id=${serverId} AND action='agent-update' AND state IN ('pending','running') LIMIT 1`);}
/** One planned update job with the signed envelope chosen for its device. */
export type StagedUpdate={id:string;serverId:string;envelope:{manifest:string;signature:string}};
/**
 * Plans one agent update job per staged device and the customer entries in one
 * transaction. Every job is admitted by the authorization, the customer gate,
 * the live release, no open remote desktop session, no other active update and
 * the live MFA login session (`fence`, the route's mfaSessionFence). Each job
 * carries the signed path-form envelope of the release.
 */
export async function scheduleAgentUpdates(input:{staged:StagedUpdate[];release:Release;time:number;scheduledAt:number;actor:{id:string;label:string;principal:string};authorization:Sql;customers:CustomerScope;fence:Sql}):Promise<ReleaseWrite>{
 const {staged,release:r,time,scheduledAt,actor,authorization,customers,fence}=input,jobIds=JSON.stringify(staged.map(j=>j.id)),servers=JSON.stringify(staged.map(target=>target.serverId));
 const results=await commitAll([...staged.map(j=>sql`INSERT INTO jobs (id,server_id,action,target,parameters,display_input,created_at,actor,actor_email,actor_principal,not_before) SELECT ${j.id},${j.serverId},'agent-update',${r.version},${JSON.stringify({releaseId:r.id,manifest:j.envelope.manifest,signature:j.envelope.signature})},${jobDisplayInput('agent-update',{releaseId:r.id})},${time},${actor.id},${actor.label.trim().toLowerCase()},${actor.principal},${scheduledAt} WHERE ${authorization} AND ${customers.guard} AND NOT EXISTS (SELECT 1 FROM agent_release_states WHERE release_id=${r.id}) AND NOT EXISTS (SELECT 1 FROM rdp_sessions WHERE server_id IN (SELECT value FROM jsonb_array_elements_text(${servers}::jsonb)) AND state IN ('opening','open')) AND NOT EXISTS (SELECT 1 FROM jobs WHERE action='agent-update' AND state IN ('pending','running') AND server_id IN (SELECT value FROM jsonb_array_elements_text(${servers}::jsonb)) AND id NOT IN (SELECT value FROM jsonb_array_elements_text(${jobIds}::jsonb))) AND (${fence})`),
  ...customerEntries(customers,{actor:actor.label,action:'Agent-Update kundenübergreifend geplant',target:r.version,condition:sql`EXISTS (SELECT 1 FROM jobs WHERE action='agent-update' AND id IN (SELECT value FROM jsonb_array_elements_text(${jobIds}::jsonb)))`})]);
 return {written:results.slice(0,staged.length).every(result=>result.rowCount>0)};
}
