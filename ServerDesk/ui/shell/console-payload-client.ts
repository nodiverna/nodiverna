// The main thread's side of the console's payload worker (ui/shell/console-payload.worker.ts): it gives every content
// state a version, sends the answer body (a Blob is passed by handle, an ArrayBuffer is transferred) and matches the
// replies to their requests. When the worker cannot start or fails (error, messageerror), every waiting and every
// later request rejects and `failed` is true: the console then reads its answers on the main thread for good
// (ui/shell/use-console-data.ts).
import type {Job,Viewer} from '@/lib/types';
import type {PayloadReply,PayloadRequest} from '@/ui/shell/console-payload';

export type ConsolePayloadWorker={
 /** True once the worker failed: no later request reaches it. */
 readonly failed:boolean;
 /** Parses the answer body and diffs it against version base (null: no base). */
 parse(body:Blob|ArrayBuffer,base:number|null):Promise<PayloadReply>;
 /** Gives the worker the answer body as a new version, with no reply (the main thread parses it itself); returns its id. */
 seed(body:Blob|ArrayBuffer):number;
 /** The full data of version id, or `missing`. */
 full(id:number):Promise<PayloadReply>;
 /** Makes a new version from base with the jobs poll's jobs and viewer; returns its id. */
 jobs(base:number,jobs:Job[],viewer:Viewer):number;
 /** Ends the worker; waiting requests reject (without marking it failed). */
 terminate():void;
};

/** The part of a Worker the client uses (a test passes its own). */
export type PayloadPort={
 postMessage(message:PayloadRequest,transfer?:Transferable[]):void;
 addEventListener(type:'message'|'error'|'messageerror',listener:(event:Event)=>void):void;
 terminate():void;
};

/** The worker's failure, as the rejection of a request. */
export class PayloadWorkerError extends Error {}

/** A client on port. */
export function consolePayloadClient(port:PayloadPort):ConsolePayloadWorker{
 const waiting=new Map<number,{resolve:(reply:PayloadReply)=>void;reject:(failure:Error)=>void}>();
 let version=0,failed=false,ended=false;
 const stop=(failure:Error)=>{ended=true;for(const request of waiting.values())request.reject(failure);waiting.clear();port.terminate();};
 const fail=()=>{if(ended)return;failed=true;stop(new PayloadWorkerError('The console payload worker failed'));};
 port.addEventListener('message',event=>{
  const reply=(event as MessageEvent<PayloadReply|{type:'broken'}>).data;
  if(reply.type==='broken'){fail();return;}
  const request=waiting.get(reply.id);
  if(request){waiting.delete(reply.id);request.resolve(reply);}
 });
 port.addEventListener('error',event=>{event.preventDefault();fail();});
 port.addEventListener('messageerror',fail);
 const transfer=(body:Blob|ArrayBuffer)=>body instanceof ArrayBuffer?[body]:[];
 const send=(message:PayloadRequest,transferred:Transferable[]=[])=>new Promise<PayloadReply>((resolve,reject)=>{
  if(ended){reject(new PayloadWorkerError('The console payload worker has ended'));return;}
  waiting.set(message.id,{resolve,reject});
  try{port.postMessage(message,transferred);}catch{fail();}
 });
 /** A message without a reply; returns the version it makes. */
 const post=(message:PayloadRequest,transferred:Transferable[]=[])=>{
  if(!ended)try{port.postMessage(message,transferred);}catch{fail();}
  return message.id;
 };
 return {
  get failed(){return failed;},
  parse:(body,base)=>send({type:'parse',id:++version,base,body},transfer(body)),
  seed:body=>post({type:'seed',id:++version,body},transfer(body)),
  full:id=>send({type:'full',id}),
  jobs:(base,jobs,viewer)=>post({type:'jobs',id:++version,base,jobs,viewer}),
  terminate(){if(!ended)stop(new PayloadWorkerError('The console payload worker has ended'));},
 };
}

/** A new worker with its client, or null where workers do not exist or cannot start. */
export function startConsolePayloadWorker():ConsolePayloadWorker|null{
 if(typeof Worker==='undefined')return null;
 try{return consolePayloadClient(new Worker(new URL('./console-payload.worker.ts',import.meta.url),{type:'module',name:'console-payload'}));}
 catch{return null;}
}
