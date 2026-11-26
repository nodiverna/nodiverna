// GPU driver updates on PostgreSQL: GET /api/gpu-drivers/device
// (view right, customer boundary, no download URL, revoked and GPU-less devices,
// the 5-minute refresh limit, the global limit of forced lookups) and the
// install-gpu-driver job of POST /api/console (URL and size only from the
// server's lookup, the refusals with the reason the GET shows, the capability
// and ReadOnly mode). The vendor web is stubbed with the recorded fixtures.
import {HttpError as realHttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {z} from 'zod';
import {sourceDatabase,sourceLoader,insertRow} from '../support/source-database.mjs';
import {sql} from '../../runtime/database.mjs';
import {boundaryPhase,everyCustomer} from '../support/customer-separation.mjs';

let checks=0,viewer=null;
const clock=Date.now();
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const uuid=()=>crypto.randomUUID(),noop=async()=>{},allow=sql`TRUE`;
const HttpError=realHttpError,d=await sourceDatabase();
const stamped=v=>Object.defineProperty(v,'authorization',{value:{authVersion:1},enumerable:false});

// ---- The vendor web: recorded NVIDIA and AMD answers; other AMD driver pages fail ----
const fixture=name=>fs.readFileSync('tests/fixtures/gpu-drivers/'+name,'utf8');
const vendorRequests=[];
const fetch=async(url,init={})=>{
 vendorRequests.push(url);
 const parsed=new URL(url),type=parsed.searchParams.get('TypeID');
 if(parsed.hostname==='www.nvidia.com')return new Response(fixture(type==='2'?'nvidia-series.xml':type==='3'?'nvidia-products.xml':parsed.searchParams.get('ParentID')==='127'?'nvidia-os-127.xml':'nvidia-os-122.xml'));
 if(parsed.hostname==='gfwsl.geforce.com')return new Response(fixture(parsed.searchParams.get('psid')==='127'?'nvidia-driver-geforce.json':'nvidia-driver-rtx.json'));
 if(url==='https://www.amd.com/en/support/download/drivers.html')return new Response(fixture('amd-drivers-index.html'));
 if(url==='https://www.amd.com/en/support/downloads/drivers.html/graphics/radeon-rx/radeon-rx-7000-series/amd-radeon-rx-7900-xtx.html')return new Response(fixture('amd-driver-rx-7900-xtx.html'));
 if(/download\.nvidia\.com$|^drivers\.amd\.com$/.test(parsed.hostname)&&init.headers?.range==='bytes=0-0')return new Response(null,{status:206,headers:{'content-range':'bytes 0-0/1037190000'}});
 return new Response('unavailable',{status:503});
};
const loader=sourceLoader(),realCatalog=loader('lib/server/devices/gpu-drivers/catalog.ts');
const catalog=realCatalog.createGpuDriverCatalog({fetch,now:()=>clock});
// The routes use activeCatalog, so one block can switch to a catalog with a small budget of forced lookups.
let activeCatalog=catalog;
const routeCatalog={lookup:(...args)=>activeCatalog.lookup(...args),claimRefresh:(...args)=>activeCatalog.claimRefresh(...args)};
const geforceUrl='https://us.download.nvidia.com/Windows/621.01/621.01-desktop-win10-win11-64bit-international-dch-whql.exe';

const server={
 db:()=>d,now:()=>clock,config:()=>'',guid:value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
 hash:async value=>crypto.createHash('sha256').update(value).digest('hex'),HttpError,log:noop,
 requireViewer:async()=>viewer,sameOrigin:()=>{},body:request=>request.json(),random:()=>crypto.randomBytes(16).toString('hex'),
 failure:error=>error instanceof HttpError?Response.json({error:error.message,code:error.code,messageKey:error.messageKey,params:error.params},{status:error.status}):Response.json({error:String(error?.message??error)},{status:500}),
};
const imports={
 '../context':server,'./context':server,'../../context':server,'@/lib/server/context':server,'./local-auth':{},
 './catalog':{...realCatalog,gpuDriverCatalog:routeCatalog},
 '@/lib/server/identity/mfa':{requireMfa:noop},
 '@/lib/server/agent/agent-protocol':{maintenanceBusy:async()=>false},
 '@/agent/package-v3':{installerV3:()=>'',registrationV3:()=>''},
 '@/lib/server/agent/agent-dispatch':{dispatchSigner:()=>null,DISPATCH_LIFETIME_SECONDS:60,JOB_SIGNING_KEY_MISSING:'missing'},'@/lib/server/agent/agent-crypto':{sealAgentSecrets:async()=>({})},
 '@/lib/server/devices/device-group-catalog':{deviceGroupCatalog:async()=>[],devicePermissionTargets:async()=>[]},'@/lib/server/agent/device-tokens':{PERSONAL_REGISTRATION_LIFETIME:1},
 '@/lib/server/devices/device-lifecycle':{removeDevice:noop,removeDevices:noop,sweepRemovedTransfers:noop},'@/lib/server/devices/rdp':{sweepRdp:noop},
 '@/lib/server/audit-scope':{auditSelect:sql`SELECT 1`,deviceAuditGuard:()=>allow,portalAuditGuard:()=>allow},'@/lib/server/identity/customers':{visibleCustomers:async()=>[]},
 '@/lib/server/automation/runbooks':{tickAutomation:noop},'@/lib/server/automation/drift':{ingestDrift:noop},'@/lib/server/devices/file-access':{requireFileAccess:noop},
 '@/lib/server/devices/transfers':{verifyTransfer:noop,sweepTransfers:noop,transferAuthorizationGuard:()=>allow},'@/lib/server/devices/terminal-lifecycle':{sweepTerminalSessions:noop},
 '@/lib/server/devices/terminal-channel':{terminalReport:z.object({}),exchangeTerminals:async()=>[]},
};
const load=file=>loader(file,imports);
const deviceApi=load('app/api/gpu-drivers/device/route.ts'),consoleApi=load('app/api/console/route.ts');
check(fs.readFileSync('app/api/gpu-drivers/device/route.ts','utf8').includes('sql`'),false,'the route has no SQL; lib/server/devices/gpu-drivers/device.ts owns it');

// ---- Fixtures ----
const time=Date.now(),insert=(table,row)=>insertRow(d,table,row);
const customerA='00000000-0000-4000-8000-000000000100',customerB=uuid();
await insert('customers',{id:customerB,name:'Customer B',created_at:time,updated_at:time});
async function persona(name,permissions){
 const id=uuid(),principal='local:'+id,roleId=uuid();
 await insert('local_users',{id,username:name,email:name+'@gpu.test',display_name:name,auth_principal:principal,auth_email:name+'@gpu.test',status:'active',auth_version:1,created_at:time,updated_at:time});
 await insert('rbac_roles',{id:roleId,name:'Role '+name,description:'',permissions:JSON.stringify(permissions),builtin:0,created_at:time});
 await d.exec(sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(${uuid()},'user',${id},${roleId},'global','*',${time},'fixture')`);
 return stamped({id,userId:id,label:name+'@gpu.test',principal,username:name,displayName:name,permissions:[]});
}
const at=new Date(time).toISOString();
const capabilities=['refresh','install-gpu-driver'];
const snapshot=({gpus=[{id:'g1',name:'NVIDIA GeForce RTX 4070',vendor:'nvidia'}],details=[{id:'g1',vendorDriverVersion:'581.57'}],mode='Management',agentCapabilities=capabilities,os='Microsoft Windows 11 Pro',osInfo={editionId:'Professional',installationType:'Client'}}={})=>JSON.stringify({
 protocolVersion:3,mode,agentCapabilities,os,osInfo,
 gpus:gpus.map(gpu=>({utilization:4,collectedAt:at,...gpu})),gpuDetails:details.map(row=>({collectedAt:at,...row})),
});
async function device(name,{customer=customerA,management=1,revoked=0,...shape}={}){
 const id=uuid();
 await insert('servers',{id,name,token_hash:'fixture-'+id,created_at:time,last_seen:clock,management,snapshot:snapshot(shape),customer_id:customer,revoked});
 return id;
}
const reader=await persona('reader',['view']),technician=await persona('technician',['view','manage']),stranger=await persona('stranger',[]);
const outdated=await device('GPU-OLD'),outdatedIdle=await device('GPU-OLD-IDLE'),current=await device('GPU-NEW',{details:[{id:'g1',vendorDriverVersion:'621.01'}]});
const mixed=await device('GPU-MIX',{gpus:[{id:'g1',name:'NVIDIA GeForce RTX 4070',vendor:'nvidia'},{id:'g2',name:'NVIDIA GeForce RTX 4070',vendor:'nvidia'},{id:'g3',name:'AMD Radeon RX 7900 XTX',vendor:'amd'}],details:[{id:'g1',vendorDriverVersion:'617.42'},{id:'g2',driverVersion:'32.0.15.8157'},{id:'g3',vendorDriverVersion:'26.9.2',deviceId:0x744c}]});
const amdFailing=await device('AMD-FAIL',{gpus:[{id:'g1',name:'AMD Radeon RX 7800 XT',vendor:'amd'}],details:[{id:'g1',vendorDriverVersion:'26.9.2',deviceId:0x747e}]});
const noGpu=await device('NO-GPU',{gpus:[],details:[]}),revoked=await device('REVOKED',{revoked:1});
const datacenter=await device('DC-GPU',{gpus:[{id:'g1',name:'NVIDIA RTX PRO 6000 Blackwell Server Edition',vendor:'nvidia'}]});
const radeon7900={gpus:[{id:'g1',name:'AMD Radeon RX 7900 XTX',vendor:'amd'}],details:[{id:'g1',vendorDriverVersion:'26.9.2',deviceId:0x744c}]};
const amdServer=await device('AMD-SERVER',{...radeon7900,os:'Microsoft Windows Server 2022 Standard',osInfo:{editionId:'ServerStandard',installationType:'Server'}});
const amdUnknownOs=await device('AMD-UNKNOWN-OS',{...radeon7900,os:'Unknown system',osInfo:null});
const longName=await device('LONG-NAME',{gpus:[{id:'g1',name:'NVIDIA GeForce RTX 4070 '+'x'.repeat(200),vendor:'nvidia'}]});
const oldAgent=await device('OLD-AGENT',{agentCapabilities:['refresh']}),readOnly=await device('READONLY',{mode:'ReadOnly'}),localReadOnly=await device('LOCAL-RO',{management:0});
const foreign=await device('FOREIGN',{customer:customerB});

const get=async(v,id,refresh=false)=>{viewer=v;const response=await deviceApi.GET(new Request(`https://gpu.test/api/gpu-drivers/device?serverId=${id}${refresh?'&refresh=1':''}`));return {status:response.status,body:await response.json()};};
const queue=async(v,id,params)=>{viewer=v;const response=await consoleApi.POST(new Request('https://gpu.test/api/console',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'job',id,kind:'install-gpu-driver',params,confirm:true})}));return {status:response.status,body:await response.json()};};
const jobRows=id=>d.query(sql`SELECT action,target,parameters FROM jobs WHERE server_id=${id}`);

