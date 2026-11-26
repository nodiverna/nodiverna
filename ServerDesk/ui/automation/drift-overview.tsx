'use client';
// The read side of the drift panel (ui/automation/drift-panel.tsx) on the console kit: the current-state card
// (the focal point: the state and the number of changes since the baseline, with "Accept as
// baseline"), the changes since the baseline and the history as flush DataTables whose rows open
// the details, and below them the policy disclosure (children).
import type {ReactNode} from 'react';
import {Select} from '@/ui/kit/field';
import {AlertTriangle,ArrowRight,Clock3,FolderSearch,GitCompareArrows,History,ShieldCheck} from 'lucide-react';
import {stamp} from '@/ui/base/api';
import type {MessageKey} from '@/lib/i18n/translate';
import type {Translate} from '@/ui/base/locale';
import {useLocale,useT} from '@/ui/base/locale';
import {storedMessageText} from '@/lib/server-messages';
import {Btn,Card,Facts,Notice,StatusPill,type EmptyProps,type IconTone,type StatusKind} from '@/ui/kit/kit';
import {DataTable,Toolbar,type DataColumn} from '@/ui/kit/data-table';
export type DriftChange={key:string;path:string;kind:string;change:string;before?:unknown;after?:unknown;textDiff?:string|{lines:{type:'same'|'added'|'removed';text:string}[];truncated:boolean}};
export type DriftReport={id:string;policyVersion:number;scannedAt:number;receivedAt:number;firstScannedAt:number;scanCount:number;complete:boolean;state:string;changes:DriftChange[];errors:string[]};
export type DriftBaseline={id:string;reportId:string;policyVersion:number;createdAt:number;createdBy:string};
export type DriftHistory={id:string;policyVersion:number;scannedAt:number;receivedAt:number;firstScannedAt:number;scanCount:number;complete:boolean;state:string;changeCount:number;errorCount:number;kind:string};
export type DriftOverviewData={state:string;baseline:DriftBaseline|null;baselines:DriftBaseline[];current:DriftReport|null;history:DriftHistory[];retentionDays:number;historyLimit:number;policy:{enabled:boolean;version?:number}};
// Label maps hold message keys; driftText translates a value or returns it unchanged.
export const driftLabels:Record<string,MessageKey>={baseline_missing:'drift.state.baselineMissing',in_sync:'drift.state.inSync',drifted:'drift.state.drifted',stale:'drift.state.stale',error:'drift.state.error',disabled:'fleet.disabled',loading:'drift.state.loading'};
export const driftChangeLabels:Record<string,MessageKey>={added:'drift.change.added',removed:'drift.change.removed',modified:'drift.change.modified',renamed:'drift.change.renamed'};
export const driftKindLabels:Record<string,MessageKey>={file:'files.file',directory:'files.folder',registry:'drift.kind.registry',config:'drift.kind.config'};
export const driftText=(labels:Record<string,MessageKey>,value:string,t:Translate)=>Object.hasOwn(labels,value)?t(labels[value]):value;
/** The pill and the icon tile tone of a drift state. */
export const driftPillKind=(state:string):StatusKind=>state==='in_sync'?'success':state==='drifted'||state==='stale'||state==='baseline_missing'?'warning':state==='error'?'critical':state==='loading'?'waiting':'neutral';
const driftTileTone=(state:string):IconTone=>state==='in_sync'?'success':state==='drifted'||state==='stale'||state==='baseline_missing'?'warning':state==='error'?'danger':state==='loading'?'accent':'neutral';
/** The state of the device as a pill, for the panel head. */
export function DriftStatePill({state}:{state:string}){
 const t=useT();
 return <StatusPill kind={driftPillKind(state)}>{driftText(driftLabels,state,t)}</StatusPill>;
}
const dayMs=86400000;
/**
 * Why a scan cannot become the baseline, or null: the right first, then the scan (incomplete,
 * older than 24 h or of another policy version, already the baseline: the baseline scan itself or a
 * scan without changes against a baseline), then a running change. The card and the details drawer
 * use the same reasons.
 */
