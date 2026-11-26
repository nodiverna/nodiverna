// The console answer as a patch (ui/shell/console-payload.ts) and the client of the console's payload worker
// (ui/shell/console-payload-client.ts):
// 1. diffConsoleData and applyConsolePatch: an equal answer is an empty patch and keeps the shown object; a heartbeat
//    over 250 devices (cloned from demoData() as e2e/overlay-performance.spec.ts does) gives a small patch with only the
//    changed paths, new device objects and kept nested lists; one changed device renews only that device and servers.
// 2. Shapes: added, removed and reordered items of every list with ids, arrays without ids, object keys, null, type
//    changes, optional top-level keys; each result equals the answer and keeps the identity rules of
//    ui/shell/keep-equal.ts.
// 3. Fuzz: 200 seeded random mutations of a 20-device answer.
// 4. A "__proto__" key of the answer stays an own property, and Object.prototype does not change.
// 5. The worker's message handler as a plain function: full answer without base, patch against the base, full answer
//    for an unknown base, invalid JSON, the jobs-poll step, the full request, the seed of the first load and the order
//    of messages while a Blob body is read.
// 6. The client over a fake worker port (tests/support/fake-payload-worker.mjs: structured clone, transfer): replies by
//    id, versions, Blob bodies by handle, the seed, failure and end.
// No browser, no Worker.
import '../../support/register.mjs';
import assert from 'node:assert/strict';

const {diffConsoleData,applyConsolePatch,consolePayloadHandler}=await import('../../../ui/shell/console-payload.ts');
const {consolePayloadClient,PayloadWorkerError,startConsolePayloadWorker}=await import('../../../ui/shell/console-payload-client.ts');
const {jsonEqual,mergeConsoleJobs,keyed}=await import('../../../ui/shell/keep-equal.ts');
const {demoData}=await import('../../../ui/shell/demo.ts');
const {fakePayloadWorker}=await import('../../support/fake-payload-worker.mjs');

let checks=0;
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const clone=value=>JSON.parse(JSON.stringify(value));
const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);

/**
 * The identity rules of ui/shell/keep-equal.ts: where next equals previous the result is previous itself; a changed
 * object or array is new and its parts follow the same rule; lists with ids are matched by id (for ids that occur once).
 */
function identityHolds(previous,next,result,path='answer'){
 if(jsonEqual(previous,next)){assert.ok(result===previous,`${path}: an equal part keeps its object`);return;}
 if(previous!==null&&typeof previous==='object')assert.ok(result!==previous,`${path}: a changed part is new`);
 if(Array.isArray(previous)&&Array.isArray(next)){
  if(previous.length&&next.length&&keyed(previous)&&keyed(next)){
   // Ids are unique in a console answer; a fuzzed one may repeat an id, which then has no one item to keep.
   const unique=list=>{const seen=new Map();for(const item of list)seen.set(item.id,(seen.get(item.id)??0)+1);return id=>seen.get(id)===1;};
   const once=unique(previous),onceNext=unique(next),byId=new Map(previous.map(item=>[item.id,item]));
   next.forEach((item,index)=>{const before=byId.get(item.id);if(before!==undefined&&once(item.id)&&onceNext(item.id))identityHolds(before,item,result[index],`${path}[id ${item.id}]`);});
  }else for(let index=0;index<Math.min(previous.length,next.length);index++)identityHolds(previous[index],next[index],result[index],`${path}[${index}]`);
  return;
 }
 if(isObject(previous)&&isObject(next))for(const key of Object.keys(next))if(Object.hasOwn(previous,key))identityHolds(previous[key],next[key],result[key],`${path}.${key}`);
}
/** apply(diff(a,b),a): equals b, keeps the identity rules, leaves a as it was; returns the result and the patch. */
function roundTrip(a,b,label){
 const before=JSON.stringify(a),patch=diffConsoleData(a,b),result=applyConsolePatch(a,structuredClone(patch));
 ok(jsonEqual(result,b),`${label}: the result equals the answer`);
 identityHolds(a,b,result);checks++;
 ok(JSON.stringify(a)===before,`${label}: the shown data is not changed in place`);
 return {result,patch};
}

