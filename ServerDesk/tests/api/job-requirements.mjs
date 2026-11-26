// Job requirements (041): one pure source for the rights a device job needs,
// and every site that queues, claims, cancels or shows a job against it.
import {serverText} from '../support/server-text.mjs';
import {HttpError as realHttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import ts from 'typescript';
import {z} from 'zod';
import {sourceDatabase,sourceLoader,inTransaction} from '../support/source-database.mjs';
import {sql} from '../../runtime/database.mjs';

let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};

// ---------------------------------------------------------------------------
// 1. Pure matrix. No import map: a runtime import of the
// database, access.ts or cloudflare:workers would fail to load here.
// ---------------------------------------------------------------------------
const pure=sourceLoader();
const {jobRequirements,jobViewRequirements}=pure('lib/jobs/requirements.ts');
const {operations}=pure('lib/management.ts'),{diagnosticDefinitions}=pure('lib/diagnostics.ts');
const source=fs.readFileSync('lib/jobs/requirements.ts','utf8');
check(/^import\s+(?!type\b)[^;]*from\s+'(?:\.\.\/(?:access|server)|cloudflare:workers)'/m.test(source),false,'requirements import access/server only as types');

// Literal expectations for params={}; written out, never computed by the code under test.
const read=(...permissions)=>({permissions,managementMode:false,mfa:false});
const change=(...permissions)=>({permissions,managementMode:true,mfa:true});
const expected={
 'list-files':read('files.read'),
 'create-directory':change('files.write'),'rename-file':change('files.write'),'delete-file':change('files.write'),
 'storage-inspect':read('diagnose'),
 'storage-initialize':change('manage'),'storage-set-disk':change('manage'),'storage-new-volume':change('manage'),'storage-resize':change('manage'),
 'storage-drive-letter':change('manage'),'storage-format':change('manage'),'storage-delete-partition':change('manage'),
 'desired-state-test':change('desired.apply'),'desired-state-apply':change('desired.apply'),
 refresh:read('diagnose'),'scan-updates':read('diagnose'),'test-connection':read('diagnose'),
 'start-service':change('manage'),'stop-service':change('manage'),'restart-service':change('manage'),'set-service-startup':change('manage'),
 'install-feature':change('manage'),'remove-feature':change('manage'),'set-network':change('manage'),'set-dns':change('manage'),
 'join-domain':change('manage'),'leave-domain':change('manage'),'rename-computer':change('manage'),'set-rdp':change('manage'),'set-pagefile':change('manage'),
 'create-local-user':change('manage'),'set-local-user':change('manage'),'reset-local-password':change('manage'),'delete-local-user':change('manage'),
 'local-group-add':change('manage'),'local-group-remove':change('manage'),'restart-computer':change('manage'),'shutdown-computer':change('manage'),
 'schedule-power':change('manage'),'cancel-power-schedule':change('manage'),'install-updates':change('manage'),'install-gpu-driver':change('manage'),
 'set-firewall-rule':change('manage'),'add-firewall-rule':change('manage'),'set-task':change('manage'),
 // Microsoft Defender (agent 4.15.0): only defender.control, not manage and not defender.read.
 'defender-quick-scan':change('defender.control'),'defender-full-scan':change('defender.control'),'defender-update-signatures':change('defender.control'),'defender-clean-detections':change('defender.control'),
 'list-processes':read('diagnose'),'list-sessions':read('diagnose'),'list-connections':read('diagnose'),'network-diagnostics':read('diagnose'),
 'query-events':read('diagnose'),'export-events':read('diagnose'),'support-bundle':read('diagnose'),
 // A1 (tightening): changing diagnostics need diagnose as well as manage, at
 // claim, in the console list and at cancel, as queueing already requires.
 // To revert A1, use change('manage') here and in lib/jobs/requirements.ts.
 'kill-process':change('diagnose','manage'),'message-session':change('diagnose','manage'),
 'disconnect-session':change('diagnose','manage'),'logoff-session':change('diagnose','manage'),
 // {} is no read-only diagnosis step, so it runs only in Management mode.
 'runbook-step':change('runbooks.execute'),
 'agent-update':{permissions:['update'],managementMode:false,mfa:true},
 // Offboarding with uninstall: manage is the device part of the removal right; queue and claim also need instance.owner.
 'agent-uninstall':{permissions:['manage'],managementMode:false,mfa:true},
};
check(Object.keys(expected).sort(),[...Object.keys(operations),...Object.keys(diagnosticDefinitions),'runbook-step','agent-update','agent-uninstall'].sort(),'the table covers every job kind');
const full=(kind,{permissions,managementMode,mfa},extra={})=>({known:true,permissions,privilegedPath:false,securityEvents:false,managementMode,mfa,capabilities:[kind],...extra});
for(const [kind,row] of Object.entries(expected))check(jobRequirements(kind,{}),full(kind,row),'matrix '+kind);
check(jobRequirements('retired-kind',{}),{known:false,permissions:['manage'],privilegedPath:false,securityEvents:false,managementMode:true,mfa:true,capabilities:['retired-kind']},'unknown kind keeps the manage fallback');
for(const kind of ['__proto__','constructor','toString'])check(jobRequirements(kind,{}).known,false,'prototype names are no job kinds: '+kind);

