'use client';
import {useCallback,useEffect,useRef,useState,type FormEvent} from 'react';
import {AlertTriangle,Info,LifeBuoy,LogIn,RefreshCw} from 'lucide-react';
import {Btn,Disclosure,Notice,Skeleton} from '@/ui/kit/kit';
import {Field} from '@/ui/kit/field';
import {SessionCard} from '@/ui/session/session-card';
import type {Viewer} from '@/lib/types';
import {api,message} from '@/ui/base/api';
import {passwordProblem,usernameProblem} from '@/ui/session/identity-password';
import {useLocale,useStableT,useT} from '@/ui/base/locale';
import SessionGate,{entraStartPath,type SessionEnd} from '@/ui/session/session-gate';
import type {MessageKey} from '@/lib/i18n/translate';
import {amrDetail,parseAmrDiagnostic} from '@/lib/entra/amr';
import Console from '@/ui/shell/console';
import '@/ui/session/identity-entry.css';

// entra.entraOnly: Microsoft sign-in only is on, so only the emergency access signs in with a password (docs/entra-id.md).
type IdentityStatus={viewer:Viewer|null;passwordConfigured:boolean;entra?:{enabled:boolean;entraOnly?:boolean}};
// The outcomes of a sign-in with Microsoft that come back as #entra=<code> (lib/server/identity/entra/sign-in.ts).
const entraErrorKeys:Readonly<Record<string,MessageKey>>={notConfigured:'entra.error.notConfigured',cancelled:'entra.error.cancelled',expired:'entra.error.expired',mfaMissing:'entra.error.mfaMissing',apiSetupMissing:'entra.error.apiSetupMissing',wrongTenant:'entra.error.wrongTenant',accountDisabled:'entra.error.accountDisabled',groupsOverage:'entra.error.groupsOverage',tokenRejected:'entra.error.tokenRejected',staleSignIn:'entra.error.staleSignIn',unavailable:'entra.error.unavailable',busy:'apiError.entra.busy',rateLimited:'apiError.auth.rateLimited'};
/** The catalog key of a #entra=<code>; an unknown code reads as tokenRejected. */
export const entraErrorKey=(code:string|null):MessageKey=>code!==null&&Object.hasOwn(entraErrorKeys,code)?entraErrorKeys[code]:'entra.error.tokenRejected';
/**
 * The detail line of #entra=mfaMissing&amr=<diagnostic> (lib/entra/amr.ts): which sign-in
 * methods Microsoft reported. Null for any other code and for an amr value that does not parse.
 */
export function entraErrorDetail(code:string|null,amr:string|null):{key:MessageKey;params?:{methods:string}}|null{
 const diagnostic=code==='mfaMissing'&&amr!==null?parseAmrDiagnostic(amr):null;
 if(diagnostic===null)return null;
 const detail=amrDetail(diagnostic);
 return detail.key==='entra.error.amrValues'?{key:detail.key,params:{methods:detail.methods}}:{key:detail.key};
}

/** "Sign in with Microsoft" as the leading primary action, then the divider before the built-in form (none while Microsoft sign-in only is on). `focus` takes the focus on mount (an Entra account after its session ended). */
export function EntraSignInChoice({redirecting,blocked,divider=true,focus=false,onStart}:{redirecting:boolean;blocked?:string;divider?:boolean;focus?:boolean;onStart:()=>void}){
 const t=useT();
 return <div className="sd-identity-entra">
  <Btn variant="primary" className="sd-session-primary" icon={LogIn} loading={redirecting} blocked={blocked} autoFocus={focus} onClick={onStart}>{t('identity.signInWithMicrosoft')}</Btn>
  {redirecting&&<p className="sd-session-status" role="status">{t('identity.redirecting')}</p>}
  {divider&&<div className="sd-identity-divider" role="separator" aria-label={t('identity.or')}><span aria-hidden="true">{t('identity.or')}</span></div>}
 </div>;
}
// The reply sets the primary session cookie; its body never carries a token.
type LoginReply={ok:boolean;viewer?:Viewer};
type Invitation={valid:true;kind:'invite'|'reset';username:string;displayName:string;expiresAt:number};
/**
 * The notice of the sign-in card after the console lost its session
 * (SessionGate, docs/portal-sessions.md): who signed in, so the card can prefill
 * the username of a built-in account or lead with Microsoft for an Entra one.
 */