// Until the boundary phase every account sees every customer (tests/support/customer-separation.mjs).
await d.exec(everyCustomer(time));

// ---- GET ----
{
 const answer=await get(reader,outdated);
 check(answer.status,200,'view is enough to read the status');
 check(answer.body,{entries:[{vendor:'nvidia',gpuIds:['g1'],gpuNames:['NVIDIA GeForce RTX 4070'],installed:'581.57',reported:'581.57',pendingInventory:null,latest:{version:'621.01',releasedAt:'2026-10-21'},status:'outdated',reason:null,checkedAt:clock}]},'one NVIDIA entry, outdated');
 check(/https?:|download/i.test(JSON.stringify(answer.body)),false,'the answer contains no download URL');
 check((await get(reader,current)).body.entries[0].status,'current','the newest driver is current');
 const mix=(await get(reader,mixed)).body.entries;
 check(mix.map(entry=>[entry.vendor,entry.gpuIds,entry.installed,entry.latest,entry.status,entry.reason]),[['nvidia',['g1','g2'],'581.57',{version:'621.01',releasedAt:'2026-10-21'},'outdated',null],['amd',['g3'],'26.9.2',{version:'26.10.1',releasedAt:'2026-10-20'},'outdated',null]],'one entry per vendor; the oldest NVIDIA version decides; AMD has its Recommended Adrenalin release');
 check((await get(reader,amdFailing)).body.entries.map(entry=>[entry.status,entry.reason]),[['unknown','lookup-failed']],'an AMD driver page that fails is lookup-failed');
 check((await get(reader,noGpu)).body,{entries:[]},'a device without GPUs');
 check((await get(reader,revoked)).body,{entries:[]},'a revoked device');
 const hidden=await get(stranger,revoked);
 check([hidden.status,hidden.body.messageKey],[403,'apiError.access.devicePermissionMissing'],'without view a revoked device is refused like any other, so its state stays hidden');
 check((await get(reader,datacenter)).body.entries[0].status,'unsupported','a data center card is unsupported');
 const denied=await get(stranger,outdated);
 check([denied.status,denied.body.messageKey],[403,'apiError.access.devicePermissionMissing'],'without view');
 check((await get(reader,'not-a-guid')).status,400,'an invalid device ID');
 check((await get(reader,uuid())).status,404,'an unknown device');
 await d.exec(boundaryPhase());
 await d.exec(sql`INSERT INTO customer_assignments(customer_id,principal_type,principal_id,created_at,created_by) VALUES(${customerA},'user',${reader.id},${time},'fixture'),(${customerA},'user',${technician.id},${time},'fixture')`);
 check((await get(reader,foreign)).status,404,'a device of an unseen customer answers 404');
 check((await get(reader,outdated)).status,200,'the own customer stays visible');
 const before=vendorRequests.length;
 const refreshed=await get(reader,outdated,true);
 check([refreshed.status,refreshed.body.notice,vendorRequests.length>before],[200,undefined,true],'"Check again" skips the cache');
 const refused=await get(reader,outdated,true);
 check([refused.status,refused.body.notice,refused.body.entries[0].latest.version],[200,{code:'RATE_LIMITED',messageKey:'apiError.gpuDriver.checkTooSoon'},'621.01'],'a second refresh within 5 minutes answers the cached result with checkTooSoon');
}