const privileged={privilegedPath:true},security={securityEvents:true};
const variants=[
 ['list-files',{path:'C:\\data\\reports'},['files.read'],{}],
 ['list-files',{path:'C:\\Windows\\x'},['files.read','manage'],privileged],
 ['delete-file',{path:'C:\\data\\a.pfx'},['files.write','manage'],privileged],
 ['delete-file',{path:'C:\\logs\\Security.evtx'},['files.write','security.events'],security],
 ['create-directory',{path:'C:\\logs\\security-events-1.json'},['files.write','security.events'],security],
 ['rename-file',{path:'C:\\data\\a.txt',name:'b.txt'},['files.write'],{}],
 ['rename-file',{path:'C:\\data\\a.txt',name:'b.pfx'},['files.write','manage'],privileged],
 ['rename-file',{path:'C:\\logs\\a.txt',name:'Security.evtx'},['files.write','security.events'],security],
 ['list-files',{includeSecurity:true},['files.read','security.events'],security],
 ['query-events',{channel:'Security'},['diagnose','security.events'],security],
 ['query-events',{channel:' security '},['diagnose','security.events'],security],
 ['query-events',{channel:'System'},['diagnose'],{}],
 ['export-events',{filter:{channel:'Security'},format:'json'},['diagnose','security.events'],security],
 ['support-bundle',{channels:['System','Security']},['diagnose','security.events'],security],
 ['set-task',{name:'Task',path:'\\Microsoft\\Crypto\\',enabled:true},['manage'],privileged],
 // A privileged path on a changing diagnostic: manage appears once.
 ['kill-process',{path:'C:\\Windows\\x'},['diagnose','manage'],privileged],
 ['retired-kind',{path:'C:\\Windows\\x'},['manage'],{...privileged,known:false}],
 // Malformed stored parameters never throw. A malformed channel field fails
 // closed: a string is one channel, an array counts by its strings.
 ['list-files',{path:42},['files.read'],{}],
 ['support-bundle',{channels:'Security'},['diagnose','security.events'],security],
 ['support-bundle',{channels:' security '},['diagnose','security.events'],security],
 ['export-events',{filter:{channel:['System','Security']}},['diagnose','security.events'],security],
 ['query-events',{channel:['Security']},['diagnose','security.events'],security],
 // Non-string values never count as Security.
 ['export-events',{filter:null},['diagnose'],{}],
 ['export-events',{filter:'Security'},['diagnose'],{}],
 ['export-events',{filter:['Security']},['diagnose'],{}],
 ['support-bundle',{channels:42},['diagnose'],{}],
 ['support-bundle',{channels:[null,1]},['diagnose'],{}],
 ['query-events',{channel:{}},['diagnose'],{}],
];
for(const [kind,params,permissions,extra] of variants){
 const row=expected[kind]??{permissions,managementMode:true,mfa:true};
 check(jobRequirements(kind,params),full(kind,{...row,permissions},extra),'variant '+kind+' '+JSON.stringify(params));
}
check(jobRequirements('install-updates',{all:true}),full('install-updates',change('manage'),{capabilities:['install-updates','install-all-updates']}),'all updates need the agent capability');
check(jobRequirements('install-updates',{updateIds:[crypto.randomUUID()]}).capabilities,['install-updates'],'selected updates need only the kind');
check(jobRequirements('runbook-step',{runId:'r',kind:'diagnosis',operation:'refresh',operationParameters:{}}),full('runbook-step',read('runbooks.execute')),'read-only runbook diagnosis step');
check(jobRequirements('runbook-step',{runId:'r',kind:'powershell',script:'Get-Date'}),full('runbook-step',change('runbooks.execute')),'PowerShell runbook step needs Management');
check(jobRequirements('runbook-step',{kind:'diagnosis',operation:'refresh',operationParameters:{},script:'x'}).managementMode,true,'a script never counts as read-only');
for(const params of [null,undefined,'x',42,[],{path:{}}])check(jobRequirements('refresh',params).permissions,['diagnose'],'non-object parameters: '+JSON.stringify(params));
assert.doesNotThrow(()=>jobRequirements(undefined,undefined));assert.doesNotThrow(()=>jobRequirements(42,null));

