// The browser transport of Remote Desktop: the IronRDP boundary, flow control, cancellation, the RTC validators,
// encrypted offers, signals and portal deadlines.
import {germanLocale,germanLocalePath} from '../../support/locale-de.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {webcrypto} from 'node:crypto';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {i18nRequire} from '../../support/i18n-stubs.mjs';
const require=createRequire(import.meta.url),root=process.cwd(),cache=new Map();
function load(filename,moduleOverrides){
 const absolute=path.resolve(filename);if(absolute===germanLocalePath)return germanLocale;if(!moduleOverrides&&cache.has(absolute))return cache.get(absolute).exports;if(absolute.endsWith('.css'))return {};
 const entry={exports:{}};if(!moduleOverrides)cache.set(absolute,entry);
 const code=ts.transpileModule(fs.readFileSync(absolute,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
 function localRequire(id){const i18nStub=i18nRequire(id);if(i18nStub)return i18nStub;if(moduleOverrides&&Object.hasOwn(moduleOverrides,id))return moduleOverrides[id];if(id.startsWith('.')||id.startsWith('@/')){const base=id.startsWith('@/')?path.join(root,id.slice(2)):path.resolve(path.dirname(absolute),id),file=[base,base+'.ts',base+'.tsx',base+'.js',base+'/index.ts',base+'/index.tsx'].find(file=>fs.existsSync(file)&&fs.statSync(file).isFile());if(file)return load(file);}return require(id);}
 new Function('require','module','exports',code)(localRequire,entry,entry.exports);return entry.exports;
}
const {createRdpKey,encryptRdpFrame,decryptRdpFrame,rdpBase64,rdpUnbase64}=load('ui/devices/remote/rdp-crypto.ts');
const {createRdpWebSocket,RdpInitialBoundary}=load('ui/devices/remote/rdp-transport.ts');
const {connectionError}=load('ui/devices/remote/remote-desktop-client.tsx');
const RemoteDesktopClient=load('ui/devices/remote/remote-desktop-client.tsx').default;
const {validatedRdpBridge,rdpAvailable,rdpLogonAccount,RDP_BRIDGE,RDP_CANCEL,RDP_BRIDGE_PROTOCOL,createRdpChildBridge}=load('ui/devices/remote/rdp-bridge.ts');
const {watchRemoteDesktopActivity}=load('ui/session/session-activity.ts');
const PausedRdpPanel=load('ui/devices/remote/rdp-panel.tsx').default;
// Preserve the enabled UI's security checks in an isolated module fixture while
// independently checking the production feature switch's paused UI below.
const RdpPanel=load('ui/devices/remote/rdp-panel.tsx',{'@/lib/rdp-feature':{...load('lib/rdp-feature.ts'),REMOTE_DESKTOP_AVAILABLE:true}}).default;
const id='11111111-1111-4111-8111-111111111111',serverId='22222222-2222-4222-8222-222222222222';
const rsa=await webcrypto.subtle.generateKey({name:'RSA-OAEP',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['encrypt','decrypt']);
const generated=await createRdpKey(id,await webcrypto.subtle.exportKey('jwk',rsa.publicKey),webcrypto);
assert.equal(generated.key.extractable,false,'session key is not exportable');
const secret=JSON.parse(new TextDecoder().decode(await webcrypto.subtle.decrypt('RSA-OAEP',rsa.privateKey,rdpUnbase64(generated.keyEnvelope,256))));
assert.equal(secret.id,id);assert.equal(rdpUnbase64(secret.key,32).length,32);assert.deepEqual(Object.keys(secret).sort(),['id','key'],'sealed key contains no Windows credentials');
const peerKey=await webcrypto.subtle.importKey('raw',rdpUnbase64(secret.key,32),'AES-GCM',false,['encrypt','decrypt']);
function context(seq,direction){const iv=new Uint8Array(12);iv.set(new TextEncoder().encode(direction==='in'?'CLNT':'AGNT'));new DataView(iv.buffer).setBigUint64(4,BigInt(seq));return {name:'AES-GCM',iv,additionalData:new TextEncoder().encode(`ServerDesk:RDP:1:${id}:${direction}:${seq}`),tagLength:128};}
const output=async(seq,bytes)=>({seq,data:rdpBase64(new Uint8Array(await webcrypto.subtle.encrypt(context(seq,'out'),peerKey,bytes)))});
const input=await encryptRdpFrame(generated.key,id,1,new Uint8Array([3,0,0,19]),webcrypto);
assert.deepEqual(new Uint8Array(await webcrypto.subtle.decrypt(context(1,'in'),peerKey,rdpUnbase64(input.data))),new Uint8Array([3,0,0,19]));
await assert.rejects(decryptRdpFrame(generated.key,id,input,webcrypto),'direction-separated nonce/AAD rejects reflection');
await assert.rejects(encryptRdpFrame(generated.key,id,0,new Uint8Array([1]),webcrypto));
await assert.rejects(encryptRdpFrame(generated.key,id,1,new Uint8Array(16385),webcrypto));
assert.throws(()=>rdpUnbase64('AAA=',1));assert.throws(()=>rdpUnbase64('AA-_'));

const der=new Uint8Array(20004);der.set([0x30,0x82,0x4e,0x20]);der.fill(7,4);
const boundary=new RdpInitialBoundary();assert.deepEqual(boundary.accept(der.slice(0,1)),[]);assert.deepEqual(boundary.accept(der.slice(1,16000)),[]);
const combined=new Uint8Array(der.length-16000+3);combined.set(der.slice(16000));combined.set([3,0,1],der.length-16000);
const packets=boundary.accept(combined);assert.equal(packets.length,2);assert.deepEqual(packets[0],der);assert.deepEqual(packets[1],new Uint8Array([3,0,1]));assert.deepEqual(boundary.accept(new Uint8Array([9])),[new Uint8Array([9])]);
for(const value of [[0x31,0],[0x30,0x80],[0x30,0x82,0,128],[0x30,0x83,1,0,0]])assert.throws(()=>new RdpInitialBoundary().accept(new Uint8Array(value)),'invalid/canonical/oversized initial DER rejected');

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async(predicate,label)=>{for(let i=0;i<200;i++){if(predicate())return;await pause(5);}throw new Error('Timed out: '+label);};
function harness(options={}){const calls=[],events=[],errors=[];const request=(body,signal)=>new Promise((resolve,reject)=>{calls.push({body,resolve,reject,signal});signal?.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});});const Socket=createRdpWebSocket({id,key:generated.key,request,crypto:webcrypto,onFailure:error=>errors.push(error),...options}),socket=new Socket('wss://portal.example/serverdesk-rdp');socket.binaryType='arraybuffer';socket.addEventListener('message',event=>events.push(new Uint8Array(event.data)));return {calls,events,errors,socket,Socket};}
const response=(frames=[],inputAck=0,outputAck=0)=>({id,state:'open',inputAck,outputAck,frames,intervalMs:1000});
let h=harness();await until(()=>h.calls.length===1,'initial poll');assert.throws(()=>new h.Socket('wss://portal.example/serverdesk-rdp'),'one socket per session/key');
const first=await output(1,der.slice(0,16000)),second=await output(2,der.slice(16000)),third=await output(3,new Uint8Array([3,0,9]));
h.calls[0].resolve(response([first,second,third]));await until(()=>h.events.length===2,'DER reassembly and next packet');assert.deepEqual(h.events[0],der);assert.deepEqual(h.events[1],new Uint8Array([3,0,9]));
const nextInput=async(h,start=1,inputAck=0)=>{let index=start;for(let i=0;i<100;i++){const call=h.calls[index];if(call){if(call.body.frames?.length)return {call,index};call.resolve(response([],inputAck,call.body.ack));index++;}await pause(5);}throw new Error('Timed out: queued input');};
const openStream=async h=>{await until(()=>h.calls.length===1,'stream initial');h.calls[0].resolve(response());h.socket.send(new Blob([new Uint8Array([0x30,0])]));const initial=await nextInput(h);assert.equal(initial.call.body.frames.length,1);initial.call.resolve(response([],1));await until(()=>h.socket.bufferedAmount===0,'stream handshake ack');return initial.index;};
h.socket.send(new Uint8Array([1,2,3]));const firstInput=await nextInput(h);assert.equal(firstInput.call.body.ack,3);assert.equal(firstInput.call.body.frames.length,1);const sent=firstInput.call.body.frames[0];
firstInput.call.reject(new TypeError('network unavailable'));await until(()=>h.calls.length>firstInput.index+1,'identical retry');const retry=h.calls[firstInput.index+1];assert.deepEqual(retry.body.frames,[sent],'transport loss retries exact cipher, never re-encrypts sequence');
retry.resolve(response([third],1,3));await until(()=>h.socket.bufferedAmount===0,'input ack');assert.equal(h.events.length,2,'unchanged duplicate output not rendered twice');
h.socket.send(new Uint8Array([4]));const secondInput=await nextInput(h,firstInput.index+2,1);secondInput.call.resolve(response([{...third,data:third.data.slice(0,-4)+'AAAA'}],1,3));await until(()=>h.socket.readyState===3,'changed retry closes');assert.match(h.errors[0].message,/verändert/);

h=harness();const flowIndex=await openStream(h);h.socket.send(new Uint8Array(64*16384));await until(()=>h.calls.length===flowIndex+2,'credit batch');assert.equal(h.calls[flowIndex+1].body.frames.length,16,'each exchange capped at sixteen frames');assert.equal(h.socket.bufferedAmount,64*16384);let closed;h.socket.onclose=event=>{closed=event;};h.socket.send(new Uint8Array([1]));await until(()=>!!closed,'byte capacity exhaustion close');assert.equal(closed.code,1011);assert.equal(closed.wasClean,false);assert.equal(h.socket.bufferedAmount,0);assert.ok(h.calls.some(call=>call.body.action==='close'));

h=harness();await until(()=>h.calls.length===1,'gap initial');h.calls[0].resolve(response([await output(2,new Uint8Array([0x30,1,0]))]));await until(()=>h.socket.readyState===3,'output gap closes');assert.match(h.errors[0].message,/unterwegs verloren gegangen/);
h=harness();await until(()=>h.calls.length===1,'invalid ack initial');h.calls[0].resolve(response([],1));await until(()=>h.socket.readyState===3,'unsent input ack closes');assert.match(h.errors[0].message,/Transportantwort/);
h=harness();await until(()=>h.calls.length===1,'auth initial');h.calls[0].reject(Object.assign(new Error('MFA abgelaufen'),{status:403}));await until(()=>h.socket.readyState===3,'auth closes');assert.equal(h.calls.filter(call=>call.body.action==='exchange').length,1,'authentication failures are not retried');

// Real IronRDP uses Blob. A slow conversion must preserve synchronous byte
// accounting and ordering against subsequent Blob and typed-array sends.
let releaseBlob;const blobReady=new Promise(resolve=>{releaseBlob=resolve;});
class DelayedBlob extends Blob{slice(start,end){return new DelayedBlob([super.slice(start,end)]);}async arrayBuffer(){await blobReady;return super.arrayBuffer();}}
h=harness();const blobIndex=await openStream(h);
const blobBytes=new Uint8Array(16385);blobBytes.fill(42);h.socket.send(new DelayedBlob([blobBytes]));h.socket.send(new Uint8Array([7,8]));
assert.equal(h.socket.bufferedAmount,16387);await pause(10);assert.equal(h.calls.length,blobIndex+1,'pending Blob cannot be overtaken by later sends');releaseBlob();
const blobInput=await nextInput(h,blobIndex+1,1);assert.deepEqual(blobInput.call.body.frames.map(frame=>frame.seq),[2,3]);
const blobPlain=await Promise.all(blobInput.call.body.frames.map(async frame=>new Uint8Array(await webcrypto.subtle.decrypt(context(frame.seq,'in'),peerKey,rdpUnbase64(frame.data)))));
assert.deepEqual(blobPlain.map(bytes=>bytes.length),[16384,3]);assert.equal(blobPlain[0][0],42);assert.deepEqual(blobPlain[1],new Uint8Array([42,7,8]),'later opaque stream writes coalesce without reordering');
blobInput.call.resolve(response([],3));await until(()=>h.socket.bufferedAmount===0,'blob ack');h.socket.close();
h=harness();await openStream(h);h.socket.send(new Blob([new Uint8Array(64*16384)]));assert.equal(h.socket.bufferedAmount,64*16384);h.socket.send(new Blob([new Uint8Array([1])]));await until(()=>h.socket.readyState===3,'blob byte capacity closes');assert.match(h.errors[0].message,/überlastet/,'Blob reserves byte capacity before asynchronous conversion');
h=harness();await until(()=>h.calls.length===1,'oversized cleanpath initial');h.socket.send(new Blob([new Uint8Array(16385)]));await until(()=>h.socket.readyState===3,'oversized cleanpath closes');assert.match(h.errors[0].message,/Verhandlungsanforderung/,'first CleanPath request must fit the native single-frame limit');

// Tiny SDK Blob writes previously exhausted CREDIT while only a few hundred
// bytes were pending. Exercise a full retained window, then a large input
// burst during delayed ACKs. Staging must be byte-bounded and drain in order.
h=harness();let stressIndex=await openStream(h),pendingStress;const expectedStress=[],stressFrames=new Map();
const rememberFrames=async call=>{assert.ok(call.body.frames.length<=16);for(const frame of call.body.frames){if(stressFrames.has(frame.seq)){assert.equal(stressFrames.get(frame.seq).cipher,frame.data,'retry ciphertext stays identical');continue;}const bytes=new Uint8Array(await webcrypto.subtle.decrypt(context(frame.seq,'in'),peerKey,rdpUnbase64(frame.data)));assert.ok(bytes.length<=16384);stressFrames.set(frame.seq,{cipher:frame.data,bytes});}};
for(let i=0;i<64;i++){h.socket.send(new Blob([new Uint8Array([i])]));expectedStress.push(i);pendingStress=await nextInput(h,stressIndex+1,1);stressIndex=pendingStress.index;await rememberFrames(pendingStress.call);if(i<63)pendingStress.call.resolve(response([],1));}
for(let i=0;i<2000;i++){const bytes=new Uint8Array([i&255,i>>8,7,8]);h.socket.send(i%2?new Blob([bytes]):bytes);expectedStress.push(...bytes);}
assert.equal(h.socket.readyState,1,'SDK write count does not exhaust the remote frame window');assert.equal(h.errors.length,0);assert.equal(h.socket.bufferedAmount,8064,'bufferedAmount counts actual bytes, including retained and staged input');
pendingStress.call.resolve(response([],pendingStress.call.body.frames.at(-1).seq));
for(let i=0;i<10&&h.socket.bufferedAmount;i++){const next=await nextInput(h,stressIndex+1,1);stressIndex=next.index;await rememberFrames(next.call);next.call.resolve(response([],next.call.body.frames.at(-1).seq));await pause(5);}
await until(()=>h.socket.bufferedAmount===0,'tiny-write burst drains');assert.equal(h.socket.readyState,1);assert.equal(stressFrames.size,65,'two thousand queued writes coalesce into one stream frame behind the retained window');
const actualStress=Array.from(stressFrames.entries()).sort((a,b)=>a[0]-b[0]).flatMap(([,frame])=>Array.from(frame.bytes));assert.deepEqual(actualStress,expectedStress,'all staged SDK bytes drain exactly once and in order');h.socket.close();

// The first proxy request remains standalone even if subsequent stream bytes
// arrive in the same JavaScript turn before conversion/encryption begins.
h=harness();await until(()=>h.calls.length===1,'first-message boundary initial');h.calls[0].resolve(response());h.socket.send(new Blob([new Uint8Array([0x30,0])]));h.socket.send(new Blob([new Uint8Array([3,4])]));h.socket.send(new Uint8Array([5,6]));const boundaryInput=await nextInput(h);const boundaryPlain=await Promise.all(boundaryInput.call.body.frames.map(async frame=>new Uint8Array(await webcrypto.subtle.decrypt(context(frame.seq,'in'),peerKey,rdpUnbase64(frame.data)))));assert.deepEqual(boundaryPlain,[new Uint8Array([0x30,0]),new Uint8Array([3,4,5,6])]);h.socket.close();

const dualResponse=(frames=[],inputAck=0,inputStored=inputAck,outputAck=0)=>({...response(frames,inputAck,outputAck),inputStored});
const lane=(h,action,index=0)=>h.calls.filter(call=>call.body.action===action)[index];
const waitLane=async(h,action,index=0)=>{await until(()=>!!lane(h,action,index),`${action} lane ${index}`);return lane(h,action,index);};
// A blocked receive long-poll must not serialize keyboard/mouse input behind
// screen reception. Portal storage opens the next upload batch, but only the
// agent's consumed ACK frees the ciphertext/byte window.
h=harness({duplex:true});const receive0=await waitLane(h,'receive');assert.equal(receive0.body.waitMs,600);assert.equal(receive0.body.inputAck,0);h.socket.send(new Blob([new Uint8Array([0x30,0])]));const upload0=await waitLane(h,'exchange');assert.equal(upload0.body.receive,false);assert.equal(receive0.signal.aborted,false,'input starts while reception is blocked');upload0.resolve(dualResponse([],0,1));await pause(20);assert.equal(h.socket.bufferedAmount,2,'stored input stays retained until native consumption');assert.equal(h.calls.filter(call=>call.body.action==='exchange').length,1,'stored input is not idle-polled or resent');
receive0.resolve(dualResponse([],0,0));const receive1=await waitLane(h,'receive',1);assert.equal(h.socket.readyState,1,'older concurrent storage snapshot cannot rewind state');h.socket.send(new Uint8Array(63*16384));
for(let batch=0;batch<4;batch++){const call=await waitLane(h,'exchange',batch+1),start=2+batch*16,end=Math.min(64,start+15);assert.deepEqual(call.body.frames.map(frame=>frame.seq),Array.from({length:end-start+1},(_,i)=>start+i),'each committed batch advances without waiting for consumption');call.resolve(dualResponse([],0,end));}
await pause(20);assert.equal(h.socket.bufferedAmount,2+63*16384);assert.equal(h.calls.filter(call=>call.body.action==='exchange').length,5,'all64 stored frames wait for native credit without upload polling');h.socket.send(new Uint8Array([9,10]));await pause(20);assert.equal(h.calls.filter(call=>call.body.action==='exchange').length,5,'staging cannot exceed64 retained cipher frames');
receive1.resolve(dualResponse([],17,64));const upload65=await waitLane(h,'exchange',5),receive2=await waitLane(h,'receive',2);assert.deepEqual(upload65.body.frames.map(frame=>frame.seq),[65],'consumption feedback wakes sender during next receive long-poll');assert.equal(receive2.body.inputAck,17);
receive2.resolve(dualResponse([],65,65));await until(()=>h.socket.bufferedAmount===0,'receiver consumption frees bytes');upload65.resolve(dualResponse([],17,65));await pause(20);assert.equal(h.socket.readyState,1);assert.equal(h.socket.bufferedAmount,0,'older upload ACK cannot free the same bytes twice');assert.equal(h.errors.length,0);
const receive3=await waitLane(h,'receive',3);receive3.resolve(dualResponse([first],65,65));const receive4=await waitLane(h,'receive',4);assert.equal(h.events.length,0);receive4.resolve(dualResponse([second,third],65,65,1));await until(()=>h.events.length===2,'duplex output preserves DER boundary and sequence');assert.deepEqual(h.events[0],der);const receive5=await waitLane(h,'receive',5);assert.equal(receive5.body.ack,3);receive5.resolve(dualResponse([third],17,64));const receive6=await waitLane(h,'receive',6);assert.equal(h.events.length,2,'unchanged output replay is not delivered twice');assert.equal(h.socket.bufferedAmount,0);receive6.resolve(dualResponse([{...third,data:third.data.slice(0,-4)+'AAAA'}],65,65,3));await until(()=>h.socket.readyState===3,'duplex changed output replay closes');assert.match(h.errors[0].message,/verändert/);

h=harness({duplex:true});const retryReceive=await waitLane(h,'receive');h.socket.send(new Uint8Array([0x30,0]));const dualInput=await waitLane(h,'exchange'),dualCipher=dualInput.body.frames;dualInput.reject(new TypeError('temporary network failure'));const dualRetry=await waitLane(h,'exchange',1);assert.deepEqual(dualRetry.body.frames,dualCipher,'duplex retries original ciphertext');assert.equal(retryReceive.signal.aborted,false,'sender network retry does not cancel screen reception');dualRetry.resolve(dualResponse([],0,1));await pause(20);const callsBeforeClose=h.calls.length;h.socket.close();await pause(20);assert.equal(retryReceive.signal.aborted,true);assert.equal(h.calls.length,callsBeforeClose+1,'close clears both lane timers and creates only one close request');
h=harness({duplex:true});const abortReceive=await waitLane(h,'receive');h.socket.send(new Uint8Array([0x30,0]));const abortUpload=await waitLane(h,'exchange');h.socket.close();await pause(20);assert.equal(abortReceive.signal.aborted,true);assert.equal(abortUpload.signal.aborted,true,'close aborts both in-flight HTTP requests');

for(const invalid of [{inputAck:1,inputStored:1},{inputAck:0,inputStored:1},{inputAck:1,inputStored:0}]){h=harness({duplex:true});const call=await waitLane(h,'receive');call.resolve({...dualResponse(),...invalid});await until(()=>h.socket.readyState===3,'duplex forged ACK/stored closes');assert.match(h.errors[0].message,/Transportantwort/);}
h=harness({duplex:true});const gapReceive=await waitLane(h,'receive');gapReceive.resolve(dualResponse([await output(2,new Uint8Array([0x30,0]))]));await until(()=>h.socket.readyState===3,'duplex output gap closes');assert.match(h.errors[0].message,/unterwegs verloren gegangen/);
h=harness({duplex:true});await waitLane(h,'receive');h.socket.send(new Uint8Array([0x30,0]));const invalidSender=await waitLane(h,'exchange');invalidSender.resolve(dualResponse([first],0,1));await until(()=>h.socket.readyState===3,'sender cannot deliver screen bytes');assert.equal(h.events.length,0);assert.match(h.errors[0].message,/Transportantwort/);

let releaseDualBlob;const dualBlobReady=new Promise(resolve=>{releaseDualBlob=resolve;});class DelayedDualBlob extends Blob{slice(start,end){return new DelayedDualBlob([super.slice(start,end)]);}async arrayBuffer(){await dualBlobReady;return super.arrayBuffer();}}
h=harness({duplex:true});const delayedReceive=await waitLane(h,'receive');h.socket.send(new DelayedDualBlob([new Uint8Array([0x30,0])]));h.socket.send(new Uint8Array([1,2]));await pause(20);assert.equal(h.calls.filter(call=>call.body.action==='exchange').length,0);assert.equal(delayedReceive.signal.aborted,false);releaseDualBlob();const delayedUpload=await waitLane(h,'exchange');const delayedPlain=await Promise.all(delayedUpload.body.frames.map(async frame=>new Uint8Array(await webcrypto.subtle.decrypt(context(frame.seq,'in'),peerKey,rdpUnbase64(frame.data)))));assert.deepEqual(delayedPlain,[new Uint8Array([0x30,0]),new Uint8Array([1,2])],'independent lanes preserve delayed Blob order');h.socket.close();

// Exercise the SDK's transport boundary with its pinned RDCleanPath request.
// Node EventTarget plus a synthetic canvas is not a browser engine environment:
// IronRDP's WASM drops its error closure before a queued close event can arrive.
// These transport tests own the Blob/events fixture; browser engine integration
// belongs in a real browser. Crypto, native bytes and cleanup remain real here.
const cleanPathBase64='MG6gBAICDT6iEAwObG9jYWxob3N0OjMzODmjJgwkMTExMTExMTEtMTExMS00MTExLTgxMTEtMTExMTExMTExMTExpiwEKgMAACol4AAAAAAAQ29va2llOiBtc3RzaGFzaD10ZXN0DQoBAAgACwAAAA==';
function sdkConnectionFixture(Socket){
 const socket=new Socket('wss://portal.example/serverdesk-rdp');
 const result=new Promise((resolve,reject)=>{
  const cleanup=()=>{socket.removeEventListener('open',opened);socket.removeEventListener('error',failed);socket.removeEventListener('close',closed);};
  const opened=()=>{socket.send(new Blob([Buffer.from(cleanPathBase64,'base64')]));};
  const failed=()=>{cleanup();reject(new Error('SDK fixture: WebSocket transport failed.'));};
  const closed=()=>{cleanup();reject(new Error('SDK fixture: WebSocket closed before RDP negotiation.'));};
  socket.addEventListener('open',opened,{once:true});socket.addEventListener('error',failed,{once:true});socket.addEventListener('close',closed,{once:true});
 });
 return {socket,result};
}
let sdkSocket,sdkBlob=false,sdkRequest,transportFailure='';const nativeFailure='Windows-RDP-Listener ist nicht erreichbar.';
try{
 for(const duplex of [false,true]){
 sdkBlob=false;sdkRequest=undefined;transportFailure='';
 const Socket=createRdpWebSocket({id,key:generated.key,crypto:webcrypto,duplex,onFailure:error=>{transportFailure=error.message;},request:async(body,signal)=>{
  if(body.action==='close')return {};
  if(body.action==='receive')return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}));
  if(body.frames.length){assert.equal(body.frames.length,1);const frame=body.frames[0];sdkRequest=new Uint8Array(await webcrypto.subtle.decrypt(context(frame.seq,'in'),peerKey,rdpUnbase64(frame.data)));return {...dualResponse([],frame.seq,frame.seq,body.ack),state:'error',error:nativeFailure};}
  return response([],0,body.ack);
 }});
 const fixture=sdkConnectionFixture(class extends Socket{send(data){sdkBlob=data instanceof Blob;return super.send(data);}});sdkSocket=fixture.socket;
 const sdkError=await fixture.result.then(()=>assert.fail('fixture must close after sending the pinned handshake'),error=>error);
 assert.equal(sdkBlob,true,'SDK boundary sends its handshake as Blob');assert.equal(sdkRequest?.[0],0x30,'encrypted SDK boundary request reaches the agent as DER');
 assert.equal(Buffer.from(sdkRequest).toString('base64'),cleanPathBase64,'encrypted and decrypted request matches the pinned native RDCleanPath contract');
 assert.equal(Buffer.from(sdkRequest).includes(Buffer.from('fixture-secret')),false,'Windows password is absent from the initial proxy request');
 assert.equal(sdkSocket.readyState,3);assert.equal(transportFailure,nativeFailure,'agent error is reported before SDK generic rejection');assert.equal(connectionError(sdkError,transportFailure),nativeFailure,'SDK generic catch preserves the specific transport cause');assert.equal(connectionError({kind:()=>1}),'Die Windows-Anmeldung ist fehlgeschlagen. Prüfe Benutzername und Passwort.');
 }
}finally{sdkSocket?.close();}

