// The shared fixture of the device assistant tests on PostgreSQL: the real
// routes app/api/assistant/route.ts and app/api/assistant/settings/route.ts
// with lib/server/devices/assistant*.ts, lib/server/identity/access.ts, lib/server/identity/rbac.ts, lib/server/audit.ts and the
// console reads, a server stub with the real failure() body, an MFA stub with
// a real keyring and step-up proofs as rows, actors, devices with a snapshot,
// customers and the customer separation, and the fake provider hosts.
import crypto from 'node:crypto';
import {HttpError} from './http-error.mjs';
import {sourceDatabase,sourceLoader,sourceActor,insertRow} from './source-database.mjs';
import {sql} from '../../runtime/database.mjs';
import {createKeyring,decryptWithKeyring,encryptWithKeyring} from '../../runtime/secret-keyring.mjs';
import {fakeAssistantProviders,assistantOptions} from './fake-assistant-providers.mjs';
import {enableMultipleCustomers,separateCustomers as separationStatement} from './customer-separation.mjs';
const {classifyFailure}=await import('../../lib/server/errors/failure.ts');
// The one HttpError class of classifyFailure, also for the domain modules that import it directly (lib/server/devices/jobs/queue.ts).
const httpErrorModule=await import('../../lib/errors/http-error.ts');

export const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const day=86_400_000;

export async function assistantFixture({secret='assistant-session-secret-for-tests-0000000001'}={}){
 const d=await sourceDatabase();
 const state={viewer:null,ring:createKeyring({SESSION_SECRET:secret}),clock:0,mfaMissing:false};
 const load=sourceLoader();
 const server={db:()=>d,now:()=>Date.now()+state.clock,config:key=>key==='SITE_ORIGIN'?'https://portal.example.test':'',random:()=>crypto.randomBytes(32).toString('hex'),hash:async value=>sha(value),HttpError,
  guid:x=>typeof x==='string'&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(x),body:async request=>request.json(),sameOrigin:()=>{},
  requireViewer:async()=>state.viewer,log:async()=>{throw new Error('log() is not used');},
  failure:error=>{const answer=classifyFailure(error);return Response.json(answer.body,{status:answer.status,headers:{'Cache-Control':'no-store'}});}};
 const localAuth={primaryGuard:async(_request,actor)=>load('lib/server/identity/access.ts').viewerWriteGuard(actor)};
 // requireMfa answers like lib/server/identity/mfa.ts without a fresh MFA session while state.mfaMissing is set.
 const mfa={requireLiveSessions:async()=>{},requireMfa:async()=>{if(state.mfaMissing)throw new HttpError('apiError.mfa.loginRequired');},isMfaEnabled:async()=>true,
  mfaSessionFence:async(_request,who)=>sql`EXISTS (SELECT 1 FROM mfa_sessions WHERE token_hash=${sha(who.id+'mfa')} AND principal=${who.principal})`,
  encryptSecret:(value,context)=>encryptWithKeyring(state.ring,value,context),
  decryptSecret:async(value,context)=>{try{return await decryptWithKeyring(state.ring,value,context);}catch{throw new HttpError('apiError.mfa.secretUndecryptable');}},
  // Like lib/server/identity/mfa.ts: a missing or expired proof is refused before the commit.
  readMfaManagementProof:async(_request,who,value)=>{
   const live=typeof value==='string'&&await d.one(sql`SELECT 1 AS live FROM mfa_management_proofs WHERE token_hash=${value} AND principal=${who.principal} AND expires_at>${Date.now()}`);
   if(!live)throw new HttpError('apiError.mfa.stepUpRequired');
   return {tokenHash:value,key:who.principal,sessionHash:sha(who.id+'mfa'),guard:sql`TRUE`};
  }};
 const imports={'../context':server,'./context':server,'../../context':server,'@/lib/server/context':server,'../identity/mfa':mfa,'./mfa':mfa,'@/lib/server/identity/mfa':mfa,'./local-auth':localAuth,'@/lib/server/identity/local-auth':localAuth,'../../errors/http-error':httpErrorModule,'./errors/http-error':httpErrorModule,'../../../errors/http-error':httpErrorModule};
 const access=load('lib/server/identity/access.ts',imports);
 const settingsRoute=load('app/api/assistant/settings/route.ts',imports),askRoute=load('app/api/assistant/route.ts',imports);
 const provider=load('lib/server/devices/assistant-provider.ts',imports);
 const fake=await fakeAssistantProviders();
 provider.useAssistantTransportOptions(assistantOptions(fake.port));
 const time=Date.now();

 /** A local account with a role on a scope and a live MFA session. */
 const actor=async(label,permissions,scopeType='global',scopeId='*')=>{
  const {actor:value}=await sourceActor(d,label,permissions,scopeType,scopeId);value.userId=value.id;
  await insertRow(d,'mfa_sessions',{token_hash:sha(value.id+'mfa'),principal:value.principal,created_at:time,last_activity:time,idle_expires_at:time+day,expires_at:time+day});
  return value;
 };
 const token=async who=>{const value=crypto.randomUUID();await insertRow(d,'mfa_management_proofs',{token_hash:value,principal:who.principal,session_hash:sha(who.id+'mfa'),expires_at:Date.now()+300_000});return value;};
 const answer=async response=>({status:response.status,cache:response.headers.get('Cache-Control'),body:await response.json()});
 const settings={
  get:async as=>{state.viewer=as;return answer(await settingsRoute.GET());},
  post:async(as,payload)=>{state.viewer=as;return answer(await settingsRoute.POST(new Request('https://portal.example.test/api/assistant/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})));},
  // With a fresh step-up proof.
  change:async(as,payload)=>settings.post(as,{...payload,managementToken:await token(as)}),
 };
 const assistant={
  status:async(as,serverId)=>{state.viewer=as;return answer(await askRoute.GET(new Request(`https://portal.example.test/api/assistant?serverId=${encodeURIComponent(serverId)}`)));},
  ask:async(as,payload)=>{state.viewer=as;return answer(await askRoute.POST(new Request('https://portal.example.test/api/assistant',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'ask',...payload})})));},
  // A command after the user's click, and the state of one own job.
  run:async(as,payload)=>{state.viewer=as;return answer(await askRoute.POST(new Request('https://portal.example.test/api/assistant',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'run',...payload})})));},
  job:async(as,serverId,jobId)=>{state.viewer=as;return answer(await askRoute.GET(new Request(`https://portal.example.test/api/assistant?serverId=${encodeURIComponent(serverId)}&jobId=${encodeURIComponent(jobId)}`)));},
 };
 const customer=async(name,status='active')=>{const id=crypto.randomUUID();await insertRow(d,'customers',{id,name,status,created_at:time,updated_at:time});return id;};
 const separateCustomers=async()=>{await d.exec(enableMultipleCustomers());await d.exec(separationStatement(time));};
 const assign=(customerId,who)=>insertRow(d,'customer_assignments',{customer_id:customerId,principal_type:'user',principal_id:who.id,created_at:time,created_by:'test'});
 /** A device with a snapshot; lastSeen null means it never reported; management 1 with a Management snapshot is a managed agent. */
 const device=async({name='SRV-01',customerId,snapshot=baseSnapshot(),lastSeen=time,revoked=0,management=0}={})=>{
  const id=crypto.randomUUID();
  await insertRow(d,'servers',{id,name,token_hash:sha(id),created_at:time,last_seen:lastSeen,snapshot:snapshot?JSON.stringify(snapshot):null,revoked,management,...(customerId?{customer_id:customerId}:{})});
  return id;
 };
 const audits=(pattern='assistant.%')=>d.query(sql`SELECT action,target,scope,server_id AS "serverId",customer_id AS "customerId" FROM audit WHERE action LIKE ${pattern} ORDER BY id`);
 const keys=()=>d.query(sql`SELECT * FROM assistant_keys ORDER BY scope,id`);
 const decrypt=(value,context)=>decryptWithKeyring(state.ring,value,context);
 return {d,load,imports,access,state,fake,provider,actor,token,settings,assistant,customer,separateCustomers,assign,device,audits,keys,decrypt,time,
  close:async()=>{await fake.close();await d.close();}};
}

