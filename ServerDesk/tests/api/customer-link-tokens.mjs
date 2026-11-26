// Open account links die when an account gains a customer assignment:
// manageRbac add-member and update-group (enabling), and setCustomerTechnicians
// (lib/server/identity/customer-admin.ts), against the real
// lib/server/identity/access.ts, lib/server/identity/rbac.ts and app/api/auth/route.ts on an isolated PostgreSQL
// test database, before and after the UAA is assigned to customer A. Links
// are issued through reset-link and checked through invitation-info and redeem.
import {serverText} from '../support/server-text.mjs';
import {HttpError as realHttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFileSync} from 'node:fs';
import {sourceDatabase,sourceLoader,insertRow,createTrigger,dropTrigger} from '../support/source-database.mjs';

import {sql} from '../../runtime/database.mjs';

import {hookDatabase} from '../support/hooked-database.mjs';
const {apiErrorBody,classifyFailure}=await import('../../lib/server/errors/failure.ts');
const d=await sourceDatabase();
let checks=0;
const check=(value,expectedValue,label)=>{assert.deepEqual(value,expectedValue,label);checks++;};
try{
 const time=Date.now(),uuid=()=>crypto.randomUUID(),sha=value=>crypto.createHash('sha256').update(value).digest('hex');
 const HttpError=realHttpError;
 // The hook runs once, right before a later batch: `skip` batches pass first.
 // manageRbac and reset-link commit in their first batch.
 let viewer=null,hook=null;
 const beforeBatch=(run,skip=0)=>{hook={run,skip};};
 const facade=hookDatabase(d,{transaction:async()=>{if(hook){if(hook.skip>0)hook.skip--;else{const {run}=hook;hook=null;await run();}}}});
 const server={db:()=>facade,now:()=>Date.now(),config:()=>'',random:()=>crypto.randomBytes(32).toString('hex'),hash:async value=>sha(value),guid:x=>typeof x==='string'&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(x),HttpError,
  body:request=>request.json(),sameOrigin:()=>{},requireViewer:async()=>viewer,log:async()=>{},
  // As lib/server/context.ts failure(): an HttpError answers with its status, code, message key and params.
  failure:error=>{const answer=error instanceof HttpError?classifyFailure(error):{status:503,body:apiErrorBody('apiError.storageUnavailable')};return Response.json(answer.body,{status:answer.status});}};
 const mfa={requireLiveSessions:async()=>{},mfaSessionFence:async(request,actor)=>localAuth.primaryGuard(request,actor),isMfaEnabled:async()=>true,requireMfa:async()=>{},readMfaManagementProof:async(_request,actor,token)=>({tokenHash:token,key:actor.principal,sessionHash:sha(actor.id+'mfa'),guard:sql`TRUE`}),
  clearMfaSessionCookie:()=>'mfa=; Max-Age=0',clearMfaTrustCookie:()=>'trust=; Max-Age=0'};
 const load=sourceLoader();
 const localAuth={primaryGuard:async(_request,actor)=>load('lib/server/identity/access.ts').viewerWriteGuard(actor),clearLocalAuthCookie:()=>'auth=; Max-Age=0',
  rateLimit:async()=>{},username:value=>{if(typeof value!=='string'||!value)throw new HttpError(400,'Benutzername fehlt.');return value;},hashNewPassword:async value=>'hashed:'+value,userViewer:async user=>({id:user.id}),
  revocationStatements:(user,guard=sql`TRUE`)=>[sql`DELETE FROM local_auth_sessions WHERE user_id=${user.id} AND (${guard})`]};
 const imports={'../context':server,'./context':server,'../../context':server,'@/lib/server/context':server,'./mfa':mfa,'@/lib/server/identity/mfa':mfa,'./local-auth':localAuth,'@/lib/server/identity/local-auth':localAuth,'@/lib/server/identity/passwords':{verifyPassword:async()=>false}};
 const access=load('lib/server/identity/access.ts',imports),rbac=load('lib/server/identity/rbac.ts',imports),route=load('app/api/auth/route.ts',imports),technicians=load('lib/server/identity/customer-technicians.ts',imports),admin=load('lib/server/identity/customer-admin.ts',imports);

 // ---- Static checks -----------------------------------------------------
 const source=file=>readFileSync(file,'utf8'),occurrences=(file,needle)=>source(file).split(needle).length-1;
 check(occurrences('lib/server/identity/rbac.ts','UPDATE local_account_tokens'),1,'UPDATE local_account_tokens occurs once in lib/server/identity/rbac.ts');
 check(occurrences('lib/server/identity/customer-technicians.ts','UPDATE local_account_tokens'),0,'lib/server/identity/customer-technicians.ts never voids links itself');
 check(occurrences('lib/server/identity/customer-admin.ts','UPDATE local_account_tokens'),0,'lib/server/identity/customer-admin.ts never voids links itself');
 check(/import \{[^}]*\bcustomerGainStatements\b[^}]*\} from '\.\/rbac'/.test(source('lib/server/identity/customer-admin.ts')),true,'lib/server/identity/customer-admin.ts takes customerGainStatements from lib/server/identity/rbac.ts');
 check(occurrences('lib/server/identity/rbac.ts','boundary_assignment'),0,'lib/server/identity/rbac.ts does not copy the boundary SQL');

 // ---- Fixture --------------------------------------------------------------------
 const insert=(table,row)=>insertRow(d,table,row);
 const count=async statement=>Number((await d.one(statement)).n);
 const builtin={owner:'builtin-owner',uaa:'builtin-user-access-administrator'};
 const uaaRights=access.allPortalPermissions.filter(right=>right!=='portal.operator'&&right!==access.crossCustomerPermission);
 for(const [id,name,permissions] of [[builtin.owner,'Owner',['*']],[builtin.uaa,'User Access Administrator',uaaRights]])await insert('rbac_roles',{id,name,description:'',permissions:JSON.stringify(permissions),builtin:1,created_at:time});
 const assignRole=async(type,subject,role)=>{const id=uuid();await insert('role_assignments',{id,principal_type:type,principal_id:subject,role_id:role,scope_type:'global',scope_id:'*',created_at:time,created_by:'fixture'});return id;};
 const createUser=async(status,passwordHash)=>{const id=uuid();await insert('local_users',{id,username:'u'+id.slice(0,8)+id.slice(-4),email:'',display_name:'Ziel '+id.slice(0,8),auth_principal:'local:'+id,auth_email:id+'@local.serverdesk.invalid',status,password_hash:passwordHash,auth_version:1,must_reset:0,created_at:time,updated_at:time});return id;};
 const actor=async(label,role)=>{const id=await createUser('active','fixture-password');await assignRole('user',id,role);
  await insert('mfa_sessions',{token_hash:sha(id+'mfa'),principal:'local:'+id,created_at:time,last_activity:time,idle_expires_at:time+3_600_000,expires_at:time+86_400_000});
  return {id,userId:id,label,principal:'local:'+id,authorization:{authVersion:1}};};
 const owner=await actor('owner@customer-links.test',builtin.owner),owner2=await actor('owner-2@customer-links.test',builtin.owner),uaa=await actor('uaa@customer-links.test',builtin.uaa);
 const customerA='00000000-0000-4000-8000-000000000100',customerB=uuid();
 await insert('customers',{id:customerB,name:'Kunde B',created_at:time,updated_at:time});
 const assignCustomer=(customer,type,id)=>insert('customer_assignments',{customer_id:customer,principal_type:type,principal_id:id,created_at:time,created_by:owner.principal});
 const userGroup=async(enabled,{customer=null,role=null}={})=>{const id=uuid();await insert('user_groups',{id,name:'Gruppe '+id,description:'',enabled,created_at:time});if(customer)await assignCustomer(customer,'group',id);if(role)await assignRole('group',id,role);return id;};
 const member=(groupId,userId)=>insert('user_group_members',{group_id:groupId,user_id:userId});
 const group=id=>d.one(sql`SELECT name,description FROM user_groups WHERE id=${id}`);

 const invalidLink=serverText('apiError.account.invalidToken');
 const customerAction='Konto-Links wegen Kundenzuweisung verfallen',raiseAction='Konto-Links wegen Rechteanstieg verfallen';
 const post=async(who,body)=>{viewer=who;const response=await route.POST(new Request('https://customer-links.test/api/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({managementToken:uuid(),...body})}));return {status:response.status,body:await response.json()};};
 // A link issued through reset-link (by the UAA unless told otherwise); returns the raw token.
 const issue=async(userId,who=uaa)=>{const reply=await post(who,{action:'reset-link',userId});check(reply.status,200,'issue: '+JSON.stringify(reply.body));const token=/#invite=([a-f0-9]{64})$/.exec(reply.body.invitationUrl)?.[1];assert.ok(token,'issue: token in the URL');return token;};
 const open=async token=>{const reply=await post(null,{action:'invitation-info',token});return {status:reply.status,code:reply.body.code??null,valid:reply.body.valid??null,error:reply.body.error??null};};
 const tokens=async()=>(await d.query(sql`SELECT token_hash,user_id,kind,used_at FROM local_account_tokens ORDER BY token_hash`));
 const openTokens=userId=>count(sql`SELECT count(*) AS n FROM local_account_tokens WHERE user_id=${userId} AND used_at IS NULL`);
 const account=userId=>d.one(sql`SELECT status,auth_version,updated_at,password_hash FROM local_users WHERE id=${userId}`);
 const linkAudits=()=>count(sql`SELECT count(*) AS n FROM audit WHERE action IN (${customerAction},${raiseAction})`);
 const auditsFor=(userId,action)=>count(sql`SELECT count(*) AS n FROM audit WHERE action=${action} AND target=${userId}`);
 const proof=async who=>{const token=uuid();await insert('mfa_management_proofs',{token_hash:token,principal:who.principal,session_hash:sha(who.id+'mfa'),expires_at:Date.now()+300_000});return token;};
 const proofLeft=token=>count(sql`SELECT count(*) AS n FROM mfa_management_proofs WHERE token_hash=${token}`);
 const authorize=async(who,token)=>{viewer=who;return rbac.prepareManagementAuthorization(new Request('https://customer-links.test/api/rbac'),who,token??await proof(who));};
 const manage=async(who,payload,token)=>rbac.manageRbac(who,payload,await authorize(who,token));
 const enable=async(who,groupId,enabled=true)=>{const row=await group(groupId);return manage(who,{action:'update-group',id:groupId,name:row.name,description:row.description,enabled});};
 // The stored technicians of a customer plus `add`, minus `remove`, at the current revision.
 const stored=async customerId=>(await d.query(sql`SELECT principal_type,principal_id FROM customer_assignments WHERE customer_id=${customerId}`));
 const revision=async customerId=>Number((await d.one(sql`SELECT revision FROM customers WHERE id=${customerId}`)).revision);
 // Each refusal as [status, code, message key] (lib/errors/api-error-keys.ts).
 const refused={
  invalidLink:[400,'INVALID_ACCOUNT_TOKEN','apiError.account.invalidToken'],
  concurrent:[409,'CONFLICT','apiError.customer.concurrent'],
  ownerOnly:[403,'FORBIDDEN','apiError.customer.ownerOnly'],
  proofUsed:[403,'MFA_STEP_UP_REQUIRED','apiError.mfa.confirmationUsed'],
  targetBoundary:[403,'FORBIDDEN','apiError.access.targetCustomerBoundary'],
 };
 const keyed=reply=>[reply.status,reply.body.code,reply.body.messageKey];
 // A refusal is a keyed HttpError: status, code and message key, as the answer body carries them.
 const rejects=async(promise,[status,code,key],label)=>{await assert.rejects(promise,error=>{assert.ok(error instanceof HttpError,label+': '+error);assert.deepEqual([error.status,error.code,error.messageKey],[status,code,key],label);return true;},label);checks++;};
 const technicianInput=async(customerId,{users=[],groups=[],removeUsers=[],removeGroups=[]}={})=>{const rows=await stored(customerId),of=(type,drop)=>rows.filter(row=>row.principal_type===type&&!drop.includes(row.principal_id)).map(row=>row.principal_id);
  return {userIds:[...of('user',removeUsers),...users],groupIds:[...of('group',removeGroups),...groups],revision:await revision(customerId)};};
 // lib/server/identity/policy/can.ts caches its answer per Viewer object: each request gets a fresh copy, as in the portal.
 const setTechnicians=async(who,customerId,change,token,input)=>{const request={...who};return admin.setCustomerTechnicians(request,customerId,input??await technicianInput(customerId,change),await authorize(request,token));};

 // A fresh invited account with an open invite link and a fresh active account
 // with an open reset link, both checked as valid before the gain.
 const fresh=async()=>{
  const invited=await createUser('invited',null),active=await createUser('active','fixture-password'),links={[invited]:await issue(invited),[active]:await issue(active)};
  for(const token of Object.values(links))check(await open(token),{status:200,code:null,valid:true,error:null},'before the gain the link is valid');
  return {ids:[invited,active],links,accounts:{[invited]:await account(invited),[active]:await account(active)}};
 };
 // Both links die, the account row is unchanged and the account has exactly one
 // audit row of `action` (customer gain by default) and none of the other one.
 const voided=async(pair,label,action=customerAction)=>{for(const userId of pair.ids){
  check(await open(pair.links[userId]),{status:400,code:'INVALID_ACCOUNT_TOKEN',valid:null,error:invalidLink},label+': the link dies');
  check(await account(userId),pair.accounts[userId],label+': the account row is unchanged');
  check(await openTokens(userId),0,label+': no open link is left');
  check([await auditsFor(userId,customerAction),await auditsFor(userId,raiseAction)],action===customerAction?[1,0]:[0,1],label+': one audit row for the account');
 }};
 const alive=async(pair,label)=>{for(const userId of pair.ids)check((await open(pair.links[userId])).status,200,label+': the link stays valid');};
 // Nothing voided and no voided-links audit row.
 const unchanged=async(label,run)=>{const before=await tokens(),audits=await linkAudits();await run();check([await tokens(),await linkAudits()],[before,audits],label+': no token changed, no audit row');};
 // Every positive case keeps a bystander: its links must survive every gain.
 const bystander=await fresh();

 // ---- Before the UAA sees only A: add-member and enabling ---------
 {
  // Case 3/5 before: the Owner adds members to an enabled and a disabled group of B.
  for(const enabled of [1,0]){const groupId=await userGroup(enabled,{customer:customerB}),joined=await fresh();
   for(const userId of joined.ids)await manage(owner,{action:'add-member',groupId,userId});
   await voided(joined,`before: add-member to an ${enabled?'enabled':'disabled'} group of B`);}
  // Case 4 before: enabling a disabled group of B voids all members.
  const off=await userGroup(0,{customer:customerB}),members=await fresh();for(const userId of members.ids)await member(off,userId);
  await enable(owner,off);await voided(members,'before: enabling a group of B');
  // Case 7: a group with an Owner role and a customer: only the raise row.
  const privileged=await userGroup(1,{customer:customerB,role:builtin.owner}),both=await fresh();
  for(const userId of both.ids)await manage(owner,{action:'add-member',groupId:privileged,userId});
  await voided(both,'before: add-member to a group with an Owner role and a customer',raiseAction);
  // A group without customer voids nothing, before as after.
  const bare=await userGroup(0),plain=await fresh();
  await unchanged('before: add-member to a group without customer',async()=>{for(const userId of plain.ids)await manage(owner,{action:'add-member',groupId:bare,userId});});
  await unchanged('before: enabling a group without customer',()=>enable(owner,bare));
  await alive(plain,'before: a group without customer');
  // Race (a): a link that becomes open right before the add-member batch dies with it.
  const late=await createUser('active','fixture-password'),raced=await userGroup(1,{customer:customerB});
  beforeBatch(()=>insert('local_account_tokens',{token_hash:'late-'+late,user_id:late,kind:'reset',created_at:time,expires_at:time+3_600_000,auth_version:1}));
  await manage(owner,{action:'add-member',groupId:raced,userId:late});check(hook,null,'race (a) add-member: the hook ran');
  check([await openTokens(late),await auditsFor(late,customerAction)],[0,1],'race (a) add-member: the late link is voided and audited');
  // Atomicity: a failing voiding statement rolls the membership back and keeps the proof.
  const target=await createUser('active','fixture-password'),atomic=await userGroup(1,{customer:customerB});await issue(target);
  const before=await tokens(),token=await proof(owner);
  await createTrigger(d,'customer_boom','local_account_tokens','BEFORE UPDATE',{message:'boom'});
  try{await assert.rejects(manage(owner,{action:'add-member',groupId:atomic,userId:target},token),/boom/,'atomicity add-member: the change fails');checks++;}
  finally{await dropTrigger(d,'customer_boom');}
  check([await count(sql`SELECT count(*) AS n FROM user_group_members WHERE group_id=${atomic}`),await proofLeft(token),await tokens()],[0,1,before],'atomicity add-member: no membership, the proof stays, no token changed');
 }

 // ---- The UAA sees only customer A from now on ----------------------------------
 await assignCustomer(customerA,'user',uaa.id);

 // ---- After: add-member, enabling ---------------------
 {
  // Case 3/5 after: add-member to an enabled and a disabled group of B.
  for(const on of [1,0]){const groupId=await userGroup(on,{customer:customerB}),joined=await fresh();
   for(const userId of joined.ids)await manage(owner,{action:'add-member',groupId,userId});
   await voided(joined,`after: add-member to an ${on?'enabled':'disabled'} group of B`);}
  // Case 4 after: enabling.
  const off=await userGroup(0,{customer:customerB}),members=await fresh();for(const userId of members.ids)await member(off,userId);
  await enable(owner,off);await voided(members,'after: enabling a group of B');
 }

 // ---- set-technicians: a gain voids the open links --------------------------
 {
  // Case 1 and 6: a direct assignment to B; the Owner issues a new link, the old ones stay dead.
  const pair=await fresh();
  await setTechnicians(owner,customerB,{users:pair.ids});
  await voided(pair,'after: set-technicians adds users to B');
  const [invited,active]=pair.ids,password=(await account(invited)).password_hash;
  const redeem=await post(null,{action:'redeem',token:pair.links[invited],username:'neu-'+invited.slice(0,8),password:'ein-langes-passwort'});
  check(keyed(redeem),refused.invalidLink,'redeem with a voided invite link fails');
  check((await account(invited)).password_hash,password,'redeem with a voided link sets no password');
  const reset=await post(null,{action:'redeem',token:pair.links[active],username:'x',password:'ein-langes-passwort'});
  check(keyed(reset),refused.invalidLink,'redeem with a voided reset link fails');
  check(keyed(await post(uaa,{action:'reset-link',userId:active})),refused.targetBoundary,'the UAA who sees only A may not issue a link for an account of B (078)');
  for(const userId of pair.ids)check(await open(await issue(userId,owner)),{status:200,code:null,valid:true,error:null},'a new link by the Owner works');
  // An account of A: the UAA who sees A issues the new link.
  const ofA=await fresh();
  await setTechnicians(owner,customerA,{users:ofA.ids});await voided(ofA,'after: set-technicians adds users to A');
  for(const userId of ofA.ids)check((await open(await issue(userId,uaa))).status,200,'a new link by the UAA who sees A works');

  // Case 2: an enabled group with two members and a disabled group with one member; a non-member keeps its links.
  const enabled=await userGroup(1),disabled=await userGroup(0),two=await fresh(),one=await fresh(),outsider=await fresh();
  for(const userId of two.ids)await member(enabled,userId);await member(disabled,one.ids[0]);
  await setTechnicians(owner,customerB,{groups:[enabled,disabled]});
  await voided(two,'after: set-technicians adds an enabled group');await voided({...one,ids:[one.ids[0]]},'after: set-technicians adds a disabled group');
  await alive({...one,ids:[one.ids[1]]},'after: not a member of the added groups');await alive(outsider,'after: a non-member');


 }

 // ---- Changes that give no customer leave links alone ---------------------
 {
  // Removing through the core path voids nothing. The users of B are set by SQL.
  const pair=await fresh();
  for(const userId of pair.ids)await assignCustomer(customerB,'user',userId);
  for(const userId of pair.ids)pair.links[userId]=await issue(userId,owner);
  await unchanged('removeCustomerTechnicians',async()=>technicians.removeCustomerTechnicians(owner,customerB,await technicianInput(customerB,{removeUsers:pair.ids}),await authorize(owner)));
  check(await count(sql`SELECT count(*) AS n FROM customer_assignments WHERE principal_id IN (${pair.ids[0]},${pair.ids[1]})`),0,'both users are removed');
  await alive(pair,'removals');
  // Groups without customer; disabling and renaming a customer group.
  const bare=await userGroup(0),plain=await fresh();
  await unchanged('after: add-member to a group without customer',async()=>{for(const userId of plain.ids)await manage(owner,{action:'add-member',groupId:bare,userId});});
  await unchanged('after: enabling a group without customer',()=>enable(owner,bare));
  const customerGroup=await userGroup(1,{customer:customerB}),inside=await fresh();for(const userId of inside.ids){await member(customerGroup,userId);inside.links[userId]=await issue(userId,owner);}
  await unchanged('renaming an enabled customer group',()=>manage(owner,{action:'update-group',id:customerGroup,name:'Umbenannt '+customerGroup,description:'Neu',enabled:true}));
  await unchanged('disabling a customer group',()=>enable(owner,customerGroup,false));
  await unchanged('renaming a disabled customer group',()=>manage(owner,{action:'update-group',id:customerGroup,name:'Wieder '+customerGroup,description:'',enabled:false}));
  await alive(plain,'groups without customer');await alive(inside,'renaming and disabling');
 }

 // ---- set-technicians changes that give no customer leave links alone ---------------
 {
  // Remove-only through set-technicians and through the remove path; the same set again.
  const pair=await fresh();
  await setTechnicians(owner,customerB,{users:pair.ids});await voided(pair,'set-up: users of B');
  for(const userId of pair.ids)pair.links[userId]=await issue(userId,owner);
  await unchanged('the same set again',()=>setTechnicians(owner,customerB));
  await unchanged('remove-only set-technicians',()=>setTechnicians(owner,customerB,{removeUsers:[pair.ids[0]]}));
  await unchanged('removeCustomerTechnicians',async()=>technicians.removeCustomerTechnicians(owner,customerB,await technicianInput(customerB,{removeUsers:[pair.ids[1]]}),await authorize(owner)));
  check(await count(sql`SELECT count(*) AS n FROM customer_assignments WHERE principal_id IN (${pair.ids[0]},${pair.ids[1]})`),0,'both users are removed');
  await alive(pair,'removals');
  // Refused set-technicians before the batch: a stale revision, a non-Owner.
  const target=await fresh();
  await unchanged('stale revision',async()=>rejects(setTechnicians(owner,customerB,null,undefined,{...await technicianInput(customerB,{users:target.ids}),revision:-1}),refused.concurrent,'stale revision'));
  await unchanged('non-Owner',()=>rejects(setTechnicians(uaa,customerB,{users:target.ids}),refused.ownerOnly,'non-Owner'));
  // Refused in the batch: revision, Owner right or proof change before the commit.
  const ownerAssignment=async()=>(await d.one(sql`SELECT id FROM role_assignments WHERE principal_type=${'user'} AND principal_id=${owner2.id} AND role_id=${builtin.owner}`)).id;
  for(const [label,expected,change] of [
   ['customer revision',refused.concurrent,()=>d.exec(sql`UPDATE customers SET revision=revision+1 WHERE id=${customerB}`)],
   ['Owner right',refused.ownerOnly,async()=>d.exec(sql`DELETE FROM role_assignments WHERE id=${await ownerAssignment()}`)],
   ['proof',refused.proofUsed,()=>d.exec(sql`DELETE FROM mfa_management_proofs WHERE principal=${owner2.principal}`)],
  ]){
   const input=await technicianInput(customerB,{users:target.ids});
   await unchanged('refused batch: '+label,async()=>{beforeBatch(change);await rejects(setTechnicians(owner2,customerB,null,undefined,input),expected,'refused batch: '+label);check(hook,null,'refused batch: '+label+': the hook ran');});
   check(await count(sql`SELECT count(*) AS n FROM customer_assignments WHERE principal_id IN (${target.ids[0]},${target.ids[1]})`),0,'refused batch: '+label+': no assignment row');
   if(label==='Owner right')await assignRole('user',owner2.id,builtin.owner);
  }
  await alive(target,'refused set-technicians');
  // A refused batch voids nothing even when the row it would add exists meanwhile
  // (written by a concurrent change that voided nothing): the voiding carries the guard.
  {
   const input=await technicianInput(customerB,{users:target.ids});
   await unchanged('refused batch, row present',async()=>{beforeBatch(async()=>{await d.exec(sql`UPDATE customers SET revision=revision+1 WHERE id=${customerB}`);await d.exec(sql`INSERT INTO customer_assignments(customer_id,principal_type,principal_id,created_at,created_by) VALUES(${customerB},${'user'},${target.ids[0]},${time},${'fixture'})`);});
    await rejects(setTechnicians(owner,customerB,null,undefined,input),refused.concurrent,'refused batch, row present');check(hook,null,'refused batch, row present: the hook ran');});
   await alive(target,'refused batch, row present');
   await d.exec(sql`DELETE FROM customer_assignments WHERE principal_id=${target.ids[0]}`);
  }
  // A used token keeps its used_at.
  const used=await createUser('active','fixture-password');await insert('local_account_tokens',{token_hash:'used-'+used,user_id:used,kind:'reset',created_at:time,expires_at:time+3_600_000,auth_version:1,used_at:time-5});
  await setTechnicians(owner,customerB,{users:[used]});
  check([(await d.one(sql`SELECT used_at FROM local_account_tokens WHERE token_hash=${'used-'+used}`)).used_at,await auditsFor(used,customerAction)],[time-5,0],'a used token keeps its used_at and gets no audit row');
 }

 // ---- Races between issuing and assigning ---------------------------------------
 {
  // (b) the UAA (sees A) issues a link while the account gets B, directly or
  // through its group; (c) the same with the Owner, whose link is issued after
  // the gain by someone who sees B.
  const gainingAccount=async variant=>{const userId=await createUser('active','fixture-password');
   if(variant==='direct'){beforeBatch(()=>assignCustomer(customerB,'user',userId));return userId;}
   const groupId=await userGroup(1);await member(groupId,userId);beforeBatch(()=>assignCustomer(customerB,'group',groupId));return userId;};
  for(const variant of ['direct','group']){
   const userId=await gainingAccount(variant),reply=await post(uaa,{action:'reset-link',userId});check(hook,null,`race (b) ${variant}: the hook ran`);
   check([reply.status,reply.body.error],[403,access.targetCustomerBoundaryMessage],`race (b) ${variant}: the UAA is refused`);
   check(await openTokens(userId),0,`race (b) ${variant}: no open link`);
  }
  for(const variant of ['direct','group']){
   const userId=await gainingAccount(variant),token=await issue(userId,owner);check(hook,null,`race (c) ${variant}: the hook ran`);
   check((await open(token)).status,200,`race (c) ${variant}: the Owner's link is valid`);
  }
 }

 // ---- Races of set-technicians -----------------------------------------------------
 {
  // (a) set-technicians: a link that becomes open right before the batch dies with it.
  const late=await createUser('active','fixture-password');
  beforeBatch(()=>insert('local_account_tokens',{token_hash:'late-'+late,user_id:late,kind:'reset',created_at:time,expires_at:time+3_600_000,auth_version:1}));
  await setTechnicians(owner,customerB,{users:[late]});check(hook,null,'race (a) set-technicians: the hook ran');
  check([await openTokens(late),await auditsFor(late,customerAction)],[0,1],'race (a) set-technicians: the late link is voided and audited');
 }

 // ---- Atomicity of set-technicians ------------------------------------------
 {
  const target=await createUser('active','fixture-password');await issue(target,owner);
  const before=await tokens(),token=await proof(owner),input=await technicianInput(customerB,{users:[target]});
  await createTrigger(d,'customer_boom','local_account_tokens','BEFORE UPDATE',{message:'boom'});
  try{await assert.rejects(setTechnicians(owner,customerB,null,token,input),/boom/,'atomicity set-technicians: the change fails');checks++;}
  finally{await dropTrigger(d,'customer_boom');}
  check([await count(sql`SELECT count(*) AS n FROM customer_assignments WHERE principal_id=${target}`),await revision(customerB),await proofLeft(token),await tokens()],[0,input.revision,1,before],'atomicity set-technicians: no assignment, revision unchanged, the proof stays, no token changed');
 }
 await alive(bystander,'bystander after every gain');
 console.log(`customer-link-tokens: ${checks} checks passed`);
}finally{d.close();}
