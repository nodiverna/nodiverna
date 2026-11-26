type Options<T>={
 now:()=>number;idleRemaining:()=>number;isLive:()=>boolean;
 send:(signal:AbortSignal)=>Promise<T>;onReply:(reply:T)=>void;
 onError:(error:unknown)=>void;shouldRetry:(error:unknown)=>boolean;
};
export function createSessionActivity<T>(options:Options<T>){
 let disposed=false,pending=false,sending=false,lastSent:number|null=null,lastInteraction=0;
 let controller:AbortController|null=null;
 const flush=async()=>{
  if(disposed||!pending||sending||!options.isLive())return;
  pending=false;sending=true;lastSent=options.now();
  const current=new AbortController();controller=current;
  const timeout=setTimeout(()=>current.abort(),8000);
  try{const reply=await options.send(current.signal);if(!disposed&&options.isLive())options.onReply(reply);}
  catch(error){if(!disposed&&options.isLive()){
   options.onError(error);
   // Retries represent recent genuine input only. A request that hangs cannot
   // block future renewals, and background retries cannot keep an idle tab live.
   if(options.shouldRetry(error)&&options.now()-lastInteraction<30000)pending=true;
  }}
  finally{clearTimeout(timeout);if(controller===current)controller=null;sending=false;}
 };
 return {
  interact(){
   if(disposed||!options.isLive())return;
   pending=true;lastInteraction=options.now();
   if(lastSent===null||options.now()-lastSent>=15000||options.idleRemaining()<15000)void flush();
  },
  flush,
  dispose(){disposed=true;pending=false;controller?.abort();},
 };
}

export function watchPortalActivity(target:Pick<EventTarget,'addEventListener'|'removeEventListener'>,visible:()=>boolean,onInteract:()=>void){
 const events=['pointerdown','pointermove','keydown','wheel','touchstart'] as const;
 const interacted=(event:Event)=>{if(event.isTrusted&&visible())onInteract();};
 // Terminal textareas and dialogs may stop bubbling keyboard/pointer events.
 // Capture sees genuine input before those components consume it.
 for(const event of events)target.addEventListener(event,interacted,{capture:true,passive:true});
 return()=>{for(const event of events)target.removeEventListener(event,interacted,true);};
}

// Only the dedicated, currently mounted same-origin RDP iframe may report
// trusted keyboard/mouse events. Network polling and synthetic parent events
// are deliberately excluded from MFA inactivity renewal.
export function watchRemoteDesktopActivity(target:Pick<EventTarget,'addEventListener'|'removeEventListener'>,origin:string,frames:()=>Iterable<{contentWindow:unknown;serverId:string}>,visible:()=>boolean,onInteract:()=>void){
 const interacted=(raw:Event)=>{
  const event=raw as MessageEvent;
  if(!event.isTrusted||!visible()||event.origin!==origin||!event.data||event.data.type!=='serverdesk:rdp:activity'||typeof event.data.serverId!=='string')return;
  for(const frame of frames())if(frame.contentWindow&&event.source===frame.contentWindow&&event.data.serverId===frame.serverId){onInteract();return;}
 };
 target.addEventListener('message',interacted);
 return()=>target.removeEventListener('message',interacted);
}
