// The retry after a step-up dialog (lib/step-up.ts): the dialog's onVerified
// callback resends a request once with the new managementToken. A proof without
// a token sends nothing and only reports the problem. Removal, enroll, the
// terminal and the release source share it. useStepUp is the whole step-up flow
// of a request for a panel (nodiverna-ui §5 "Step-up MFA"): a pure controller
// that a test drives without a DOM, wrapped in a hook. The caller renders
// <MfaStepUp {...dialog}/>, so this module does not load the dialog.
import {useEffect,useState} from 'react';
// Static on purpose (unlike kit.tsx and field.tsx): every caller of useStepUp already loads sonner, and
// the step-up tests read the report in the same tick as the resolved request.
import {toast} from 'sonner';
import {defaultLocale,type Locale} from '@/lib/i18n/locale';
import {translate} from '@/lib/i18n/translate';
import {opensMfaPrompt} from '@/lib/errors/codes';
import {message} from '@/ui/base/api';

/** The report for a proof without a token, in German (the default language). */
export const missingProofMessage=translate(defaultLocale,'mfa.missingProof');
export type StepUpProof={managementToken?:string};

/** onVerified callback that calls `send` once with the proof's managementToken, or reports the missing proof. */
export function proofRetry(send:(managementToken:string)=>Promise<void>|void,report:(message:string)=>void,locale:Locale=defaultLocale){
 return (proof?:StepUpProof)=>{const token=proof?.managementToken;if(typeof token!=='string'||!token){report(translate(locale,'mfa.missingProof'));return;}return send(token);};
}
/** onVerified callback that resends `payload` once with the new managementToken in place of any old one. */
export function stepUpRetry<T extends object>(payload:T,send:(payload:T&{managementToken:string})=>Promise<void>|void,report:(message:string)=>void,locale:Locale=defaultLocale){
 const base=Object.fromEntries(Object.entries(payload).filter(([key])=>key!=='managementToken')) as T;
 return proofRetry(managementToken=>send({...base,managementToken}),report,locale);
}

/** What the step-up flow shows: the dialog, the server's reason in it, and whether a request is out. */
export type StepUpState={open:boolean;notice:string;sending:boolean};
export const idleStepUp:StepUpState={open:false,notice:'',sending:false};
export type StepUpControllerOptions<P extends object,R>={
 /** Sends the payload (with managementToken after a proof); rejects with the API error. */
 send:(payload:P)=>Promise<R>;
 /** Critical payloads open the dialog before any request. */
 needsStepUp:(payload:P)=>boolean;
 /** Handles a failure itself (a field error, for example) and returns true; else the failure is reported. */
 onError?:(failure:unknown,payload:P)=>boolean;
 /** Reports a failure, toast.error in the hook. */
 report:(text:string)=>void;
 /** The text of a failure, message() in the hook. */
 describe:(failure:unknown)=>string;
 /** The viewer's locale, for the missing-proof report. */
 locale:()=>Locale;
 /** Gets every new state; not called after dispose(). */
 onState:(state:StepUpState)=>void;
};
export type StepUpController<P extends object,R>={
 /** Runs one request. Resolves with the result, or null when cancelled, refused, failed or already busy. */
 run:(payload:P)=>Promise<R|null>;
 /** The dialog's onVerified: resends the waiting payload once with the proof's token. */
 verified:(proof?:StepUpProof)=>void;
 /** The dialog's onClose: sends nothing and resolves the waiting request with null. */
 cancel:()=>void;
 state:()=>StepUpState;
 /** Takes the caller's latest callbacks (send, needsStepUp, onError, describe, locale). */
 update:(next:Partial<StepUpControllerOptions<P,R>>)=>void;
 /** Mount: states reach onState. dispose() is the unmount: later results set no state and resolve null. */
 attach:()=>void;dispose:()=>void;
};
type StepUpRequest<P,R>={payload:P;resolve:(result:R|null)=>void};
const carriesToken=(payload:object)=>{const token=(payload as {managementToken?:unknown}).managementToken;return typeof token==='string'&&token!=='';};
const failureCode=(failure:unknown)=>typeof failure==='object'&&failure!==null?(failure as {code?:unknown}).code:undefined;

