'use client';
// AD sign-in for plugin changes (docs/plugin-ad-sign-in.md, lib/plugin-ad.ts).
// A technician signs in once per portal session and directory: the first
// change on a server opens "Sign in to {domain}" before the confirmation, and
// the sign-in then covers every server of that domain and every plugin. Here:
// the client list of this portal session's sign-ins (GET /api/plugin-ad, kept
// in memory and shared by every view), the sign-in dialog (an auth prompt in the
// kit dialog, like the MFA step-up), the account chip of a plugin view head and
// the "Server sign-ins" card of the account page. The password goes once to POST
// /api/plugin-ad and is never kept; the last account typed stays in this tab's
// memory only.
import {useEffect,useRef,useState,type FormEvent,type ReactElement,type ReactNode} from 'react';
import {Dialog} from 'radix-ui';
import {toast} from 'sonner';
import {KeyRound,LogOut,RefreshCw,TriangleAlert} from 'lucide-react';
import type {Server,Viewer} from '@/lib/types';
import type {MessageKey} from '@/lib/i18n/translate';
import {formatClock} from '@/lib/i18n/format';
import {connectionKind} from '@/lib/device-connection';
import {agentMessageText} from '@/lib/agent-messages';
import {AD_ACCOUNT_MAX,adAccountTooLong,adSessionForDevice,adSignInField,deviceDirectory,devicesWithoutAdSession,pluginAccountBlocked,type AdDirectory,type AdSessionSummary,type AdSignInStatus} from '@/lib/plugin-ad';
import {api,ApiError,message,permitted} from '@/ui/base/api';
import {SESSION_LOCK_EVENT,portalNow} from '@/ui/base/http';
import {Btn,Card,Empty,EntranceList,IconBtn,IconTile,Menu,Notice,Skeleton,cx} from '@/ui/kit/kit';
import {Field} from '@/ui/kit/field';
import {useLocale,useT,type Translate} from '@/ui/base/locale';
import {useClockAt} from '@/ui/base/clock-store';
import '@/ui/devices/extensions/plugin-ad.css';

// ---- The sign-ins of this portal session ---------------------------------------------------------

type AdStore={sessions:AdSessionSummary[]|null;loading:boolean;error:string};
let store:AdStore={sessions:null,loading:false,error:''};
const listeners=new Set<()=>void>();
const emit=(next:Partial<AdStore>)=>{store={...store,...next};for(const listener of listeners)listener();};
let loading:Promise<void>|null=null;
/** The sign-ins the client knows now (empty before the first load). */
export const adSessionsNow=()=>store.sessions??[];
/** Sets the list and its load state, for the view test. */
export function primeAdSessions(sessions:AdSessionSummary[]|null,state:{loading?:boolean;error?:string}={}){emit({sessions,loading:state.loading??false,error:state.error??''});}
/** Loads the list again; parallel calls share one request. */
export function loadAdSessions():Promise<void>{
 if(loading)return loading;
 emit({loading:true});
 loading=api<{sessions:AdSessionSummary[]}>('/api/plugin-ad').then(result=>emit({sessions:result.sessions,loading:false,error:''}),failure=>emit({loading:false,error:message(failure)})).finally(()=>{loading=null;});
 return loading;
}
const addSession=(session:AdSessionSummary)=>emit({sessions:[...adSessionsNow().filter(item=>item.id!==session.id&&item.directory.sid.toUpperCase()!==session.directory.sid.toUpperCase()),session]});
const dropSession=(id:string)=>emit({sessions:adSessionsNow().filter(item=>item.id!==id)});
/** The shared list; demo mode has none. The first view that needs it loads it, a portal sign-out clears it. */
function useAdSessions(demo:boolean):AdStore{
 const [,render]=useState(0);
 useEffect(()=>{
  const listener=()=>render(value=>value+1),clear=()=>emit({sessions:null,error:''});
  listeners.add(listener);window.addEventListener(SESSION_LOCK_EVENT,clear);
  if(!demo&&store.sessions===null&&!store.loading)void loadAdSessions();
  return ()=>{listeners.delete(listener);window.removeEventListener(SESSION_LOCK_EVENT,clear);};
 },[demo]);
 return demo?{sessions:[],loading:false,error:''}:store;
}