// Display fallbacks: only ever additions to the canonical set.
check(jobViewRequirements('delete-file',{},{target:'C:\\Windows\\x.txt'}).permissions,['files.write','manage'],'wiped params: the stored target still needs manage');
check(jobViewRequirements('query-events',{},{outputScope:{security:1}}).permissions,['diagnose','security.events'],'wiped params: the output scope still needs security.events');
check(jobViewRequirements('list-files',{},{outputScope:{management:true}}).permissions,['files.read','manage'],'output scope management adds manage');
check(jobViewRequirements('rename-file',{path:'C:\\data\\a.pfx',name:'b.txt'},{target:'C:\\data\\a.pfx → b.txt'}).permissions,['files.write','manage'],'A3: the stored params count although the target is harmless');
check(jobViewRequirements('kill-process',{},{target:'PID 4'}).permissions,['diagnose','manage'],'view keeps the base rights');
check(jobViewRequirements('refresh',{},{target:'',outputScope:'broken'}).permissions,['diagnose'],'malformed output scope adds nothing');
// Only a file job's target is its path; other kinds store a label there.
check(jobViewRequirements('export-events',{},{target:'Security / json',outputScope:{security:true}}).permissions,['diagnose','security.events'],'an export label is no path');
check(jobViewRequirements('export-events',{},{target:'Security / json'}).permissions,['diagnose'],'without output scope only diagnose');
check(jobViewRequirements('delete-file',{},{target:'C:\\Windows\\x'}).permissions,['files.write','manage'],'delete-file target stays a path');
check(jobViewRequirements('list-files',{},{target:'C:\\Users'}).permissions,['files.read','manage'],'list-files target stays a path');
check(jobViewRequirements('create-directory',{},{target:'C:\\Program Files\\x'}).permissions,['files.write','manage'],'create-directory target stays a path');
check(jobViewRequirements('rename-file',{},{target:'C:\\data\\a.pfx'}).permissions,['files.write','manage'],'rename-file target stays a path');
check(jobViewRequirements('export-events',{},{target:'Security / json',outputScope:{management:true}}).permissions,['diagnose','manage'],'the output-scope management fallback stays for every kind');
check(jobViewRequirements('set-task',{name:'Task',path:'\\Microsoft\\Crypto\\'},{target:'Task'}).privilegedPath,true,'the params fallback stays for every kind');
// A PowerShell script from the assistant (agent 4.17.0): terminal, Management mode, MFA and its capability, with and without its parameters.
const assistantScript=full('assistant-powershell',{permissions:['terminal'],managementMode:true,mfa:true});
check(jobRequirements('assistant-powershell',{script:'Get-Date',timeoutSeconds:120}),assistantScript,'assistant-powershell needs terminal, Management mode, MFA and the capability');
check(jobRequirements('assistant-powershell',{}),assistantScript,'also after its parameters are wiped');
check(jobViewRequirements('assistant-powershell',{},{target:'Get-Date / 0123456789ab',outputScope:{security:false,management:false}}).permissions,['terminal'],'the view of its output needs terminal');
check(jobViewRequirements('assistant-powershell',{},{target:'C:\\Windows\\x'}).permissions,['terminal'],'its target is no path');
for(const kind of [...Object.keys(operations),...Object.keys(diagnosticDefinitions)].filter(kind=>!['list-files','create-directory','rename-file','delete-file'].includes(kind))){
 for(const target of ['Security / json','C:\\Windows\\x','C:\\data\\a.pfx'])check(jobViewRequirements(kind,{},{target}),jobRequirements(kind,{}),`${kind} ignores the target ${target}`);
}

// ---------------------------------------------------------------------------
// 2. Sites ±1: the real routes, real access.ts and real
// database. A non-owner holds view plus exactly R, or R without one right r.
// ---------------------------------------------------------------------------
const d=await sourceDatabase();
const HttpError=realHttpError;
let clock=Date.now(),viewer=null;
const uuid=()=>crypto.randomUUID(),noop=async()=>{},allow=sql`TRUE`;
const server={
 db:()=>d,now:()=>clock,config:()=>'',guid:value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
 hash:async value=>crypto.createHash('sha256').update(value).digest('hex'),HttpError,log:noop,
 requireViewer:async()=>viewer,sameOrigin:()=>{},body:request=>request.json(),random:()=>crypto.randomBytes(16).toString('hex'),
 failure:error=>Response.json({error:error.message},{status:error.status??500}),
};
const deviceRow=id=>d.one(sql`SELECT id,last_seen,management,snapshot,name,agent_public_key FROM servers WHERE id=${id}`);
const imports={
 '../context':server,'./context':server,'../../context':server,'@/lib/server/context':server,'./local-auth':{},
 '@/lib/server/identity/mfa':{requireMfa:noop},
 '@/lib/server/agent/agent-protocol':{
  maintenanceBusy:async()=>false,
  modern:(row,capability)=>{const p=row.snapshot?JSON.parse(row.snapshot):null;if(!p||!row.last_seen||clock-row.last_seen>120000)throw new HttpError(409,serverText('apiError.device.offline'));if(p.protocolVersion!==3||capability&&!p.agentCapabilities?.includes(capability))throw new HttpError(409,serverText('apiError.agent.v3FunctionRequired'));return p;},
  agentFromBearer:async request=>deviceRow((await request.clone().json()).serverId),assertAgentActive:noop,snapshot:row=>JSON.parse(row.snapshot),releaseLease:noop,securityFile:()=>false,lease:noop,
 },
 '@/agent/package-v3':{installerV3:()=>'',registrationV3:()=>''},
 '@/lib/server/agent/agent-dispatch':{dispatchSigner:()=>null,DISPATCH_LIFETIME_SECONDS:60,JOB_SIGNING_KEY_MISSING:'missing'},'@/lib/server/agent/agent-crypto':{sealAgentSecrets:async()=>({})},
 '@/lib/server/devices/device-group-catalog':{deviceGroupCatalog:async()=>[],devicePermissionTargets:async()=>[]},'@/lib/server/agent/device-tokens':{PERSONAL_REGISTRATION_LIFETIME:1},
 '@/lib/server/devices/device-lifecycle':{removeDevice:noop,removeDevices:noop,sweepRemovedTransfers:noop},'@/lib/server/devices/rdp':{sweepRdp:noop},
 '@/lib/server/audit-scope':{auditSelect:sql`SELECT 1`,deviceAuditGuard:()=>allow,portalAuditGuard:()=>allow},'@/lib/server/identity/customers':{visibleCustomers:async()=>[]},
 '@/lib/server/automation/runbooks':{tickAutomation:noop},'@/lib/server/automation/drift':{ingestDrift:noop},'@/lib/server/devices/file-access':{requireFileAccess:noop},
 '@/lib/server/devices/transfers':{verifyTransfer:noop,sweepTransfers:noop,transferAuthorizationGuard:()=>allow},'@/lib/server/devices/terminal-lifecycle':{sweepTerminalSessions:noop},
 '@/lib/server/devices/terminal-channel':{terminalReport:z.object({}),exchangeTerminals:async()=>[]},
 '@/lib/server/automation/desired-state':{advanceDesiredState:noop,checkPendingDesiredJob:async()=>true,desiredJobClaimGuard:async()=>allow},
 '@/lib/server/automation/desired-state-result':{desiredResultActions:new Set(),desiredResultStatement:()=>null},
 '@/lib/server/automation/automation-device':{reconcileDeviceAutomation:noop,getAutomationDriftPolicy:async()=>null},'@/lib/server/automation/automation-runbooks':{scopedRunbookClaimGuard:async()=>allow},
};
const modules=sourceLoader(),load=file=>modules(file,imports);
const consoleApi=load('app/api/console/route.ts'),filesApi=load('app/api/files/route.ts'),diagnosticsApi=load('app/api/diagnostics/route.ts'),channel=load('app/api/agent/channel/route.ts');
const {allPermissions}=load('lib/server/identity/access.ts'),{safeTarget}=load('lib/management.ts'),{diagnosticTarget}=load('lib/diagnostics.ts');