/**
 * The step-up flow without React. A critical payload opens the dialog first; any other goes out at once.
 * A reply whose code opens the MFA prompt opens the dialog, and the proof resends the same payload once
 * (stepUpRetry replaces an old token). A refused request that carried a token reopens the dialog with the
 * server's reason as notice. Cancel sends nothing. One request at a time: a run while one is out or the
 * dialog waits resolves null at once.
 */
export function stepUpController<P extends object,R>(initial:StepUpControllerOptions<P,R>):StepUpController<P,R>{
 let options=initial,state=idleStepUp,waiting:StepUpRequest<P,R>|null=null,sending:StepUpRequest<P,R>|null=null,alive=true;
 const set=(next:Partial<StepUpState>)=>{state={...state,...next};if(alive)options.onState(state);};
 const send=async(request:StepUpRequest<P,R>)=>{
  sending=request;set({sending:true});
  try{
   const result=await options.send(request.payload);
   sending=null;set({sending:false});
   request.resolve(alive?result:null);
  }catch(failure){
   sending=null;
   if(!alive){request.resolve(null);return;}
   if(opensMfaPrompt(failureCode(failure))){waiting=request;set({sending:false,open:true,notice:carriesToken(request.payload)?options.describe(failure):''});return;}
   set({sending:false});
   if(!options.onError?.(failure,request.payload))options.report(options.describe(failure));
   request.resolve(null);
  }
 };
 return {
  run:payload=>{
   if(waiting||sending)return Promise.resolve(null);
   return new Promise<R|null>(resolve=>{
    const request={payload,resolve};
    if(options.needsStepUp(payload)){waiting=request;set({open:true,notice:''});}
    else void send(request);
   });
  },
  verified:proof=>{
   const request=waiting;waiting=null;set({open:false,notice:''});
   if(!request)return;
   void stepUpRetry(request.payload,payload=>send({payload,resolve:request.resolve}),text=>{options.report(text);request.resolve(null);},options.locale())(proof);
  },
  cancel:()=>{const request=waiting;waiting=null;set({open:false,notice:''});request?.resolve(null);},
  state:()=>state,
  update:next=>{options={...options,...next};},
  attach:()=>{alive=true;},
  dispose:()=>{alive=false;},
 };
}

/** The props of <MfaStepUp/> that useStepUp hands to its caller. */
export type StepUpDialogProps={open:boolean;notice:string;onClose:()=>void;onVerified:(proof:StepUpProof)=>void};
/**
 * The step-up flow of a panel: run(payload) resolves with the result or null; busy is true while a request
 * is out or the dialog is open (sending only while a request is out); dialog holds the props of
 * <MfaStepUp/>. Failures show toast.error(message(failure)) unless onError handles them.
 */
export function useStepUp<P extends object,R>({send,needsStepUp,onError,locale=defaultLocale}:{send:(payload:P)=>Promise<R>;needsStepUp:(payload:P)=>boolean;onError?:(failure:unknown,payload:P)=>boolean;locale?:Locale}){
 const [state,setState]=useState<StepUpState>(idleStepUp);
 const callbacks=(current:Locale)=>({send,needsStepUp,onError,describe:(failure:unknown)=>message(failure,current),locale:()=>current});
 // The controller lives as long as the component; after each render it takes the caller's latest callbacks.
 const [controller]=useState(()=>stepUpController<P,R>({...callbacks(locale),report:text=>{toast.error(text);},onState:setState}));
 useEffect(()=>{controller.update(callbacks(locale));});
 useEffect(()=>{controller.attach();return ()=>controller.dispose();},[controller]);
 const dialog:StepUpDialogProps={open:state.open,notice:state.notice,onClose:controller.cancel,onVerified:controller.verified};
 return {run:controller.run,busy:state.open||state.sending,sending:state.sending,dialog};
}
