'use client';
// Health in the console (docs/alert-rules.md, "Health and the Monitoring tab"):
// the health pill of the fleet table and the device cards, and the scope view
// Monitoring › "By device", a worklist of the devices with warning or critical alarms. The
// calculation, the row order and the area of an alarm are in ui/base/health-score.ts;
// the column sort is ui/base/table-sort.ts.
import {useMemo,useState,type ReactNode} from 'react';
import {useClockNow} from '@/ui/base/clock-store';
import {AlertTriangle,HeartPulse,Info,OctagonAlert,Search} from 'lucide-react';
import type {AlertLevel} from '@/lib/alert-rules';
import type {OpenAlert,Server} from '@/lib/types';
import {alarmTarget,healthText,listHealth,problemCounts,problemRows,type HealthState,type ProblemRow} from '@/ui/base/health-score';
import {alarmDuration,alarmText} from '@/ui/devices/monitoring/alarms-view';
import {customerColumnDistinguishes} from '@/ui/devices/fleet/fleet-columns';
import {EMPTY_VALUE} from '@/lib/i18n/format';
import {inputRank,sortTableRows} from '@/ui/base/table-sort';
import {translate} from '@/lib/i18n/translate';
import type {Locale} from '@/lib/i18n/locale';
import {deviceSectionLabels,type DeviceSection} from '@/lib/console-route';
import type {Device} from '@/ui/base/api';
import {Segmented,StatusPill,exactTime,type EmptyProps,type StatusKind} from '@/ui/kit/kit';
import {DataTable,Toolbar,type DataColumn,type TableSort} from '@/ui/kit/data-table';
import {AnalysisTab,ResetAction,ShowDevicesAction,worstTone} from '@/ui/kit/analysis-tab';
import {useLocale,useT} from '@/ui/base/locale';

const healthKind:Record<HealthState,StatusKind>={good:'success',warning:'warning',critical:'critical',unknown:'neutral'};

/**
 * The health level as a pill ("Critical", "Warning", "Good", "No data"): lists show the level only, the
 * score stays on the device health line (device-summary.tsx). Only "No data" explains itself in a title.
 * The level is text, never color alone.
 */
export function HealthPill({server}:{server:Pick<Server,'alerts'|'lastSeen'>&{snapshot?:unknown}}){
 const [locale]=useLocale(),health=listHealth(server),text=healthText(health,locale);
 return <StatusPill kind={healthKind[health.state]} title={health.state==='unknown'?text.tooltip:undefined}>{text.label}</StatusPill>;
}

const levelIcons={critical:OctagonAlert,warning:AlertTriangle,info:Info} satisfies Record<AlertLevel,unknown>;
/** How many reasons a row shows before "Show N more". */
export const shownReasons=3;

export type ProblemLevel='all'|'critical'|'warning';
export type ProblemSortColumn='health'|'device'|'openFor';
/** The default sort: worst health first, the order of problemRows. */
export const defaultProblemSort:TableSort<ProblemSortColumn>={column:'health',direction:'desc'};
const levels:ProblemLevel[]=['all','critical','warning'];

/** The rows of the level in the sort: problemRows order in, sortTableRows out. */
export function sortedProblemRows<D extends Device>(rows:readonly ProblemRow<D>[],level:ProblemLevel,sort:TableSort<ProblemSortColumn>|null,now:number):ProblemRow<D>[]{
 const rank=inputRank(rows);
 const visible=level==='all'?rows:rows.filter(row=>row.health.state===level);
 return sortTableRows(visible,sort,{health:row=>-rank(row),device:row=>row.device.name,openFor:row=>now-row.since});
}

type ViewProps={
 rows:readonly ProblemRow<Device>[];level:ProblemLevel;onLevel:(level:ProblemLevel)=>void;
 sort:TableSort<ProblemSortColumn>;onSort:(sort:TableSort<ProblemSortColumn>)=>void;
 /** The ids of the devices whose reasons are expanded. */
 expanded:ReadonlySet<string>;onToggle:(deviceId:string)=>void;
 now:number;locale:Locale;
 /** The customer column: several customers in the portal and the devices belong to two or more customers. */
 customer:boolean;
 onOpen:(id:string,section?:DeviceSection,detail?:string)=>void;
 onShowDevices:()=>void;
};
/**
 * The toolbar, the table and its states. Without hooks, so a test can call it and press its parts: a row
 * and the device button open the area of the first reason, each reason chip the area of its alarm, and
 * "Show N more" expands the reasons of its row in place.
 */
