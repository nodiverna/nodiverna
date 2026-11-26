import {serverText} from '../../support/server-text.mjs';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import '../../support/register.mjs';

// Run the actual browser credential helper as JavaScript without a DOM or
// browser process. Fetch, time, timers and window events are controlled at the
// boundary. The session tokens travel only in HttpOnly cookies:
// the helper keeps no token, sends no credential header and strips caller ones.
// The shared loader compiles the file and resolves its '@/lib/i18n' imports.
const source=await readFile(new URL('../../../ui/base/http.ts',import.meta.url),'utf8');
const runtime=await import('../../../ui/base/http.ts');
const original={fetch:globalThis.fetch,window:globalThis.window,CustomEvent:globalThis.CustomEvent,now:Date.now,performance:globalThis.performance,setTimeout:globalThis.setTimeout,clearTimeout:globalThis.clearTimeout};
let time=1800000000000,monotonic=0,calls=[],events=[],timers=[],respond=()=>new Response('{}',{headers:{'Content-Type':'application/json'}}),cases=0;
const day=86400000,credentialHeaders=['X-ServerDesk-Session','X-ServerDesk-Mfa','X-ServerDesk-Embedded'];
function reset(){calls=[];events=[];timers=[];respond=()=>new Response('{}',{headers:{'Content-Type':'application/json'}});if(globalThis.window){window.top=window;window.self=window;}}
const sent=(index=-1)=>new Headers(calls.at(index).init.headers);
const noCredentialHeader=(index=-1)=>credentialHeaders.every(name=>sent(index).get(name)===null);
const {errorCatalog}=await import('../../../lib/errors/codes.ts');
// A core error answer: the code with its default key, as lib/server/errors/failure.ts sends it.
function error(status=401,code='SESSION_EXPIRED'){return new Response(JSON.stringify({code,error:'Session expired',messageKey:errorCatalog[code]?.key}),{status,headers:{'Content-Type':'application/json'}});}
const isRecheck=(input,init)=>String(input)==='/api/mfa'&&(init?.method??'GET')==='GET';
async function test(name,run){reset();await run();cases++;console.log('PASS '+name);}
try{
 Date.now=()=>time;globalThis.performance={now:()=>monotonic};
 globalThis.CustomEvent=class extends Event{constructor(type,options={}){super(type);this.detail=options.detail;}};
 globalThis.window={location:{href:'https://serverdesk.test/',origin:'https://serverdesk.test'},dispatchEvent(event){events.push(event);return true;}};
 globalThis.fetch=async(input,init)=>{calls.push({input,init});return respond(input,init);};
 // The 3-second recheck deadline is the only timer; tests fire it by hand.
 globalThis.setTimeout=(callback,ms)=>{const timer={callback,ms,cleared:false};timers.push(timer);return timer;};
 globalThis.clearTimeout=timer=>{if(timer)timer.cleared=true;};

 await test('The module keeps no token and exports no token helpers',async()=>{
  for(const name of ['captureIdentityProof','clearMfaProof','clearIdentityProof','embeddedContext','captureMfaProof'])assert.equal(name in runtime,false,name+' is gone');
  assert.equal(typeof runtime.captureServerClock,'function','the clock capture stays');
  assert.doesNotMatch(source,/proofToken|identityToken|(?:local|session)Storage\.(?:get|set)Item/,'no token field is read and nothing is stored');
  assert.doesNotMatch(source,/headers\.set\('X-ServerDesk/i,'the helper never sets a credential header');
 });
 await test('Requests carry cookies only: no credential header, same-origin credentials, manual redirects for the API',async()=>{
  await runtime.credentialFetch('/api/console');assert.ok(noCredentialHeader());assert.equal(calls.at(-1).init.credentials,'same-origin');assert.equal(calls.at(-1).init.redirect,'manual');
  await runtime.credentialFetch(new URL('https://serverdesk.test/api/mfa'),{credentials:'include'});assert.ok(noCredentialHeader());assert.equal(calls.at(-1).init.credentials,'same-origin','a caller cannot widen the credentials mode');
  for(const url of ['https://foreign.test/api/console','https://serverdesk.test/page','http://serverdesk.test/api/console','//foreign.test/api/mfa','/api-other/mfa']){
   await runtime.credentialFetch(url,{headers:{'X-ServerDesk-Mfa':'caller-secret','X-ServerDesk-Session':'caller-primary'}});assert.ok(noCredentialHeader(),url);assert.equal(calls.at(-1).init.redirect,undefined,url);
  }
 });
 await test('Caller credential headers are stripped from Request and init; other headers stay',async()=>{
  const request=new Request('https://serverdesk.test/api/console',{headers:{'X-ServerDesk-Mfa':'caller-secret','X-ServerDesk-Session':'caller-primary','X-ServerDesk-Embedded':'1','X-Request':'keep','X-Override':'old'}});
  await runtime.credentialFetch(request,{headers:{'X-Override':'new','X-ServerDesk-Session':'second-secret'}});
  assert.ok(noCredentialHeader());assert.equal(sent().get('X-Request'),'keep');assert.equal(sent().get('X-Override'),'new');
  await runtime.credentialFetch(request,{redirect:'follow'});assert.equal(calls.at(-1).init.redirect,'manual');
 });
 await test('No embedded header, also inside a frame of a different origin',async()=>{
  for(const top of [{location:{origin:window.location.origin}},{location:{origin:'https://foreign.test'}}]){window.top=top;await runtime.credentialFetch('/api/console');assert.ok(noCredentialHeader());}
  const foreignTop={};Object.defineProperty(foreignTop,'location',{get(){throw new DOMException('Cross-origin frame','SecurityError');}});window.top=foreignTop;
  await runtime.credentialFetch('/api/mfa',{headers:{[['X-ServerDesk','Embedded'].join('-')]:'1'}});assert.ok(noCredentialHeader());
 });
 await test('An MFA failure with a live shared cookie dispatches the sync event after one read-only recheck',async()=>{
  for(const [status,code] of [[401,'SESSION_EXPIRED'],[403,'MFA_LOGIN_REQUIRED']]){
   reset();respond=(input,init)=>isRecheck(input,init)?Response.json({authenticated:true}):error(status,code);
   const response=await runtime.credentialFetch('/api/console',{method:'POST',body:'{}'});
   assert.equal(response.status,status,'the failure is returned, never replayed');assert.equal(calls.length,2,'exactly one recheck');
   assert.equal(String(calls[1].input),'/api/mfa');assert.equal(calls[1].init.method,undefined,'the recheck is a read');assert.equal(calls[1].init.body,undefined);
   assert.equal(calls[1].init.credentials,'same-origin');assert.equal(calls[1].init.redirect,'manual');assert.ok(noCredentialHeader(1),'the recheck carries only the cookie');
   assert.deepEqual(events.map(event=>event.type),[runtime.SESSION_SYNC_EVENT]);
   assert.equal(timers[0].ms,3000,'the recheck has a 3-second deadline');assert.equal(timers[0].cleared,true);
  }
 });
 await test('An MFA failure without a live shared cookie locks with the code',async()=>{
  for(const [status,code,recheck] of [[401,'SESSION_EXPIRED',()=>Response.json({authenticated:false})],[403,'MFA_LOGIN_REQUIRED',()=>Response.json({authenticated:false})],[401,'SESSION_EXPIRED',()=>error(401,'IDENTITY_LOGIN_REQUIRED')],[401,'SESSION_EXPIRED',()=>new Response('<html/>',{headers:{'Content-Type':'text/html'}})],[403,'MFA_LOGIN_REQUIRED',()=>{throw new TypeError('offline');}]]){
   reset();respond=(input,init)=>isRecheck(input,init)?recheck():error(status,code);
   await runtime.credentialFetch('/api/console');assert.equal(calls.length,2);
   assert.equal(events.length,1);assert.equal(events[0].type,runtime.SESSION_LOCK_EVENT);assert.equal(events[0].detail.code,code);// The lock detail carries the catalog text of the key in the page language (English outside a browser), not the sent text.
   assert.equal(events[0].detail.message,serverText((await import('../../../lib/errors/codes.ts')).errorCatalog[code].key));
  }
 });
 await test('A recheck that hits its 3-second deadline locks',async()=>{
  respond=(input,init)=>isRecheck(input,init)?new Promise((resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')))):error();
  const pending=runtime.credentialFetch('/api/console');
  while(!timers.length)await new Promise(resolve=>setImmediate(resolve));
  timers[0].callback();await pending;
  assert.equal(events.length,1);assert.equal(events[0].type,runtime.SESSION_LOCK_EVENT);
 });
 await test('Concurrent MFA failures share one recheck (single flight)',async()=>{
  let finish;respond=(input,init)=>isRecheck(input,init)?new Promise(resolve=>{finish=resolve;}):error();
  const first=runtime.credentialFetch('/api/console'),second=runtime.credentialFetch('/api/runbooks');
  while(!finish)await new Promise(resolve=>setImmediate(resolve));
  await new Promise(resolve=>setImmediate(resolve));
  finish(Response.json({authenticated:true}));await Promise.all([first,second]);
  assert.equal(calls.filter(call=>isRecheck(call.input,call.init)).length,1,'one recheck for both failures');
  assert.deepEqual(events.map(event=>event.type),[runtime.SESSION_SYNC_EVENT,runtime.SESSION_SYNC_EVENT]);
  // The next failure starts a new recheck.
  respond=(input,init)=>isRecheck(input,init)?Response.json({authenticated:false}):error();await runtime.credentialFetch('/api/console');
  assert.equal(calls.filter(call=>isRecheck(call.input,call.init)).length,2);assert.equal(events.at(-1).type,runtime.SESSION_LOCK_EVENT);
 });
 await test('Identity loss locks without a recheck',async()=>{
  for(const [status,code] of [[401,'IDENTITY_LOGIN_REQUIRED']]){
   reset();respond=()=>error(status,code);
   const result=await runtime.credentialFetch('/api/mfa');assert.equal(result.status,status);assert.equal(calls.length,1,'no recheck and no replay');
   assert.equal(events.length,1);assert.equal(events[0].type,runtime.SESSION_LOCK_EVENT);assert.equal(events[0].detail.code,code);
   await assert.rejects(()=>runtime.readApiJson(result),failure=>failure instanceof runtime.ApiError&&failure.status===status&&failure.code===code);
  }
 });
 await test('The removed access-approval code is an ordinary permission error',async()=>{
  respond=()=>error(403,'ACCESS_NOT_APPROVED');
  const result=await runtime.credentialFetch('/api/mfa');assert.equal(result.status,403);assert.equal(calls.length,1,'no recheck and no replay');assert.equal(events.length,0,'no session lock');
 });
 await test('Permission errors and foreign authentication failures do not lock the portal',async()=>{
  respond=()=>error(403,'DEVICE_PERMISSION_DENIED');await runtime.credentialFetch('/api/console');assert.equal(events.length,0);
  respond=()=>error();await runtime.credentialFetch('https://foreign.test/api/console');assert.equal(events.length,0);
  respond=()=>new Response(JSON.stringify({error:serverText('apiError.mfa.codeInvalid')}),{status:401,headers:{'Content-Type':'application/json'}});await runtime.credentialFetch('/api/mfa');assert.equal(events.length,0);
  assert.equal(calls.length,3,'no recheck for these');
 });
 await test('Redirects and non-JSON auth answers become a code-less 502 without a lock or a recheck',async()=>{
  const patched=(response,fields)=>{for(const [key,value] of Object.entries(fields))Object.defineProperty(response,key,{value});return response;};
  for(const [label,make] of [
   ['302 to an external login',()=>new Response(null,{status:302,headers:{Location:'https://login.example.test/signin'}})],
   ['opaque redirect',()=>patched(new Response(null),{type:'opaqueredirect',status:0,ok:false})],
   ['followed redirect',()=>patched(new Response('{}',{headers:{'Content-Type':'application/json'}}),{redirected:true})],
   ['text/plain 401',()=>new Response('unauthorized',{status:401,headers:{'Content-Type':'text/plain'}})],
   ['text/plain 403',()=>new Response('forbidden',{status:403,headers:{'Content-Type':'text/plain'}})],
   ['text/html 403',()=>new Response('<h1>Forbidden</h1>',{status:403,headers:{'Content-Type':'text/html'}})],
   ['HTML 200',()=>new Response('<!DOCTYPE html><title>Sign in</title>',{headers:{'Content-Type':'text/html'}})],
  ]){
   reset();respond=make;
   const response=await runtime.credentialFetch('/api/mfa');
   assert.equal(response.status,502,label);assert.equal(calls.length,1,label+': the failed call is not replayed and no recheck runs');
   const body=await response.clone().json();assert.equal(body.error,serverText('common.serviceUnavailable'),label);assert.equal('code' in body,false,label);
   assert.equal(events.length,0,label+': no session lock event');
   await assert.rejects(()=>runtime.readApiJson(response),failure=>failure instanceof runtime.ApiError&&failure.status===502&&failure.code===undefined);
  }
 });
 await test('Temporary proxy outages stay errors without locking',async()=>{
  respond=()=>new Response('<h1>Unavailable</h1>',{status:503,headers:{'Content-Type':'text/html'}});
  const response=await runtime.credentialFetch('/api/console');assert.equal(response.status,503);assert.equal(events.length,0);
  await assert.rejects(()=>runtime.readApiJson(response),failure=>failure instanceof runtime.ApiError&&failure.status===503&&!/JSON|Unexpected|SyntaxError/.test(failure.message));
 });
 await test('Unexpected JSON responses produce typed user-facing errors',async()=>{
  await assert.rejects(()=>runtime.readApiJson(new Response('<html>bad</html>',{headers:{'Content-Type':'application/json'}})),failure=>failure instanceof runtime.ApiError&&failure.status===200&&!/SyntaxError|Unexpected token/.test(failure.message));
  const result=await runtime.readApiJson(new Response(JSON.stringify({ok:true}),{headers:{'Content-Type':'application/json'}}));assert.equal(result.ok,true);
 });
 await test('Intentional scripts and file blocks retain their binary response',async()=>{
  respond=()=>new Response(new Uint8Array([1,2,3]),{headers:{'Content-Type':'application/octet-stream'}});
  const response=await runtime.credentialFetch('/api/transfers?id=one&chunk=0');assert.deepEqual([...new Uint8Array(await response.arrayBuffer())],[1,2,3]);assert.equal(events.length,0);
 });
 await test('Server time and monotonic elapsed time survive client clock corrections',async()=>{
  const serverTime=time;runtime.captureServerClock('/api/mfa',undefined,{serverTime});assert.equal(runtime.portalNow(),serverTime);
  time+=2*day;monotonic+=10000;assert.equal(runtime.portalNow(),serverTime+10000,'a Windows clock jump does not move portal time');
  time-=3*day;monotonic+=day;assert.equal(runtime.portalNow(),serverTime+day+10000,'a clock moving backwards does not either');
  const later=serverTime+5*day;
  for(const [url,body] of [['https://foreign.test/api/mfa',{action:'verify'}],['/api/console',{action:'verify'}],['/api/passkeys',{action:'registration-verify'}],['https://foreign.test/api/passkeys',{action:'authentication-verify'}]]){
   runtime.captureServerClock(url,body,{serverTime:later});assert.equal(runtime.portalNow(),serverTime+day+10000,'ignored: '+url);
  }
  runtime.captureServerClock('/api/mfa',{action:'verify'},{serverTime:'soon'});assert.equal(runtime.portalNow(),serverTime+day+10000,'a non-number is ignored');
  for(const [url,body] of [['/api/passkeys',{action:'authentication-verify'}],['/api/passkeys',{action:'setup-verify'}],['/api/mfa',{action:'activity'}]]){
   runtime.captureServerClock(url,body,{serverTime:later});assert.equal(runtime.portalNow(),later,'captured: '+url+' '+body.action);
  }
 });
 console.log(`Portal HTTP credential checks passed (${cases} scenarios).`);
}finally{
 globalThis.fetch=original.fetch;Date.now=original.now;globalThis.performance=original.performance;globalThis.setTimeout=original.setTimeout;globalThis.clearTimeout=original.clearTimeout;
 for(const key of ['window','CustomEvent']){if(original[key]===undefined)delete globalThis[key];else globalThis[key]=original[key];}
}