// The answer of e2e/overlay-performance.spec.ts: 250 devices from the sample devices in 12 groups, plus jobs,
// customers and the rest of a console answer.
const samples=demoData().servers;
function answerOf(count){
 const deviceGroups=Array.from({length:12},(_,index)=>({id:`perf-group-${index+1}`,name:`Standort ${String(index+1).padStart(2,'0')}`,description:'',parentId:null,depth:0,deviceCount:0,permissions:[]}));
 const servers=Array.from({length:count},(_,index)=>{
  const sample=clone(samples[index%samples.length]),group=deviceGroups[index%12],number=String(index+1).padStart(3,'0'),name=`${sample.name}-${number}`;
  group.deviceCount++;
  const snapshot=sample.snapshot?{...sample.snapshot,hostname:name,networks:sample.snapshot.networks.map(network=>({...network,addresses:[`10.20.${Math.floor(index/200)}.${index%200+1}`]}))}:null;
  return {...sample,id:`perf-${number}`,name,snapshot,groupId:group.id,groupName:group.name,groups:[{id:group.id,name:group.name}]};
 });
 return {
  servers,deviceGroups,customers:[{id:'c1',name:'Contoso'},{id:'c2',name:'Fabrikam'}],
  jobs:[{id:'j1',serverId:servers[0].id,type:'script',state:'running',createdAt:1},{id:'j2',serverId:servers[1].id,type:'script',state:'succeeded',createdAt:2}],
  audit:[{id:'a1',at:1,action:'login'}],viewer:{id:'u1',label:'Owner',username:'owner',permissions:['view'],identitySource:'local'},
  auth:{mode:'local',origin:'https://desk.example.test'},multipleCustomers:false,
 };
}
const heartbeatOf=(answer,beat)=>({...answer,servers:answer.servers.map((server,index)=>({...server,lastSeen:1_800_000_000_000+beat,snapshot:server.snapshot?{...server.snapshot,cpu:(index*7+beat*13)%97,memory:(index*11+beat*5)%89}:null}))});

// ---- 1. Equal, heartbeat, one device ----
{
 const shown=answerOf(250);
 check(diffConsoleData(shown,clone(shown)),null,'an equal answer gives an empty patch');
 ok(applyConsolePatch(shown,diffConsoleData(shown,clone(shown)))===shown,'… and apply returns the shown object itself');

 const heartbeat=clone(heartbeatOf(shown,1)),{result,patch}=roundTrip(shown,heartbeat,'heartbeat');
 ok(result.servers.every((server,index)=>server!==shown.servers[index]),'every device of a heartbeat is a new object');
 ok(result.servers.every((server,index)=>server.snapshot.networks===shown.servers[index].snapshot.networks&&server.snapshot.services===shown.servers[index].snapshot.services&&server.snapshot.processes===shown.servers[index].snapshot.processes&&server.snapshot.disks===shown.servers[index].snapshot.disks),'… and keeps its snapshot lists (networks, services, processes, disks) by identity');
 ok(['deviceGroups','customers','jobs','audit','viewer','auth'].every(key=>result[key]===shown[key]),'the rest of the answer keeps its identity');
 const patchLength=JSON.stringify(patch).length,answerLength=JSON.stringify(heartbeat).length;
 ok(patchLength<answerLength*0.05,`the heartbeat patch is under 5 % of the answer (${patchLength} of ${answerLength} characters)`);
 // Only the changed paths: no device and no snapshot travels in full.
 const values=[];const collect=change=>{if(!change||typeof change!=='object')return;if('v' in change){values.push(change.v);return;}for(const part of Object.values(change))if(Array.isArray(part))for(const entry of part)collect(Array.isArray(entry)?entry[1]:entry);};
 collect(patch);
 const changedFields=shown.servers.reduce((sum,server,index)=>sum+['lastSeen'].filter(key=>server[key]!==heartbeat.servers[index][key]).length+['cpu','memory'].filter(key=>server.snapshot[key]!==heartbeat.servers[index].snapshot[key]).length,0);
 ok(changedFields>700&&values.length===changedFields&&values.every(value=>typeof value==='number'),'the patch carries per device only its changed lastSeen, cpu and memory values');

 const one=clone(shown);one.servers[17].snapshot.cpu=99;
 const single=roundTrip(shown,one,'one changed device').result;
 ok(single.servers!==shown.servers&&single.servers[17]!==shown.servers[17],'one changed device: that device and servers are new');
 ok(single.servers.every((server,index)=>index===17||server===shown.servers[index]),'… every other device keeps its object');
 ok(single.jobs===shown.jobs&&single.deviceGroups===shown.deviceGroups&&single.customers===shown.customers&&single.viewer===shown.viewer,'… and so do jobs, groups, customers and viewer');
 ok(single.servers[17].snapshot.networks===shown.servers[17].snapshot.networks,'… and its unchanged snapshot lists');
}

