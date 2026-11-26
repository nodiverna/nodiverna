'use client';
// The "Graphics driver" card of Hardware → GPU (docs/gpu-driver-updates.md): the
// installed version as the focal number, the vendor's latest version, the status
// and "Update driver". Rules and copy come from ui/devices/hardware/gpu-driver-view.ts.
import {useEffect,useRef,useState} from 'react';
import {Download,Info,RefreshCw,RotateCw,ShieldCheck} from 'lucide-react';
import {toast} from 'sonner';
import type {Job,Viewer} from '@/lib/types';
import type {GpuDriverEntry,GpuDriverView} from '@/lib/server/devices/gpu-drivers/device';
import {gpuDriverGroups,gpuDriverVendorNames,type GpuDriverStatus,type GpuDriverVendor} from '@/lib/gpu-drivers/installed';
import {activeGpuDriverJob,demoGpuDriverView,finishedGpuDriverJob,gpuDriverActionReason,gpuDriverConfirmation,gpuDriverMultiGpu,gpuDriverPendingReported,gpuDriverReloadCodes,gpuDriverSentence,gpuDriverStatusText,gpuDriverUpdateVisible} from '@/ui/devices/hardware/gpu-driver-view';
import {agentMessageText} from '@/lib/agent-messages';
import {EMPTY_VALUE,formatDateTime} from '@/lib/i18n/format';
import {api,message,type Device} from '@/ui/base/api';
import type {Confirmation} from '@/ui/base/confirmation';
import {jobLabel} from '@/ui/shell/console-jobs';
import {Btn,IconBtn,Notice,Skeleton,StatusPill,relativeTime,type StatusKind} from '@/ui/kit/kit';
import {RetryAction} from '@/ui/kit/analysis-tab';
import {useLocale,useT} from '@/ui/base/locale';

type Props={server:Device;viewer:Viewer;demo:boolean;now:number;jobs:Job[];vendor:GpuDriverVendor;onConfirm?:(confirmation:Confirmation)=>void};
const tones:Record<GpuDriverStatus,{icon:typeof Info;pill:StatusKind;tone:string}>={
 current:{icon:ShieldCheck,pill:'success',tone:'success'},outdated:{icon:Download,pill:'warning',tone:'warn'},
 unknown:{icon:Info,pill:'neutral',tone:'muted'},unsupported:{icon:Info,pill:'neutral',tone:'muted'},
};
// A finished job's result stays on the card for a day.
const resultWindowMs=86_400_000;
const versionOf=(job:Job)=>/(\d[\d.]*)$/.exec(job.target??'')?.[1]??job.target??'';