const allCapabilities=[...Object.keys(expected),'install-all-updates'];
const snapshot=(extra={})=>JSON.stringify({protocolVersion:3,mode:'Management',agentCapabilities:allCapabilities,...extra});
const device=uuid();
await d.exec(sql`INSERT INTO servers(id,name,token_hash,created_at,last_seen,management,snapshot) VALUES(${device},${'SRV-041'},${'token'},${clock},${clock+1e12},1,${snapshot()})`);
async function actor(name){
 const id=uuid(),roleId=uuid(),email=name+'@jobs.test',principal='private:'+email,at=Date.now();
 await inTransaction(d,[
  sql`INSERT INTO local_users(id,username,email,display_name,auth_principal,auth_email,status,auth_version,created_at,updated_at) VALUES(${id},${name},${email},${name},${principal},${email},'active',1,${at},${at})`,
  sql`INSERT INTO rbac_roles(id,name,description,permissions,builtin,created_at) VALUES(${roleId},${'Role '+name},'Job requirements fixture','[]',0,${at})`,
  sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(${uuid()},'user',${id},${roleId},'global','*',${at},${principal})`,
 ]);
 const v={id,userId:id,label:email,principal,username:name,displayName:name,permissions:[]};
 Object.defineProperty(v,'authorization',{value:{authVersion:1},enumerable:false});
 return {v,roleId,email};
}
const tech=await actor('technician');viewer=tech.v;
const grant=rights=>d.exec(sql`UPDATE rbac_roles SET permissions=${JSON.stringify(['view',...rights])} WHERE id=${tech.roleId}`);
const without=(rights,right)=>rights.filter(item=>item!==right);
const missing=right=>serverText('apiError.access.devicePermissionMissing',{permission:right});
const request=(payload,url='https://jobs.test/api')=>new Request(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
const answer=async response=>({status:response.status,body:await response.json()});
const jobs=async()=>(await d.one(sql`SELECT count(*) AS n FROM jobs WHERE server_id=${device}`)).n;
const clear=()=>inTransaction(d,[sql`DELETE FROM jobs`,sql`DELETE FROM job_outputs`]);
const targetOf=(kind,params)=>{try{return Object.hasOwn(operations,kind)?safeTarget(kind,params):Object.hasOwn(diagnosticDefinitions,kind)?diagnosticTarget(kind,params):kind==='agent-update'?'4.8.0':kind;}catch{return kind;}};
async function insertJob(kind,params,{state='pending',target=targetOf(kind,params),stored=JSON.stringify(params)}={}){
 const id=uuid();
 await d.exec(sql`INSERT INTO jobs(id,server_id,action,target,state,created_at,actor,parameters,actor_email,actor_principal,not_before) VALUES(${id},${device},${kind},${target},${state},${clock},${tech.v.id},${stored},${tech.email},${tech.v.principal},0)`);
 return id;
}
const jobState=async id=>d.one(sql`SELECT state,result FROM jobs WHERE id=${id}`);

// Queue (sites 1–3): R passes; R without r answers 403 naming r and queues nothing.
async function queue(label,send,kind,params){
 const rights=jobRequirements(kind,params).permissions;
 for(const right of rights){
  await clear();await grant(without(rights,right));
  const result=await answer(await send());
  check([result.status,result.body.error,await jobs()],[403,missing(right),0],`${label} ${kind} ${JSON.stringify(params)} without ${right}`);
 }
 await clear();await grant(rights);
 const result=await answer(await send());
 check([result.status,typeof result.body.id,await jobs()],[200,'string',1],`${label} ${kind} ${JSON.stringify(params)} with exactly its rights`);
 await clear();
}
const startedAt=new Date(clock).toISOString(),session={sessionId:2,username:'user',confirm:true};
const diagnosticCases=[
 ['list-processes',{}],['kill-process',{pid:4,startedAt,confirm:true}],['list-sessions',{}],['message-session',{...session,message:'Hallo'}],
 ['disconnect-session',session],['logoff-session',session],['list-connections',{}],['network-diagnostics',{}],
 ['query-events',{}],['query-events',{channel:'Security'}],['export-events',{filter:{},format:'json'}],['export-events',{filter:{channel:'Security'},format:'json'}],
 ['support-bundle',{}],['support-bundle',{channels:['System','Security']}],
];
check([...new Set(diagnosticCases.map(([kind])=>kind))].sort(),Object.keys(diagnosticDefinitions).sort(),'diagnostic queue covers every kind');
for(const [kind,params] of diagnosticCases)await queue('diagnostics queue',()=>diagnosticsApi.POST(request({serverId:device,kind,params,confirm:true})),kind,params);
const fileCases=[
 ['list-files',{}],['list-files',{path:'C:\\data'}],['list-files',{path:'C:\\Windows'}],['list-files',{includeSecurity:true}],
 ['create-directory',{path:'C:\\data\\new'}],['create-directory',{path:'C:\\Program Files\\new'}],['create-directory',{path:'C:\\logs\\security-events-1.json'}],
 ['rename-file',{path:'C:\\data\\a.txt',name:'b.txt'}],['rename-file',{path:'C:\\data\\a.txt',name:'b.pfx'}],['rename-file',{path:'C:\\logs\\a.txt',name:'Security.evtx'}],
 ['delete-file',{path:'C:\\data\\a.txt'}],['delete-file',{path:'C:\\data\\a.pfx'}],['delete-file',{path:'C:\\logs\\Security.evtx'}],
];
for(const [kind,params] of fileCases)await queue('files queue',()=>filesApi.POST(request({serverId:device,kind,params,confirm:true})),kind,params);
const consoleCases=[
 ['refresh',{}],['restart-service',{name:'Spooler'}],['storage-inspect',{}],['install-updates',{all:true}],
 ['rename-file',{path:'C:\\data\\a.pfx',name:'b.txt'}],['rename-file',{path:'C:\\logs\\a.txt',name:'Security.evtx'}],
 ['delete-file',{path:'C:\\Windows\\x.txt'}],['delete-file',{path:'C:\\logs\\Security.evtx'}],
];
for(const [kind,params] of consoleCases)await queue('console queue',()=>consoleApi.POST(request({action:'job',id:device,kind,params,confirm:true})),kind,params);

// Every kind and variant for claim, cancel and display, inserted as stored rows.
const storedCases=[
 ...Object.keys(expected).filter(kind=>!['runbook-step','agent-update'].includes(kind)).map(kind=>[kind,{}]),
 ['agent-update',{releaseId:'release-1'}],
 ['runbook-step',{runId:uuid(),kind:'diagnosis',operation:'refresh',operationParameters:{}}],
 ['runbook-step',{runId:uuid(),kind:'powershell',script:'Get-Date'}],
 ...variants.filter(([kind])=>Object.hasOwn(expected,kind)).map(([kind,params])=>[kind,params]),
 ['install-updates',{all:true}],
];

// Claim (site 6): R is claimed; R without r is cancelled before dispatch.
const deniedClaim='serverMessage.job.permissionOrCapabilityMissing';
async function poll(body={}){
 clock+=1000;const response=await channel.POST(request({serverId:device,...body},'https://jobs.test/api/agent/channel'));
 assert.equal(response.status,200,'channel answers: '+JSON.stringify(await response.clone().json()));return response.json();
}
// The agent-uninstall claim also needs instance.owner; tests/api/agent-uninstall.mjs covers it.
for(const [kind,params] of storedCases.filter(([kind])=>kind!=='agent-uninstall')){
 const rights=jobRequirements(kind,params).permissions,label=`claim ${kind} ${JSON.stringify(params)}`;
 for(const right of rights){
  await clear();await grant(without(rights,right));const id=await insertJob(kind,params);await poll();
  check(await jobState(id),{state:'cancelled',result:deniedClaim},`${label} without ${right}`);
 }
 await clear();await grant(rights);const id=await insertJob(kind,params),claimed=await poll();
 check([(await jobState(id)).state,claimed.jobs.map(job=>job.id)],['running',[id]],`${label} with exactly its rights`);
}
// Claim validity: capabilities and Management mode come from the requirements.
await clear();await grant(['manage']);
await d.exec(sql`UPDATE servers SET snapshot=${snapshot({agentCapabilities:allCapabilities.filter(capability=>capability!=='install-all-updates')})} WHERE id=${device}`);
let id=await insertJob('install-updates',{all:true});await poll();
check(await jobState(id),{state:'cancelled',result:deniedClaim},'all updates are not claimed by an agent without install-all-updates');
await d.exec(sql`UPDATE servers SET snapshot=${snapshot()},management=0 WHERE id=${device}`);
await clear();id=await insertJob('restart-service',{name:'Spooler'});await poll();
check(await jobState(id),{state:'cancelled',result:deniedClaim},'a changing job is not claimed when Management is off');
await clear();await grant(['diagnose']);id=await insertJob('refresh',{});await poll();
check((await jobState(id)).state,'running','a read-only job is still claimed when Management is off');
await d.exec(sql`UPDATE servers SET management=1 WHERE id=${device}`);
// The stamped output scope uses securityEvents and privilegedPath.
for(const [kind,params,scope] of [['list-files',{includeSecurity:true},{security:true,management:false}],['delete-file',{path:'C:\\Windows\\x.txt'},{security:false,management:true}],['query-events',{channel:'Security'},{security:true,management:false}]]){
 await clear();await grant(jobRequirements(kind,params).permissions);const job=await insertJob(kind,params);await poll();
 await poll({results:[{id:job,ok:true,message:'Fertig',data:{}}]});
 const output=JSON.parse((await d.one(sql`SELECT data FROM job_outputs WHERE job_id=${job}`)).data);
 check(output.scope,{...scope,runbookCustom:false},'output scope of '+kind);
}

// Cancel (site 5): R cancels; R without r answers 403 naming r and the job stays pending.
for(const [kind,params] of storedCases){
 const rights=jobRequirements(kind,params).permissions,label=`cancel ${kind} ${JSON.stringify(params)}`;
 await clear();const job=await insertJob(kind,params);
 for(const right of rights){
  // A2 (tightening) shows up here for privileged paths: cancel now needs manage too.
  await grant(without(rights,right));const result=await answer(await consoleApi.POST(request({action:'cancel-job',id:job})));
  check([result.status,result.body.error,(await jobState(job)).state],[403,missing(right),'pending'],`${label} without ${right}`);
 }
 await grant(rights);const result=await answer(await consoleApi.POST(request({action:'cancel-job',id:job})));
 check([result.status,(await jobState(job)).state],[200,'cancelled'],`${label} with exactly its rights`);
}
await clear();await grant(allPermissions);id=await insertJob('retired-kind',{});
let result=await answer(await consoleApi.POST(request({action:'cancel-job',id})));
check([result.status,result.body.error,(await jobState(id)).state],[403,serverText('apiError.job.forbidden'),'pending'],'an unknown kind is cancelled by an owner only');
// A real Owner in the fixture DB (live can(), lib/server/identity/policy/can.ts): '*' includes manage.
viewer={...tech.v,permissions:['*']};Object.defineProperty(viewer,'authorization',{value:{authVersion:1},enumerable:false});await grant(['*']);
result=await answer(await consoleApi.POST(request({action:'cancel-job',id})));
check([result.status,(await jobState(id)).state],[200,'cancelled'],'an owner may cancel an unknown kind with manage');
viewer=tech.v;
await clear();await grant(allPermissions);id=await insertJob('refresh',{},{state:'running'});
result=await answer(await consoleApi.POST(request({action:'cancel-job',id})));
check(result.status,409,'only pending jobs can be cancelled');

// Display (site 4): the console list shows a job only with every right of R.
const listed=async()=>(await answer(await consoleApi.GET(new Request('https://jobs.test/api/console?jobsOnly=1')))).body.jobs.map(job=>job.id);
for(const [kind,params] of storedCases.filter(([kind])=>!['runbook-step','list-files','storage-inspect'].includes(kind))){
 // A3 (tightening): rights from the stored params count, not only those from the
 // stored target, e.g. rename-file C:\data\a.pfx → b.txt or set-task \Microsoft\Crypto\.
 // The list reads the stored target as a path only for file jobs.
 const rights=jobViewRequirements(kind,params,{target:targetOf(kind,params)}).permissions,label=`list ${kind} ${JSON.stringify(params)}`;
 await clear();const job=await insertJob(kind,params);
 for(const right of rights){await grant(without(rights,right));check((await listed()).includes(job),false,`${label} hidden without ${right}`);}
 await grant(rights);check((await listed()).includes(job),true,`${label} shown with exactly its rights`);
}
await clear();await grant(allPermissions);id=await insertJob('retired-kind',{});
check((await listed()).includes(id),false,'an unknown kind stays hidden for non-owners');
// A3 on a pending console rename whose target hides the privileged source path.
await clear();id=await insertJob('rename-file',{path:'C:\\data\\a.pfx',name:'b.txt'});
check(targetOf('rename-file',{path:'C:\\data\\a.pfx',name:'b.txt'}),'C:\\data\\a.pfx → b.txt','the console target');
await grant(['files.write']);check((await listed()).includes(id),false,'A3: console list needs manage from the stored params');

// Display fallbacks after the parameters were wiped.
await clear();id=await insertJob('delete-file',{},{state:'succeeded',target:'C:\\Windows\\x.txt',stored:'{}'});
await grant(['files.write']);check((await listed()).includes(id),false,'wiped params: privileged target hides the job without manage');
result=await answer(await filesApi.GET(new Request(`https://jobs.test/api/files?serverId=${device}&jobId=${id}`)));
check([result.status,result.body.error],[403,missing('manage')],'wiped params: GET /api/files needs manage for the privileged target');
await grant(['files.write','manage']);check((await listed()).includes(id),true,'wiped params: shown with manage');
result=await answer(await filesApi.GET(new Request(`https://jobs.test/api/files?serverId=${device}&jobId=${id}`)));
check(result.status,200,'wiped params: GET /api/files with manage');
await clear();id=await insertJob('query-events',{},{state:'succeeded',target:'Security',stored:'{}'});
await d.exec(sql`INSERT INTO job_outputs(job_id,server_id,data,created_at) VALUES(${id},${device},${JSON.stringify({scope:{security:true,management:false}})},${clock})`);
await grant(['diagnose']);check((await listed()).includes(id),false,'wiped params: the output scope hides Security events');
result=await answer(await diagnosticsApi.GET(new Request(`https://jobs.test/api/diagnostics?serverId=${device}&jobId=${id}`)));
check([result.status,result.body.error],[403,missing('security.events')],'GET /api/diagnostics keeps its output-scope fallback');
await grant(['diagnose','security.events']);check((await listed()).includes(id),true,'output scope: shown with security.events');
// a finished export keeps its label target; the label is no privileged path.
await clear();id=await insertJob('export-events',{},{state:'succeeded',target:'Security / json',stored:'{}'});
await d.exec(sql`INSERT INTO job_outputs(job_id,server_id,data,created_at) VALUES(${id},${device},${JSON.stringify({scope:{security:true,management:false}})},${clock})`);
await grant(['diagnose','security.events']);check((await listed()).includes(id),true,'finished export shown with diagnose and security.events, without manage');
await grant(['diagnose']);check((await listed()).includes(id),false,'finished export hidden without security.events');
await clear();id=await insertJob('delete-file',{},{state:'succeeded',target:'C:\\Windows\\x.txt',stored:'{}'});
await grant(['files.write']);check((await listed()).includes(id),false,'a wiped delete-file with a privileged target stays hidden without manage');
// A1 in GET /api/diagnostics was already the rule: a changing diagnostic needs manage.
await clear();id=await insertJob('kill-process',{},{state:'succeeded',stored:'{}'});await grant(['diagnose']);
result=await answer(await diagnosticsApi.GET(new Request(`https://jobs.test/api/diagnostics?serverId=${device}`)));
check([result.status,result.body.jobs.length],[200,0],'the diagnostics list skips a changing job without manage');
await grant(['diagnose','manage']);result=await answer(await diagnosticsApi.GET(new Request(`https://jobs.test/api/diagnostics?serverId=${device}`)));
check(result.body.jobs.map(job=>job.id),[id],'the diagnostics list shows it with manage');

// Queue limit: 20 waiting jobs; console and diagnostics answer 429, files keeps its 409.
await clear();await grant(allPermissions);for(let index=0;index<20;index++)await insertJob('refresh',{});
result=await answer(await consoleApi.POST(request({action:'job',id:device,kind:'refresh',params:{}})));
check([result.status,result.body.error],[429,serverText('apiError.console.queueFull',{count:20})],'console queue limit');
result=await answer(await diagnosticsApi.POST(request({serverId:device,kind:'list-processes',params:{}})));
check([result.status,result.body.error],[429,serverText('apiError.console.queueFull',{count:20})],'diagnostics queue limit');
result=await answer(await filesApi.POST(request({serverId:device,kind:'list-files',params:{}})));
check([result.status,result.body.error],[409,serverText('apiError.console.queueChanged')],'files queue limit in the SQL guard');
check(await jobs(),20,'the limit admits no 21st job');
check(load('lib/server/devices/jobs/queue.ts').MAX_QUEUED_JOBS,20,'one constant for the limit');
await clear();
d.close?.();

// ---------------------------------------------------------------------------
// 3. Source check: no site composes job rights by hand any more.
// ---------------------------------------------------------------------------
for(const file of ['app/api/console/route.ts','app/api/files/route.ts','app/api/diagnostics/route.ts','app/api/agent/channel/route.ts','ui/shell/console-jobs.tsx']){
 const text=fs.readFileSync(file,'utf8');
 check(text.match(/\b(?:operationPermission|filePermission|fileManagementAccess|fileSecurityAccess|diagnosticSecurityAccess|isReadOnlyRunbookJob)\b/g),null,'no hand-composed job rights in '+file);
}
check(fs.existsSync('lib/job-permissions.ts'),false,'lib/job-permissions.ts is gone');

// ---------------------------------------------------------------------------
// 4. Client cancel button: every base right, the real permitted().
// ---------------------------------------------------------------------------
const require=createRequire(import.meta.url),viewCache=new Map();
const viewStubs={'@/ui/devices/management/management-actions':{operationLabel:action=>action}};
function view(file){
 const absolute=path.resolve(file);if(viewCache.has(absolute))return viewCache.get(absolute).exports;
 const mod={exports:{}};viewCache.set(absolute,mod);
 const code=ts.transpileModule(fs.readFileSync(absolute,'utf8'),{fileName:absolute,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
 new Function('require','module','exports',code)(name=>{
  if(Object.hasOwn(viewStubs,name))return viewStubs[name];
  // A plain JavaScript module of runtime/ (for example runtime/release-version.mjs) loads as itself.
  if(name.startsWith('.')&&name.endsWith('.mjs'))return require(path.resolve(path.dirname(absolute),name));
  if(name.startsWith('.')||name.startsWith('@/')){const base=name.startsWith('@/')?path.resolve(name.slice(2)):path.resolve(path.dirname(absolute),name),target=[base+'.ts',base+'.tsx',path.join(base,'index.ts')].find(candidate=>fs.existsSync(candidate));if(target)return view(target);}
  return require(name);
 },mod,mod.exports);
 return mod.exports;
}
const {canCancelJob,cancelJobVisible}=view('ui/shell/console-jobs.tsx'),operator={id:'u',label:'u@jobs.test',permissions:[]};
const can=(action,permissions,extra={})=>canCancelJob({id:'j',serverId:'s',action,state:'pending',target:'',createdAt:0,...extra},[{id:'s',name:'SRV',permissions}],operator);
check(can('kill-process',['view','manage']),false,'A1: the button needs diagnose for a changing diagnostic');
check(can('kill-process',['view','diagnose','manage']),true,'kill-process with diagnose and manage');
check(can('agent-update',['view','update']),true,'agent-update with update');
check(can('agent-uninstall',['view','manage']),true,'agent-uninstall with manage');
check(can('agent-uninstall',['view','update']),false,'agent-uninstall needs manage');
check(can('runbook-step',['view','runbooks.execute']),true,'runbook-step with runbooks.execute');
check(can('list-processes',['view','diagnose']),true,'read-only diagnostic with diagnose');
check(can('refresh',['view','diagnose'],{state:'running'}),false,'only pending jobs');
check(can('runbook-run',allPermissions),false,'runbook runs are cancelled elsewhere');
check(canCancelJob({id:'j',serverId:'s',action:'kill-process',state:'pending'},[{id:'s',permissions:[]}],{...operator,permissions:['*']}),true,'owner');
// A missing right disables the button with a reason instead of hiding it.
const pendingJob=(extra={})=>({id:'j',serverId:'s',action:'kill-process',state:'pending',target:'',createdAt:0,...extra}),knownServers=[{id:'s',name:'SRV',permissions:['view','diagnose']}];
check([cancelJobVisible(pendingJob(),knownServers),canCancelJob(pendingJob(),knownServers,operator)],[true,false],'a pending kill-process with only diagnose is visible but not cancellable');
check(cancelJobVisible(pendingJob({state:'running'}),knownServers),false,'a running job has no cancel button');
check(cancelJobVisible(pendingJob({action:'runbook-run'}),knownServers),false,'a runbook run has no cancel button');
check(cancelJobVisible(pendingJob({serverId:'other'}),knownServers),false,'a job of an unknown server has no cancel button');
// The job drawer moved out of console.tsx into job-detail.tsx; History's JobTable has the entry in its row Menu. All
// three block Cancel job with the reason of cancelJobBlocked (demo, the missing permission, saving).
check(/blocked:t\(reason\)/.test(fs.readFileSync('ui/devices/history/job-table.tsx','utf8'))&&/cancelJobBlocked\(/.test(fs.readFileSync('ui/devices/history/job-table.tsx','utf8'))&&/cancelJobVisible\(/.test(fs.readFileSync('ui/devices/history/job-table.tsx','utf8')),true,'ui/devices/history/job-table.tsx blocks its Cancel job menu entry with the reason');
for(const file of ['ui/shell/jobs.tsx','ui/shell/job-detail.tsx']){
 const text=fs.readFileSync(file,'utf8');
 check(/cancelJobBlocked\(/.test(text)&&/blocked=\{t\((blocked|cancelReason)\)\}/.test(text),true,''+file+' blocks the cancel button with the reason');
 check(/cancelJobVisible\(/.test(text),true,''+file+' shows the button by cancelJobVisible');
 check(/\{cancellable&&<IconBtn|canCancelJob\(job,servers,user\)\?<Btn disabled=\{demo\|\|saving\} onClick=\{\(\)=>cancelJob\(job\)\}>Auftrag abbrechen<\/Btn>:undefined/.test(text),false,''+file+' no longer hides the button by canCancelJob alone');
}
check(/export default/.test(fs.readFileSync('ui/shell/console-jobs.tsx','utf8')),false,'the classic JobsTable is gone; the job dock carries the cancel button');

console.log(`PASS: ${checks} job requirement assertions: pure matrix, queue, claim, cancel and display sites, fallbacks, queue limit, source check and cancel button.`);
