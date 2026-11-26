'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {ArrowUpCircle,CheckCircle2,Loader2,RefreshCw} from 'lucide-react';
import {Btn,IconBtn} from '@/ui/kit/kit';
import {deviceConnection} from '@/ui/base/ui-device';
import {agentChangesBetween,deviceUpdateState,isDevVersion,latestDeviceReleases,usableDeviceRelease,type AgentChange,type DeviceRelease,type DeviceUpdateCampaign,type UpdateReceipt} from '@/lib/agent-update-state';
import {deviceUpdateBlockReason,inspectDeviceUpdates} from '@/ui/devices/device/agent-update-model';
import type {Job,Viewer} from '@/lib/types';
import {api,ApiError,message,stamp,type Device} from '@/ui/base/api';
import {isOwner} from '@/ui/base/access-capabilities';
import {MfaStepUp} from '@/ui/session/mfa-step-up';
import {ConfirmDialog} from '@/ui/kit/confirm-dialog';
import {confirmationDevice} from '@/ui/devices/management/management-actions';
import '@/ui/devices/device/agent-update-notice.css';
import {useLocale,useT,useStableT} from '@/ui/base/locale';
import {EMPTY_VALUE} from '@/lib/i18n/format';
// history: the bundled changelogs of every agent version (GET /api/releases); anything but a list counts as none.
// devBuilds: Import dev builds is on, so the device may be offered a dev build (with its "Dev build" tag).
type ReleaseData={releases:DeviceRelease[];campaigns:DeviceUpdateCampaign[];history?:unknown;devBuilds?:boolean};
type Translate=ReturnType<typeof useT>;
/** The features and fixes of one version in the list of changes since the installed agent. */
function versionChanges(t:Translate,change:AgentChange){
 if(!change.published||!change.features.length&&!change.fixes.length)return <p>{t('agentUpdates.notice.noVersionChangelog',{version:change.version})}</p>;
 return <>{change.features.length>0&&<><strong>{t('agentUpdates.notice.features')}</strong><ul>{change.features.map((entry,index)=><li key={index}>{entry}</li>)}</ul></>}{change.fixes.length>0&&<><strong>{t('agentUpdates.notice.fixes')}</strong><ul>{change.fixes.map((entry,index)=><li key={index}>{entry}</li>)}</ul></>}</>;
}
type UpdateIntent={scope:string;releaseId:string;version:string;release:DeviceRelease};
export default function AgentUpdateNotice({server,viewer,demo,jobs,now}:{server:Device;viewer:Viewer;demo:boolean;jobs:Job[];now:number}){
 const t=useT(),stableT=useStableT(),[locale]=useLocale();
 // The install command sits inside the sentence, so the sentence is split at its placeholder.
 const [migrationBefore,migrationAfter]=t('agentUpdates.notice.nativeInstall').split('{command}');
 // The version sits in .mono inside the heading, so the heading is split at its placeholder.
 const [headingBefore,headingAfter]=t('agentUpdates.notice.versionHeading').split('{version}');
 const scope=JSON.stringify([server.id,viewer.id,isOwner(viewer),server.permissions??[],server.management,server.snapshot?.mode,server.snapshot?.agentCapabilities?.includes('agent-update'),demo]);
 const scopeRef=useRef(scope);scopeRef.current=scope;
 const[data,setData]=useState<{scope:string;value:ReleaseData}|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[receipt,setReceipt]=useState<UpdateReceipt|null>(null),[mfa,setMfa]=useState(false),[intent,setIntent]=useState<UpdateIntent|null>(null),[asking,setAsking]=useState<UpdateIntent|null>(null);
 const alive=useRef(true),busyRef=useRef(false),loadController=useRef<AbortController|null>(null),deployController=useRef<AbortController|null>(null),generation=useRef(0),latest=useRef({server,viewer,demo,jobs,now,data,receipt});latest.current={server,viewer,demo,jobs,now,data,receipt};
 const canInspect=inspectDeviceUpdates(server,viewer,demo),visible=data?.scope===scope?data.value:null;
 const state=deviceUpdateState(server,jobs,visible?.campaigns??[],receipt,now),active=!!state&&['scheduled','queued','installing','waiting'].includes(state.phase);
 const load=useCallback(async()=>{
  if(!canInspect)return;loadController.current?.abort();const controller=new AbortController();loadController.current=controller;const request=++generation.current,captured=scope,timer=setTimeout(()=>controller.abort(),15000);
  try{const value=await api<ReleaseData>('/api/releases',undefined,controller.signal);if(alive.current&&scopeRef.current===captured&&request===generation.current){setData({scope:captured,value});setError('');}}
  catch(failure){if(alive.current&&scopeRef.current===captured&&request===generation.current){setError(controller.signal.aborted?stableT('agentUpdates.notice.timeout'):message(failure));if(failure instanceof ApiError&&[401,403].includes(failure.status))setData(null);}}
  finally{clearTimeout(timer);}
 },[canInspect,scope,stableT]);
 // eslint-disable-next-line react-hooks/exhaustive-deps -- generation is a generation counter, not DOM refs; the cleanup increments it so that late responses are dropped.
 useEffect(()=>{setData(null);setError('');setReceipt(null);setMfa(false);setIntent(null);busyRef.current=false;setBusy(false);deployController.current?.abort();void load();return()=>{generation.current++;loadController.current?.abort();deployController.current?.abort();};},[scope,load]);
 useEffect(()=>{if(!canInspect)return;const timer=setInterval(()=>void load(),active?3000:60000);return()=>clearInterval(timer);},[load,canInspect,active]);
 // eslint-disable-next-line react-hooks/exhaustive-deps -- generation is a generation counter, not DOM refs; the cleanup increments it so that late responses are dropped.
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;generation.current++;loadController.current?.abort();deployController.current?.abort();};},[]);
 // A rollout relies on the live MFA login session (lib/step-up.ts: routine), so
 // the confirmed release goes out at once without a managementToken. Only when
 // the session lapsed does the MFA dialog open; after it verifies, the same
 // release goes out once more, with or without a token from the dialog.
 const deploy=async(selected:UpdateIntent)=>{
  if(busyRef.current||!alive.current||scopeRef.current!==selected.scope)return;
  const current=latest.current,loaded=current.data?.scope===selected.scope?current.data.value:null;
  const release=loaded?loaded.releases.find(item=>item.id===selected.releaseId&&item.version===selected.version):selected.release;
  const update=latestDeviceReleases(current.server.snapshot?.agentVersion,release?[release]:[],current.server.snapshot?.agentCapabilities,{devBuilds:loaded?.devBuilds===true}).update;
  const currentState=deviceUpdateState(current.server,current.jobs,loaded?.campaigns??[],current.receipt,current.now);
  const block=deviceUpdateBlockReason(current.server,current.viewer,deviceConnection(current.server,current.now).kind==='online',current.demo,locale);
  // update is the release itself only while it is newer than the installed agent (by rank, or another dev build of its base).
  if(!release||!usableDeviceRelease(release)||!update||update.id!==release.id){setError(t('agentUpdates.notice.gone'));setMfa(false);setIntent(null);return;}
  if(block||currentState&&['scheduled','queued','installing','waiting'].includes(currentState.phase)){setError(block||t('agentUpdates.notice.active'));setMfa(false);setIntent(null);return;}
  busyRef.current=true;setBusy(true);setError('');const controller=new AbortController();deployController.current=controller;
  try{
   const result=await api<{jobs:string[];scheduledAt:number}>('/api/releases',{action:'deploy',releaseId:selected.releaseId,serverIds:[current.server.id],confirm:true},controller.signal);
   if(!alive.current||scopeRef.current!==selected.scope||controller.signal.aborted)return;
   if(!Array.isArray(result.jobs)||!result.jobs[0])throw new Error(t('agentUpdates.notice.unconfirmed'));
   setReceipt({jobId:result.jobs[0],version:selected.version,createdAt:Date.now()});setIntent(null);setMfa(false);void load();
  }catch(failure){if(alive.current&&scopeRef.current===selected.scope&&!controller.signal.aborted){
   setError(message(failure));const stepUp=failure instanceof ApiError&&['MFA_LOGIN_REQUIRED','MFA_STEP_UP_REQUIRED','SESSION_EXPIRED'].includes(failure.code??'');
   if(stepUp){setIntent(selected);setMfa(true);}else if(failure instanceof ApiError&&failure.status===409){setIntent(null);setMfa(false);void load();}
  }}finally{if(alive.current&&scopeRef.current===selected.scope){busyRef.current=false;setBusy(false);}}
 };
 if(!canInspect)return null;
 if(!visible&&!error)return <div className="sd-device-agent-check" role="status" aria-label={t('agentUpdates.notice.checkingLabel')}><span className="sd-device-agent-skeleton"/>{t('agentUpdates.notice.checking')}</div>;
 const {update,migration}=latestDeviceReleases(server.snapshot?.agentVersion,visible?.releases??[],server.snapshot?.agentCapabilities,{devBuilds:visible?.devBuilds===true}),changes=update?agentChangesBetween(server.snapshot?.agentVersion,update,visible?.releases??[],visible?.history):[],block=deviceUpdateBlockReason(server,viewer,deviceConnection(server,now).kind==='online',demo,locale);
 // Install asks through the kit ConfirmDialog first (nodiverna-ui §5); its confirm button repeats the verb.
 const start=()=>{if(!update||busyRef.current||active)return;setAsking({scope,releaseId:update.id,version:update.version,release:update});};
 const confirmed=()=>{const selected=asking;setAsking(null);if(selected&&selected.scope===scope){setIntent(selected);void deploy(selected);}};
 const labels={scheduled:t('agentUpdates.phase.scheduled'),queued:t('agentUpdates.phase.queued'),installing:t('agentUpdates.phase.installing'),waiting:t('agentUpdates.phase.waiting'),verified:t('agentUpdates.phase.verified'),failed:t('agentUpdates.phase.failed')};
 return <><div className={'sd-device-agent-update'+(state?.phase==='failed'||error?' has-error':'')}>
 {state&&<div className="sd-device-agent-progress" role="status">{state.phase==='verified'?<CheckCircle2 size={15}/>:active?<Loader2 size={15} className="spin"/>:<ArrowUpCircle size={15}/>}<div><strong>{labels[state.phase]} · {state.version}</strong>{state.phase==='scheduled'&&state.notBefore?<span>{t('jobs.table.from',{time:stamp(state.notBefore,locale)})}</span>:state.phase==='waiting'?<span>{t('agentUpdates.notice.confirmedLater')}</span>:state.phase==='queued'?<span>{t('agentUpdates.notice.automatic')}</span>:state.phase==='installing'?<span>{t('agentUpdates.notice.restart')}</span>:null}{state.phase==='failed'&&state.message&&<span>{state.message.slice(0,240)}</span>}</div></div>}
 {!active&&update&&<div className="sd-device-agent-available"><div><strong><ArrowUpCircle size={15}/>{t('agentUpdates.notice.available',{version:update.version})}{isDevVersion(update.version)&&<span className="sdx-tag">{t('releases.devBuild')}</span>}</strong>{block&&<span>{block}</span>}</div><Btn size="sm" icon={ArrowUpCircle} loading={busy} blocked={block||undefined} onClick={start}>{t('agentUpdates.notice.install')}</Btn></div>}
 {!active&&update&&<details className="sd-device-agent-changelog">{changes.length>1?<><summary>{t('agentUpdates.notice.changesRange',{installed:String(server.snapshot?.agentVersion),version:update.version})}</summary><ol className="sd-device-agent-versions">{changes.map(change=><li key={change.version}><h3>{headingBefore}<span className="mono">{change.version}</span>{headingAfter}</h3>{versionChanges(t,change)}</li>)}</ol></>:<><summary>{t('agentUpdates.notice.changes',{version:update.version})}</summary>{update.changelog?.features?.length? <><strong>{t('agentUpdates.notice.features')}</strong><ul>{update.changelog.features.map((entry,index)=><li key={index}>{entry}</li>)}</ul></>:null}{update.changelog?.fixes?.length? <><strong>{t('agentUpdates.notice.fixes')}</strong><ul>{update.changelog.fixes.map((entry,index)=><li key={index}>{entry}</li>)}</ul></>:null}{!update.changelog?.features?.length&&!update.changelog?.fixes?.length&&<p>{t('agentUpdates.notice.noChangelog')}</p>}</>}</details>}
 {!active&&!update&&migration&&<div className="sd-device-agent-migration"><strong>{t('agentUpdates.notice.native',{version:migration.version})}</strong><span>{migrationBefore}<code>ServerDesk.Agent.exe --install</code>{migrationAfter}</span></div>}
 {!active&&update&&migration&&<p className="sd-device-agent-migration-note">{t('agentUpdates.notice.nativeLocal',{version:migration.version})}</p>}
 {error&&<div className="sd-device-agent-error" role="alert"><span>{error}</span><IconBtn icon={RefreshCw} label={t('agentUpdates.notice.recheck')} disabled={busy} onClick={()=>void load()}/></div>}
 </div><ConfirmDialog open={!!asking&&asking.scope===scope} onOpenChange={open=>{if(!open)setAsking(null);}} title={t('agentUpdates.notice.confirmTitle',{version:asking?.version??'',name:server.name})}
  lines={[...confirmationDevice(server.name,locale),{label:t('agentUpdates.notice.installedLabel'),value:String(server.snapshot?.agentVersion??EMPTY_VALUE),mono:true},{label:t('agentUpdates.notice.newLabel'),value:asking?.version??'',mono:true}]}
  body={t('agentUpdates.notice.confirmHint')} confirmLabel={t('agentUpdates.notice.install')} onConfirm={confirmed}/>
 <MfaStepUp open={mfa} onClose={()=>{setMfa(false);setIntent(null);}} onVerified={()=>{const selected=intent;if(selected)void deploy(selected);}}/></>;
}