const owned=new Set([id]);assert.deepEqual(validatedRdpBridge({action:'metadata',serverId},serverId,owned),{action:'metadata',serverId});assert.equal(validatedRdpBridge({action:'metadata',serverId:id},serverId,owned),null);assert.equal(validatedRdpBridge({action:'open',id,serverId,keyEnvelope:generated.keyEnvelope,password:'secret'},serverId,owned),null);assert.equal(validatedRdpBridge({action:'close',id:serverId},serverId,owned),null);assert.equal(validatedRdpBridge({action:'exchange',id,ack:0,frames:new Array(17).fill(input)},serverId,owned),null);assert.deepEqual(validatedRdpBridge({action:'exchange',id,ack:0,frames:[input]},serverId,owned),{action:'exchange',id,ack:0,frames:[input]});
const rtcOffer=Buffer.alloc(32,7).toString('base64'),rtcOpen={action:'open',id,serverId,keyEnvelope:generated.keyEnvelope,transport:'webrtc',offer:rtcOffer};
assert.deepEqual(validatedRdpBridge(rtcOpen,serverId,owned),rtcOpen,'RTC open retains only the device-scoped encrypted offer and key');assert.deepEqual(validatedRdpBridge({action:'signal',id},serverId,owned),{action:'signal',id});
for(const invalid of [{serverId:id},{id:'not-a-guid'},{transport:'websocket'},{offer:''},{offer:'AAAA'},{offer:Buffer.alloc(16).toString('base64')},{offer:Buffer.alloc(49153).toString('base64')},{offer:rtcOffer.slice(0,-1)},{offer:'!'.repeat(24)},{offer:Buffer.alloc(17).toString('base64').slice(0,-2)+'B='},{password:'secret'},{candidates:[]}])assert.equal(validatedRdpBridge({...rtcOpen,...invalid},serverId,owned),null,'RTC open rejects wrong scope, unsupported transport, oversize/noncanonical ciphertext or extra fields');
const missingOffer={...rtcOpen};delete missingOffer.offer;assert.equal(validatedRdpBridge(missingOffer,serverId,owned),null);const missingTransport={...rtcOpen};delete missingTransport.transport;assert.equal(validatedRdpBridge(missingTransport,serverId,owned),null);
for(const invalid of [{id:serverId},{id:'bad'},{offer:rtcOffer},{password:'secret'},{serverId},{ack:0}])assert.equal(validatedRdpBridge({action:'signal',id,...invalid},serverId,owned),null,'signal is limited to exactly one owned session');
assert.deepEqual(validatedRdpBridge({action:'open',id,serverId,keyEnvelope:generated.keyEnvelope},serverId,owned),{action:'open',id,serverId,keyEnvelope:generated.keyEnvelope},'legacy open remains explicitly compatible');
assert.deepEqual(validatedRdpBridge({action:'exchange',id,ack:0,frames:[input],receive:false},serverId,owned),{action:'exchange',id,ack:0,frames:[input],receive:false});assert.equal(validatedRdpBridge({action:'exchange',id,ack:0,frames:[],receive:true},serverId,owned),null);
assert.deepEqual(validatedRdpBridge({action:'receive',id,ack:3,waitMs:600},serverId,owned),{action:'receive',id,ack:3,waitMs:600});assert.deepEqual(validatedRdpBridge({action:'receive',id,ack:3,inputAck:17,waitMs:600},serverId,owned),{action:'receive',id,ack:3,inputAck:17,waitMs:600});
for(const badReceive of [{id:serverId},{ack:-1},{ack:1.5},{waitMs:601},{waitMs:-1},{waitMs:0.5},{inputAck:-1},{inputAck:Number.MAX_SAFE_INTEGER+1},{frames:[]},{password:'secret'}])assert.equal(validatedRdpBridge({action:'receive',id,ack:0,waitMs:600,...badReceive},serverId,owned),null,'receive validates owner, ACK hint, wait bound and exact fields');
// Test the actual child message bridge without a browser session. Responses
// must match origin, parent Window, device and request correlation independently.
const previousWindow=globalThis.window,fakeWindow=new EventTarget(),sentMessages=[],parentWindow={postMessage(data,origin){sentMessages.push({data,origin});}};
Object.assign(fakeWindow,{location:{origin:'https://portal.example'},parent:parentWindow});globalThis.window=fakeWindow;
try{
 assert.equal(RDP_BRIDGE_PROTOCOL,2);const bridge=createRdpChildBridge(serverId),request=bridge.request({action:'metadata',serverId});assert.equal(bridge.protocol,0,'a new child cannot assume its parent protocol');assert.equal(sentMessages.length,1);const sent=sentMessages[0];assert.equal(sent.origin,'https://portal.example');
 const dispatch=overrides=>fakeWindow.dispatchEvent(Object.assign(new Event('message'),{origin:'https://portal.example',source:parentWindow,data:{type:RDP_BRIDGE,serverId,requestId:sent.data.requestId,ok:true,result:{hostname:'SRV-RDP'}},...overrides}));
 let completed=false;void request.then(()=>{completed=true;});const spoofEnvelope={type:RDP_BRIDGE,serverId,requestId:sent.data.requestId,bridgeProtocol:2,ok:true,result:{hostname:'wrong'}};dispatch({origin:'https://evil.example',data:spoofEnvelope});dispatch({source:{},data:spoofEnvelope});dispatch({data:{...spoofEnvelope,serverId:id}});dispatch({data:{...spoofEnvelope,requestId:crypto.randomUUID()}});await pause(5);assert.equal(completed,false,'spoofed replies cannot settle a bridge request');assert.equal(bridge.protocol,0,'spoofed protocol envelopes cannot upgrade the parent capability');dispatch({data:{type:RDP_BRIDGE,serverId,requestId:sent.data.requestId,ok:true,result:{hostname:'SRV-RDP',bridgeProtocol:2,availability:{webrtcCapable:true}}}});assert.deepEqual(await request,{hostname:'SRV-RDP',bridgeProtocol:2,availability:{webrtcCapable:true}});assert.equal(bridge.protocol,0,'new backend metadata does not advertise an old parent bridge protocol');dispatch({data:spoofEnvelope});assert.equal(bridge.protocol,0,'settled request correlations cannot later change the protocol');
 const protocolReply=async envelope=>{const pending=bridge.request({action:'metadata',serverId}),requestId=sentMessages.at(-1).data.requestId;fakeWindow.dispatchEvent(Object.assign(new Event('message'),{origin:'https://portal.example',source:parentWindow,data:{type:RDP_BRIDGE,serverId,requestId,ok:true,result:{hostname:'SRV-RDP'},...envelope}}));await pending;};
 await protocolReply({bridgeProtocol:2});assert.equal(bridge.protocol,2,'only a matched parent envelope upgrades the bridge');await protocolReply({bridgeProtocol:'2'});assert.equal(bridge.protocol,0,'noninteger protocol values are rejected');await protocolReply({bridgeProtocol:2.5});assert.equal(bridge.protocol,0);await protocolReply({});assert.equal(bridge.protocol,0,'a matched legacy reply resets capability');await protocolReply({bridgeProtocol:2});assert.equal(bridge.protocol,2);
 const pending=[];for(let i=0;i<4;i++)pending.push(bridge.request({action:'metadata',serverId}));const pendingIds=sentMessages.slice(-4).map(item=>item.data.requestId),settled=pending.map(p=>p.catch(error=>error));await assert.rejects(bridge.request({action:'metadata',serverId}),/gleichzeitige/);bridge.dispose();const failures=await Promise.all(settled);assert.ok(failures.every(error=>error.name==='AbortError'),'unmount rejects and removes every pending request');assert.deepEqual(sentMessages.slice(-4).map(item=>({type:item.data.type,requestId:item.data.requestId,serverId:item.data.serverId,origin:item.origin})),pendingIds.map(requestId=>({type:RDP_CANCEL,requestId,serverId,origin:'https://portal.example'})),'unmount cancels each scoped parent HTTP request');await assert.rejects(bridge.request({action:'metadata',serverId}),{name:'AbortError'});
 const cancelBridge=createRdpChildBridge(serverId),controller=new AbortController(),cancelRequest=cancelBridge.request({action:'receive',id,ack:0,inputAck:0,waitMs:600},controller.signal),cancelRequestId=sentMessages.at(-1).data.requestId;controller.abort();await assert.rejects(cancelRequest,{name:'AbortError',message:'Die Remote-Desktop-Anfrage wurde abgebrochen.'});assert.deepEqual(sentMessages.at(-1),{data:{type:RDP_CANCEL,serverId,requestId:cancelRequestId},origin:'https://portal.example'},'AbortSignal cancels parent long-poll by request correlation');const cancelCount=sentMessages.length;cancelBridge.dispose();assert.equal(sentMessages.length,cancelCount,'dispose does not repeat already completed cancellation');
 const oldSetTimeout=globalThis.setTimeout,oldClearTimeout=globalThis.clearTimeout;let fireTimeout;
 try{globalThis.setTimeout=(callback,ms)=>{assert.equal(ms,12000);fireTimeout=callback;return 1;};globalThis.clearTimeout=()=>{};const timeoutBridge=createRdpChildBridge(serverId),timeoutRequest=timeoutBridge.request({action:'receive',id,ack:0,waitMs:600}),timeoutRequestId=sentMessages.at(-1).data.requestId;fireTimeout();await assert.rejects(timeoutRequest,{name:'TimeoutError',code:'RDP_BRIDGE_TIMEOUT',status:504});assert.deepEqual(sentMessages.at(-1),{data:{type:RDP_CANCEL,serverId,requestId:timeoutRequestId},origin:'https://portal.example'},'bridge timeout cancels parent HTTP instead of leaving a live receive');timeoutBridge.dispose();}finally{globalThis.setTimeout=oldSetTimeout;globalThis.clearTimeout=oldClearTimeout;}
}finally{if(previousWindow===undefined)delete globalThis.window;else globalThis.window=previousWindow;}
assert.equal(rdpAvailable({online:true,capable:true,management:true,enabled:true,policyBlocked:false,reason:null}),true);assert.equal(rdpAvailable({enabled:false,reason:'Windows RDP ist deaktiviert.'}),false);assert.equal(rdpAvailable(undefined),false);
let listener,interactions=0;const child={},watch=watchRemoteDesktopActivity({addEventListener(type,fn){listener=fn;},removeEventListener(){}},'https://portal.example',()=>[{contentWindow:child,serverId}],()=>true,()=>interactions++);
listener({isTrusted:true,origin:'https://evil.example',source:child,data:{type:'serverdesk:rdp:activity',serverId}});listener({isTrusted:true,origin:'https://portal.example',source:{},data:{type:'serverdesk:rdp:activity',serverId}});listener({isTrusted:true,origin:'https://portal.example',source:child,data:{type:'serverdesk:rdp:activity',serverId:id}});assert.equal(interactions,0);listener({isTrusted:true,origin:'https://portal.example',source:child,data:{type:'serverdesk:rdp:activity',serverId}});assert.equal(interactions,1);listener({isTrusted:false,origin:'https://portal.example',source:child,data:{type:'serverdesk:rdp:activity',serverId}});assert.equal(interactions,1,'synthetic matching message is not trusted activity');watch();
assert.deepEqual(rdpLogonAccount('user',true,'ignored','SRV-RDP'),{username:'user',domain:'SRV-RDP'});assert.deepEqual(rdpLogonAccount('.\\user',false,'stale','SRV-RDP'),{username:'user',domain:'SRV-RDP'});assert.deepEqual(rdpLogonAccount('user@example.test',false,'stale','SRV-RDP'),{username:'user@example.test',domain:''});assert.deepEqual(rdpLogonAccount('EXAMPLE\\user',true,'stale','SRV-RDP'),{username:'user',domain:'EXAMPLE'});assert.throws(()=>rdpLogonAccount('a\\b\\c',false,'','SRV-RDP'));
const server={id:serverId,name:'SRV-RDP',lastSeen:Date.now(),management:1,snapshot:{mode:'Management',agentCapabilities:['rdp-browser','set-rdp']}},viewer={id:'viewer',label:'Viewer',permissions:[]};
const pausedHtml=renderToStaticMarkup(React.createElement(PausedRdpPanel,{server,viewer,demo:false}));assert.match(pausedHtml,/Remote Desktop ist vorübergehend pausiert/);assert.doesNotMatch(pausedHtml,/<iframe|Remote Desktop öffnen|Remote Desktop aktivieren|RDP aktivieren/,'paused production UI offers no active session or management action');
let html=renderToStaticMarkup(React.createElement(RdpPanel,{server,viewer,demo:false}));assert.match(html,/Berechtigung „Remote Desktop mit Windows-Konto öffnen“/);assert.match(html,/class="sdx-btn sdx-btn-primary" aria-disabled="true" aria-describedby=/,'without the device right the primary Open Remote Desktop stays visible and blocked with its reason');html=renderToStaticMarkup(React.createElement(RdpPanel,{server:{...server,permissions:['rdp']},viewer,demo:false}));assert.match(html,/Mit einem Windows-Konto anmelden/);assert.ok(!html.includes('RDP aktivieren')&&!html.includes('Remote Desktop einschalten'),'independent rdp permission does not grant management');html=renderToStaticMarkup(React.createElement(RdpPanel,{server:{...server,snapshot:{...server.snapshot,mode:'ReadOnly'}},viewer:{...viewer,permissions:['*']},demo:false}));assert.match(html,/Schalte den Verwaltungsmodus direkt auf dem Gerät ein/);
html=renderToStaticMarkup(React.createElement(RemoteDesktopClient));assert.match(html,/<option value="webrtc" selected="">Direktverbindung/,'WebRTC is the explicit default');assert.match(html,/<option value="mailbox">Kompatibilität/,'compatibility is available only as an explicit selection');assert.match(html,/braucht Agent 4\.3 oder neuer/);

