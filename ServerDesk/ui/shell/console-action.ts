// The console's generic POST action (ui/shell/console.tsx): device removal,
// jobs and cancelling jobs, all sent to /api/console. It takes everything it
// touches as explicit dependencies, so tests/ui/devices/device-removal-view.mjs runs the
// removal flow with fakes, without network, DOM or a console render.
import {isDeviceRemovalAction} from '@/lib/step-up';
import {opensAdSignIn,opensMfaPrompt} from '@/lib/errors/codes';
import {defaultLocale,type Locale} from '@/lib/i18n/locale';
import {apiErrorText} from '@/ui/base/api-error-text';
import {translate} from '@/lib/i18n/translate';
import {removalNeedsStepUp,removalProofRejected,removalProofRetry,type StepUpProof} from '@/ui/devices/device/device-removal';
import {ApiError,readApiJson} from '@/ui/base/http';
import type {ConfirmationOutcome} from '@/ui/base/confirmation';
import {stepUpRetry} from '@/ui/session/step-up-retry';

export type ConsolePayload=Record<string,unknown>;
/** endpoint: the route (default /api/console); plugin: the plugin of a change (the AD sign-in); stepUpFirst: the step-up dialog opens before the first send; success: the toast text. */
export type ConsoleActionOptions={endpoint?:string;plugin?:string;stepUpFirst?:boolean;success?:string};
/** The payloads that are already the one resend after an AD sign-in; their answer never opens the dialog again. */
const adRetried=new WeakSet<object>();
/**
 * The resend after the AD sign-in (docs/plugin-ad-sign-in.md): the server
 * answered PLUGIN_AD_SIGN_IN_REQUIRED, the dialog signed in, and the same
 * request goes once more. A second refusal shows its error and stops.
 */
export function adSignInRetry(payload:ConsolePayload,send:(payload:ConsolePayload)=>Promise<void>|void){
 const next={...payload};adRetried.add(next);
 return ()=>send(next);
}
export type ConsoleActionDeps={
 /** Demo mode sends nothing. */
 demo:boolean;
 /** Whether the viewer may remove devices right now (read live, also after the reply). */
 canOffboard:()=>boolean;
 /** Sends the payload as POST to the endpoint, /api/console without one. */
 post:(payload:ConsolePayload,endpoint?:string)=>Promise<Response>;
 /** Opens the step-up dialog; its onVerified runs `retry` with the proof. */
 openStepUp:(retry:(proof:StepUpProof)=>Promise<void>|void)=>void;
 /** Opens the AD sign-in for the device of a PLUGIN_AD_SIGN_IN_REQUIRED answer; `retry` runs once after a successful sign-in, nothing after Cancel. */
 openAdSignIn?:(serverId:string,plugin:string,retry:()=>Promise<void>|void)=>void;
 toast:{success:(message:string)=>void;error:(message:string)=>void};
 /** Runs after a successful removal with the removed device IDs, before the toast. */
 onRemoved:(ids:string[])=>void;
 /** Runs after a successful removal with uninstall:true with the selected IDs: the console opens the offboarding drawer. */
 onUninstallRequested?:(ids:string[])=>void;
 refresh:()=>Promise<void>|void;
 setSaving:(saving:boolean)=>void;
 /** The console's action itself: the step-up retry resends through it. */
 action:(payload:ConsolePayload)=>Promise<void>;
 /** Language of the toasts; German when absent. */
 locale?:Locale;
 /** Runs once when the request ended, with the new job ID on success or the error code and text on a refusal. Not when the step-up dialog opens: its retry reports. */
 onSettled?:(outcome:ConfirmationOutcome)=>void;
};

