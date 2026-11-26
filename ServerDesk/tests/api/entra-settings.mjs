// Settings → Microsoft Entra ID: Owner-only GET and POST, the reply without
// secrets, the validation of IDs, secret and certificate, the revision, the
// step-up rule, the connection test codes, the enable rule, the revocation of
// every Entra session and the audit rows, the portal API step of the test and
// the application ID URI of the view and its kept last Owners. Real lib/server/identity/entra/settings.ts and its
// route on an isolated PostgreSQL database (tests/support/entra-fixture.mjs).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {entraFixture,tenant,clientId,selfSignedCertificate,applicationIdUri} from '../support/entra-fixture.mjs';
import {serverText} from '../support/server-text.mjs';
import {sql} from '../../runtime/database.mjs';

const f=await entraFixture(),{d,m,microsoft}=f;
let checks=0;
const check=(value,expected,label)=>{assert.deepEqual(value,expected,label);checks++;};
const tenant2='33333333-4444-4555-8666-777777777777',client2='44444444-5555-4666-8777-888888888888';
try{
 check(['save','set-enabled','add-mapping','remove-mapping','set-emergency-account','set-entra-only','test','other'].map(action=>m.stepUp.entraSettingsActionNeedsStepUp(action)),[true,true,true,true,true,true,false,false],'rule 6: every change but test needs a step-up');
 const owner=await f.localAccount('owner@entra.test'),reader=await f.localAccount('reader@entra.test',['view']);
 const get=async browser=>{f.setViewer(await f.viewerOf(browser));return f.answer(await m.settingsApi.GET());};
 const post=async(browser,payload)=>{f.setViewer(await f.viewerOf(browser));return f.answer(await m.settingsApi.POST(f.request('/api/entra/settings',{browser,payload})));};
 const settings=()=>d.one(sql`SELECT * FROM entra_settings WHERE id=1`);
 const audit=async()=>(await f.auditRows('auth.entra.%')).map(row=>[row.action,row.target]);
 const save=async(payload,browser)=>{const login=browser??await f.localLogin(owner);return post(login,{action:'save',tenantId:tenant,clientId,credentialKind:'secret',...payload,managementToken:login.management});};

 // ---- Owner only ------------------------------------------------------------------
 {
  const browser=await f.localLogin(reader);
  const view=await get(browser);
  check([view.status,view.body.error],[403,serverText('apiError.settings.ownerOnly')],'GET: non-Owner 403');
  const change=await post(browser,{action:'save',tenantId:tenant,clientId,credentialKind:'secret',secret:'x',managementToken:browser.management});
  check(change.status,403,'POST save: non-Owner 403');
  check((await post(browser,{action:'test'})).status,403,'POST test: non-Owner 403');
  const empty=await get(await f.localLogin(owner));
  check([empty.status,empty.body.tenantId,empty.body.clientId,empty.body.credentialKind,empty.body.secretSaved,empty.body.enabled,empty.body.configured,empty.body.redirectUri,empty.body.lastTest,empty.body.mappings,empty.body.accounts,empty.body.lastSignInAt],
   [200,'','','secret',false,false,false,'https://entra.test/api/auth/entra/callback',null,[],0,null],'GET: the empty settings with the redirect URI');
  check([empty.body.entraOnly,empty.body.emergency,empty.body.switchChecks],[{enabled:false,since:null,by:null,lockedAccounts:2},{account:null,candidates:[],lastSignInAt:null,openAlarms:0},{signIn:false,emergency:false,viewerEntraOwner:false,mailChannel:false}],'GET: Microsoft sign-in only off, no emergency access, no check met; the two built-in accounts the switch would lock');
  check(empty.body.roles.find(role=>role.id==='builtin-owner'),{id:'builtin-owner',name:'Owner',portal:false},'roles of the instance catalog');
 }

 // ---- Validation ----------------------------------------------------------------------
 {
  const browser=await f.localLogin(owner);
  const refused=async(payload,key,label)=>{const result=await post(browser,{action:'save',tenantId:tenant,clientId,credentialKind:'secret',secret:'abc',managementToken:browser.management,...payload});check([result.status,result.body.messageKey],[400,key],label);};
  await refused({tenantId:'contoso.onmicrosoft.com'},'apiError.entra.tenantIdFormat','tenant ID must be a GUID');
  await refused({tenantId:'common'},'apiError.entra.tenantIdFormat','no common tenant');
  await refused({clientId:'123'},'apiError.entra.clientIdFormat','client ID must be a GUID');
  await refused({secret:'x'.repeat(513)},'apiError.entra.secretFormat','secret at most 512 characters');
  await refused({secret:'tab\there'},'apiError.entra.secretFormat','secret only printable characters');
  const certificate=selfSignedCertificate(),small=selfSignedCertificate({bits:1024}),expired=selfSignedCertificate({notAfter:'010101000000Z'}),other=selfSignedCertificate();
  await refused({credentialKind:'certificate',certificatePem:'not a pem',privateKeyPem:certificate.privateKeyPem},'apiError.entra.certificateInvalid','certificate must be PEM');
  await refused({credentialKind:'certificate',certificatePem:small.certificatePem,privateKeyPem:small.privateKeyPem},'apiError.entra.certificateInvalid','key of at least 2048 bits');
  await refused({credentialKind:'certificate',certificatePem:certificate.certificatePem,privateKeyPem:selfSignedCertificate({keyFormat:'encrypted'}).privateKeyPem},'apiError.entra.certificateInvalid','no encrypted key');
  await refused({credentialKind:'certificate',certificatePem:certificate.certificatePem,privateKeyPem:other.privateKeyPem},'apiError.entra.keyMismatch','the key must belong to the certificate');
  await refused({credentialKind:'certificate',certificatePem:expired.certificatePem,privateKeyPem:expired.privateKeyPem},'apiError.entra.certificateExpired','no expired certificate');
  check([await settings(),await f.count(sql`SELECT count(*) AS n FROM mfa_management_proofs WHERE principal=${owner.actor.principal}`)>0],[null,true],'refusals store nothing and keep the proof');
 }

 // ---- Save: step-up, secret kept, revision, no secret in the reply ----------------------
 {
  const browser=await f.localLogin(owner);
  const missing=await post(browser,{action:'save',tenantId:tenant,clientId,credentialKind:'secret',secret:'first-secret-value'});
  check([missing.status,missing.body.code],[403,'MFA_STEP_UP_REQUIRED'],'save without a proof: step-up');
  const saved=await save({secret:'first-secret-value'},browser);
  check([saved.status,saved.body.tenantId,saved.body.clientId,saved.body.secretSaved,saved.body.revision,saved.body.configured,saved.body.disabled],[200,tenant,clientId,true,1,true,false],'saved with revision 1');
  const row=await settings(),reply=JSON.stringify(saved.body);
  check([reply.includes('first-secret-value'),reply.includes(row.secret_enc),'secret_enc' in saved.body,await m.mfa.decryptSecret(row.secret_enc,'entra:client-secret')],[false,false,false,'first-secret-value'],'reply without secret or ciphertext; stored encrypted under entra:client-secret');
  const kept=await save({secret:''});
  check([kept.body.revision,(await settings()).secret_enc],[1,row.secret_enc],'empty secret keeps the saved value; an unchanged save changes nothing');
  check((await save({secret:'first-secret-value'})).body.revision,1,'the same secret is no change');
  check((await save({secret:'second-secret-value'})).body.revision,2,'a new secret increments revision');
  check((await save({secret:'',tenantId:tenant2})).body.revision,3,'a new tenant increments revision');
  check((await save({secret:'',tenantId:tenant2,clientId:client2})).body.revision,4,'a new client increments revision');
  const certificate=selfSignedCertificate();
  const cert=await save({tenantId:tenant,credentialKind:'certificate',certificatePem:certificate.certificatePem,privateKeyPem:certificate.privateKeyPem});
  check([cert.status,cert.body.revision,cert.body.credentialKind,cert.body.certificate.thumbprint,cert.body.certificate.expiresAt,cert.body.privateKeySaved],[200,5,'certificate',certificate.thumbprint,Date.parse('2049-12-31T23:59:59Z'),true],'certificate saved with thumbprint and expiry');
  const certRow=await settings(),certReply=JSON.stringify(cert.body);
  check([certReply.includes('PRIVATE'+' KEY'),certReply.includes(certRow.private_key_enc),(await m.mfa.decryptSecret(certRow.private_key_enc,'entra:private-key')).startsWith('-----BEGIN PRIVATE'+' KEY-----')],[false,false,true],'private key encrypted under entra:private-key, never in the reply');
  check((await save({tenantId:tenant,credentialKind:'certificate',certificatePem:'',privateKeyPem:''})).body.revision,5,'empty certificate fields keep the saved certificate');
  const pkcs1=selfSignedCertificate({keyFormat:'pkcs1'});
  check((await save({tenantId:tenant,credentialKind:'certificate',certificatePem:pkcs1.certificatePem,privateKeyPem:pkcs1.privateKeyPem})).body.revision,6,'a PKCS#1 key is accepted');
  const stale=await f.localLogin(owner);
  check((await post(stale,{action:'save',tenantId:tenant,clientId,credentialKind:'secret',secret:'x-secret',revision:2,managementToken:stale.management})).body.messageKey,'apiError.entra.settingsChanged','an old revision: settingsChanged');
  check((await save({tenantId:tenant,clientId,credentialKind:'secret',secret:'client-secret-value'})).body.revision,7,'back to a secret');
  const rows=(await audit()).filter(([action])=>action==='auth.entra.settings.update');
  check(rows.length,7,'one update row per real change');
  check(rows.some(([,target])=>/secret-value|PRIVATE|BEGIN/.test(target)),false,'no secret in an audit row');
  check(rows.at(-1)[1],`tenant=${tenant} client=${clientId} credential=secret revision=7`,'update row target');
 }

 // ---- Test: result codes, no step-up, stored for the revision ---------------------------
 // test needs no step-up, so one login serves every test.
 let testLogin=null;
 const test=async()=>post(testLogin??=await f.localLogin(owner),{action:'test'});
 const otherKey=crypto.generateKeyPairSync('rsa',{modulusLength:2048}).privateKey;
 /** Answers the client-credentials request for the portal API only; Graph and the code redemption keep their answers. */
 const apiAnswer=answer=>{const original=microsoft.token;microsoft.token=(form,request)=>form.scope===`${applicationIdUri}/.default`?answer(form):original(form,request);};
 {
  const cases=[
   ['ok',()=>{}],
   ['tenantNotFound',()=>{microsoft.discovery=()=>({status:400,body:JSON.stringify({error:'invalid_tenant',error_description:'AADSTS90002: Tenant not found.'})});}],
   ['discoveryFailed',()=>{microsoft.discovery=()=>({status:200,body:JSON.stringify({issuer:'https://login.microsoftonline.com/other/v2.0',jwks_uri:'https://login.microsoftonline.com/x/keys'})});}],
   ['discoveryFailed',()=>{microsoft.discovery=()=>({status:200,body:JSON.stringify({issuer:`https://login.microsoftonline.com/${tenant}/v2.0`,jwks_uri:'https://evil.example/keys'})});}],
   ['discoveryFailed',()=>{microsoft.jwks=()=>({status:200,body:JSON.stringify({keys:[{kty:'EC',kid:'x',crv:'P-256'}]})});}],
   ['credentialRefused',()=>{microsoft.token=()=>({status:401,body:JSON.stringify({error:'invalid_client',error_description:'AADSTS7000215: Invalid client secret provided.',error_codes:[7000215]})});}],
   ['secretExpired',()=>{microsoft.token=()=>({status:401,body:JSON.stringify({error:'invalid_client',error_description:'AADSTS7000222: The provided client secret keys are expired.',error_codes:[7000222]})});}],
   ['unreachable',()=>{microsoft.fail=()=>{throw new Error('connect ECONNREFUSED');};}],
   // The fourth step: two Graph reads with the token (the permissions of the account check).
   ['graphPermissionMissing',()=>{microsoft.graph=()=>({status:403,body:JSON.stringify({error:{code:'Authorization_RequestDenied',message:'AADSTS Insufficient privileges to complete the operation.'}})});}],
   ['graphPermissionMissing',()=>{microsoft.graph=(request,{path})=>path==='/users'?{status:200,body:JSON.stringify({value:[{id:'00000000-0000-4000-8000-0000000000f1'}]})}:{status:200,body:JSON.stringify({value:[]})};}],
   ['graphPermissionMissing',()=>{microsoft.graph=(request,{path})=>path==='/groups'?{status:403,body:JSON.stringify({error:{message:'AADSTS denied'}})}:{status:200,body:JSON.stringify({value:[{id:'x',accountEnabled:false}]})};}],
   ['ok',()=>{microsoft.graph=()=>({status:200,body:JSON.stringify({value:[]})});}],
   // The fifth step: a client-credentials token for the portal API (api://<client>/.default).
   ['ok',()=>{microsoft.appClaims={aud:clientId};}],
   ['apiTokenVersion',()=>{microsoft.appClaims={ver:'2.0',iss:`https://login.microsoftonline.com/${tenant}/v2.0`,aud:clientId};}],
   ['apiNotExposed',()=>{apiAnswer(()=>({status:400,body:JSON.stringify({error:'invalid_resource',error_description:'AADSTS500011: The resource principal named api://x was not found.',error_codes:[500011]})}));}],
   ['apiNotExposed',()=>{apiAnswer(()=>({status:400,body:JSON.stringify({error:'invalid_scope',error_description:'AADSTS70011: invalid scope',error_codes:[70011]})}));}],
   ['apiNotExposed',()=>{microsoft.appSignWith=otherKey;}],
   ['apiNotExposed',()=>{microsoft.appClaims={aud:'https://graph.microsoft.com'};}],
   ['apiNotExposed',()=>{microsoft.appClaims={tid:tenant2,iss:`https://sts.windows.net/${tenant2}/`};}],
   ['apiNotExposed',()=>{microsoft.appClaims={ver:'2.0'};}],
   ['apiNotExposed',()=>{microsoft.appHeader={alg:'none'};}],
   ['apiNotExposed',()=>{apiAnswer(()=>({status:200,body:JSON.stringify({token_type:'Bearer'})}));}],
   ['ok',()=>{apiAnswer(()=>({status:400,body:JSON.stringify({error:'invalid_grant',error_description:'AADSTS501051: Application is not assigned to a role.',error_codes:[501051]})}));}],
   ['unreachable',()=>{apiAnswer(()=>({status:503,body:'AADSTS busy'}));}],
   ['unreachable',()=>{apiAnswer(()=>({status:429,body:''}));}],
   ['unreachable',()=>{apiAnswer(()=>{throw new Error('connect ETIMEDOUT');});}],
   ['graphUnreachable',()=>{microsoft.graph=()=>({status:503,body:'AADSTS busy'});}],
   ['graphUnreachable',()=>{microsoft.graph=()=>({status:429,body:''});}],
   ['graphUnreachable',()=>{microsoft.graph=()=>{throw new Error('connect ETIMEDOUT');};}],
  ];
  for(const [code,setup] of cases){
   f.resetMicrosoft();setup();
   const result=await test();
   check([result.status,result.body.result,result.body.lastTest.result,result.body.lastTest.current],[200,code,code,true],`test: ${code}`);
   check(JSON.stringify(result.body).includes('AADSTS'),false,`test ${code}: no Microsoft text`);
  }
  f.resetMicrosoft();
  check((await settings()).test_result,'graphUnreachable','the last result is stored');
  check(JSON.stringify(await settings()).includes('AADSTS'),false,'no Microsoft text stored');
  const ok=await test();
  const form=Object.fromEntries(new URLSearchParams(microsoft.calls.find(call=>call.url.endsWith('/token')).body));
  check([ok.body.result,form.grant_type,form.scope,form.client_secret],['ok','client_credentials','https://graph.microsoft.com/.default','client-secret-value'],'client credentials for Microsoft Graph with the saved secret');
  const tokenForms=microsoft.calls.filter(call=>call.url.endsWith('/token')).map(call=>Object.fromEntries(new URLSearchParams(call.body)));
  check(tokenForms.map(entry=>[entry.grant_type,entry.scope,entry.client_secret]),[['client_credentials','https://graph.microsoft.com/.default','client-secret-value'],['client_credentials',`${applicationIdUri}/.default`,'client-secret-value']],'then client credentials for the portal API with the saved secret');
  const graphCalls=microsoft.calls.filter(call=>new URL(call.url).host==='graph.microsoft.com');
  check(graphCalls.map(call=>[call.method,call.url.replace('https://graph.microsoft.com',''),call.headers?.Authorization]),[['GET','/v1.0/users?$top=1&$select=id,accountEnabled','Bearer graph-token'],['GET','/v1.0/groups?$top=1&$select=id','Bearer graph-token']],'both Graph probes with the client-credentials token');
  check(microsoft.calls.every(call=>['login.microsoftonline.com','graph.microsoft.com'].includes(new URL(call.url).host)),true,'only login.microsoftonline.com and graph.microsoft.com');
  check(String(await m.oidc.entraRequest({url:'https://graph.microsoft.com.evil.example/v1.0/users',method:'GET'}).catch(error=>error.message)).includes('only to login.microsoftonline.com'),true,'the host check refuses any other host');
  check(String(await m.oidc.entraRequest({url:'https://graph.microsoft.com/beta/users',method:'GET'}).catch(error=>error.message)).includes('only to login.microsoftonline.com'),true,'the host check refuses Graph outside /v1.0');
  const rows=(await audit()).filter(([action])=>action==='auth.entra.settings.test');
  check([rows.length,rows.at(-1)[1]],[cases.length+1,'result=ok revision=7'],'one test row per test');
  // A certificate that Entra refuses.
  const certificate=selfSignedCertificate();
  await save({credentialKind:'certificate',certificatePem:certificate.certificatePem,privateKeyPem:certificate.privateKeyPem});
  microsoft.token=()=>({status:401,body:JSON.stringify({error:'invalid_client',error_description:'AADSTS700027: Client assertion contains an invalid signature.',error_codes:[700027]})});
  check((await test()).body.result,'certificateRefused','test: certificateRefused');
  f.resetMicrosoft();
  check((await test()).body.result,'ok','test with the certificate assertion: ok');
 }

 // ---- Enable: only after a passing test of the current revision ---------------------------
 {
  const enable=async value=>{const login=await f.localLogin(owner);return post(login,{action:'set-enabled',enabled:value,managementToken:login.management});};
  const browser=await f.localLogin(owner);
  check((await post(browser,{action:'set-enabled',enabled:true})).body.code,'MFA_STEP_UP_REQUIRED','enable without a proof: step-up');
  await save({credentialKind:'secret',secret:'client-secret-value'});
  const blocked=await enable(true);
  check([blocked.status,blocked.body.code,blocked.body.messageKey],[409,'ENTRA_TEST_FIRST','apiError.entra.testFirst'],'enable before a test of the new revision: testFirst');
  f.resetMicrosoft();microsoft.token=()=>({status:401,body:JSON.stringify({error:'invalid_client',error_codes:[7000215]})});
  await test();
  check((await enable(true)).body.messageKey,'apiError.entra.testFirst','enable after a failed test: testFirst');
  f.resetMicrosoft();microsoft.graph=()=>({status:403,body:''});
  check((await test()).body.result,'graphPermissionMissing','a test without the Graph permissions');
  check((await enable(true)).body.messageKey,'apiError.entra.testFirst','enable after graphPermissionMissing: testFirst');
  for(const [result,setup] of [['apiNotExposed',()=>apiAnswer(()=>({status:400,body:JSON.stringify({error:'invalid_resource',error_codes:[500011]})}))],['apiTokenVersion',()=>{microsoft.appClaims={ver:'2.0',iss:`https://login.microsoftonline.com/${tenant}/v2.0`};}]]){
   f.resetMicrosoft();setup();
   check([(await test()).body.result,(await settings()).test_result],[result,result],`a test with ${result} is stored`);
   check((await enable(true)).body.messageKey,'apiError.entra.testFirst',`enable after ${result}: testFirst`);
  }
  f.resetMicrosoft();await test();
  await d.exec(sql`UPDATE entra_directory_check SET last_started_at=${Date.now()} WHERE id=1`);
  const on=await enable(true);
  check([on.status,on.body.enabled],[200,true],'enable after a passing test');
  check((await audit()).at(-1),['auth.entra.enable','revision=9'],'enable row');
  check((await d.one(sql`SELECT last_started_at FROM entra_directory_check WHERE id=1`)).last_started_at,null,'turning on makes the account check due at the next tick');
  const same=await enable(true);
  check([same.status,same.body.enabled],[200,true],'enabling again changes nothing');
 }

 // ---- Revocation: off, and a changed credential while on ------------------------------------
 {
  const entraSessions=()=>f.count(sql`SELECT count(*) AS n FROM local_auth_sessions s JOIN local_users u ON u.id=s.user_id WHERE u.identity_source='entra'`);
  const entraMfa=()=>f.count(sql`SELECT count(*) AS n FROM mfa_sessions WHERE principal LIKE 'entra:%'`);
  const signInTwo=async()=>{f.resetMicrosoft();microsoft.claims={oid:'aaaaaaaa-0000-4000-8000-000000000001'};await f.signIn();microsoft.claims={oid:'aaaaaaaa-0000-4000-8000-000000000002'};await f.signIn();f.resetMicrosoft();};
  await signInTwo();
  check([await entraSessions(),await entraMfa()],[2,2],'two Entra accounts are signed in');
  const off=await (async()=>{const login=await f.localLogin(owner);return post(login,{action:'set-enabled',enabled:false,managementToken:login.management});})();
  check([off.status,off.body.enabled,await entraSessions(),await entraMfa()],[200,false,0,0],'turning off ends every Entra session in the same commit');
  check((await audit()).at(-1)[0],'auth.entra.disable','disable row');
  check(await f.count(sql`SELECT count(*) AS n FROM local_auth_sessions WHERE user_id=${owner.actor.id}`)>0,true,'local sessions stay');
  // On again, then a new secret: off until a new test, sessions ended.
  await test();
  await (async()=>{const login=await f.localLogin(owner);return post(login,{action:'set-enabled',enabled:true,managementToken:login.management});})();
  await signInTwo();
  check(await entraSessions(),2,'signed in again');
  const changed=await save({secret:'third-secret-value'});
  check([changed.status,changed.body.enabled,changed.body.disabled,changed.body.lastTest.current,await entraSessions(),await entraMfa()],[200,false,true,false,0,0],'a new credential while on: off, test outdated, every Entra session ended');
  check((await audit()).slice(-2).map(([action])=>action),['auth.entra.settings.update','auth.entra.disable'],'update and disable rows');
  // A new tenant while on ends the sessions too.
  await d.exec(sql`UPDATE entra_settings SET enabled=1,tested_revision=revision,test_result='ok'`);
  await signInTwo();
  const tenantChange=await save({secret:'',tenantId:tenant2});
  check([tenantChange.body.enabled,await entraSessions()],[false,0],'a new tenant while on: off and sessions ended');
  await save({secret:'',tenantId:tenant});
 }

 // ---- An Entra Owner confirms with Microsoft ---------------------------------------------------
 {
  await f.configure();
  const entraOwner=async()=>{
   f.resetMicrosoft();microsoft.claims={oid:'bbbbbbbb-0000-4000-8000-000000000001'};
   const entra=await f.signIn();
   const viewer=await f.viewerOf(entra.browser);f.setViewer(viewer);
   return {browser:entra.browser,viewer};
  };
  let {browser,viewer}=await entraOwner();
  await d.exec(sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(gen_random_uuid()::text,'user',${viewer.userId},'builtin-owner','global','*',0,'fixture')`);
  const read=await get(browser);
  check(read.status,200,'an Entra Owner reads the settings');
  check([read.body.switchChecks.signIn,read.body.switchChecks.viewerEntraOwner,read.body.switchChecks.emergency],[true,true,false],'the switch checks of an Entra Owner: sign-in on with a passed test, signed in through Entra, no emergency access yet');
  const refused=await post(browser,{action:'set-enabled',enabled:false,managementToken:'a'.repeat(64)});
  check([refused.status,refused.body.code],[403,'MFA_STEP_UP_REQUIRED'],'an Entra Owner without a proof: MFA_STEP_UP_REQUIRED');
  check(m.codes.opensMfaPrompt(refused.body.code),true,'the client opens the step-up dialog for it');
  const tested=await post(browser,{action:'test'});
  check([tested.status,tested.body.result],[200,'ok'],'test relies on the login session, also for an Entra Owner');
  // A mapping change with the proof of a Microsoft confirmation.
  let confirmed=await f.confirm(browser);browser=confirmed.browser;
  const mapping=await post(browser,{action:'add-mapping',groupObjectId:'0b0b0b0b-0000-4000-8000-0000000000aa',groupName:'Ops',roleId:'builtin-reader',scopeType:'global',managementToken:confirmed.management});
  check([mapping.status,mapping.body.error??'',(mapping.body.mappings??[]).some(entry=>entry.groupObjectId==='0b0b0b0b-0000-4000-8000-0000000000aa')],[200,'',true],'add-mapping by an Entra Owner with the confirmation proof');
  // set-enabled off with the proof: the switch moves and every Entra session ends, also this one.
  confirmed=await f.confirm(browser);browser=confirmed.browser;
  const off=await post(browser,{action:'set-enabled',enabled:false,managementToken:confirmed.management});
  check([off.status,off.body.enabled,(await settings()).enabled],[200,false,0],'set-enabled by an Entra Owner with the confirmation proof');
  check((await f.auditRows('auth.entra.disable')).at(-1).actor,viewer.label,'the disable row names the Entra Owner');
  check(await f.count(sql`SELECT count(*) AS n FROM local_auth_sessions WHERE user_id=${viewer.userId}`),0,'switching off ends the sessions of the Entra Owner too, after the switch moved');
  // save with a new secret and the proof: saved; while on, sign-in turns off as for every credential change.
  await d.exec(sql`UPDATE entra_settings SET enabled=1`);
  ({browser,viewer}=await entraOwner());
  confirmed=await f.confirm(browser);browser=confirmed.browser;
  const before=Number((await settings()).revision);
  const saved=await post(browser,{action:'save',tenantId:tenant,clientId,credentialKind:'secret',secret:'a-new-client-secret',managementToken:confirmed.management});
  check([saved.status,Number((await settings()).revision),saved.body.disabled],[200,before+1,true],'save by an Entra Owner with the confirmation proof');
  check(await f.count(sql`SELECT count(*) AS n FROM local_auth_sessions WHERE user_id=${viewer.userId}`),0,'the credential change ends the sessions of the Entra Owner too');
  await f.configure();f.resetMicrosoft();
 }
 // ---- The view: the account check and its permissions ------------------------------------------
 {
  const browser=await f.localLogin(owner);
  const api=(await get(browser)).body;
  check([api.applicationIdUri,api.apiScope],[applicationIdUri,'access_as_user'],'the view: the application ID URI of the saved client ID and the API scope');
  const saved=await settings();await d.exec(sql`DELETE FROM entra_settings`);
  check((await get(browser)).body.applicationIdUri,null,'no application ID URI without a saved client ID');
  await f.configure({enabled:saved.enabled,revision:Number(saved.revision)});
  // The new outcome of a confirm flow passes the CHECK of migration 0028.
  const at=Date.now();
  await d.exec(sql`INSERT INTO entra_sign_in_flows(state_hash,browser_hash,nonce_hash,code_verifier_enc,created_at,expires_at,attempt_bucket,attempt_window_at,purpose,user_id,primary_hash,claim_hash,settings_revision,outcome) VALUES('api-setup-state','b','n','',${at},${at+600_000},'bucket',${at},'confirm',${owner.actor.id},'p','c',1,'apiSetupMissing')`);
  check(await f.count(sql`SELECT count(*) AS n FROM entra_sign_in_flows WHERE outcome='apiSetupMissing'`),1,'entra_sign_in_flows accepts the outcome apiSetupMissing');
  await d.exec(sql`DELETE FROM entra_sign_in_flows`);
  const view=async()=>(await get(browser)).body;
  const setCheck=values=>d.exec(sql`UPDATE entra_directory_check SET last_started_at=${values.started??null},last_finished_at=${values.finished??null},last_result=${values.result??null},last_ok_at=${values.ok??null},checked_count=${values.checked??0},locked_count=${values.locked??0},group_change_count=${values.groups??0},remaining_count=${values.remaining??0} WHERE id=1`);
  await d.exec(sql`UPDATE entra_settings SET enabled=0`);
  await setCheck({started:1000,finished:2000,result:'ok',ok:2000,checked:3});
  const off=await view();
  check([off.graphPermissions,off.directoryCheck.state,off.directoryCheck.nextRunAt,off.directoryCheck.result],[['User.Read.All','GroupMember.Read.All'],'off',null,'ok'],'off while sign-in is off, no next check');
  await d.exec(sql`UPDATE entra_settings SET enabled=1`);
  await setCheck({});
  const waiting=(await view()).directoryCheck;
  check([waiting.state,waiting.lastRunAt,typeof waiting.nextRunAt,waiting.checked],['waiting',null,'number',0],'waiting before the first finished run, next check at the next tick');
  const started=Date.now()-60_000;
  await setCheck({started,finished:started+5000,result:'ok',ok:started+5000,checked:12,locked:1,groups:2,remaining:7});
  check((await view()).directoryCheck,{state:'ok',result:'ok',lastRunAt:started+5000,lastOkAt:started+5000,nextRunAt:started+15*60_000,checked:12,locked:1,groupChanges:2,remaining:7,keptOwners:[]},'ok with the counts of the last run and the next start 15 minutes after the last');
  await setCheck({started,finished:started+5000,result:'permissionMissing',ok:started-3_600_000});
  const failed=(await view()).directoryCheck;
  check([failed.state,failed.result,failed.lastOkAt],['failed','permissionMissing',started-3_600_000],'failed by the last result');
  const reply=JSON.stringify(await view());
  check(/client-secret-value|graph-token|AADSTS/.test(reply),false,'the view still carries no secret, token or Microsoft text');
  await setCheck({});
  // The kept last Owners (entra_kept_owner_since): active Entra accounts of the saved tenant only, in name order, by their shown name.
  const objectId=n=>`d0d0d0d0-0000-4000-8000-${String(n).padStart(12,'0')}`;
  const entraAccount=async(n,{name,tid=tenant,status='active',since=null,email=''})=>{
   const id=`kept-${n}`,oid=objectId(n);
   await d.exec(sql`INSERT INTO local_users(id,username,email,display_name,auth_principal,auth_email,status,password_hash,auth_version,must_reset,created_at,updated_at,identity_source,entra_tenant_id,entra_object_id,entra_kept_owner_since)
    VALUES(${id},${'entra.'+oid},${email},${name},${`entra:${tid}:${oid}`},${`${oid}@${tid}.entra.serverdesk.invalid`},${status},NULL,1,0,0,0,'entra',${tid},${oid},${since})`);
   return id;
  };
  const zoe=await entraAccount(1,{name:'Zoe Kept',since:5000}),anna=await entraAccount(2,{name:'Anna Kept',since:7000});
  await entraAccount(3,{name:'Locked Kept',status:'disabled',since:5000});
  await entraAccount(4,{name:'Other Tenant',tid:tenant2,since:5000});
  await entraAccount(5,{name:'Not kept'});
  const unnamed=await entraAccount(6,{name:objectId(6),since:9000});
  await d.exec(sql`UPDATE local_users SET entra_kept_owner_since=5000 WHERE id=${owner.actor.id}`);
  const kept=(await view()).directoryCheck.keptOwners;
  check(kept,[{id:unnamed,name:'',since:9000},{id:anna,name:'Anna Kept',since:7000},{id:zoe,name:'Zoe Kept',since:5000}],'keptOwners: the marked active Entra accounts of the tenant in name order; no locked, other-tenant or local account');
  check(JSON.stringify(kept).includes('d0d0d0d0'),false,'keptOwners: no object ID, also not as the name of an account without one');
  await d.exec(sql`UPDATE entra_settings SET enabled=0`);
  check((await view()).directoryCheck.keptOwners,[],'keptOwners: empty while sign-in is off');
  await d.exec(sql`UPDATE entra_settings SET enabled=1`);
  await d.exec(sql`DELETE FROM local_users WHERE id LIKE 'kept-%'`);
  await d.exec(sql`UPDATE local_users SET entra_kept_owner_since=NULL WHERE id=${owner.actor.id}`);
 }
 console.log(`PASS entra settings (${checks} checks): Owner only, reply without secrets, validation, revision, step-up, test codes with the Graph probes, enable rule, revocation, audit rows, the account check view and the Microsoft sign-in only fields.`);
}finally{await d.close();}
