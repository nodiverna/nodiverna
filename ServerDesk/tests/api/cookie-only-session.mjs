// Session tokens travel only in HttpOnly cookies. A source scan
// keeps the header transport, the -embedded cookies and the partitioned
// SameSite=None cookies out of app/, lib/, components/ and scripts/. Route-level
// scenes run the real /api/auth, /api/mfa and /api/passkeys routes with
// lib/server/identity/local-auth.ts and lib/server/identity/mfa.ts on an isolated PostgreSQL test database.
import {HttpError as realHttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {sourceDatabase,sourceLoader,sourceActor,inTransaction} from '../support/source-database.mjs';
import {browserAfter,cookieNames,sessionHeaders,setCookies} from '../support/session-cookies.mjs';
import {sql} from '../../runtime/database.mjs';

let checks=0;
const check=(value,expected,label)=>{assert.deepEqual(value,expected,label);checks++;};

// ---- source scan ---------------------------------------------------------------
{
 const files=[];
 const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory()){if(entry.name!=='node_modules')walk(full);}else if(/\.(?:ts|tsx|mjs|js|cjs)$/.test(entry.name))files.push(full);}};
 for(const dir of ['app','ui','lib','scripts'])if(fs.existsSync(dir))walk(dir);
 check(files.length>50,true,'the scan sees the source tree');
 const header=/X-ServerDesk-(?:Session|Mfa|Embedded)/i,embeddedCookie=/serverdesk-[a-z-]*-embedded|['"`]-embedded['"`]/i,partitioned=/SameSite=None|Partitioned/i;
 // ui/base/http.ts names the former headers once, only to delete caller copies.
 const stripList="const strippedHeaders=['X-ServerDesk-Session','X-ServerDesk-Mfa','X-ServerDesk-Embedded'];";
 const http=fs.readFileSync('ui/base/http.ts','utf8');
 check(http.includes(stripList)&&/for\(const name of strippedHeaders\)headers\.delete\(name\);/.test(http),true,'ui/base/http.ts strips the former headers');
 const offenders=[];
 for(const file of files){
  let source=fs.readFileSync(file,'utf8');if(file.replaceAll('\\','/').endsWith('ui/base/http.ts'))source=source.replace(stripList,'');
  for(const [name,pattern] of [['credential header',header],['-embedded cookie',embeddedCookie],['SameSite=None or Partitioned',partitioned]])if(pattern.test(source))offenders.push(`${file}: ${name}`);
 }
 check(offenders,[],'no code reads or sets the former headers, names an -embedded cookie or builds a partitioned cookie');
 for(const file of ['lib/server/identity/mfa.ts','lib/server/identity/local-auth.ts','app/api/auth/route.ts'])check(/request\.headers\.get\('X-ServerDesk-(?!Client-IP')/i.test(fs.readFileSync(file,'utf8')),false,file+' reads no credential header (X-ServerDesk-Client-IP is the client address from the proxy)');
}