// Exercise the actual component connect/disconnect lifecycle with a small
// hook runtime, while mocking only SDK initialization and the peer/API I/O.
// This catches stale asynchronous prepare results, key/session leakage and
// missing cancellation without requiring a browser rendering environment.
function clientLifecycleHarness({protocol=2,requestOverride}={}){
 const state=[],effects=[],requests=[],preparations=[],directs=[];let hook=0,refCount=0,element,shutdowns=0,keyCreations=0,parentReloads=0,childReloads=0;const originalWebSocket=class OriginalSocket{};
 const fakeWindow=new EventTarget();Object.assign(fakeWindow,{location:{href:`https://portal.example/remote-desktop?serverId=${serverId}`,origin:'https://portal.example',host:'portal.example',reload(){childReloads++;}},parent:{postMessage(){},location:{reload(){parentReloads++;}}},WebSocket:originalWebSocket});
 const api={shutdown(){shutdowns++;},setEnableClipboard(){},setEnableAutoClipboard(){},onWarningCallback(){},setVisibility(){},setScale(){},configBuilder(){const builder={build(){return {};}};for(const name of ['withUsername','withPassword','withServerDomain','withDestination','withProxyAddress','withAuthToken','withDesktopSize','withExtension'])builder[name]=()=>builder;return builder;},async connect(){new fakeWindow.WebSocket('wss://portal.example/serverdesk-rdp');return {run:()=>new Promise(()=>{})};}};
 const fakeDocument={visibilityState:'visible',createElement(){element=new EventTarget();element.remove=()=>{};return element;}},host={clientWidth:1280,clientHeight:720,replaceChildren(){},requestFullscreen:async()=>{}};
 const hooks={...React,useState(initial){const index=hook++;if(!(index in state))state[index]=initial;return [state[index],value=>{state[index]=typeof value==='function'?value(state[index]):value;}];},useRef(initial){const index=hook++,isHost=refCount++===0;if(!(index in state))state[index]={current:isHost?host:initial};return state[index];},useEffect(fn){const index=hook++;if(!(index in state)){state[index]=true;effects.push(fn);}}};
 const bridge={get protocol(){return protocol;},async request(body,signal){const call={body,signal};requests.push(call);const override=requestOverride?.(call,requests);if(override!==undefined)return override;if(body.action==='metadata')return {hostname:'SRV-RDP',publicKey:{},availability:{enabled:true,online:true,management:true,capable:true,webrtcCapable:true}};if(['exchange','receive'].includes(body.action))return {id:body.id,state:'open',inputAck:0,inputStored:0,outputAck:0,frames:[]};return {id:body.id,state:'opening',transport:body.transport};},dispose(){}};
 const peerModule={prepareRdpWebRtc(options){return new Promise((resolve,reject)=>preparations.push({options,resolve,reject}));}};
 const absolute=path.resolve('ui/devices/remote/remote-desktop-client.tsx'),entry={exports:{}},code=ts.transpileModule(fs.readFileSync(absolute,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
 function localRequire(name){const i18nStub=i18nRequire(name);if(i18nStub)return i18nStub;if(name==='react')return hooks;if(name==='@/ui/devices/remote/rdp-webrtc')return peerModule;if(name==='@/ui/devices/remote/rdp-crypto')return {createRdpKey:async()=>{keyCreations++;return {key:generated.key,keyEnvelope:generated.keyEnvelope};}};if(name==='@/ui/devices/remote/rdp-bridge')return {...load('ui/devices/remote/rdp-bridge.ts'),createRdpChildBridge:()=>bridge};if(name==='@devolutions/iron-remote-desktop-rdp')return {init:async()=>{},Backend:{},enableCredssp:()=>({}),outboundMessageSizeLimit:()=>({})};if(name==='@devolutions/iron-remote-desktop')return {};if(name.startsWith('.')){const base=path.resolve(path.dirname(absolute),name);if(base.endsWith('.css'))return {};return load([base,base+'.ts',base+'.tsx'].find(file=>fs.existsSync(file)));}return require(name);}
 new Function('require','module','exports',code)(localRequire,entry,entry.exports);
 const render=()=>{hook=0;refCount=0;return entry.exports.default();},find=(tree,predicate)=>{if(!tree||typeof tree!=='object')return null;if(predicate(tree))return tree;for(const child of [tree.props?.children].flat(Infinity)){const result=find(child,predicate);if(result)return result;}return null;};
 const direct=()=>{const result={offer:rtcOffer,closes:0,start:async()=>{},close(){this.closes++;},Socket:class extends EventTarget{close(){}}};directs.push(result);return result;};
 return {fakeWindow,fakeDocument,requests,preparations,directs,render,find,direct,get element(){return element;},get shutdowns(){return shutdowns;},get keyCreations(){return keyCreations;},get parentReloads(){return parentReloads;},get childReloads(){return childReloads;},originalWebSocket,async mount(){render();const cleanups=effects.map(fn=>fn());await until(()=>!!element,'client SDK element created');element.dispatchEvent(Object.assign(new Event('ready'),{detail:{irgUserInteraction:api}}));return ()=>cleanups.forEach(fn=>fn?.());},credentials(){const tree=render();find(tree,node=>node.props?.id==='rdp-user').props.onChange({target:{value:'test'}});find(tree,node=>node.props?.id==='rdp-password').props.onChange({target:{value:'fixture-secret'}});},submit(){return find(render(),node=>node.type==='form').props.onSubmit({preventDefault(){}});}};
}
const lifecycle=clientLifecycleHarness(),savedGlobals=['window','document'].map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]);let unmount;
try{
 globalThis.window=lifecycle.fakeWindow;globalThis.document=lifecycle.fakeDocument;unmount=await lifecycle.mount();lifecycle.find(lifecycle.render(),node=>node.props?.id==='rdp-transport').props.onChange({target:{value:'mailbox'}});assert.ok(lifecycle.find(lifecycle.render(),node=>node.type==='small'&&node.props.children==='Die Verbindung läuft über Nodiverna und kann deutlich langsamer sein.'));lifecycle.find(lifecycle.render(),node=>node.props?.id==='rdp-transport').props.onChange({target:{value:'webrtc'}});lifecycle.credentials();const pendingConnect=lifecycle.submit();await until(()=>lifecycle.preparations.length===1,'component peer preparation starts');const pendingPrepare=lifecycle.preparations[0];const disconnectButton=lifecycle.find(lifecycle.render(),node=>node.type==='button'&&[node.props.children].flat(Infinity).includes('Trennen'));assert.ok(disconnectButton);disconnectButton.props.onClick();assert.equal(pendingPrepare.options.signal.aborted,true,'disconnect immediately aborts peer preparation');const stale=lifecycle.direct();pendingPrepare.resolve(stale);await pendingConnect;assert.equal(stale.closes,1,'late peer preparation result is closed');assert.equal(lifecycle.requests.filter(call=>call.body.action==='open').length,0,'cancelled preparation cannot open a portal session');assert.equal(lifecycle.fakeWindow.WebSocket,lifecycle.originalWebSocket);
 lifecycle.credentials();const reconnect=lifecycle.submit();await until(()=>lifecycle.preparations.length===2,'reconnect prepares a fresh peer');const next=lifecycle.direct();lifecycle.preparations[1].resolve(next);await reconnect;const opens=lifecycle.requests.filter(call=>call.body.action==='open');assert.equal(opens.length,1);assert.equal(opens[0].body.transport,'webrtc');assert.equal(opens[0].body.offer,rtcOffer);assert.notEqual(lifecycle.fakeWindow.WebSocket,lifecycle.originalWebSocket,'connected SDK uses the direct socket');assert.match(lifecycle.find(lifecycle.render(),node=>node.props?.role==='status').props.children.flat(Infinity).filter(value=>typeof value==='string').join(''),/Verbunden/);
 unmount();unmount=null;assert.equal(lifecycle.preparations[1].options.signal.aborted,true,'unmount aborts connection scope');assert.equal(next.closes,1,'unmount closes the live peer');assert.equal(lifecycle.fakeWindow.WebSocket,lifecycle.originalWebSocket,'unmount restores the original constructor');assert.ok(lifecycle.requests.some(call=>call.body.action==='close'&&call.body.id===opens[0].body.id),'unmount closes the authorized portal session');assert.ok(lifecycle.shutdowns>=2);
}finally{unmount?.();for(const[name,descriptor]of savedGlobals){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}}
for(const protocol of [0,1]){
 const oldParent=clientLifecycleHarness({protocol});let dispose;
 try{globalThis.window=oldParent.fakeWindow;globalThis.document=oldParent.fakeDocument;dispose=await oldParent.mount();oldParent.credentials();await oldParent.submit();assert.equal(oldParent.keyCreations,0,'new iframe rejects old parent before generating a session key');assert.equal(oldParent.preparations.length,0,'new iframe rejects old parent before ICE preparation');assert.equal(oldParent.requests.filter(call=>call.body.action==='open').length,0,'backend webrtcCapable cannot bypass an old parent validator');assert.equal(oldParent.fakeWindow.WebSocket,oldParent.originalWebSocket);const tree=oldParent.render(),alert=oldParent.find(tree,node=>node.props?.role==='alert');assert.ok(alert);const reload=oldParent.find(alert,node=>node.type==='button'&&node.props.children==='Seite neu laden');assert.ok(reload,'mixed deployment provides the specific portal reload action');assert.equal(oldParent.parentReloads,0,'failure does not navigate automatically');reload.props.onClick();assert.equal(oldParent.parentReloads,1,'explicit reload targets the parent portal');assert.equal(oldParent.childReloads,0,'reloading only the new iframe cannot repair an old parent');
  oldParent.find(oldParent.render(),node=>node.props?.id==='rdp-transport').props.onChange({target:{value:'mailbox'}});oldParent.credentials();await oldParent.submit();assert.equal(oldParent.preparations.length,0,'compatibility must remain an explicit user selection');assert.equal(oldParent.keyCreations,1);const legacyOpen=oldParent.requests.find(call=>call.body.action==='open');assert.ok(legacyOpen);assert.equal(Object.hasOwn(legacyOpen.body,'transport'),false,'old parent retains the four-field legacy open contract');assert.equal(Object.hasOwn(legacyOpen.body,'offer'),false);
 }finally{dispose?.();for(const[name,descriptor]of savedGlobals){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}}
}

