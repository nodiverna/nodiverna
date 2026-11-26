// Refresh the small session roster independently of terminal output. Visibility
// changes wake discovery; a background/offline tab has no recurring requests.
export const TERMINAL_SESSION_REFRESH_MS=2500;
export const TERMINAL_SESSION_RETRY_MAX_MS=30000;
export const TERMINAL_SESSION_REQUEST_TIMEOUT_MS=8000;

type RequestTimer={schedule?:(callback:()=>void,delay:number)=>unknown;cancel?:(handle:unknown)=>void};

// Fetch normally rejects on abort. The explicit race also bounds callers whose
// transport does not settle immediately, so one lost request cannot stop all
// subsequent roster updates.
export function createTerminalSessionRequest<T>(request:(signal:AbortSignal)=>Promise<T>,{schedule=(callback,delay)=>setTimeout(callback,delay),cancel=handle=>clearTimeout(handle as ReturnType<typeof setTimeout>)}:RequestTimer={}){
  const controller=new AbortController();
  let rejectAbort:(reason:unknown)=>void=()=>{};
  const aborted=new Promise<never>((_resolve,reject)=>{rejectAbort=reject;});
  const onAbort=()=>rejectAbort(new DOMException('Aktualisierung der Sitzungen abgebrochen.','AbortError'));
  controller.signal.addEventListener('abort',onAbort,{once:true});
  const timer=schedule(()=>controller.abort(),TERMINAL_SESSION_REQUEST_TIMEOUT_MS);
  const result=Promise.resolve().then(()=>{controller.signal.throwIfAborted();return request(controller.signal);});
  const promise=Promise.race([result,aborted]).finally(()=>{cancel(timer);controller.signal.removeEventListener('abort',onAbort);});
  return {promise,abort:()=>controller.abort()};
}

type DiscoveryOptions={
  refresh:()=>Promise<boolean>;
  canRefresh:()=>boolean;
  schedule?:(callback:()=>void,delay:number)=>unknown;
  cancel?:(handle:unknown)=>void;
};

export function createTerminalSessionDiscovery({refresh,canRefresh,schedule=(callback,delay)=>setTimeout(callback,delay),cancel=handle=>clearTimeout(handle as ReturnType<typeof setTimeout>)}:DiscoveryOptions){
  let stopped=true,inFlight=false,queued=false,failures=0,timer:unknown;
  const clear=()=>{if(timer!==undefined){cancel(timer);timer=undefined;}};
  const request=()=>{
    if(stopped)return;
    clear();
    if(!canRefresh())return;
    if(inFlight){queued=true;return;}
    inFlight=true;
    void Promise.resolve().then(refresh).catch(()=>false).then(succeeded=>{
      failures=succeeded?0:Math.min(failures+1,4);
    }).finally(()=>{
      inFlight=false;
      if(stopped||!canRefresh()){queued=false;return;}
      const delay=queued&&failures===0?0:failures?Math.min(TERMINAL_SESSION_RETRY_MAX_MS,TERMINAL_SESSION_REFRESH_MS*2**failures):TERMINAL_SESSION_REFRESH_MS;
      queued=false;timer=schedule(request,delay);
    });
  };
  return {start:()=>{stopped=false;request();},request,stop:()=>{stopped=true;queued=false;clear();}};
}
