'use client';
import {useEffect,useRef,useState,type KeyboardEvent,type PointerEvent,type RefObject} from 'react';
import {Activity,ChevronDown,ChevronUp,CircleCheck,CircleSlash,CircleX,Clock3,Loader2,X} from 'lucide-react';
import type {Job,Viewer} from '@/lib/types';
import {jobCounts,jobElapsed,jobProgress,shownJobObject} from '@/lib/job-display';
import {cancelJobBlocked,cancelJobVisible,jobActionLabel,jobLabel} from '@/ui/shell/console-jobs';
import type {Device} from '@/ui/base/api';
import {Btn,Drawer,Empty,IconBtn,cx,exactTime,relativeTime} from '@/ui/kit/kit';
import {useLocale,useT} from '@/ui/base/locale';
import {useClockNow} from '@/ui/base/clock-store';

/** The tone of a job state: success, danger (failed, expired, unknown), accent (pending, running) or muted. */
export const jobStateTone=(state:string)=>state==='succeeded'?'success':['failed','expired','unknown'].includes(state)?'danger':['pending','running'].includes(state)?'accent':'muted';
export const isActiveJob=(job:Job)=>['pending','running'].includes(job.state);

export function JobState({job}:{job:Job}){
 const state=job.state,[locale]=useLocale();
 return <span className={'sdx-job-state sdx-job-'+jobStateTone(state)}>{state==='running'?<Loader2 size={14} className="sdx-spin" aria-hidden/>:state==='pending'?<Clock3 size={14} aria-hidden/>:state==='succeeded'?<CircleCheck size={14} aria-hidden/>:state==='cancelled'?<CircleSlash size={14} aria-hidden/>:<CircleX size={14} aria-hidden/>}{jobLabel(state,locale)}</span>;
}

/** Compact job list for the dock and the Jobs sheet: the label, then device, object (never the raw kind) and progress. */
export function JobList({jobs,servers,viewer,demo,saving,now,onSelect,onCancel,showDevice=true,empty}:{jobs:Job[];servers:Device[];viewer:Viewer;demo:boolean;saving:boolean;now:number;onSelect:(job:Job)=>void;onCancel:(job:Job)=>void;showDevice?:boolean;empty?:string}){
 const t=useT(),[locale]=useLocale();
 if(!jobs.length)return <Empty icon={Activity} title={empty??t('jobs.none')}>{t('jobs.emptyHint')}</Empty>;
 return <ul className="sdx-job-list">{jobs.map(job=>{
  const device=servers.find(server=>server.id===job.serverId)?.name??job.serverId,visible=cancelJobVisible(job,servers),blocked=visible?cancelJobBlocked(job,servers,viewer,{demo,saving}):null,progress=jobProgress(job,locale);
  return <li key={job.id}>
   <button type="button" className="sdx-job-row" onClick={()=>onSelect(job)}>
    <JobState job={job}/>
    <span className="sdx-job-text"><strong>{jobActionLabel(job.action,locale,job.target)}</strong><small>{[showDevice?device:null,shownJobObject(job),progress].filter(Boolean).join(' · ')}</small></span>
    <time className="sdx-job-time" dateTime={new Date(job.claimedAt??job.createdAt).toISOString()} title={exactTime(job.claimedAt??job.createdAt,locale)}>{job.state==='running'?jobElapsed(job,now,locale):relativeTime(job.claimedAt??job.createdAt,now,locale)}</time>
   </button>
   {visible&&(blocked?<IconBtn icon={X} label={t('jobs.cancel')} blocked={t(blocked)}/>:<IconBtn icon={X} label={t('jobs.cancel')} onClick={()=>onCancel(job)}/>)}
  </li>;
 })}</ul>;
}

/** The list of the dock and the Jobs sheet: the active jobs first, then the last 20 others. */
export const recentJobs=(jobs:Job[])=>[...jobs.filter(isActiveJob),...jobs.filter(job=>!isActiveJob(job)).slice(0,20)];