const d=await sourceDatabase();
try{
 const origin='https://cookies.test',time=Date.now();
 const HttpError=realHttpError;
 const token=()=>crypto.randomBytes(32).toString('hex'),sha=value=>crypto.createHash('sha256').update(value).digest('hex');
 let localAuth=null;
 const server={
  db:()=>d,config:key=>key==='SESSION_SECRET'?'s'.repeat(64):key==='SITE_ORIGIN'?origin:'',now:()=>Date.now(),random:token,hash:async value=>sha(value),HttpError,
  guid:x=>typeof x==='string'&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(x),body:request=>request.json(),sameOrigin:()=>{},
  // As lib/server/context.ts: the identity comes from the primary session of the request.
  requireAuthIdentity:async request=>{const v=await localAuth.localIdentity(request);if(!v)throw new HttpError(401,'Bitte mit Benutzername und Passwort anmelden.','IDENTITY_LOGIN_REQUIRED');return v;},
  requireViewer:async()=>{throw new Error('not used');},
  log:async()=>{throw new Error('log() must not be used');},
  failure:e=>Response.json({error:e instanceof HttpError?e.message:'Datenspeicher oder Dienst momentan nicht erreichbar.',...(e instanceof HttpError&&e.code?{code:e.code}:{})},{status:e instanceof HttpError?e.status:503}),
 };
 const passwords={verifyPassword:async(password,record)=>typeof password==='string'&&password===record,dummyPasswordRecord:async()=>'\0never-matches',hashPassword:async value=>value,validatePassword:value=>value};
 const webauthn={
  generateRegistrationOptions:async()=>({}),verifyRegistrationResponse:async()=>({verified:false}),generateAuthenticationOptions:async()=>({}),
  verifyAuthenticationResponse:async({credential})=>({verified:true,authenticationInfo:{newCounter:credential.counter+1,credentialBackedUp:false}}),
 };
 const load=sourceLoader(),imports={'../context':server,'./context':server,'../../context':server,'@/lib/server/context':server,'./passwords':passwords,'@/lib/server/identity/passwords':passwords,'@simplewebauthn/server':webauthn};
 localAuth=load('lib/server/identity/local-auth.ts',imports);
 const mfa=load('lib/server/identity/mfa.ts',imports),authApi=load('app/api/auth/route.ts',imports),mfaApi=load('app/api/mfa/route.ts',imports),passkeyApi=load('app/api/passkeys/route.ts',imports);

 const one=statement=>d.one(statement);
 const count=async(sql,...bindings)=>Number((await one(sql,...bindings)).n);
 async function account(name){
  const {actor}=await sourceActor(d,name+'@cookies.test',['*']);actor.userId=actor.id;
  const password=name+'-correct-password',codes=Array.from({length:20},()=>crypto.randomBytes(16).toString('hex').toUpperCase());
  await d.exec(sql`UPDATE local_users SET username=${name},password_hash=${password},must_reset=0 WHERE id=${actor.id}`);
  await d.exec(sql`INSERT INTO mfa_accounts(principal,secret_enc,recovery_hashes,last_counter,created_at,authenticators_migrated) VALUES(${actor.principal},'migrated:authenticator-managed',${JSON.stringify(codes.map(code=>sha(actor.principal+'\0'+code)))},-1,${time},1)`);
  return {actor,name,password,codes};
 }
 const request=(pathname,headers,payload)=>new Request(origin+pathname,{method:payload?'POST':'GET',headers:{'Content-Type':'application/json',Origin:origin,...headers},...(payload?{body:JSON.stringify(payload)}:{})});
 const answer=async response=>{const raw=await response.text();return {status:response.status,raw,body:JSON.parse(raw),response};};
 // No body names a token field or carries the value of a Set-Cookie of its own response.
 const leaksNothing=(result,label)=>{
  check(['proofToken','identityToken'].filter(field=>field in result.body),[],label+': no token field in the body');
  const values=setCookies(result.response).map(cookie=>cookie.value).filter(Boolean);
  check(values.length>0,true,label+': the response sets cookies');
  check(values.filter(value=>result.raw.includes(value)),[],label+': no Set-Cookie value appears in the body');
 };
 const strict=(result,label)=>{for(const cookie of setCookies(result.response).filter(cookie=>Object.values(cookieNames).includes(cookie.name)&&cookie.name!==cookieNames.passkey)){
  check([cookie.attributes.includes('Path=/'),cookie.attributes.includes('Secure'),cookie.attributes.includes('HttpOnly'),cookie.attributes.includes('SameSite=Strict'),cookie.attributes.some(a=>/^Max-Age=\d+$/.test(a))],[true,true,true,true,true],`${label}: ${cookie.name} is Path=/; Secure; HttpOnly; SameSite=Strict with Max-Age`);
  check(/SameSite=None|Partitioned/i.test(cookie.raw),false,`${label}: ${cookie.name} is never SameSite=None or Partitioned`);
 }};
 // As lib/server/context.ts requireViewer: identity, MFA session and the binding of both.
 const dataApi=async headers=>{const r=request('/api/console',headers);try{const v=await server.requireAuthIdentity(r);await mfa.requireMfa(r,v);await localAuth.requireBoundLocalMfa(r,v);return {status:200};}catch(error){if(!(error instanceof HttpError))throw error;return {status:error.status,code:error.code};}};

 const owner=await account('owner');
 // ---- /api/auth login ----------------------------------------------------------------
 const login=await answer(await authApi.POST(request('/api/auth',{'X-ServerDesk-Embedded':'1'},{action:'login',username:owner.name,password:owner.password})));
 check([login.status,login.body.ok,login.body.viewer?.id],[200,true,owner.actor.id],'login succeeds and returns the viewer');
 leaksNothing(login,'login');strict(login,'login with X-ServerDesk-Embedded: 1');
 check(setCookies(login.response).map(cookie=>cookie.name).sort(),[cookieNames.primary,cookieNames.session].sort(),'login sets the primary cookie and clears the MFA cookie, no -embedded names');
 let browser=browserAfter(login.response);
 check(typeof browser.primary,'string','the primary token comes only from Set-Cookie');

 // ---- /api/mfa verify and GET --------------------------------------------------------
 const verify=await answer(await mfaApi.POST(request('/api/mfa',{...sessionHeaders(browser),'X-ServerDesk-Embedded':'1'},{action:'verify',recoveryCode:owner.codes.shift()})));
 check(verify.status,200,'verify succeeds: '+verify.body.error);
 leaksNothing(verify,'verify');strict(verify,'verify with X-ServerDesk-Embedded: 1');
 check(setCookies(verify.response).some(cookie=>cookie.name===cookieNames.session&&cookie.value),true,'X-ServerDesk-Embedded: 1 still yields __Host-serverdesk-mfa');
 check(typeof verify.body.managementToken==='string'&&typeof verify.body.managementExpiresAt==='number',true,'the managementToken and its expiry stay in the body');
 browser=browserAfter(verify.response,browser);
 const status=await answer(await mfaApi.GET(request('/api/mfa',sessionHeaders(browser))));
 check([status.body.authenticated,'proofToken' in status.body,'identityToken' in status.body],[true,false,false],'GET /api/mfa: authenticated, no token fields');
 check([browser.primary,browser.session].filter(value=>status.raw.includes(value)),[],'GET /api/mfa: no token value in the body');
 const activity=await answer(await mfaApi.POST(request('/api/mfa',sessionHeaders(browser),{action:'activity'})));
 check([activity.status,'proofToken' in activity.body,'identityToken' in activity.body,[browser.primary,browser.session].some(value=>activity.raw.includes(value))],[200,false,false,false],'activity: no token in the body');

 // ---- headers never authenticate ------------------------------------------------------
 check(await dataApi(sessionHeaders(browser)),{status:200},'cookies authenticate the data API');
 const headerOnly={'X-ServerDesk-Session':browser.primary,'X-ServerDesk-Mfa':browser.session};
 check(await dataApi(headerOnly),{status:401,code:'IDENTITY_LOGIN_REQUIRED'},'header-only tokens count as no token');
 check(await dataApi({...sessionHeaders({primary:browser.primary}),'X-ServerDesk-Mfa':browser.session}),{status:403,code:'MFA_LOGIN_REQUIRED'},'an MFA token only in the header counts as no MFA token');
 const headerActivity=await answer(await mfaApi.POST(request('/api/mfa',{...sessionHeaders({primary:browser.primary}),'X-ServerDesk-Mfa':browser.session},{action:'activity'})));
 check([headerActivity.status,headerActivity.body.code],[403,'MFA_LOGIN_REQUIRED'],'activity with a header-only MFA token: MFA_LOGIN_REQUIRED');
 const headerStatus=await answer(await mfaApi.GET(request('/api/mfa',headerOnly)));
 check([headerStatus.status,headerStatus.body.code],[401,'IDENTITY_LOGIN_REQUIRED'],'GET /api/mfa with header-only tokens: IDENTITY_LOGIN_REQUIRED');
 // Valid cookies plus headers that carry other tokens change nothing.
 const other=await account('other'),otherLogin=await answer(await authApi.POST(request('/api/auth',{},{action:'login',username:other.name,password:other.password})));
 let otherBrowser=browserAfter(otherLogin.response);
 otherBrowser=browserAfter((await mfaApi.POST(request('/api/mfa',sessionHeaders(otherBrowser),{action:'verify',recoveryCode:other.codes.shift()}))),otherBrowser);
 const mixed={...sessionHeaders(browser),'X-ServerDesk-Session':otherBrowser.primary,'X-ServerDesk-Mfa':otherBrowser.session};
 check(await dataApi(mixed),{status:200},'foreign tokens in headers do not change a cookie request');
 const mixedStatus=await answer(await mfaApi.GET(request('/api/mfa',mixed)));
 check(mixedStatus.body.sessionId,sha(browser.session).slice(0,24),'the cookie session is the one reported');
 check((await localAuth.localIdentity(request('/',mixed))).id,owner.actor.id,'the identity is the cookie owner');

 // ---- passkey authentication-verify --------------------------------------------------
 {
  const fresh=browserAfter((await authApi.POST(request('/api/auth',{},{action:'login',username:owner.name,password:owner.password}))));
  const credential='cred_'+crypto.randomBytes(8).toString('hex'),challengeId=token(),passkeyBrowser=token(),at=Date.now();
  await inTransaction(d,[
   sql`INSERT INTO passkey_credentials(id,principal,public_key,counter,transports,name,device,device_type,backed_up,created_at,last_used_at) VALUES(${credential},${owner.actor.principal},'AAAA',5,'[]','Laptop','local','singleDevice',0,${at},NULL)`,
   sql`INSERT INTO passkey_challenges(id,principal,purpose,challenge,browser_hash,session_hash,rp_id,origin,name,device,expires_at) VALUES(${challengeId},${owner.actor.principal},'authentication','challenge',${sha(passkeyBrowser)},NULL,'cookies.test',${origin},'','any',${at+300_000})`,
  ]);
  const passkey=await answer(await passkeyApi.POST(request('/api/passkeys',{...sessionHeaders({...fresh,passkey:passkeyBrowser}),'X-ServerDesk-Embedded':'1'},{action:'authentication-verify',challengeId,response:{id:credential,rawId:credential,type:'public-key',response:{clientDataJSON:Buffer.from('{}').toString('base64url')}}})));
  check(passkey.status,200,'passkey login succeeds: '+passkey.body.error);
  leaksNothing(passkey,'passkey authentication-verify');strict(passkey,'passkey authentication-verify');
 }

 // ---- logout revokes only what the cookies name -------------------------------------
 {
  const sessionsBefore=await count(sql`SELECT count(*) AS n FROM mfa_sessions`),primaryBefore=await count(sql`SELECT count(*) AS n FROM local_auth_sessions`);
  const headerLogout=await answer(await authApi.POST(request('/api/auth',headerOnly,{action:'logout'})));
  check(headerLogout.status,200,'a logout without cookies answers');
  check([await count(sql`SELECT count(*) AS n FROM mfa_sessions`),await count(sql`SELECT count(*) AS n FROM local_auth_sessions`)],[sessionsBefore,primaryBefore],'a logout with header-only tokens revokes nothing');
  const mfaHeaderLogout=await answer(await mfaApi.POST(request('/api/mfa',{...sessionHeaders({primary:browser.primary}),'X-ServerDesk-Mfa':browser.session},{action:'logout'})));
  check([mfaHeaderLogout.status,await count(sql`SELECT count(*) AS n FROM mfa_sessions WHERE token_hash=${sha(browser.session)}`)],[200,1],'an MFA logout with the token only in the header keeps that session');
  const cookieLogout=await answer(await authApi.POST(request('/api/auth',{...sessionHeaders(browser),'X-ServerDesk-Session':otherBrowser.primary,'X-ServerDesk-Mfa':otherBrowser.session},{action:'logout'})));
  check(cookieLogout.status,200,'the cookie logout succeeds');strict(cookieLogout,'logout');
  check([await count(sql`SELECT count(*) AS n FROM mfa_sessions WHERE token_hash=${sha(browser.session)}`),await count(sql`SELECT count(*) AS n FROM local_auth_sessions WHERE token_hash=${sha(browser.primary)}`)],[0,0],'the cookie sessions are revoked');
  check([await count(sql`SELECT count(*) AS n FROM mfa_sessions WHERE token_hash=${sha(otherBrowser.session)}`),await count(sql`SELECT count(*) AS n FROM local_auth_sessions WHERE token_hash=${sha(otherBrowser.primary)}`)],[1,1],'the sessions named only in headers stay');
  check(setCookies(cookieLogout.response).filter(cookie=>cookie.value).length,0,'logout only clears cookies');
 }
 console.log(`PASS cookie-only session (${checks} assertions): no header transport, -embedded cookie or partitioned cookie in the source; login, verify, status, activity and passkey replies carry no token; headers never authenticate; logout revokes only what the cookies name; every session cookie is SameSite=Strict.`);
}finally{d.close();}