/** Signs out of one sign-in: POST sign-out, then the row leaves the list and a toast names the domain. False on a failure (with its toast). */
export async function signOutAdSession(session:AdSessionSummary,t:Translate):Promise<boolean>{
 try{await api('/api/plugin-ad',{action:'sign-out',id:session.id});dropSession(session.id);toast.success(t('pluginAd.signOut.success',{domain:session.directory.name}));return true;}
 catch(failure){toast.error(message(failure));if(failure instanceof ApiError&&failure.status===404)dropSession(session.id);return false;}
}

// ---- The dialog request -------------------------------------------------------------------------

type SignInRequest={serverId:string;plugin:string;resolve:(ok:boolean)=>void};
let request:SignInRequest|null=null;
const requestListeners=new Set<()=>void>();
/** Opens the sign-in dialog for this device; true after a sign-in, false after Cancel. A newer request ends an older one with false. */
export function requestAdSignIn(serverId:string,plugin:string):Promise<boolean>{
 return new Promise(resolve=>{request?.resolve(false);request={serverId,plugin,resolve};for(const listener of requestListeners)listener();});
}
/** The open request (device and plugin), or null; for the view test. */
export const currentAdSignIn=()=>request?{serverId:request.serverId,plugin:request.plugin}:null;
/** Ends the open request: true after a sign-in, false after Cancel. */
export const finishRequest=(ok:boolean)=>{const current=request;request=null;for(const listener of requestListeners)listener();current?.resolve(ok);};
/**
 * The sign-ins a plugin change needs before its confirmation: one
 * dialog per directory of the target devices without a sign-in, in order.
 * False when the user cancels one; nothing is sent then.
 */
export async function ensureAdSessions(devices:readonly Server[],plugin:string,now=Date.now()):Promise<boolean>{
 for(const device of devicesWithoutAdSession(devices,adSessionsNow(),now))if(!await requestAdSignIn(device.id,plugin))return false;
 return true;
}

/** Mounted once in the console: shows the dialog of the open request. */
export function PluginAdSignInHost({servers,demo}:{servers:readonly Server[];demo:boolean}){
 const [,render]=useState(0);
 useEffect(()=>{const listener=()=>render(value=>value+1);requestListeners.add(listener);return ()=>{requestListeners.delete(listener);};},[]);
 const current=request,device=current?servers.find(item=>item.id===current.serverId):null;
 useEffect(()=>{if(current&&!device)finishRequest(false);},[current,device]);
 if(!current||!device)return null;
 return <PluginAdSignIn key={current.serverId+current.plugin} device={device} directory={deviceDirectory(device.snapshot)} plugin={current.plugin} demo={demo} onDone={()=>finishRequest(true)} onCancel={()=>finishRequest(false)}/>;
}

// ---- The sign-in -------------------------------------------------------------------------------

/** The outcome of the poll: the job's state, or timeout after the limit. */
export type AdSignInOutcome=AdSignInStatus|{state:'timeout'};
/** Polls GET /api/plugin-ad?jobId= every second until the job is no longer pending, at most 60 s. */
export async function pollAdSignIn(jobId:string,deps:{get?:(jobId:string)=>Promise<AdSignInStatus>;sleep?:(ms:number)=>Promise<void>;clock?:()=>number;limitMs?:number;intervalMs?:number;alive?:()=>boolean}={}):Promise<AdSignInOutcome>{
 const get=deps.get??(id=>api<AdSignInStatus>(`/api/plugin-ad?${new URLSearchParams({jobId:id})}`)),sleep=deps.sleep??(ms=>new Promise<void>(resolve=>setTimeout(resolve,ms)));
 const clock=deps.clock??Date.now,limit=deps.limitMs??60_000,interval=deps.intervalMs??1000,start=clock();
 while(clock()-start<limit){
  await sleep(interval);
  if(deps.alive&&!deps.alive())return {state:'timeout'};
  const status=await get(jobId);
  if(status.state!=='pending')return status;
 }
 return {state:'timeout'};
}
/** A failure of the dialog: the text and where it shows. */
export type AdSignInFailure={field:'account'|'password'|'notice';text:string};
/** The failure of a finished job (agent code or stored server message) or of the POST (API error key), placed by adSignInField. */
export function adSignInFailure(failure:{code?:string;args?:Record<string,string>;messageKey?:string;text?:string},t:Translate):AdSignInFailure{
 const text=failure.text??(failure.code?agentMessageText({result:failure.code,resultCode:failure.code,resultArgs:failure.args??{}},t):null)??t('console.actionFailed');
 return {field:adSignInField(failure.code,failure.messageKey),text};
}
/** The check before a sign-in is sent: an account over AD_ACCOUNT_MAX characters fails under Account, anything else passes (null). */
export const adAccountPrecheck=(account:string,t:Translate):AdSignInFailure|null=>adAccountTooLong(account)?{field:'account',text:t('pluginAd.error.accountTooLong',{max:AD_ACCOUNT_MAX})}:null;
// The last account typed in this browser tab (memory only, never stored).
let lastAccount='';