// ---- 2. Shapes ----
{
 const base=answerOf(6);
 const variant=(label,change)=>{const next=clone(base);change(next);roundTrip(base,next,label);};
 for(const list of ['servers','jobs','deviceGroups','customers']){
  variant(`${list}: an item added`,next=>{next[list].splice(1,0,{...clone(base[list][0]),id:`new-${list}`});});
  variant(`${list}: an item removed`,next=>{next[list].splice(0,1);});
  variant(`${list}: reversed`,next=>{next[list].reverse();});
  variant(`${list}: reversed with one change`,next=>{next[list].reverse();next[list][0].name='Changed';});
  variant(`${list}: emptied`,next=>{next[list]=[];});
 }
 {
  const next=clone(base);next.servers.reverse();
  const result=applyConsolePatch(base,diffConsoleData(base,next));
  ok(result.servers!==base.servers&&result.servers.every((server,index)=>server===base.servers[base.servers.length-1-index]),'a new order keeps every device and makes a new list');
 }
 {
  const empty={...clone(base),jobs:[]},next={...clone(empty),jobs:clone(base.jobs)};
  roundTrip(empty,next,'a list filled from empty');
 }
 variant('an array without ids: an item changed',next=>{next.servers[0].snapshot.disks[0].freeGb=1;});
 variant('an array without ids: longer',next=>{next.servers[0].snapshot.disks.push({...clone(next.servers[0].snapshot.disks[0]),name:'Z:'});});
 variant('an array without ids: shorter',next=>{next.servers[0].snapshot.disks.length=0;});
 variant('an array of strings: longer and changed',next=>{next.servers[0].tags=['a','b','c'];});
 variant('a key added',next=>{next.servers[2].note='new';});
 variant('a key removed',next=>{delete next.servers[2].description;});
 variant('a key added and one removed',next=>{delete next.servers[2].description;next.servers[2].note='new';});
 variant('null to an object',next=>{next.servers[3].snapshot=null;});
 {
  const off=clone(base);off.servers[3].snapshot=null;
  roundTrip(off,clone(base),'an object from null');
 }
 variant('a type change: number to string',next=>{next.servers[1].lastSeen='yesterday';});
 variant('a type change: object to array',next=>{next.viewer=['x'];});
 variant('a type change: array to object',next=>{next.audit={id:'a'};});
 variant('maintenance appears',next=>{next.maintenance={active:true,until:5};});
 variant('emergencyAlarms appears',next=>{next.emergencyAlarms={open:1,latest:null};});
 variant('previousSecretRemovable appears',next=>{next.previousSecretRemovable=true;});
 {
  const full={...clone(base),maintenance:{active:true},emergencyAlarms:{open:1,latest:null},previousSecretRemovable:true};
  roundTrip(full,clone(base),'the optional top-level keys disappear');
 }
 variant('a top-level value that is no object',next=>{next.auth=null;});
 ok(applyConsolePatch(base,diffConsoleData(base,null))===null&&jsonEqual(applyConsolePatch(base,diffConsoleData(base,[1])),[1]),'an answer that is no object replaces the data');
 {
  const reordered=clone(base),{servers,...rest}=reordered;
  const keysMoved={...rest,servers};
  ok(applyConsolePatch(base,diffConsoleData(base,keysMoved))===base,'the same keys in another order are the same answer');
 }
 {
  const next=clone(base);next.servers[0].note='x';
  const result=applyConsolePatch(base,diffConsoleData(base,next));
  check(Object.keys(result.servers[0]),Object.keys(next.servers[0]),'an added key: the object has the keys of the answer in its order');
 }
 assert.throws(()=>applyConsolePatch({servers:'none'},diffConsoleData({servers:[{id:'a'}]},{servers:[{id:'a',x:1}]})),TypeError,'a patch never applies to a base of another shape');checks++;
}

