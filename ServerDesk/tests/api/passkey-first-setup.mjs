// A new local user can enroll a passkey instead of an authenticator app as the
// first MFA factor. Real route and lib sources run against a migrated
// PostgreSQL test database; log() throws, so every success proves the audit row was
// written in the enrollment batch. Passkey-only accounts keep recovery codes,
// step-up and the rule that at least one passkey or authenticator remains.
// The last authenticator stays while passkeys are unusable at SITE_ORIGIN,
// and the setup account insert is coupled to the primary-session binding.
import {serverText} from '../support/server-text.mjs';
import {HttpError as realHttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFileSync} from 'node:fs';
import {sourceDatabase,sourceLoader,sourceActor,inTransaction,createTrigger,dropTrigger} from '../support/source-database.mjs';
import {hookDatabase} from '../support/hooked-database.mjs';
import {browserAfter,sessionHeaders} from '../support/session-cookies.mjs';
import {sql} from '../../runtime/database.mjs';

const d=await sourceDatabase();
try{
 const origin='https://passkey.test';
 // SITE_ORIGIN and the app clock offset are switchable per scene.
 let siteOrigin=origin,clockSkew=0;
 const HttpError=realHttpError;
 const unavailable=serverText('apiError.storageUnavailable');
 const token=()=>crypto.randomBytes(32).toString('hex'),sha=value=>crypto.createHash('sha256').update(value).digest('hex');
 // A one-shot hook runs right before the first transaction whose statements
 // match (the hooked database reads them in a rolled-back dry run).
 let beforeBatch=null,batches=0;
 const database=hookDatabase(d,{
  transaction:async()=>{batches++;},
  batch:async texts=>{const hook=beforeBatch;if(hook&&hook.match(texts)){beforeBatch=null;await hook.run();}},
 });
 let current=null;
 const server={
  db:()=>database,config:key=>key==='SESSION_SECRET'?'s'.repeat(64):key==='SITE_ORIGIN'?siteOrigin:'',now:()=>Date.now()+clockSkew,random:token,hash:async value=>sha(value),HttpError,
  body:request=>request.json(),sameOrigin:()=>{},requireAuthIdentity:async()=>current,
  log:async()=>{throw new Error('log() must not be used by atomic security actions');},
  // Mirrors lib/server/context.ts failure(): any non-HttpError becomes the generic 503.
  failure:e=>Response.json({error:e instanceof HttpError?e.message:unavailable,...(e instanceof HttpError&&e.code?{code:e.code}:{})},{status:e instanceof HttpError?e.status:503}),
 };
 // The WebAuthn stub records its arguments. Verification succeeds unless
 // `rejectNext` is set, and returns the response's own credential ID.
 const calls={options:[],verify:[]};let rejectNext=false;
 const webauthn={
  generateRegistrationOptions:async args=>{calls.options.push(args);return {challenge:'registration-'+token()};},
  verifyRegistrationResponse:async args=>{calls.verify.push(args);if(rejectNext){rejectNext=false;return {verified:false};}return {verified:true,registrationInfo:{credential:{id:args.response.id,publicKey:new Uint8Array([1,2,3,4]),counter:0,transports:['internal']},credentialDeviceType:'multiDevice',credentialBackedUp:true}};},
  generateAuthenticationOptions:async()=>({challenge:'authentication-'+token()}),
  verifyAuthenticationResponse:async({credential})=>({verified:true,authenticationInfo:{newCounter:credential.counter+1,credentialBackedUp:true}}),
 };
 const load=sourceLoader(),dependencies={'../context':server,'./context':server,'../../context':server,'@/lib/server/context':server,'@simplewebauthn/server':webauthn};
 const mfa=load('lib/server/identity/mfa.ts',dependencies);
 const mfaApi=load('app/api/mfa/route.ts',dependencies),passkeyApi=load('app/api/passkeys/route.ts',dependencies);

 const one=async statement=>d.one(statement);
 const count=async(sql,...bindings)=>(await one(sql,...bindings)).n;
 const audits=async(action,fixture)=>count(sql`SELECT count(*) AS n FROM audit WHERE action=${action} AND actor=${fixture.actor.label}`);
 const failAudit=()=>createTrigger(d,'audit_unavailable','audit','BEFORE INSERT',{message:'audit unavailable'});
 const restoreAudit=()=>dropTrigger(d,'audit_unavailable');
 const setupDone=serverText('apiError.passkey.setupDone');
 const lastFactor=serverText('apiError.passkey.lastFactor');
 const lastAuthenticator=serverText('apiError.mfa.lastAuthenticator');

 // A local user with a password and a pending primary session, without MFA.
 async function newcomer(label){
  const {actor}=await sourceActor(d,label,['*']);actor.userId=actor.id;
  const primary=token(),at=Date.now();
  await d.exec(sql`UPDATE local_users SET password_hash='fixture-password',must_reset=0 WHERE id=${actor.id}`);
  await d.exec(sql`INSERT INTO local_auth_sessions(token_hash,user_id,auth_version,created_at,expires_at,pending_until,mfa_hash) SELECT ${sha(primary)},id,auth_version,${at},${at+86_400_000},${at+600_000},NULL FROM local_users WHERE id=${actor.id}`);
  return {actor,key:actor.principal,primary};
 }
 // An enrolled user with the given number of authenticators and passkeys.
 async function enrolled(label,{authenticators=0,passkeys=0}={}){
  const {actor}=await sourceActor(d,label,['*']);actor.userId=actor.id;
  const key=actor.principal,at=Date.now(),authenticatorIds=[],passkeyIds=[];
  await d.exec(sql`UPDATE local_users SET password_hash='fixture-password',must_reset=0 WHERE id=${actor.id}`);
  await d.exec(sql`INSERT INTO mfa_accounts(principal,secret_enc,recovery_hashes,last_counter,created_at,authenticators_migrated) VALUES(${key},'migrated:authenticator-managed','[]',-1,${at},1)`);
  for(let i=0;i<authenticators;i++){const id=token();authenticatorIds.push(id);await d.exec(sql`INSERT INTO mfa_authenticators(id,principal,name,secret_enc,last_counter,created_at,last_used_at) VALUES(${id},${key},'Authenticator',${await mfa.encryptSecret('A'.repeat(32),key)},-1,${at+i},NULL)`);}
  for(let i=0;i<passkeys;i++)passkeyIds.push(await passkey({key}));
  return {actor,key,authenticatorIds,passkeyIds};
 }
 async function passkey(fixture,name='Laptop'){
  const id='cred_'+crypto.randomBytes(8).toString('hex');
  await d.exec(sql`INSERT INTO passkey_credentials(id,principal,public_key,counter,transports,name,device,device_type,backed_up,created_at,last_used_at) VALUES(${id},${fixture.key},'AAAA',0,'[]',${name},'local','singleDevice',0,${Date.now()},NULL)`);
  return id;
 }
 // A fully signed-in browser: bound primary session, MFA session and proof.
 async function signedIn(fixture){
  const at=Date.now(),primary=token(),session=token(),management=token();
  await inTransaction(d,[
   sql`INSERT INTO mfa_sessions(token_hash,principal,created_at,last_activity,idle_expires_at,expires_at,passkey_id) VALUES(${sha(session)},${fixture.key},${at},${at},${at+3_600_000},${at+86_400_000},NULL)`,
   sql`INSERT INTO local_auth_sessions(token_hash,user_id,auth_version,created_at,expires_at,pending_until,mfa_hash) SELECT ${sha(primary)},id,auth_version,${at},${at+86_400_000},${at+600_000},${sha(session)} FROM local_users WHERE id=${fixture.actor.id}`,
   sql`INSERT INTO mfa_management_proofs(token_hash,principal,session_hash,expires_at) VALUES(${sha(management)},${fixture.key},${sha(session)},${at+300_000})`,
  ]);
  return {primary,session,management};
 }
 // The tokens travel only as cookies.
 const headers=(browser,cookie)=>sessionHeaders(browser,cookie?{Cookie:cookie}:{});
 const post=(api,path,payload,h)=>{const data={...payload};current=data.viewer;delete data.viewer;batches=0;return api.POST(new Request(origin+path,{method:'POST',headers:{'Content-Type':'application/json',...h},body:JSON.stringify(data)}));};
 const get=(api,path,viewer,h)=>{current=viewer;return api.GET(new Request(origin+path,{headers:h}));};
 const passkeyCookie=response=>response.headers.getSetCookie().find(value=>value.startsWith('__Host-serverdesk-passkey='));
 const clientData=type=>Buffer.from(JSON.stringify({type,challenge:'x',origin})).toString('base64url');
 const registrationResponse=(id='cred_'+crypto.randomBytes(8).toString('hex'))=>({id,rawId:id,type:'public-key',response:{clientDataJSON:clientData('webauthn.create'),attestationObject:'AAAA'}});
 const authenticationResponse=id=>({id,rawId:id,type:'public-key',response:{clientDataJSON:clientData('webauthn.get'),authenticatorData:'AAAA',signature:'AAAA'}});
 const setupOptions=(fixture,{device='local',viewer=fixture.actor}={})=>post(passkeyApi,'/api/passkeys',{viewer,action:'setup-options',device},sessionHeaders({primary:fixture.primary}));
 async function started(fixture,device='local'){
  const response=await setupOptions(fixture,{device}),body=await response.json();
  assert.equal(response.status,200,'setup options succeed: '+JSON.stringify(body));
  return {challengeId:body.challengeId,cookie:passkeyCookie(response).split(';')[0],options:body.options};
 }
 const setupVerify=(fixture,start,response=registrationResponse())=>post(passkeyApi,'/api/passkeys',{viewer:fixture.actor,action:'setup-verify',challengeId:start.challengeId,response},sessionHeaders({primary:fixture.primary},{Cookie:start.cookie}));
 const setupChallenges=fixture=>count(sql`SELECT count(*) AS n FROM passkey_challenges WHERE principal=${fixture.key} AND purpose='setup'`);
 // Nothing of an enrollment was committed: no account (other than `account`), no
 // credential, MFA session, proof, MFA grant, bound primary session or audit row.
 async function nothingCommitted(fixture,what,{account=null}={}){
  const row=await one(sql`SELECT recovery_hashes FROM mfa_accounts WHERE principal=${fixture.key}`);
  assert.equal(row?.recovery_hashes??null,account,`${what}: no account row of this enrollment`);
  for(const table of ['passkey_credentials','mfa_sessions','mfa_management_proofs','mfa_grants'])assert.equal(await count(sql`SELECT count(*) AS n FROM ${sql.ident(table)} WHERE principal=${fixture.key}`),0,`${what}: no ${table} row`);
  assert.equal(await count(sql`SELECT count(*) AS n FROM local_auth_sessions WHERE user_id=${fixture.actor.id} AND mfa_hash IS NOT NULL`),0,`${what}: no bound primary session`);
  assert.equal(await audits('MFA mit Passkey eingerichtet',fixture),0,`${what}: no audit row`);
 }

 // Setup options.
 {
  const fixture=await newcomer('options@passkey.test');
  calls.options.length=0;
  const response=await setupOptions(fixture),body=await response.json();
  assert.equal(response.status,200,'setup options need no MFA session or proof');
  assert.equal(calls.options.length,1);
  const args=calls.options[0];
  assert.equal(args.authenticatorSelection.userVerification,'required','user verification is required');
  assert.equal(args.authenticatorSelection.residentKey,'required','a discoverable credential is required');
  assert.equal(args.authenticatorSelection.authenticatorAttachment,'platform');
  assert.equal(args.attestationType,'none');assert.deepEqual(args.supportedAlgorithmIDs,[-7,-257]);
  const row=await one(sql`SELECT * FROM passkey_challenges WHERE id=${body.challengeId}`);
  assert.equal(row.purpose,'setup');assert.equal(row.session_hash,null,'the setup challenge has no MFA session');assert.equal(row.name,'Dieses Gerät');assert.equal(row.device,'local');
  const cookie=passkeyCookie(response);assert.ok(cookie&&/Max-Age=300/.test(cookie),'the passkey browser cookie is set');
  assert.equal(row.browser_hash,sha(cookie.split(';')[0].split('=')[1]),'the challenge is bound to the browser cookie');
  const phone=await setupOptions(fixture,{device:'phone'}),phoneBody=await phone.json();
  assert.equal(phone.status,200);assert.equal((await one(sql`SELECT name FROM passkey_challenges WHERE id=${phoneBody.challengeId}`)).name,'Mein Smartphone');
  assert.equal(calls.options.at(-1).authenticatorSelection.authenticatorAttachment,'cross-platform');
  for(const device of ['any',null,'usb']){
   const invalid=await setupOptions(fixture,{device});
   assert.equal(invalid.status,400);assert.equal((await invalid.json()).error,serverText('apiError.passkey.invalidDevice'),`device ${device} is rejected`);
  }
 }
 {
  const fixture=await enrolled('options-enabled@passkey.test',{authenticators:1});
  const browser=await signedIn(fixture);fixture.primary=browser.primary;
  const response=await setupOptions(fixture);
  assert.equal(response.status,409);assert.equal((await response.json()).error,setupDone,'an enabled account gets the existing-MFA 409');
  assert.equal(await setupChallenges(fixture),0,'no challenge is written');
 }
 {
  const fixture=await newcomer('options-expired@passkey.test');
  await d.exec(sql`UPDATE local_auth_sessions SET pending_until=${Date.now()-1000} WHERE token_hash=${sha(fixture.primary)}`);
  const response=await setupOptions(fixture),body=await response.json();
  assert.equal(response.status,401);assert.equal(body.code,'IDENTITY_LOGIN_REQUIRED','an expired pending session needs a new password login');
  assert.equal(await setupChallenges(fixture),0);
 }
 // The guarded insert: a revocation or an enrollment right before the batch.
 {
  const isChallenge=texts=>texts.some(text=>text.startsWith('INSERT INTO passkey_challenges'));
  const revoked=await newcomer('options-revoked@passkey.test');
  beforeBatch={match:isChallenge,run:()=>d.exec(sql`DELETE FROM local_auth_sessions WHERE token_hash=${sha(revoked.primary)}`)};
  let response=await setupOptions(revoked);
  assert.equal(beforeBatch,null);assert.equal(response.status,401);assert.equal((await response.json()).code,'IDENTITY_LOGIN_REQUIRED');
  assert.equal(await setupChallenges(revoked),0,'a revoked primary session writes no challenge');
  const raced=await newcomer('options-raced@passkey.test');
  beforeBatch={match:isChallenge,run:()=>d.exec(sql`INSERT INTO mfa_accounts(principal,secret_enc,recovery_hashes,last_counter,created_at,authenticators_migrated) VALUES(${raced.key},'migrated:authenticator-managed','[]',-1,${Date.now()},1)`)};
  response=await setupOptions(raced);
  assert.equal(beforeBatch,null);assert.equal(response.status,409);assert.equal((await response.json()).error,setupDone);
  assert.equal(await setupChallenges(raced),0,'an enrollment meanwhile writes no challenge');
 }

 // A failed verification discards the challenge.
 {
  const fixture=await newcomer('verify-failed@passkey.test'),start=await started(fixture);
  rejectNext=true;calls.verify.length=0;
  const response=await setupVerify(fixture,start),body=await response.json();
  assert.equal(calls.verify[0].requireUserVerification,true,'verification requires user verification');
  assert.equal(response.status,400);assert.equal(body.error,serverText('apiError.passkey.verifyFailed'));
  assert.equal(await setupChallenges(fixture),0,'the challenge is deleted');
  await nothingCommitted(fixture,'failed verification');
 }

 // A fresh enrollment commits everything in one batch.
 const owner=await newcomer('owner@passkey.test');
 let ownerBrowser,ownerCodes,ownerCredential;
 {
  const fixture=owner;
  // A pending TOTP setup of the same user goes with the passkey enrollment.
  const begin=await post(mfaApi,'/api/mfa',{viewer:fixture.actor,action:'begin'},sessionHeaders({primary:fixture.primary}));
  assert.equal(begin.status,200,'a TOTP setup is pending');
  assert.equal(await count(sql`SELECT count(*) AS n FROM mfa_challenges WHERE principal=${fixture.key}`),1);
  const start=await started(fixture),response=registrationResponse();ownerCredential=response.id;
  calls.verify.length=0;
  const reply=await setupVerify(fixture,start,response),body=await reply.json();
  assert.equal(reply.status,200,'passkey setup succeeds although log() throws: '+JSON.stringify(body));
  assert.equal(batches,1,'setup-verify commits in exactly one batch');
  assert.equal(calls.verify[0].requireUserVerification,true);
  assert.equal(body.ok,true);
  assert.equal(body.recoveryCodes.length,10,'ten recovery codes');
  assert.match(body.managementToken,/^[a-f0-9]{64}$/,'the reply has the managementToken');
  for(const field of ['proofToken','identityToken'])assert.ok(!(field in body),`the reply body has no ${field}`);
  const issued=browserAfter(reply);assert.match(issued.session,/^[a-f0-9]{64}$/);assert.match(issued.primary,/^[a-f0-9]{64}$/);
  assert.ok(!('authenticatorCount' in body),'the setup reply has no authenticatorCount');assert.equal(body.passkeyCount,1);assert.equal(body.authenticated,true);
  const account=await one(sql`SELECT * FROM mfa_accounts WHERE principal=${fixture.key}`);
  assert.equal(account.authenticators_migrated,1);assert.equal(account.secret_enc,'migrated:authenticator-managed');assert.equal(account.last_counter,-1);
  assert.equal(JSON.parse(account.recovery_hashes).length,10,'ten recovery hashes');
  const credential=await one(sql`SELECT * FROM passkey_credentials WHERE principal=${fixture.key}`);
  assert.equal(await count(sql`SELECT count(*) AS n FROM passkey_credentials WHERE principal=${fixture.key}`),1,'one credential');
  assert.equal(credential.id,ownerCredential);assert.equal(credential.name,'Dieses Gerät');assert.equal(credential.device,'local');assert.equal(credential.device_type,'multiDevice');assert.equal(credential.backed_up,1);
  assert.equal(await count(sql`SELECT count(*) AS n FROM mfa_authenticators WHERE principal=${fixture.key}`),0,'no authenticator');
  const session=await one(sql`SELECT * FROM mfa_sessions WHERE token_hash=${sha(issued.session)}`);
  assert.equal(session.passkey_id,ownerCredential,'the MFA session records the new passkey');
  assert.equal(await one(sql`SELECT token_hash FROM local_auth_sessions WHERE token_hash=${sha(fixture.primary)}`),null,'the pending primary session is retired');
  assert.equal((await one(sql`SELECT mfa_hash FROM local_auth_sessions WHERE token_hash=${sha(issued.primary)}`)).mfa_hash,sha(issued.session),'the rotated primary session is bound');
  assert.equal(await count(sql`SELECT count(*) AS n FROM mfa_management_proofs WHERE principal=${fixture.key} AND token_hash=${sha(body.managementToken)}`),1,'one management proof');
  assert.equal(await count(sql`SELECT count(*) AS n FROM mfa_management_proofs WHERE principal=${fixture.key}`),1);
  assert.equal(await count(sql`SELECT count(*) AS n FROM mfa_challenges WHERE principal=${fixture.key}`),0,'the pending TOTP setup is gone');
  assert.equal(await setupChallenges(fixture),0,'the setup challenge is gone');
  assert.equal(await audits('MFA mit Passkey eingerichtet',fixture),1,'exactly one audit row');
  assert.deepEqual(await one(sql`SELECT actor,target,server_id,scope FROM audit WHERE action='MFA mit Passkey eingerichtet' AND actor=${fixture.actor.label}`),{actor:'owner@passkey.test',target:'owner@passkey.test',server_id:null,scope:'portal'});
  const cookies=reply.headers.getSetCookie();
  assert.ok(cookies.some(c=>c.startsWith('__Host-serverdesk-mfa=')&&!/Max-Age=0/.test(c)),'the MFA session cookie is set');
  assert.ok(cookies.some(c=>c.startsWith('__Host-serverdesk-auth=')&&!/Max-Age=0/.test(c)),'the rotated primary cookie is set');
  assert.ok(cookies.some(c=>c.startsWith('__Host-serverdesk-passkey=;')&&/Max-Age=0/.test(c)),'the passkey cookie is cleared');
  ownerBrowser={primary:issued.primary,session:issued.session,management:body.managementToken};ownerCodes=body.recoveryCodes;
  // The used challenge cannot enroll again.
  const replay=await setupVerify({...fixture,primary:ownerBrowser.primary},start,registrationResponse());
  assert.equal(replay.status,409,'a used setup challenge is gone');
 }

 // Refused commits.
 const isSetup=texts=>texts.some(text=>text.startsWith('INSERT INTO mfa_accounts')&&text.includes("'migrated:authenticator-managed'"));
 {
  // A TOTP enrollment (direct account insert) wins the race.
  const fixture=await newcomer('race-totp@passkey.test'),start=await started(fixture);
  beforeBatch={match:isSetup,run:()=>d.exec(sql`INSERT INTO mfa_accounts(principal,secret_enc,recovery_hashes,last_counter,created_at,authenticators_migrated) VALUES(${fixture.key},'migrated:authenticator-managed','["totp"]',-1,${Date.now()},1)`)};
  const response=await setupVerify(fixture,start),body=await response.json();
  assert.equal(beforeBatch,null,'the hook ran before the enrollment batch');
  assert.equal(response.status,409);assert.equal(body.error,serverText('apiError.mfa.setupUsed'));
  await nothingCommitted(fixture,'concurrent enrollment',{account:'["totp"]'});
  assert.equal(await setupChallenges(fixture),0,'the challenge cannot be reused');
 }
 {
  // A second setup-verify of the same user, from another password login, wins.
  const fixture=await newcomer('race-setup@passkey.test'),first=await started(fixture);
  const other={...fixture,primary:token()},at=Date.now();
  await d.exec(sql`INSERT INTO local_auth_sessions(token_hash,user_id,auth_version,created_at,expires_at,pending_until,mfa_hash) SELECT ${sha(other.primary)},id,auth_version,${at},${at+86_400_000},${at+600_000},NULL FROM local_users WHERE id=${fixture.actor.id}`);
  const second=await started(other);
  let winner=null;
  beforeBatch={match:isSetup,run:async()=>{winner=await setupVerify(other,second);}};
  const response=await setupVerify(fixture,first);
  assert.equal(winner.status,200,'the other enrollment committed');
  assert.equal(response.status,409);assert.equal((await response.json()).error,serverText('apiError.mfa.setupUsed'));
  assert.equal(await count(sql`SELECT count(*) AS n FROM passkey_credentials WHERE principal=${fixture.key}`),1,'only the winner credential exists');
  assert.equal(await count(sql`SELECT count(*) AS n FROM mfa_sessions WHERE principal=${fixture.key}`),1,'only the winner session exists');
  assert.equal(await count(sql`SELECT count(*) AS n FROM mfa_management_proofs WHERE principal=${fixture.key}`),1,'only the winner proof exists');
  assert.equal(await audits('MFA mit Passkey eingerichtet',fixture),1,'only the winner is audited');
  assert.equal(await setupChallenges(fixture),0);
 }
 {
  // The primary session is revoked right before the batch.
  const fixture=await newcomer('race-revoked@passkey.test'),start=await started(fixture);
  beforeBatch={match:isSetup,run:()=>d.exec(sql`DELETE FROM local_auth_sessions WHERE token_hash=${sha(fixture.primary)}`)};
  const response=await setupVerify(fixture,start),body=await response.json();
  assert.equal(beforeBatch,null);
  assert.equal(response.status,401);assert.ok(['SESSION_EXPIRED','IDENTITY_LOGIN_REQUIRED'].includes(body.code),'a revoked primary session gets a re-login code');
  await nothingCommitted(fixture,'revoked primary session');
  assert.equal(await setupChallenges(fixture),0,'the challenge cannot be reused');
 }
 {
  // Revoked before the request: the guard fails before any batch.
  const fixture=await newcomer('revoked-early@passkey.test'),start=await started(fixture);
  await d.exec(sql`DELETE FROM local_auth_sessions WHERE token_hash=${sha(fixture.primary)}`);
  const response=await setupVerify(fixture,start);
  assert.equal(response.status,401);assert.equal((await response.json()).code,'IDENTITY_LOGIN_REQUIRED');
  await nothingCommitted(fixture,'revoked before the request');
  assert.equal(await setupChallenges(fixture),0,'the challenge cannot be reused');
 }
 // The account insert is refused whenever the session binding is:
 // a session or user change right before the batch leaves nothing behind. The
 // auth_principal and app-clock cases pin the coupling of localBindGuard and
 // bindLocalMfaStatements().bind (lib/server/identity/local-auth.ts); primaryAuthenticationGuard
 // alone lets them commit an account without a session.
 {
  const user=fixture=>sql`SELECT id FROM local_users WHERE id=${fixture.actor.id}`;
  const cases=[
   ['user disabled',fixture=>d.exec(sql`UPDATE local_users SET status='disabled' WHERE id=${fixture.actor.id}`)],
   ['must_reset',fixture=>d.exec(sql`UPDATE local_users SET must_reset=1 WHERE id=${fixture.actor.id}`)],
   ['password removed',fixture=>d.exec(sql`UPDATE local_users SET password_hash=NULL WHERE id=${fixture.actor.id}`)],
   ['auth_version bumped',fixture=>d.exec(sql`UPDATE local_users SET auth_version=auth_version+1 WHERE id=${fixture.actor.id}`)],
   ['auth_principal changed',fixture=>d.exec(sql`UPDATE local_users SET auth_principal=${fixture.key+'.moved'} WHERE id=${fixture.actor.id}`)],
   ['pending session expired',fixture=>d.exec(sql`UPDATE local_auth_sessions SET pending_until=${Date.now()-1000} WHERE token_hash=${sha(fixture.primary)}`)],
   // Expired by the app clock only: the SQL clock still sees it as pending.
   ['pending session expired by the app clock',fixture=>d.exec(sql`UPDATE local_auth_sessions SET pending_until=${Date.now()+30_000} WHERE token_hash=${sha(fixture.primary)}`),60_000],
  ];
  for(const [what,change,skew=0] of cases){
   clockSkew=skew;
   try{
    const fixture=await newcomer(`bind-${what.replace(/[^a-z]+/g,'-')}@passkey.test`),start=await started(fixture);
    assert.ok(await d.one(user(fixture)),`${what}: the user exists`);
    beforeBatch={match:isSetup,run:()=>change(fixture)};
    const response=await setupVerify(fixture,start),body=await response.json();
    assert.equal(beforeBatch,null,`${what}: the hook ran before the enrollment batch`);
    assert.equal(response.status,401,`${what}: the reply is 401, got ${response.status} ${JSON.stringify(body)}`);
    assert.ok(['SESSION_EXPIRED','IDENTITY_LOGIN_REQUIRED'].includes(body.code),`${what}: a re-login code`);
    await nothingCommitted(fixture,`session binding: ${what}`);
    assert.equal(await count(sql`SELECT count(*) AS n FROM mfa_accounts WHERE principal=${fixture.key}`),0,`${what}: no mfa_accounts row`);
   }finally{clockSkew=0;}
  }
 }
 {
  // The credential ID already belongs to another account.
  const fixture=await newcomer('duplicate@passkey.test'),start=await started(fixture);
  const response=await setupVerify(fixture,start,registrationResponse(ownerCredential)),body=await response.json();
  assert.equal(response.status,409);assert.equal(body.error,serverText('apiError.passkey.duplicate'));
  await nothingCommitted(fixture,'duplicate credential');
  assert.equal(await setupChallenges(fixture),0,'the challenge is deleted');
  assert.equal(await count(sql`SELECT count(*) AS n FROM passkey_credentials WHERE id=${ownerCredential} AND principal=${owner.key}`),1,'the other account keeps its passkey');
 }
 {
  // The audit insert fails: nothing commits and the challenge stays for a retry.
  const fixture=await newcomer('audit-fail@passkey.test'),start=await started(fixture),response=registrationResponse();
  await failAudit();
  let reply;
  try{reply=await setupVerify(fixture,start,response);}finally{await restoreAudit();}
  assert.equal(reply.status,503,'the audit failure propagates');
  await nothingCommitted(fixture,'audit failure');
  assert.equal(await setupChallenges(fixture),1,'the challenge stays usable');
  assert.ok(await one(sql`SELECT token_hash FROM local_auth_sessions WHERE token_hash=${sha(fixture.primary)}`),'the pending primary session stays');
  const retry=await setupVerify(fixture,start,response);
  assert.equal(retry.status,200,'a retry after the audit works again succeeds');
  assert.equal(await audits('MFA mit Passkey eingerichtet',fixture),1);
  assert.equal(await count(sql`SELECT count(*) AS n FROM passkey_credentials WHERE principal=${fixture.key}`),1);
 }

 // The passkey-only account from the fresh enrollment above.
 {
  const fixture=owner,viewer=fixture.actor;
  let status=await (await get(mfaApi,'/api/mfa',viewer,headers(ownerBrowser))).json();
  assert.equal(status.enabled,true);assert.equal(status.authenticated,true);
  assert.equal(status.authenticatorCount,0);assert.equal(status.passkeyCount,1);assert.equal(status.passkeysAvailable,true);
  status=await (await get(mfaApi,'/api/mfa',viewer,headers(ownerBrowser))).json();
  assert.equal(status.authenticatorCount,0);
  assert.equal(await count(sql`SELECT count(*) AS n FROM mfa_authenticators WHERE principal=${fixture.key}`),0,'status reads create no authenticator row');
  const passkeyStatus=await (await get(passkeyApi,'/api/passkeys',viewer,headers(ownerBrowser))).json();
  assert.equal(passkeyStatus.count,1);assert.equal(passkeyStatus.authenticatorCount,0,'GET /api/passkeys reports the authenticator count');
  // A TOTP code fails and counts as an attempt.
  const before=(await one(sql`SELECT attempts FROM mfa_attempts WHERE principal=${fixture.key}`))?.attempts??0;
  let response=await post(mfaApi,'/api/mfa',{viewer,action:'verify',code:'123456'},headers(ownerBrowser));
  assert.equal(response.status,401);assert.equal((await response.json()).error,serverText('apiError.mfa.codeInvalidOrUsed'));
  assert.equal((await one(sql`SELECT attempts FROM mfa_attempts WHERE principal=${fixture.key}`)).attempts,before+1,'the failed code counts');
  // A recovery code yields a session and a management proof.
  const recover=async code=>{
   const reply=await post(mfaApi,'/api/mfa',{viewer,action:'verify',recoveryCode:code},headers(ownerBrowser)),body=await reply.json();
   assert.equal(reply.status,200,'recovery verify succeeds: '+JSON.stringify(body));assert.match(body.managementToken,/^[a-f0-9]{64}$/);
   ownerBrowser={...browserAfter(reply,ownerBrowser),management:body.managementToken};
  };
  await recover(ownerCodes[0]);
  // Adding an authenticator later works with that proof.
  response=await post(mfaApi,'/api/mfa',{viewer,action:'authenticator-begin',name:'Telefon',managementToken:ownerBrowser.management},headers(ownerBrowser));
  const begun=await response.json();assert.equal(response.status,200,'authenticator-begin works: '+JSON.stringify(begun));
  response=await post(mfaApi,'/api/mfa',{viewer,action:'authenticator-confirm',challengeId:begun.challengeId,code:await mfa.totp(begun.secret,Math.floor(Date.now()/30000))},headers(ownerBrowser));
  assert.equal(response.status,200,'authenticator-confirm works');assert.equal((await response.json()).authenticatorCount,1);
  // Regenerating recovery codes works.
  await recover(ownerCodes[1]);
  response=await post(mfaApi,'/api/mfa',{viewer,action:'regenerate-recovery',managementToken:ownerBrowser.management},headers(ownerBrowser));
  assert.equal(response.status,200);assert.equal((await response.json()).recoveryCodes.length,10);
  // Passkey login yields the management proof for step-up; adding a passkey works with it.
  response=await post(passkeyApi,'/api/passkeys',{viewer,action:'authentication-options',device:'any'},headers(ownerBrowser));
  const authOptions=await response.json();assert.equal(response.status,200);
  response=await post(passkeyApi,'/api/passkeys',{viewer,action:'authentication-verify',challengeId:authOptions.challengeId,response:authenticationResponse(ownerCredential)},headers(ownerBrowser,passkeyCookie(response).split(';')[0]));
  const login=await response.json();assert.equal(response.status,200,'passkey login works: '+JSON.stringify(login));assert.match(login.managementToken,/^[a-f0-9]{64}$/);
  ownerBrowser={...browserAfter(response,ownerBrowser),management:login.managementToken};
  response=await post(passkeyApi,'/api/passkeys',{viewer,action:'registration-options',name:'Zweiter',device:'phone',managementToken:ownerBrowser.management},headers(ownerBrowser));
  const regOptions=await response.json();assert.equal(response.status,200,'registration-options work with a passkey proof: '+JSON.stringify(regOptions));
  response=await post(passkeyApi,'/api/passkeys',{viewer,action:'registration-verify',challengeId:regOptions.challengeId,response:registrationResponse()},headers(ownerBrowser,passkeyCookie(response).split(';')[0]));
  assert.equal(response.status,200,'registration-verify works');
  assert.equal(await count(sql`SELECT count(*) AS n FROM passkey_credentials WHERE principal=${fixture.key}`),2);
 }
 {
  // disable works on a passkey-only account and removes its passkey.
  const fixture=await enrolled('disable@passkey.test',{passkeys:1}),browser=await signedIn(fixture);
  const response=await post(mfaApi,'/api/mfa',{viewer:fixture.actor,action:'disable',managementToken:browser.management},headers(browser));
  assert.equal(response.status,200);
  assert.equal(await count(sql`SELECT count(*) AS n FROM mfa_accounts WHERE principal=${fixture.key}`),0);
  assert.equal(await count(sql`SELECT count(*) AS n FROM passkey_credentials WHERE principal=${fixture.key}`),0);
 }

 // The last passkey of a passkey-only account stays.
 {
  const fixture=await enrolled('last-passkey@passkey.test',{passkeys:1}),browser=await signedIn(fixture);
  const response=await post(passkeyApi,'/api/passkeys',{viewer:fixture.actor,action:'delete',id:fixture.passkeyIds[0],managementToken:browser.management},headers(browser));
  assert.equal(response.status,409);assert.equal((await response.json()).error,lastFactor);
  assert.equal(batches,0,'no batch runs');
  assert.ok(await one(sql`SELECT token_hash FROM mfa_management_proofs WHERE token_hash=${sha(browser.management)}`),'the proof stays unused');
  assert.equal(await count(sql`SELECT count(*) AS n FROM passkey_credentials WHERE principal=${fixture.key}`),1);
  assert.equal(await audits('Passkey entfernt',fixture),0);
  const second=await passkey(fixture,'Zweiter');
  const removed=await post(passkeyApi,'/api/passkeys',{viewer:fixture.actor,action:'delete',id:second,managementToken:browser.management},headers(browser));
  assert.equal(removed.status,200,'one of two passkeys can be deleted');
  assert.equal(await count(sql`SELECT count(*) AS n FROM passkey_credentials WHERE principal=${fixture.key}`),1);
  assert.equal(await audits('Passkey entfernt',fixture),1);
 }

 // The last authenticator can go while a passkey remains.
 {
  const fixture=await enrolled('last-authenticator@passkey.test',{authenticators:1,passkeys:1}),browser=await signedIn(fixture);
  const response=await post(mfaApi,'/api/mfa',{viewer:fixture.actor,action:'authenticator-delete',id:fixture.authenticatorIds[0],managementToken:browser.management},headers(browser));
  assert.equal(response.status,200,'the last authenticator is removed');assert.equal((await response.json()).authenticatorCount,0);
  assert.equal(await audits('Authenticator entfernt',fixture),1);
  assert.equal(await count(sql`SELECT count(*) AS n FROM passkey_credentials WHERE principal=${fixture.key}`),1,'the passkey remains');
 }
 {
  const fixture=await enrolled('only-authenticator@passkey.test',{authenticators:1}),browser=await signedIn(fixture);
  const response=await post(mfaApi,'/api/mfa',{viewer:fixture.actor,action:'authenticator-delete',id:fixture.authenticatorIds[0],managementToken:browser.management},headers(browser));
  assert.equal(response.status,409);assert.equal((await response.json()).error,lastAuthenticator,'without a passkey the existing 409 applies');
  assert.equal(batches,0);
  assert.equal(await count(sql`SELECT count(*) AS n FROM mfa_authenticators WHERE principal=${fixture.key}`),1);
 }

 // Passkeys count as the remaining factor only while they are usable.
 {
  const fixture=await enrolled('ip-origin@passkey.test',{authenticators:1,passkeys:1}),browser=await signedIn(fixture);
  const remove=()=>post(mfaApi,'/api/mfa',{viewer:fixture.actor,action:'authenticator-delete',id:fixture.authenticatorIds[0],managementToken:browser.management},headers(browser));
  siteOrigin='http://192.168.1.10';
  try{
   const status=await (await get(mfaApi,'/api/mfa',fixture.actor,headers(browser))).json();
   assert.equal(status.passkeysAvailable,false,'an IP origin makes passkeys unusable');
   const response=await remove();
   assert.equal(response.status,409);assert.equal((await response.json()).error,serverText('apiError.mfa.passkeysUnusableHere'));
   assert.equal(batches,0,'no batch runs');
   assert.equal(await count(sql`SELECT count(*) AS n FROM mfa_authenticators WHERE principal=${fixture.key}`),1,'the authenticator remains');
   assert.ok(await one(sql`SELECT token_hash FROM mfa_management_proofs WHERE token_hash=${sha(browser.management)}`),'the proof stays unused');
   assert.equal(await audits('Authenticator entfernt',fixture),0);
  }finally{siteOrigin=origin;}
  // With the HTTPS origin back, the same proof removes the last authenticator, because a passkey remains.
  const response=await remove();
  assert.equal(response.status,200,'the unused proof still works');assert.equal((await response.json()).authenticatorCount,0);
  assert.equal(await count(sql`SELECT count(*) AS n FROM passkey_credentials WHERE principal=${fixture.key}`),1,'the passkey remains');
 }
 {
  // A non-last authenticator goes regardless of the passkeys.
  const fixture=await enrolled('ip-origin-two@passkey.test',{authenticators:2,passkeys:1}),browser=await signedIn(fixture);
  siteOrigin='http://192.168.1.10';
  try{
   const response=await post(mfaApi,'/api/mfa',{viewer:fixture.actor,action:'authenticator-delete',id:fixture.authenticatorIds[0],managementToken:browser.management},headers(browser));
   assert.equal(response.status,200,'one of two authenticators can be deleted');
   assert.equal(await count(sql`SELECT count(*) AS n FROM mfa_authenticators WHERE principal=${fixture.key}`),1);
  }finally{siteOrigin=origin;}
 }
 {
  // Without passkeys the existing 409 applies, also at an IP origin.
  const fixture=await enrolled('ip-origin-none@passkey.test',{authenticators:1}),browser=await signedIn(fixture);
  siteOrigin='http://192.168.1.10';
  try{
   const response=await post(mfaApi,'/api/mfa',{viewer:fixture.actor,action:'authenticator-delete',id:fixture.authenticatorIds[0],managementToken:browser.management},headers(browser));
   assert.equal(response.status,409);assert.equal((await response.json()).error,lastAuthenticator);assert.equal(batches,0);
  }finally{siteOrigin=origin;}
 }

 // Concurrent deletes cannot remove the last two factors.
 const deletePasskey=(fixture,browser,id)=>post(passkeyApi,'/api/passkeys',{viewer:fixture.actor,action:'delete',id,managementToken:browser.management},headers(browser));
 const deleteAuthenticator=(fixture,browser,id)=>post(mfaApi,'/api/mfa',{viewer:fixture.actor,action:'authenticator-delete',id,managementToken:browser.management},headers(browser));
 const isPasskeyDelete=texts=>texts.some(text=>text.startsWith('DELETE FROM passkey_credentials'));
 const isAuthenticatorDelete=texts=>texts.some(text=>text.startsWith('DELETE FROM mfa_authenticators WHERE id'));
 async function race(fixture,second,match,first,what){
  let winner=null;
  beforeBatch={match,run:async()=>{winner=await first();}};
  const response=await second(),body=await response.json();
  assert.equal(beforeBatch,null,`${what}: the hook ran before the refused batch`);
  assert.equal(winner.status,200,`${what}: the first delete committed`);
  return {response,body};
 }
 {
  const fixture=await enrolled('race-passkeys@passkey.test',{passkeys:2}),[a,b]=fixture.passkeyIds,one1=await signedIn(fixture),two=await signedIn(fixture);
  const {response,body}=await race(fixture,()=>deletePasskey(fixture,two,b),isPasskeyDelete,()=>deletePasskey(fixture,one1,a),'two passkeys');
  assert.equal(response.status,409);assert.equal(body.error,lastFactor);
  assert.deepEqual((await d.query(sql`SELECT id FROM passkey_credentials WHERE principal=${fixture.key}`)).map(row=>row.id),[b],'passkey B remains');
  assert.equal(await audits('Passkey entfernt',fixture),1,'one audit row');
 }
 {
  // The passkey delete commits first; the last authenticator is refused.
  const fixture=await enrolled('race-mixed@passkey.test',{authenticators:1,passkeys:1}),one1=await signedIn(fixture),two=await signedIn(fixture);
  const {response}=await race(fixture,()=>deleteAuthenticator(fixture,two,fixture.authenticatorIds[0]),isAuthenticatorDelete,()=>deletePasskey(fixture,one1,fixture.passkeyIds[0]),'passkey before authenticator');
  assert.equal(response.status,409,'the authenticator delete is refused');
  assert.equal(await count(sql`SELECT count(*) AS n FROM mfa_authenticators WHERE principal=${fixture.key}`),1,'the authenticator remains');
  assert.equal(await count(sql`SELECT count(*) AS n FROM passkey_credentials WHERE principal=${fixture.key}`),0);
  assert.equal(await audits('Authenticator entfernt',fixture),0,'no audit row for the refused delete');
  assert.equal(await audits('Passkey entfernt',fixture),1);
 }
 {
  // The authenticator delete commits first; the last passkey is refused.
  const fixture=await enrolled('race-mixed-reverse@passkey.test',{authenticators:1,passkeys:1}),one1=await signedIn(fixture),two=await signedIn(fixture);
  const {response}=await race(fixture,()=>deletePasskey(fixture,two,fixture.passkeyIds[0]),isPasskeyDelete,()=>deleteAuthenticator(fixture,one1,fixture.authenticatorIds[0]),'authenticator before passkey');
  // The authenticator delete also ends the other browser's session and proof.
  assert.ok([403,409].includes(response.status),'the passkey delete is refused, got '+response.status);
  assert.equal(await count(sql`SELECT count(*) AS n FROM passkey_credentials WHERE principal=${fixture.key}`),1,'the passkey remains');
  assert.equal(await count(sql`SELECT count(*) AS n FROM mfa_authenticators WHERE principal=${fixture.key}`),0);
  assert.equal(await audits('Passkey entfernt',fixture),0,'no audit row for the refused delete');
  assert.equal(await audits('Authenticator entfernt',fixture),1);
 }

 // Static check: the setup actions do not use log().
 {
  const route=readFileSync('app/api/passkeys/route.ts','utf8').split('\n').filter(line=>line.includes("p.action==='setup-"));
  assert.equal(route.length,2,'both setup actions are routed');
  for(const line of route)assert.ok(!line.includes('log('),'setup actions do not call log()');
 }
 console.log('PASS passkey first setup: a passkey enrolls as first MFA factor in one audited batch with recovery codes; refused commits leave nothing; passkey-only accounts keep step-up and at least one factor.');
}finally{d.close();}
