// The display-safe job input (lib/job-input.ts, jobs.display_input of migration 0032) and the job's object
// (jobObject in lib/job-display.ts), pure: an allowlist for every kind the console job list shows, never a password,
// a sealed secret or a secret-named key, the length limits, and a source scan that every INSERT INTO jobs in lib/
// writes display_input while no statement that wipes parameters touches it.
import '../support/register.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const {jobDisplayInput,jobInputKinds,jobInputKeys,knownPluginOperations,isSecretKey,parseJobInput,keepsInput}=await import('../../lib/job-input.ts');
const {jobObject,shownJobObject}=await import('../../lib/job-display.ts');
const {operations}=await import('../../lib/management.ts');
const {diagnosticDefinitions}=await import('../../lib/diagnostics.ts');
const {fileDefinitions}=await import('../../lib/file-operations.ts');
const {pluginOperations}=await import('../../lib/plugin-catalog.ts');
const {default:en}=await import('../../lib/i18n/messages/en.ts');
const {default:de}=await import('../../lib/i18n/messages/de.ts');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const kept=(kind,params)=>JSON.parse(jobDisplayInput(kind,params));

// ---- an allowlist for every listed kind ----
const listed=[...Object.keys(operations),...Object.keys(diagnosticDefinitions),...Object.keys(fileDefinitions),'agent-update','agent-uninstall','plugin-install','plugin-remove','ad-sign-in','assistant-powershell'];
const known=new Set([...jobInputKinds.operations,...jobInputKinds.others]);
for(const kind of listed)ok(known.has(kind),`${kind} has an allowlist`);
check([...jobInputKinds.pluginOperations].sort(),[...knownPluginOperations].sort(),'every plugin operation has an allowlist');
check([...knownPluginOperations].sort(),Object.keys(pluginOperations).sort(),'the plugin operations are those of the catalog');
// Every allowlisted key has a label in both catalogs and is no secret.
for(const key of jobInputKeys()){
 ok(typeof en[`jobs.input.${key}`]==='string'&&typeof de[`jobs.input.${key}`]==='string',`jobs.input.${key} in en and de`);
 ok(!isSecretKey(key),`${key} is no secret key`);
}
// Secrets never stay.
check(kept('rename-computer',{name:'SRV-02',username:'CONTOSO\\admin',password:'P@ss'}),{name:'SRV-02'},'rename-computer keeps the name only');
check(kept('create-local-user',{name:'svc',fullName:'Service',description:'d',passwordNeverExpires:true,password:'x'}),{name:'svc',fullName:'Service',description:'d',passwordNeverExpires:true},'create-local-user keeps no password');
check(kept('reset-local-password',{name:'svc',password:'x',secrets:{box:'sealed'}}),{name:'svc'},'reset-local-password keeps the name, not the sealed secrets');
check(kept('ad-sign-in',JSON.stringify({plugin:'dhcp',account:'CONTOSO\\anna',secretParameters:{box:'x'}})),{plugin:'dhcp',account:'CONTOSO\\anna'},'ad-sign-in keeps plugin and account');
check(kept('plugin-job',{plugin:'dhcp',operation:'dhcp-scope-create',parameters:{family:'ipv4',scopeId:'10.0.0.0',name:'Office',startRange:'10.0.0.10',endRange:'10.0.0.200',subnetMask:'255.255.255.0',activate:true},secretParameters:{box:'x'},actAs:{sessionId:'s',userSid:'S-1',account:'CONTOSO\\anna'}}),
 {plugin:'dhcp',operation:'dhcp-scope-create',family:'ipv4',scopeId:'10.0.0.0',name:'Office',startRange:'10.0.0.10',endRange:'10.0.0.200',subnetMask:'255.255.255.0',activate:true},'a DHCP change keeps its fields, not actAs or secretParameters');
