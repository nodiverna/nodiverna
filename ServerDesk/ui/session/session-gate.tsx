'use client';
import {useCallback,useEffect,useRef,useState,type ReactNode} from 'react';
import {AlertTriangle,ArrowRight,Download,Info,KeyRound,LogOut,RefreshCw} from 'lucide-react';
import {Btn,CopyValue,Notice,Skeleton} from '@/ui/kit/kit';
import {Field} from '@/ui/kit/field';
import {SessionCard} from '@/ui/session/session-card';
import type {Viewer} from '@/lib/types';
import {api,ApiError,downloadText,message} from '@/ui/base/api';
import {portalNow,SESSION_LOCK_EVENT,SESSION_SYNC_EVENT} from '@/ui/base/http';
import {mergeSessionStatus,sessionExpired,type SessionTiming} from '@/ui/session/session-state';
import {createSessionActivity,watchPortalActivity,watchRemoteDesktopActivity} from '@/ui/session/session-activity';
import {PasskeySignInOptions} from '@/ui/account/passkeys-panel';
import {authenticatePasskey,cancelPasskey,passkeyError,setupPasskey,type PasskeyDevice} from '@/ui/session/passkey-client';
import {SessionIdleProvider} from '@/ui/session/session-idle';
import {idleLogoutText} from '@/ui/session/session-idle-state';
import IdentityChangeGate from '@/ui/session/identity-change-gate';
import MfaQrCode from '@/ui/session/mfa-qr-code';
import {samePortalIdentity,type IdentityReply} from '@/ui/session/portal-identity';
import {useLocale,useT} from '@/ui/base/locale';
import {clearAssistantConversations} from '@/ui/devices/assistant/assistant-conversations';
import {setIdentitySource} from '@/ui/session/identity-source';
import {accountDetail,accountName,viewerNameParts} from '@/lib/account-display';
import {EMPTY_VALUE} from '@/lib/i18n/format';

/** Starts the sign-in with Microsoft Entra ID: a full navigation to the start route, which leaves for Microsoft (the sign-in card). */
export const entraStartPath='/api/auth/entra/start';

// authenticatorCount and passkeysAvailable are absent in replies of older
// servers; the gate then offers the authenticator-app flow only.
type Status=SessionTiming&{enabled:boolean;available:boolean;idleTimeoutMs:number;serverTime:number;passkeyCount?:number;authenticatorCount?:number;passkeysAvailable?:boolean};
/**
 * Why the session of the console ended (docs/portal-sessions.md): `idle` when the
 * idle deadline passed, with the idle timeout in ms; `ended` for every other
 * cause. The sign-in card (ui/session/identity-entry.tsx) names it in its notice.
 */
export type SessionEnd={reason:'idle'|'ended';idleTimeoutMs:number|null};
/** Whether the idle deadline of `status` passed before its absolute end at `time`: an idle timeout, not the 24-hour limit. */
export function idleEnded(status:Pick<Status,'authenticated'|'idleExpiresAt'|'sessionExpiresAt'>|null,time:number){
 return !!status?.authenticated&&status.idleExpiresAt!==null&&status.idleExpiresAt<=time&&(status.sessionExpiresAt===null||status.idleExpiresAt<status.sessionExpiresAt);
}
type SessionReply=Status&{ok?:boolean;recoveryCodes?:string[]};
type Setup={secret:string;uri:string;expiresAt:number};

export async function signOutPortal(){
 cancelPasskey();
 // The kept assistant conversations of this tab end when the user signs out (assistant-conversations.ts), also when the logout request fails.
 try{await api('/api/auth',{action:'logout'});}
 finally{clearAssistantConversations();}
 window.location.assign('/');
}

/**
 * The account line of the session card. A local account shows its display name
 * and username as before. An Entra account follows lib/account-display.ts: the
 * name, then " · <email>" when there is one; the title is the email or absent,
 * never entra.<oid> or the .serverdesk.invalid address.
 */
export function SessionAccountLine({viewer}:{viewer:Viewer}){
 if(viewer.identitySource!=='entra')return <p className="sd-session-account" title={viewer.username??viewer.label}>{viewer.displayName??viewer.username??viewer.label}{viewer.displayName&&viewer.username&&viewer.displayName!==viewer.username&&<> · {viewer.username}</>}</p>;
 const name=accountName(viewerNameParts(viewer)),detail=accountDetail({identitySource:'entra',email:viewer.entra?.email});
 return <p className="sd-session-account" title={detail||undefined}>{name||EMPTY_VALUE}{detail&&detail!==name&&<> · {detail}</>}</p>;
}