// ---- POST /api/console: install-gpu-driver ----
{
 const ok=await queue(technician,outdated,{vendor:'nvidia',version:'621.01'});
 check(ok.status,200,'the job is queued');
 const codes=await Promise.all([[current,'621.01'],[outdatedIdle,'617.42']].map(async([id,version])=>(await queue(technician,id,{vendor:'nvidia',version})).body.code));
 check(codes,['GPU_DRIVER_NO_UPDATE','GPU_DRIVER_VERSION_CHANGED'],'the client branches on these codes');
 const [row]=await jobRows(outdated);
 check([row.action,row.target,JSON.parse(row.parameters)],['install-gpu-driver','NVIDIA 621.01',{vendor:'nvidia',version:'621.01',url:geforceUrl,sizeBytes:1037190000}],'URL and size come from the lookup');
 const refuse=async(id,params,expected,label,v=technician)=>{const answer=await queue(v,id,params);check([answer.status,answer.body.messageKey],expected,label);};
 await refuse(outdated,{vendor:'nvidia',version:'621.01',url:'https://evil.example/x.exe'},[400,'apiError.console.invalidParameters'],'a client URL fails the strict schema');
 await refuse(outdated,{vendor:'nvidia',version:'621.01',sizeBytes:1},[400,'apiError.console.invalidParameters'],'a client size fails the strict schema');
 await refuse(outdated,{vendor:'intel',version:'1.0'},[400,'apiError.console.invalidParameters'],'Intel is no vendor');
 await refuse(outdated,{vendor:'nvidia',version:'621.01; rm'},[400,'apiError.console.invalidParameters'],'the version format');
 await refuse(outdatedIdle,{vendor:'amd',version:'26.10.1'},[409,'apiError.gpuDriver.noGpu'],'no GPU of that vendor');
 await refuse(current,{vendor:'nvidia',version:'621.01'},[409,'apiError.gpuDriver.noUpdate'],'the newest driver is installed');
 await refuse(outdatedIdle,{vendor:'nvidia',version:'617.42'},[409,'apiError.gpuDriver.versionChanged'],'the request names another version than the lookup');
 await refuse(outdated,{vendor:'nvidia',version:'621.01'},[409,'apiError.gpuDriver.jobActive'],'a second request while the first driver job waits');
 const datacenterJob=await queue(technician,datacenter,{vendor:'nvidia',version:'621.01'});
 check([datacenterJob.status,datacenterJob.body.code,datacenterJob.body.messageKey],[409,'GPU_DRIVER_UNSUPPORTED_MODEL','apiError.gpuDriver.unsupportedModel'],'an unsupported model is refused as such, not as a failed lookup');
 await refuse(longName,{vendor:'nvidia',version:'621.01'},[409,'apiError.gpuDriver.unsupportedModel'],'a GPU name over 96 characters is an unsupported model');
 const failed=await queue(technician,amdFailing,{vendor:'amd',version:'26.10.1'});
 check([failed.status,failed.body.code,failed.body.messageKey],[502,'GPU_DRIVER_LOOKUP_FAILED','apiError.gpuDriver.lookupFailed'],'a failed lookup stays 502');
 // AMD has no driver for Windows Server or an unknown Windows version: the job
 // gets the reason of the GET, and AMD is never asked.
 for(const [id,label] of [[amdServer,'Windows Server'],[amdUnknownOs,'an unknown OS family']]){
  const before=vendorRequests.length,shown=(await get(reader,id)).body.entries;
  check(shown.map(entry=>[entry.vendor,entry.status,entry.reason]),[['amd','unsupported','unsupported-os']],`AMD on ${label}: the GET shows unsupported-os`);
  const answer=await queue(technician,id,{vendor:'amd',version:'26.10.1'});
  check([answer.status,answer.body.code,answer.body.messageKey,answer.body.params],[409,'GPU_DRIVER_UNSUPPORTED_OS','apiError.gpuDriver.unsupportedOs',{vendor:'AMD'}],`AMD on ${label}: the job is refused with unsupportedOs`);
  check(answer.body.error,'AMD offers no driver for this Windows version.','the refusal says what the card says');
  check(vendorRequests.slice(before).filter(url=>/amd\.com$/.test(new URL(url).hostname)),[],`AMD on ${label}: no request to AMD`);
 }
 const amdJob=await queue(technician,mixed,{vendor:'amd',version:'26.10.1'});
 check(amdJob.status,200,'an AMD job is queued');
 const amdRow=(await jobRows(mixed)).find(row=>row.target==='AMD 26.10.1');
 check(JSON.parse(amdRow.parameters),{vendor:'amd',version:'26.10.1',url:'https://drivers.amd.com/drivers/whql-amd-software-adrenalin-edition-26.10.1-win11-b.exe',sizeBytes:1037190000},'the AMD URL and size come from the driver page and the range request');
 await refuse(oldAgent,{vendor:'nvidia',version:'621.01'},[409,'apiError.agent.functionUnavailable'],'an agent without the capability');
 await refuse(readOnly,{vendor:'nvidia',version:'621.01'},[409,'apiError.agent.functionUnavailable'],'an agent in ReadOnly mode');
 const local=await queue(technician,localReadOnly,{vendor:'nvidia',version:'621.01'});
 check([local.status,local.body.messageKey],[403,'apiError.agent.readOnlyEnableManagement'],'Management off for the device');
 const reading=await queue(reader,outdated,{vendor:'nvidia',version:'621.01'});
 check([reading.status,reading.body.messageKey],[403,'apiError.access.devicePermissionMissing'],'view without manage');
 check((await queue(technician,foreign,{vendor:'nvidia',version:'621.01'})).status,404,'the customer boundary');
 const unconfirmed=await (async()=>{viewer=technician;const response=await consoleApi.POST(new Request('https://gpu.test/api/console',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'job',id:current,kind:'install-gpu-driver',params:{vendor:'nvidia',version:'621.01'}})}));return response.json();})();
 check(unconfirmed.messageKey,'apiError.console.confirmServerChange','the confirmation is required');
 for(const id of [outdatedIdle,current,datacenter,amdFailing,amdServer,amdUnknownOs,longName,oldAgent,readOnly,localReadOnly])check((await jobRows(id)).length,0,'no job after a refusal');
 check((await jobRows(outdated)).length,1,'only the valid request queued a job');
}

