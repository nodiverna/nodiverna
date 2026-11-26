// The script retention of assistant script jobs on PostgreSQL: runMaintenance (runtime/maintenance.mjs) removes the key
// script from jobs.display_input of an ended assistant-powershell job older than assistantScriptRetentionDays (7) and
// keeps timeoutSeconds; a younger job, a running job and another kind stay unchanged, and a second run clears nothing.
// The cleared row through the real readers: consoleJobDetail (lib/server/devices/job-detail.ts) answers
// scriptRemovedAfterDays 7 with inputKept true and no script, and scopeJobs still gives the script's first line as the
// object, from the stored target (jobObject in lib/job-display.ts).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {sql} from '../../runtime/database.mjs';
import {createStorage} from '../../runtime/storage.mjs';
import {assistantScriptRetentionDays,resultHasMore,runMaintenance} from '../../runtime/maintenance.mjs';
import {insertRow} from '../support/source-database.mjs';
import {assistantFixture} from '../support/assistant-fixture.mjs';

const f=await assistantFixture();
const {d,load,imports,actor}=f;
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'serverdesk-script-retention-'));
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
try{
 const {jobDisplayInput}=load('lib/job-input.ts',imports),{scriptTarget}=load('lib/server/devices/assistant-commands.ts',imports);
 const detail=load('lib/server/devices/job-detail.ts',imports),projection=load('lib/server/devices/device-projection.ts',imports),data=load('lib/server/console-data.ts',imports);
 const storage=createStorage({OBJECT_STORAGE_DRIVER:'filesystem',OBJECT_STORAGE_PATH:path.join(directory,'objects')});
 const day=86_400_000,now=Date.now();
 check(assistantScriptRetentionDays,7,'the script stays 7 days');
 const deviceId=await f.device({name:'SRV-SCRIPT'}),owner=await actor('owner@script-retention.test',['*']);
 const script='Get-Service Spooler\nRestart-Service Spooler -Force';
 const job=async({action='assistant-powershell',state='succeeded',age,params={script,timeoutSeconds:60},target=scriptTarget(script)})=>{
  const id=crypto.randomUUID();
  await insertRow(d,'jobs',{id,server_id:deviceId,action,target,state,created_at:now-age,actor:owner.id,parameters:'{}',display_input:jobDisplayInput(action,params)});
  return id;
 };
 const old=await job({age:8*day}),failedOld=await job({state:'failed',age:9*day}),young=await job({age:6*day}),running=await job({state:'running',age:8*day});
 const service=await job({action:'stop-service',params:{name:'Spooler'},target:'Spooler',age:8*day});
 const stored=async()=>Object.fromEntries((await d.query(sql`SELECT id,display_input FROM jobs WHERE server_id=${deviceId}`)).map(row=>[row.id,JSON.parse(row.display_input)]));
 const before=await stored();
 check(before[old],{script,timeoutSeconds:60},'queued: the script and the timeout are kept');

 // Batches of 1: two scripts to clear take two full batches and a third, empty one.
 const retention={auditDays:30,jobDays:30};
 const first=await runMaintenance(d,storage,{retention,now,batchSize:1,maxBatches:5});
 check(first.assistantScripts,{cleared:2,more:false},'the run clears the two old ended scripts');
 const after=await stored();
 check([after[old],after[failedOld]],[{timeoutSeconds:60},{timeoutSeconds:60}],'old ended jobs: the script is gone, the timeout stays');
 check([after[young],after[running],after[service]],[before[young],before[running],before[service]],'a younger job, a running job and another kind are unchanged');
 const second=await runMaintenance(d,storage,{retention,now,batchSize:1,maxBatches:5});
 check(second.assistantScripts,{cleared:0,more:false},'a second run clears nothing');
 // The batch limit: more is true while a script remains after the last allowed batch.
 const another=await job({age:10*day}),last=await job({age:11*day});
 const limited=await runMaintenance(d,storage,{retention,now,batchSize:1,maxBatches:1});
 check(limited.assistantScripts,{cleared:1,more:true},'one batch of one leaves one script: more');
 check([resultHasMore(limited),resultHasMore({assistantScripts:{cleared:1,more:true}})],[true,true],'remaining scripts start a continuation');
 check((await runMaintenance(d,storage,{retention,now,batchSize:1,maxBatches:1})).assistantScripts,{cleared:1,more:false},'the next run clears the rest');
 check([(await stored())[another],(await stored())[last]],[{timeoutSeconds:60},{timeoutSeconds:60}],'both are cleared');

 // The cleared row through the job drawer's read and the console list.
 const read=await detail.consoleJobDetail(owner,deviceId,old);
 check([read.scriptRemovedAfterDays,read.inputKept,read.input],[7,true,{fields:[{key:'timeoutSeconds',value:60}]}],'consoleJobDetail: scriptRemovedAfterDays 7, input kept, no script');
 const fresh=await detail.consoleJobDetail(owner,deviceId,young);
 check([fresh.scriptRemovedAfterDays,fresh.input.script],[null,script],'a job within the 7 days still shows its script');
 const rows=await data.consoleJobs(JSON.stringify([deviceId]));
 const listed=projection.scopeJobs(rows,true,await load('lib/server/identity/access.ts',imports).effectivePermissions(owner,[deviceId])).find(item=>item.id===old);
 check(listed.object,'Get-Service Spooler','the list object is still the first line of the script, from the stored target');
}finally{
 await f.close();
 fs.rmSync(directory,{recursive:true,force:true});
}
console.log(`PASS assistant script retention (${checks} checks): the maintenance removes the script of ended assistant jobs after 7 days and keeps the timeout, in batches; the drawer read says so and the list object stays.`);
