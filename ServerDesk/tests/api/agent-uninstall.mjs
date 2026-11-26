// Offboarding with a portal uninstall of the agent: the removal actions queue a
// signed agent-uninstall job instead of revoking, the channel claims it like an
// agent update, and only the agent's AGENT_UNINSTALL_STARTED result revokes the
// device with the cleanup of removeDevices. Real console and channel routes,
// device lifecycle, access, policy, MFA and step-up proofs run against an
// isolated migrated PostgreSQL test database.
import {serverText} from '../support/server-text.mjs';
import {HttpError as realHttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {sourceDatabase,sourceLoader,insertRow,inTransaction} from '../support/source-database.mjs';
import {sessionHeaders} from '../support/session-cookies.mjs';
import {sql} from '../../runtime/database.mjs';
const require=createRequire(import.meta.url);
const {z}=require('zod');
const d=await sourceDatabase();
let checks=0;
const check=(value,expected,label)=>{assert.deepEqual(value,expected,label);checks++;};
try{
 const origin='https://uninstall.test';let clock=Date.now(),current=null;
 const HttpError=realHttpError;
 const token=()=>crypto.randomBytes(32).toString('hex'),sha=value=>crypto.createHash('sha256').update(value).digest('hex'),uuid=()=>crypto.randomUUID();
 const signingKey=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey.export({type:'pkcs8',format:'pem'});
 const identity=async()=>{if(!current)throw new HttpError(401,'Bitte anmelden.','IDENTITY_LOGIN_REQUIRED');return current;};
 const server={
  db:()=>d,config:key=>key==='SESSION_SECRET'?'s'.repeat(64):key==='SITE_ORIGIN'?origin:key==='AGENT_JOB_SIGNING_KEY'?signingKey:'',now:()=>clock,random:token,hash:async value=>sha(value),HttpError,
  guid:x=>typeof x==='string'&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(x),body:request=>request.json(),sameOrigin:()=>{},
  requireViewer:identity,requireIdentity:identity,requireAuthIdentity:async()=>current,log:async()=>{},
  failure:e=>Response.json({error:e instanceof HttpError?e.message:serverText('apiError.storageUnavailable'),...(e instanceof HttpError&&e.code?{code:e.code}:{})},{status:e instanceof HttpError?e.status:503}),
 };
 // Schedulers, storage and terminal transport stay idle; access, policy, jobs and the lifecycle are real.
 const idle=async()=>{},allow=sql`TRUE`;
 const transfers={clearTransfer:idle,verifyTransfer:idle,sweepTransfers:idle,transferAuthorizationGuard:()=>allow};
 const imports={'../context':server,'./context':server,'../../context':server,'@/lib/server/context':server,'../devices/transfers':transfers,'./transfers':transfers,'@/lib/server/devices/transfers':transfers,
  '@/lib/server/automation/runbooks':{tickAutomation:idle},'@/lib/server/automation/drift':{ingestDrift:idle},'@/lib/server/devices/terminal-lifecycle':{sweepTerminalSessions:idle},'@/lib/server/devices/rdp':{sweepRdp:idle},
  '@/lib/server/devices/terminal-channel':{terminalReport:z.object({id:z.guid()}),exchangeTerminals:async()=>[]},
  '@/lib/server/automation/desired-state':{advanceDesiredState:idle,checkPendingDesiredJob:async()=>true,desiredJobClaimGuard:async()=>allow},
  '@/lib/server/automation/automation-device':{reconcileDeviceAutomation:idle,getAutomationDriftPolicy:async()=>null},
  '@/agent/package-v3':{installerV3:()=>'',registrationV3:()=>''},'@/lib/server/agent/agent-crypto':{sealAgentSecrets:async()=>({})}};
 const load=sourceLoader();
 const consoleApi=load('app/api/console/route.ts',imports),channel=load('app/api/agent/channel/route.ts',imports);
 const {PENDING_JOB_LIFETIME_MS}=load('lib/job-expiry.ts',imports);

 // ---- Fixture -------------------------------------------------------------------
 const insert=(table,row)=>insertRow(d,table,row);
 const count=async statement=>Number((await d.one(statement)).n);
 async function account(name,permissions=['*']){
  const id=uuid(),roleId=uuid(),label=name+'@uninstall.test',principal='private:'+label,at=clock;
  await inTransaction(d,[
   sql`INSERT INTO local_users(id,username,email,display_name,auth_principal,auth_email,status,auth_version,created_at,updated_at,password_hash,must_reset) VALUES(${id},${name},${label},${name},${principal},${label},'active',1,${at},${at},'fixture-password',0)`,
   sql`INSERT INTO rbac_roles(id,name,description,permissions,builtin,created_at) VALUES(${roleId},${'Role '+name},'Uninstall fixture',${JSON.stringify(permissions)},0,${at})`,
   sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(${uuid()},'user',${id},${roleId},'global','*',${at},'fixture')`,
   sql`INSERT INTO mfa_accounts(principal,secret_enc,recovery_hashes,last_counter,created_at,authenticators_migrated) VALUES(${principal},'migrated:authenticator-managed','[]',-1,${at},1)`
  ]);
  const actor={id,userId:id,label,principal,username:name,displayName:name,permissions:permissions.includes('*')?['*']:[]};
  Object.defineProperty(actor,'authorization',{value:{authVersion:1},enumerable:false});
  return {actor,roleId};
 }
 // A signed-in browser: bound primary session, live MFA session and one fresh management proof.
 async function browser(actor){
  const at=clock,primary=token(),session=token(),management=token();
  await insert('mfa_sessions',{token_hash:sha(session),principal:actor.principal,created_at:at,last_activity:at,idle_expires_at:at+900_000,expires_at:at+86_400_000});
  await insert('local_auth_sessions',{token_hash:sha(primary),user_id:actor.id,auth_version:1,created_at:at,expires_at:at+86_400_000,pending_until:at+600_000,mfa_hash:sha(session)});
  await insert('mfa_management_proofs',{token_hash:sha(management),principal:actor.principal,session_hash:sha(session),expires_at:at+300_000});
  return {primary,session,management};
 }
 const post=async(actor,b,payload)=>{current=actor;const response=await consoleApi.POST(new Request(origin+'/api/console',{method:'POST',headers:sessionHeaders(b,{'Content-Type':'application/json'}),body:JSON.stringify(payload)}));return {status:response.status,body:await response.json()};};
 const status=async(actor,ids)=>{current=actor;const response=await consoleApi.GET(new Request(origin+'/api/console?offboarding='+ids.join(',')));return {status:response.status,cache:response.headers.get('Cache-Control'),body:await response.json()};};
 const proofExists=async value=>await count(sql`SELECT count(*) AS n FROM mfa_management_proofs WHERE token_hash=${sha(value)}`)===1;
 const capabilities=['refresh','agent-update','agent-uninstall','terminal','terminal-multi','terminal-live','signed-dispatch'];
 const pinned=(()=>{const key=crypto.generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({format:'jwk'});return JSON.stringify({kty:key.kty,n:key.n,e:key.e});})();
 async function device(name,{caps=capabilities,online=true,mode='ReadOnly',protocol=3,revoked=0,customer=null}={}){
  const id=uuid(),secret=token(),snapshot={protocolVersion:protocol,agentVersion:'4.9.0',mode,agentCapabilities:caps};
  await insert('servers',{id,name,token_hash:sha(secret),token_expires_at:clock+30*86_400_000,created_at:clock,last_seen:online?clock:clock-3_600_000,management:mode==='Management'?1:0,snapshot:JSON.stringify(snapshot),agent_public_key:pinned,revoked,...(customer?{customer_id:customer}:{})});
  // Like the agent: the device ID header on every post, extra headers such as X-ServerDesk-Uninstall-Job on request.
  const poll=async(results=[],runningJobs=[],headers={})=>{clock+=1000;const response=await channel.POST(new Request(origin+'/api/agent/channel',{method:'POST',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json','X-ServerDesk-Device-Id':id,...headers},body:JSON.stringify({serverId:id,results,runningJobs})}));return {status:response.status,body:await response.json()};};
  return {id,name,poll};
 }
 const job=id=>d.one(sql`SELECT state,action,target,parameters,result,result_code,result_args FROM jobs WHERE id=${id}`);
 const uninstallJobs=async serverId=>d.query(sql`SELECT id,state,target,parameters,actor_email FROM jobs WHERE server_id=${serverId} AND action='agent-uninstall' ORDER BY created_at,id`);
 const insertJob=async(serverId,actor,{state='pending',action='agent-uninstall',createdAt=clock,claimedAt=null,result=null,resultCode=null}={})=>{const id=uuid();await insert('jobs',{id,server_id:serverId,action,target:'',parameters:'{}',state,created_at:createdAt,claimed_at:claimedAt,last_progress:claimedAt,result,result_code:resultCode,actor:actor.id,actor_email:actor.label,actor_principal:actor.principal});return id;};
 const audits=(action,serverId)=>d.query(sql`SELECT actor,target,server_id,scope,customer_id FROM audit WHERE action=${action} AND (${serverId??null}::text IS NULL OR server_id=${serverId??null} OR target LIKE ${'%'+(serverId??'')})`);
 const revoked=async id=>Number((await d.one(sql`SELECT revoked FROM servers WHERE id=${id}`)).revoked);
 const {actor:owner}=await account('owner'),{actor:tech}=await account('tech',['view','manage']);
 const customer=uuid();await insert('customers',{id:customer,name:'Contoso',created_at:clock,updated_at:clock});

 // ---- the job action does not know agent-uninstall ------------------------
 {
  const host=await device('SRV-JOB'),b=await browser(owner);
  const result=await post(owner,b,{action:'job',id:host.id,kind:'agent-uninstall',params:{},confirm:true});
  check([result.status,await count(sql`SELECT count(*) AS n FROM jobs WHERE server_id=${host.id}`)],[400,0],'the job action answers 400 for agent-uninstall');
 }

 // ---- owner right and step-up proof come first ------------------------------
 {
  const host=await device('SRV-RIGHTS'),payload={action:'remove-server',id:host.id,confirm:true,uninstall:true};
  const nothing=async label=>check([await count(sql`SELECT count(*) AS n FROM jobs WHERE server_id=${host.id}`),await count(sql`SELECT count(*) AS n FROM audit WHERE server_id=${host.id}`),await revoked(host.id)],[0,0,0],label+': no job, no audit, not revoked');
  let b=await browser(tech),result=await post(tech,b,{...payload,managementToken:b.management});
  check(result.status,403,'without instance.owner the request is refused');await nothing('non-owner');
  b=await browser(owner);result=await post(owner,b,payload);
  check([result.status,result.body.code],[403,'MFA_STEP_UP_REQUIRED'],'without a proof: MFA_STEP_UP_REQUIRED');await nothing('no proof');
  await d.exec(sql`DELETE FROM mfa_management_proofs WHERE token_hash=${sha(b.management)}`);result=await post(owner,b,{...payload,managementToken:b.management});
  check([result.status,result.body.code],[403,'MFA_STEP_UP_REQUIRED'],'with a used proof: MFA_STEP_UP_REQUIRED');await nothing('used proof');
  b=await browser(owner);result=await post(owner,b,{...payload,managementToken:b.management});
  check([result.status,result.body.uninstall.queued],[200,[host.id]],'owner with a proof queues the job');
  check((await uninstallJobs(host.id)).map(row=>row.state),['pending'],'one pending job');check(await proofExists(b.management),false,'the proof row is deleted');
  const replay=await post(owner,b,{...payload,managementToken:b.management});check([replay.status,replay.body.code],[403,'MFA_STEP_UP_REQUIRED'],'a second request with the same proof is refused');
  check(await revoked(host.id),0,'queueing revokes nothing');
 }

 // ---- groups of a mixed selection --------------------------
 {
  const online=await device('SRV-ONLINE',{customer}),offline=await device('SRV-OFFLINE',{online:false}),old=await device('SRV-OLD',{caps:['refresh']}),v2=await device('SRV-V2',{protocol:2});
  const open=await device('SRV-OPEN'),gone=await device('SRV-GONE',{revoked:1}),full=await device('SRV-FULL');
  const openJob=await insertJob(open.id,owner);
  for(let n=0;n<20;n++)await insertJob(full.id,owner,{action:'refresh'});
  const ids=[online.id,offline.id,old.id,v2.id,open.id,gone.id,full.id],b=await browser(owner);
  const result=await post(owner,b,{action:'remove-servers',ids,confirm:true,uninstall:true,managementToken:b.management});
  check([result.status,result.body.ok,result.body.ids],[200,true,ids],'the response lists the selection');
  check(result.body.uninstall,{queued:[online.id,offline.id],unsupported:[old.id,v2.id],alreadyPending:[open.id],queueFull:[full.id],unchanged:[gone.id]},'each device is in exactly one group');
  check(Object.values(result.body.uninstall).flat().sort(),[...ids].sort(),'every ID is in exactly one list');
  for(const host of [online,offline]){const rows=await uninstallJobs(host.id);check(rows.map(row=>({state:row.state,target:row.target,parameters:row.parameters,actor_email:row.actor_email})),[{state:'pending',target:'',parameters:'{}',actor_email:owner.label}],host.name+': one pending job with empty parameters and target');}
  for(const host of [old,v2,full])check((await uninstallJobs(host.id)).length,0,host.name+': no job');
  check((await uninstallJobs(open.id)).map(row=>row.id),[openJob],'an open job gets no second job');
  check(await count(sql`SELECT count(*) AS n FROM servers WHERE revoked=1 AND id IN (SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))`),1,'no device is revoked (only the already revoked one)');
  const rows=await d.query(sql`SELECT actor,target,server_id,scope,customer_id FROM audit WHERE action='Agent-Deinstallation angefordert' AND server_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)) ORDER BY target`);
  const defaultCustomer=(await d.one(sql`SELECT customer_id FROM servers WHERE id=${offline.id}`)).customer_id;
  check(rows,[{actor:owner.label,target:'SRV-OFFLINE / '+offline.id,server_id:offline.id,scope:'device',customer_id:defaultCustomer},{actor:owner.label,target:'SRV-ONLINE / '+online.id,server_id:online.id,scope:'device',customer_id:customer}],'one device audit row per queued device, with its customer');
  check(await proofExists(b.management),false,'the batch consumed the proof');
 }

 // ---- claim like an agent update, in ReadOnly and Management mode -------------
 const signedJob=body=>body.signedJobs?.map(envelope=>JSON.parse(envelope.payload).job.id);
 {
  for(const mode of ['ReadOnly','Management']){
   const host=await device('SRV-CLAIM-'+mode,{mode}),id=await insertJob(host.id,owner),reply=await host.poll();
   check([reply.status,(await job(id)).state,reply.body.jobs.map(row=>row.id),signedJob(reply.body)],[200,'running',[id],[id]],mode+': the job is claimed and delivered signed');
  }
  const host=await device('SRV-TERMINAL'),id=await insertJob(host.id,owner),terminal=uuid();
  await insert('terminal_sessions',{id:terminal,server_id:host.id,principal:owner.principal,state:'open',cols:100,rows:30,created_at:clock,last_activity:clock,expires_at:clock+3_600_000});
  let reply=await host.poll();check([(await job(id)).state,reply.body.jobs],['pending',[]],'an open terminal session blocks the claim');
  await d.exec(sql`UPDATE terminal_sessions SET state='closed' WHERE id=${terminal}`);
  reply=await host.poll();check([(await job(id)).state,reply.body.jobs.map(row=>row.id)],['running',[id]],'the claim follows once the terminal is closed');
 }

 // ---- capability missing at claim ------------------------------------------
 const downgraded=await device('SRV-DOWNGRADE',{caps:['refresh','signed-dispatch','terminal-live','terminal-multi']});
 {
  const id=await insertJob(downgraded.id,owner),reply=await downgraded.poll();
  check(reply.body.jobs,[],'nothing is delivered');
  check(await job(id),{state:'cancelled',action:'agent-uninstall',target:'',parameters:'{}',result:'serverMessage.offboarding.unsupported',result_code:null,result_args:null},'the job is cancelled with its reason');
  const rows=await audits('Agent-Deinstallation fehlgeschlagen',downgraded.id);
  check([rows.length,rows[0]?.target,rows[0]?.scope],[1,'SRV-DOWNGRADE / '+downgraded.id+' / Diese Agent-Version kann sich nicht selbst deinstallieren. Aktualisiere den Agent oder entferne das Gerät ohne Deinstallation.','device'],'one failure audit row names the reason');
  check(await revoked(downgraded.id),0,'the device stays registered');
 }

 // ---- owner right withdrawn before the claim ---------------------------------
 const demotedHost=await device('SRV-DEMOTED');
 {
  const {actor:former,roleId}=await account('former');
  const id=await insertJob(demotedHost.id,former);
  await d.exec(sql`UPDATE rbac_roles SET permissions=${JSON.stringify(['view','manage'])} WHERE id=${roleId}`);
  await demotedHost.poll();
  check([(await job(id)).state,(await job(id)).result],['cancelled','serverMessage.job.permissionOrCapabilityMissing'],'without instance.owner the job is cancelled');
  check((await audits('Agent-Deinstallation fehlgeschlagen',demotedHost.id)).length,1,'one failure audit row');
  check(await revoked(demotedHost.id),0,'the device stays registered');
 }

 // ---- failure results keep the device --------------------------------
 const group=uuid();await insert('device_groups',{id:group,name:'Offboarding',description:'',created_at:clock,parent_id:null});
 const identityOf=id=>d.one(sql`SELECT revoked,token_hash,snapshot,last_seen FROM servers WHERE id=${id}`);
 const failedHosts=[];
 for(const [label,result] of [['ok:false',{ok:false,message:'A terminal or Remote Desktop session is open. Close it and try again.',code:'AGENT_UNINSTALL_TERMINAL_ACTIVE'}],['ok:true with another code',{ok:true,message:'The uninstaller could not be prepared: disk full. Nothing was uninstalled.',code:'AGENT_UNINSTALL_STAGE_FAILED',args:{detail:'disk full'}}]]){
  const host=await device('SRV-FAIL-'+failedHosts.length);failedHosts.push(host);
  await insert('device_group_members',{server_id:host.id,group_id:group});
  const id=await insertJob(host.id,owner);await host.poll();
  const before=await identityOf(host.id),reply=await host.poll([{id,...result}]);
  check(reply.status,200,label+': the channel answers');
  check(await job(id),{state:'failed',action:'agent-uninstall',target:'',parameters:'{}',result:result.message,result_code:result.code,result_args:result.args?JSON.stringify(result.args):null},label+': the job fails with result, code and arguments');
  const rows=await audits('Agent-Deinstallation fehlgeschlagen',host.id);
  check([rows.length,rows[0]?.target],[1,host.name+' / '+host.id+' / '+result.message],label+': exactly one failure audit row with the reason');
  const after=await identityOf(host.id);
  check([after.revoked,after.token_hash,after.snapshot],[0,before.token_hash,before.snapshot],label+': revoked=0, token and snapshot unchanged');
  check(await count(sql`SELECT count(*) AS n FROM device_group_members WHERE server_id=${host.id}`),1,label+': group membership unchanged');
  check((await audits('Gerät aus Portal entfernt',host.id)).length,0,label+': no removal audit');
 }

 // ---- the started result revokes with the removal cleanup -------------
 const uninstalledHost=await device('SRV-UNINSTALLED',{customer});
 {
  const host=uninstalledHost,customerGroup=uuid();
  await insert('device_groups',{id:customerGroup,name:'Contoso devices',description:'',created_at:clock,parent_id:null,customer_id:customer});
  await insert('device_group_members',{server_id:host.id,group_id:customerGroup});
  const id=await insertJob(host.id,owner);let reply=await host.poll();check(reply.body.jobs.map(row=>row.id),[id],'the job is claimed');
  const terminal=uuid();await insert('terminal_sessions',{id:terminal,server_id:host.id,principal:owner.principal,state:'closed',cols:100,rows:30,created_at:clock,last_activity:clock,expires_at:clock+3_600_000});
  const later=await insertJob(host.id,owner,{action:'refresh'});
  reply=await host.poll([{id,ok:true,message:'The agent started to uninstall itself. The device can no longer connect to the portal.',code:'AGENT_UNINSTALL_STARTED'}]);
  check([reply.status,reply.body],[200,{ok:true,jobs:[],signedJobs:[],transfers:[],signedTransfers:[],intervalMs:5000}],'the delivering request gets 200 without work or terminal commands');
  check(await job(id),{state:'succeeded',action:'agent-uninstall',target:'',parameters:'{}',result:'The agent started to uninstall itself. The device can no longer connect to the portal.',result_code:'AGENT_UNINSTALL_STARTED',result_args:null},'the uninstall job succeeds and is not cancelled by the cleanup');
  check((await job(later)).state,'cancelled','other pending jobs are cancelled as in removeDevices');
  const row=await d.one(sql`SELECT revoked,token_hash,snapshot,last_seen,agent_public_key FROM servers WHERE id=${host.id}`);
  check([row.revoked,row.token_hash.startsWith('revoked:'),row.snapshot,row.last_seen,row.agent_public_key],[1,true,null,null,null],'the device is revoked: token cleared, snapshot and key removed');
  check(await count(sql`SELECT count(*) AS n FROM device_group_members WHERE server_id=${host.id}`),0,'group membership deleted');
  check(await count(sql`SELECT count(*) AS n FROM terminal_sessions WHERE server_id=${host.id} AND error=${'serverMessage.device.removed'}`),1,'sessions closed by the cleanup');
  const started=await audits('Agent-Deinstallation gestartet',host.id),removed=await d.query(sql`SELECT actor,target,scope,customer_id FROM audit WHERE action='Gerät aus Portal entfernt' AND target=${host.name+' / '+host.id}`);
  check(started.map(entry=>({actor:entry.actor,scope:entry.scope,customer_id:entry.customer_id})),[{actor:owner.label,scope:'device',customer_id:customer}],'exactly one started audit row');
  check(removed,[{actor:owner.label,target:host.name+' / '+host.id,scope:'portal',customer_id:customer}],'exactly one removal audit row with the job actor and the customer');
  reply=await host.poll();check(reply.status,403,'the next channel request with the old token is refused');
 }

 // ---- after a failure, remove without uninstall or try again ---------
 {
  const [plain,retry]=failedHosts;let b=await browser(owner);
  let result=await post(owner,b,{action:'remove-servers',ids:[plain.id],confirm:true,managementToken:b.management});
  check([result.status,result.body.removedCount,await revoked(plain.id)],[200,1,1],'a plain removal without uninstall revokes the device as today');
  b=await browser(owner);result=await post(owner,b,{action:'remove-servers',ids:[retry.id],confirm:true,uninstall:true,managementToken:b.management});
  check([result.status,result.body.uninstall.queued,(await uninstallJobs(retry.id)).map(row=>row.state)],[200,[retry.id],['failed','pending']],'a retry with uninstall:true queues a new job');
  // An owner cancels the pending job with cancel-job: failed/cancelled, still registered.
  const pending=(await uninstallJobs(retry.id)).at(-1).id;b=await browser(owner);
  result=await post(owner,b,{action:'cancel-job',id:pending});check(result.status,200,'cancel-job cancels the pending uninstall job');
  const entry=(await status(owner,[retry.id])).body.devices[0];check([entry.state,entry.reason,await revoked(retry.id)],['failed','cancelled',0],'after cancel-job: failed/cancelled and still registered');
 }

 // ---- offboarding status --------------------------------------------------------
 {
  const waiting=await device('SRV-WAITING'),running=await device('SRV-RUNNING'),stale=await device('SRV-STALE',{online:false}),agent=await device('SRV-AGENT'),registered=await device('SRV-REGISTERED'),gone=await device('SRV-REVOKED',{revoked:1}),neverClaimed=await device('SRV-EXPIRED',{online:false}),old=await device('SRV-OLDAGENT',{caps:['refresh']});
  const waitingJob=await insertJob(waiting.id,owner),runningJob=await insertJob(running.id,owner,{state:'running',claimedAt:clock});
  await insertJob(stale.id,owner,{createdAt:clock-PENDING_JOB_LIFETIME_MS-1000});
  await insertJob(neverClaimed.id,owner,{state:'expired',result:'serverMessage.job.pendingExpired'});
  const agentJob=await insertJob(agent.id,owner,{state:'failed',result:'A file transfer is in progress. Try again when it is complete.',resultCode:'AGENT_UNINSTALL_TRANSFER_ACTIVE'});
  const ids=[waiting.id,running.id,stale.id,agent.id,downgraded.id,demotedHost.id,uninstalledHost.id,gone.id,registered.id,neverClaimed.id,old.id];
  const result=await status(owner,ids);
  check([result.status,result.cache],[200,'no-store'],'the status answers with Cache-Control: no-store');
  const pick=entry=>[entry.id,entry.state,entry.reason??null];
  check(result.body.devices.map(pick),[[waiting.id,'waiting',null],[running.id,'running',null],[stale.id,'failed','offline'],[agent.id,'failed','agent'],[downgraded.id,'failed','unsupported'],[demotedHost.id,'failed','cancelled'],[uninstalledHost.id,'uninstalled',null],[gone.id,'revoked',null],[registered.id,'registered',null],[neverClaimed.id,'failed','offline'],[old.id,'failed','unsupported']],'one entry per ID with its state');
  const agentEntry=result.body.devices.find(entry=>entry.id===agent.id);
  check([agentEntry.name,agentEntry.code,agentEntry.jobId],['SRV-AGENT','AGENT_UNINSTALL_TRANSFER_ACTIVE',agentJob],'an agent failure carries the code and the job');
  check([result.body.devices[0].jobId,result.body.devices[1].jobId],[waitingJob,runningJob],'open rows carry their job');
  const refused=await status(tech,[waiting.id]);check(refused.status,403,'a non-owner gets 403');
  const unknown=await status(owner,[waiting.id,uuid()]);check([unknown.status,unknown.body.error],[404,serverText('apiError.devices.offboardingNotFound')],'an unknown ID answers 404');
  check((await status(owner,['nope'])).status,400,'an invalid ID answers 400');
 }

 // ---- an expired pending job is not delivered and revokes nothing ----------------
 {
  const host=await device('SRV-LATE',{online:false}),id=await insertJob(host.id,owner);
  clock+=PENDING_JOB_LIFETIME_MS+60_000;
  const reply=await host.poll();
  check([reply.status,reply.body.jobs,(await job(id)).state,await revoked(host.id)],[200,[],'pending',0],'past the lifetime the job is not delivered and the device stays registered');
  check((await status(owner,[host.id])).body.devices[0].reason,'offline','the status names the offline reason');
 }

 const start={ok:true,message:'The agent started to uninstall itself. The device can no longer connect to the portal.',code:'AGENT_UNINSTALL_STARTED'};
 const generic={error:serverText('apiError.agent.notApproved'),code:'FORBIDDEN'},uninstallHeader=id=>({'X-ServerDesk-Uninstall-Job':id});
 // ---- The refusal of a revoked device proves the uninstall only with its job ID ----
 {
  const host=await device('SRV-CONFIRM'),other=await device('SRV-CONFIRM-OTHER'),live=await device('SRV-CONFIRM-LIVE');
  const id=await insertJob(host.id,owner),otherJob=await insertJob(other.id,owner);await host.poll();await other.poll();
  check((await other.poll([{id:otherJob,...start}])).status,200,'the other device is revoked by its own start result');
  let reply=await host.poll([{id,...start}],[],uninstallHeader(id));
  check([reply.status,reply.body],[200,{ok:true,jobs:[],signedJobs:[],transfers:[],signedTransfers:[],intervalMs:5000}],'the revoking start result with the uninstall header gets the early 200');
  reply=await host.poll([],[],uninstallHeader(id));
  check([reply.status,reply.body],[403,{error:serverText('apiError.agent.uninstallConfirmed'),code:'AGENT_UNINSTALL_CONFIRMED'}],'the device ID and its uninstall job ID get 403 AGENT_UNINSTALL_CONFIRMED');
  for(const [label,headers] of [['without the uninstall header',{}],['with a random job ID',uninstallHeader(uuid())],['with the job ID of another device',uninstallHeader(otherJob)],['with a non-GUID header',uninstallHeader('not-a-guid')]]){
   reply=await host.poll([],[],headers);check([reply.status,reply.body],[403,generic],'a revoked device '+label+' gets the generic 403');
  }
  const at=Number((await d.one(sql`SELECT last_progress FROM jobs WHERE id=${id}`)).last_progress);
  clock=at+900_000-1000;reply=await host.poll([],[],uninstallHeader(id));
  check([reply.status,reply.body.code],[403,'AGENT_UNINSTALL_CONFIRMED'],'exactly 15 minutes after the start the confirmation still holds');
  clock=at+900_001-1000;reply=await host.poll([],[],uninstallHeader(id));
  check([reply.status,reply.body],[403,generic],'15 minutes and 1 second after the start the answer is the generic 403');
  // A live device with a valid token and the header is processed as normal.
  const pending=await insertJob(live.id,owner,{action:'refresh'});
  reply=await live.poll([],[],uninstallHeader(uuid()));
  check([reply.status,reply.body.jobs.map(row=>row.id)],[200,[pending]],'a live device with the uninstall header is processed as normal');
  // A plain removal while the uninstall job runs expires the job: no confirmation.
  const removed=await device('SRV-CONFIRM-REMOVED'),running=await insertJob(removed.id,owner);await removed.poll();
  const b=await browser(owner),result=await post(owner,b,{action:'remove-servers',ids:[removed.id],confirm:true,managementToken:b.management});
  check([result.status,(await job(running)).state,await revoked(removed.id)],[200,'expired',1],'a plain removal expires the running uninstall job');
  reply=await removed.poll([],[],uninstallHeader(running));
  check([reply.status,reply.body],[403,generic],'a device removed by a plain removal gets the generic 403 with its job ID');
 }

 // ---- A start result that revokes nothing gets 409 and no work ----
 {
  const other=await device('SRV-NOTCONFIRMED-OTHER');
  const cases=[
   ['a cancelled uninstall job',host=>insertJob(host.id,owner,{state:'cancelled',result:'serverMessage.runbook.stepCancelled'})],
   ['an uninstall job expired while it ran',host=>insertJob(host.id,owner,{state:'expired',claimedAt:clock-60_000,result:'serverMessage.runbook.resultUnknown'})],
   ['an unknown job ID',async()=>uuid()],
   ['the uninstall job of another device',()=>insertJob(other.id,owner,{state:'running',claimedAt:clock})],
  ];
  for(const [n,[label,make]] of cases.entries()){
   const host=await device('SRV-NOTCONFIRMED-'+n),pending=await insertJob(host.id,owner,{action:'refresh'}),runningRefresh=await insertJob(host.id,owner,{action:'refresh',state:'running',claimedAt:clock});
   const target=await make(host),before=await job(target);
   const reply=await host.poll([{id:target,...start},{id:runningRefresh,ok:true,message:'Inventory refreshed.'}]);
   check([reply.status,reply.body],[409,{error:serverText('apiError.agent.uninstallNotConfirmed'),code:'AGENT_UNINSTALL_NOT_CONFIRMED'}],label+': 409 AGENT_UNINSTALL_NOT_CONFIRMED');
   check([await revoked(host.id),await job(target)],[0,before],label+': the device stays registered and the job is unchanged');
   check([(await audits('Agent-Deinstallation gestartet',host.id)).length,(await audits('Gerät aus Portal entfernt',host.id)).length],[0,0],label+': no started or removal audit');
   check([(await job(pending)).state,(await job(runningRefresh)).state,await count(sql`SELECT count(*) AS n FROM device_leases WHERE server_id=${host.id}`)],['pending','succeeded',0],label+': the other result is stored, no job is claimed and no lease is taken');
  }
  check([await revoked(other.id),(await audits('Agent-Deinstallation gestartet',other.id)).length],[0,0],'the other device keeps its registration');
  // An ok:false result for a job that does not run is still skipped with the normal 200.
  const host=await device('SRV-NOTCONFIRMED-FAILURE'),cancelled=await insertJob(host.id,owner,{state:'cancelled',result:'serverMessage.runbook.stepCancelled'});
  const reply=await host.poll([{id:cancelled,ok:false,message:'The portal did not confirm the uninstall.',code:'AGENT_UNINSTALL_STAGE_FAILED',args:{detail:'The portal did not confirm the uninstall'}}]);
  check([reply.status,reply.body.ok,(await job(cancelled)).state],[200,true,'cancelled'],'an ok:false result for a cancelled uninstall job gets the normal 200');
 }

 // ---- The English docs name the English switch label ----
 for(const file of ['../../docs/native-agent-v4.md','../../agent/v3/README.md']){
  const text=fs.readFileSync(new URL(file,import.meta.url),'utf8');
  check([text.includes('Agent auf dem Gerät deinstallieren'),text.includes('**Uninstall the agent on the device**')],[false,true],file+' names the English switch label only');
 }
 console.log(`PASS agent uninstall (${checks} assertions): queueing through the removal actions with owner, MFA and step-up checks, groups and audit; claim like an agent update; capability and rights loss cancel; failures keep the device; only AGENT_UNINSTALL_STARTED revokes with the removal cleanup and a 200 answer; a start that revokes nothing gets 409; a revoked device proves the uninstall only with its job ID; offboarding status; English docs.`);
}finally{d.close();}
