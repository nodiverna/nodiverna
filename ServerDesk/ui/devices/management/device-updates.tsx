'use client';
// Management → Windows Update on the console kit: a SectionHead without a visible title with one status
// sentence (updateStatus) and the two secondary actions (search, "Install all available"), the three KPI
// tiles once a search reported, a notice only while a job runs or after one failed, the update DataTable
// with the kit selection and BulkBar, and the hotfix history. Every action is confirmed through ui/devices/management/update-view.ts.
import {useRef,useState} from 'react';
import {Select} from '@/ui/kit/field';
import {AlertCircle,CheckCircle2,Download,History,LoaderCircle,PackageCheck,RefreshCw,RotateCw,ShieldCheck} from 'lucide-react';
import {toast} from 'sonner';
import type {Job,Viewer} from '@/lib/types';
import {unavailableReason} from '@/ui/devices/device/device-unavailable';
import {updateActionReason,updateConfirmation,updateCsv,updateInventory,updateJobs,updateSelected,updateSeverity,updateSeverityTone,updateStatus,updateView,UPDATE_PAGE_SIZE,UPDATE_SELECTION_LIMIT,type UpdateFilters,type UpdateSelection,type WindowsUpdate} from '@/ui/devices/management/update-view';
import type {Device} from '@/ui/base/api';
import {downloadText,permitted,stamp} from '@/ui/base/api';
import type {Confirmation} from '@/ui/base/confirmation';
import {agentMessageText} from '@/lib/agent-messages';
import {Btn,Card,IconBtn,Kpi,KpiRow,Notice,PanelUnavailable,SectionHead,Skeleton,StatusPill,type StatusKind} from '@/ui/kit/kit';
import {BulkBar,DataTable,Toolbar,type DataColumn} from '@/ui/kit/data-table';
import '@/ui/devices/management/device-updates.css';

import {useLocale,useT} from '@/ui/base/locale';
import {translate} from '@/lib/i18n/translate';
import {defaultLocale,type Locale} from '@/lib/i18n/locale';
import {EMPTY_VALUE} from '@/lib/i18n/format';
type Props={server:Device;viewer:Viewer;demo:boolean;saving:boolean;onConfirm:(value:Confirmation)=>void;now:number;jobs:Job[]};
type Hotfix={id:string;installedOn:string;key:string};
const defaults=():UpdateFilters=>({query:'',severity:'all',reboot:'all',page:1});
const HOTFIX_PAGE_SIZE=10;
const terminalLabel=(state:string,locale:Locale=defaultLocale)=>({succeeded:translate(locale,'updates.terminal.succeeded'),failed:translate(locale,'jobs.state.failed'),cancelled:translate(locale,'jobs.state.cancelled')} as Record<string,string>)[state]??translate(locale,'updates.terminal.unconfirmed');
const severityKinds:Record<ReturnType<typeof updateSeverityTone>,StatusKind>={critical:'critical',important:'warning',moderate:'neutral',low:'neutral',unknown:'neutral'};
const kbList=(item:WindowsUpdate)=>item.kb?item.kb.split(',').map(kb=>/^\d+$/.test(kb.trim())?'KB'+kb.trim():kb.trim()).join(' · '):item.id;

