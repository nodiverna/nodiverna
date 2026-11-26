'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {Info,Monitor,MonitorPause,RefreshCw,Square,Terminal,X} from 'lucide-react';
import type {Confirmation} from '@/ui/base/confirmation';
import {api,credentialFetch,message,online,permitted,type V3Props} from '@/ui/base/api';
import {RDP_BRIDGE,RDP_BRIDGE_PROTOCOL,RDP_CANCEL,validatedRdpBridge,rdpGuid,rdpAvailable,type RdpMetadata,type RdpSession} from '@/ui/devices/remote/rdp-bridge';
import {REMOTE_DESKTOP_AVAILABLE} from '@/lib/rdp-feature';
import {Btn,Empty,IconTile,Notice,SectionHead,Unavailable} from '@/ui/kit/kit';
import {LoadFailed} from '@/ui/kit/analysis-tab';
import {ConfirmDialog} from '@/ui/kit/confirm-dialog';
import type {UnavailableReason} from '@/ui/devices/device/device-unavailable';
import '@/ui/devices/remote/rdp.css';

import {useLocale,useT,useStableT} from '@/ui/base/locale';
import {serverMessageText} from '@/lib/server-messages';
import {translate,type MessageKey} from '@/lib/i18n/translate';
import {defaultLocale,type Locale} from '@/lib/i18n/locale';
/** Why this viewer cannot use Remote Desktop on this device, as the kind of the kit Unavailable (in the panel's check order). */
export function rdpUnavailable({server,viewer,demo}:V3Props):UnavailableReason|null{
 if(demo)return 'demo';
 if(!permitted(server,viewer,'rdp'))return 'right';
 if(!online(server))return 'offline';
 if(server.snapshot?.mode!=='Management'||server.management!==1)return 'mode';
 if(!server.snapshot.agentCapabilities.includes('rdp-browser'))return 'agent';
 return null;
}
const rdpReasonKeys:Partial<Record<UnavailableReason,MessageKey>>={demo:'rdp.panel.demo',right:'rdp.panel.noPermission',offline:'management.blocked.offline',mode:'rdp.panel.management',agent:'rdp.panel.agentVersion'};
/** The full sentence of that reason, or '' when Remote Desktop can be used. */
export function rdpReason(props:V3Props,locale:Locale=defaultLocale){
 const kind=rdpUnavailable(props),key=kind&&rdpReasonKeys[kind];
 return key?translate(locale,key):'';
}
type RdpPanelProps=V3Props&{onConfirm?:(c:Confirmation)=>void;saving?:boolean;
 /** Switches the device view to the Terminal subarea: the paused state's one action. */
 onOpenTerminal?:()=>void};
