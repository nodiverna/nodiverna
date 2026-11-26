// Account actions only on dominated accounts (targetDominanceGuard):
// reset-link, update-user, lock and unlock in app/api/auth/route.ts against the
// real lib/server/identity/access.ts and route on an isolated PostgreSQL test database. The regression
// matrix runs with only the default customer and again with a second customer (separateCustomers).
// The customer boundary of the target has its own block at the end.
import {serverText} from '../support/server-text.mjs';
import {HttpError as realHttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readdirSync,readFileSync} from 'node:fs';
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
  clearMfaSessionCookie:()=>'mfa=; Max-Age=0',clearMfaTrustCookie:()=>'trust=; Max-Age=0',prepareManagementAuthorization:async()=>(sql`TRUE`)};
 const load=sourceLoader();
 // The real revocation would also clear MFA tables; the local_auth_sessions statement is enough to see a revocation.
 const localAuth={primaryGuard:async(_request,actor)=>load('lib/server/identity/access.ts').viewerWriteGuard(actor),clearLocalAuthCookie:()=>'auth=; Max-Age=0',
  revocationStatements:(user,guard=sql`TRUE`)=>[sql`DELETE FROM local_auth_sessions WHERE user_id=${user.id} AND (${guard})`]};
 const imports={'../context':server,'./context':server,'@/lib/server/context':server,'./mfa':mfa,'../identity/mfa':mfa,'./identity/mfa':mfa,'@/lib/server/identity/mfa':mfa,'./local-auth':localAuth,'./identity/local-auth':localAuth,'@/lib/server/identity/local-auth':localAuth,'@/lib/server/identity/passwords':{verifyPassword:async()=>false}};
 const access=load('lib/server/identity/access.ts',imports),route=load('app/api/auth/route.ts',imports);

 // ---- Messages and static checks ------------------------------------------------
 const ownerOnly=serverText('apiError.access.targetOwnerOnly');
 const assignmentsRequired=serverText('apiError.access.targetAssignmentsRequired');
 const disabledLink=serverText('apiError.account.lockedNoPasswordLink'),stateChanged=serverText('apiError.account.stateChanged');
 check(access.targetOwnerOnlyMessage,ownerOnly,'targetOwnerOnlyMessage is the UI copy');
 check(access.targetAssignmentsRequiredMessage,assignmentsRequired,'targetAssignmentsRequiredMessage is the UI copy');
 const routeSource=readFileSync('lib/server/identity/account-admin.ts','utf8'),rbacSource=readFileSync('lib/server/identity/rbac.ts','utf8');
 check(routeSource.includes('credentialAdministrationGuard'),false,'the route no longer has credentialAdministrationGuard');
 check(/import \{[^}]*\bprivilegedRoleSql\b[^}]*\} from '\.\/access'/.test(rbacSource),true,'lib/server/identity/rbac.ts imports privilegedRoleSql from ./access');
 check(/\b(?:const|function)\s+privilegedRoleSql\b/.test(rbacSource),false,'lib/server/identity/rbac.ts keeps no copy of privilegedRoleSql');
 check(/\bfunction\s+privilegedWriteGuard\b/.test(rbacSource),false,'lib/server/identity/rbac.ts keeps no copy of the mode rule');
 // The former lib/*.ts files live in lib/, lib/server/ and its domain folders, and ui/ (the UI models): walk all of lib/ and ui/.
 const tsFiles=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?tsFiles(dir+'/'+entry.name):entry.name.endsWith('.ts')?[dir+'/'+entry.name]:[]);
 check(['lib','ui'].flatMap(tsFiles).reduce((sum,file)=>sum+readFileSync(file,'utf8').split('privileged_right.value IN').length-1,0),1,'privileged_right.value IN occurs once under lib');
 for(const action of ['reset-link','update-user','disable-user']){
  const start=routeSource.indexOf(`if(p.action==='${action}')`),end=routeSource.indexOf('\n }',start);
  assert.ok(start>0,action);check(routeSource.slice(start,end).includes('targetDominanceGuard(v,user.id)'),true,action+' references targetDominanceGuard');
 }
 const createStart=routeSource.indexOf("if(p.action==='create-user')");check(routeSource.slice(createStart,routeSource.indexOf('\n }',createStart)).includes('targetDominanceGuard'),false,'create-user is unchanged');

 // ---- Fixture --------------------------------------------------------------------
 const insert=(table,row)=>insertRow(d,table,row);
 const builtin={owner:'builtin-owner',reader:'builtin-reader',uaa:'builtin-user-access-administrator'};
 const uaaRights=access.allPortalPermissions.filter(right=>right!=='portal.operator'&&right!==access.crossCustomerPermission);
 for(const [id,name,permissions] of [[builtin.owner,'Owner',['*']],[builtin.reader,'Reader',access.rolePermissions.viewer],[builtin.uaa,'User Access Administrator',uaaRights]])await insert('rbac_roles',{id,name,description:'',permissions:JSON.stringify(permissions),builtin:1,created_at:time});
 const assignRole=(type,subject,role)=>insert('role_assignments',{id:uuid(),principal_type:type,principal_id:subject,role_id:role,scope_type:'global',scope_id:'*',created_at:time,created_by:'fixture'});
 const createUser=async(status,passwordHash)=>{const id=uuid();await insert('local_users',{id,username:'u'+id.slice(0,8)+id.slice(-4),email:'',display_name:'Ziel '+id.slice(0,8),auth_principal:'local:'+id,auth_email:id+'@local.serverdesk.invalid',status,password_hash:passwordHash,auth_version:1,must_reset:0,created_at:time,updated_at:time});return id;};
 const actor=async(label,role)=>{const id=await createUser('active','fixture-password');await assignRole('user',id,role);
  return {id,userId:id,label,principal:'local:'+id,authorization:{authVersion:1}};};
 const customRole=async permissions=>{const id=uuid();await insert('rbac_roles',{id,name:'Rolle '+id,description:'',permissions:JSON.stringify(permissions),builtin:0,created_at:time});return id;};
 const owner=await actor('owner@dominance.test',builtin.owner);
 const uaa=await actor('uaa@dominance.test',builtin.uaa);
 const usersOnly=await actor('users@dominance.test',await customRole(['portal.users.manage']));
 const actors={owner,uaa,usersOnly};
 const userGroup=async enabled=>{const id=uuid();await insert('user_groups',{id,name:'Gruppe '+id,description:'',enabled,created_at:time});await assignRole('group',id,builtin.owner);return id;};
 const enabledOwnerGroup=await userGroup(1),disabledOwnerGroup=await userGroup(0);

 const statuses={invited:['invited',null],active:['active','fixture-password'],disabled:['disabled',null]};
 const roleKinds=['none','reader','ownerDirect','ownerEnabledGroup','ownerDisabledGroup'];
 // A fresh target per cell with an open link and a live session, so a refusal can be seen to leave both alone.
 const target=async(status,kind)=>{
  const id=await createUser(...statuses[status]);
  if(kind==='reader')await assignRole('user',id,builtin.reader);
  if(kind==='ownerDirect')await assignRole('user',id,builtin.owner);
  if(kind==='ownerEnabledGroup')await insert('user_group_members',{group_id:enabledOwnerGroup,user_id:id});
  if(kind==='ownerDisabledGroup')await insert('user_group_members',{group_id:disabledOwnerGroup,user_id:id});
  if(kind==='custom')await assignRole('user',id,await customRole(['view']));
  await insert('local_account_tokens',{token_hash:'open-'+id,user_id:id,kind:status==='active'?'reset':'invite',created_at:time,expires_at:time+3_600_000,auth_version:1});
  await insert('local_auth_sessions',{token_hash:'session-'+id,user_id:id,auth_version:1,created_at:time,expires_at:time+3_600_000,pending_until:time});
  return id;
 };
 const actionAudit={'reset-link':'auth.user.password-link','update-user':'auth.user.update',lock:'auth.user.disable',unlock:'auth.user.enable'};
 const payload=(action,userId)=>action==='reset-link'?{action,userId}:action==='update-user'?{action,userId,displayName:'Neuer Name '+userId.slice(0,8),email:'neu@dominance.test'}:{action:'disable-user',userId,disabled:action==='lock'};
 const post=async(who,body)=>{viewer=who;const response=await route.POST(new Request('https://dominance.test/api/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({managementToken:uuid(),...body})}));return {status:response.status,body:await response.json()};};
 const act=(who,action,userId)=>post(who,payload(action,userId));
 const trace=async userId=>({
  user:await d.one(sql`SELECT status,auth_version,display_name,email,updated_at FROM local_users WHERE id=${userId}`),
  tokens:(await d.query(sql`SELECT token_hash,kind,used_at FROM local_account_tokens WHERE user_id=${userId} ORDER BY token_hash`)),
  audits:(await d.query(sql`SELECT action FROM audit WHERE target=${userId} ORDER BY id`)),
  sessions:(await d.query(sql`SELECT token_hash FROM local_auth_sessions WHERE user_id=${userId}`))
 });
 const refused=async(response,before,userId,status,message,label)=>{check({status:response.status,error:response.body.error},{status,error:message},label);check(await trace(userId),before,label+': no trace');};
 const separate=async()=>{await d.exec(enableMultipleCustomers());await d.exec(separateCustomers(time));};

 // ---- Last owner: before the second direct Owner exists ------------------
 {
  const groupOwner=await actor('group-owner@dominance.test',await customRole(['view']));await insert('user_group_members',{group_id:enabledOwnerGroup,user_id:groupOwner.id});
  let before=await trace(owner.id);
  await refused(await act(groupOwner,'lock',owner.id),before,owner.id,409,stateChanged,'a group Owner cannot lock the last active direct global Owner');
  before=await trace(owner.id);
  await refused(await act(owner,'lock',owner.id),before,owner.id,409,stateChanged,'the last active direct global Owner cannot lock itself');
  await d.exec(sql`DELETE FROM user_group_members WHERE user_id=${groupOwner.id}`);
 }
 await actor('owner-2@dominance.test',builtin.owner);

 // ---- Regression matrix ------------------------------------------
 // Privileged targets are the exception: only an Owner acts on them, before and
 // with one customer and with several alike. The mode stays in the loop to prove it.
 const expected=(who,kind,status,_mode,action)=>{
  if(action==='reset-link'&&status==='disabled')return {status:409,error:disabledLink};
  const hasRole=kind!=='none',privileged=kind.startsWith('owner'),assignments=who!=='usersOnly';
  if(!hasRole||(assignments&&(!privileged||who==='owner')))return {status:200};
  return {status:403,error:privileged?ownerOnly:assignmentsRequired};
 };
 let cells=0;
 for(const mode of ['before','after']){
  if(mode==='after')await separate();
  for(const action of ['reset-link','update-user','lock','unlock'])for(const kind of roleKinds)for(const status of Object.keys(statuses))for(const who of Object.keys(actors)){
   const userId=await target(status,kind),label=`${mode} ${action} ${kind} ${status} by ${who}`,want=expected(who,kind,status,mode,action),before=await trace(userId);
   const response=await act(actors[who],action,userId);cells++;
   if(want.status!==200){await refused(response,before,userId,want.status,want.error,label);continue;}
   check(response.status,200,label+': '+JSON.stringify(response.body));
   // A lock or unlock that would not change the status has no effect: no row, no bump, no revocation.
   if(action==='lock'&&status==='disabled'||action==='unlock'&&status!=='disabled'){check(await trace(userId),before,label+': a no-op leaves no trace');continue;}
   const after=await trace(userId);
   check(after.audits.map(row=>row.action),[actionAudit[action]],label+': one audit row');
   if(action==='reset-link'){const fresh=after.tokens.filter(token=>!token.token_hash.startsWith('open-'));check(fresh.map(token=>[token.kind,token.used_at]),[[status==='invited'?'invite':'reset',null]],label+': one new token');}
   if(action==='update-user')check([after.user.display_name,after.user.email],['Neuer Name '+userId.slice(0,8),'neu@dominance.test'],label+': edited');
   if(action==='lock')check(after.user.status,'disabled',label+': locked');
   if(action==='unlock')check(after.user.status,status==='invited'?'invited':'active',label+': unlocked');
  }
 }
 check(cells,4*5*3*3*2,'all matrix cells ran');

 // ---- Race: the target becomes privileged after the pre-check -----------
 const races={
  ownerAssignment:async userId=>assignRole('user',userId,builtin.owner),
  privilegedGroup:async userId=>insert('user_group_members',{group_id:enabledOwnerGroup,user_id:userId}),
  roleRaised:async userId=>d.exec(sql`UPDATE rbac_roles SET permissions=${JSON.stringify(['view',access.crossCustomerPermission])} WHERE id IN (SELECT role_id FROM role_assignments WHERE principal_type='user' AND principal_id=${userId})`)
 };
 for(const action of ['reset-link','update-user','lock','unlock']){
  const status=action==='unlock'?'disabled':'active';
  for(const [variant,raise] of Object.entries(races)){
   const userId=await target(status,'custom'),before=await trace(userId);
   beforeBatch=()=>raise(userId);
   const response=await act(uaa,action,userId);
   check(beforeBatch,null,`race ${variant} ${action}: the hook ran`);
   await refused(response,before,userId,403,ownerOnly,`race ${variant} ${action}: the UAA commits nothing`);
  }
  const control=await target(status,'custom');check((await act(uaa,action,control)).status,200,`race control ${action}: without the raise the UAA succeeds`);
 }

 // ---- Takeover paths, with several customers------------------------------
 {
  const invitedOwner=await target('invited','ownerDirect');let before=await trace(invitedOwner);
  await refused(await act(uaa,'reset-link',invitedOwner),before,invitedOwner,403,ownerOnly,'takeover 1: no link for an invited Owner from a UAA');
  const link=await act(owner,'reset-link',invitedOwner);check(link.status,200,'takeover 1: an Owner issues the invitation link');
  check((await d.one(sql`SELECT count(*) AS n FROM local_account_tokens WHERE user_id=${invitedOwner} AND kind='invite' AND used_at IS NULL`)).n,1,'takeover 1: exactly the Owner\'s link is open');

  const lockedOwner=await target('disabled','ownerDirect');before=await trace(lockedOwner);
  await refused(await act(uaa,'unlock',lockedOwner),before,lockedOwner,403,ownerOnly,'takeover 2: a UAA cannot unlock a never-activated Owner');
  check((await d.one(sql`SELECT status FROM local_users WHERE id=${lockedOwner}`)).status,'disabled','takeover 2: the Owner stays disabled');
  await refused(await act(uaa,'reset-link',lockedOwner),before,lockedOwner,409,disabledLink,'takeover 2: the following link request still meets the disabled target');
  check((await act(owner,'unlock',lockedOwner)).status,200,'takeover 2: an Owner unlocks');
  const reset=await act(owner,'reset-link',lockedOwner);check(reset.status,200,'takeover 2: an Owner then issues the link');
  check((await d.one(sql`SELECT count(*) AS n FROM local_account_tokens WHERE user_id=${lockedOwner} AND kind='reset' AND used_at IS NULL`)).n,1,'takeover 2: a reset link for the unlocked Owner');

  const activeOwner=await target('active','ownerDirect');before=await trace(activeOwner);
  await refused(await act(uaa,'lock',activeOwner),before,activeOwner,403,ownerOnly,'takeover 3: a UAA cannot lock a non-last Owner');
  await refused(await act(uaa,'update-user',activeOwner),before,activeOwner,403,ownerOnly,'takeover 3: a UAA cannot rename a non-last Owner');
  check((await act(owner,'update-user',activeOwner)).status,200,'takeover 3: an Owner renames');
  check((await act(owner,'lock',activeOwner)).status,200,'takeover 3: an Owner locks');
 }

 // ---- Guard on its own ----------------------------------------------------
 {
  const guarded=async(who,userId)=>{const guard=access.targetDominanceGuard(who,userId);return !!await d.one(sql`SELECT 1 AS allowed WHERE ${guard}`);};
  const plain=await target('active','none'),privileged=await target('active','ownerDisabledGroup');
  check(await guarded(usersOnly,plain),true,'guard: users.manage alone suffices for a target without roles');
  check(await guarded(uaa,privileged),false,'guard: a disabled Owner group makes the target privileged with several customers');
  check(await guarded(owner,privileged),true,'guard: an Owner dominates every target');
  await d.exec(sql`UPDATE local_users SET status='disabled' WHERE id=${usersOnly.id}`);
  check(await guarded(usersOnly,plain),false,'guard: a disabled actor dominates no one');
 }
 // ---- Customer boundary ------------------------------------------------
 // A customer of the target (direct or through any of its groups, enabled or not)
 // must be seen by the actor; with only the default customer everyone sees every customer.
 {
  const customerBoundary=serverText('apiError.access.targetCustomerBoundary');
  check(access.targetCustomerBoundaryMessage,customerBoundary,'targetCustomerBoundaryMessage is the UI copy');
  check(readFileSync('lib/server/identity/access.ts','utf8').split('boundary_assignment.customer_id=').length-1,1,'assignedSubject keeps the only boundary_assignment.customer_id= in lib/server/identity/access.ts');
  const assignCustomer=(customer,type,subject)=>insert('customer_assignments',{customer_id:customer,principal_type:type,principal_id:subject,created_at:time,created_by:'fixture'});
  const plainGroup=async enabled=>{const id=uuid();await insert('user_groups',{id,name:'Kundengruppe '+id,description:'',enabled,created_at:time});return id;};
  const member=(group,user)=>insert('user_group_members',{group_id:group,user_id:user});
  // Customers A and B, the user groups and the new actors, in the current instance `d`.
  const fixture=async ownerActor=>{
   const A=uuid(),B=uuid();for(const [id,name] of [[A,'Kunde A'],[B,'Kunde B']])await insert('customers',{id,name,created_at:time,updated_at:time});
   const groupA=await plainGroup(1),groupB=await plainGroup(1),groupBDisabled=await plainGroup(0),usersAGroup=await plainGroup(1);
   await assignCustomer(A,'group',groupA);await assignCustomer(B,'group',groupB);await assignCustomer(B,'group',groupBDisabled);await assignCustomer(A,'group',usersAGroup);
   const uaaA=await actor('uaa-a@dominance.test',builtin.uaa);await assignCustomer(A,'user',uaaA.id);
   const usersA=await actor('users-a@dominance.test',await customRole(['portal.users.manage']));await member(usersAGroup,usersA.id);
   const kinds={none:async()=>{},aDirect:id=>assignCustomer(A,'user',id),aEnabledGroup:id=>member(groupA,id),bDirect:id=>assignCustomer(B,'user',id),
    bEnabledGroup:id=>member(groupB,id),bDisabledGroup:id=>member(groupBDisabled,id),aAndB:async id=>{await assignCustomer(A,'user',id);await assignCustomer(B,'user',id);}};
   // A fresh target (open link, live session) with a role kind of the earlier blocks and a customer kind.
   const customerTarget=async(status,kind,roleKind='none')=>{const id=await target(status,roleKind);await kinds[kind](id);return id;};
   return {A,B,groupB,uaaA,usersA,actors:{owner:ownerActor,uaaA,usersA},kinds,customerTarget};
  };
  const actionStatus={'reset-link':'invited','update-user':'invited',lock:'active',unlock:'disabled'};
  const onlyA=['none','aDirect','aEnabledGroup'];
  const expected=(mode,who,kind)=>who==='owner'||onlyA.includes(kind)?{status:200}:{status:403,error:customerBoundary};
  const guarded=async(who,userId)=>{const guard=access.targetDominanceGuard(who,userId);return !!await d.one(sql`SELECT 1 AS allowed WHERE ${guard}`);};
  let cells=0;
  const matrix=async(mode,fx)=>{
   for(const action of Object.keys(actionStatus))for(const kind of Object.keys(fx.kinds))for(const who of Object.keys(fx.actors)){
    const status=actionStatus[action],userId=await fx.customerTarget(status,kind),label=`customer ${mode} ${action} ${kind} by ${who}`,want=expected(mode,who,kind),before=await trace(userId);
    const response=await act(fx.actors[who],action,userId);cells++;
    if(want.status!==200){await refused(response,before,userId,want.status,want.error,label);continue;}
    check(response.status,200,label+': '+JSON.stringify(response.body));
    const after=await trace(userId);
    check(after.audits.map(row=>row.action),[actionAudit[action]],label+': one audit row');
    if(action==='reset-link')check(after.tokens.filter(token=>!token.token_hash.startsWith('open-')).map(token=>[token.kind,token.used_at]),[['invite',null]],label+': one new invitation link');
    if(action==='update-user')check([after.user.display_name,after.user.email],['Neuer Name '+userId.slice(0,8),'neu@dominance.test'],label+': edited');
    if(action==='lock')check(after.user.status,'disabled',label+': locked');
    if(action==='unlock')check(after.user.status,'active',label+': unlocked');
   }
   // Guard on its own: a disabled group still gives the target its customer.
   const hidden=await fx.customerTarget('active','bDisabledGroup');
   check(await guarded(fx.uaaA,hidden),false,`customer ${mode} guard: a target in a disabled B group is not dominated by the UAA of A`);
   check(await guarded(fx.actors.owner,hidden),true,`customer ${mode} guard: an Owner dominates it`);
  };

  // Customers A and B exist (and the separation customer of the regression matrix): the boundary applies.
  const fx=await fixture(owner),{A,B,groupB,uaaA,usersA,customerTarget}=fx;
  await matrix('after',fx);
  check(cells,4*7*3,'all customer matrix cells ran');

  // Precedence: Owner-only, then the unseen customer, then the assignments right.
  for(const action of Object.keys(actionStatus)){
   const status=actionStatus[action];
   let userId=await customerTarget(status,'bDirect','reader'),before=await trace(userId);
   await refused(await act(usersA,action,userId),before,userId,403,customerBoundary,`precedence ${action}: Reader role and customer B, users.manage only`);
   userId=await customerTarget(status,'aDirect','reader');before=await trace(userId);
   await refused(await act(usersA,action,userId),before,userId,403,assignmentsRequired,`precedence ${action}: Reader role and customer A, users.manage only`);
   userId=await customerTarget(status,'bDirect','ownerDirect');before=await trace(userId);
   await refused(await act(uaaA,action,userId),before,userId,403,ownerOnly,`precedence ${action}: Owner role and customer B, UAA of A`);
  }

  // Takeover paths: a technician of B with a global Reader role.
  {
   const technician=status=>customerTarget(status,'bDirect','reader');
   let userId=await technician('invited'),before=await trace(userId);
   await refused(await act(uaaA,'reset-link',userId),before,userId,403,customerBoundary,'customer takeover 1: no invitation link for a technician of B from the UAA of A');
   userId=await technician('disabled');before=await trace(userId);
   await refused(await act(uaaA,'unlock',userId),before,userId,403,customerBoundary,'customer takeover 2: the UAA of A cannot unlock a never-activated technician of B');
   check((await d.one(sql`SELECT status FROM local_users WHERE id=${userId}`)).status,'disabled','customer takeover 2: the technician stays disabled');
   await refused(await act(uaaA,'reset-link',userId),before,userId,409,disabledLink,'customer takeover 2: the following link request still meets the disabled target');
   userId=await technician('active');before=await trace(userId);
   await refused(await act(uaaA,'lock',userId),before,userId,403,customerBoundary,'customer takeover 3: the UAA of A cannot lock a technician of B');
   await refused(await act(uaaA,'update-user',userId),before,userId,403,customerBoundary,'customer takeover 3: the UAA of A cannot rename a technician of B');
   const uaaDirectB=await actor('uaa-ab@dominance.test',builtin.uaa);await assignCustomer(A,'user',uaaDirectB.id);await assignCustomer(B,'user',uaaDirectB.id);
   const uaaGroupB=await actor('uaa-a-group-b@dominance.test',builtin.uaa);await assignCustomer(A,'user',uaaGroupB.id);await member(groupB,uaaGroupB.id);
   for(const [name,who] of Object.entries({owner,uaaDirectB,uaaGroupB})){
    userId=await technician('invited');check((await act(who,'reset-link',userId)).status,200,`customer takeover 1: ${name} issues the invitation link`);
    check((await d.one(sql`SELECT count(*) AS n FROM local_account_tokens WHERE user_id=${userId} AND kind='invite' AND used_at IS NULL`)).n,1,`customer takeover 1: exactly the link of ${name} is open`);
    userId=await technician('disabled');check((await act(who,'unlock',userId)).status,200,`customer takeover 2: ${name} unlocks`);
    check((await act(who,'reset-link',userId)).status,200,`customer takeover 2: ${name} then issues the link`);
    userId=await technician('active');check((await act(who,'update-user',userId)).status,200,`customer takeover 3: ${name} renames`);
    check((await act(who,'lock',userId)).status,200,`customer takeover 3: ${name} locks`);
   }
  }

  // Race: between the pre-check and the commit the target gains customer B,
  // or the UAA loses A. Each variant prepares the target and returns the hook.
  const races={
   directAssignment:async userId=>()=>assignCustomer(B,'user',userId),
   enabledGroupJoined:async userId=>()=>member(groupB,userId),
   groupAssigned:async userId=>{const group=await plainGroup(1);await member(group,userId);return ()=>assignCustomer(B,'group',group);},
   actorLosesA:async userId=>{await fx.kinds.aDirect(userId);return ()=>d.exec(sql`DELETE FROM customer_assignments WHERE customer_id=${A} AND principal_type='user' AND principal_id=${uaaA.id}`);}
  };
  for(const action of Object.keys(actionStatus)){
   const status=action==='unlock'?'disabled':'active';
   for(const [variant,prepare] of Object.entries(races)){
    const userId=await customerTarget(status,'none','reader'),hook=await prepare(userId),before=await trace(userId);
    beforeBatch=hook;
    const response=await act(uaaA,action,userId);
    check(beforeBatch,null,`customer race ${variant} ${action}: the hook ran`);
    await refused(response,before,userId,403,customerBoundary,`customer race ${variant} ${action}: the UAA of A commits nothing`);
    if(variant==='actorLosesA')await assignCustomer(A,'user',uaaA.id);
   }
   const control=await customerTarget(status,'aDirect','reader');check((await act(uaaA,action,control)).status,200,`customer race control ${action}: without the hook the UAA of A succeeds`);
  }
 }
 console.log(`account-dominance: ${checks} checks passed`);
}finally{d.close();}
