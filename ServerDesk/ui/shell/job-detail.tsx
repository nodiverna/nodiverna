'use client';
// The job drawer (nodiverna-ui §8: one focal point): the result block first answers "did it work, and why not?"
// (JobState and the agent message), then the facts (device, account, times, duration), the kept input
// (jobs.display_input, loaded on demand from GET /api/console?job=&serverId=, lib/server/devices/job-detail.ts), the output in a
// Disclosure that opens by itself for a failed job, and the next step "Open {area}" (ui/shell/job-area.ts). The console
// renders one JobDetailDrawer; the dock, History › Jobs and the Jobs sheet open it through the job id.
import {useEffect,useState} from 'react';
import {useClockNow} from '@/ui/base/clock-store';
import {Activity,AlertTriangle,ShieldCheck} from 'lucide-react';
import type {Job,Viewer} from '@/lib/types';
import type {JobDetail} from '@/lib/server/devices/job-detail';
import {agentMessageText} from '@/lib/agent-messages';
import {jobDuration,jobEnded,shownJobObject} from '@/lib/job-display';
import {EMPTY_VALUE} from '@/lib/i18n/format';
import type {MessageKey} from '@/lib/i18n/translate';
import {jobAreaRoute} from '@/ui/shell/job-area';
import {cancelJobBlocked,cancelJobVisible,jobActionLabel} from '@/ui/shell/console-jobs';
import {api,type Device} from '@/ui/base/api';
import {Btn,CommandBlock,Disclosure,Drawer,Facts,LoadFailed,Notice,Skeleton,exactTime,type FactItem} from '@/ui/kit/kit';
import {JobState,jobStateTone} from '@/ui/shell/jobs';
import {useLocale,useT} from '@/ui/base/locale';

/** Input fields shown in mono: paths, addresses, versions and ids. */
const monoInputs=new Set(['path','address','newAddress','addresses','startRange','endRange','subnetMask','gateway','scopeId','scopeIds','addScopeIds','removeScopeIds','prefix','start','end','servers','masters','host','port','version','releaseId','versionId','assignmentId','scheduleId','groupSid','clientId','duid','iaid','updateIds','pid','sessionId','diskNumber','partitionNumber','interfaceIndex','networkId','zone','code','eventIds','ouPath','remoteAddress']);
const pending=(job:Job)=>job.state==='pending'||job.state==='running';
const settled=['pending','running','succeeded','failed','cancelled'];

export type JobDetailDrawerProps={job:Job|undefined;open:boolean;servers:Device[];viewer:Viewer;demo:boolean;saving:boolean;
 /** Pins the time (tests); without it the open drawer follows the console clock every second. */
 now?:number;
 /** Changes on every console refresh (top bar, R, palette): the open drawer loads its job again. */
 refreshKey:number;
 onClose:()=>void;onCancel:(job:Job)=>void;
 /** Opens the job's device. */
 onOpenDevice:(id:string)=>void;
 /** Goes to a console hash (the job's area); the drawer closes first. */
 onNavigate:(hash:string)=>void;
 /** The read of the job's input and output (tests replace it). */
 load?:(serverId:string,jobId:string,signal:AbortSignal)=>Promise<JobDetail>};

const loadDetail=(serverId:string,jobId:string,signal:AbortSignal)=>api<JobDetail>(`/api/console?job=${encodeURIComponent(jobId)}&serverId=${encodeURIComponent(serverId)}`,undefined,signal);
type LoadState={key:string;detail?:JobDetail;failed?:boolean};

