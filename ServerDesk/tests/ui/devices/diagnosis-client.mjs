// The diagnosis client (ui/devices/diagnostics/diagnosis-client.ts): the automatic session query, job reuse, races, single-flight
// reads, cancellation and request timeouts.
import '../../support/register.mjs';
import '../../support/german-default.mjs';
import assert from 'node:assert/strict';
const {createDiagnosisClient,diagnosisQueryState,DIAGNOSIS_REQUEST_TIMEOUT_MS,DIAGNOSIS_JOB_WAIT_MS}=await import('../../../ui/devices/diagnostics/diagnosis-client.ts');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const job=(kind='list-sessions',state='running',changes={})=>({id:'query',kind,state,createdAt:1000,claimedAt:null,result:null,data:null,...changes});
function fixture(options={}){
  const posts=[],jobs=[],errors=[],busy=[],automatic=[],timers=new Map();let timerId=0;
  const client=createDiagnosisClient({read:async()=>({jobs:[]}),post:async(kind,params,confirm,signal)=>{posts.push({kind,params,confirm,signal});return {id:'posted'};},onJobs:value=>jobs.push(value),onError:error=>errors.push(error),onBusy:value=>busy.push(value),onAutomatic:value=>automatic.push(value),schedule:(callback,delay)=>{const id=++timerId;timers.set(id,{callback,delay});return id;},cancel:id=>timers.delete(id),clock:()=>1000,...options});
  return {client,posts,jobs,errors,busy,automatic,timers};
}

const once=fixture();
await Promise.all([once.client.automatic('list-sessions'),once.client.automatic('list-sessions'),once.client.automatic('list-sessions')]);
assert.equal(once.posts.length,1);assert.equal(once.posts[0].kind,'list-sessions');assert.deepEqual(once.posts[0].params,{});
assert.deepEqual(once.automatic,[true,false]);assert.equal(once.timers.size,0);once.client.dispose();

const existing=fixture({read:async()=>({jobs:[job()]})});
await existing.client.automatic('list-sessions');assert.equal(existing.posts.length,0);
assert.equal(await existing.client.submit('list-sessions'),'query');assert.equal(existing.posts.length,0,'refresh reuses a pending session query');existing.client.dispose();

let resolveRead,readSignal,reads=0;
const slow=fixture({read:signal=>{reads++;readSignal=signal;return new Promise(resolve=>resolveRead=resolve);}});
const auto=slow.client.automatic('list-sessions');const manual=slow.client.submit('list-sessions');
slow.client.load();slow.client.load();await settle();assert.equal(reads,1,'GET discovery is single-flight');
resolveRead({jobs:[job()]});await Promise.all([auto,manual]);assert.equal(slow.posts.length,0,'auto/manual races do not submit twice');slow.client.dispose();

const unreadable=fixture({read:async()=>{throw new Error('permission denied');}});
await unreadable.client.automatic('list-sessions');assert.equal(unreadable.posts.length,0,'failed discovery never creates an unverified duplicate');assert.ok(unreadable.errors.length);unreadable.client.dispose();
const malformed=fixture({read:async()=>({})});await malformed.client.automatic('list-sessions');assert.equal(malformed.posts.length,0);assert.match(malformed.errors[0].message,/nicht lesen kann/);malformed.client.dispose();

const leaving=fixture({read:signal=>{readSignal=signal;return new Promise(resolve=>resolveRead=resolve);}});
const canceled=leaving.client.automatic('list-sessions');await settle();leaving.client.dispose();assert.equal(readSignal.aborted,true);
resolveRead({jobs:[]});await canceled;assert.equal(leaving.posts.length,0);assert.equal(leaving.jobs.length,0,'late results cannot populate a closed/device-changed scope');assert.equal(leaving.timers.size,0);

let permitted=true;
const revoked=fixture({isCurrent:()=>permitted,read:()=>new Promise(resolve=>resolveRead=resolve)});
const revokedAuto=revoked.client.automatic('list-sessions');await settle();permitted=false;resolveRead({jobs:[]});await revokedAuto;
assert.equal(revoked.posts.length,0,'scope or permission loss between GET and POST prevents enqueue');assert.equal(revoked.jobs.length,0);revoked.client.dispose();

let reachable=true;
const offline=fixture({canSubmit:()=>reachable,read:()=>new Promise(resolve=>resolveRead=resolve)});
const becameOffline=offline.client.automatic('list-sessions');await settle();reachable=false;resolveRead({jobs:[]});await becameOffline;
assert.equal(offline.posts.length,0,'offline/capability changes during discovery prevent the queued session query');offline.client.dispose();

const timeout=fixture({read:signal=>{readSignal=signal;return new Promise(()=>{});}});
const timedRead=timeout.client.load();await settle();
assert.equal([...timeout.timers.values()][0].delay,DIAGNOSIS_REQUEST_TIMEOUT_MS);
[...timeout.timers.values()][0].callback();assert.equal(await timedRead,null);assert.equal(readSignal.aborted,true);assert.match(timeout.errors[0].message,/Zeitlimit/);assert.equal(timeout.timers.size,0);
const retried=timeout.client.load();await settle();assert.equal(timeout.timers.size,1,'a timed-out request releases the read gate');timeout.client.dispose();await retried;

let postedSignal,postedCalls=0;
const postTimeout=fixture({post:(_kind,_params,_confirm,signal)=>{postedSignal=signal;postedCalls++;return new Promise(()=>{});}});
const started=postTimeout.client.automatic('list-sessions');await settle();
[...postTimeout.timers.values()][0].callback();await started;assert.equal(postedSignal.aborted,true);
await postTimeout.client.automatic('list-sessions');assert.equal(postTimeout.timers.size,0);assert.equal(postedCalls,1,'an uncertain POST result is not automatically replayed');postTimeout.client.dispose();

const session=job(),foreign=job('query-events','failed',{id:'foreign'});
assert.deepEqual(diagnosisQueryState([foreign,session],'list-sessions',null,1001),{pending:true,timedOut:false});
assert.deepEqual(diagnosisQueryState([foreign],'list-sessions',null,1001),{pending:false,timedOut:false});
assert.deepEqual(diagnosisQueryState([],'list-sessions',{id:'awaited',kind:'list-sessions',at:1000},1001),{pending:true,timedOut:false});
assert.deepEqual(diagnosisQueryState([session],'list-sessions',null,1000+DIAGNOSIS_JOB_WAIT_MS),{pending:false,timedOut:true});
assert.deepEqual(diagnosisQueryState([job('list-sessions','succeeded')],'list-sessions',null,1001),{pending:false,timedOut:false});
console.log('PASS: automatic session query once, pending-job reuse, auto/manual races, single-flight reads, permission/scope cancellation, bounded GET/POST timeouts, no automatic POST replay and matching job wait state.');
