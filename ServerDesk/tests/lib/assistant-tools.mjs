// The read tools of the device assistant (lib/server/devices/assistant-tools.ts) on
// PostgreSQL: each tool reads only the asked device for the asking viewer,
// with the console projection (lib/server/devices/device-projection.ts, which the console
// route now imports instead of its own copy): reduced processes without
// diagnose, no Defender detections or exclusions without defender.read,
// device_audit only with security.events, no publicKey, the 24 KiB cap with
// truncated/total/shown, the filter and level inputs, error results for an
// unknown tool or a bad input, the rights read again per question, and no tool
// queues a job or writes a row. Also device_gpu_drivers (never a forced
// lookup, no URL or GPU IDs, missingRight without view) and device_features. device_jobs omits a job whose
// output has the management scope for a viewer without manage.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFileSync} from 'node:fs';
import {sql} from '../../runtime/database.mjs';
import {insertRow} from '../support/source-database.mjs';
import {assistantFixture,baseSnapshot} from '../support/assistant-fixture.mjs';

const f=await assistantFixture();
const {d,load,imports,actor}=f;
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
try{
 const tools=load('lib/server/devices/assistant-tools.ts',imports),projection=load('lib/server/devices/device-projection.ts',imports),config=load('lib/assistant-config.ts',imports);
 const now=Date.now();
 const deviceId=await f.device({name:'SRV-01'}),otherId=await f.device({name:'SRV-02',snapshot:baseSnapshot({hostname:'SRV-02',services:[{name:'OtherOnly',displayName:'Other only',status:'Running',startMode:'Auto'}]})});
 const owner=await actor('owner@tools.test',['*']);
 const monitor=await actor('monitor@tools.test',['view'],'device',deviceId);
 const full=await actor('full@tools.test',['view','diagnose','defender.read','security.events','runbooks.read'],'device',deviceId);
 const run=async(as,name,input={},serverId=deviceId)=>{const context=await tools.assistantToolContext(as,serverId,now);const outcome=await tools.runAssistantTool(context,name,input);return {...outcome,json:JSON.parse(outcome.content)};};

 // ---- The tool list ----
 check(tools.assistantToolSpecs.map(spec=>spec.name),[...config.assistantToolNames],'every read tool, in the order of the config');
 ok(tools.assistantToolSpecs.every(spec=>spec.description&&spec.inputSchema.type==='object'&&spec.inputSchema.additionalProperties===false),'each tool has a description and a closed object schema');
 check(config.assistantToolNames.length,18,'18 read tools');
 ok(config.assistantToolNames.every(name=>config.assistantSourceAreas[name]?.section),'each read tool has a source area');
 check([config.assistantSourceAreas.device_gpu_drivers,config.assistantSourceAreas.device_features,config.assistantSourceAreas.device_hardware],[{section:'hardware',detail:'gpu'},{section:'management',detail:'features'},{section:'hardware'}],'the graphics card and the roles and features areas; Hardware stays without a subarea');

 // ---- One device, the console projection ----
 const overview=await run(monitor,'device_overview');
 check([overview.isError,overview.json.name,overview.json.os,overview.json.rebootPending,overview.json.connection,overview.json.cpuPercent],[false,'SRV-01','Microsoft Windows Server 2022 Standard',true,'online',12],'the overview of the asked device');
 const services=await run(monitor,'device_services');
 check(services.json.services.map(service=>service.name),['Spooler','W32Time'],'only the services of the asked device');
 const raw=(await d.one(sql`SELECT snapshot FROM servers WHERE id=${deviceId}`)).snapshot;
 const reduced=projection.snapshotForPermissions(raw,['view']);
 const processes=await run(monitor,'device_processes');
 check([processes.json.details,processes.json.processes,processes.json.inventory],['reduced',[...reduced.processes].sort((a,b)=>b.memoryMb-a.memoryMb),null],'without diagnose: the reduced console processes, no inventory');
 ok(!processes.content.includes('MSSQLSERVER')&&!processes.content.includes('explorer.exe'),'no process user or path without diagnose');
 const fullProcesses=await run(full,'device_processes');
 check([fullProcesses.json.details,fullProcesses.json.processes[0].user,fullProcesses.json.inventory.count],['full','NT SERVICE\\MSSQLSERVER',2],'with diagnose: users and paths as the console shows them');
 const security=await run(monitor,'device_security');
 check([security.json.defenderDetails,'detections' in security.json.defender,'exclusions' in security.json.defender,security.json.defender.detectionCount],['summary',false,false,1],'without defender.read: the Defender summary only');
 const fullSecurity=await run(full,'device_security');
 check([fullSecurity.json.defenderDetails,fullSecurity.json.defender.detections[0].path,fullSecurity.json.defender.exclusions.paths],['full','C:\\Users\\anna\\evil.exe',['C:\\Secret']],'with defender.read: detections and exclusions');
 const scanId=await f.device({name:'SRV-SCAN',snapshot:baseSnapshot({defenderScan:{kind:'quick',startedAt:'2026-11-05T08:00:00Z'}})});
 check((await run(owner,'device_security',{},scanId)).json.defenderScan,{kind:'quick',startedAt:'2026-11-05T08:00:00Z'},'a running portal scan reaches the Defender tool through the shared projection');
 await insertRow(d,'audit',{at:now,actor:'someone@tools.test',action:'service.started',target:'Spooler',server_id:deviceId,scope:'device'});
 check((await run(monitor,'device_audit')).json,{unavailable:'missingRight'},'device_audit without security.events');
 const audit=await run(full,'device_audit');
 check(audit.json.rows.map(row=>[row.action,row.target]),[['service.started','Spooler']],'device_audit with security.events');

 // ---- No publicKey anywhere ----
 for(const name of config.assistantToolNames){
  const result=await run(owner,name);
  ok(!result.content.includes('PUBLIC-KEY-N-VALUE')&&!result.content.includes('publicKey'),`${name} has no publicKey`);
  ok(Buffer.byteLength(result.content)<=24*1024,`${name} stays within 24 KiB`);
 }

 // ---- Inputs ----
 check((await run(monitor,'device_services',{filter:'spool'})).json.services.map(service=>service.name),['Spooler'],'filter on the service name');
 check((await run(monitor,'device_events',{level:'error'})).json.events.map(event=>event.id),[7031],'the level filter');
 check((await run(monitor,'device_events',{level:'warning'})).json.events.map(event=>event.id),[1014],'warnings only');
 const unknown=await run(monitor,'device_shell',{command:'whoami'});
 check([unknown.isError,unknown.json.error],[true,'unknownTool'],'an unknown tool is an error result');
 for(const [name,input] of [['device_services',{filter:7}],['device_services',{other:'x'}],['device_events',{level:'fatal'}],['device_overview',{filter:'x'}],['device_services','text'],['device_services',['x']],['device_services',{filter:'x'.repeat(101)}]]){
  const result=await run(monitor,name,input);
  check([result.isError,result.json.error],[true,'invalidInput'],`${name} ${JSON.stringify(input)} is an error result`);
 }

 // ---- The graphics driver status (device_gpu_drivers) ----
 // The vendor lookup, faked: the tool never forces a lookup and never claims a refresh.
 const gpuCatalog=load('lib/server/devices/gpu-drivers/catalog.ts',imports).gpuDriverCatalog,lookups=[],claims=[];
 gpuCatalog.lookup=async(query,options={})=>{lookups.push({vendor:query.vendor,force:options.force===true});return query.vendor==='nvidia'
  ?{result:{ok:true,version:'621.01',releasedAt:'2026-10-01',downloadUrl:'https://us.download.nvidia.com/Windows/621.01/driver.exe',sizeBytes:1037190000},checkedAt:now}
  :{result:{ok:false,reason:'unsupported-model'},checkedAt:now};};
 gpuCatalog.claimRefresh=deviceId=>{claims.push(deviceId);return true;};
 const gpuId=await f.device({name:'SRV-GPU',snapshot:baseSnapshot({os:'Microsoft Windows 11 Pro',gpus:[{id:'g1',name:'NVIDIA GeForce RTX 4070',vendor:'nvidia'},{id:'g2',name:'AMD Radeon PRO W7600',vendor:'amd'}],gpuDetails:[{id:'g1',vendorDriverVersion:'581.57'},{id:'g2',vendorDriverVersion:'24.10.1'}]})});
 const gpuViewer=await actor('gpu@tools.test',['view'],'device',gpuId);
 const gpu=await run(gpuViewer,'device_gpu_drivers',{},gpuId);
 check([gpu.isError,gpu.json],[false,{entries:[
  {vendor:'nvidia',gpuNames:['NVIDIA GeForce RTX 4070'],installed:'581.57',pendingInventory:null,latest:{version:'621.01',releasedAt:'2026-10-01'},status:'outdated',reason:null,checkedAt:new Date(now).toISOString()},
  {vendor:'amd',gpuNames:['AMD Radeon PRO W7600'],installed:'24.10.1',pendingInventory:null,latest:null,status:'unsupported',reason:'unsupported-model',checkedAt:new Date(now).toISOString()},
 ]}],'one entry per vendor with the status and the reason');
 ok(!gpu.content.includes('download')&&!gpu.content.includes('url')&&!gpu.content.includes('gpuIds')&&!gpu.content.includes('"g1"'),'no download URL and no GPU IDs');
 check([lookups.every(lookup=>!lookup.force),claims],[true,[]],'never a forced lookup and never a refresh claim');
 check((await run(gpuViewer,'device_gpu_drivers',{},gpuId)).isError,false,'a second call reads the same way');
 // A finished install that the inventory has not reported yet: installed is that version, and pendingInventory says so.
 await insertRow(d,'jobs',{id:crypto.randomUUID(),server_id:gpuId,action:'install-gpu-driver',target:'NVIDIA 621.01',state:'succeeded',created_at:now-10*60_000,last_progress:now-5*60_000,actor:'x',parameters:'{}',result_code:'AGENT_GPU_DRIVER_INSTALLED',result_args:JSON.stringify({version:'621.01',sha256:'0'.repeat(64)})});
 const pendingNvidia=(await run(gpuViewer,'device_gpu_drivers',{},gpuId)).json.entries[0];
 check([pendingNvidia.installed,pendingNvidia.status,pendingNvidia.pendingInventory],['621.01','current',{version:'621.01',finishedAt:new Date(now-5*60_000).toISOString()}],'a finished install that waits for the inventory');
 check((await run(monitor,'device_gpu_drivers')).json,{entries:[]},'a device without NVIDIA or AMD GPUs: no entries');
 check((await run(gpuViewer,'device_gpu_drivers',{},deviceId)).json,{unavailable:'missingRight'},'without view on the device: missingRight');
 check((await run(gpuViewer,'device_gpu_drivers',{filter:'x'},gpuId)).json.error,'invalidInput','device_gpu_drivers takes no input');

 // ---- Roles and features (device_features) ----
 const features=[{name:'Web-Server',displayName:'Web Server (IIS)',installed:true,featureType:'Role',parent:null,subFeatures:['Web-WebServer'],depth:0},{name:'Telnet-Client',displayName:'Telnet Client',installed:false,featureType:'Feature',depth:0},{name:'Web-WebServer',displayName:'Web Server',installed:true,featureType:'Role Service',parent:'Web-Server',depth:1}];
 const featureId=await f.device({name:'SRV-FEATURES',snapshot:baseSnapshot({features})}),emptyId=await f.device({name:'SRV-EMPTY',snapshot:null});
 check((await run(owner,'device_features',{},featureId)).json,{total:3,matching:3,features:[
  {name:'Web-Server',displayName:'Web Server (IIS)',installed:true,featureType:'Role',parent:null},
  {name:'Telnet-Client',displayName:'Telnet Client',installed:false,featureType:'Feature',parent:null},
  {name:'Web-WebServer',displayName:'Web Server',installed:true,featureType:'Role Service',parent:'Web-Server'},
 ]},'every role and feature with its state');
 check((await run(owner,'device_features',{filter:'telnet'},featureId)).json.features.map(feature=>feature.name),['Telnet-Client'],'the filter on the name or display name');
 check((await run(owner,'device_features',{filter:'(IIS)'},featureId)).json.features.map(feature=>feature.name),['Web-Server'],'the filter on the display name');
 check((await run(owner,'device_features',{},emptyId)).json.unavailable,'noInventory','no snapshot: noInventory');
 check((await run(monitor,'device_features')).json,{features:null},'a snapshot without features: null');
 check((await run(owner,'device_features',{level:'error'},featureId)).json.error,'invalidInput','only filter as input');

 // ---- The 24 KiB cap ----
 const many=Array.from({length:3000},(_,index)=>({name:`Service${index}`,displayName:`Service number ${index} with a long display name`,status:index%2?'Running':'Stopped',startMode:'Auto'}));
 const bigId=await f.device({name:'SRV-BIG',snapshot:baseSnapshot({services:many})});
 const owned=await actor('big@tools.test',['view'],'device',bigId);
 const big=await run(owned,'device_services',{},bigId);
 check([big.isError,big.json.truncated,big.json.total,big.json.shown===big.json.services.length,big.json.shown<3000,big.json.shown>50],[false,true,3000,true,true,true],'a long list is cut and says so');
 ok(Buffer.byteLength(big.content)<=24*1024,'the cut result fits 24 KiB');
 check(big.json.services[0].name,'Service0','the list keeps its start');
 const capped=JSON.parse(tools.cappedResult({long:'x'.repeat(5000)}));
 check(capped.long.length,2001,'long strings are shortened');

 // ---- Metrics and jobs ----
 for(let index=0;index<450;index++)await insertRow(d,'samples',{server_id:deviceId,at:now-index*60_000,cpu:index%100,memory:50});
 const metrics=await run(monitor,'device_metrics');
 check([metrics.json.count,metrics.json.points.length<=200,metrics.json.cpu.min,metrics.json.cpu.max,metrics.json.memory.avg],[450,true,0,99,50],'at most 200 points with min, avg and max');
 const jobId=crypto.randomUUID(),otherJob=crypto.randomUUID();
 await insertRow(d,'jobs',{id:jobId,server_id:deviceId,action:'refresh',target:'',state:'completed',created_at:now,actor:'x',parameters:'{}'});
 await insertRow(d,'jobs',{id:otherJob,server_id:otherId,action:'refresh',target:'',state:'completed',created_at:now,actor:'x',parameters:'{}'});
 const jobs=await run(owner,'device_jobs');
 check(jobs.json.jobs.map(job=>job.id),[jobId],'only the jobs of the asked device');
 const monitorJobs=await run(monitor,'device_jobs');
 check(monitorJobs.json.jobs.map(job=>job.id),projection.mergedJobs(projection.scopeJobs([{id:jobId,serverId:deviceId,action:'refresh',target:'',createdAt:now}],false,new Map([[deviceId,['view']]])),[]).map(job=>job.id),'the jobs as scopeJobs gives them to this viewer');

 // ---- Rights are read again for each question ----
 const before=await tools.assistantToolContext(full,deviceId,now);
 check((await tools.runAssistantTool(before,'device_audit',{})).isError,false,'with the right');
 await d.exec(sql`UPDATE rbac_roles SET permissions=${JSON.stringify(['view'])} WHERE id IN (SELECT role_id FROM role_assignments WHERE principal_id=${full.id})`);
 check((await run(full,'device_audit')).json,{unavailable:'missingRight'},'the next question no longer has the right');
 check((await run(full,'device_processes')).json.details,'reduced','nor the process details');

 // ---- Read only ----
 const counts=async()=>Object.values(await d.one(sql`SELECT (SELECT count(*) FROM jobs) AS jobs,(SELECT count(*) FROM audit) AS audit,(SELECT count(*) FROM samples) AS samples,(SELECT count(*) FROM agent_channels) AS channels`)).map(Number);
 const start=await counts();
 for(const name of config.assistantToolNames)await run(owner,name);
 check(await counts(),start,'no tool queues a job or writes a row');

 // ---- A PowerShell job of the assistant shows only with terminal ----
 const scriptJob=crypto.randomUUID(),refreshJob=crypto.randomUUID();
 await insertRow(d,'jobs',{id:scriptJob,server_id:deviceId,action:'assistant-powershell',target:'Get-Date / 0123456789ab',state:'succeeded',created_at:now,actor:owner.id,parameters:'{}',result:'Script completed.'});
 await insertRow(d,'jobs',{id:refreshJob,server_id:deviceId,action:'refresh',target:'',state:'succeeded',created_at:now,actor:owner.id,parameters:'{}'});
 const diagnoser=await actor('diagnoser@tools.test',['view','diagnose'],'device',deviceId),terminal=await actor('terminal@tools.test',['view','diagnose','terminal'],'device',deviceId);
 const jobIds=async as=>(await run(as,'device_jobs')).json.jobs.map(job=>job.id);
 const withoutTerminal=await jobIds(diagnoser);
 check([withoutTerminal.includes(refreshJob),withoutTerminal.includes(scriptJob)],[true,false],'device_jobs hides an assistant-powershell job from a viewer without terminal');
 check((await jobIds(terminal)).includes(scriptJob),true,'a viewer with terminal sees it');
 // The output's management scope (agent-channel.ts) asks for manage, like the console list and the job drawer.
 const managedJob=crypto.randomUUID(),manager=await actor('manager@tools.test',['view','diagnose','manage'],'device',deviceId);
 await insertRow(d,'jobs',{id:managedJob,server_id:deviceId,action:'refresh',target:'',state:'succeeded',created_at:now,actor:owner.id,parameters:'{}'});
 await insertRow(d,'job_outputs',{job_id:managedJob,server_id:deviceId,data:JSON.stringify({ok:true,scope:{security:false,management:true}}),created_at:now});
 const withoutManage=await jobIds(diagnoser);
 check([withoutManage.includes(refreshJob),withoutManage.includes(managedJob)],[true,false],'device_jobs omits a management-scoped job for a viewer without manage');
 check((await jobIds(manager)).includes(managedJob),true,'a viewer with manage sees it');

 // ---- The console route uses the same projection ----
 const route=readFileSync('app/api/console/route.ts','utf8');
 ok(route.includes("from '@/lib/server/devices/device-projection'")&&!/function (snapshotForPermissions|scopeJobs|scopeRunbookJobs)\(/.test(route),'the console route imports the projection and has no copy of its own');
}finally{await f.close();}
process.stdout.write(`PASS assistant tools (${checks} assertions): one device, console projection per right, no publicKey, 24 KiB cap, inputs, error results, rights per question, read only.\n`);