// ---- 3. Fuzz ----
{
 let seed=0x2f81;
 const random=()=>{seed=(seed+0x6d2b79f5)|0;let value=Math.imul(seed^(seed>>>15),1|seed);value=(value+Math.imul(value^(value>>>7),61|value))^value;return ((value^(value>>>14))>>>0)/4294967296;};
 const pick=items=>items[Math.floor(random()*items.length)];
 const lists=['servers','jobs','deviceGroups','customers'];
 // A list with ids of the answer (a mutation may have replaced or dropped one: then an empty stand-in).
 const listOf=next=>{const list=next[pick(lists)];return Array.isArray(list)?list:[];};
 /** A random path into an object or array of value, or null. */
 const somewhere=value=>{
  let target=value;
  for(let depth=0;depth<6;depth++){
   const keys=Array.isArray(target)?target.map((_,index)=>index):Object.keys(target);
   if(!keys.length)break;
   const key=pick(keys),child=target[key];
   if(child===null||typeof child!=='object'||random()<0.25)return {target,key};
   target=child;
  }
  return null;
 };
 const mutations=[
  next=>{const at=somewhere(next);if(at)at.target[at.key]=pick([1,'x',null,true,{deep:{x:1}},[1,2],random()]);},
  next=>{const at=somewhere(next);if(at&&!Array.isArray(at.target))delete at.target[at.key];},
  next=>{const at=somewhere(next);if(at&&!Array.isArray(at.target))at.target['added'+Math.floor(random()*5)]=random();},
  next=>{const at=somewhere(next);if(at&&Array.isArray(at.target))at.target.push(clone(at.target[0]??1));},
  next=>{const at=somewhere(next);if(at&&Array.isArray(at.target))at.target.splice(0,1);},
  next=>{const list=listOf(next);if(list.length>1){const [item]=list.splice(Math.floor(random()*list.length),1);list.splice(Math.floor(random()*list.length),0,item);}},
  next=>{const list=listOf(next);if(list.length)list.splice(Math.floor(random()*list.length),1);},
  next=>{const list=listOf(next);if(list.length)list.push({...clone(pick(list)),id:'fuzz-'+Math.floor(random()*1e6)});},
  next=>{for(const server of listOf(next))if(random()<0.5&&server&&typeof server==='object')server.lastSeen=Math.floor(random()*1e9);},
  next=>{listOf(next).reverse();},
  next=>{const server=pick(listOf(next));if(server?.snapshot&&typeof server.snapshot==='object')server.snapshot.cpu=Math.floor(random()*100);},
  next=>{const key=pick(['maintenance','emergencyAlarms','previousSecretRemovable']);if(key in next)delete next[key];else next[key]=key==='previousSecretRemovable'?true:{open:1};},
 ];
 const base=answerOf(20);
 let previous=base;
 for(let run=0;run<200;run++){
  const next=clone(previous);
  for(let step=1+Math.floor(random()*4);step>0;step--)pick(mutations)(next);
  const before=JSON.stringify(previous),patch=diffConsoleData(previous,next),result=applyConsolePatch(previous,structuredClone(patch));
  assert.ok(jsonEqual(result,next),`fuzz ${run}: the result equals the answer`);
  identityHolds(previous,next,result,`fuzz ${run}`);
  assert.ok(JSON.stringify(previous)===before,`fuzz ${run}: the shown data is not changed in place`);
  if(jsonEqual(previous,next))assert.ok(result===previous,`fuzz ${run}: an equal answer keeps the shown object`);
  checks+=3;
  // The next round starts from the result (as the console does), every 40 rounds again from the base.
  previous=run%40===39?base:result;
 }
}