type Ended={notice:string;entra:boolean};
/** The notice text of a SessionEnd: the idle timeout in minutes when the idle deadline passed, else the generic end. */
export function sessionEndNotice(end:SessionEnd,t:(key:MessageKey,params?:Record<string,string|number>)=>string){
 const minutes=end.idleTimeoutMs!==null&&Number.isFinite(end.idleTimeoutMs)&&end.idleTimeoutMs>=60_000?Math.round(end.idleTimeoutMs/60_000):null;
 return end.reason==='idle'&&minutes!==null?t('session.idleSignedOut',{count:minutes}):t('session.endedSignIn');
}
const validViewer=(value:unknown):value is Viewer=>!!value&&typeof value==='object'&&typeof (value as Viewer).id==='string'&&!!(value as Viewer).id&&typeof (value as Viewer).label==='string';

export default function IdentityEntry(){
 const[status,setStatus]=useState<IdentityStatus|null>(null),[viewer,setViewer]=useState<Viewer|null>(null),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[username,setUsername]=useState(''),[password,setPassword]=useState(''),[confirmation,setConfirmation]=useState(''),[invitation,setInvitation]=useState<Invitation|null>(null),[invitationFailed,setInvitationFailed]=useState(false),[entraError,setEntraError]=useState(''),[entraDetail,setEntraDetail]=useState(''),[redirecting,setRedirecting]=useState(false),[emergencyOpen,setEmergencyOpen]=useState(false),[ended,setEnded]=useState<Ended|null>(null);
 const t=useT(),stableT=useStableT(),[locale]=useLocale();
 const mounted=useRef(false),controller=useRef<AbortController|null>(null),sequence=useRef(0),busyRef=useRef(false),token=useRef<string|null>(null);
 const load=useCallback(async()=>{
  const request=++sequence.current,abort=new AbortController();controller.current?.abort();controller.current=abort;setLoading(true);setError('');
  const timer=setTimeout(()=>abort.abort(new Error(stableT('identity.checkTimeout'))),15000);
  try{
   if(token.current){const data=await api<Invitation>('/api/auth',{action:'invitation-info',token:token.current},abort.signal);if(!mounted.current||sequence.current!==request||abort.signal.aborted)return;if(data.valid!==true||!['invite','reset'].includes(data.kind)||typeof data.username!=='string'||!Number.isFinite(data.expiresAt))throw new Error(stableT('identity.invitationInvalid'));setInvitation(data);setUsername(data.username);setInvitationFailed(false);}
   else{const data=await api<IdentityStatus>('/api/auth',undefined,abort.signal);if(!mounted.current||sequence.current!==request||abort.signal.aborted)return;setStatus(data);setViewer(validViewer(data.viewer)?data.viewer:null);}
  }catch(e){if(mounted.current&&sequence.current===request){setError(abort.signal.aborted?stableT('identity.checkTooLong'):message(e));if(token.current)setInvitationFailed(true);}}
  finally{clearTimeout(timer);if(controller.current===abort)controller.current=null;if(mounted.current&&sequence.current===request)setLoading(false);}
 },[stableT]);
 useEffect(()=>{
  mounted.current=true;
  const params=new URLSearchParams(window.location.hash.slice(1));
  // A sign-in with Microsoft that came back refused: the code leaves the address bar, its message stays.
  if(params.has('entra')){const code=params.get('entra'),detail=entraErrorDetail(code,params.get('amr'));window.history.replaceState(window.history.state,'',window.location.pathname+window.location.search);setEntraError(stableT(entraErrorKey(code)));setEntraDetail(detail?stableT(detail.key,detail.params):'');}
  if(params.has('invite')){const value=params.get('invite')??'';window.history.replaceState(window.history.state,'',window.location.pathname+window.location.search);if(/^[a-f0-9]{64}$/.test(value))token.current=value;else{setInvitationFailed(true);setError(stableT('identity.invitationInvalid'));setLoading(false);return()=>{mounted.current=false;sequence.current++;controller.current?.abort();};}}
  // Keep the component-local token across React's effect replay after stripping
  // the fragment. A real unmount drops this ref; it never enters shared storage.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- sequence is a generation counter, not DOM refs; the cleanup increments it so that late responses are dropped.
  void load();return()=>{mounted.current=false;sequence.current++;controller.current?.abort();};
 },[load,stableT]);
 const login=async(event:FormEvent)=>{
  event.preventDefault();if(busyRef.current||loading||invitationFailed)return;
  if(invitation){const problem=passwordProblem(password,confirmation,locale)||usernameProblem(username,locale);if(problem){setError(problem);return;}}
  if(!username.trim()||!password)return;
  const request=++sequence.current,abort=new AbortController();controller.current?.abort();controller.current=abort;busyRef.current=true;setBusy(true);setError('');setNotice('');setEntraError('');setEntraDetail('');
  const timer=setTimeout(()=>abort.abort(new Error(t('identity.loginTooLong'))),30000);
  try{
   const chosen=invitation;
   const result=await api<LoginReply>('/api/auth',chosen?{action:'redeem',token:token.current,username:username.trim(),password}:{action:'login',username:username.trim(),password},abort.signal);
   if(!mounted.current||sequence.current!==request||abort.signal.aborted)return;
   if(result.ok!==true)throw new Error(t('identity.loginIncomplete'));
   setPassword('');setConfirmation('');
   if(chosen?.kind==='reset'){token.current=null;setInvitation(null);setInvitationFailed(false);setStatus(null);setViewer(null);setNotice(t('identity.passwordChanged'));return;}
   if(!validViewer(result.viewer))throw new Error(t('identity.loginUnverified'));
   token.current=null;setInvitation(null);setInvitationFailed(false);setEnded(null);setViewer(result.viewer);setStatus(null);
  }catch(e){if(mounted.current&&sequence.current===request)setError(abort.signal.aborted?t('identity.loginIncompleteRetry'):message(e));}
  finally{clearTimeout(timer);if(controller.current===abort)controller.current=null;busyRef.current=false;if(mounted.current&&sequence.current===request)setBusy(false);}
 };
 const forgetInvitation=()=>{sequence.current++;controller.current?.abort();token.current=null;setInvitation(null);setInvitationFailed(false);setPassword('');setConfirmation('');setError('');void load();};
 const entra=!invitation&&!invitationFailed&&status?.entra?.enabled===true;
 // Microsoft sign-in only: with Microsoft on, the password form waits behind "Use emergency access"; with Microsoft off it shows at once. Both say who may use it.
 const entraOnly=!invitation&&!invitationFailed&&status?.entra?.entraOnly===true,collapsed=entraOnly&&entra;
 const startEntra=()=>{if(redirecting)return;setEntraError('');setEntraDetail('');setRedirecting(true);window.location.assign(entraStartPath);};
 // The console lost its session: back to this card without a reload, with the reason on top. A built-in account
 // finds its username filled in; an Entra account leads with Microsoft. GET /api/auth reads the sign-in options again.
 const sessionEnded=(account:Viewer,end:SessionEnd)=>{
  const entraAccount=account.identitySource==='entra';
  setEnded({notice:sessionEndNotice(end,stableT),entra:entraAccount});setUsername(entraAccount?'':account.username??'');setPassword('');setError('');setNotice('');
  setViewer(null);setStatus(null);void load();
 };
 if(viewer&&!invitation&&!invitationFailed)return <SessionGate key={viewer.id+':'+viewer.label} viewer={viewer} onSessionEnded={end=>sessionEnded(viewer,end)}><Console viewer={viewer}/></SessionGate>;
 const passwordFocus=!!ended&&!ended.entra&&!collapsed;
 const signInBlocked=!username.trim()||!password?t('identity.blocked.fields'):invitation&&!confirmation?t('identity.blocked.repeat'):redirecting?t('session.blocked.busy'):undefined;
 const form=<form className="sd-identity-form" onSubmit={event=>void login(event)}>
  <Field label={t('identity.username')}><input id="identity-username" autoFocus={collapsed&&emergencyOpen} autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} disabled={busy||invitation?.kind==='reset'} maxLength={64} onChange={event=>setUsername(event.target.value)}/></Field>
  <Field label={invitation?t('identity.newPassword'):t('identity.password')} hint={invitation?t('identity.passwordRule'):undefined}><input id="identity-password" type="password" autoFocus={passwordFocus} autoComplete={invitation?'new-password':'current-password'} value={password} disabled={busy} maxLength={256} onChange={event=>setPassword(event.target.value)}/></Field>
  {invitation&&<Field label={t('identity.repeatPassword')}><input id="identity-password-confirm" type="password" autoComplete="new-password" value={confirmation} disabled={busy} maxLength={256} onChange={event=>setConfirmation(event.target.value)}/></Field>}
  <Btn type="submit" variant={entra?'secondary':'primary'} className="sd-session-primary" icon={LogIn} loading={busy} blocked={signInBlocked}>{invitation?.kind==='reset'?t('identity.saveNewPassword'):invitation?t('identity.activate'):t('identity.signIn')}</Btn>
 </form>;
 return <SessionCard id="identity-title" className="sd-identity-card" title={invitation?.kind==='reset'?t('identity.title.reset'):invitation?t('identity.title.invite'):t('identity.title.signIn')}>
  {ended&&!invitation&&<Notice tone="info" icon={Info}>{ended.notice}</Notice>}
  {loading?<Skeleton variant="facts" rows={2} label={t('identity.checking')}/>:<>
   {invitation?<p>{invitation.kind==='reset'?t('identity.resetIntro'):t('identity.inviteIntro',{name:invitation.displayName||invitation.username})}</p>:!invitationFailed&&<p>{t(collapsed?'identity.signInIntroEntraOnly':entra?'identity.signInIntroEntra':'identity.signInIntro')}</p>}
   {notice&&<Notice tone="info" icon={Info}>{notice}</Notice>}{error&&<Notice tone="danger" icon={AlertTriangle}>{error}</Notice>}{entraError&&!error&&<Notice tone="danger" icon={AlertTriangle}>{entraError}{entraDetail&&<span className="sd-session-error-detail">{entraDetail}</span>}</Notice>}
   {entra&&<EntraSignInChoice redirecting={redirecting} blocked={busy?t('session.blocked.busy'):undefined} divider={!collapsed} focus={!!ended?.entra} onStart={startEntra}/>}
   {!invitationFailed&&(collapsed
    ?<Disclosure title={t('identity.emergency.open')} icon={LifeBuoy} open={emergencyOpen} onOpenChange={setEmergencyOpen} className="sd-identity-emergency-toggle">
     {emergencyOpen&&<div id="identity-emergency" className="sd-identity-emergency"><p className="sd-identity-emergency-hint">{t('identity.emergency.hint')}</p>{form}</div>}
    </Disclosure>
    :<div id="identity-emergency" className={entraOnly?'sd-identity-emergency':undefined}>{entraOnly&&<p className="sd-identity-emergency-hint">{t('identity.emergency.hint')}</p>}{form}</div>)}
   {invitation||invitationFailed?<Btn variant="ghost" className="sd-session-link" blocked={busy?t('session.blocked.busy'):undefined} onClick={forgetInvitation}>{t('identity.toSignIn')}</Btn>:<><p className="sd-identity-help">{t('identity.accountHelp')}</p>{!status&&<Btn icon={RefreshCw} className="sd-session-primary" blocked={busy?t('session.blocked.busy'):undefined} onClick={()=>void load()}>{t('common.checkAgain')}</Btn>}</>}
  </>}
 </SessionCard>;
}
