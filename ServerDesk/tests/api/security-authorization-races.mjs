// Execute actual source SQL on an isolated PostgreSQL test database after intentionally stale role reads.
import {serverText} from '../support/server-text.mjs';
import {HttpError as realHttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {sourceDatabase,sourceLoader,sourceActor,inTransaction,createTrigger,dropTrigger} from '../support/source-database.mjs';
import {sessionHeaders} from '../support/session-cookies.mjs';
import {sql} from '../../runtime/database.mjs';
const d=await sourceDatabase();
try{
 const time=Date.now(),device=crypto.randomUUID(),group=crypto.randomUUID();
 const HttpError=realHttpError;
 const adminFixture=await sourceActor(d,'admin@races.test',['*']),operatorFixture=await sourceActor(d,'operator@races.test',['view','terminal','files.read'],'devicegroup',group),recipientFixture=await sourceActor(d,'recipient@races.test',[]);
 const admin=adminFixture.actor,operator=operatorFixture.actor,recipient=recipientFixture.actor;
 for(const actor of [admin,operator,recipient])actor.userId=actor.id;
 // The database contains current local identities; legacy seed migrations are
 // already complete. MFA and password-session checks use their actual sources.
 let hook=async()=>{},afterRecipient=async()=>{},afterGlobal=async()=>{},delegator=admin;
 const token=()=>crypto.randomBytes(32).toString('hex'),hash=value=>crypto.createHash('sha256').update(value).digest('hex');
 const server={db:()=>d,config:key=>key==='SESSION_SECRET'?'s'.repeat(64):'',now:()=>Date.now(),random:token,hash:async value=>hash(value),guid:x=>typeof x==='string'&&/^[a-f0-9-]{36}$/.test(x),HttpError,body:r=>r.json(),sameOrigin:()=>{},requireViewer:async()=>delegator,log:async(actor,action,target)=>d.exec(sql`INSERT INTO audit(at,actor,action,target) VALUES(${Date.now()},${actor},${action},${target})`),failure:e=>Response.json({error:e.message,code:e.code,messageKey:e.messageKey},{status:e.status??503})};
 const load=sourceLoader();
 const dependencies={'../context':server,'./context':server,'../../context':server,'@/lib/server/context':server},access=load('lib/server/identity/access.ts',dependencies),rbac=load('lib/server/identity/rbac.ts',dependencies);
 // hook runs after the scope read; afterRecipient and afterGlobal run after the
 // recipient and self-grant pre-checks, so a race there reaches the commit.
 const wrappedAccess={...access,requireGroup:async(...args)=>{const result=await access.requireGroup(...args);await hook();return result;},resolvePrincipal:async(...args)=>{const result=await access.resolvePrincipal(...args);await afterRecipient();return result;},hasGlobalPermission:async(...args)=>{const result=await access.hasGlobalPermission(...args);await afterGlobal();return result;}};
 const api=load('app/api/access/route.ts',{...dependencies,'@/lib/server/identity/access':wrappedAccess,'@/lib/server/identity/rbac':rbac});
 await d.exec(sql`INSERT INTO servers(id,name,token_hash,created_at,last_seen,management,snapshot) VALUES (${device},${'Race'},${'a'.repeat(64)},${time},${time},1,${JSON.stringify({mode:'Management'})})`);
 await d.exec(sql`INSERT INTO device_groups(id,name,description,created_at) VALUES (${group},${'Race'},${'Fixture'},${time})`);await d.exec(sql`INSERT INTO device_group_members(server_id,group_id) VALUES (${device},${group})`);
 // Sessions, MFA and the single-use management proof belong to the delegator
 // that the stubbed requireViewer returns for this request.
 async function freshRequest(actor=admin,{groupId=group,to=recipient,permissions=['view','terminal'],proofTtl=300_000}={}){
  const at=Date.now(),primary=token(),mfa=token(),management=token(),mfaHash=hash(mfa);delegator=actor;
  await inTransaction(d,[
   sql`UPDATE local_users SET password_hash=${'fixture-password'},must_reset=0 WHERE id=${actor.id}`,
   sql`INSERT INTO mfa_accounts(principal,secret_enc,recovery_hashes,last_counter,created_at) VALUES(${actor.principal},'fixture','[]',0,${at}) ON CONFLICT(principal) DO NOTHING`,
   sql`INSERT INTO mfa_sessions(token_hash,principal,created_at,last_activity,idle_expires_at,expires_at) VALUES(${mfaHash},${actor.principal},${at},${at},${at+3_600_000},${at+86_400_000})`,
   sql`INSERT INTO local_auth_sessions(token_hash,user_id,auth_version,created_at,expires_at,pending_until,mfa_hash) SELECT ${hash(primary)},id,auth_version,${at},${at+86_400_000},${at+600_000},${mfaHash} FROM local_users WHERE id=${actor.id}`,
   sql`INSERT INTO mfa_management_proofs(token_hash,principal,session_hash,expires_at) VALUES(${hash(management)},${actor.principal},${mfaHash},${at+proofTtl})`
  ]);
  const build=()=>new Request('https://races.test/api/access',{method:'POST',headers:sessionHeaders({primary,session:mfa},{'Content-Type':'application/json'}),body:JSON.stringify({action:'set-grant',groupId,principal:to.principal,role:'operator',permissions,managementToken:management})});
  return {request:build(),build,proofHash:hash(management)};
 }
 // The portal seeds the built-in roles on its first request; seed them before rows are counted.
 await rbac.ensureBuiltinRoles();
 const roleCount=(await d.one(sql`SELECT count(*) AS n FROM rbac_roles`)).n,assignmentCount=(await d.one(sql`SELECT count(*) AS n FROM role_assignments`)).n;
 let scopeReads=0;hook=async()=>{scopeReads++;await d.exec(sql`UPDATE rbac_roles SET permissions=${'["view"]'} WHERE id=${adminFixture.roleId}`);};
 const stale=await freshRequest();let response=await api.POST(stale.request);
 assert.equal(scopeReads,1,'request first captures actual group-management scope before the race');assert.equal(response.status,403,'captured global administrator cannot commit a grant after demotion');assert.equal((await response.json()).messageKey,'apiError.group.grantRevoked','denial comes from the live committing guard, not the session boundary');
 const compatRole='compat-grant:'+recipient.id+':'+group;
 assert.equal(await d.one(sql`SELECT id FROM rbac_roles WHERE id=${compatRole}`),null,'stale global admin cannot partially create a privileged role');assert.equal(await d.one(sql`SELECT id FROM role_assignments WHERE principal_id=${recipient.id} AND scope_type='devicegroup' AND scope_id=${group}`),null,'stale global admin cannot create a privileged assignment');assert.equal((await d.one(sql`SELECT count(*) AS n FROM rbac_roles`)).n,roleCount);assert.equal((await d.one(sql`SELECT count(*) AS n FROM role_assignments`)).n,assignmentCount);assert.equal((await d.one(sql`SELECT count(*) AS n FROM audit`)).n,0,'denied grant adds no misleading audit');assert.equal(await d.one(sql`SELECT token_hash FROM mfa_management_proofs WHERE token_hash=${stale.proofHash}`),null,'attempt consumes the real single-use management proof');
 // A fresh authorized control demonstrates that the same API, real password/
 // MFA checks and committing SQL work when the current permission is present.
 hook=async()=>{};await d.exec(sql`UPDATE rbac_roles SET permissions=${'["*"]'} WHERE id=${adminFixture.roleId}`);response=await api.POST((await freshRequest()).request);assert.equal(response.status,200,'fresh current administrator can still create a scoped grant');assert.deepEqual(JSON.parse((await d.one(sql`SELECT permissions FROM rbac_roles WHERE id=${compatRole}`)).permissions),['view','terminal']);assert.equal((await d.one(sql`SELECT count(*) AS n FROM role_assignments WHERE principal_id=${recipient.id} AND role_id=${compatRole} AND scope_type='devicegroup' AND scope_id=${group}`)).n,1);
 // Delegated-right recheck: the committing batch checks every
 // delegated right, aliases included, against the delegator's live state.
 const count=async statement=>Number((await d.one(statement)).n);
 const grantRole=(to,groupId)=>d.one(sql`SELECT permissions FROM rbac_roles WHERE id=${'compat-grant:'+to.id+':'+groupId}`);
 const grantAssignments=async(to,groupId)=>Number((await d.one(sql`SELECT count(*) AS n FROM role_assignments WHERE principal_type='user' AND principal_id=${to.id} AND scope_type='devicegroup' AND scope_id=${groupId}`)).n);
 const grantAudits=()=>count(sql`SELECT count(*) AS n FROM audit WHERE action='Gerätegruppenrechte geändert'`);
 const proofPresent=async proofHash=>!!await d.one(sql`SELECT token_hash FROM mfa_management_proofs WHERE token_hash=${proofHash}`);
 const snapshot=async()=>({roles:await count(sql`SELECT count(*) AS n FROM rbac_roles`),assignments:await count(sql`SELECT count(*) AS n FROM role_assignments`),audits:await grantAudits()});
 const setRole=(roleId,permissions)=>d.exec(sql`UPDATE rbac_roles SET permissions=${JSON.stringify(permissions)} WHERE id=${roleId}`);
 let recipients=0;
 const newRecipient=async()=>{const {actor}=await sourceActor(d,'recipient'+(++recipients)+'@races.test',[]);actor.userId=actor.id;return actor;};
 const newDelegator=async(label,permissions,scopeType,scopeId)=>{const fixture=await sourceActor(d,label,permissions,scopeType,scopeId);fixture.actor.userId=fixture.actor.id;return fixture;};
 async function expectDenied(actor,to,groupId,permissions,message){
  const before=await snapshot(),attempt=await freshRequest(actor,{groupId,to,permissions}),result=await api.POST(attempt.request),json=await result.json();
  assert.equal(result.status,403,message+': denied');assert.equal(json.messageKey,'apiError.group.grantRevoked',message+': live grant guard denies');
  assert.equal(await grantRole(to,groupId),null,message+': no compat role');assert.equal(await grantAssignments(to,groupId),0,message+': no assignment');
  assert.deepEqual(await snapshot(),before,message+': role, assignment and grant-audit counts unchanged');assert.equal(await proofPresent(attempt.proofHash),false,message+': attempt consumes the proof');
 }
 async function expectGranted(actor,to,groupId,permissions,message){
  const audits=await grantAudits(),result=await api.POST((await freshRequest(actor,{groupId,to,permissions})).request),roleId='compat-grant:'+to.id+':'+groupId,target=to.id+' / '+groupId;
  assert.equal(result.status,200,message+': granted');assert.deepEqual(JSON.parse((await grantRole(to,groupId)).permissions),permissions,message+': compat role holds the delegated rights');
  assert.equal(Number((await d.one(sql`SELECT count(*) AS n FROM role_assignments WHERE principal_type='user' AND principal_id=${to.id} AND role_id=${roleId} AND scope_type='devicegroup' AND scope_id=${groupId}`)).n),1,message+': one assignment with the compat role');
  assert.equal(await grantAudits(),audits+1,message+': exactly one grant audit row');
  const rows=(await d.query(sql`SELECT actor,target,scope FROM audit WHERE action='Gerätegruppenrechte geändert' AND target=${target}`));
  assert.deepEqual(rows.map(row=>({...row})),[{actor:actor.label,target,scope:'portal'}],message+': audit row from the committing batch');
 }
 const recipientTerminal=async to=>{const guard=access.devicePermissionGuard(sql`s.id`,sql`u.auth_principal`,'terminal');return (await d.one(sql`SELECT (${guard}) AS permitted FROM servers s JOIN local_users u ON u.id=${to.id} WHERE s.id=${device}`)).permitted?1:0;};
 // A global administrator keeps groups.manage but loses terminal mid-flight.
 {
  const to=await newRecipient();hook=()=>setRole(adminFixture.roleId,['view','groups.manage']);
  await expectDenied(admin,to,group,['view','terminal'],'stale terminal right');assert.equal(await recipientTerminal(to),0,'recipient gains no terminal right on the device');
  hook=async()=>{};await setRole(adminFixture.roleId,['*']);
 }
 // The runbooks alias right is rechecked as runbooks, not as runbooks.read.
 {
  const fixture=await newDelegator('runbooks@races.test',['view','groups.manage','runbooks']);
  hook=()=>setRole(fixture.roleId,['view','groups.manage','runbooks.read']);await expectDenied(fixture.actor,await newRecipient(),group,['view','runbooks'],'stale runbooks alias');
  hook=async()=>{};await setRole(fixture.roleId,['view','groups.manage','runbooks']);await expectGranted(fixture.actor,await newRecipient(),group,['view','runbooks'],'current runbooks alias');
 }
 // Rights inherited from a parent group are rechecked on the child.
 {
  const parent=crypto.randomUUID(),child=crypto.randomUUID();
  await d.exec(sql`INSERT INTO device_groups(id,name,description,created_at) VALUES (${parent},${'Race parent'},${'Fixture'},${time})`);
  await d.exec(sql`INSERT INTO device_groups(id,name,description,created_at,parent_id) VALUES (${child},${'Race child'},${'Fixture'},${time},${parent})`);
  const fixture=await newDelegator('inherited@races.test',['view','groups.manage','terminal'],'devicegroup',parent);
  await expectGranted(fixture.actor,await newRecipient(),child,['view','terminal'],'inherited rights');
  hook=()=>setRole(fixture.roleId,['view','groups.manage']);await expectDenied(fixture.actor,await newRecipient(),child,['view','terminal'],'stale inherited terminal right');hook=async()=>{};
 }
 // Rights that come only from an enabled user-group membership.
 {
  const fixture=await newDelegator('member@races.test',[]),userGroup=crypto.randomUUID(),roleId=crypto.randomUUID();
  await inTransaction(d,[
   sql`INSERT INTO user_groups(id,name,description,enabled,created_at) VALUES(${userGroup},${'Race members'},${'Fixture'},1,${time})`,
   sql`INSERT INTO user_group_members(group_id,user_id) VALUES(${userGroup},${fixture.actor.id})`,
   sql`INSERT INTO rbac_roles(id,name,description,permissions,builtin,created_at) VALUES(${roleId},${'Race member role'},'Source race fixture',${JSON.stringify(['view','groups.manage','terminal'])},0,${time})`,
   sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(${crypto.randomUUID()},'group',${userGroup},${roleId},'devicegroup',${group},${time},${admin.principal})`
  ]);
  await expectGranted(fixture.actor,await newRecipient(),group,['view','terminal'],'user-group rights');
  hook=()=>setRole(roleId,['view','groups.manage']);await expectDenied(fixture.actor,await newRecipient(),group,['view','terminal'],'stale user-group terminal right');hook=async()=>{};
 }
 // The audit row is part of the grant batch; a failing audit insert
 // rolls back the grant and keeps the management proof.
 {
  await expectGranted(admin,await newRecipient(),group,['view','terminal'],'audited grant');
  const failing=await newRecipient(),before=await snapshot();
  await createTrigger(d,'audit_unavailable','audit','BEFORE INSERT',{message:'audit unavailable'});
  try{
   const attempt=await freshRequest(admin,{to:failing}),result=await api.POST(attempt.request);
   assert.notEqual(result.status,200,'grant fails when its audit row cannot be written');assert.equal(await grantRole(failing,group),null,'no compat role without audit');assert.equal(await grantAssignments(failing,group),0,'no assignment without audit');
   assert.deepEqual(await snapshot(),before,'rolled-back batch leaves counts unchanged');assert.equal(await proofPresent(attempt.proofHash),true,'rolled-back batch keeps the management proof');
  }finally{await dropTrigger(d,'audit_unavailable');}
 }
 // A reused or expired management proof writes nothing.
 {
  const to=await newRecipient(),attempt=await freshRequest(admin,{to});assert.equal((await api.POST(attempt.request)).status,200,'first use of the proof grants');
  const before=await snapshot(),stored=(await grantRole(to,group)).permissions,reused=await api.POST(attempt.build());
  assert.equal(reused.status,403,'reused proof is denied');assert.equal((await reused.json()).code,'MFA_STEP_UP_REQUIRED');assert.deepEqual(await snapshot(),before,'reused proof writes nothing');assert.equal((await grantRole(to,group)).permissions,stored);assert.equal(await grantAssignments(to,group),1);
  const late=await newRecipient(),expired=await api.POST((await freshRequest(admin,{to:late,proofTtl:-1000})).request),afterLate=await snapshot();
  assert.equal(expired.status,403,'expired proof is denied');assert.equal((await expired.json()).code,'MFA_STEP_UP_REQUIRED');assert.equal(await grantRole(late,group),null,'expired proof creates no role');assert.equal(await grantAssignments(late,group),0,'expired proof creates no assignment');assert.equal(afterLate.audits,before.audits,'expired proof writes no audit');
 }
 const disable=to=>d.exec(sql`UPDATE local_users SET status='disabled',auth_version=auth_version+1 WHERE id=${to.id}`);
 // The committing batch requires the recipient to be active.
 {
  await expectGranted(admin,await newRecipient(),group,['view','terminal'],'active recipient control');
  const to=await newRecipient(),before=await snapshot();afterRecipient=()=>disable(to);
  try{
   const attempt=await freshRequest(admin,{to}),result=await api.POST(attempt.request);
   assert.equal(result.status,409,'recipient disabled mid-flight: conflict');assert.equal((await result.json()).messageKey,'apiError.group.userDisabled','recipient disabled mid-flight: message names the disabled account');
   assert.equal(await grantRole(to,group),null,'recipient disabled mid-flight: no compat role');assert.equal(await grantAssignments(to,group),0,'recipient disabled mid-flight: no assignment');
   assert.deepEqual(await snapshot(),before,'recipient disabled mid-flight: role, assignment and grant-audit counts unchanged');assert.equal(await proofPresent(attempt.proofHash),false,'recipient disabled mid-flight: attempt consumes the proof');
  }finally{afterRecipient=async()=>{};}
 }
 // A self-grant needs global groups.manage in the committing batch.
 {
  const fixture=await newDelegator('self-race@races.test',['*']),roleId=crypto.randomUUID(),assignmentId=crypto.randomUUID();
  await inTransaction(d,[
   sql`INSERT INTO rbac_roles(id,name,description,permissions,builtin,created_at) VALUES(${roleId},${'Race self role'},'Source race fixture',${JSON.stringify(['view','groups.manage','terminal'])},0,${time})`,
   sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(${assignmentId},'user',${fixture.actor.id},${roleId},'devicegroup',${group},${time},${admin.principal})`
  ]);
  const before=await snapshot();afterGlobal=()=>setRole(fixture.roleId,['view']);
  try{
   const attempt=await freshRequest(fixture.actor,{to:fixture.actor}),result=await api.POST(attempt.request);
   assert.equal(result.status,403,'self-grant after losing global groups.manage: denied');assert.equal((await result.json()).messageKey,'apiError.group.grantRevoked','self-grant after losing global groups.manage: live grant guard denies');
   assert.equal(await grantRole(fixture.actor,group),null,'self-grant after losing global groups.manage: no compat role');
   assert.ok(await d.one(sql`SELECT id FROM role_assignments WHERE id=${assignmentId}`),'self-grant after losing global groups.manage: existing group assignment is not deleted');
   assert.deepEqual(await snapshot(),before,'self-grant after losing global groups.manage: role, assignment and grant-audit counts unchanged');assert.equal(await proofPresent(attempt.proofHash),false,'self-grant after losing global groups.manage: attempt consumes the proof');
  }finally{afterGlobal=async()=>{};}
 }
 // A self-grant with current global groups.manage still commits.
 {
  const fixture=await newDelegator('self-control@races.test',['*']);
  await expectGranted(fixture.actor,fixture.actor,group,['view','terminal'],'self-grant control');
 }
 // The request-time pre-checks keep their messages and write nothing.
 {
  const fixture=await newDelegator('self-local@races.test',['view','groups.manage','terminal'],'devicegroup',group);
  let before=await snapshot(),result=await api.POST((await freshRequest(fixture.actor,{to:fixture.actor})).request);
  assert.equal(result.status,400,'self-grant without global groups.manage: rejected');assert.equal((await result.json()).error,serverText('apiError.group.ownManagementRights'));
  assert.equal(await grantRole(fixture.actor,group),null,'self-grant without global groups.manage: no compat role');assert.deepEqual(await snapshot(),before,'self-grant without global groups.manage: nothing written');
  const disabled=await newRecipient();await disable(disabled);before=await snapshot();result=await api.POST((await freshRequest(admin,{to:disabled})).request);
  assert.equal(result.status,400,'disabled recipient: rejected');assert.equal((await result.json()).error,serverText('apiError.group.selectActiveUser'));
  assert.equal(await grantRole(disabled,group),null,'disabled recipient: no compat role');assert.deepEqual(await snapshot(),before,'disabled recipient: nothing written');
 }
 delegator=admin;
 const live=access.devicePermissionGuard(sql`s.id`,sql`u.auth_principal`,'terminal');
 const permitted=async()=>(await d.one(sql`SELECT (${live}) AS permitted FROM servers s JOIN local_users u ON u.id=${operator.id} WHERE s.id=${device}`)).permitted?1:0;
 assert.equal(await permitted(),1);await d.exec(sql`UPDATE rbac_roles SET permissions=${'["view","files.read"]'} WHERE id=${operatorFixture.roleId}`);assert.equal(await permitted(),0,'captured SQL checks current group rights');
 await d.exec(sql`UPDATE rbac_roles SET permissions=${'["view","terminal"]'} WHERE id=${operatorFixture.roleId}`);assert.equal(await permitted(),1,'restoring current group rights restores the current SQL result');await d.exec(sql`UPDATE local_users SET status='disabled',auth_version=auth_version+1 WHERE id=${operator.id}`);assert.equal(await permitted(),0,'current account revocation denies an otherwise valid device-group assignment');
 console.log('PASS authorization races: real password/MFA-bound API rejects stale global administrator with no partial role/assignment/audit; the committing batch rechecks every delegated right live, including runbooks aliases, inherited parent-group rights and user-group rights; grant and audit commit atomically; reused/expired proofs write nothing; the commit also requires an active recipient and, for a self-grant, live global groups.manage of the delegator; current API grants work, and statement-level scope observes live permission and account withdrawal.');
}finally{d.close();}
