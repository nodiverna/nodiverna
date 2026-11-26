// Job concurrency (236): the class and group of every device job kind from one
// pure source (lib/server/devices/jobs/concurrency.ts, docs/native-agent-v4.md "Parallel
// jobs"), and the jobs columns of 0029_parallel_jobs.sql that store it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {sourceDatabase,sourceLoader,insertRow,tableColumns} from '../support/source-database.mjs';
import {sql} from '../../runtime/database.mjs';

let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};

// ---------------------------------------------------------------------------
// 1. The table of the spec, written out literally, never computed by the code under test.
// ---------------------------------------------------------------------------
const pure=sourceLoader();
const {jobConcurrency,jobConcurrencyKinds,MAX_RUNNING_JOBS,MAX_REPORTED_RUNNING_JOBS}=pure('lib/server/devices/jobs/concurrency.ts');
const {operations}=pure('lib/management.ts'),{diagnosticDefinitions}=pure('lib/diagnostics.ts'),{pluginOperations,DHCP_CHANGE_OPERATIONS,DNS_CHANGE_OPERATIONS}=pure('lib/plugin-catalog.ts');
const source=fs.readFileSync('lib/server/devices/jobs/concurrency.ts','utf8');
check(/from\s+'(?:\.\.\/)+(?:db|server|access)'|cloudflare:workers/.test(source),false,'no database, server or access import');
check(MAX_RUNNING_JOBS,4,'the cap is 4 running jobs per device');
check(MAX_REPORTED_RUNNING_JOBS,MAX_RUNNING_JOBS+1,'an agent reports at most the cap plus a pending agent-update ID');

const P=(group=null)=>({mode:'parallel',group}),E=(group=null)=>({mode:'exclusive',group}),S={mode:'sole',group:null};
const rows=[
 [['refresh'],P('inventory')],
 [['scan-updates'],P('windows-update')],
 [['test-connection'],P()],
 [['start-service','stop-service','restart-service','set-service-startup'],E()],
 [['install-feature','remove-feature'],E()],
 [['set-network','set-dns','set-rdp','set-pagefile','set-task'],E()],
 [['join-domain','leave-domain','rename-computer'],E()],
 [['create-local-user','set-local-user','reset-local-password','delete-local-user','local-group-add','local-group-remove'],E()],
 [['set-firewall-rule','add-firewall-rule'],E()],
 [['schedule-power','cancel-power-schedule'],E()],
 [['restart-computer','shutdown-computer'],S],
 [['install-updates'],E('windows-update')],
 [['install-gpu-driver'],E()],
 [['defender-quick-scan','defender-full-scan'],P('defender')],
 [['defender-update-signatures'],E('defender')],
 [['defender-clean-detections'],E('defender')],
 [['list-files'],P()],
 [['create-directory','rename-file','delete-file'],E()],
 [['storage-inspect'],P('storage')],
 [['storage-initialize','storage-set-disk','storage-new-volume','storage-resize','storage-drive-letter','storage-format','storage-delete-partition'],E('storage')],
 [['desired-state-test'],E()],
 [['desired-state-apply'],E()],
 [['list-processes','list-sessions','list-connections','network-diagnostics','query-events','export-events','support-bundle'],P()],
 [['kill-process','message-session','disconnect-session','logoff-session'],E()],
 [['assistant-powershell'],E()],
 [['ad-sign-in'],P()],
 [['plugin-install','plugin-remove'],S],
 [['agent-update','agent-uninstall'],S],
];
const table=new Map();
for(const [kinds,expected] of rows)for(const kind of kinds){assert.ok(!table.has(kind),kind+' once in the table');table.set(kind,expected);check(jobConcurrency(kind,{}),expected,kind);}

// Runbook steps (287): a fixed diagnosis without script and with valid
// operation parameters has its console kind's class; every other step is exclusive.
// agent/v3/JobConcurrencyTests.cs asserts the same list; tests/agent/agent-parallel-jobs-source.mjs compares both.
const connection=(operationParameters)=>({kind:'diagnosis',operation:'test-connection',operationParameters});
const runbookCases=[
 [{kind:'diagnosis',operation:'refresh'},P('inventory'),'refresh without parameters'],
 [{kind:'diagnosis',operation:'refresh',operationParameters:{}},P('inventory'),'refresh with {}'],
 [{kind:'diagnosis',operation:'refresh',operationParameters:null},P('inventory'),'refresh with null'],
 [{kind:'diagnosis',operation:'refresh',operationParameters:{x:1}},E(),'refresh with a property'],
 [{kind:'diagnosis',operation:'scan-updates',operationParameters:{},script:''},P('windows-update'),'scan-updates with {} and an empty script'],
 [connection({host:'srv01.example.com',port:443}),P(),'test-connection with valid parameters'],
 [{kind:'diagnosis',operation:'test-connection'},E(),'test-connection without parameters'],
 [connection({host:'srv01.example.com',port:'443'}),E(),'test-connection with a string port'],
 [connection({host:'srv01.example.com',port:0}),E(),'test-connection with port 0'],
 [connection({host:'srv01.example.com',port:65536}),E(),'test-connection with port 65536'],
 [connection({host:'srv01.example.com',port:1.5}),E(),'test-connection with port 1.5'],
 [connection({host:'-bad',port:443}),E(),'test-connection with host -bad'],
 [connection({host:'',port:443}),E(),'test-connection with an empty host'],
 [connection({host:'a'.repeat(254),port:443}),E(),'test-connection with a 254-character host'],
 [connection({host:'srv01.example.com',port:443,extra:true}),E(),'test-connection with an extra key'],
 [{kind:'diagnosis',operation:'refresh',operationParameters:[]},E(),'operationParameters is an array'],
 [{kind:'diagnosis',operation:'refresh',operationParameters:'text'},E(),'operationParameters is a string'],
 [{kind:'diagnosis',operation:'refresh',script:'Get-Process'},E(),'a diagnosis with a script'],
 [{kind:'powershell',script:'Get-Date'},E(),'a powershell step'],
 [{kind:'diagnosis',operation:'install-updates'},E(),'a diagnosis outside the fixed list'],
 [{},E(),'a runbook step without parameters'],
];
for(const [parameters,expected,label] of runbookCases)check(jobConcurrency('runbook-step',parameters),expected,'runbook step: '+label);

