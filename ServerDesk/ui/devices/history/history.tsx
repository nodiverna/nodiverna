'use client';
// History of one device, one group or the whole fleet: jobs and device accesses in one place, each as one kit table
// with its own Toolbar search (nodiverna-ui §4 "Scope subtab"). Jobs are the JobTable (ui/devices/history/job-table.tsx),
// device accesses the shared ActivityTable (ui/devices/history/activity-table.tsx) that the audit log page uses too. A single
// device switches its views with a Segmented in the table's toolbar, or (viewSwitch false) through the History subarea
// bar of the device page; its alarm history is Monitoring › Alarms (ui/devices/monitoring/alarms.tsx). A scope shows one view per
// History subtab (pill link tabs in FleetView) inside the shared analysis frame.
import {useMemo,useState} from 'react';
import {useClockNow} from '@/ui/base/clock-store';
import {Activity,ScrollText,ShieldCheck} from 'lucide-react';
import type {AuditEntry,Job,Viewer} from '@/lib/types';
import {permitted,type Device} from '@/ui/base/api';
import {Notice,Segmented} from '@/ui/kit/kit';
import {AnalysisTab} from '@/ui/kit/analysis-tab';
import {Toolbar} from '@/ui/kit/data-table';
import ActivityTable from '@/ui/devices/history/activity-table';
import JobTable from '@/ui/devices/history/job-table';

import {formatClock} from '@/lib/i18n/format';
import {useLocale,useT} from '@/ui/base/locale';
export type HistoryTab='jobs'|'access';

type Props={
 /** Devices whose history is shown. */
 scoped:Device[];
 servers:Device[];viewer:Viewer;demo:boolean;saving:boolean;
 /** Pins the time (tests); without it the panel follows the console clock. */
 now?:number;jobs:Job[];audit:AuditEntry[];
 onSelectJob:(job:Job)=>void;onCancelJob:(job:Job)=>void;
 /** Single device: hide the device column and drop it from the search hint. */
 single?:boolean;
 tab?:HistoryTab;onTab?:(tab:HistoryTab)=>void;
 /** Single device: false when the page switches the views itself (the routed subarea bar of the device History). */
 viewSwitch?:boolean;
 /** Opens a device from the device access drawer (the scope History). */
 onOpenDevice?:(id:string)=>void;
 /** The console's last successful load: a scope subtab shows it as its freshness meta (not in demo mode). */
 updatedAt?:number|null;
};

/** The counts of the scope History subtabs: the jobs, and the device accesses while the viewer may see them on at least one scoped device. */
export function scopeHistoryCounts({scoped,viewer,jobs,audit,demo}:Pick<Props,'scoped'|'viewer'|'jobs'|'audit'|'demo'>):{jobs:number;access?:number}{
 const ids=new Set(scoped.map(server=>server.id));
 const allowed=scoped.some(server=>permitted(server,viewer,'security.events'));
 return {jobs:jobs.filter(job=>ids.has(job.serverId)).length,...(allowed?{access:demo?0:audit.filter(entry=>entry.scope==='device'&&entry.serverId&&ids.has(entry.serverId)).length}:{})};
}

/** The device access view loads at most this many entries (GET /api/console, device audit). */
export const deviceAccessLimit=200;

export default function HistoryPanel({scoped,servers,viewer,demo,saving,now:pinnedNow,jobs,audit,onSelectJob,onCancelJob,single=false,tab:controlledTab,onTab,viewSwitch=true,onOpenDevice,updatedAt=null}:Props){
 const now=useClockNow(pinnedNow);
 const t=useT(),[locale]=useLocale();
 const [ownTab,setOwnTab]=useState<HistoryTab>('jobs');
 const tab:HistoryTab=controlledTab??ownTab,setTab=onTab??setOwnTab;
 const ids=useMemo(()=>new Set(scoped.map(server=>server.id)),[scoped]);
 const allowed=scoped.filter(server=>permitted(server,viewer,'security.events'));
 const scopedJobs=useMemo(()=>jobs.filter(job=>ids.has(job.serverId)),[jobs,ids]);
 const accessEntries=useMemo(()=>demo?[]:audit.filter(entry=>entry.scope==='device'&&entry.serverId&&ids.has(entry.serverId)),[audit,demo,ids]);

 // The views of a single device as a Segmented in the toolbar's filters, not in a row of its own.
 const views=single&&viewSwitch?<Segmented<HistoryTab> label={t('fleet.tabs.history')} value={tab} onChange={setTab} size="sm" items={[{id:'jobs',label:t('history.tab.jobs'),icon:Activity,count:scopedJobs.length},{id:'access',label:t('history.tab.access'),icon:ScrollText,...(allowed.length?{count:accessEntries.length}:{})}]}/>:null;
 // A tab without its own table toolbar (the missing right) shows the views in a kit Toolbar of their own.
 const viewBar=views?<Toolbar filters={views}/>:null;
 const content=<>
  {tab==='jobs'&&<JobTable jobs={scopedJobs} servers={servers} viewer={viewer} demo={demo} saving={saving} now={now} onSelect={onSelectJob} onCancel={onCancelJob} showDevice={!single} filters={views}/>}
  {tab==='access'&&(allowed.length||!scoped.length?<>
   {!single&&allowed.length<scoped.length&&<p className="sdx-inline-note">{t('history.access.partial',{missing:scoped.length-allowed.length,count:scoped.length})}</p>}
   <ActivityTable entries={accessEntries} servers={servers} label={t('history.tab.access')} entranceId="history-access" exportName="device-access" showDevice={!single} limit={deviceAccessLimit} filters={views}
    onOpenDevice={single?undefined:onOpenDevice}
    empty={single?{title:t('history.access.noneDevice'),hint:t('history.access.noneDeviceHint')}:{title:t('history.access.none'),hint:t('history.access.noneHint')}}/>
  </>:<>{viewBar}<Notice tone="info" icon={ShieldCheck}>{t('history.access.needRight')}</Notice></>)}
 </>;
 // A scope: the view of the History subtab in the analysis frame, named by the subtab, with its description and the
 // console's freshness as plain meta (the top bar already announces it live). A device keeps its own block, no head.
 if(single)return <div className="sdx-history">{content}</div>;
 const meta=updatedAt!=null&&!demo?t('shell.freshness.updated',{time:formatClock(locale,updatedAt)}):undefined;
 return <AnalysisTab title={tab==='access'?t('history.tab.access'):t('history.tab.jobs')} description={tab==='access'?t('history.access.description'):t('history.jobs.description')} meta={meta} className="sdx-history">{content}</AnalysisTab>;
}