type SignInProps={device:Pick<Server,'id'|'name'>;directory:AdDirectory|null;plugin:string;demo:boolean;onDone:(session:AdSessionSummary)=>void;onCancel:()=>void};
/**
 * The form of the sign-in: an icon tile and "Sign in to {domain}", the one
 * sentence on the benefit, Account (autofocus, the format as the hint) and
 * Password (never pre-filled), the lockout line and the footer. `heading` and `describe`
 * wraps the title for the dialog. Exported for the view test.
 */
export function PluginAdSignInForm({device,directory,plugin,demo,onDone,onCancel,heading=node=>node,describe=node=>node,initial}:SignInProps&{heading?:(title:ReactElement)=>ReactNode;describe?:(body:ReactElement)=>ReactNode;
 /** The view test sets the state it renders. */
 initial?:{account?:string;busy?:boolean;failure?:AdSignInFailure|null}}){
 const t=useT(),[locale]=useLocale();
 const [account,setAccount]=useState(initial?.account??lastAccount),[password,setPassword]=useState(''),[busy,setBusy]=useState(initial?.busy??false),[failure,setFailure]=useState<AdSignInFailure|null>(initial?.failure??null);
 const alive=useRef(true),accountInput=useRef<HTMLInputElement>(null);
 useEffect(()=>{alive.current=true;return ()=>{alive.current=false;};},[]);
 const local=directory?.kind==='local',domain=directory?.name??device.name;
 const title=local?t('pluginAd.signIn.titleLocal',{device:device.name}):t('pluginAd.signIn.titleDomain',{domain});
 const submit=async(event:FormEvent)=>{
  event.preventDefault();
  if(demo||busy)return;
  // Too long: nothing is sent, the account and the password stay, focus goes to Account.
  const early=adAccountPrecheck(account,t);
  if(early){setFailure(early);accountInput.current?.focus();return;}
  lastAccount=account.trim();setBusy(true);setFailure(null);
  try{
   const {jobId}=await api<{jobId:string}>('/api/plugin-ad',{action:'sign-in',serverId:device.id,plugin,account,password});
   const outcome=await pollAdSignIn(jobId,{alive:()=>alive.current});
   if(!alive.current)return;
   if(outcome.state==='active'&&outcome.session){
    addSession(outcome.session);
    toast.success(t('pluginAd.signIn.success',{domain:outcome.session.directory.name,account:outcome.session.account}));
    onDone(outcome.session);return;
   }
   if(outcome.state==='timeout'){
    // The job may still wait on a busy device: it is cancelled so it never runs later.
    void api('/api/console',{action:'cancel-job',id:jobId}).catch(()=>{});
    setFailure({field:'notice',text:t('pluginAd.error.timeout',{device:device.name})});
   }
   else setFailure(adSignInFailure({code:outcome.code,args:outcome.args},t));
  }catch(error){
   if(alive.current)setFailure(adSignInFailure({code:error instanceof ApiError?error.code:undefined,messageKey:error instanceof ApiError?error.messageKey:undefined,text:message(error,locale)},t));
  }finally{
   // The password never outlives an attempt.
   if(alive.current){setBusy(false);setPassword('');}
  }
 };
 return <form className="sdx-ad-form" onSubmit={event=>void submit(event)} noValidate>
  <div className="sdx-ad-head"><IconTile icon={KeyRound}/>{heading(<h2 className="sdx-confirm-title">{title}</h2>)}</div>
  {describe(<p className="sdx-ad-body">{local?t('pluginAd.signIn.bodyLocal',{device:device.name}):t('pluginAd.signIn.bodyDomain',{domain})}</p>)}
  <Field label={t('pluginAd.field.account')} hint={local?t('pluginAd.field.accountHintLocal',{device:device.name}):t('pluginAd.field.accountHintDomain',{domain})} error={failure?.field==='account'?failure.text:undefined}>
   <input ref={accountInput} name="account" autoFocus autoComplete="off" autoCapitalize="none" spellCheck={false} value={account} readOnly={busy} onChange={event=>{setAccount(event.target.value);if(failure?.field==='account')setFailure(null);}}/>
  </Field>
  <Field label={t('pluginAd.field.password')} error={failure?.field==='password'?failure.text:undefined}>
   <input name="password" type="password" autoComplete="off" maxLength={256} value={password} readOnly={busy} onChange={event=>setPassword(event.target.value)}/>
  </Field>
  <p className="sdx-ad-meta">{t('pluginAd.signIn.lockout')}</p>
  {failure?.field==='notice'&&<Notice tone="danger" icon={TriangleAlert}>{failure.text}</Notice>}
  <footer className="sdx-confirm-foot">
   <Btn onClick={onCancel}>{t('common.cancel')}</Btn>
   <Btn type="submit" variant="primary" loading={busy} blocked={demo?t('kit.unavailable.demo'):undefined}>{busy?t('pluginAd.signIn.checking',{device:device.name}):t('pluginAd.signIn.submit')}</Btn>
  </footer>
 </form>;
}

