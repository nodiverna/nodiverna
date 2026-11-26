'use client';
import {useEffect,useRef,useState,type FormEvent} from 'react';
import {AlertTriangle,KeyRound,Lock} from 'lucide-react';
import type {Viewer} from '@/lib/types';
import {api,message} from '@/ui/base/api';
import {SESSION_LOCK_EVENT} from '@/ui/base/http';
import {passwordProblem} from '@/ui/session/identity-password';
import {useLocale,useT} from '@/ui/base/locale';
import {Btn,Drawer,DrawerCancel,Notice} from '@/ui/kit/kit';
import {Field} from '@/ui/kit/field';
import {MethodSection} from '@/ui/account/account-method';

type Proof={managementToken?:string};
type Props={viewer:Viewer;
 /** Why the password cannot change now (sign-in methods unavailable, identity not confirmed); the button stays visible and says it. */
 blocked?:string;
 onConfirmIdentity:(verified:(proof:Proof)=>void,cancelled:()=>void)=>void};

/**
 * The method "Password" of My account and its drawer "Change password". Submit validates the fields
 * (errors under the fields after the first submit), closes the drawer for the step-up and sends the
 * change with the fresh proof; a cancelled step-up reopens the drawer with the input kept, a success
 * replaces the location with / (the user signs in again).
 */
export default function PasswordSettings({viewer,blocked,onConfirmIdentity}:Props){
 const t=useT(),[locale]=useLocale();
 const[open,setOpen]=useState(false),[currentPassword,setCurrentPassword]=useState(''),[newPassword,setNewPassword]=useState(''),[confirmation,setConfirmation]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[submitted,setSubmitted]=useState(false);
 const mounted=useRef(false),epoch=useRef(0),controller=useRef<AbortController|null>(null),busyRef=useRef(false),pending=useRef<{currentPassword:string;newPassword:string}|null>(null);
 const clear=()=>{epoch.current++;controller.current?.abort();pending.current=null;busyRef.current=false;setOpen(false);setBusy(false);setCurrentPassword('');setNewPassword('');setConfirmation('');setError('');setSubmitted(false);};
 // eslint-disable-next-line react-hooks/exhaustive-deps -- epoch is a generation counter, not DOM refs; the cleanup increments it so that late responses are dropped.
 useEffect(()=>{mounted.current=true;window.addEventListener(SESSION_LOCK_EVENT,clear);return()=>{mounted.current=false;epoch.current++;controller.current?.abort();pending.current=null;window.removeEventListener(SESSION_LOCK_EVENT,clear);};},[]);
 const edit=()=>{if(blocked||busyRef.current)return;setCurrentPassword('');setNewPassword('');setConfirmation('');setError('');setSubmitted(false);setOpen(true);};
 const change=async(proof:Proof,operation:number)=>{
  const chosen=pending.current;pending.current=null;if(!mounted.current||epoch.current!==operation||!chosen)return;
  if(!proof.managementToken){busyRef.current=false;setBusy(false);setOpen(true);setError(t('mfa.missingProofRetry'));return;}
  const abort=new AbortController();controller.current=abort;
  const timer=setTimeout(()=>abort.abort(new Error(t('password.changeTooLong'))),30000);
  try{await api('/api/auth',{action:'password-change',...chosen,managementToken:proof.managementToken},abort.signal);if(!mounted.current||epoch.current!==operation||abort.signal.aborted)return;setCurrentPassword('');setNewPassword('');setConfirmation('');window.location.replace('/');}
  catch(e){if(mounted.current&&epoch.current===operation){setError(abort.signal.aborted?t('password.changeIncomplete'):message(e));setOpen(true);}}
  finally{clearTimeout(timer);if(controller.current===abort)controller.current=null;if(mounted.current&&epoch.current===operation){busyRef.current=false;setBusy(false);}}
 };
 // Field errors: the current password is required; the new one follows the policy (length), and the repetition must match.
 const lengthProblem=passwordProblem(newPassword,newPassword,locale),currentError=currentPassword?'':t('password.enterCurrent');
 const repeatError=!lengthProblem&&newPassword!==confirmation?t('password.mismatch'):'';
 const submit=(event:FormEvent)=>{
  event.preventDefault();if(blocked||busyRef.current)return;
  if(currentError||passwordProblem(newPassword,confirmation,locale)){setSubmitted(true);return;}
  const operation=++epoch.current;pending.current={currentPassword,newPassword};busyRef.current=true;setBusy(true);setError('');setOpen(false);
  onConfirmIdentity(proof=>void change(proof,operation),()=>{if(!mounted.current||epoch.current!==operation)return;pending.current=null;busyRef.current=false;setBusy(false);setOpen(true);});
 };
 const dirty=!!(currentPassword||newPassword||confirmation);
 return <>
  <MethodSection id="account-password-title" icon={Lock} title={t('password.title')} description={t('password.meta',{name:viewer.username??viewer.label})}
   actions={<Btn size="sm" icon={KeyRound} blocked={blocked} loading={busy} onClick={edit}>{t('password.change')}</Btn>}/>
  <Drawer open={open} onClose={clear} title={t('password.change')} description={t('password.dialogIntro')} icon={Lock} dirty={dirty}
   footer={<><DrawerCancel/><Btn variant="primary" type="submit" form="account-password-form" loading={busy}>{t('password.change')}</Btn></>}>
   <form id="account-password-form" className="sdx-form-grid" noValidate onSubmit={submit}>
    <Field label={t('password.current')} error={submitted&&currentError}><input id="account-current-password" type="password" autoComplete="current-password" autoFocus value={currentPassword} maxLength={256} onChange={event=>setCurrentPassword(event.target.value)}/></Field>
    <Field label={t('identity.newPassword')} hint={t('password.rule')} error={submitted&&lengthProblem}><input id="account-new-password" type="password" autoComplete="new-password" value={newPassword} maxLength={256} onChange={event=>setNewPassword(event.target.value)}/></Field>
    <Field label={t('password.newRepeat')} error={submitted&&repeatError}><input id="account-new-password-confirm" type="password" autoComplete="new-password" value={confirmation} maxLength={256} onChange={event=>setConfirmation(event.target.value)}/></Field>
    {error&&<Notice tone="danger" icon={AlertTriangle}>{error}</Notice>}
   </form>
  </Drawer>
 </>;
}
