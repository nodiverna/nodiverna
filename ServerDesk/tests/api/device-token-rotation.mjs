// Execute the production token proof and SQL against an isolated PostgreSQL test database, including
// replay/concurrent redemption and an offboarding race after signature checks.
// Every token expires; a token without expiry is admitted nowhere.
import {HttpError as realHttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';
import {sourceDatabase,sourceLoader} from '../support/source-database.mjs';

import {sql} from '../../runtime/database.mjs';
import {hookDatabase} from '../support/hooked-database.mjs';
const d=await sourceDatabase();
let assertions=0;
const check=(actual,expected,message)=>{assert.equal(actual,expected,message);assertions++;};
try{
 const origin='https://serverdesk.test',sha=value=>nodeCrypto.createHash('sha256').update(value).digest('hex');
 let clock=Date.now(),database=d,batchHook=async()=>{};
 const HttpError=realHttpError;
 const server={db:()=>database,config:key=>({SITE_ORIGIN:origin,SESSION_SECRET:'isolated-device-token-proof-secret-'.repeat(3)})[key]??'',now:()=>clock,guid:value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value),hash:async value=>sha(value),random:()=>nodeCrypto.randomBytes(32).toString('hex'),body:request=>request.json(),HttpError,failure:error=>Response.json({error:error.message,...(error.code?{code:error.code}:{})},{status:error.status??503})};
 const load=sourceLoader();
 const tokens=load('lib/server/agent/device-tokens.ts',{'../context':server});
 const v3=load('lib/server/agent/agent-protocol.ts',{'cloudflare:workers':{env:{}},'../context':server,'./device-tokens':tokens});
 const challengeApi=load('app/api/agent/token/challenge/route.ts',{'@/lib/server/context':server,'@/lib/server/agent/device-tokens':tokens});
 const renewalApi=load('app/api/agent/token/renew/route.ts',{'@/lib/server/context':server,'@/lib/server/agent/device-tokens':tokens});
 const heartbeat=load('app/api/heartbeat/route.ts',{'@/lib/server/context':server,'@/lib/server/agent/telemetry':load('lib/server/agent/telemetry.ts'),'@/lib/server/agent/device-tokens':tokens});
 const {privateKey,publicKey}=nodeCrypto.generateKeyPairSync('rsa',{modulusLength:2048}),jwk=publicKey.export({format:'jwk'}),pinned=JSON.stringify({kty:jwk.kty,n:jwk.n,e:jwk.e});
 const id=nodeCrypto.randomUUID(),otherId=nodeCrypto.randomUUID(),unlimitedId=nodeCrypto.randomUUID(),registration='a'.repeat(64),unlimited='c'.repeat(64),day=86400000;
 await d.exec(sql`INSERT INTO servers(id,name,token_hash,created_at,token_expires_at) VALUES (${id},${'Token fixture'},${sha(registration)},${clock},${clock+7*day})`);
 await d.exec(sql`INSERT INTO servers(id,name,token_hash,created_at,token_expires_at) VALUES (${otherId},${'Unpinned registration'},${sha('b'.repeat(64))},${clock},${clock+7*day})`);
 await d.exec(sql`INSERT INTO servers(id,name,token_hash,created_at,agent_public_key) VALUES (${unlimitedId},${'Pinned without expiry'},${sha(unlimited)},${clock},${pinned})`);
 const post=(path,payload)=>new Request(origin+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
 const challenge=async(serverId=id)=>{const response=await challengeApi.POST(post('/api/agent/token/challenge',{serverId}));check(response.status,200,'pinned key challenge issued');check(response.headers.get('cache-control'),'no-store');assert.ok(response.headers.get('date'));assertions++;return response.json();};
 const payload=(value,changes={})=>({serverId:value.serverId,challengeId:value.challengeId,nonce:value.nonce,expiresAt:value.expiresAt,proof:value.proof,signature:nodeCrypto.sign('RSA-SHA256',Buffer.from(value.message),privateKey).toString('base64'),...changes});
 const renew=(value,changes={})=>renewalApi.POST(post('/api/agent/token/renew',payload(value,changes)));
 const authenticate=async(token,serverId=id)=>v3.agent(new Request(origin+'/api/agent/channel',{headers:{Authorization:'Bearer '+token}}),serverId,{allowTokenRetry:true});
 const rejected=async(fn,status,code)=>{await assert.rejects(fn,error=>error.status===status&&(code===undefined||error.code===code));assertions++;};
 const snapshot={hostname:'VM',os:'Microsoft Windows Server 2025 Standard',build:'26100',manufacturer:'Microsoft',model:'VM',domain:'WORKGROUP',cores:4,memoryGb:8,cpu:10,memory:20,uptimeSeconds:300,rebootPending:false,management:true,disks:[],services:[],processes:[],events:[],networks:[],hotfixes:[],collectionErrors:[],protocolVersion:3,agentVersion:'4.6.0',mode:'Management',publicKey:{kty:'RSA',n:jwk.n,e:jwk.e},agentCapabilities:['refresh']};
 const beat=(token,serverId=id)=>heartbeat.POST(new Request(origin+'/api/heartbeat',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({serverId,snapshot,results:[]})}));
 // A device whose token never expires is rejected on the channel, the
 // heartbeat and the key proof, and nothing is written; it needs a new registration.
 await rejected(()=>authenticate(unlimited,unlimitedId),403,'DEVICE_TOKEN_REJECTED');
 let response=await beat(unlimited,unlimitedId);check(response.status,403);check((await response.json()).code,'DEVICE_TOKEN_REJECTED','the heartbeat rejects a token without expiry too');
 response=await challengeApi.POST(post('/api/agent/token/challenge',{serverId:unlimitedId}));check(response.status,403,'no key proof for a token without expiry');
 check((await d.one(sql`SELECT count(*) AS n FROM samples`)).n,0,'rejected requests write nothing');
 check((await d.one(sql`SELECT last_seen FROM servers WHERE id=${unlimitedId}`)).last_seen,null);
 // The registration token makes the first heartbeat and pins the key.
 check((await beat(registration)).status,200,'the registration token makes the first heartbeat');
 check((await d.one(sql`SELECT agent_public_key FROM servers WHERE id=${id}`)).agent_public_key,pinned,'the first heartbeat pins the key');
 check((await d.one(sql`SELECT count(*) AS n FROM samples`)).n,1);
 clock+=10000;
 check((await challengeApi.POST(post('/api/agent/token/challenge',{serverId:otherId}))).status,409,'unpinned key cannot renew');
 check((await challengeApi.POST(post('/api/agent/token/challenge',{serverId:'invalid'}))).status,400);
 const first=await challenge(),concurrentChallenge=await challenge();
 check((await d.one(sql`SELECT count(*) AS n FROM device_token_nonces`)).n,0,'anonymous challenges allocate no database rows');
 check(first.message,['ServerDesk device access token v1',origin,id,first.challengeId,first.nonce,first.expiresAt].join('\n'),'proof is bound to portal origin, device, purpose, nonce and expiry');
 const wrongKey=nodeCrypto.generateKeyPairSync('rsa',{modulusLength:2048}).privateKey;
 check((await renew(first,{signature:nodeCrypto.sign('RSA-SHA256',Buffer.from(first.message),wrongKey).toString('base64')})).status,403,'stolen bearer cannot replace RSA possession');
 check((await renew(first,{signature:nodeCrypto.sign('RSA-SHA256',Buffer.from(first.message.replace(origin,'https://attacker.test')),privateKey).toString('base64')})).status,403,'cross-origin signature rejected');
 check((await renew(first,{serverId:otherId})).status,409,'device substitution rejected');
 check((await renew(first,{nonce:nodeCrypto.randomBytes(32).toString('base64url')})).status,409,'nonce substitution rejected');
 check((await renew(first,{proof:nodeCrypto.randomBytes(32).toString('base64url')})).status,409,'fabricated server challenge rejected');
 check((await renew(first,{expiresAt:first.expiresAt+300})).status,409,'expiry extension rejected');
 check((await d.one(sql`SELECT token_hash FROM servers WHERE id=${id}`)).token_hash,sha(registration),'invalid proofs cannot rotate credentials');
 response=await renew(first);check(response.status,200);check(response.headers.get('cache-control'),'no-store');assert.ok(response.headers.get('date'));assertions++;
 const migrated=await response.json();check(migrated.expiresIn,900);check(migrated.tokenMode,'key-bound');check(Date.parse(migrated.expiresAt),clock+15*60*1000);
 const row=await d.one(sql`SELECT token_hash,token_expires_at,previous_token_hash,previous_token_expires_at FROM servers WHERE id=${id}`);
 check(row.token_hash,sha(migrated.token),'only token hash persisted');check(row.previous_token_hash,sha(registration));check(row.previous_token_expires_at,clock+2*60*1000,'the overlap is two minutes, before the old expiry');
 check((await authenticate(migrated.token)).id,id);check((await authenticate(registration)).id,id,'in-flight requests with the old token retain a bounded overlap');
 check((await renew(first)).status,409,'redeemed challenge cannot be replayed');
 check((await renew(concurrentChallenge)).status,409,'challenge from the old generation cannot supersede a new token');
 clock+=2*60*1000;
 await rejected(()=>authenticate(registration),403,'DEVICE_TOKEN_REJECTED');
 await assert.rejects(()=>v3.agent(new Request(origin+'/api/agent/channel',{headers:{Authorization:'Bearer '+registration}}),id),error=>error.status===403&&error.code==='FORBIDDEN');assertions++;
 check((await authenticate(migrated.token)).id,id);
 response=await beat(registration);check(response.status,403);check((await response.json()).code,'DEVICE_TOKEN_REJECTED');check((await d.one(sql`SELECT count(*) AS n FROM samples`)).n,1,'retry code is returned before heartbeat writes');
 check((await beat(migrated.token)).status,200,'new token supports telemetry');
 clock=Date.parse(migrated.expiresAt);
 await rejected(()=>authenticate(migrated.token),403,'DEVICE_TOKEN_REJECTED');
 response=await beat(migrated.token);check(response.status,403);check((await response.json()).code,'DEVICE_TOKEN_REJECTED');check((await d.one(sql`SELECT count(*) AS n FROM samples`)).n,2,'expired heartbeat cannot add telemetry');
 clock+=100*86400000;
 const offline=await challenge();response=await renew(offline);check(response.status,200,'durable key recovers a device after a long offline interval without a valid bearer');
 const recovered=await response.json();check((await authenticate(recovered.token)).id,id);
 const afterLostResponse=await challenge();response=await renew(afterLostResponse);check(response.status,200);await response.body.cancel();
 const fresh=await challenge();response=await renew(fresh);check(response.status,200,'lost issuance response is recovered with a fresh proof');const live=await response.json();check((await authenticate(live.token)).id,id);
 const expired=await challenge();clock=expired.expiresAt*1000;check((await renew(expired)).status,409,'expired challenge rejected');
 const racing=await challenge();const race=await Promise.all(Array.from({length:8},()=>renew(racing)));check(race.filter(result=>result.status===200).length,1,'concurrent redemption accepts one proof exactly once');check(race.filter(result=>result.status===409).length,7);
 for(const result of race)await result.body?.cancel();
 const keyChanged=await challenge();await d.exec(sql`UPDATE servers SET agent_public_key=${JSON.stringify(nodeCrypto.generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({format:'jwk'}))} WHERE id=${id}`);check((await renew(keyChanged)).status,409,'proof is invalid after the pinned key changes');await d.exec(sql`UPDATE servers SET agent_public_key=${pinned} WHERE id=${id}`);
 // The overlap never outlives the old token's own expiry.
 {const shortId=nodeCrypto.randomUUID(),shortToken='d'.repeat(64),oldExpiry=clock+30000;
  await d.exec(sql`INSERT INTO servers(id,name,token_hash,created_at,token_expires_at,agent_public_key) VALUES (${shortId},${'Short overlap'},${sha(shortToken)},${clock},${oldExpiry},${pinned})`);
  const proof=await challenge(shortId);response=await renew(proof);check(response.status,200);await response.body.cancel();
  check((await d.one(sql`SELECT previous_token_expires_at FROM servers WHERE id=${shortId}`)).previous_token_expires_at,oldExpiry,'renewal sets the overlap to min(old expiry, now + 2 minutes)');}
 const offboarding=await challenge(),before=await d.one(sql`SELECT token_hash FROM servers WHERE id=${id}`);
 database=hookDatabase(d,{transaction:()=>batchHook()});
 batchHook=()=>d.exec(sql`UPDATE servers SET revoked=1 WHERE id=${id}`);
 check((await renew(offboarding)).status,409,'revocation after signature verification prevents issuance atomically');
 check((await d.one(sql`SELECT token_hash FROM servers WHERE id=${id}`)).token_hash,before.token_hash,'offboarding race cannot partially rotate the token');
 check((await challengeApi.POST(post('/api/agent/token/challenge',{serverId:id}))).status,403,'revoked device cannot renew');
 await rejected(()=>authenticate(live.token),403);
 check((await d.one(sql`SELECT count(*) AS n FROM device_token_nonces WHERE expires_at<=${clock}`)).n,0,'redeemed nonce records are pruned after replay window');
 check((await d.one(sql`SELECT token_hash,token_expires_at FROM servers WHERE id=${unlimitedId}`)).token_hash,sha(unlimited),'the rejected device keeps its row unchanged');
 console.log(`PASS device token rotation: ${assertions} assertions for no admission without expiry, pinning by the registration token, 15-minute expiry, two-minute overlap, RSA proof binding, stateless challenges, replay/concurrency, long-offline and lost-response recovery, pinned-key changes, and atomic revocation.`);
}finally{d.close();}
