// Shared fixture of the sign-in with Microsoft Entra ID tests: the real
// lib/server/identity/entra/*, lib/server/identity/local-auth.ts, lib/server/identity/mfa.ts, lib/server/identity/rbac.ts and their routes on an
// isolated PostgreSQL database, with a stub of lib/server/context.ts whose clock can be
// moved. A fake Microsoft (entraTransport) serves discovery, the JWKS, the
// token endpoint and Microsoft Graph (the probes of the connection test and the
// account check: microsoft.directory); RSA keys from node:crypto sign the
// id_tokens and the v1.0 access tokens of the portal API (the MFA signal).
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {HttpError} from './http-error.mjs';
import {serverText} from './server-text.mjs';
import {browserAfter,sessionHeaders} from './session-cookies.mjs';
import {sourceDatabase,sourceLoader,sourceActor,insertRow} from './source-database.mjs';
import {sql} from '../../runtime/database.mjs';

export const origin='https://entra.test';
export const tenant='11111111-2222-4333-8444-555555555555';
export const clientId='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
export const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
/** The application ID URI and the sign-in scope of the portal API (lib/server/identity/entra/oidc.ts). */
export const applicationIdUri=`api://${clientId}`,signInScope=`openid profile email api://${clientId}/access_as_user`;
const token=()=>crypto.randomBytes(32).toString('hex');
const b64=value=>Buffer.from(typeof value==='string'?value:JSON.stringify(value)).toString('base64url');

export {selfSignedCertificate} from './entra-certificate.mjs';

/** One time offset of a refused time check (lib/server/identity/entra/oidc.ts, timeOffset): a signed integer without "+" or leading zeros, at most 9 digits, or none. */
export const timeOffsetPattern='(?:0|-?[1-9]\\d{0,8}|none)';
/**
 * `server` overrides members of the lib/server/context.ts stub (for example log), and
 * `imports` adds module stubs for the extra modules a test loads with `load`.
 */
