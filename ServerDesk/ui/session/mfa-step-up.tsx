'use client';
// The step-up dialog for critical actions (lib/step-up.ts, nodiverna-ui §5 "Step-up MFA") on kit
// parts: the kit Dialog (the glass surface of ConfirmDialog, Esc and the scrim close it), the
// passkey choice as kit buttons, the code as a Field-bound input, errors as a danger Notice and the
// footer with Cancel leading and the confirm Btn trailing. Dialog opens from state, so it remembers the
// element that had focus and gives focus back there on close. An account from
// Microsoft Entra ID confirms with a fresh Microsoft sign-in instead (EntraStepUp).
import {useEffect,useId,useRef,useState} from 'react';
import {AlertTriangle,Fingerprint,LogIn,Monitor,QrCode} from 'lucide-react';
import {api,message} from '@/ui/base/api';
import {authenticatePasskey,passkeyError,type PasskeyDevice,type PasskeyStatus} from '@/ui/session/passkey-client';
import {DirectTabLink,usePasskeySupport} from '@/ui/session/passkey-support';
import {identitySource} from '@/ui/session/identity-source';
import {useEntraConfirm,type EntraConfirmResult} from '@/ui/session/entra-confirm';
import {Btn,Notice} from '@/ui/kit/kit';
import {Field} from '@/ui/kit/field';
import {useLocale,useT} from '@/ui/base/locale';
import {Dialog} from '@/ui/kit/confirm-dialog';

type ManagementProof={managementToken?:string;managementExpiresAt?:number};

/** The error slot of the dialog: a danger Notice (role=alert), nothing without a text. */
function StepUpError({text}:{text:string}){
  return text?<Notice tone="danger" icon={AlertTriangle}>{text}</Notice>:null;
}

/**
 * The body of the step-up dialog of an account from Microsoft Entra ID: the
 * error slot, the polite waiting line and the actions. The single primary action
 * keeps its name; while the Microsoft window is open it shows its spinner.
 */
export function EntraConfirmContent({waiting,error,onConfirm,onCancel}:{waiting:boolean;error:string;onConfirm:()=>void;onCancel:()=>void}){
  const t=useT();
  return <>
    <StepUpError text={error}/>
    <p className="sdx-stepup-status" role="status" aria-live="polite">{waiting?t('mfa.entraWaiting'):''}</p>
    <footer className="sdx-confirm-foot"><Btn onClick={onCancel}>{t('common.cancel')}</Btn><Btn variant="primary" icon={LogIn} loading={waiting} onClick={onConfirm}>{t('mfa.entraConfirm')}</Btn></footer>
  </>;
}

/**
 * The step-up of an account from Microsoft Entra ID (lib/server/identity/entra/confirm.ts): a
 * fresh Microsoft sign-in in a window. Nothing is sent before the click. Cancel
 * and closing the dialog stop the polling and close the window; the pending
 * action keeps its input because only onClose runs.
 */
function EntraStepUp({open,onClose,onVerified,notice}:{open:boolean;onClose:()=>void;onVerified:(proof:ManagementProof)=>void;notice?:string}){
  const t=useT();
  const confirm=useEntraConfirm((result:EntraConfirmResult)=>{onVerified(result);onClose();});
  const {cancel,setError}=confirm;
  useEffect(()=>{if(open)setError('');else cancel();},[open,cancel,setError]);
  const close=()=>{cancel();onClose();};
  return <Dialog open={open} onOpenChange={next=>{if(!next)close();}} className="sdx-stepup" title={t('mfa.title')} description={t('mfa.entraConfirmText')}>
    <EntraConfirmContent waiting={confirm.waiting} error={confirm.error||notice||''} onConfirm={confirm.start} onCancel={close}/>
  </Dialog>;
}

/**
 * The passkey choice of the step-up: this device or a phone. While one ceremony runs, its button
 * shows the spinner and the other waits; a browser that cannot run passkeys here blocks both with
 * its reason. The divider names the code that follows below.
 */
function StepUpPasskeys({busy,pending,divider,onSelect}:{busy:boolean;pending:PasskeyDevice|null;divider:string;onSelect:(device:PasskeyDevice)=>void}){
  const t=useT(),unsupported=usePasskeySupport(),headingId=useId(),waiting=busy&&!!pending,reason=unsupported?t(unsupported):undefined;
  const option=(device:PasskeyDevice,icon:typeof Monitor,label:string)=><Btn icon={icon} loading={waiting&&pending===device} disabled={busy&&pending!==device} blocked={reason} onClick={()=>onSelect(device)}>{label}</Btn>;
  return <section className="sdx-stepup-passkeys" aria-labelledby={headingId}>
    <h3 id={headingId} className="sdx-stepup-passkeys-title"><Fingerprint size={16} aria-hidden/>{t('passkeys.signIn.title')}</h3>
    <div className="sdx-stepup-passkeys-options">{option('local',Monitor,t('passkeys.signIn.local'))}{option('phone',QrCode,t('passkeys.signIn.phone'))}</div>
    <p className="sdx-stepup-hint" role={waiting?'status':undefined}>{waiting?t('passkeys.signIn.waiting'):reason??t('passkeys.signIn.phoneHint')}</p>
    <DirectTabLink unsupported={unsupported} className="sdx-stepup-link"/>
    <p className="sdx-stepup-divider"><span>{divider}</span></p>
  </section>;
}

