import {translate} from '@/lib/i18n/translate';
import {defaultLocale,type Locale} from '@/lib/i18n/locale';
export type DiagnosisJob={id:string;kind:string;state:string;createdAt:number;claimedAt:number|null;result:string|null;resultCode?:string|null;resultArgs?:Record<string,string>|null;data:{kind:string;at:string;data:Record<string,unknown>}|null};
export type DiagnosisSubmission={id:string;kind:string;at:number};
export const DIAGNOSIS_REQUEST_TIMEOUT_MS=10000;
export const DIAGNOSIS_JOB_WAIT_MS=60000;
export const diagnosisRunning=(job:DiagnosisJob)=>['pending','queued','running'].includes(job.state);

type ClientOptions={
  isCurrent?:()=>boolean;
  canSubmit?:(kind:string)=>boolean;
  read:(signal:AbortSignal)=>Promise<{jobs:DiagnosisJob[]}>;
  post:(kind:string,params:Record<string,unknown>,confirm:boolean,signal:AbortSignal)=>Promise<{id:string}>;
  onJobs?:(jobs:DiagnosisJob[])=>void;
  onError?:(error:unknown,source:'read'|'submit')=>void;
  onLoading?:(loading:boolean)=>void;
  onBusy?:(kind:string|null)=>void;
  onSubmitted?:(submission:DiagnosisSubmission)=>void;
  onAutomatic?:(preparing:boolean)=>void;
  clock?:()=>number;
  schedule?:(callback:()=>void,delay:number)=>unknown;
  cancel?:(handle:unknown)=>void;
};
const aborted=(locale:Locale=defaultLocale)=>new DOMException(translate(locale,'diagnostics.client.closed'),'AbortError');

// One client belongs to one mounted device scope. Requests never overlap a
// matching read/submit and disposal prevents all late callbacks or job replays.
export function createDiagnosisClient(options:ClientOptions,locale:Locale=defaultLocale){
  const {clock=Date.now,schedule=(callback,delay)=>setTimeout(callback,delay),cancel=handle=>clearTimeout(handle as ReturnType<typeof setTimeout>)}=options;
  let active=true,loading:Promise<DiagnosisJob[]|null>|null=null,submitting:{key:string;promise:Promise<string>}|null=null;
  const controllers=new Set<AbortController>(),automaticKinds=new Set<string>();
  const isActive=()=>active&&(options.isCurrent?.()??true);
  const notify=(callback:(()=>void)|undefined)=>{if(isActive())callback?.();};
  const request=async<T,>(run:(signal:AbortSignal)=>Promise<T>):Promise<T>=>{
    if(!isActive())throw aborted(locale);
    const controller=new AbortController();controllers.add(controller);
    let rejectAbort:(reason:unknown)=>void=()=>{};
    const canceled=new Promise<never>((_resolve,reject)=>{rejectAbort=reject;});
    const onAbort=()=>rejectAbort(aborted(locale));controller.signal.addEventListener('abort',onAbort,{once:true});
    const timer=schedule(()=>{rejectAbort(new Error(translate(locale,'diagnostics.client.timeout')));controller.abort();},DIAGNOSIS_REQUEST_TIMEOUT_MS);
    try{
      const response=await Promise.race([Promise.resolve().then(()=>{controller.signal.throwIfAborted();if(!isActive())throw aborted(locale);return run(controller.signal);}),canceled]);
      if(!isActive())throw aborted(locale);return response;
    }finally{cancel(timer);controller.signal.removeEventListener('abort',onAbort);controllers.delete(controller);}
  };
  const load=():Promise<DiagnosisJob[]|null>=>{
    if(!isActive())return Promise.resolve(null);
    if(loading)return loading;
    notify(()=>options.onLoading?.(true));
    const result=(async()=>{
      try{const response=await request(options.read);if(!Array.isArray(response.jobs))throw new Error(translate(locale,'diagnostics.client.invalidList'));notify(()=>options.onJobs?.(response.jobs));return response.jobs;}
      catch(error){notify(()=>options.onError?.(error,'read'));return null;}
      finally{notify(()=>options.onLoading?.(false));}
    })();
    loading=result;void result.finally(()=>{if(loading===result)loading=null;});return result;
  };
  const submit=(kind:string,params:Record<string,unknown>={},confirm=false):Promise<string>=>{
    if(!isActive())return Promise.reject(aborted(locale));
    if(options.canSubmit&&!options.canSubmit(kind))return Promise.reject(new Error(translate(locale,'diagnostics.client.unreachable')));
    const key=JSON.stringify([kind,params,confirm]);
    if(submitting)return submitting.key===key?submitting.promise:Promise.reject(new Error(translate(locale,'diagnostics.client.busy')));
    notify(()=>options.onBusy?.(kind));
    const promise=(async()=>{
      try{
        // Reopening a sessions tab or repeated clicks reuse a pending query.
        // A failed discovery never blindly creates a second agent job.
        if(kind==='list-sessions'){
          const jobs=await load();if(!isActive())throw aborted(locale);
          if(!jobs)throw new Error(translate(locale,'diagnostics.client.sessionCheck'));
          if(options.canSubmit&&!options.canSubmit(kind))throw new Error(translate(locale,'diagnostics.client.unreachable'));
          const existing=jobs.find(job=>job.kind===kind&&diagnosisRunning(job));
          if(existing){notify(()=>options.onSubmitted?.({id:existing.id,kind,at:existing.createdAt}));return existing.id;}
        }
        const response=await request(signal=>options.post(kind,params,confirm,signal));
        notify(()=>options.onSubmitted?.({id:response.id,kind,at:clock()}));
        await load();if(!isActive())throw aborted(locale);return response.id;
      }catch(error){notify(()=>options.onError?.(error,'submit'));throw error;}
      finally{notify(()=>options.onBusy?.(null));}
    })();
    submitting={key,promise};void promise.then(()=>{if(submitting?.promise===promise)submitting=null;},()=>{if(submitting?.promise===promise)submitting=null;});return promise;
  };
  const automatic=async(kind:string)=>{
    if(!isActive()||automaticKinds.has(kind))return;
    automaticKinds.add(kind);notify(()=>options.onAutomatic?.(true));
    try{await submit(kind);}catch{}
    finally{notify(()=>options.onAutomatic?.(false));}
  };
  const dispose=()=>{active=false;for(const controller of controllers)controller.abort();controllers.clear();};
  return {load,submit,automatic,dispose};
}

export function diagnosisQueryState(jobs:DiagnosisJob[],kind:string,submitted:DiagnosisSubmission|null,now=Date.now()){
  const target=submitted?.kind===kind?jobs.find(job=>job.id===submitted.id):jobs.find(job=>job.kind===kind);
  const waiting=!!target&&diagnosisRunning(target)||submitted?.kind===kind&&!target;
  const startedAt=target?.createdAt??(submitted?.kind===kind?submitted.at:now);
  return {pending:!!waiting&&now-startedAt<DIAGNOSIS_JOB_WAIT_MS,timedOut:!!waiting&&now-startedAt>=DIAGNOSIS_JOB_WAIT_MS};
}
