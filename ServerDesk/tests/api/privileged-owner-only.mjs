// Owner rule for privileged roles: only a live global Owner creates, changes,
// deletes or assigns roles with '*' or the cross-customer right, adds members to
// or enables a user group that holds one, and runs account actions on accounts
// that hold one. With only the default customer and with a second customer
// alike. Real lib/server/identity/access.ts, lib/server/identity/rbac.ts and app/api/auth/route.ts on an isolated
// PostgreSQL test database; the second customer comes from separateCustomers.
import {serverText} from '../support/server-text.mjs';
import {HttpError as realHttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFileSync} from 'node:fs';
import {sourceDatabase,sourceLoader,insertRow} from '../support/source-database.mjs';

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
  revocationStatements:(user,guard=sql`TRUE`)=>[sql`DELETE FROM local_auth_sessions WHERE user_id=${user.id} AND (${guard})`]};
 const imports={'../context':server,'./context':server,'../../context':server,'@/lib/server/context':server,'./mfa':mfa,'@/lib/server/identity/mfa':mfa,'./local-auth':localAuth,'@/lib/server/identity/local-auth':localAuth,'@/lib/server/identity/passwords':{verifyPassword:async()=>false}};
 const access=load('lib/server/identity/access.ts',imports),rbac=load('lib/server/identity/rbac.ts',imports),route=load('app/api/auth/route.ts',imports);

 // ---- Messages and static checks ------------------------------------------
 const text={
  role:serverText('apiError.rbac.privilegedRoleOwnerOnly'),
  group:serverText('apiError.rbac.privilegedGroupOwnerOnly'),
  target:serverText('apiError.access.targetOwnerOnly'),
 };
 check([rbac.privilegedRoleOwnerOnlyMessage,rbac.privilegedGroupOwnerOnlyMessage,access.targetOwnerOnlyMessage],[text.role,text.group,text.target],'the messages are unchanged');
 const accessSource=readFileSync('lib/server/identity/access.ts','utf8'),guardStart=accessSource.indexOf('export function privilegedWriteGuard(');assert.ok(guardStart>0,'privilegedWriteGuard');
 const guardSource=accessSource.slice(guardStart,accessSource.indexOf('\n',guardStart));
 check([guardSource.includes('singleCustomer'),guardSource.includes('customerSeparationSql'),guardSource.includes('globalOwnerGuard(')],[false,false,true],'privilegedWriteGuard is the Owner guard alone');
 check(/export function privilegedWriteGuard\(v:Viewer\):SqlGuard\{/.test(guardSource),true,'privilegedWriteGuard keeps its name and signature');

 // ---- Fixture --------------------------------------------------------------------
 const cross=access.crossCustomerPermission;
 const insert=(table,row)=>insertRow(d,table,row);
 const builtin={owner:'builtin-owner',reader:'builtin-reader',uaa:'builtin-user-access-administrator'};
 const uaaRights=access.allPortalPermissions.filter(right=>right!=='portal.operator'&&right!==cross);
 for(const [id,name,permissions] of [[builtin.owner,'Owner',['*']],[builtin.reader,'Reader',access.rolePermissions.viewer],[builtin.uaa,'User Access Administrator',uaaRights]])await insert('rbac_roles',{id,name,description:'',permissions:JSON.stringify(permissions),builtin:1,created_at:time});
 const assignRole=async(type,subject,role,scopeType='global',scopeId='*')=>{const id=uuid();await insert('role_assignments',{id,principal_type:type,principal_id:subject,role_id:role,scope_type:scopeType,scope_id:scopeId,created_at:time,created_by:'fixture'});return id;};
 const createUser=async(status='active',passwordHash='fixture-password')=>{const id=uuid();await insert('local_users',{id,username:'u'+id.slice(0,8)+id.slice(-4),email:'',display_name:'Ziel '+id.slice(0,8),auth_principal:'local:'+id,auth_email:id+'@local.serverdesk.invalid',status,password_hash:passwordHash,auth_version:1,must_reset:0,created_at:time,updated_at:time});return id;};
 const customRole=async permissions=>{const id=uuid();await insert('rbac_roles',{id,name:'Rolle '+id,description:'',permissions:JSON.stringify(permissions),builtin:0,created_at:time});return id;};
 const userGroup=async(enabled,role)=>{const id=uuid();await insert('user_groups',{id,name:'Gruppe '+id,description:'',enabled,created_at:time});if(role)await assignRole('group',id,role);return id;};
 const actor=async(label,...roles)=>{const id=await createUser();for(const role of roles)await assignRole('user',id,role);
  await insert('mfa_sessions',{token_hash:sha(id+'mfa'),principal:'local:'+id,created_at:time,last_activity:time,idle_expires_at:time+3_600_000,expires_at:time+86_400_000});
  return {id,userId:id,label,principal:'local:'+id,authorization:{authVersion:1}};};
 const owner=await actor('owner@owner-only.test',builtin.owner);
 // The UAA can attempt every action: the built-in role plus roles and user groups management.
 const uaa=await actor('uaa@owner-only.test',builtin.uaa,await customRole(['portal.roles.manage','portal.userGroups.manage']));
 await actor('owner-2@owner-only.test',builtin.owner);
 const deviceGroup=uuid();await insert('device_groups',{id:deviceGroup,name:'Standort',description:'',created_at:time});

 const proof=async who=>{const token=uuid();await insert('mfa_management_proofs',{token_hash:token,principal:who.principal,session_hash:sha(who.id+'mfa'),expires_at:Date.now()+300_000});return token;};
 const manage=async(who,payload)=>{viewer=who;return rbac.manageRbac(who,payload,await rbac.prepareManagementAuthorization(new Request('https://owner-only.test/api/rbac'),who,await proof(who)));};
 const post=async(who,body)=>{viewer=who;const response=await route.POST(new Request('https://owner-only.test/api/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({managementToken:uuid(),...body})}));return {status:response.status,body:await response.json()};};
 const count=async statement=>Number((await d.one(statement)).n);
 const state=async()=>({roles:(await d.query(sql`SELECT id,permissions FROM rbac_roles ORDER BY id`)),assignments:await count(sql`SELECT count(*) AS n FROM role_assignments`),members:await count(sql`SELECT count(*) AS n FROM user_group_members`),
  enabled:(await d.query(sql`SELECT id,enabled FROM user_groups ORDER BY id`)),audits:await count(sql`SELECT count(*) AS n FROM audit`),tokens:await count(sql`SELECT count(*) AS n FROM local_account_tokens`)});
 // Refused with 403 and the exact message, and nothing written.
 const refused=async(who,payload,message,label)=>{
  const before=await state();
  await assert.rejects(manage(who,payload),error=>{assert.equal(error.status,403,label+': '+error.message);assert.equal(error.message,message,label);return true;},label);checks++;
  check(await state(),before,label+': nothing written');
 };
 const allowed=async(who,payload,label)=>{const result=await manage(who,payload);check(result.ok===true||typeof result.id==='string',true,label);return result;};
 const assignment=(subjectType,subjectId,roleId,scopeType='global',scopeId='*')=>({action:'add-assignment',subjectType,subjectId,roleId,scopeType,scopeId});
 const passes=async guard=>!!await d.one(sql`SELECT 1 AS allowed WHERE ${guard}`);
 const separate=async()=>{await d.exec(enableMultipleCustomers());await d.exec(separateCustomers(time));};

 for(const mode of ['before','after']){
  if(mode==='after')await separate();
  check(await count(sql`SELECT count(*) AS n FROM customers`),mode==='after'?2:1,`${mode}: the number of customers`);

  // ---- The rule itself, on the server side ---------------------------------
  check([await passes(access.privilegedWriteGuard(owner)),await passes(access.privilegedWriteGuard(uaa))],[true,false],`${mode}: privilegedWriteGuard is true for the Owner only`);
  check([(await rbac.rbacData(owner)).privilegedWritable,(await rbac.rbacData(uaa)).privilegedWritable],[true,false],`${mode}: rbacData reports privilegedWritable`);

  // ---- No self-elevation ---------------------------------------------------
  const other=await createUser();
  await refused(uaa,assignment('user',uaa.id,builtin.owner),text.role,`${mode}: the UAA may not assign the Owner role to itself`);
  await refused(uaa,assignment('user',other,builtin.owner),text.role,`${mode}: the UAA may not assign the Owner role to another user`);
  check(await access.hasGlobalPermission(uaa,'*'),false,`${mode}: the UAA holds no '*'`);

  // ---- Every privileged write ------------------------------------------------
  const createPayload={action:'create-role',name:'Kundenübergreifend '+mode,description:'',permissions:['view',cross]};
  await refused(uaa,createPayload,text.role,`${mode}: create-role with the cross-customer right`);
  const created=await allowed(owner,createPayload,`${mode}: the Owner creates the role`);
  const plain=await customRole(['view']),updatePayload={action:'update-role',id:plain,name:'Rolle '+plain,description:'',permissions:['view',cross]};
  await refused(uaa,updatePayload,text.role,`${mode}: update-role that adds the cross-customer right`);
  await allowed(owner,updatePayload,`${mode}: the Owner raises the role`);
  const privilegedRole=await customRole(['view',cross]);
  await refused(uaa,{action:'delete-role',id:privilegedRole},text.role,`${mode}: delete-role of a privileged role`);
  await allowed(owner,{action:'delete-role',id:privilegedRole},`${mode}: the Owner deletes the privileged role`);
  const group=await userGroup(1);
  const targets=[['another user',assignment('user',other,created.id)],['a group',assignment('group',group,created.id)],['a devicegroup scope',assignment('user',other,builtin.owner,'devicegroup',deviceGroup)]];
  for(const [label,payload] of targets){
   await refused(uaa,payload,text.role,`${mode}: add-assignment of a privileged role to ${label}`);
   await allowed(owner,payload,`${mode}: the Owner assigns a privileged role to ${label}`);
  }
  const ownerGroup=await userGroup(1,builtin.owner),joiner=await createUser();
  await refused(uaa,{action:'add-member',groupId:ownerGroup,userId:joiner},text.group,`${mode}: add-member to an Owner group`);
  await allowed(owner,{action:'add-member',groupId:ownerGroup,userId:joiner},`${mode}: the Owner adds a member`);
  const disabledGroup=await userGroup(0),crossGroupRole=await customRole([cross]);await assignRole('group',disabledGroup,crossGroupRole);
  const enable={action:'update-group',id:disabledGroup,name:'Gruppe '+disabledGroup,description:'',enabled:true};
  await refused(uaa,enable,text.group,`${mode}: enabling a group with the cross-customer right`);
  await allowed(owner,enable,`${mode}: the Owner enables the group`);

  // ---- Account actions on a privileged target ------------------------------
  const invited=await createUser('invited',null);await assignRole('user',invited,builtin.owner);
  await insert('local_account_tokens',{token_hash:'open-'+invited,user_id:invited,kind:'invite',created_at:time,expires_at:time+3_600_000,auth_version:1});
  const account=async userId=>({user:await d.one(sql`SELECT status,display_name,email,auth_version,updated_at FROM local_users WHERE id=${userId}`),
   tokens:(await d.query(sql`SELECT token_hash,kind,used_at FROM local_account_tokens WHERE user_id=${userId} ORDER BY token_hash`))});
  const accountRefused=async(body,userId,label)=>{const before=await account(userId),reply=await post(uaa,body);check([reply.status,reply.body.error],[403,text.target],label);check(await account(userId),before,label+': nothing changed');};
  await accountRefused({action:'reset-link',userId:invited},invited,`${mode}: no link for an invited Owner from the UAA`);
  await accountRefused({action:'update-user',userId:invited,displayName:'Übernommen',email:'neu@owner-only.test'},invited,`${mode}: the UAA may not edit an invited Owner`);
  const activeOwner=await createUser();await assignRole('user',activeOwner,builtin.owner);
  await accountRefused({action:'disable-user',userId:activeOwner,disabled:true},activeOwner,`${mode}: the UAA may not lock an Owner`);
  const lockedOwner=await createUser('disabled',null);await assignRole('user',lockedOwner,builtin.owner);
  await accountRefused({action:'disable-user',userId:lockedOwner,disabled:false},lockedOwner,`${mode}: the UAA may not unlock an Owner`);
  check((await post(owner,{action:'reset-link',userId:invited})).status,200,`${mode}: the Owner issues the link`);

  // ---- Control: non-privileged assignments by the UAA stay as they are ----
  const reader=await createUser(),control=await manage(uaa,assignment('user',reader,builtin.reader));
  check(await count(sql`SELECT count(*) AS n FROM role_assignments WHERE id=${control.id} AND principal_id=${reader} AND role_id=${builtin.reader}`),1,`${mode}: the UAA assigns the Reader role`);

  // ---- Cleanup of this mode's privileged fixtures ----------------------------------
  for(const id of [other,joiner,invited,activeOwner,lockedOwner,reader])await d.exec(sql`DELETE FROM role_assignments WHERE principal_type='user' AND principal_id=${id}`);
  for(const id of [group,ownerGroup,disabledGroup]){await d.exec(sql`DELETE FROM role_assignments WHERE principal_type='group' AND principal_id=${id}`);await d.exec(sql`DELETE FROM user_group_members WHERE group_id=${id}`);await d.exec(sql`DELETE FROM user_groups WHERE id=${id}`);}
  for(const id of [created.id,plain,crossGroupRole])await d.exec(sql`DELETE FROM rbac_roles WHERE id=${id}`);
  check(await access.hasGlobalPermission(uaa,'*'),false,`${mode}: the UAA still holds no '*'`);

  // ---- Races with only the default customer --------------------------------------------
  if(mode==='before'){
   // A non-privileged role gets '*' between pre-check and commit.
   const raised=await customRole(['view']),subject=await createUser();
   beforeBatch=()=>d.exec(sql`UPDATE rbac_roles SET permissions=${'["*"]'} WHERE id=${raised}`);
   const before=await state();
   await assert.rejects(manage(uaa,assignment('user',subject,raised)),error=>{assert.equal(error.status,403,'race 1: '+error.message);return true;},'race 1: the raised role is not assigned');checks++;
   check(beforeBatch,null,'race 1: the hook ran');
   const after=await state();
   check({...after,roles:undefined},{...before,roles:undefined},'race 1: nothing written');
   check(await count(sql`SELECT count(*) AS n FROM role_assignments WHERE principal_id=${subject}`),0,'race 1: no assignment');
   await d.exec(sql`DELETE FROM rbac_roles WHERE id=${raised}`);
   // A temporary Owner assignment of the UAA disappears between pre-check and commit.
   const temporary=await assignRole('user',uaa.id,builtin.owner),target=await createUser();
   beforeBatch=()=>d.exec(sql`DELETE FROM role_assignments WHERE id=${temporary}`);
   const beforeOwner=await state();
   await assert.rejects(manage(uaa,assignment('user',target,builtin.owner)),error=>{assert.equal(error.status,403,'race 2: '+error.message);assert.equal(error.message,text.role,'race 2');return true;},'race 2: the Owner role is not assigned');checks++;
   check(beforeBatch,null,'race 2: the hook ran');
   check({...await state(),assignments:undefined},{...beforeOwner,assignments:undefined},'race 2: nothing else written');
   check([await count(sql`SELECT count(*) AS n FROM role_assignments`),await count(sql`SELECT count(*) AS n FROM role_assignments WHERE principal_id=${target}`)],[beforeOwner.assignments-1,0],'race 2: only the temporary assignment is gone, no new one');
   check(await access.hasGlobalPermission(uaa,'*'),false,'race 2: the UAA holds no \'*\' afterwards');
  }
 }
 console.log(`privileged-owner-only: ${checks} checks passed`);
}finally{d.close();}
