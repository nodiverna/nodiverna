// Downloads in the file browser (ui/devices/remote/file-transfer-flow.ts): create, wait, verify and save one
// transfer, chunks, limits, SHA-256, failures, timeout and abort.
import '../../support/register.mjs';
import '../../support/german-default.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
const {runCreatedDownload,FILE_CHUNK_SIZE,MAX_FILE_SIZE,transferDelay}=await import('../../../ui/devices/remote/file-transfer-flow.ts');
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const original=new Uint8Array(FILE_CHUNK_SIZE+7);original.fill(37);
const completed={id:'new-download',direction:'download',path:'C:\\Temp\\report.zip',state:'completed',size:original.length,sha256:digest(original)};
const historical={...completed,id:'old-download',path:'C:\\Temp\\old.zip'};
let checks=0;
function harness(overrides={}){
 const controller=new AbortController(),progress=[],saved=[],reads=[],calls=[];let polls=0;
 const options={guard:{signal:controller.signal,isCurrent:()=>true},create:async()=>{calls.push('create');return {id:completed.id};},list:async()=>{calls.push('poll');return polls++===0?[historical,{...completed,state:'pending',size:null,sha256:null}]:polls===2?[historical,{...completed,state:'active',transferredBytes:FILE_CHUNK_SIZE}]:[historical,completed];},readChunk:async(id,index)=>{calls.push('chunk');reads.push({id,index});return original.slice(index*FILE_CHUNK_SIZE,(index+1)*FILE_CHUNK_SIZE).buffer;},save:(bytes,path)=>{calls.push('save');saved.push({bytes,path});},onProgress:item=>progress.push(item),wait:async()=>{},...overrides};
 return {controller,options,progress,saved,reads,calls};
}
let test=harness();const result=await runCreatedDownload(test.options);
assert.equal(result.id,completed.id);assert.equal(test.saved.length,1);assert.deepEqual(test.saved[0].bytes,original);assert.equal(test.saved[0].path,completed.path);assert.deepEqual(test.reads,[{id:completed.id,index:0},{id:completed.id,index:1}]);assert.deepEqual(test.calls,['create','poll','poll','poll','chunk','chunk','save']);assert.deepEqual(test.progress.map(item=>item.phase),['waiting','waiting','streaming','streaming','verifying']);checks+=7;
// Empty files still require and verify SHA-256 before saving.
test=harness({list:async()=>[{...completed,size:0,sha256:digest(new Uint8Array())}],readChunk:async()=>{throw Error('empty file must not request blocks');}});await runCreatedDownload(test.options);assert.equal(test.saved.length,1);assert.equal(test.saved[0].bytes.length,0);checks+=2;
test=harness({list:async()=>[{...completed,sha256:'0'.repeat(64)}]});await assert.rejects(()=>runCreatedDownload(test.options),/Prüfsumme stimmt nicht/);assert.equal(test.saved.length,0);checks+=2;
test=harness({readChunk:async()=>new Uint8Array(FILE_CHUNK_SIZE+1).buffer});await assert.rejects(()=>runCreatedDownload(test.options),/falscher Größe/);assert.equal(test.saved.length,0);checks+=2;
for(const size of [MAX_FILE_SIZE+1,-1,1.5,null]){test=harness({list:async()=>[{...completed,size}]});await assert.rejects(()=>runCreatedDownload(test.options),/Größe lässt sich nicht lesen/);assert.equal(test.reads.length,0);assert.equal(test.saved.length,0);checks+=3;}
for(const sha256 of [null,'invalid','A'.repeat(64)]){test=harness({list:async()=>[{...completed,sha256}]});await assert.rejects(()=>runCreatedDownload(test.options),/keine gültige Prüfsumme/);assert.equal(test.reads.length,0);checks+=2;}
for(const state of ['failed','expired','cancelled']){test=harness({list:async()=>[{...completed,state,message:'Agent rejected file'}]});await assert.rejects(()=>runCreatedDownload(test.options),/Agent rejected/);assert.equal(test.saved.length,0);checks+=2;}
// A scope change during an async digest must prevent the browser save.
let sameScope=true;test=harness({guard:{signal:new AbortController().signal,isCurrent:()=>sameScope},hash:async()=>{sameScope=false;return completed.sha256;}});await assert.rejects(()=>runCreatedDownload(test.options),{name:'AbortError'});assert.equal(test.saved.length,0);checks+=2;
// Unmount/abort after a create or block response may not continue or save.
for(const stage of ['create','chunk','hash']){
 test=harness();if(stage==='create')test.options.create=async()=>{test.controller.abort();return {id:completed.id};};
 if(stage==='chunk')test.options.readChunk=async()=>{test.controller.abort();return original.slice(0,FILE_CHUNK_SIZE).buffer;};
 if(stage==='hash')test.options.hash=async()=>{test.controller.abort();return completed.sha256;};
 await assert.rejects(()=>runCreatedDownload(test.options),{name:'AbortError'});assert.equal(test.saved.length,0);checks+=2;
}
// Polling a pending agent result is bounded, and aborted waits are cleaned up.
test=harness({list:async()=>[{...completed,state:'pending',size:null,sha256:null}],wait:transferDelay,timeoutMs:8});await assert.rejects(()=>runCreatedDownload(test.options),/zu lange gedauert/);assert.equal(test.saved.length,0);checks+=2;
test=harness({list:async()=>[historical],wait:transferDelay,timeoutMs:8});await assert.rejects(()=>runCreatedDownload(test.options),/zu lange gedauert/);assert.equal(test.reads.length,0);assert.equal(test.saved.length,0);checks+=3;
console.log(`PASS download orchestration (${checks} assertions): one action creates/waits/verifies/saves only its own ID, empty files, exact chunks/limits/SHA, agent failures, timeout and abort/scope protection after async work.`);
