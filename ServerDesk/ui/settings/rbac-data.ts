'use client';
// The load and change flow of the access management views (Accounts, User groups, Roles and the Permissions view of a
// scope or a device). One hook, so the four views keep the same guards:
// - load: GET /api/rbac (or the scoped URL) with a 15 s timeout; a newer load drops an older reply; a reload keeps the
//   loaded data visible; 401/403 drops the data (denied).
// - change: every change asks for the step-up proof first (useStepUp, nodiverna-ui §5) and is sent once with it, with a
//   20 s timeout. Success reloads the data, runs onRefresh and shows the success toast; a failure shows toast.error; a
//   401/403 on a change reloads the data. Cancelling the step-up sends nothing.
// - guards: a viewer, section or scope change, the session lock and the unmount start a new generation. They abort
//   the running requests, drop late load and change replies, cancel a waiting step-up, and change `generation`, which
//   the views compare with the generation they opened a drawer or dialog in, so those close.
// useGenerationState holds such a drawer or dialog state, and useRbacConfirm the one confirmation flow of the views, so
// the four views keep the same generation guard and the same step-up wiring of their ConfirmDialog.
import {useCallback,useEffect,useRef,useState} from 'react';
import {toast} from 'sonner';
import type {Viewer} from '@/lib/types';
import {api,ApiError,message} from '@/ui/base/api';
import {SESSION_LOCK_EVENT} from '@/ui/base/http';
import {isOwner} from '@/ui/base/access-capabilities';
import {useStepUp,type StepUpDialogProps} from '@/ui/session/step-up-retry';
import {useLocale,useStableT} from '@/ui/base/locale';
import type {ConfirmLine} from '@/ui/kit/confirm-dialog';
import type {RbacData,RbacReply} from '@/ui/settings/rbac-model';

/** One change: the endpoint (/api/rbac or /api/auth), the body of today and the success toast (none: the view shows its own). */
export type RbacChange={endpoint:'/api/rbac'|'/api/auth';body:Record<string,unknown>;success?:string};
type Payload=RbacChange&{epoch:number;managementToken?:string};
const deniedStatus=(failure:unknown)=>failure instanceof ApiError&&(failure.status===401||failure.status===403);

export type RbacView={
 /** The data of the current viewer and scope, null before the first load, after a 401/403 and after the session lock. */
 data:RbacData|null;loading:boolean;
 /** The last load failure, '' after a successful load. */
 error:string;
 /** The last load answered 401 or 403. */
 denied:boolean;
 load:()=>Promise<void>;
 /** Runs one change through the step-up; resolves with the reply, or null when cancelled, failed or outdated. */
 change:(request:RbacChange)=>Promise<RbacReply|null>;
 /** A change runs or its step-up waits. */
 busy:boolean;
 /** The change request is out (Btn loading). */
 sending:boolean;
 /** The props of <MfaStepUp/>. */
 dialog:StepUpDialogProps;
 /** Changes with the viewer, the scope and every session lock; drawers and dialogs opened in another generation are closed. */
 generation:string;
};

export function useRbacData({viewer,demo,scopeKey,endpoint,enabled=true,onRefresh}:{viewer:Viewer;demo:boolean;
 /** The section or scope the view shows: a change starts a new generation. */
 scopeKey:string;endpoint:string;
 /** false: no request at all (the Permissions view with sample devices). */
 enabled?:boolean;onRefresh:()=>Promise<void>|void}):RbacView{
 const stableT=useStableT(),[locale]=useLocale();
 const key=JSON.stringify([viewer.id,isOwner(viewer),viewer.label,[...(viewer.permissions??[])].sort(),demo,scopeKey,endpoint,enabled]);
 const mounted=useRef(false),epoch=useRef(0),loadSequence=useRef(0),loadAbort=useRef<AbortController|null>(null),mutationAbort=useRef<AbortController|null>(null);
 const [loaded,setLoaded]=useState<{key:string;data:RbacData}|null>(null),[failure,setFailure]=useState<{key:string;text:string;denied:boolean}|null>(null),[loading,setLoading]=useState(false),[locks,setLocks]=useState(0);
 const current=(started:number)=>mounted.current&&epoch.current===started;
 const step=useStepUp<Payload,RbacReply>({locale,needsStepUp:()=>true,
  send:async({endpoint:target,body,epoch:started,managementToken})=>{
   if(!current(started))throw new Error('outdated');
   const controller=new AbortController();mutationAbort.current?.abort();mutationAbort.current=controller;
   const timeout=setTimeout(()=>controller.abort(new Error(stableT('rbac.noReply'))),20000);
   try{return await api<RbacReply>(target,{...body,managementToken},controller.signal);}
   catch(problem){throw controller.signal.aborted&&current(started)?controller.signal.reason:problem;}
   finally{clearTimeout(timeout);if(mutationAbort.current===controller)mutationAbort.current=null;}
  },
  // An outdated change ends silently; a 401/403 reloads the data and is reported.
  onError:(problem,payload)=>{if(!current(payload.epoch))return true;if(deniedStatus(problem))void loadRef.current();return false;}});
 const cancel=step.dialog.onClose;
 const load=useCallback(async()=>{
  if(!enabled||!mounted.current)return;
  const started=epoch.current,sequence=++loadSequence.current,controller=new AbortController();loadAbort.current?.abort();loadAbort.current=controller;setLoading(true);
  const fresh=()=>mounted.current&&epoch.current===started&&loadSequence.current===sequence;
  const timeout=setTimeout(()=>controller.abort(new Error(stableT('rbac.loadTimeout'))),15000);
  try{const next=await api<RbacData>(endpoint,undefined,controller.signal);if(!fresh())return;setLoaded({key,data:next});setFailure(null);}
  catch(problem){if(!fresh())return;const refused=deniedStatus(problem);if(refused)setLoaded(null);setFailure({key,text:message(problem),denied:refused});}
  finally{clearTimeout(timeout);if(loadAbort.current===controller)loadAbort.current=null;if(fresh())setLoading(false);}
 },[enabled,endpoint,key,stableT]);
 const loadRef=useRef(load);
 useEffect(()=>{loadRef.current=load;});
 useEffect(()=>{
  mounted.current=true;epoch.current++;
  const stop=()=>{epoch.current++;loadSequence.current++;loadAbort.current?.abort();mutationAbort.current?.abort();cancel();};
  // The session lock: everything stops and the loaded data (and a one-time link with it) goes.
  const lock=()=>{stop();setLoaded(null);setLoading(false);setLocks(count=>count+1);};
  window.addEventListener(SESSION_LOCK_EVENT,lock);
  queueMicrotask(()=>void load());
  return ()=>{mounted.current=false;stop();window.removeEventListener(SESSION_LOCK_EVENT,lock);};
 },[load,cancel]);
 const change=async(request:RbacChange)=>{
  if(!enabled||!mounted.current)return null;
  const started=epoch.current,result=await step.run({...request,epoch:started});
  if(!result||!current(started))return null;
  await load();if(!current(started))return null;
  await onRefresh();if(!current(started))return null;
  if(request.success)toast.success(request.success);
  return result;
 };
 // A proof without a management token sends nothing; the drawer keeps its input.
 const dialog:StepUpDialogProps={...step.dialog,onVerified:proof=>{if(!proof?.managementToken){toast.error(stableT('rbac.noManagementToken'));cancel();return;}step.dialog.onVerified(proof);}};
 // Until the first reply of this viewer and scope arrives, the view shows its first load.
 const data=loaded?.key===key?loaded.data:null,failed=failure?.key===key?failure:null;
 return {data,loading:enabled&&(loading||!data&&!failed),error:failed?.text??'',denied:failed?.denied===true,load,change,busy:step.busy,sending:step.sending,dialog,generation:`${key}#${locks}`};
}

