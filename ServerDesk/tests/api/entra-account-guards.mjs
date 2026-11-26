// Accounts from Microsoft Entra ID in the rest of the portal: the session guards
// accept them only bound, the refused password, link, profile and factor
// actions, the step-up through a Microsoft confirmation, the reserved user names, lock and unlock, and
// the database checks of local_users. Real lib/server/identity/local-auth.ts, lib/server/identity/mfa.ts,
// lib/server/identity/passkeys.ts, lib/server/identity/account-admin.ts and their routes on an isolated
// PostgreSQL database (tests/support/entra-fixture.mjs).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {entraFixture,tenant,sha} from '../support/entra-fixture.mjs';
import {insertRow} from '../support/source-database.mjs';
import {sql} from '../../runtime/database.mjs';

const f=await entraFixture(),{d,m,microsoft}=f;
let checks=0;
const check=(value,expected,label)=>{assert.deepEqual(value,expected,label);checks++;};
const oid='c0c0c0c0-0000-4000-8000-00000000000c';
const refusedWith=async(promise,code,label)=>{await assert.rejects(promise,error=>{assert.equal(error.code,code,label);return true;});checks++;};
try{
 await f.configure();
 microsoft.claims={oid,groups:[]};
 const entra=await f.signIn();
 const viewer=await f.viewerOf(entra.browser),browser=entra.browser;
 const userId=viewer.userId,request=(payload,path='/api/auth')=>f.request(path,{browser,payload});
 const owner=await f.localAccount('owner@guards.test');

 // ---- Guards: a bound Entra session passes ------------------------------------------------
 {
  const time=Date.now();
  check(!!await m.localAuth.localIdentity(f.request('/',{browser})),true,'primarySession: the bound Entra session');
  const primary=await m.localAuth.primaryGuard(f.request('/',{browser}),viewer);
  const bind=await m.localAuth.localBindGuard(f.request('/',{browser}),viewer);
  const authentication=await m.localAuth.primaryAuthenticationGuard(f.request('/',{browser}),viewer);
  const interactive=m.featureAuthorization.primaryMfaSessionGuard(sql`${viewer.principal}`,sql`${sha(browser.session)}`,time);
  for(const [name,guard] of [['primaryGuard',primary],['localBindGuard',bind],['primaryAuthenticationGuard',authentication],['primaryMfaSessionGuard',interactive],['viewerWriteGuard',m.access.viewerWriteGuard(viewer)]])check(!!await d.one(sql`SELECT 1 AS ok WHERE ${guard}`),true,`${name}: passes for the bound Entra session`);
  f.setViewer(viewer);
  check((await f.answer(await m.mfaApi.POST(request({action:'activity'},'/api/mfa')))).status,200,'recordMfaActivity for the Entra session');
 }

 // ---- Guards: without mfa_hash an Entra session counts nowhere ----------------------------------
 {
  const pending=crypto.randomBytes(32).toString('hex'),time=Date.now();
  await insertRow(d,'local_auth_sessions',{token_hash:sha(pending),user_id:userId,auth_version:1,created_at:time,expires_at:time+86_400_000,pending_until:time+600_000,mfa_hash:null});
  const unbound={primary:pending};
  check(await m.localAuth.localIdentity(f.request('/',{browser:unbound})),null,'primarySession: no pending Entra session');
  for(const [name,guard] of [['primaryGuard',m.localAuth.primaryGuard],['localBindGuard',m.localAuth.localBindGuard],['primaryAuthenticationGuard',m.localAuth.primaryAuthenticationGuard]])await refusedWith(guard(f.request('/',{browser:unbound}),viewer),'IDENTITY_LOGIN_REQUIRED',`${name}: refused without mfa_hash`);
  check(!!await d.one(sql`SELECT 1 AS ok WHERE ${m.featureAuthorization.primaryMfaSessionGuard(sql`${viewer.principal}`,sql`${'x'.repeat(64)}`,time)}`),false,'primaryMfaSessionGuard: refused without the bound hash');
  // The SQL predicates alone, with the row in place: an Entra row without mfa_hash never passes.
  check(!!await d.one(sql`SELECT 1 AS ok FROM local_auth_sessions s JOIN local_users u ON u.id=s.user_id WHERE s.token_hash=${sha(pending)} AND ${m.localAuth.credentialSql(sql`u`,sql`s`)}`),false,'credentialSql: Entra without mfa_hash fails');
  await d.exec(sql`DELETE FROM local_auth_sessions WHERE token_hash=${sha(pending)}`);
 }

 // ---- Password, links, profile ----------------------------------------------------------------
 f.setViewer(viewer);
 {
  const login=await f.answer(await m.authApi.POST(f.request('/api/auth',{payload:{action:'login',username:`entra.${oid}`,password:'a-long-enough-password'}})));
  check([login.status,login.body.code],[401,'INVALID_CREDENTIALS'],'built-in login: invalidCredentials');
  const unknown=await f.answer(await m.authApi.POST(f.request('/api/auth',{payload:{action:'login',username:'nobody.here',password:'a-long-enough-password'}})));
  check([unknown.status,unknown.body.error],[401,login.body.error],'the same answer as an unknown user');
  const change=await f.answer(await m.authApi.POST(request({action:'password-change',currentPassword:'x',newPassword:'a-new-long-enough-password'})));
  check([change.status,change.body.code,change.body.messageKey],[403,'ENTRA_MANAGED','apiError.account.entraManaged'],'password-change: entraManaged');
  const token=crypto.randomBytes(32).toString('hex');
  await insertRow(d,'local_account_tokens',{token_hash:sha(token),user_id:userId,kind:'reset',created_at:Date.now(),expires_at:Date.now()+3_600_000,auth_version:1});
  const info=await f.answer(await m.authApi.POST(f.request('/api/auth',{payload:{action:'invitation-info',token}})));
  check([info.status,info.body.code],[400,'INVALID_ACCOUNT_TOKEN'],'an account token of an Entra account is not valid');
  const redeem=await f.answer(await m.authApi.POST(f.request('/api/auth',{payload:{action:'redeem',token,username:`entra.${oid}`,password:'a-new-long-enough-password'}})));
  check([redeem.status,(await d.one(sql`SELECT password_hash FROM local_users WHERE id=${userId}`)).password_hash],[400,null],'redeem sets no password');
  const admin=async payload=>{const login=await f.localLogin(owner);return f.answer(await m.authApi.POST(f.request('/api/auth',{browser:login,payload:{...payload,managementToken:login.management}})));};
  const link=await admin({action:'reset-link',userId});
  check([link.status,link.body.messageKey],[403,'apiError.account.entraManaged'],'reset-link: entraManaged');
  const update=await admin({action:'update-user',userId,displayName:'Other',email:'other@contoso.example'});
  check([update.status,update.body.messageKey],[403,'apiError.account.entraManaged'],'update-user: entraManaged');
  const reserved=await admin({action:'create-user',username:'entra.someone',displayName:'Someone',email:''});
  check([reserved.status,reserved.body.messageKey],[400,'apiError.auth.usernameReserved'],'create-user: entra. is reserved');
  assert.throws(()=>m.localAuth.username('Entra.x1'),error=>error.messageKey==='apiError.auth.usernameReserved');checks++;
  check(m.localAuth.username('entrance'),'entrance','other names stay');
  // Lock and unlock work as for local accounts, with the revocation.
  const lock=await admin({action:'disable-user',userId,disabled:true});
  check([lock.status,lock.body.user.status,lock.body.user.identitySource],[200,'disabled','entra'],'lock an Entra account');
  check(await f.count(sql`SELECT count(*) AS n FROM local_auth_sessions WHERE user_id=${userId}`),0,'locking ends its sessions');
  check((await f.signIn()).target,'/#entra=accountDisabled','a locked account cannot sign in');
  const unlock=await admin({action:'disable-user',userId,disabled:false});
  check([unlock.status,unlock.body.user.status],[200,'active'],'unlock: active again');
 }

 // ---- Factors: TOTP, recovery codes, passkeys -------------------------------------------------
 const again=await f.signIn(),entraBrowser=again.browser,entraViewer=await f.viewerOf(entraBrowser);
 f.setViewer(entraViewer);
 {
  for(const payload of [{action:'begin'},{action:'confirm',code:'123456'},{action:'verify',code:'123456'},{action:'verify',recoveryCode:'AAAA-BBBB'},{action:'authenticator-begin',name:'x',managementToken:'a'.repeat(64)},{action:'authenticator-delete',id:'a'.repeat(64),managementToken:'a'.repeat(64)},{action:'regenerate-recovery',managementToken:'a'.repeat(64)},{action:'disable',managementToken:'a'.repeat(64)}]){
   const result=await f.answer(await m.mfaApi.POST(f.request('/api/mfa',{browser:entraBrowser,payload})));
   check([result.status,result.body.code,result.body.messageKey],[403,'ENTRA_MANAGED','apiError.mfa.entraManaged'],`/api/mfa ${payload.action}: entraManaged`);
  }
  for(const action of ['setup-options','registration-options','authentication-options']){
   const result=await f.answer(await m.passkeyApi.POST(f.request('/api/passkeys',{browser:entraBrowser,payload:{action,device:'this-device'}})));
   check([result.status,result.body.messageKey],[403,'apiError.mfa.entraManaged'],`/api/passkeys ${action}: entraManaged`);
  }
  check(await f.count(sql`SELECT count(*) AS n FROM mfa_accounts WHERE principal=${entraViewer.principal}`),0,'no mfa_accounts row was created');
 }

 // ---- Step-up: MFA_STEP_UP_REQUIRED without a proof, success with a Microsoft confirmation ---------
 {
  await refusedWith(m.mfa.readMfaManagementProof(f.request('/',{browser:entraBrowser}),entraViewer,'a'.repeat(64)),'MFA_STEP_UP_REQUIRED','managementProof: an unknown token asks for the step-up, as for local viewers');
  await d.exec(sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(${crypto.randomUUID()},'user',${entraViewer.userId},'builtin-user-access-administrator','global','*',0,'fixture')`);
  const createUser=(browser,managementToken)=>m.authApi.POST(f.request('/api/auth',{browser,payload:{action:'create-user',username:'new.person',displayName:'New',email:'',managementToken}}));
  const create=await f.answer(await createUser(entraBrowser,'a'.repeat(64)));
  check([create.status,create.body.code],[403,'MFA_STEP_UP_REQUIRED'],'a step-up action of an Entra viewer without a proof: MFA_STEP_UP_REQUIRED');
  check([m.codes.opensMfaPrompt('MFA_STEP_UP_REQUIRED'),m.codes.opensMfaPrompt('ENTRA_CONFIRM_REFUSED'),m.codes.opensMfaPrompt('MFA_ENTRA_ONLY')],[true,false,false],'the code prompt opens for the step-up, not for a refused confirmation');
  const confirmed=await f.confirm(entraBrowser);
  check([confirmed.claimed.status,typeof confirmed.management],[200,'string'],'Confirm with Microsoft gives a managementToken');
  f.setViewer(await f.viewerOf(confirmed.browser));
  const created=await f.answer(await createUser(confirmed.browser,confirmed.management));
  check([created.status,created.body.ok],[200,true],'the step-up action succeeds with the proof of the confirmation');
  const reused=await f.answer(await m.authApi.POST(f.request('/api/auth',{browser:confirmed.browser,payload:{action:'create-user',username:'second.person',displayName:'Second',email:'',managementToken:confirmed.management}})));
  check([reused.status,reused.body.code],[403,'MFA_STEP_UP_REQUIRED'],'the proof is used once');
  for(const payload of [{action:'verify',code:'123456'},{action:'resume'}]){
   const refused=await f.answer(await m.mfaApi.POST(f.request('/api/mfa',{browser:confirmed.browser,payload})));
   check(refused.body.code,payload.action==='resume'?'INVALID_REQUEST':'ENTRA_MANAGED',`${payload.action} stays refused for Entra after a confirmation (resume is an unknown action)`);
  }
 }

 // ---- Database checks of local_users -------------------------------------------------------------
 {
  const base=id=>({id,username:'x'+id.slice(0,8),email:'',display_name:'X',auth_email:id+'@x.invalid',status:'active',auth_version:1,must_reset:0,created_at:0,updated_at:0});
  const other='d0d0d0d0-0000-4000-8000-00000000000d';
  const refused=async(row,label)=>{await assert.rejects(insertRow(d,'local_users',row),error=>/check constraint|violates/i.test(String(error.message)),label);checks++;};
  const id1=crypto.randomUUID(),id2=crypto.randomUUID(),id3=crypto.randomUUID(),id4=crypto.randomUUID();
  await refused({...base(id1),auth_principal:`entra:${tenant}:${other}`,identity_source:'entra',entra_tenant_id:tenant,entra_object_id:other,password_hash:'hash'},'an Entra row with a password');
  await refused({...base(id2),auth_principal:'private:someone',identity_source:'entra',entra_tenant_id:tenant,entra_object_id:other},'an Entra row with a foreign principal');
  await refused({...base(id3),auth_principal:'private:x3',identity_source:'local',entra_tenant_id:tenant,entra_object_id:other},'a local row with Entra IDs');
  await refused({...base(id4),auth_principal:`entra:${tenant}:${other}`,identity_source:'entra',entra_tenant_id:tenant,entra_object_id:null},'an Entra row without the object ID');
  await refused({...base(id4),auth_principal:`entra:${tenant}:${other}`,identity_source:'entra',entra_tenant_id:tenant,entra_object_id:other,must_reset:1},'an Entra row with must_reset');
  await refused({...base(id4),auth_principal:'private:y',identity_source:'other'},'an unknown identity source');
  await assert.rejects(d.exec(sql`UPDATE local_users SET password_hash='hash' WHERE id=${userId}`),/check constraint|violates/i);checks++;
  check((await d.one(sql`SELECT identity_source FROM local_users WHERE id=${owner.actor.id}`)).identity_source,'local','local accounts are local');
  await assert.rejects(d.exec(sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by,source) VALUES(${crypto.randomUUID()},'group',${crypto.randomUUID()},'builtin-reader','global','*',0,'x','entra')`),/check constraint|violates/i,'an Entra row is always a user row');checks++;
 }
 console.log(`PASS entra account guards (${checks} checks): bound-only guards, refused password, link, profile and factor actions, step-up with a Microsoft confirmation, reserved names, lock and unlock, database checks.`);
}finally{await d.close();}
