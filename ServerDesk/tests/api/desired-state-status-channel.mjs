// The production agent channel stores a Desired-State result on its assignment
// in the same transaction as the job output and state. A real PostgreSQL test database and
// real result writer; unrelated schedulers are idle fixtures as in
// agent-request-expiry-races.mjs.
import {HttpError as realHttpError} from '../support/http-error.mjs';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import ts from 'typescript';
import {sourceDatabase,createTrigger,dropTrigger,idents} from '../support/source-database.mjs';
import {hookDatabase} from '../support/hooked-database.mjs';
import {sql} from '../../runtime/database.mjs';
const require=createRequire(import.meta.url);
const d=await sourceDatabase();
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
try{
 const origin='https://serverdesk.test',owner='owner@status.test',sha=value=>crypto.createHash('sha256').update(value).digest('hex');
 const key=crypto.generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({format:'jwk'}),pinned=JSON.stringify({kty:key.kty,n:key.n,e:key.e});
 let clock=Date.now();const batches=[];
 // Records which SQL ran in which transaction, so the test can see the transaction boundary.
 const facade=hookDatabase(d,{record:batches});
 const HttpError=realHttpError;
 const server={db:()=>facade,config:name=>name==='SITE_ORIGIN'?origin:'',now:()=>clock,hash:async value=>sha(value),guid:value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value),body:request=>request.json(),HttpError,failure:error=>Response.json({error:error.message,...(error.code?{code:error.code}:{})},{status:error.status??503})};
 const cache=new Map([['lib/server/context.ts',server]]),idle=async()=>{};
 function load(file){
  if(cache.has(file))return cache.get(file);
  const fixture={exports:{}},code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  cache.set(file,fixture.exports);
  new Function('require','exports','module',code)(name=>{
   if(name==='cloudflare:workers')return {env:{}};
   if(name.startsWith('@/'))return load(name.slice(2)+'.ts');
   // Plain runtime modules (runtime/secret-keyring.mjs) load as they are.
   if(name.startsWith('.')&&name.endsWith('.mjs'))return require(path.resolve(path.posix.dirname(file),name));
   if(name.startsWith('.'))return load(path.posix.normalize(path.posix.join(path.posix.dirname(file),name))+'.ts');
   return require(name);
  },fixture.exports,fixture);cache.set(file,fixture.exports);return fixture.exports;
 }
 const {z}=require('zod');
 cache.set('lib/server/automation/runbooks.ts',{tickAutomation:idle});
 cache.set('lib/server/automation/drift.ts',{getDriftPolicy:async()=>null,ingestDrift:idle});
 cache.set('lib/server/devices/transfers.ts',{verifyTransfer:idle,sweepTransfers:idle});
 cache.set('lib/server/devices/terminal-lifecycle.ts',{sweepTerminalSessions:idle});
 cache.set('lib/server/devices/rdp.ts',{sweepRdp:idle});
 cache.set('lib/server/devices/terminal-channel.ts',{terminalReport:z.object({id:z.guid()}),exchangeTerminals:async()=>[]});
 // The scheduler stays idle; the result writer in lib/server/automation/desired-state-result.ts is real.
 cache.set('lib/server/automation/desired-state.ts',{advanceDesiredState:idle,checkPendingDesiredJob:async()=>true,desiredJobClaimGuard:async()=>(sql`TRUE`)});
 const channel=load('app/api/agent/channel/route.ts');
 assert.equal(typeof load('lib/server/automation/desired-state-result.ts').desiredResultStatement,'function');

 const columns='last_job_id,last_result_state,last_result_at,last_compliant,last_compliant_at';
 const status=id=>d.one(sql`SELECT ${idents(columns)} FROM desired_assignments WHERE id=${id}`);
 const empty={last_job_id:null,last_result_state:null,last_result_at:null,last_compliant:null,last_compliant_at:null};
 async function device(){
  const id=crypto.randomUUID(),token=crypto.randomBytes(32).toString('hex'),assignment=crypto.randomUUID(),version=crypto.randomUUID();
  const snapshot={protocolVersion:3,agentVersion:'4.6.0',mode:'Management',agentCapabilities:['refresh','desired-state-test','desired-state-apply','terminal-live','terminal-multi']};
  await d.exec(sql`INSERT INTO servers(id,name,token_hash,token_expires_at,created_at,last_seen,management,snapshot,agent_public_key) VALUES (${id},${'Status fixture'},${sha(token)},${clock+86400000},${clock},${clock},1,${JSON.stringify(snapshot)},${pinned})`);
  await d.exec(sql`INSERT INTO desired_assignments(id,server_id,version_id,assigned_by,assigned_at,enabled,interval_seconds) VALUES(${assignment},${id},${version},${'private:'+owner},${clock},1,0)`);
  const report=results=>{clock+=1000;return channel.POST(new Request(origin+'/api/agent/channel',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({serverId:id,results,runningJobs:[]})}));};
  // A running job and its run, as the channel claimed them.
  const job=async({action='desired-state-test',run=true,assignmentId=assignment,versionId=version}={})=>{
   const jobId=crypto.randomUUID();
   await d.exec(sql`INSERT INTO jobs(id,server_id,action,target,state,created_at,claimed_at,last_progress,actor,actor_email,actor_principal,parameters) VALUES (${jobId},${id},${action},'fixture','running',${clock},${clock},${clock},'owner',${owner},${'private:'+owner},${JSON.stringify({assignmentId,versionId})})`);
   if(run)await d.exec(sql`INSERT INTO desired_runs(id,assignment_id,server_id,version_id,job_id,operation,created_at,created_by) VALUES(${crypto.randomUUID()},${assignmentId},${id},${versionId},${jobId},${action==='desired-state-apply'?'apply':'test'},${clock},${'private:'+owner})`);
   return jobId;
  };
  return {id,assignment,version,report,job};
 }
 const jobRow=jobId=>d.one(sql`SELECT state,result,parameters,last_progress FROM jobs WHERE id=${jobId}`);
 const output=jobId=>d.one(sql`SELECT data,created_at FROM job_outputs WHERE job_id=${jobId}`);
 const lastBatch=jobId=>{const found=batches.filter(batch=>batch.some(sql=>/^UPDATE jobs SET state=[$][0-9]+,result=[$][0-9]+/.test(sql))).at(-1);assert.ok(found,'a result batch ran for '+jobId);return found;};
 const kinds=batch=>batch.map(sql=>sql.startsWith('INSERT INTO job_outputs')?'output':sql.startsWith('UPDATE desired_assignments')?'assignment':/^UPDATE jobs SET state=[$][0-9]+,result=[$][0-9]+/.test(sql)?'job':'other');

 // A second device's assignment carries a stored status that nothing here may change.
 const bystander=await device();await d.exec(sql`UPDATE desired_assignments SET last_job_id='foreign',last_result_state='succeeded',last_result_at=1,last_compliant=1,last_compliant_at=1 WHERE id=${bystander.assignment}`);
 const foreign=await status(bystander.assignment);

 // Compliant, then non-compliant, then failed, then succeeded without a verdict.
 const a=await device();check(await status(a.assignment),empty,'a new assignment has no stored status');
 const j1=await a.job();let response=await a.report([{id:j1,ok:true,message:'Konform',data:{engine:'dsc3',compliant:true,resources:[]}}]);const t1=clock;
 check(response.status,200,'compliant result accepted');
 check(await status(a.assignment),{last_job_id:j1,last_result_state:'succeeded',last_result_at:t1,last_compliant:1,last_compliant_at:t1},'step 1: succeeded and compliant');
 check(kinds(lastBatch(j1)),['output','assignment','job'],'output, assignment status and job state run in one batch, the assignment before the job update');
 check((await jobRow(j1)).state,'succeeded','the job completes as before');check(JSON.parse((await output(j1)).data).compliant,true,'the output is stored as before');
 const j2=await a.job({action:'desired-state-apply'});response=await a.report([{id:j2,ok:true,message:'Abweichend',data:{compliant:false}}]);const t2=clock;
 check(response.status,200);check(await status(a.assignment),{last_job_id:j2,last_result_state:'succeeded',last_result_at:t2,last_compliant:0,last_compliant_at:t2},'step 2: an apply result with compliant:false overwrites job, time and verdict');
 check(kinds(lastBatch(j2)),['output','assignment','job'],'apply results use the same batch');
 const j3=await a.job();response=await a.report([{id:j3,ok:false,message:'DSC fehlt',data:{compliant:true}}]);const t3=clock;
 check(response.status,200);check(await status(a.assignment),{last_job_id:j3,last_result_state:'failed',last_result_at:t3,last_compliant:0,last_compliant_at:t2},'step 3: a failed result keeps the previous verdict, even with compliant in its data');
 check((await jobRow(j3)).state,'failed');
 const j4=await a.job();response=await a.report([{id:j4,ok:true,message:'Fertig'}]);const t4=clock;
 check(response.status,200);check(await status(a.assignment),{last_job_id:j4,last_result_state:'succeeded',last_result_at:t4,last_compliant:0,last_compliant_at:t2},'step 4: a succeeded result without a verdict keeps the previous verdict');
 check(kinds(lastBatch(j4)),['assignment','job'],'without data there is no output insert, still one batch');
 const j4b=await a.job();response=await a.report([{id:j4b,ok:true,message:'Fertig',data:{compliant:'true'}}]);const t4b=clock;
 check(await status(a.assignment),{last_job_id:j4b,last_result_state:'succeeded',last_result_at:t4b,last_compliant:0,last_compliant_at:t2},'a string compliant is not a verdict');
 let kept=await status(a.assignment);

 // No stray writes.
 const repeat=await a.report([{id:j1,ok:true,message:'Nochmal',data:{compliant:true}}]);check(repeat.status,200,'a repeated report is accepted');
 check(await status(a.assignment),kept,'a repeated report of a finished job changes nothing');
 const expired=await a.job();await d.exec(sql`UPDATE jobs SET state='expired' WHERE id=${expired}`);
 await a.report([{id:expired,ok:true,message:'Spät',data:{compliant:true}}]);check(await status(a.assignment),kept,'a result for an expired job changes nothing');check((await jobRow(expired)).state,'expired','the expired job stays expired');
 const removed=await a.job();await d.exec(sql`UPDATE desired_assignments SET enabled=0 WHERE id=${a.assignment}`);
 await a.report([{id:removed,ok:true,message:'Konform',data:{compliant:true}}]);check(await status(a.assignment),kept,'a removed assignment keeps its status');check((await jobRow(removed)).state,'succeeded','the job itself still completes');
 await d.exec(sql`UPDATE desired_assignments SET enabled=1 WHERE id=${a.assignment}`);
 const changed=await a.job();await d.exec(sql`UPDATE desired_assignments SET version_id=${crypto.randomUUID()} WHERE id=${a.assignment}`);
 await a.report([{id:changed,ok:true,message:'Konform',data:{compliant:true}}]);check(await status(a.assignment),kept,'an assignment with another version keeps its status');
 await d.exec(sql`UPDATE desired_assignments SET version_id=${a.version} WHERE id=${a.assignment}`);
 const reassigned=await a.job(),newId=crypto.randomUUID();await d.exec(sql`UPDATE desired_assignments SET id=${newId} WHERE id=${a.assignment}`);
 await a.report([{id:reassigned,ok:true,message:'Konform',data:{compliant:true}}]);check(await status(newId),kept,'a re-assigned device (new id) keeps the new assignment untouched');
 await d.exec(sql`UPDATE desired_assignments SET id=${a.assignment} WHERE id=${newId}`);
 const orphan=await a.job({run:false});await a.report([{id:orphan,ok:true,message:'Konform',data:{compliant:true}}]);check(await status(a.assignment),kept,'a desired job without a run changes nothing');
 check(await status(bystander.assignment),foreign,'another device\'s assignment is never touched');

 // A failing status update rolls back the output and the job state.
 await createTrigger(d,'test_status_failure','desired_assignments','BEFORE UPDATE',{message:'test-status-failure'});
 const atomic=await a.job(),parameters=(await jobRow(atomic)).parameters,result=[{id:atomic,ok:true,message:'Konform',data:{compliant:true}}];
 response=await a.report(result);assert.ok(response.status>=400,'the report fails: '+response.status);checks++;
 check(await jobRow(atomic),{state:'running',result:null,parameters,last_progress:(await jobRow(atomic)).last_progress},'the job is still running with its parameters');
 check((await jobRow(atomic)).parameters!=='{}',true,'parameters are not cleared');
 check(await output(atomic),null,'no output row exists');check(await status(a.assignment),kept,'the assignment is unchanged');
 await dropTrigger(d,'test_status_failure');
 response=await a.report(result);const t5=clock;check(response.status,200,'the identical report succeeds once the trigger is gone');
 check(await status(a.assignment),{last_job_id:atomic,last_result_state:'succeeded',last_result_at:t5,last_compliant:1,last_compliant_at:t5},'all three writes land');
 check((await jobRow(atomic)).state,'succeeded');check(!!await output(atomic),true);
 kept=await status(a.assignment);

 // Control: other job actions keep their behaviour and touch no assignment.
 const refresh=await a.job({action:'refresh',run:false});response=await a.report([{id:refresh,ok:true,message:'Inventar aktualisiert',data:{items:1,compliant:false}}]);const t6=clock;
 check(response.status,200);check(await jobRow(refresh),{state:'succeeded',result:'Inventar aktualisiert',parameters:'{}',last_progress:t6},'refresh result: state, result, cleared parameters and progress as before');
 const refreshOutput=await output(refresh);check(refreshOutput.created_at,t6);check(JSON.parse(refreshOutput.data).items,1,'refresh output is stored');
 check(kinds(lastBatch(refresh)),['output','job'],'no assignment statement for other actions');
 check(await status(a.assignment),kept,'a refresh result never changes an assignment');check(await status(bystander.assignment),foreign);
 const failedRefresh=await a.job({action:'refresh',run:false});await a.report([{id:failedRefresh,ok:false,message:'Fehler'}]);
 check(await jobRow(failedRefresh),{state:'failed',result:'Fehler',parameters:'{}',last_progress:clock},'a failed refresh without data');check(await output(failedRefresh),null);

 // Agent 4.8.0 sends a message code and arguments next to the English text.
 const coding=jobId=>d.one(sql`SELECT result,result_code,result_args FROM jobs WHERE id=${jobId}`);
 check(await coding(failedRefresh),{result:'Fehler',result_code:null,result_args:null},'a result without code (older agent) stores NULL in both columns');
 const coded=await a.job({action:'refresh',run:false});
 response=await a.report([{id:coded,ok:true,message:'TCP connection succeeded: srv:443',code:'AGENT_TCP_CONNECTED',args:{host:'srv',port:'443'}}]);
 check(response.status,200,'a coded result is accepted');
 check(await coding(coded),{result:'TCP connection succeeded: srv:443',result_code:'AGENT_TCP_CONNECTED',result_args:'{"host":"srv","port":"443"}'},'code and arguments are stored with the English text');
 const codeOnly=await a.job({action:'refresh',run:false});
 await a.report([{id:codeOnly,ok:false,message:'Role or feature not found.',code:'AGENT_FEATURE_NOT_FOUND'}]);
 check(await coding(codeOnly),{result:'Role or feature not found.',result_code:'AGENT_FEATURE_NOT_FOUND',result_args:null},'a code without arguments stores NULL arguments');
 const nine=Object.fromEntries(Array.from({length:9},(_,index)=>[`a${index}`,'x']));
 for(const [label,fields] of [['a malformed code',{code:'agent_lower'}],['a bad argument key',{code:'AGENT_TCP_CONNECTED',args:{Host:'srv'}}],['a too long value',{code:'AGENT_TCP_CONNECTED',args:{detail:'x'.repeat(1001)}}],['a number value',{code:'AGENT_TCP_CONNECTED',args:{port:443}}],['nine arguments',{code:'AGENT_TCP_CONNECTED',args:nine}],['arguments without code',{args:{host:'srv'}}]]){
  const rejected=await a.job({action:'refresh',run:false});
  response=await a.report([{id:rejected,ok:true,message:'x',...fields}]);
  check(response.status,400,`${label} is rejected like any schema violation`);
  check((await jobRow(rejected)).state,'running',`${label} leaves the job running`);
  await d.exec(sql`UPDATE jobs SET state='cancelled' WHERE id=${rejected}`);
 }
 console.log(`PASS ${checks} Desired-State result status checks: one batch for output, assignment status and job state, overwrite and keep of the verdict, no writes for removed, re-assigned, re-versioned or finished work, rollback on failure, other actions unchanged.`);
}finally{d.close();}
