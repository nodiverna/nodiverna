import {type body,guid,HttpError,now} from '../context';
import {auditAfterChange,auditEvent} from '../audit';
import {allPermissions,allowedDeviceIds,allowedGroupIds,customerAccessGuard,globalPermissionGuard,groupPermissionGuard,groupPermissions,hasGlobalPermission,permissionDefinitions,principal,requireGroup,resolvePrincipal,rolePermissions,type GrantRole,type Permission,type SqlGuard} from './access';
import {commitManagementChange,commitSessionChange,deleteDeviceGroupRequest,invalidateRbacUsers,prepareManagementAuthorization,type ManagementAuthorization} from './rbac';
import {mfaSessionFence,requireLiveSessions} from './mfa';
import {accessActionNeedsStepUp,accessActionNeedsStepUpWhenWidening,deviceGroupDeleteNeedsStepUp} from '../../step-up';
import type {Viewer} from '../../types';
import {commitWithAudit} from '../security-commit';
import {can} from './policy/can';
import {changeDeviceMemberships} from '../devices/device-group-membership';
import {deviceGroupAncestors,deviceGroupHasAssignmentsSql,deviceGroupHasMembersSql} from '../devices/device-groups';
import {defaultCustomerId,visibleCustomers} from './customers';
import {catalogCommit} from '../catalog-ownership';
import {db,sql,type Sql} from '../db';