export default function DeviceUpdates(props:Props){
  const t=useT(),[locale]=useLocale();
  const {server,viewer,demo}=props,live=useRef(props);live.current=props;
  const [state,setState]=useState({serverId:server.id,filters:defaults()}),[selection,setSelection]=useState<UpdateSelection|null>(null),[hotfixQuery,setHotfixQuery]=useState({serverId:server.id,value:'',page:1});
  const inventory=updateInventory(server),filters=state.serverId===server.id?state.filters:defaults(),view=updateView(inventory.items,filters,locale),chosen=updateSelected(server,selection);
  const scopedJobs=updateJobs(props),activeJob=scopedJobs.find(job=>['pending','running'].includes(job.state)),latestJob=scopedJobs[0];
  const scanReason=updateActionReason(props,'scan-updates',false,locale),installReason=updateActionReason(props,'install-updates',false,locale),allReason=updateActionReason(props,'install-updates',true,locale);
  const scanning=activeJob?.action==='scan-updates',loading=!inventory.known&&(scanning||!server.snapshot);
  const hotfixes=server.snapshot?.hotfixes,hotfixState=hotfixQuery.serverId===server.id?hotfixQuery:{serverId:server.id,value:'',page:1},query=hotfixState.value;
  const hotfixMatches:Hotfix[]=(hotfixes??[]).map((item,index)=>({...item,key:`${item.id}-${index}`})).filter(item=>[item.id,item.installedOn].join(' ').toLocaleLowerCase(locale).includes(query.trim().toLocaleLowerCase(locale))).sort((a,b)=>(Date.parse(b.installedOn)||0)-(Date.parse(a.installedOn)||0)||a.id.localeCompare(b.id));
  const hotfixPages=Math.max(1,Math.ceil(hotfixMatches.length/HOTFIX_PAGE_SIZE)),hotfixPage=Math.min(hotfixPages,Math.max(1,hotfixState.page)),hotfixRows=hotfixMatches.slice((hotfixPage-1)*HOTFIX_PAGE_SIZE,hotfixPage*HOTFIX_PAGE_SIZE);
  const candidate={serverId:server.id,inventoryKey:inventory.key};
  // One panel notice (nodiverna-ui §5): the search needs no Management mode, so the mode is not checked here.
  const notice=unavailableReason({demo,revoked:!!server.revoked,permitted:permitted(server,viewer,'manage'),reported:true,supported:true});
  const request=(kind:'scan-updates'|'install-updates',ids?:string[],all=false)=>{const current=live.current,confirmation=updateConfirmation(current,kind,{...candidate,ids,all},locale);if(confirmation)current.onConfirm(confirmation);};
  const change=(next:Partial<UpdateFilters>)=>setState(previous=>({serverId:server.id,filters:{...(previous.serverId===server.id?previous.filters:defaults()),...next,...(next.page===undefined?{page:1}:{})}}));
  // Selecting is possible on a blocked device too; installing stays refused by updateConfirmation.
  const choose=(ids:string[])=>{
    const current=live.current,fresh=updateInventory(current.server);
    if(candidate.serverId!==current.server.id||candidate.inventoryKey!==fresh.key)return;
    const selected=[...new Set(ids)].filter(id=>fresh.items.some(item=>item.id===id)).slice(0,UPDATE_SELECTION_LIMIT);
    setSelection({serverId:server.id,inventoryKey:inventory.key,ids:selected});
  };
  const selectedIds=chosen.map(item=>item.id),limitReached=chosen.length>=UPDATE_SELECTION_LIMIT;
  const download=()=>{
    const current=live.current,fresh=updateInventory(current.server);
    if(current.server.id!==server.id||current.server.revoked||fresh.key!==inventory.key||!view.filtered.length)return;
    downloadText(`windows-updates-${server.id}.csv`,updateCsv(view.filtered,locale),'text/csv;charset=utf-8');
    toast.success(t('updates.csv.exported',{count:view.filtered.length}));
  };
  const filtered=!!filters.query||filters.severity!=='all'||filters.reboot!=='all';
  const reset=<Btn variant="ghost" size="sm" onClick={()=>change(defaults())}>{t('fleet.empty.resetFilter')}</Btn>;
  const columns:DataColumn<WindowsUpdate>[]=[
    {id:'update',label:t('management.updates.update'),primary:true,wrap:true,cell:item=><span className="sdx-cell-stack"><span>{item.title||t('updates.unnamed')}</span><small className="mono">{kbList(item)}</small></span>},
    {id:'priority',label:t('management.updates.priority'),cell:item=><StatusPill kind={severityKinds[updateSeverityTone(item.severity)]}>{updateSeverity(item.severity,locale)}</StatusPill>},
    {id:'restart',label:t('management.updates.restart'),cell:item=>item.rebootRequired?<span className="sdx-updates-restart"><RotateCw size={13} aria-hidden/>{t('updates.csv.restart')}</span>:<span className="sdx-muted-cell">{t('updates.noneReported')}</span>},
  ];
  const scanButton=(size?:'sm')=><Btn size={size} icon={RefreshCw} loading={scanning} blocked={scanReason||undefined} onClick={()=>request('scan-updates')}>{t('management.updates.scan')}</Btn>;
  // Before the first search the empty list says so and offers the search right there.
  const empty=!inventory.known?{icon:PackageCheck,title:t('updates.scanPending'),children:t('updates.startScan'),action:scanButton('sm')}
    :inventory.items.length?{icon:PackageCheck,title:t('updates.noMatch'),children:t('updates.adjust'),action:reset}
    :inventory.pendingCount===0?{icon:CheckCircle2,title:t('updates.noneAvailable'),children:t('updates.lastScanBased')}
    :{icon:PackageCheck,title:t('updates.noDetails'),children:t('updates.newScanOrAll')};
  const failedJob=!activeJob&&latestJob&&['failed','cancelled'].includes(latestJob.state)?latestJob:null;
  const hotfixColumns:DataColumn<Hotfix>[]=[
    {id:'hotfix',label:t('updates.hotfixes.column'),primary:true,mono:true,cell:item=>item.id},
    {id:'installed',label:t('management.hotfixes.installedOn'),cell:item=>item.installedOn||<span className="sdx-muted-cell">{t('updates.hotfixes.noDate')}</span>},
  ];
  return <div className="sdx-updates">
    <SectionHead hideTitle title={t('device.area.updates')} description={t('updates.subtitle')} meta={<span aria-live="polite">{updateStatus(props,locale)}</span>}
      actions={<>{scanButton()}<Btn icon={PackageCheck} blocked={allReason||undefined} onClick={()=>request('install-updates',undefined,true)}>{t('updates.install.all')}</Btn></>}/>
    <PanelUnavailable reason={notice} readOnly={t('updates.readOnly')}/>
    {/* The tiles appear once a search reported: before it, no tile shows a dash. */}
    {inventory.known&&<KpiRow label={t('updates.overview')} entranceId={'updates-kpi:'+server.id}>
      <Kpi key="available" label={t('updates.available')} value={inventory.pendingCount} icon={Download} tone="accent"/>
      <Kpi key="urgent" label={t('updates.criticalImportant')} value={view.urgent} icon={ShieldCheck} tone={view.urgent>0?'warning':'neutral'} detail={t('updates.inList')} hint={t('updates.showUrgent')} onSelect={()=>change({severity:filters.severity==='urgent'?'all':'urgent',reboot:'all'})} pressed={filters.severity==='urgent'}/>
      <Kpi key="restart" label={t('updates.csv.restart')} value={view.reboot} icon={RotateCw} tone="accent" detail={server.snapshot?.rebootPending?t('updates.rebootPending'):t('updates.forCollected')} hint={t('updates.showRestart')} onSelect={()=>change({reboot:filters.reboot==='yes'?'all':'yes',severity:'all'})} pressed={filters.reboot==='yes'}/>
    </KpiRow>}
    {activeJob&&<Notice tone="info" icon={LoaderCircle}><div className="sdx-updates-job"><strong>{t(activeJob.action==='scan-updates'?activeJob.state==='pending'?'updates.job.scanQueued':'updates.job.scanRunning':activeJob.state==='pending'?'updates.job.installQueued':'updates.job.installRunning')}</strong><span>{activeJob.state==='pending'?t('updates.job.waiting'):t('updates.job.processing')}</span>{activeJob.claimedAt&&<small>{activeJob.lastProgress?t('updates.job.startedProgress',{started:stamp(activeJob.claimedAt,locale),progress:stamp(activeJob.lastProgress,locale)}):t('updates.job.started',{started:stamp(activeJob.claimedAt,locale)})}</small>}</div></Notice>}
    {failedJob&&<Notice tone="warning" icon={AlertCircle}><details className="sdx-updates-output"><summary>{t(failedJob.action==='scan-updates'?'updates.job.lastScan':'updates.job.lastInstall',{state:terminalLabel(failedJob.state,locale)})} · {stamp(failedJob.createdAt,locale)}</summary>{failedJob.outputRedacted?<p>{t('updates.job.redacted')}</p>:<pre>{agentMessageText(failedJob,t)??t('updates.job.noResult')}</pre>}</details></Notice>}
    {inventory.truncated&&<Notice tone="warning" icon={AlertCircle}>{t('updates.truncated',{collected:inventory.items.length,count:inventory.pendingCount??0})}</Notice>}
    <Card flush className="sdx-updates-card">
      {loading?<Skeleton variant="table" label={t('updates.loading')} after={15000}/>:<>
        <Toolbar search={{value:filters.query,onChange:value=>change({query:value}),label:t('updates.search'),placeholder:t('updates.searchPlaceholder')}}
          filters={<>
            <Select size="sm" aria-label={t('updates.filterPriority')} value={filters.severity} onChange={event=>change({severity:event.target.value})}><option value="all">{t('updates.allPriorities')}</option><option value="urgent">{t('updates.criticalImportant')}</option><option value="critical">{t('updates.severity.critical')}</option><option value="important">{t('updates.severity.important')}</option><option value="moderate">{t('updates.severity.moderate')}</option><option value="low">{t('updates.severity.low')}</option><option value="unknown">{t('management.updates.notSpecified')}</option></Select>
            <Select size="sm" aria-label={t('updates.filterRestart')} value={filters.reboot} onChange={event=>change({reboot:event.target.value})}><option value="all">{t('updates.allUpdates')}</option><option value="yes">{t('updates.csv.restart')}</option><option value="no">{t('updates.noneReported')}</option></Select>
            {filtered&&reset}
          </>}
          actions={<IconBtn icon={Download} label={t('csv.export')} blocked={!view.filtered.length?t('updates.csv.nothing'):undefined} onClick={download}/>}/>
        <DataTable variant="flush" cards label={t('updates.tableLabel')} columns={columns} rows={view.items} rowKey={item=>item.id} busy={scanning} entranceId={'updates-table:'+server.id} empty={empty}
          // Selecting works on a blocked device too; installing stays refused by updateConfirmation. Once the limit is reached, unselected rows say why.
          selection={{selected:selectedIds,onChange:choose,rowLabel:item=>t('management.updates.selectOne',{title:item.title}),allLabel:t('updates.selectShown'),blocked:()=>limitReached?t('updates.blocked.limit',{count:UPDATE_SELECTION_LIMIT}):undefined}}
          foot={t('updates.foot',{count:inventory.items.length,filtered:view.filtered.length})}
          pagination={{page:view.page,pageSize:UPDATE_PAGE_SIZE,total:view.filtered.length,onPage:page=>change({page})}}/>
        <BulkBar count={chosen.length} onClear={()=>choose([])}>
          <Btn icon={Download} size="sm" blocked={installReason||undefined} onClick={()=>request('install-updates',selectedIds)}>{t('updates.install.selected',{length:chosen.length})}</Btn>
        </BulkBar>
      </>}
    </Card>
    <Card title={t('updates.hotfixes.title')} icon={History} iconTone="neutral" description={t('updates.hotfixes.footnote')} meta={t('management.collected',{value:hotfixes?.length??EMPTY_VALUE})} flush className="sdx-updates-hotfixes">
      <DataTable variant="flush" label={t('updates.hotfixes.title')} columns={hotfixColumns} rows={hotfixRows} rowKey={item=>item.key}
        toolbar={<Toolbar search={{value:query,onChange:value=>setHotfixQuery({serverId:server.id,value,page:1}),label:t('updates.hotfixes.search'),placeholder:t('updates.hotfixes.searchPlaceholder')}}/>}
        empty={{icon:History,title:!hotfixes?t('updates.hotfixes.pending'):query?t('updates.hotfixes.noMatch'):t('updates.hotfixes.none')}}
        foot={t('updates.hotfixes.foot',{count:hotfixes?.length??0,filtered:hotfixMatches.length})}
        pagination={{page:hotfixPage,pageSize:HOTFIX_PAGE_SIZE,total:hotfixMatches.length,onPage:page=>setHotfixQuery({serverId:server.id,value:query,page})}}/>
    </Card>
  </div>;
}
