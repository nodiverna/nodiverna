'use client';
import {startTransition,useCallback,useEffect,useRef,useState} from 'react';
import {toast} from 'sonner';
import type {ConsoleData,Job,Sample,Viewer} from '@/lib/types';
import {credentialFetch,invalidApiReply,readApiJson} from '@/ui/base/api';
import {useStableT} from '@/ui/base/locale';
import {useClockValue} from '@/ui/base/clock-store';
import {mergeConsoleDataInSlices,mergeConsoleJobs} from '@/ui/shell/keep-equal';
import {applyConsolePatch} from '@/ui/shell/console-payload';
import {startConsolePayloadWorker,type ConsolePayloadWorker} from '@/ui/shell/console-payload-client';
import {apiErrorText} from '@/ui/base/api-error-text';
import {documentLocale} from '@/lib/i18n/locale';
import {openPluginJobIds,pluginJobSettled} from '@/lib/extensions';

/**
 * Loads the console snapshot, keeps it fresh and polls jobs while any are active. Each answer is merged into the
 * shown data: every part that did not change keeps its identity, so memoized views skip it. Where workers exist, a
 * refresh reads the answer as a Blob and hands it to the console's payload worker (ui/shell/console-payload.worker.ts),
 * which reads, parses and diffs it against its copy of the shown data; the main thread only applies the small patch
 * (ui/shell/console-payload.ts). The first load (no shown data yet) is parsed here as before; its bytes seed the worker.
 * Without a worker, after it failed and for non-ok answers, the answer is parsed here and compared in slices
 * (ui/shell/keep-equal.ts), as before. The state update of a refresh and of the jobs poll is a transition: React
 * renders it in slices and lets input and frames go first; an answer equal to the shown data sets no data. A refresh
 * resolves once its data is on screen, so `await refresh(true)` callers see it. When an extension install or removal
 * of any device leaves pending/running, it reloads once at once (never in demo mode, never on the first load), so
 * every view shows the device data the job result wrote without waiting for the 30 s reload.
 */
