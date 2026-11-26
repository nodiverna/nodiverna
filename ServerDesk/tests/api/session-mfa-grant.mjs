// The MFA grant of a built-in account (docs/portal-sessions.md, "What each
// sign-in asks for"): a sign-in MFA gives the browser a grant of
// MFA_GRANT_LIFETIME_MS; within it the password alone opens a session after the
// idle timeout; after it, after Sign out and after each early end (password
// change, reset link, authenticator reset and delete, passkey delete, disable,
// lock, role assignment, group right, Microsoft sign-in only) the next sign-in
// asks for MFA again. A grant of another account, the switch "Ask for MFA after
// an automatic sign-out", the emergency access, an account without MFA and
// races between the read and the commit never skip MFA. The passkey sign-in, the
// ignored remember24 and the removed resume. Real lib/server/identity/local-auth.ts,
// lib/server/identity/mfa.ts, lib/server/identity/passkeys.ts, lib/server/identity/rbac.ts,
// lib/server/identity/account-admin.ts, lib/server/identity/session-settings.ts and their
// routes on an isolated PostgreSQL database with a movable clock (tests/support/entra-fixture.mjs).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {entraFixture} from '../support/entra-fixture.mjs';
import {browserAfter,cookieNames,setCookies,setCookieValue} from '../support/session-cookies.mjs';
import {hookDatabase} from '../support/hooked-database.mjs';
import {insertRow} from '../support/source-database.mjs';
import {fixtureTotp} from '../support/mfa-fixture.mjs';
import {sql} from '../../runtime/database.mjs';

// Passwords compare in plain text, so a test sign-in costs no key derivation.
const passwords={verifyPassword:async(password,record)=>typeof password==='string'&&password===record,dummyPasswordRecord:async()=>'\0never-matches',hashPassword:async value=>value,validatePassword:value=>value};
// A passkey assertion that always verifies: the ceremony itself is tested in tests/api/passkey-*.mjs.
const webauthn={generateRegistrationOptions:async()=>({}),verifyRegistrationResponse:async()=>({verified:false}),generateAuthenticationOptions:async()=>({challenge:crypto.randomBytes(16).toString('base64url')}),
 verifyAuthenticationResponse:async({credential})=>({verified:true,authenticationInfo:{newCounter:credential.counter+1,credentialBackedUp:false}})};
const f=await entraFixture({imports:{'./passwords':passwords,'@simplewebauthn/server':webauthn}}),{d,m}=f;
const hooks=hookDatabase(d).hooks;
const settings=f.load('lib/server/identity/session-settings.ts'),db=f.load('lib/server/db.ts'),settingsApi=f.load('app/api/session-settings/route.ts');
let checks=0;
const check=(value,expected,label)=>{assert.deepEqual(value,expected,label);checks++;};
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const token=()=>crypto.randomBytes(32).toString('hex');
const minute=60_000,hour=60*minute,lifetime=settings.MFA_GRANT_LIFETIME_MS;

