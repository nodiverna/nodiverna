// The move from zod 3 to zod 4 keeps what the schemas accept and refuse, without
// a database: GUID fields still take any 8-4-4-4-12 hex ID (zod 4's uuid() needs
// RFC version bits), the former single-argument records (desired-state and runbook
// parameters) keep their key and value rules and defaults, the management IP fields
// use zod 4 IP schemas, defaults on object fields give the zod 3 output, signed
// release and plugin manifests parse as before, a ZodError thrown below the
// automation route still answers apiError.automation.checkInput and through
// failure() VALIDATION_FAILED, and invalid telemetry still names its field paths.
import '../support/register.mjs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {HttpError} from '../support/http-error.mjs';
import {sourceLoader} from '../support/source-database.mjs';

const {z}=await import('zod');
const {agentChannelBody}=await import('../../lib/server/agent/agent-channel.ts');
const {operations}=await import('../../lib/management.ts');
const {desiredParameters,desiredJobSchema}=await import('../../lib/desired-state-operations.ts');
const {runbookDefinition}=await import('../../lib/server/automation/runbooks.ts');
const {driftPolicySchema,driftReportSchema}=await import('../../lib/server/automation/drift.ts');
const {cveRecord}=await import('../../lib/software-vulnerabilities.ts');
const {manifestSchema,pluginManifestSchema,pluginExePath}=await import('../../runtime/release-schema.mjs');
const {classifyFailure}=await import('../../lib/server/errors/failure.ts');
const {issueFields}=await import('../../lib/server/errors/issues.ts');
const {telemetry}=await import('../../lib/server/agent/telemetry.ts');

let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(schema,value)=>schema.safeParse(value).success;

// ---- GUIDs: any 8-4-4-4-12 hex string, as zod 3's uuid() and guid() in lib/server/context.ts ----
const nonRfc='12345678-1234-1234-1234-123456789abc',upper='ABCDEF01-2345-6789-ABCD-EF0123456789',rfc='3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const badGuids=['12345678-1234-1234-1234-123456789abg','1234567-81234-1234-1234-123456789abc','12345678-1234-1234-1234-123456789ab','{12345678-1234-1234-1234-123456789abc}','123456781234123412341234567890ab',''];
const channel=(serverId,extra={})=>({serverId,...extra});
for(const id of [nonRfc,upper,rfc])check(ok(agentChannelBody,channel(id,{runningJobs:[id],results:[{id,ok:true,message:''}]})),true,`the agent channel takes ${id}`);
for(const id of badGuids){
 check(ok(agentChannelBody,channel(id)),false,`the agent channel refuses the server ID ${JSON.stringify(id)}`);
 check(ok(agentChannelBody,channel(nonRfc,{runningJobs:[id]})),false,`the agent channel refuses the running job ${JSON.stringify(id)}`);
}
const cancelPower=operations['cancel-power-schedule'].schema,updates=operations['install-updates'].schema;
check([ok(cancelPower,{scheduleId:nonRfc}),ok(cancelPower,{scheduleId:upper}),ok(updates,{updateIds:[nonRfc,rfc]})],[true,true,true],'device jobs take non-RFC GUIDs');
check(badGuids.map(id=>ok(cancelPower,{scheduleId:id})||ok(updates,{updateIds:[id]})),badGuids.map(()=>false),'device jobs refuse non-hex or wrongly grouped IDs');
check(ok(driftReportSchema,{policyId:nonRfc,version:1,scanId:upper,at:1,complete:true,entries:[]}),true,'a drift report takes non-RFC GUIDs');

// ---- Records with a string key: the desired-state parameters ----
const thirty=Object.fromEntries(Array.from({length:30},(_,index)=>[`key_${index}`,index%3===0?'text':index%3===1?index+0.5:true]));
check(desiredParameters.parse(thirty),thirty,'30 valid keys with string, number and boolean values parse unchanged');
check(ok(desiredParameters,{...thirty,key_30:1}),false,'31 keys are refused');
for(const [label,value] of [['__proto__ key',JSON.parse('{"__proto__":"x"}')],['__proto__ key with an object',JSON.parse('{"__proto__":{"a":1}}')],['constructor key',{constructor:'x'}],['OutputPath key',{OutputPath:'C:\\'}],['digit-first key',{'1abc':1}],['object value',{a:{}}],['array value',{a:[1]}],['null value',{a:null}],['array',[]],['string','a']])
 check(ok(desiredParameters,value),false,`desired parameters refuse a ${label}`);
check(ok(desiredParameters,{a:'x'.repeat(4096)})&&!ok(desiredParameters,{a:'x'.repeat(4097)}),true,'a string value holds up to 4096 characters');
const job={assignmentId:nonRfc,versionId:rfc,engine:'dsc3',contentSha256:'a'.repeat(64),timeoutSeconds:60,configuration:{key:'AA==',iv:'AA==',data:'AA==',mac:'AA=='}};
check(desiredJobSchema.parse(job).parameters,{},'a desired-state job without parameters gets {}');
check(desiredJobSchema.parse({...job,parameters:{Name:'x'}}).parameters,{Name:'x'},'given parameters stay');