// A generic signaling/ICE timeout can race the agent's terminal report. Read
// only that closed, owned session's metadata after the transport is already
// stopped. Exercise the real component callbacks, including stale replies.
const diagnosticCodes=['RDP_SIGNAL_TIMEOUT','RDP_BRIDGE_TIMEOUT','RDP_AGENT_ANSWER_TIMEOUT','RDP_NEGOTIATION_TIMEOUT','RDP_ICE_FAILED'];
const diagnosticMessage='Die WebRTC-Signalisierung hat das Zeitlimit überschritten.';
const nativeCause='WebRTC-Verbindung fehlgeschlagen (phase=ice-dtls; ice=failed; peer=failed; dtls=False; sctp=Closed; host=1; srflx=1; exception=IOException).';
const diagnosticFailure=code=>Object.assign(new Error(diagnosticMessage),{code});
const metadataRequests=flow=>flow.requests.filter(call=>call.body.action==='metadata');
const alertText=flow=>[flow.find(flow.render(),node=>node.props?.role==='alert')?.props.children].flat(Infinity).filter(value=>typeof value==='string').join('');
function restoreClientGlobals(){for(const[name,descriptor]of savedGlobals){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}}
async function connectedDiagnosticClient(metadataReply,configureDirect){
 const flow=clientLifecycleHarness({requestOverride:(call,calls)=>{if(call.body.action==='metadata'){const index=calls.filter(item=>item.body.action==='metadata').length-1;if(index>0)return metadataReply(call,index,flow);}}});
 globalThis.window=flow.fakeWindow;globalThis.document=flow.fakeDocument;const dispose=await flow.mount();flow.credentials();const connecting=flow.submit();await until(()=>flow.preparations.length===1,'diagnostic fixture prepares peer');const direct=flow.direct();configureDirect?.(direct,flow);flow.preparations[0].resolve(direct);await connecting;const failedId=flow.requests.find(call=>call.body.action==='open').body.id;
 return {flow,direct,failedId,dispose,fail:error=>flow.preparations[0].options.onFailure(error)};
}
const diagnosticTimer=globalThis.setTimeout;
try{
 // Keep the component's real timer ordering while shortening only its
 // diagnostic retry/grace timers. The connection and transport tests above
 // retain their original deadlines.
 globalThis.setTimeout=(fn,ms,...args)=>diagnosticTimer(fn,ms===500?15:ms===1000?25:ms===3000?120:ms,...args);
 for(const code of diagnosticCodes){
  let fixture;
  try{
   fixture=await connectedDiagnosticClient((_call,index,flow)=>({sessions:index===1?[]:[{id:flow.requests.find(call=>call.body.action==='open').body.id,isOwn:true,transport:'webrtc',state:'closed',error:nativeCause}]}));
   fixture.fail(diagnosticFailure(code));await until(()=>alertText(fixture.flow).includes('Agentdiagnose:'),'late own agent terminal diagnosis');
   assert.match(alertText(fixture.flow),/direkten Netzwerkpfad|direkte Netzwerkverbindung|Netzwerkpfad|Netzwerk.*NAT/,'ICE failure receives a clear network-path explanation');assert.ok(alertText(fixture.flow).includes(nativeCause),'the original safe native cause remains visible');assert.equal(metadataRequests(fixture.flow).length,3,'one empty metadata reply is followed by one bounded diagnostic retry');
   assert.equal(fixture.direct.closes,1,'diagnostics happen after the direct peer closes');assert.equal(fixture.flow.fakeWindow.WebSocket,fixture.flow.originalWebSocket,'diagnostics cannot resume the transport');const closeIndex=fixture.flow.requests.findIndex(call=>call.body.action==='close'&&call.body.id===fixture.failedId);assert.ok(closeIndex>=0);assert.ok(fixture.flow.requests.slice(closeIndex+1).every(call=>call.body.action==='metadata'),'only metadata reads follow the terminal close');assert.equal(fixture.flow.requests.filter(call=>call.body.action==='open').length,1,'diagnostics never reopen a session');assert.equal(fixture.flow.preparations.length,1);assert.equal(fixture.flow.keyCreations,1,'metadata diagnosis creates no new peer or key');
  }finally{fixture?.dispose();restoreClientGlobals();}
 }
 for(const invalid of [
  {id},
  {isOwn:false},
  {isOwn:undefined},
  {transport:'mailbox'},
  {state:'open'},
  {state:'opening'},
  {error:''},
  {error:'   '},
  {error:null},
  {error:7},
  {error:'x'.repeat(501)},
  {activeOnly:true},
 ]){
  let fixture;
  try{
   fixture=await connectedDiagnosticClient((_call,_index,flow)=>{const session={id:flow.requests.find(call=>call.body.action==='open').body.id,isOwn:true,transport:'webrtc',state:'closed',error:nativeCause,...invalid};return invalid.activeOnly?{sessions:[],activeSessions:[session]}:{sessions:[session]};});
   fixture.fail(diagnosticFailure('RDP_SIGNAL_TIMEOUT'));await until(()=>metadataRequests(fixture.flow).length===4,'invalid diagnosis reaches bounded three reads');await pause(35);assert.equal(alertText(fixture.flow),diagnosticMessage,'other IDs/owners/transports/states and invalid errors cannot replace the original failure');assert.equal(metadataRequests(fixture.flow).length,4,'diagnostic search is limited to three metadata reads');assert.equal(fixture.flow.requests.filter(call=>call.body.action==='open').length,1);
  }finally{fixture?.dispose();restoreClientGlobals();}
 }
 // A valid terminal error exactly at the documented size limit is retained.
 let boundaryFixture;
 try{
  const error='a'.repeat(500);boundaryFixture=await connectedDiagnosticClient((_call,_index,flow)=>({sessions:[{id:flow.requests.find(call=>call.body.action==='open').body.id,isOwn:true,transport:'webrtc',state:'error',error}]}));boundaryFixture.fail(diagnosticFailure('RDP_NEGOTIATION_TIMEOUT'));await until(()=>alertText(boundaryFixture.flow).includes('Agentdiagnose:'),'500-character terminal diagnosis');assert.ok(alertText(boundaryFixture.flow).includes(error));assert.equal(metadataRequests(boundaryFixture.flow).length,2);
 }finally{boundaryFixture?.dispose();restoreClientGlobals();}
 // The native transport invokes onFailure and then rejects start(). Both
 // paths refer to one failed generation and must produce one diagnostic.
 let doubleFixture;
 try{
  const error=diagnosticFailure('RDP_SIGNAL_TIMEOUT');doubleFixture=await connectedDiagnosticClient((_call,_index,flow)=>({sessions:[{id:flow.requests.find(call=>call.body.action==='open').body.id,isOwn:true,transport:'webrtc',state:'closed',error:nativeCause}]}),(direct,flow)=>{direct.start=async()=>{flow.preparations[0].options.onFailure(error);throw error;};});await until(()=>alertText(doubleFixture.flow).includes('Agentdiagnose:'),'callback plus start rejection share one diagnosis');assert.equal(metadataRequests(doubleFixture.flow).length,2);assert.equal(doubleFixture.direct.closes,1);assert.equal(doubleFixture.flow.requests.filter(call=>call.body.action==='close').length,1);doubleFixture.fail(new Error('late cleanup failure'));await pause(20);assert.ok(alertText(doubleFixture.flow).includes(nativeCause),'late failure callback cannot replace the first terminal cause');assert.equal(metadataRequests(doubleFixture.flow).length,2);
 }finally{doubleFixture?.dispose();restoreClientGlobals();}
 // An open POST may have committed before its bridge reply times out. The
 // outer connect catch must also diagnose its already assigned session ID.
 let openFlow,openDispose,openId;
 try{
  const error=Object.assign(new Error(diagnosticMessage),{name:'TimeoutError',code:'RDP_BRIDGE_TIMEOUT',status:504});openFlow=clientLifecycleHarness({requestOverride:(call,calls)=>{if(call.body.action==='open'){openId=call.body.id;return Promise.reject(error);}if(call.body.action==='metadata'&&calls.filter(item=>item.body.action==='metadata').length>1)return {sessions:[{id:openId,isOwn:true,transport:'webrtc',state:'closed',error:nativeCause}]};}});globalThis.window=openFlow.fakeWindow;globalThis.document=openFlow.fakeDocument;openDispose=await openFlow.mount();openFlow.credentials();const opening=openFlow.submit();await until(()=>openFlow.preparations.length===1,'open timeout fixture prepares peer');const direct=openFlow.direct();openFlow.preparations[0].resolve(direct);await opening;await until(()=>alertText(openFlow).includes('Agentdiagnose:'),'open timeout catch reads its owned terminal cause');assert.ok(alertText(openFlow).includes(nativeCause));assert.equal(metadataRequests(openFlow).length,2);assert.equal(direct.closes,1);assert.ok(openFlow.requests.some(call=>call.body.action==='close'&&call.body.id===openId));assert.equal(openFlow.requests.filter(call=>call.body.action==='open').length,1);assert.equal(openFlow.fakeWindow.WebSocket,openFlow.originalWebSocket);
 }finally{openDispose?.();restoreClientGlobals();}
 for(const error of [
  new Error('Die Direktverbindung zum Gerät wurde unterbrochen. Verbinde dich erneut.'),
  new Error(nativeCause),
  Object.assign(new Error('MFA-Freigabe ist abgelaufen.'),{status:403,code:'MFA_LOGIN_REQUIRED'}),
  Object.assign(new Error('Die Windows-Anmeldung ist fehlgeschlagen. Prüfe Benutzername und Passwort.'),{code:'RDP_NLA_FAILED'}),
  Object.assign(new Error('WebRTC-Antwort wurde nachträglich verändert.'),{code:'RDP_SIGNAL_CHANGED'}),
  Object.assign(new Error('WebRTC-Signal konnte nicht entschlüsselt werden.'),{code:'RDP_SIGNAL_CRYPTO'}),
 ]){
  let fixture;
  try{fixture=await connectedDiagnosticClient(()=>assert.fail('concrete failures must not read metadata'));fixture.fail(error);await pause(35);assert.equal(alertText(fixture.flow),error.message,'the first concrete transport/authentication cause is preserved');assert.equal(metadataRequests(fixture.flow).length,1);}
  finally{fixture?.dispose();restoreClientGlobals();}
 }
 let rejectedFixture;
 try{rejectedFixture=await connectedDiagnosticClient(()=>Promise.reject(Object.assign(new Error('metadata unavailable'),{status:503})));rejectedFixture.fail(diagnosticFailure('RDP_SIGNAL_TIMEOUT'));await until(()=>metadataRequests(rejectedFixture.flow).length===2,'metadata failure is attempted once');await pause(35);assert.equal(alertText(rejectedFixture.flow),diagnosticMessage,'failed metadata cannot replace the original failure');assert.equal(metadataRequests(rejectedFixture.flow).length,2);}
 finally{rejectedFixture?.dispose();restoreClientGlobals();}
 for(const after of ['reconnect','pagehide','unmount']){
  let fixture,resolveLate,disposed=false;
  try{
   fixture=await connectedDiagnosticClient((_call,index)=>index===1?new Promise(resolve=>{resolveLate=resolve;}):undefined);fixture.fail(diagnosticFailure('RDP_SIGNAL_TIMEOUT'));await until(()=>!!resolveLate,'diagnostic metadata request in flight');const pending=metadataRequests(fixture.flow)[1];assert.equal(pending.signal.aborted,false);
   if(after==='reconnect'){
    fixture.flow.credentials();const reconnect=fixture.flow.submit();await until(()=>fixture.flow.preparations.length===2,'new connection begins while previous diagnosis is pending');assert.equal(pending.signal.aborted,true,'reconnect aborts the old diagnostic request');const next=fixture.flow.direct();fixture.flow.preparations[1].resolve(next);await reconnect;
   }else if(after==='pagehide'){fixture.flow.fakeWindow.dispatchEvent(new Event('pagehide'));assert.equal(pending.signal.aborted,true,'pagehide/disconnect aborts the diagnostic request');}
   else{fixture.dispose();disposed=true;assert.equal(pending.signal.aborted,true,'unmount aborts the diagnostic request');}
   const before=alertText(fixture.flow);resolveLate({sessions:[{id:fixture.failedId,isOwn:true,transport:'webrtc',state:'closed',error:nativeCause}]});await pause(35);assert.equal(alertText(fixture.flow),before,'late metadata cannot overwrite a newer connection or an unmounted client');assert.equal(metadataRequests(fixture.flow).length,after==='reconnect'?3:2,'late diagnosis cannot schedule another metadata read');if(after==='reconnect')assert.match(fixture.flow.find(fixture.flow.render(),node=>node.props?.role==='status').props.children.flat(Infinity).filter(value=>typeof value==='string').join(''),/Verbunden/);
  }finally{if(!disposed)fixture?.dispose();restoreClientGlobals();}
 }
 // A metadata promise that ignores cancellation still cannot outlive the
 // bounded grace period or update the UI with an eventual stale result.
 let blockedFixture,resolveAfterDeadline;
 try{
  blockedFixture=await connectedDiagnosticClient(()=>new Promise(resolve=>{resolveAfterDeadline=resolve;}));blockedFixture.fail(diagnosticFailure('RDP_BRIDGE_TIMEOUT'));await until(()=>!!resolveAfterDeadline,'blocked diagnosis starts');const pending=metadataRequests(blockedFixture.flow)[1];await until(()=>pending.signal.aborted,'diagnostic grace hard deadline');assert.equal(alertText(blockedFixture.flow),diagnosticMessage);resolveAfterDeadline({sessions:[{id:blockedFixture.failedId,isOwn:true,transport:'webrtc',state:'closed',error:nativeCause}]});await pause(35);assert.equal(alertText(blockedFixture.flow),diagnosticMessage,'metadata arriving after the grace deadline cannot refine the displayed failure');assert.equal(metadataRequests(blockedFixture.flow).length,2);
 }finally{blockedFixture?.dispose();restoreClientGlobals();}
}finally{globalThis.setTimeout=diagnosticTimer;}