export default function DeviceGpuDriver({server,viewer,demo,now,jobs,vendor,onConfirm}:Props){
 const t=useT(),[locale]=useLocale();
 const [loaded,setLoaded]=useState<{serverId:string;view:GpuDriverView}|null>(null),[error,setError]=useState(''),[refreshing,setRefreshing]=useState(false),[revision,setRevision]=useState(0);
 const sequence=useRef(0),live=useRef({server,viewer,demo,now,jobs});
 useEffect(()=>{live.current={server,viewer,demo,now,jobs};},[server,viewer,demo,now,jobs]);
 const context={server,viewer,demo,now,jobs},active=activeGpuDriverJob(context),finished=finishedGpuDriverJob(context);
 // The installed versions in the snapshot: after the inventory refresh of a finished job, the status loads again.
 const installedKey=JSON.stringify(gpuDriverGroups(server.snapshot).map(group=>[group.vendor,group.installed]));
 const fetchable=!demo&&server.revoked===0;
 useEffect(()=>{
  if(!fetchable)return;
  const current=++sequence.current;
  api<GpuDriverView>(`/api/gpu-drivers/device?${new URLSearchParams({serverId:server.id})}`)
   .then(view=>{if(current===sequence.current){setLoaded({serverId:server.id,view});setError('');}},failure=>{if(current===sequence.current)setError(message(failure,locale));});
 },[fetchable,server.id,locale,revision,installedKey]);
 // A job of this device that ends reloads the status.
 const activeId=active?.id,previousActive=useRef(activeId);
 useEffect(()=>{if(previousActive.current&&!activeId)queueMicrotask(()=>setRevision(value=>value+1));previousActive.current=activeId;},[activeId]);

 const view=demo?demoGpuDriverView(server,now):loaded?.serverId===server.id?loaded.view:null;
 const entry=view?.entries.find(item=>item.vendor===vendor)??null;
 const name=gpuDriverVendorNames[vendor];

 const checkAgain=async()=>{
  if(!fetchable||refreshing)return;
  const current=++sequence.current;setRefreshing(true);
  try{
   const next=await api<GpuDriverView>(`/api/gpu-drivers/device?${new URLSearchParams({serverId:server.id,refresh:'1'})}`);
   if(current!==sequence.current)return;
   setLoaded({serverId:server.id,view:next});setError('');
   if(next.notice)toast.info(t(next.notice.messageKey));
  }catch(failure){if(current===sequence.current){if(loaded?.serverId===server.id)toast.error(message(failure,locale));else setError(message(failure,locale));}}
  finally{if(current===sequence.current)setRefreshing(false);}
 };
 const update=(item:GpuDriverEntry)=>{
  const current=live.current,confirmation=gpuDriverConfirmation(current,item,locale);
  if(!confirmation||!onConfirm||current.server.id!==server.id)return;
  // A changed latest version, a recent install or another driver job: the server refused, so the card loads what the server knows.
  onConfirm({...confirmation,onSettled:outcome=>{if(!outcome.ok&&outcome.code&&gpuDriverReloadCodes.includes(outcome.code))setRevision(value=>value+1);}});
 };

 if(!view&&error)return <Notice tone="danger" icon={Info} action={<RetryAction onRetry={()=>{setError('');setRevision(value=>value+1);}}/>}>{t('hardware.gpuDriver.loadError')}</Notice>;
 if(!view)return <section className="dgd-card dgd-pending"><Skeleton variant="facts" rows={2} label={t('hardware.gpuDriver.loading')} after={15000} action={<RetryAction onRetry={()=>setRevision(value=>value+1)}/>}/></section>;
 if(!entry)return null;

 const {icon:Icon,pill,tone}=tones[entry.status],reason=gpuDriverActionReason(context,entry,locale),multi=gpuDriverMultiGpu(entry,locale);
 const recent=!active&&finished&&now-(finished.claimedAt??finished.createdAt)<resultWindowMs?finished:undefined;
 const result=recent?(recent.outputRedacted?null:agentMessageText(recent,t)):null;
 // A recent install the device has not reported yet: the installed figure already shows it, the row says why.
 const pending=entry.pendingInventory&&!entry.reason?entry.pendingInventory:null,reported=pending?gpuDriverPendingReported(entry,locale):null;
 return <section className="dgd-card" aria-labelledby="dgd-title" data-status={entry.status}>
  <div className="dgd-head">
   <span className={'dgd-tile dgd-tone-'+tone} aria-hidden><Icon size={16}/></span>
   <h3 id="dgd-title">{t('hardware.gpuDriver.title')}</h3>
   <StatusPill kind={pill}>{gpuDriverStatusText(entry.status,locale)}</StatusPill>
  </div>
  <div className="dgd-versions">
   <div className="dgd-installed"><span>{t('hardware.gpuDriver.installed')}</span><strong className="mono" key={entry.installed??'none'}>{entry.installed??EMPTY_VALUE}</strong></div>
   {entry.latest&&!entry.reason?<div className="dgd-latest"><span>{t('hardware.gpuDriver.latest',{vendor:name})}</span><strong className="mono" key={entry.latest.version}>{entry.latest.version}</strong>{entry.latest.releasedAt&&<small>{t('hardware.gpuDriver.released',{date:formatDateTime(locale,entry.latest.releasedAt+'T12:00:00Z',{day:'2-digit',month:'2-digit',year:'numeric'})})}</small>}</div>:null}
  </div>
  {pending?<div className="dgd-inventory" role="status"><RefreshCw size={16} aria-hidden/><p><span>{gpuDriverSentence(entry,locale)}{multi&&<> {multi}</>}</span>{reported&&<small>{reported}</small>}</p></div>
   :<p className="dgd-sentence">{gpuDriverSentence(entry,locale)}{multi&&<> {multi}</>}</p>}
  {active&&<div className="dgd-running" role="status" aria-live="polite"><i aria-hidden/><span>{t('hardware.gpuDriver.running',{version:versionOf(active)})}</span><small>{jobLabel(active.state,locale)}</small></div>}
  {recent&&<div className={'dgd-result dgd-result-'+(recent.state==='succeeded'?'success':'danger')} role="status"><strong>{t('hardware.gpuDriver.resultTitle',{state:jobLabel(recent.state,locale)})}</strong>{result&&<span>{result}</span>}</div>}
  {recent?.resultCode==='AGENT_GPU_DRIVER_INSTALLED_REBOOT'&&<Notice tone="warning" icon={RotateCw}>{t('hardware.gpuDriver.restart')}</Notice>}
  <div className="dgd-foot">
   <span className="dgd-checked" title={formatDateTime(locale,entry.checkedAt)}>{t('hardware.gpuDriver.checked',{time:relativeTime(entry.checkedAt,now,locale)})}</span>
   <IconBtn icon={RefreshCw} label={t('hardware.gpuDriver.checkAgain')} loading={refreshing} blocked={demo?t('network.blocked.demo'):undefined} onClick={()=>void checkAgain()}/>
   {gpuDriverUpdateVisible(entry.status)&&<Btn variant="primary" icon={Download} loading={active?.state==='pending'} blocked={reason||undefined} onClick={()=>update(entry)}>{t('hardware.gpuDriver.update')}</Btn>}
  </div>
  {reason&&gpuDriverUpdateVisible(entry.status)&&!active&&<small className="dgd-blocked">{reason}</small>}
 </section>;
}
