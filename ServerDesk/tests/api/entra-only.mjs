// Microsoft sign-in only with the emergency access (docs/entra-id.md): the
// choice of the emergency access account, the switch with its refusals in
// order and its races, the locked built-in accounts, sign-in, account, role
// and factor rules while it is on, and switching it off. Real lib/server/identity/entra/*,
// lib/server/identity/local-auth.ts, lib/server/identity/account-admin.ts, lib/server/identity/mfa.ts and lib/server/identity/rbac.ts with
// their routes on an isolated PostgreSQL database (tests/support/entra-fixture.mjs).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {entraFixture,tenant,clientId} from '../support/entra-fixture.mjs';
import {browserAfter} from '../support/session-cookies.mjs';
import {hookDatabase} from '../support/hooked-database.mjs';
import {insertRow} from '../support/source-database.mjs';
import {fixtureTotp} from '../support/mfa-fixture.mjs';
import {sql} from '../../runtime/database.mjs';

// Passwords compare in plain text, so a test sign-in costs no key derivation.
const passwords={verifyPassword:async(password,record)=>typeof password==='string'&&password===record,dummyPasswordRecord:async()=>'\0never-matches',hashPassword:async value=>value,validatePassword:value=>value};
const f=await entraFixture({imports:{'./passwords':passwords}}),{d,m,microsoft}=f;
const hooks=hookDatabase(d).hooks;
const auditScope=f.load('lib/server/audit-scope.ts');
let checks=0;
const check=(value,expected,label)=>{assert.deepEqual(value,expected,label);checks++;};
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const address='203.0.113.7';
const totpSecret='JBSWY3DPEHPK3PXP';