check(kept('desired-state-apply',{assignmentId:'a',versionId:'v',engine:'dsc3',contentSha256:'f'.repeat(64),parameters:{Password:'x'},timeoutSeconds:900,configuration:{key:'k',iv:'i',data:'d',mac:'m'}}),{engine:'dsc3',versionId:'v',assignmentId:'a',timeoutSeconds:900},'desired state keeps no configuration or parameters');
check(kept('agent-update',{releaseId:'r1',manifest:'m'.repeat(5000),signature:'s'}),{releaseId:'r1'},'agent-update keeps the release id, not the manifest');
check(kept('runbook-step',{runId:'r',stepId:'s',kind:'powershell',script:'Get-Date',parameters:{token:'x'},name:'Collect'}),{name:'Collect',kind:'powershell'},'a runbook step keeps its name and kind');
check(kept('export-events',{filter:{channel:'Security',from:'2026-01-01T00:00:00Z',levels:[2]},format:'csv'}),{channel:'Security',from:'2026-01-01T00:00:00Z',format:'csv'},'a nested field by its path');
// Secret-named keys are refused even when an allowlist names them.
for(const key of ['password','Password','passwords','secretParameters','secrets','apiToken','token','credentials','adminCredential','clientSecret'])ok(isSecretKey(key),`${key} is a secret key`);
for(const key of ['passwordNeverExpires','username','name','tokenized'])ok(!isSecretKey(key),`${key} is no secret key`);
check(parseJobInput(JSON.stringify({name:'x',password:'y',nested:{a:1}})),{name:'x'},'a stored input is read without secrets and objects');
// Values and limits.
const script='Write-Output "a"\n'+'#'.repeat(9000);
check(kept('assistant-powershell',{script,timeoutSeconds:120}).script.length,8000,'the script is cut at 8000 characters');
check(kept('assistant-powershell',{script:'Get-Service',timeoutSeconds:120}),{script:'Get-Service',timeoutSeconds:120},'assistant-powershell keeps script and timeout');
check(kept('stop-service',{name:'x'.repeat(600)}).name.length,512,'other strings are cut at 512 characters');
check(kept('install-updates',{updateIds:['a','b','c']}),{updateIds:'a, b, c'},'a list of values becomes one text');
check(kept('test-connection',{host:'h',port:Number.NaN}),{host:'h'},'a number that is not finite is not kept');
check(kept('no-such-kind',{name:'x'}),{},'an unknown kind keeps {}');
check(kept('plugin-job',{plugin:'dhcp',operation:'dhcp-unknown'}),{},'an unknown plugin operation keeps {}');
check(jobDisplayInput('stop-service','not json'),'{}','malformed parameters keep {}');
ok(keepsInput('stop-service')&&keepsInput('plugin-job')&&!keepsInput('refresh')&&!keepsInput('defender-quick-scan'),'which kinds keep input');

// ---- the source scan of the writes ----
const files=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(path.join(dir,entry.name)):entry.name.endsWith('.ts')?[path.join(dir,entry.name)]:[]);
let inserts=0,wipes=0;
// lib/ with lib/server/, and ui/ with the UI models that lived in lib/ before lib/server/.
for(const file of [...files('lib'),...files('ui')]){
 const text=fs.readFileSync(file,'utf8');
 for(const match of text.matchAll(/INSERT INTO jobs\s*\(([^)]*)\)\s*SELECT([\s\S]*?)\bWHERE\b/g)){
  inserts++;
  ok(match[1].split(',').map(column=>column.trim()).includes('display_input'),`${file}: the INSERT INTO jobs names display_input`);
  ok(/jobDisplayInput\(/.test(match[2]),`${file}: display_input comes from jobDisplayInput`);
 }
 for(const match of text.matchAll(/UPDATE jobs SET[^`]*?parameters\s*=\s*'\{\}'[^`]*/g)){wipes++;ok(!match[0].includes('display_input'),`${file}: the wipe leaves display_input`);}
}
ok(inserts>=13,`every job insert in lib/ is checked (${inserts})`);
ok(wipes>=9,`every parameter wipe in lib/ is checked (${wipes})`);

// ---- jobObject ----
const job=(action,target,input)=>({action,target,displayInput:input===undefined?undefined:JSON.stringify(input)});
check(jobObject(job('plugin-job','dhcp-scope-create',{plugin:'dhcp',operation:'dhcp-scope-create',scopeId:'10.0.0.0'})),'10.0.0.0','a finished DHCP scope create with kept input shows the scope');
check(jobObject(job('plugin-job','dhcp-read',{plugin:'dhcp',operation:'dhcp-read'})),null,'a DHCP read has no object; its operation id is not one');
check(jobObject(job('plugin-job','dhcp-scope-create')),null,'an old plugin job: the operation id is never the object');
check(jobObject(job('assistant-powershell','Get-Service | Sort / 0123456789ab')),'Get-Service | Sort','a script target gives its first line');
check(jobObject(job('assistant-powershell','x / 0123456789ab',{script:'Get-Date\nexit 0',timeoutSeconds:60})),'Get-Date','the kept script gives its first line');
check(jobObject(job('stop-service','Spooler')),'Spooler','an old service job: the target');
check(jobObject(job('stop-service','',{name:'W32Time'})),'W32Time','the service name from the kept input');
check(jobObject(job('cancel-power-schedule','5f3e1a2b-1111-4222-8333-444455556666')),null,'a GUID target is no object');
check(jobObject(job('refresh','refresh')),null,'the kind itself is no object');
check(jobObject(job('install-updates','Alle verfügbaren Softwareupdates')),null,'a built (German) target is never shown');
check(jobObject(job('scan-updates','Updates suchen')),null,'the kind label is never shown');
check(jobObject(job('agent-update','4.20.0',{releaseId:'r'})),'4.20.0','the release version');
check(shownJobObject({action:'stop-service',target:'x',object:'Spooler'}),'Spooler','the server object wins');
check(shownJobObject({action:'stop-service',target:'x',object:null}),null,'a server null stays null');

console.log(`PASS job input (${checks} checks): an allowlist for every listed kind with catalog labels, no secret ever kept, the limits, every job insert writes display_input and no wipe touches it, and the job object.`);
