'use client';
import {useEffect,useRef,useState,type FormEvent} from 'react';
import {Monitor,Maximize,Square,Play,LoaderCircle} from 'lucide-react';
import type {UserInteraction} from '@devolutions/iron-remote-desktop';
import {createRdpKey} from '@/ui/devices/remote/rdp-crypto';
import {createRdpWebSocket} from '@/ui/devices/remote/rdp-transport';
import {prepareRdpWebRtc,type RdpRtcStats} from '@/ui/devices/remote/rdp-webrtc';
import {createRdpChildBridge,RDP_ACTIVITY,RDP_BRIDGE_PROTOCOL,rdpGuid,rdpAvailable,rdpLogonAccount,type RdpMetadata} from '@/ui/devices/remote/rdp-bridge';
import '@/ui/devices/remote/rdp.css';

import {useLocale,useT,useStableT} from '@/ui/base/locale';
import {serverMessageText,storedMessageText} from '@/lib/server-messages';
import {translate,type MessageKey} from '@/lib/i18n/translate';
import {defaultLocale,documentLocale,type Locale} from '@/lib/i18n/locale';
type DesktopElement=HTMLElement&{module:unknown;scale:string;flexcenter:string;verbose:string};
const stateText:Record<string,MessageKey>={loading:'rdp.state.loading',ready:'rdp.state.ready',connecting:'rdp.state.connecting',connected:'network.status.up',disconnected:'network.status.disconnected',error:'rdp.state.error'};
const needsNativeDiagnosis=(error:unknown)=>!!error&&typeof error==='object'&&'code' in error&&['RDP_SIGNAL_TIMEOUT','RDP_BRIDGE_TIMEOUT','RDP_AGENT_ANSWER_TIMEOUT','RDP_NEGOTIATION_TIMEOUT','RDP_ICE_FAILED'].includes(String(error.code));
export function connectionError(error:unknown,transportError='',locale:Locale=defaultLocale){
 if(transportError)return transportError;
 if(error&&typeof error==='object'&&'kind' in error&&typeof error.kind==='function'){
  try{const kind=error.kind();return kind===1?translate(locale,'rdp.client.signInFailed'):kind===2?translate(locale,'rdp.client.signInRejected'):kind===3?translate(locale,'rdp.client.notAllowed'):kind===6?translate(locale,'rdp.client.nla'):translate(locale,'rdp.client.failedDetail');}catch{}
 }
 return error instanceof Error?error.message:translate(locale,'rdp.transport.failed');
}
export default function RemoteDesktopClient(){
 const t=useT(),stableT=useStableT(),[locale]=useLocale();
 const[state,setState]=useState<keyof typeof stateText>('loading'),[error,setError]=useState(''),[portalUpdate,setPortalUpdate]=useState(false),[username,setUsername]=useState(''),[password,setPassword]=useState(''),[domain,setDomain]=useState(''),[local,setLocal]=useState(false),[scale,setScale]=useState<'fit'|'real'>('fit'),[quality,setQuality]=useState<'performance'|'detail'>('performance'),[transportMode,setTransportMode]=useState<'webrtc'|'mailbox'>('webrtc'),[stats,setStats]=useState<RdpRtcStats|null>(null),[serverId,setServerId]=useState(''),[recovering,setRecovering]=useState(false);
 const host=useRef<HTMLDivElement>(null),api=useRef<UserInteraction|null>(null),element=useRef<DesktopElement|null>(null),bridge=useRef<ReturnType<typeof createRdpChildBridge>|null>(null),session=useRef<string|null>(null),socket=useRef<{close():void}|null>(null),rtc=useRef<Awaited<ReturnType<typeof prepareRdpWebRtc>>|null>(null),connectAbort=useRef<AbortController|null>(null),diagnosticAbort=useRef<AbortController|null>(null),originalSocket=useRef<typeof WebSocket|null>(null),mounted=useRef(false),generation=useRef(0),rdpEngine=useRef<typeof import('@devolutions/iron-remote-desktop-rdp')|null>(null),connecting=useRef(false);
 const disconnect=()=>{
  generation.current++;diagnosticAbort.current?.abort();diagnosticAbort.current=null;connectAbort.current?.abort();connectAbort.current=null;api.current?.shutdown();socket.current?.close();socket.current=null;rtc.current?.close();rtc.current=null;const id=session.current;session.current=null;setStats(null);
  if(id)void bridge.current?.request({action:'close',id}).catch(()=>{});
  if(originalSocket.current)window.WebSocket=originalSocket.current;setPassword('');if(mounted.current)setState('disconnected');
 };
 const diagnoseFailure=async(id:string,current:number)=>{
  const transport=bridge.current;if(!transport)return;const controller=new AbortController();diagnosticAbort.current?.abort();diagnosticAbort.current=controller;
  const valid=()=>mounted.current&&generation.current===current&&bridge.current===transport&&!controller.signal.aborted;
  const deadline=setTimeout(()=>controller.abort(),3000);
  try{
   for(let attempt=0;attempt<3&&valid();attempt++){
    if(attempt)await new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);controller.signal.removeEventListener('abort',done);resolve();},timer=setTimeout(done,attempt*500);controller.signal.addEventListener('abort',done,{once:true});});
    if(!valid())return;
    const metadata=await transport.request({action:'metadata',serverId},controller.signal) as RdpMetadata;if(!valid())return;
    const ended=metadata.sessions?.find(s=>s.id===id&&s.isOwn===true&&s.transport==='webrtc'&&['closed','error'].includes(s.state));
    if(typeof ended?.error==='string'&&ended.error.trim()&&ended.error.length<=500){
     const detail=storedMessageText(ended.error.trim(),t);setError(t(/\bice=failed\b/.test(detail)?'rdp.client.noPathDiagnosis':'rdp.client.diagnosis',{detail}));return;
    }
   }
  }catch{}finally{clearTimeout(deadline);if(diagnosticAbort.current===controller)diagnosticAbort.current=null;}
 };
 useEffect(()=>{
  mounted.current=true;let cancelled=false;const id=new URL(window.location.href).searchParams.get('serverId');if(!rdpGuid(id)){setError(stableT('rdp.client.invalidDevice'));setState('error');return()=>{mounted.current=false;};}setServerId(id);
  const transport=createRdpChildBridge(id);bridge.current=transport;originalSocket.current=window.WebSocket;
  const onPageHide=()=>{const current=session.current;if(current){window.parent.postMessage({type:'serverdesk:rdp:pagehide',serverId:id,id:current},window.location.origin);void fetch('/api/rdp',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'close',id:current}),keepalive:true,cache:'no-store',redirect:'manual'}).catch(()=>{});}disconnect();};
  let lastActivity=0;const interacted=(event:Event)=>{if(!event.isTrusted||document.visibilityState==='hidden')return;const now=performance.now();if(now-lastActivity<400)return;lastActivity=now;window.parent.postMessage({type:RDP_ACTIVITY,serverId:id},window.location.origin);};
  const events=['keydown','pointerdown','pointermove','wheel','touchstart'];for(const event of events)window.addEventListener(event,interacted,{capture:true,passive:true});window.addEventListener('pagehide',onPageHide);
  void (async()=>{
   try{
    const [rdp]=await Promise.all([import('@devolutions/iron-remote-desktop-rdp'),import('@devolutions/iron-remote-desktop')]);if(cancelled)return;
    await rdp.init('error');if(cancelled)return;rdpEngine.current=rdp;
    const desktop=document.createElement('iron-remote-desktop') as DesktopElement;desktop.module=rdp.Backend;desktop.scale='fit';desktop.flexcenter='true';desktop.verbose='false';element.current=desktop;
    desktop.addEventListener('ready',event=>{if(cancelled)return;api.current=(event as CustomEvent<{irgUserInteraction:UserInteraction}>).detail.irgUserInteraction;api.current.setEnableClipboard(false);api.current.setEnableAutoClipboard(false);api.current.onWarningCallback(()=>{});setState('ready');});
    host.current?.replaceChildren(desktop);
   }catch(e){if(!cancelled){setError(connectionError(e,'',documentLocale()));setState('error');}}
  })();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- generation is a generation counter, not DOM refs; the cleanup increments it so that late responses are dropped.
  return()=>{cancelled=true;mounted.current=false;generation.current++;diagnosticAbort.current?.abort();diagnosticAbort.current=null;connectAbort.current?.abort();connectAbort.current=null;window.removeEventListener('pagehide',onPageHide);for(const event of events)window.removeEventListener(event,interacted,true);api.current?.shutdown();socket.current?.close();socket.current=null;rtc.current?.close();rtc.current=null;const current=session.current;session.current=null;if(current)void transport.request({action:'close',id:current}).catch(()=>{});transport.dispose();if(originalSocket.current)window.WebSocket=originalSocket.current;element.current?.remove();element.current=null;api.current=null;rdpEngine.current=null;};
 },[stableT]);
 const connect=async(event:FormEvent)=>{
  event.preventDefault();if(connecting.current||!api.current||!bridge.current||!rdpEngine.current||!serverId||['loading','connecting','connected'].includes(state))return;
  diagnosticAbort.current?.abort();diagnosticAbort.current=null;connecting.current=true;setRecovering(true);let secret=password,transportError='';setPassword('');setError('');setPortalUpdate(false);setStats(null);setState('connecting');const current=++generation.current,id=crypto.randomUUID(),controller=new AbortController();connectAbort.current=controller;
  const deadline=setTimeout(()=>{if(mounted.current&&generation.current===current){disconnect();setError(t('rdp.client.timeout'));setState('error');}},50000);
  try{
   const metadata=await bridge.current.request({action:'metadata',serverId},controller.signal) as RdpMetadata;if(!mounted.current||generation.current!==current)return;
   if(transportMode==='webrtc'&&bridge.current.protocol<RDP_BRIDGE_PROTOCOL)throw Object.assign(new Error(t('rdp.client.stale')),{code:'RDP_PORTAL_UPDATE_REQUIRED'});
   if(!metadata.publicKey)throw new Error(t('rdp.client.noKey'));if(!rdpAvailable(metadata.availability))throw new Error((metadata.availability?.reason?serverMessageText(metadata.availability.reason,t):'')||t('rdp.client.unavailable'));
   if(transportMode==='webrtc'&&metadata.availability?.webrtcCapable!==true)throw new Error(t('rdp.client.needsAgent'));
   const account=rdpLogonAccount(username,local,domain,metadata.hostname);
   const {key,keyEnvelope}=await createRdpKey(id,metadata.publicKey);if(!mounted.current||generation.current!==current)return;
   const onFailure=(e:Error)=>{if(mounted.current&&generation.current===current){const failedId=session.current;transportError=connectionError(e,'',locale);disconnect();setError(transportError);setState('error');if(failedId&&transportMode==='webrtc'&&needsNativeDiagnosis(e))void diagnoseFailure(failedId,generation.current);}};
   let Socket:ReturnType<typeof createRdpWebSocket>|Awaited<ReturnType<typeof prepareRdpWebRtc>>['Socket'];
   if(transportMode==='webrtc'){
    const direct=await prepareRdpWebRtc({id,key,request:bridge.current.request,onFailure,signal:controller.signal,onStats:value=>{if(mounted.current&&generation.current===current)setStats(value);}});if(!mounted.current||generation.current!==current){direct.close();return;}rtc.current=direct;
    session.current=id;await bridge.current.request({action:'open',id,serverId,keyEnvelope,transport:'webrtc',offer:direct.offer},controller.signal);if(!mounted.current||generation.current!==current){direct.close();void bridge.current.request({action:'close',id}).catch(()=>{});return;}
    await direct.start();if(!mounted.current||generation.current!==current){direct.close();return;}Socket=direct.Socket;
   }else{
    session.current=id;await bridge.current.request({action:'open',id,serverId,keyEnvelope},controller.signal);if(!mounted.current||generation.current!==current){void bridge.current.request({action:'close',id}).catch(()=>{});return;}
    Socket=createRdpWebSocket({id,key,duplex:true,request:bridge.current.request,onFailure});
   }
   const TransportSocket=Socket as unknown as typeof WebSocket;
   window.WebSocket=class extends TransportSocket{constructor(url:string|URL,protocols?:string|string[]){super(url,protocols);socket.current=this;}};
   const config=api.current.configBuilder().withUsername(account.username).withPassword(secret).withServerDomain(account.domain).withDestination('localhost:3389').withProxyAddress(`wss://${window.location.host}/serverdesk-rdp`).withAuthToken(id).withDesktopSize(quality==='performance'?{width:1280,height:720}:{width:Math.max(800,Math.min(1920,host.current?.clientWidth??1280)),height:Math.max(600,Math.min(1080,host.current?.clientHeight??720))}).withExtension(rdpEngine.current.enableCredssp(true)).withExtension(rdpEngine.current.outboundMessageSizeLimit(16384)).build();secret='';
   const info=await api.current.connect(config);if(!mounted.current||generation.current!==current){api.current.shutdown();return;}api.current.setVisibility(true);api.current.setScale(scale==='fit'?1:3);setState('connected');
   void info.run().then(()=>{if(mounted.current&&generation.current===current)disconnect();}).catch(e=>{if(mounted.current&&generation.current===current){disconnect();setError(connectionError(e,transportError,locale));setState('error');}});
  }catch(e){if(mounted.current&&generation.current===current){const failedId=session.current;disconnect();setPortalUpdate(!!e&&typeof e==='object'&&'code' in e&&e.code==='RDP_PORTAL_UPDATE_REQUIRED');setError(connectionError(e,transportError,locale));setState('error');if(failedId&&transportMode==='webrtc'&&needsNativeDiagnosis(e))void diagnoseFailure(failedId,generation.current);}}finally{clearTimeout(deadline);secret='';connecting.current=false;if(mounted.current)setRecovering(false);}
 };
 const connected=state==='connected',working=state==='loading'||state==='connecting'||recovering;
 return <main className="sd-rdp-client"><header className="sd-rdp-client-toolbar"><span className={'sd-rdp-state '+state} role="status">{working?<LoaderCircle size={14} className="sd-rdp-spin"/>:<Monitor size={14}/>} {t(stateText[state])}{connected&&transportMode==='webrtc'&&<> · {stats?.rttMs!=null?t('rdp.client.directRtt',{ms:Math.round(stats.rttMs)}):t('rdp.client.direct')}</>}{connected&&transportMode==='mailbox'&&<> · {t('rdp.client.mailboxMode')}</>}</span><div><button disabled={!connected} onClick={()=>api.current?.ctrlAltDel()}>Ctrl+Alt+Del</button><select aria-label={t('rdp.client.display')} value={scale} onChange={event=>{const value=event.target.value as 'fit'|'real';setScale(value);api.current?.setScale(value==='fit'?1:3);}}><option value="fit">{t('rdp.client.fit')}</option><option value="real">{t('rdp.client.original')}</option></select><button disabled={!connected} onClick={()=>void host.current?.requestFullscreen().catch(()=>setError(t('rdp.client.noFullscreen')))} aria-label={t('rdp.client.fullscreen')}><Maximize size={15}/></button>{(connected||state==='connecting')&&<button onClick={disconnect}><Square size={13}/>{t('rdp.panel.disconnect')}</button>}</div></header>
  {error&&<div className="sd-rdp-client-error" role="alert">{error}{portalUpdate&&<button type="button" onClick={()=>window.parent.location.reload()}>{t('rdp.client.refreshPortal')}</button>}</div>}
  <div className="sd-rdp-desktop" ref={host} aria-label={t('rdp.client.desktopLabel')}/>
  {!connected&&<div className="sd-rdp-login-wrap"><form className="sd-rdp-login" onSubmit={connect}><Monitor size={25}/><h2>{t('rdp.client.signIn')}</h2><div className="sd-rdp-account-kind"><label><input type="radio" name="account-kind" checked={!local} onChange={()=>setLocal(false)} disabled={working}/>{t('management.field.domainAccount')}</label><label><input type="radio" name="account-kind" checked={local} onChange={()=>setLocal(true)} disabled={working}/>{t('rdp.client.localAccount')}</label></div><label htmlFor="rdp-transport">{t('rdp.client.mode')}</label><select id="rdp-transport" value={transportMode} onChange={event=>setTransportMode(event.target.value as 'webrtc'|'mailbox')} disabled={working}><option value="webrtc">{t('rdp.client.direct2')}</option><option value="mailbox">{t('rdp.client.mailboxOption')}</option></select><small>{transportMode==='webrtc'?t('rdp.client.directHint'):t('rdp.client.mailboxHint')}</small><label htmlFor="rdp-resolution">{t('rdp.client.resolution')}</label><select id="rdp-resolution" value={quality} onChange={event=>setQuality(event.target.value as 'performance'|'detail')} disabled={working}><option value="performance">{t('rdp.client.smooth')}</option><option value="detail">{t('rdp.client.detailed')}</option></select><label htmlFor="rdp-user">{t('management.users.username')}</label><input id="rdp-user" autoComplete="off" placeholder={local?t('management.users.username'):t('rdp.client.userPlaceholder')} value={username} onChange={event=>setUsername(event.target.value)} disabled={working} maxLength={253} required/>{!local&&!username.includes('\\')&&!username.includes('@')&&<><label htmlFor="rdp-domain">{t('management.param.domain')}</label><input id="rdp-domain" autoComplete="off" placeholder={t('rdp.client.optional')} value={domain} onChange={event=>setDomain(event.target.value)} disabled={working} maxLength={253}/></>}<label htmlFor="rdp-password">{t('management.field.password')}</label><input id="rdp-password" type="password" autoComplete="off" value={password} onChange={event=>setPassword(event.target.value)} disabled={working} maxLength={1024} required/><button className="sd-rdp-connect" type="submit" disabled={working||!username.trim()||!password}>{working?<LoaderCircle size={15} className="sd-rdp-spin"/>:<Play size={15}/>} {working?t('rdp.client.connectingEllipsis'):t('rdp.client.connect')}</button><small>{t('rdp.client.passwordHint')}</small></form></div>}
 </main>;
}