/** The sign-in dialog: the kit dialog of an auth prompt. Cancel and Esc send nothing more and keep the user's form. */
export function PluginAdSignIn(props:SignInProps){
 const [returnTo]=useState(()=>typeof document==='undefined'?null:document.activeElement as HTMLElement|null);
 return <Dialog.Root open onOpenChange={open=>{if(!open)props.onCancel();}}>
  <Dialog.Portal>
   <Dialog.Overlay className="sdx-layer sdx-confirm-scrim"/>
   <Dialog.Content className="sdx-layer sdx-confirm-dialog sdx-ad-dialog" onCloseAutoFocus={event=>{if(returnTo?.isConnected){event.preventDefault();returnTo.focus();}}}>
    <PluginAdSignInForm {...props} heading={title=><Dialog.Title asChild>{title}</Dialog.Title>} describe={body=><Dialog.Description asChild>{body}</Dialog.Description>}/>
   </Dialog.Content>
  </Dialog.Portal>
 </Dialog.Root>;
}

// ---- The account chip of a plugin view -------------------------------------------------------

type ChipGate={permission:string;rightKey:MessageKey};
/**
 * The head chip: signed in, a ghost menu trigger with the account and
 * "until {time}" and the entry "Sign out of {domain}"; not signed in, the
 * ghost button "Sign in with AD account". Blocked in order: demo, the manage
 * right, offline, an agent without plugin-ad-identity. Shown only to viewers
 * who can manage the plugin on some device. The two states cross-fade.
 */
