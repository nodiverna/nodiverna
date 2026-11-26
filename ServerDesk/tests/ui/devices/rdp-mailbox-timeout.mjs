// The Remote Desktop mailbox timeouts: bridge and local deadlines, retries with the same ciphertext and ACK, the
// attempt limit and the cases without a retry.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {webcrypto} from 'node:crypto';
import {mock} from 'node:test';
import ts from 'typescript';
import {i18nRequire} from '../../support/i18n-stubs.mjs';

const require=createRequire(import.meta.url),cache=new Map();
function load(filename){
 const file=path.resolve(filename);if(cache.has(file))return cache.get(file).exports;
 const mod={exports:{}};cache.set(file,mod);
 const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 new Function('require','module','exports',code)(id=>i18nRequire(id)??(id.startsWith('.')?load(path.resolve(path.dirname(file),id+'.ts')):require(id)),mod,mod.exports);return mod.exports;
}
const {createRdpWebSocket}=load('ui/devices/remote/rdp-transport.ts'),{rdpBase64}=load('ui/devices/remote/rdp-crypto.ts');
const id='11111111-1111-4111-8111-111111111111',key=await webcrypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),flush=()=>new Promise(resolve=>setImmediate(resolve));
async function until(predicate,label,virtual=false){for(let i=0;i<400;i++){if(predicate())return;await (virtual?flush():pause(5));}throw new Error('Timed out: '+label);}
const timeoutError=(named=true)=>Object.assign(new Error('Nodiverna hat die Remote-Desktop-Anfrage nicht rechtzeitig beantwortet. Verbinde dich erneut.'),{...(named?{name:'TimeoutError'}:{}),code:'RDP_BRIDGE_TIMEOUT',status:504});
const reply=(inputAck=0,inputStored=inputAck,frames=[],outputAck=0)=>({id,state:'open',inputAck,inputStored,outputAck,frames,intervalMs:1000});
function harness({duplex=true,input=false,cryptoApi=webcrypto}={}){
 const calls=[],errors=[],events=[];
 const request=(body,signal)=>new Promise((resolve,reject)=>{calls.push({body,signal,resolve,reject});signal?.addEventListener('abort',()=>reject(new DOMException('Die Remote-Desktop-Anfrage wurde abgebrochen.','AbortError')),{once:true});});
 const Socket=createRdpWebSocket({id,key,duplex,crypto:cryptoApi,now:()=>0,request,onFailure:error=>errors.push(error)}),socket=new Socket('wss://portal.example/serverdesk-rdp');
 socket.binaryType='arraybuffer';if(input)socket.onopen=()=>socket.send(new Uint8Array([0x30,0]));socket.onmessage=event=>events.push(new Uint8Array(event.data));
 return {socket,calls,errors,events};
}
const lane=(h,action,index=0)=>h.calls.filter(call=>call.body.action===action)[index];
async function waitLane(h,action,index=0,virtual=false){await until(()=>!!lane(h,action,index),`${action} ${index}`,virtual);return lane(h,action,index);}
function assertPortalTimeout(h){assert.equal(h.errors.length,1);const error=h.errors[0];assert.equal(error.name,'TimeoutError');assert.equal(error.code,'RDP_MAILBOX_TIMEOUT');assert.equal(error.status,504);assert.match(error.message,/Nodiverna hat mehrere Remote-Desktop-Anfragen nicht rechtzeitig beantwortet/);assert.doesNotMatch(error.message,/abgebrochen/);assert.equal(h.socket.readyState,3);}
async function output(seq,plain){const iv=new Uint8Array(12);iv.set(new TextEncoder().encode('AGNT'));new DataView(iv.buffer).setBigUint64(4,BigInt(seq));return {seq,data:rdpBase64(new Uint8Array(await webcrypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(`ServerDesk:RDP:1:${id}:out:${seq}`)},key,plain)))};}

// Typed bridge timeout recovery must reuse the exact encrypted upload, whether
// the original name survives the bridge or only its code/status survive.
let h=harness({input:true});const first=await waitLane(h,'exchange'),cipher=structuredClone(first.body.frames);first.reject(timeoutError());const second=await waitLane(h,'exchange',1);assert.deepEqual(second.body.frames,cipher);second.reject(timeoutError(false));const third=await waitLane(h,'exchange',2);assert.deepEqual(third.body.frames,cipher);third.resolve(reply(1));await until(()=>h.socket.bufferedAmount===0,'recovered upload consumed');assert.equal(h.errors.length,0);assert.equal(h.socket.readyState,1);assert.equal(h.calls.filter(call=>call.body.action==='exchange').length,3);h.socket.close();await flush();