/**
 * The MFA step of a signed-in viewer and the frame of the console. When the
 * session ends for any reason (idle deadline, SESSION_EXPIRED, MFA_LOGIN_REQUIRED,
 * IDENTITY_LOGIN_REQUIRED), it hands over to the normal sign-in card through
 * `onSessionEnded`, without a reload: the sign-in after the idle timeout asks for
 * the same factors as the sign-in after Sign out (docs/portal-sessions.md).
 */
export default function SessionGate({viewer,onSessionEnded,children}:{viewer:Viewer;onSessionEnded:(end:SessionEnd)=>void;children:ReactNode}){
 const t=useT(),[locale]=useLocale();
 const[status,setStatus]=useState<Status|null>(null),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[hint,setHint]=useState(''),[handedOver,setHandedOver]=useState(false);
 const[identityChange,setIdentityChange]=useState<string|null>(null),identityChangePaused=useRef(false),checkAbort=useRef<AbortController|null>(null);
 const[setup,setSetup]=useState<Setup|null>(null),[code,setCode]=useState(''),[recovery,setRecovery]=useState(false),[codes,setCodes]=useState<string[]>([]);
 // The device whose passkey setup dialog is open, and the factor the shown recovery codes replace.
 const[ceremony,setCeremony]=useState<PasskeyDevice|null>(null),[codeFactor,setCodeFactor]=useState<'authenticator'|'passkey'>('authenticator');
 const statusRef=useRef(status),generation=useRef(0),mounted=useRef(false),checkInFlight=useRef(false),queuedCheck=useRef(false),passkeyAttempt=useRef<AbortController|null>(null),ended=useRef(false),endedCallback=useRef(onSessionEnded);
 statusRef.current=status;endedCallback.current=onSessionEnded;
 const update=useCallback((next:Status)=>{const merged=mergeSessionStatus(statusRef.current,next);statusRef.current=merged;setStatus(merged);},[]);
 // The session is gone: stop every request of this gate, drop the console, setup secrets and recovery codes, and hand
 // over to the sign-in card once.
 const lock=useCallback(()=>{
  if(ended.current)return;ended.current=true;
  generation.current++;checkAbort.current?.abort();passkeyAttempt.current?.abort();
  setCode('');setSetup(null);setCodes([]);setCeremony(null);setBusy(false);setLoading(false);setHandedOver(true);
  const previous=statusRef.current;
  if(previous)update({...previous,authenticated:false,verifiedUntil:null,idleExpiresAt:null,sessionExpiresAt:null,sessionId:null,lastActivityAt:null});
  endedCallback.current?.({reason:idleEnded(previous,portalNow())?'idle':'ended',idleTimeoutMs:previous?.idleTimeoutMs??null});
 },[update]);
 const recover=(reply:IdentityReply,signal:AbortSignal)=>{
  if(!mounted.current||signal.aborted)return;
  if(!samePortalIdentity(viewer,reply.viewer)){identityChanged();return;}
  generation.current++;checkAbort.current?.abort();passkeyAttempt.current?.abort();queuedCheck.current=false;
  if(!reply.session.authenticated){setSetup(null);setCode('');setCodes([]);setRecovery(false);}
  update(reply.session);identityChangePaused.current=false;setIdentityChange(null);setError('');setHint(reply.session.authenticated?'':t('session.confirmAgain'));setLoading(false);setCeremony(null);setBusy(false);
 };
 const identityChanged=()=>{generation.current++;checkAbort.current?.abort();passkeyAttempt.current?.abort();identityChangePaused.current=true;setIdentityChange(t('session.identityChanged'));};
 const entraAccount=viewer.identitySource==='entra';
 const check:()=>Promise<void>=useCallback(async()=>{
  if(identityChangePaused.current||ended.current)return;
  if(checkInFlight.current){queuedCheck.current=true;return;}
  checkInFlight.current=true;const currentGeneration=generation.current,abort=new AbortController();checkAbort.current=abort;
  const timeout=setTimeout(()=>abort.abort(),5000);
  try{
   let next=await api<Status>('/api/mfa',undefined,abort.signal);
   if(!mounted.current||generation.current!==currentGeneration)return;
   if(statusRef.current?.authenticated&&!next.authenticated){
    // A status read sent just before another tab's successful login may return
    // late. Recheck the now-current shared cookie before unmounting the portal.
    next=await api<Status>('/api/mfa',undefined,abort.signal);
    if(!mounted.current||generation.current!==currentGeneration)return;
   }
   // An account from Microsoft Entra ID has no portal factor: without a live session it signs in with Microsoft again.
   if((statusRef.current?.authenticated||entraAccount)&&!next.authenticated)lock();
   else update(next);
   setError('');
  }catch(e){if(mounted.current&&generation.current===currentGeneration){
   setError(message(e));const current=statusRef.current;
   if(e instanceof ApiError&&e.code==='IDENTITY_LOGIN_REQUIRED')lock();
   else if(current?.authenticated&&((e instanceof ApiError&&[401,403].includes(e.status))||sessionExpired(current,portalNow())))lock();
  }}
  finally{clearTimeout(timeout);if(checkAbort.current===abort)checkAbort.current=null;checkInFlight.current=false;if(mounted.current){setLoading(false);if(queuedCheck.current&&!identityChangePaused.current){queuedCheck.current=false;queueMicrotask(()=>void check());}}}
 },[update,lock,entraAccount]);
 useEffect(()=>{
  mounted.current=true;void check();
  const expired=(event:Event)=>{const detail=(event as CustomEvent<{code?:string}>).detail;if(detail?.code==='IDENTITY_LOGIN_REQUIRED'||statusRef.current?.authenticated)lock();};window.addEventListener(SESSION_LOCK_EVENT,expired);
  const sync=()=>void check();window.addEventListener(SESSION_SYNC_EVENT,sync);
  const returned=(event:PageTransitionEvent)=>{if(event.persisted){const current=statusRef.current;if(sessionExpired(current,portalNow()))lock();void check();}};window.addEventListener('pageshow',returned);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- generation is a generation counter, not DOM refs; the cleanup increments it so that late responses are dropped.
  return()=>{mounted.current=false;generation.current++;checkAbort.current?.abort();passkeyAttempt.current?.abort();window.removeEventListener(SESSION_LOCK_EVENT,expired);window.removeEventListener(SESSION_SYNC_EVENT,sync);window.removeEventListener('pageshow',returned);};
 },[check,lock]);
 const sessionActive=!!status?.authenticated&&!identityChange,authenticated=sessionActive&&codes.length===0;
 useEffect(()=>{
  if(!sessionActive)return;
  const currentGeneration=generation.current;
  const activity=createSessionActivity<SessionReply>({
   now:()=>performance.now(),idleRemaining:()=>(statusRef.current?.idleExpiresAt??0)-portalNow(),
   isLive:()=>generation.current===currentGeneration&&statusRef.current?.authenticated===true,
   send:signal=>api<SessionReply>('/api/mfa',{action:'activity'},signal),
   onReply:next=>update(next),onError:e=>setError(message(e)),
   shouldRetry:e=>!(e instanceof ApiError&&[401,403].includes(e.status)),
  });
  const stopWatching=watchPortalActivity(window,()=>document.visibilityState!=='hidden',()=>activity.interact());
  const stopRemoteWatching=watchRemoteDesktopActivity(window,window.location.origin,()=>Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe[data-serverdesk-rdp]'),frame=>({contentWindow:frame.contentWindow,serverId:frame.dataset.serverdeskRdp??''})),()=>document.visibilityState!=='hidden',()=>activity.interact());
  const activityTimer=setInterval(()=>void activity.flush(),15000);
  const statusTimer=setInterval(()=>void check(),30000);
  const deadlineTimer=setInterval(()=>{const current=statusRef.current;if(sessionExpired(current,portalNow()))void check();},1000);
  const visible=()=>{if(document.visibilityState==='visible'){const current=statusRef.current;if(sessionExpired(current,portalNow()))lock();void check();}};document.addEventListener('visibilitychange',visible);
  return()=>{activity.dispose();stopWatching();stopRemoteWatching();clearInterval(activityTimer);clearInterval(statusTimer);clearInterval(deadlineTimer);document.removeEventListener('visibilitychange',visible);};
 },[sessionActive,check,update,lock]);

 const begin=async()=>{
  setBusy(true);setCeremony(null);setError('');setHint('');const currentGeneration=generation.current;
  try{const next=await api<Setup>('/api/mfa',{action:'begin'});if(mounted.current&&generation.current===currentGeneration){setSetup(next);setCode('');setRecovery(false);}}
  catch(e){if(mounted.current&&generation.current===currentGeneration)setError(message(e));}finally{if(mounted.current&&generation.current===currentGeneration)setBusy(false);}
 };
 const login=async()=>{
  setBusy(true);setError('');const currentGeneration=++generation.current;
  try{
   const result=await api<SessionReply>('/api/mfa',{action:setup?'confirm':'verify',...(!setup&&recovery?{recoveryCode:code}:{code})});
   if(!mounted.current||generation.current!==currentGeneration)return;
   update(result);setSetup(null);setCode('');setHint('');setRecovery(false);
   if(result.recoveryCodes?.length){setCodeFactor('authenticator');setCodes(result.recoveryCodes);}
  }catch(e){if(mounted.current&&generation.current===currentGeneration)setError(message(e));}
  finally{if(mounted.current&&generation.current===currentGeneration)setBusy(false);}
 };
 // First enrollment with a passkey. Lock, unmount and an identity change abort the
 // ceremony through passkeyAttempt and the generation; a late reply is ignored.
 const setupWithPasskey=async(device:PasskeyDevice)=>{
  if(busy)return;
  const currentGeneration=++generation.current,controller=new AbortController();passkeyAttempt.current=controller;
  setBusy(true);setCeremony(device);setError('');setHint('');
  try{
   const result=await setupPasskey(device,controller.signal);
   if(!mounted.current||generation.current!==currentGeneration)return;
   // A passkey setup always creates an account without an authenticator app, and
   // the reply has no count: a later lock must offer the passkey-only login.
   update({...result,authenticatorCount:0});setSetup(null);setCode('');setRecovery(false);
   if(result.recoveryCodes?.length){setCodeFactor('passkey');setCodes(result.recoveryCodes);}
  }catch(e){if(mounted.current&&generation.current===currentGeneration)setError(passkeyError(e,locale));}
  finally{if(mounted.current&&generation.current===currentGeneration){setBusy(false);setCeremony(null);passkeyAttempt.current=null;}}
 };
 const loginPasskey=async(device:PasskeyDevice)=>{
  if(busy)return;
  const currentGeneration=++generation.current,controller=new AbortController();passkeyAttempt.current=controller;
  setBusy(true);setError('');
  try{
   const result=await authenticatePasskey(device,controller.signal);
   if(!mounted.current||generation.current!==currentGeneration)return;
   update(result);setSetup(null);setCode('');setHint('');setRecovery(false);
  }catch(e){if(mounted.current&&generation.current===currentGeneration)setError(passkeyError(e,locale));}
  finally{if(mounted.current&&generation.current===currentGeneration){setBusy(false);passkeyAttempt.current=null;}}
 };
 const logout=async()=>{generation.current++;passkeyAttempt.current?.abort();setBusy(true);setError('');try{await signOutPortal();}catch(e){setError(message(e));setBusy(false);}};
 // Handed over to the sign-in card: the parent replaces this gate, and nothing of the session stays on screen.
 if(handedOver)return null;
 if(identityChange)return <IdentityChangeGate viewer={viewer} reason={identityChange} onVerified={recover} onIdentityChange={identityChanged}/>;
 // The console learns the identity source of its account here (MfaStepUp reads it). Idempotent for one viewer.
 setIdentitySource(viewer.identitySource);
 if(authenticated)return <SessionIdleProvider status={status!}>{children}</SessionIdleProvider>;
 // An enabled account without an authenticator signs in with a passkey or a recovery code.
 const passkeyOnly=!!status?.enabled&&status.authenticatorCount===0;
 const offerPasskey=status?.passkeysAvailable===true;
 const waitBlocked=busy?t('session.blocked.busy'):undefined,codeForm=recovery&&!setup;
 const codeBlocked=codeForm?(code.trim()?undefined:t('mfa.blocked.recovery')):/^\d{6}$/.test(code)?undefined:t('session.codeBlocked');
 // The passkey-only login (no code form) and the setup with a passkey offered lead with the passkey of this device.
 const passkeyLogin=!setup&&!!status?.enabled&&!!status.available&&(status.passkeyCount??0)>0&&!(passkeyOnly&&recovery);
 return <SessionCard id="session-title" title={codes.length?t('session.title.recoveryCodes'):loading?t('session.title.checking'):setup?t('session.title.setup'):status?.enabled?t('session.title.signIn'):t('session.title.secure')}>
  <SessionAccountLine viewer={viewer}/>
  {loading?<Skeleton variant="facts" rows={2} label={t('session.checkingSession')}/>:codes.length?<>
   <p>{codeFactor==='passkey'?t('session.codesReplacePasskey'):t('session.codesReplaceAuthenticator')}</p>
   <div className="sd-session-copy"><span className="sdx-field-label">{t('account.codesLabel')}</span><CopyValue value={codes.join('\n')} label={t('account.copyCodes')} success={t('account.codesCopied')} display={<ul className="sd-session-codes mono">{codes.map(value=><li key={value}>{value}</li>)}</ul>}/></div>
   <Btn icon={Download} onClick={()=>downloadText('ServerDesk-Recovery-Codes.txt',codes.join('\n'),'text/plain')}>{t('account.saveCodes')}</Btn>
   <Btn variant="primary" className="sd-session-primary" icon={ArrowRight} onClick={()=>setCodes([])}>{t('session.continue')}</Btn>
  </>:<>
   {hint&&<Notice tone="info" icon={Info}>{hint}</Notice>}
   {error&&<Notice tone="danger" icon={AlertTriangle}>{error}</Notice>}
   {status&&!status.available?<p>{t('session.mfaUnavailable')}</p>:setup?<>
    <p>{t('session.addToApp')}</p>
    <MfaQrCode uri={setup.uri} expiresAt={setup.expiresAt}/>
    <div className="sd-session-secret"><span className="sdx-field-label">{t('session.setupKey')}</span><CopyValue value={setup.secret} label={t('session.copySetupKey')} success={t('session.setupKeyCopied')}/><a href={setup.uri}>{t('session.openAuthenticator')}</a></div>
    <Btn variant="ghost" className="sd-session-link" blocked={waitBlocked} onClick={()=>void begin()}>{t('session.restartSetup')}</Btn>
   </>:status?.enabled?<p>{passkeyOnly?t('session.confirmPasskey'):status.passkeyCount?t('session.confirmPasskeyOrAuthenticator'):t('session.confirmAuthenticator')}</p>:status?<>
    <p>{t('session.secondStep')}</p>
    {offerPasskey&&<PasskeySignInOptions busy={busy} primary title={t('session.setupWithPasskey')} badge={t('session.recommended')} divider={t('session.orAuthenticatorApp')} pending={ceremony} onSelect={device=>void setupWithPasskey(device)}/>}
    <Btn variant={offerPasskey?'secondary':'primary'} className="sd-session-primary" icon={KeyRound} loading={busy&&!ceremony} blocked={busy&&ceremony?waitBlocked:undefined} onClick={()=>void begin()}>{t('session.setupAuthenticator')}</Btn>
   </>:<Btn variant="primary" className="sd-session-primary" icon={RefreshCw} loading={busy} onClick={()=>void check()}>{t('common.checkAgain')}</Btn>}
   {passkeyLogin&&<PasskeySignInOptions busy={busy} primary={passkeyOnly} divider={passkeyOnly?t('session.orRecoveryCode'):undefined} onSelect={device=>void loginPasskey(device)}/>}
   {!setup&&passkeyOnly&&status?.available&&!recovery&&<Btn variant="ghost" className="sd-session-link" blocked={waitBlocked} onClick={()=>{setRecovery(true);setCode('');setError('');}}>{t('session.useRecoveryCode')}</Btn>}
   {(setup||status?.enabled)&&status?.available&&(!passkeyOnly||recovery)&&<form className="sd-session-form" onSubmit={event=>{event.preventDefault();if(!busy&&!codeBlocked)void login();}}>
    <Field label={codeForm?t('session.recoveryCode'):t('session.authenticatorCode')}><input id="portal-mfa-code" className="sd-session-code" disabled={busy} autoFocus value={code} onChange={event=>setCode(event.target.value)} inputMode={codeForm?'text':'numeric'} autoComplete="one-time-code" maxLength={codeForm?40:6} placeholder={codeForm?'XXXX-XXXX-…':'000000'}/></Field>
    <Btn type="submit" variant="primary" className="sd-session-primary" loading={busy} blocked={codeBlocked}>{setup?t('session.activateMfa'):t('session.title.signIn')}</Btn>
    {!setup&&<Btn variant="ghost" className="sd-session-link" blocked={waitBlocked} onClick={()=>{setRecovery(!recovery);setCode('');setError('');}}>{recovery?passkeyOnly?t('session.usePasskey'):t('session.useAuthenticator'):t('session.useRecoveryCode')}</Btn>}
   </form>}
   {status?.available&&idleLogoutText(status.idleTimeoutMs,locale)&&<small>{idleLogoutText(status.idleTimeoutMs,locale)}</small>}
   <Btn variant="ghost" className="sd-session-link" icon={LogOut} blocked={waitBlocked} onClick={()=>void logout()}>{t('session.signOut')}</Btn>
  </>}
 </SessionCard>;
}
