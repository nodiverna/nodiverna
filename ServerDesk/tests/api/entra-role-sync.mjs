// Entra group mappings → portal roles: the sync at sign-in, the sync of every
// Entra account after add-mapping and remove-mapping, manual assignments left
// alone, the refused manual delete of an Entra row, the kept last Owner and the
// auth.entra.roles.sync rows. Rights are read with globalPermissions and
// devicePermissionGuard before and after. Real lib/server/identity/entra/*, lib/server/identity/rbac.ts and
// lib/server/identity/access.ts on an isolated PostgreSQL database (tests/support/entra-fixture.mjs).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {entraFixture} from '../support/entra-fixture.mjs';
import {inTransaction} from '../support/source-database.mjs';
import {sql} from '../../runtime/database.mjs';

const f=await entraFixture(),{d,m,microsoft}=f;
let checks=0;
const check=(value,expected,label)=>{assert.deepEqual(value,expected,label);checks++;};
const groupOps='0b0b0b0b-0000-4000-8000-000000000001',groupAdmins='0b0b0b0b-0000-4000-8000-000000000002',groupOther='0b0b0b0b-0000-4000-8000-000000000003';
const oidA='a0a0a0a0-0000-4000-8000-00000000000a',oidB='b0b0b0b0-0000-4000-8000-00000000000b';
try{
 await f.configure();
 const time=Date.now(),deviceGroup=crypto.randomUUID(),device=crypto.randomUUID(),outside=crypto.randomUUID();
 await d.exec(sql`INSERT INTO device_groups(id,name,description,created_at) VALUES(${deviceGroup},'Production','Fixture',${time})`);
 for(const id of [device,outside])await d.exec(sql`INSERT INTO servers(id,name,token_hash,created_at,revoked) VALUES(${id},${id.slice(0,8)},${crypto.randomBytes(32).toString('hex')},${time},0)`);
 await inTransaction(d,[sql`INSERT INTO device_group_members(server_id,group_id) VALUES(${device},${deviceGroup})`]);
 const owner=await f.localAccount('owner@entra.test');
 const post=async(browser,payload)=>{f.setViewer(await f.viewerOf(browser));return f.answer(await m.settingsApi.POST(f.request('/api/entra/settings',{browser,payload})));};
 const addMapping=async(groupObjectId,roleId,scopeType='global',scopeId)=>{const login=await f.localLogin(owner);const result=await post(login,{action:'add-mapping',groupObjectId,groupName:'Group '+groupObjectId.slice(-1),roleId,scopeType,...(scopeId?{scopeId}:{}),managementToken:login.management});assert.equal(result.status,200,result.body.error);return result.body;};
 const removeMapping=async id=>{const login=await f.localLogin(owner);const result=await post(login,{action:'remove-mapping',id,managementToken:login.management});assert.equal(result.status,200,result.body.error);return result.body;};
 const signInAs=async(oid,groups)=>{f.resetMicrosoft();microsoft.claims={oid,groups};const result=await f.signIn();f.resetMicrosoft();assert.equal(result.target,'/');return {...result,viewer:await f.viewerOf(result.browser)};};
 const userOf=async oid=>(await d.one(sql`SELECT id FROM local_users WHERE entra_object_id=${oid}`)).id;
 const assignments=async userId=>(await d.query(sql`SELECT role_id,scope_type,scope_id,source,created_by FROM role_assignments WHERE principal_type='user' AND principal_id=${userId} ORDER BY role_id,scope_type`)).map(row=>({...row}));
 const syncRows=async()=>(await f.auditRows('auth.entra.roles.sync')).map(row=>[row.actor,row.target]);
 const rights=async viewer=>m.access.globalPermissions(viewer);
 const onDevice=async(viewer,id,permission='view')=>!!await d.one(sql`SELECT 1 AS allowed WHERE ${m.access.devicePermissionGuard(sql`${id}`,sql`${viewer.principal}`,permission)}`);

 // ---- A mapping gives the role at sign-in --------------------------------------------
 let a,userA,opsMapping;
 {
  const first=await signInAs(oidA,[groupOps]);userA=await userOf(oidA);
  check([await rights(first.viewer),await onDevice(first.viewer,device)],[[],false],'no mapping: no rights');
  check(await syncRows(),[],'no change, no sync row');
  opsMapping=(await addMapping(groupOps,'builtin-operator')).mappings.find(mapping=>mapping.groupObjectId===groupOps);
  check([opsMapping.roleName,opsMapping.scopeType,opsMapping.groupName],['Operator','global','Group 1'],'mapping listed');
  check(await assignments(userA),[{role_id:'builtin-operator',scope_type:'global',scope_id:'*',source:'entra',created_by:'entra:sync'}],'add-mapping syncs the signed-in account at once');
  a=await signInAs(oidA,[groupOps]);
  check([(await rights(a.viewer)).includes('terminal'),await onDevice(a.viewer,device,'manage')],[true,true],'Operator rights from the group');
  check((await syncRows()).length,1,'one sync row for the mapping change, none for the unchanged sign-in');
  check((await syncRows())[0],[owner.actor.label,`user=${userA} added=builtin-operator@global removed=`],'sync row of the mapping change');
 }

 // ---- Group dropped at the next sign-in: role removed in the same commit -------------------
 {
  const dropped=await signInAs(oidA,[groupOther]);
  check([await assignments(userA),await rights(dropped.viewer),await onDevice(dropped.viewer,device)],[[],[],false],'removed from the group: role and rights gone at sign-in');
  check((await syncRows()).at(-1),['System',`user=${userA} added= removed=builtin-operator@global`],'sync row of the sign-in');
  check(Number((await d.one(sql`SELECT count(*) AS n FROM entra_user_groups WHERE user_id=${userA}`)).n),1,'the groups of the last sign-in');
  await signInAs(oidA,[groupOps]);
 }

 // ---- Manual assignments stay; no duplicate ---------------------------------------------------
 {
  const manualId=crypto.randomUUID();
  await d.exec(sql`DELETE FROM role_assignments WHERE principal_id=${userA}`);
  await d.exec(sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(${manualId},'user',${userA},'builtin-operator','global','*',0,'manual')`);
  await d.exec(sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(${crypto.randomUUID()},'user',${userA},'builtin-reader','devicegroup',${deviceGroup},0,'manual')`);
  const before=(await syncRows()).length;
  await signInAs(oidA,[groupOps]);
  check((await assignments(userA)).map(row=>[row.role_id,row.source]),[['builtin-operator','manual'],['builtin-reader','manual']],'identical manual row: not duplicated');
  check((await syncRows()).length,before,'nothing to change, no row');
  await signInAs(oidA,[]);
  check((await assignments(userA)).map(row=>[row.role_id,row.source]),[['builtin-operator','manual'],['builtin-reader','manual']],'manual rows stay when the group goes');
  await d.exec(sql`DELETE FROM role_assignments WHERE principal_id=${userA}`);
 }

 // ---- A manual delete of an Entra row is refused ------------------------------------------------
 {
  await signInAs(oidA,[groupOps]);
  const row=await d.one(sql`SELECT id FROM role_assignments WHERE principal_id=${userA} AND source='entra'`);
  const login=await f.localLogin(owner);f.setViewer(await f.viewerOf(login));
  const refused=await f.answer(await m.rbacApi.POST(f.request('/api/rbac',{browser:login,payload:{action:'delete-assignment',id:row.id,managementToken:login.management}})));
  check([refused.status,refused.body.code,refused.body.messageKey],[409,'RBAC_ASSIGNMENT_FROM_ENTRA','apiError.rbac.assignmentFromEntra'],'manual delete of an Entra row: refused');
  check(Number((await d.one(sql`SELECT count(*) AS n FROM role_assignments WHERE id=${row.id}`)).n),1,'the row stays');
  const data=await f.answer(await m.rbacApi.GET(f.request('/api/rbac',{browser:login})));
  check([data.body.assignments.find(assignment=>assignment.id===row.id).source,data.body.users.find(user=>user.id===userA).identitySource],['entra','entra'],'the RBAC list carries source and identitySource');
 }

 // ---- Mapping changes recompute every Entra account at once -----------------------------------
 let adminsMapping;
 {
  const b=await signInAs(oidB,[groupOps,groupAdmins]),userB=await userOf(oidB);
  check((await assignments(userB)).map(row=>row.role_id),['builtin-operator'],'B gets Operator at sign-in');
  adminsMapping=(await addMapping(groupAdmins,'builtin-reader','devicegroup',deviceGroup)).mappings.find(mapping=>mapping.groupObjectId===groupAdmins);
  check([adminsMapping.scopeType,adminsMapping.scopeName],['devicegroup','Production'],'device group mapping listed');
  check((await assignments(userB)).map(row=>[row.role_id,row.scope_type]),[['builtin-operator','global'],['builtin-reader','devicegroup']],'add-mapping gives B the group role without a sign-in');
  check((await assignments(userA)).map(row=>row.role_id),['builtin-operator'],'A is not in the group');
  check([await onDevice(b.viewer,device,'view'),await onDevice(b.viewer,outside,'manage')],[true,true],'B: rights on the device');
  await removeMapping(opsMapping.id);
  check([(await assignments(userA)),(await assignments(userB)).map(row=>row.role_id)],[[],['builtin-reader']],'remove-mapping takes Operator from A and B at once');
  check([await onDevice(b.viewer,device,'view'),await onDevice(b.viewer,outside,'view'),await onDevice(b.viewer,device,'manage')],[true,false,false],'B keeps only the group role');
  const rows=(await syncRows()).slice(-2).map(([,target])=>target).sort();
  check(rows,[`user=${userA} added= removed=builtin-operator@global`,`user=${userB} added= removed=builtin-operator@global`].sort(),'one sync row per changed account');
  check((await f.auditRows('auth.entra.mapping.%')).map(row=>row.action),['auth.entra.mapping.add','auth.entra.mapping.add','auth.entra.mapping.remove'],'mapping rows');
  // Validation of add-mapping.
  const login=await f.localLogin(owner);
  const refused=async(payload,key,label)=>{const result=await post(login,{action:'add-mapping',groupObjectId:groupOps,roleId:'builtin-reader',scopeType:'global',managementToken:login.management,...payload});check(result.body.messageKey,key,label);};
  await refused({groupObjectId:'Ops'},'apiError.entra.groupIdFormat','group ID must be a GUID');
  await refused({roleId:'builtin-user-access-administrator',scopeType:'devicegroup',scopeId:deviceGroup},'apiError.entra.roleNotAllowed','a role with portal rights only for all devices');
  await refused({roleId:'missing-role'},'apiError.entra.roleNotAllowed','unknown role');
  await refused({scopeType:'devicegroup',scopeId:crypto.randomUUID()},'apiError.entra.scopeInvalid','unknown device group');
  await refused({groupObjectId:groupAdmins,roleId:'builtin-reader',scopeType:'devicegroup',scopeId:deviceGroup},'apiError.entra.mappingExists','an identical mapping');
  await refused({groupName:'x'.repeat(121)},'apiError.entra.groupNameFormat','group name at most 120 characters');
  check(await d.one(sql`SELECT count(*)::int AS n FROM mfa_management_proofs WHERE principal=${owner.actor.principal}`).then(row=>row.n>0),true,'refusals keep the proof');
  // The mapping protects its role and device group from a delete.
  await assert.rejects(m.rbac.deleteDeviceGroup(f.viewer,deviceGroup,true,await m.rbac.prepareManagementAuthorization(f.request('/',{browser:login}),f.viewer,login.management)),error=>error.code==='RBAC_ASSIGNMENT_FROM_ENTRA');checks++;
 }

 // ---- The last Owner is kept ---------------------------------------------------------------------
 {
  await addMapping(groupAdmins,'builtin-owner');
  const userB=await userOf(oidB);
  check((await assignments(userB)).some(row=>row.role_id==='builtin-owner'&&row.source==='entra'),true,'B is Owner through the group');
  // The local Owner loses the direct assignment: B's Entra row is the last one.
  await d.exec(sql`DELETE FROM role_assignments WHERE id=${owner.assignmentId}`);
  const before=(await syncRows()).length;
  await signInAs(oidB,[groupOps]);
  check((await assignments(userB)).some(row=>row.role_id==='builtin-owner'),true,'the last active direct global Owner assignment stays');
  check((await syncRows()).slice(before).map(([,target])=>target),[`user=${userB} added= removed=builtin-reader@devicegroup:${deviceGroup} keptLastOwner`],'the sync row says keptLastOwner');
  // With another Owner the row goes at the next sign-in.
  await d.exec(sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(${owner.assignmentId},'user',${owner.actor.id},'builtin-owner','global','*',0,'fixture')`);
  await signInAs(oidB,[groupOps]);
  check((await assignments(userB)).some(row=>row.role_id==='builtin-owner'),false,'with another Owner the Entra Owner row goes');
  check((await syncRows()).at(-1)[1],`user=${userB} added= removed=builtin-owner@global`,'removed without keptLastOwner');
 }
 console.log(`PASS entra role sync (${checks} checks): roles from groups at sign-in and after mapping changes, manual rows untouched, Entra rows protected, last Owner kept, sync rows only on change.`);
}finally{await d.close();}
