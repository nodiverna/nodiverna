// Parallel jobs in the agent (236): agent/v3/JobConcurrency.cs mirrors
// lib/server/devices/jobs/concurrency.ts (kinds, modes, groups, plugin operations, the cap),
// the worker advertises parallel-jobs, the JobRunner keeps a set of running
// jobs instead of one active task, and the agent version is bumped together
// with its changelog. Runbook steps (287): every runbook case of
// JobConcurrencyTests.cs gets the same class from the portal, and the agent's
// host pattern is the portal's dnsName pattern.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {sourceLoader} from '../support/source-database.mjs';

let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const load=sourceLoader();
const {jobConcurrency,jobConcurrencyKinds,MAX_RUNNING_JOBS,parallelPluginOperations,exclusivePluginOperations}=load('lib/server/devices/jobs/concurrency.ts');
const {pluginOperations}=load('lib/plugin-catalog.ts');
const read=file=>fs.readFileSync(file,'utf8');
// The channel module needs the server bindings; its constant is read from the source.
const PARALLEL_JOBS_CAPABILITY=/export const PARALLEL_JOBS_CAPABILITY='([^']+)';/.exec(read('lib/server/agent/agent-channel.ts'))?.[1];

// ---- JobConcurrency.cs mirrors the portal table ---------------------------------------------------------
const csharp=read('agent/v3/JobConcurrency.cs');
const dictionary=name=>{
 const start=csharp.indexOf(`IReadOnlyDictionary<string, JobClass> ${name} =`);assert.ok(start>=0,name+' exists');
 const body=csharp.slice(start,csharp.indexOf('};',start));
 const entries={};
 for(const [,kind,mode,group] of body.matchAll(/\["([^"]+)"\]\s*=\s*new\(JobMode\.(Parallel|Exclusive|Sole),\s*(null|"[^"]*")\)/g)){
  assert.ok(!Object.hasOwn(entries,kind),kind+' once in '+name);
  entries[kind]={mode:mode.toLowerCase(),group:group==='null'?null:group.slice(1,-1)};
 }
 return entries;
};
const kinds=dictionary('Kinds'),plugins=dictionary('PluginOperations');
check(Object.keys(kinds).sort(),Object.keys(jobConcurrencyKinds).sort(),'the agent knows exactly the kinds of the portal');
for(const kind of Object.keys(jobConcurrencyKinds))check(kinds[kind],jobConcurrencyKinds[kind],'agent class of '+kind);
check(Object.keys(plugins).sort(),[...parallelPluginOperations,...exclusivePluginOperations].sort(),'the agent knows exactly the plugin operations of the portal');
check(Object.keys(plugins).sort(),Object.keys(pluginOperations).sort(),'and they are every plugin operation of the catalog');
for(const operation of Object.keys(plugins))check(plugins[operation],jobConcurrency('plugin-job',{plugin:pluginOperations[operation].plugin,operation}),'agent class of plugin operation '+operation);
check(Number(/internal const int MaxRunning = (\d+);/.exec(csharp)?.[1]),MAX_RUNNING_JOBS,'the agent cap is the portal cap');
check(/internal const string Capability = "([^"]+)";/.exec(csharp)?.[1],PARALLEL_JOBS_CAPABILITY,'the capability name');
check(/private static readonly string\[\] RunbookDiagnoses = \["refresh", "scan-updates", "test-connection"\];/.test(csharp),true,'the runbook diagnoses of runbook-step.ts');
// ---- Runbook steps: one rule in the portal and the agent (287) -----------------------------------------
// Every RunbookCase line of JobConcurrencyTests.cs gets from the portal the class the agent asserts.
const caseClass=(letter,group)=>({mode:letter==='P'?'parallel':'exclusive',group:group===undefined?null:JSON.parse(group)});
const runbookCases=[...read('agent/v3/JobConcurrencyTests.cs').matchAll(/^ *RunbookCase\("""(.*)""", (P|E)\(("[^"]*")?\), "([^"]*)"\);$/gm)];
const runbookCalls=read('agent/v3/JobConcurrencyTests.cs').match(/^ *RunbookCase\(/gm)??[];
check(runbookCases.length,runbookCalls.length,'every RunbookCase line has the parseable form');
assert.ok(runbookCases.length>=19,`the agent asserts at least the 19 runbook cases of the spec table (found ${runbookCases.length})`);checks++;
for(const [,json,letter,group,label] of runbookCases)check(jobConcurrency('runbook-step',JSON.parse(json)),caseClass(letter,group),'portal class of the agent runbook case: '+label);
// Each required case below must be in the agent list, by its parameters.
const agentJson=new Set(runbookCases.map(([,json])=>JSON.stringify(JSON.parse(json))));
const connection=operationParameters=>({kind:'diagnosis',operation:'test-connection',operationParameters});
const specCases=[
 {kind:'diagnosis',operation:'refresh'},{kind:'diagnosis',operation:'refresh',operationParameters:{}},{kind:'diagnosis',operation:'refresh',operationParameters:null},
 {kind:'diagnosis',operation:'refresh',operationParameters:{x:1}},{kind:'diagnosis',operation:'scan-updates',operationParameters:{},script:''},
 connection({host:'srv01.example.com',port:443}),{kind:'diagnosis',operation:'test-connection'},connection({host:'srv01.example.com',port:'443'}),
 connection({host:'srv01.example.com',port:0}),connection({host:'srv01.example.com',port:65536}),connection({host:'srv01.example.com',port:1.5}),
 connection({host:'-bad',port:443}),connection({host:'',port:443}),connection({host:'a'.repeat(254),port:443}),connection({host:'srv01.example.com',port:443,extra:true}),
 {kind:'diagnosis',operation:'refresh',operationParameters:[]},{kind:'diagnosis',operation:'refresh',operationParameters:'text'},
 {kind:'diagnosis',operation:'refresh',script:'Get-Date'},{kind:'powershell',script:'Get-Date'},
];
for(const parameters of specCases)check(agentJson.has(JSON.stringify(parameters)),true,'the agent asserts the spec case '+JSON.stringify(parameters).slice(0,120));
// The agent's host pattern is the portal's dnsName pattern, character for character.
const dnsName=/const dnsName=z\.string\(\)\.min\(1\)\.max\(253\)\.regex\(\/(.+)\/\);/.exec(read('lib/management.ts'))?.[1];
assert.ok(dnsName,'management.ts has the dnsName pattern');checks++;
check(/internal const string HostPattern = @"([^"]+)";/.exec(csharp)?.[1],dnsName,'the agent host pattern is the portal dnsName pattern');
check(/ValidOperationParameters\(operation, parameters\?\["operationParameters"\]\)/.test(csharp),true,'the agent checks the operation parameters of a runbook diagnosis');
check(/catch \{ return SoleClass; \}/.test(csharp)&&/: SoleClass;/.test(csharp),true,'the fail-safe is sole');

// ---- The worker advertises the capability; the runner keeps a set ---------------------------------------
const worker=read('agent/v3/AgentWorker.cs');
check(/agentCapabilities"\] = new JsonArray\([^;]*JobConcurrency\.Capability/.test(worker),true,'AgentWorker lists parallel-jobs');
const runner=read('agent/v3/JobRunner.cs');
check(/\bTask\?\s+active\b/.test(runner),false,'JobRunner has no single Task? active field');
check(/List<RunningJob> running/.test(runner),true,'JobRunner keeps a list of running jobs');
check(/JobConcurrency\.Admits\(/.test(runner)&&/BusyCode\(action\)/.test(runner),true,'Start refuses by the local rule with BusyCode');
check(/Task\.WhenAll\(/.test(runner),true,'StopAsync awaits every running job');
check(/JobConcurrencyTests\.Run\(\);/.test(read('agent/v3/SelfTests.cs')),true,'the self-test runs the concurrency checks');
check(/"--jobs-self-test"\) return JobConcurrencyTests\.RunSelfTest\(\);/.test(read('agent/v3/Program.cs')),true,'--jobs-self-test');
check(read('scripts/build-agent-v3.mjs').includes("'--jobs-self-test'"),true,'the agent build runs --jobs-self-test');

// ---- Version -------------------------------------------------------------------------------------------
const version=/<Version>([^<]+)<\/Version>/.exec(read('agent/v3/ServerDesk.Agent.csproj'))?.[1];
check(/internal const string BaseVersion = "([^"]+)";/.exec(read('agent/v3/Program.cs'))?.[1],version,'csproj version = Program.Version');
check(fs.existsSync(`agent/v3/changelogs/${version}.json`),true,`changelogs/${version}.json exists`);
check(read('agent/v3/README.md').startsWith(`# ServerDesk native agent ${version}\n`),true,'the README names the version');
check(JSON.parse(read('lib/agent-changelog-history.json'))[0].version,version,'the history starts with the version');
check(read('docs/native-agent-v4.md').includes('## Parallel jobs in '),true,'the guide has the section');

console.log(`agent-parallel-jobs-source: ${checks} checks passed`);