export async function runConsoleAction(payload:ConsolePayload,deps:ConsoleActionDeps,options:ConsoleActionOptions={}):Promise<void>{
 if(deps.demo)return;
 const locale=deps.locale??defaultLocale,failed=translate(locale,'console.actionFailed');
 const removal=isDeviceRemovalAction(payload.action);
 if(removal&&!deps.canOffboard()){deps.toast.error(translate(locale,'console.noRemoveRight'));return;}
 // Removal needs a fresh step-up proof: the dialog opens before anything is sent.
 if(removalNeedsStepUp(payload)){deps.openStepUp(removalProofRetry(payload,deps.action,deps.toast.error,locale));return;}
 // An assistant PowerShell script (lib/step-up.ts, rule 5) needs a fresh proof as well: the dialog opens first, the retry sends once with its token.
 if(options.stepUpFirst&&typeof payload.managementToken!=='string'){deps.openStepUp(stepUpRetry(payload,deps.action,deps.toast.error,locale));return;}
 deps.setSaving(true);
 let fieldErrors:unknown;
 try{
  const response=await deps.post(payload,options.endpoint);
  const result=await readApiJson<{error?:string;code?:string;uninstall?:{queued?:string[]};jobs?:unknown[];id?:unknown;errors?:unknown}>(response);
  // A refusal with field errors (POST /api/dhcp changeInvalid) hands them to onSettled, so the form marks its fields.
  if(!response.ok){fieldErrors=result.errors;throw new ApiError(apiErrorText(locale,result,failed),response.status,result.code);}
  // With uninstall the devices stay registered until their agents confirm the start.
  if(removal&&payload.uninstall===true){
   const selected=payload.action==='remove-servers'?payload.ids as string[]:[payload.id as string],queued=result.uninstall?.queued?.length??0;
   deps.toast.success(queued?translate(locale,'console.uninstall.requested',{count:queued}):translate(locale,'console.uninstall.noneQueued'));
   deps.onUninstallRequested?.(selected);
  }
  else if(removal){const removed=payload.action==='remove-servers'?payload.ids as string[]:[payload.id as string];deps.onRemoved(removed);deps.toast.success(removed.length>1?translate(locale,'console.devicesRemoved',{count:removed.length}):translate(locale,'console.deviceRemoved'));}
  else if(options.success)deps.toast.success(options.success);
  // The Defender bulk action answers with one job per device (lib/server/devices/defender-jobs.ts).
  else if(payload.action==='defender-jobs')deps.toast.success(translate(locale,'defender.bulk.started',{count:result.jobs?.length??0}));
  else deps.toast.success(translate(locale,payload.action==='job'?'console.jobCreated':'console.saved'));
  deps.onSettled?.(typeof result.id==='string'?{ok:true,id:result.id}:{ok:true});
  await deps.refresh();
 }catch(failure){
  if(removal&&!deps.canOffboard())return;
  // A keyed API error shows the catalog text in the console's language (apiErrorText).
  const text=failure instanceof Error?typeof (failure as {messageKey?:unknown}).messageKey==='string'?apiErrorText(locale,{...failure,error:failure.message},failed):failure.message:failed;deps.toast.error(text);
  // The step-up dialog opens by error code, never by message text.
  if(removal){if(removalProofRejected(failure))deps.openStepUp(removalProofRetry(payload,deps.action,deps.toast.error,locale));}
  else if(failure instanceof ApiError&&opensMfaPrompt(failure.code)){deps.openStepUp(options.stepUpFirst?stepUpRetry(payload,deps.action,deps.toast.error,locale):()=>deps.action(payload));return;}
  // The AD sign-in comes after the step-up prompt, as the server checks the second factor first. It opens once per request and keeps the form.
  else if(failure instanceof ApiError&&opensAdSignIn(failure.code)&&deps.openAdSignIn&&!adRetried.has(payload)&&typeof failure.params?.serverId==='string'){deps.openAdSignIn(failure.params.serverId,options.plugin??'dhcp',adSignInRetry(payload,deps.action));return;}
  deps.onSettled?.({ok:false,code:failure instanceof ApiError?failure.code:undefined,message:text,...(fieldErrors!==undefined?{errors:fieldErrors}:{})});
 }finally{deps.setSaving(false);}
}
