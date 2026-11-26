// The kept job input and the job drawer's read against PostgreSQL, through the real console route
// (app/api/console/route.ts) and lib/server/devices/job-detail.ts: migration 0032 adds jobs.display_input with '{}', a queued
// create-local-user and stop-service keep their safe fields after the result wipes the parameters, the list gets the
// object but never display_input, and GET ?job=&serverId= answers the input and output only under the job list's own
// visibility (one 404 for missing, foreign and not allowed), with the secret scrub, the ad-sign-in exclusion, the
// 64 KiB cut, the scope removal and inputKept false for a job from before 0032. Also the output's management scope
// (a non-owner needs manage, in the list and the read) and scriptRemovedAfterDays of a script job.
import {HttpError as realHttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {z} from 'zod';
import {sourceDatabase,sourceLoader,insertRow} from '../support/source-database.mjs';
import {sql} from '../../runtime/database.mjs';
import {enableMultipleCustomers,separateCustomers} from '../support/customer-separation.mjs';

let checks=0,viewer=null;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const uuid=()=>crypto.randomUUID(),noop=async()=>{},allow=sql`TRUE`,clock=Date.now();
const HttpError=realHttpError,d=await sourceDatabase();
const stamped=v=>Object.defineProperty(v,'authorization',{value:{authVersion:1},enumerable:false});
const server={
 db:()=>d,now:()=>clock,config:()=>'',guid:value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
 hash:async value=>crypto.createHash('sha256').update(value).digest('hex'),HttpError,log:noop,
 requireViewer:async()=>viewer,sameOrigin:()=>{},body:request=>request.json(),random:()=>crypto.randomBytes(16).toString('hex'),
 failure:error=>error instanceof HttpError||typeof error?.status==='number'&&typeof error?.messageKey==='string'?Response.json({error:error.message,code:error.code,messageKey:error.messageKey},{status:error.status}):Response.json({error:String(error?.message??error)},{status:500}),
};
const imports={
 '../context':server,'./context':server,'../../context':server,'@/lib/server/context':server,'./local-auth':{},
 '@/lib/server/identity/mfa':{requireMfa:noop},'../identity/mfa':{requireMfa:noop},'./mfa':{requireMfa:noop},
 '@/lib/server/agent/agent-protocol':{maintenanceBusy:async()=>false},'../agent/agent-protocol':{maintenanceBusy:async()=>false},
 '@/agent/package-v3':{installerV3:()=>'',registrationV3:()=>''},
 '@/lib/server/agent/agent-dispatch':{dispatchSigner:()=>null,DISPATCH_LIFETIME_SECONDS:60,JOB_SIGNING_KEY_MISSING:'missing'},'@/lib/server/agent/agent-crypto':{sealAgentSecrets:async()=>({box:'sealed'})},'../agent/agent-crypto':{sealAgentSecrets:async()=>({box:'sealed'})},
 '@/lib/server/devices/device-group-catalog':{deviceGroupCatalog:async()=>[],devicePermissionTargets:async()=>[]},'@/lib/server/agent/device-tokens':{PERSONAL_REGISTRATION_LIFETIME:1},
 '@/lib/server/devices/device-lifecycle':{removeDevice:noop,removeDevices:noop,sweepRemovedTransfers:noop},'@/lib/server/devices/rdp':{sweepRdp:noop},
 '@/lib/server/identity/customers':{visibleCustomers:async()=>[]},
 '@/lib/server/automation/runbooks':{tickAutomation:noop},'@/lib/server/automation/drift':{ingestDrift:noop},'@/lib/server/devices/file-access':{requireFileAccess:noop},
 '@/lib/server/devices/transfers':{verifyTransfer:noop,sweepTransfers:noop,transferAuthorizationGuard:()=>allow},'@/lib/server/devices/terminal-lifecycle':{sweepTerminalSessions:noop},
 '@/lib/server/devices/terminal-channel':{terminalReport:z.object({}),exchangeTerminals:async()=>[]},
};
const loader=sourceLoader(),load=file=>loader(file,imports);
const consoleApi=load('app/api/console/route.ts');

// ---- the migration ----
const [column]=await d.query(sql`SELECT column_default,is_nullable,data_type FROM information_schema.columns WHERE table_name='jobs' AND column_name='display_input'`);
check([column.data_type,column.is_nullable,column.column_default],['text','NO',"'{}'::text"],'0032 adds display_input text NOT NULL DEFAULT \'{}\'');

// ---- Fixtures ----
const time=Date.now(),insert=(table,row)=>insertRow(d,table,row);
const customerA='00000000-0000-4000-8000-000000000100',customerB=uuid();
await insert('customers',{id:customerB,name:'Customer B',created_at:time,updated_at:time});
async function persona(name,permissions,customers=[customerA]){
 const id=uuid(),principal='local:'+id,roleId=uuid();
 await insert('local_users',{id,username:name,email:name+'@detail.test',display_name:name,auth_principal:principal,auth_email:name+'@detail.test',status:'active',auth_version:1,created_at:time,updated_at:time});
 await insert('rbac_roles',{id:roleId,name:'Role '+name,description:'',permissions:JSON.stringify(permissions),builtin:0,created_at:time});
 await d.exec(sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(${uuid()},'user',${id},${roleId},'global','*',${time},'fixture')`);
 for(const customer of customers)await d.exec(sql`INSERT INTO customer_assignments(customer_id,principal_type,principal_id,created_at,created_by) VALUES(${customer},'user',${id},${time},'fixture')`);
 return stamped({id,userId:id,label:name+'@detail.test',principal,username:name,displayName:name,permissions:permissions.includes('*')?['*']:[]});
}
const capabilities=['create-local-user','stop-service'];
async function device(name,customer=customerA){
 const id=uuid();
 await insert('servers',{id,name,token_hash:'fixture-'+id,created_at:time,last_seen:clock,management:1,snapshot:JSON.stringify({protocolVersion:3,mode:'Management',agentCapabilities:capabilities,os:'Windows Server 2025'}),customer_id:customer,revoked:0});
 return id;
}
await d.exec(enableMultipleCustomers());await d.exec(separateCustomers(time));
const owner=await persona('owner',['*']),admin=await persona('admin',['view','manage']),reader=await persona('reader',['view']);
const local=await device('DETAIL-01'),foreign=await device('DETAIL-B',customerB);
const post=async(v,body)=>{viewer=v;const response=await consoleApi.POST(new Request('https://detail.test/api/console',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}));return {status:response.status,body:await response.json()};};
const get=async(v,query)=>{viewer=v;const response=await consoleApi.GET(new Request('https://detail.test/api/console?'+query));return {status:response.status,cache:response.headers.get('Cache-Control'),body:await response.json()};};
const detail=(v,serverId,jobId)=>get(v,`job=${jobId}&serverId=${serverId}`);
/** The agent result path: output with its scope, then the state with the parameters wiped (lib/server/agent/agent-channel.ts). */
async function finish(jobId,serverId,ok,data){
 if(data!==undefined)await d.exec(sql`INSERT INTO job_outputs (job_id,server_id,data,created_at) VALUES (${jobId},${serverId},${JSON.stringify(data)},${time})`);
 await d.exec(sql`UPDATE jobs SET state=${ok?'succeeded':'failed'},result=${ok?'ok':'failed'},parameters='{}',last_progress=${time} WHERE id=${jobId} AND server_id=${serverId}`);
}

// ---- The input survives a finished job ----
const user=await post(admin,{action:'job',id:local,kind:'create-local-user',params:{name:'svc-backup',fullName:'Backup',description:'Nightly',passwordNeverExpires:true,password:'S3cret!x'},confirm:true});
check(user.status,200,'create-local-user is queued');
const service=await post(admin,{action:'job',id:local,kind:'stop-service',params:{name:'Spooler'},confirm:true});
check(service.status,200,'stop-service is queued');
let rows=await d.query(sql`SELECT id,parameters,display_input FROM jobs WHERE id IN (${user.body.id},${service.body.id}) ORDER BY action`);
check(JSON.parse(rows[0].display_input),{name:'svc-backup',fullName:'Backup',description:'Nightly',passwordNeverExpires:true},'queued: the safe fields, no password');
ok(!rows[0].display_input.includes('S3cret')&&!rows[0].display_input.includes('sealed'),'no password and no sealed secret in display_input');
await finish(user.body.id,local,true,{created:true,password:'leak',scope:{security:false}});
await finish(service.body.id,local,false,{error:'access denied',nested:{token:'t',items:[{secret:'s',keep:1}]},scope:{security:false,management:false}});
rows=await d.query(sql`SELECT id,action,parameters,display_input FROM jobs WHERE id IN (${user.body.id},${service.body.id}) ORDER BY action`);
check(rows.map(row=>[row.action,row.parameters,JSON.parse(row.display_input)]),[['create-local-user','{}',{name:'svc-backup',fullName:'Backup',description:'Nightly',passwordNeverExpires:true}],['stop-service','{}',{name:'Spooler'}]],'finished: parameters wiped, display_input kept');

// ---- the list carries the object, never display_input ----
const list=await get(admin,'jobsOnly=1');
const listed=list.body.jobs.filter(item=>[user.body.id,service.body.id].includes(item.id));
check(listed.map(item=>[item.action,item.object]).sort(),[['create-local-user','svc-backup'],['stop-service','Spooler']],'scopeJobs adds the object');
check(listed.some(item=>'displayInput' in item||'display_input' in item||'accessParameters' in item),false,'no display_input in the list');

// ---- the read ----
let answer=await detail(admin,local,user.body.id);
check([answer.status,answer.cache],[200,'no-store'],'the visible job answers, no-store');
check(answer.body.input,{fields:[{key:'name',value:'svc-backup'},{key:'fullName',value:'Backup'},{key:'description',value:'Nightly'},{key:'passwordNeverExpires',value:true}]},'the input fields in allowlist order');
check([answer.body.inputKept,answer.body.outputRedacted,answer.body.scriptRemovedAfterDays],[true,false,null],'kept, not redacted, no removed script for another kind');
check(JSON.parse(answer.body.output.data),{created:true},'the output without scope and without the password key');
answer=await detail(owner,local,service.body.id);
check(JSON.parse(answer.body.output.data),{error:'access denied',nested:{items:[{keep:1}]}},'secret keys are removed at any depth');
// One 404 for not allowed, foreign, missing and malformed.
const notFound=async(v,serverId,jobId,label)=>{const result=await detail(v,serverId,jobId);check([result.status,result.body.messageKey],[404,'apiError.job.notFound'],label);};
await notFound(reader,local,user.body.id,'a viewer without the kind\'s right gets 404');
const foreignJob=uuid();
await d.exec(sql`INSERT INTO jobs (id,server_id,action,target,parameters,display_input,created_at,actor,actor_email,actor_principal,state) VALUES (${foreignJob},${foreign},'stop-service','Spooler','{}','{"name":"Spooler"}',${time},'x','x@x','local:x','succeeded')`);
await notFound(admin,foreign,foreignJob,'another customer\'s device gets the same 404');
await notFound(admin,local,uuid(),'an unknown job gets the same 404');
await notFound(admin,local,'nope','a malformed id gets the same 404');
await notFound(admin,foreign,user.body.id,'a job under the wrong device gets the same 404');
// A hidden kind (list-files) is never read.
const listJob=uuid();
await d.exec(sql`INSERT INTO jobs (id,server_id,action,target,parameters,display_input,created_at,actor,actor_email,actor_principal,state) VALUES (${listJob},${local},'list-files','C:\\','{}','{"path":"C:\\\\"}',${time},'x','x@x','local:x','succeeded')`);
await notFound(owner,local,listJob,'a kind the list hides gets 404');
// ad-sign-in: input plugin and account, output never.
const adJob=uuid();
await d.exec(sql`INSERT INTO jobs (id,server_id,action,target,parameters,display_input,created_at,actor,actor_email,actor_principal,state) VALUES (${adJob},${local},'ad-sign-in','dhcp/CONTOSO\\anna','{}',${JSON.stringify({plugin:'dhcp',account:'CONTOSO\\anna'})},${time},'x','x@x','local:x','succeeded')`);
await d.exec(sql`INSERT INTO job_outputs (job_id,server_id,data,created_at) VALUES (${adJob},${local},${JSON.stringify({userSid:'S-1-5-21',ticket:'x'})},${time})`);
answer=await detail(owner,local,adJob);
check([answer.status,answer.body.input.fields,answer.body.output],[200,[{key:'plugin',value:'dhcp'},{key:'account',value:'CONTOSO\\anna'}],null],'ad-sign-in: plugin and account, never the output');
// A script output: text, stderr, exit code, cut at 64 KiB.
const script=uuid(),long='x'.repeat(70*1024);
await d.exec(sql`INSERT INTO jobs (id,server_id,action,target,parameters,display_input,created_at,actor,actor_email,actor_principal,state) VALUES (${script},${local},'assistant-powershell','Get-Date / 0123456789ab','{}',${JSON.stringify({script:'Get-Date\nexit 1',timeoutSeconds:60})},${time},'x','x@x','local:x','failed')`);
await d.exec(sql`INSERT INTO job_outputs (job_id,server_id,data,created_at) VALUES (${script},${local},${JSON.stringify({output:long,stderr:'boom',exitCode:1,truncated:false,scope:{security:false}})},${time})`);
answer=await detail(owner,local,script);
check([answer.body.input.script,answer.body.input.fields],['Get-Date\nexit 1',[{key:'timeoutSeconds',value:60}]],'the script apart from the fields');
check(answer.body.scriptRemovedAfterDays,null,'a script job that still keeps its script: scriptRemovedAfterDays null');
check([answer.body.output.text.length,answer.body.output.stderr,answer.body.output.exitCode,answer.body.output.truncated],[64*1024,'boom',1,true],'text cut at 64 KiB with truncated');
// A job from before 0032: inputKept false.
const old=uuid();
await d.exec(sql`INSERT INTO jobs (id,server_id,action,target,parameters,created_at,actor,actor_email,actor_principal,state) VALUES (${old},${local},'stop-service','Spooler','{}',${time},'x','x@x','local:x','succeeded')`);
answer=await detail(owner,local,old);
check([answer.body.inputKept,answer.body.input.fields,answer.body.output],[false,[],null],'an old job: input not kept, no output');
// A kind without input fields keeps inputKept true.
const refresh=uuid();
await d.exec(sql`INSERT INTO jobs (id,server_id,action,target,parameters,created_at,actor,actor_email,actor_principal,state) VALUES (${refresh},${local},'refresh','','{}',${time},'x','x@x','local:x','succeeded')`);
answer=await detail(owner,local,refresh);
check([answer.status,answer.body.inputKept,answer.body.input.fields],[200,true,[]],'refresh has no input');
// A script job whose script the maintenance removed (runtime/maintenance.mjs): the note's days, inputKept stays true.
const cleared=uuid();
await d.exec(sql`INSERT INTO jobs (id,server_id,action,target,parameters,display_input,created_at,actor,actor_email,actor_principal,state) VALUES (${cleared},${local},'assistant-powershell','Get-Date / 0123456789ab','{}','{"timeoutSeconds": 60}',${time},'x','x@x','local:x','succeeded')`);
answer=await detail(owner,local,cleared);
check([answer.body.scriptRemovedAfterDays,answer.body.inputKept,answer.body.input],[7,true,{fields:[{key:'timeoutSeconds',value:60}]}],'a removed script: scriptRemovedAfterDays 7, the timeout kept');

// ---- the output's management scope gates the job like its security scope ----
const diagnoser=await persona('diagnoser',['view','diagnose']),diagManager=await persona('diagmanager',['view','diagnose','manage']);
const managed=uuid(),plain=uuid();
for(const id of [managed,plain])await d.exec(sql`INSERT INTO jobs (id,server_id,action,target,parameters,display_input,created_at,actor,actor_email,actor_principal,state) VALUES (${id},${local},'list-processes','','{}','{}',${time},'x','x@x','local:x','running')`);
await finish(managed,local,true,{processes:[{name:'svchost'}],scope:{security:false,management:true}});
await finish(plain,local,true,{processes:[{name:'lsass'}],scope:{security:false,management:false}});
const listedIds=async v=>(await get(v,'jobsOnly=1')).body.jobs.map(item=>item.id).filter(id=>[managed,plain].includes(id)).sort();
check(await listedIds(diagnoser),[plain],'without manage: the management-scoped job is not in the list, the other one is');
await notFound(diagnoser,local,managed,'without manage: the management-scoped job answers the same 404');
answer=await detail(diagnoser,local,plain);
check(answer.status,200,'without manage: a job without the management scope still opens');
check(await listedIds(diagManager),[managed,plain].sort(),'with manage: both jobs are in the list');
answer=await detail(diagManager,local,managed);
check([answer.status,JSON.parse(answer.body.output.data)],[200,{processes:[{name:'svchost'}]}],'with manage: the job and its output');

await d.close();
console.log(`PASS job detail (${checks} checks): the 0032 column, the kept input after the wipe, the object in the list without display_input, and the drawer read under the list's visibility with the secret scrub, the ad-sign-in exclusion, the 64 KiB cut and the old-job case.`);
function ok(value,label){assert.ok(value,label);checks++;}
