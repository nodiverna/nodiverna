import {decryptRdpFrame,encryptRdpFrame,RDP_FRAME_BYTES,type RdpCipherFrame} from '@/ui/devices/remote/rdp-crypto';

import {translate} from '@/lib/i18n/translate';
import {documentLocale} from '@/lib/i18n/locale';
import {storedMessageText} from '@/lib/server-messages';
export type RdpExchange={id:string;state:string;inputAck:number;inputStored?:number;outputAck:number;frames:RdpCipherFrame[];error?:string;intervalMs?:number};
export type RdpRequest=(body:Record<string,unknown>,signal?:AbortSignal)=>Promise<unknown>;
type RdpStagedPart=Uint8Array<ArrayBuffer>|Blob;
const CREDIT=64,EXCHANGE_LIMIT=16,MAX_QUEUE_BYTES=CREDIT*RDP_FRAME_BYTES,DER_MAX_BYTES=65536;
const active=(state:string)=>state==='open'||state==='opening';
const validSeq=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;
function requestFailure(error:Error,inRequest:boolean,timedOut:boolean){
 const detail=error as Error&{code?:unknown;status?:unknown},status=detail.status;
 const denied=typeof status==='number'&&status>=400&&status!==408&&status!==504;
 const timeout=inRequest&&!denied&&(timedOut||error.name==='TimeoutError'||detail.code==='RDP_BRIDGE_TIMEOUT'||status===408||status===504);
 return {timeout,transient:inRequest&&!denied&&(timeout||error.name==='AbortError'||error instanceof TypeError)};
}
function mailboxTimeout(cause:Error){return Object.assign(new Error(translate(documentLocale(),'rdp.transport.mailboxTimeout')),{name:'TimeoutError',code:'RDP_MAILBOX_TIMEOUT',status:504,cause});}

// RDCleanPath is a DER message. Its first response must remain one WebSocket
// message even when the encrypted mailbox splits it across several chunks.
export class RdpInitialBoundary{
 private initial=true;private pending=new Uint8Array(0);
 accept(input:Uint8Array):Uint8Array[]{
  if(!this.initial)return [input];
  if(this.pending.length+input.length>DER_MAX_BYTES+RDP_FRAME_BYTES)throw new Error(translate(documentLocale(),'rdp.transport.negotiationTooLarge'));
  const all=new Uint8Array(this.pending.length+input.length);all.set(this.pending);all.set(input,this.pending.length);this.pending=all;
  if(all.length<2)return [];if(all[0]!==0x30)throw new Error(translate(documentLocale(),'rdp.transport.invalidNegotiation'));
  const count=all[1]&0x7f;let header=2,length=all[1];
  if(all[1]&0x80){if(count<1||count>4)throw new Error(translate(documentLocale(),'rdp.transport.invalidDer'));if(all.length<2+count)return [];length=0;for(let i=0;i<count;i++)length=length*256+all[2+i];header+=count;if(length<128||all[2]===0)throw new Error(translate(documentLocale(),'rdp.transport.invalidDer'));}
  const total=header+length;if(total>DER_MAX_BYTES)throw new Error(translate(documentLocale(),'rdp.transport.negotiationTooLarge'));if(all.length<total)return [];
  this.initial=false;this.pending=new Uint8Array(0);return all.length===total?[all]:[all.slice(0,total),all.slice(total)];
 }
 clear(){this.pending.fill(0);this.pending=new Uint8Array(0);}
}

function closeEvent(code:number,reason:string,wasClean:boolean):CloseEvent{
 if(typeof CloseEvent!=='undefined')return new CloseEvent('close',{code,reason,wasClean});
 return Object.assign(new Event('close'),{code,reason,wasClean}) as CloseEvent;
}
export type RdpSocketOptions={id:string;key:CryptoKey;request:RdpRequest;onFailure?:(error:Error)=>void;crypto?:Crypto;now?:()=>number;duplex?:boolean};

