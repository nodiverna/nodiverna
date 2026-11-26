// Open account links die when an account gains a privileged role:
// manageRbac (add-assignment, add-member, update-group, update-role) against the
// real lib/server/identity/access.ts, lib/server/identity/rbac.ts and app/api/auth/route.ts on an isolated PostgreSQL
// test database. Links are issued through reset-link and checked through invitation-info
// and redeem. A second customer switches the customer boundary on, as in
// tests/api/account-dominance.mjs and tests/api/cross-customer-actions.mjs.
import {serverText} from '../support/server-text.mjs';
import {HttpError as realHttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFileSync} from 'node:fs';
import {sourceDatabase,sourceLoader,insertRow,createTrigger,dropTrigger} from '../support/source-database.mjs';

import {sql} from '../../runtime/database.mjs';

import {hookDatabase} from '../support/hooked-database.mjs';
import {enableMultipleCustomers,separateCustomers} from '../support/customer-separation.mjs';
const d=await sourceDatabase();
let checks=0;
const check=(value,expectedValue,label)=>{assert.deepEqual(value,expectedValue,label);checks++;};
try{
 const time=Date.now(),uuid=()=>crypto.randomUUID(),sha=value=>crypto.createHash('sha256').update(value).digest('hex');
 const HttpError=realHttpError;
 // The hook runs once, right before the next batch (the committing one of the action).
 let viewer=null,beforeBatch=null;
 const facade=hookDatabase(d,{transaction:async()=>{if(beforeBatch){const hook=beforeBatch;beforeBatch=null;await hook();}}});
 const server={db:()=>facade,now:()=>Date.now(),config:()=>'',random:()=>crypto.randomBytes(32).toString('hex'),hash:async value=>sha(value),guid:x=>typeof x==='string'&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(x),HttpError,
  body:request=>request.json(),sameOrigin:()=>{},requireViewer:async()=>viewer,log:async()=>{},
  failure:error=>Response.json({error:error instanceof HttpError?error.message:serverText('apiError.storageUnavailable'),...(error instanceof HttpError&&error.code?{code:error.code}:{})},{status:error instanceof HttpError?error.status:503})};
 // Routine writes (lib/step-up.ts) commit behind the live-session fence.
 const mfa={requireLiveSessions:async()=>{},mfaSessionFence:async(request,actor)=>localAuth.primaryGuard(request,actor),isMfaEnabled:async()=>true,requireMfa:async()=>{},readMfaManagementProof:async(_request,actor,token)=>({tokenHash:token,key:actor.principal,sessionHash:sha(actor.id+'mfa'),guard:sql`TRUE`}),
  clearMfaSessionCookie:()=>'mfa=; Max-Age=0',clearMfaTrustCookie:()=>'trust=; Max-Age=0'};
 const load=sourceLoader();
 const localAuth={primaryGuard:async(_request,actor)=>load('lib/server/identity/access.ts').viewerWriteGuard(actor),clearLocalAuthCookie:()=>'auth=; Max-Age=0',
  rateLimit:async()=>{},username:value=>{if(typeof value!=='string'||!value)throw new HttpError(400,'Benutzername fehlt.');return value;},hashNewPassword:async value=>'hashed:'+value,userViewer:async user=>({id:user.id}),
  revocationStatements:(user,guard=sql`TRUE`)=>[sql`DELETE FROM local_auth_sessions WHERE user_id=${user.id} AND (${guard})`]};
 const imports={'../context':server,'./context':server,'../../context':server,'@/lib/server/context':server,'./mfa':mfa,'@/lib/server/identity/mfa':mfa,'./local-auth':localAuth,'@/lib/server/identity/local-auth':localAuth,'@/lib/server/identity/passwords':{verifyPassword:async()=>false}};
 const access=load('lib/server/identity/access.ts',imports),rbac=load('lib/server/identity/rbac.ts',imports),route=load('app/api/auth/route.ts',imports);

 // ---- Static checks -----------------------------------------------------
 const rbacSource=readFileSync('lib/server/identity/rbac.ts','utf8');
 check(rbacSource.split('UPDATE local_account_tokens').length-1,1,'UPDATE local_account_tokens occurs once in lib/server/identity/rbac.ts');
 check(rbacSource.includes('privileged_right'),false,'lib/server/identity/rbac.ts does not copy privilegedRoleSql');
 const manageStart=rbacSource.indexOf('export async function manageRbac(');assert.ok(manageStart>0,'manageRbac');
 for(const action of ['add-assignment','add-member','update-group','update-role']){
  const start=rbacSource.indexOf(`if(p.action==='${action}'`,manageStart),end=rbacSource.indexOf('\n }',start);
  assert.ok(start>0,action);check(rbacSource.slice(start,end).includes('voidOpenTokens('),true,action+' references voidOpenTokens');
 }

 // ---- Fixture --------------------------------------------------------------------
 const insert=(table,row)=>insertRow(d,table,row);
 const builtin={owner:'builtin-owner',reader:'builtin-reader',uaa:'builtin-user-access-administrator'};
 const uaaRights=access.allPortalPermissions.filter(right=>right!=='portal.operator'&&right!==access.crossCustomerPermission);
 for(const [id,name,permissions] of [[builtin.owner,'Owner',['*']],[builtin.reader,'Reader',access.rolePermissions.viewer],[builtin.uaa,'User Access Administrator',uaaRights]])await insert('rbac_roles',{id,name,description:'',permissions:JSON.stringify(permissions),builtin:1,created_at:time});
 const assignRole=async(type,subject,role,scopeType='global',scopeId='*')=>{const id=uuid();await insert('role_assignments',{id,principal_type:type,principal_id:subject,role_id:role,scope_type:scopeType,scope_id:scopeId,created_at:time,created_by:'fixture'});return id;};
 const createUser=async(status,passwordHash)=>{const id=uuid();await insert('local_users',{id,username:'u'+id.slice(0,8)+id.slice(-4),email:'',display_name:'Ziel '+id.slice(0,8),auth_principal:'local:'+id,auth_email:id+'@local.serverdesk.invalid',status,password_hash:passwordHash,auth_version:1,must_reset:0,created_at:time,updated_at:time});return id;};
 const actor=async(label,role)=>{const id=await createUser('active','fixture-password');await assignRole('user',id,role);
  await insert('mfa_sessions',{token_hash:sha(id+'mfa'),principal:'local:'+id,created_at:time,last_activity:time,idle_expires_at:time+3_600_000,expires_at:time+86_400_000});
  return {id,userId:id,label,principal:'local:'+id,authorization:{authVersion:1}};};
 const customRole=async permissions=>{const id=uuid();await insert('rbac_roles',{id,name:'Rolle '+id,description:'',permissions:JSON.stringify(permissions),builtin:0,created_at:time});return id;};
 const userGroup=async(enabled,role)=>{const id=uuid();await insert('user_groups',{id,name:'Gruppe '+id,description:'',enabled,created_at:time});if(role)await assignRole('group',id,role);return id;};
 const member=(groupId,userId)=>insert('user_group_members',{group_id:groupId,user_id:userId});
 const owner=await actor('owner@raise.test',builtin.owner),owner2=await actor('owner-2@raise.test',builtin.owner),uaa=await actor('uaa@raise.test',builtin.uaa);
 const deviceGroup=uuid(),device=uuid();
 await insert('device_groups',{id:deviceGroup,name:'Standort',description:'',created_at:time});
 await insert('servers',{id:device,name:'Server 1',token_hash:'fixture-'+device,created_at:time,last_seen:time,management:1,snapshot:'{}'});

 const ownerOnly=rbac.privilegedRoleOwnerOnlyMessage,invalidLink=serverText('apiError.account.invalidToken');
 const post=async(who,body)=>{viewer=who;const response=await route.POST(new Request('https://raise.test/api/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({managementToken:uuid(),...body})}));return {status:response.status,body:await response.json()};};
 // A link issued through reset-link (by the UAA unless told otherwise); returns the raw token.
 const issue=async(userId,who=uaa)=>{const reply=await post(who,{action:'reset-link',userId});check(reply.status,200,'issue: '+JSON.stringify(reply.body));const token=/#invite=([a-f0-9]{64})$/.exec(reply.body.invitationUrl)?.[1];assert.ok(token,'issue: token in the URL');return token;};
 const open=async token=>{const reply=await post(null,{action:'invitation-info',token});return {status:reply.status,code:reply.body.code??null,valid:reply.body.valid??null,error:reply.body.error??null};};
 const tokens=async()=>(await d.query(sql`SELECT token_hash,user_id,kind,used_at FROM local_account_tokens ORDER BY token_hash`));
 const account=userId=>d.one(sql`SELECT status,auth_version,updated_at,password_hash FROM local_users WHERE id=${userId}`);
 const proof=async who=>{const token=uuid();await insert('mfa_management_proofs',{token_hash:token,principal:who.principal,session_hash:sha(who.id+'mfa'),expires_at:Date.now()+300_000});return token;};
 const manageWith=async(who,payload,token)=>{viewer=who;return rbac.manageRbac(who,payload,await rbac.prepareManagementAuthorization(new Request('https://raise.test/api/rbac'),who,token));};
 const manage=async(who,payload)=>manageWith(who,payload,await proof(who));
 const rejects=async(promise,status,message,label)=>{await assert.rejects(promise,error=>{assert.equal(error.status,status,label+': '+error.message);if(message)assert.equal(error.message,message,label);return true;},label);checks++;};
 const separate=async()=>{await d.exec(enableMultipleCustomers());await d.exec(separateCustomers(time));};
 const assignment=(subjectType,subjectId,roleId,scopeType='global',scopeId='*')=>({action:'add-assignment',subjectType,subjectId,roleId,scopeType,scopeId});

 // A fresh invited account with an open invite link and a fresh active account
 // with an open reset link, both checked as valid before the raise.
 const fresh=async()=>{
  const invited=await createUser('invited',null),active=await createUser('active','fixture-password'),links={[invited]:await issue(invited),[active]:await issue(active)};
  for(const token of Object.values(links))check(await open(token),{status:200,code:null,valid:true,error:null},'before the raise the link is valid');
  return {ids:[invited,active],links,accounts:{[invited]:await account(invited),[active]:await account(active)}};
 };
 const voided=async(pair,label)=>{for(const userId of pair.ids){
  check(await open(pair.links[userId]),{status:400,code:'INVALID_ACCOUNT_TOKEN',valid:null,error:invalidLink},label+': the link dies');
  check(await account(userId),pair.accounts[userId],label+': the account row is unchanged');
  check((await d.one(sql`SELECT count(*) AS n FROM local_account_tokens WHERE user_id=${userId} AND used_at IS NULL`)).n,0,label+': no open link is left');
 }};
 const alive=async(pair,label)=>{for(const userId of pair.ids)check((await open(pair.links[userId])).status,200,label+': the link stays valid');};
 // Every positive case keeps a bystander: its link must survive the raise.
 const bystander=await fresh();

 // ---- With only the default customer, by an Owner ---------
 // Only an Owner grants privileged roles, also with only the default customer.
 {
  const pair=await fresh();
  for(const userId of pair.ids)await manage(owner,assignment('user',userId,builtin.owner));
  await voided(pair,'before: Owner assigns Owner globally');
  const enabled=await userGroup(1,builtin.owner),disabled=await userGroup(0,builtin.owner);
  for(const groupId of [enabled,disabled]){const joined=await fresh();for(const userId of joined.ids)await manage(owner,{action:'add-member',groupId,userId});await voided(joined,`before: Owner adds a member to an ${groupId===enabled?'enabled':'disabled'} Owner group`);}
  const crossRole=await customRole([access.crossCustomerPermission]),cross=await fresh();
  for(const userId of cross.ids)await manage(owner,assignment('user',userId,crossRole));
  await voided(cross,'before: Owner assigns a crossCustomer role');
  // Enabling, raising a role and a devicegroup scope by the Owner.
  const groupId=await userGroup(0,builtin.owner),members=await fresh();for(const userId of members.ids)await member(groupId,userId);
  const group=await d.one(sql`SELECT name,description FROM user_groups WHERE id=${groupId}`);
  await manage(owner,{action:'update-group',id:groupId,name:group.name,description:group.description,enabled:true});await voided(members,'before: Owner enables an Owner group');
  const roleId=await customRole(['portal.users.manage']),holders=await fresh();for(const userId of holders.ids)await assignRole('user',userId,roleId);
  await manage(owner,{action:'update-role',id:roleId,name:'Rolle '+roleId,description:'',permissions:['portal.users.manage',access.crossCustomerPermission]});await voided(holders,'before: Owner raises a role');
  const scoped=await fresh();for(const userId of scoped.ids)await manage(owner,assignment('user',userId,builtin.owner,'devicegroup',deviceGroup));await voided(scoped,'before: Owner assigns Owner on a devicegroup');
  // A token that was already used keeps its used_at.
  const used=await createUser('active','fixture-password');await insert('local_account_tokens',{token_hash:'used-'+used,user_id:used,kind:'reset',created_at:time,expires_at:time+3_600_000,auth_version:1,used_at:time-5});
  await manage(owner,assignment('user',used,builtin.owner));
  check((await d.one(sql`SELECT used_at FROM local_account_tokens WHERE token_hash=${'used-'+used}`)).used_at,time-5,'an already used token keeps its used_at');
 }

 // ---- Refusals: race with one customer -----------------------------------
 {
  // The second Owner loses its Owner assignment between pre-check and commit (a UAA is refused before that).
  const pair=await fresh(),before=await tokens(),[userId]=pair.ids;
  const ownerAssignment=(await d.one(sql`SELECT id FROM role_assignments WHERE principal_type='user' AND principal_id=${owner2.id} AND role_id=${builtin.owner}`)).id;
  beforeBatch=()=>d.exec(sql`DELETE FROM role_assignments WHERE id=${ownerAssignment}`);
  await rejects(manage(owner2,assignment('user',userId,builtin.owner)),403,ownerOnly,'race: the Owner loses its right before the commit');
  check(beforeBatch,null,'race: the hook ran');
  check((await d.one(sql`SELECT count(*) AS n FROM role_assignments WHERE principal_id=${userId}`)).n,0,'race: no assignment');
  check(await tokens(),before,'race: no token changed');
  await alive(pair,'race');
  await assignRole('user',owner2.id,builtin.owner);
 }

 // ---- Atomicity --------------------------------------------------------------
 {
  const pair=await fresh(),before=await tokens(),[userId]=pair.ids,token=await proof(owner);
  await createTrigger(d,'raise_boom','local_account_tokens','BEFORE UPDATE',{message:'boom'});
  try{await assert.rejects(manageWith(owner,assignment('user',userId,builtin.owner),token),/boom/,'atomicity: the failing voiding statement fails the change');checks++;}
  finally{await dropTrigger(d,'raise_boom');}
  check((await d.one(sql`SELECT count(*) AS n FROM role_assignments WHERE principal_id=${userId}`)).n,0,'atomicity: no assignment');
  check((await d.one(sql`SELECT count(*) AS n FROM mfa_management_proofs WHERE token_hash=${token}`)).n,1,'atomicity: the proof is not consumed');
  check(await tokens(),before,'atomicity: no token changed');
  await alive(pair,'atomicity');
 }

 await separate();

 // ---- With a second customer, by an Owner ------
 {
  // Case 1, 9, 10: global Owner to a user; a new link by an Owner works.
  const pair=await fresh();
  for(const userId of pair.ids)await manage(owner,assignment('user',userId,builtin.owner));
  await voided(pair,'after: Owner assigns Owner globally');
  const [invited,active]=pair.ids,password=(await account(invited)).password_hash;
  const redeem=await post(null,{action:'redeem',token:pair.links[invited],username:'neu-'+invited.slice(0,8),password:'ein-langes-passwort'});
  check([redeem.status,redeem.body.code,redeem.body.error],[400,'INVALID_ACCOUNT_TOKEN',invalidLink],'redeem with a voided invite link fails');
  check((await account(invited)).password_hash,password,'redeem with a voided link sets no password');
  const reset=await post(null,{action:'redeem',token:pair.links[active],username:'x',password:'ein-langes-passwort'});
  check([reset.status,reset.body.code],[400,'INVALID_ACCOUNT_TOKEN'],'redeem with a voided reset link fails');
  check((await post(uaa,{action:'reset-link',userId:active})).status,403,'after: the UAA may not issue a link for the new Owner (034)');
  for(const userId of pair.ids)check((await open(await issue(userId,owner2))).status,200,'after: a new link by an Owner works');

  // Case 2: devicegroup and device scopes.
  for(const [scopeType,scopeId] of [['devicegroup',deviceGroup],['device',device]]){const scoped=await fresh();for(const userId of scoped.ids)await manage(owner,assignment('user',userId,builtin.owner,scopeType,scopeId));await voided(scoped,`after: Owner on a ${scopeType} scope`);}

  // Case 3: a custom role holding crossCustomer.
  const crossRole=await customRole([access.crossCustomerPermission]),cross=await fresh();
  for(const userId of cross.ids)await manage(owner,assignment('user',userId,crossRole));
  await voided(cross,'after: a crossCustomer role');

  // Case 4: Owner to an enabled group with two members and to a disabled group.
  for(const enabled of [1,0]){
   const groupId=await userGroup(enabled),members=await fresh(),outsider=await fresh();for(const userId of members.ids)await member(groupId,userId);
   await manage(owner,assignment('group',groupId,builtin.owner));
   await voided(members,`after: Owner to an ${enabled?'enabled':'disabled'} group`);await alive(outsider,'after: a non-member');
  }

  // Case 5: add-member to an enabled and a disabled Owner group.
  for(const enabled of [1,0]){const groupId=await userGroup(enabled,builtin.owner),joined=await fresh();for(const userId of joined.ids)await manage(owner,{action:'add-member',groupId,userId});await voided(joined,`after: Owner adds a member to an ${enabled?'enabled':'disabled'} Owner group`);}

  // Case 6: enabling a disabled Owner group voids all members.
  {const groupId=await userGroup(0,builtin.owner),members=await fresh();for(const userId of members.ids)await member(groupId,userId);
   const group=await d.one(sql`SELECT name,description FROM user_groups WHERE id=${groupId}`);
   await manage(owner,{action:'update-group',id:groupId,name:group.name,description:group.description,enabled:true});await voided(members,'after: enabling an Owner group');}

  // Case 7: a role becomes privileged; a direct holder, an enabled-group holder and a disabled-group holder.
  {const roleId=await customRole(['portal.users.manage']),direct=await fresh(),viaGroup=await fresh(),viaDisabled=await fresh();
   for(const userId of direct.ids)await assignRole('user',userId,roleId);
   for(const [pair,enabled] of [[viaGroup,1],[viaDisabled,0]]){const groupId=await userGroup(enabled,roleId);for(const userId of pair.ids)await member(groupId,userId);}
   await manage(owner,{action:'update-role',id:roleId,name:'Rolle '+roleId,description:'',permissions:['portal.users.manage',access.crossCustomerPermission]});
   await voided(direct,'after: role raised, direct holder');await voided(viaGroup,'after: role raised, enabled group holder');await voided(viaDisabled,'after: role raised, disabled group holder');}
 }

 // ---- Non-privileged changes leave links alone ---------------------
 const unchanged=async(label,run)=>{const before=await tokens();await run();check(await tokens(),before,label+': no token changed');};
 {
  const viewRole=await customRole(['view']),pair=await fresh();
  await unchanged('Reader assignment',async()=>{for(const userId of pair.ids)await manage(owner,assignment('user',userId,builtin.reader));});
  await unchanged('custom view assignment',async()=>{for(const userId of pair.ids)await manage(owner,assignment('user',userId,viewRole));});
  await unchanged('Reader on a devicegroup',async()=>{for(const userId of pair.ids)await manage(owner,assignment('user',userId,builtin.reader,'devicegroup',deviceGroup));});
  await alive(pair,'non-privileged assignments');

  const plainEnabled=await userGroup(1,builtin.reader),plainDisabled=await userGroup(0,viewRole),bare=await userGroup(0);
  await unchanged('add-member to a group without a privileged role',async()=>{for(const groupId of [plainEnabled,plainDisabled,bare])for(const userId of pair.ids)await manage(owner,{action:'add-member',groupId,userId});});
  await unchanged('enabling a group without a privileged role',async()=>{for(const groupId of [plainDisabled,bare]){const group=await d.one(sql`SELECT name,description FROM user_groups WHERE id=${groupId}`);await manage(owner,{action:'update-group',id:groupId,name:group.name,description:group.description,enabled:true});}});
  await alive(pair,'non-privileged groups');

  // A privileged group whose members got their links after joining.
  const privileged=await userGroup(1,builtin.owner),members=await fresh();for(const userId of members.ids)await member(privileged,userId);
  for(const userId of members.ids)members.links[userId]=await issue(userId,owner);
  await unchanged('renaming an enabled Owner group',()=>manage(owner,{action:'update-group',id:privileged,name:'Umbenannt '+privileged,description:'Neu',enabled:true}));
  await unchanged('disabling an Owner group',()=>manage(owner,{action:'update-group',id:privileged,name:'Umbenannt '+privileged,description:'Neu',enabled:false}));
  await unchanged('renaming a disabled Owner group',()=>manage(owner,{action:'update-group',id:privileged,name:'Wieder '+privileged,description:'',enabled:false}));
  await unchanged('removing a member of an Owner group',()=>manage(owner,{action:'remove-member',groupId:privileged,userId:members.ids[0]}));
  await alive(members,'non-raising group changes');

  // Deleting an assignment and the idempotent repeat of an existing one.
  const holder=await createUser('active','fixture-password'),payload=assignment('user',holder,builtin.owner);
  const created=await manage(owner,payload),link=await issue(holder,owner);
  await unchanged('identical repeated add-assignment',async()=>check((await manage(owner,payload)).id,created.id,'the idempotent path returns the existing id'));
  await unchanged('deleting an assignment',()=>manage(owner,{action:'delete-assignment',id:created.id}));
  check((await open(link)).status,200,'after the idempotent repeat and the deletion the link is valid');

  // update-role without a privileged transition.
  const plain=await customRole(['view']),crossRole=await customRole([access.crossCustomerPermission]),holders=await fresh();
  for(const userId of holders.ids){await assignRole('user',userId,plain);await assignRole('user',userId,crossRole);holders.links[userId]=await issue(userId,owner);}
  await unchanged('update-role non-privileged to non-privileged',()=>manage(owner,{action:'update-role',id:plain,name:'Rolle '+plain,description:'',permissions:['view','terminal']}));
  await unchanged('update-role privileged to privileged',()=>manage(owner,{action:'update-role',id:crossRole,name:'Rolle '+crossRole,description:'',permissions:['view',access.crossCustomerPermission]}));
  await unchanged('update-role privileged to non-privileged',()=>manage(owner,{action:'update-role',id:crossRole,name:'Rolle '+crossRole,description:'',permissions:['view']}));
  await unchanged('update-role renaming only',()=>manage(owner,{action:'update-role',id:plain,name:'Neu '+plain,description:'',permissions:['view','terminal']}));
  await alive(holders,'update-role without a raise');

  // With a second customer the UAA cannot assign the Owner role.
  const target=await fresh();
  await unchanged('UAA assigns Owner with a second customer',()=>rejects(manage(uaa,assignment('user',target.ids[0],builtin.owner)),403,ownerOnly,'the UAA is refused'));
  check((await d.one(sql`SELECT count(*) AS n FROM role_assignments WHERE principal_id=${target.ids[0]}`)).n,0,'refused: no assignment');
  await alive(target,'refused raise');
 }
 await alive(bystander,'bystander after every raise');
 console.log(`privilege-raise-tokens: ${checks} checks passed`);
}finally{d.close();}