export function driftAcceptReason(report:DriftReport,data:Pick<DriftOverviewData,'baseline'|'policy'>,canManage:boolean,busy:boolean,now:number,t:Translate):string|null{
 if(!canManage)return t('drift.blocked.manage');
 if(!report.complete)return t('drift.blocked.incomplete');
 if(report.policyVersion!==data.policy.version||now-Math.min(report.receivedAt,report.scannedAt)>dayMs)return t('drift.blocked.outdated');
 if(report.id===data.baseline?.reportId||data.baseline&&!report.changes.length)return t('drift.blocked.alreadyBaseline');
 if(busy)return t('automation.busy');
 return null;
}
type Props={data:DriftOverviewData;busy:boolean;canManage:boolean;historyDays:number;onHistoryDays:(days:number)=>void;onEdit:()=>void;onInspect:(id:string,index?:number,historical?:boolean)=>void;onAccept:(report:DriftReport)=>void;
 /** The time used for the 24 h limit and the history range. */
 now:number;children?:ReactNode};
type ChangeRow={change:DriftChange;index:number};
type EventRow={id:string;key:string;at:number;latestAt:number;label:string;note:string;count:number;kind:string;version:number};
const eventKinds:Record<string,StatusKind>={error:'critical',change:'warning',recovered:'success',baseline:'accent'};
export function DriftOverview({data,busy,canManage,historyDays,onHistoryDays,onEdit,onInspect,onAccept,now,children}:Props){
 const t=useT(),[locale]=useLocale();
 const current=data.current,baseline=data.baseline,state=data.state;
 const cutoff=now-historyDays*dayMs;
 const history:EventRow[]=[...data.history.filter(e=>e.receivedAt>=cutoff).map(e=>({id:e.id,key:'scan:'+e.id,at:e.firstScannedAt,latestAt:e.scannedAt,label:e.kind==='recovered'?(e.state==='in_sync'?t('drift.backInSync'):t('drift.scanOk')):driftText(driftLabels,e.state,t),note:e.errorCount?t('drift.scanErrors',{count:e.errorCount}):t('drift.changes',{count:e.changeCount}),count:e.scanCount,kind:e.kind,version:e.policyVersion})),...data.baselines.filter(b=>b.createdAt>=cutoff).map(b=>({id:b.reportId,key:'baseline:'+b.id,at:b.createdAt,latestAt:b.createdAt,label:t('drift.baselineAccepted'),note:t('drift.version',{version:b.policyVersion}),count:1,kind:'baseline',version:b.policyVersion}))].sort((a,b)=>b.latestAt-a.latestAt||b.key.localeCompare(a.key));
 const dayOptions=[...new Set([1,7,30,data.retentionDays].filter(day=>day<=data.retentionDays))].sort((a,b)=>a-b);
 const acceptReason=current?driftAcceptReason(current,data,canManage,busy,now,t):null;
 const policyAction=canManage?<Btn size="sm" icon={ArrowRight} onClick={onEdit}>{t('drift.setupPolicy')}</Btn>:undefined;
 // Without a current scan the changes card says why: monitoring is off, or the first scan is pending.
 const changesEmpty:EmptyProps=!current?data.policy.enabled?{icon:Clock3,title:t('drift.firstScanPending'),children:t('drift.agentReportsFirst'),action:policyAction}:{icon:FolderSearch,title:t('drift.setupMonitoring'),children:t('drift.chooseItems'),action:policyAction}
  :{icon:ShieldCheck,title:t('drift.noChanges'),children:t('drift.noChangesHint')};
 const changeColumns:DataColumn<ChangeRow>[]=[
  {id:'path',label:t('drift.pathSource'),primary:true,wrap:true,cell:({change})=><span className="sdx-cell-stack"><span className="mono drift-path">{change.path||change.key}</span><small>{driftText(driftKindLabels,change.kind,t)}</small></span>},
  {id:'change',label:t('drift.changeColumn'),cell:({change})=>driftText(driftChangeLabels,change.change,t)},
 ];
 const eventColumns:DataColumn<EventRow>[]=[
  {id:'time',label:t('drift.time'),primary:true,cell:event=><span className="sdx-cell-stack"><span>{stamp(event.at,locale)}</span>{event.count>1&&<small>{t('drift.unchangedUntil',{stamp:stamp(event.latestAt,locale)})}</small>}</span>},
  {id:'event',label:t('drift.event'),cell:event=><span className="sdx-cell-stack"><StatusPill kind={eventKinds[event.kind]??'neutral'}>{event.label}</StatusPill><small>{t('drift.policy',{version:event.version})}</small></span>},
  {id:'scope',label:t('drift.scope'),wrap:true,cell:event=><span className="sdx-cell-stack"><span>{event.note}</span>{event.count>1&&<small>{t('drift.scansMerged',{count:event.count})}</small>}</span>},
 ];
 const changes=current?.changes.map((change,index)=>({change,index}))??[];
 return <>
  <Card title={t('drift.currentState')} icon={GitCompareArrows} iconTone={driftTileTone(state)} meta={<DriftStatePill state={state}/>}
   description={current?t('drift.changes',{count:current.changes.length}):data.policy.enabled?t('drift.firstScanPending'):t('drift.monitoringOff')}
   actions={<>
    {baseline&&<Btn variant="ghost" size="sm" onClick={()=>onInspect(baseline.reportId,0,true)}>{t('drift.viewSourceScan')}</Btn>}
    {current&&<Btn variant="primary" size="sm" icon={ShieldCheck} blocked={acceptReason??undefined} onClick={()=>onAccept(current)}>{baseline?t('drift.acceptCurrent'):t('drift.acceptFirst')}</Btn>}
   </>}>
   <Facts columns={2} items={[
    {id:'scan',label:t('drift.lastScanLabel'),value:current?stamp(current.scannedAt,locale):t('drift.firstScanPending'),hint:current&&!current.complete?t('drift.incompleteScan',{length:current.errors.length}):undefined},
    {id:'baseline',label:t('drift.baseline'),value:baseline?stamp(baseline.createdAt,locale):t('drift.noReference'),hint:baseline?t('drift.policyVersion',{policyVersion:baseline.policyVersion}):data.policy.enabled?t('drift.useScanAsReference'):t('drift.chooseSources')},
   ]}/>
   {current?.errors.length?<Notice tone="danger" icon={AlertTriangle}>{current.errors.map((error,index)=><p key={index}>{storedMessageText(error,t)}</p>)}</Notice>:null}
  </Card>
  <Card title={t('drift.changesTitle')} icon={GitCompareArrows} iconTone={changes.length?'warning':'neutral'} flush meta={current?t('drift.changes',{count:changes.length}):undefined}>
   <DataTable<ChangeRow> label={t('drift.changesTitle')} variant="flush" cards entranceId="drift-changes" columns={changeColumns} rows={changes} rowKey={row=>row.change.key+'-'+row.index}
    onOpen={row=>current&&onInspect(current.id,row.index)} empty={changesEmpty}/>
  </Card>
  <Card title={t('device.summary.history')} icon={History} iconTone="neutral" flush meta={t('drift.events',{count:history.length})}>
   <DataTable<EventRow> label={t('device.summary.history')} variant="flush" cards columns={eventColumns} rows={history} rowKey={event=>event.key}
    onOpen={event=>onInspect(event.id,0,true)}
    toolbar={<Toolbar filters={<label className="drift-range"><span>{t('device.summary.range')}</span><Select size="sm" value={historyDays} onChange={event=>onHistoryDays(Number(event.target.value))}>{dayOptions.map(day=><option value={day} key={day}>{day===1?t('drift.last24h'):t('drift.lastDays',{day})}</option>)}</Select></label>}
     actions={<span className="drift-retention"><Clock3 size={14} aria-hidden/>{t('drift.retention',{value:data.retentionDays})}</span>}/>}
    empty={{icon:History,title:t('drift.noEvents'),children:t('drift.noEventsHint')}} foot={t('drift.historyNote',{value:data.historyLimit})}/>
  </Card>
  {children}
 </>;
}