// Install only in the dedicated iframe, before IronRDP connect(). The SDK
// still handles real RDP/CredSSP/rendering/input; this replaces its byte carrier.
export function createRdpWebSocket(options:RdpSocketOptions){
 let claimed=false;const now=options.now??Date.now;
 return class MailboxWebSocket extends EventTarget {
  static readonly CONNECTING=0;static readonly OPEN=1;static readonly CLOSING=2;static readonly CLOSED=3;
  readonly CONNECTING=0;readonly OPEN=1;readonly CLOSING=2;readonly CLOSED=3;
  readonly url:string;readonly protocol='';readonly extensions='';binaryType:BinaryType='blob';readyState=0;bufferedAmount=0;
  onopen:((event:Event)=>unknown)|null=null;onmessage:((event:MessageEvent)=>unknown)|null=null;onerror:((event:Event)=>unknown)|null=null;onclose:((event:CloseEvent)=>unknown)|null=null;
  private sequence=1;private inputAck=0;private inputStored=0;private outputAck=0;private highestSent=0;private initialSent=false;private receipts=new Map<number,string>();private queue:{parts:(RdpStagedPart|undefined)[];size:number;standalone:boolean}[]=[];private retained:{frame:RdpCipherFrame;size:number;at:number}[]=[];
  private sending=false;private wake=false;private timer:ReturnType<typeof setTimeout>|null=null;private controller:AbortController|null=null;private stopped=false;private failures=0;private boundary=new RdpInitialBoundary();
  private receiving=false;private receiveTimer:ReturnType<typeof setTimeout>|null=null;private receiveController:AbortController|null=null;private receiveFailures=0;
  constructor(url:string|URL){
   super();this.url=String(url);const parsed=new URL(this.url);
   if(claimed||parsed.pathname!=='/serverdesk-rdp'||parsed.search||parsed.hash||!['ws:','wss:'].includes(parsed.protocol))throw new DOMException(translate(documentLocale(),'rdp.transport.used'),'SecurityError');
   claimed=true;queueMicrotask(()=>{if(!this.stopped){this.readyState=this.OPEN;this.emit(new Event('open'));void this.exchange();if(options.duplex)void this.receive();}});
  }
  private emit(event:Event){this.dispatchEvent(event);const callback=({open:this.onopen,message:this.onmessage,error:this.onerror,close:this.onclose} as Record<string,((event:never)=>unknown)|null>)[event.type];callback?.call(this,event as never);}
  send(data:string|ArrayBufferLike|Blob|ArrayBufferView){
   if(this.readyState!==this.OPEN)throw new DOMException(translate(documentLocale(),'rdp.transport.notOpen'),'InvalidStateError');
   // Preserve the first RDCleanPath message, then coalesce the opaque RDP
   // byte stream. A mouse/input burst must consume byte capacity rather than
   // one remote frame credit per tiny SDK Blob. Staged chunks stay <=16KiB;
   // only encrypted, immutable frames consume the 64-frame remote window.
   let input:Uint8Array|Blob;if(typeof data==='string')input=new TextEncoder().encode(data);else if(data instanceof ArrayBuffer)input=new Uint8Array(data);else if(ArrayBuffer.isView(data))input=new Uint8Array(data.buffer,data.byteOffset,data.byteLength);else if(data instanceof Blob)input=data;else throw new TypeError(translate(documentLocale(),'rdp.transport.binary'));
   const size=input instanceof Blob?input.size:input.length;if(!size)return;
   const standalone=!this.initialSent;if(standalone&&size>RDP_FRAME_BYTES){this.fail(new Error(translate(documentLocale(),'rdp.transport.requestTooLarge')));return;}
   if(this.bufferedAmount+size>MAX_QUEUE_BYTES){this.fail(new Error(translate(documentLocale(),'rdp.transport.busy')));return;}
   this.initialSent=true;
   for(let start=0;start<size;){
    let tail=this.queue[this.queue.length-1];
    if(standalone||!tail||tail.standalone||tail.size===RDP_FRAME_BYTES){tail={parts:[],size:0,standalone};this.queue.push(tail);}
    const length=Math.min(RDP_FRAME_BYTES-tail.size,size-start);let part:RdpStagedPart=input.slice(start,start+length),level=0;
    // Binary carry keeps Blob nesting logarithmic and at most 15 fragment
    // groups per chunk, even for thousands of one-byte SDK writes.
    while(tail.parts[level]){const previous=tail.parts[level]!,combined=new Blob([previous,part]);if(previous instanceof Uint8Array)previous.fill(0);if(part instanceof Uint8Array)part.fill(0);part=combined;tail.parts[level]=undefined;level++;}
    tail.parts[level]=part;
    tail.size+=length;start+=length;
   }
   this.bufferedAmount+=size;this.schedule(0);
  }
  private schedule(ms:number){if(this.stopped)return;if(this.sending){this.wake=true;return;}if(this.timer)clearTimeout(this.timer);this.timer=setTimeout(()=>{this.timer=null;void this.exchange();},ms);}
  private checkStale(){if(this.retained.some(item=>now()-item.at>30000))throw new Error(translate(documentLocale(),'rdp.transport.notAcknowledged'));}
  private feedback(raw:unknown,receiveOutput:boolean){
   const response=raw as RdpExchange,stored=options.duplex?response?.inputStored:response?.inputAck;
   if(!response||response.id!==options.id||typeof response.state!=='string'||!validSeq(response.inputAck)||!options.duplex&&response.inputAck<this.inputAck||response.inputAck>this.highestSent||!validSeq(stored)||stored<response.inputAck||stored>this.highestSent||!validSeq(response.outputAck)||response.outputAck>this.outputAck||!Array.isArray(response.frames)||response.frames.length>EXCHANGE_LIMIT||!receiveOutput&&response.frames.length)throw new Error(translate(documentLocale(),'rdp.transport.invalidResponse'));
   const progressed=response.inputAck>this.inputAck||stored>this.inputStored;
   // Sender and receiver replies can cross in flight. An older valid snapshot
   // must never rewind either ACK or free credit twice.
   this.inputAck=Math.max(this.inputAck,response.inputAck);this.inputStored=Math.max(this.inputStored,stored);
   this.retained=this.retained.filter(item=>{if(item.frame.seq<=this.inputAck){this.bufferedAmount-=item.size;return false;}return true;});
   if(options.duplex&&progressed)this.schedule(0);
   return {response,progressed};
  }
  private async deliver(frames:RdpCipherFrame[]){
   for(const frame of frames){
    if(!validSeq(frame.seq)||frame.seq<1||typeof frame.data!=='string'||frame.data.length>21868)throw new Error(translate(documentLocale(),'rdp.transport.invalidBlock'));
    const digest=Array.from(new Uint8Array(await (options.crypto??crypto).subtle.digest('SHA-256',new TextEncoder().encode(frame.data))),value=>value.toString(16).padStart(2,'0')).join('');
    if(this.stopped)return;
    if(frame.seq<=this.outputAck){if(this.receipts.get(frame.seq)!==digest)throw new Error(translate(documentLocale(),'rdp.transport.changedBlock'));continue;}
    if(frame.seq!==this.outputAck+1)throw new Error(translate(documentLocale(),'rdp.transport.gap'));
    const plain=await decryptRdpFrame(options.key,options.id,frame,options.crypto);if(this.stopped){plain.fill(0);return;}
    for(const packet of this.boundary.accept(plain)){const buffer=packet.slice().buffer;this.emit(new MessageEvent('message',{data:this.binaryType==='arraybuffer'?buffer:new Blob([buffer])}));}
    this.outputAck=frame.seq;this.receipts.set(frame.seq,digest);if(this.receipts.size>CREDIT)this.receipts.delete(this.receipts.keys().next().value!);
   }
  }
  private ended(response:RdpExchange){if(active(response.state))return false;if(response.state==='closed'&&!response.error)this.finish(1000,translate(documentLocale(),'rdp.sessionEnded'),true,false);else this.fail(new Error(storedMessageText(response.error,(key,params)=>translate(documentLocale(),key,params))||translate(documentLocale(),'rdp.sessionEnded')));return true;}
  private async exchange(){
   if(this.stopped||this.sending)return;this.sending=true;this.wake=false;let delay:number|null=100,phase:'prepare'|'request'|'deliver'='prepare';
   let timedOut=false;const controller=new AbortController();this.controller=controller;const timeout=setTimeout(()=>{timedOut=true;controller.abort();},10000);
   try{
    this.checkStale();
    while(this.queue.length&&this.retained.length<CREDIT){const item=this.queue.shift()!,parts=item.parts.filter((part):part is RdpStagedPart=>!!part).reverse(),data=parts.length===1?parts[0]:new Blob(parts);let bytes:Uint8Array|undefined;try{bytes=data instanceof Blob?new Uint8Array(await data.arrayBuffer()):data;if(this.stopped)return;if(!Number.isSafeInteger(this.sequence))throw new Error(translate(documentLocale(),'rdp.transport.sequenceLimit'));const frame=await encryptRdpFrame(options.key,options.id,this.sequence++,bytes,options.crypto);if(this.stopped)return;this.retained.push({frame,size:bytes.length,at:now()});}finally{bytes?.fill(0);for(const part of parts)if(part instanceof Uint8Array)part.fill(0);}}
    const frames=(options.duplex?this.retained.filter(item=>item.frame.seq>this.inputStored):this.retained).slice(0,EXCHANGE_LIMIT).map(item=>item.frame);
    if(options.duplex&&!frames.length){delay=null;return;}
    if(frames.length)this.highestSent=Math.max(this.highestSent,frames[frames.length-1].seq);
    phase='request';const raw=await options.request({action:'exchange',id:options.id,ack:this.outputAck,frames,...options.duplex?{receive:false}:{}},controller.signal);phase='deliver';
    if(this.stopped)return;
    const {response,progressed}=this.feedback(raw,!options.duplex);if(!options.duplex)await this.deliver(response.frames);
    if(this.stopped||this.ended(response))return;
    this.failures=0;delay=options.duplex?(this.retained.some(item=>item.frame.seq>this.inputStored)||this.queue.length&&this.retained.length<CREDIT?0:null):response.frames.length||this.queue.length&&this.retained.length<CREDIT||progressed&&this.retained.length?0:Math.min(1000,Math.max(20,response.intervalMs??20));
   }catch(error){
    if(this.stopped)return;
    const e=error instanceof Error?error:new Error(translate(documentLocale(),'rdp.transport.failed'));
    // Transport loss retries the exact retained ciphertext. Protocol/auth/crypto
    // failures close immediately; no new key or input sequence is reused.
    const failure=requestFailure(e,phase==='request',timedOut);
    if(!failure.transient||++this.failures>=3){this.fail(failure.timeout?mailboxTimeout(e):e);return;}delay=500;
   }finally{clearTimeout(timeout);if(this.controller===controller)this.controller=null;this.sending=false;if(!this.stopped&&(this.wake||delay!==null))this.schedule(this.wake?0:delay!);}
  }
  private scheduleReceive(ms:number){if(this.stopped)return;if(this.receiveTimer)clearTimeout(this.receiveTimer);this.receiveTimer=setTimeout(()=>{this.receiveTimer=null;void this.receive();},ms);}
  private async receive(){
   if(this.stopped||this.receiving)return;this.receiving=true;let delay=0,phase:'request'|'deliver'='request';
   let timedOut=false;const controller=new AbortController();this.receiveController=controller;const timeout=setTimeout(()=>{timedOut=true;controller.abort();},10000);
   try{
    this.checkStale();const raw=await options.request({action:'receive',id:options.id,ack:this.outputAck,inputAck:this.inputAck,waitMs:600},controller.signal);phase='deliver';if(this.stopped)return;
    const {response}=this.feedback(raw,true);await this.deliver(response.frames);if(this.stopped||this.ended(response))return;this.receiveFailures=0;
   }catch(error){
    if(this.stopped)return;const e=error instanceof Error?error:new Error(translate(documentLocale(),'rdp.transport.receiveFailed'));
    const failure=requestFailure(e,phase==='request',timedOut);if(!failure.transient||++this.receiveFailures>=3){this.fail(failure.timeout?mailboxTimeout(e):e);return;}delay=500;
   }finally{clearTimeout(timeout);if(this.receiveController===controller)this.receiveController=null;this.receiving=false;if(!this.stopped)this.scheduleReceive(delay);}
  }
  private fail(error:Error){options.onFailure?.(error);this.emit(new Event('error'));this.finish(1011,error.message.slice(0,120),false,true);}
  private finish(code:number,reason:string,clean:boolean,notify:boolean){
   if(this.stopped)return;this.stopped=true;this.readyState=this.CLOSING;this.controller?.abort();this.receiveController?.abort();if(this.timer)clearTimeout(this.timer);if(this.receiveTimer)clearTimeout(this.receiveTimer);this.timer=null;this.receiveTimer=null;
   for(const item of this.queue)for(const part of item.parts)if(part instanceof Uint8Array)part.fill(0);this.queue=[];this.retained=[];this.receipts.clear();this.bufferedAmount=0;this.boundary.clear();
   if(notify)void options.request({action:'close',id:options.id}).catch(()=>{});
   this.readyState=this.CLOSED;queueMicrotask(()=>this.emit(closeEvent(code,reason,clean)));
  }
  close(code=1000,reason=''){
   if(code!==1000&&(code<3000||code>4999))throw new DOMException(translate(documentLocale(),'rdp.transport.closeCode'),'InvalidAccessError');
   if(new TextEncoder().encode(reason).length>123)throw new DOMException(translate(documentLocale(),'rdp.transport.closeReason'),'SyntaxError');
   this.finish(code,reason,true,true);
  }
 };
}