// ---- Records with a string key: the runbook step parameters ----
const step={id:'first',name:'First',kind:'powershell',script:'Write-Output 1'};
const parsedBook=runbookDefinition.parse({steps:[step]});
check([parsedBook.steps[0].operationParameters,parsedBook.steps[0].timeoutSeconds,parsedBook.parameters],[{},300,[]],'a runbook step without operationParameters gets {}, the default timeout and no parameters');
check(runbookDefinition.parse({steps:[{id:'probe',name:'Probe',kind:'diagnosis',operation:'test-connection',operationParameters:{host:'server.example',port:443}}]}).steps[0].operationParameters,{host:'server.example',port:443},'diagnosis operation parameters stay');
check(ok(runbookDefinition,{steps:[{...step,operationParameters:'x'}]}),false,'operation parameters must be an object');

// ---- Management IP fields: zod 4 IP schemas ----
const network=operations['set-network'].schema,dns=operations['set-dns'].schema,firewall=operations['add-firewall-rule'].schema;
const ipv4=address=>ok(network,{interfaceIndex:1,dhcp:false,address,prefixLength:24});
check([ipv4('10.0.0.1'),ipv4('::1'),ipv4('999.1.1.1'),ipv4('01.2.3.4'),ipv4('10.0.0')],[true,false,false,false,false],'set-network takes IPv4 only');
const ip=address=>ok(dns,{interfaceIndex:1,automatic:false,servers:[address]});
check([ip('10.0.0.1'),ip('fe80::1'),ip('2001:db8::1'),ip('::ffff:10.0.0.1'),ip('999.1.1.1'),ip('1::2::3'),ip('host.example')],[true,true,true,true,false,false,false],'set-dns takes IPv4 and IPv6');
const rule=remoteAddress=>ok(firewall,{name:'Fixture',direction:'Inbound',action:'Allow',protocol:'TCP',port:'443',remoteAddress});
check(['Any','LocalSubnet','10.0.0.0/8, fe80::/64','10.0.0.1','2001:db8::/128'].map(rule),[true,true,true,true,true],'firewall remote addresses: keywords, IPv4 and IPv6 with prefixes');
check(['10.0.0.0/33','fe80::/129','host.example','10.0.0.1/8/1','10.0.0.0/x',''].map(rule),[false,false,false,false,false,false],'firewall remote addresses refuse bad prefixes and names');

// ---- Defaults give the zod 3 output ----
check(cveRecord.parse({cveMetadata:{cveId:'CVE-2026-0001',state:'PUBLISHED'},containers:{}}).containers,{cna:{affected:[],descriptions:[],metrics:[]},adp:[]},'a CVE record without a CNA container');
check(cveRecord.parse({cveMetadata:{cveId:'CVE-2026-0001',state:'PUBLISHED'},containers:{cna:{}}}).containers.cna,{affected:[],descriptions:[],metrics:[]},'an empty CNA container fills its lists');
const driftDefaults={enabled:false,paths:[],excludes:['*.log','*.tmp','*.cache'],registry:[],config:[],includeConfigValues:false,intervalSeconds:300,maxFiles:1000,maxFileBytes:10485760,maxTextBytes:8192,maxDurationSeconds:30,retentionDays:30};
check(driftPolicySchema.parse({}),driftDefaults,'a drift policy {} parses to the defaults');
check(driftPolicySchema.parse({paths:[{path:'C:\\Data'}],registry:[{path:'HKLM\\Software\\Fixture'}]}),{...driftDefaults,paths:[{path:'C:\\Data',recursive:true,includeText:false,extensions:[]}],registry:[{path:'HKLM\\Software\\Fixture',names:[],includeValues:false}]},'nested drift sources fill their defaults');
check(ok(driftPolicySchema,{enabled:true}),false,'an enabled drift policy still needs a source');
const body=agentChannelBody.parse({serverId:nonRfc});
check(body,{serverId:nonRfc,runningJobs:[],results:[],transfers:[]},'an agent channel body without results, runningJobs or transfers gives [] for each and no optional keys');

// ---- Release and plugin manifests (runtime/release-schema.mjs) ----
const sha='b'.repeat(64);
const release={version:'4.20.0',protocolVersion:3,minProtocolVersion:3,os:['windows-server-2025'],arch:'x64',path:'/downloads/agent/4.20.0/agent.zip',sha256:sha,size:1024,
 exe:{path:'/downloads/agent/4.20.0/agent.exe',sha256:sha,size:2048,parts:[{path:'/downloads/agent/4.20.0/agent.exe.part1',sha256:sha,size:2048}]},changelog:{features:['New'],fixes:[]},createdAt:'2026-11-01T10:00:00.000Z'};
