// "Confirm with Microsoft" (lib/server/identity/entra/confirm.ts): the step-up of
// accounts from Microsoft Entra ID through a fresh Microsoft sign-in. The begin
// with its flow row, cookie, authorize URL, cap and rate limit; the callback of a
// confirm flow with every refusal and its audit row; the claim with the new MFA
// session bound to the same primary session and the proof, and no MFA grant; the
// refusal after the idle end (the account signs in again instead); the proof at the terminal, the assistant PowerShell job, IAM and the
// session settings; and the MFA anchors of terminal, RDP, runbook and job guards
// without mfa_accounts. Real lib/server/identity/entra/*, lib/server/identity/mfa.ts, lib/server/identity/local-auth.ts and the
// routes on an isolated PostgreSQL database, with a fake Microsoft
// (tests/support/entra-fixture.mjs).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {entraFixture,origin,tenant,clientId,sha,signInScope,timeOffsetPattern} from '../support/entra-fixture.mjs';
import {cookieNames,setCookies} from '../support/session-cookies.mjs';
import {insertRow} from '../support/source-database.mjs';
import {sql} from '../../runtime/database.mjs';

const logs=[],leases=[];
const v3={modern:device=>JSON.parse(device.snapshot||'{}'),snapshot:device=>JSON.parse(device.snapshot||'{}'),maintenanceBusy:async()=>false,pendingWork:async()=>false,pendingTransfers:async()=>false,lease:async(...args)=>{leases.push(args);},releaseLease:async()=>{}};
// requireIdentity runs only after the fixture exists, so it may read f.
const f=await entraFixture({
 server:{requireIdentity:async()=>{if(!f.viewer)throw new Error('no viewer');return f.viewer;},log:async(...entry)=>{logs.push(entry);}},
 imports:{'../agent/agent-protocol':v3,'@/lib/server/agent/agent-protocol':v3,'../../rdp-feature':{REMOTE_DESKTOP_AVAILABLE:true},'../agent/agent-crypto':{sealAgentSecrets:async()=>({})}},
});
const {d,m,microsoft}=f;
let checks=0;
const check=(value,expected,label)=>{assert.deepEqual(value,expected,label);checks++;};
const {translate}=f.load('lib/i18n/translate.ts'),t=key=>translate('en',key);
const uuid=()=>crypto.randomUUID();
const oidA='a1a1a1a1-0000-4000-8000-0000000000a1',oidB='b2b2b2b2-0000-4000-8000-0000000000b2',otherTenant='22222222-3333-4444-8555-666666666666';
const flows=()=>d.query(sql`SELECT * FROM entra_sign_in_flows WHERE purpose='confirm'`);
const refusedRows=()=>f.auditRows('auth.entra.confirm.refused');
const mfaPost=(browser,payload,headers={})=>m.mfaApi.POST(f.request('/api/mfa',{browser,payload,headers}));
try{
 await f.configure();
 // Two Entra accounts and a built-in Owner. Account A is an Owner too.
 const signInAs=async(oid,claims={})=>{f.resetMicrosoft();microsoft.claims={oid,...claims};const result=await f.signIn();const viewer=await f.viewerOf(result.browser);f.setViewer(viewer);return {browser:result.browser,viewer};};
 let a=await signInAs(oidA);
 const userA=a.viewer.userId,principalA=a.viewer.principal;
 await d.exec(sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(${uuid()},'user',${userA},'builtin-owner','global','*',0,'fixture')`);
 a={browser:a.browser,viewer:await f.viewerOf(a.browser)};f.setViewer(a.viewer);
 const b=await signInAs(oidB,{email:undefined,preferred_username:'not-an-email'});
 f.setViewer(a.viewer);microsoft.claims={oid:oidA};
 const owner=await f.localAccount('owner@step-up.test');
 /** A confirmation of account A's browser; `before` changes the token or the state before the callback. */
 const confirmA=async(options={})=>{f.setViewer(await f.viewerOf(a.browser));microsoft.claims={oid:oidA,...options.claims};const result=await f.confirm(a.browser,options);return result;};

 // ---- The fake Microsoft models max_age ----------------------------------------------------
 {
  // Seen on a real tenant: max_age=<n> gives exp = auth_time + n and iat = nbf = exp - 300.
  microsoft.maxAge=0;
  const aged=microsoft.idClaims();
  check([aged.exp===aged.auth_time,aged.iat,aged.nbf],[true,aged.exp-300,aged.exp-300],'fake Microsoft with max_age=0: exp at auth_time, iat and nbf 300 s before');
  microsoft.claims={oid:oidA,exp:aged.auth_time+60};
  check(microsoft.idClaims().exp,aged.auth_time+60,'an exp in the claims wins over max_age');
  f.resetMicrosoft();
  const fresh=microsoft.idClaims();
  check([microsoft.maxAge,fresh.exp-fresh.iat],[null,3600],'resetMicrosoft clears max_age: the default lifetime of 3600 s');
  microsoft.claims={oid:oidA};
 }

 // ---- Begin ---------------------------------------------------------------------------------
 {
  const local=await f.localLogin(owner);
  const refused=await f.answer(await mfaPost(local,{action:'entra-begin'}));
  check([refused.status,refused.body.code,refused.body.messageKey],[400,'MFA_ENTRA_ONLY','apiError.mfa.entraOnly'],'begin: a built-in account gets entraOnly');
  const claimLocal=await f.answer(await mfaPost(local,{action:'entra-claim',flow:'a'.repeat(64)}));
  check(claimLocal.body.code,'MFA_ENTRA_ONLY','claim: a built-in account gets entraOnly');
  f.setViewer(a.viewer);
  await d.exec(sql`UPDATE entra_settings SET enabled=0`);
  const off=await f.answer(await mfaPost(a.browser,{action:'entra-begin'}));
  check([off.status,off.body.code,off.body.messageKey],[409,'ENTRA_CONFIRM_NOT_CONFIGURED','apiError.entra.confirm.notConfigured'],'begin while sign-in is off: notConfigured');
  await d.exec(sql`UPDATE entra_settings SET enabled=1`);

  // After the idle end the bound primary session ended with its MFA session: the begin is refused, the account signs in again.
  f.offset=16*60_000;
  check((await m.mfa.mfaStatus(f.request('/',{browser:a.browser}),a.viewer)).authenticated,false,'idle end: no live MFA session');
  const idleBegin=await f.answer(await mfaPost(a.browser,{action:'entra-begin'}));
  check([idleBegin.status,idleBegin.body.code,idleBegin.body.messageKey,(await flows()).length],[401,'IDENTITY_LOGIN_REQUIRED','apiError.auth.signInAgain',0],'begin after the idle end with the old cookies: signInAgain, no flow');
  f.offset=0;
  const grantsBefore=await f.count(sql`SELECT count(*) AS n FROM mfa_grants WHERE principal=${principalA}`);
  const begin=await f.answer(await mfaPost(a.browser,{action:'entra-begin'}));
  check([begin.status,begin.response.headers.get('cache-control'),Object.keys(begin.body).sort()],[200,'no-store',['expiresAt','flow','url']],'begin of a live session: 200, no-store, {flow,url,expiresAt}');
  const cookie=begin.response.headers.getSetCookie().find(value=>value.startsWith('__Host-serverdesk-entra-confirm='));
  const browserToken=cookie.split(';')[0].split('=')[1];
  check(cookie,`__Host-serverdesk-entra-confirm=${browserToken}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`,'the confirm cookie');
  const url=new URL(begin.body.url),q=Object.fromEntries(url.searchParams);
  check(url.origin+url.pathname,`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,'authorize endpoint of the tenant');
  check(Object.keys(q).sort(),['client_id','code_challenge','code_challenge_method','login_hint','nonce','prompt','redirect_uri','response_mode','response_type','scope','state'],'exactly the sign-in parameters plus prompt and login_hint');
  // No max_age: with max_age=0 Entra ID gives an id_token that expires at auth_time.
  check([q.client_id,q.response_type,q.response_mode,q.redirect_uri,q.scope,q.code_challenge_method,q.prompt,q.max_age,q.login_hint],[clientId,'code','query',origin+'/api/auth/entra/callback',signInScope,'S256','login',undefined,'ada@contoso.example'],'authorize parameters of the confirmation: the portal API scope and prompt=login, no max_age');
  const rows=await flows();
  check(rows.length,1,'one confirm flow');
  const row=rows[0],text=JSON.stringify(row);
  check([row.purpose,row.user_id,row.primary_hash,row.claim_hash,Number(row.settings_revision),row.state_hash,row.browser_hash,row.nonce_hash,Number(row.expires_at)-Number(row.created_at),row.confirmed_at,row.outcome],
   ['confirm',userA,sha(a.browser.primary),sha(begin.body.flow),1,sha(q.state),sha(browserToken),sha(q.nonce),600_000,null,null],'flow row: purpose, account, primary session, hashes only, revision, 10 minutes');
  check([text.includes(q.state),text.includes(q.nonce),text.includes(browserToken),text.includes(begin.body.flow)],[false,false,false,false],'no plain state, nonce, browser token or claim handle');
  check(Number(begin.body.expiresAt),Number(row.expires_at),'expiresAt of the reply');
  const second=await f.answer(await mfaPost(a.browser,{action:'entra-begin'}));
  check([(await flows()).length,(await flows())[0].claim_hash],[1,sha(second.body.flow)],'a new begin deletes the open confirm flow of the same session');
  check(await f.count(sql`SELECT count(*) AS n FROM local_auth_sessions WHERE token_hash=${sha(a.browser.primary)}`),1,'the begin changes no session');
  check(await f.count(sql`SELECT count(*) AS n FROM mfa_grants WHERE principal=${principalA}`),grantsBefore,'the begin creates no grant');
  // Without an email no login_hint.
  f.setViewer(b.viewer);
  const noEmail=await f.answer(await mfaPost(b.browser,{action:'entra-begin'}));
  check(new URL(noEmail.body.url).searchParams.has('login_hint'),false,'no login_hint without an email');
  f.setViewer(a.viewer);
  // The cap counts both purposes.
  await d.exec(sql`DELETE FROM entra_sign_in_flows`);
  const at=Date.now();
  await d.exec(sql`INSERT INTO entra_sign_in_flows(state_hash,browser_hash,nonce_hash,code_verifier_enc,created_at,expires_at,attempt_bucket,attempt_window_at) SELECT 'state'||n,'b','n','v',${at},${at+600_000},'bucket',${at} FROM generate_series(1,1000) n`);
  const busy=await f.answer(await mfaPost(a.browser,{action:'entra-begin'}));
  check([busy.status,busy.body.code,busy.body.messageKey],[429,'ENTRA_BUSY','apiError.entra.busy'],'1000 open flows of any purpose: busy');
  const signInBusy=await m.startApi.GET(f.request('/api/auth/entra/start'));
  check(signInBusy.headers.get('location'),'/#entra=busy','the sign-in start counts the same rows');
  await d.exec(sql`DELETE FROM entra_sign_in_flows`);
  // The address bucket of the limiter entra.
  await d.exec(sql`DELETE FROM local_auth_attempts`);
  const headers={'X-ServerDesk-Client-IP':'203.0.113.7'},bucket=sha('ip:203.0.113.7');
  await mfaPost(a.browser,{action:'entra-begin'},headers);
  check(Number((await d.one(sql`SELECT attempts FROM local_auth_attempts WHERE bucket=${bucket}`)).attempts),1,'a begin counts one attempt in the address bucket');
  await d.exec(sql`UPDATE local_auth_attempts SET attempts=41 WHERE bucket=${bucket}`);
  const limited=await f.answer(await mfaPost(a.browser,{action:'entra-begin'},headers));
  check([limited.status,limited.body.code],[429,'AUTH_RATE_LIMITED'],'over the address limit: rateLimited');
  await d.exec(sql`DELETE FROM local_auth_attempts`);
  await d.exec(sql`DELETE FROM entra_sign_in_flows`);
 }

 // ---- Callback and claim: success --------------------------------------------------------------
 {
  f.resetMicrosoft();
  const headers={'X-ServerDesk-Client-IP':'203.0.113.8'},bucket=sha('ip:203.0.113.8');
  const oldPrimary=await d.one(sql`SELECT * FROM local_auth_sessions WHERE token_hash=${sha(a.browser.primary)}`);
  const pending=await confirmA({claim:false,headers});
  check([pending.response.status,pending.response.headers.get('location'),pending.response.headers.get('cache-control'),pending.response.headers.get('referrer-policy')],[200,null,'no-store','no-referrer'],'callback: a 200 page with no-store and no-referrer');
  check([pending.html.includes('http-equiv="refresh"'),pending.html.includes('<script'),pending.html.includes(t('entra.confirm.doneTitle')),pending.html.includes(t('entra.confirm.doneText'))],[false,false,true,true],'success page: no refresh, no script, done title and text');
  check(setCookies(pending.response).map(cookie=>cookie.raw),['__Host-serverdesk-entra-confirm=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0'],'the callback sets no session cookie and clears the confirm cookie');
  const redemption=microsoft.calls.find(call=>call.url.endsWith('/oauth2/v2.0/token')),form=Object.fromEntries(new URLSearchParams(redemption.body));
  check([form.grant_type,form.code,form.redirect_uri,crypto.createHash('sha256').update(form.code_verifier).digest('base64url'),form.scope],['authorization_code','confirm-code',origin+'/api/auth/entra/callback',pending.authorize.searchParams.get('code_challenge'),signInScope],'the code is redeemed with the PKCE verifier of the S256 challenge and the portal API scope');
  check(microsoft.idClaims().amr,undefined,'confirmed with an id_token without amr: the MFA signal is the access token amr');
  const confirmedClaims=microsoft.idClaims();
  check([pending.authorize.searchParams.has('max_age'),confirmedClaims.exp-confirmedClaims.auth_time],[false,3600],'no max_age in the confirmation: the id_token lives 3600 s after auth_time');
  check((await refusedRows()).length,0,'a successful confirmation writes no refused row');
  const row=(await flows())[0];
  check([row.confirmed_at!==null,row.outcome,row.code_verifier_enc],[true,null,''],'callback: confirmed_at set, the verifier used');
  const grantsBeforeClaim=await f.count(sql`SELECT count(*) AS n FROM mfa_grants WHERE principal=${principalA}`);
  const claimPending=await f.answer(await mfaPost(a.browser,{action:'entra-claim',flow:pending.begin.body.flow}));
  check(claimPending.status,200,'a confirmed flow can be claimed');
  const claimed=claimPending;
  check([claimed.body.ok,claimed.body.authenticated,typeof claimed.body.managementToken,typeof claimed.body.verifiedUntil,'rememberedUntil' in claimed.body],[true,true,'string','number',false],'claim: the verify reply with a managementToken');
  check(claimed.body.managementExpiresAt-Date.now()<=300_000&&claimed.body.managementExpiresAt>Date.now(),true,'the proof is valid 5 minutes');
  const cookies=setCookies(claimed.response);
  check([cookies.some(cookie=>cookie.name===cookieNames.primary&&cookie.value),cookies.some(cookie=>cookie.name===cookieNames.session&&cookie.value),cookies.find(cookie=>cookie.name==='__Host-serverdesk-entra-confirm')?.raw],[true,true,'__Host-serverdesk-entra-confirm=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0'],'claim: new session cookies, the confirm cookie cleared');
  const browser={...a.browser,primary:cookies.find(cookie=>cookie.name===cookieNames.primary).value,session:cookies.find(cookie=>cookie.name===cookieNames.session).value};
  const newPrimary=await d.one(sql`SELECT * FROM local_auth_sessions WHERE token_hash=${sha(browser.primary)}`);
  check([newPrimary.user_id,newPrimary.mfa_hash,Number(newPrimary.created_at),Number(newPrimary.expires_at)],[userA,sha(browser.session),Number(oldPrimary.created_at),Number(oldPrimary.expires_at)],'the copied primary session: same account, created and expiry, new mfa_hash');
  check([await f.count(sql`SELECT count(*) AS n FROM local_auth_sessions WHERE token_hash=${sha(a.browser.primary)}`),await f.count(sql`SELECT count(*) AS n FROM mfa_sessions WHERE token_hash=${sha(a.browser.session)}`)],[0,0],'the old primary row and the old MFA session are gone');
  const session=await d.one(sql`SELECT * FROM mfa_sessions WHERE token_hash=${sha(browser.session)}`);
  check([session.principal,session.passkey_id,Number(session.expires_at)-Number(session.created_at),Number(session.idle_expires_at)-Number(session.created_at)],[principalA,null,86_400_000,15*60_000],'new MFA session: absolute 24 h, idle timeout, no passkey');
  check(await f.count(sql`SELECT count(*) AS n FROM mfa_management_proofs WHERE token_hash=${sha(claimed.body.managementToken)} AND session_hash=${sha(browser.session)}`),1,'the proof row belongs to the new session');
  check([await f.count(sql`SELECT count(*) AS n FROM entra_sign_in_flows`),await f.count(sql`SELECT count(*) AS n FROM mfa_accounts WHERE principal=${principalA}`)],[0,0],'the flow is deleted; no mfa_accounts row');
  check([cookies.some(cookie=>cookie.name===cookieNames.grant&&cookie.value),await f.count(sql`SELECT count(*) AS n FROM mfa_grants WHERE principal=${principalA}`)],[false,grantsBeforeClaim],'a step-up creates no MFA grant and sets no grant cookie');
  check(Number((await d.one(sql`SELECT attempts FROM local_auth_attempts WHERE bucket=${bucket}`)).attempts),0,'the attempt of the begin is given back');
  check((await f.auditRows('auth.entra.confirm')).map(row=>[row.actor,row.target]),[[a.viewer.label,userA]],'one auth.entra.confirm row: actor the account, target the user ID');
  const again=await f.answer(await mfaPost(browser,{action:'entra-claim',flow:pending.begin.body.flow}));
  check([again.status,again.body.code,again.body.messageKey],[409,'ENTRA_CONFIRM_EXPIRED','apiError.entra.confirm.expired'],'a second claim: expired');
  a={browser,viewer:await f.viewerOf(browser)};f.setViewer(a.viewer);
  const replay=await m.callbackApi.GET(f.request('/api/auth/entra/callback?'+pending.query,{cookie:`__Host-serverdesk-entra-confirm=${pending.token}`}));
  check((await replay.text()).includes('url=/#entra=expired'),true,'a callback for a finished flow: expired');
 }

 // ---- Claim: pending, foreign session, foreign account -------------------------------------------
 {
  f.resetMicrosoft();
  const begun=await confirmA({claim:false,before:async()=>{}}).then(async result=>result);
  // Take the result back to pending to test the claim before the callback.
  await d.exec(sql`UPDATE entra_sign_in_flows SET confirmed_at=NULL`);
  const pending=await f.answer(await mfaPost(a.browser,{action:'entra-claim',flow:begun.begin.body.flow}));
  check([pending.status,pending.body],[200,{pending:true}],'claim before the result: pending');
  check((await flows()).length,1,'pending changes nothing');
  await d.exec(sql`UPDATE entra_sign_in_flows SET confirmed_at=${Date.now()}`);
  // Another session of the same account and another account cannot claim it.
  microsoft.claims={oid:oidA};const other=await f.signIn();f.setViewer(await f.viewerOf(other.browser));
  const foreignSession=await f.answer(await mfaPost(other.browser,{action:'entra-claim',flow:begun.begin.body.flow}));
  check(foreignSession.body.code,'ENTRA_CONFIRM_EXPIRED','claim from another primary session of the same account: expired');
  f.setViewer(b.viewer);
  const foreignAccount=await f.answer(await mfaPost(b.browser,{action:'entra-claim',flow:begun.begin.body.flow}));
  check(foreignAccount.body.code,'ENTRA_CONFIRM_EXPIRED','claim from another account: expired');
  for(const flow of ['short','0'.repeat(64),undefined]){const result=await f.answer(await mfaPost(a.browser,{action:'entra-claim',flow}));f.setViewer(a.viewer);check(result.body.code,'ENTRA_CONFIRM_EXPIRED',`claim of ${String(flow).slice(0,8)}: expired`);}
  f.setViewer(a.viewer);
  check((await flows()).length,1,'a foreign claim leaves the flow');
  f.offset=11*60_000;
  const late=await f.answer(await mfaPost(a.browser,{action:'entra-claim',flow:begun.begin.body.flow}));
  check(late.body.code,'ENTRA_CONFIRM_EXPIRED','claim after 10 minutes: expired');
  f.offset=0;
  await d.exec(sql`DELETE FROM entra_sign_in_flows`);
 }

 // ---- Callback refusals: outcome, audit row, claim -----------------------------------------------------
 {
  // `rejected` is the check=<...> part of a tokenRejected row; `early` means no GUID of the id_token was known yet.
  // `times` are the expected time offsets after a time check (a number or none), in their order: the case then holds the
  // portal clock at a whole second (f.clock) from before the reset until after the claim, so the claims (functions called
  // inside the held window, second()) and the check read the same clock, and the row must equal the target followed by
  // " <name>=<value>" for each time, exactly. `claims` and `accessClaims` may be functions that return the claims.
  const refusal=async(label,{claims={},accessClaims,before,after,callback,expected,rejected,early=false,target,times,audited=true,page})=>{
   if(times)f.clock=Math.floor(Date.now()/1000)*1000;
   try{
    f.resetMicrosoft();
    const idClaims=typeof claims==='function'?claims():claims,access=typeof accessClaims==='function'?accessClaims():accessClaims;
    const sessions=await f.count(sql`SELECT count(*) AS n FROM mfa_sessions`),known=(await refusedRows()).length;
    const result=await confirmA({claim:false,claims:idClaims,before:async context=>{if(access)microsoft.accessClaims=access;await before?.(context);},callback});
    await page?.(result.html);
    check([result.html.includes('eyJ'),result.html.includes('access_as_user'),result.html.includes('MARKER')],[false,false,false],`${label}: no token or Microsoft text in the page`);
    check([result.response.status,result.html.includes(t('entra.confirm.failedTitle')),result.html.includes(t(`entra.error.${expected}`)),result.html.includes(t('entra.confirm.failedText')),result.html.includes('<script'),result.html.includes('http-equiv')],[200,true,true,true,false,false],`${label}: the refusal page of ${expected}`);
    check(setCookies(result.response).map(cookie=>cookie.name),['__Host-serverdesk-entra-confirm'],`${label}: no session cookie`);
    check((await flows()).map(row=>row.outcome),[expected],`${label}: outcome ${expected}`);
    await after?.();
    const rows=(await refusedRows()).slice(known);
    const wanted=(target??`reason=${expected} user=${userA} tenant=${early?'-':tenant} object=${early?'-':idClaims.oid??oidA}${rejected?` check=${rejected}`:''}`)+Object.entries(times??{}).map(([name,value])=>` ${name}=${value}`).join('');
    check(rows.map(row=>[row.actor,row.target]),audited?[['System',wanted]]:[],`${label}: ${audited?'one refused row':'no audit row'}`);
    const claimed=await f.answer(await mfaPost(a.browser,{action:'entra-claim',flow:result.begin.body.flow}));
    check([claimed.body.messageKey,await f.count(sql`SELECT count(*) AS n FROM entra_sign_in_flows`),await f.count(sql`SELECT count(*) AS n FROM mfa_sessions`)],[`apiError.entra.confirm.${expected}`,0,sessions],`${label}: the claim answers the code and deletes the row`);
   }finally{f.clock=null;}
  };
  await refusal('another account',{claims:{oid:'99999999-0000-4000-8000-000000000099'},expected:'wrongAccount'});
  await refusal('another tenant',{claims:{tid:otherTenant,iss:`https://login.microsoftonline.com/${otherTenant}/v2.0`},expected:'wrongTenant',target:`reason=wrongTenant user=${userA} tenant=${otherTenant} object=${oidA}`});
  await refusal('no auth_time',{claims:{auth_time:undefined},expected:'staleSignIn'});
  await refusal('an old auth_time',{claims:{auth_time:Math.floor(Date.now()/1000)-600},expected:'staleSignIn'});
  await refusal('auth_time in the future',{claims:{auth_time:Math.floor(Date.now()/1000)+900},expected:'staleSignIn'});
  await refusal('auth_time as text',{claims:{auth_time:String(Math.floor(Date.now()/1000))},expected:'staleSignIn'});
  // The MFA signal: amr of the access token, with its diagnostic in the row and the page.
  const lines=html=>[...html.matchAll(/<p>([^<]*)<\/p>/g)].map(match=>match[1]);
  const escaped=text=>text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  await refusal('no mfa in the access token amr',{claims:{amr:['mfa']},accessClaims:{amr:['pwd']},expected:'mfaMissing',target:`reason=mfaMissing user=${userA} tenant=${tenant} object=${oidA} amr=pwd`,
   page:html=>check(lines(html),[escaped(t('entra.error.mfaMissing')),escaped(translate('en','entra.error.amrValues',{methods:'pwd'})),escaped(t('entra.confirm.failedText'))],'mfaMissing page: the error, the amr detail line and the failed text, escaped')});
  await refusal('amr absent in the access token',{accessClaims:{amr:undefined},expected:'mfaMissing',target:`reason=mfaMissing user=${userA} tenant=${tenant} object=${oidA} amr=missing`,
   page:html=>check(lines(html)[1],escaped(t('entra.error.amrMissing')),'amr absent: the missing line')});
  await refusal('unknown amr values',{accessClaims:{amr:['pwd','<b>"x"</b>','otp']},expected:'mfaMissing',target:`reason=mfaMissing user=${userA} tenant=${tenant} object=${oidA} amr=pwd,other,otp`,
   page:html=>check([lines(html)[1],html.includes('<b>')],[escaped(translate('en','entra.error.amrValues',{methods:'pwd, other, otp'})),false],'unknown values read as other; no claim text in the page')});
  await refusal('access token ver 2.0',{accessClaims:{ver:'2.0'},expected:'apiSetupMissing',target:`reason=apiSetupMissing user=${userA} tenant=${tenant} object=${oidA} detail=version`,
   page:html=>check(lines(html),[escaped(t('entra.error.apiSetupMissing')),escaped(t('entra.confirm.failedText'))],'apiSetupMissing page: its text and the failed text, no detail line')});
  await refusal('access token without the scope',{accessClaims:{scp:'User.Read'},expected:'apiSetupMissing',target:`reason=apiSetupMissing user=${userA} tenant=${tenant} object=${oidA} detail=scope`});
  await refusal('no access token',{before:()=>{microsoft.dropAccessToken=true;},expected:'apiSetupMissing',target:`reason=apiSetupMissing user=${userA} tenant=- object=- detail=missing`});
  await refusal('callback error invalid_scope',{callback:{query:{error:'invalid_scope',code:undefined}},expected:'apiSetupMissing',target:`reason=apiSetupMissing user=${userA} tenant=- object=- detail=refused`});
  await refusal('access token of another account',{accessClaims:{oid:oidB},expected:'tokenRejected',rejected:'access.identity'});
  await refusal('access token with a nonce header',{accessClaims:{},before:()=>{microsoft.accessHeader={nonce:'graph-nonce'};},expected:'tokenRejected',rejected:'access.format'});
  check(JSON.stringify(await refusedRows()).match(/eyJ|<b>|graph-nonce|access_as_user/g),null,'no token or claim text in a confirm refused row');
  await refusal('bad signature',{before:()=>{microsoft.signWith=crypto.generateKeyPairSync('rsa',{modulusLength:2048}).privateKey;},expected:'tokenRejected',target:`reason=tokenRejected user=${userA} tenant=- object=- check=id.signature`});
  // The failed check of every other tokenRejected, with the OAuth error and the AADSTS numbers where Microsoft refused.
  const answerText={error_description:'AADSTS50076: MARKER-description. Trace ID: MARKER-trace Correlation ID: MARKER-correlation Timestamp: MARKER-time',trace_id:'MARKER-trace',correlation_id:'MARKER-correlation',timestamp:'MARKER-time'};
  const redeemRefused=body=>()=>{microsoft.token=()=>({status:400,body:JSON.stringify({...answerText,...body})});};
  const callbackError=(error,description)=>({query:{error,...(description===undefined?{}:{error_description:description}),code:undefined}});
  await refusal('callback error with an AADSTS number',{callback:callbackError('login_required','AADSTS50058: MARKER-description. Trace ID: MARKER-trace Correlation ID: MARKER-correlation'),expected:'tokenRejected',early:true,rejected:'callback error=login_required aadsts=50058'});
  await refusal('callback error of no list',{callback:callbackError('MARKER-error','AADSTS50058 AADSTS50076 AADSTS50079 AADSTS50158'),expected:'tokenRejected',early:true,rejected:'callback error=other aadsts=50058,50076,50079'});
  await refusal('callback without a code',{callback:{query:{code:undefined}},expected:'tokenRejected',early:true,rejected:'code'});
  await refusal('refused redemption',{before:redeemRefused({error:'invalid_grant',error_codes:[50076,'MARKER-code']}),expected:'tokenRejected',early:true,rejected:'redeem error=invalid_grant aadsts=50076'});
  await refusal('id_token missing in a 200 answer',{before:()=>{microsoft.token=()=>({status:200,body:JSON.stringify({access_token:microsoft.accessToken()})});},expected:'tokenRejected',early:true,rejected:'redeem.idToken'});
  await refusal('nonce mismatch',{before:()=>{microsoft.nonce='other-nonce';},expected:'tokenRejected',rejected:'id.nonce'});
  await refusal('unknown kid',{before:()=>{microsoft.header={kid:'key-unknown'};},expected:'tokenRejected',early:true,rejected:'id.key'});
  // A refused time check names the times as offsets from the portal clock, and start, the start of the flow (0: the held clock
  // does not move between the begin and the callback). Claims are built relative to the held second (the real second otherwise).
  const second=()=>Math.floor((f.clock??Date.now())/1000);
  await refusal('expired id_token',{claims:()=>({exp:second()-10}),expected:'tokenRejected',rejected:'id.expired',times:{exp:-10,iat:0,nbf:0,auth:0,start:0}});
  // What Entra ID answered to max_age=0: an id_token that expires at auth_time. The expiry check stays strict.
  await refusal('id_token that expires at auth_time',{claims:()=>({exp:second(),iat:second()-300,nbf:second()-300}),expected:'tokenRejected',rejected:'id.expired',times:{exp:0,iat:-300,nbf:-300,auth:0,start:0}});
  await refusal('expired id_token without nbf',{claims:()=>({exp:second()-10,nbf:undefined}),expected:'tokenRejected',rejected:'id.expired',times:{exp:-10,iat:0,nbf:'none',auth:0,start:0}});
  await refusal('expired access token',{accessClaims:()=>({exp:second()-10}),expected:'tokenRejected',rejected:'access.expired',times:{exp:-10,iat:0,nbf:0,start:0}});
  await refusal('access token of another app',{accessClaims:{appid:'00000000-0000-4000-8000-000000000000'},expected:'tokenRejected',rejected:'access.appid'});
  await refusal('access token nbf ahead',{accessClaims:()=>({nbf:second()+600}),expected:'tokenRejected',rejected:'access.ahead',times:{exp:3600,iat:0,nbf:600,start:0}});
  // The offsets come from the portal clock read at the callback, not from the real time the person took: a slow callback changes nothing.
  let waited=0;
  await refusal('access token nbf ahead after a slow callback',{accessClaims:()=>({nbf:second()+600}),before:async()=>{const from=Date.now();await new Promise(resolve=>setTimeout(resolve,1600));waited=Date.now()-from;},expected:'tokenRejected',rejected:'access.ahead',times:{exp:3600,iat:0,nbf:600,start:0}});
  check(waited>=1500,true,`the slow callback waited at least 1500 ms of real time (${waited} ms)`);
  await refusal('access token of another issuer',{accessClaims:{iss:`https://login.microsoftonline.com/${tenant}/v2.0`},expected:'tokenRejected',rejected:'access.issuer'});
  // Temporary Microsoft failures and a used or expired code are no rejected token: unavailable and expired, without an audit row.
  await refusal('callback error server_error',{callback:callbackError('server_error','AADSTS90033: MARKER-description'),expected:'unavailable',audited:false});
  await refusal('callback error temporarily_unavailable',{callback:callbackError('temporarily_unavailable'),expected:'unavailable',audited:false});
  await refusal('code already redeemed (54005)',{before:redeemRefused({error:'invalid_grant',error_codes:[54005]}),expected:'expired',audited:false});
  await refusal('code expired (70008)',{before:redeemRefused({error:'invalid_grant',error_codes:[70008]}),expected:'expired',audited:false});
  // Every tokenRejected row of a confirmation ends with a check of the list; only the four time checks add the time offsets, always with start.
  const n=timeOffsetPattern;
  const shape=new RegExp(` check=(?:(?:callback|code|redeem|redeem\\.idToken|id\\.(?:format|key|signature|issuer|audience|nonce|oid|groups)|access\\.(?:format|key|signature|issuer|appid|identity))(?: error=[a-z_]+)?(?: aadsts=\\d{4,7}(?:,\\d{4,7}){0,2})?|id\\.(?:expired|ahead) exp=${n} iat=${n} nbf=${n} auth=${n} start=${n}|access\\.(?:expired|ahead) exp=${n} iat=${n} nbf=${n} start=${n})$`);
  check((await refusedRows()).filter(row=>row.target.startsWith('reason=tokenRejected ')&&!shape.test(row.target)).map(row=>row.target),[],'every confirm tokenRejected row ends with a check of the list');
  const base=`reason=tokenRejected user=${userA} tenant=${tenant} object=${oidA}`;
  check([`${base} check=id.expired exp=-12 iat=-3612 nbf=-3612 auth=-40 start=-55`,`${base} check=access.ahead exp=3600 iat=0 nbf=600 start=0`].filter(target=>!shape.test(target)),[],'the confirm shape accepts the time offsets with start');
  check([`${base} check=id.expired exp=-12 iat=-3612 nbf=-3612 auth=-40`,`${base} check=access.expired exp=1 iat=1 nbf=1`,`${base} check=id.nonce exp=1 iat=1 nbf=1 auth=1 start=1`,`${base} check=redeem exp=1 iat=1 nbf=1 start=1`,`${base} check=id.expired start=-5`].filter(target=>shape.test(target)),[],'the confirm shape needs start after a time check and refuses time offsets after any other check');
  const confirmRows=JSON.stringify(await refusedRows());
  check([confirmRows.includes('AADSTS'),confirmRows.includes('MARKER'),confirmRows.includes('eyJ')],[false,false,false],'no Microsoft text, trace or correlation ID or token part in a confirm refused row');
  // Unlocked again before the claim: a locked account has no primary session to claim with.
  await refusal('locked account',{before:()=>d.exec(sql`UPDATE local_users SET status='disabled' WHERE id=${userA}`),after:()=>d.exec(sql`UPDATE local_users SET status='active' WHERE id=${userA}`),expected:'accountDisabled'});
  await refusal('settings revision bumped',{before:()=>d.exec(sql`UPDATE entra_settings SET revision=revision+1,tested_revision=tested_revision+1`),expected:'notConfigured',audited:false});
  await f.configure();
  await refusal('access_denied',{callback:{query:{error:'access_denied',code:undefined}},expected:'cancelled',audited:false});
  await refusal('network failure at redemption',{before:()=>{microsoft.fail=request=>{if(request.url.endsWith('/token'))throw new Error('socket hang up');return null;};},expected:'unavailable',audited:false});
  check(JSON.stringify(await refusedRows()).includes('Ada'),false,'no claim text beyond the GUIDs in a refused row');
  // A groups overage is ignored by the confirmation.
  f.resetMicrosoft();
  const overage=await confirmA({claims:{_claim_names:{groups:'src1'},_claim_sources:{src1:{endpoint:'https://graph.microsoft.com/v1.0/users/x/getMemberObjects'}}}});
  check([overage.claimed.status,overage.claimed.body.authenticated],[200,true],'a groups overage in a confirm token is ignored');
  a={browser:overage.browser,viewer:await f.viewerOf(overage.browser)};f.setViewer(a.viewer);
  // A foreign or missing confirm cookie answers expired and leaves the flow pending.
  const foreign=await confirmA({claim:false,callback:{cookie:'__Host-serverdesk-entra-confirm='+'0'.repeat(64)}});
  check([foreign.html.includes(t('entra.error.expired')),(await flows()).map(row=>[row.outcome,row.confirmed_at,row.code_verifier_enc!==''])],[true,[[null,null,true]]],'a foreign confirm cookie: expired, the flow untouched');
  const sign=await confirmA({claim:false,callback:{cookie:`__Host-serverdesk-entra=${'1'.repeat(64)}`}});
  check([sign.html.includes(t('entra.error.expired')),(await flows())[0].outcome],[true,null],'the sign-in cookie does not open a confirm flow');
  await d.exec(sql`DELETE FROM entra_sign_in_flows`);
 }

 // ---- No resume after the idle end ---------------------------------------------------------------------
 {
  f.resetMicrosoft();
  f.offset=16*60_000;
  check((await m.mfa.mfaStatus(f.request('/',{browser:a.browser}),a.viewer)).authenticated,false,'after the idle end: unauthenticated');
  const resumed=await confirmA();
  check([resumed.begin.status,resumed.begin.body.code],[401,'IDENTITY_LOGIN_REQUIRED'],'after the idle end the confirmation is refused: the account signs in with Microsoft again');
  f.setViewer(a.viewer);
  const resume=await f.answer(await mfaPost(a.browser,{action:'resume'}));
  check(resume.body.messageKey,'apiError.mfa.unknownAction','resume is an unknown action');
  f.offset=0;
  // The offset clock moved: sign account A in again for the rest.
  a=await signInAs(oidA);
 }

 // ---- The proof at the step-up consumers --------------------------------------------------------------
 const terminalApi=f.load('app/api/terminal/route.ts'),rbacApi=m.rbacApi,sessionSettingsApi=f.load('app/api/session-settings/route.ts');
 const assistantCommands=f.load('lib/server/devices/assistant-commands.ts'),deviceJobs=f.load('lib/server/devices/device-job-queue.ts');
 const snapshot=(extra={})=>JSON.stringify({protocolVersion:3,agentVersion:'4.17.0',mode:'Management',agentCapabilities:['terminal','terminal-multi','assistant-powershell','rdp-browser','restart-service'],...extra});
 const device=async name=>{const id=uuid(),at=Date.now();await insertRow(d,'servers',{id,name,token_hash:'fixture-'+id,created_at:at,last_seen:at,management:1,snapshot:snapshot()});return id;};
 const post=async(api,path,browser,payload)=>{f.setViewer(await f.viewerOf(browser));return f.answer(await api.POST(f.request(path,{browser,payload})));};
 const proof=async()=>{const result=await confirmA();a={browser:result.browser,viewer:await f.viewerOf(result.browser)};f.setViewer(a.viewer);return result.management;};
 const host=await device('SRV-ENTRA');
 {
  const open=managementToken=>({action:'open',serverId:host,confirm:true,cols:100,rows:30,...(managementToken?{managementToken}:{})});
  const without=await post(terminalApi,'/api/terminal',a.browser,open('a'.repeat(64)));
  check([without.status,without.body.code],[403,'MFA_STEP_UP_REQUIRED'],'terminal open without a proof: MFA_STEP_UP_REQUIRED');
  const token=await proof();
  const opened=await post(terminalApi,'/api/terminal',a.browser,open(token));
  check([opened.status,opened.body.state,opened.body.resumed],[200,'opening',false],`terminal open with the proof of a confirmation (${opened.body.error})`);
  check([await f.count(sql`SELECT count(*) AS n FROM terminal_sessions WHERE principal=${principalA} AND mfa_hash=${sha(a.browser.session)}`),await f.count(sql`SELECT count(*) AS n FROM mfa_management_proofs WHERE token_hash=${sha(token)}`)],[1,0],'the terminal row exists and the proof is consumed');
  await d.exec(sql`UPDATE terminal_sessions SET state='closed'`);
  const reused=await post(terminalApi,'/api/terminal',a.browser,open(token));
  check(reused.body.code,'MFA_STEP_UP_REQUIRED','the proof is not reusable');
  // A proof of another session of the same account, and of another account.
  const first=await proof(),firstBrowser=a.browser;
  microsoft.claims={oid:oidA};const second=await f.signIn();
  const crossed=await post(terminalApi,'/api/terminal',second.browser,open(first));
  check(crossed.body.code,'MFA_STEP_UP_REQUIRED','a proof of another session is refused');
  check(await f.count(sql`SELECT count(*) AS n FROM mfa_management_proofs WHERE token_hash=${sha(first)}`),1,'the refused use leaves the proof');
  // A proof of account B used with the session of account A.
  f.setViewer(b.viewer);microsoft.claims={oid:oidB,email:undefined,preferred_username:'not-an-email'};
  const foreign=await f.confirm(b.browser);
  check(foreign.claimed.status,200,'account B confirms with Microsoft');
  microsoft.claims={oid:oidA};
  const otherAccount=await post(terminalApi,'/api/terminal',firstBrowser,open(foreign.management));
  check(otherAccount.body.code,'MFA_STEP_UP_REQUIRED','a proof of another account is refused');
  a={browser:firstBrowser,viewer:await f.viewerOf(firstBrowser)};f.setViewer(a.viewer);
 }
 {
  // The assistant runs a PowerShell script: the step-up job of queueOperationJob.
  const run=managementToken=>assistantCommands.runAssistantCommand(f.request('/api/assistant',{browser:a.browser,payload:{}}),a.viewer,{action:'run',serverId:host,confirm:true,command:{type:'powershell',script:'Get-Service',timeoutSeconds:60},managementToken});
  await assert.rejects(run('a'.repeat(64)),error=>error.code==='MFA_STEP_UP_REQUIRED');checks++;
  const token=await proof();
  const job=await run(token);
  check([await f.count(sql`SELECT count(*) AS n FROM jobs WHERE id=${job.id} AND action='assistant-powershell' AND actor_email=${a.viewer.label}`),await f.count(sql`SELECT count(*) AS n FROM mfa_management_proofs WHERE token_hash=${sha(token)}`)],[1,0],'the assistant PowerShell job row is written and the proof consumed');
  // A job kind that needs MFA (kind.mfa) without a step-up: admitted with the live Entra MFA session.
  const restart=await deviceJobs.queueDeviceOperation(f.request('/api/console',{browser:a.browser,payload:{}}),a.viewer,{serverId:host,kind:'restart-service',params:{name:'Spooler'},confirm:true});
  check(await f.count(sql`SELECT count(*) AS n FROM jobs WHERE id=${restart.id}`),1,'a kind.mfa job is admitted for the live Entra MFA session');
  f.offset=16*60_000;
  await d.exec(sql`UPDATE servers SET last_seen=${Date.now()+f.offset} WHERE id=${host}`);
  await assert.rejects(deviceJobs.queueDeviceOperation(f.request('/api/console',{browser:a.browser,payload:{}}),a.viewer,{serverId:host,kind:'restart-service',params:{name:'Spooler'},confirm:true}),error=>['SESSION_EXPIRED','MFA_LOGIN_REQUIRED'].includes(error.code));checks++;
  f.offset=0;
 }
 {
  const iam=managementToken=>post(rbacApi,'/api/rbac',a.browser,{action:'create-group',name:'Entra confirmed group',description:'',managementToken});
  check((await iam('a'.repeat(64))).body.code,'MFA_STEP_UP_REQUIRED','IAM without a proof: MFA_STEP_UP_REQUIRED');
  const iamToken=await proof();
  const created=await iam(iamToken);
  check([created.status,created.body.ok],[200,true],`IAM create-group with the proof of a confirmation (${created.body.error})`);
  const idle=managementToken=>post(sessionSettingsApi,'/api/session-settings',a.browser,{action:'set-idle-timeout',minutes:30,managementToken});
  check((await idle('a'.repeat(64))).body.code,'MFA_STEP_UP_REQUIRED','set-idle-timeout without a proof: MFA_STEP_UP_REQUIRED');
  const idleToken=await proof();
  const changed=await idle(idleToken);
  check(changed.status,200,`set-idle-timeout with the proof of a confirmation (${changed.body.error})`);
  const restore=await proof();
  const back=await post(sessionSettingsApi,'/api/session-settings',a.browser,{action:'set-idle-timeout',minutes:15,managementToken:restore});
  check(back.status,200,'the idle timeout back to 15 minutes');
 }

 // ---- MFA anchors without mfa_accounts: terminal, RDP, runbooks ------------------------------------------
 {
  const lifecycle=f.load('lib/server/devices/terminal-lifecycle.ts'),rdp=f.load('lib/server/devices/rdp.ts');
  const at=Date.now(),terminalId=uuid(),rdpId=uuid();
  await insertRow(d,'terminal_sessions',{id:terminalId,server_id:host,principal:principalA,mfa_hash:sha(a.browser.session),state:'open',cols:100,rows:30,created_at:at,last_activity:at,expires_at:at+3_600_000});
  await insertRow(d,'rdp_sessions',{id:rdpId,server_id:host,principal:principalA,mfa_hash:sha(a.browser.session),state:'open',key_hash:'k',created_at:at,last_presence:at,expires_at:at+3_600_000,transport:'mailbox'});
  const terminalPasses=time=>d.one(sql`SELECT 1 AS ok FROM terminal_sessions t WHERE t.id=${terminalId} AND ${lifecycle.terminalAccessGuard('t',time)}`).then(Boolean);
  const rdpPasses=time=>d.one(sql`SELECT 1 AS ok FROM rdp_sessions r WHERE r.id=${rdpId} AND ${rdp.rdpWriteGuard('r',time)}`).then(Boolean);
  check([await terminalPasses(Date.now()),await rdpPasses(Date.now())],[true,true],'terminal access and RDP write guards pass for a live Entra MFA session');
  const expiry=Number((await d.one(sql`SELECT idle_expires_at FROM mfa_sessions WHERE token_hash=${sha(a.browser.session)}`)).idle_expires_at);
  // Presence and the device heartbeat stay current, so only the MFA session decides.
  await d.exec(sql`UPDATE rdp_sessions SET last_presence=${expiry+1} WHERE id=${rdpId}`);
  await d.exec(sql`UPDATE servers SET last_seen=${expiry} WHERE id=${host}`);
  check([await terminalPasses(expiry+1),await rdpPasses(expiry+1)],[false,false],'both guards fail after the MFA session expired');
  // The same guards for a local session stay as before.
  const local=await f.localLogin(owner);
  await insertRow(d,'terminal_sessions',{id:uuid(),server_id:host,principal:owner.actor.principal,mfa_hash:sha(local.session),state:'open',cols:100,rows:30,created_at:at,last_activity:at,expires_at:at+3_600_000});
  check(await d.one(sql`SELECT 1 AS ok FROM terminal_sessions t WHERE t.principal=${owner.actor.principal} AND ${lifecycle.terminalAccessGuard('t',Date.now())}`).then(Boolean),true,'a local session still passes with its mfa_accounts row');
  await d.exec(sql`DELETE FROM mfa_accounts WHERE principal=${owner.actor.principal}`);
  check(await d.one(sql`SELECT 1 AS ok FROM terminal_sessions t WHERE t.principal=${owner.actor.principal} AND ${lifecycle.terminalAccessGuard('t',Date.now())}`).then(Boolean),false,'a local session without mfa_accounts fails as before');
  await d.exec(sql`DELETE FROM terminal_sessions`);await d.exec(sql`DELETE FROM rdp_sessions`);
 }
 {
  const runbooks=f.load('lib/server/automation/automation-runbooks.ts'),scopes=f.load('lib/server/automation/automation-scopes.ts');
  const at=Date.now(),book=uuid(),version=uuid(),template=uuid(),assignment=uuid(),group=uuid();
  const definition={parameters:[],steps:[{id:'first',name:'First',kind:'powershell',script:'Write-Output "first"',timeoutSeconds:60,operationParameters:{}}]};
  await d.exec(sql`INSERT INTO device_groups(id,name,description,parent_id,created_at) VALUES(${group},'Entra group','',NULL,${at})`);
  await d.exec(sql`INSERT INTO device_group_members(server_id,group_id) VALUES(${host},${group})`);
  await d.exec(sql`INSERT INTO runbooks(id,name,description,created_at,created_by) VALUES(${book},'Entra book','',${at},${principalA})`);
  await d.exec(sql`INSERT INTO runbook_versions(id,runbook_id,version,definition,created_at,created_by) VALUES(${version},${book},1,${JSON.stringify(definition)},${at},${principalA})`);
  await d.exec(sql`INSERT INTO automation_templates(id,kind,slot,name,payload,created_by,created_at) VALUES(${template},'runbook',${book},'Entra template',${JSON.stringify({versionId:version,parameters:{},recurrence:null,catchupSeconds:3600,concurrency:1,failureStop:true})},${principalA},${at})`);
  await d.exec(sql`INSERT INTO automation_scope_assignments(id,kind,slot,scope_type,scope_id,template_id,disabled,actor,auth_version,created_at) VALUES(${assignment},'runbook',${book},'group',${group},${template},0,${principalA},1,${at})`);
  const viewer=await f.viewerOf(a.browser);
  const started=await runbooks.startAutomationRun(viewer,{assignmentId:assignment,confirm:true,requestId:uuid()});
  check([typeof started.id,started.targets,started.deduplicated],['string',1,false],'startAutomationRun and createCampaign admit an Entra account');
  check(await f.count(sql`SELECT count(*) AS n FROM runbook_runs WHERE id=${started.id} AND actor=${principalA}`),1,'the runbook run row of the Entra actor');
  check(await d.one(sql`SELECT 1 AS ok WHERE ${await runbooks.scopedRunbookGuard(started.id,host)}`).then(Boolean),true,'scopedRunbookGuard accepts the Entra executor');
  const [effective]=await scopes.effectiveAutomationForDevice(host,'runbook');
  check([effective.actor,(await scopes.automationAssignmentActor(effective,host))?.principal],[principalA,principalA],'automationAssignmentActor accepts an Entra assignment actor');
  check(await d.one(sql`SELECT 1 AS ok WHERE ${scopes.effectiveAutomationGuard(effective,host)}`).then(Boolean),true,'effectiveAutomationGuard accepts an Entra assignment actor');
  // An Entra account created after the assignment is no valid approval.
  check(await d.one(sql`SELECT 1 AS ok WHERE ${m.access.mfaEnrollmentSql(sql`${principalA}`,0)}`).then(Boolean),false,'mfaEnrollmentSql: the account did not exist yet');
  await d.exec(sql`UPDATE local_users SET status='disabled' WHERE id=${userA}`);
  check([await scopes.automationAssignmentActor(effective,host),await d.one(sql`SELECT 1 AS ok WHERE ${scopes.effectiveAutomationGuard(effective,host)}`).then(Boolean),await d.one(sql`SELECT 1 AS ok WHERE ${await runbooks.scopedRunbookGuard(started.id,host)}`).then(Boolean)],[null,false,false],'a locked Entra account is no valid approval');
  await d.exec(sql`UPDATE local_users SET status='active' WHERE id=${userA}`);
 }
 console.log(`PASS entra step-up (${checks} checks): begin, confirm callback with refusals and audit, claim with the bound MFA session and proof, refusal after the idle end, proofs at terminal, assistant, IAM and session settings, MFA anchors of terminal, RDP, runbooks and jobs.`);
}finally{await d.close();}
