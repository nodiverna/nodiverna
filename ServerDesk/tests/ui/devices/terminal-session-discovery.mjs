// Terminal session discovery (ui/devices/remote/terminal-session-discovery.ts): single-flight refreshes, wakeups, pause while
// hidden or offline, retry backoff, request timeouts and teardown.
import assert from 'node:assert/strict';
import {createTerminalSessionDiscovery,createTerminalSessionRequest,TERMINAL_SESSION_REFRESH_MS,TERMINAL_SESSION_RETRY_MAX_MS,TERMINAL_SESSION_REQUEST_TIMEOUT_MS} from '../../../ui/devices/remote/terminal-session-discovery.ts';

const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(refresh){
  let available=true,next=0;
  const scheduled=new Map();
  const discovery=createTerminalSessionDiscovery({refresh,canRefresh:()=>available,schedule:(callback,delay)=>{const handle=++next;scheduled.set(handle,{callback,delay});return handle;},cancel:handle=>scheduled.delete(handle)});
  return {discovery,scheduled,setAvailable:value=>available=value,run:async()=>{const [handle,task]=scheduled.entries().next().value;scheduled.delete(handle);task.callback();await settle();return task.delay;}};
}

// Many focus/visibility wakeups during a slow request queue one follow-up.
let calls=0,complete;
const slow=fixture(()=>{calls++;return new Promise(resolve=>complete=resolve);});
slow.discovery.start();await settle();
assert.equal(calls,1);assert.equal(slow.scheduled.size,0);
for(let n=0;n<20;n++)slow.discovery.request();await settle();
assert.equal(calls,1,'a slow session-list request cannot overlap another');
complete(true);await settle();
assert.equal(slow.scheduled.size,1);assert.equal([...slow.scheduled.values()][0].delay,0);
await slow.run();assert.equal(calls,2);
complete(true);await settle();
assert.equal([...slow.scheduled.values()][0].delay,TERMINAL_SESSION_REFRESH_MS);
slow.discovery.stop();assert.equal(slow.scheduled.size,0);

// Browsers no longer keep querying the roster while hidden or offline.
calls=0;
const visible=fixture(async()=>{calls++;return true;});
visible.discovery.start();await settle();assert.equal(calls,1);
visible.setAvailable(false);visible.discovery.request();await settle();
assert.equal(visible.scheduled.size,0);assert.equal(calls,1);
visible.setAvailable(true);visible.discovery.request();await settle();
assert.equal(calls,2,'returning to the page refreshes immediately');
assert.equal([...visible.scheduled.values()][0].delay,TERMINAL_SESSION_REFRESH_MS);
visible.discovery.stop();

// Offline/failed API calls back off instead of producing a tight request loop.
let succeeds=false;
const failing=fixture(async()=>{if(!succeeds)throw new Error('transport failed');return true;});
failing.discovery.start();await settle();
for(const delay of [5000,10000,20000,TERMINAL_SESSION_RETRY_MAX_MS,TERMINAL_SESSION_RETRY_MAX_MS])assert.equal(await failing.run(),delay);
succeeds=true;await failing.run();
assert.equal([...failing.scheduled.values()][0].delay,TERMINAL_SESSION_REFRESH_MS,'successful recovery restores the normal cadence');
failing.discovery.stop();

// Closing the panel prevents a late in-flight completion from restarting it.
const closed=fixture(()=>new Promise(resolve=>complete=resolve));
closed.discovery.start();await settle();closed.discovery.stop();complete(true);await settle();
assert.equal(closed.scheduled.size,0);closed.discovery.request();assert.equal(closed.scheduled.size,0);

// A transport that hangs forever is aborted and releases the refresh loop.
let timeoutCallback,timeoutDelay,requestSignal,canceledTimeout;
const requestTimers={schedule:(callback,delay)=>{timeoutCallback=callback;timeoutDelay=delay;return 'timer';},cancel:handle=>canceledTimeout=handle};
const hung=createTerminalSessionRequest(signal=>{requestSignal=signal;return new Promise(()=>{});},requestTimers);
await settle();assert.equal(timeoutDelay,TERMINAL_SESSION_REQUEST_TIMEOUT_MS);
timeoutCallback();await assert.rejects(hung.promise,{name:'AbortError'});
assert.equal(requestSignal.aborted,true);assert.equal(canceledTimeout,'timer');

// Explicit teardown aborts the network signal without waiting for its timeout.
const leaving=createTerminalSessionRequest(signal=>{requestSignal=signal;return new Promise(()=>{});},requestTimers);
await settle();leaving.abort();await assert.rejects(leaving.promise,{name:'AbortError'});
assert.equal(requestSignal.aborted,true);assert.equal(canceledTimeout,'timer');
const completed=createTerminalSessionRequest(async()=>({sessions:[]}),requestTimers);
assert.deepEqual(await completed.promise,{sessions:[]});assert.equal(canceledTimeout,'timer');
console.log('PASS: terminal session discovery has single-flight refreshes, queued wakeups, hidden/offline pause, bounded retry backoff, immediate return refresh, request timeouts, aborted network signals and safe teardown.');
