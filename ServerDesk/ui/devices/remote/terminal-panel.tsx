'use client';
import {translate,type MessageKey} from '@/lib/i18n/translate';
import type {Locale} from '@/lib/i18n/locale';
import {useState,useEffect,useRef,useCallback} from 'react';
import {AlertTriangle,Check,Play,Square,Clipboard,Copy,TerminalSquare,WifiOff} from 'lucide-react';
import {toast} from 'sonner';
import {api,credentialFetch,message,stamp,permitted,online,v3,ApiError,type V3Props} from '@/ui/base/api';
import {Btn,Menu,Notice,SectionHead,Skeleton,StatusPill,Unavailable,type MenuEntry,type StatusKind} from '@/ui/kit/kit';
import {DataTable,type DataColumn} from '@/ui/kit/data-table';
import {ConfirmDialog} from '@/ui/kit/confirm-dialog';
import {unavailableReason} from '@/ui/devices/device/device-unavailable';
import {MfaStepUp} from '@/ui/session/mfa-step-up';
import {errorCatalog,opensMfaPrompt} from '@/lib/errors/codes';
import {proofRetry,type StepUpProof} from '@/ui/session/step-up-retry';
import {appendTerminalInput,type QueuedTerminalInput} from '@/ui/devices/remote/terminal-input';
import {terminalTheme} from '@/ui/devices/remote/terminal-theme';
import {createTerminalSessionDiscovery,createTerminalSessionRequest} from '@/ui/devices/remote/terminal-session-discovery';
import '@xterm/xterm/css/xterm.css';
import '@/ui/devices/remote/terminal.css';

import {useLocale,useT,useStableT} from '@/ui/base/locale';
import {storedMessageText} from '@/lib/server-messages';
import {accountName,viewerNameParts} from '@/lib/account-display';
import {EMPTY_VALUE} from '@/lib/i18n/format';
type Session={id:string;state:string;createdAt?:number;expiresAt?:number;ack?:number;inputAck?:number;inputSeq?:number;outputSeq?:number;cols?:number;rows?:number;owner?:string|null;lastActivity?:number;presenceExpiresAt?:number;isOwn?:boolean;canClose?:boolean};
type Frame={seq:number;data:string};
type TerminalReply={id?:string;session?:Session;sessions?:Session[];activeSessions?:Session[];frames?:Frame[];ack?:number;inputSeq?:number;state?:string;cursor?:number;expiresAt?:number;error?:string;truncated?:boolean;resumed?:boolean;presenceGraceMs?:number;presenceExpiresAt?:number;multiuser?:boolean;maxSessions?:number};
type QueuedInput=QueuedTerminalInput;
type PendingAction={kind:'open'}|{kind:'resume';session:Session}|{kind:'close';session:Session};
const running=(state:string)=>['opening','open','active','running'].includes(state);
const terminalHostStyle={height:'100%',width:'100%',minHeight:0,minWidth:0,padding:0,overflow:'hidden',boxSizing:'border-box'} as const;
const stateKeys:Record<string,MessageKey>={opening:'terminal.state.opening',open:'management.active',active:'management.active',running:'management.active',closing:'terminal.state.closing',closed:'terminal.state.closed',expired:'jobs.state.expired',error:'hardware.error',failed:'hardware.error',cancelled:'terminal.state.closed'};
const stateLabel=(state:string,locale:Locale)=>Object.hasOwn(stateKeys,state)?translate(locale,stateKeys[state]):state;
const requiresMfa=(e:unknown)=>e instanceof ApiError&&e.status===403&&opensMfaPrompt(e.code);