// Receive retries must keep the delivered-output ACK and deliver a recovered
// packet exactly once, rather than close on the new TimeoutError shape.
h=harness();(await waitLane(h,'receive')).reject(timeoutError(false));(await waitLane(h,'receive',1)).reject(timeoutError());const recovered=await waitLane(h,'receive',2);assert.equal(recovered.body.ack,0);recovered.resolve(reply(0,0,[await output(1,new Uint8Array([0x30,0]))]));await until(()=>h.events.length===1,'recovered output delivered');assert.deepEqual(h.events[0],new Uint8Array([0x30,0]));assert.equal((await waitLane(h,'receive',3)).body.ack,1);assert.equal(h.errors.length,0);h.socket.close();await flush();

for(const action of ['exchange','receive']){
 h=harness({input:true});let originalCipher;for(let i=0;i<3;i++){const call=await waitLane(h,action,i);if(action==='exchange'){if(i===0)originalCipher=structuredClone(call.body.frames);else assert.deepEqual(call.body.frames,originalCipher);}call.reject(timeoutError(i%2===0));}
 await until(()=>h.socket.readyState===3,`${action} timeout exhaustion`);assertPortalTimeout(h);assert.equal(h.calls.filter(call=>call.body.action===action).length,3,'the existing three-attempt bound is unchanged');assert.equal(lane(h,action==='exchange'?'receive':'exchange').signal.aborted,true,'exhaustion aborts the sibling lane');assert.equal(h.errors[0].cause.code,'RDP_BRIDGE_TIMEOUT');
}

// A timeout-looking error with an actual authorization status must remain a
// single fail-close. Protocol and cryptographic failures are never retried.
for(const error of [Object.assign(new TypeError('MFA fehlt.'),{status:403}),Object.assign(timeoutError(),{status:403})]){h=harness({input:true});(await waitLane(h,'exchange')).reject(error);await until(()=>h.socket.readyState===3,'authorization fail-close');assert.equal(h.errors[0],error);assert.equal(h.calls.filter(call=>call.body.action==='exchange').length,1);assert.notEqual(h.errors[0].code,'RDP_MAILBOX_TIMEOUT');}
h=harness();(await waitLane(h,'receive')).resolve(reply(1,1));await until(()=>h.socket.readyState===3,'forged ACK fail-close');assert.match(h.errors[0].message,/Transportantwort/);assert.equal(h.calls.filter(call=>call.body.action==='receive').length,1);assert.notEqual(h.errors[0].code,'RDP_MAILBOX_TIMEOUT');
const badCryptoError=timeoutError(),badCrypto={subtle:{encrypt:async()=>{throw badCryptoError;}}};h=harness({input:true,cryptoApi:badCrypto});await until(()=>h.socket.readyState===3,'preparation failure fail-close');assert.equal(h.errors[0],badCryptoError);assert.equal(h.calls.filter(call=>call.body.action==='exchange').length,0,'crypto preparation is outside the retryable request phase');
h=harness();const corrupted=await output(1,new Uint8Array([0x30,0]));const bytes=Buffer.from(corrupted.data,'base64');bytes[0]^=1;corrupted.data=bytes.toString('base64');(await waitLane(h,'receive')).resolve(reply(0,0,[corrupted]));await until(()=>h.socket.readyState===3,'GCM failure fail-close');assert.equal(h.errors[0].name,'OperationError');assert.equal(h.calls.filter(call=>call.body.action==='receive').length,1);assert.notEqual(h.errors[0].code,'RDP_MAILBOX_TIMEOUT');

// Exercise the mailbox's own ten-second deadline. The underlying bridge still
// reports AbortError for its signal; the lane must remember that this abort
// was a timeout and normalize it only after the same three-attempt limit.
mock.timers.enable({apis:['setTimeout']});
try{
 for(const duplex of [false,true]){const action=duplex?'receive':'exchange';h=harness({duplex});for(let i=0;i<3;i++){await waitLane(h,action,i,true);mock.timers.tick(10000);await flush();if(i<2){mock.timers.tick(500);await flush();}}
  await until(()=>h.socket.readyState===3,`${action} local deadline exhausted`,true);assertPortalTimeout(h);assert.equal(h.errors[0].cause.name,'AbortError');assert.equal(h.calls.filter(call=>call.body.action===action).length,3);
 }
 h=harness();const manual=await waitLane(h,'receive',0,true);h.socket.close();await flush();mock.timers.tick(60000);await flush();assert.equal(manual.signal.aborted,true);assert.equal(h.errors.length,0,'manual close does not show a timeout or aborted error');assert.equal(h.calls.filter(call=>call.body.action==='receive').length,1);
}finally{mock.timers.reset();}
h=harness({input:true});(await waitLane(h,'exchange')).reject(timeoutError());await flush();h.socket.close();await pause(550);assert.equal(h.errors.length,0,'manual close during timeout backoff stays silent');assert.equal(h.calls.filter(call=>call.body.action==='exchange').length,1,'manual close clears a scheduled retry');
console.log('PASS mailbox timeout: typed bridge and local-deadline retries, exact ciphertext/ACK, three-attempt limit, specific portal exhaustion, silent manual close, and no auth/protocol/crypto retries.');
