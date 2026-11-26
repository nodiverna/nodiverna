// AD sign-ins for plugin changes on PostgreSQL (POST/GET /api/plugin-ad,
// lib/server/extensions/plugin-ad-sessions.ts, the ad-sign-in results and the claim guard of
// lib/server/agent/agent-channel.ts, docs/plugin-ad-sign-in.md): a sign-in queues one job
// with the password sealed to the device key and one pending row, and the
// password is in no table in plain text; every refusal writes nothing; five
// failed sign-ins block the next; an ok result turns the row active with its
// audit row, a failure or a directory from elsewhere leaves no row, a late
// result creates nothing; a second sign-in replaces the first; GET lists only
// the sign-ins of the request's portal session; sign-out writes its audit row;
// a deleted portal session takes its sign-ins along; the Entra hook opens a
// session that matches a device of its domain; a plugin change is delivered
// only while its sign-in lives. Real libraries run against an isolated database.
import {HttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {z} from 'zod';
import {sourceDatabase,sourceLoader,sourceActor,insertRow} from '../support/source-database.mjs';
import {sessionHeaders} from '../support/session-cookies.mjs';
import {sql} from '../../runtime/database.mjs';

const d=await sourceDatabase();
let checks=0;
const check=(value,expected,label)=>{assert.deepEqual(value,expected,label);checks++;};
try{
 const origin='https://plugin-ad.test',time=Date.now();
 const token=()=>crypto.randomBytes(32).toString('hex'),sha=value=>crypto.createHash('sha256').update(value).digest('hex'),uuid=()=>crypto.randomUUID();
 const signing=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey.export({type:'pkcs8',format:'pem'});
 let current=null;const clock=null;
 const identity=async()=>{if(!current)throw new HttpError(401,'Sign in.','IDENTITY_LOGIN_REQUIRED');return current;};
 const noop=async()=>{},allow=sql`TRUE`;
 const server={
  db:()=>d,config:key=>key==='SESSION_SECRET'?'s'.repeat(64):key==='SITE_ORIGIN'?origin:key==='AGENT_JOB_SIGNING_KEY'?signing:'',now:()=>clock??Date.now(),random:token,hash:async value=>sha(value),HttpError,
  guid:x=>typeof x==='string'&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(x),body:request=>request.json(),sameOrigin:()=>{},
  requireViewer:identity,requireIdentity:identity,requireAuthIdentity:async()=>current,log:noop,
  failure:e=>{const known=e instanceof HttpError||e instanceof Error&&typeof e.status==='number'&&typeof e.code==='string';return Response.json({error:e instanceof Error?e.message:'failed',...(known?{code:e.code,messageKey:e.messageKey,params:e.params}:{})},{status:known?e.status:500});},
 };
 const deviceRow=id=>d.one(sql`SELECT id,last_seen,management,snapshot,name,agent_public_key FROM servers WHERE id=${id}`);
 const v3={snapshot:row=>row.snapshot?JSON.parse(row.snapshot):null,agentFromBearer:async request=>deviceRow((await request.clone().json()).serverId),assertAgentActive:noop,releaseLease:noop,securityFile:()=>false,lease:noop,maintenanceBusy:async()=>false};
 const imports={'../context':server,'./context':server,'../../context':server,'@/lib/server/context':server,'./agent-protocol':v3,'../agent/agent-protocol':v3,'@/lib/server/agent/agent-protocol':v3,
  '../automation/runbooks':{tickAutomation:noop},'../automation/drift':{ingestDrift:noop},'../devices/file-access':{requireFileAccess:noop},
  '../devices/transfers':{verifyTransfer:noop,sweepTransfers:noop,transferAuthorizationGuard:()=>allow},'./transfers':{verifyTransfer:noop,sweepTransfers:noop,transferAuthorizationGuard:()=>allow},'../devices/terminal-lifecycle':{sweepTerminalSessions:noop},'../devices/rdp':{sweepRdp:noop},
  '../devices/terminal-channel':{terminalReport:z.object({}),exchangeTerminals:async()=>[]},
  '../automation/desired-state':{advanceDesiredState:noop,checkPendingDesiredJob:async()=>true,desiredJobClaimGuard:async()=>allow},
  '../automation/desired-state-result':{desiredResultActions:new Set(),desiredResultStatement:()=>null},
  '../automation/automation-device':{reconcileDeviceAutomation:noop,getAutomationDriftPolicy:async()=>null},
 };
 const load=sourceLoader();
 const route=load('app/api/plugin-ad/route.ts',imports),sessions=load('lib/server/extensions/plugin-ad-sessions.ts',imports),channel=load('lib/server/agent/agent-channel.ts',imports);

 // ---- Fixture ------------------------------------------------------------------------------------
 const insert=(table,row)=>insertRow(d,table,row);
 const count=async statement=>Number((await d.one(statement)).n);
 const corpSid='S-1-5-21-1000-2000-3000',otherSid='S-1-5-21-4000-5000-6000',annaSid=corpSid+'-1105';
 const corp={kind:'domain',name:'corp.example',netbiosName:'CORP',sid:corpSid};
 async function account(label,permissions){
  const {actor}=await sourceActor(d,label,permissions);actor.userId=actor.id;
  // The claim resolves the job's actor as private:<email>, like a local user of the portal.
  actor.principal='private:'+label;await d.exec(sql`UPDATE local_users SET auth_principal=${actor.principal},password_hash='fixture-password',must_reset=0 WHERE id=${actor.id}`);
  await insert('mfa_accounts',{principal:actor.principal,secret_enc:'migrated:authenticator-managed',recovery_hashes:'[]',last_counter:-1,created_at:time,authenticators_migrated:1});
  return actor;
 }
 // An account from Microsoft Entra ID as the Entra sign-in creates it: principal entra:<tid>:<oid>, label <oid>@<tid>.entra.serverdesk.invalid, no mfa_accounts row.
 const tenant='7c7c7c7c-0000-4000-8000-000000000232';
 async function entraAccount(permissions){
  const oid=uuid(),label=`${oid}@${tenant}.entra.serverdesk.invalid`,{actor}=await sourceActor(d,label,permissions);
  Object.assign(actor,{userId:actor.id,principal:`entra:${tenant}:${oid}`,identitySource:'entra',entra:{tenantId:tenant,objectId:oid,email:'entra@contoso.test'}});
  await d.exec(sql`UPDATE local_users SET auth_principal=${actor.principal},identity_source='entra',entra_tenant_id=${tenant},entra_object_id=${oid},password_hash=NULL,must_reset=0 WHERE id=${actor.id}`);
  return actor;
 }
 async function browser(actor,{expires=Date.now()+86_400_000}={}){
  const at=Date.now(),primary=token(),session=token();
  await insert('mfa_sessions',{token_hash:sha(session),principal:actor.principal,created_at:at,last_activity:at,idle_expires_at:at+900_000,expires_at:expires});
  await insert('local_auth_sessions',{token_hash:sha(primary),user_id:actor.id,auth_version:1,created_at:at,expires_at:at+86_400_000,pending_until:at+600_000,mfa_hash:sha(session)});
  return {primary,session,hash:sha(session)};
 }
 const keyPair=crypto.generateKeyPairSync('rsa',{modulusLength:2048}),jwk=keyPair.publicKey.export({format:'jwk'});
 const plugin={name:'dhcp',role:'dhcp',version:'1.1.0',capabilities:['dhcp-read','dhcp-reservation-add'],state:'ready',networkBlocked:true};
 async function device(name,{lastSeen=Date.now(),agent=['plugin-host','plugin-secrets','plugin-ad-identity','signed-dispatch'],directory=corp,management=1}={}){
  const id=uuid();
  const snapshot={protocolVersion:3,agentVersion:'4.19.0',mode:management?'Management':'ReadOnly',agentCapabilities:agent,plugins:[plugin],publicKey:{kty:'RSA',n:jwk.n,e:jwk.e},hostname:name,...(directory?{security:{directory}}:{})};
  await insert('servers',{id,name,token_hash:'fixture-'+id,created_at:time,last_seen:lastSeen,management,snapshot:JSON.stringify(snapshot)});
  return id;
 }
 const post=async(actor,b,payload)=>{current=actor;const response=await route.POST(new Request(origin+'/api/plugin-ad',{method:'POST',headers:sessionHeaders(b,{'Content-Type':'application/json'}),body:JSON.stringify(payload)}));return {status:response.status,body:await response.json()};};
 const get=async(actor,b,query='')=>{current=actor;const response=await route.GET(new Request(origin+'/api/plugin-ad'+query,{headers:sessionHeaders(b)}));return {status:response.status,body:await response.json()};};
 const signIn=(serverId,accountName='CORP\\anna',password='Winter-Is-Coming-7',extra={})=>({action:'sign-in',serverId,plugin:'dhcp',account:accountName,password,...extra});
 // The channel admits one post per device every 150 ms.
 // Posts need 150 ms spacing; a transient 429 or 5xx of the shared test database under parallel suites is tried again (at most 3 times).
 const agent=async(serverId,body)=>{
  for(let attempt=1;;attempt++){
   await new Promise(resolve=>setTimeout(resolve,160*attempt));
   const response=await channel.agentChannel(new Request(origin+'/api/agent/channel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({serverId,...body})}));
   if(attempt<3&&(response.status===429||response.status>=500))continue;
   return {status:response.status,body:await response.json()};
  }
 };
 const running=id=>d.exec(sql`UPDATE jobs SET state='running',claimed_at=${Date.now()},last_progress=${Date.now()} WHERE id=${id}`);
 const identityData=(directory=corp,extra={})=>({userSid:annaSid,account:'CORP\\anna',upn:'anna@corp.example',directory,...extra});
 const okResult=(id,data=identityData())=>({id,ok:true,message:'The account was checked.',code:'AGENT_AD_SIGNED_IN',data});
 const failedResult=id=>({id,ok:false,message:'The account or password is wrong. Check both and try again.',code:'AGENT_AD_SIGN_IN_FAILED'});
 const rows=()=>d.query(sql`SELECT * FROM plugin_ad_sessions ORDER BY created_at,id`);
 const totals=async()=>[await count(sql`SELECT count(*) AS n FROM jobs`),await count(sql`SELECT count(*) AS n FROM plugin_ad_sessions`),await count(sql`SELECT count(*) AS n FROM audit`)];
 const reset=async()=>{await d.exec(sql`DELETE FROM jobs`);await d.exec(sql`DELETE FROM plugin_ad_sessions`);await d.exec(sql`DELETE FROM audit`);await d.exec(sql`DELETE FROM local_auth_attempts`);};
 const open=box=>{const material=crypto.privateDecrypt({key:keyPair.privateKey,padding:crypto.constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha1'},Buffer.from(box.key,'base64'));const decipher=crypto.createDecipheriv('aes-256-cbc',material.subarray(0,32),Buffer.from(box.iv,'base64'));return JSON.parse(Buffer.concat([decipher.update(Buffer.from(box.data,'base64')),decipher.final()]).toString());};

 const manager=await account('manager@plugin-ad.test',['view','dhcp.read','dhcp.manage','dns.manage']),reader=await account('reader@plugin-ad.test',['view','dhcp.read']);
 const dc01=await device('SRV-DC01'),dc02=await device('SRV-DC02');
 const mb=await browser(manager);

 // ---- A sign-in: one job, one pending row, the password only sealed -------------------------------------
 const password='Winter-Is-Coming-7';
 {
  const result=await post(manager,mb,signIn(dc01));
  check(result.status,200,'the sign-in is queued');
  const job=await d.one(sql`SELECT action,target,parameters,state,actor_email FROM jobs WHERE id=${result.body.jobId}`);
  const parameters=JSON.parse(job.parameters);
  check([job.action,job.target,job.state,parameters.plugin,parameters.account,Object.keys(parameters.secretParameters).sort()],['ad-sign-in','dhcp/CORP\\anna','pending','dhcp','CORP\\anna',['data','iv','key','mac']],'one ad-sign-in job: target <plugin>/<account>, the sealed box');
  check(open(parameters.secretParameters),{password},'the box opens with the device key');
  const [row]=await rows();
  check([row.state,row.source,row.job_id,row.principal,row.session_hash,row.directory_kind,row.directory_name,row.directory_sid,row.user_sid],['pending','password',result.body.jobId,manager.principal,mb.hash,'domain','corp.example',corpSid,null],'one pending row of this portal session and directory');
  const anywhere=sql`${'%'+password+'%'}`;
  check(await count(sql`SELECT count(*) AS n FROM jobs WHERE parameters LIKE ${anywhere} OR target LIKE ${anywhere}`)+await count(sql`SELECT count(*) AS n FROM audit WHERE target LIKE ${anywhere} OR action LIKE ${anywhere}`)+await count(sql`SELECT count(*) AS n FROM plugin_ad_sessions WHERE row_to_json(plugin_ad_sessions)::text LIKE ${anywhere}`),0,'no plain password in jobs, audit or plugin_ad_sessions');
  check(JSON.stringify(result.body).includes(password),false,'no password in the answer');
  check((await get(manager,mb,'?jobId='+result.body.jobId)).body,{state:'pending'},'GET ?jobId=: pending');
  check((await get(reader,await browser(reader),'?jobId='+result.body.jobId)).body.messageKey,'apiError.generic.notFound','GET ?jobId= of another user\'s job: not found');
  await reset();
 }

 // ---- Each refusal writes nothing ------------------------------------------------------------------------
 {
  const refuse=async(label,actor,b,payload,key,params)=>{
   const before=await totals(),result=await post(actor,b,payload);
   check([result.body.messageKey,...(params?[result.body.params]:[])],[key,...(params?[params]:[])],label);
   check(await totals(),before,label+': nothing written');
   return result;
  };
  await refuse('a plugin without changes',manager,mb,{...signIn(dc01),plugin:'wsus'},'apiError.plugin.operationUnknown');
  await refuse('without the manage right of the plugin',reader,await browser(reader),signIn(dc01),'apiError.access.devicePermissionMissing');
  await refuse('offline',manager,mb,signIn(await device('SRV-OFF',{lastSeen:Date.now()-10*60_000})),'apiError.agent.notConnected',{name:'SRV-OFF'});
  await refuse('an agent without plugin-ad-identity',manager,mb,signIn(await device('SRV-417',{agent:['plugin-host']})),'apiError.pluginAd.agentTooOld',{name:'SRV-417'});
  await refuse('no reported directory',manager,mb,signIn(await device('SRV-NODIR',{directory:null})),'apiError.pluginAd.noDirectory',{name:'SRV-NODIR'});
  await refuse('without an MFA session',manager,null,signIn(dc01),'apiError.mfa.loginRequired');
  await refuse('an account that does not fit',manager,mb,signIn(dc01,'CORP\\'),'apiError.pluginAd.accountInvalid');
  const long=await refuse('an account over 256 characters',manager,mb,signIn(dc01,'CORP\\'+'a'.repeat(300)),'apiError.pluginAd.accountTooLong',{max:'256'});
  check([long.status,long.body.code],[400,'INVALID_REQUEST'],'an account over 256 characters answers 400 INVALID_REQUEST');
  await refuse('a local account on a domain server',manager,mb,signIn(dc01,'.\\admin'),'apiError.pluginAd.localOnDomain');
  await refuse('another domain on a workgroup server',manager,mb,signIn(await device('WG1',{directory:{kind:'local',name:'WG1',netbiosName:'WG1',sid:otherSid}}),'CORP\\anna'),'apiError.pluginAd.accountInvalidLocal',{name:'WG1'});
  await refuse('no password',manager,mb,signIn(dc01,'CORP\\anna',''),'apiError.pluginAd.passwordRequired');
  await refuse('a password over 256 characters',manager,mb,signIn(dc01,'CORP\\anna','x'.repeat(257)),'apiError.pluginAd.passwordRequired');
  const full=await device('SRV-FULL');
  for(let n=0;n<20;n++)await insert('jobs',{id:uuid(),server_id:full,action:'refresh',target:'',parameters:'{}',state:'pending',created_at:time,actor:manager.id,actor_email:manager.label,actor_principal:manager.principal});
  const queue=await refuse('a full queue',manager,mb,signIn(full),'apiError.console.queueFull');
  check(queue.status,429,'a full queue answers 429');
  await reset();
 }

 // ---- Results: active, failed, another directory, too late ----------------------------------------------
 {
  // ok: the row turns active with the verified identity and the audit row.
  let queued=await post(manager,mb,signIn(dc01));await running(queued.body.jobId);
  check((await agent(dc01,{results:[okResult(queued.body.jobId)]})).status,200,'the channel takes the result');
  const [row]=await rows();
  const mfa=await d.one(sql`SELECT expires_at FROM mfa_sessions WHERE token_hash=${mb.hash}`);
  check([row.state,row.user_sid,row.account,row.upn,row.server_id,Number(row.expires_at)===Math.min(Number(row.verified_at)+8*3600_000,Number(mfa.expires_at))],['active',annaSid,'CORP\\anna','anna@corp.example',dc01,true],'ok: active with the verified identity, 8 hours at most');
  check(await d.one(sql`SELECT state,parameters FROM jobs WHERE id=${queued.body.jobId}`),{state:'succeeded',parameters:'{}'},'the job succeeded and its parameters are wiped');
  check(await count(sql`SELECT count(*) AS n FROM audit WHERE action='AD sign-in' AND target='SRV-DC01 / CORP\\anna' AND server_id=${dc01} AND scope='device'`),1,'the device audit row "AD sign-in"');
  const status=(await get(manager,mb,'?jobId='+queued.body.jobId)).body;
  check([status.state,status.session.account,status.session.directory,status.session.source],['active','CORP\\anna',{kind:'domain',name:'corp.example',sid:corpSid},'password'],'GET ?jobId=: active with the session');
  // A second sign-in of the same session and directory replaces the first.
  queued=await post(manager,mb,signIn(dc02,'anna@corp.example'));await running(queued.body.jobId);
  await agent(dc02,{results:[okResult(queued.body.jobId,identityData(corp,{account:'CORP\\anna2',userSid:corpSid+'-1106'}))]});
  check((await rows()).map(item=>[item.state,item.account,item.server_id]),[['active','CORP\\anna2',dc02]],'a second sign-in replaces the first');
  await reset();
  // A wrong password: no row, the audit row, the job fails with the agent code and counts.
  queued=await post(manager,mb,signIn(dc01));await running(queued.body.jobId);
  await agent(dc01,{results:[failedResult(queued.body.jobId)]});
  check([(await rows()).length,(await d.one(sql`SELECT state,result_code FROM jobs WHERE id=${queued.body.jobId}`))],[0,{state:'failed',result_code:'AGENT_AD_SIGN_IN_FAILED'}],'a failure: no row, the job failed with its code');
  check(await count(sql`SELECT count(*) AS n FROM audit WHERE action='AD sign-in failed' AND target='SRV-DC01 / CORP\\anna'`),1,'the device audit row "AD sign-in failed"');
  check(Number((await d.one(sql`SELECT attempts FROM local_auth_attempts WHERE bucket=${'plugin-ad:'+manager.principal}`)).attempts),1,'a wrong password counts');
  check((await get(manager,mb,'?jobId='+queued.body.jobId)).body,{state:'failed',code:'AGENT_AD_SIGN_IN_FAILED'},'GET ?jobId=: failed with the code');
  // Another error does not count.
  queued=await post(manager,mb,signIn(dc01));await running(queued.body.jobId);
  await agent(dc01,{results:[{id:queued.body.jobId,ok:false,message:'The server cannot reach a domain controller.',code:'AGENT_AD_DOMAIN_UNREACHABLE'}]});
  check(Number((await d.one(sql`SELECT attempts FROM local_auth_attempts WHERE bucket=${'plugin-ad:'+manager.principal}`)).attempts),1,'an unreachable domain does not count');
  queued=await post(manager,mb,signIn(dc01));await running(queued.body.jobId);
  await agent(dc01,{results:[{id:queued.body.jobId,ok:false,message:'CORP\\anna cannot sign in now.',code:'AGENT_AD_ACCOUNT_RESTRICTED',args:{account:'CORP\\anna'}}]});
  check(Number((await d.one(sql`SELECT attempts FROM local_auth_attempts WHERE bucket=${'plugin-ad:'+manager.principal}`)).attempts),1,'a restricted account does not count');
  // ok from another directory than the device reports: no row, the job fails.
  queued=await post(manager,mb,signIn(dc01));await running(queued.body.jobId);
  await agent(dc01,{results:[okResult(queued.body.jobId,identityData({...corp,sid:otherSid}))]});
  check([(await rows()).length,(await d.one(sql`SELECT state,result FROM jobs WHERE id=${queued.body.jobId}`))],[0,{state:'failed',result:'serverMessage.job.adSignInMismatch'}],'a directory SID mismatch: no row, adSignInMismatch');
  // ok with data outside the schema: the same.
  queued=await post(manager,mb,signIn(dc01));await running(queued.body.jobId);
  await agent(dc01,{results:[okResult(queued.body.jobId,{...identityData(),password:'x'})]});
  check((await rows()).length,0,'data with an unknown key: no row');
  // A result after 2 minutes creates nothing.
  queued=await post(manager,mb,signIn(dc01));await running(queued.body.jobId);
  await d.exec(sql`UPDATE plugin_ad_sessions SET created_at=${Date.now()-3*60_000} WHERE job_id=${queued.body.jobId}`);
  await agent(dc01,{results:[okResult(queued.body.jobId)]});
  check([(await rows()).filter(item=>item.state==='active').length,(await d.one(sql`SELECT state,result FROM jobs WHERE id=${queued.body.jobId}`))],[0,{state:'failed',result:'serverMessage.job.adSignInEnded'}],'a late result: no active row');
  await reset();
 }

 // ---- The rate limit: only failed sign-ins count; one sign-in at a time ------------------------------------
 {
  const attempts=async()=>Number((await d.one(sql`SELECT attempts FROM local_auth_attempts WHERE bucket=${'plugin-ad:'+manager.principal}`))?.attempts??0);
  // A sign-in in flight (job pending, then running) refuses a second one with 409 signInRunning and no write.
  const first=await post(manager,mb,signIn(dc01));
  check(first.status,200,'the first sign-in is queued');
  let before=await totals(),result=await post(manager,mb,signIn(dc02));
  check([result.status,result.body.messageKey,result.body.code,await totals()],[409,'apiError.pluginAd.signInRunning','CONFLICT',before],'a second sign-in while the first job is pending: signInRunning, nothing written');
  await running(first.body.jobId);
  result=await post(manager,mb,signIn(dc01));
  check([result.status,result.body.messageKey,await totals()],[409,'apiError.pluginAd.signInRunning',before],'a second sign-in while the first job runs: signInRunning, nothing written');
  // The dialog cancels its job after its timeout: the pending row no longer blocks, and nothing counts.
  await d.exec(sql`UPDATE jobs SET state='cancelled',parameters='{}' WHERE id=${first.body.jobId}`);
  result=await post(manager,mb,signIn(dc01));
  check([result.status,await attempts()],[200,0],'after the first job is cancelled, the next sign-in is accepted at once and the failure count does not change');
  await reset();
  // Two parallel sign-ins of one principal: exactly one job and one pending row.
  const parallel=await Promise.all([post(manager,mb,signIn(dc01)),post(manager,mb,signIn(dc02))]);
  check(parallel.map(item=>item.status).sort(),[200,409],'two parallel sign-ins: one is queued, the other gets 409');
  check(parallel.find(item=>item.status===409).body.messageKey,'apiError.pluginAd.signInRunning','the other one: signInRunning');
  check([await count(sql`SELECT count(*) AS n FROM jobs`),await count(sql`SELECT count(*) AS n FROM plugin_ad_sessions WHERE state='pending'`)],[1,1],'two parallel sign-ins: one job and one pending row');
  await reset();
  // The race itself: a test transaction holds the principal's advisory lock until both requests have
  // passed the checks and wait for it. Then the guard of the job INSERT lets only one of them through.
  {
   const lockKey=sql`${sessions.adSignInLockClass}::integer,hashtext(${'plugin-ad:'+manager.principal})`;
   const waiting=()=>count(sql`SELECT count(*) AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted AND classid=${sessions.adSignInLockClass}::bigint::oid`);
   let release,held;const gate=new Promise(resolve=>{release=resolve;}),holding=new Promise(resolve=>{held=resolve;});
   const holder=d.transaction(async tx=>{await tx.query(sql`SELECT pg_advisory_xact_lock(${lockKey})`);held();await gate;});
   await holding;
   const raced=Promise.all([post(manager,mb,signIn(dc01)),post(manager,mb,signIn(dc02))]);
   for(let n=0;n<400&&await waiting()<2;n++)await new Promise(resolve=>setTimeout(resolve,25));
   check(await waiting(),2,'both sign-ins passed the checks and wait for the advisory lock');
   release();await holder;
   const outcome=await raced;
   check([outcome.map(item=>item.status).sort(),outcome.find(item=>item.status!==200)?.body.messageKey],[[200,409],'apiError.pluginAd.signInRunning'],'after the lock: one is queued, the INSERT guard refuses the other with signInRunning');
   check([await count(sql`SELECT count(*) AS n FROM jobs`),await count(sql`SELECT count(*) AS n FROM plugin_ad_sessions`)],[1,1],'after the lock: one job and one pending row');
  }
  await reset();
  // Four failures, then a sign-in is accepted; its failure is the fifth, so the next one gets 429.
  for(let n=0;n<4;n++){const queued=await post(manager,mb,signIn(dc01));await running(queued.body.jobId);await agent(dc01,{results:[failedResult(queued.body.jobId)]});}
  const fifth=await post(manager,mb,signIn(dc01));
  check([fifth.status,await attempts()],[200,4],'after 4 failed sign-ins the next one is accepted');
  await running(fifth.body.jobId);await agent(dc01,{results:[failedResult(fifth.body.jobId)]});
  before=await totals();result=await post(manager,mb,signIn(dc01));
  check([result.status,result.body.messageKey,await totals()],[429,'apiError.pluginAd.tooManyAttempts',before],'after 5 failed sign-ins: tooManyAttempts, nothing written');
  await d.exec(sql`UPDATE local_auth_attempts SET window_at=${Date.now()-16*60_000}`);
  check((await post(manager,mb,signIn(dc01))).status,200,'after 15 minutes the next try is allowed');
  await reset();
 }

 // ---- GET lists the own portal session only; sign-out; the cascade -----------------------------------------
 {
  const at=Date.now(),own=uuid(),foreign=uuid(),second=await browser(manager);
  const active=(id,hash,sid=corpSid)=>insert('plugin_ad_sessions',{id,principal:manager.principal,session_hash:hash,state:'active',source:'password',directory_kind:'domain',directory_name:'corp.example',directory_sid:sid,user_sid:sid+'-1105',account:'CORP\\anna',upn:null,created_at:at,verified_at:at,expires_at:at+3600_000});
  await active(own,mb.hash);await active(foreign,second.hash);
  const listed=(await get(manager,mb)).body.sessions;
  check(listed.map(item=>[item.id,item.account,item.directory.sid,item.source,item.expiresAt]),[[own,'CORP\\anna',corpSid,'password',at+3600_000]],'GET lists only the sign-ins of this portal session');
  check((await get(manager,null)).body.sessions,[],'GET without a portal session lists nothing');
  check((await post(manager,mb,{action:'sign-out',id:foreign})).body.messageKey,'apiError.generic.notFound','sign-out of another session\'s sign-in: not found');
  const out=await post(manager,mb,{action:'sign-out',id:own});
  check([out.status,(await rows()).map(item=>item.id)],[200,[foreign]],'sign-out deletes the one row');
  check(await count(sql`SELECT count(*) AS n FROM audit WHERE action='AD sign-out' AND target='corp.example / CORP\\anna' AND scope='portal'`),1,'the portal audit row "AD sign-out"');
  await d.exec(sql`DELETE FROM mfa_sessions WHERE token_hash=${second.hash}`);
  check((await rows()).length,0,'a deleted portal session takes its sign-ins along');
  // The table constraints of the migration (drizzle/*_plugin_ad_sessions.sql): states, sources, kinds, an active row needs its identity, one active row per portal session and directory.
  const refused=async(label,row)=>{let failed=false;try{await insert('plugin_ad_sessions',{id:uuid(),principal:manager.principal,session_hash:mb.hash,state:'pending',source:'password',directory_kind:'domain',directory_name:'corp.example',directory_sid:corpSid,created_at:at,...row});}catch{failed=true;}check(failed,true,label);};
  await refused('the state is pending or active',{state:'expired'});
  await refused('the source is password or entra',{source:'ldap'});
  await refused('the directory kind is domain or local',{directory_kind:'forest'});
  await refused('an active row needs user_sid and verified_at',{state:'active',user_sid:null,verified_at:null,expires_at:at+1000});
  await refused('an unknown portal session is refused by the foreign key',{session_hash:'f'.repeat(64)});
  await active(uuid(),mb.hash);
  await refused('one active row per portal session and directory',{state:'active',user_sid:corpSid+'-1106',verified_at:at,expires_at:at+1000,account:'CORP\\bob'});
  const columns=(await d.query(sql`SELECT column_name FROM information_schema.columns WHERE table_name='plugin_ad_sessions'`)).map(row=>row.column_name);
  check(columns.some(name=>/pass|secret/i.test(name)),false,'the table has no password column');
  await reset();
 }

 // ---- Entra ID: openDirectoryAdSession ----------------------------------------------------------------------
 {
  const eb=await browser(manager),mfa=await d.one(sql`SELECT expires_at FROM mfa_sessions WHERE token_hash=${eb.hash}`);
  check(await sessions.openDirectoryAdSession({sessionHash:eb.hash,principal:manager.principal,mfaExpiresAt:Number(mfa.expires_at),onPremisesDomainName:'corp.example',onPremisesSamAccountName:'anna'}),null,'no SID: no row');
  const opened=await sessions.openDirectoryAdSession({sessionHash:eb.hash,principal:manager.principal,mfaExpiresAt:Number(mfa.expires_at),onPremisesSecurityIdentifier:annaSid,onPremisesDomainName:'corp.example',onPremisesSamAccountName:'anna',onPremisesUserPrincipalName:'anna@corp.example'});
  check([opened.source,opened.account,opened.directory],['entra','corp.example\\anna',{kind:'domain',name:'corp.example',sid:corpSid}],'an active entra row for the domain of the user SID');
  current=manager;
  const snapshot=JSON.parse((await d.one(sql`SELECT snapshot FROM servers WHERE id=${dc01}`)).snapshot);
  const actAs=(await sessions.requireAdSessions(new Request(origin,{headers:sessionHeaders(eb)}),manager,[{device:{id:dc01,name:'SRV-DC01'},snapshot}])).get(dc01);
  check(actAs,{sessionId:opened.id,userSid:annaSid,logonName:'anna@corp.example',account:'corp.example\\anna',kind:'domain'},'it matches a device of that domain: actAs with the UPN');
  await reset();
 }

 // ---- The claim: a plugin change only while its sign-in lives ---------------------------------------------
 {
  const at=Date.now(),sessionId=uuid();
  await insert('plugin_ad_sessions',{id:sessionId,principal:manager.principal,session_hash:mb.hash,state:'active',source:'password',directory_kind:'domain',directory_name:'corp.example',directory_sid:corpSid,user_sid:annaSid,account:'CORP\\anna',upn:null,created_at:at,verified_at:at,expires_at:at+3600_000});
  const actAs={sessionId,userSid:annaSid,logonName:'CORP\\anna',account:'CORP\\anna',kind:'domain'};
  const queue=async(parameters,created=at)=>{const id=uuid();await insert('jobs',{id,server_id:dc01,action:'plugin-job',target:parameters.operation,parameters:JSON.stringify({plugin:'dhcp',...parameters}),state:'pending',created_at:created,actor:manager.id,actor_email:manager.label,actor_principal:manager.principal});return id;};
  const stateOf=id=>d.one(sql`SELECT state,result,parameters FROM jobs WHERE id=${id}`);
  const live=await queue({operation:'dhcp-reservation-add',parameters:{},actAs});
  let answer=await agent(dc01,{});
  check([answer.body.jobs.map(job=>job.id),answer.body.jobs[0]?.parameters.actAs,answer.body.signedJobs.length],[[live],actAs,1],'a change with a live sign-in is delivered with actAs in its signed envelope');
  check(JSON.parse(answer.body.signedJobs[0].payload).job.parameters.actAs,actAs,'actAs is inside the signed payload');
  await d.exec(sql`DELETE FROM jobs`);
  // The live session of another portal user (same directory, same user SID): the claim refuses it.
  const other=await account('other@plugin-ad.test',['view','dhcp.read','dhcp.manage']),ob=await browser(other),otherSession=uuid();
  await insert('plugin_ad_sessions',{id:otherSession,principal:other.principal,session_hash:ob.hash,state:'active',source:'password',directory_kind:'domain',directory_name:'corp.example',directory_sid:corpSid,user_sid:annaSid,account:'CORP\\anna',upn:null,created_at:at,verified_at:at,expires_at:at+3600_000});
  const otherActAs={...actAs,sessionId:otherSession},actor=sql`jobs.actor_principal`,change={operation:'dhcp-reservation-add',parameters:{}};
  const borrowed=await queue({...change,actAs:otherActAs}),own=await queue({...change,actAs});
  const guarded=async id=>(await d.query(sql`SELECT id FROM jobs WHERE id=${id} AND ${sessions.adClaimGuard(Date.now(),actor)}`)).length;
  check([await guarded(borrowed),await guarded(own)],[0,1],'the SQL guard alone: no row for the session of another portal user, one row for the own session');
  check([await sessions.adClaimable('plugin-job',{...change,actAs},sql`${manager.principal}`,Date.now()),await sessions.adClaimable('plugin-job',{...change,actAs:otherActAs},sql`${manager.principal}`,Date.now()),await sessions.adClaimable('plugin-job',{...change,actAs},null,Date.now()),await sessions.adClaimable('plugin-job',{operation:'dhcp-read'},null,Date.now())],[true,false,false,true],'adClaimable: the own session only, never without an actor; a read needs none');
  await d.exec(sql`DELETE FROM jobs WHERE id=${own}`);
  answer=await agent(dc01,{});
  check([answer.body.jobs.length,await stateOf(borrowed)],[0,{state:'cancelled',result:'serverMessage.job.adSignInEnded',parameters:'{}'}],'a change whose actAs names the live session of another portal user is cancelled with adSignInEnded');
  const again=await queue({...change,actAs});
  answer=await agent(dc01,{});
  check([answer.body.jobs.map(job=>job.id),JSON.parse(answer.body.signedJobs[0].payload).job.parameters.actAs],[[again],actAs],'the own session still delivers with actAs in the signed envelope');
  await d.exec(sql`DELETE FROM jobs`);
  // No actAs on a change, a sign-in of another user SID, an expired sign-in, a deleted portal session.
  const missing=await queue({operation:'dhcp-reservation-add',parameters:{}});
  answer=await agent(dc01,{});
  check([answer.body.jobs.length,await stateOf(missing)],[0,{state:'cancelled',result:'serverMessage.job.adSignInEnded',parameters:'{}'}],'a change without actAs is cancelled with adSignInEnded');
  const forged=await queue({operation:'dhcp-reservation-add',parameters:{},actAs:{...actAs,userSid:corpSid+'-500'}});
  answer=await agent(dc01,{});
  check([answer.body.jobs.length,(await stateOf(forged)).result],[0,'serverMessage.job.adSignInEnded'],'a change whose actAs names another user SID is cancelled');
  await d.exec(sql`UPDATE plugin_ad_sessions SET expires_at=${Date.now()-1} WHERE id=${sessionId}`);
  const expired=await queue({operation:'dhcp-reservation-add',parameters:{},actAs});
  answer=await agent(dc01,{});
  check([answer.body.jobs.length,(await stateOf(expired)).result],[0,'serverMessage.job.adSignInEnded'],'a claim after the sign-in expired: cancelled with adSignInEnded');
  // A DNS change has no list of its own: every change of every plugin needs a live sign-in.
  const dnsChange=await queue({plugin:'dns',operation:'dns-record-add',parameters:{zone:'corp.example'},actAs});
  answer=await agent(dc01,{});
  check([answer.body.jobs.length,(await stateOf(dnsChange)).state,(await stateOf(dnsChange)).result],[0,'cancelled','serverMessage.job.adSignInEnded'],'a DNS change after the sign-in expired: cancelled with adSignInEnded');
  await d.exec(sql`UPDATE plugin_ad_sessions SET expires_at=${Date.now()+3600_000} WHERE id=${sessionId}`);
  await d.exec(sql`UPDATE mfa_sessions SET idle_expires_at=${Date.now()-1} WHERE token_hash=${mb.hash}`);
  const idle=await queue({operation:'dhcp-reservation-add',parameters:{},actAs});
  answer=await agent(dc01,{});
  check([answer.body.jobs.length,(await stateOf(idle)).result],[0,'serverMessage.job.adSignInEnded'],'a claim after the portal session ended: cancelled');
  // A read needs no sign-in.
  const read=await queue({operation:'dhcp-read'});
  answer=await agent(dc01,{});
  check(answer.body.jobs.map(job=>job.id),[read],'a read without actAs is delivered');
 }

 // ---- Entra ID accounts: the poll, the rate limit and the claim use jobs.actor_principal ----------
 {
  await reset();await d.exec(sql`UPDATE mfa_sessions SET idle_expires_at=${Date.now()+900_000} WHERE token_hash=${mb.hash}`);
  const entra=await entraAccount(['view','dhcp.read','dhcp.manage']),eb=await browser(entra);
  const attemptsOf=async key=>Number((await d.one(sql`SELECT attempts FROM local_auth_attempts WHERE bucket=${'plugin-ad:'+key}`))?.attempts??0);
  const queued=await post(entra,eb,signIn(dc01));
  check([queued.status,await d.one(sql`SELECT actor_email,actor_principal FROM jobs WHERE id=${queued.body.jobId}`)],[200,{actor_email:entra.label,actor_principal:entra.principal}],'the Entra manager queues a sign-in; the job stores the label and the Entra principal');
  // the dialog's poll finds the own job by actor_principal; another viewer gets notFound.
  check((await get(entra,eb,'?jobId='+queued.body.jobId)).body,{state:'pending'},'the Entra viewer polls their own sign-in job');
  const foreign=await get(manager,mb,'?jobId='+queued.body.jobId);
  check([foreign.status,foreign.body.messageKey],[404,'apiError.generic.notFound'],'another viewer gets notFound for the job of the Entra viewer');
  // a wrong password whose pending row is gone counts against the Entra principal, not a key rebuilt from the label.
  await running(queued.body.jobId);await d.exec(sql`DELETE FROM plugin_ad_sessions WHERE job_id=${queued.body.jobId}`);
  check((await agent(dc01,{results:[failedResult(queued.body.jobId)]})).status,200,'the agent reports the failed sign-in');
  check([await attemptsOf(entra.principal),await attemptsOf('private:'+entra.label)],[1,0],'the failure without its pending row counts against entra:<tid>:<oid>');
  await reset();
  // a change of the Entra manager is delivered with their own sign-in; with another user's sign-in it is cancelled.
  const at=Date.now(),own=uuid(),borrowed=uuid();
  const session=(id,actor,hash)=>insert('plugin_ad_sessions',{id,principal:actor.principal,session_hash:hash,state:'active',source:'password',directory_kind:'domain',directory_name:'corp.example',directory_sid:corpSid,user_sid:annaSid,account:'CORP\\anna',upn:null,created_at:at,verified_at:at,expires_at:at+3600_000});
  await session(own,entra,eb.hash);await session(borrowed,manager,mb.hash);
  const actAs={sessionId:own,userSid:annaSid,logonName:'CORP\\anna',account:'CORP\\anna',kind:'domain'},change={operation:'dhcp-reservation-add',parameters:{}};
  const queue=async parameters=>{const id=uuid();await insert('jobs',{id,server_id:dc01,action:'plugin-job',target:parameters.operation,parameters:JSON.stringify({plugin:'dhcp',...parameters}),state:'pending',created_at:at,actor:entra.id,actor_email:entra.label,actor_principal:entra.principal});return id;};
  const mine=await queue({...change,actAs});
  let answer=await agent(dc01,{});
  check([answer.body.jobs.map(job=>job.id),JSON.parse(answer.body.signedJobs[0].payload).job.parameters.actAs],[[mine],actAs],'a change of the Entra manager with their own sign-in is delivered');
  await d.exec(sql`DELETE FROM jobs`);
  const other=await queue({...change,actAs:{...actAs,sessionId:borrowed}});
  answer=await agent(dc01,{});
  check([answer.body.jobs.length,await d.one(sql`SELECT state,result FROM jobs WHERE id=${other}`)],[0,{state:'cancelled',result:'serverMessage.job.adSignInEnded'}],'a change of the Entra manager with the sign-in of another user is cancelled with adSignInEnded');
  await reset();
 }
 // ---- A DNS read needs no AD sign-in, from the queue to the claim ----------------------------------
 {
  await reset();
  // The real lib/server/agent/agent-protocol (the queue checks the snapshot through it); the channel keeps its stub.
  const plugins=sourceLoader()('app/api/plugins/route.ts',{'../context':server,'./context':server,'../../context':server,'@/lib/server/context':server});
  const dnsReader=await account('dns-reader@plugin-ad.test',['view','dns.read']),db=await browser(dnsReader);
  const id=uuid(),dnsPlugin={name:'dns',role:'dns',version:'1.0.1',capabilities:['dns-read','dns-zone-read','dns-cache-clear'],state:'ready',networkBlocked:true};
  await insert('servers',{id,name:'SRV-DNS01',token_hash:'fixture-'+id,created_at:time,last_seen:Date.now(),management:0,snapshot:JSON.stringify({protocolVersion:3,agentVersion:'4.21.2',mode:'ReadOnly',agentCapabilities:['plugin-host','plugin-secrets','plugin-ad-identity','signed-dispatch'],plugins:[dnsPlugin],publicKey:{kty:'RSA',n:jwk.n,e:jwk.e},hostname:'SRV-DNS01',security:{directory:corp}})});
  check(await count(sql`SELECT count(*) AS n FROM plugin_ad_sessions WHERE principal=${dnsReader.principal}`),0,'the reader has no AD sign-in');
  current=dnsReader;
  const response=await plugins.POST(new Request(origin+'/api/plugins',{method:'POST',headers:sessionHeaders(db,{'Content-Type':'application/json'}),body:JSON.stringify({action:'job',serverId:id,plugin:'dns',operation:'dns-read'})}));
  const queued=await response.json();
  check(response.status,200,`Read DNS server without an AD sign-in is queued: ${JSON.stringify(queued)}`);
  const row=await d.one(sql`SELECT action,target,state,parameters,actor_principal FROM jobs WHERE id=${queued.id}`);
  check([row.action,row.target,row.state,JSON.parse(row.parameters)],['plugin-job','dns-read','pending',{plugin:'dns',operation:'dns-read'}],'the dns-read job stores no actAs');
  check(await sessions.adClaimable('plugin-job',JSON.parse(row.parameters),sql`${row.actor_principal}`,Date.now()),true,'adClaimable admits the read without a sign-in');
  check(await sessions.adClaimable('plugin-job',JSON.parse(row.parameters),null,Date.now()),true,'adClaimable admits the read without an actor too');
  const answer=await agent(id,{});
  check([answer.status,answer.body.jobs.map(job=>job.id),answer.body.signedJobs.length],[200,[queued.id],1],'the channel claims and delivers the read');
  check([JSON.parse(answer.body.signedJobs[0].payload).job.parameters.actAs,(await d.one(sql`SELECT state FROM jobs WHERE id=${queued.id}`)).state],[undefined,'running'],'the delivered read carries no actAs and runs');
  await reset();
 }
 console.log(`PASS plugin AD sessions (${checks} checks): the sign-in job with the sealed password and no plain text anywhere, every refusal without a write, ok/failed/mismatch/late results, the rate limit on failed sign-ins and one sign-in at a time (also in parallel), the replacement, GET and sign-out of the own portal session, the cascade, the Entra hook, the claim guard bound to the portal user who queued the change, and a DNS read that is queued and claimed without any AD sign-in.`);
}finally{await d.close();}