// Plugin jobs: reads are parallel, changes exclusive, both in the plugin's group; anything else is sole.
const reads=['dhcp-read','dns-read','dns-zone-read'];
for(const operation of reads)check(jobConcurrency('plugin-job',{plugin:operation.split('-')[0],operation}),P('plugin:'+operation.split('-')[0]),'plugin read '+operation);
for(const operation of DHCP_CHANGE_OPERATIONS)check(jobConcurrency('plugin-job',{plugin:'dhcp',operation}),E('plugin:dhcp'),'DHCP change '+operation);
for(const operation of DNS_CHANGE_OPERATIONS)check(jobConcurrency('plugin-job',{plugin:'dns',operation}),E('plugin:dns'),'DNS change '+operation);
check(jobConcurrency('plugin-job',{plugin:'dhcp',operation:'dhcp-format-everything'}),S,'an unknown plugin operation is sole');
check(jobConcurrency('plugin-job',{plugin:'dns',operation:'dhcp-read'}),S,'a plugin mismatch is sole');
check(jobConcurrency('plugin-job',{operation:'dhcp-read'}),S,'a plugin job without plugin is sole');
check(jobConcurrency('plugin-job',{plugin:'dhcp',operation:'__proto__'}),S,'a prototype key is no operation');

// ---------------------------------------------------------------------------
// 2. Every known kind has an explicit entry; nothing known reaches the fail-safe.
// ---------------------------------------------------------------------------
const known=[...Object.keys(operations),...Object.keys(diagnosticDefinitions),'runbook-step','assistant-powershell','agent-update','agent-uninstall','plugin-install','plugin-remove','ad-sign-in'];
for(const kind of known){
 assert.ok(kind==='runbook-step'||Object.hasOwn(jobConcurrencyKinds,kind),kind+' has an explicit entry');checks++;
 if(kind!=='runbook-step')assert.ok(table.has(kind),kind+' is in the table of the spec');
}
check([...table.keys()].filter(kind=>!known.includes(kind)),[],'the table names no kind the portal does not know');
check(Object.keys(jobConcurrencyKinds).sort(),[...table.keys()].sort(),'the explicit entries are the table');
for(const operation of Object.keys(pluginOperations)){
 const plugin=pluginOperations[operation].plugin,expected=pluginOperations[operation].readOnly?P('plugin:'+plugin):E('plugin:'+plugin);
 check(jobConcurrency('plugin-job',{plugin,operation}),expected,'plugin operation '+operation+' follows readOnly');
}
for(const kind of ['format-c','',' refresh','REFRESH','constructor','__proto__','toString','plugin-host'])check(jobConcurrency(kind,{}),S,`unknown kind ${JSON.stringify(kind)} is sole`);

// Malformed parameters never throw.
for(const kind of [...known,'plugin-job','unknown'])for(const params of [null,undefined,[],'text',42,{operation:{}},{kind:null},Object.create(null),{operation:'dhcp-read',plugin:{toString(){throw new Error('boom');}}}]){
 const result=jobConcurrency(kind,params);assert.ok(['parallel','exclusive','sole'].includes(result.mode),kind);checks++;
}
// A returned value is a copy: changing it changes nothing for the next call.
const copy=jobConcurrency('refresh',{});copy.group='other';check(jobConcurrency('refresh',{}),P('inventory'),'results are copies');

// ---------------------------------------------------------------------------
// 3. The columns of 0029_parallel_jobs.sql.
// ---------------------------------------------------------------------------
const d=await sourceDatabase();
try{
 const names=(await tableColumns(d,'jobs')).map(column=>column.name);
 for(const name of ['concurrency','concurrency_group']){assert.ok(names.includes(name),name+' exists');checks++;}
 const id=crypto.randomUUID(),at=Date.now();
 await insertRow(d,'jobs',{id,server_id:crypto.randomUUID(),action:'refresh',target:'',state:'running',created_at:at,actor:'fixture'});
 check((await d.one(sql`SELECT concurrency,concurrency_group FROM jobs WHERE id=${id}`)),{concurrency:null,concurrency_group:null},'both columns are nullable');
 for(const mode of ['parallel','exclusive','sole'])await d.exec(sql`UPDATE jobs SET concurrency=${mode},concurrency_group='inventory' WHERE id=${id}`);
 await assert.rejects(d.exec(sql`UPDATE jobs SET concurrency='other' WHERE id=${id}`),error=>error.code==='23514'&&error.constraint_name==='jobs_concurrency','the CHECK refuses another class');checks++;
}finally{await d.close();}

console.log(`job-concurrency: ${checks} checks passed`);
