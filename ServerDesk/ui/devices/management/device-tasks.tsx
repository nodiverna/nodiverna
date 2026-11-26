'use client';
// Management → Scheduled tasks on the console kit: a SectionHead without a visible title, the panel notice of System, then
// the collected Windows scheduled tasks with search, paging and Enable or Disable per task. Every change is confirmed
// before it runs (device-management-confirm.ts). The Nodiverna power task ("Scheduled power") is changed only through
// Management → System, so its row offers "Open scheduling" instead.
import {useRef,useState} from 'react';
import {CalendarClock,ListChecks,Power,PowerOff} from 'lucide-react';
import type {ServerSnapshot} from '@/lib/types';
import {unavailableReason} from '@/ui/devices/device/device-unavailable';
import {EMPTY_VALUE} from '@/lib/i18n/format';
import {permitted} from '@/ui/base/api';
import {confirmManagementAction,panelManageReason,type ManagementPanelProps} from '@/ui/devices/management/device-management-confirm';
import {Card,Menu,PanelUnavailable,SectionHead,StatusPill,type MenuEntry,type StatusKind} from '@/ui/kit/kit';
import {DataTable,Toolbar,pageWindow,type DataColumn} from '@/ui/kit/data-table';
import {useLocale,useT} from '@/ui/base/locale';
import '@/ui/devices/management/device-system.css';

export type ScheduledTask=NonNullable<ServerSnapshot['tasks']>[number];
const LIST_PAGE_SIZE=25;
/** The Nodiverna power task that Management → System schedules. */
export const ownedTask=(task:Pick<ScheduledTask,'name'|'path'>)=>task.name.toLowerCase()==='scheduled power'&&task.path.toLowerCase()==='\\serverdesk\\';
const taskKinds=(state:string):StatusKind=>state==='Running'?'success':state==='Ready'?'online':'neutral';
/** The tasks whose name or path contains the search, in the order the agent reports them. */
export function matchingTasks(tasks:readonly ScheduledTask[],query:string):ScheduledTask[]{
 const needle=query.trim().toLowerCase();
 return tasks.filter(task=>(task.name+' '+task.path).toLowerCase().includes(needle));
}

type Props=ManagementPanelProps&{
 /** "Open scheduling" of the power task: opens Management → System with the focus on the Scheduled maintenance card. */
 onOpenScheduling:()=>void;
};

export default function DeviceTasks(props:Props){
 const t=useT(),[locale]=useLocale(),live=useRef(props);live.current=props;
 const {server,viewer,demo,onOpenScheduling}=props,snapshot=server.snapshot;
 const [list,setList]=useState({serverId:server.id,query:'',page:1});
 const current=list.serverId===server.id?list:{serverId:server.id,query:'',page:1};
 const tasks=snapshot?.tasks??[],matches=matchingTasks(tasks,current.query);
 const pageView=pageWindow(current.page,LIST_PAGE_SIZE,matches.length),rows=matches.slice(pageView.start?pageView.start-1:0,pageView.end);
 const reason=panelManageReason(props,'set-task',locale);
 // The notice of System: the same rights and Management mode rule (nodiverna-ui §4, device section).
 const notice=unavailableReason({demo,revoked:!!server.revoked,permitted:permitted(server,viewer,'manage'),reported:true,supported:true,management:!snapshot||server.management===1&&snapshot.mode==='Management'});
 const toggle=(task:ScheduledTask)=>{
  const enable=task.state==='Disabled';
  confirmManagementAction(live.current,server.id,'set-task',{name:task.name,path:task.path,enabled:enable},t(enable?'management.tasks.enableDescription':'management.tasks.disableDescription',{path:task.path,name:task.name}),enable?t('management.enable'):t('management.disable'),locale);
 };
 // One row Menu: "Open scheduling" for the power task Nodiverna owns, else Turn on or Turn off.
 const taskEntries=(task:ScheduledTask):MenuEntry[]=>ownedTask(task)
  ?[{id:'schedule',label:t('management.tasks.openScheduler'),icon:CalendarClock,onSelect:onOpenScheduling}]
  :[{id:'toggle',label:task.state==='Disabled'?t('management.enable'):t('management.disable'),icon:task.state==='Disabled'?Power:PowerOff,blocked:reason||undefined,onSelect:()=>toggle(task)}];
 const columns:DataColumn<ScheduledTask>[]=[
  {id:'task',label:t('management.tasks.task'),primary:true,wrap:true,cell:task=><span className="sdx-cell-stack"><span>{task.name}</span><small className="mono">{task.path}</small></span>},
  {id:'state',label:t('management.status'),cell:task=><StatusPill kind={taskKinds(task.state)}>{task.state||EMPTY_VALUE}</StatusPill>},
  {id:'runs',label:t('management.tasks.runs'),cell:task=><span className="sdx-cell-stack"><span>{task.lastRun||EMPTY_VALUE}</span><small>{task.nextRun||EMPTY_VALUE}</small></span>},
  {id:'result',label:t('management.tasks.resultCode'),mono:true,cell:task=>String(task.lastResult)},
  {id:'actions',label:t('fleet.col.actions'),hideLabel:true,className:'sdx-col-actions',align:'end',cell:task=><Menu label={t('tree.actionsForName',{name:task.name})} entries={taskEntries(task)}/>},
 ];
 return <div className="sdx-system sdx-tasks">
  {/* The subtab names the panel: the head keeps the title for the outline only, the list is the focal point. */}
  <SectionHead hideTitle title={t('management.tasks.title')} description={t('management.tasks.description')} meta={t('management.collected',{value:snapshot?.tasks?tasks.length:EMPTY_VALUE})}/>
  <PanelUnavailable reason={notice} readOnly={t('system.readOnly')}/>
  <Card flush className="sdx-system-list sdx-system-list-bare">
   <DataTable variant="flush" cards label={t('management.tasks.title')} columns={columns} rows={rows} rowKey={task=>task.path+task.name} entranceId={'device-tasks:'+server.id}
    toolbar={<Toolbar search={{value:current.query,onChange:value=>setList({...current,query:value,page:1}),label:t('system.tasks.search'),placeholder:t('management.searchInventory')}}/>}
    empty={!tasks.length?{icon:ListChecks,title:t('management.tasks.noInventory')}:{icon:ListChecks,title:t('system.tasks.noMatch'),children:t('services.adjust')}}
    foot={t('system.tasks.foot',{count:tasks.length,filtered:matches.length})}
    pagination={{page:pageView.page,pageSize:LIST_PAGE_SIZE,total:matches.length,onPage:value=>setList({...current,page:value})}}/>
  </Card>
 </div>;
}