/** A small snapshot of a protocol 3 agent with a few entries in each list. */
export function baseSnapshot(extra={}){
 return {hostname:'SRV-01',os:'Microsoft Windows Server 2022 Standard',build:'20348',manufacturer:'Contoso',model:'VM-1',domain:'corp.example',cores:4,memoryGb:16,cpu:12,memory:48,uptimeSeconds:3600,rebootPending:true,rebootReasons:['windows-update'],management:false,
  disks:[{name:'C:',label:'System',totalGb:120,freeGb:30}],
  services:[{name:'Spooler',displayName:'Print Spooler',status:'Stopped',startMode:'Auto'},{name:'W32Time',displayName:'Windows Time',status:'Running',startMode:'Auto'}],
  processes:[{name:'sqlservr',pid:100,memoryMb:900,cpuSeconds:50,user:'NT SERVICE\\MSSQLSERVER',path:'C:\\Program Files\\SQL\\sqlservr.exe'},{name:'explorer',pid:200,memoryMb:80,cpuSeconds:3,user:'CORP\\anna',path:'C:\\Windows\\explorer.exe'}],
  processInventory:{collectedAt:'2026-11-05T08:00:00Z',count:2,truncated:false,complete:true,intervalSeconds:300},
  events:[{id:7031,level:'Error',source:'Service Control Manager',message:'The Print Spooler service terminated unexpectedly.',at:'2026-11-05T07:00:00Z'},{id:1014,level:'Warning',source:'DNS Client',message:'Name resolution timed out.',at:'2026-11-05T06:00:00Z'}],
  networks:[{name:'Ethernet',addresses:['10.0.0.5'],mac:'00-11-22-33-44-55',speedMbps:1000}],
  hotfixes:[{id:'KB5030216',installedOn:'2026-10-10'}],collectionErrors:[],
  protocolVersion:3,agentVersion:'4.14.0',mode:'ReadOnly',agentCapabilities:['refresh'],
  publicKey:{kty:'RSA',n:'PUBLIC-KEY-N-VALUE',e:'AQAB'},
  updates:{checkedAt:'2026-11-05T05:00:00Z',pendingCount:1,items:[{id:'u1',title:'2026-11 Cumulative Update',kb:'KB5040000',severity:'Critical',rebootRequired:true}]},
  defender:{available:true,collectedAt:'2026-11-05T05:00:00Z',mode:'normal',antivirusEnabled:true,realTimeProtection:true,tamperProtected:true,quickScanAt:null,fullScanAt:null,signatureAt:null,signatureVersion:null,productVersion:null,otherAntivirus:null,detectionCount:1,activeCount:1,highestActiveSeverity:'high',truncated:false,
   detections:[{id:'d1',threatId:'t1',name:'Trojan:Win32/Test',severity:'high',status:'detected',active:true,path:'C:\\Users\\anna\\evil.exe',resourceCount:1,at:null,user:'CORP\\anna'}],exclusions:{paths:['C:\\Secret'],extensions:[],processes:[]}},
  tasks:[{name:'Backup',path:'\\Backup',state:'Ready',lastRun:'2026-11-04T22:00:00Z',nextRun:'2026-11-05T22:00:00Z',lastResult:0}],
  ...extra};
}
