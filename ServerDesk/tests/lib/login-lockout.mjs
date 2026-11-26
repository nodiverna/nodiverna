// Only failed logins count, the account bucket is per client address,
// and the shared address bucket without a trusted client address allows 200.
// A cross-address ceiling allows 100 failures per account; IPv6 counts by /64.
// Logins count under their own key space login:, and every lockout
// writes one auth.lockout row per limit and window, without passwords or typed names.
// Real lib/server/identity/local-auth.ts on an isolated PostgreSQL test database; ./passwords is a fast plain-text
// fake so hundreds of logins cost no scrypt. The server stub clock can be moved.
import {serverText} from '../support/server-text.mjs';
import {HttpError as realHttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {sourceDatabase,sourceLoader,sourceActor} from '../support/source-database.mjs';
import {sql} from '../../runtime/database.mjs';

const d=await sourceDatabase();
let checks=0;
const check=(value,expected,label)=>{assert.deepEqual(value,expected,label);checks++;};
try{
 const origin='https://lockout.test',window=10*60_000;
 const HttpError=realHttpError;
 const token=()=>crypto.randomBytes(32).toString('hex'),sha=value=>crypto.createHash('sha256').update(value).digest('hex');
 let offset=0,verifications=0;
 const server={
  db:()=>d,config:key=>key==='SESSION_SECRET'?'s'.repeat(64):key==='SITE_ORIGIN'?origin:'',now:()=>Date.now()+offset,random:token,hash:async value=>sha(value),HttpError,
  guid:value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
  log:async()=>{throw new Error('log() must not be used by login');},
 };
 const passwords={
  verifyPassword:async(password,record)=>{verifications++;return typeof password==='string'&&password===record;},
  dummyPasswordRecord:async()=>'\0never-matches',hashPassword:async value=>value,validatePassword:value=>value,
 };
 const webauthn={generateRegistrationOptions:async()=>({}),verifyRegistrationResponse:async()=>({verified:false}),generateAuthenticationOptions:async()=>({}),verifyAuthenticationResponse:async()=>({verified:false})};
 const load=sourceLoader(),imports={'../context':server,'./context':server,'../../context':server,'@/lib/server/context':server,'./passwords':passwords,'@simplewebauthn/server':webauthn};
 const auth=load('lib/server/identity/local-auth.ts',imports);

 // ---- Fixture: two active local accounts with a password -------------------------------
 async function account(name,password){
  const {actor}=await sourceActor(d,name+'@lockout.test',['view']);
  await d.exec(sql`UPDATE local_users SET username=${name},password_hash=${password},must_reset=0 WHERE id=${actor.id}`);
  return {name,password,id:actor.id};
 }
 const owner=await account('owner','owner-correct-password'),other=await account('other','other-correct-password'),target=await account('target','target-correct-password');
 const request=ip=>new Request(origin+'/api/auth',{headers:ip?{'X-ServerDesk-Client-IP':ip}:{}});
 const attempt=async(ip,name,password)=>{try{const result=await auth.login(request(ip),{username:name,password});return {status:200,ok:result.ok};}catch(error){if(!(error instanceof HttpError))throw error;return {status:error.status,code:error.code};}};
 const success={status:200,ok:true},invalid={status:401,code:'INVALID_CREDENTIALS'},limited={status:429,code:'AUTH_RATE_LIMITED'};
 const bucket=async key=>Number((await d.one(sql`SELECT attempts FROM local_auth_attempts WHERE bucket=${sha(key)}`))?.attempts??0);
 const accountKey=(name,ip)=>'account:login:'+name+'\n'+'ip:'+ip,totalKey=name=>'account-total:login:'+name;
 const lockouts=async()=>(await d.query(sql`SELECT actor,action,target,scope,server_id FROM audit WHERE action='auth.lockout' ORDER BY id`)).map(row=>({...row}));
 const lockout=target=>({actor:'System',action:'auth.lockout',target,scope:'portal',server_id:null});
 // The rows a block adds: call before the block, then await the result after it.
 const newLockouts=async()=>{const before=(await lockouts()).length;return async()=>(await lockouts()).slice(before);};

 check([auth.ACCOUNT_ATTEMPT_LIMIT,auth.ADDRESS_ATTEMPT_LIMIT,auth.SHARED_INGRESS_ATTEMPT_LIMIT,auth.ACCOUNT_TOTAL_ATTEMPT_LIMIT,auth.ATTEMPT_WINDOW],[10,40,200,100,window],'named limits: 10 per account and address, 40 per address, 200 shared, 100 per account across addresses, 10 minutes');

 // ---- A successful login leaves no count ------------------------------------------
 {
  const results=[];for(let n=0;n<60;n++)results.push(await attempt(null,owner.name,owner.password));
  check(results.filter(r=>r.status===200&&r.ok===true).length,60,'60 successful logins without X-ServerDesk-Client-IP all succeed');
  check([await bucket(accountKey('owner','unknown-ingress')),await bucket('ip:unknown-ingress')],[0,0],'success gives its reservation back in both buckets');
  check(await bucket('account:owner'),0,'the old account-only bucket is not used');
  check(await bucket(totalKey('owner')),0,'success gives its reservation back in the cross-address ceiling too');
  const ip='192.0.2.1';
  check(await attempt(ip,owner.name,owner.password),success,'a login with X-ServerDesk-Client-IP succeeds');
  check([await bucket(accountKey('owner',ip)),await bucket('ip:'+ip)],[0,0],'success with an address leaves no count');
  check(await attempt(ip,owner.name,'wrong-password-123'),invalid,'a wrong password gives 401');
  check([await bucket(accountKey('owner',ip)),await bucket('ip:'+ip),await bucket(totalKey('owner'))],[1,1,1],'a failure keeps its reservation in all three buckets');
  check([await bucket('account:owner\nip:'+ip),await bucket('account-total:owner')],[0,0],'the old keys without login: are not used any more');
  check(await attempt(ip,owner.name,owner.password),success,'a later success');
  check([await bucket(accountKey('owner',ip)),await bucket('ip:'+ip),await bucket(totalKey('owner'))],[1,1,1],'a success does not reset earlier failures');
 }

 // ---- The login key space shares no account bucket with redeem: -------
 {
  const rows=await newLockouts(),typed='redeem:'+owner.id,first='192.0.2.120',second='192.0.2.121';
  for(let n=1;n<=10;n++)check(await attempt(first,typed,'wrong-password-r'+n),invalid,`login failure ${n} with the typed name ${typed} gives 401`);
  check([await bucket(accountKey(typed,first)),await bucket('account:'+typed+'\n'+'ip:'+first)],[10,0],'the typed name counts under login:, not in the redeem bucket');
  await auth.rateLimit(request(first),typed);checks++;
  for(let n=0;n<9;n++)await auth.rateLimit(request(second),typed);
  await auth.rateLimit(request(second),typed);checks++;
  check(await bucket('account:'+typed+'\n'+'ip:'+second),10,'10 redeem calls fill the redeem bucket');
  check(await attempt(second,typed,'wrong-password-r11'),invalid,'a login with the typed name redeem:<id> still gets 401, not 429');
  check(await rows(),[],'no limit was reached, so no auth.lockout row');
 }

 // ---- Account bucket per client address; a blocked request skips the check -----
 {
  const attacker='203.0.113.7',home='198.51.100.9',rows=await newLockouts();
  for(let n=1;n<=10;n++)check(await attempt(attacker,owner.name,'wrong-password-'+n),invalid,`failure ${n} from ${attacker} gives 401`);
  check(await bucket(accountKey('owner',attacker)),10,'the account bucket is keyed by account and address');
  check(await rows(),[],'10 failures are no lockout yet');
  const before=verifications;
  check(await attempt(attacker,owner.name,owner.password),limited,'the 11th try from the same address gets 429, even with the correct password');
  check(verifications,before,'a blocked request never reaches verifyPassword');
  check(await rows(),[lockout(`login account-address user=${owner.id} address=${attacker}`)],'the first rejected try writes one auth.lockout row as System');
  check(await attempt(attacker,owner.name,'wrong-password-x'),limited,'further tries stay blocked');
  check(await attempt(attacker,owner.name,'wrong-password-y'),limited,'the 13th try too');
  check((await rows()).length,1,'further 429 answers in the window write no row');
  check(await attempt(home,owner.name,owner.password),success,'owner signs in from another address meanwhile');
  check(await attempt(attacker,other.name,other.password),success,'the attacking address can still sign in to another account');
 }

 // ---- Shared address bucket without a trusted client address ---------------------
 {
  const rows=await newLockouts();
  let n=0;const fail=async()=>{const name=`unknown-${Math.floor(n/9)}`;n++;return attempt(null,name,'wrong-password-'+n);};
  const results=[];while(n<199)results.push(await fail());
  check(results.every(r=>r.status===401&&r.code==='INVALID_CREDENTIALS'),true,'199 failures on changing names (under 10 per name) all give 401');
  check(await bucket('ip:unknown-ingress'),199,'the shared bucket counts the failures');
  check(await attempt(null,owner.name,owner.password),success,'after 199 failures owner still signs in');
  check(await bucket('ip:unknown-ingress'),199,'the success gave its reservation back');
  check(await fail(),invalid,'the 200th failure still gets checked');
  check(await attempt(null,owner.name,owner.password),limited,'after 200 failures every login without an address gets 429');
  check(await attempt(null,other.name,other.password),limited,'also for another account');
  check(await attempt('192.0.2.77',owner.name,owner.password),success,'a trusted client address is not affected');
  check(await rows(),[lockout('login address address=unknown-ingress')],'the 201st try writes one address row for unknown-ingress, none for the unknown names');
 }

 // ---- A real client address stays at 40 -------------------------------------------
 {
  const ip='192.0.2.40',rows=await newLockouts();
  for(let n=0;n<40;n++){const result=await attempt(ip,`spray-${Math.floor(n/9)}`,'wrong-password-'+n);if(result.status!==401)assert.fail(`failure ${n+1} from ${ip}: ${JSON.stringify(result)}`);}checks++;
  check(await attempt(ip,owner.name,owner.password),limited,'after 40 failures the address gets 429');
  check(await attempt('192.0.2.41',owner.name,owner.password),success,'another address is not affected');
  check(await rows(),[lockout('login address address=192.0.2.40')],'the 41st try writes one address row');
 }

 // ---- IPv6 addresses are grouped by /64, IPv4 stays per address ------------------
 {
  const keys=Object.fromEntries(['2001:db8:1:2::a','2001:0DB8:0001:0002:FFFF:0:0:b','2001:db8:1:3::a','::ffff:192.0.2.5','192.0.2.5','::1','fe80::1%eth0','1:2:3:4:5:6:1.2.3.4','not-an-ip','1::2::3'].map(ip=>[ip,auth.clientAddressKey(ip)]));
  check(keys,{'2001:db8:1:2::a':'2001:db8:1:2::/64','2001:0DB8:0001:0002:FFFF:0:0:b':'2001:db8:1:2::/64','2001:db8:1:3::a':'2001:db8:1:3::/64','::ffff:192.0.2.5':'192.0.2.5','192.0.2.5':'192.0.2.5','::1':'0:0:0:0::/64','fe80::1%eth0':'fe80:0:0:0::/64','1:2:3:4:5:6:1.2.3.4':'1:2:3:4::/64','not-an-ip':'not-an-ip','1::2::3':'1::2::3'},'IPv6 maps to its /64, IPv4 and IPv4-mapped IPv6 stay per address, other text is used as is');
  const first='2001:db8:1:2::a',neighbour='2001:db8:1:2:ffff::b',elsewhere='2001:db8:1:3::a';
  for(let n=1;n<=10;n++)check(await attempt(first,owner.name,'wrong-v6-'+n),invalid,`failure ${n} from ${first} gives 401`);
  check(await bucket(accountKey('owner','2001:db8:1:2::/64')),10,'the account bucket is keyed by the /64');
  check(await attempt(neighbour,owner.name,owner.password),limited,'another address in the same /64 shares the account bucket');
  check(await bucket('ip:2001:db8:1:2::/64'),11,'both addresses count in the /64 address bucket');
  check(await attempt(elsewhere,owner.name,owner.password),success,'a different /64 is not affected');
  for(let n=0;n<40;n++){const result=await attempt(`2001:db8:9:9::${n%2?'a':'b'}`,`spray6-${Math.floor(n/9)}`,'wrong-v6-'+n);if(result.status!==401)assert.fail(`IPv6 spray failure ${n+1}: ${JSON.stringify(result)}`);}checks++;
  check(await attempt('2001:db8:9:9::c',owner.name,owner.password),limited,'40 failures from two addresses block the whole /64');
  check(await attempt('2001:db8:9:a::c',owner.name,owner.password),success,'the next /64 is not affected');
 }

 // ---- The window runs out -------------------------------------------------------------
 {
  offset=window+1;
  check(await attempt('203.0.113.7',owner.name,owner.password),success,'the blocked account and address signs in after 10 minutes');
  check(await attempt(null,owner.name,owner.password),success,'the shared bucket opens after 10 minutes');
  check(await attempt('192.0.2.40',owner.name,owner.password),success,'the blocked address signs in after 10 minutes');
  check([await bucket(accountKey('owner','203.0.113.7')),await bucket('ip:203.0.113.7')],[0,0],'a new window starts from zero');
  const rows=await newLockouts();
  for(let n=1;n<=10;n++)check(await attempt('203.0.113.7',owner.name,'wrong-password-w'+n),invalid,`failure ${n} in the new window gives 401`);
  check(await attempt('203.0.113.7',owner.name,owner.password),limited,'the 11th try in the new window gets 429');
  check(await rows(),[lockout(`login account-address user=${owner.id} address=203.0.113.7`)],'a new lockout in a new window writes a second row with the same target');
  check((await lockouts()).filter(row=>row.target===`login account-address user=${owner.id} address=203.0.113.7`).length,2,'two rows for the pair, one per window');
 }

 // ---- 100 failures per account across all addresses ----------------------------
 {
  offset+=window+1;
  const rotating='10.1.0.1',rows=await newLockouts();
  for(let n=1;n<=10;n++)check(await attempt(rotating,target.name,'wrong-total-'+n),invalid,`failure ${n} from ${rotating} gives 401`);
  for(let n=0;n<5;n++)check(await attempt(rotating,target.name,'wrong-total-x'),limited,'the address stays blocked for this account');
  check(await bucket(totalKey('target')),10,'requests an address limit rejects do not count toward the ceiling');
  for(let n=0;n<89;n++){const result=await attempt(`10.1.${1+Math.floor(n/9)}.1`,target.name,'wrong-total-'+n);if(result.status!==401)assert.fail(`rotating failure ${n+11}: ${JSON.stringify(result)}`);}checks++;
  check(await bucket(totalKey('target')),99,'99 failures from 11 addresses count in the ceiling');
  check(await attempt('10.2.0.1',target.name,target.password),success,'after 99 failures target still signs in from a fresh address');
  check(await bucket(totalKey('target')),99,'the success gave its ceiling reservation back');
  check(await attempt('10.2.0.2',target.name,'wrong-total-100'),invalid,'the 100th failure still gets checked');
  const before=verifications;
  check(await attempt('10.2.0.3',target.name,target.password),limited,'after 100 failures a correct login from a fresh address gets 429');
  check(await attempt(null,target.name,target.password),limited,'the ceiling also applies without a trusted client address');
  check(await attempt('2001:db8:77:1::1',target.name,target.password),limited,'and from a fresh IPv6 /64');
  check(verifications,before,'a request over the ceiling never reaches verifyPassword');
  check(await attempt('10.2.0.3',other.name,other.password),success,'the ceiling is per account');
  check(await rows(),[lockout(`login account-address user=${target.id} address=${rotating}`),lockout(`login account-total user=${target.id}`)],'one row for the blocked address, one for the ceiling');
  offset+=window+1;
  check(await attempt('10.2.0.3',target.name,target.password),success,'the ceiling opens after 10 minutes');
  check(await bucket(totalKey('target')),0,'a new ceiling window starts from zero');
 }

 // ---- Parallel failures cannot pass the limit -----------------------------------------
 {
  const ip='198.51.100.50',rows=await newLockouts();
  const settled=await Promise.allSettled(Array.from({length:15},(_,n)=>attempt(ip,other.name,'wrong-password-'+n)));
  check(settled.every(r=>r.status==='fulfilled'),true,'every parallel try gives an answer');
  const values=settled.map(r=>r.value),failed=values.filter(r=>r.status===401).length,blocked=values.filter(r=>r.status===429).length;
  check(failed<=10,true,`at most 10 parallel failures reach the check (got ${failed})`);
  check(failed+blocked,15,'the rest gets 429');
  check(values.filter(r=>r.status===429).every(r=>r.code==='AUTH_RATE_LIMITED'),true,'429 carries AUTH_RATE_LIMITED');
  check(await attempt(ip,other.name,other.password),limited,'the correct password stays blocked after the burst');
  check(await rows(),[lockout(`login account-address user=${other.id} address=${ip}`)],'15 parallel failures give exactly one auth.lockout row');
 }

 // ---- rateLimit for redeem and password change counts every try ------------------------
 {
  check(typeof auth.rateLimit,'function','rateLimit is still exported');
  check(auth.rateLimit.length,2,'signature (request,account,limit=10)');
  const ip='192.0.2.90',key='account:redeem:user-1\nip:'+ip,rows=await newLockouts();
  for(let n=0;n<10;n++)await auth.rateLimit(request(ip),'redeem:user-1');
  check(await bucket(key),10,'every call counts, keyed by account and address');
  await assert.rejects(()=>auth.rateLimit(request(ip),'redeem:user-1'),error=>error instanceof HttpError&&error.status===429&&error.code==='AUTH_RATE_LIMITED'&&error.message===serverText('apiError.auth.rateLimited'));checks++;
  await auth.rateLimit(request('192.0.2.91'),'redeem:user-1');checks++;
  await auth.rateLimit(request(ip),'password:user-1',3);await auth.rateLimit(request(ip),'password:user-1',3);await auth.rateLimit(request(ip),'password:user-1',3);
  await assert.rejects(()=>auth.rateLimit(request(ip),'password:user-1',3),error=>error.status===429);checks++;
  check(await rows(),[],'redeem:user-1 and password:user-1 are no real accounts, so no account row');
  const changer='192.0.2.95';
  for(let n=0;n<10;n++)await auth.rateLimit(request(changer),'password:'+owner.id);
  await assert.rejects(()=>auth.rateLimit(request(changer),'password:'+owner.id),error=>error.status===429&&error.code==='AUTH_RATE_LIMITED');checks++;
  check(await rows(),[lockout(`password account-address user=${owner.id} address=${changer}`)],'a password change lockout names its limiter and the user id');
  // The 24-hour cleanup stays.
  await d.exec(sql`INSERT INTO local_auth_attempts(bucket,attempts,window_at,blocked_until) VALUES(${'stale'},${3},${Date.now()+offset-24*60*60_000-1},0)`);
  await auth.rateLimit(request('192.0.2.92'),'password:user-2');
  check(await d.one(sql`SELECT bucket FROM local_auth_attempts WHERE bucket='stale'`),null,'rows older than 24 hours are removed');
 }

 // ---- No account row for unknown names, no secrets in the audit -------------
 {
  const ip='192.0.2.130',secret='nobody-secret-name',rows=await newLockouts();
  for(let n=1;n<=10;n++)check(await attempt(ip,secret,'wrong-password-s'+n),invalid,`failure ${n} for an unknown name gives 401`);
  check(await attempt(ip,secret,'wrong-password-s11'),limited,'the account bucket of an unknown name still blocks the 11th try');
  check(await rows(),[],'an unknown name writes no auth.lockout row');
  const all=(await d.query(sql`SELECT actor,action,target FROM audit`)).map(row=>[row.actor,row.action,row.target].join('\n'));
  check(all.filter(text=>text.includes(secret)),[],'no audit row names the unknown typed name');
  const used=[owner.password,other.password,target.password,'wrong-password-','wrong-v6-','wrong-total-'];
  check(all.filter(text=>used.some(password=>text.includes(password))),[],'no audit row contains a password used in this test');
  check((await lockouts()).every(row=>/^(login|redeem|password) (account-address user=\S+ address=\S+|address address=\S+|account-total user=\S+)$/.test(row.target)),true,'every auth.lockout target has one of the three formats');
 }
 console.log(`PASS login lockout (${checks} assertions): only failures count, account bucket per address, 40 per address and 200 shared, 100 per account across addresses, IPv6 by /64, window expiry, race-safe reservation, rateLimit unchanged for its callers, own login: key space, one auth.lockout row per limit and window without secrets.`);
}finally{d.close();}
