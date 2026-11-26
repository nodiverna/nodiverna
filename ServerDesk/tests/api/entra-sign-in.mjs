// Sign-in with Microsoft Entra ID: the start, the callback with the id_token
// checks and the MFA signal of the portal API access token (amr of a v1.0
// token, its diagnostic in the audit row and the page), the password-less account, the bound session pair, the refusals with
// their audit rows, the certificate assertion, the idle end and the logout, and
// the MFA grant: a forced sign-in (prompt=login, auth_time) without a grant, a
// silent one through a live grant of the same account, the refusals that start
// again with ?fresh=1, the role sync rule and the switch.
// Real lib/server/identity/entra/*, lib/server/identity/local-auth.ts and lib/server/identity/mfa.ts on an isolated PostgreSQL
// database; a fake Microsoft (tests/support/entra-fixture.mjs).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {entraFixture,origin,tenant,clientId,sha,selfSignedCertificate,signInScope,timeOffsetPattern} from '../support/entra-fixture.mjs';
import {cookieNames,setCookies} from '../support/session-cookies.mjs';

import {sql} from '../../runtime/database.mjs';

const f=await entraFixture(),{d,m,microsoft}=f;
let checks=0;
const check=(value,expected,label)=>{assert.deepEqual(value,expected,label);checks++;};
const oid='99999999-8888-4777-8666-555555555555',principal=`entra:${tenant}:${oid}`;
const sessionCount=()=>f.count(sql`SELECT count(*) AS n FROM local_auth_sessions`);
const mfaCount=()=>f.count(sql`SELECT count(*) AS n FROM mfa_sessions`);
const refusedRows=()=>f.auditRows('auth.entra.login.refused');
try{
 // ---- Off: the card offers nothing and the start goes back ---------------------
 {
  const status=await f.answer(await m.authApi.GET(f.request('/api/auth')));
  check([status.status,status.body.entra],[200,{enabled:false,entraOnly:false}],'GET /api/auth: entra off without settings');
  const start=await m.startApi.GET(f.request('/api/auth/entra/start'));
  check([start.status,start.headers.get('location'),start.headers.getSetCookie()],[302,'/#entra=notConfigured',[]],'start while off: back to the card, no cookie');
  await f.configure({enabled:0});
  check((await m.startApi.GET(f.request('/api/auth/entra/start'))).headers.get('location'),'/#entra=notConfigured','start while switched off');
  await f.configure();
  const on=await f.answer(await m.authApi.GET(f.request('/api/auth')));
  check([on.body.entra,JSON.stringify(on.body).includes(tenant),JSON.stringify(on.body).includes(clientId)],[{enabled:true,entraOnly:false},false,false],'GET /api/auth: enabled, no tenant or client ID');
 }

 // ---- Start: authorize URL, PKCE, cookie, hashes only ----------------------------
 let first;
 {
  first=await f.signIn({before:async({authorize,flow})=>{
   check([authorize.origin+authorize.pathname],[`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`],'authorize endpoint of the tenant');
   const q=Object.fromEntries(authorize.searchParams);
   check([q.client_id,q.response_type,q.response_mode,q.redirect_uri,q.scope,q.code_challenge_method],[clientId,'code','query',origin+'/api/auth/entra/callback',`openid profile email api://${clientId}/access_as_user`,'S256'],'authorize parameters: the OIDC scopes and the portal API scope');
   check([q.prompt,q.max_age],['login',undefined],'without an MFA grant the start forces a new Microsoft sign-in (prompt=login, no max_age)');
   check([/^[a-f0-9]{64}$/.test(q.state),/^[a-f0-9]{64}$/.test(q.nonce),/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge),/^[a-f0-9]{64}$/.test(flow)],[true,true,true,true],'random state, nonce, browser token and an S256 challenge');
   const rows=await d.query(sql`SELECT * FROM entra_sign_in_flows`);
   check(rows.length,1,'one flow row');
   const row=rows[0],text=JSON.stringify(row);
   check([row.state_hash,row.browser_hash,row.nonce_hash,Number(row.expires_at)-Number(row.created_at)],[sha(q.state),sha(flow),sha(q.nonce),600_000],'state, browser and nonce only as SHA-256 hashes; 10 minutes');
   check([text.includes(q.state),text.includes(q.nonce),text.includes(flow)],[false,false,false],'no plain state, nonce or browser token in the row');
  }});
  check([first.start.status,first.start.headers.get('cache-control')],[302,'no-store'],'start answers 302 no-store');
  check(first.flowCookie,`__Host-serverdesk-entra=${first.flow}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`,'flow cookie attributes');
  const redemption=microsoft.calls.find(call=>call.url.endsWith('/oauth2/v2.0/token'));
  const form=Object.fromEntries(new URLSearchParams(redemption.body));
  check([form.grant_type,form.client_id,form.code,form.redirect_uri,form.client_secret,form.scope],['authorization_code',clientId,'authorization-code',origin+'/api/auth/entra/callback','client-secret-value',signInScope],'code redemption with the secret and the same scope');
  check([form.code_verifier.length>=43&&form.code_verifier.length<=128,crypto.createHash('sha256').update(form.code_verifier).digest('base64url')],[true,first.authorize.searchParams.get('code_challenge')],'the S256 challenge matches the verifier sent at redemption');
  check(JSON.stringify(await d.query(sql`SELECT code_verifier_enc FROM entra_sign_in_flows`)).includes(form.code_verifier),false,'the verifier is stored encrypted');
 }

 // ---- Success: account, bound session pair, 200 HTML with the cookies -------------
 let browser,userId;
 {
  check([first.response.status,first.response.headers.get('location'),first.target],[200,null,'/'],'callback: 200 page that moves to /');
  check([microsoft.idClaims().amr,microsoft.idClaims().ver],[undefined,'2.0'],'the id_token of the fake Microsoft has no amr: the MFA signal comes from the access token');
  check([first.response.headers.get('cache-control'),first.response.headers.get('referrer-policy'),first.response.headers.get('content-type')],['no-store','no-referrer','text/html; charset=utf-8'],'callback headers');
  check([first.html.includes('<a href="/">Continue</a>'),first.html.includes('<script')],[true,false],'visible Continue link, no script');
  const cookies=setCookies(first.response),attributes=name=>cookies.find(cookie=>cookie.name===name)?.attributes.filter(value=>!/^max-age=/i.test(value));
  check([attributes(cookieNames.primary),attributes(cookieNames.session)],[['Path=/','Secure','HttpOnly','SameSite=Strict'],['Path=/','Secure','HttpOnly','SameSite=Strict']],'session cookies like the built-in login');
  check(cookies.find(cookie=>cookie.name==='__Host-serverdesk-entra')?.raw,'__Host-serverdesk-entra=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0','flow cookie cleared');
  browser=first.browser;
  const user=await d.one(sql`SELECT * FROM local_users WHERE identity_source='entra'`);userId=user.id;
  check([user.auth_principal,user.auth_email,user.username,user.display_name,user.email,user.status,user.password_hash,Number(user.must_reset),user.entra_tenant_id,user.entra_object_id,/^[0-9a-f-]{36}$/.test(user.id)],[principal,`${oid}@${tenant}.entra.serverdesk.invalid`,`entra.${oid}`,'Ada Lovelace','ada@contoso.example','active',null,0,tenant,oid,true],'the password-less account');
  const sessions=await d.query(sql`SELECT * FROM local_auth_sessions`),mfa=await d.query(sql`SELECT * FROM mfa_sessions`);
  check([sessions.length,mfa.length],[1,1],'one session pair');
  check([sessions[0].token_hash,sessions[0].mfa_hash,Number(sessions[0].pending_until)===Number(sessions[0].created_at),Number(sessions[0].expires_at)-Number(sessions[0].created_at)],[sha(browser.primary),sha(browser.session),true,86_400_000],'primary session: 24 h, bound, never pending');
  check([mfa[0].principal,mfa[0].passkey_id,Number(mfa[0].expires_at)-Number(mfa[0].created_at),Number(mfa[0].idle_expires_at)-Number(mfa[0].created_at)],[principal,null,86_400_000,15*60_000],'MFA session: absolute 24 h, idle timeout, no passkey');
  check(user.last_login_at!==null,true,'last_login_at set');
  const viewer=await f.viewerOf(browser);
  check([viewer.identitySource,viewer.principal,viewer.entra],['entra',principal,{tenantId:tenant,objectId:oid,email:'ada@contoso.example'}],'localIdentity: the Entra viewer');
  const status=await m.mfa.mfaStatus(f.request('/',{browser}),viewer);
  check([status.enabled,status.authenticated,status.passkeyCount,status.authenticatorCount],[true,true,0,0],'mfaStatus: authenticated without an mfa_accounts row');
  check(await f.count(sql`SELECT count(*) AS n FROM mfa_accounts WHERE principal=${principal}`),0,'no mfa_accounts row');
  check((await f.auditRows('auth.entra.%')).map(row=>[row.actor,row.action,row.target]),[[user.auth_email,'auth.entra.account.create',user.id],[user.auth_email,'auth.entra.login',user.id]],'account.create and login rows');
  check(await f.count(sql`SELECT count(*) AS n FROM entra_sign_in_flows`),0,'the flow row is gone');
  const grant=await d.one(sql`SELECT * FROM mfa_grants WHERE token_hash=${sha(browser.grant)}`);
  check([!!grant,grant?.principal,grant?.user_id,Number(grant?.expires_at)-Number(grant?.created_at)],[true,principal,user.id,8*60*60_000],'the forced sign-in gives the browser an MFA grant of 8 hours');
  check(attributes(cookieNames.grant),['Path=/','Secure','HttpOnly','SameSite=Strict'],'the grant cookie is HttpOnly, Secure and SameSite=Strict');
  check(first.html.includes(browser.grant),false,'the page never holds the grant token');
 }

 // ---- Second sign-in: same account, name and email from the token ------------------
 {
  microsoft.claims={name:' Ada\u0007 King ',email:undefined,preferred_username:'ada.king@contoso.example'};
  const second=await f.signIn();
  check(second.target,'/','second sign-in');
  const users=await d.query(sql`SELECT id,display_name,email FROM local_users WHERE identity_source='entra'`);
  check(users.map(user=>({...user})),[{id:userId,display_name:'Ada King',email:'ada.king@contoso.example'}],'same account; name without control characters, email from preferred_username');
  check((await f.auditRows('auth.entra.account.create')).length,1,'no second account.create row');
  check((await f.auditRows('auth.entra.login')).length,2,'a second login row');
  microsoft.claims={name:'',email:undefined,preferred_username:'not-an-email'};
  await f.signIn();
  check({...await d.one(sql`SELECT display_name,email FROM local_users WHERE id=${userId}`)},{display_name:'not-an-email',email:''},'name from preferred_username, no email when it is none');
  microsoft.claims={name:'',preferred_username:''};
  await f.signIn();
  check((await d.one(sql`SELECT display_name FROM local_users WHERE id=${userId}`)).display_name,oid,'name falls back to the oid');
  microsoft.claims={};await f.signIn();
 }

 // ---- Refusals after a valid flow: code, no session, one audit row -----------------
 // `rejected` is the check=<...> part of a tokenRejected row (with the GUIDs of the id_token); `early` means no GUID was known yet.
 // `times` are the expected time offsets after a time check (a number or none), in their order: the case then holds the
 // portal clock at a whole second (f.clock) from before `setup` until after the check, so the claims of `setup` (second())
 // and the check read the same clock, and the row must equal `target` followed by " <name>=<value>" for each time, exactly.
 // `beforeCallback` runs between the start and the callback. heldSeconds collects the held epoch seconds.
 const heldSeconds=[];
 const refusal=async(label,setup,expected,{rejected,early=false,target=`reason=${expected} tenant=${early?'-':tenant} object=${early?'-':oid}${rejected?` check=${rejected}`:''}`,times,audited=true,page=`/#entra=${expected}`,callback,beforeCallback}={})=>{
  if(times){f.clock=Math.floor(Date.now()/1000)*1000;heldSeconds.push(f.clock/1000);}
  try{
   f.resetMicrosoft();await setup?.();
   const [sessions,mfa,before]=[await sessionCount(),await mfaCount(),(await refusedRows()).length];
   const result=await f.signIn({callback,before:beforeCallback});
   check([result.response.status,result.target?.replace(/&amp;/g,'&')],[200,page],`${label}: page with ${page}`);
   // No token leaves the check: a JWT starts with eyJ (base64url of {").
   check([result.html.includes('eyJ'),result.html.includes('access_as_user'),result.html.includes('MARKER')],[false,false,false],`${label}: no token or Microsoft text in the page`);
   const names=setCookies(result.response).map(cookie=>cookie.name);
   check([names,await sessionCount(),await mfaCount()],[['__Host-serverdesk-entra'],sessions,mfa],`${label}: no session cookie and no session`);
   const rows=(await refusedRows()).slice(before),line=target+Object.entries(times??{}).map(([name,value])=>` ${name}=${value}`).join('');
   check(rows.map(row=>[row.actor,row.target]),audited?[['System',line]]:[],`${label}: ${audited?'one refused row':'no audit row'}`);
  }finally{f.clock=null;f.resetMicrosoft();}
 };
 // The time offsets of an id_token and an access token whose other times are the defaults of the fixture (now, exp in 1 hour).
 const idTimes=times=>({times:{exp:3600,iat:0,nbf:0,auth:0,...times}}),accessTimes=times=>({times:{exp:3600,iat:0,nbf:0,...times}});
 // Claims are built relative to the held second of a time case (the real second otherwise).
 const second=()=>Math.floor((f.clock??Date.now())/1000);
 {
  const other=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
  await refusal('bad signature',()=>{microsoft.signWith=other.privateKey;},'tokenRejected',{early:true,rejected:'id.signature'});
  await refusal('a signature that is not base64url',()=>{const original=microsoft.token;microsoft.token=form=>{const answer=original(form),body=JSON.parse(answer.body);return {...answer,body:JSON.stringify({...body,id_token:body.id_token.replace(/\.[^.]+$/,'.@@')})};};},'tokenRejected',{early:true,rejected:'id.signature'});
  await refusal('wrong iss',()=>{microsoft.claims={iss:'https://login.microsoftonline.com/common/v2.0'};},'tokenRejected',{rejected:'id.issuer'});
  await refusal('wrong aud',()=>{microsoft.claims={aud:'00000000-0000-4000-8000-000000000000'};},'tokenRejected',{rejected:'id.audience'});
  const otherTenant='22222222-3333-4444-8555-666666666666';
  await refusal('other tenant',()=>{microsoft.claims={tid:otherTenant,iss:`https://login.microsoftonline.com/${otherTenant}/v2.0`};},'wrongTenant',{target:`reason=wrongTenant tenant=${otherTenant} object=${oid}`});
  // A refused time check names the times as offsets in seconds from the portal clock (exp iat nbf auth; no start at a sign-in).
  await refusal('expired exp',()=>{microsoft.claims={exp:second()-10};},'tokenRejected',{rejected:'id.expired',...idTimes({exp:-10})});
  await refusal('no exp',()=>{microsoft.claims={exp:undefined};},'tokenRejected',{rejected:'id.expired',...idTimes({exp:'none'})});
  await refusal('exp as text',()=>{microsoft.claims={exp:String(second()+600)};},'tokenRejected',{rejected:'id.expired',...idTimes({exp:'none'})});
  // 1e400 in the JSON of the token parses as Infinity: a number that is not finite.
  await refusal('exp not finite',()=>{const original=microsoft.token;microsoft.token=form=>{const answer=original(form),body=JSON.parse(answer.body),claims=JSON.stringify({...microsoft.idClaims(),exp:0,nbf:second()+600}).replace('"exp":0','"exp":1e400');return {...answer,body:JSON.stringify({...body,id_token:microsoft.jwt({alg:'RS256',typ:'JWT',kid:'key-1'},claims)})};};},'tokenRejected',{rejected:'id.ahead',...idTimes({exp:'none',nbf:600})});
  await refusal('nbf in the future',()=>{microsoft.claims={nbf:second()+600};},'tokenRejected',{rejected:'id.ahead',...idTimes({nbf:600})});
  await refusal('iat in the future',()=>{microsoft.claims={iat:second()+600};},'tokenRejected',{rejected:'id.ahead',...idTimes({iat:600})});
  await refusal('iat as text',()=>{microsoft.claims={iat:'now'};},'tokenRejected',{rejected:'id.ahead',...idTimes({iat:'none'})});
  // The text of a claim never reaches the row: none (the marker check below looks for MARKER).
  await refusal('iat as a marker text',()=>{microsoft.claims={iat:'MARKER-iat'};},'tokenRejected',{rejected:'id.ahead',...idTimes({iat:'none'})});
  // The offsets come from the portal clock read at the callback, not from the real time the person took: a slow callback changes nothing.
  let waited=0;
  await refusal('nbf in the future after a slow callback',()=>{microsoft.claims={nbf:second()+600};},'tokenRejected',{rejected:'id.ahead',...idTimes({nbf:600}),beforeCallback:async()=>{const from=Date.now();await new Promise(resolve=>setTimeout(resolve,1600));waited=Date.now()-from;}});
  check(waited>=1500,true,`the slow callback waited at least 1500 ms of real time (${waited} ms)`);
  await refusal('expired exp without iat',()=>{microsoft.claims={exp:second()-10,iat:undefined};},'tokenRejected',{rejected:'id.expired',...idTimes({exp:-10,iat:'none'})});
  await refusal('expired exp without nbf',()=>{microsoft.claims={exp:second()-10,nbf:undefined};},'tokenRejected',{rejected:'id.expired',...idTimes({exp:-10,nbf:'none'})});
  await refusal('expired exp without auth_time',()=>{microsoft.claims={exp:second()-10,auth_time:undefined};},'tokenRejected',{rejected:'id.expired',...idTimes({exp:-10,auth:'none'})});
  await refusal('stale iat and auth_time, expired exp',()=>{const now=second();microsoft.claims={exp:now-12,iat:now-3612,nbf:now-3612,auth_time:now-40};},'tokenRejected',{rejected:'id.expired',...idTimes({exp:-12,iat:-3612,nbf:-3612,auth:-40})});
  // An offset beyond ±999999999 s is clamped.
  await refusal('exp 1e12 s in the past',()=>{microsoft.claims={exp:second()-1e12};},'tokenRejected',{rejected:'id.expired',...idTimes({exp:-999999999})});
  await refusal('exp 1e12 s ahead (refused for nbf)',()=>{const now=second();microsoft.claims={exp:now+1e12,nbf:now+600};},'tokenRejected',{rejected:'id.ahead',...idTimes({exp:999999999,nbf:600})});
  await refusal('nonce mismatch',()=>{const original=microsoft.token;microsoft.token=form=>{microsoft.nonce='other-nonce';return original(form);};},'tokenRejected',{rejected:'id.nonce'});
  await refusal('oid not a GUID',()=>{microsoft.claims={oid:'not-a-guid'};},'tokenRejected',{target:`reason=tokenRejected tenant=${tenant} object=- check=id.oid`});
  await refusal('groups not a list',()=>{microsoft.claims={groups:'MARKER-group'};},'tokenRejected',{rejected:'id.groups'});
  await refusal('alg none',()=>{microsoft.header={alg:'none'};},'tokenRejected',{early:true,rejected:'id.format'});
  await refusal('no kid',()=>{microsoft.header={kid:undefined};},'tokenRejected',{early:true,rejected:'id.format'});
  await refusal('crit header',()=>{microsoft.header={crit:['exp']};},'tokenRejected',{early:true,rejected:'id.format'});
  await refusal('not a compact JWS',()=>{microsoft.token=()=>({status:200,body:JSON.stringify({id_token:'MARKER-part.two',access_token:microsoft.accessToken()})});},'tokenRejected',{early:true,rejected:'id.format'});
  await refusal('undecodable claims',()=>{microsoft.token=()=>({status:200,body:JSON.stringify({id_token:`${Buffer.from('{"alg":"RS256","kid":"key-1"}').toString('base64url')}.MARKER.c2ln`,access_token:microsoft.accessToken()})});},'tokenRejected',{early:true,rejected:'id.format'});
  await refusal('unknown kid',()=>{microsoft.header={kid:'key-unknown'};},'tokenRejected',{early:true,rejected:'id.key'});
  await refusal('groups overage',()=>{microsoft.claims={_claim_names:{groups:'src1'},_claim_sources:{src1:{endpoint:'https://graph.microsoft.com/v1.0/users/x/getMemberObjects'}}};},'groupsOverage');
  // Microsoft's answer text: description, trace and correlation ID and timestamp carry markers that must not reach the row.
  const answerText={error_description:'AADSTS50076: MARKER-description. Trace ID: MARKER-trace Correlation ID: MARKER-correlation Timestamp: MARKER-time',trace_id:'MARKER-trace',correlation_id:'MARKER-correlation',timestamp:'MARKER-time'};
  const redeemRefused=body=>()=>{microsoft.token=()=>({status:400,body:JSON.stringify({...answerText,...body})});};
  await refusal('refused redemption',()=>{microsoft.token=()=>({status:400,body:JSON.stringify({error:'invalid_grant',error_description:'AADSTS70008: secret text'})});},'tokenRejected',{early:true,rejected:'redeem error=invalid_grant'});
  await refusal('refused redemption with an AADSTS number',redeemRefused({error:'invalid_grant',error_codes:[50076]}),'tokenRejected',{early:true,rejected:'redeem error=invalid_grant aadsts=50076'});
  await refusal('refused redemption with more than 3 numbers',redeemRefused({error:'invalid_grant',error_codes:[50076,50079,50158,50072]}),'tokenRejected',{early:true,rejected:'redeem error=invalid_grant aadsts=50076,50079,50158'});
  await refusal('refused redemption with non-numeric codes',redeemRefused({error:'invalid_grant',error_codes:['MARKER-code',null,{},12345678,999,1.5,50076]}),'tokenRejected',{early:true,rejected:'redeem error=invalid_grant aadsts=50076'});
  await refusal('refused redemption with error_codes not a list',redeemRefused({error:'invalid_grant',error_codes:'50076'}),'tokenRejected',{early:true,rejected:'redeem error=invalid_grant'});
  await refusal('refused redemption with an unknown error',redeemRefused({error:'MARKER-error',error_codes:[9002313]}),'tokenRejected',{early:true,rejected:'redeem error=other aadsts=9002313'});
  await refusal('refused redemption without an error',()=>{microsoft.token=()=>({status:403,body:'MARKER-not-json'});},'tokenRejected',{early:true,rejected:'redeem error=other'});
  await refusal('refused redemption with unsupported_grant_type',redeemRefused({error:'unsupported_grant_type'}),'tokenRejected',{early:true,rejected:'redeem error=unsupported_grant_type'});
  // A used or an expired code is no rejected token: expired, without an audit row.
  await refusal('code already redeemed (54005)',redeemRefused({error:'invalid_grant',error_codes:[54005]}),'expired',{audited:false});
  await refusal('code expired (70008)',redeemRefused({error:'invalid_grant',error_codes:[70008]}),'expired',{audited:false});
  await refusal('54005 without invalid_grant',redeemRefused({error:'invalid_request',error_codes:[54005]}),'tokenRejected',{early:true,rejected:'redeem error=invalid_request aadsts=54005'});
  // The callback error parameter: the OAuth error of the list or other, and the AADSTS numbers of error_description.
  const callbackError=(error,description)=>({callback:{query:{error,...(description===undefined?{}:{error_description:description}),code:undefined}}});
  await refusal('callback error with an AADSTS number',null,'tokenRejected',{early:true,rejected:'callback error=invalid_request aadsts=50058',...callbackError('invalid_request','AADSTS50058: MARKER-description. Trace ID: MARKER-trace Correlation ID: MARKER-correlation Timestamp: MARKER-time')});
  await refusal('callback error with more than 3 numbers',null,'tokenRejected',{early:true,rejected:'callback error=interaction_required aadsts=50058,50076,50079',...callbackError('interaction_required','AADSTS50058 AADSTS123 AADSTS50076 AADSTS12345678 AADSTS50079 AADSTS50158')});
  await refusal('callback error without a description',null,'tokenRejected',{early:true,rejected:'callback error=login_required',...callbackError('login_required')});
  await refusal('callback error of no list',null,'tokenRejected',{early:true,rejected:'callback error=other',...callbackError('MARKER-error','MARKER-description')});
  await refusal('an empty callback error',null,'tokenRejected',{early:true,rejected:'callback error=other',...callbackError('')});
  await refusal('callback without a code',null,'tokenRejected',{early:true,rejected:'code',callback:{query:{code:undefined}}});
  await refusal('callback with a code over 8192 characters',null,'tokenRejected',{early:true,rejected:'code',callback:{query:{code:'c'.repeat(8193)}}});
  // A temporary Microsoft failure is no rejected token: unavailable, without an audit row.
  await refusal('callback error server_error',null,'unavailable',{audited:false,...callbackError('server_error','AADSTS90033: MARKER-description')});
  await refusal('callback error temporarily_unavailable',null,'unavailable',{audited:false,...callbackError('temporarily_unavailable')});
  const markers=JSON.stringify(await refusedRows());
  check([markers.includes('AADSTS'),markers.includes('MARKER'),markers.includes('eyJ')],[false,false,false],'no Microsoft text, trace or correlation ID, timestamp or token part in an audit row');
  await refusal('network failure at redemption',()=>{microsoft.fail=request=>{if(request.url.endsWith('/token'))throw new Error('socket hang up');return null;};},'unavailable',{audited:false});
  await refusal('server error at redemption',()=>{microsoft.token=()=>({status:503,body:''});},'unavailable',{audited:false});
  await d.exec(sql`UPDATE local_users SET status='disabled' WHERE id=${userId}`);
  await refusal('disabled account',null,'accountDisabled');
  await d.exec(sql`UPDATE local_users SET status='active' WHERE id=${userId}`);
 }

 // ---- The MFA signal: amr of the v1.0 access token of the portal API -----------------
 {
  const mfa=(label,amr,diagnostic,claims={})=>refusal(label,()=>{microsoft.claims=claims;microsoft.accessClaims={amr};},'mfaMissing',{target:`reason=mfaMissing tenant=${tenant} object=${oid} amr=${diagnostic}`,page:`/#entra=mfaMissing&amr=${diagnostic}`});
  await mfa('amr pwd',['pwd'],'pwd');
  await mfa('amr absent',undefined,'missing');
  await mfa('amr not an array','mfa','missing');
  await mfa('unknown values and duplicates',['pwd','x"<y>',7,'rsa','pwd'],'pwd,other,rsa');
  await mfa('an empty amr',[],'');
  await mfa('MFA-like values without mfa',['pwd','ngcmfa','fido','MFA'],'pwd,ngcmfa,fido,other');
  await mfa('mfa only in the id_token',['pwd'],'pwd',{amr:['mfa']});
  const other=crypto.generateKeyPairSync('rsa',{modulusLength:2048}),otherTenant='22222222-3333-4444-8555-666666666666';
  // The access token: the JWS, the signature and the claims that bind it to the id_token and the app.
  await refusal('access token: bad signature',()=>{microsoft.accessSignWith=other.privateKey;},'tokenRejected',{rejected:'access.signature'});
  await refusal('access token: nonce header (a Graph token)',()=>{microsoft.accessHeader={nonce:'graph-nonce'};},'tokenRejected',{rejected:'access.format'});
  await refusal('access token: alg none',()=>{microsoft.accessHeader={alg:'none'};},'tokenRejected',{rejected:'access.format'});
  await refusal('access token: crit header',()=>{microsoft.accessHeader={crit:['exp']};},'tokenRejected',{rejected:'access.format'});
  await refusal('access token: not a compact JWS',()=>{const original=microsoft.token;microsoft.token=form=>{const answer=original(form);return {...answer,body:JSON.stringify({...JSON.parse(answer.body),access_token:'MARKER-access'})};};},'tokenRejected',{rejected:'access.format'});
  await refusal('access token: unknown kid',()=>{microsoft.accessHeader={kid:'key-unknown'};},'tokenRejected',{rejected:'access.key'});
  await refusal('access token: wrong iss',()=>{microsoft.accessClaims={iss:`https://login.microsoftonline.com/${tenant}/v2.0`};},'tokenRejected',{rejected:'access.issuer'});
  await refusal('access token: wrong tid',()=>{microsoft.accessClaims={tid:otherTenant,iss:`https://sts.windows.net/${otherTenant}/`};},'tokenRejected',{rejected:'access.issuer'});
  await refusal('access token: wrong appid',()=>{microsoft.accessClaims={appid:'00000000-0000-4000-8000-000000000000'};},'tokenRejected',{rejected:'access.appid'});
  await refusal('access token: other oid',()=>{microsoft.accessClaims={oid:'12345678-1234-4234-8234-123456789012'};},'tokenRejected',{rejected:'access.identity'});
  // An access token has no auth_time: exp iat nbf only.
  await refusal('access token: expired',()=>{microsoft.accessClaims={exp:second()-10};},'tokenRejected',{rejected:'access.expired',...accessTimes({exp:-10})});
  await refusal('access token: no exp',()=>{microsoft.accessClaims={exp:undefined};},'tokenRejected',{rejected:'access.expired',...accessTimes({exp:'none'})});
  await refusal('access token: nbf ahead',()=>{microsoft.accessClaims={nbf:second()+600};},'tokenRejected',{rejected:'access.ahead',...accessTimes({nbf:600})});
  await refusal('access token: iat ahead',()=>{microsoft.accessClaims={iat:second()+600};},'tokenRejected',{rejected:'access.ahead',...accessTimes({iat:600})});
  await refusal('access token: expired without iat and nbf',()=>{microsoft.accessClaims={exp:second()-10,iat:undefined,nbf:undefined};},'tokenRejected',{rejected:'access.expired',...accessTimes({exp:-10,iat:'none',nbf:'none'})});
  // The setup of the portal API: apiSetupMissing with its detail.
  const setup=detail=>({target:`reason=apiSetupMissing tenant=${tenant} object=${oid} detail=${detail}`});
  await refusal('access token: ver 2.0',()=>{microsoft.accessClaims={ver:'2.0',iss:`https://login.microsoftonline.com/${tenant}/v2.0`};},'apiSetupMissing',setup('version'));
  await refusal('access token: no ver',()=>{microsoft.accessClaims={ver:undefined};},'apiSetupMissing',setup('version'));
  await refusal('access token: other aud (a Graph token)',()=>{microsoft.accessClaims={aud:'https://graph.microsoft.com'};},'apiSetupMissing',setup('audience'));
  await refusal('access token: scp without access_as_user',()=>{microsoft.accessClaims={scp:'User.Read access_as_user_x'};},'apiSetupMissing',setup('scope'));
  await refusal('access token: no scp',()=>{microsoft.accessClaims={scp:undefined};},'apiSetupMissing',setup('scope'));
  const early={target:'reason=apiSetupMissing tenant=- object=- detail=missing'};
  await refusal('no access token in the answer',()=>{microsoft.dropAccessToken=true;},'apiSetupMissing',early);
  await refusal('an empty access token',()=>{const original=microsoft.token;microsoft.token=form=>{const answer=original(form);return {...answer,body:JSON.stringify({...JSON.parse(answer.body),access_token:''})};};},'apiSetupMissing',early);
  const refused={target:'reason=apiSetupMissing tenant=- object=- detail=refused'};
  await refusal('callback error invalid_scope',null,'apiSetupMissing',{...refused,callback:{query:{error:'invalid_scope',error_description:'AADSTS70011: secret text',code:undefined}}});
  await refusal('callback error invalid_resource',null,'apiSetupMissing',{...refused,callback:{query:{error:'invalid_resource',code:undefined}}});
  for(const code of [500011,65001,65005,70011])await refusal(`redemption refused with ${code}`,()=>{microsoft.token=()=>({status:400,body:JSON.stringify({error:'invalid_grant',error_description:`AADSTS${code}: secret text`,error_codes:[code]})});},'apiSetupMissing',refused);
  await refusal('redemption refused with invalid_scope',()=>{microsoft.token=()=>({status:400,body:JSON.stringify({error:'invalid_scope',error_description:'AADSTS70011: secret text'})});},'apiSetupMissing',refused);
  await refusal('redemption refused with invalid_client',()=>{microsoft.token=()=>({status:401,body:JSON.stringify({error:'invalid_client',error_codes:[7000215]})});},'tokenRejected',{target:'reason=tokenRejected tenant=- object=- check=redeem error=invalid_client aadsts=7000215'});
  await refusal('id_token missing in a 200 answer',()=>{microsoft.token=()=>({status:200,body:JSON.stringify({access_token:microsoft.accessToken()})});},'tokenRejected',{target:'reason=tokenRejected tenant=- object=- check=redeem.idToken'});
  await refusal('callback error access_denied',null,'cancelled',{audited:false,callback:{query:{error:'access_denied',code:undefined}}});
  const rows=JSON.stringify(await refusedRows());
  // Offsets only: no refused row carries an absolute time, the held epoch second of a time case or that second ±10, ±600 or ±3600.
  check(heldSeconds.length,20,'every time refusal (15 of the id_token, 5 of the access token) held the clock');
  const absolute=[...new Set(heldSeconds.flatMap(held=>[0,10,600,3600].flatMap(delta=>[held-delta,held+delta])))].map(String);
  check(absolute.filter(text=>rows.includes(text)),[],'no absolute claim time in a refused row');
  check(['AADSTS','eyJ','x\"<y>','Ada','ada@contoso','subject-of-the-api','access_as_user','graph-nonce','MFA','MARKER'].filter(text=>rows.includes(text)),[],'no token, claim text or Microsoft text in a refused row');
  // Every tokenRejected row names one check of the fixed list, and its error and aadsts parts have their fixed shapes;
  // only the four time checks end with the time offsets (exp iat nbf, auth for the id_token, no start at a sign-in).
  const n=timeOffsetPattern;
  const shape=new RegExp(` check=(?:(?:callback|code|redeem|redeem\\.idToken|id\\.(?:format|key|signature|issuer|audience|nonce|oid|groups)|access\\.(?:format|key|signature|issuer|appid|identity))(?: error=[a-z_]+)?(?: aadsts=\\d{4,7}(?:,\\d{4,7}){0,2})?|id\\.(?:expired|ahead) exp=${n} iat=${n} nbf=${n} auth=${n}|access\\.(?:expired|ahead) exp=${n} iat=${n} nbf=${n})$`);
  check((await refusedRows()).filter(row=>row.target.startsWith('reason=tokenRejected ')&&!shape.test(row.target)).map(row=>row.target),[],'every tokenRejected row ends with a check of the list');
  const base=`reason=tokenRejected tenant=${tenant} object=${oid}`;
  check([
   `${base} check=id.expired exp=-12 iat=-3612 nbf=-3612 auth=-40`,`${base} check=access.ahead exp=3600 iat=0 nbf=600`,`${base} check=id.ahead exp=none iat=none nbf=none auth=none`,`${base} check=redeem error=invalid_grant aadsts=50076`,
  ].map(target=>shape.test(target)),[true,true,true,true],'the shape accepts the time offsets after a time check');
  check([
   `${base} check=id.nonce exp=1 iat=1 nbf=1 auth=1`,`${base} check=redeem exp=1 iat=1 nbf=1`,`${base} check=redeem error=invalid_grant exp=1 iat=1 nbf=1`,`${base} check=access.identity exp=1 iat=1 nbf=1`,
   `${base} check=id.expired`,`${base} check=id.expired exp=1 iat=1 nbf=1`,`${base} check=access.expired exp=1 iat=1 nbf=1 auth=1`,`${base} check=id.expired exp=1 iat=1 nbf=1 auth=1 start=-5`,
   `${base} check=id.expired exp=+1 iat=1 nbf=1 auth=1`,`${base} check=id.expired exp=1000000000 iat=1 nbf=1 auth=1`,`${base} check=id.expired exp=-0 iat=1 nbf=1 auth=1`,`${base} check=id.expired exp=1.5 iat=1 nbf=1 auth=1`,
  ].filter(target=>shape.test(target)),[],'the shape refuses time offsets after any other check, an incomplete or reordered set, a start part at a sign-in and anything but plain integers');
  // Successes: the bare client ID as aud, more scopes and more amr values.
  for(const [label,claims] of [['aud the bare client ID',{aud:clientId}],['several scopes',{scp:'User.Read access_as_user'}],['amr with mfa among other values',{amr:['rsa','pwd','mfa','ngcmfa']}]]){
   f.resetMicrosoft();microsoft.accessClaims=claims;
   check((await f.signIn()).target,'/',`a valid access token with ${label} signs in`);
  }
  f.resetMicrosoft();
 }

 // ---- Keys: cache, one refetch for an unknown kid, rotation ------------------------
 {
  f.resetMicrosoft();
  const keyCalls=()=>microsoft.calls.filter(call=>call.url.endsWith('/discovery/v2.0/keys')).length;
  check((await f.signIn()).target,'/','sign-in fetches the keys');
  check(keyCalls(),1,'one key fetch');
  await f.signIn();check(keyCalls(),1,'keys from the cache');
  microsoft.header={kid:'key-unknown'};
  check((await f.signIn()).target,'/#entra=tokenRejected','unknown kid inside 5 minutes: refused');
  check((await refusedRows()).at(-1).target,'reason=tokenRejected tenant=- object=- check=id.key','unknown kid inside the refetch window: check=id.key');
  check(keyCalls(),1,'no refetch within 5 minutes of the last fetch');
  f.offset+=6*60_000;
  check((await f.signIn()).target,'/#entra=tokenRejected','unknown kid after 5 minutes: refused');
  check(keyCalls(),2,'one refetch for the unknown kid');
  check((await f.signIn()).target,'/#entra=tokenRejected','still unknown');
  check(keyCalls(),2,'at most one refetch per 5 minutes');
  const rotated={kid:'key-2',...crypto.generateKeyPairSync('rsa',{modulusLength:2048})};
  microsoft.keys=[microsoft.keys[0],rotated];microsoft.header={kid:'key-2'};microsoft.signWith=rotated.privateKey;
  f.offset+=6*60_000;
  check([(await f.signIn()).target,keyCalls()],['/',3],'a rotated key is found by the refetch');
  f.resetMicrosoft();f.offset=0;
 }

 // ---- Flow refusals without audit ---------------------------------------------------
 {
  const before=(await refusedRows()).length;
  const replay=await f.signIn();
  const again=await m.callbackApi.GET(f.request('/api/auth/entra/callback?code=x&state='+replay.authorize.searchParams.get('state'),{cookie:`__Host-serverdesk-entra=${replay.flow}`}));
  check(/url=([^"]+)"/.exec(await again.text())[1],'/#entra=expired','a reused state: expired');
  check((await f.signIn({callback:{cookie:'__Host-serverdesk-entra='+'0'.repeat(64)}})).target,'/#entra=expired','a foreign browser token: expired');
  check((await f.signIn({callback:{cookie:''}})).target,'/#entra=expired','no flow cookie: expired');
  check((await f.signIn({callback:{query:{state:'f'.repeat(64)}}})).target,'/#entra=expired','an unknown state: expired');
  check((await f.signIn({before:async()=>{f.offset+=11*60_000;}})).target,'/#entra=expired','after 10 minutes: expired');
  f.offset=0;
  check((await f.signIn({callback:{query:{error:'access_denied',code:undefined}}})).target,'/#entra=cancelled','access_denied: cancelled');
  check((await refusedRows()).length,before,'no audit row for expired or cancelled');
  for(const error of ['server_error','temporarily_unavailable']){
   const result=await f.signIn({callback:{query:{error,code:undefined}}}),state=result.authorize.searchParams.get('state');
   check([result.target,(await refusedRows()).length,await f.count(sql`SELECT count(*) AS n FROM entra_sign_in_flows WHERE state_hash=${sha(state)}`)],['/#entra=unavailable',before,0],`${error}: unavailable, no audit row, the flow is deleted`);
  }
  check((await f.signIn({callback:{query:{error:'login_required',error_description:'AADSTS50058: Silent sign-in failed',code:undefined}}})).target,'/#entra=tokenRejected','another error: tokenRejected');
  check((await refusedRows()).slice(before).map(row=>row.target),['reason=tokenRejected tenant=- object=- check=callback error=login_required aadsts=50058'],'one audit row for the other error, with its check');
  check((await f.signIn({before:()=>f.configure({enabled:0})})).target,'/#entra=notConfigured','switched off during the flow: notConfigured');
  await f.configure();
  // A new revision while the code is redeemed (after the callback read the settings) refuses the commit: nothing of it stays.
  const users=await f.count(sql`SELECT count(*) AS n FROM local_users`),sessions=await sessionCount(),original=microsoft.token;
  microsoft.token=async form=>{await d.exec(sql`UPDATE entra_settings SET revision=revision+1`);return original(form);};
  microsoft.claims={oid:'12345678-1234-4234-8234-123456789012'};
  check((await f.signIn()).target,'/#entra=expired','a new revision before the commit: no session');
  check([await f.count(sql`SELECT count(*) AS n FROM local_users`),await sessionCount(),(await f.auditRows('auth.entra.account.create')).length],[users,sessions,1],'the whole commit rolled back: no account, no session, no row');
  f.resetMicrosoft();await f.configure();
 }

 // ---- 1000 open flows -------------------------------------------------------------
 {
  await d.exec(sql`DELETE FROM entra_sign_in_flows`);
  const at=Date.now();
  await d.exec(sql`INSERT INTO entra_sign_in_flows(state_hash,browser_hash,nonce_hash,code_verifier_enc,created_at,expires_at,attempt_bucket,attempt_window_at) SELECT 'state'||n,'b','n','v',${at},${at+600_000},'bucket',${at} FROM generate_series(1,1000) n`);
  const busy=await m.startApi.GET(f.request('/api/auth/entra/start'));
  check([busy.headers.get('location'),busy.headers.getSetCookie()],['/#entra=busy',[]],'1000 open flows: busy');
  await d.exec(sql`UPDATE entra_sign_in_flows SET expires_at=${at-1} WHERE state_hash='state1'`);
  check((await m.startApi.GET(f.request('/api/auth/entra/start'))).headers.get('location').startsWith('https://login.microsoftonline.com/'),true,'an expired row is deleted at the start and frees a place');
  await d.exec(sql`DELETE FROM entra_sign_in_flows`);
 }

 // ---- Attempt counting -------------------------------------------------------------
 {
  await d.exec(sql`DELETE FROM local_auth_attempts`);
  const headers={'X-ServerDesk-Client-IP':'203.0.113.9'},bucket=sha('ip:203.0.113.9');
  await m.startApi.GET(f.request('/api/auth/entra/start',{headers}));
  check(Number((await d.one(sql`SELECT attempts FROM local_auth_attempts WHERE bucket=${bucket}`)).attempts),1,'a start counts in the address bucket');
  await f.signIn({startHeaders:headers});
  check(Number((await d.one(sql`SELECT attempts FROM local_auth_attempts WHERE bucket=${bucket}`)).attempts),1,'a successful sign-in gives its attempt back');
  await d.exec(sql`UPDATE local_auth_attempts SET attempts=41 WHERE bucket=${bucket}`);
  check((await m.startApi.GET(f.request('/api/auth/entra/start',{headers}))).headers.get('location'),'/#entra=rateLimited','over the address limit: rateLimited');
  await d.exec(sql`DELETE FROM local_auth_attempts`);
 }

 // ---- Certificate credential: the client assertion -----------------------------------
 {
  const certificate=selfSignedCertificate();
  await d.exec(sql`UPDATE entra_settings SET credential_kind='certificate',secret_enc=NULL,certificate_pem=${certificate.certificatePem},private_key_enc=${await m.mfa.encryptSecret(certificate.privateKeyPem,'entra:private-key')},certificate_thumbprint=${certificate.thumbprint},certificate_expires_at=${Date.parse('2049-12-31T23:59:59Z')}`);
  f.resetMicrosoft();
  check((await f.signIn()).target,'/','sign-in with the certificate assertion');
  const form=Object.fromEntries(new URLSearchParams(microsoft.calls.find(call=>call.url.endsWith('/token')).body));
  check([form.client_secret,form.client_assertion_type],[undefined,'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'],'assertion instead of a secret');
  const [header,claims,signature]=form.client_assertion.split('.'),json=part=>JSON.parse(Buffer.from(part,'base64url').toString());
  check([json(header).alg,json(header).x5t],['RS256',Buffer.from(certificate.thumbprint,'hex').toString('base64url')],'header: RS256 and x5t = base64url SHA-1 thumbprint');
  const body=json(claims);
  check([body.aud,body.iss,body.sub,/^[0-9a-f-]{36}$/.test(body.jti),body.exp-body.nbf<=600,body.exp>body.nbf],[`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,clientId,clientId,true,true,true],'claims: aud token URL, iss = sub = client, jti, exp at most 10 minutes');
  check(crypto.verify('sha256',Buffer.from(`${header}.${claims}`),certificate.publicKey,Buffer.from(signature,'base64url')),true,'signed with the certificate key');
  await f.configure();
 }

 // ---- Idle end: the sign-in through the grant, no resume, logout --------------------------
 {
  f.resetMicrosoft();
  const session=await f.signIn(),viewer=await f.viewerOf(session.browser);
  f.setViewer(viewer);
  f.offset=16*60_000;
  const status=await m.mfa.mfaStatus(f.request('/',{browser:session.browser}),viewer);
  check([status.enabled,status.authenticated],[true,false],'after the idle timeout the MFA session has ended');
  await assert.rejects(m.mfa.requireMfa(f.request('/',{browser:session.browser}),viewer),error=>error.code==='SESSION_EXPIRED');checks++;
  check([await f.viewerOf(session.browser),(await f.answer(await m.authApi.GET(f.request('/api/auth',{browser:session.browser})))).body.viewer],[null,null],'the bound primary session ended with it: GET /api/auth has no viewer');
  const resume=await f.answer(await m.mfaApi.POST(f.request('/api/mfa',{browser:session.browser,payload:{action:'resume'}})));
  check([resume.status,resume.body.messageKey],[400,'apiError.mfa.unknownAction'],'resume is an unknown action');
  // The sign-in after the idle timeout is the normal start: with the live grant, no prompt and a session.
  microsoft.claims={auth_time:Math.floor(Date.now()/1000)-3600};
  const again=await f.signIn({startHeaders:{Cookie:`${cookieNames.grant}=${session.browser.grant}`}});
  check([again.authorize.searchParams.get('prompt'),again.target,!!await f.viewerOf(again.browser)],[null,'/',true],'idle, then Sign in with Microsoft: no prompt, an old auth_time is fine, a session');
  f.resetMicrosoft();f.offset=0;
  const live=await f.signIn(),hashes=[sha(live.browser.primary),sha(live.browser.session)];
  const logout=await f.answer(await m.authApi.POST(f.request('/api/auth',{browser:live.browser,payload:{action:'logout'}})));
  check(logout.status,200,'logout');
  check([await f.count(sql`SELECT count(*) AS n FROM local_auth_sessions WHERE token_hash=${hashes[0]}`),await f.count(sql`SELECT count(*) AS n FROM mfa_sessions WHERE token_hash=${hashes[1]}`)],[0,0],'logout deletes both rows');
  check(setCookies(logout.response).filter(cookie=>[cookieNames.primary,cookieNames.session,cookieNames.grant].includes(cookie.name)).map(cookie=>cookie.attributes.includes('Max-Age=0')),[true,true,true],'logout clears both session cookies and the grant cookie');
  check(await f.count(sql`SELECT count(*) AS n FROM mfa_grants WHERE token_hash=${sha(live.browser.grant)}`),0,'Sign out ends the grant of the browser');
  const after=await f.signIn({startHeaders:{Cookie:`${cookieNames.grant}=${live.browser.grant}`}});
  check(after.authorize.searchParams.get('prompt'),'login','after Sign out the next start forces a new Microsoft sign-in');
 }

 // ---- The MFA grant: forced and silent flows, refusals, switch, role sync ------------------
 {
  f.resetMicrosoft();
  const withGrant=grant=>({startHeaders:{Cookie:`${cookieNames.grant}=${grant}`}});
  const grantRows=()=>f.count(sql`SELECT count(*) AS n FROM mfa_grants`);
  const start=async(path,grant)=>new URL((await m.startApi.GET(f.request(path,{headers:{Cookie:`${cookieNames.grant}=${grant}`}}))).headers.get('location'));
  // A forced flow needs a fresh auth_time: at most 60 s before the start.
  const refusedBefore=(await refusedRows()).length,sessionsBefore=await sessionCount();
  microsoft.claims={auth_time:Math.floor(Date.now()/1000)-120};
  check((await f.signIn()).target,'/#entra=staleSignIn','a forced flow with an old auth_time: staleSignIn');
  check([(await refusedRows()).slice(refusedBefore).map(row=>row.target.split(' ')[0]),await sessionCount()],[['reason=staleSignIn'],sessionsBefore],'audited, no session');
  microsoft.claims={auth_time:undefined};
  check((await f.signIn()).target,'/#entra=staleSignIn','a forced flow without auth_time: staleSignIn');
  microsoft.claims={};
  const forced=await f.signIn(),grant=forced.browser.grant;
  check([forced.target,typeof grant],['/','string'],'a fresh forced flow: a session and a grant cookie');
  // A start with the live grant sends no prompt and keeps the grant hash on the flow.
  let flowHash=null;
  const silent=await f.signIn({...withGrant(grant),before:async()=>{flowHash=(await d.one(sql`SELECT grant_hash FROM entra_sign_in_flows`))?.grant_hash??null;}});
  check([silent.authorize.searchParams.get('prompt'),flowHash],[null,sha(grant)],'with a live grant: no prompt, the flow row holds the grant hash');
  check([silent.target,silent.browser.grant,!!await f.viewerOf(silent.browser)],['/',undefined,true],'the silent callback: a session, no new grant cookie');
  // fresh=1 and the switch on force the prompt and ignore the grant.
  const fresh=await start('/api/auth/entra/start?fresh=1',grant);
  check(fresh.searchParams.get('prompt'),'login','fresh=1 forces prompt=login');
  await d.exec(sql`INSERT INTO identity_settings(key,value) VALUES('session_idle_requires_mfa','1')`);
  check((await start('/api/auth/entra/start',grant)).searchParams.get('prompt'),'login','with the switch on: prompt=login');
  const onForced=await f.signIn();
  check([onForced.target,onForced.browser.grant],['/',undefined],'with the switch on a forced sign-in creates no grant');
  await d.exec(sql`DELETE FROM identity_settings WHERE key='session_idle_requires_mfa'`);
  await d.exec(sql`DELETE FROM entra_sign_in_flows`);
  // The silent flow creates no grant and caps the session at 24 hours after the MFA of the grant.
  const created=Date.now()-20*60*60_000;
  await d.exec(sql`UPDATE mfa_grants SET created_at=${created},expires_at=${Date.now()+60*60_000} WHERE token_hash=${sha(grant)}`);
  const rowsBefore=await grantRows(),capped=await f.signIn(withGrant(grant));
  const cappedSession=await d.one(sql`SELECT expires_at,idle_expires_at FROM mfa_sessions WHERE token_hash=${sha(capped.browser.session)}`);
  check([capped.target,await grantRows(),Number(cappedSession.expires_at)],['/',rowsBefore,created+86_400_000],'through a grant: no new grant, the MFA session ends 24 hours after the MFA of the grant');
  // Refusals of a grant flow: no session, the page starts again with ?fresh=1.
  const refused=async(label,{before,claims={}}={})=>{
   const sessions=await sessionCount();microsoft.claims=claims;
   const result=await f.signIn({...withGrant(grant),before});
   check([result.target,await sessionCount(),result.browser.primary],['/api/auth/entra/start?fresh=1',sessions,undefined],label);
   microsoft.claims={};
  };
  await refused('the grant expired after the start',{before:()=>d.exec(sql`UPDATE mfa_grants SET expires_at=${Date.now()-1} WHERE token_hash=${sha(grant)}`)});
  await d.exec(sql`UPDATE mfa_grants SET expires_at=${Date.now()+60*60_000} WHERE token_hash=${sha(grant)}`);
  await refused('the switch went on after the start',{before:()=>d.exec(sql`INSERT INTO identity_settings(key,value) VALUES('session_idle_requires_mfa','1')`)});
  await d.exec(sql`DELETE FROM identity_settings WHERE key='session_idle_requires_mfa'`);
  await refused('the grant of another account',{claims:{oid:'abababab-0000-4000-8000-000000000001'}});
  const saved=await d.one(sql`SELECT * FROM mfa_grants WHERE token_hash=${sha(grant)}`);
  await refused('the grant was deleted after the start',{before:()=>d.exec(sql`DELETE FROM mfa_grants WHERE token_hash=${sha(grant)}`)});
  await d.exec(sql`INSERT INTO mfa_grants(token_hash,principal,user_id,created_at,expires_at) VALUES(${saved.token_hash},${saved.principal},${saved.user_id},${Date.now()},${Date.now()+60*60_000})`);
  // amr without mfa is refused for both kinds of flow.
  microsoft.accessClaims={amr:['pwd']};
  check([(await f.signIn()).target,(await f.signIn(withGrant(grant))).target],['/#entra=mfaMissing&amp;amr=pwd','/#entra=mfaMissing&amp;amr=pwd'],'amr without mfa: refused for a forced and a grant flow');
  microsoft.accessClaims={};
  // A role sync that adds an assignment rolls the grant sign-in back and ends the grant.
  const group='cdcdcdcd-0000-4000-8000-000000000001',assignments=()=>f.count(sql`SELECT count(*) AS n FROM role_assignments WHERE principal_type='user' AND principal_id=${userId}`);
  await d.exec(sql`INSERT INTO entra_group_roles(id,group_object_id,group_name,role_id,scope_type,scope_id,created_at,created_by) VALUES('mapping-grant',${group},'Admins','builtin-owner','global','*',0,'fixture')`);
  const before={assignments:await assignments(),sessions:await sessionCount()};
  microsoft.claims={groups:[group]};
  const raised=await f.signIn(withGrant(grant));
  check([raised.target,await assignments(),await sessionCount(),await f.count(sql`SELECT count(*) AS n FROM mfa_grants WHERE token_hash=${sha(grant)}`)],['/api/auth/entra/start?fresh=1',before.assignments,before.sessions,0],'a role sync that adds an assignment: rolled back, the grant ends, a new forced start');
  const forcedRaise=await f.signIn();
  check([forcedRaise.target,await assignments()],['/',before.assignments+1],'the forced sign-in that follows adds the assignment');
  microsoft.claims={};
  await d.exec(sql`DELETE FROM role_assignments WHERE principal_type='user' AND principal_id=${userId} AND source='entra'`);
  await d.exec(sql`DELETE FROM entra_group_roles WHERE id='mapping-grant'`);
  f.resetMicrosoft();
 }

 // ---- A built-in login of the Entra account fails like a wrong password -------------------
 {
  const login=await f.answer(await m.authApi.POST(f.request('/api/auth',{payload:{action:'login',username:`entra.${oid}`,password:'whatever-long-password'}})));
  check([login.status,login.body.code],[401,'INVALID_CREDENTIALS'],'built-in login of an Entra account: invalidCredentials');
 }
 console.log(`PASS entra sign-in (${checks} checks): start, PKCE, flow cookie and hashes, account and bound session pair, refusals with audit, keys, certificate assertion, idle end and logout, the MFA grant (forced and silent flows, staleSignIn, fresh=1, switch, cap, refusals, role sync).`);
}finally{await d.close();}
