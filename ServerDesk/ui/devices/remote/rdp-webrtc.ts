import {RDP_FRAME_BYTES} from '@/ui/devices/remote/rdp-crypto';
import {openRdpRtcSignal,sealRdpRtcSignal} from '@/ui/devices/remote/rdp-rtc-crypto';
import {RdpInitialBoundary,type RdpRequest} from '@/ui/devices/remote/rdp-transport';

import {translate} from '@/lib/i18n/translate';
import {documentLocale} from '@/lib/i18n/locale';
import {storedMessageText} from '@/lib/server-messages';
const QUEUE_BYTES=1024*1024,SCTP_HIGH=512*1024,SCTP_LOW=128*1024;
type Part=Uint8Array<ArrayBuffer>|Blob;
type Chunk={parts:(Part|undefined)[];size:number;standalone:boolean};
export type RdpRtcStats={rttMs:number|null;bytesSent:number;bytesReceived:number;direct:boolean};
export type RdpRtcOptions={id:string;key:CryptoKey;request:RdpRequest;onFailure?:(error:Error)=>void;onStats?:(stats:RdpRtcStats)=>void;crypto?:Crypto;signal?:AbortSignal};
export type RdpRtcSignal={id:string;transport:'webrtc';state:string;answer?:string|null;error?:string|null;leaseExpiresAt:string;leaseMs:number};
function closeEvent(code:number,reason:string,wasClean:boolean):CloseEvent{return typeof CloseEvent!=='undefined'?new CloseEvent('close',{code,reason,wasClean}):Object.assign(new Event('close'),{code,reason,wasClean}) as CloseEvent;}