export async function entraFixture({server:serverOverrides={},imports:extraImports={}}={}){
 const d=await sourceDatabase();
 // `held` is the portal clock held at a fixed millisecond value (the clock setter), or null for the real clock;
 // clock() is the portal clock (server.now) and the clock of the fake Microsoft, both moved by `offset`.
 let offset=0,held=null,current=null;
 const clock=()=>(held??Date.now())+offset;
 const server={
  db:()=>d,config:key=>key==='SESSION_SECRET'?'s'.repeat(64):key==='PASSWORD_PEPPER'?'p'.repeat(48):key==='SITE_ORIGIN'?origin:'',now:clock,random:token,hash:async value=>sha(value),HttpError,
  guid:x=>typeof x==='string'&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(x),body:request=>request.json(),sameOrigin:request=>{if(request.headers.get('origin')!==origin)throw new HttpError('apiError.request.invalidOrigin');},
  requireViewer:async()=>{if(!current)throw new HttpError('apiError.auth.loginRequired');return current;},requireAuthIdentity:async()=>{if(!current)throw new HttpError('apiError.auth.loginRequired');return current;},
  log:async()=>{throw new Error('log() must not be used by these actions');},
  failure:e=>{if(!(e instanceof HttpError))console.error(e);return Response.json(e instanceof HttpError?{error:e.message,code:e.code,messageKey:e.messageKey}:{error:serverText('apiError.storageUnavailable'),code:'STORAGE_UNAVAILABLE'},{status:e instanceof HttpError?e.status:503});},
  ...serverOverrides,
 };
 const webauthn={generateRegistrationOptions:async()=>({}),verifyRegistrationResponse:async()=>({verified:false}),generateAuthenticationOptions:async()=>({}),verifyAuthenticationResponse:async()=>({verified:false})};
 const load=sourceLoader(),imports={'../context':server,'./context':server,'../../context':server,'@/lib/server/context':server,'@simplewebauthn/server':webauthn,...extraImports};
 const m={
  oidc:load('lib/server/identity/entra/oidc.ts',imports),signIn:load('lib/server/identity/entra/sign-in.ts',imports),settings:load('lib/server/identity/entra/settings.ts',imports),roleSync:load('lib/server/identity/entra/role-sync.ts',imports),
  localAuth:load('lib/server/identity/local-auth.ts',imports),mfa:load('lib/server/identity/mfa.ts',imports),access:load('lib/server/identity/access.ts',imports),rbac:load('lib/server/identity/rbac.ts',imports),featureAuthorization:load('lib/server/identity/feature-authorization.ts',imports),
  accountAdmin:load('lib/server/identity/account-admin.ts',imports),stepUp:load('lib/step-up.ts',imports),codes:load('lib/errors/codes.ts',imports),
  startApi:load('app/api/auth/entra/start/route.ts',imports),callbackApi:load('app/api/auth/entra/callback/route.ts',imports),authApi:load('app/api/auth/route.ts',imports),
  settingsApi:load('app/api/entra/settings/route.ts',imports),mfaApi:load('app/api/mfa/route.ts',imports),passkeyApi:load('app/api/passkeys/route.ts',imports),rbacApi:load('app/api/rbac/route.ts',imports),
 };
 await m.rbac.ensureBuiltinRoles();

 // ---- Fake Microsoft ---------------------------------------------------------
 const keys=[{kid:'key-1',...crypto.generateKeyPairSync('rsa',{modulusLength:2048})}];
 const jwk=entry=>({...entry.publicKey.export({format:'jwk'}),kid:entry.kid,use:'sig'});
 const microsoft={
  calls:[],keys,
  discovery:()=>({status:200,body:JSON.stringify({issuer:`https://login.microsoftonline.com/${tenant}/v2.0`,jwks_uri:`https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`})}),
  jwks:()=>({status:200,body:JSON.stringify({keys:microsoft.keys.map(jwk)})}),
  /**
   * The answer of the token endpoint; `form` holds the parsed request. Client
   * credentials answer a Graph token, or for api://<client>/.default a v1.0 app
   * token of the portal API (appToken); a code redemption answers the id_token
   * and the access token of the portal API (unless dropAccessToken).
   */
  token:form=>form.grant_type==='client_credentials'
   ?{status:200,body:JSON.stringify({access_token:form.scope===`${applicationIdUri}/.default`?microsoft.appToken():'graph-token',expires_in:3600})}
   :{status:200,body:JSON.stringify({id_token:microsoft.idToken(form),...(microsoft.dropAccessToken?{}:{access_token:microsoft.accessToken(form),token_type:'Bearer',scope:`${applicationIdUri}/access_as_user`})})},
  /** Claims of the next id_token, merged over the defaults (auth_time is now, no amr; undefined removes a claim); the nonce comes from the started flow. */
  claims:{},header:{},signWith:null,
  nonce:null,
  /**
   * max_age of the authorize URL of the current flow (sign-in or confirmation), or null.
   * Entra ID then gives an id_token with exp = auth_time + max_age and
   * iat = nbf = exp - 300 (seen in the audit of a real tenant); exp, iat or nbf
   * in `claims` win.
   */
  maxAge:null,
  /** Claims and header of the next access token of the portal API, merged over the v1.0 defaults (oid of the id_token, amr pwd and mfa). */
  accessClaims:{},accessHeader:{},accessSignWith:null,dropAccessToken:false,
  /** Claims and header of the next app token of the connection test (client credentials for api://<client>/.default). */
  appClaims:{},appHeader:{},appSignWith:null,
  jwt(header,claims,signWith){
   for(const [key,value] of Object.entries(claims))if(value===undefined)delete claims[key];
   for(const [key,value] of Object.entries(header))if(value===undefined)delete header[key];
   const data=`${b64(header)}.${b64(claims)}`;return `${data}.${crypto.sign('sha256',Buffer.from(data),(signWith??keys[0].privateKey)).toString('base64url')}`;
  },
  idClaims(){
   const now=Math.floor(clock()/1000);
   const claims={iss:`https://login.microsoftonline.com/${tenant}/v2.0`,aud:clientId,tid:tenant,oid:'99999999-8888-4777-8666-555555555555',name:'Ada Lovelace',preferred_username:'ada@contoso.example',email:'ada@contoso.example',nonce:microsoft.nonce,iat:now,nbf:now,exp:now+3600,auth_time:now,groups:[],ver:'2.0',...microsoft.claims};
   if(microsoft.maxAge!==null){
    const exp=(typeof claims.auth_time==='number'?claims.auth_time:now)+microsoft.maxAge;
    const modeled={exp,iat:exp-300,nbf:exp-300};
    for(const [key,value] of Object.entries(modeled))if(!(key in microsoft.claims))claims[key]=value;
   }
   return claims;
  },
  idToken(){return microsoft.jwt({alg:'RS256',typ:'JWT',kid:'key-1',...microsoft.header},microsoft.idClaims(),microsoft.signWith);},
  accessToken(){
   const now=Math.floor(clock()/1000),oid=microsoft.idClaims().oid;
   return microsoft.jwt({typ:'JWT',alg:'RS256',kid:'key-1',...microsoft.accessHeader},{aud:applicationIdUri,iss:`https://sts.windows.net/${tenant}/`,iat:now,nbf:now,exp:now+3600,amr:['pwd','mfa'],appid:clientId,appidacr:'1',name:'Ada Lovelace',oid,scp:'access_as_user',sub:'subject-of-the-api',tid:tenant,unique_name:'ada@contoso.example',upn:'ada@contoso.example',ver:'1.0',...microsoft.accessClaims},microsoft.accessSignWith);
  },
  appToken(){
   const now=Math.floor(clock()/1000);
   return microsoft.jwt({typ:'JWT',alg:'RS256',kid:'key-1',...microsoft.appHeader},{aud:applicationIdUri,iss:`https://sts.windows.net/${tenant}/`,iat:now,nbf:now,exp:now+3600,appid:clientId,appidacr:'1',oid:'00000000-0000-4000-8000-00000000a99a',sub:'00000000-0000-4000-8000-00000000a99a',tid:tenant,ver:'1.0',...microsoft.appClaims},microsoft.appSignWith);
  },
  fail:null,
  /** The Entra directory that Graph answers from: object ID → {enabled, groups}; an unknown object ID is 404 (deleted). */
  directory:new Map(),
  /**
   * The answer of Microsoft Graph (graph.microsoft.com/v1.0): the two probes of
   * the connection test, GET /users/<oid> and POST /users/<oid>/checkMemberGroups.
   * `path` is the path below /v1.0, `body` the parsed JSON request body.
   */
  graph:(request,{path,body})=>{
   if(path==='/users')return {status:200,body:JSON.stringify({value:[{id:'00000000-0000-4000-8000-0000000000f1',accountEnabled:true}]})};
   if(path==='/groups')return {status:200,body:JSON.stringify({value:[{id:'00000000-0000-4000-8000-0000000000f2'}]})};
   const user=/^\/users\/([^/]+)(\/checkMemberGroups)?$/.exec(path);
   const entry=user?microsoft.directory.get(user[1]):undefined;
   if(!entry)return {status:404,body:JSON.stringify({error:{code:'Request_ResourceNotFound',message:'Resource does not exist.'}})};
   if(!user[2])return {status:200,body:JSON.stringify({id:user[1],accountEnabled:entry.enabled!==false})};
   return {status:200,body:JSON.stringify({value:(body?.groupIds??[]).filter(id=>(entry.groups??[]).includes(id))})};
  },
 };
 const defaults={discovery:microsoft.discovery,jwks:microsoft.jwks,token:microsoft.token,graph:microsoft.graph};
 // `fail` answers every request (a network failure throws); otherwise the three endpoints and Graph answer.
 const transport=async request=>{
  microsoft.calls.push(request);
  if(microsoft.fail)return microsoft.fail(request);
  const url=new URL(request.url);
  if(url.host==='graph.microsoft.com'){
   let body=null;try{body=request.body?JSON.parse(request.body):null;}catch{body=null;}
   return microsoft.graph(request,{path:url.pathname.replace(/^\/v1\.0/,''),query:url.searchParams,body});
  }
  if(url.pathname.endsWith('/.well-known/openid-configuration'))return microsoft.discovery(request);
  if(url.pathname.endsWith('/discovery/v2.0/keys'))return microsoft.jwks(request);
  if(url.pathname.endsWith('/oauth2/v2.0/token'))return microsoft.token(Object.fromEntries(new URLSearchParams(request.body)),request);
  return {status:404,body:''};
 };
 /** Back to the default answers; set() also empties the key cache. */
 const resetMicrosoft=()=>{Object.assign(microsoft,{claims:{},maxAge:null,header:{},signWith:null,accessClaims:{},accessHeader:{},accessSignWith:null,dropAccessToken:false,appClaims:{},appHeader:{},appSignWith:null,fail:null,calls:[],keys:[keys[0]],directory:new Map()},defaults);m.oidc.entraTransport.set(transport);};
 m.oidc.entraTransport.set(transport);

 // ---- Settings and accounts ------------------------------------------------------
 /** Saves a complete, tested and enabled secret configuration directly. */
 async function configure({enabled=1,revision=1,secret='client-secret-value'}={}){
  await d.exec(sql`DELETE FROM entra_settings`);
  await insertRow(d,'entra_settings',{id:1,enabled,tenant_id:tenant,client_id:clientId,credential_kind:'secret',secret_enc:await m.mfa.encryptSecret(secret,'entra:client-secret'),revision,tested_revision:revision,tested_at:Date.now()+offset,test_result:'ok',updated_at:Date.now(),updated_by:'fixture'});
 }
 const request=(path,{browser={},cookie='',payload,headers={}}={})=>new Request(origin+path,{method:payload?'POST':'GET',headers:sessionHeaders(browser,{...(payload?{'Content-Type':'application/json',Origin:origin}:{}),...(cookie?{Cookie:cookie}:{}),...headers}),...(payload?{body:JSON.stringify(payload)}:{})});
 const answer=async response=>({status:response.status,body:await response.json(),response});

 /** The max_age of an authorize URL as a number of seconds, or null without one. */
 const maxAgeOf=authorize=>authorize?.searchParams.has('max_age')?Number(authorize.searchParams.get('max_age')):null;
 /**
  * A complete sign-in: start, then the callback with the flow cookie. `before`
  * runs between both (for example to change settings); `callback` changes the
  * callback query or cookie. Returns the start and callback answers, the page
  * target and the browser with its new session cookies.
  */
 async function signIn({callback={},before,startHeaders={}}={}){
  const start=await m.startApi.GET(request('/api/auth/entra/start',{headers:startHeaders}));
  const location=start.headers.get('location');
  const flowCookie=start.headers.getSetCookie().find(value=>value.startsWith('__Host-serverdesk-entra='));
  const flow=flowCookie?.split(';')[0].split('=')[1]??'';
  const authorize=location&&location.startsWith('https://')?new URL(location):null;
  microsoft.nonce=authorize?.searchParams.get('nonce')??null;microsoft.maxAge=maxAgeOf(authorize);
  await before?.({authorize,flow});
  const query=new URLSearchParams({code:'authorization-code',state:authorize?.searchParams.get('state')??'',...callback.query});
  for(const [key,value] of Object.entries(callback.query??{}))if(value===undefined)query.delete(key);
  const response=await m.callbackApi.GET(request('/api/auth/entra/callback?'+query,{cookie:callback.cookie??(flow?`__Host-serverdesk-entra=${flow}`:'')}));
  const html=await response.text(),target=/content="0;url=([^"]+)"/.exec(html)?.[1]??null;
  return {start,location,authorize,flow,flowCookie,response,html,target,browser:browserAfter(response,{})};
 }
 /**
  * "Confirm with Microsoft" (lib/server/identity/entra/confirm.ts) for the Entra browser that
  * the current viewer signed in with: entra-begin, the callback with the confirm
  * cookie, then (unless claim:false) one entra-claim. `before` runs between the
  * begin and the callback; `callback` changes its query or cookie. Returns the
  * answers, the callback page and the browser with the cookies of the claim.
  */
 async function confirm(browser,{before,callback={},claim=true,headers={}}={}){
  const begin=await answer(await m.mfaApi.POST(request('/api/mfa',{browser,payload:{action:'entra-begin'},headers})));
  if(begin.status!==200)return {begin,browser};
  const confirmCookie=begin.response.headers.getSetCookie().find(value=>value.startsWith('__Host-serverdesk-entra-confirm='));
  const token=confirmCookie?.split(';')[0].split('=')[1]??'',authorize=new URL(begin.body.url);
  microsoft.nonce=authorize.searchParams.get('nonce');microsoft.maxAge=maxAgeOf(authorize);
  await before?.({authorize,token,begin});
  const query=new URLSearchParams({code:'confirm-code',state:authorize.searchParams.get('state')??'',...callback.query});
  for(const [key,value] of Object.entries(callback.query??{}))if(value===undefined)query.delete(key);
  const response=await m.callbackApi.GET(request('/api/auth/entra/callback?'+query,{cookie:callback.cookie??`__Host-serverdesk-entra-confirm=${token}`}));
  const html=await response.text(),result={begin,confirmCookie,token,authorize,query,response,html,browser};
  if(!claim)return result;
  const claimed=await answer(await m.mfaApi.POST(request('/api/mfa',{browser,payload:{action:'entra-claim',flow:begin.body.flow}})));
  return {...result,claimed,browser:claimed.status===200&&!claimed.body.pending?browserAfter(claimed.response,browser):browser,management:claimed.body.managementToken};
 }
 /** The viewer of a browser through the real localIdentity, as requireViewer would see it. */
 async function viewerOf(browser){return m.localAuth.localIdentity(request('/',{browser}));}

 /** A local account with password and an MFA account with recovery codes (the step-up fixture of tests/api/session-idle-resume.mjs). */
 async function localAccount(label,permissions=['*']){
  const {actor,assignmentId}=await sourceActor(d,label,permissions);actor.userId=actor.id;
  const codes=Array.from({length:40},()=>crypto.randomBytes(16).toString('hex').toUpperCase());
  await d.exec(sql`UPDATE local_users SET password_hash='fixture-password',must_reset=0 WHERE id=${actor.id}`);
  await insertRow(d,'mfa_accounts',{principal:actor.principal,secret_enc:'migrated:authenticator-managed',recovery_hashes:JSON.stringify(codes.map(code=>sha(actor.principal+'\0'+code))),last_counter:-1,created_at:Date.now(),authenticators_migrated:1});
  return {actor,assignmentId,codes};
 }
 /** Signs a local account in with a recovery code: a bound session and a fresh management token. */
 async function localLogin(fixture){
  const primary=token(),at=Date.now()+offset;
  await insertRow(d,'local_auth_sessions',{token_hash:sha(primary),user_id:fixture.actor.id,auth_version:1,created_at:at,expires_at:at+86_400_000,pending_until:at+600_000,mfa_hash:null});
  current=fixture.actor;const start={primary,session:''};
  const result=await answer(await m.mfaApi.POST(request('/api/mfa',{browser:start,payload:{action:'verify',recoveryCode:fixture.codes.shift()}})));
  assert.equal(result.status,200,'recovery login: '+result.body.error);
  const browser=browserAfter(result.response,start);
  current=await viewerOf(browser);
  return {...browser,management:result.body.managementToken};
 }
 const auditRows=async action=>(await d.query(sql`SELECT actor,action,target,scope FROM audit WHERE action LIKE ${action} ORDER BY id`)).map(row=>({...row}));
 const count=async statement=>Number((await d.one(statement)).n);
 return {
  d,m,server,load:file=>load(file,imports),microsoft,resetMicrosoft,configure,request,answer,signIn,confirm,viewerOf,localAccount,localLogin,auditRows,count,
  setViewer:value=>{current=value;},get viewer(){return current;},
  get offset(){return offset;},set offset(value){offset=value;},
  /**
   * The held portal clock in ms, or null for the real clock. While it is held,
   * server.now() is that value plus `offset`, and the fake Microsoft builds the
   * default iat, nbf, exp and auth_time of every token from it; null releases it.
   */
  get clock(){return held;},set clock(value){assert.ok(value===null||Number.isFinite(value),'the held clock is a finite number of ms or null');held=value;},
 };
}