check(manifestSchema.parse(release),release,'a release manifest parses unchanged');
check(ok(manifestSchema,{...release,path:undefined,url:'https://downloads.example/agent.zip'}),true,'the older URL form still parses (the catalog refuses it itself)');
check([ok(manifestSchema,{...release,extra:1}),ok(manifestSchema,{...release,createdAt:'2026-11-01'}),ok(manifestSchema,{...release,createdAt:'2026-11-01T10:00:00+02:00'}),ok(manifestSchema,{...release,url:'not a url'}),ok(manifestSchema,{...release,changelog:{features:[],fixes:[]}})],[false,false,false,false,false],'a release manifest with an unknown key, a bad createdAt, a bad URL or an empty changelog is refused');
const exePath=pluginExePath('dhcp','1.2.0');
const plugin={kind:'plugin',name:'dhcp',role:'dhcp',version:'1.2.0',minAgentVersion:'4.10.0',protocolVersion:1,os:['windows-server-2025'],arch:'x64',capabilities:['dhcp-read','dhcp-manage'],
 exe:{path:exePath,sha256:sha,size:300,parts:[{path:`${exePath}.part1`,sha256:sha,size:100},{path:`${exePath}.part2`,sha256:sha,size:200}]},changelog:{features:[],fixes:['Fix']},createdAt:'2026-11-01T10:00:00Z'};
check(pluginManifestSchema.parse(plugin),plugin,'a plugin manifest parses unchanged');
check(ok(pluginManifestSchema,{...plugin,target:'dhcp'}),true,'a plugin manifest with a matching target parses');
check([ok(pluginManifestSchema,{...plugin,extra:true}),ok(pluginManifestSchema,{...plugin,createdAt:'yesterday'}),ok(pluginManifestSchema,{...plugin,capabilities:['dhcp-read','dhcp-read']}),ok(pluginManifestSchema,{...plugin,target:'dns'}),ok(pluginManifestSchema,{...plugin,exe:{...plugin.exe,size:301}})],[false,false,false,false,false],'a plugin manifest with an unknown key, a bad createdAt, a duplicate capability, another target or wrong part sizes is refused');

// ---- A ZodError stays a validation error ----
let zodError;try{z.object({id:z.guid()}).parse({id:'nope'});}catch(error){zodError=error;}
check([zodError instanceof z.ZodError,zodError.name,Array.isArray(zodError.issues),zodError.issues[0].path],[true,'ZodError',true,['id']],'zod 4 throws a ZodError named ZodError with an issues list and the field path');
const answer=classifyFailure(zodError);
check([answer.status,answer.body.code,answer.body.messageKey],[400,'VALIDATION_FAILED','apiError.validationFailed'],'failure() answers a ZodError with 400 VALIDATION_FAILED');
// The route as the bundle loads it: CommonJS zod, as in tests that stub its imports.
const cjsZod=createRequire(import.meta.url)('zod');
const thrown=()=>{cjsZod.z.object({versionId:cjsZod.z.guid()}).parse({versionId:'nope'});};
try{thrown();}catch(error){check(classifyFailure(error).body.code,'VALIDATION_FAILED','a ZodError of the CommonJS zod is a validation error too');}
const context={body:request=>request.json(),HttpError,requireViewer:async()=>({label:'fixture'}),sameOrigin:()=>{},
 failure:error=>Response.json({messageKey:error instanceof HttpError?error.messageKey:'apiError.internalError'},{status:error instanceof HttpError?error.status:500})};
const route=sourceLoader()('app/api/automation/route.ts',{'@/lib/server/context':context,'@/lib/server/identity/mfa':{requireMfa:async()=>{}},
 '@/lib/server/automation/automation-scopes':{createAutomationTemplate:async()=>thrown(),assignAutomationScope:async()=>thrown(),removeAutomationScope:async()=>({}),listAutomationScopes:async()=>[]},
 '@/lib/server/automation/automation-runbooks':{startAutomationRun:async()=>thrown()}});
for(const action of ['create-template','assign','run']){
 const response=await route.POST(new Request('https://automation.test/api/automation',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action})}));
 check([response.status,(await response.json()).messageKey],[400,'apiError.automation.checkInput'],`the automation route answers a ZodError of ${action} with checkInput`);
}

// The heartbeat answer (apiError.heartbeat.invalidTelemetry) lists the field paths of the issues.
const telemetryIssues=telemetry.safeParse({hostname:5,os:'Windows',disks:[{name:3}]}).error.issues;
check(issueFields(telemetryIssues,3),'hostname, build, manufacturer','invalid telemetry names its fields in schema order');
check(issueFields(telemetry.safeParse([]).error.issues,10),'(root)','a non-object names the root');

console.log(`PASS zod 4 schemas (${checks} checks): GUID fields take any hex GUID, string-key records keep their rules and defaults, IP fields use zod 4 IP schemas, defaults match zod 3, release and plugin manifests parse as before, ZodErrors stay validation errors, telemetry issues keep their paths.`);