// ---- The job refusal names the reason of the GET entry, for every fixture device ----
{
 const refusalOf={'unsupported-os':[409,'GPU_DRIVER_UNSUPPORTED_OS'],'unsupported-model':[409,'GPU_DRIVER_UNSUPPORTED_MODEL'],'lookup-failed':[502,'GPU_DRIVER_LOOKUP_FAILED']};
 let compared=0;
 for(const id of [outdated,current,mixed,amdFailing,datacenter,amdServer,amdUnknownOs,longName]){
  for(const entry of (await get(technician,id)).body.entries){
   if(!Object.hasOwn(refusalOf,entry.reason))continue;
   const answer=await queue(technician,id,{vendor:entry.vendor,version:'621.01'});
   check([answer.status,answer.body.code],refusalOf[entry.reason],`${entry.vendor} entry with ${entry.reason}: the job refusal names the same reason`);
   compared++;
  }
 }
 check(compared,5,'the fixtures cover all three reasons');
}

// ---- The global limit of forced lookups: an allowed refresh over the budget gets checkBusy ----
{
 activeCatalog=realCatalog.createGpuDriverCatalog({fetch,now:()=>clock,forcedLookupLimit:1});
 const first=await get(reader,outdated,true);
 check([first.status,first.body.notice,first.body.entries[0].status],[200,undefined,'outdated'],'the first forced lookup uses the budget');
 const before=vendorRequests.length,second=await get(reader,current,true);
 check([second.status,second.body.notice,second.body.entries[0].latest.version,vendorRequests.length],[200,{code:'RATE_LIMITED',messageKey:'apiError.gpuDriver.checkBusy'},'621.01',before],'another device over the vendor budget gets the cached result with checkBusy');
 const soon=await get(reader,outdated,true);
 check([soon.status,soon.body.notice],[200,{code:'RATE_LIMITED',messageKey:'apiError.gpuDriver.checkTooSoon'}],'a refresh refused by the per-device limit keeps checkTooSoon');
 check((await get(reader,mixed)).body.notice,undefined,'a read without refresh has no notice');
 activeCatalog=catalog;
}

