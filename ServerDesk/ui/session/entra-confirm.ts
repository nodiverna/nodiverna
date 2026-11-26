'use client';
// "Confirm with Microsoft" in the console (docs/entra-id.md): the step-up dialog
// (MfaStepUp) of an account from
// Microsoft Entra ID uses it. The click opens an empty window at once, so
// pop-up blockers allow it; then entra-begin moves the window to Microsoft and
// entra-claim is polled every second until a result, a refusal, the expiry or
// the closed window. The callback page has no script; the opener closes it.
import {useCallback,useEffect,useRef,useState} from 'react';
import {api,message} from '@/ui/base/api';
import {useT} from '@/ui/base/locale';

/** The window name and features of the Microsoft window. */
export const entraConfirmWindow={name:'nodiverna-entra-confirm',features:'popup,width=520,height=680'};
export const entraClaimIntervalMs=1000;
/** The part of a browser window the flow uses. */
export type ConfirmWindow={readonly closed:boolean;close():void;location:{replace(url:string):void}};
/** The reply of a successful claim: the verify reply (session fields and the 5-minute managementToken). */
export type EntraConfirmResult={authenticated?:boolean;managementToken?:string;managementExpiresAt?:number;[key:string]:unknown};
type BeginReply={flow:string;url:string;expiresAt:number};
type ClaimReply={pending:true}|EntraConfirmResult;
export type EntraConfirmFailure={kind:'blocked'}|{kind:'closed'}|{kind:'server';error:unknown};
export type EntraConfirmDeps={
 /** Opens the empty window; null when the browser blocked it. Called synchronously by run(). */
 openWindow:()=>ConfirmWindow|null;
 post:(body:Record<string,unknown>,signal:AbortSignal)=>Promise<unknown>;
 now:()=>number;
 wait:(callback:()=>void,ms:number)=>()=>void;
 onSuccess:(result:EntraConfirmResult)=>void;
 onFailure:(failure:EntraConfirmFailure)=>void;
};

/**
 * One confirmation. It opens the window before anything is sent (a blocked
 * window sends nothing), then begins and polls one claim at a time. After the
 * window closes, or once the flow expires, it sends one last claim. cancel()
 * stops at once: no further request, no callback, and the window closes.
 */
export function runEntraConfirm(deps:EntraConfirmDeps){
 const controller=new AbortController();
 let stopped=false,clearWait:(()=>void)|null=null;
 const popup=deps.openWindow();
 if(!popup){deps.onFailure({kind:'blocked'});return {cancel:()=>{}};}
 const finish=()=>{stopped=true;clearWait?.();clearWait=null;try{if(!popup.closed)popup.close();}catch{/* The window may already be gone. */}};
 const fail=(failure:EntraConfirmFailure)=>{if(stopped)return;finish();deps.onFailure(failure);};
 const succeed=(result:EntraConfirmResult)=>{if(stopped)return;finish();deps.onSuccess(result);};
 const claim=async(flow:string,expiresAt:number)=>{
  if(stopped)return;
  // A closed window or the end of the flow gets exactly one last claim.
  const last=popup.closed||deps.now()>=expiresAt;
  let reply:ClaimReply;
  try{reply=await deps.post({action:'entra-claim',flow},controller.signal) as ClaimReply;}
  catch(error){if(!stopped&&!controller.signal.aborted)fail({kind:'server',error});return;}
  if(stopped)return;
  if(!('pending' in reply&&reply.pending===true)){succeed(reply as EntraConfirmResult);return;}
  if(last){fail({kind:'closed'});return;}
  clearWait=deps.wait(()=>{clearWait=null;void claim(flow,expiresAt);},entraClaimIntervalMs);
 };
 void (async()=>{
  let begun:BeginReply;
  try{begun=await deps.post({action:'entra-begin'},controller.signal) as BeginReply;}
  catch(error){if(!stopped&&!controller.signal.aborted)fail({kind:'server',error});return;}
  if(stopped)return;
  try{popup.location.replace(begun.url);}catch{fail({kind:'closed'});return;}
  clearWait=deps.wait(()=>{clearWait=null;void claim(begun.flow,begun.expiresAt);},entraClaimIntervalMs);
 })();
 return {cancel:()=>{if(stopped)return;finish();controller.abort();}};
}

/**
 * The shared hook of the dialog and the gate. start() must run inside the click
 * handler, with no await before it, so the window opens as part of the click.
 * Unmounting cancels a running confirmation.
 */
export function useEntraConfirm(onVerified:(result:EntraConfirmResult)=>void){
 const t=useT(),[waiting,setWaiting]=useState(false),[error,setError]=useState(''),running=useRef<{cancel:()=>void}|null>(null),verified=useRef(onVerified);
 useEffect(()=>{verified.current=onVerified;},[onVerified]);
 const cancel=useCallback(()=>{running.current?.cancel();running.current=null;setWaiting(false);},[]);
 useEffect(()=>()=>{running.current?.cancel();running.current=null;},[]);
 const start=()=>{
  if(running.current)return;
  setError('');setWaiting(true);
  let ended=false;
  const run=runEntraConfirm({
   openWindow:()=>window.open('about:blank',entraConfirmWindow.name,entraConfirmWindow.features),
   post:(body,signal)=>api('/api/mfa',body,signal),
   now:()=>Date.now(),
   wait:(callback,ms)=>{const timer=window.setTimeout(callback,ms);return()=>window.clearTimeout(timer);},
   onSuccess:result=>{ended=true;running.current=null;setWaiting(false);verified.current(result);},
   onFailure:failure=>{ended=true;running.current=null;setWaiting(false);setError(failure.kind==='blocked'?t('mfa.entraPopupBlocked'):failure.kind==='closed'?t('mfa.entraClosed'):message(failure.error));},
  });
  // A blocked window ends inside runEntraConfirm, before it returns.
  if(!ended)running.current=run;
 };
 return {start,cancel,waiting,error,setError};
}