export default function RdpPanel(props:RdpPanelProps){
 return REMOTE_DESKTOP_AVAILABLE?<EnabledRdpPanel {...props}/>:<RdpPausedState onOpenTerminal={props.onOpenTerminal}/>;
}
/** The paused subarea: one Empty that states the fact and offers the terminal instead; no card, heading or badge. */
export function RdpPausedState({onOpenTerminal}:{onOpenTerminal?:()=>void}){
 const t=useT();
 return <Empty icon={MonitorPause} title={t('rdp.paused.title')} action={onOpenTerminal&&<Btn variant="primary" icon={Terminal} onClick={onOpenTerminal}>{t('rdp.paused.openTerminal')}</Btn>}>{t('rdp.paused.notice')}</Empty>;
}
/** Remote Desktop while the feature is on: the check and the on/off switch in the head, the start card with its primary, the active connections. */
export function EnabledRdpPanel(props:RdpPanelProps){
 const t=useT(),stableT=useStableT(),[locale]=useLocale();
 const {server,viewer,demo,onConfirm,saving}=props;const frame=useRef<HTMLIFrameElement>(null),owned=useRef(new Set<string>()),pending=useRef(new Map<string,AbortController>());
 const[metadata,setMetadata]=useState<RdpMetadata|null>(null),[error,setError]=useState(''),[visible,setVisible]=useState(false),[busy,setBusy]=useState(false),[checking,setChecking]=useState(false),[closeTarget,setCloseTarget]=useState<RdpSession|null>(null);
 const reason=rdpReason(props,locale),canConfigure=!reason&&permitted(server,viewer,'manage')&&server.snapshot?.agentCapabilities.includes('set-rdp')===true;
 // eslint-disable-next-line react-hooks/exhaustive-deps -- discover depends only on the device ID, the role and the device rights; new server and viewer objects from polling must not query again.
 const discover=useCallback(async()=>{if(demo||!permitted(server,viewer,'rdp'))return;setBusy(true);setChecking(true);try{setMetadata(await api<RdpMetadata>('/api/rdp?serverId='+encodeURIComponent(server.id)));setError('');}catch(e){setError(message(e));}finally{setBusy(false);setChecking(false);}},[server.id,viewer.permissions,server.permissions,demo]);
 useEffect(()=>{void discover();},[discover]);
 useEffect(()=>{
  const sessions=owned.current,requests=pending.current;let disposed=false;
  const receive=(event:MessageEvent)=>{
   const data=event.data;if(disposed||event.origin!==window.location.origin||event.source!==frame.current?.contentWindow||!data||data.serverId!==server.id)return;
   if(data.type==='serverdesk:rdp:pagehide'&&rdpGuid(data.id)&&sessions.has(data.id)){void credentialFetch('/api/rdp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'close',id:data.id}),keepalive:true,cache:'no-store'}).then(response=>{if(response.ok)sessions.delete(data.id);}).catch(()=>{});return;}
   if(data.type===RDP_CANCEL&&rdpGuid(data.requestId)){requests.get(data.requestId)?.abort();return;}
   if(data.type!==RDP_BRIDGE||!rdpGuid(data.requestId))return;
   const reply=(result:Record<string,unknown>)=>{if(!disposed&&event.source===frame.current?.contentWindow)(event.source as Window).postMessage({type:RDP_BRIDGE,serverId:server.id,requestId:data.requestId,...result,bridgeProtocol:RDP_BRIDGE_PROTOCOL},window.location.origin);};
   if(requests.has(data.requestId))return;
   const body=validatedRdpBridge(data.body,server.id,sessions);
   if(!body){reply({ok:false,error:stableT('rdp.panel.mismatch'),status:400,code:'RDP_BRIDGE_INVALID_REQUEST'});return;}
   if(requests.size>=4){reply({ok:false,error:stableT('rdp.panel.tooMany'),status:429,code:'RDP_BRIDGE_BUSY'});return;}
   if(body.action==='open'&&(sessions.size>=2||reason)){reply({ok:false,error:reason||stableT('rdp.panel.hasSession'),status:409});return;}
   let timedOut=false;const controller=new AbortController(),timeout=setTimeout(()=>{timedOut=true;controller.abort();},10000);requests.set(data.requestId,controller);
   if(body.action==='open')sessions.add(String(body.id));
   void api<unknown>(body.action==='metadata'?'/api/rdp?serverId='+encodeURIComponent(server.id):'/api/rdp',body.action==='metadata'?undefined:body,controller.signal).then(result=>{
    if(body.action==='open'&&(!result||typeof result!=='object'||(result as {id?:string}).id!==body.id))throw new Error(stableT('rdp.panel.invalidSession'));
    if(body.action==='close'||['exchange','receive','signal'].includes(String(body.action))&&result&&typeof result==='object'&&!['open','opening'].includes(String((result as {state?:string}).state)))sessions.delete(String(body.id));
    if(body.action==='metadata'&&result&&typeof result==='object')for(const s of (result as RdpMetadata).sessions??[])if(!['opening','open'].includes(s.state))sessions.delete(s.id);
    reply({ok:true,result});
   }).catch(e=>{
    if(body.action==='open')void api('/api/rdp',{action:'close',id:body.id}).then(()=>sessions.delete(String(body.id))).catch(()=>{if(typeof e?.status==='number'&&e.status>=400&&e.status<500&&![408,429].includes(e.status))sessions.delete(String(body.id));});
    reply(timedOut?{ok:false,error:stableT('rdp.bridge.timeout'),status:504,code:'RDP_BRIDGE_TIMEOUT'}:{ok:false,error:message(e),status:typeof e?.status==='number'?e.status:500,code:typeof e?.code==='string'?e.code:undefined,messageKey:typeof e?.messageKey==='string'?e.messageKey:undefined,params:e?.params});
   }).finally(()=>{clearTimeout(timeout);requests.delete(data.requestId);});
  };
  window.addEventListener('message',receive);
  return()=>{
   disposed=true;window.removeEventListener('message',receive);for(const request of requests.values())request.abort();requests.clear();
   for(const id of sessions)void credentialFetch('/api/rdp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'close',id}),keepalive:true,cache:'no-store'}).catch(()=>{});sessions.clear();
  };
 },[server.id,visible,reason,stableT]);
 const configure=(enabled:boolean)=>onConfirm?.({title:enabled?t('rdp.panel.enableTitle'):t('rdp.panel.disableTitle'),description:t(enabled?'rdp.panel.enableDescription':'rdp.panel.disableDescription'),confirmLabel:t(enabled?'rdp.panel.enable':'rdp.panel.disable'),lines:[{label:t('management.confirm.device'),value:server.name}],payload:{action:'job',id:server.id,kind:'set-rdp',params:{enabled,confirm:true},confirm:true}});
 const close=async(session:RdpSession)=>{setBusy(true);try{await api('/api/rdp',{action:'close',id:session.id,...(session.isOwn===false?{confirm:true}:{})});setCloseTarget(null);await discover();}catch(e){setError(message(e));}finally{setBusy(false);}};
 const availability=metadata?.availability,sessions=metadata?.activeSessions??metadata?.sessions?.filter(s=>['open','opening'].includes(s.state))??[];
 const unavailable=rdpUnavailable(props),availabilityText=availability?.reason?serverMessageText(availability.reason,t):'';
 // A Windows policy blocks the switch: the reason from the agent report, or the policy sentence when the report has none.
 const policyReason=availability?.policyBlocked?availabilityText||serverMessageText({key:'serverMessage.rdp.policyBlocked'},t):undefined;
 // The reason shown above the start card also blocks its primary; without metadata the button waits for the check.
 const openBlocked=reason||(availability&&!rdpAvailable(availability)?availabilityText||serverMessageText({key:'serverMessage.rdp.disabledOnWindows'},t):undefined);
 const enabled=availability?.enabled===true;
 return <div className="sd-rdp-panel">
  <SectionHead title={t('device.section.rdp')} hideTitle actions={<>
   <Btn variant="ghost" size="sm" icon={RefreshCw} loading={checking} blocked={demo?t('kit.unavailable.demo'):undefined} onClick={()=>void discover()}>{t('network.check')}</Btn>
   {canConfigure&&onConfirm&&<Btn size="sm" loading={saving} disabled={checking&&!metadata} blocked={policyReason} onClick={()=>configure(!enabled)}>{t(enabled?'rdp.panel.disable':'rdp.panel.enable')}</Btn>}
  </>}/>
  {error&&<LoadFailed text={error} loading={checking} onRetry={()=>void discover()}/>}
  {unavailable?<Unavailable reason={unavailable}>{reason}</Unavailable>:availabilityText?<Notice tone="info" icon={Info}>{availabilityText}</Notice>:null}
  {visible&&!reason?<iframe ref={frame} className="sd-rdp-frame" data-serverdesk-rdp={server.id} title={t('rdp.panel.on',{name:server.name})} src={'/remote-desktop?serverId='+encodeURIComponent(server.id)} allow="fullscreen; clipboard-read 'none'; clipboard-write 'none'; microphone 'none'; camera 'none'"/>:<div className="sd-rdp-start"><IconTile icon={Monitor}/><div><strong>{t('rdp.panel.signIn')}</strong><p>{t('rdp.panel.signInHint')}</p></div><Btn variant="primary" icon={Monitor} loading={!metadata&&checking&&!reason} blocked={openBlocked} onClick={()=>setVisible(true)}>{t('rdp.panel.open')}</Btn></div>}
  {visible&&<div className="sd-rdp-foot"><span>{t('rdp.panel.leaveHint')}</span><Btn variant="ghost" size="sm" icon={X} onClick={()=>{setVisible(false);void discover();}}>{t('rdp.panel.closeView')}</Btn></div>}
  {sessions.length>0&&<div className="sd-rdp-sessions"><h3>{t('rdp.panel.active')}</h3>{sessions.map(session=><div key={session.id}><span>{session.owner??(session.isOwn?t('rdp.panel.yours'):t('rdp.panel.other'))}<small>{session.state==='opening'?t('rdp.panel.connecting'):t('network.status.up')}</small></span>{session.canClose&&<Btn size="sm" icon={Square} disabled={busy} onClick={()=>session.isOwn===false?setCloseTarget(session):void close(session)}>{t('rdp.panel.disconnect')}</Btn>}</div>)}</div>}
  {/* Disconnecting another person's connection asks first; the own one disconnects at once. */}
  <ConfirmDialog open={!!closeTarget} onOpenChange={open=>{if(!open)setCloseTarget(null);}} title={closeTarget?.owner?t('rdp.panel.closeOwner',{owner:closeTarget.owner}):t('rdp.panel.closeOther')} confirmLabel={t('rdp.panel.adminDisconnect')} tone="danger" busy={busy} onConfirm={()=>{if(closeTarget)void close(closeTarget);}}/>
 </div>;
}