// ---- 4. __proto__ ----
{
 const shown=answerOf(3),text=JSON.stringify(shown).replace('"id":"perf-002"','"id":"perf-002","__proto__":{"polluted":true}');
 const next=JSON.parse(text);
 ok(Object.hasOwn(next.servers[1],'__proto__'),'JSON.parse makes "__proto__" an own key');
 const {result}=roundTrip(shown,next,'__proto__ key added');
 ok(Object.hasOwn(result.servers[1],'__proto__')&&jsonEqual(result.servers[1]['__proto__'],{polluted:true}),'the "__proto__" key is an own property of the result');
 ok(Object.getPrototypeOf(result.servers[1])===Object.prototype&&!('polluted' in {})&&Object.prototype.polluted===undefined,'neither the device nor Object.prototype got a new prototype');
 const changed=JSON.parse(text.replace('"polluted":true','"polluted":false'));
 const second=roundTrip(next,changed,'__proto__ key changed').result;
 ok(second.servers[1]['__proto__'].polluted===false&&Object.prototype.polluted===undefined,'a change inside it stays inside it');
 const dropped=roundTrip(next,clone(shown),'__proto__ key removed').result;
 ok(!Object.hasOwn(dropped.servers[1],'__proto__'),'… and it can disappear again');
}

// ---- 5. The worker's message handler ----
{
 // Bodies as the console sends them (a Blob from response.blob()) and as bytes (an ArrayBuffer).
 const encoder=new TextEncoder(),bytes=value=>encoder.encode(typeof value==='string'?value:JSON.stringify(value)).buffer,blob=value=>new Blob([typeof value==='string'?value:JSON.stringify(value)]);
 const handle=consolePayloadHandler();
 const first=answerOf(4);
 const full=await handle({type:'parse',id:1,base:null,body:blob(first)});
 ok(full.type==='full'&&full.id===1&&jsonEqual(full.data,first),'a body with no base gives the full answer');
 const second=heartbeatOf(first,1);
 const patched=await handle({type:'parse',id:2,base:1,body:blob(second)});
 ok(patched.type==='patch'&&patched.base===1&&patched.id===2,'a second answer gives a patch against the first');
 ok(jsonEqual(applyConsolePatch(full.data,structuredClone(patched.patch)),second),'… that turns the first into the second');
 const same=await handle({type:'parse',id:3,base:2,body:bytes(second)});
 ok(same.type==='patch'&&same.patch===null,'an equal answer gives an empty patch');
 // A result the main thread dropped (a newer request superseded it): the next answer still diffs against the base.
 const dropped=await handle({type:'parse',id:30,base:3,body:bytes(first)}),third=heartbeatOf(first,5);
 const after=await handle({type:'parse',id:31,base:3,body:bytes(third)});
 ok(dropped.type==='patch'&&after.type==='patch'&&after.base===3&&jsonEqual(applyConsolePatch(second,structuredClone(after.patch)),third),'a dropped result does not move the base: the next patch fits the shown data');
 const unknown=await handle({type:'parse',id:4,base:99,body:bytes(second)});
 ok(unknown.type==='full'&&jsonEqual(unknown.data,second),'a base version the worker does not hold gives the full answer');
 const old=await handle({type:'parse',id:5,base:1,body:bytes(first)});
 ok(old.type==='full','a version it dropped gives the full answer too (it keeps only the last base and its result)');
 check(await handle({type:'parse',id:6,base:5,body:bytes('{"servers":[')}),{type:'invalid',id:6},'invalid JSON gives an invalid result');
 check(await handle({type:'parse',id:7,base:5,body:new ArrayBuffer(0)}),{type:'invalid',id:7},'an empty body is invalid too');
 ok((await handle({type:'parse',id:8,base:5,body:bytes(first)})).patch===null,'an invalid answer leaves the base as it was');
 check((await handle({type:'parse',id:9,base:8,body:encoder.encode(String.fromCharCode(0xfeff)+JSON.stringify(first)).buffer})).patch,null,'a byte order mark is dropped as response.json() does');
 // The jobs poll: the main thread merges jobs and viewer into its data; the worker makes the same step.
 let shown=first;
 const jobs=[{id:'j1',serverId:first.servers[0].id,type:'script',state:'succeeded',createdAt:1},{id:'j3',serverId:first.servers[2].id,type:'script',state:'pending',createdAt:3}],viewer={...first.viewer,label:'Renamed'};
 check(await handle({type:'jobs',id:10,base:9,jobs:structuredClone(jobs),viewer:structuredClone(viewer)}),null,'the jobs step has no reply');
 shown=mergeConsoleJobs(shown,jobs,viewer);
 const afterPoll=heartbeatOf({...first,jobs,viewer},2);
 const next=await handle({type:'parse',id:11,base:10,body:bytes(afterPoll)});
 const applied=applyConsolePatch(shown,structuredClone(next.patch));
 ok(next.type==='patch'&&jsonEqual(applied,afterPoll),'after a jobs step the next patch fits the main thread\'s merged data');
 ok(applied.jobs===shown.jobs&&applied.viewer===shown.viewer,'… and the polled jobs and viewer keep their identity');
 const fullReply=await handle({type:'full',id:11});
 ok(fullReply.type==='full'&&jsonEqual(fullReply.data,afterPoll),'a full request gives the data of that version');
 check(await handle({type:'full',id:2}),{type:'missing',id:2},'a version it dropped is missing');
 check(await handle({type:'jobs',id:12,base:77,jobs:[],viewer}),null,'a jobs step on an unknown base…');
 ok((await handle({type:'parse',id:13,base:12,body:bytes(first)})).type==='full','… leaves no base, so the next answer comes in full');
 // seed: the main thread parses the first load itself; the worker reads it as a version, with no reply.
 check(await handle({type:'seed',id:20,body:blob(first)}),null,'a seed has no reply');
 const seeded=await handle({type:'parse',id:21,base:20,body:blob(second)});
 ok(seeded.type==='patch'&&seeded.base===20&&jsonEqual(applyConsolePatch(first,structuredClone(seeded.patch)),second),'… and the next answer diffs against it');
 check(await handle({type:'seed',id:22,body:blob('no json')}),null,'a seed that is no JSON…');
 ok((await handle({type:'parse',id:23,base:22,body:blob(first)})).type==='full','… is no version: the next answer comes in full');
 // Order: a jobs step sent right after an answer whose Blob is still being read waits for it.
 const ordered=[handle({type:'parse',id:30,base:23,body:blob(second)}),handle({type:'jobs',id:31,base:30,jobs,viewer}),handle({type:'parse',id:32,base:31,body:blob({...second,jobs,viewer})})];
 const [,stepReply,last]=await Promise.all(ordered);
 ok(stepReply===null&&last.type==='patch'&&last.base===31&&last.patch===null,'messages are handled in the order they came, also while a Blob is read');
}