export function ProblemsView({rows,level,onLevel,sort,onSort,expanded,onToggle,now,locale,customer,onOpen,onShowDevices}:ViewProps){
 const t=(key:Parameters<typeof translate>[1],params?:Parameters<typeof translate>[2])=>translate(locale,key,params);
 const counts=problemCounts(rows);
 const visible=sortedProblemRows(rows,level,sort,now);
 const open=(device:Device,alert:OpenAlert)=>{const target=alarmTarget(alert.ruleId,alert.params,device);onOpen(device.id,target.section,target.detail);};
 type Row=ProblemRow<Device>;
 const reasonsCell=({device,reasons}:Row)=>{
  const all=expanded.has(device.id),more=reasons.length-shownReasons,listId=`sdx-problem-reasons-${device.id}`;
  return <span className="sdx-problem-reasons" id={listId}>
   {(all?reasons:reasons.slice(0,shownReasons)).map(alert=>{
    const Icon=levelIcons[alert.level],title=alarmText(alert,locale,now).title,area=t(deviceSectionLabels[alarmTarget(alert.ruleId,alert.params,device).section]);
    return <button key={alert.id} type="button" className={'sdx-problem-reason '+alert.level} aria-label={t('problems.reason.open',{area,device:device.name,title})} onClick={()=>open(device,alert)}><Icon size={12} aria-hidden/><span>{title}</span></button>;
   })}
   {more>0&&<button key="more" type="button" className="sdx-problem-more" aria-expanded={all} aria-controls={listId} onClick={()=>onToggle(device.id)}>{all?t('problems.showFewer'):t('problems.showMore',{count:more})}</button>}
  </span>;
 };
 const columns:DataColumn<Row>[]=[
  {id:'health',label:t('problems.column.health'),sort:{first:'desc'},cell:row=><HealthPill server={row.device}/>},
  {id:'device',label:t('problems.column.device'),primary:true,sort:{first:'asc'},cell:row=>row.device.name},
  ...(customer?[{id:'customer',label:t('problems.column.customer'),cell:(row:Row)=><span className="sdx-muted-cell">{row.device.customerName?.trim()||EMPTY_VALUE}</span>}]:[]),
  {id:'reasons',label:t('problems.column.reasons'),wrap:true,className:'sdx-problem-reasons-col',cell:reasonsCell},
  {id:'openFor',label:t('problems.column.openFor'),sort:{first:'desc'},cell:row=><span title={exactTime(row.since,locale)}>{alarmDuration(row.since,now,locale)}</span>},
 ];
 const empty:EmptyProps=!rows.length
  ?{icon:HeartPulse,title:t('problems.empty.title'),children:t('problems.empty.text'),action:<ShowDevicesAction onShowDevices={onShowDevices}/>}
  :{icon:Search,title:t('problems.filtered.title'),children:t('problems.filtered.text'),action:<ResetAction label={t('problems.filtered.action')} onReset={()=>onLevel('all')}/>};
 const toolbar=<Toolbar filters={<Segmented<ProblemLevel> label={t('problems.level.label')} size="sm" value={level} onChange={onLevel} items={worstTone(levels.map(id=>({id,label:t(`problems.level.${id}`),count:counts[id],...(id==='all'?{}:{tone:healthKind[id]})})),['critical','warning'])}/>}/>;
 return <DataTable<Row> label={t('fleet.alarms.byDevice')} toolbar={toolbar} columns={columns} rows={visible} rowKey={row=>row.device.id}
  sort={sort} onSort={next=>onSort(next as TableSort<ProblemSortColumn>)} onOpen={row=>open(row.device,row.reasons[0])}
  empty={empty} foot={t('problems.foot',{count:rows.length,shown:visible.length})} cards entranceId="problem-rows"/>;
}

type TabProps={
 /** The scoped devices of the view. */
 devices:Device[];
 /** Pins the time (tests); without it the tab follows the console clock. */
 now?:number;
 /** Several customers in the portal (not in demo mode): the customer column shows when the devices belong to two or more customers. */
 customerColumn:boolean;
 onOpen:(id:string,section?:DeviceSection,detail?:string)=>void;
 /** Switches the view to its "devices" tab. */
 onShowDevices:()=>void;
 /** The level at the start; the console mounts one tab per scope, so it resets with the scope. */
 initialLevel?:ProblemLevel;
 /** The Monitoring summary row (MonitoringSummaryRow) between the head and the table; the default Monitoring subtab only. */
 summary?:ReactNode;
};

/** The scope view Monitoring › By device: the devices of the scope with warning or critical alarms, worst and longest open first. */
export default function ProblemsTab({devices,now:pinnedNow,customerColumn,onOpen,onShowDevices,initialLevel='all',summary}:TabProps){
 const now=useClockNow(pinnedNow);
 const t=useT(),[locale]=useLocale();
 const [level,setLevel]=useState<ProblemLevel>(initialLevel),[sort,setSort]=useState<TableSort<ProblemSortColumn>>(defaultProblemSort);
 // The expanded rows live as long as the tab: a remount (another tab, another scope) collapses them.
 const [expanded,setExpanded]=useState<ReadonlySet<string>>(()=>new Set());
 const rows=useMemo(()=>problemRows(devices),[devices]);
 const customer=customerColumn&&customerColumnDistinguishes(devices);
 const toggle=(id:string)=>setExpanded(current=>{const next=new Set(current);if(next.has(id))next.delete(id);else next.add(id);return next;});
 return <AnalysisTab title={t('fleet.alarms.byDevice')} description={t('problems.meta')} className="sdx-problems">
  {summary}
  <ProblemsView rows={rows} level={level} onLevel={setLevel} sort={sort} onSort={setSort} expanded={expanded} onToggle={toggle} now={now} locale={locale} customer={customer} onOpen={onOpen} onShowDevices={onShowDevices}/>
 </AnalysisTab>;
}
