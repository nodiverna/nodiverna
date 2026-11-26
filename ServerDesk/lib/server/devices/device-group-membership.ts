import {guid,HttpError,now} from '../context';
import {globalPermissionGuard,groupPermissionGuard,hasGlobalPermission,principal,requireGroup,type SqlGuard} from '../identity/access';
import {featureTargetsGuard} from '../identity/feature-authorization';
import type {Viewer} from '../../types';
import {deviceGroupConflict} from './device-groups';
import type {ManagementAuthorization} from '../identity/rbac';
import {commitAll,db,sql,type Step,type StepResult} from '../db';


// A device belongs to exactly one group (unique index since 0027). Adding it to
// a group moves it: its previous membership is removed in the same commit and
// needs manage rights on the group it leaves. assign-device replaces all.
// Organizing devices is routine (lib/step-up.ts): `session` is the request's
// live-session fence (mfaSessionFence), checked in the committing batch. A
// change that widens access (the rule in lib/step-up.ts) needs a fresh step-up
// proof: `stepUp` reads it, the audit admission requires it and the batch
// consumes it. A change read as not widening commits without a proof, and its
// admission requires that it still does not widen access at commit.
export async function changeDeviceMemberships(v:Viewer,ids:unknown,groupId:unknown,assigned:unknown,session:SqlGuard,replace=false,removeIds:string[]=[],stepUp:(()=>Promise<ManagementAuthorization>)|null=null){
 if(!Array.isArray(ids)||!ids.length||ids.length>1000||ids.some(value=>!guid(value))||groupId!==null&&!guid(groupId)||typeof assigned!=='boolean'||!replace&&groupId===null)throw new HttpError('apiError.groupMembership.selectDevicesAndGroup');
 if(removeIds.length>1000||removeIds.some(value=>!guid(value))||replace&&removeIds.length)throw new HttpError('apiError.groupMembership.invalidSelection');
 const addIds=[...new Set(ids as string[])].filter(id=>!removeIds.includes(id)),serverIds=[...new Set([...(ids as string[]),...removeIds])],d=db(),global=await hasGlobalPermission(v,'groups.manage');
 if(serverIds.length>1000)throw new HttpError('apiError.groupMembership.tooMany');
 const previous=(await d.query<{server_id:string;group_id:string}>(sql`SELECT server_id,group_id FROM device_group_members WHERE server_id IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(serverIds)}::jsonb)) ORDER BY server_id,group_id`));
 const readGroups=[...new Set([...previous.map(member=>member.group_id),...(groupId===null?[]:[groupId as string])])],readGroupJson=JSON.stringify(readGroups);
 const ancestry=(await d.query<{group_id:string;ancestor_id:string;depth:number}>(sql`SELECT group_id,ancestor_id,depth FROM device_group_ancestors WHERE group_id IN (SELECT value FROM jsonb_array_elements_text(${readGroupJson}::jsonb)) ORDER BY group_id,depth,ancestor_id`));
 const moves=previous.filter(member=>!replace&&assigned&&addIds.includes(member.server_id)&&member.group_id!==groupId);
 const removedMemberships=previous.filter(member=>replace||(!assigned||removeIds.includes(member.server_id))&&member.group_id===groupId||moves.includes(member));
 if(!global&&replace&&(groupId===null||serverIds.some(id=>!previous.some(member=>member.server_id===id))))throw new HttpError('apiError.groupMembership.unassignedGlobalRight');
 const sourceIds=[...new Set(removedMemberships.map(member=>member.group_id))];
 const scopes=[...new Set([...sourceIds,...(groupId===null?[]:[groupId as string])])];
 for(const scope of scopes)await requireGroup(v,scope);
 const targets=featureTargetsGuard(v,serverIds,['view']),guards:SqlGuard[]=[targets,session];
 // Widening: a device added to the target group gets a devicegroup assignment
 // on an ancestor of the target (itself included) that does not already reach
 // it through its current group. Removals add no device and never widen access.
 const addedIds=groupId!==null&&assigned?addIds:[];
 const widens:SqlGuard=sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(${JSON.stringify(addedIds)}::jsonb) added JOIN role_assignments widening ON widening.scope_type='devicegroup' JOIN device_group_ancestors target_path ON target_path.group_id=${groupId===null?'':groupId as string} AND target_path.ancestor_id=widening.scope_id WHERE NOT EXISTS (SELECT 1 FROM device_group_members current_member JOIN device_group_ancestors current_path ON current_path.group_id=current_member.group_id WHERE current_member.server_id=added.value AND current_path.ancestor_id=widening.scope_id))`;
 const checksWidening=!!stepUp&&addedIds.length>0;
 const widensNow=async()=>!!(await d.one<{widens:boolean}>(sql`SELECT ${widens} AS widens`))?.widens;
 const proof=checksWidening&&await widensNow()?await stepUp!():null;
 if(proof)guards.push(proof.guard);else if(checksWidening)guards.push(sql`NOT ${widens}`);
 const me=sql`${principal(v)}`;
 if(global)guards.push(globalPermissionGuard(me,'groups.manage'));
 else for(const scope of scopes)guards.push(groupPermissionGuard(sql`${scope}`,me));
 // Compare the complete read set at commit, including the memberships moved away.
 const expected=JSON.stringify(previous.map(member=>[member.server_id,member.group_id]));
 guards.push(sql`coalesce((SELECT jsonb_agg(jsonb_build_array(server_id,group_id) ORDER BY server_id,group_id) FROM device_group_members WHERE server_id IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(serverIds)}::jsonb))),'[]'::jsonb)=${expected}::jsonb`);
 const expectedAncestry=JSON.stringify(ancestry.map(path=>[path.group_id,path.ancestor_id,path.depth]));
 guards.push(sql`coalesce((SELECT jsonb_agg(jsonb_build_array(group_id,ancestor_id,depth) ORDER BY group_id,depth,ancestor_id) FROM device_group_ancestors WHERE group_id IN (SELECT value FROM jsonb_array_elements_text(${readGroupJson}::jsonb))),'[]'::jsonb)=${expectedAncestry}::jsonb`);
 if(groupId!==null)guards.push(sql`EXISTS (SELECT 1 FROM device_groups WHERE id=${groupId as string})`);
 const guard=sql.join(guards.map(item=>sql`(${item})`),sql` AND `);
 const at=now(),receipt=crypto.randomUUID(),action='Gerätezuordnung geändert',admission=sql`EXISTS (SELECT 1 FROM audit WHERE at=${at} AND actor=${v.label} AND action=${action} AND target=${receipt})`;
 const mutations:Step[]=[];
 if(replace)mutations.push(sql`DELETE FROM device_group_members WHERE server_id IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(serverIds)}::jsonb)) AND ${admission}`);
 else if(moves.length)mutations.push(sql`DELETE FROM device_group_members WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(${JSON.stringify(moves.map(member=>[member.server_id,member.group_id]))}::jsonb) removed WHERE device_group_members.server_id=removed.value->>0 AND device_group_members.group_id=removed.value->>1) AND ${admission}`);
 if(groupId!==null){if(assigned&&addIds.length)mutations.push(sql`INSERT INTO device_group_members(server_id,group_id) SELECT value,${groupId as string}::text FROM jsonb_array_elements_text(${JSON.stringify(addIds)}::jsonb) WHERE ${admission} ON CONFLICT(server_id,group_id) DO NOTHING`);if(!assigned||removeIds.length)mutations.push(sql`DELETE FROM device_group_members WHERE group_id=${groupId as string} AND server_id IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(assigned?removeIds:serverIds)}::jsonb)) AND ${admission}`);}
 const affectedGroups=JSON.stringify([...new Set([...sourceIds,...(groupId===null?[]:[groupId as string])])]);
 const affectedUsers=sql`SELECT u.id,u.auth_principal FROM local_users u WHERE EXISTS (SELECT 1 FROM role_assignments a WHERE a.scope_type='devicegroup' AND EXISTS (SELECT 1 FROM device_group_ancestors ancestor WHERE ancestor.group_id IN (SELECT value FROM jsonb_array_elements_text(${affectedGroups}::jsonb)) AND ancestor.ancestor_id=a.scope_id) AND ((a.principal_type='user' AND a.principal_id=u.id) OR (a.principal_type='group' AND EXISTS (SELECT 1 FROM user_group_members m WHERE m.user_id=u.id AND m.group_id=a.principal_id))))`;
 const affected=(column:'id'|'auth_principal')=>sql`IN (SELECT ${sql.ident(column)} FROM (${affectedUsers}) affected_user)`;
 const revocations:Step[]=[
  sql`UPDATE jobs SET state='cancelled',parameters='{}',result='serverMessage.job.permissionChanged' WHERE actor_principal ${affected('auth_principal')} AND state='pending' AND ${admission}`,
  ...['mfa_authenticator_challenges','mfa_management_proofs','mfa_proofs','mfa_sessions','mfa_grants','passkey_challenges'].map(table=>sql`DELETE FROM ${sql.ident(table)} WHERE principal ${affected('auth_principal')} AND ${admission}`),
  sql`DELETE FROM local_auth_sessions WHERE user_id ${affected('id')} AND ${admission}`,
  sql`UPDATE terminal_sessions SET state='closed',error='serverMessage.access.userRightsChanged' WHERE principal ${affected('auth_principal')} AND state IN ('opening','open') AND ${admission}`,
  sql`UPDATE rdp_sessions SET state='closed',key_envelope=NULL,error='serverMessage.access.userRightsChanged' WHERE principal ${affected('auth_principal')} AND state IN ('opening','open') AND ${admission}`,
  sql`UPDATE transfers SET state='cancelled',updated_at=${at},message='serverMessage.access.userRightsChanged' WHERE principal ${affected('auth_principal')} AND state NOT IN ('completed','cancelled','failed','expired') AND ${admission}`,
  sql`UPDATE runbook_runs SET cancel_requested=1 WHERE actor ${affected('auth_principal')} AND state IN ('queued','running') AND ${admission}`,
  ...['rdp_frames','rdp_receipts'].map(table=>sql`DELETE FROM ${sql.ident(table)} WHERE session_id IN (SELECT id FROM rdp_sessions WHERE principal ${affected('auth_principal')}) AND ${admission}`)
 ];
 let result:StepResult[];
 try{
  result=await commitAll([
   sql`INSERT INTO audit(at,actor,action,target) SELECT ${at},${v.label},${action},${receipt} WHERE ${guard}`,
   ...revocations,...mutations,
   ...(proof?[sql`DELETE FROM mfa_management_proofs WHERE token_hash=${proof.tokenHash} AND principal=${proof.key} AND session_hash=${proof.sessionHash} AND ${admission}`]:[])
  ]);
 }catch(error){throw deviceGroupConflict(error)??error;}
 if(!result[0].rowCount){
  // Name the step-up when the proof vanished or the change now widens access.
  if(proof&&!await d.one(sql`SELECT 1 AS confirmed WHERE ${proof.guard}`))throw new HttpError('apiError.mfa.proofExpired');
  if(!proof&&checksWidening&&await widensNow())throw new HttpError('apiError.mfa.confirmChange');
  throw new HttpError('apiError.groupMembership.changed');
 }
 return {ok:true,count:serverIds.length};
}