export function useConsoleData(demo:boolean){
 const [data,setData]=useState<ConsoleData|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[checkedAt,setCheckedAt]=useState<number|null>(null),[shown,setShown]=useState(0);
 const t=useStableT(),sequence=useRef(0),inFlight=useRef<Promise<void>|null>(null),jobsInFlight=useRef(false);
 // The data of the last update (also before React rendered it): the base of the next merge.
 const latest=useRef<ConsoleData|null>(null);
 // The payload worker: undefined until a refresh needs it, null where it cannot run or after it failed (the answers
 // are then read here for good). `version` is the worker's version of `latest`; null: the worker does not hold it,
 // so the next answer comes in full.
 const worker=useRef<ConsolePayloadWorker|null|undefined>(undefined),version=useRef<number|null>(null),mounted=useRef(false);
 useEffect(()=>{
  mounted.current=true;
  return()=>{mounted.current=false;const client=worker.current;worker.current=undefined;version.current=null;client?.terminate();};
 },[]);
 // The refreshes that wait for their data to be on screen; the effect of `shown` releases them after each commit.
 const waiting=useRef<(()=>void)[]>([]);
 useEffect(()=>{for(const resolve of waiting.current.splice(0))resolve();},[shown]);
 // next: the new data (null: the data did not change); at: the worker's version of it.
 const show=useCallback((next:ConsoleData|null,at:number|null,extra?:()=>void):Promise<void>=>{
  if(next)latest.current=next;
  version.current=at;
  const done=new Promise<void>(resolve=>waiting.current.push(resolve));
  startTransition(()=>{if(next)setData(next);extra?.();setShown(count=>count+1);});
  return done;
 },[]);
 const request=useCallback(async():Promise<void>=>{
  const current=++sequence.current;setLoading(true);
  type Read={data:ConsoleData;at:number|null}|undefined;
  // On the main thread. The device list is compared in slices (ui/shell/keep-equal.ts), so a large unchanged answer is no long task either.
  const readHere=async(response:Response):Promise<Read>=>{
   const payload=await readApiJson<ConsoleData&{error?:string}>(response);
   if(current!==sequence.current)return;
   if(!response.ok){if(response.status===401||response.status===403){latest.current=null;version.current=null;setData(null);}throw new Error(apiErrorText(documentLocale(),payload,t('console.loadFailed')));}
   return {data:await mergeConsoleDataInSlices(latest.current,payload),at:null};
  };
  // With the worker. The first load (also after a reset) is read and parsed here, as fast as before (arrayBuffer() reads
  // the body while it arrives, as json() did); the bytes then go to the worker as the base of the next refresh.
  const firstLoad=async(client:ConsolePayloadWorker,response:Response):Promise<Read>=>{
   let bytes:ArrayBuffer,payload:ConsoleData;
   try{bytes=await response.arrayBuffer();}catch{throw invalidApiReply(response.status);}
   if(current!==sequence.current)return;
   const text=new TextDecoder().decode(bytes),at=client.seed(bytes);
   try{payload=JSON.parse(text);}catch{throw invalidApiReply(response.status);}
   return {data:payload,at:client.failed?null:at};
  };
  // A refresh: response.blob() leaves the bytes with the browser (arrayBuffer() would copy the ~4 MB answer into this
  // thread in one long task); the worker reads the Blob, parses and diffs it, and a patch comes back. The Blob stays
  // here for the main-thread path.
  const readInWorker=async(client:ConsolePayloadWorker,response:Response):Promise<Read>=>{
   if(!latest.current)return firstLoad(client,response);
   let body:Blob;
   try{body=await response.blob();}catch{throw invalidApiReply(response.status);}
   if(current!==sequence.current)return;
   const here=()=>{
    if(client.failed&&worker.current===client)worker.current=null;
    return readHere(new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers}));
   };
   let reply;
   try{reply=await client.parse(body,version.current);}catch{return here();}
   if(current!==sequence.current)return;
   if(reply.type==='invalid')throw invalidApiReply(response.status);
   if(reply.type==='patch'&&latest.current&&reply.base===version.current){
    try{return {data:applyConsolePatch(latest.current,reply.patch),at:reply.id};}catch{/* A patch that does not fit: the full answer below. */}
   }
   // No base, or the shown data moved on since the request: the full answer, merged as on the main thread.
   const full=reply.type==='full'?reply:await client.full(reply.id).catch(()=>null);
   if(current!==sequence.current)return;
   if(full?.type!=='full')return here();
   return {data:await mergeConsoleDataInSlices(latest.current,full.data),at:full.id};
  };
  try{
   const response=await credentialFetch('/api/console',{cache:'no-store'});
   if(worker.current?.failed)worker.current=null;
   if(response.ok&&worker.current===undefined&&mounted.current)worker.current=startConsolePayloadWorker();
   const client=response.ok?worker.current:null;
   const read=client?await readInWorker(client,response):await readHere(response);
   if(!read||current!==sequence.current)return;
   await show(read.data===latest.current?null:read.data,read.at,()=>{setError('');setCheckedAt(Date.now());setLoading(false);});
  }catch(failure){if(current===sequence.current)setError(failure instanceof Error?failure.message:t('console.loadFailed'));}
  finally{if(current===sequence.current)setLoading(false);}
 },[t,show]);
 // Concurrent callers share one request; `fresh` waits for it and then asks again.
 const refresh=useCallback(async(fresh=false):Promise<void>=>{
  if(inFlight.current){await inFlight.current;if(!fresh)return;if(inFlight.current){await inFlight.current;return;}}
  const task=request();
  inFlight.current=task;void task.finally(()=>{if(inFlight.current===task)inFlight.current=null;});
  return task;
 },[request]);
 useEffect(()=>{void refresh();},[refresh]);
 useEffect(()=>{if(demo)return;const timer=setInterval(()=>void refresh(),30000);return()=>clearInterval(timer);},[refresh,demo]);
 useEffect(()=>{let timer:ReturnType<typeof setTimeout>;const schedule=()=>{clearTimeout(timer);timer=setTimeout(()=>void refresh(true),300);};window.addEventListener('serverdesk:refresh',schedule);return()=>{clearTimeout(timer);window.removeEventListener('serverdesk:refresh',schedule);};},[refresh]);
 // The jobs poll runs while a job is running or a pending job is due: a selector of the console clock, so the poll
 // starts on the tick its notBefore passes and the console does not render on the other ticks.
 const activeJobs=useClockValue(now=>data?.jobs.some(job=>['pending','running'].includes(job.state)&&(job.notBefore??0)<=now)??false);
 useEffect(()=>{
  if(demo||!activeJobs)return;
  let disposed=false;const abort=new AbortController();
  const poll=async()=>{
   if(inFlight.current||jobsInFlight.current)return;
   jobsInFlight.current=true;const request=sequence.current;
   try{
    const response=await credentialFetch('/api/console?jobsOnly=1',{cache:'no-store',signal:abort.signal});
    const payload=await readApiJson<{jobs:Job[];viewer:Viewer;error?:string}>(response);
    if(disposed||request!==sequence.current)return;
    if(!response.ok){if(response.status===401||response.status===403)void refresh();return;}
    const previous=latest.current;if(!previous)return;
    const merged=mergeConsoleJobs(previous,payload.jobs,payload.viewer),client=worker.current;
    // The worker takes the same step on its copy, so the next refresh's patch fits the merged data.
    const at=merged===previous?version.current:client&&version.current!==null?client.jobs(version.current,payload.jobs,payload.viewer):null;
    void show(merged===previous?null:merged,at);
   }catch{}finally{jobsInFlight.current=false;}
  };
  const timer=setInterval(()=>void poll(),3000);
  return()=>{disposed=true;abort.abort();clearInterval(timer);};
 },[demo,activeJobs,refresh,show]);
 const jobs=data?.jobs,openPluginJobs=useRef<ReadonlySet<string>|null>(null);
 useEffect(()=>{
  if(!jobs)return;
  const ids=openPluginJobIds(jobs),before=openPluginJobs.current;
  openPluginJobs.current=ids;
  if(!demo&&before&&pluginJobSettled(before,ids))void refresh(true);
 },[jobs,demo,refresh]);
 return {data,error,loading,checkedAt,refresh};
}