type GenerationUpdate<T>=T|null|((current:T|null)=>T|null);
/**
 * A drawer or dialog state of one generation (RbacView.generation): the value reads as null once the generation differs
 * from the one it was set in, so a viewer change, a scope change and the session lock close it; the value is then dropped,
 * so a return to the first viewer or scope (the same generation key) does not bring it back. The setter stamps the
 * generation of its render itself; a null from a setter of an older generation leaves a newer value alone.
 */
export function useGenerationState<T>(generation:string):[T|null,(next:GenerationUpdate<T>)=>void]{
 const [state,setState]=useState<{generation:string;value:T}|null>(null);
 // A value of another generation is dropped, not only hidden: back on the first viewer or scope it stays closed.
 if(state&&state.generation!==generation)setState(null);
 const set=useCallback((next:GenerationUpdate<T>)=>setState(old=>{
  const mine=old?.generation===generation,current=mine?old.value:null;
  const value=typeof next==='function'?(next as (current:T|null)=>T|null)(current):next;
  return value===null?(mine?null:old):{generation,value};
 }),[generation]);
 return [state?.generation===generation?state.value:null,set];
}

/** One confirmation of an access change: the ConfirmDialog texts and the change it sends. */
export type RbacConfirmRequest={title:string;body:string;lines:ConfirmLine[];confirmLabel:string;tone:'danger'|'default';change:RbacChange};
/** The props of <ConfirmDialog/> for useRbacConfirm. */
export type RbacConfirmDialogProps={open:boolean;onOpenChange:(open:boolean)=>void;title:string;body:string|undefined;lines:ConfirmLine[]|undefined;
 confirmLabel:string;tone:'danger'|'default'|undefined;busy:boolean;onConfirm:()=>void};
/**
 * The confirmation flow of the access views: ask(request) opens the ConfirmDialog in this generation; dialog holds its
 * props. The dialog hides while the step-up dialog is open, a close is ignored while the change is sent, and confirming
 * runs rbac.change(request.change) once (a second press while it runs does nothing) and closes the dialog after the
 * change resolved, with success or not. accept refuses a confirm whose request no longer applies (nothing is sent, the
 * dialog stays); onDone gets the change reply (null: cancelled, failed or outdated) and the request.
 */
export function useRbacConfirm<Extra extends object=Record<never,never>>(rbac:RbacView,{accept,onDone}:{accept?:(request:RbacConfirmRequest&Extra)=>boolean;onDone?:(reply:RbacReply|null,request:RbacConfirmRequest&Extra)=>void}={}){
 const [request,setRequest]=useGenerationState<RbacConfirmRequest&Extra>(rbac.generation),running=useRef(false);
 const confirm=async()=>{
  if(!request||running.current||rbac.busy||accept&&!accept(request))return;
  running.current=true;
  try{const reply=await rbac.change(request.change);setRequest(null);onDone?.(reply,request);}
  finally{running.current=false;}
 };
 const dialog:RbacConfirmDialogProps={open:!!request&&!rbac.dialog.open,onOpenChange:next=>{if(!next&&!rbac.sending)setRequest(null);},title:request?.title??'',body:request?.body,lines:request?.lines,
  confirmLabel:request?.confirmLabel??'',tone:request?.tone,busy:rbac.sending,onConfirm:()=>void confirm()};
 return {request,ask:(next:RbacConfirmRequest&Extra)=>setRequest(next),dialog};
}
