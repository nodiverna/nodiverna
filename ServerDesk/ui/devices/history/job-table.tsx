'use client';
// History › Jobs of a scope and of a device (nodiverna-ui §4 "Scope subtab"): the jobs as one kit DataTable with the
// Toolbar search, the state as the focal column (JobState: icon, text, tone), the job's label with its object in the
// admin's words as the second line, and one row Menu (Show details, Cancel job). The dock and the Jobs sheet keep the
// compact JobList (ui/shell/jobs.tsx); both open the same job drawer through onSelect.
import {useState,type ReactNode} from 'react';
import {Activity} from 'lucide-react';
import type {Job,Viewer} from '@/lib/types';
import {jobElapsed,shownJobObject} from '@/lib/job-display';
import {EMPTY_VALUE} from '@/lib/i18n/format';
import {cancelJobBlocked,cancelJobVisible,jobActionLabel,jobLabel} from '@/ui/shell/console-jobs';
import type {Device} from '@/ui/base/api';
import {Menu,exactTime,relativeTime,type MenuEntry} from '@/ui/kit/kit';
import {DataTable,Toolbar,type DataColumn} from '@/ui/kit/data-table';
import {pageWindow} from '@/ui/kit/data-table-model';
import {ResetAction} from '@/ui/kit/analysis-tab';
import {JobState} from '@/ui/shell/jobs';
import {useLocale,useT} from '@/ui/base/locale';

export const jobPageSize=25;

export type JobTableProps={jobs:readonly Job[];servers:Device[];viewer:Viewer;demo:boolean;saving:boolean;now:number;
 onSelect:(job:Job)=>void;onCancel:(job:Job)=>void;
 /** The Device column and the device in the search (a scope). */
 showDevice:boolean;
 /** Controls in the toolbar's filters, for example the view Segmented of a device History. */
 filters?:ReactNode};

export default function JobTable({jobs,servers,viewer,demo,saving,now,onSelect,onCancel,showDevice,filters}:JobTableProps){
 const t=useT(),[locale]=useLocale();
 const [search,setSearch]=useState(''),[page,setPage]=useState(1);
 const names=new Map(servers.map(server=>[server.id,server.name]));
 const label=(job:Job)=>jobActionLabel(job.action,locale,job.target);
 const query=search.trim().toLocaleLowerCase(locale);
 const shown=query?jobs.filter(job=>[label(job),shownJobObject(job),job.actor,jobLabel(job.state,locale),showDevice?names.get(job.serverId):null].filter(Boolean).join(' ').toLocaleLowerCase(locale).includes(query)):jobs;
 const view=pageWindow(page,jobPageSize,shown.length);
 const menu=(job:Job):MenuEntry[]=>{
  const entries:MenuEntry[]=[{id:'details',label:t('jobs.menu.details'),onSelect:()=>onSelect(job)}];
  // Cancel stays visible for a pending job of a known device. In demo mode, without the right and while another change
  // saves it is blocked with its reason (cancelJobBlocked), like the drawer's and the dock's cancel button.
  if(cancelJobVisible(job,servers)){
   const reason=cancelJobBlocked(job,servers,viewer,{demo,saving});
   entries.push({id:'separator',separator:true},{id:'cancel',label:t('jobs.cancel'),danger:true,...(reason?{blocked:t(reason)}:{onSelect:()=>onCancel(job)})});
  }
  return entries;
 };
 const at=(job:Job)=>job.claimedAt??job.createdAt;
 const columns:DataColumn<Job>[]=[
  {id:'state',label:t('jobs.col.state'),className:'sdx-cell-nowrap',cell:job=><JobState job={job}/>},
  {id:'job',label:t('jobs.col.job'),primary:true,cell:job=>{const object=shownJobObject(job);return object?<span className="sdx-cell-stack sdx-job-cell"><strong>{label(job)}</strong><small>{object}</small></span>:<strong className="sdx-job-cell">{label(job)}</strong>;}},
  ...(showDevice?[{id:'device',label:t('fleet.col.device'),className:'sdx-cell-nowrap',cell:(job:Job)=>names.get(job.serverId)??EMPTY_VALUE}]:[]),
  {id:'account',label:t('console.job.account'),className:'sdx-cell-nowrap',cell:job=>job.actor||EMPTY_VALUE},
  {id:'time',label:t('audit.time'),className:'sdx-cell-nowrap',cell:job=><time dateTime={new Date(at(job)).toISOString()} title={exactTime(at(job),locale)}>{job.state==='running'?jobElapsed(job,now,locale):relativeTime(at(job),now,locale)}</time>},
  {id:'actions',label:t('fleet.col.actions'),hideLabel:true,className:'sdx-col-actions',cell:job=><Menu label={t('jobs.menu.label',{job:label(job)})} entries={menu(job)}/>},
 ];
 return <DataTable<Job> label={t('history.tab.jobs')} cards entranceId="history-jobs" columns={columns} rows={shown.slice(view.from,view.to)} rowKey={job=>job.id}
  toolbar={<Toolbar search={{value:search,onChange:value=>{setSearch(value);setPage(1);},label:t('history.search.label'),placeholder:showDevice?t('history.search.fleetJobs'):t('history.search.deviceJobs')}} filters={filters}/>}
  onOpen={onSelect} openLabel={job=>t('jobs.open',{job:label(job)})}
  empty={query?{icon:Activity,title:t('history.jobs.noMatch'),action:<ResetAction label={t('history.search.clear')} onReset={()=>{setSearch('');setPage(1);}}/>}
   :{icon:Activity,title:showDevice?t('history.jobs.noneScope'):t('history.jobs.noneDevice'),children:t('jobs.emptyHint')}}
  foot={t('jobs.foot',{shown:shown.length,count:jobs.length})}
  pagination={{page:view.page,pageSize:jobPageSize,total:shown.length,onPage:setPage}}/>;
}