/**
 * Step-up dialog for critical actions (lib/step-up.ts). `notice` is the server's
 * reason when a request that already carried a proof was refused; it shows in the
 * error slot until the dialog has an error of its own.
 */
export function MfaStepUp({open,onClose,onVerified,notice}:{open:boolean;onClose:()=>void;onVerified:(proof:ManagementProof)=>void;notice?:string}){
  const t=useT(),[locale]=useLocale(),entra=identitySource()==='entra';
  const[code,setCode]=useState(''),[recovery,setRecovery]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[pending,setPending]=useState<PasskeyDevice|null>(null);
  const[passkeys,setPasskeys]=useState<PasskeyStatus|null>(null),generation=useRef(0),attempt=useRef<AbortController|null>(null),isOpen=useRef(open),busyRef=useRef(false);
  useEffect(()=>{
    isOpen.current=open;
    busyRef.current=false;
    const currentGeneration=++generation.current;
    // An account from Microsoft Entra ID confirms with Microsoft (EntraStepUp): no passkey list is read.
    if(open&&!entra){setCode('');setError('');setRecovery(false);setBusy(false);setPending(null);setPasskeys(null);void api<PasskeyStatus>('/api/passkeys').then(next=>{if(isOpen.current&&generation.current===currentGeneration)setPasskeys(next);}).catch(()=>{});}
    // eslint-disable-next-line react-hooks/exhaustive-deps -- generation is a generation counter, not DOM refs; the cleanup increments it so that late responses are dropped.
    return()=>{isOpen.current=false;generation.current++;attempt.current?.abort();busyRef.current=false;};
  },[open,entra]);
  const close=()=>{isOpen.current=false;generation.current++;attempt.current?.abort();busyRef.current=false;setBusy(false);setPending(null);onClose();};
  // A passkey-only account has no authenticator code: its fallback is a recovery code.
  const passkeyOnly=passkeys?.authenticatorCount===0,useRecovery=recovery||passkeyOnly;
  const codeReady=useRecovery?!!code.trim():/^\d{6}$/.test(code);
  const verify=async()=>{
    if(busyRef.current||!isOpen.current||!(useRecovery?code.trim():/^\d{6}$/.test(code)))return;
    busyRef.current=true;
    const currentGeneration=++generation.current,controller=new AbortController();attempt.current=controller;
    setBusy(true);setError('');
    try{const proof=await api<ManagementProof>('/api/mfa',{action:'verify',...(useRecovery?{recoveryCode:code}:{code})},controller.signal);if(isOpen.current&&generation.current===currentGeneration){onVerified(proof);close();}}
    catch(e){if(isOpen.current&&generation.current===currentGeneration)setError(message(e));}finally{if(isOpen.current&&generation.current===currentGeneration){busyRef.current=false;setBusy(false);attempt.current=null;}}
  };
  const verifyPasskey=async(device:PasskeyDevice)=>{
    if(busyRef.current||!isOpen.current)return;
    busyRef.current=true;
    const currentGeneration=++generation.current,controller=new AbortController();attempt.current=controller;
    setBusy(true);setPending(device);setError('');
    try{const proof=await authenticatePasskey(device,controller.signal);if(isOpen.current&&generation.current===currentGeneration){onVerified(proof as typeof proof&ManagementProof);close();}}
    catch(e){if(isOpen.current&&generation.current===currentGeneration)setError(passkeyError(e,locale));}finally{if(isOpen.current&&generation.current===currentGeneration){busyRef.current=false;setBusy(false);setPending(null);attempt.current=null;}}
  };
  if(entra)return <EntraStepUp open={open} onClose={close} onVerified={onVerified} notice={notice}/>;
  return <Dialog open={open} onOpenChange={next=>{if(!next)close();}} className="sdx-stepup" title={t('mfa.title')} description={passkeyOnly?t('mfa.passkeyOrRecovery'):passkeys?.count?t('session.confirmPasskeyOrAuthenticator'):t('session.confirmAuthenticator')}>
    {!!passkeys?.available&&passkeys.count>0&&<StepUpPasskeys busy={busy} pending={pending} divider={passkeyOnly?t('session.orRecoveryCode'):t('passkeys.signIn.orCode')} onSelect={device=>void verifyPasskey(device)}/>}
    <Field label={useRecovery?t('session.recoveryCode'):t('session.authenticatorCode')}>
      <input id="v3-stepup" disabled={busy} autoComplete="one-time-code" inputMode={useRecovery?'text':'numeric'} value={code} maxLength={useRecovery?40:6} onChange={e=>setCode(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!busy&&code)void verify();}}/>
    </Field>
    <StepUpError text={error||notice||''}/>
    {!passkeyOnly&&<Btn variant="ghost" size="sm" className="sdx-stepup-toggle" disabled={busy} onClick={()=>{setRecovery(!recovery);setCode('');}}>{recovery?t('session.useAuthenticator'):t('session.useRecoveryCode')}</Btn>}
    <footer className="sdx-confirm-foot"><Btn onClick={close}>{t('common.cancel')}</Btn><Btn variant="primary" loading={busy&&!pending} disabled={busy&&!!pending} blocked={codeReady?undefined:t(useRecovery?'mfa.blocked.recovery':'mfa.blocked.code')} onClick={verify}>{t('common.confirm')}</Btn></footer>
  </Dialog>;
}