export function PluginAccountChip({server,viewer,demo,now,plugin,gate,devices=[]}:{server:Server;viewer:Viewer;demo:boolean;now:number;plugin:string;gate:ChipGate;devices?:readonly Server[]}){
 const t=useT(),[locale]=useLocale(),{sessions}=useAdSessions(demo);
 if(!demo&&!permitted(server,viewer,gate.permission)&&!devices.some(device=>permitted(device,viewer,gate.permission)))return null;
 const session=demo?null:adSessionForDevice(sessions??[],server.snapshot,now);
 if(session){
  const time=formatClock(locale,session.expiresAt);
  return <span className="sdx-ad-chip" key="signed-in">
   <Menu label={t('pluginAd.chip.label',{account:session.account,time})} entries={[{id:'sign-out',label:t('pluginAd.signOut',{domain:session.directory.name}),icon:LogOut,onSelect:()=>void signOutAdSession(session,t)}]}
    trigger={<button type="button" className="sdx-btn sdx-btn-ghost sdx-ad-chip-trigger" aria-label={t('pluginAd.chip.label',{account:session.account,time})}><KeyRound size={15} aria-hidden/><span className="mono">{session.account}</span><small>{t('pluginAd.chip.until',{time})}</small></button>}/>
  </span>;
 }
 const blocked=pluginAccountBlocked(server,viewer,demo,demo||connectionKind(server,now)==='online',gate);
 return <span className="sdx-ad-chip" key="signed-out"><Btn variant="ghost" icon={KeyRound} blocked={blocked?t(blocked.key,blocked.params):undefined} onClick={()=>void requestAdSignIn(server.id,plugin)}>{t('pluginAd.signIn.button')}</Btn></span>;
}

// ---- The account page ----------------------------------------------------------------------

/**
 * "Server sign-ins" on the account page: one row per sign-in of this
 * portal session with its account, domain, end and source, and a row action
 * "Sign out" (the row fades and collapses). Skeleton while it loads, a danger
 * notice with "Try again" on a failure, the empty state otherwise.
 */
export function ServerSignInsCard({demo,now:pinnedNow}:{demo:boolean;
 /** Pins the portal time (tests); without it the card follows the console clock and the portal's time. */
 now?:number}){
 const t=useT(),[locale]=useLocale(),{sessions,loading:busy,error}=useAdSessions(demo),[leaving,setLeaving]=useState<string[]>([]);
 const tick=useClockAt(()=>(sessions??[]).filter(session=>session.expiresAt>portalNow()).map(session=>session.id).join());
 const now=pinnedNow??(tick?portalNow():undefined);
 const rows=(sessions??[]).filter(session=>now===undefined||session.expiresAt>now);
 const signOut=async(session:AdSessionSummary)=>{
  setLeaving(current=>[...current,session.id]);
  // The row fades and collapses first (200 ms); it leaves the list only after the server confirmed.
  const [done]=await Promise.all([signOutAdSession(session,t),new Promise(resolve=>setTimeout(resolve,200))]);
  if(!done)setLeaving(current=>current.filter(id=>id!==session.id));
 };
 const body=sessions===null&&busy?<Skeleton variant="table" rows={2} label={t('common.loading')}/>
  :sessions===null&&error?<Notice tone="danger" icon={TriangleAlert} action={<Btn size="sm" icon={RefreshCw} onClick={()=>void loadAdSessions()}>{t('common.retry')}</Btn>}>{t('pluginAd.account.loadError')}</Notice>
  :!rows.length?<Empty icon={KeyRound} title={t('pluginAd.account.emptyTitle')}>{t('pluginAd.account.emptyText')}</Empty>
  :<EntranceList id="plugin-ad-sessions" as="ul" className="sdx-ad-list" role="list" label={t('pluginAd.account.title')}>{rows.map(session=><li key={session.id} className={cx('sdx-ad-row',leaving.includes(session.id)&&'sdx-ad-row-leaving')}>
   <div className="sdx-ad-row-inner">
    <IconTile icon={KeyRound} size="sm"/>
    <div className="sdx-ad-row-text"><strong className="mono">{session.account}</strong><small>{t('pluginAd.account.row',{domain:session.directory.name,time:formatClock(locale,session.expiresAt)})}</small></div>
    <span className="sdx-tag">{t(session.source==='entra'?'pluginAd.account.sourceEntra':'pluginAd.account.sourcePassword')}</span>
    <IconBtn icon={LogOut} label={t('pluginAd.account.signOutLabel',{domain:session.directory.name,account:session.account})} loading={leaving.includes(session.id)} onClick={()=>void signOut(session)}/>
   </div>
  </li>)}</EntranceList>;
 return <Card className="sdx-ad-card" title={t('pluginAd.account.title')} icon={KeyRound} iconTone="accent" description={t('pluginAd.account.description')}>{body}</Card>;
}