// ---- Recent installs: a succeeded driver job counts as installed until the device reports it ----
{
 const minute=60_000,day=86_400_000;
 const driverJob=(serverId,{state='succeeded',target='NVIDIA 621.01',code='AGENT_GPU_DRIVER_INSTALLED',args={version:'621.01',sha256:'0'.repeat(64)},finished=clock-5*minute,claimed=null,created=null}={})=>insert('jobs',{
  id:uuid(),server_id:serverId,action:'install-gpu-driver',target,state,created_at:created??(finished??clock)-4*minute,claimed_at:claimed,last_progress:finished,actor:technician.id,
  result_code:code,result_args:args===null?null:typeof args==='string'?args:JSON.stringify(args),
 });
 const entry=async id=>(await get(technician,id)).body.entries[0];
 const pick=value=>({installed:value.installed,reported:value.reported,status:value.status,pendingInventory:value.pendingInventory});
 const waiting=async id=>Number((await d.one(sql`SELECT count(*) AS n FROM jobs WHERE server_id=${id} AND state IN ('pending','running')`)).n);
 const audits=async id=>Number((await d.one(sql`SELECT count(*) AS n FROM audit WHERE server_id=${id}`)).n);

 // GET: the recent install is the effective version until the snapshot reports it.
 const pending=await device('RECENT-PENDING');await driverJob(pending,{finished:clock-5*minute});
 check(pick(await entry(pending)),{installed:'621.01',reported:'581.57',status:'current',pendingInventory:{version:'621.01',finishedAt:clock-5*minute}},'snapshot 581.57, recent install 621.01, latest 621.01: installed, current, pending inventory');
 const reboot=await device('RECENT-REBOOT');await driverJob(reboot,{code:'AGENT_GPU_DRIVER_INSTALLED_REBOOT'});
 check((await entry(reboot)).pendingInventory?.version,'621.01','the reboot result counts as installed too');
 const reportedNow=await device('RECENT-REPORTED',{details:[{id:'g1',vendorDriverVersion:'621.01'}]});await driverJob(reportedNow);
 check(pick(await entry(reportedNow)),{installed:'621.01',reported:'621.01',status:'current',pendingInventory:null},'the snapshot reports the version: as before, nothing pending');
 const stale=await device('RECENT-STALE-NVML',{details:[{id:'g1',vendorDriverVersion:'581.57',driverVersion:'32.0.16.2101'}]});await driverJob(stale);
 check(pick(await entry(stale)),{installed:'621.01',reported:'621.01',status:'current',pendingInventory:null},'a stale NVML version: the newer Windows version is reported, nothing pending');
 const claimedOnly=await device('RECENT-CLAIMED');await driverJob(claimedOnly,{finished:null,claimed:clock-10*minute,created:clock-11*minute});
 check((await entry(claimedOnly)).pendingInventory,{version:'621.01',finishedAt:clock-10*minute},'without last_progress the finish time is claimed_at');
 const createdOnly=await device('RECENT-CREATED');await driverJob(createdOnly,{finished:null,claimed:null,created:clock-12*minute});
 check((await entry(createdOnly)).pendingInventory,{version:'621.01',finishedAt:clock-12*minute},'then created_at');
 const notCounted=[
  ['older than 24 hours',{finished:clock-day-1}],['a failed job',{state:'failed'}],['a cancelled job',{state:'cancelled'}],['an expired job',{state:'expired'}],
  ['another result code',{code:'AGENT_GPU_DRIVER_SIGNATURE'}],['the other vendor',{target:'AMD 26.10.1',args:{version:'26.10.1'}}],
  ['a malformed result_args.version',{args:{version:'621.01; rm'}}],['result_args without a version',{args:{sha256:'0'}}],['result_args that are no JSON',{args:'not json'}],['no result_args',{args:null}],
 ];
 for(const [label,shape] of notCounted){
  const id=await device('RECENT-NOT-'+label);await driverJob(id,shape);
  check(pick(await entry(id)),{installed:'581.57',reported:'581.57',status:'outdated',pendingInventory:null},label+' does not count');
 }
 const newest=await device('RECENT-NEWEST');await driverJob(newest,{target:'NVIDIA 617.42',args:{version:'617.42'},finished:clock-30*minute});await driverJob(newest,{finished:clock-2*minute});
 check((await entry(newest)).pendingInventory?.version,'621.01','the newest recent install counts');
 // The vendor offers a newer version than the recent install.
 const older=await device('RECENT-OLDER');await driverJob(older,{target:'NVIDIA 617.42',args:{version:'617.42'}});
 check(pick(await entry(older)),{installed:'617.42',reported:'581.57',status:'outdated',pendingInventory:{version:'617.42',finishedAt:clock-5*minute}},'a newer latest version than the recent install is outdated');

 // POST: the same version again is refused, without job or audit row.
 const before=[await waiting(pending),await audits(pending)];
 const again=await queue(technician,pending,{vendor:'nvidia',version:'621.01'});
 check([again.status,again.body.code,again.body.messageKey,again.body.params],[409,'GPU_DRIVER_ALREADY_INSTALLED','apiError.gpuDriver.alreadyInstalled',{vendor:'NVIDIA',version:'621.01'}],'the same version while the inventory is pending is refused');
 check(again.body.error,'NVIDIA driver 621.01 is already installed on this device. The device has not reported it yet. Wait a few minutes, then check again.','the refusal says what happened and what to do');
 check([await waiting(pending),await audits(pending)],before,'no job and no audit row');
 // Outside the pending state, the effective version decides with noUpdate.
 const reportedNewer=await device('RECENT-REPORTED-NEWER',{details:[{id:'g1',vendorDriverVersion:'621.01'}]});await driverJob(reportedNewer,{target:'NVIDIA 617.42',args:{version:'617.42'}});
 check((await queue(technician,reportedNewer,{vendor:'nvidia',version:'621.01'})).body.code,'GPU_DRIVER_NO_UPDATE','a reported version newer than the recent install: noUpdate');
 // The newer version is accepted.
 const accepted=await queue(technician,older,{vendor:'nvidia',version:'621.01'});
 check([accepted.status,(await jobRows(older)).filter(row=>row.target==='NVIDIA 621.01').length],[200,1],'the update to the newer version is accepted');
 // Any waiting or running driver job of the device refuses, whatever the vendor, before the vendor lookup.
 for(const [state,target] of [['pending','NVIDIA 621.01'],['running','NVIDIA 621.01'],['pending','AMD 26.10.1'],['running','AMD 26.10.1']]){
  const id=await device('ACTIVE-'+state+'-'+target);await driverJob(id,{state,target,code:null,args:null,finished:null,created:clock-minute});
  const lookups=vendorRequests.length,answer=await queue(technician,id,{vendor:'nvidia',version:'621.01'});
  check([answer.status,answer.body.code,answer.body.messageKey],[409,'GPU_DRIVER_JOB_ACTIVE','apiError.gpuDriver.jobActive'],'a '+state+' '+target+' job refuses a new driver job');
  check(answer.body.error,'A driver update already waits or runs on this device. Wait until it ends, then try again.','the jobActive text');
  check((await queue(technician,id,{vendor:'amd',version:'26.10.1'})).body.code,'GPU_DRIVER_JOB_ACTIVE','the active check runs before the vendor lookup (no AMD GPU on the device)');
  check([vendorRequests.length,await waiting(id)],[lookups,1],'no vendor request and no second job');
 }
 // Two parallel requests write at most one driver job.
 for(let round=0;round<3;round++){
  const id=await device('PARALLEL-'+round);
  const answers=await Promise.all([0,1].map(()=>queue(technician,id,{vendor:'nvidia',version:'621.01'})));
  check([answers.map(answer=>answer.status).sort(),answers.find(answer=>answer.status!==200)?.body.code,(await jobRows(id)).length],[[200,409],'GPU_DRIVER_JOB_ACTIVE',1],'two parallel requests: one job, the other answers jobActive');
 }
 // Through queueOperationJob (the assistant path): a driver job committed between the
 // check and the write makes the guarded INSERT write nothing, and the refusal names the active job.
 const realDevice=load('lib/server/devices/gpu-drivers/device.ts'),{operations}=load('lib/management.ts');
 let raced=null;
 const raceQueue=sourceLoader()('lib/server/devices/device-job-queue.ts',{...imports,'./gpu-drivers/device':{...realDevice,resolveGpuDriverJob:async(...args)=>{const params=await realDevice.resolveGpuDriverJob(...args);if(raced)await raced();return params;}}});
 const direct=id=>raceQueue.queueOperationJob(new Request('https://gpu.test/api/console',{method:'POST'}),technician,{serverId:id,kind:'install-gpu-driver',definition:operations['install-gpu-driver'],params:{vendor:'nvidia',version:'621.01'},confirm:true}).then(()=>null,error=>error.messageKey??String(error));
 check(await direct(pending),'apiError.gpuDriver.alreadyInstalled','queueOperationJob refuses the same version');
 const race=await device('RACE');raced=()=>driverJob(race,{state:'running',target:'AMD 26.10.1',code:null,args:null,finished:null,created:clock});
 check([await direct(race),await waiting(race),await audits(race)],['apiError.gpuDriver.jobActive',1,0],'a driver job that won the race: the guarded INSERT writes nothing and answers jobActive');
 // A device removed while the request ran: the authorization fails, no driver job is active, so the refusal stays queueChanged.
 const removed=await device('RACE-REMOVED');
 raced=()=>d.exec(sql`UPDATE servers SET revoked=1 WHERE id=${removed}`);
 check([await direct(removed),await waiting(removed)],['apiError.console.queueChanged',0],'a lost write without an active driver job answers queueChanged');
 const free=await device('RACE-NONE');raced=null;
 check([await direct(free),await waiting(free)],[null,1],'without a race queueOperationJob writes the job');
}

await d.close();
console.log(`PASS: ${checks} GPU driver route checks (view, boundary, no URL, refresh and forced-lookup limits, lookup-resolved job parameters and refusals).`);