/**
 * The Jobs sheet of the bottom bar at 900px or narrower (in place of the dock bar): a modal kit Drawer with the dock's
 * list, its counts as the description and "Show all jobs" in the footer. returnFocus is the bottom-bar item.
 */
export function JobSheet({jobs,servers,viewer,demo,saving,now:pinnedNow,open,onClose,onSelect,onCancel,onShowAll,returnFocus}:{jobs:Job[];servers:Device[];viewer:Viewer;demo:boolean;saving:boolean;
 /** Pins the time (tests); without it the open sheet follows the console clock every second (elapsed times). */
 now?:number;open:boolean;onClose:()=>void;onSelect:(job:Job)=>void;onCancel:(job:Job)=>void;onShowAll:()=>void;returnFocus?:RefObject<HTMLElement|null>}){
 const now=useClockNow(pinnedNow,time=>open?time:0);
 const t=useT(),{running,waiting}=jobCounts(jobs,now);
 return <Drawer open={open} onClose={onClose} title={t('jobs.title')} icon={Activity} description={`${t('jobs.dock.running',{count:running})} · ${t('jobs.dock.waiting',{count:waiting})}`} returnFocus={returnFocus}
  footer={<Btn onClick={onShowAll}>{t('jobs.sheet.showAll')}</Btn>}>
  <JobList jobs={recentJobs(jobs)} servers={servers} viewer={viewer} demo={demo} saving={saving} now={now} onSelect={onSelect} onCancel={onCancel} empty={t('jobs.noneYet')}/>
 </Drawer>;
}

const dockKey='serverdesk.redesign.dock-height',minHeight=140;
const maxHeight=()=>Math.max(minHeight+40,Math.round(window.innerHeight*.72));