// Device group administration of the access panel (app/api/access): the
// overview and the group, membership and per-group grant changes.
function writeGuard(v:Viewer,scopes:Awaited<ReturnType<typeof requireGroup>>[],proof:SqlGuard):SqlGuard{
 const me=sql`${principal(v)}`,clauses=[proof,...scopes.map(scope=>groupPermissionGuard(sql`${scope.id}`,me,'groups.manage'))];
 return sql.join(clauses.map(clause=>sql`(${clause})`),sql` AND `);
}
// A delegator may only pass on rights it still holds when the grant commits, so
// every delegated right (aliases included) is rechecked against the live state.
// The recipient must still be active, and a self-grant still needs the global
// groups.manage right that the pre-check required.
function grantGuard(v:Viewer,scope:Awaited<ReturnType<typeof requireGroup>>,proof:ManagementAuthorization,rights:readonly string[],recipient:Viewer):SqlGuard{
 const me=sql`${principal(v)}`,clauses:SqlGuard[]=[writeGuard(v,[scope],proof.guard),sql`EXISTS (SELECT 1 FROM local_users grant_recipient WHERE grant_recipient.id=${recipient.id} AND grant_recipient.status='active')`];
 for(const right of new Set(rights))clauses.push(groupPermissionGuard(sql`${scope.id}`,me,right as Permission));
 if(principal(recipient)===principal(v))clauses.push(globalPermissionGuard(me,'groups.manage'));
 return sql.join(clauses.map(clause=>sql`(${clause})`),sql` AND `);
}
function grantRole(rights:string[]):GrantRole{return rights.includes('groups.manage')?'admin':rights.some(right=>!rolePermissions.viewer.includes(right as Permission))?'operator':'viewer';}
/** The access panel: groups the viewer manages, memberships, grants and active users. */
export async function accessOverview(v:Viewer){
 const d=db(),globalAdmin=await can(v,'instance.owner'),groupIds=await allowedGroupIds(v,'groups.manage'),deviceIds=await allowedDeviceIds(v),canCreateGroups=await hasGlobalPermission(v,'groups.manage'),canManageAssignments=await hasGlobalPermission(v,'portal.roleAssignments.manage');
 const [groups,memberships,grants,users]=await Promise.all([
  d.query<{id:string;name:string;description:string;parentId:string|null;depth:number;childCount:number;has_assignments:boolean;has_members:boolean}>(sql`SELECT id,name,description,parent_id AS "parentId",(SELECT max(depth) FROM device_group_ancestors WHERE group_id=device_groups.id) AS depth,(SELECT count(*) FROM device_groups children WHERE children.parent_id=device_groups.id) AS "childCount",${deviceGroupHasAssignmentsSql(sql`device_groups.id`)} AS has_assignments,${deviceGroupHasMembersSql(sql`device_groups.id`)} AS has_members FROM device_groups WHERE id IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(groupIds)}::jsonb)) ORDER BY name`),
  d.query<{server_id:string;group_id:string}>(sql`SELECT m.server_id,m.group_id FROM device_group_members m JOIN servers s ON s.id=m.server_id WHERE s.revoked=0`),
  d.query<{id:string;groupId:string;principal:string;permissions:string}>(sql`SELECT a.id,a.scope_id AS "groupId",u.auth_principal AS principal,r.permissions FROM role_assignments a JOIN local_users u ON a.principal_type='user' AND u.id=a.principal_id JOIN rbac_roles r ON r.id=a.role_id WHERE a.scope_type='devicegroup' AND a.scope_id IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(groupIds)}::jsonb)) AND u.status<>'disabled'`),
  groupIds.length||globalAdmin||canCreateGroups?d.query<{id:string;auth_principal:string;display_name:string;username:string}>(sql`SELECT id,auth_principal,display_name,username FROM local_users WHERE status='active' ORDER BY username`):Promise.resolve([])
 ]),customers=await visibleCustomers(v);
 return {groups:await Promise.all(groups.map(async group=>({id:group.id,name:group.name,description:group.description,parentId:group.parentId,depth:group.depth,childCount:group.childCount,protected:false,deletable:!group.childCount&&canCreateGroups&&(!group.has_assignments||canManageAssignments),stepUpOnDelete:deviceGroupDeleteNeedsStepUp({hasMembers:!!group.has_members,hasAssignments:!!group.has_assignments}),deviceIds:memberships.filter(member=>member.group_id===group.id&&deviceIds.includes(member.server_id)).map(member=>member.server_id),grantedPermissions:await groupPermissions(v,group.id),editable:true}))),grants:grants.map(grant=>{let permissions:string[]=[];try{permissions=JSON.parse(grant.permissions);}catch{}if(permissions.includes('*'))permissions=[...allPermissions];return {...grant,role:grantRole(permissions),permissions};}),permissions:permissionDefinitions,principals:await Promise.all(users.map(async user=>{const viewer=await resolvePrincipal(user.auth_principal);return {id:user.auth_principal,label:user.display_name||user.username,owner:viewer?await can(viewer,'instance.owner'):false};})),globalAdmin,canCreateGroups,canArrangeAllDevices:canCreateGroups,canManageGroups:canCreateGroups||groupIds.length>0,deviceIds,customers};
}
/** One change of the access panel; the answer is the JSON body of the route. */
export async function changeAccess(request:Request,v:Viewer,p:Awaited<ReturnType<typeof body>>){
 const d=db();
 // delete-group asks for a proof only in its risky case (lib/step-up.ts) and
 // reads it after its checks; deleteDeviceGroupRequest decides and commits.
 if(p.action==='delete-group')return await deleteDeviceGroupRequest(request,v,p.id,p.confirm,p.managementToken);
 // Critical actions (lib/step-up.ts) need and consume a fresh proof. Routine
 // ones rely on the MFA login session: they ignore a supplied managementToken
 // and commit behind the live primary and MFA session fence instead.
 const proof=accessActionNeedsStepUp(p.action)?await prepareManagementAuthorization(request,v,p.managementToken):null,fence:SqlGuard=proof?proof.guard:await mfaSessionFence(request,v);
 const confirmed=():ManagementAuthorization=>{if(!proof)throw new HttpError('apiError.mfa.confirmChange');return proof;};
 // A routine write stopped by its session fence answers with the session's own
 // 401 (SESSION_EXPIRED/IDENTITY_LOGIN_REQUIRED), so the client opens the re-login.
 const refused=async(error:unknown)=>{if(!proof&&error instanceof HttpError&&error.status===403)await requireLiveSessions(request,v);return error;};
 // Device moves are routine unless they widen access (lib/step-up.ts); only then
 // does changeDeviceMemberships read and consume the request's managementToken.
 const widening=accessActionNeedsStepUpWhenWidening(p.action)?()=>prepareManagementAuthorization(request,v,p.managementToken):null;
 const memberships=(actor:Viewer,ids:unknown,groupId:unknown,assigned:unknown,session:SqlGuard,replace=false,removeIds:string[]=[])=>changeDeviceMemberships(actor,ids,groupId,assigned,session,replace,removeIds,widening).catch(async(error:unknown)=>{throw await refused(error);});
 const commit=(statement:Sql,action:string,target:string)=>{const audit=auditEvent({actor:v.label,action,target,guard:auditAfterChange});return proof?commitManagementChange(statement,proof,audit):commitSessionChange(statement,audit);};
 if(p.action==='update-group'){
  const scope=await requireGroup(v,String(p.id??'')),name=typeof p.name==='string'?p.name.trim():'',description=typeof p.description==='string'?p.description.trim():'';
  if(!name||name.length>80||description.length>500)throw new HttpError('apiError.group.checkNameAndDescription');
  if(Object.hasOwn(p,'parentId'))throw new HttpError('apiError.group.onlyNameAndDescription');
  const guard=writeGuard(v,[scope],fence),changed=await commit(sql`UPDATE device_groups SET name=${name},description=${description} WHERE id=${scope.id} AND ${guard} RETURNING id`,'Gerätegruppe geändert',name);
  if(!changed)throw await refused(new HttpError('apiError.group.rightRevoked'));
  return {ok:true,id:scope.id};
 }
 if(p.action==='create-group'){
  if(!await hasGlobalPermission(v,'groups.manage'))throw new HttpError('apiError.group.globalRightRequired');
  const name=typeof p.name==='string'?p.name.trim():'',description=typeof p.description==='string'?p.description.trim():'';if(!name||name.length>80||description.length>500)throw new HttpError('apiError.group.checkNameAndDescription');
  const id=crypto.randomUUID();
  const parentId=p.parentId===undefined||p.parentId===null?null:p.parentId;if(parentId!==null&&!guid(parentId))throw new HttpError('apiError.group.invalidParent');
  const requested=p.customerId===undefined||p.customerId===null?null:p.customerId;if(requested!==null&&!guid(requested))throw new HttpError('apiError.customer.invalid');
  // A subgroup inherits its parent's customer; a root group belongs to the chosen
  // customer, without a choice to the first customer.
  let customerId=requested===null?defaultCustomerId:requested.toLowerCase();
  if(parentId!==null){
   await requireGroup(v,parentId);if((await deviceGroupAncestors(parentId)).length>4)throw new HttpError('apiError.group.depthLimit');
   const parentCustomer=await d.one<{"customer_id":string}>(sql`SELECT customer_id FROM device_groups WHERE id=${parentId}`).then(row=>row===null?null:row.customer_id);
   if(!parentCustomer)throw new HttpError('apiError.group.notFound');
   if(requested!==null&&customerId!==parentCustomer)throw new HttpError('apiError.group.subgroupCustomer');
   customerId=parentCustomer;
  }
  // Customers outside the viewer's boundary answer as if they did not exist.
  const visible=customerAccessGuard(sql`customers.id`,sql`${principal(v)}`),customer=await d.one<{status:string}>(sql`SELECT status FROM customers WHERE id=${customerId} AND ${visible}`);
  if(!customer)throw new HttpError('apiError.customer.unavailable');
  if(customer.status==='disabled')throw new HttpError('apiError.customer.disabled');
  // Global permission is tested directly because the target group does not yet
  // exist; the boundary is tested on exactly the customer the row receives.
  const me=sql`${principal(v)}`,owning=sql`coalesce((SELECT boundary_parent.customer_id FROM device_groups boundary_parent WHERE boundary_parent.id=${parentId}),${customerId})`;
  const global=globalPermissionGuard(me,'groups.manage'),boundary=customerAccessGuard(owning,me);
  const changed=await commit(sql`INSERT INTO device_groups(id,name,description,created_at,parent_id,customer_id) SELECT ${id},${name},${description},${now()},${parentId},coalesce((SELECT customer_id FROM device_groups WHERE id=${parentId}),${customerId}) WHERE ${global} AND ${fence} AND ${boundary} RETURNING id`,'Gerätegruppe erstellt',name);
  if(!changed)throw await refused(new HttpError('apiError.group.rightRevoked'));return {ok:true,id};
 }
 if(p.action==='assign-device'){
  // serverIds moves several devices at once; serverId stays for older clients.
  return await memberships(v,Array.isArray(p.serverIds)?p.serverIds:[p.serverId],p.groupId,true,fence,true);
 }
 if(p.action==='set-device-memberships')return await memberships(v,p.serverIds,p.groupId,p.assigned,fence);
 if(p.action==='update-device-memberships'){
  if(!Array.isArray(p.addIds)||!Array.isArray(p.removeIds)||!p.addIds.length&&!p.removeIds.length)throw new HttpError('apiError.group.changeOneAssignment');
  return await memberships(v,p.addIds.length?p.addIds:p.removeIds,p.groupId,!!p.addIds.length,fence,false,p.addIds.length?p.removeIds:[]);
 }
 // The per-group grant editor of the access panel stores its rights as a
 // compat-grant role. The role/group workspace writes role_assignments directly
 // and is the canonical UI.
 if(p.action==='set-grant'){
  if(!guid(p.groupId)||typeof p.principal!=='string'||!['viewer','operator','admin'].includes(p.role)||!Array.isArray(p.permissions)||p.permissions.some((right:unknown)=>typeof right!=='string'||!allPermissions.includes(right as Permission)))throw new HttpError('apiError.group.grantInput');
  const scope=await requireGroup(v,p.groupId),recipient=await resolvePrincipal(p.principal);if(!recipient)throw new HttpError('apiError.group.selectActiveUser');
  const role=p.role as GrantRole,rights=allPermissions.filter(right=>right==='view'||p.permissions.includes(right));if(rights.some(right=>!rolePermissions[role].includes(right)))throw new HttpError('apiError.group.roleUnsupported');
  const expanded=rights.includes('runbooks')?[...rights,'runbooks.read','runbooks.execute']:rights;if(expanded.some(right=>!scope.permissions.includes(right as Permission)))throw new HttpError('apiError.group.onlyOwnGrants');
  if(principal(recipient)===principal(v)&&!await hasGlobalPermission(v,'groups.manage'))throw new HttpError('apiError.group.ownManagementRights');
  const roleId='compat-grant:'+recipient.id+':'+p.groupId,json=JSON.stringify(rights),confirmation=confirmed(),guard=grantGuard(v,scope,confirmation,expanded,recipient),assignmentId=crypto.randomUUID(),at=now();
  // Role replacement, assignment and audit row are guarded by the live delegated
  // rights and the live recipient status and consume one fresh proof in one
  // transaction, so a concurrent revoke or account disable cannot become a
  // partial or unaudited grant.
  // The grant role belongs to the group's customer; an existing one keeps its owner.
  const statements=[sql`INSERT INTO rbac_roles(id,name,description,permissions,builtin,created_at,customer_id) SELECT ${roleId},${'Gerätegruppenfreigabe '+recipient.id+' / '+p.groupId},${'Direkte Gerätegruppenfreigabe'},${json},0,${at},(SELECT customer_id FROM device_groups WHERE id=${p.groupId}) WHERE ${guard} ON CONFLICT(id) DO UPDATE SET permissions=excluded.permissions WHERE rbac_roles.builtin=0`,sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) SELECT ${assignmentId},'user',${recipient.id},${roleId},'devicegroup',${p.groupId},${at},${principal(v)} WHERE ${guard} AND EXISTS (SELECT 1 FROM rbac_roles WHERE id=${roleId} AND permissions=${json}) ON CONFLICT(principal_type,principal_id,role_id,scope_type,scope_id) DO NOTHING`,sql`DELETE FROM role_assignments WHERE principal_type='user' AND principal_id=${recipient.id} AND scope_type='devicegroup' AND scope_id=${p.groupId} AND role_id<>${roleId} AND ${guard} AND EXISTS (SELECT 1 FROM role_assignments WHERE principal_type='user' AND principal_id=${recipient.id} AND role_id=${roleId} AND scope_type='devicegroup' AND scope_id=${p.groupId})`,sql`DELETE FROM mfa_management_proofs WHERE token_hash=${confirmation.tokenHash} AND principal=${confirmation.key} AND session_hash=${confirmation.sessionHash}`];
  // at:0 meets the guard rule: guard is the mutations' own guard, evaluated before them.
  // The batch changes neither local_users nor global-scope assignments, and the new
  // grant role carries every delegated right on the group (also for a self-grant),
  // so a guard that holds before the mutations still holds after them.
  const {results,audited}=await catalogCommit(()=>commitWithAudit(statements,{audit:{actor:v.label,action:'Gerätegruppenrechte geändert',target:recipient.id+' / '+p.groupId},guard,at:0}));
  if(!results[3].rowCount)throw new HttpError('apiError.mfa.proofUsed');if(!audited){
   // Only picks the message; the committing guard already denied the grant.
   if(!await d.one(sql`SELECT 1 AS active FROM local_users WHERE id=${recipient.id} AND status='active'`))throw new HttpError('apiError.group.userDisabled');
   throw new HttpError('apiError.group.grantRevoked');
  }await invalidateRbacUsers([{auth_principal:principal(recipient)}]);return {ok:true};
 }
 if(p.action==='delete-grant'){
  if(!guid(p.id))throw new HttpError('apiError.group.invalidGrant');const grant=await d.one<{id:string;principal_id:string;role_id:string;scope_id:string}>(sql`SELECT id,principal_id,role_id,scope_id FROM role_assignments WHERE id=${p.id} AND principal_type='user' AND scope_type='devicegroup'`);if(!grant)throw new HttpError('apiError.group.grantNotFound');
  const scope=await requireGroup(v,grant.scope_id),guard=writeGuard(v,[scope],confirmed().guard),recipient=await d.one<{auth_principal:string}>(sql`SELECT auth_principal FROM local_users WHERE id=${grant.principal_id}`);
  const changed=await commit(sql`DELETE FROM role_assignments WHERE id=${grant.id} AND principal_type='user' AND scope_type='devicegroup' AND scope_id=${grant.scope_id} AND ${guard} RETURNING id`,'Gerätegruppenfreigabe entfernt',grant.id);if(!changed)throw new HttpError('apiError.group.grantChanged');if(recipient)await invalidateRbacUsers([recipient]);return {ok:true};
 }
 throw new HttpError('apiError.access.unknownAction');
}