export default function JobDetailDrawer({job,open,servers,viewer,demo,saving,now:pinnedNow,refreshKey,onClose,onCancel,onOpenDevice,onNavigate,load=loadDetail}:JobDetailDrawerProps){
 const now=useClockNow(pinnedNow,time=>open?time:0);
 const t=useT(),[locale]=useLocale();
 const [state,setState]=useState<LoadState>({key:''}),[retry,setRetry]=useState(0),[outputOpen,setOutputOpen]=useState<{key:string;open:boolean}>({key:'',open:false});
 const key=job?`${job.serverId}/${job.id}`:'',fetches=open&&!!job&&!demo&&job.action!=='runbook-run';
 // One read per opened job; a console refresh or a retry reads it again. A newer job's data is never shown for an older one.
 useEffect(()=>{
  if(!fetches||!job)return;
  const controller=new AbortController();
  load(job.serverId,job.id,controller.signal).then(detail=>{if(!controller.signal.aborted)setState({key,detail});},()=>{if(!controller.signal.aborted)setState(previous=>({key,detail:previous.key===key?previous.detail:undefined,failed:true}));});
  return ()=>controller.abort();
 },[fetches,key,refreshKey,retry]);// eslint-disable-line react-hooks/exhaustive-deps -- job and load are read through key
 const loaded=state.key===key?state:{key};
 // A device that is not in the list (removed, or out of view) shows no raw id: the Device fact is EMPTY_VALUE and the description the object alone.
 const device=job?servers.find(server=>server.id===job.serverId):undefined;
 const object=job?shownJobObject(job):null;
 const label=job?jobActionLabel(job.action,locale,job.target):t('jobs.table.job');
 const failedOpen=job?.state==='failed',showOutput=outputOpen.key===key?outputOpen.open:failedOpen;

 const facts=(job:Job):FactItem[]=>{
  const ended=jobEnded(job),duration=jobDuration(job,now,locale);
  return [
   {id:'device',label:t('console.job.device'),value:device?<Btn variant="ghost" size="sm" onClick={()=>onOpenDevice(device.id)}>{device.name}</Btn>:EMPTY_VALUE},
   {id:'account',label:t('console.job.account'),value:job.actor||EMPTY_VALUE},
   {id:'created',label:t('console.job.created'),value:exactTime(job.createdAt,locale)},
   {id:'started',label:t('console.job.started'),value:job.claimedAt!=null?exactTime(job.claimedAt,locale):EMPTY_VALUE},
   ...(ended!==null?[{id:'ended',label:t('console.job.ended'),value:exactTime(ended,locale)}]:[]),
   ...(duration?[{id:'duration',label:t('console.job.duration'),value:duration}]:[]),
   ...(job.state==='running'&&job.lastProgress?[{id:'progress',label:t('console.job.lastProgress'),value:exactTime(job.lastProgress,locale)}]:[]),
  ];
 };
 const inputValue=(value:string|number|boolean)=>typeof value==='boolean'?t(value?'common.yes':'common.no'):String(value);
 const input=(detail:JobDetail|undefined)=>{
  if(demo)return <p className="sdx-detail-note">{t('console.job.inputMissing')}</p>;
  if(!detail){
   if(loaded.failed)return <LoadFailed text={t('console.job.loadFailed')} onRetry={()=>setRetry(count=>count+1)}/>;
   return <Skeleton variant="facts" rows={2} label={t('console.job.loading')}/>;
  }
  if(!detail.inputKept)return <p className="sdx-detail-note">{t('console.job.inputMissing')}</p>;
  // The maintenance removed the script after its retention: the note takes the script's place, the other fields stay.
  const removed=detail.scriptRemovedAfterDays!==null&&detail.scriptRemovedAfterDays!==undefined;
  if(!removed&&detail.input.script===undefined&&!detail.input.fields.length)return <p className="sdx-detail-note">{t('console.job.noInput')}</p>;
  return <>
   {removed&&<p className="sdx-detail-note">{t('console.job.scriptRemoved',{count:detail.scriptRemovedAfterDays??0})}</p>}
   {!removed&&detail.input.script!==undefined&&<CommandBlock label={t('console.job.script')} command={detail.input.script} tall/>}
   {detail.input.fields.length>0&&<Facts items={detail.input.fields.map(field=>({id:field.key,label:t(`jobs.input.${field.key}` as MessageKey),value:inputValue(field.value),mono:monoInputs.has(field.key)}))}/>}
  </>;
 };
 const output=(job:Job,detail:JobDetail|undefined)=>{
  if(job.outputRedacted||detail?.outputRedacted)return <Notice tone="info" icon={ShieldCheck}>{t('console.job.redacted')}</Notice>;
  const result=detail?.output;
  if(!result)return <p className="sdx-detail-note">{t('console.job.noOutput')}</p>;
  return <>
   {result.text!==undefined&&<pre className="sdx-output" tabIndex={0} aria-label={t('console.job.outputLabel',{job:label})}>{result.text}</pre>}
   {result.stderr!==undefined&&<div className="sdx-detail-block"><span className="sdx-command-label">{t('console.job.stderr')}</span><pre className="sdx-output" tabIndex={0} aria-label={t('console.job.stderrLabel',{job:label})}>{result.stderr}</pre></div>}
   {result.exitCode!==undefined&&<Facts items={[{id:'exit',label:t('console.job.exitCode'),value:String(result.exitCode),mono:true}]}/>}
   {result.data!==undefined&&<pre className="sdx-output" tabIndex={0} aria-label={t('console.job.dataLabel',{job:label})}>{result.data}</pre>}
   {result.text===undefined&&result.stderr===undefined&&result.data===undefined&&result.exitCode===undefined&&<p className="sdx-detail-note">{t('console.job.noOutput')}</p>}
   {result.truncated&&<p className="sdx-detail-note">{t('console.job.outputTruncated')}</p>}
  </>;
 };
 const area=job&&device?jobAreaRoute(job):null;
 const cancelReason=job?cancelJobBlocked(job,servers,viewer,{demo,saving}):null;
 const footer=job?<>
  {area&&<Btn onClick={()=>{onClose();onNavigate(area.hash);}}>{area.kind==='area'?t('console.job.openArea',{area:t(area.areaKey)}):area.kind==='assistant'?t('console.job.openAssistant'):t('fleet.openDevice',{name:device?.name??''})}</Btn>}
  {cancelJobVisible(job,servers)&&(cancelReason?<Btn blocked={t(cancelReason)}>{t('jobs.cancel')}</Btn>:<Btn onClick={()=>onCancel(job)}>{t('jobs.cancel')}</Btn>)}
 </>:undefined;
 const message=job?agentMessageText(job,t):null;
 const runbook=job?.action==='runbook-run';

 return <Drawer open={open} onClose={onClose} icon={Activity} title={label} description={job?(device?(object?`${device.name} · ${object}`:device.name):object||undefined):undefined} footer={footer}>
  {job&&<div className="sdx-detail sdx-job-detail">
   <div className="sdx-job-result" data-tone={jobStateTone(job.state)}>
    <JobState job={job}/>
    {message?<p className="sdx-job-message">{message}</p>:pending(job)?<p className="sdx-detail-note">{t('console.job.noResult')}</p>:null}
   </div>
   {!settled.includes(job.state)&&<Notice tone="warning" icon={AlertTriangle}>{t('console.job.uncertain')}</Notice>}
   <Facts items={facts(job)}/>
   {!runbook&&<section className="sdx-detail-section" aria-label={t('console.job.input')}>
    <h3 className="sdx-detail-subhead">{t('console.job.input')}</h3>
    {input(loaded.detail)}
   </section>}
   {!runbook&&(demo||loaded.detail||job.outputRedacted)&&<Disclosure title={t('console.job.output')} open={showOutput} onOpenChange={next=>setOutputOpen({key,open:next})}>
    {output(job,loaded.detail)}
   </Disclosure>}
  </div>}
 </Drawer>;
}