// Execute the parent panel's real message handler. Parent protocol belongs
// on every correlated envelope, including validation and congestion errors.
async function parentBridgeHarness(){
 const state=[],effects=[],replies=[],apiCalls=[],inFlight=[];let hook=0,ref=0;const child={postMessage(data,origin){replies.push({data,origin});}},fakeWindow=new EventTarget();Object.assign(fakeWindow,{location:{origin:'https://portal.example'}});
 const hooks={...React,useRef(initial){const index=hook++;if(!(index in state))state[index]={current:ref++===0?{contentWindow:child}:initial};return state[index];},useState(initial){const index=hook++;if(!(index in state))state[index]=initial;return [state[index],value=>{state[index]=value;}];},useCallback(fn){hook++;return fn;},useEffect(fn){hook++;effects.push(fn);}};
 const shared={...load('ui/base/api.tsx'),permitted:()=>true,online:()=>true,message:error=>error.message,api(url,body,signal){apiCalls.push({url,body,signal});if(!signal)return Promise.resolve({availability:{enabled:true}});return new Promise((resolve,reject)=>{inFlight.push({url,body,signal,resolve,reject});signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});});},credentialFetch:async()=>({ok:true})};
 const absolute=path.resolve('ui/devices/remote/rdp-panel.tsx'),entry={exports:{}},code=ts.transpileModule(fs.readFileSync(absolute,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
 function localRequire(name){const i18nStub=i18nRequire(name);if(i18nStub)return i18nStub;if(name==='react')return hooks;if(name==='@/ui/base/api')return shared;if(name==='@/lib/rdp-feature')return {...load('lib/rdp-feature.ts'),REMOTE_DESKTOP_AVAILABLE:true};if(name.startsWith('.')||name.startsWith('@/')){const base=name.startsWith('@/')?path.join(root,name.slice(2)):path.resolve(path.dirname(absolute),name);if(base.endsWith('.css'))return {};return load([base,base+'.ts',base+'.tsx'].find(file=>fs.existsSync(file)));}return require(name);}
 new Function('require','module','exports',code)(localRequire,entry,entry.exports);globalThis.window=fakeWindow;const panel=entry.exports.default({server:{...server,permissions:['rdp','manage']},viewer:{...viewer,permissions:['*']},demo:false});panel.type(panel.props);const cleanups=effects.map(fn=>fn());
 const dispatch=body=>{const requestId=crypto.randomUUID();fakeWindow.dispatchEvent(Object.assign(new Event('message'),{origin:'https://portal.example',source:child,data:{type:RDP_BRIDGE,serverId,requestId,body}}));return requestId;},cancel=requestId=>fakeWindow.dispatchEvent(Object.assign(new Event('message'),{origin:'https://portal.example',source:child,data:{type:RDP_CANCEL,serverId,requestId}}));return {replies,inFlight,apiCalls,dispatch,cancel,dispose(){cleanups.forEach(fn=>fn?.());}};
}
let parentHarness;
try{
 parentHarness=await parentBridgeHarness();let requestId=parentHarness.dispatch({action:'signal',id:serverId}),reply=parentHarness.replies.at(-1);assert.equal(reply.data.requestId,requestId);assert.equal(reply.data.status,400);assert.equal(reply.data.code,'RDP_BRIDGE_INVALID_REQUEST');assert.equal(reply.data.bridgeProtocol,2);assert.equal(reply.origin,'https://portal.example');
 const queued=[];for(let n=0;n<4;n++)queued.push(parentHarness.dispatch({action:'metadata',serverId}));requestId=parentHarness.dispatch({action:'metadata',serverId});reply=parentHarness.replies.at(-1);assert.equal(reply.data.requestId,requestId);assert.equal(reply.data.status,429);assert.equal(reply.data.code,'RDP_BRIDGE_BUSY');assert.equal(reply.data.bridgeProtocol,2);assert.equal(parentHarness.inFlight.length,4,'congestion creates no extra API call');
 parentHarness.inFlight[0].resolve({hostname:'SRV-RDP',bridgeProtocol:999,availability:{webrtcCapable:true}});await until(()=>parentHarness.replies.some(item=>item.data.requestId===queued[0]),'new parent metadata reply');reply=parentHarness.replies.find(item=>item.data.requestId===queued[0]);assert.equal(reply.data.bridgeProtocol,2);assert.equal(reply.data.result.bridgeProtocol,999,'backend payload is separate from the protocol envelope');
 for(const pending of parentHarness.inFlight.slice(1))pending.resolve({hostname:'SRV-RDP'});await pause(0);const denied=parentHarness.dispatch({action:'metadata',serverId});parentHarness.inFlight.at(-1).reject(Object.assign(new Error('Berechtigung entzogen'),{status:403,code:'RDP_FORBIDDEN'}));await until(()=>parentHarness.replies.some(item=>item.data.requestId===denied),'denied API reply');reply=parentHarness.replies.find(item=>item.data.requestId===denied);assert.equal(reply.data.bridgeProtocol,2);assert.equal(reply.data.status,403);assert.equal(reply.data.code,'RDP_FORBIDDEN');
 const parentTimer=globalThis.setTimeout;let parentTimeout;
 try{
  globalThis.setTimeout=(fn,ms,...args)=>{if(ms===10000){parentTimeout=fn;return 0;}return parentTimer(fn,ms,...args);};const expired=parentHarness.dispatch({action:'metadata',serverId});assert.equal(typeof parentTimeout,'function');parentTimeout();await until(()=>parentHarness.replies.some(item=>item.data.requestId===expired),'parent own HTTP deadline');reply=parentHarness.replies.find(item=>item.data.requestId===expired);assert.equal(reply.data.bridgeProtocol,2);assert.equal(reply.data.status,504);assert.equal(reply.data.code,'RDP_BRIDGE_TIMEOUT');assert.match(reply.data.error,/nicht rechtzeitig beantwortet/);assert.equal(parentHarness.inFlight.at(-1).signal.aborted,true);
  const cancelled=parentHarness.dispatch({action:'metadata',serverId});parentHarness.cancel(cancelled);await until(()=>parentHarness.replies.some(item=>item.data.requestId===cancelled),'explicit parent cancellation');reply=parentHarness.replies.find(item=>item.data.requestId===cancelled);assert.equal(reply.data.error,'Aborted');assert.notEqual(reply.data.code,'RDP_BRIDGE_TIMEOUT','explicit cancellation is not misclassified as a portal deadline');assert.notEqual(reply.data.status,504);assert.equal(parentHarness.inFlight.at(-1).signal.aborted,true);
 }finally{globalThis.setTimeout=parentTimer;}
}finally{parentHarness?.dispose();for(const[name,descriptor]of savedGlobals){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}}
console.log('PASS browser RDP transport: pinned IronRDP Blob/event boundary fixture, duplex flow control and cancellation, scoped RTC validators, canonical encrypted offers, owned signals, typed child/parent portal deadlines versus explicit abort, old-parent/new-iframe regression before key/ICE/open, explicit parent reload/legacy selection, owned terminal RTC diagnosis with bounded metadata reads, rejection/open timeout/double failure handling, stale reconnect/pagehide/unmount/grace replies, preserved concrete causes, ordered tiny writes and independent UI permissions.');
