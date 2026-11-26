// The customer boundary in the real guards, routes and libraries,
// against an isolated PostgreSQL test database. Customer A is the first customer.
// While it is the only one there is no boundary: an account with a device role
// sees and changes every device. Customers B and C, with their groups and
// devices, are created by SQL later: from then on an account without a customer
// assignment gets 404 for every device, until it is assigned; assigned accounts
// and the global Owner keep access.
import {serverText} from '../support/server-text.mjs';
// The body keeps the codes a client branches on; the generic codes per status are checked in tests/repo/error-codes.mjs.
import {HttpError as realHttpError,genericCode} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFileSync} from 'node:fs';
import {sourceDatabase,sourceLoader,sourceActor,insertRow} from '../support/source-database.mjs';

import {sql} from '../../runtime/database.mjs';

import {hookDatabase} from '../support/hooked-database.mjs';
const d=await sourceDatabase();
let checks=0;
const check=(value,expected,label)=>{assert.deepEqual(value,expected,label);checks++;};
try{
 const time=Date.now(),uuid=()=>crypto.randomUUID(),hash=value=>crypto.createHash('sha256').update(value).digest('hex');
 const customerA='00000000-0000-4000-8000-000000000100',customerB=uuid(),customerC=uuid();
 const HttpError=realHttpError;
 // The batch hook runs once, right before the next batch: the committing write.
 let viewer=null,beforeBatch=null,afterGroup=async()=>{},afterDevice=async()=>{};
 const facade=hookDatabase(d,{transaction:async()=>{if(beforeBatch){const hook=beforeBatch;beforeBatch=null;await hook();}}});
 const server={db:()=>facade,now:()=>Date.now(),config:()=>'',random:()=>crypto.randomBytes(32).toString('hex'),hash:async value=>hash(value),guid:x=>typeof x==='string'&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(x),HttpError,
  body:request=>request.json(),sameOrigin:()=>{},requireViewer:async()=>viewer,
  log:async(actor,action,target,serverId)=>{await d.exec(sql`INSERT INTO audit(at,actor,action,target,server_id,scope) VALUES(${Date.now()},${actor},${action},${target},${serverId??null},${serverId?'device':'portal'})`);},
  failure:error=>Response.json({error:error.message,code:genericCode(error.code)?undefined:error.code},{status:error.status??503})};
 // Routine writes (lib/step-up.ts) commit behind the live-session fence.
 const mfa={requireLiveSessions:async()=>{},mfaSessionFence:async(request,actor)=>localAuth.primaryGuard(request,actor),requireMfa:async()=>{},isMfaEnabled:async()=>true,readMfaManagementProof:async(_request,actor,token)=>({tokenHash:token,key:actor.principal,sessionHash:hash(actor.id+'mfa'),guard:sql`TRUE`})};
 const localAuth={primaryGuard:async(_request,actor)=>load('lib/server/identity/access.ts').viewerWriteGuard(actor)};
 const v3={maintenanceBusy:async()=>false,modern:device=>JSON.parse(device.snapshot||'{}'),windowsPath:path=>String(path),CHUNK_SIZE:262144,MAX_TRANSFER:1<<30,securityFile:()=>false,bucket:()=>({})};
 const management={operations:{refresh:{readOnly:true,label:'Aktualisieren',schema:{safeParse:value=>({success:true,data:value})}}},safeTarget:()=>''};
 const agentCrypto={sealAgentSecrets:async()=>({})};
 const imports={'../context':server,'./context':server,'../../context':server,'@/lib/server/context':server,'./local-auth':localAuth,'./mfa':mfa,'../identity/mfa':mfa,'@/lib/server/identity/mfa':mfa,'../agent/agent-protocol':v3,'@/lib/server/agent/agent-protocol':v3,'../../management':management,'./management':management,'@/lib/management':management,'../agent/agent-crypto':agentCrypto,'@/lib/server/agent/agent-crypto':agentCrypto,
  '@/agent/package-v3':{installerV3:()=>'',registrationV3:()=>''},
  '@/lib/server/agent/agent-dispatch':{dispatchSigner:()=>({publicKey:'fixture-job-key'}),JOB_SIGNING_KEY_MISSING:'missing'},
  '@/lib/diagnostics':{diagnosticDefinitions:{},diagnosticSecurityAccess:()=>false,isDiagnosticKind:()=>false},'@/lib/file-operations':{fileSecurityAccess:()=>false},
  '@/lib/server/devices/device-lifecycle':{removeDevice:async()=>({}),removeDevices:async()=>({}),sweepRemovedTransfers:async()=>{}},'@/lib/server/devices/rdp':{sweepRdp:async()=>{}}};
 const load=sourceLoader();
 const access=load('lib/server/identity/access.ts',imports);
 // Routes see requireGroup/requireDevice with a hook after the pre-check, so a
 // revocation can happen between the pre-check and the committing write.
 const wrapped={...access,requireGroup:async(...args)=>{const result=await access.requireGroup(...args);await afterGroup();return result;},requireDevice:async(...args)=>{const result=await access.requireDevice(...args);await afterDevice();return result;}};
 const routeImports={...imports,'@/lib/server/identity/access':wrapped};
 const accessApi=load('app/api/access/route.ts',routeImports),consoleApi=load('app/api/console/route.ts',routeImports),transfersApi=load('app/api/transfers/route.ts',routeImports);
 const rbac=load('lib/server/identity/rbac.ts',imports),rbacApi=load('app/api/rbac/route.ts',routeImports),catalog=load('lib/server/devices/device-group-catalog.ts',imports),auditScope=load('lib/server/audit-scope.ts',imports),transfers=load('lib/server/devices/transfers.ts',imports),runbooks=load('lib/server/automation/runbooks.ts',imports),customers=load('lib/server/identity/customers.ts',imports);

 // ---- Fixture ----------------------------------------------------------------
 const insert=(table,row)=>insertRow(d,table,row);
 const gA=uuid(),gA2=uuid(),gB=uuid(),gB1=uuid(),gC=uuid();
 for(const [id,name,customer,parent] of [[gA,'Gruppe A',customerA,null],[gA2,'Gruppe A leer',customerA,null]])await insert('device_groups',{id,name,description:'',created_at:time,parent_id:parent,customer_id:customer});
 const snapshot=JSON.stringify({protocolVersion:3,agentCapabilities:['refresh'],mode:'Management'});
 const dA=uuid(),dB=uuid(),dB2=uuid();
 const addServer=(id,name,customer)=>insert('servers',{id,name,token_hash:'fixture-'+id,created_at:time,last_seen:time,management:1,snapshot,customer_id:customer});
 await addServer(dA,'Server A',customerA);
 await insert('device_group_members',{server_id:dA,group_id:gA});
 const ownerActor=await sourceActor(d,'owner@boundary.test',['*']),owner=ownerActor.actor;
 const techActor=await sourceActor(d,'tech@boundary.test',[...access.allPermissions]),tech=techActor.actor;
 const uaaActor=await sourceActor(d,'uaa@boundary.test',['portal.roleAssignments.manage']),uaa=uaaActor.actor;
 const memberActor=await sourceActor(d,'member@boundary.test',['view']),member=memberActor.actor;
 for(const actor of [owner,tech,uaa,member]){actor.userId=actor.id;await insert('mfa_sessions',{token_hash:hash(actor.id+'mfa'),principal:actor.principal,created_at:time,last_activity:time,idle_expires_at:time+3_600_000,expires_at:time+86_400_000});}
 const team=uuid();await insert('user_groups',{id:team,name:'Team B',description:'',enabled:1,created_at:time});await insert('user_group_members',{group_id:team,user_id:member.id});
 const job=(id,server)=>insert('jobs',{id,server_id:server,action:'refresh',target:'',parameters:'{}',state:'pending',created_at:time,actor:tech.id,actor_email:tech.label,actor_principal:tech.principal});
 const jobA1=uuid(),jobA2=uuid(),jobB=uuid();await job(jobA1,dA);await job(jobA2,dA);
 for(const server of [dA])await insert('audit',{at:time,actor:tech.label,action:'Fixture',target:'Audit '+server,server_id:server,scope:'device'});
 const transferA=uuid(),transferB=uuid();
 for(const [id,server] of [[transferA,dA],[transferB,dB]])await insert('transfers',{id,server_id:server,principal:tech.principal,direction:'download',path:'C:\\Daten\\bericht.txt',state:'pending',overwrite:0,created_at:time,updated_at:time,expires_at:time+3_600_000});
 const book=uuid(),version=uuid(),run=uuid();
 await insert('runbooks',{id:book,name:'Runbook',description:'',created_at:time,created_by:owner.principal});
 await insert('runbook_versions',{id:version,runbook_id:book,version:1,definition:'{"steps":[],"parameters":[]}',created_at:time,created_by:owner.principal});
 await insert('runbook_runs',{id:run,version_id:version,actor:tech.principal,state:'running',parameters:'{}',concurrency:1,failure_stop:1,created_at:time,expires_at:time+3_600_000});
 for(const server of [dA,dB])await insert('runbook_run_devices',{run_id:run,server_id:server,state:'running'});
 const assign=(customer,type,id)=>insert('customer_assignments',{customer_id:customer,principal_type:type,principal_id:id,created_at:time,created_by:owner.principal});
 const unassign=(customer,type,id)=>d.exec(sql`DELETE FROM customer_assignments WHERE customer_id=${customer} AND principal_type=${type} AND principal_id=${id}`);
 const proof=async actor=>{const token=uuid();await insert('mfa_management_proofs',{token_hash:token,principal:actor.principal,session_hash:hash(actor.id+'mfa'),expires_at:Date.now()+300_000});return token;};
 const post=async(api,actor,payload)=>{viewer=actor;return api.POST(new Request('https://boundary.test/api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...payload,managementToken:await proof(actor)})}));};
 const get=async(api,actor,query='')=>{viewer=actor;return api.GET(new Request('https://boundary.test/api'+query));};
 const answer=async response=>({status:response.status,body:await response.json()});
 const rejects=async(promise,status,message,label)=>{await assert.rejects(promise,error=>{assert.equal(error.status,status,label+': '+error.message);if(message)assert.equal(error.message,message,label);return true;},label);checks++;};
 const count=async statement=>Number((await d.one(statement)).n);
 const sorted=values=>[...values].sort();
 const guardHolds=async guard=>(await d.one(sql`SELECT (${guard}) AS allowed`)).allowed?1:0;
 const value=text=>sql`${text}::text`;
 const deviceAllowed=(actor,server,permission='view')=>guardHolds(access.devicePermissionGuard(value(server),value(actor.principal),permission));
 const groupAllowed=(actor,group,permission='view')=>guardHolds(access.groupPermissionGuard(value(group),value(actor.principal),permission));
 const anyDeviceAllowed=(actor,permission)=>guardHolds(access.anyDevicePermissionGuard(value(actor.principal),permission));
 // The second customer: B and C with their groups, devices, the job and audit row on dB, and
 // scoped with its role on dB. The assignment ids of the global roles and of scoped's role on dB.
 let scopedActor,scoped,scopedOnB;
 const separate=async()=>{
  await insert('customers',{id:customerB,name:'Kunde B',created_at:time,updated_at:time});
  await insert('customers',{id:customerC,name:'Kunde C',created_at:time,updated_at:time});
  for(const [id,name,customer,parent] of [[gB,'Gruppe B',customerB,null],[gB1,'Gruppe B1',customerB,gB],[gC,'Gruppe C',customerC,null]])await insert('device_groups',{id,name,description:'',created_at:time,parent_id:parent,customer_id:customer});
  await addServer(dB,'Server B',customerB);await addServer(dB2,'Server B2',customerB);
  await insert('device_group_members',{server_id:dB,group_id:gB1});
  await job(jobB,dB);await insert('audit',{at:time,actor:tech.label,action:'Fixture',target:'Audit '+dB,server_id:dB,scope:'device'});
  scopedActor=await sourceActor(d,'scoped@boundary.test',['view','terminal'],'device',dB);scoped=scopedActor.actor;scopedOnB=scopedActor.assignmentId;
  scoped.userId=scoped.id;await insert('mfa_sessions',{token_hash:hash(scoped.id+'mfa'),principal:scoped.principal,created_at:time,last_activity:time,idle_expires_at:time+3_600_000,expires_at:time+86_400_000});
 };
 // Effective flag and reason of one inherited entry.
 const flag=(data,id)=>{const entry=data.inherited.find(row=>row.assignmentId===id);assert.ok(entry,'missing inherited entry '+id);return 'reason' in entry?[entry.effective,entry.reason]:[entry.effective];};
 const visibleAssignmentIds=async actor=>{const visible=load('lib/server/catalog-ownership.ts',imports).catalogVisibleGuard(sql`r.customer_id`,value(actor.principal));return (await d.query(sql`SELECT a.id FROM role_assignments a WHERE EXISTS (SELECT 1 FROM rbac_roles r WHERE r.id=a.role_id AND ${visible})`)).map(row=>row.id);};
 const createdAt=async ids=>Promise.all(ids.map(id=>d.one(sql`SELECT created_at FROM role_assignments WHERE id=${id}`).then(row=>row===null?null:row.created_at)));
 // delete-assignment: throwaway assignments of a fresh user that no check acts as,
 // so invalidateRbacUsers ends no session that a later check needs.
 const throwawayUser=(await sourceActor(d,'throwaway@boundary.test',[])).actor,throwawayRole=uuid();
 await insert('rbac_roles',{id:throwawayRole,name:'Wegwerf',description:'',permissions:'["view"]',builtin:0,created_at:time});
 const throwaway=async(scopeType,scopeId)=>{const id=uuid();await insert('role_assignments',{id,principal_type:'user',principal_id:throwawayUser.id,role_id:throwawayRole,scope_type:scopeType,scope_id:scopeId,created_at:time,created_by:owner.principal});return id;};
 const deleteAssignment=async(actor,id,token)=>rbac.manageRbac(actor,{action:'delete-assignment',id},await rbac.prepareManagementAuthorization(new Request('https://boundary.test/api/rbac'),actor,token??await proof(actor)));
 const failureOf=async promise=>{try{await promise;}catch(error){return [error.status,error.message,genericCode(error.code)?undefined:error.code];}assert.fail('expected a rejection');};
 const assignmentExists=id=>count(sql`SELECT count(*) AS n FROM role_assignments WHERE id=${id}`);
 // remove-member and the customer boundary: manageRbac with a given proof token, fresh members
 // with their own MFA session, and the counters of a refused or allowed removal.
 const groupsBoundaryMessage=serverText('apiError.rbac.customerGroupBoundary');
 const manageWith=async(actor,payload,token)=>{viewer=actor;return rbac.manageRbac(actor,payload,await rbac.prepareManagementAuthorization(new Request('https://boundary.test/api/rbac'),actor,token));};
 const mfaSession=actor=>insert('mfa_sessions',{token_hash:hash(actor.id+'mfa'),principal:actor.principal,created_at:time,last_activity:time,idle_expires_at:time+3_600_000,expires_at:time+86_400_000});
 const userGroup=async(enabled,...customers)=>{const id=uuid();await insert('user_groups',{id,name:'Gruppe '+id,description:'',enabled,created_at:time});for(const customer of customers)await assign(customer,'group',id);return id;};
 const joined=async group=>{const user=(await sourceActor(d,'member-'+uuid().slice(0,8)+'@boundary.test',[])).actor;await mfaSession(user);await insert('user_group_members',{group_id:group,user_id:user.id});return user;};
 const memberOf=(group,user)=>count(sql`SELECT count(*) AS n FROM user_group_members WHERE group_id=${group} AND user_id=${user.id}`);
 const removedAudits=()=>count(sql`SELECT count(*) AS n FROM audit WHERE action='Benutzergruppenmitglied entfernt'`);
 const proofLeft=token=>count(sql`SELECT count(*) AS n FROM mfa_management_proofs WHERE token_hash=${token}`);
 const sessionLeft=user=>count(sql`SELECT count(*) AS n FROM mfa_sessions WHERE principal=${user.principal}`);
 // Refused: 403 with the boundary message, the membership and the member's session stay, no audit row.
 // A pre-check refusal keeps the proof; a commit refused in the batch (race hook) consumes it like every
 // refused commitManagementChange.
 const removalRefused=async(actor,group,user,label,hook=null)=>{const token=await proof(actor),before=await removedAudits();beforeBatch=hook;
  await rejects(manageWith(actor,{action:'remove-member',groupId:group,userId:user.id},token),403,groupsBoundaryMessage,label);
  check(beforeBatch,null,label+': no hook is left');beforeBatch=null;
  check([await memberOf(group,user),await removedAudits(),await proofLeft(token),await sessionLeft(user)],[1,before,hook?0:1,1],label+': membership and session stay, no audit row');};
 // Allowed: {ok:true}, the row is gone, exactly one audit row.
 const removalAllowed=async(actor,group,user,label)=>{const before=await removedAudits();
  check(await manageWith(actor,{action:'remove-member',groupId:group,userId:user.id},await proof(actor)),{ok:true},label);
  check([await memberOf(group,user),await removedAudits()],[0,before+1],label+': the row is gone and audited');};

 // ---- With only the default customer there is no boundary ------------------------
 check(sorted(await access.allowedDeviceIds(tech)),sorted([dA]),'one customer: tech without assignment sees every device');
 check(sorted(await access.allowedGroupIds(tech)),sorted([gA,gA2]),'one customer: tech without assignment sees every group');
 check([await deviceAllowed(tech,dA),await groupAllowed(tech,gA),await anyDeviceAllowed(tech,'terminal')],[1,1,1],'one customer: the guards are unchanged');
 check((await customers.visibleCustomers(tech)).map(row=>row.name),['Standardkunde'],'one customer: every active customer');
 {
  // No customer names in the fleet while only the default customer exists.
  const {status,body}=await answer(await get(consoleApi,tech));check(status,200,'one customer: console GET');
  check(body.multipleCustomers,false,'one customer: multipleCustomers is false');
  check(body.servers.length,1,'one customer: tech sees every device');
  check(body.servers.some(row=>'customerName' in row||'customerDisabled' in row),false,'one customer: no customerName or customerDisabled on any device');
 }
 {
  // With one customer the assignment list is not filtered by customer.
  const ids=(await rbac.rbacData(uaa)).assignments.map(row=>row.id);
  check(sorted(ids),sorted(await visibleAssignmentIds(uaa)),'one customer: rbacData(uaa) lists every assignment with a visible role');
  check((await createdAt(ids)).every((at,n,all)=>n===0||Number(at)<=Number(all[n-1])),true,'one customer: the list stays in created_at DESC order');
  // No customer reason with one customer; member (only in Team B) is effective on dA.
  const ofA=await rbac.rbacData(owner,{type:'device',id:dA});
  check(ofA.inherited.some(entry=>['user-customer','group-customer'].includes(entry.reason)),false,'one customer: no customer reason on dA');
  check([flag(ofA,memberActor.assignmentId),flag(ofA,ownerActor.assignmentId),flag(ofA,techActor.assignmentId)],[[true],[true],[true]],'one customer: the global roles of member, owner and tech are effective on dA');
 }
 {
  // With one customer delete-assignment deletes an assignment on any device.
  const onDA=await throwaway('device',dA);
  check(await deleteAssignment(uaa,onDA),{ok:true},'one customer: uaa deletes an assignment on dA');
  check(await assignmentExists(onDA),0,'one customer: the assignment on dA is gone');
 }

 {
  // With one customer removing a member of a group assigned to A needs no customer.
  check(rbac.customerGroupBoundaryMessage,groupsBoundaryMessage,'the remove-member boundary message');
  const groupsActor=(await sourceActor(d,'groups-single@boundary.test',['portal.userGroups.manage'])).actor;groupsActor.userId=groupsActor.id;await mfaSession(groupsActor);
  const ofA=await userGroup(1,customerA),person=await joined(ofA);
  await removalAllowed(groupsActor,ofA,person,'one customer: remove-member from a group assigned to A without a customer');
  await d.exec(sql`DELETE FROM user_groups WHERE id=${ofA}`);
 }

 // ---- A second customer: the boundary applies; nobody but the Owner is assigned yet ---
 await separate();
 check([(await access.allowedDeviceIds(tech)).length,(await access.allowedGroupIds(tech)).length],[0,0],'two customers: tech without assignment sees no device and no group');
 check([await deviceAllowed(tech,dA),await deviceAllowed(owner,dA),await deviceAllowed(owner,dB)],[0,1,1],'two customers: tech gets nothing on dA, the Owner keeps every device');
 await assign(customerA,'user',tech.id);await assign(customerA,'user',uaa.id);await assign(customerA,'user',scoped.id);await assign(customerB,'group',team);

 // ---- Reading --------------------------------------------------------
 check(sorted(await access.allowedDeviceIds(tech)),[dA],'allowedDeviceIds: only customer A');
 check(sorted(await access.allowedGroupIds(tech)),sorted([gA,gA2]),'allowedGroupIds: only customer A');
 check(await access.permissionsFor(tech,dB),[],'permissionsFor outside the boundary');
 check(await access.groupPermissions(tech,gB),[],'groupPermissions outside the boundary');
 check((await access.permissionsFor(tech,dA)).length,access.allPermissions.length,'permissionsFor inside the boundary is unchanged');
 check((await access.groupPermissions(tech,gA)).length,access.allPermissions.length,'groupPermissions inside the boundary is unchanged');
 await rejects(access.requireDevice(tech,dB),404,serverText('apiError.device.notFound'),'requireDevice outside');
 await rejects(access.requireDevice(tech,dB2,'files.read'),404,serverText('apiError.device.notFound'),'requireDevice outside without group');
 await rejects(access.requireGroup(tech,gB1),404,serverText('apiError.group.notFound'),'requireGroup outside');
 check((await access.requireDevice(tech,dA)).id,dA,'requireDevice inside');
 check((await access.requireGroup(tech,gA)).id,gA,'requireGroup inside');
 check([await deviceAllowed(tech,dB),await deviceAllowed(tech,dA)],[0,1],'devicePermissionGuard B 0, A 1');
 check([await groupAllowed(tech,gB),await groupAllowed(tech,gB1),await groupAllowed(tech,gA)],[0,0,1],'groupPermissionGuard B 0, A 1');
 check(await anyDeviceAllowed(scoped,'terminal'),0,'anyDevicePermissionGuard: a role only on a device of B gives nothing');
 await assign(customerB,'user',scoped.id);check(await anyDeviceAllowed(scoped,'terminal'),1,'anyDevicePermissionGuard: with B assigned it counts');await unassign(customerB,'user',scoped.id);
 check(await guardHolds(access.globalPermissionGuard(value(tech.principal),'view')),1,'globalPermissionGuard is unchanged');
 check(await guardHolds(access.groupPermissionGuard(value(uuid()),value(owner.principal),'view')),0,'a missing group allows nothing, also globally');
 check(sorted(await access.allowedDeviceIds(owner)),sorted([dA,dB,dB2]),'the Owner sees every device');
 check(sorted(await access.allowedGroupIds(owner)),sorted([gA,gA2,gB,gB1,gC]),'the Owner sees every group');
 check((await customers.visibleCustomers(owner)).length,3,'the Owner sees every customer');
 const boundary=(customer,principal)=>access.customerAccessGuard(value(customer),value(principal));
 check([await guardHolds(boundary(customerA,tech.principal)),await guardHolds(boundary(customerB,tech.principal)),await guardHolds(boundary(customerB,owner.principal))],[1,0,1],'customerAccessGuard: customer before principal');
 // Roles directly on a device or group of B give nothing without the customer.
 const directOnB=uuid(),directOnGB=uuid();
 {
  const roleId=uuid();await insert('rbac_roles',{id:roleId,name:'Direkt',description:'',permissions:'["view","terminal"]',builtin:0,created_at:time});
  await insert('role_assignments',{id:directOnB,principal_type:'user',principal_id:tech.id,role_id:roleId,scope_type:'device',scope_id:dB,created_at:time,created_by:owner.principal});
  await insert('role_assignments',{id:directOnGB,principal_type:'user',principal_id:tech.id,role_id:roleId,scope_type:'devicegroup',scope_id:gB,created_at:time,created_by:owner.principal});
  check([await access.permissionsFor(tech,dB),await access.groupPermissions(tech,gB1),await deviceAllowed(tech,dB,'terminal'),(await access.allowedDeviceIds(tech)).includes(dB)],[[],[],0,false],'direct roles on B give no access');
 }
 // A user group assignment: enabled group and active account only; deleting the group removes it.
 check(sorted(await access.allowedDeviceIds(member)),sorted([dB,dB2]),'member sees B through the user group');
 check((await customers.visibleCustomers(member)).map(row=>row.id),[customerB],'member sees customer B');
 await d.exec(sql`UPDATE user_groups SET enabled=0 WHERE id=${team}`);
 check([(await access.allowedDeviceIds(member)).length,await deviceAllowed(member,dB)],[0,0],'a disabled user group gives nothing');
 await d.exec(sql`UPDATE user_groups SET enabled=1 WHERE id=${team}`);
 await d.exec(sql`UPDATE local_users SET status='disabled' WHERE id=${member.id}`);
 check([await guardHolds(boundary(customerB,member.principal)),await deviceAllowed(member,dB)],[0,0],'a disabled account gives nothing');
 await d.exec(sql`UPDATE local_users SET status='active' WHERE id=${member.id}`);
 check(await deviceAllowed(member,dB),1,'control: active again');

 // ---- Jobs, audit, transfers, runbooks -----------------------------------
 {
  const {status,body}=await answer(await get(consoleApi,tech));check(status,200,'console GET');
  check(body.servers.map(row=>row.id),[dA],'console: servers only from A');
  check(body.jobs.some(row=>[dB,dB2].includes(row.serverId)),false,'console: no job of B, also no runbook step');
  check(body.jobs.filter(row=>row.id===jobA1||row.id===jobA2).length,2,'console: the jobs of A are listed');
  check(body.jobs.filter(row=>row.action==='runbook-run').map(row=>row.id),['runbook:'+run+':'+dA],'console: only the runbook run of A is listed');
  check(sorted(new Set(body.deviceAudit.map(row=>row.serverId))),[dA],'console: device audit only from A');
  check(body.deviceGroups.some(row=>[gB,gB1].includes(row.id)),false,'console: no group of B');
  check(body.permissionDevices,undefined,'console: no permission targets for tech');
  check(body.customers,[{id:customerA,name:'Standardkunde'}],'console: customers only A');
  check(body.deviceGroups.length>0&&body.deviceGroups.every(row=>row.customerId===customerA),true,'console: every group carries customer A (customer folders)');
  check(body.servers.every(row=>row.customerId===customerA),true,'console: every device carries customer A');
  check(JSON.stringify(body).includes(dB),false,'console: the id of a B device appears nowhere');
  // Customer names of visible devices only.
  check(body.multipleCustomers,true,'console: multipleCustomers with a second customer');
  check(body.servers.map(row=>[row.customerName,row.customerDisabled]),[['Standardkunde',false]],'console: tech gets only the name of A');
  check(['Kunde B','Kunde C'].some(name=>JSON.stringify(body.servers).includes(name)),false,'console: the names of B and C appear nowhere in servers');
  const ownerView=(await answer(await get(consoleApi,owner))).body;
  check(sorted(ownerView.servers.map(row=>row.id)),sorted([dA,dB,dB2]),'console: the Owner sees every device');
  check(ownerView.customers.map(row=>row.name),['Kunde B','Kunde C','Standardkunde'],'console: the Owner sees every active customer');
  const names=view=>Object.fromEntries(view.servers.map(row=>[row.id,[row.customerName,row.customerDisabled]]));
  check(ownerView.multipleCustomers,true,'console: multipleCustomers for the Owner');
  check(names(ownerView),{[dA]:['Standardkunde',false],[dB]:['Kunde B',false],[dB2]:['Kunde B',false]},'console: the Owner gets the customer of each device');
  await d.exec(sql`UPDATE customers SET status='disabled' WHERE id=${customerB}`);
  try{
   const disabledView=(await answer(await get(consoleApi,owner))).body;
   check(names(disabledView),{[dA]:['Standardkunde',false],[dB]:['Kunde B',true],[dB2]:['Kunde B',true]},'console: a disabled customer keeps its name and is marked');
  }finally{await d.exec(sql`UPDATE customers SET status='active' WHERE id=${customerB}`);}
  const customerOf={[dA]:customerA,[dB]:customerB,[dB2]:customerB},groupCustomer={[gA]:customerA,[gA2]:customerA,[gB]:customerB,[gB1]:customerB,[gC]:customerC};
  check(ownerView.deviceGroups.filter(row=>row.id in groupCustomer).map(row=>[row.id,row.customerId]).sort(),Object.entries(groupCustomer).sort(),'console: the Owner gets each group with its customer');
  check(sorted(ownerView.permissionDevices.map(row=>row.id+':'+row.customerId)),sorted(Object.entries(customerOf).map(([id,customer])=>id+':'+customer)),'console: permission targets carry their customer');
 }
 {
  let {status}=await answer(await post(consoleApi,tech,{action:'cancel-job',id:jobB}));check(status,404,'cancel-job on B');
  check(await d.one(sql`SELECT state FROM jobs WHERE id=${jobB}`).then(row=>row===null?null:row.state),'pending','the job of B stays pending');
  ({status}=await answer(await post(consoleApi,tech,{action:'cancel-job',id:jobA1})));check(status,200,'control: cancel-job on A');
  check(await d.one(sql`SELECT state FROM jobs WHERE id=${jobA1}`).then(row=>row===null?null:row.state),'cancelled','the job of A is cancelled');
  const jobs=await count(sql`SELECT count(*) AS n FROM jobs`);
  ({status}=await answer(await post(consoleApi,tech,{action:'job',id:dB,kind:'refresh'})));check(status,404,'job on B');
  check(await count(sql`SELECT count(*) AS n FROM jobs`),jobs,'no job row for B');
  ({status}=await answer(await post(consoleApi,tech,{action:'job',id:dA,kind:'refresh'})));check(status,200,'control: job on A');
  check(await count(sql`SELECT count(*) AS n FROM jobs`),jobs+1,'one job row for A');
 }
 {
  const guard=auditScope.deviceAuditGuard(tech,[dA,dB,dB2]);
  const rows=(await d.query(sql`SELECT a.server_id AS "serverId" FROM audit a WHERE ${guard}`));
  check(sorted(new Set(rows.map(row=>row.serverId))),[dA],'deviceAuditGuard passes only audit rows of A');
 }
 {
  const transferCount=await count(sql`SELECT count(*) AS n FROM transfers`);
  const {status}=await answer(await post(transfersApi,tech,{action:'create',serverId:dB,direction:'download',path:'C:\\Daten\\neu.txt'}));
  check(status,404,'transfer create on B');check(await count(sql`SELECT count(*) AS n FROM transfers`),transferCount,'no transfer row');
  const row=id=>d.one(sql`SELECT * FROM transfers WHERE id=${id}`);
  await rejects(transfers.assertTransferAuthorized(await row(transferB),tech),403,serverText('apiError.transfer.rightRevoked'),'an existing transfer on B');
  await transfers.assertTransferAuthorized(await row(transferA),tech);checks++;
  const statusB=await answer(await get(transfersApi,tech,'?id='+transferB));check([statusB.status,statusB.body.error],[404,serverText('apiError.device.notFound')],'transfer status on B fails at requireDevice');
 }
 {
  const list=await runbooks.listRunbooks(tech);
  check(list.runs.map(entry=>entry.id),[run],'listRunbooks: the run over A and B');
  check(list.runs[0].devices.map(entry=>entry.serverId),[dA],'listRunbooks: only the device of A');
  check(JSON.stringify(list).includes(dB),false,'listRunbooks: nothing of B');
  check((await runbooks.listRunbooks(owner)).runs[0].devices.map(entry=>entry.serverId).sort(),sorted([dA,dB]),'listRunbooks: the Owner sees both');
 }

 // ---- The access route and RBAC ---------------------------------------
 const groupsBefore=await count(sql`SELECT count(*) AS n FROM device_groups`),membersBefore=await count(sql`SELECT count(*) AS n FROM device_group_members`);
 const auditBefore=async()=>count(sql`SELECT count(*) AS n FROM audit`);
 const unchanged=async(label,audits)=>{check([await count(sql`SELECT count(*) AS n FROM device_groups`),await count(sql`SELECT count(*) AS n FROM device_group_members`),await auditBefore()],[groupsBefore,membersBefore,audits],label+': no group, membership or audit');};
 {
  const {status,body}=await answer(await get(accessApi,tech));check(status,200,'access GET');
  check(sorted(body.groups.map(row=>row.id)),sorted([gA,gA2]),'access GET lists only the groups of A');
  check(body.customers,[{id:customerA,name:'Standardkunde'}],'access GET: customers only A');
  check(JSON.stringify(body).includes(gB),false,'access GET: no id of B');
 }
 {
  const audits=await auditBefore(),cases=[
   ['update-group gB1',{action:'update-group',id:gB1,name:'Neu',description:''},404,serverText('apiError.group.notFound')],
   ['create-group below gB1',{action:'create-group',name:'Neu',parentId:gB1},404,serverText('apiError.group.notFound')],
   ['delete-group gB',{action:'delete-group',id:gB,confirm:true},404,serverText('apiError.group.deviceGroupNotFound')],
   ['set-device-memberships into gB1',{action:'set-device-memberships',serverIds:[dA],groupId:gB1,assigned:true},404,serverText('apiError.group.notFound')],
   ['set-device-memberships of dB (its group gB1 is outside)',{action:'set-device-memberships',serverIds:[dB],groupId:gA,assigned:true},404,serverText('apiError.group.notFound')],
   ['set-grant on gB1',{action:'set-grant',groupId:gB1,principal:member.principal,role:'viewer',permissions:['view']},404,serverText('apiError.group.notFound')],
   ['set-device-memberships of dB2 into gA',{action:'set-device-memberships',serverIds:[dB2],groupId:gA,assigned:true},403,null],
   ['create-group for B',{action:'create-group',name:'Neu',customerId:customerB},404,serverText('apiError.customer.unavailable')],
   ['create-group for an unknown customer',{action:'create-group',name:'Neu',customerId:uuid()},404,serverText('apiError.customer.unavailable')],
   ['create-group with a non-GUID customer',{action:'create-group',name:'Neu',customerId:'kunde-b'},400,serverText('apiError.customer.invalid')],
   ['create-group below gA for B',{action:'create-group',name:'Neu',parentId:gA,customerId:customerB},400,serverText('apiError.group.subgroupCustomer')],
  ];
  for(const [label,payload,status,message] of cases){
   const result=await answer(await post(accessApi,tech,payload));check(result.status,status,label);if(message)check(result.body.error,message,label+' message');
   await unchanged(label,audits);
  }
  check(await count(sql`SELECT count(*) AS n FROM role_assignments WHERE principal_id=${member.id} AND scope_id=${gB1}`),0,'set-grant wrote no assignment');
  await assign(customerC,'user',tech.id);await d.exec(sql`UPDATE customers SET status='disabled' WHERE id=${customerC}`);
  const disabled=await answer(await post(accessApi,tech,{action:'create-group',name:'Neu',customerId:customerC}));
  check([disabled.status,disabled.body.error],[409,serverText('apiError.customer.disabled')],'create-group for a disabled visible customer');
  await unchanged('disabled customer',audits);
  // Enrolling into a group of a disabled customer: 409 with the reason, no device.
  const servers=await count(sql`SELECT count(*) AS n FROM servers`),enrolled=await answer(await post(consoleApi,owner,{action:'enroll',name:'Server C',groupId:gC}));
  check([enrolled.status,enrolled.body.error],[409,serverText('apiError.customer.disabled')],'enroll into a group of a disabled customer');
  check([await count(sql`SELECT count(*) AS n FROM servers`),await count(sql`SELECT count(*) AS n FROM device_group_members WHERE group_id=${gC}`)],[servers,0],'no device and no membership');
  // Without customerId a root group belongs to the first customer: not visible without A.
  await unassign(customerA,'user',tech.id);
  const hidden=await answer(await post(accessApi,tech,{action:'create-group',name:'Neu'}));check(hidden.status,404,'root group without customerId and without A');
  await unchanged('root group without A',audits);
  await assign(customerA,'user',tech.id);
  const created=await answer(await post(accessApi,tech,{action:'create-group',name:'Neu A',customerId:customerA}));check(created.status,200,'create-group for A');
  check(await d.one(sql`SELECT customer_id FROM device_groups WHERE id=${created.body.id}`).then(row=>row===null?null:row.customer_id),customerA,'the new group belongs to A');
  await d.exec(sql`DELETE FROM device_groups WHERE id=${created.body.id}`);
 }
 {
  const groups=await catalog.deviceGroupCatalog(uaa,await access.allowedDeviceIds(uaa));
  check(sorted(groups.map(row=>row.id)),sorted([gA,gA2]),'deviceGroupCatalog for portal.roleAssignments.manage: only A');
  check((await catalog.devicePermissionTargets(uaa)).map(row=>row.id),[dA],'devicePermissionTargets: only A');
  const data=await rbac.rbacData(uaa);
  check([sorted(data.deviceGroups.map(row=>row.id)),data.devices.map(row=>row.id)],[sorted([gA,gA2]),[dA]],'rbacData: only A');
  check(sorted((await catalog.devicePermissionTargets(owner)).map(row=>row.id)),sorted([dA,dB,dB2]),'devicePermissionTargets: the Owner sees all');
  const roleId=uuid();await insert('rbac_roles',{id:roleId,name:'Leser',description:'',permissions:'["view"]',builtin:0,created_at:time});
  const assignments=await count(sql`SELECT count(*) AS n FROM role_assignments`);
  const authorization=async()=>rbac.prepareManagementAuthorization(new Request('https://boundary.test/api/rbac'),uaa,await proof(uaa));
  await rejects(rbac.manageRbac(uaa,{action:'add-assignment',subjectType:'user',subjectId:member.id,roleId,scopeType:'devicegroup',scopeId:gB},await authorization()),403,serverText('apiError.rbac.assignmentChanged'),'add-assignment on gB');
  await rejects(rbac.manageRbac(uaa,{action:'add-assignment',subjectType:'user',subjectId:member.id,roleId,scopeType:'device',scopeId:dB},await authorization()),403,serverText('apiError.rbac.assignmentChanged'),'add-assignment on dB');
  check(await count(sql`SELECT count(*) AS n FROM role_assignments`),assignments,'no assignment row');
  await rbac.manageRbac(uaa,{action:'add-assignment',subjectType:'user',subjectId:member.id,roleId,scopeType:'devicegroup',scopeId:gA},await authorization());
  check(await count(sql`SELECT count(*) AS n FROM role_assignments`),assignments+1,'control: add-assignment on gA');
  const memberGlobal=(await rbac.manageRbac(uaa,{action:'add-assignment',subjectType:'user',subjectId:member.id,roleId,scopeType:'global',scopeId:'*'},await authorization())).id;
  check(await count(sql`SELECT count(*) AS n FROM role_assignments`),assignments+2,'global assignments are not affected');
  // Inherited assignments stay inside the customer boundary.
  const customerRole=uuid(),onB=uuid(),onBCustomer=uuid(),onB1=uuid();await insert('rbac_roles',{id:customerRole,name:'Leser B',description:'',permissions:'["view"]',builtin:0,created_at:time,customer_id:customerB});
  for(const [id,role,group] of [[onB,roleId,gB],[onBCustomer,customerRole,gB],[onB1,roleId,gB1]])await insert('role_assignments',{id,principal_type:'user',principal_id:member.id,role_id:role,scope_type:'devicegroup',scope_id:group,created_at:time,created_by:owner.principal});
  const ofA=await rbac.rbacData(uaa,{type:'device',id:dA}),visible=ofA.assignments,inheritedA=ofA.inherited.map(entry=>entry.assignmentId);
  check(inheritedA,[...visible.filter(row=>row.scopeType==='devicegroup'&&row.scopeId===gA),...visible.filter(row=>row.scopeType==='global')].map(row=>row.id),'rbacData(uaa, dA): the visible gA and global assignments, nearest first');
  check(inheritedA.length>1&&inheritedA.every(id=>visible.some(row=>row.id===id)),true,'rbacData(uaa, dA): every inherited entry is in assignments');
  check(ofA.inherited.some(entry=>[gB,gB1].includes(entry.originId)),false,'rbacData(uaa, dA): no origin of B');
  for(const [type,id,label] of [['device',dB,'dB'],['devicegroup',gB,'gB'],['devicegroup',gB1,'gB1'],['device',dB2,'dB2']]){
   const ofB=await rbac.rbacData(uaa,{type,id});
   check(ofB.inherited,[],`rbacData(uaa, ${label}): nothing inherited outside the boundary`);
   check([onB,onBCustomer,onB1].some(assignment=>JSON.stringify(ofB).includes(assignment)),false,`rbacData(uaa, ${label}): no gB assignment id in the whole response`);
   check(JSON.stringify(ofB).includes(onBCustomer),false,`rbacData(uaa, ${label}): the assignment with the customer B role appears nowhere`);
  }
  const ofOwner=await rbac.rbacData(owner,{type:'device',id:dB}),inheritedOwner=ofOwner.inherited.map(entry=>entry.assignmentId);
  check([onB1,onB,onBCustomer].every(id=>inheritedOwner.includes(id))&&inheritedOwner.indexOf(onB1)<inheritedOwner.indexOf(onB),true,'control: the Owner sees the B assignments on dB, gB1 before gB');
  // Effective flag fixtures: Team B on gB1 and on gA, an empty, a disabled group and a disabled account with a global Leser role.
  const empty=uuid(),off=uuid(),offMember=(await sourceActor(d,'off-member@boundary.test',[])).actor,gone=(await sourceActor(d,'gone@boundary.test',[])).actor;
  await insert('user_groups',{id:empty,name:'Leer',description:'',enabled:1,created_at:time});await insert('user_groups',{id:off,name:'Aus',description:'',enabled:0,created_at:time});
  await insert('user_group_members',{group_id:off,user_id:offMember.id});await d.exec(sql`UPDATE local_users SET status='disabled' WHERE id=${gone.id}`);
  const teamOnGB1=uuid(),teamOnGA=uuid(),emptyGlobal=uuid(),offGlobal=uuid(),goneGlobal=uuid();
  for(const [id,type,subject,scopeType,scopeId] of [[teamOnGB1,'group',team,'devicegroup',gB1],[teamOnGA,'group',team,'devicegroup',gA],[emptyGlobal,'group',empty,'global','*'],[offGlobal,'group',off,'global','*'],[goneGlobal,'user',gone.id,'global','*']])await insert('role_assignments',{id,principal_type:type,principal_id:subject,role_id:roleId,scope_type:scopeType,scope_id:scopeId,created_at:time,created_by:owner.principal});
  // Tech of A (uaa) gets nothing of B or C, for every scope; the global and the A assignments stay.
  const foreign={gB,gB1,gC,dB,dB2,onB,onB1,onBCustomer,directOnB,directOnGB,scopedOnB,teamOnGB1};
  const expected=(await d.query(sql`SELECT id FROM role_assignments WHERE scope_type='global' OR scope_id IN (${gA},${dA})`)).map(row=>row.id);
  for(const [label,scope] of [['no scope',undefined],['global',{type:'global',id:'*'}],['dA',{type:'device',id:dA}],['gA',{type:'devicegroup',id:gA}],['dB',{type:'device',id:dB}],['dB2',{type:'device',id:dB2}],['gB',{type:'devicegroup',id:gB}],['gB1',{type:'devicegroup',id:gB1}]]){
   const result=await rbac.rbacData(uaa,scope),json=JSON.stringify(result);
   check(Object.entries(foreign).filter(([,id])=>json.includes(id)).map(([name])=>name),[],`rbacData(uaa, ${label}): no id of B or C anywhere in the response`);
   const ids=result.assignments.map(row=>row.id);
   check(expected.filter(id=>!ids.includes(id)),[],`rbacData(uaa, ${label}): every global, gA and dA assignment stays`);
   check(sorted(ids),sorted(expected),`rbacData(uaa, ${label}): exactly the global, gA and dA assignments`);
  }
  // The Owner keeps the full list; uaa with B and C assigned gets the same ids.
  const all=(await d.query(sql`SELECT id FROM role_assignments`)).map(row=>row.id),ownerIds=(await rbac.rbacData(owner)).assignments.map(row=>row.id);
  check(sorted(ownerIds),sorted(all),'rbacData(owner): every assignment, also those of B');
  await assign(customerB,'user',uaa.id);await assign(customerC,'user',uaa.id);
  try{check((await rbac.rbacData(uaa)).assignments.map(row=>row.id),ownerIds,'rbacData(uaa with A, B and C): the same assignments as the Owner');}
  finally{await unassign(customerB,'user',uaa.id);await unassign(customerC,'user',uaa.id);}
  // Effective and reason per inherited entry, read by the Owner.
  const onDA=await rbac.rbacData(owner,{type:'device',id:dA}),onDB=await rbac.rbacData(owner,{type:'device',id:dB});
  check(flag(onDA,memberGlobal),[false,'user-customer'],'member (only in Team B) on dA: not assigned to the customer');
  check(flag(onDB,memberGlobal),[true],'member on dB: effective');
  check([flag(onDA,techActor.assignmentId),flag(onDB,techActor.assignmentId)],[[true],[false,'user-customer']],'tech: effective on dA, not on dB');
  check([flag(onDA,uaaActor.assignmentId),flag(onDB,uaaActor.assignmentId)],[[false,'role'],[false,'role']],'uaa: a portal-only role gives no device right');
  check([flag(onDA,ownerActor.assignmentId),flag(onDB,ownerActor.assignmentId)],[[true],[true]],'owner: the global Owner role is effective on both');
  check(flag(onDB,teamOnGB1),[true],'Team B on gB1, read on dB: effective');
  check(flag(onDA,teamOnGA),[false,'group-customer'],'Team B on gA, read on dA: no member is assigned to customer A');
  check([flag(onDA,emptyGlobal),flag(onDA,offGlobal),flag(onDA,goneGlobal)],[[false,'group-empty'],[false,'group-disabled'],[false,'user-inactive']],'empty group, disabled group, disabled account');
  check(onDA.inherited.every(entry=>typeof entry.effective==='boolean'&&entry.effective===!('reason' in entry)),true,'every entry has effective, only non-effective ones a reason');
  // For a group scope the group's own customer counts: member's assignments on gB and globally, read on gB1.
  const onGB1=await rbac.rbacData(owner,{type:'devicegroup',id:gB1});
  check([flag(onGB1,onB),flag(onGB1,memberGlobal)],[[true],[true]],'member on gB1 through gB and globally: effective');
  check(flag(await rbac.rbacData(owner,{type:'devicegroup',id:gA}),memberGlobal),[false,'user-customer'],'member globally, read on gA: not assigned to customer A');
  await d.exec(sql`DELETE FROM role_assignments WHERE id IN (${teamOnGB1},${teamOnGA},${emptyGlobal},${offGlobal},${goneGlobal})`);
  await d.exec(sql`DELETE FROM user_group_members WHERE group_id=${off}`);await d.exec(sql`DELETE FROM user_groups WHERE id IN (${empty},${off})`);
  {
   // delete-assignment: an assignment on a group or device of B answers like an unknown ID for uaa (only A).
   const audits=await auditBefore(),unknownId=[404,serverText('apiError.rbac.assignmentNotFound'),undefined];
   check(await failureOf(deleteAssignment(uaa,uuid())),unknownId,'delete-assignment(uaa, unknown ID)');
   for(const [id,label] of [[onB,'onB (gB)'],[onB1,'onB1 (gB1)'],[onBCustomer,'onBCustomer (gB, customer B role)'],[scopedOnB,'scopedOnB (dB)']]){
    const token=await proof(uaa);
    check(await failureOf(deleteAssignment(uaa,id,token)),unknownId,`delete-assignment(uaa, ${label}): as for an unknown ID`);
    check(await count(sql`SELECT count(*) AS n FROM mfa_management_proofs WHERE token_hash=${token}`),1,`delete-assignment(uaa, ${label}): the proof stays`);
    const refused=await answer(await post(rbacApi,uaa,{action:'delete-assignment',id})),unknown=await answer(await post(rbacApi,uaa,{action:'delete-assignment',id:uuid()}));
    check(refused,unknown,`POST /api/rbac delete-assignment(uaa, ${label}): the same status and body as for an unknown ID`);
    check(refused.status,404,`POST /api/rbac delete-assignment(uaa, ${label}): 404`);
   }
   check(await Promise.all([onB,onB1,onBCustomer,scopedOnB].map(assignmentExists)),[1,1,1,1],'delete-assignment(uaa): all four B assignments stay');
   check(await auditBefore(),audits,'delete-assignment(uaa): no audit row for the refused deletes');
   // Controls: A and global for uaa, B for the Owner and for uaa assigned to A and B.
   const removed=async(actor,id,label)=>{const before=await auditBefore();check(await deleteAssignment(actor,id),{ok:true},label);check([await assignmentExists(id),await auditBefore(),await count(sql`SELECT count(*) AS n FROM audit WHERE action='Rollenzuweisung entfernt' AND target LIKE ${'%'+id+'%'}`)],[0,before+1,1],label+': the row is gone and audited');};
   await removed(uaa,await throwaway('devicegroup',gA),'control: uaa deletes an assignment on gA');
   await removed(uaa,await throwaway('device',dA),'control: uaa deletes an assignment on dA');
   await removed(uaa,await throwaway('global','*'),'control: uaa deletes a global assignment');
   await removed(owner,await throwaway('device',dB),'control: the Owner deletes an assignment on dB');
   await assign(customerB,'user',uaa.id);
   try{await removed(uaa,await throwaway('devicegroup',gB),'control: uaa assigned to A and B deletes an assignment on gB');}
   finally{await unassign(customerB,'user',uaa.id);}
   // Race: customer A is removed from uaa between the pre-check and the commit.
   const raced=await throwaway('device',dA),before=await auditBefore();
   await insert('mfa_sessions',{token_hash:hash(throwawayUser.id+'mfa'),principal:throwawayUser.principal,created_at:time,last_activity:time,idle_expires_at:time+3_600_000,expires_at:time+86_400_000});
   beforeBatch=()=>unassign(customerA,'user',uaa.id);
   try{await rejects(deleteAssignment(uaa,raced),409,serverText('apiError.rbac.lastOwner'),'race: delete-assignment on dA');}
   finally{beforeBatch=null;await assign(customerA,'user',uaa.id);}
   check([await assignmentExists(raced),await auditBefore(),await count(sql`SELECT count(*) AS n FROM mfa_sessions WHERE principal=${throwawayUser.principal}`)],[1,before,1],'race: the assignment stays, no audit, the subject keeps its session');
   await d.exec(sql`DELETE FROM role_assignments WHERE id=${raced}`);await d.exec(sql`DELETE FROM mfa_sessions WHERE principal=${throwawayUser.principal}`);
  }
 }

 // ---- Commit races: the assignment disappears between pre-check and commit -----
 {
  const audits=await auditBefore();
  afterGroup=()=>unassign(customerA,'user',tech.id);
  const renamed=await answer(await post(accessApi,tech,{action:'update-group',id:gA,name:'Umbenannt',description:''}));afterGroup=async()=>{};
  check([renamed.status,renamed.body.error],[403,serverText('apiError.group.rightRevoked')],'race 1: update-group');
  check(await d.one(sql`SELECT name FROM device_groups WHERE id=${gA}`).then(row=>row===null?null:row.name),'Gruppe A','race 1: the name is unchanged');
  await assign(customerA,'user',tech.id);
  afterDevice=()=>unassign(customerA,'user',tech.id);
  const cancelled=await answer(await post(consoleApi,tech,{action:'cancel-job',id:jobA2}));afterDevice=async()=>{};
  check(cancelled.status,409,'race 2: cancel-job');check(await d.one(sql`SELECT state FROM jobs WHERE id=${jobA2}`).then(row=>row===null?null:row.state),'pending','race 2: the job stays pending');
  await assign(customerA,'user',tech.id);
  beforeBatch=()=>unassign(customerA,'user',tech.id);
  const created=await answer(await post(accessApi,tech,{action:'create-group',name:'Rennen',customerId:customerA}));beforeBatch=null;
  check(created.status,403,'race 3: create-group');check(await count(sql`SELECT count(*) AS n FROM device_groups WHERE name='Rennen'`),0,'race 3: nothing written');
  await assign(customerA,'user',tech.id);
  beforeBatch=()=>unassign(customerA,'user',tech.id);
  const deleted=await answer(await post(accessApi,tech,{action:'delete-group',id:gA2,confirm:true}));beforeBatch=null;
  check(deleted.status,403,'race 4: delete-group');check(await count(sql`SELECT count(*) AS n FROM device_groups WHERE id=${gA2}`),1,'race 4: the group stays');
  await assign(customerA,'user',tech.id);
  await unchanged('races',audits);
  // Controls: with the assignment in place the same requests succeed.
  check((await answer(await post(consoleApi,tech,{action:'cancel-job',id:jobA2}))).status,200,'control: cancel-job');
  check((await answer(await post(accessApi,tech,{action:'delete-group',id:gA2,confirm:true}))).status,200,'control: delete-group');
 }
 // Joining or enabling a user group that is assigned
 // to a customer is a customer assignment and needs a live global Owner.
 {
  const ugm=(await sourceActor(d,'groups@boundary.test',['portal.userGroups.manage','view'])).actor;ugm.userId=ugm.id;
  await insert('mfa_sessions',{token_hash:hash(ugm.id+'mfa'),principal:ugm.principal,created_at:time,last_activity:time,idle_expires_at:time+3_600_000,expires_at:time+86_400_000});
  await assign(customerA,'user',ugm.id);
  const ownerOnly=serverText('apiError.rbac.customerGroupOwnerOnly');
  const manage=async(actor,payload)=>{viewer=actor;return rbac.manageRbac(actor,payload,await rbac.prepareManagementAuthorization(new Request('https://boundary.test/api/rbac'),actor,await proof(actor)));};
  const membership=group=>count(sql`SELECT count(*) AS n FROM user_group_members WHERE group_id=${group} AND user_id=${ugm.id}`);
  check(sorted(await access.allowedDeviceIds(ugm)),[dA],'ugm sees only A');
  const audits=await auditBefore();
  await rejects(manage(ugm,{action:'add-member',groupId:team,userId:ugm.id}),403,ownerOnly,'joining the group of customer B');
  check([await membership(team),(await access.allowedDeviceIds(ugm)).includes(dB)],[0,false],'no membership, still no access to B');
  // Race: the group gets its customer between the pre-check and the commit.
  const late=uuid();await insert('user_groups',{id:late,name:'Spät',description:'',enabled:1,created_at:time});
  beforeBatch=()=>assign(customerB,'group',late);
  await rejects(manage(ugm,{action:'add-member',groupId:late,userId:ugm.id}),403,ownerOnly,'customer assigned before the commit');beforeBatch=null;
  check(await membership(late),0,'race: no membership');
  // Enabling a disabled customer group is refused as well; disabling and removing stay allowed.
  await d.exec(sql`UPDATE user_groups SET enabled=0 WHERE id=${team}`);
  await rejects(manage(ugm,{action:'update-group',id:team,name:'Team B',description:'',enabled:true}),403,ownerOnly,'enabling the group of customer B');
  check(await count(sql`SELECT count(*) AS n FROM user_groups WHERE id=${team} AND enabled=0`),1,'the group stays disabled');
  check(await auditBefore(),audits,'no audit for the refused changes');
  await manage(owner,{action:'update-group',id:team,name:'Team B',description:'',enabled:true});checks++;
  await manage(ugm,{action:'update-group',id:team,name:'Team B',description:'',enabled:false});checks++;
  check(await count(sql`SELECT count(*) AS n FROM user_groups WHERE id=${team} AND enabled=0`),1,'disabling stays allowed');
  await manage(owner,{action:'update-group',id:team,name:'Team B',description:'',enabled:true});
  // Removing a member needs every customer of the group: ugm sees only A.
  const offB=await userGroup(0,customerB),both=await userGroup(1,customerA,customerB),onlyA=await userGroup(1,customerA),bare=await userGroup(1);
  const inOffB=await joined(offB),inBoth=await joined(both);
  // member's session ended with an earlier group change; a fresh one shows that a refusal revokes nothing.
  await d.exec(sql`DELETE FROM mfa_sessions WHERE principal=${member.principal}`);await mfaSession(member);
  await removalRefused(ugm,team,member,'remove-member from the enabled group of B');
  await removalRefused(ugm,offB,inOffB,'remove-member from a disabled group of B');
  await removalRefused(ugm,both,inBoth,'remove-member from a group of A and B');
  // The guard alone: false for ugm, true for the Owner.
  const seen=async(actor,group)=>{const guard=access.groupCustomersSeenGuard(actor,group);return !!await d.one(sql`SELECT 1 AS ok WHERE ${guard}`);};
  check([await seen(ugm,offB),await seen(owner,offB),await seen(ugm,onlyA),await seen(ugm,bare)],[false,true,true,true],'groupCustomersSeenGuard: ugm only for A and no customer, the Owner always');
  check(readFileSync('lib/server/identity/access.ts','utf8').split('boundary_assignment.customer_id=').length-1,1,'lib/server/identity/access.ts keeps one assignedSubject definition');
  // Controls: the Owner; ugm once it sees B as well; groups of A only and without customer.
  await removalAllowed(owner,team,member,'Owner removes a member of the group of B');
  await insert('user_group_members',{group_id:team,user_id:member.id});
  await assign(customerB,'user',ugm.id);
  await removalAllowed(ugm,team,member,'ugm with A and B removes a member of the group of B');
  await removalAllowed(ugm,both,inBoth,'ugm with A and B removes a member of the group of A and B');
  await unassign(customerB,'user',ugm.id);
  await removalAllowed(ugm,onlyA,await joined(onlyA),'ugm removes a member of a group of A');
  await removalAllowed(ugm,bare,await joined(bare),'ugm removes a member of a group without customer');
  // Races: the group gets customer B, or ugm loses A, between the pre-check and the commit.
  const raceBare=await joined(bare),raceA=await joined(onlyA);
  await removalRefused(ugm,bare,raceBare,'race: the group gets customer B before the commit',()=>assign(customerB,'group',bare));
  await unassign(customerB,'group',bare);
  await removalRefused(ugm,onlyA,raceA,'race: ugm loses customer A before the commit',()=>unassign(customerA,'user',ugm.id));
  await assign(customerA,'user',ugm.id);
  await removalAllowed(ugm,bare,raceBare,'race control: no hook, group without customer');
  await removalAllowed(ugm,onlyA,raceA,'race control: no hook, group of A');
  for(const group of [offB,both,onlyA,bare])await d.exec(sql`DELETE FROM user_groups WHERE id=${group}`);
  // Controls: the Owner may add members, also the technician himself.
  await manage(owner,{action:'add-member',groupId:team,userId:member.id});await manage(owner,{action:'add-member',groupId:team,userId:ugm.id});
  check([await membership(team),(await access.allowedDeviceIds(ugm)).includes(dB)],[1,true],'Owner control: ugm joins and sees B');
  // Joining revoked ugm's sessions (invalidateRbacUsers); a fresh MFA session for the next requests.
  await insert('mfa_sessions',{token_hash:hash(ugm.id+'mfa'),principal:ugm.principal,created_at:time,last_activity:time,idle_expires_at:time+3_600_000,expires_at:time+86_400_000});
  await rejects(manage(ugm,{action:'add-member',groupId:late,userId:member.id}),403,ownerOnly,'adding another user is refused too');
  await d.exec(sql`DELETE FROM customer_assignments WHERE principal_type='group' AND principal_id=${late}`);
  await manage(ugm,{action:'add-member',groupId:late,userId:ugm.id});check(await membership(late),1,'control: a group without customer stays open to portal.userGroups.manage');
 }
 // A group drift policy on a foreign group answers like a missing group.
 {
  const drift=load('lib/server/automation/drift.ts',imports);
  await rejects(drift.applyGroupDriftPolicy(tech,gB,{},true),404,serverText('apiError.group.deviceGroupNotFound'),'group drift policy on B');
  await rejects(drift.applyGroupDriftPolicy(tech,uuid(),{},true),404,serverText('apiError.group.deviceGroupNotFound'),'group drift policy on a missing group');
  await assert.rejects(drift.applyGroupDriftPolicy(owner,gB,{},true),error=>error.message!==serverText('apiError.group.deviceGroupNotFound'),'control: the Owner gets past the group read');checks++;
 }
 // Deleting the user group removes its assignment.
 await d.exec(sql`DELETE FROM user_groups WHERE id=${team}`);
 check(await count(sql`SELECT count(*) AS n FROM customer_assignments WHERE principal_type='group' AND principal_id=${team}`),0,'deleting the user group removes its assignment');
 check((await access.allowedDeviceIds(member)).length,0,'member sees nothing afterwards');
 console.log(`PASS: ${checks} customer boundary assertions across guards, console, access, transfers, runbooks and commit races.`);
}finally{d.close();}