try{
 check([lifetime,settings.mfaGrantHours],[8*hour,8],'the grant lifetime is the constant MFA_GRANT_LIFETIME_MS of 8 hours');
 // ---- Helpers ----------------------------------------------------------------------
 let serial=0;
 /** A built-in account with a password and an MFA account with recovery codes; `secret` adds an authenticator app; `mfa:false` removes MFA. */
 async function builtIn({permissions=['view'],secret=null,mfa=true}={}){
  const name='grant'+(++serial),fixture=await f.localAccount(name+'@local.test',permissions);
  await d.exec(sql`UPDATE local_users SET username=${name},password_hash=${name+'-password'} WHERE id=${fixture.actor.id}`);
  const authenticatorId=sha('authenticator:'+name);
  if(secret)await insertRow(d,'mfa_authenticators',{id:authenticatorId,principal:fixture.actor.principal,name:'Phone',secret_enc:await m.mfa.encryptSecret(secret,fixture.actor.principal),last_counter:-1,created_at:Date.now(),last_used_at:null});
  if(!mfa)await d.exec(sql`DELETE FROM mfa_accounts WHERE principal=${fixture.actor.principal}`);
  return {...fixture,id:fixture.actor.id,principal:fixture.actor.principal,name,password:name+'-password',authenticatorId};
 }
 const answer=response=>f.answer(response);
 /** POST /api/auth login with the cookies of `browser`; the browser after the reply. */
 async function passwordLogin(account,browser={},password=account.password){
  f.setViewer(null);
  const result=await answer(await m.authApi.POST(f.request('/api/auth',{browser,payload:{action:'login',username:account.name,password}})));
  return {...result,browser:browserAfter(result.response,browser)};
 }
 const viewerFor=async browser=>{const viewer=await f.viewerOf(browser);f.setViewer(viewer);return viewer;};
 const mfaPost=async(browser,payload)=>{await viewerFor(browser);const result=await answer(await m.mfaApi.POST(f.request('/api/mfa',{browser,payload})));return {...result,browser:result.status===200?browserAfter(result.response,browser):browser};};
 const mfaGet=async browser=>{await viewerFor(browser);return answer(await m.mfaApi.GET(f.request('/api/mfa',{browser})));};
 const authGet=async browser=>(await answer(await m.authApi.GET(f.request('/api/auth',{browser})))).body;
 const authPost=async(browser,payload)=>{await viewerFor(browser);return answer(await m.authApi.POST(f.request('/api/auth',{browser,payload})));};
 /** Password, then a recovery code: a sign-in MFA. Returns the browser with its grant and the management token. */
 async function signIn(account,browser={}){
  const login=await passwordLogin(account,browser);
  assert.equal(login.status,200,'password login: '+login.body.error);
  const verified=await mfaPost(login.browser,{action:'verify',recoveryCode:account.codes.shift()});
  assert.equal(verified.status,200,'recovery sign-in: '+verified.body.error);
  return {...verified.browser,management:verified.body.managementToken,reply:verified.body,response:verified.response};
 }
 const grantRow=grant=>grant?d.one(sql`SELECT * FROM mfa_grants WHERE token_hash=${sha(grant)}`):null;
 const grantsOf=account=>f.count(sql`SELECT count(*) AS n FROM mfa_grants WHERE principal=${account.principal}`);
 const primaryRow=browser=>d.one(sql`SELECT * FROM local_auth_sessions WHERE token_hash=${sha(browser.primary)}`);
 /** A login that left a pending session: no MFA session cookie, an unbound primary session, not authenticated. */
 async function pending(login,label){
  check([login.status,login.browser.session,(await primaryRow(login.browser))?.mfa_hash,(await mfaGet(login.browser)).body.authenticated],[200,'',null,false],label);
 }
 /** A login through the grant: a bound primary session and a live MFA session at once, no code, no proof. */
 async function granted(login,label){
  const status=await mfaGet(login.browser);
  check([login.status,typeof login.browser.session,(await primaryRow(login.browser))?.mfa_hash===sha(login.browser.session),status.body.authenticated,'managementToken' in login.body],[200,'string',true,true,false],label);
 }
 const setSwitch=async value=>{await d.exec(sql`DELETE FROM identity_settings WHERE key='session_idle_requires_mfa'`);if(value!==null)await insertRow(d,'identity_settings',{key:'session_idle_requires_mfa',value});};
 const handMadeGrant=async account=>{const value=token(),at=Date.now()+f.offset;await insertRow(d,'mfa_grants',{token_hash:sha(value),principal:account.principal,user_id:account.id,created_at:at,expires_at:at+lifetime});return value;};
 const owner=await builtIn({permissions:['*']});

 // ---- First sign-in: the password gives a pending session; the code gives the grant ---------------
 const secret='JBSWY3DPEHPK3PXP';
 const alice=await builtIn({secret});
 let aliceBrowser;
 {
  const login=await passwordLogin(alice);
  await pending(login,'the password alone: a pending session');
  check(JSON.stringify(login.body).includes(login.browser.primary),false,'the login reply holds no token');
  const verified=await mfaPost(login.browser,{action:'verify',code:fixtureTotp(secret)});
  check(verified.status,200,'TOTP: '+verified.body.error);
  aliceBrowser=verified.browser;
  const row=await grantRow(aliceBrowser.grant),cookie=setCookies(verified.response).find(item=>item.name===cookieNames.grant);
  check([typeof aliceBrowser.grant,!!row,row?.principal,row?.user_id,Number(row?.expires_at)-Number(row?.created_at),await grantsOf(alice)],['string',true,alice.principal,alice.id,lifetime,1],'verify sets __Host-serverdesk-mfa-grant and creates one grant row of 8 hours');
  check(cookie.attributes.filter(value=>!/^max-age=/i.test(value)),['Path=/','Secure','HttpOnly','SameSite=Strict'],'the grant cookie attributes');
  check(Math.abs(Number(cookie.attributes.find(value=>/^max-age=/i.test(value)).split('=')[1])-lifetime/1000)<=2,true,'Max-Age is the time to expires_at');
  check(JSON.stringify(verified.body).includes(aliceBrowser.grant),false,'no JSON reply holds the grant token');
  check(setCookieValue(verified.response,cookieNames.trust),'','the cookie of the removed remembered browser is cleared');
 }

 // ---- The idle path within 8 hours: the password only -------------------------------------------
 {
  const grant=await grantRow(aliceBrowser.grant);
  f.offset=16*minute;
  check(await authGet(aliceBrowser),{viewer:null,passwordConfigured:false,entra:{enabled:false,entraOnly:false}},'after the idle deadline GET /api/auth has no viewer');
  const status=await mfaGet(aliceBrowser);
  check([status.status,status.body.code],[401,'IDENTITY_LOGIN_REQUIRED'],'GET /api/mfa: 401 IDENTITY_LOGIN_REQUIRED');
  f.setViewer(alice.actor);
  const stale=await answer(await m.mfaApi.POST(f.request('/api/mfa',{browser:aliceBrowser,payload:{action:'verify',recoveryCode:alice.codes.shift()}})));
  check([stale.status,stale.body.code],[401,'IDENTITY_LOGIN_REQUIRED'],'verify with the old cookies is refused');
  const auditBefore=await f.count(sql`SELECT count(*) AS n FROM audit WHERE action='auth.login' AND target=${alice.id}`);
  const login=await passwordLogin(alice,aliceBrowser);
  await granted(login,'login with the password and the grant cookie: authenticated without a code');
  const session=await d.one(sql`SELECT * FROM mfa_sessions WHERE token_hash=${sha(login.browser.session)}`);
  check([await grantsOf(alice),login.browser.grant,Number(session.expires_at)<=Number(grant.created_at)+24*hour,Number(session.idle_expires_at)-Number(session.created_at)],[1,aliceBrowser.grant,true,15*minute],'no new grant; the absolute deadline is at most the grant created_at + 24 h; the configured idle time');
  check(await f.count(sql`SELECT count(*) AS n FROM audit WHERE action='auth.login' AND target=${alice.id}`),auditBefore+1,'one auth.login row');
  // Within the grant a second idle end works the same way; a step-up still creates no grant.
  const stepUp=await mfaPost(login.browser,{action:'verify',recoveryCode:alice.codes.shift()});
  check([stepUp.status,typeof stepUp.body.managementToken,stepUp.browser.grant,await grantsOf(alice)],[200,'string',aliceBrowser.grant,1],'a step-up: a proof, no new grant');
  aliceBrowser=stepUp.browser;
 }

 // ---- After 8 hours: a code again, and a new grant ----------------------------------------------
 {
  f.offset=8*hour+minute;
  const login=await passwordLogin(alice,aliceBrowser);
  await pending(login,'after 8 hours the password gives a pending session');
  const verified=await mfaPost(login.browser,{action:'verify',recoveryCode:alice.codes.shift()});
  check([verified.status,verified.browser.grant!==aliceBrowser.grant,!!await grantRow(verified.browser.grant),await grantRow(aliceBrowser.grant)],[200,true,true,null],'the new verify creates a new grant and ends the old one of the cookie');
  f.offset=0;
 }

 // ---- Sign out, then login: the grant is gone and a code is needed --------------------------------
 {
  const bob=await builtIn(),browser=await signIn(bob);
  const logout=await answer(await m.authApi.POST(f.request('/api/auth',{browser,payload:{action:'logout'}})));
  check([logout.status,setCookieValue(logout.response,cookieNames.grant),await grantRow(browser.grant)],[200,'',null],'Sign out deletes the grant row of the cookie and clears the cookie');
  await pending(await passwordLogin(bob,{grant:browser.grant}),'Sign out, then login: a code is needed');
 }

 // ---- Early ends: one scene each ----------------------------------------------------------------
 async function earlyEnd(label,run,{account=null,password=null,unlock=false}={}){
  const target=account??await builtIn(),browser=await signIn(target);
  check(!!await grantRow(browser.grant),true,`${label}: a live grant first`);
  await run(target,browser);
  check(await grantRow(browser.grant),null,`${label}: the grant row is gone`);
  if(unlock)await d.exec(sql`UPDATE local_users SET status='active' WHERE id=${target.id}`);
  const login=await passwordLogin(target,{grant:browser.grant},password??target.password);
  await pending(login,`${label}: the next login is pending`);
 }
 const ownerBrowser=async()=>signIn(owner);
 await earlyEnd('password change',async(target,browser)=>{
  const result=await authPost(browser,{action:'password-change',currentPassword:target.password,newPassword:'a-new-password-for-the-grant',managementToken:browser.management});
  assert.equal(result.status,200,'password change: '+result.body.error);
 },{password:'a-new-password-for-the-grant'});
 {
  const target=await builtIn(),value=token();
  await earlyEnd('reset link redeem',async()=>{
   await insertRow(d,'local_account_tokens',{token_hash:sha(value),user_id:target.id,kind:'reset',created_at:Date.now(),expires_at:Date.now()+hour,auth_version:1,used_at:null});
   f.setViewer(null);
   const result=await answer(await m.authApi.POST(f.request('/api/auth',{payload:{action:'redeem',token:value,username:target.name,password:'a-reset-password-for-the-grant'}})));
   assert.equal(result.status,200,'redeem: '+result.body.error);
  },{account:target,password:'a-reset-password-for-the-grant'});
 }
 await earlyEnd('authenticator reset',async(target,browser)=>{
  const begin=await mfaPost(browser,{action:'authenticator-begin',id:target.authenticatorId,name:'Phone',managementToken:browser.management});
  assert.equal(begin.status,200,'authenticator-begin: '+begin.body.error);
  const confirm=await mfaPost(browser,{action:'authenticator-confirm',challengeId:begin.body.challengeId,code:fixtureTotp(begin.body.secret)});
  assert.equal(confirm.status,200,'authenticator-confirm: '+confirm.body.error);
 },{account:await builtIn({secret})});
 await earlyEnd('authenticator delete',async(target,browser)=>{
  const second=sha('second:'+target.name);
  await insertRow(d,'mfa_authenticators',{id:second,principal:target.principal,name:'Tablet',secret_enc:await m.mfa.encryptSecret(secret,target.principal),last_counter:-1,created_at:Date.now(),last_used_at:null});
  const result=await mfaPost(browser,{action:'authenticator-delete',id:second,managementToken:browser.management});
  assert.equal(result.status,200,'authenticator-delete: '+result.body.error);
 },{account:await builtIn({secret})});
 await earlyEnd('passkey delete',async(target,browser)=>{
  const id='cred_'+target.name;
  await insertRow(d,'passkey_credentials',{id,principal:target.principal,public_key:'AAAA',counter:0,transports:'[]',name:'Key',device:'any',device_type:'singleDevice',backed_up:0,created_at:Date.now(),last_used_at:null});
  await viewerFor(browser);
  const result=await answer(await m.passkeyApi.POST(f.request('/api/passkeys',{browser,payload:{action:'delete',id,managementToken:browser.management}})));
  assert.equal(result.status,200,'passkey delete: '+result.body.error);
 },{account:await builtIn({secret})});
 {
  const target=await builtIn(),browser=await signIn(target);
  const result=await mfaPost(browser,{action:'disable',managementToken:browser.management});
  check([result.status,setCookieValue(result.response,cookieNames.grant),await grantRow(browser.grant)],[200,'',null],'disable: the grant row is gone and the cookie is cleared');
  const login=await passwordLogin(target,{grant:browser.grant});
  check([login.status,login.browser.session,(await mfaGet(login.browser)).body.enabled,(await mfaGet(login.browser)).body.authenticated],[200,'',false,false],'disable: the next login is pending and asks for the MFA setup');
 }
 await earlyEnd('account lock',async target=>{
  const admin=await ownerBrowser();
  const result=await authPost(admin,{action:'disable-user',userId:target.id,disabled:true,managementToken:admin.management});
  assert.equal(result.status,200,'lock: '+result.body.error);
 },{unlock:true});
 await earlyEnd('role assignment added',async target=>{
  const admin=await ownerBrowser();await viewerFor(admin);
  const result=await answer(await m.rbacApi.POST(f.request('/api/rbac',{browser:admin,payload:{action:'add-assignment',subjectType:'user',subjectId:target.id,roleId:'builtin-operator',scopeType:'global',scopeId:'*',managementToken:admin.management}})));
  assert.equal(result.status,200,'add-assignment: '+result.body.error);
 });
 await earlyEnd('group right added',async target=>{
  const group=crypto.randomUUID();
  await insertRow(d,'user_groups',{id:group,name:'Operators '+target.name,description:'',enabled:1,created_at:Date.now()});
  await d.exec(sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(gen_random_uuid()::text,'group',${group},'builtin-operator','global','*',0,'fixture')`);
  const admin=await ownerBrowser();await viewerFor(admin);
  const result=await answer(await m.rbacApi.POST(f.request('/api/rbac',{browser:admin,payload:{action:'add-member',groupId:group,userId:target.id,managementToken:admin.management}})));
  assert.equal(result.status,200,'add-member: '+result.body.error);
 });
 // The switch to Microsoft sign-in only ends every built-in account through revocationStatementsFor
 // (lib/server/identity/entra/settings.ts; the switch itself is in tests/api/entra-only.mjs).
 await earlyEnd('Microsoft sign-in only turned on',async target=>{
  await db.commitAll(m.localAuth.revocationStatementsFor(sql`SELECT id,auth_principal FROM local_users WHERE id=${target.id}`));
 });

 // ---- A grant belongs to its account --------------------------------------------------------------
 {
  const a=await builtIn(),b=await builtIn(),browser=await signIn(a);
  await pending(await passwordLogin(b,{grant:browser.grant}),'the grant of account A plus the password of account B: pending');
  check(!!await grantRow(browser.grant),true,'the grant of A stays');
  await pending(await passwordLogin(a,{grant:'f'.repeat(64)}),'a cookie value that is not a live row is ignored');
 }

 // ---- The switch "Ask for MFA after an automatic sign-out" --------------------------------------------
 {
  await setSwitch('1');
  const c=await builtIn(),cBrowser=await signIn(c);
  check([cBrowser.grant??null,await grantsOf(c)],[null,0],'switch on: verify creates no grant and sets no grant cookie');
  const handMade=await handMadeGrant(c);
  await pending(await passwordLogin(c,{grant:handMade}),'switch on: a hand-made grant row is ignored');
  await setSwitch(null);
  // Turning it on through the settings deletes a live grant that existed before.
  const dAccount=await builtIn(),dBrowser=await signIn(dAccount),admin=await ownerBrowser();
  check(!!await grantRow(dBrowser.grant),true,'a live grant before the switch');
  await viewerFor(admin);
  const on=await answer(await settingsApi.POST(f.request('/api/session-settings',{browser:admin,payload:{action:'set-idle-mfa',required:true,managementToken:admin.management}})));
  check([on.status,on.body.idleRequiresMfa,await grantRow(dBrowser.grant),await f.count(sql`SELECT count(*) AS n FROM mfa_grants`)],[200,true,null,0],'the switch batch deletes every grant');
  // Turned on between the grant read and the commit: a pending session.
  await setSwitch('0');
  const e=await builtIn(),eBrowser=await signIn(e);
  hooks.batch=async texts=>{if(texts.some(text=>text.includes('INSERT INTO local_auth_sessions'))&&texts.some(text=>text.includes('mfa_grants'))){hooks.batch=null;await setSwitch('1');}};
  await pending(await passwordLogin(e,{grant:eBrowser.grant}),'the switch turned on between the read and the commit: pending');
  check(hooks.batch,null,'the hook ran');
  // Turned off again: the next sign-in MFA creates a grant, and the next idle sign-in needs no code.
  await setSwitch('0');
  const off=await signIn(e);
  check(!!await grantRow(off.grant),true,'switch off again: the sign-in MFA creates a grant');
  f.offset=16*minute;
  await granted(await passwordLogin(e,off),'switch off again: the idle sign-in needs no code');
  f.offset=0;
  // The grant deleted between the read and the commit: a pending session.
  const g=await builtIn(),gBrowser=await signIn(g);
  hooks.batch=async texts=>{if(texts.some(text=>text.includes('INSERT INTO local_auth_sessions'))&&texts.some(text=>text.includes('mfa_grants'))){hooks.batch=null;await d.exec(sql`DELETE FROM mfa_grants WHERE token_hash=${sha(gBrowser.grant)}`);}};
  await pending(await passwordLogin(g,{grant:gBrowser.grant}),'the grant deleted between the read and the commit: pending');
  check(hooks.batch,null,'the hook ran');
  await setSwitch(null);
 }

 // ---- The emergency access while Microsoft sign-in only is on --------------------------------------
 {
  await f.configure();
  const emergency=await builtIn({permissions:['*']});
  await d.exec(sql`UPDATE entra_settings SET emergency_user_id=${emergency.id},entra_only=1,entra_only_at=${Date.now()},entra_only_by='fixture'`);
  const browser=await signIn(emergency);
  check([browser.grant??null,await grantsOf(emergency)],[null,0],'the emergency access gets no grant');
  const handMade=await handMadeGrant(emergency);
  await pending(await passwordLogin(emergency,{grant:handMade}),'a hand-made grant row of the emergency access is ignored');
  await d.exec(sql`UPDATE entra_settings SET entra_only=0`);
 }

 // ---- A built-in account without MFA --------------------------------------------------------------
 {
  const plain=await builtIn({mfa:false});
  for(const [label,browser] of [['after Sign out',{}],['after the idle timeout',{grant:await handMadeGrant(plain)}]]){
   const login=await passwordLogin(plain,browser),status=await mfaGet(login.browser);
   check([login.status,login.browser.session,status.body.enabled,status.body.authenticated],[200,'',false,false],`no MFA, ${label}: enabled false, never authenticated; a hand-made grant is ignored`);
  }
 }

 // ---- Passkey sign-in, remember24 and the removed resume ---------------------------------------------
 {
  const p=await builtIn(),credential='cred_passkey_'+p.name,challengeId=token(),passkeyBrowser=token(),at=Date.now();
  await insertRow(d,'passkey_credentials',{id:credential,principal:p.principal,public_key:'AAAA',counter:5,transports:'[]',name:'Laptop',device:'local',device_type:'singleDevice',backed_up:0,created_at:at,last_used_at:null});
  await insertRow(d,'passkey_challenges',{id:challengeId,principal:p.principal,purpose:'authentication',challenge:'challenge',browser_hash:sha(passkeyBrowser),session_hash:null,rp_id:'entra.test',origin:'https://entra.test',name:'',device:'any',expires_at:at+300_000});
  const login=await passwordLogin(p);
  const browser={...login.browser,passkey:passkeyBrowser};await viewerFor(browser);
  const result=await answer(await m.passkeyApi.POST(f.request('/api/passkeys',{browser,payload:{action:'authentication-verify',challengeId,remember24:true,response:{id:credential,rawId:credential,type:'public-key',response:{clientDataJSON:Buffer.from('{}').toString('base64url')}}}})));
  const after=browserAfter(result.response,browser);
  check([result.status,typeof after.grant,await grantsOf(p),setCookieValue(result.response,cookieNames.trust),'rememberAvailable' in result.body],[200,'string',1,'',false],'passkey authentication-verify with remember24: one grant, the old trust cookie only cleared');
  const resume=await mfaPost(after,{action:'resume'});
  check([resume.status,resume.body.messageKey],[400,'apiError.mfa.unknownAction'],'POST /api/mfa resume: the unknown-action error');
  const remembered=await mfaPost((await passwordLogin(p,{})).browser,{action:'verify',recoveryCode:p.codes.shift(),remember24:'yes'});
  check([remembered.status,await grantsOf(p)],[200,2],'remember24 of any type is ignored: no error, no extra grant');
 }
 console.log(`PASS session MFA grant (${checks} checks): the grant of a sign-in MFA, the password-only idle sign-in within 8 hours, a code after 8 hours and after Sign out, every early end, the grant bound to its account, the switch and its races, the emergency access, no MFA, passkey, remember24 and resume.`);
}finally{await d.close();}
