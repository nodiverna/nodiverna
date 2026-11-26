// Registration tokens expire (7 days personal, 24 hours installer) until an
// agent connects, and a token without expiry is admitted nowhere: such
// a device needs a new registration. Runs the real token SQL, heartbeat, channel
// gate, challenge and renewal routes against an isolated PostgreSQL test database.
import {serverText} from '../support/server-text.mjs';
import {HttpError as realHttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';
import {sourceDatabase,sourceLoader} from '../support/source-database.mjs';
import {sql} from '../../runtime/database.mjs';
const d=await sourceDatabase();
let assertions=0;
const check=(actual,expected,message)=>{assert.equal(actual,expected,message);assertions++;};
try{
 const origin='https://serverdesk.test',sha=value=>nodeCrypto.createHash('sha256').update(value).digest('hex'),day=86400000;
 let clock=Date.parse('2026-10-19T08:00:00.000Z');
 const HttpError=realHttpError;
 const server={db:()=>d,config:key=>({SITE_ORIGIN:origin,SESSION_SECRET:'isolated-registration-expiry-secret-'.repeat(3)})[key]??'',now:()=>clock,guid:value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value),hash:async value=>sha(value),random:()=>nodeCrypto.randomBytes(32).toString('hex'),body:request=>request.json(),HttpError,failure:error=>Response.json({error:error.message,...(error.code?{code:error.code}:{})},{status:error.status??503}),requireViewer:async()=>{throw new HttpError(401,'Anmeldung erforderlich.');}};
 const load=sourceLoader();
 const tokens=load('lib/server/agent/device-tokens.ts',{'../context':server});
 const v3=load('lib/server/agent/agent-protocol.ts',{'cloudflare:workers':{env:{}},'../context':server,'./device-tokens':tokens});
 const challengeApi=load('app/api/agent/token/challenge/route.ts',{'@/lib/server/context':server,'@/lib/server/agent/device-tokens':tokens});
 const renewalApi=load('app/api/agent/token/renew/route.ts',{'@/lib/server/context':server,'@/lib/server/agent/device-tokens':tokens});
 const heartbeat=load('app/api/heartbeat/route.ts',{'@/lib/server/context':server,'@/lib/server/agent/telemetry':load('lib/server/agent/telemetry.ts'),'@/lib/server/agent/device-tokens':tokens});
 const expiredMessage=serverText('apiError.deviceToken.registrationExpired');

 check(tokens.PERSONAL_REGISTRATION_LIFETIME,7*24*60*60*1000,'personal registration lifetime');
 check(tokens.INSTALLER_REGISTRATION_LIFETIME,24*60*60*1000,'installer registration lifetime');

 const agentKey=()=>{const {privateKey,publicKey}=nodeCrypto.generateKeyPairSync('rsa',{modulusLength:2048}),jwk=publicKey.export({format:'jwk'});return {privateKey,jwk,pinned:JSON.stringify({kty:jwk.kty,n:jwk.n,e:jwk.e})};};
 const device=async({name,created=clock,expiresAt=null,key=null})=>{
  const id=nodeCrypto.randomUUID(),token=nodeCrypto.randomBytes(32).toString('hex');
  await d.exec(sql`INSERT INTO servers(id,name,token_hash,created_at,token_expires_at,agent_public_key) VALUES (${id},${name},${sha(token)},${created},${expiresAt},${key?.pinned??null})`);
  return {id,token,key};
 };
 const row=id=>d.one(sql`SELECT token_hash,token_expires_at,agent_public_key,last_seen,snapshot FROM servers WHERE id=${id}`);
 const samples=async id=>(await d.one(sql`SELECT count(*) AS n FROM samples WHERE server_id=${id}`)).n;
 const snapshot=key=>({hostname:'VM',os:'Microsoft Windows Server 2025 Standard',build:'26100',manufacturer:'Microsoft',model:'VM',domain:'WORKGROUP',cores:4,memoryGb:8,cpu:10,memory:20,uptimeSeconds:300,rebootPending:false,management:true,disks:[],services:[],processes:[],events:[],networks:[],hotfixes:[],collectionErrors:[],protocolVersion:3,agentVersion:'4.6.7',mode:'Management',publicKey:{kty:'RSA',n:key.jwk.n,e:key.jwk.e},agentCapabilities:['refresh']});
 const beat=(serverId,token,key)=>heartbeat.POST(new Request(origin+'/api/heartbeat',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({serverId,snapshot:snapshot(key),results:[]})}));
 const channel=(serverId,token)=>v3.agent(new Request(origin+'/api/agent/channel',{headers:{Authorization:'Bearer '+token}}),serverId,{allowTokenRetry:true});
 const post=(path,payload)=>new Request(origin+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
 const challenge=serverId=>challengeApi.POST(post('/api/agent/token/challenge',{serverId}));
 const rotate=async(serverId,key)=>{
  const issued=await challenge(serverId);check(issued.status,200,'challenge issued for a pinned key');const value=await issued.json();
  const response=await renewalApi.POST(post('/api/agent/token/renew',{serverId:value.serverId,challengeId:value.challengeId,nonce:value.nonce,expiresAt:value.expiresAt,proof:value.proof,signature:nodeCrypto.sign('RSA-SHA256',Buffer.from(value.message),key.privateKey).toString('base64')}));
  check(response.status,200,'renewal issues a key-bound token');const renewed=await response.json();check(renewed.tokenMode,'key-bound');return renewed.token;
 };
 const rejected=async(fn,code,message)=>{await assert.rejects(fn,error=>error.status===403&&error.code===code&&(message===undefined||error.message===message));assertions++;};
 const refused=async(response,code,message)=>{check(response.status,403);const body=await response.json();check(body.code,code);if(message)check(body.error,message);};

 // Expired personal registration: rejected everywhere, nothing written, and
 // only the holder of the exact token learns that it expired.
 {
  const key=agentKey(),created=clock,expiry=created+tokens.PERSONAL_REGISTRATION_LIFETIME;
  const expired=await device({name:'Expired personal',created,expiresAt:expiry}),boundary=await device({name:'Boundary personal',created,expiresAt:expiry});
  clock=expiry-1;
  check((await beat(boundary.id,boundary.token,key)).status,200,'one millisecond before expiry the registration still connects');
  check((await row(boundary.id)).agent_public_key,key.pinned,'first heartbeat pins the key');
  clock=expiry;
  await refused(await beat(expired.id,expired.token,key),'DEVICE_REGISTRATION_EXPIRED',expiredMessage);
  const after=await row(expired.id);
  check(after.agent_public_key,null,'expired registration cannot pin a key');check(after.last_seen,null);check(after.snapshot,null);check(await samples(expired.id),0);
  await rejected(()=>channel(expired.id,expired.token),'DEVICE_REGISTRATION_EXPIRED',expiredMessage);
  let response=await challenge(expired.id);check(response.status,409);check((await response.json()).code,'DEVICE_KEY_REQUIRED','expired registration cannot obtain a key proof');
  const wrong='c'.repeat(64);
  response=await beat(expired.id,wrong,key);check(response.status,403);const body=await response.json();check(body.error,serverText('apiError.agent.notApproved'));check(body.code,'FORBIDDEN','a wrong bearer learns nothing about the registration');
  await rejected(()=>channel(expired.id,wrong),'FORBIDDEN',serverText('apiError.agent.notApproved'));
  check((await row(expired.id)).last_seen,null,'still nothing written');
 }

 // Customer-installer registration: the same rules at the 24-hour boundary.
 {
  const key=agentKey(),created=clock,expiry=created+tokens.INSTALLER_REGISTRATION_LIFETIME;
  const expired=await device({name:'Expired installer',created,expiresAt:expiry}),boundary=await device({name:'Boundary installer',created,expiresAt:expiry});
  clock=expiry-1;
  check((await beat(boundary.id,boundary.token,key)).status,200,'installer registration connects until its last millisecond');
  check((await channel(expired.id,expired.token)).id,expired.id,'installer registration admits the channel before expiry');
  clock=expiry;
  await refused(await beat(expired.id,expired.token,key),'DEVICE_REGISTRATION_EXPIRED',expiredMessage);
  check((await row(expired.id)).agent_public_key,null);check(await samples(expired.id),0);
  await rejected(()=>channel(expired.id,expired.token),'DEVICE_REGISTRATION_EXPIRED');
  check((await challenge(expired.id)).status,409);
 }

 // A device whose token never expires (NULL expiry, pinned or not) is rejected
 // on the heartbeat, the channel and the key proof, and nothing is written.
 {
  const key=agentKey(),pinned=await device({name:'Pinned without expiry',created:clock-400*day,key});
  const before=await row(pinned.id),count=await samples(pinned.id);
  await refused(await beat(pinned.id,pinned.token,key),'DEVICE_TOKEN_REJECTED',serverText('apiError.agent.notApproved'));
  await rejected(()=>channel(pinned.id,pinned.token),'DEVICE_TOKEN_REJECTED',serverText('apiError.agent.notApproved'));
  await assert.rejects(()=>v3.agent(new Request(origin+'/api/agent/channel',{headers:{Authorization:'Bearer '+pinned.token}}),pinned.id),error=>error.status===403&&error.code==='FORBIDDEN');assertions++;
  let response=await challenge(pinned.id);check(response.status,403,'no key proof for a token without expiry');check((await response.json()).error,serverText('apiError.agent.notApproved'));
  const after=await row(pinned.id);check(after.token_hash,before.token_hash,'rejected requests write nothing');check(after.last_seen,before.last_seen);check(after.snapshot,before.snapshot);check(await samples(pinned.id),count);
  const unpinned=await device({name:'Unpinned without expiry',created:clock-400*day});
  response=await beat(unpinned.id,unpinned.token,key);check(response.status,403);check((await response.json()).code,'FORBIDDEN','an unpinned device gets no retry code');
  check((await row(unpinned.id)).agent_public_key,null,'a token without expiry cannot pin a key');check(await samples(unpinned.id),0);
  await rejected(()=>channel(unpinned.id,unpinned.token),'FORBIDDEN',serverText('apiError.agent.notApproved'));
  check((await challenge(unpinned.id)).status,403);
 }

 // A fresh 4.6+ agent on a new personal registration.
 {
  const key=agentKey(),created=clock,registration=await device({name:'New agent',created,expiresAt:created+tokens.PERSONAL_REGISTRATION_LIFETIME});
  clock+=60000;
  const response=await challenge(registration.id);check(response.status,409);check((await response.json()).code,'DEVICE_KEY_REQUIRED','key proof waits for the first heartbeat');
  check((await beat(registration.id,registration.token,key)).status,200,'(b) first heartbeat succeeds');
  check((await row(registration.id)).agent_public_key,key.pinned,'(b) and pins the key');
  check((await channel(registration.id,registration.token)).id,registration.id,'(c) registration token still opens the channel after pinning');
  const first=await rotate(registration.id,key);
  check((await channel(registration.id,first)).id,registration.id,'(d) channel accepts the key-bound token');
  clock+=15*60*1000;
  await rejected(()=>channel(registration.id,first),'DEVICE_TOKEN_REJECTED');
  await rejected(()=>channel(registration.id,registration.token),'DEVICE_TOKEN_REJECTED');
  const second=await rotate(registration.id,key);
  check((await channel(registration.id,second)).id,registration.id,'(e) a new key proof recovers after expiry');
  clock+=8*day;
  check(clock>created+tokens.PERSONAL_REGISTRATION_LIFETIME,true);
  const third=await rotate(registration.id,key);
  check((await channel(registration.id,third)).id,registration.id,'(f) key proof works long after the registration lifetime');
  await rejected(()=>channel(registration.id,registration.token),'DEVICE_TOKEN_REJECTED');
 }

 console.log(`PASS registration token expiry: ${assertions} assertions for 7-day and 24-hour registration expiry, DEVICE_REGISTRATION_EXPIRED only for the token holder, no admission for tokens without expiry, retry codes only with a pinned key, and the full 4.6+ agent sequence.`);
}finally{d.close();}