/** Docked task panel below the workspace, like the recent tasks of vCenter. Its height can be dragged. Above 900px only: below, the bottom bar's Jobs item opens the JobSheet. */
export function JobDock({jobs,current,servers,viewer,demo,loaded,saving,now:pinnedNow,open,onOpenChange,onSelect,onCancel,onShowAll}:{jobs:Job[];current?:Job;servers:Device[];viewer:Viewer;demo:boolean;loaded:boolean;saving:boolean;
 /**
  * Pins the time (tests). Without it the dock follows the console clock: every second while its list is open or the
  * shown job runs (elapsed time), otherwise only when its counts change.
  */
 now?:number;open:boolean;onOpenChange:(open:boolean)=>void;onSelect:(job:Job)=>void;onCancel:(job:Job)=>void;onShowAll:()=>void}){
 const t=useT(),[locale]=useLocale();
 const now=useClockNow(pinnedNow,time=>open||current?.state==='running'?time:JSON.stringify(jobCounts(jobs,time)));
 const {running,waiting,scheduled}=jobCounts(jobs,now),recent=recentJobs(jobs);
 const device=current&&(servers.find(server=>server.id===current.serverId)?.name??current.serverId);
 const [height,setHeight]=useState(300),[resizing,setResizing]=useState(false),drag=useRef<{y:number;height:number}|null>(null);
 useEffect(()=>{queueMicrotask(()=>{try{const saved=Number(localStorage.getItem(dockKey));if(Number.isFinite(saved)&&saved>=minHeight)setHeight(Math.min(saved,maxHeight()));}catch{}});},[]);
 const persist=(value:number)=>{try{localStorage.setItem(dockKey,String(Math.round(value)));}catch{}};
 const resizeTo=(value:number)=>{const next=Math.max(minHeight,Math.min(maxHeight(),value));setHeight(next);return next;};
 const startResize=(event:PointerEvent<HTMLDivElement>)=>{
  if(event.button!==0)return;
  event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);
  drag.current={y:event.clientY,height:open?height:0};setResizing(true);
 };
 const moveResize=(event:PointerEvent<HTMLDivElement>)=>{
  const start=drag.current;if(!start)return;
  const next=start.height+start.y-event.clientY;
  if(!open&&next>24)onOpenChange(true);
  if(open||next>24)resizeTo(next);
 };
 const endResize=(event:PointerEvent<HTMLDivElement>)=>{
  const start=drag.current;if(!start)return;
  drag.current=null;setResizing(false);
  if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
  const next=start.height+start.y-event.clientY;
  if(open&&next<minHeight-60){onOpenChange(false);return;}
  persist(resizeTo(next));
 };
 const keyResize=(event:KeyboardEvent<HTMLDivElement>)=>{
  const step=event.shiftKey?96:32,keys:Record<string,number>={ArrowUp:step,ArrowDown:-step,PageUp:step*3,PageDown:-step*3};
  if(event.key==='Home'||event.key==='End'){event.preventDefault();if(!open)onOpenChange(true);persist(resizeTo(event.key==='Home'?maxHeight():minHeight));return;}
  const delta=keys[event.key];if(delta===undefined)return;
  event.preventDefault();if(!open){if(delta>0)onOpenChange(true);return;}
  persist(resizeTo(height+delta));
 };
 return <section className={cx('sdx-dock',open&&'open',resizing&&'resizing')} aria-label={t('jobs.title')}>
  <div className="sdx-dock-resize" role="separator" aria-orientation="horizontal" aria-label={t('jobs.dock.resize')} aria-controls={open?'sdx-dock-panel':undefined} aria-valuemin={0} aria-valuenow={open?Math.round(height):0} aria-valuetext={open?t('jobs.dock.height',{height:Math.round(height)}):t('jobs.dock.collapsed')} tabIndex={0} title={t('jobs.dock.dragHint')} onPointerDown={startResize} onPointerMove={moveResize} onPointerUp={endResize} onPointerCancel={endResize} onKeyDown={keyResize}><i aria-hidden="true"/></div>
  <div className="sdx-dock-bar">
   <button type="button" className="sdx-dock-toggle" aria-expanded={open} aria-controls={open?'sdx-dock-panel':undefined} aria-keyshortcuts="T" title={t('jobs.dock.toggle')} onClick={()=>onOpenChange(!open)}>
    <Activity size={15} aria-hidden/><strong>{t('jobs.title')}</strong>{running+waiting>0&&<b className="sdx-dock-badge">{running+waiting}</b>}{open?<ChevronDown size={14} aria-hidden/>:<ChevronUp size={14} aria-hidden/>}
   </button>
   {current?<button type="button" className="sdx-dock-current" onClick={()=>onSelect(current)} aria-label={t('jobs.dock.currentLabel',{action:jobActionLabel(current.action,locale,current.target),device:device??'',state:jobLabel(current.state,locale)})}>
    <JobState job={current}/><span className="sdx-dock-task"><strong>{jobActionLabel(current.action,locale,current.target)}</strong><span>{device}{shownJobObject(current)?` · ${shownJobObject(current)}`:''}{current.action==='runbook-run'?` · ${jobProgress(current,locale)}`:''}</span></span>
    {current.state==='running'&&<span className="sdx-dock-progress" aria-hidden="true"><i/></span>}
    <span className="sdx-dock-time">{jobElapsed(current,now,locale)}</span>
   </button>:<span className="sdx-dock-idle">{demo?t('jobs.dock.demo'):!loaded?t('jobs.dock.loading'):t('jobs.dock.idle')}</span>}
   <span className="sdx-dock-counts"><span>{t('jobs.dock.running',{count:running})}</span><span>{t('jobs.dock.waiting',{count:waiting})}</span>{scheduled>0&&<span>{t('jobs.dock.scheduled',{count:scheduled})}</span>}</span>
   {open&&<><Btn size="sm" variant="ghost" onClick={onShowAll}>{t('jobs.dock.showAll')}</Btn><IconBtn icon={X} label={t('jobs.dock.close')} onClick={()=>onOpenChange(false)}/></>}
  </div>
  {open&&<div id="sdx-dock-panel" className="sdx-dock-panel" style={{height}}>
   <JobList jobs={recent} servers={servers} viewer={viewer} demo={demo} saving={saving} now={now} onSelect={onSelect} onCancel={onCancel} empty={t('jobs.noneYet')}/>
  </div>}
 </section>;
}
