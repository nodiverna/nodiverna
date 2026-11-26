// The session state and activity of the browser (ui/session/session-state.ts, session-activity.ts): status
// order, expiry, trusted input, bounded fetch, retry and revocation.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
async function runtime(file){const source=await readFile(new URL(file,import.meta.url),'utf8'),compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;return import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'));}
const {mergeSessionStatus,sessionExpired}=await runtime('../../../ui/session/session-state.ts');
const {createSessionActivity,watchPortalActivity}=await runtime('../../../ui/session/session-activity.ts');
const base={authenticated:true,sessionId:'one',lastActivityAt:100,verifiedUntil:1000,idleExpiresAt:1000,sessionExpiresAt:10000};
assert.equal(sessionExpired(base,999),false);assert.equal(sessionExpired(base,1000),true);assert.equal(sessionExpired({...base,idleExpiresAt:20000},10000),true);assert.equal(sessionExpired({...base,authenticated:false},20000),false);
const newer={...base,lastActivityAt:200,idleExpiresAt:2000,verifiedUntil:2000};
assert.equal(mergeSessionStatus(newer,base).idleExpiresAt,2000,'slow status reads cannot discard recent activity');
assert.equal(mergeSessionStatus(newer,{...base,sessionId:'two'}).idleExpiresAt,1000,'a fresh session does not inherit another deadline');
assert.equal(mergeSessionStatus(newer,{...base,authenticated:false}).authenticated,false,'revocation is never ignored');
assert.equal(mergeSessionStatus(newer,{...base,sessionExpiresAt:1500}).idleExpiresAt,1500,'the hard session/trust deadline wins over a newer idle deadline');
const listeners=[],removed=[];let visible=true,interactions=0;
const stopWatching=watchPortalActivity({addEventListener(type,listener,options){listeners.push({type,listener,options});},removeEventListener(type,listener,capture){removed.push({type,listener,capture});}},()=>visible,()=>interactions++);
assert.equal(listeners.length,5);assert.ok(listeners.every(item=>item.options.capture&&item.options.passive),'terminal and dialog input is observed before stopPropagation');
const keydown=listeners.find(item=>item.type==='keydown').listener;keydown({isTrusted:false});assert.equal(interactions,0,'synthetic input is not activity');keydown({isTrusted:true});assert.equal(interactions,1,'trusted terminal typing counts');visible=false;keydown({isTrusted:true});assert.equal(interactions,1,'a hidden tab does not renew activity');stopWatching();assert.equal(removed.length,5);assert.ok(removed.every(item=>item.capture===true),'capture listeners are removed on lock/unmount');
const original={setTimeout:globalThis.setTimeout,clearTimeout:globalThis.clearTimeout};
const requests=[],timers=new Map(),replies=[],errors=[];let time=0,remaining=3600000,live=true,timerId=0;
globalThis.setTimeout=(callback,ms)=>{timers.set(++timerId,{callback,at:time+ms});return timerId;};globalThis.clearTimeout=id=>timers.delete(id);
const settle=async()=>{for(let i=0;i<5;i++)await Promise.resolve();};
const advance=async ms=>{time+=ms;for(const[id,timer]of [...timers])if(timer.at<=time){timers.delete(id);timer.callback();}await settle();};
const make=({shouldRetry=()=>true}={})=>createSessionActivity({now:()=>time,idleRemaining:()=>remaining,isLive:()=>live,send:signal=>new Promise((resolve,reject)=>{const item={signal,resolve,reject};requests.push(item);signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});}),onReply:value=>replies.push(value),onError:error=>errors.push(error),shouldRetry});
try{
 const activity=make();await activity.flush();assert.equal(requests.length,0,'background ticks without input never renew MFA');
 activity.interact();assert.equal(requests.length,1,'first real input renews immediately');
 activity.interact();await activity.flush();assert.equal(requests.length,1,'only one activity request may be in flight');
 await advance(8000);assert.equal(requests[0].signal.aborted,true,'a hung activity request is bounded');assert.equal(errors.length,1);
 await advance(7000);const retry=activity.flush();assert.equal(requests.length,2,'a recent genuine event can retry after timeout');
 requests[1].resolve({ok:true});await retry;await settle();assert.equal(replies.length,1);await activity.flush();assert.equal(requests.length,2,'a successful retry does not produce an infinite background keepalive');
 await advance(1000);activity.interact();assert.equal(requests.length,2,'real input is throttled within fifteen seconds');remaining=1000;activity.interact();assert.equal(requests.length,3,'input near idle expiry renews immediately');
 activity.dispose();assert.equal(requests[2].signal.aborted,true,'unmount cancels renewal');await settle();activity.interact();await activity.flush();assert.equal(requests.length,3);
 const noRetry=make({shouldRetry:()=>false});noRetry.interact();requests.at(-1).reject(new Error('SESSION_EXPIRED'));await settle();const count=requests.length;await noRetry.flush();assert.equal(requests.length,count,'auth expiry cannot be retried into a keepalive');noRetry.dispose();
 remaining=3600000;const old=make();old.interact();await advance(31000);const before=requests.length;await old.flush();assert.equal(requests.length,before,'a stale input does not retry after thirty seconds');old.dispose();
 live=false;const stopped=make();stopped.interact();await stopped.flush();assert.equal(requests.length,before,'locked sessions cannot renew');stopped.dispose();
 console.log('PASS session state/activity: reordered status, hard expiry, trusted-input capture (including terminal), bounded fetch, recent retry, unmount and revocation.');
}finally{globalThis.setTimeout=original.setTimeout;globalThis.clearTimeout=original.clearTimeout;}
