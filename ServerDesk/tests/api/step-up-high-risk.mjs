// Opening a SYSTEM terminal, creating a personal registration (enroll) and device
// removal need a fresh MFA step-up proof (managementToken). The proof is part of the write's admission and
// consumed in the same batch. Validation and the existing preconditions answer
// first. Rolling out a signed agent release (deploy) is routine: it relies on
// the live MFA login session behind mfaSessionFence, reads no proof and leaves
// a supplied one unused. Real
// routes and libraries (terminal, releases, console, access, rbac, mfa,
// local-auth, terminal lifecycle) run against an isolated migrated PostgreSQL test database.
import {serverText} from '../support/server-text.mjs';
import {HttpError as realHttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
import {sourceDatabase,sourceLoader,sourceActor,insertRow} from '../support/source-database.mjs';

import {sessionHeaders} from '../support/session-cookies.mjs';
import {sql} from '../../runtime/database.mjs';

import {hookDatabase} from '../support/hooked-database.mjs';
const d=await sourceDatabase();
let checks=0;
const check=(value,expected,label)=>{assert.deepEqual(value,expected,label);checks++;};
try{
 const origin='https://high-risk.test',time=Date.now();
 const HttpError=realHttpError;
 const token=()=>crypto.randomBytes(32).toString('hex'),sha=value=>crypto.createHash('sha256').update(value).digest('hex'),uuid=()=>crypto.randomUUID();
 // The one-shot hook runs right before the next batch; every batch's SQL is recorded.
 let beforeBatch=null,current=null,signer={publicKey:'fixture-job-key'},pending=false;const batches=[],logs=[],leases=[];
 const facade=hookDatabase(d,{transaction:async()=>{if(beforeBatch){const hook=beforeBatch;beforeBatch=null;await hook();}},record:batches});
 const identity=async()=>{if(!current)throw new HttpError(401,'Bitte anmelden.','IDENTITY_LOGIN_REQUIRED');return current;};
 const server={
  db:()=>facade,config:key=>key==='SESSION_SECRET'?'s'.repeat(64):key==='SITE_ORIGIN'?origin:'',now:()=>Date.now(),random:token,hash:async value=>sha(value),HttpError,
  guid:x=>typeof x==='string'&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(x),body:request=>request.json(),sameOrigin:()=>{},
  requireViewer:identity,requireIdentity:identity,requireAuthIdentity:async()=>current,
  log:async(...entry)=>{logs.push(entry);},
  failure:e=>Response.json({error:e instanceof HttpError?e.message:serverText('apiError.storageUnavailable'),...(e instanceof HttpError&&e.code?{code:e.code}:{})},{status:e instanceof HttpError?e.status:503}),
 };
 const snapshotOf=device=>JSON.parse(device.snapshot||'{}');
 const v3={modern:snapshotOf,snapshot:snapshotOf,maintenanceBusy:async()=>false,pendingWork:async()=>pending,pendingTransfers:async()=>false,lease:async(...args)=>{leases.push(args);},releaseLease:async()=>{},bucket:()=>({}),CHUNK_SIZE:262144,MAX_TRANSFER:1<<30,securityFile:()=>false};
 // Releases are verified by a fixture publisher: the signature 'signed' is valid.
 const releaseRow={id:uuid(),version:'4.6.0',manifest:'{"version":"4.6.0"}',signature:'signed'};
 const releases={releases:async()=>[],releaseEnvelopes:async()=>({release:releaseRow,path:releaseRow}),retireRelease:async()=>({release:releaseRow,cancelledJobs:0}),
  verifiedRelease:(manifest,signature)=>{if(signature!=='signed')throw new HttpError(400,serverText('apiError.release.signatureInvalid'));const parsed=JSON.parse(manifest);return {version:parsed.version,sha256:'a'.repeat(64),size:100};}};
 // Leaves the routes import but these flows never reach (agent packages, R2, RDP).
 const imports={'../context':server,'./context':server,'../../context':server,'@/lib/server/context':server,'../agent/agent-protocol':v3,'@/lib/server/agent/agent-protocol':v3,'./transfers':{clearTransfer:async()=>{}},
  '@/lib/management':{operations:{},safeTarget:()=>''},'@/lib/server/agent/agent-crypto':{sealAgentSecrets:async()=>({})},'@/agent/package-v3':{installerV3:()=>'',registrationV3:c=>JSON.stringify({id:c.id,jobSigningKey:c.jobSigningKey})},
  '@/lib/server/agent/agent-dispatch':{dispatchSigner:()=>signer,JOB_SIGNING_KEY_MISSING:'Der Signaturschlüssel fehlt.'},'@/lib/server/devices/rdp':{sweepRdp:async()=>{}},'@/lib/server/agent/releases':releases};
 const load=sourceLoader();
 const terminalApi=load('app/api/terminal/route.ts',imports),releasesApi=load('app/api/releases/route.ts',imports),consoleApi=load('app/api/console/route.ts',imports),stepUp=load('lib/step-up.ts',imports);

 // ---- One dependency-free classification, read by the routes ------------------
 {
  const source=readFileSync('lib/step-up.ts','utf8');
  check(/^\s*import\b|\brequire\(|\bimport\(/m.test(source),false,'lib/step-up.ts imports nothing');
  check([...stepUp.terminalStepUpActions].sort(),['open'],'terminal actions that need step-up');
  check(['releaseStepUpActions','releaseActionNeedsStepUp'].filter(name=>name in stepUp),[],'lib/step-up.ts has no release step-up set or predicate: no release action needs a proof');
  check([...stepUp.consoleStepUpActions].sort(),['enroll','move-customer','remove-server','remove-servers'],'console actions that need step-up');
  check([...stepUp.deviceRemovalActions].sort(),['remove-server','remove-servers'],'device removal actions without the removed revoke action');
  check([...stepUp.accessWideningStepUpActions].sort(),['assign-device','set-device-memberships','update-device-memberships'],'access actions that need step-up when they widen access');
  for(const [predicate,yes,no] of [['terminalActionNeedsStepUp',['open'],['input','resize','heartbeat','close']],['consoleActionNeedsStepUp',['enroll','remove-server','remove-servers'],['job','cancel-job',['revoke','server'].join('-')]]]){
   for(const action of yes)check(stepUp[predicate](action),true,`${predicate}(${action})`);
   for(const action of [...no,undefined,null,42])check(stepUp[predicate](action),false,`${predicate}(${String(action)})`);
  }
  check(stepUp.isDeviceRemovalAction('enroll'),false,'enroll is no removal');
  for(const [file,pattern,count] of [['lib/server/devices/terminal-sessions.ts',/terminalActionNeedsStepUp\(p\.action\)/g,1],['app/api/console/route.ts',/consoleActionNeedsStepUp\(p\.action\)/g,1]]){
   const text=readFileSync(file,'utf8');check([/from '(?:@\/lib|\.|\.\.\/\.\.)\/step-up'/.test(text),text.match(pattern)?.length],[true,count],file+' decides by lib/step-up.ts');
   check(/\['deploy','import'\]|action==='open'&&.*managementToken|\['enroll'/.test(text),false,file+' keeps no own list');
  }
  check(existsSync('app/api/releases/upload/route.ts'),false,'the portal release upload is gone');
  {
   const text=readFileSync('app/api/releases/route.ts','utf8');
   check([/prepareManagementAuthorization/.test(text),/step-up'/.test(text),/set-token|remove-token/.test(text)],[false,false,false],'app/api/releases/route.ts reads no step-up proof and has no token action');
  }
 }

 // ---- Fixture -------------------------------------------------------------------
 const insert=(table,row)=>insertRow(d,table,row);
 const count=async statement=>Number((await d.one(statement)).n);
 async function account(label,permissions=['*']){
  const {actor}=await sourceActor(d,label,permissions);actor.userId=actor.id;
  await d.exec(sql`UPDATE local_users SET password_hash='fixture-password',must_reset=0 WHERE id=${actor.id}`);
  await insert('mfa_accounts',{principal:actor.principal,secret_enc:'migrated:authenticator-managed',recovery_hashes:'[]',last_counter:-1,created_at:time,authenticators_migrated:1});
  return actor;
 }
 // A signed-in browser: bound primary session, live MFA session and one fresh management proof.
 async function browser(actor,{proof=true}={}){
  const at=Date.now(),primary=token(),session=token(),management=token();
  await insert('mfa_sessions',{token_hash:sha(session),principal:actor.principal,created_at:at,last_activity:at,idle_expires_at:at+900_000,expires_at:at+86_400_000});
  await insert('local_auth_sessions',{token_hash:sha(primary),user_id:actor.id,auth_version:1,created_at:at,expires_at:at+86_400_000,pending_until:at+600_000,mfa_hash:sha(session)});
  if(proof)await insert('mfa_management_proofs',{token_hash:sha(management),principal:actor.principal,session_hash:sha(session),expires_at:at+300_000});
  return {primary,session,management:proof?management:null};
 }
 const newProof=async(actor,b)=>{const value=token();await insert('mfa_management_proofs',{token_hash:sha(value),principal:actor.principal,session_hash:sha(b.session),expires_at:Date.now()+300_000});return value;};
 const post=async(api,path,actor,b,payload)=>{current=actor;batches.length=0;const response=await api.POST(new Request(origin+path,{method:'POST',headers:sessionHeaders(b,{'Content-Type':'application/json'}),body:JSON.stringify(payload)}));const text=await response.text();let body;try{body=JSON.parse(text);}catch{body={text};}return {status:response.status,body};};
 const proofExists=async value=>await count(sql`SELECT count(*) AS n FROM mfa_management_proofs WHERE token_hash=${sha(value)}`)===1;
 const deleteProof=value=>()=>d.exec(sql`DELETE FROM mfa_management_proofs WHERE token_hash=${sha(value)}`);
 const committedWith=(marker)=>batches.find(batch=>batch.some(sql=>sql.startsWith(marker)));
 const consumesProof=batch=>!!batch?.some(sql=>/^DELETE FROM mfa_management_proofs WHERE token_hash=\$\d+/.test(sql));
 const device=async(name,capabilities=['terminal','terminal-multi'],extra={})=>{const id=uuid();await insert('servers',{id,name,token_hash:'fixture-'+id,created_at:time,last_seen:time,management:1,snapshot:JSON.stringify({protocolVersion:3,agentVersion:'4.5.0',mode:'Management',agentCapabilities:capabilities}),...extra});return id;};
 // Missing, garbage, unknown and used tokens: 403 MFA_STEP_UP_REQUIRED and nothing changes.
 async function refusedWithout(label,actor,send,state){
  for(const kind of ['missing','garbage','unknown','used']){
   const b=await browser(actor),supplied={missing:undefined,garbage:'kein-token',unknown:token(),used:b.management}[kind];
   if(kind==='used')await deleteProof(b.management)();
   const before=await state(),result=await send(b,supplied);
   check([result.status,result.body.code],[403,'MFA_STEP_UP_REQUIRED'],`${label} ${kind} token: 403 MFA_STEP_UP_REQUIRED (${result.body.error})`);
   check(await state(),before,`${label} ${kind} token: nothing is written`);
  }
 }
 const owner=await account('owner@high-risk.test');
 const withToken=(payload,value)=>value===undefined?payload:{...payload,managementToken:value};

 // ---- Terminal open --------------------------------------------------------------
 {
  const terminal=(b,payload)=>post(terminalApi,'/api/terminal',owner,b,payload);
  const host=await device('SRV-TERMINAL'),readOnly=await device('SRV-READONLY',['terminal','terminal-multi'],{management:0}),single=await device('SRV-SINGLE',['terminal']);
  const sessions=()=>count(sql`SELECT count(*) AS n FROM terminal_sessions`);
  const state=async()=>({sessions:await sessions(),leases:leases.length});
  const open=(serverId=host,extra={})=>({action:'open',serverId,confirm:true,cols:100,rows:30,...extra});
  await refusedWithout('terminal open',owner,(b,value)=>terminal(b,withToken(open(),value)),state);
  await refusedWithout('terminal open (single-shell agent, no lease)',owner,(b,value)=>terminal(b,withToken(open(single),value)),state);
  // Invalid input and existing preconditions answer first with their status; the proof stays.
  for(const [label,payload,status] of [['missing confirm',open(host,{confirm:false}),400],['unknown device',open(uuid()),404],['no Management mode',open(readOnly),403]]){
   const b=await browser(owner),before=await state(),result=await terminal(b,{...payload,managementToken:b.management});
   check([result.status,result.body.code===undefined||result.body.code!=='MFA_STEP_UP_REQUIRED'],[status,true],`terminal ${label}: ${status} (${result.body.error})`);
   check([await state(),await proofExists(b.management)],[before,true],`terminal ${label}: nothing written, the proof remains`);
  }
  // Pending work (single-shell agent) and agent maintenance (multi-shell agent) also answer first.
  {
   pending=true;let b=await browser(owner),before=await state(),result=await terminal(b,{...open(single),managementToken:b.management});pending=false;
   check([result.status,result.body.error],[409,serverText('apiError.terminal.finishJobs')],'terminal pending work: 409 first');check([await state(),await proofExists(b.management)],[before,true],'terminal pending work: nothing written, the proof remains');
   const job=uuid();await insert('jobs',{id:job,server_id:host,action:'agent-update',target:'4.6.0',parameters:'{}',state:'running',created_at:time,actor:owner.id,actor_email:owner.label,actor_principal:owner.principal});
   b=await browser(owner);before=await state();result=await terminal(b,{...open(),managementToken:b.management});
   check([result.status,result.body.error],[409,serverText('apiError.terminal.finishMaintenance')],'terminal maintenance: 409 first');check([await state(),await proofExists(b.management)],[before,true],'terminal maintenance: nothing written, the proof remains');
   await d.exec(sql`DELETE FROM jobs WHERE id=${job}`);
  }
  // A refused insert (session limit) answers as today and leaves the proof.
  {
   const others=[];
   for(let n=0;n<4;n++){const other=await account(`other${n}@high-risk.test`),ob=await browser(other,{proof:false}),id=uuid();others.push(id);const at=Date.now();await insert('terminal_sessions',{id,server_id:host,principal:other.principal,mfa_hash:sha(ob.session),state:'open',cols:100,rows:30,created_at:at,last_activity:at,expires_at:at+3_600_000});}
   const b=await browser(owner),before=await sessions(),result=await terminal(b,{...open(),managementToken:b.management});
   check([result.status,result.body.error],[409,serverText('apiError.terminal.limitMultiuser')],'terminal session limit: the reply as today');
   check([await sessions(),await proofExists(b.management)],[before,true],'terminal session limit: no session, the proof remains for a retry');
   await d.exec(sql`UPDATE terminal_sessions SET state='closed' WHERE id IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(others)}::jsonb))`);
  }
  // The proof is part of the insert's admission: it disappears right before the batch.
  {
   const b=await browser(owner),before=await state();beforeBatch=deleteProof(b.management);
   const result=await terminal(b,{...open(),managementToken:b.management});
   check([beforeBatch,result.status,result.body.code],[null,403,'MFA_STEP_UP_REQUIRED'],'terminal: a proof that vanishes before the batch is refused');check(await state(),before,'terminal: no session is created');
  }
  // With a valid proof the session row is inserted as today; the proof goes in the same batch.
  const b=await browser(owner),result=await terminal(b,{...open(),managementToken:b.management});
  check([result.status,result.body.resumed,result.body.state],[200,false,'opening'],`terminal open with a proof: a new shell (${result.body.error})`);
  check(await proofExists(b.management),false,'terminal open: the proof is consumed');
  const opening=committedWith('INSERT INTO terminal_sessions');check([consumesProof(opening),opening?.[0].startsWith('SELECT 1 AS confirmed WHERE')],[true,true],'terminal open: the insert and the proof DELETE share one batch');
  check(await count(sql`SELECT count(*) AS n FROM terminal_sessions WHERE id=${result.body.id} AND principal=${owner.principal} AND state='opening'`),1,'terminal open: the session row exists');
  check(logs.at(-1)?.slice(1,3),['SYSTEM-Terminal geöffnet',result.body.id],'terminal open: logged as today');
  // The same token resumes the shell just opened; without a token too. A supplied proof stays unused.
  {
   const again=await terminal(b,{...open(),managementToken:b.management});check([again.status,again.body.resumed,again.body.id],[200,true,result.body.id],'terminal: the same token resumes the shell just opened');
   const unused=await newProof(owner,b),resumed=await terminal(b,{...open(),managementToken:unused});check([resumed.status,resumed.body.resumed,await proofExists(unused)],[200,true,true],'terminal resume: a supplied proof stays unused');
   const plain=await terminal(b,open());check([plain.status,plain.body.resumed],[200,true],'terminal resume: no token needed');
   check(await count(sql`SELECT count(*) AS n FROM terminal_sessions WHERE principal=${owner.principal} AND state IN ('opening','open')`),1,'terminal resume: no second shell');
  }
  // Once the shell is closed, the used token is refused.
  await d.exec(sql`UPDATE terminal_sessions SET state='closed' WHERE id=${result.body.id}`);
  const replay=await terminal(b,{...open(),managementToken:b.management});check([replay.status,replay.body.code],[403,'MFA_STEP_UP_REQUIRED'],'terminal: a used token is refused');
 }

 // ---- Release deploy and the release source ---------------------------------------
 {
  const release=(b,payload)=>post(releasesApi,'/api/releases',owner,b,payload);
  const state=async()=>({releases:await count(sql`SELECT count(*) AS n FROM agent_releases`),jobs:await count(sql`SELECT count(*) AS n FROM jobs WHERE action='agent-update'`),audit:await count(sql`SELECT count(*) AS n FROM audit`)});
  // The record-only import is gone: it answers like any unknown action and reads no proof.
  {
   const b=await browser(owner),before=await state(),result=await release(b,{action:'import',manifest:JSON.stringify({version:'4.7.1'}),signature:'signed',managementToken:b.management});
   check([result.status,result.body.error],[400,serverText('apiError.release.pilotDevicesRequired')],'release import: answers like an unknown action');check([await state(),await proofExists(b.management)],[before,true],'release import: no release row, the proof remains');
  }
  // The release source has no token since the repository is public: set-token
  // and remove-token answer like any unknown action, change nothing and keep the proof; check needs none.
  {
   const sourceState=async()=>({source:await d.one(sql`SELECT * FROM agent_release_source WHERE id=1`),audit:await count(sql`SELECT count(*) AS n FROM audit`)});
   for(const payload of [{action:'set-token',token:'github_pat_'+'A1b2'.repeat(10)},{action:'remove-token'}]){
    const b=await browser(owner),before=await sourceState(),result=await release(b,{...payload,managementToken:b.management});
    check([result.status,result.body.error],[400,serverText('apiError.release.pilotDevicesRequired')],`release ${payload.action}: answers like an unknown action`);
    check([await sourceState(),await proofExists(b.management)],[before,true],`release ${payload.action}: no source row or audit change, the proof remains`);
   }
   {
    const b=await browser(owner,{proof:false}),result=await release(b,{action:'check'});
    check([result.status,result.body.source?.state],[200,'queued'],`check needs no proof (${result.body.error})`);
   }
  }
  // Deploy: payload and per-device checks answer first.
  const updatable=()=>device('SRV-UPDATE-'+uuid().slice(0,8),['agent-update','release-paths']);
  const deploy=(serverIds,extra={})=>({action:'deploy',releaseId:releaseRow.id,serverIds,confirm:true,...extra});
  const targets=[await updatable(),await updatable()];
  const current=await device('SRV-CURRENT',['agent-update','release-paths']);await d.exec(sql`UPDATE servers SET snapshot=jsonb_set(snapshot::jsonb,'{agentVersion}','"4.6.0"')::text WHERE id=${current}`);
  const busy=await updatable();await insert('jobs',{id:uuid(),server_id:busy,action:'agent-update',target:'4.6.0',parameters:'{}',state:'pending',created_at:time,actor:owner.id,actor_email:owner.label,actor_principal:owner.principal});
  for(const [label,payload,status] of [['missing confirm',deploy(targets,{confirm:false}),400],['empty target list',deploy([]),400],['maintenance window too far',deploy(targets,{scheduledAt:Date.now()+30*86400000}),400],['same version',deploy([current]),409],['active update',deploy([busy]),409]]){
   const b=await browser(owner),before=await state(),result=await release(b,{...payload,managementToken:b.management});
   check(result.status,status,`release deploy ${label}: ${status} (${result.body.error})`);check([await state(),await proofExists(b.management)],[before,true],`release deploy ${label}: nothing written, the proof remains`);
  }
  // Without a live MFA session: the requireMfa error before any write.
  {
   const b=await browser(owner,{proof:false}),before=await state();
   const noCookie=await release({primary:b.primary},deploy(targets));
   check([noCookie.status,noCookie.body.code],[403,'MFA_LOGIN_REQUIRED'],`release deploy without an MFA session cookie: MFA_LOGIN_REQUIRED (${noCookie.body.error})`);
   await d.exec(sql`DELETE FROM mfa_sessions WHERE token_hash=${sha(b.session)}`);
   const ended=await release(b,deploy(targets));
   check(ended.body.code,'SESSION_EXPIRED',`release deploy with an ended MFA session: SESSION_EXPIRED (${ended.body.error})`);
   check(await state(),before,'release deploy without a live MFA session: nothing is written');
  }
  // The MFA session ends between the route checks and the batch: the fence admits no job.
  {
   const b=await browser(owner,{proof:false}),before=await state(),customerEntries=await count(sql`SELECT count(*) AS n FROM audit WHERE scope='customer'`);
   beforeBatch=()=>d.exec(sql`DELETE FROM mfa_sessions WHERE token_hash=${sha(b.session)}`);
   const result=await release(b,deploy(targets));
   check([beforeBatch,result.body.code],[null,'SESSION_EXPIRED'],`release deploy: an MFA session that ends before the batch answers the MFA-session error, not rolloutChanged (${result.body.error})`);
   check([await state(),await count(sql`SELECT count(*) AS n FROM audit WHERE scope='customer'`)],[before,customerEntries],'release deploy: no job and no customer entry');
   const batch=committedWith('INSERT INTO jobs');check(/FROM mfa_sessions live_session/.test(batch?.find(text=>text.startsWith('INSERT INTO jobs'))??''),true,'release deploy: the job INSERT carries mfaSessionFence');
  }
  // Without a token: one job per device on the MFA login session, logged as today.
  {
   const b=await browser(owner,{proof:false}),from=logs.length,result=await release(b,deploy(targets));
   check([result.status,result.body.jobs?.length,typeof result.body.scheduledAt],[200,2,'number'],`release deploy without a token: one job per device (${result.body.error})`);
   check(await count(sql`SELECT count(*) AS n FROM jobs WHERE action='agent-update' AND id IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(result.body.jobs)}::jsonb))`),2,'release deploy: the jobs exist');
   check(logs.slice(from).map(entry=>[entry[1],entry[2],entry[3]]),[['Agentupdate geplant',releaseRow.version,targets]],'release deploy: the audit row agentUpdateScheduled as today');
   check(consumesProof(committedWith('INSERT INTO jobs')),false,'release deploy: no proof DELETE in the batch');
   await d.exec(sql`DELETE FROM jobs WHERE action='agent-update' AND id IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(result.body.jobs)}::jsonb))`);
  }
  // A supplied token is neither read nor consumed.
  {
   const b=await browser(owner),result=await release(b,{...deploy(targets),managementToken:b.management});
   check([result.status,result.body.jobs?.length],[200,2],`release deploy with a token: one job per device (${result.body.error})`);
   check([await proofExists(b.management),consumesProof(committedWith('INSERT INTO jobs'))],[true,false],'release deploy with a token: the proof row stays');
  }
  // Disable and delete stay routine.
  {
   const b=await browser(owner,{proof:false}),result=await release(b,{action:'disable',releaseId:releaseRow.id,confirm:true});
   check([result.status,result.body.ok],[200,true],'release disable needs no token');
  }
 }

 // ---- Enroll ------------------------------------------------------------------
 {
  const enroll=(b,payload)=>post(consoleApi,'/api/console',owner,b,payload);
  const state=async()=>({servers:await count(sql`SELECT count(*) AS n FROM servers`),members:await count(sql`SELECT count(*) AS n FROM device_group_members`)});
  const target=uuid();await insert('device_groups',{id:target,name:'Neue Geräte',description:'',created_at:time,parent_id:null});
  await refusedWithout('enroll',owner,(b,value)=>enroll(b,withToken({action:'enroll',name:'SRV-NEU'},value)),state);
  await refusedWithout('enroll into a group',owner,(b,value)=>enroll(b,withToken({action:'enroll',name:'SRV-NEU',groupId:target},value)),state);
  for(const [label,payload,status,prepare] of [['name',{name:'Ungültig/Name'},400],['mode',{name:'SRV-X',mode:'Admin'},400],['agent version',{name:'SRV-X',agentVersion:2},400],['format',{name:'SRV-X',format:'zip'},400],['invalid group',{name:'SRV-X',groupId:'keine-gruppe'},400],['unknown group',{name:'SRV-X',groupId:uuid()},404],['missing signing key',{name:'SRV-X'},503,()=>{signer=null;}],['invalid signing key',{name:'SRV-X'},503,()=>{signer={get publicKey(){throw new Error('unused');}};imports['@/lib/server/agent/agent-dispatch'].dispatchSigner=()=>{throw new Error('Der Signaturschlüssel ist ungültig.');};}]]){
   prepare?.();
   const b=await browser(owner),before=await state(),result=await enroll(b,{action:'enroll',...payload,managementToken:b.management});
   check(result.status,status,`enroll ${label}: ${status} (${result.body.error})`);check([await state(),await proofExists(b.management)],[before,true],`enroll ${label}: nothing created, the proof remains`);
   signer={publicKey:'fixture-job-key'};imports['@/lib/server/agent/agent-dispatch'].dispatchSigner=()=>signer;
  }
  for(const groupId of [undefined,target]){
   const label=groupId?'enroll into a group':'enroll';
   {
    const b=await browser(owner),before=await state();beforeBatch=deleteProof(b.management);
    const result=await enroll(b,{action:'enroll',name:'SRV-RACE',groupId,managementToken:b.management});
    check([result.status,result.body.code],[403,'MFA_STEP_UP_REQUIRED'],`${label}: a proof that vanishes before the batch is refused`);check(await state(),before,`${label}: nothing is created`);
   }
   const b=await browser(owner),result=await enroll(b,{action:'enroll',name:'SRV-ENROLLED',groupId,managementToken:b.management});
   check([result.status,result.body.jobSigningKey],[200,'fixture-job-key'],`${label} with a proof: the registration download (${result.body.error})`);
   check(await count(sql`SELECT count(*) AS n FROM servers WHERE id=${result.body.id}`),1,`${label}: the device exists`);
   check(await count(sql`SELECT count(*) AS n FROM device_group_members WHERE server_id=${result.body.id} AND group_id=${groupId??''}`),groupId?1:0,`${label}: the membership as requested`);
   check(await proofExists(b.management),false,`${label}: the proof is consumed`);check(consumesProof(committedWith('INSERT INTO servers')),true,`${label}: the device row and the proof DELETE share one batch`);
   const replay=await enroll(b,{action:'enroll',name:'SRV-AGAIN',groupId,managementToken:b.management});check([replay.status,replay.body.code],[403,'MFA_STEP_UP_REQUIRED'],`${label}: a used token is refused`);
  }
 }

 // ---- Removal with agent uninstall ------------------------------------------------
 {
  const remove=(b,payload)=>post(consoleApi,'/api/console',owner,b,payload);
  const host=await device('SRV-UNINSTALL',['refresh','agent-uninstall']);
  const state=async()=>({jobs:await count(sql`SELECT count(*) AS n FROM jobs WHERE server_id=${host}`),revoked:await count(sql`SELECT revoked AS n FROM servers WHERE id=${host}`)});
  const payload={action:'remove-server',id:host,confirm:true,uninstall:true};
  await refusedWithout('remove-server with uninstall',owner,(b,value)=>remove(b,withToken(payload,value)),state);
  // A malformed uninstall flag answers 400 before the proof is read; the proof stays.
  {const b=await browser(owner),before=await state(),result=await remove(b,{...payload,uninstall:'yes',managementToken:b.management});
   check([result.status,await state(),await proofExists(b.management)],[400,before,true],`remove-server uninstall:'yes': 400 first (${result.body.error})`);}
  const b=await browser(owner),result=await remove(b,{...payload,managementToken:b.management});
  check([result.status,result.body.uninstall?.queued],[200,[host]],`remove-server with uninstall and a proof queues the job (${result.body.error})`);
  check(await state(),{jobs:1,revoked:0},'remove-server with uninstall: one job, the device stays registered');
  check(await proofExists(b.management),false,'remove-server with uninstall: the proof is consumed');check(consumesProof(committedWith('INSERT INTO jobs')),true,'remove-server with uninstall: the job and the proof DELETE share one batch');
  const replay=await remove(b,{...payload,managementToken:b.management});check([replay.status,replay.body.code],[403,'MFA_STEP_UP_REQUIRED'],'remove-server with uninstall: a used token is refused');
 }
 console.log(`PASS step-up high risk (${checks} assertions): SYSTEM terminal open, enroll and removal with uninstall need a fresh step-up proof, read after validation, part of the admission and consumed in the writing batch; the retired release token actions answer like unknown actions; release deploy, resume and disable stay on the MFA login session behind the session fence.`);
}finally{d.close();}