try{
 // ---- Helpers ----------------------------------------------------------------------
 /** A built-in account with a password and an MFA account; owner gives it a direct, global built-in Owner assignment. */
 async function builtIn(name,{owner=true,status='active',password=true,authenticator=false}={}){
  const fixture=await f.localAccount(name+'@local.test',owner?['*']:['view']);
  const id=fixture.actor.id,display=name[0].toUpperCase()+name.slice(1);
  await d.exec(sql`UPDATE local_users SET username=${name},display_name=${display},email=${name+'@example.test'},password_hash=${password?name+'-password':null},status=${status} WHERE id=${id}`);
  if(owner)await d.exec(sql`UPDATE role_assignments SET role_id='builtin-owner' WHERE id=${fixture.assignmentId}`);
  if(authenticator)await insertRow(d,'mfa_authenticators',{id:sha('authenticator:'+id),principal:fixture.actor.principal,name:'Phone',secret_enc:await m.mfa.encryptSecret(totpSecret,fixture.actor.principal),last_counter:-1,created_at:Date.now(),last_used_at:null});
  return {...fixture,id,name,display,password:name+'-password'};
 }
 /** An Entra account signed in with Microsoft; owner adds a direct, global Owner assignment. */
 async function entraAccount(oid,{owner=true}={}){
  f.resetMicrosoft();microsoft.claims={oid};
  const entra=await f.signIn();
  const viewer=await f.viewerOf(entra.browser);
  if(owner)await d.exec(sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(gen_random_uuid()::text,'user',${viewer.userId},'builtin-owner','global','*',0,'fixture')`);
  return {oid,browser:entra.browser,viewer,id:viewer.userId};
 }
 /** A fresh Microsoft confirmation of an Entra account: its management token. */
 async function entraProof(account){
  microsoft.claims={oid:account.oid};f.setViewer(await f.viewerOf(account.browser));
  const confirmed=await f.confirm(account.browser);
  assert.equal(confirmed.claimed?.status,200,'confirm with Microsoft: '+JSON.stringify(confirmed.begin?.body));
  account.browser=confirmed.browser;return confirmed.management;
 }
 const post=async(browser,payload)=>{f.setViewer(await f.viewerOf(browser));return f.answer(await m.settingsApi.POST(f.request('/api/entra/settings',{browser,payload})));};
 const authPost=async(browser,payload,headers={})=>{f.setViewer(browser?await f.viewerOf(browser):null);return f.answer(await m.authApi.POST(f.request('/api/auth',{browser,payload,headers})));};
 const mfaPost=async(browser,payload)=>{f.setViewer(await f.viewerOf(browser));return f.answer(await m.mfaApi.POST(f.request('/api/mfa',{browser,payload,headers:{'X-ServerDesk-Client-IP':address}})));};
 const settings=()=>d.one(sql`SELECT entra_only,emergency_user_id,entra_only_at,entra_only_by,revision FROM entra_settings WHERE id=1`);
 const userRow=id=>d.one(sql`SELECT status,auth_version FROM local_users WHERE id=${id}`);
 const sessionsOf=id=>f.count(sql`SELECT count(*) AS n FROM local_auth_sessions WHERE user_id=${id}`);
 const rows=async action=>(await f.auditRows(action)).map(row=>[row.actor,row.target]);
 const setOn=async(owner,extra={})=>{const managementToken=await entraProof(owner);return post(owner.browser,{action:'set-entra-only',enabled:true,managementToken,...extra});};
 const choose=async(browser,userId,management)=>post(browser,{action:'set-emergency-account',userId,managementToken:management});

 check(['set-emergency-account','set-entra-only'].map(action=>m.stepUp.entraSettingsActionNeedsStepUp(action)),[true,true],'rule 6: both new actions need a step-up');
 const carol=await builtIn('carol');
 // ---- set-emergency-account before the settings exist -------------------------------
 {
  const login=await f.localLogin(carol);
  const result=await choose(login,carol.id,login.management);
  check([result.status,result.body.messageKey],[409,'apiError.entra.notSetUp'],'set-emergency-account without settings: notSetUp');
 }
 await f.configure();
 const owner=await entraAccount('cccccccc-0000-4000-8000-000000000001');

 // ---- set-entra-only: the refusals in order -------------------------------------------
 {
  await d.exec(sql`UPDATE entra_settings SET test_result='unreachable'`);
  let result=await setOn(owner);
  check([result.status,result.body.messageKey],[409,'apiError.entra.testFirst'],'1. a failed test: testFirst (before the missing emergency access)');
  await d.exec(sql`UPDATE entra_settings SET test_result='ok'`);
  await d.exec(sql`UPDATE entra_settings SET enabled=0`);
  const local=await f.localLogin(carol);
  result=await post(local,{action:'set-entra-only',enabled:true,managementToken:local.management});
  check(result.body.messageKey,'apiError.entra.testFirst','1. sign-in with Microsoft off: testFirst (before the viewer check)');
  await d.exec(sql`UPDATE entra_settings SET enabled=1`);
  owner.browser=(await entraAccount(owner.oid,{owner:false})).browser;
  result=await setOn(owner);
  check([result.status,result.body.messageKey],[409,'apiError.entra.emergencyMissing'],'2. no emergency access: emergencyMissing');
 }

 // ---- set-emergency-account: who qualifies ---------------------------------------------
 const emergency=await builtIn('emergency',{authenticator:true});
 {
  const login=await f.localLogin(carol);
  const refused=async(userId,label)=>{const result=await choose(login,userId,login.management);check([result.status,result.body.messageKey],[409,'apiError.entra.emergencyInvalid'],label);};
  await refused(owner.id,'an Entra account cannot be emergency access');
  await refused((await builtIn('nopass',{password:false})).id,'an account without a password cannot');
  const noMfa=await builtIn('nomfa');await d.exec(sql`DELETE FROM mfa_accounts WHERE principal=${noMfa.actor.principal}`);
  await refused(noMfa.id,'an account without MFA cannot');
  const grouped=await builtIn('grouped',{owner:false}),group=crypto.randomUUID();
  await insertRow(d,'user_groups',{id:group,name:'Owners',description:'',enabled:1,created_at:Date.now()});
  await insertRow(d,'user_group_members',{group_id:group,user_id:grouped.id});
  await d.exec(sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(gen_random_uuid()::text,'group',${group},'builtin-owner','global','*',0,'fixture')`);
  await refused(grouped.id,'an Owner only through a user group cannot');
  const scoped=await builtIn('scoped',{owner:false}),deviceGroup=crypto.randomUUID();
  await insertRow(d,'device_groups',{id:deviceGroup,name:'Branch',description:'',created_at:Date.now(),parent_id:null});
  await d.exec(sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(gen_random_uuid()::text,'user',${scoped.id},'builtin-owner','devicegroup',${deviceGroup},0,'fixture')`);
  await refused(scoped.id,'an Owner of a device group cannot');
  await refused((await builtIn('locked',{status:'disabled'})).id,'a locked account cannot');
  await refused(crypto.randomUUID(),'an unknown account cannot');
  check((await settings()).emergency_user_id,null,'nothing chosen');
  const view=(await post(login,{action:'test'})).body;
  check(view.emergency.candidates.map(candidate=>candidate.username).sort(),['carol','emergency'],'the candidates are the qualifying built-in Owners');
  const missing=await post(login,{action:'set-emergency-account',userId:emergency.id});
  check(missing.body.code,'MFA_STEP_UP_REQUIRED','set-emergency-account without a proof: step-up');
  const chosen=await choose(login,emergency.id,login.management);
  check([chosen.status,chosen.body.emergency.account,(await settings()).emergency_user_id],[200,{id:emergency.id,username:'emergency',displayName:'Emergency',authenticator:true,passkeys:0},emergency.id],'a qualifying account is chosen');
  check(await rows('auth.entra.emergency.set'),[[carol.actor.label,`user=${emergency.id}`]],'one audit row auth.entra.emergency.set');
  const again=await f.localLogin(carol);
  check((await choose(again,emergency.id,again.management)).status,200,'the same account again answers 200');
  check((await rows('auth.entra.emergency.set')).length,1,'the same account again writes no row');
  check(await f.count(sql`SELECT count(*) AS n FROM mfa_management_proofs WHERE principal=${carol.actor.principal}`)>0,true,'the same account again consumes no proof');
 }

 // ---- set-entra-only: the remaining refusals --------------------------------------------
 {
  const saved=await d.one(sql`SELECT * FROM mfa_accounts WHERE principal=${emergency.actor.principal}`);
  await d.exec(sql`DELETE FROM mfa_accounts WHERE principal=${emergency.actor.principal}`);
  let result=await setOn(owner);
  check([result.status,result.body.messageKey],[409,'apiError.entra.emergencyInvalid'],'3. the emergency access lost its MFA: emergencyInvalid');
  await insertRow(d,'mfa_accounts',saved);
  const local=await f.localLogin(carol);
  result=await post(local,{action:'set-entra-only',enabled:true,managementToken:local.management});
  check([result.status,result.body.messageKey],[409,'apiError.entra.ownerSignInRequired'],'4. a local Owner: ownerSignInRequired');
  const reader=await entraAccount('cccccccc-0000-4000-8000-000000000002',{owner:false});
  result=await post(reader.browser,{action:'set-entra-only',enabled:true,managementToken:'a'.repeat(64)});
  check([result.status,result.body.messageKey],[403,'apiError.settings.ownerOnly'],'an Entra account without the Owner role gets the Owner-only answer of the page');
  check((await settings()).entra_only,0,'nothing switched');
 }

 // ---- set-entra-only: races between the read and the commit ----------------------------
 const alice=await builtIn('alice',{owner:false});
 {
  const switching=texts=>texts.some(text=>text.includes('SET entra_only=1'));
  const race=async(change,label)=>{
   hooks.batch=async texts=>{if(switching(texts)){hooks.batch=null;await change();}};
   const result=await setOn(owner);
   hooks.batch=null;
   check([result.status,result.body.messageKey,(await settings()).entra_only,(await userRow(alice.id)).status],[409,'apiError.entra.settingsChanged',0,'active'],label);
  };
  const saved=await d.one(sql`SELECT * FROM mfa_accounts WHERE principal=${emergency.actor.principal}`);
  await race(()=>d.exec(sql`DELETE FROM mfa_accounts WHERE principal=${emergency.actor.principal}`),'the emergency access loses MFA before the commit: nothing changed');
  await insertRow(d,'mfa_accounts',saved);
  await race(()=>d.exec(sql`UPDATE entra_settings SET revision=revision+1,tested_revision=revision+1`),'the revision changes before the commit: nothing changed');
  check(await rows('auth.entra.only.on'),[],'no switch row after the races');
 }

 // ---- set-entra-only on: locks the built-in accounts -------------------------------------
 const bob=await builtIn('bob',{owner:false,status:'invited',password:false});
 const bobToken='b'.repeat(64);
 await insertRow(d,'local_account_tokens',{token_hash:sha(bobToken),user_id:bob.id,kind:'invite',created_at:Date.now(),expires_at:Date.now()+86_400_000,auth_version:1,used_at:null});
 const aliceSession=await f.localLogin(alice);
 const emergencySession=await f.localLogin(emergency);
 await insertRow(d,'mfa_grants',{token_hash:sha('grant-of-emergency'),principal:emergency.actor.principal,user_id:emergency.id,created_at:Date.now(),expires_at:Date.now()+28_800_000});
 await insertRow(d,'audit',{at:Date.now()-1000,actor:alice.actor.label,action:'auth.login',target:alice.id,server_id:null,scope:'portal',customer_id:null});
 const before={users:await f.count(sql`SELECT count(*) AS n FROM local_users`),assignments:await f.count(sql`SELECT count(*) AS n FROM role_assignments`),audit:await f.count(sql`SELECT count(*) AS n FROM audit`)};
 const toLock=await f.count(sql`SELECT count(*) AS n FROM local_users WHERE identity_source='local' AND status IN ('active','invited') AND id<>${emergency.id}`);
 const lockedBefore=await f.count(sql`SELECT count(*) AS n FROM local_users WHERE identity_source='local' AND status='disabled'`);
 const versions=Object.fromEntries(await Promise.all([carol,alice,bob].map(async account=>[account.id,Number((await userRow(account.id)).auth_version)])));
 const revision=Number((await settings()).revision);
 {
  const viewBefore=(await post(owner.browser,{action:'test'})).body;
  check([viewBefore.entraOnly.enabled,viewBefore.entraOnly.lockedAccounts,viewBefore.switchChecks],[false,toLock,{signIn:true,emergency:true,viewerEntraOwner:true,mailChannel:false}],'the view before the switch: the accounts to lock and every check');
  const missing=await post(owner.browser,{action:'set-entra-only',enabled:true});
  check(missing.body.code,'MFA_STEP_UP_REQUIRED','set-entra-only without a proof: step-up');
  const on=await setOn(owner);
  check([on.status,on.body.locked,on.body.entraOnly.enabled,on.body.entraOnly.by,on.body.entraOnly.lockedAccounts],[200,toLock,true,owner.viewer.displayName,toLock+lockedBefore],'switched on with the number it locked; the view counts every locked built-in account; By is the display name of the Owner');
  check([owner.viewer.label.endsWith('.entra.serverdesk.invalid'),JSON.stringify(on.body).includes('.serverdesk.invalid')],[true,false],'the reply names no internal account value');
  const row=await settings();
  check([row.entra_only,row.emergency_user_id,row.entra_only_by,typeof Number(row.entra_only_at)],[1,emergency.id,owner.viewer.label,'number'],'the settings row');
  for(const account of [carol,alice,bob]){
   const user=await userRow(account.id);
   check([user.status,Number(user.auth_version)],['disabled',versions[account.id]+1],`${account.name} is locked with auth_version+1`);
   check(await sessionsOf(account.id),0,`${account.name} has no session`);
  }
  check(await f.viewerOf(aliceSession),null,'the locked session no longer signs in');
  check(await f.count(sql`SELECT count(*) AS n FROM local_account_tokens WHERE user_id=${bob.id} AND used_at IS NULL`),0,'the open invitation is used');
  check([(await userRow(emergency.id)).status,await sessionsOf(emergency.id),await f.count(sql`SELECT count(*) AS n FROM mfa_grants WHERE principal=${emergency.actor.principal}`),await f.viewerOf(emergencySession)],['active',0,0,null],'the emergency access stays active; its sessions and MFA grants end');
  check((await f.viewerOf(owner.browser))?.userId,owner.id,'the session of the Entra Owner stays');
  check(await f.count(sql`SELECT count(*) AS n FROM role_assignments WHERE principal_type='user' AND scope_type='global' AND scope_id='*' AND role_id='builtin-owner' AND principal_id IN (${owner.id},${emergency.id})`),2,'the viewer and the emergency access keep their global Owner assignments');
  check([await f.count(sql`SELECT count(*) AS n FROM local_users`),await f.count(sql`SELECT count(*) AS n FROM role_assignments`),await f.count(sql`SELECT count(*) AS n FROM audit`)>=before.audit+toLock+1],[before.users,before.assignments,true],'no account, assignment or audit row deleted');
  check(await rows('auth.entra.only.on'),[[owner.viewer.label,`emergency=${emergency.id} locked=${toLock} revision=${revision}`]],'one switch row');
  const disabled=(await rows('auth.user.disable')).filter(([actor])=>actor===owner.viewer.label);
  check([disabled.length,disabled.some(([,target])=>target===alice.id),disabled.some(([,target])=>target===bob.id),disabled.some(([,target])=>target===emergency.id)],[toLock,true,true,false],'one auth.user.disable row per locked account, none for the emergency access');
  const old=await d.one(sql`${auditScope.auditSelect} WHERE a.action='auth.login' AND a.target=${alice.id}`);
  check(old.actor,'Alice','the audit view still shows the old display name');
  const same=await post(owner.browser,{action:'set-entra-only',enabled:true,managementToken:'a'.repeat(64)});
  check([same.status,(await rows('auth.entra.only.on')).length],[200,1],'switching on again changes nothing');
 }

 // ---- While on: sign-in --------------------------------------------------------------------
 {
  const locked=await authPost(null,{action:'login',username:'alice',password:'alice-password'});
  check([locked.status,locked.body.messageKey],[401,'apiError.auth.invalidCredentials'],'a locked account: invalidCredentials');
  const other=await builtIn('other',{owner:false});
  const refused=await authPost(null,{action:'login',username:'other',password:'other-password'});
  check([refused.status,refused.body.messageKey,await sessionsOf(other.id)],[401,'apiError.auth.invalidCredentials',0],'another active built-in account: invalidCredentials from the guard of the insert');
  const wrong=await authPost(null,{action:'login',username:'nobody',password:'x'});
  check(wrong.body,locked.body,'the answers do not show which account exists');
  const allowed=await authPost(null,{action:'login',username:'emergency',password:'emergency-password'});
  check([allowed.status,allowed.body.ok],[200,true],'the emergency access signs in with its password');
  const status=await f.answer(await m.authApi.GET(f.request('/api/auth')));
  check([status.body.entra,JSON.stringify(status.body).includes(tenant),JSON.stringify(status.body).includes(clientId),JSON.stringify(status.body).includes(emergency.id)],[{enabled:true,entraOnly:true},false,false,false],'GET /api/auth: entraOnly without tenant, client or account');
 }

 // ---- While on: account actions --------------------------------------------------------------
 {
  const manage=async payload=>{const managementToken=await entraProof(owner);return authPost(owner.browser,{...payload,managementToken});};
  const created=await manage({action:'create-user',username:'newcomer',displayName:'Newcomer'});
  check([created.status,created.body.messageKey,await f.count(sql`SELECT count(*) AS n FROM local_users WHERE username='newcomer'`)],[409,'apiError.account.entraOnly',0],'create-user: entraOnly');
  const unlock=await manage({action:'disable-user',userId:alice.id,disabled:false});
  check([unlock.status,unlock.body.messageKey,(await userRow(alice.id)).status],[409,'apiError.account.entraOnly','disabled'],'unlocking a built-in account: entraOnly');
  const lockEmergency=await manage({action:'disable-user',userId:emergency.id,disabled:true});
  check([lockEmergency.status,lockEmergency.body.messageKey,(await userRow(emergency.id)).status],[409,'apiError.account.emergencyAccount','active'],'locking the emergency access: emergencyAccount');
  const colleague=await entraAccount('cccccccc-0000-4000-8000-000000000003',{owner:false});
  owner.browser=(await entraAccount(owner.oid,{owner:false})).browser;
  const lockEntra=await manage({action:'disable-user',userId:colleague.id,disabled:true});
  check([lockEntra.status,(await userRow(colleague.id)).status],[200,'disabled'],'an Entra account is locked as before');
  const unlockEntra=await manage({action:'disable-user',userId:colleague.id,disabled:false});
  check([unlockEntra.status,(await userRow(colleague.id)).status],[200,'active'],'an Entra account is unlocked as before');
  const redeem=await authPost(null,{action:'redeem',token:bobToken,username:'bob',password:'a-long-enough-password'});
  check([redeem.status,redeem.body.messageKey],[400,'apiError.account.invalidToken'],'the invitation of a locked account: invalidToken');
  // An invitation that exists anyway (written past the portal) is refused by the guard of the redeem.
  const dave=await builtIn('dave',{owner:false,status:'invited',password:false}),daveToken='d'.repeat(64);
  await insertRow(d,'local_account_tokens',{token_hash:sha(daveToken),user_id:dave.id,kind:'invite',created_at:Date.now(),expires_at:Date.now()+86_400_000,auth_version:1,used_at:null});
  const daveRedeem=await authPost(null,{action:'redeem',token:daveToken,username:'dave',password:'a-long-enough-password'});
  check([daveRedeem.body.messageKey,(await userRow(dave.id)).status],['apiError.account.invalidToken','invited'],'redeem while on: invalidToken from the guard');
  await d.exec(sql`UPDATE local_users SET status='disabled' WHERE id IN (${dave.id},${(await d.one(sql`SELECT id FROM local_users WHERE username='other'`)).id})`);
  // The role assignment of the emergency access.
  const rbacToken=await entraProof(owner);f.setViewer(await f.viewerOf(owner.browser));
  const removed=await f.answer(await m.rbacApi.POST(f.request('/api/rbac',{browser:owner.browser,payload:{action:'delete-assignment',id:emergency.assignmentId,managementToken:rbacToken}})));
  check([removed.status,removed.body.messageKey,await f.count(sql`SELECT count(*) AS n FROM role_assignments WHERE id=${emergency.assignmentId}`)],[409,'apiError.rbac.emergencyOwner',1],'removing the Owner assignment of the emergency access: emergencyOwner');
  const reset=await manage({action:'reset-link',userId:emergency.id});
  check([reset.status,typeof reset.body.invitationUrl],[200,'string'],'a reset link for the emergency access still works');
 }

 // ---- While on: the factors of the emergency access ------------------------------------------
 {
  let browser=await f.localLogin(emergency);
  const disable=await mfaPost(browser,{action:'disable',managementToken:browser.management});
  check([disable.status,disable.body.messageKey,await f.count(sql`SELECT count(*) AS n FROM mfa_accounts WHERE principal=${emergency.actor.principal}`)],[409,'apiError.mfa.emergencyFactorRequired',1],'disabling MFA: emergencyFactorRequired');
  browser=await f.localLogin(emergency);
  const last=await mfaPost(browser,{action:'authenticator-delete',id:sha('authenticator:'+emergency.id),managementToken:browser.management});
  check([last.status,last.body.messageKey],[409,'apiError.mfa.emergencyFactorRequired'],'deleting the last factor: emergencyFactorRequired');
  // The emergency access gets no MFA grant and uses none (docs/entra-id.md).
  const primary=crypto.randomBytes(32).toString('hex'),at=Date.now();
  await insertRow(d,'local_auth_sessions',{token_hash:sha(primary),user_id:emergency.id,auth_version:1,created_at:at,expires_at:at+86_400_000,pending_until:at+600_000,mfa_hash:null});
  const signedIn=await mfaPost({primary},{action:'verify',recoveryCode:emergency.codes.shift(),remember24:true});
  check([signedIn.status,'rememberAvailable' in signedIn.body,browserAfter(signedIn.response,{}).grant??null,await f.count(sql`SELECT count(*) AS n FROM mfa_grants WHERE principal=${emergency.actor.principal}`)],[200,false,null,0],'the sign-in MFA of the emergency access creates no grant; remember24 is ignored');
  await insertRow(d,'mfa_grants',{token_hash:sha('c'.repeat(64)),principal:emergency.actor.principal,user_id:emergency.id,created_at:Date.now(),expires_at:Date.now()+28_800_000});
  f.setViewer(null);
  const viaGrant=await f.answer(await m.authApi.POST(f.request('/api/auth',{browser:{grant:'c'.repeat(64)},payload:{action:'login',username:'emergency',password:'emergency-password'}})));
  const grantBrowser=browserAfter(viaGrant.response,{});
  check([viaGrant.status,grantBrowser.session,(await d.one(sql`SELECT mfa_hash FROM local_auth_sessions WHERE token_hash=${sha(grantBrowser.primary)}`)).mfa_hash],[200,'',null],'a hand-made grant does not skip the second factor of the emergency access');
  // Adding a factor works: a second authenticator app.
  const fresh=await f.localLogin(emergency);
  const begin=await mfaPost(fresh,{action:'authenticator-begin',name:'Backup',managementToken:fresh.management});
  check(begin.status,200,'authenticator-begin works: '+begin.body.error);
  const confirmed=await mfaPost(fresh,{action:'authenticator-confirm',challengeId:begin.body.challengeId,code:fixtureTotp(begin.body.secret)});
  check([confirmed.status,confirmed.body.authenticatorCount],[200,2],'a second authenticator is added');
  // Changing the password works.
  const change=await f.localLogin(emergency);
  const changed=await authPost(change,{action:'password-change',currentPassword:'emergency-password',newPassword:'the-new-emergency-password',managementToken:change.management});
  check([changed.status,changed.body.loginRequired],[200,true],'the emergency access changes its password');
  // Back to the old password and auth_version 1, which the sessions of f.localLogin carry.
  check(Number((await userRow(emergency.id)).auth_version),2,'the password change ends the old sessions');
  await d.exec(sql`UPDATE local_users SET password_hash='emergency-password',auth_version=1 WHERE id=${emergency.id}`);
 }

 // ---- Sign-in with Microsoft off while on ---------------------------------------------------
 {
  const offToken=await entraProof(owner);
  const off=await post(owner.browser,{action:'set-enabled',enabled:false,managementToken:offToken});
  check([off.status,off.body.enabled,off.body.entraOnly.enabled],[200,false,true],'set-enabled off stays allowed while Microsoft sign-in only is on');
  check(await sessionsOf(owner.id),0,'every Entra session ends');
  const emergencyLogin=await authPost(null,{action:'login',username:'emergency',password:'emergency-password'});
  check(emergencyLogin.status,200,'the emergency access still signs in');
  check((await f.answer(await m.authApi.GET(f.request('/api/auth')))).body.entra,{enabled:false,entraOnly:true},'GET /api/auth: Microsoft off, built-in accounts still locked out');
 }

 // ---- set-entra-only off ------------------------------------------------------------------------
 {
  const browser=await f.localLogin(emergency);
  const view=(await post(browser,{action:'test'})).body;
  check([view.entraOnly.enabled,view.entraOnly.lockedAccounts,view.emergency.account.id],[true,toLock+lockedBefore+2,emergency.id],'the view while on: the locked built-in accounts');
  const fixed=await choose(browser,carol.id,browser.management);
  check([fixed.status,fixed.body.messageKey],[409,'apiError.entra.emergencyFixed'],'the emergency access cannot change while on');
  const off=await post(browser,{action:'set-entra-only',enabled:false,managementToken:browser.management});
  check([off.status,off.body.entraOnly.enabled,(await settings()).emergency_user_id],[200,false,emergency.id],'the emergency access switches it off; the choice stays');
  check((await rows('auth.entra.only.off')).map(([actor])=>actor),[emergency.actor.label],'one auth.entra.only.off row');
  check((await userRow(alice.id)).status,'disabled','the locked accounts stay locked');
  const again=await f.localLogin(emergency);
  check([(await post(again,{action:'set-entra-only',enabled:false,managementToken:again.management})).status,(await rows('auth.entra.only.off')).length],[200,1],'switching off again changes nothing');
  const unlock=await authPost(again,{action:'disable-user',userId:alice.id,disabled:false,managementToken:again.management});
  check([unlock.status,(await userRow(alice.id)).status],[200,'active'],'an Owner unlocks a built-in account again');
  const login=await authPost(null,{action:'login',username:'alice',password:'alice-password'});
  check(login.status,200,'the unlocked account signs in');
 }
 console.log(`PASS entra only (${checks} checks): emergency access choice and qualification, switch refusals in order and races, locked accounts with sessions, links and audit, sign-in, account, role and factor rules while on, Microsoft off, and switching off.`);
}finally{await d.close();}
