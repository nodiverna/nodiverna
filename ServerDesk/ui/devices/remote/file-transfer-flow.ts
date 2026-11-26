import {translate} from '@/lib/i18n/translate';
import {defaultLocale,type Locale} from '@/lib/i18n/locale';
import {storedMessageText} from '@/lib/server-messages';
// Browser-side transfer orchestration. Only an explicitly created transfer ID
// is observed, so completed history entries can never trigger local downloads.
export const FILE_CHUNK_SIZE=262144,MAX_FILE_SIZE=268435456,TRANSFER_TIMEOUT_MS=600000;
export type BrowserTransfer={id:string;direction:'download'|'upload';path:string;size:number|null;sha256:string|null;state:string;transferredBytes?:number;message?:string|null};
export type TransferProgress={phase:'waiting'|'streaming'|'verifying';done:number;total:number|null;label:string};
export type TransferGuard={signal:AbortSignal;isCurrent:()=>boolean};
export function assertTransferCurrent({signal,isCurrent}:TransferGuard,locale:Locale=defaultLocale){if(signal.aborted||!isCurrent())throw new DOMException(translate(locale,'jobs.state.cancelled'),'AbortError');}
export async function fileHash(buffer:ArrayBuffer){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',buffer))).map(byte=>byte.toString(16).padStart(2,'0')).join('');}
export function transferDelay(milliseconds:number,signal:AbortSignal,locale:Locale=defaultLocale){return new Promise<void>((resolve,reject)=>{
 if(signal.aborted){reject(new DOMException(translate(locale,'jobs.state.cancelled'),'AbortError'));return;}
 const abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(new DOMException(translate(locale,'jobs.state.cancelled'),'AbortError'));};
 const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},milliseconds);signal.addEventListener('abort',abort,{once:true});
});}
export async function waitForCreatedTransfer({id,direction,list,guard,onProgress,wait=transferDelay}:{id:string;direction:'upload'|'download';list:(signal:AbortSignal)=>Promise<BrowserTransfer[]>;guard:TransferGuard;onProgress:(progress:TransferProgress)=>void;wait?:(milliseconds:number,signal:AbortSignal)=>Promise<void>},locale:Locale=defaultLocale){
 while(true){
  assertTransferCurrent(guard);const transfers=await list(guard.signal);assertTransferCurrent(guard);
  const transfer=transfers.find(item=>item.id===id);
  if(transfer){
   if(transfer.direction!==direction)throw new Error(translate(locale,'files.transfer.mismatch'));
   if(transfer.state==='completed')return transfer;
   if(['failed','cancelled','expired'].includes(transfer.state))throw new Error(storedMessageText(transfer.message,(key,params)=>translate(locale,key,params))||translate(locale,'files.transfer.failed'));
   onProgress({phase:'waiting',done:transfer.transferredBytes??0,total:transfer.size,label:transfer.state==='active'?translate(locale,'files.transfer.agentActive'):translate(locale,'files.transfer.waiting')});
  }
  await wait(1000,guard.signal);
 }
}
export async function runCreatedDownload({create,list,readChunk,save,guard,onProgress,onCreated,wait=transferDelay,hash=fileHash,timeoutMs=TRANSFER_TIMEOUT_MS}:{
 create:(signal:AbortSignal)=>Promise<{id:string}>;list:(signal:AbortSignal)=>Promise<BrowserTransfer[]>;
 readChunk:(id:string,index:number,signal:AbortSignal)=>Promise<ArrayBuffer>;save:(bytes:Uint8Array,path:string)=>void;
 guard:TransferGuard;onProgress:(progress:TransferProgress)=>void;onCreated?:(id:string)=>void;
 wait?:(milliseconds:number,signal:AbortSignal)=>Promise<void>;hash?:(buffer:ArrayBuffer)=>Promise<string>;timeoutMs?:number;
},locale:Locale=defaultLocale){
 const controller=new AbortController();let timedOut=false;
 const abort=()=>controller.abort();guard.signal.addEventListener('abort',abort,{once:true});if(guard.signal.aborted)controller.abort();
 const timer=setTimeout(()=>{timedOut=true;controller.abort();},timeoutMs),current={signal:controller.signal,isCurrent:guard.isCurrent};
 try{
  assertTransferCurrent(current);const {id}=await create(current.signal);assertTransferCurrent(current);
  if(typeof id!=='string'||!id)throw new Error(translate(locale,'files.transfer.createFailed'));onCreated?.(id);
  const item=await waitForCreatedTransfer({id,direction:'download',list,guard:current,onProgress,wait},locale);assertTransferCurrent(current);
  if(!Number.isSafeInteger(item.size)||item.size===null||item.size<0||item.size>MAX_FILE_SIZE)throw new Error(translate(locale,'files.transfer.tooLarge'));
  if(typeof item.sha256!=='string'||!/^[a-f0-9]{64}$/.test(item.sha256))throw new Error(translate(locale,'files.transfer.noHash'));
  const bytes=new Uint8Array(item.size);let loaded=0;
  for(let index=0;index<Math.ceil(item.size/FILE_CHUNK_SIZE);index++){
   assertTransferCurrent(current);onProgress({phase:'streaming',done:loaded,total:item.size,label:translate(locale,'files.transfer.downloading')});
   const block=await readChunk(id,index,current.signal);assertTransferCurrent(current);
   const expected=Math.min(FILE_CHUNK_SIZE,item.size-loaded);if(block.byteLength!==expected)throw new Error(translate(locale,'files.transfer.badBlock'));
   bytes.set(new Uint8Array(block),loaded);loaded+=block.byteLength;
  }
  if(loaded!==item.size)throw new Error(translate(locale,'files.transfer.badSize'));
  onProgress({phase:'verifying',done:loaded,total:item.size,label:translate(locale,'files.transfer.verifying')});
  const digest=await hash(bytes.buffer);assertTransferCurrent(current);
  if(digest!==item.sha256)throw new Error(translate(locale,'files.transfer.badHash'));
  save(bytes,item.path);return item;
 }catch(error){if(timedOut)throw new Error(translate(locale,'files.transfer.timeout'));throw error;}
 finally{clearTimeout(timer);guard.signal.removeEventListener('abort',abort);}
}