// The terminal starts nothing on its own: opening the subarea only reads the session list (GET). A
// session opens or resumes only after Connect, so the step-up dialog appears only after that click.
export default function TerminalPanel({server,viewer,demo}:V3Props){
  const t=useT(),stableT=useStableT(),[locale]=useLocale();
  const[session,setSession]=useState<Session|null>(null),[sessions,setSessions]=useState<Session[]>([]),[activeSessions,setActiveSessions]=useState<Session[]>([]);
  const[sessionsLoaded,setSessionsLoaded]=useState(false),[sessionsError,setSessionsError]=useState('');
  const[error,setError]=useState(''),[busy,setBusy]=useState(false),[connected,setConnected]=useState(false),[mfa,setMfa]=useState(false),[warning,setWarning]=useState(''),[confirmation,setConfirmation]=useState<Session|null>(null),[multiuser,setMultiuser]=useState<boolean|null>(null),[maxSessions,setMaxSessions]=useState(4);
  const host=useRef<HTMLDivElement>(null),term=useRef<import('@xterm/xterm').Terminal|null>(null),fit=useRef<import('@xterm/addon-fit').FitAddon|null>(null);
  const sessionRef=useRef<Session|null>(null),nextSeq=useRef(1),cursor=useRef(0),queue=useRef<QueuedInput[]>([]),sending=useRef(false),active=useRef(false),generation=useRef(0);
  const wakeOutput=useRef<(()=>void)|null>(null),recentInput=useRef(0);
  const discovering=useRef<Promise<boolean>|null>(null);
  const[copied,setCopied]=useState(false),copiedTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const discoveryAbort=useRef<(()=>void)|null>(null);
  const retry=useRef<ReturnType<typeof setTimeout>|null>(null),resizeTimer=useRef<ReturnType<typeof setTimeout>|null>(null),lastResize=useRef<{id:string;cols:number;rows:number}|null>(null),pendingAction=useRef<PendingAction>({kind:'open'}),mfaNeeded=useRef(false);
  const reason=unavailableReason({demo,revoked:!!server.revoked,permitted:permitted(server,viewer,'terminal'),reported:!!server.snapshot,supported:v3(server),management:server.management===1});
  const enabled=reason===null;
  const capableMultiuser=multiuser??server.snapshot?.agentCapabilities.includes('terminal-multi')===true;

  const stopInput=useCallback(()=>{
    queue.current=[];lastResize.current=null;
    if(retry.current)clearTimeout(retry.current);retry.current=null;
    if(resizeTimer.current)clearTimeout(resizeTimer.current);resizeTimer.current=null;
  },[]);
  // A keepalive request keeps the existing identity cookies and in-memory MFA proof.
  // It remains best effort: the server expires sessions whose page presence stops.
  const releaseSession=useCallback((id:string)=>{
    void credentialFetch('/api/terminal',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'close',serverId:server.id,id}),keepalive:true,cache:'no-store'}).catch(()=>{});
  },[server.id]);
  const discover=useCallback(()=>{
    if(!enabled||!active.current)return Promise.resolve(false);
    if(discovering.current)return discovering.current;
    const currentGeneration=generation.current;
    const bounded=createTerminalSessionRequest(signal=>api<TerminalReply>('/api/terminal?serverId='+encodeURIComponent(server.id),undefined,signal));
    discoveryAbort.current=bounded.abort;
    const request=(async()=>{
      try{
        const p=await bounded.promise;
        if(!active.current||generation.current!==currentGeneration)return false;
        setSessions(p.sessions??[]);setActiveSessions(p.activeSessions??[]);setSessionsLoaded(true);setSessionsError('');
        if(typeof p.multiuser==='boolean')setMultiuser(p.multiuser);
        if(typeof p.maxSessions==='number')setMaxSessions(p.maxSessions);
        return true;
      }catch(e){if(active.current&&generation.current===currentGeneration&&discoveryAbort.current===bounded.abort)setSessionsError(message(e));return false;}
    })();
    discovering.current=request;void request.finally(()=>{if(discovering.current===request)discovering.current=null;if(discoveryAbort.current===bounded.abort)discoveryAbort.current=null;});return request;
  },[server.id,enabled]);

  const askMfa=useCallback((action:PendingAction)=>{
    stopInput();mfaNeeded.current=true;pendingAction.current=action;
    // A new SYSTEM shell needs a fresh step-up proof (lib/step-up.ts); resuming or closing your own shell only the login session.
    setWarning(action.kind==='open'?stableT('terminal.confirmIdentity'):stableT('terminal.confirmToContinue'));setMfa(true);
  },[stopInput,stableT]);
  const send=useCallback(async()=>{
    if(sending.current||!sessionRef.current||!running(sessionRef.current.state)||!queue.current.length||!active.current||mfaNeeded.current)return;
    sending.current=true;
    const item=queue.current[0],current=sessionRef.current,currentGeneration=generation.current;
    item.sent=true;
    try{
      const p=await api<TerminalReply>('/api/terminal',{action:item.action,seq:item.seq,...(item.action==='input'?{data:item.data}:{cols:item.cols,rows:item.rows}),serverId:server.id,id:current.id});
      if(!active.current||generation.current!==currentGeneration||sessionRef.current?.id!==current.id)return;
      if(queue.current[0]===item)queue.current.shift();
      setConnected(true);
      if(typeof p.ack==='number')nextSeq.current=Math.max(nextSeq.current,p.ack+1);
      wakeOutput.current?.();
    }catch(e){
      if(!active.current||generation.current!==currentGeneration||sessionRef.current?.id!==current.id)return;
      setConnected(false);
      // One message per event: the conflict text comes from the catalog (also
      // correct against an older server) and goes to the warning line only.
      if(e instanceof ApiError&&e.code==='TERMINAL_SEQUENCE_CONFLICT'||requiresMfa(e))setError('');else setError(message(e));
      if(requiresMfa(e))askMfa({kind:'resume',session:current});
      else if(e instanceof ApiError&&e.code==='TERMINAL_SEQUENCE_CONFLICT'){
        stopInput();setWarning(stableT(errorCatalog.TERMINAL_SEQUENCE_CONFLICT.key));
        try{
          const latest=await api<TerminalReply>('/api/terminal?serverId='+encodeURIComponent(server.id)+'&id='+encodeURIComponent(current.id));
          if(active.current&&generation.current===currentGeneration&&sessionRef.current?.id===current.id)nextSeq.current=(latest.inputSeq??latest.ack??0)+1;
        }catch{}
      }else if(e instanceof ApiError&&[403,404,410].includes(e.status)){
        stopInput();sessionRef.current=null;setSession(null);setWarning(stableT('terminal.accessEnded'));void discover();
      }else if(active.current)retry.current=setTimeout(()=>{retry.current=null;void send();},1000);
    }finally{
      sending.current=false;
      if(queue.current.length&&active.current&&!retry.current&&!mfaNeeded.current)queueMicrotask(()=>void send());
    }
  },[server.id,askMfa,stopInput,discover,stableT]);
  const scheduleResize=useCallback(()=>{
    if(resizeTimer.current)clearTimeout(resizeTimer.current);
    resizeTimer.current=setTimeout(()=>{
      resizeTimer.current=null;
      const current=sessionRef.current,xterm=term.current;
      if(!active.current||!current||!xterm||!running(current.state)||mfaNeeded.current)return;
      const previous=lastResize.current;
      if(previous?.id===current.id&&previous.cols===xterm.cols&&previous.rows===xterm.rows)return;
      if(queue.current.length>=128)return;
      queue.current.push({action:'resize',seq:nextSeq.current++,cols:xterm.cols,rows:xterm.rows});lastResize.current={id:current.id,cols:xterm.cols,rows:xterm.rows};void send();
    },200);
  },[send]);
  const enqueue=useCallback((data:string)=>{
    if(!active.current||mfaNeeded.current||!sessionRef.current||!running(sessionRef.current.state))return;
    const size=queue.current.reduce((n,p)=>n+(p.data?.length??0),0);
    if(queue.current.length>=120||size+data.length>65536){setWarning(stableT('terminal.bufferFull'));return;}
    // Merge untouched input frames without changing any attempted payload.
    recentInput.current=Date.now();nextSeq.current=appendTerminalInput(queue.current,data,nextSeq.current);
    wakeOutput.current?.();
    if(retry.current){clearTimeout(retry.current);retry.current=null;}void send();
  },[send,stableT]);

  useEffect(()=>{
    active.current=true;generation.current++;
    let disposed=false,observer:ResizeObserver|undefined,fitFrame:number|null=null,measured:{width:number;height:number}|null=null,cleanup:(()=>void)|undefined;
    const fitViewport=()=>{
      if(fitFrame!==null)return;
      fitFrame=requestAnimationFrame(()=>{
        fitFrame=null;const element=host.current;if(disposed||!element||!term.current)return;
        const width=element.clientWidth,height=element.clientHeight;if(width<=0||height<=0||(measured?.width===width&&measured.height===height))return;
        measured={width,height};fit.current?.fit();
      });
    };
    const leave=()=>{
      if(!active.current)return;
      active.current=false;generation.current++;stopInput();
      discoveryAbort.current?.();discoveryAbort.current=null;discovering.current=null;
      const current=sessionRef.current;sessionRef.current=null;
      if(current&&running(current.state))releaseSession(current.id);
    };
    const returnToPage=(event:PageTransitionEvent)=>{
      if(!event.persisted||disposed)return;
      active.current=true;generation.current++;mfaNeeded.current=false;setMfa(false);setSession(null);setConnected(false);setBusy(false);
      setWarning(stableT('terminal.viewLeft'));discovery.request();fitViewport();
    };
    const setup=async()=>{
      if(!enabled||!host.current)return;
      try{
        const[{Terminal},{FitAddon}]=await Promise.all([import('@xterm/xterm'),import('@xterm/addon-fit')]);
        if(disposed||!host.current)return;
        const xterm=new Terminal({cursorBlink:true,fontSize:13,fontFamily:'Consolas, ui-monospace, monospace',scrollback:5000,convertEol:false,theme:terminalTheme(getComputedStyle(host.current))}),f=new FitAddon();
        term.current=xterm;fit.current=f;xterm.loadAddon(f);xterm.open(host.current);
        const data=xterm.onData(enqueue),resize=xterm.onResize(scheduleResize);cleanup=()=>{data.dispose();resize.dispose();};fitViewport();
        xterm.writeln('\x1b[36mNodiverna · Windows PowerShell · SYSTEM\x1b[0m');xterm.writeln(stableT('terminal.connectHint'));
        observer=new ResizeObserver(fitViewport);observer.observe(host.current);
      }catch(e){if(!disposed)setError(message(e));}
    };
    setSessionsLoaded(false);setSessionsError('');setSessions([]);setActiveSessions([]);
    const discovery=createTerminalSessionDiscovery({refresh:discover,canRefresh:()=>enabled&&active.current&&document.visibilityState!=='hidden'&&navigator.onLine});
    const refreshSessions=()=>discovery.request();
    window.addEventListener('pagehide',leave);window.addEventListener('pageshow',returnToPage);
    window.addEventListener('focus',refreshSessions);window.addEventListener('online',refreshSessions);document.addEventListener('visibilitychange',refreshSessions);
    void setup();discovery.start();
    return()=>{
      leave();disposed=true;observer?.disconnect();window.removeEventListener('pagehide',leave);window.removeEventListener('pageshow',returnToPage);
      discovery.stop();window.removeEventListener('focus',refreshSessions);window.removeEventListener('online',refreshSessions);document.removeEventListener('visibilitychange',refreshSessions);
      if(fitFrame!==null)cancelAnimationFrame(fitFrame);
      cleanup?.();term.current?.dispose();term.current=null;fit.current=null;
    };
  },[enabled,server.id,enqueue,scheduleResize,stopInput,releaseSession,discover,stableT]);

  useEffect(()=>{
    if(!session||!enabled||!running(session.state))return;
    let cancelled=false,timer:ReturnType<typeof setTimeout>|undefined,inFlight=false,pollAgain=false;
    const abort=new AbortController(),currentGeneration=generation.current,live=server.snapshot?.agentCapabilities.includes('terminal-live')===true;
    const stillCurrent=()=>!cancelled&&active.current&&generation.current===currentGeneration&&sessionRef.current?.id===session.id;
    const wake=()=>{if(!stillCurrent())return;if(timer){clearTimeout(timer);timer=undefined;}if(inFlight){pollAgain=true;return;}void poll();};
    const poll=async()=>{
      if(!stillCurrent()||inFlight)return;
      if(!term.current||mfaNeeded.current){timer=setTimeout(()=>void poll(),1000);return;}
      inFlight=true;let frameCount=0,failed=false;
      try{
        const p=await api<TerminalReply>(`/api/terminal?serverId=${encodeURIComponent(server.id)}&id=${encodeURIComponent(session.id)}&after=${cursor.current}`,undefined,abort.signal);
        if(!stillCurrent())return;
        const frames=(p.frames??[]).sort((a,b)=>a.seq-b.seq);frameCount=frames.length;
        if(p.truncated){setWarning(t('terminal.bufferLimited'));term.current?.writeln('\r\n\x1b[33m['+t('terminal.olderMissing')+']\x1b[0m');}
        for(const frame of frames)if(frame.seq>cursor.current){term.current?.write(frame.data);cursor.current=frame.seq;}
        if(p.cursor!==undefined)cursor.current=Math.max(cursor.current,p.cursor);
        const state=p.session?.state??p.state??session.state,current={...sessionRef.current!,...p.session,state,expiresAt:p.expiresAt??sessionRef.current?.expiresAt};
        sessionRef.current=current;setSession(current);if(p.error)setWarning(storedMessageText(p.error,t));setConnected(true);setError('');
        if(!running(state)){stopInput();setConnected(false);setWarning(t('terminal.ended'));void discover();return;}
      }catch(e){
        if(!stillCurrent())return;
        failed=true;setConnected(false);setError(requiresMfa(e)?'':message(e));
        if(requiresMfa(e))askMfa({kind:'resume',session:sessionRef.current!});
        else if(e instanceof ApiError&&[403,404,410].includes(e.status)){
          stopInput();sessionRef.current=null;setSession(null);setWarning(t('terminal.accessEndedShort'));void discover();return;
        }
      }finally{
        inFlight=false;
        if(stillCurrent()&&running(sessionRef.current?.state??'')){
          const typing=Date.now()-recentInput.current<2000;
          const interval=failed?1000:!live?500:document.visibilityState==='hidden'?1000:typing||frameCount>0?100:350;
          timer=setTimeout(()=>void poll(),pollAgain&&!failed?0:interval);pollAgain=false;
        }
      }
    };
    wakeOutput.current=wake;void poll();
    // Presence is independent of output polling and MFA step-up. No queued input
    // is replayed while authentication or a transient connection is pending.
    const presence=setInterval(()=>{
      if(!stillCurrent()||!running(sessionRef.current?.state??''))return;
      void api<TerminalReply>('/api/terminal',{action:'heartbeat',serverId:server.id,id:session.id},abort.signal).then(p=>{
        if(!stillCurrent())return;
        if(p.state&&!running(p.state)){stopInput();const current={...sessionRef.current!,state:p.state};sessionRef.current=current;setSession(current);setConnected(false);void discover();}
      }).catch(()=>{});
    },20000);
    return()=>{cancelled=true;abort.abort();if(timer)clearTimeout(timer);clearInterval(presence);if(wakeOutput.current===wake)wakeOutput.current=null;};
  // eslint-disable-next-line react-hooks/exhaustive-deps -- The output loop restarts only for another session ID or status; it reads the session through sessionRef.
  },[session?.id,session?.state,enabled,server.id,server.snapshot?.agentCapabilities,stopInput,askMfa,discover]);

  const attach=useCallback((s:Session,resumed:boolean)=>{
    stopInput();cursor.current=0;nextSeq.current=(s.inputSeq??s.ack??s.inputAck??0)+1;
    lastResize.current=s.cols&&s.rows?{id:s.id,cols:s.cols,rows:s.rows}:null;recentInput.current=Date.now();term.current?.clear();sessionRef.current=s;setSession(s);setConnected(false);
    setWarning(resumed?stableT('terminal.resumed'):'');scheduleResize();term.current?.focus();
  },[stopInput,scheduleResize,stableT]);
  // managementToken is only set by the retry after the step-up dialog.
  const open=async(managementToken?:string)=>{
    if(!active.current||busy)return;
    pendingAction.current={kind:'open'};setBusy(true);setError('');const currentGeneration=generation.current;
    try{
      const cols=term.current?.cols??100,rows=term.current?.rows??28;
      const p=await api<TerminalReply>('/api/terminal',{action:'open',serverId:server.id,cols,rows,confirm:true,...(managementToken?{managementToken}:{})});
      const s=p.session??(p.id?{id:p.id,state:p.state??'opening',ack:p.ack,inputSeq:p.inputSeq,expiresAt:p.expiresAt,cols,rows,isOwn:true}:null);
      if(!s)throw new Error(t('terminal.noSessionId'));
      if(!active.current||generation.current!==currentGeneration){if(!p.resumed)releaseSession(s.id);return;}
      if(typeof p.multiuser==='boolean')setMultiuser(p.multiuser);
      if(typeof p.maxSessions==='number')setMaxSessions(p.maxSessions);
      mfaNeeded.current=false;attach(s,p.resumed===true);await discover();
    }catch(e){
      if(!active.current||generation.current!==currentGeneration)return;
      if(requiresMfa(e))askMfa({kind:'open'});else toast.error(message(e));
    }finally{if(active.current&&generation.current===currentGeneration)setBusy(false);}
  };
  const resume=async(s:Session)=>{
    if(!active.current||busy||s.isOwn===false)return;
    setBusy(true);setError('');stopInput();const currentGeneration=generation.current;
    try{
      const p=await api<TerminalReply>('/api/terminal?serverId='+encodeURIComponent(server.id)+'&id='+encodeURIComponent(s.id));
      if(!active.current||generation.current!==currentGeneration)return;
      const current={...s,...p.session,state:p.session?.state??p.state??s.state,inputSeq:p.inputSeq??p.session?.inputSeq??s.inputSeq,ack:p.ack??p.session?.ack??s.ack,isOwn:true};
      if(!running(current.state)){setWarning(t('terminal.alreadyEnded'));await discover();return;}
      mfaNeeded.current=false;attach(current,true);
    }catch(e){if(active.current&&generation.current===currentGeneration){if(requiresMfa(e))askMfa({kind:'resume',session:s});else toast.error(message(e));}}
    finally{if(active.current&&generation.current===currentGeneration)setBusy(false);}
  };
  const close=async(s:Session)=>{
    if(!active.current||busy)return;
    const currentGeneration=generation.current,isCurrent=sessionRef.current?.id===s.id;
    if(isCurrent){stopInput();sessionRef.current=null;setSession(null);setConnected(false);}
    pendingAction.current={kind:'close',session:s};setBusy(true);setError('');
    try{
      await api('/api/terminal',{action:'close',serverId:server.id,id:s.id,...(s.isOwn===false?{confirm:true}:{})});
      if(!active.current||generation.current!==currentGeneration)return;
      setConfirmation(null);setWarning(isCurrent?t('terminal.sessionEnded'):'');await discover();
    }catch(e){if(active.current&&generation.current===currentGeneration){if(requiresMfa(e))askMfa({kind:'close',session:s});else toast.error(message(e));}}
    finally{if(active.current&&generation.current===currentGeneration)setBusy(false);}
  };
  // Connect: resume your own running shell from the last session list, otherwise open a new one.
  const connect=()=>{
    if(!active.current||busy||!online(server))return;
    const own=sessions.find(item=>running(item.state)&&item.isOwn!==false);
    if(own)void resume(own);else void open();
  };
  // Try again on the session list: a stuck request is dropped and the list is read once more.
  const reloadSessions=()=>{if(discovering.current){discoveryAbort.current?.();discovering.current=null;}setSessionsError('');void discover();};
  const copySelection=()=>{
    const selection=term.current?.getSelection()??'';
    if(!selection){toast.info(t('terminal.selectFirst'));return;}
    void navigator.clipboard.writeText(selection).then(()=>{
      if(!active.current)return;
      if(copiedTimer.current)clearTimeout(copiedTimer.current);
      setCopied(true);copiedTimer.current=setTimeout(()=>{copiedTimer.current=null;setCopied(false);},1200);
    },e=>toast.error(message(e)));
  };
  // Only open resends with the proof's token; resume and close never send one.
  const onVerified=(proof?:StepUpProof)=>{
    mfaNeeded.current=false;const action=pendingAction.current;
    if(action.kind==='open')void proofRetry(token=>open(token),text=>toast.error(text))(proof);else if(action.kind==='resume')void resume(action.session);else void close(action.session);
  };

  if(reason)return <Unavailable reason={reason}>{reason==='right'?t('terminal.blocked.right'):undefined}</Unavailable>;
  const visibleActive=activeSessions.length?activeSessions:sessions.filter(s=>running(s.state)||s.state==='closing').map(s=>({...s,isOwn:true,canClose:true,owner:accountName(viewerNameParts(viewer))||null}));
  const attached=!!session&&running(session.state);
  // Connect resumes your own shell, so only a new shell counts against the limit of the device.
  const ownRunning=sessions.some(item=>running(item.state)&&item.isOwn!==false);
  const full=sessionsLoaded&&!ownRunning&&visibleActive.filter(item=>running(item.state)).length>=(capableMultiuser?maxSessions:1);
  const connectBlocked=!online(server)?t('management.blocked.offline'):full?t('terminal.limitReached'):undefined;
  const inputBlocked=!attached||mfaNeeded.current?t('terminal.connectFirst'):undefined;
  const status:{kind:StatusKind;label:string}=attached?connected?{kind:'online',label:t('network.status.up')}:{kind:'neutral',label:t('terminal.connecting')}:{kind:'neutral',label:t('terminal.state.notConnected')};
  // The sessions roster (nodiverna-ui §4 Table): one row Menu per session with Resume and End session (or End as administrator).
  const accountOf=(s:Session)=>s.owner??(s.isOwn?t('terminal.yours'):t('rdp.panel.other'));
  const sessionEntries=(s:Session):MenuEntry[]=>{
    const blocked=busy?t('kit.busy'):undefined;
    return [
      ...(s.isOwn&&running(s.state)&&session?.id!==s.id?[{id:'resume',label:t('terminal.resume'),icon:Play,blocked,onSelect:()=>void resume(s)} as MenuEntry]:[]),
      ...(s.canClose&&running(s.state)?[{id:'end',label:s.isOwn?t('terminal.end'):t('terminal.endAsAdminButton'),icon:Square,danger:true,blocked,onSelect:()=>{if(s.isOwn)void close(s);else setConfirmation(s);}} as MenuEntry]:[]),
    ];
  };
  const sessionColumns:DataColumn<Session>[]=[
    {id:'account',label:t('rbac.account'),primary:true,cell:s=><span className="sd-terminal-account"><strong>{accountOf(s)}</strong>{s.isOwn&&<span className="sd-terminal-you">{t('terminal.you')}</span>}</span>},
    {id:'opened',label:t('terminal.col.opened'),cell:s=>stamp(s.createdAt,locale)},
    {id:'active',label:t('terminal.col.lastActive'),hideBelow:900,cell:s=>s.lastActivity?stamp(s.lastActivity,locale):EMPTY_VALUE},
    {id:'state',label:t('management.status'),cell:s=><span className="sd-terminal-account">{stateLabel(s.state,locale)}{session?.id===s.id&&<span className="sdx-tag">{t('terminal.inThisView')}</span>}</span>},
    {id:'actions',label:t('fleet.col.actions'),hideLabel:true,className:'sdx-col-actions',align:'end',cell:s=><Menu label={t('tree.actionsForName',{name:accountOf(s)})} entries={sessionEntries(s)}/>},
  ];
  // nodiverna-ui §4 "Device section": the hidden title, the shell line, the status pill and the one primary (Connect).
  return <>
    <section className="v3-terminal-panel" aria-labelledby="sd-terminal-title">
      <SectionHead hideTitle id="sd-terminal-title" title={t('terminal.heading')} description={t('terminal.title',{name:server.name})}
        actions={<><span role="status" className="sd-terminal-state"><StatusPill kind={status.kind}>{status.label}</StatusPill></span>{attached&&<Btn icon={Square} loading={busy} onClick={()=>void close({...session,isOwn:true})}>{t('terminal.end')}</Btn>}</>}
        primary={!attached&&<Btn variant="primary" icon={Play} loading={busy} blocked={connectBlocked} onClick={connect}>{t('terminal.connect')}</Btn>}/>
      {warning&&<Notice tone="warning" icon={WifiOff}>{warning}</Notice>}
      {error&&<Notice tone="danger" icon={AlertTriangle}>{error}</Notice>}
      <div className="sd-terminal-frame">
        <div className="v3-terminal-viewport"><div className="v3-terminal" style={terminalHostStyle} ref={host}/></div>
        <div className="sd-terminal-toolbar" role="group" aria-label={t('terminal.actions')}>
          <Btn size="sm" blocked={inputBlocked} onClick={()=>enqueue('\x03')}>Ctrl+C</Btn>
          <Btn size="sm" icon={copied?Check:Copy} onClick={copySelection}>{t('terminal.copySelection')}</Btn>
          <Btn size="sm" icon={Clipboard} blocked={inputBlocked} onClick={()=>void navigator.clipboard.readText().then(text=>enqueue(text)).catch(e=>{if(active.current)toast.error(message(e));})}>{t('terminal.paste')}</Btn>
        </div>
      </div>
      <div className="sd-terminal-sessions" aria-busy={!sessionsLoaded}>
        <SectionHead level={3} title={t('terminal.sessionsHere')}/>
        {sessionsError&&<Notice tone="danger" icon={AlertTriangle} action={<Btn size="sm" onClick={reloadSessions}>{t('common.retry')}</Btn>}><p>{sessionsError}</p>{sessionsLoaded&&<p>{t('console.staleData')}</p>}</Notice>}
        {!sessionsLoaded?!sessionsError&&<Skeleton variant="table" rows={2} label={t('terminal.loading')} after={15000} action={<Btn variant="ghost" size="sm" onClick={reloadSessions}>{t('common.retry')}</Btn>}/>
          :<DataTable label={t('terminal.sessionsHere')} cards entranceId="device-terminal-sessions" columns={sessionColumns} rows={visibleActive} rowKey={s=>s.id}
            foot={t('terminal.activeCount',{length:visibleActive.length,value:capableMultiuser?maxSessions:1})} empty={{icon:TerminalSquare,title:t('terminal.none')}}/>}
        {!capableMultiuser&&<p className="sd-terminal-note">{t('terminal.singleShell')}</p>}
      </div>
    </section>
    <ConfirmDialog open={!!confirmation&&!mfa} onOpenChange={next=>{if(!next)setConfirmation(null);}} title={t('terminal.endOtherTitle')} body={confirmation?t(confirmation.owner?'terminal.endOtherDescription':'terminal.endOtherDescriptionAnonymous',{owner:confirmation.owner??'',name:server.name}):undefined} confirmLabel={t('terminal.endAsAdminButton')} tone="danger" busy={busy} onConfirm={()=>{if(confirmation)void close(confirmation);}}/>
    <MfaStepUp open={mfa} onClose={()=>setMfa(false)} onVerified={onVerified}/>
  </>;
}