/** Utilisation history of the open device, refreshed with the heartbeat cadence. */
export function useDeviceHistory(deviceId:string|undefined,enabled:boolean){
 const t=useStableT(),[samples,setSamples]=useState<Sample[]>([]),[loading,setLoading]=useState(false);
 useEffect(()=>{
  if(!enabled||!deviceId){queueMicrotask(()=>setLoading(false));return;}
  let cancelled=false;const controller=new AbortController();
  queueMicrotask(()=>{if(!cancelled){setSamples([]);setLoading(true);}});
  const load=async()=>{
   try{
    const response=await credentialFetch('/api/history?serverId='+encodeURIComponent(deviceId),{cache:'no-store',signal:controller.signal});
    const payload=await readApiJson<{samples:Sample[];error?:string}>(response);
    if(!response.ok)throw new Error(apiErrorText(documentLocale(),payload,t('console.historyFailed')));
    if(!cancelled)setSamples(payload.samples);
   }catch(failure){if(!cancelled&&!controller.signal.aborted)toast.error(failure instanceof Error?failure.message:t('console.historyFailed'));}
   finally{if(!cancelled)setLoading(false);}
  };
  void load();const timer=setInterval(()=>void load(),30000);
  return()=>{cancelled=true;controller.abort();clearInterval(timer);};
 },[deviceId,enabled,t]);
 return {samples,loading};
}