// ---- 6. The client over a fake worker port ----
{
 const fakeWorker=fakePayloadWorker;
 const port=fakeWorker(),client=consolePayloadClient(port);
 const first=answerOf(3),encoder=new TextEncoder();
 const buffer=encoder.encode(JSON.stringify(first)).buffer;
 const fullReply=await client.parse(buffer,null);
 ok(fullReply.type==='full'&&fullReply.id===1&&jsonEqual(fullReply.data,first),'the client sends the bytes and gets the full answer');
 ok(buffer.byteLength===0&&port.sent[0].transfer[0]===buffer,'an ArrayBuffer body is transferred, not copied');
 {
  const blobPort=fakeWorker(),blobClient=consolePayloadClient(blobPort),body=new Blob([JSON.stringify(first)]);
  const seeded=blobClient.seed(body);
  const reply=await blobClient.parse(new Blob([JSON.stringify(heartbeatOf(first,3))]),seeded);
  ok(seeded===1&&blobPort.sent[0].message.type==='seed'&&blobPort.sent[0].transfer.length===0&&body.size>0,'a Blob body is sent by handle (no transfer) and stays readable here');
  ok(reply.type==='patch'&&reply.base===1&&reply.id===2&&jsonEqual(applyConsolePatch(first,reply.patch),heartbeatOf(first,3)),'a seed is the base of the next parse');
 }
 const [a,b]=await Promise.all([client.parse(encoder.encode(JSON.stringify(heartbeatOf(first,1))).buffer,1),client.full(1)]);
 ok(a.type==='patch'&&a.id===2&&a.base===1&&b.type==='full'&&b.id===1,'concurrent requests get their own replies');
 const step=client.jobs(2,[],first.viewer);
 ok(step===3&&port.sent.at(-1).message.type==='jobs','a jobs step gets the next version');
 const patched=await client.parse(encoder.encode(JSON.stringify({...heartbeatOf(first,1),jobs:[]})).buffer,3);
 ok(patched.type==='patch'&&patched.base===3&&patched.patch===null,'… and the next parse diffs against it');
 // The worker fails (error event): the waiting request rejects, later ones too, and the client says so.
 const waiting=client.parse(encoder.encode('{}').buffer,4);
 let prevented=false;
 port.emit('error',{preventDefault(){prevented=true;}});
 await assert.rejects(waiting,PayloadWorkerError,'a waiting request rejects when the worker fails');
 await assert.rejects(client.parse(new ArrayBuffer(2),null),PayloadWorkerError,'… and so does every later one');
 ok(client.failed&&port.terminated&&prevented,'the client is failed, the worker ended and the error event handled');
 checks+=2;
 // messageerror and the worker's own "broken" reply count as failures too.
 for(const [label,fail] of [['messageerror',port=>port.emit('messageerror')],['a message the worker could not read',port=>port.emit('message',{data:{type:'broken'}})]]){
  const other=fakeWorker(),otherClient=consolePayloadClient(other);
  const pending=otherClient.parse(new ArrayBuffer(0),null);
  fail(other);
  await assert.rejects(pending,PayloadWorkerError,`${label} fails the worker`);
  ok(otherClient.failed,`${label}: the client is failed`);
  checks++;
 }
 // A postMessage that throws (a value that cannot be cloned) fails the worker instead of waiting for ever.
 const throwing=consolePayloadClient({postMessage(){throw new Error('DataCloneError');},addEventListener(){},terminate(){}});
 await assert.rejects(throwing.parse(new ArrayBuffer(0),null),PayloadWorkerError,'a postMessage that throws fails the request');checks++;
 // terminate: waiting requests reject, but the worker is not failed (the console unmounted).
 const ending=fakeWorker(),endingClient=consolePayloadClient(ending),open=endingClient.parse(new ArrayBuffer(0),null);
 endingClient.terminate();
 await assert.rejects(open,PayloadWorkerError,'terminate rejects the waiting requests');
 ok(!endingClient.failed&&ending.terminated,'terminate ends the worker without marking it failed');
 checks++;
 ok(typeof Worker==='undefined'&&startConsolePayloadWorker()===null,'without Worker (Node) there is no payload worker');
}

console.log(`PASS console payload (${checks} checks): equal answers give no patch, a 250-device heartbeat a small patch with kept nested lists, every shape and 200 fuzzed answers round-trip with the identity rules, "__proto__" stays data, and the worker handler and its client keep versions, base sync, invalid JSON and failures right.`);