// The server carries only the encrypted offer/answer and authorization lease.
// Every opaque RDP byte travels directly over ordered SCTP/DTLS, with no database
// frame mailbox, polling transport or implicit fallback.
export async function prepareRdpWebRtc(options:RdpRtcOptions){
 if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(options.id))throw new Error(translate(documentLocale(),'rdp.webrtc.invalidSession'));
 if(typeof RTCPeerConnection==='undefined')throw new Error(translate(documentLocale(),'rdp.webrtc.unsupported'));
 if(options.signal?.aborted)throw new DOMException(translate(documentLocale(),'jobs.state.cancelled'),'AbortError');
 let key:CryptoKey|null=options.key,stopped=false,claimed=false,started:Promise<void>|null=null,answer:string|null=null,pollTimer:ReturnType<typeof setTimeout>|null=null,pollController:AbortController|null=null,connectTimer:ReturnType<typeof setTimeout>|null=null,flushTimer:ReturnType<typeof setTimeout>|null=null,leaseTimer:ReturnType<typeof setTimeout>|null=null;
 let queued=0,inboundQueued=0,sending=false,firstSent=false,queue:Chunk[]=[],socket:DirectRdpWebSocket|null=null,receiveChain=Promise.resolve();
 const preparationAbort=new AbortController(),discoveryDeadline=Date.now()+8000,preparationDeadline=discoveryDeadline+1000;
 const peer=new RTCPeerConnection({iceServers:[{urls:'stun:stun.cloudflare.com:3478'}],bundlePolicy:'max-bundle'}),channel=peer.createDataChannel('serverdesk-rdp-v1',{ordered:true});
 channel.binaryType='arraybuffer';channel.bufferedAmountLowThreshold=SCTP_LOW;const boundary=new RdpInitialBoundary();
 let settleOpen:(()=>void)|null=null,rejectOpen:((error:Error)=>void)|null=null;
 const opened=new Promise<void>((resolve,reject)=>{settleOpen=resolve;rejectOpen=reject;});void opened.catch(()=>{});
 let failure:Error|null=null,notifyClosed=false;
 let signalFailures=0,lastSignalFailure:Error|null=null,openingUntil=0,leaseUntil=0;
 let setupStartedAt:number|null=null;
 const monotonicNow=()=>typeof performance==='undefined'?Date.now():performance.now();
 const cancelSignal=()=>finish(1000,translate(documentLocale(),'rdp.webrtc.sessionCancelled'),true,false);
 options.signal?.addEventListener('abort',cancelSignal,{once:true});
 const safeError=(error:unknown)=>error instanceof Error?error:new Error(translate(documentLocale(),'rdp.webrtc.failed'));
 const typedError=(text:string,code:string)=>Object.assign(new Error(text),{code});
 function fail(error:Error){if(stopped)return;failure=error;try{options.onFailure?.(error);}finally{try{socket?.emit(new Event('error'));}finally{finish(1011,error.message.slice(0,120),false,true);}}}
 function finish(code:number,reason:string,clean:boolean,notify:boolean){
  if(stopped)return;stopped=true;preparationAbort.abort();pollController?.abort();if(pollTimer)clearTimeout(pollTimer);if(connectTimer)clearTimeout(connectTimer);if(flushTimer)clearTimeout(flushTimer);if(leaseTimer)clearTimeout(leaseTimer);pollTimer=null;connectTimer=null;flushTimer=null;leaseTimer=null;
  options.signal?.removeEventListener('abort',cancelSignal);for(const item of queue)for(const part of item.parts)if(part instanceof Uint8Array)part.fill(0);queue=[];queued=0;boundary.clear();key=null;
  channel.removeEventListener('open',onChannelOpen);channel.removeEventListener('message',onMessage);channel.removeEventListener('close',onChannelClose);channel.removeEventListener('error',onChannelError);channel.removeEventListener('bufferedamountlow',onBufferedLow);peer.removeEventListener('connectionstatechange',onPeerState);peer.removeEventListener('iceconnectionstatechange',onIceState);
  channel.close();peer.close();rejectOpen?.(failure??new DOMException(translate(documentLocale(),'rdp.sessionEnded'),'AbortError'));settleOpen=null;rejectOpen=null;
  if(notify&&!notifyClosed){notifyClosed=true;void options.request({action:'close',id:options.id}).catch(()=>{});}
  if(socket){socket.readyState=socket.CLOSING;socket.readyState=socket.CLOSED;queueMicrotask(()=>socket?.emit(closeEvent(code,reason,clean)));}
 }
 function onChannelOpen(){if(stopped)return;if(connectTimer)clearTimeout(connectTimer);connectTimer=null;openingUntil=0;settleOpen?.();settleOpen=null;rejectOpen=null;if(socket){socket.readyState=socket.OPEN;queueMicrotask(()=>{if(!stopped)socket?.emit(new Event('open'));});}}
 function onChannelClose(){if(!stopped)fail(new Error(translate(documentLocale(),'rdp.webrtc.interrupted')));}
 function onChannelError(){fail(new Error(translate(documentLocale(),'rdp.webrtc.channelFailed')));}
 function connectionFailure(source:'peer-state'|'ice-state'|'setup-deadline'){
  const state=(value:unknown,allowed:string[])=>value==null?'none':typeof value==='string'&&allowed.includes(value)?value:'unknown';
  let dtls='none',sctp='none';try{dtls=state(peer.sctp?.transport.state,['new','connecting','connected','closed','failed']);sctp=state(peer.sctp?.state,['connecting','connected','closed']);}catch{dtls='unknown';sctp='unknown';}
  const ice=state(peer.iceConnectionState,['new','checking','connected','completed','failed','disconnected','closed']),connection=state(peer.connectionState,['new','connecting','connected','disconnected','failed','closed']),elapsed=setupStartedAt===null?0:Math.min(600000,Math.max(0,Math.round(monotonicNow()-setupStartedAt)));
  // Copy bounded enum states before finish() closes the transports. This
  // identifies an actual DTLS failure separately from ICE or our setup timer.
  const detail=translate(documentLocale(),'rdp.webrtc.diagnostics',{ice,connection,dtls,sctp,source,elapsed});
  if(!answer)return typedError(translate(documentLocale(),'rdp.webrtc.noAnswer',{detail}),'RDP_AGENT_ANSWER_TIMEOUT');
  if(channel.readyState==='open')return new Error(translate(documentLocale(),'rdp.webrtc.interruptedDetail',{detail}));
  if(dtls==='failed')return typedError(translate(documentLocale(),'rdp.webrtc.dtlsFailed',{detail}),'RDP_NEGOTIATION_TIMEOUT');
  if(['connected','completed'].includes(peer.iceConnectionState))return new Error(translate(documentLocale(),'rdp.webrtc.channelSetup',{detail}));
  if(peer.iceConnectionState==='failed')return typedError(translate(documentLocale(),'rdp.webrtc.noPath',{detail}),'RDP_ICE_FAILED');
  return typedError(translate(documentLocale(),'rdp.webrtc.setupEnded',{detail}),'RDP_NEGOTIATION_TIMEOUT');
 }
 function onPeerState(){if(peer.connectionState==='failed'||peer.connectionState==='closed')fail(connectionFailure('peer-state'));}
 function onIceState(){if(peer.iceConnectionState==='failed'||peer.iceConnectionState==='closed')fail(connectionFailure('ice-state'));}
 function onBufferedLow(){scheduleFlush();}
 function onMessage(event:MessageEvent){
  if(!socket||socket.readyState!==socket.OPEN){fail(new Error(translate(documentLocale(),'rdp.webrtc.unexpectedOutput')));return;}
  const data=event.data;let size:number;if(data instanceof ArrayBuffer)size=data.byteLength;else if(data instanceof Blob)size=data.size;else{fail(new Error(translate(documentLocale(),'rdp.webrtc.invalidBinary')));return;}
  if(!size||size>RDP_FRAME_BYTES||inboundQueued+size>QUEUE_BYTES){fail(new Error(translate(documentLocale(),'rdp.webrtc.bufferExceeded')));return;}inboundQueued+=size;
  receiveChain=receiveChain.then(async()=>{try{const bytes=data instanceof Blob?new Uint8Array(await data.arrayBuffer()):new Uint8Array(data);if(stopped){bytes.fill(0);return;}for(const packet of boundary.accept(bytes)){if(stopped)break;const buffer=packet.slice().buffer;socket?.emit(new MessageEvent('message',{data:socket.binaryType==='arraybuffer'?buffer:new Blob([buffer])}));}bytes.fill(0);}finally{inboundQueued-=size;}}).catch(error=>fail(safeError(error)));
 }
 function scheduleFlush(){if(stopped||!queue.length||sending||flushTimer)return;flushTimer=setTimeout(()=>{flushTimer=null;void flush();},channel.bufferedAmount>=SCTP_HIGH?25:0);}
 async function flush(){
  if(stopped||sending)return;sending=true;
  try{while(queue.length&&!stopped&&channel.readyState==='open'&&channel.bufferedAmount<SCTP_HIGH){const item=queue.shift()!,parts=item.parts.filter((part):part is Part=>!!part).reverse(),data=parts.length===1?parts[0]:new Blob(parts);let bytes:Uint8Array<ArrayBuffer>|undefined;try{bytes=data instanceof Blob?new Uint8Array(await data.arrayBuffer()):data;if(stopped)return;channel.send(bytes);queued-=item.size;}finally{bytes?.fill(0);for(const part of parts)if(part instanceof Uint8Array)part.fill(0);}}}catch(error){fail(safeError(error));}finally{sending=false;scheduleFlush();}
 }
 // IronRDP constructs exactly one socket; the transport keeps it to forward channel events.
 function claim(instance:DirectRdpWebSocket){claimed=true;socket=instance;}
 class DirectRdpWebSocket extends EventTarget{
  static readonly CONNECTING=0;static readonly OPEN=1;static readonly CLOSING=2;static readonly CLOSED=3;
  readonly CONNECTING=0;readonly OPEN=1;readonly CLOSING=2;readonly CLOSED=3;
  readonly url:string;readonly protocol='';readonly extensions='';binaryType:BinaryType='blob';readyState=0;
  get bufferedAmount(){return stopped?0:queued+channel.bufferedAmount;}
  onopen:((event:Event)=>unknown)|null=null;onmessage:((event:MessageEvent)=>unknown)|null=null;onerror:((event:Event)=>unknown)|null=null;onclose:((event:CloseEvent)=>unknown)|null=null;
  constructor(url:string|URL){
   super();this.url=String(url);const parsed=new URL(this.url);if(claimed||stopped||parsed.pathname!=='/serverdesk-rdp'||parsed.search||parsed.hash||!['ws:','wss:'].includes(parsed.protocol))throw new DOMException(translate(documentLocale(),'rdp.transport.used'),'SecurityError');claim(this);
   if(channel.readyState==='open'){this.readyState=this.OPEN;queueMicrotask(()=>{if(!stopped)this.emit(new Event('open'));});}
  }
  emit(event:Event){this.dispatchEvent(event);const callback=({open:this.onopen,message:this.onmessage,error:this.onerror,close:this.onclose} as Record<string,((event:never)=>unknown)|null>)[event.type];callback?.call(this,event as never);}
  send(data:string|ArrayBufferLike|Blob|ArrayBufferView){
   if(this.readyState!==this.OPEN)throw new DOMException(translate(documentLocale(),'rdp.transport.notOpen'),'InvalidStateError');
   let input:Uint8Array|Blob;if(typeof data==='string')input=new TextEncoder().encode(data);else if(data instanceof ArrayBuffer)input=new Uint8Array(data);else if(ArrayBuffer.isView(data))input=new Uint8Array(data.buffer,data.byteOffset,data.byteLength);else if(data instanceof Blob)input=data;else throw new TypeError(translate(documentLocale(),'rdp.transport.binary'));
   const size=input instanceof Blob?input.size:input.length;if(!size)return;const standalone=!firstSent;if(standalone&&size>RDP_FRAME_BYTES){fail(new Error(translate(documentLocale(),'rdp.transport.requestTooLarge')));return;}if(this.bufferedAmount+size>QUEUE_BYTES){fail(new Error(translate(documentLocale(),'rdp.webrtc.inputBusy')));return;}firstSent=true;
   for(let start=0;start<size;){let tail=queue[queue.length-1];if(standalone||!tail||tail.standalone||tail.size===RDP_FRAME_BYTES){tail={parts:[],size:0,standalone};queue.push(tail);}const length=Math.min(RDP_FRAME_BYTES-tail.size,size-start);let part:Part=input.slice(start,start+length),level=0;while(tail.parts[level]){const previous=tail.parts[level]!,combined=new Blob([previous,part]);if(previous instanceof Uint8Array)previous.fill(0);if(part instanceof Uint8Array)part.fill(0);part=combined;tail.parts[level]=undefined;level++;}tail.parts[level]=part;tail.size+=length;start+=length;}queued+=size;scheduleFlush();
  }
  close(code=1000,reason=''){if(code!==1000&&(code<3000||code>4999))throw new DOMException(translate(documentLocale(),'rdp.transport.closeCode'),'InvalidAccessError');if(new TextEncoder().encode(reason).length>123)throw new DOMException(translate(documentLocale(),'rdp.transport.closeReason'),'SyntaxError');finish(code,reason,true,true);}
 }
 channel.addEventListener('open',onChannelOpen);channel.addEventListener('message',onMessage);channel.addEventListener('close',onChannelClose);channel.addEventListener('error',onChannelError);channel.addEventListener('bufferedamountlow',onBufferedLow);peer.addEventListener('connectionstatechange',onPeerState);peer.addEventListener('iceconnectionstatechange',onIceState);
 async function stats(){if(!options.onStats||stopped)return;const reports=await peer.getStats();if(stopped)return;let rttMs:number|null=null,bytesSent=0,bytesReceived=0,direct=true;for(const report of reports.values()){if(report.type==='transport'){bytesSent=report.bytesSent??bytesSent;bytesReceived=report.bytesReceived??bytesReceived;}if(report.type==='candidate-pair'&&report.state==='succeeded'&&(report.nominated||report.selected)){rttMs=typeof report.currentRoundTripTime==='number'?Math.round(report.currentRoundTripTime*1000):null;bytesSent=report.bytesSent??bytesSent;bytesReceived=report.bytesReceived??bytesReceived;for(const id of [report.localCandidateId,report.remoteCandidateId])if(reports.get(id)?.candidateType==='relay')direct=false;}}options.onStats({rttMs,bytesSent,bytesReceived,direct});}
 async function poll(){
  if(stopped)return;if(leaseUntil&&Date.now()>=leaseUntil){fail(new Error(translate(documentLocale(),'rdp.webrtc.grantExpired')));return;}if(openingUntil&&Date.now()>=openingUntil){fail(lastSignalFailure??connectionFailure('setup-deadline'));return;}
  const controller=new AbortController();pollController=controller;const requestedAt=Date.now();let timedOut=false,retry=false,requestPhase=true;const deadline=setTimeout(()=>{timedOut=true;controller.abort();},10000);
  try{
   const response=await options.request({action:'signal',id:options.id},controller.signal) as RdpRtcSignal;if(stopped)return;requestPhase=false;
   if(!response||response.id!==options.id||response.transport!=='webrtc'||!['opening','open','closed','error'].includes(response.state)||response.answer!==undefined&&response.answer!==null&&typeof response.answer!=='string')throw new Error(translate(documentLocale(),'rdp.webrtc.invalidResponse'));
   if(response.state==='closed'||response.state==='error')throw new Error(storedMessageText(response.error,(key,params)=>translate(documentLocale(),key,params))||translate(documentLocale(),'rdp.sessionEnded'));
   const absolute=typeof response.leaseExpiresAt==='string'?Date.parse(response.leaseExpiresAt):NaN;if(!Number.isFinite(absolute)||!Number.isSafeInteger(response.leaseMs)||response.leaseMs<1||response.leaseMs>15000)throw new Error(translate(documentLocale(),'rdp.webrtc.invalidGrant'));
   leaseUntil=Math.min(absolute,requestedAt+response.leaseMs);const remaining=leaseUntil-Date.now();if(remaining<=0)throw new Error(translate(documentLocale(),'rdp.webrtc.grantExpired'));if(leaseTimer)clearTimeout(leaseTimer);leaseTimer=setTimeout(()=>fail(new Error(translate(documentLocale(),'rdp.webrtc.grantExpired'))),remaining);
   if(response.answer){if(answer&&answer!==response.answer)throw new Error(translate(documentLocale(),'rdp.webrtc.answerChanged'));if(!answer){if(!key)throw new Error(translate(documentLocale(),'rdp.sessionEnded'));const sdp=await openRdpRtcSignal(key,options.id,'answer',response.answer,options.crypto);if(stopped)return;answer=response.answer;await peer.setRemoteDescription({type:'answer',sdp});}}
   await stats();signalFailures=0;lastSignalFailure=null;
  }catch(error){
   if(stopped)return;const original=safeError(error),status=(original as Error&{status?:number}).status,code=(original as Error&{code?:string}).code,denied=typeof status==='number'&&status>=400&&status<500;
   const timeout=requestPhase&&!denied&&(timedOut||code==='RDP_BRIDGE_TIMEOUT'),network=requestPhase&&!denied&&original instanceof TypeError;
   const failure=timeout?typedError(translate(documentLocale(),'rdp.webrtc.signalTimeout'),'RDP_SIGNAL_TIMEOUT'):network?typedError(translate(documentLocale(),'rdp.webrtc.signalUnavailable'),'RDP_SIGNAL_UNAVAILABLE'):requestPhase&&original.name==='AbortError'&&!denied?typedError(translate(documentLocale(),'rdp.webrtc.signalInterrupted'),'RDP_SIGNAL_INTERRUPTED'):original;
   // One sequential retry can recover a stalled control request. Only a
   // validated fresh reply renews the server lease or resets this allowance.
   // Peer failure, authorization revocation and the original deadlines win.
   const withinLease=!leaseUntil||Date.now()<leaseUntil,withinOpening=!openingUntil||Date.now()<openingUntil;
   if((timeout||network)&&signalFailures===0&&withinLease&&withinOpening){signalFailures=1;lastSignalFailure=failure;retry=true;}else fail(failure);
  }finally{clearTimeout(deadline);if(pollController===controller)pollController=null;if(!stopped)pollTimer=setTimeout(()=>{pollTimer=null;void poll();},retry?0:channel.readyState==='open'?5000:250);}
 }
 async function gather(){
  await duringPreparation(peer.setLocalDescription(await duringPreparation(peer.createOffer())));if(stopped)throw new DOMException(translate(documentLocale(),'jobs.state.cancelled'),'AbortError');
  // A blocked public STUN lookup must not prevent a usable LAN/host path.
  // Freeze the available candidate set after bounded discovery; the one
  // encrypted offer is never replaced or reused with the same GCM nonce.
  if(peer.iceGatheringState!=='complete')await new Promise<void>((resolve,reject)=>{const cleanup=()=>{clearTimeout(timer);peer.removeEventListener('icegatheringstatechange',changed);preparationAbort.signal.removeEventListener('abort',aborted);},changed=()=>{if(peer.iceGatheringState==='complete'){cleanup();resolve();}},aborted=()=>{cleanup();reject(new DOMException(translate(documentLocale(),'jobs.state.cancelled'),'AbortError'));},timer=setTimeout(()=>{cleanup();resolve();},Math.max(0,discoveryDeadline-Date.now()));peer.addEventListener('icegatheringstatechange',changed);preparationAbort.signal.addEventListener('abort',aborted,{once:true});changed();});
  if(stopped||!key)throw new DOMException(translate(documentLocale(),'jobs.state.cancelled'),'AbortError');const sdp=peer.localDescription?.sdp;if(!sdp)throw new Error(translate(documentLocale(),'rdp.webrtc.noData'));if(!/(?:^|\r?\n)a=candidate:[^\r\n]+(?:\r?\n|$)/.test(sdp))throw new Error(translate(documentLocale(),'rdp.webrtc.noCandidates'));return duringPreparation(sealRdpRtcSignal(key,options.id,'offer',sdp,options.crypto),preparationDeadline);
 }
 function duringPreparation<T>(work:Promise<T>,deadline=discoveryDeadline):Promise<T>{
  if(stopped||preparationAbort.signal.aborted){void work.catch(()=>{});return Promise.reject(new DOMException(translate(documentLocale(),'jobs.state.cancelled'),'AbortError'));}
  return new Promise((resolve,reject)=>{const cleanup=()=>{clearTimeout(timer);preparationAbort.signal.removeEventListener('abort',aborted);},aborted=()=>{cleanup();reject(new DOMException(translate(documentLocale(),'jobs.state.cancelled'),'AbortError'));},timer=setTimeout(()=>{cleanup();reject(new Error(translate(documentLocale(),'rdp.webrtc.setupTimeout')));},Math.max(0,deadline-Date.now()));preparationAbort.signal.addEventListener('abort',aborted,{once:true});void work.then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});});
 }
 let offer:string;try{offer=await gather();}catch(error){finish(1011,translate(documentLocale(),'rdp.webrtc.setupFailed'),false,false);throw error;}
 return {offer,Socket:DirectRdpWebSocket,start(){if(started)return started;if(stopped)return Promise.reject(failure??new DOMException(translate(documentLocale(),'jobs.state.cancelled'),'AbortError'));setupStartedAt=monotonicNow();openingUntil=Date.now()+20000;connectTimer=setTimeout(()=>fail(lastSignalFailure??connectionFailure('setup-deadline')),20000);void poll();started=opened;return started;},close(){finish(1000,translate(documentLocale(),'rdp.sessionEnded'),true,true);}};
}
