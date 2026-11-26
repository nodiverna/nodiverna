'use client';
// The alarms in the console (docs/alert-rules.md): the scope view Monitoring ›
// By alarm with the open alarms of every device in the scope, and the device
// Monitoring › Alarms with open and closed alarms. Both share the row menu
// (acknowledge, mute, unmute, open device) and the mute drawer. The server
// decides the alarm state (lib/server/devices/alerts.ts); ui/devices/monitoring/alarms-view.ts holds the sort,
// filters and texts.
import {useCallback,useEffect,useId,useMemo,useRef,useState,type FormEvent,type ReactNode} from 'react';
import {useClockNow} from '@/ui/base/clock-store';
import {toast} from 'sonner';
import {AlertTriangle,Bell,BellOff,BellRing,Check,ChevronRight,Clock,Download,Search,Siren} from 'lucide-react';
import type {AlertLevel} from '@/lib/alert-rules';
import type {AlertHistoryEntry,OpenAlert,Viewer} from '@/lib/types';
import {alarmCounts,alarmCustomerOptions,alarmDuration,alarmGroupOptions,alarmHistoryRows,alarmLevelKeys,alarmPeak,alarmRows,alarmStatus,alarmText,alarmsCsv,alarmsCsvFileName,closeReasonKeys,filterAlarmRows,noAlarmFilter,type AlarmFilter,type AlarmLevelFilter,type AlarmRow} from '@/ui/devices/monitoring/alarms-view';
import {customerColumnDistinguishes} from '@/ui/devices/fleet/fleet-columns';
import {EMPTY_VALUE} from '@/lib/i18n/format';
import type {Locale} from '@/lib/i18n/locale';
import {inputRank,sortTableRows} from '@/ui/base/table-sort';
import {ApiError} from '@/ui/base/http';
import {api,downloadText,permitted,type Device} from '@/ui/base/api';
import {Btn,Drawer,IconBtn,Menu,Notice,PickRow,Segmented,Skeleton,StatusPill,exactTime,relativeTime,type EmptyProps,type MenuEntry,type StatusKind} from '@/ui/kit/kit';
import {Select} from '@/ui/kit/field';
import {DataTable,Toolbar,type DataColumn,type TableSort} from '@/ui/kit/data-table';
import {AnalysisTab,ResetAction,RetryAction,ShowDevicesAction} from '@/ui/kit/analysis-tab';
import {useLocale,useT,type Translate} from '@/ui/base/locale';

const levelKind:Record<AlertLevel,StatusKind>={critical:'critical',warning:'warning',info:'neutral'};
const muteChoices=[{minutes:60,label:'alarms.mute.hour'},{minutes:240,label:'alarms.mute.hours4'},{minutes:1440,label:'alarms.mute.day'},{minutes:10080,label:'alarms.mute.days7'}] as const;
const endpoint='/api/alerts';

/** The localized text of a failed alarm action, by error code; never a raw status. */
export function alarmFailure(failure:unknown,t:Translate):string{
 if(failure instanceof ApiError){
  if(failure.code==='ALERT_INVALID')return t('alarms.error.invalid');
  if(failure.status===403)return t('alarms.blocked.right');
  if(failure.code==='ALERT_STATE_CHANGED'||failure.status===404||failure.status===409)return t('alarms.error.changed');
 }
 return t('alarms.error.changed');
}

type ActionTarget={alert:OpenAlert;device:Device};
/**
 * The row menu of an open alarm: acknowledge, mute, unmute (only while muted)
 * and open device. Without alerts.manage on the device, or in demo mode, the
 * state entries stay visible and say why they are blocked.
 */
export function alarmMenu({alert,device}:ActionTarget,viewer:Viewer,demo:boolean,t:Translate,actions:{onAcknowledge:()=>void;onMute:()=>void;onUnmute:()=>void;onOpen?:()=>void;busy?:boolean}):MenuEntry[]{
 const locked=demo?t('kit.unavailable.demo'):!permitted(device,viewer,'alerts.manage')?t('alarms.blocked.right'):actions.busy?t('fleet.menu.saving'):undefined;
 return [
  {id:'acknowledge',label:t('alarms.menu.acknowledge'),icon:Check,blocked:locked??(alert.acknowledged?t('alarms.blocked.acknowledged'):undefined),onSelect:actions.onAcknowledge},
  {id:'mute',label:t('alarms.menu.mute'),icon:BellOff,blocked:locked,onSelect:actions.onMute},
  ...(alert.muted?[{id:'unmute',label:t('alarms.menu.unmute'),icon:Bell,blocked:locked,onSelect:actions.onUnmute}]:[]),
  ...(actions.onOpen?[{id:'separator',separator:true as const},{id:'open',label:t('alarms.menu.openDevice'),icon:ChevronRight,onSelect:actions.onOpen}]:[]),
 ];
}

/** The actions of the row menu and the mute drawer, shared by the tab and the device history. */
function useAlarmActions({viewer,demo,onRefresh}:{viewer:Viewer;demo:boolean;onRefresh:()=>Promise<void>|void}){
 const t=useT(),[locale]=useLocale();
 const [busy,setBusy]=useState(false),[muting,setMuting]=useState<ActionTarget|null>(null);
 const send=async(payload:Record<string,unknown>,success:(result:{mutedUntil:number|null})=>string)=>{
  setBusy(true);
  try{const result=await api<{ok:true;mutedUntil:number|null}>(endpoint,payload);toast.success(success(result));await onRefresh();return true;}
  catch(failure){toast.error(alarmFailure(failure,t));return false;}
  finally{setBusy(false);}
 };
 const menu=(target:ActionTarget,onOpen?:()=>void)=>alarmMenu(target,viewer,demo,t,{busy,onOpen,
  onAcknowledge:()=>void send({action:'acknowledge',id:target.alert.id},()=>t('alarms.acknowledged')),
  onMute:()=>setMuting(target),
  onUnmute:()=>void send({action:'unmute',id:target.alert.id},()=>t('alarms.unmuted')),
 });
 const drawer=<MuteDrawer key={muting?.alert.id??''} target={muting} busy={busy} onClose={()=>setMuting(null)}
  onMute={minutes=>{if(!muting)return;void send({action:'mute',id:muting.alert.id,minutes},result=>t('alarms.muted',{time:exactTime(result.mutedUntil,locale)})).then(done=>{if(done)setMuting(null);});}}/>;
 return {menu,drawer};
}

/** "Mute alarm": one of four durations, 1 hour by default. */
function MuteDrawer({target,busy,onClose,onMute}:{target:ActionTarget|null;busy:boolean;onClose:()=>void;onMute:(minutes:number)=>void}){
 const t=useT(),[locale]=useLocale(),formId=useId();
 const [minutes,setMinutes]=useState<number>(60);
 if(!target)return null;
 const text=alarmText(target.alert,locale);
 const submit=(event:FormEvent)=>{event.preventDefault();if(!busy)onMute(minutes);};
 return <Drawer open onClose={onClose} title={t('alarms.mute.title')} description={<><strong>{target.device.name}</strong> · {text.rule}: {text.title}</>}
  footer={<><Btn onClick={onClose} disabled={busy}>{t('common.cancel')}</Btn><Btn variant="primary" type="submit" form={formId} icon={BellOff} loading={busy}>{t('alarms.mute.submit')}</Btn></>}>
  <form id={formId} className="sdx-form-grid" onSubmit={submit}>
   <p className="sdx-inline-note">{t('alarms.mute.text')}</p>
   <div className="sdx-pick-list" role="radiogroup" aria-label={t('alarms.mute.duration')}>
    {muteChoices.map(choice=><PickRow key={choice.minutes} selected={minutes===choice.minutes} icon={<Clock size={15} aria-hidden/>} label={t(choice.label)} onSelect={()=>setMinutes(choice.minutes)}/>)}
   </div>
  </form>
 </Drawer>;
}

function LevelPill({level}:{level:AlertLevel}){const t=useT();return <StatusPill kind={levelKind[level]}>{t(alarmLevelKeys[level])}</StatusPill>;}
/** The peak in the rule unit; without one the shared placeholder, named "Not used". */
function Peak({alert}:{alert:Pick<OpenAlert,'ruleId'|'peakValue'>}){
 const t=useT(),[locale]=useLocale(),value=alarmPeak(alert,locale);
 return value===null?<span className="sdx-muted-cell" role="img" aria-label={t('alertRules.notUsed')}>{EMPTY_VALUE}</span>:<span className="mono">{value}</span>;
}
function AlarmCell({alert,now}:{alert:Pick<OpenAlert,'ruleId'|'params'>;now:number}){
 const [locale]=useLocale(),text=alarmText(alert,locale,now);
 // An agent reason the catalog does not know follows the title as received, in mono (ui/base/agent-reasons.ts).
 return <span className="sdx-alarm-cell"><strong>{text.rule}</strong><small title={text.detail||undefined}>{text.title}</small>{text.unknown?.map((line,index)=><small key={index} className="mono sdx-agent-reason">{line}</small>)}</span>;
}

export type AlarmSortColumn='level'|'device'|'alarm'|'since';
/** The default sort: the order of alarmRows (critical first, then the oldest). */
export const defaultAlarmSort:TableSort<AlarmSortColumn>={column:'level',direction:'desc'};
/** The filtered rows in the sort: alarmRows order in, sortTableRows out. */
export function sortedAlarmRows<R extends AlarmRow>(rows:readonly R[],sort:TableSort<AlarmSortColumn>|null,locale:Locale):R[]{
 const rank=inputRank(rows);
 return sortTableRows(rows,sort,{level:row=>-rank(row),device:row=>row.device.name,alarm:row=>alarmText(row.alert,locale).rule,since:row=>row.alert.startedAt});
}
/** The worst level with open alarms; its filter count carries its tone (the focal point of the toolbar). */
export const worstAlarmLevel=(counts:Record<AlarmLevelFilter,number>):AlertLevel|null=>counts.critical?'critical':counts.warning?'warning':counts.info?'info':null;

type TabProps={
 /** The scoped devices of the view. */
 devices:Device[];viewer:Viewer;demo:boolean;
 /** Pins the time (tests); without it the tab follows the console clock. */
 now?:number;
 /** Several customers in the portal (not in demo mode): the CSV has a customer column; the table column and the filter show when the devices belong to two or more customers. */
 customerColumn:boolean;
 onOpen:(id:string)=>void;onRefresh:()=>Promise<void>|void;
 /** Switches the view to its Devices tab (the empty state without alarms, when the scope has no Alert rules tab). */
 onShowDevices:()=>void;
 /** Switches the view to its Alert rules tab, where the scope has one. */
 onOpenAlertRules?:()=>void;
 /** The filters at the start; the console mounts one tab per scope, so they reset with the scope. */
 initialFilter?:AlarmFilter;
};

/** The scope view Monitoring › By alarm: the open alarms of the devices in the scope. */
export default function AlarmsTab({devices,viewer,demo,now:pinnedNow,customerColumn,onOpen,onRefresh,onShowDevices,onOpenAlertRules,initialFilter=noAlarmFilter}:TabProps){
 const now=useClockNow(pinnedNow);
 const t=useT(),[locale]=useLocale();
 const [filter,setFilter]=useState<AlarmFilter>(initialFilter),[sort,setSort]=useState<TableSort<AlarmSortColumn>>(defaultAlarmSort);
 const rows=useMemo(()=>alarmRows(devices),[devices]);
 const counts=useMemo(()=>alarmCounts(rows),[rows]);
 const customers=useMemo(()=>alarmCustomerOptions(rows),[rows]),groups=useMemo(()=>alarmGroupOptions(rows),[rows]);
 // The customer column and filter follow the Devices tab: only when the devices belong to two or more customers.
 const shownCustomer=customerColumn&&customerColumnDistinguishes(devices);
 const activeFilter:AlarmFilter={level:filter.level,customer:shownCustomer&&customers.some(item=>item.id===filter.customer)?filter.customer:'',group:groups.some(item=>item.id===filter.group)?filter.group:''};
 const visible=sortedAlarmRows(filterAlarmRows(rows,activeFilter),sort,locale);
 const {menu,drawer}=useAlarmActions({viewer,demo,onRefresh});
 const reset=()=>setFilter(noAlarmFilter);
 const exportCsv=()=>{
  if(!visible.length)return;
  try{downloadText(alarmsCsvFileName(now,locale),alarmsCsv(visible,{customer:customerColumn},locale,now),'text/csv;charset=utf-8');toast.success(t('alarms.exported'));}
  catch{toast.error(t('csv.exportFailed'));}
 };
 const levels:AlarmLevelFilter[]=['all','critical','warning','info'],worst=worstAlarmLevel(counts);
 type Row=typeof visible[number];
 const columns:DataColumn<Row>[]=[
  {id:'level',label:t('alarms.column.level'),sort:{first:'desc'},cell:row=><LevelPill level={row.alert.level}/>},
  {id:'device',label:t('alarms.column.device'),primary:true,sort:{first:'asc'},cell:row=>row.device.name},
  ...(shownCustomer?[{id:'customer',label:t('alarms.column.customer'),cell:(row:Row)=><span className="sdx-muted-cell">{row.device.customerName?.trim()||EMPTY_VALUE}</span>}]:[]),
  {id:'alarm',label:t('alarms.column.alarm'),sort:{first:'asc'},cell:row=><AlarmCell alert={row.alert} now={now}/>},
  {id:'peak',label:t('alarms.column.peak'),cell:row=><Peak alert={row.alert}/>},
  {id:'since',label:t('alarms.column.since'),sort:{first:'asc'},cell:row=><span title={exactTime(row.alert.startedAt,locale)}>{relativeTime(row.alert.startedAt,now,locale)}</span>},
  {id:'status',label:t('alarms.column.status'),cell:row=><span className="sdx-muted-cell">{alarmStatus(row.alert,locale)}</span>},
  {id:'actions',label:t('alarms.column.actions'),hideLabel:true,className:'sdx-col-actions',cell:row=><Menu label={t('alarms.actionsFor',{name:alarmText(row.alert,locale,now).rule})} entries={menu(row,()=>onOpen(row.device.id))}/>},
 ];
 const toolbar=<Toolbar filters={<>
   <Segmented<AlarmLevelFilter> label={t('alarms.column.level')} size="sm" value={filter.level} onChange={level=>setFilter({...filter,level})} items={levels.map(level=>({id:level,label:level==='all'?t('alarms.level.all'):t(alarmLevelKeys[level]),count:counts[level],...(level==='all'?{}:{tone:worst===level?levelKind[level]:undefined})}))}/>
   {shownCustomer&&<Select size="sm" aria-label={t('alarms.filter.customer')} value={activeFilter.customer} onChange={event=>setFilter({...filter,customer:event.target.value})}><option value="">{t('alarms.filter.allCustomers')}</option>{customers.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</Select>}
   {/* The group filter only while an alarm row has a group; without one, activeFilter.group is empty and no group filter applies. */}
   {groups.length>0&&<Select size="sm" aria-label={t('alarms.filter.group')} value={activeFilter.group} onChange={event=>setFilter({...filter,group:event.target.value})}><option value="">{t('alarms.filter.allGroups')}</option>{groups.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</Select>}
  </>}
  actions={<IconBtn icon={Download} label={t('alarms.csv')} className="sdx-icon-btn-framed" blocked={visible.length?undefined:t('alarms.nothingToExport')} onClick={exportCsv}/>}/>;
 const empty:EmptyProps=!rows.length
  ?{icon:Siren,title:t('alarms.empty.title'),children:t('alarms.empty.text'),action:onOpenAlertRules?<Btn icon={BellRing} onClick={onOpenAlertRules}>{t('fleet.analysis.openAlertRules')}</Btn>:<ShowDevicesAction onShowDevices={onShowDevices}/>}
  :{icon:Search,title:t('alarms.filtered.title'),children:t('alarms.filtered.text'),action:<ResetAction label={t('alarms.resetFilters')} onReset={reset}/>};
 return <AnalysisTab title={t('fleet.alarms.byAlarm')} description={t('alarms.meta')} className="sdx-alarms">
  <DataTable<Row> label={t('fleet.alarms.byAlarm')} toolbar={toolbar} columns={columns} rows={visible} rowKey={row=>row.alert.id}
   sort={sort} onSort={next=>setSort(next as TableSort<AlarmSortColumn>)} onOpen={row=>onOpen(row.device.id)}
   empty={empty} foot={t('alarms.foot',{count:rows.length,shown:visible.length})} cards entranceId="alarm-rows"/>
  {drawer}
 </AnalysisTab>;
}

type HistoryPage={alerts:AlertHistoryEntry[];next:string|null};
/**
 * The device Monitoring › Alarms: open alarms first (from the
 * console data, with the row menu), then the closed ones from GET /api/alerts,
 * newest first, page by page. Demo mode shows the sample alarms and no closed history.
 * The section has the AnalysisTab head (sr-only title, description) like the scope subtabs and device Alert rules.
 */
export function AlarmHistory({device,viewer,demo,now,onRefresh,summary}:{device:Device;viewer:Viewer;demo:boolean;now:number;onRefresh:()=>Promise<void>|void;
 /** The Monitoring summary row of the device, right below the head (the focal point above the alarm table). */
 summary?:ReactNode}){
 const t=useT();
 const [pages,setPages]=useState<{key:string;alerts:AlertHistoryEntry[];next:string|null}|null>(null),[error,setError]=useState(false),[loading,setLoading]=useState(false);
 const sequence=useRef(0),mounted=useRef(true);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 const open=useMemo(()=>device.alerts??[],[device.alerts]);
 // A changed set of open alarms (one closed, one opened) reloads the first page.
 const openKey=open.map(alert=>alert.id).join(',');
 const load=useCallback(async(cursor:string|null)=>{
  if(demo)return;
  const current=++sequence.current;setLoading(true);
  try{
   const page=await api<HistoryPage>(`${endpoint}?${new URLSearchParams({serverId:device.id,limit:'50',...(cursor?{before:cursor}:{})})}`);
   if(!mounted.current||current!==sequence.current)return;
   setPages(previous=>({key:device.id,alerts:cursor&&previous?.key===device.id?[...previous.alerts,...page.alerts]:page.alerts,next:page.next}));setError(false);
  }catch{if(mounted.current&&current===sequence.current)setError(true);}
  finally{if(mounted.current&&current===sequence.current)setLoading(false);}
 },[demo,device.id]);
 useEffect(()=>{queueMicrotask(()=>void load(null));},[load,openKey]);
 const {menu,drawer}=useAlarmActions({viewer,demo,onRefresh});
 const loaded=demo||pages?.key===device.id;
 const rows=alarmHistoryRows(open,loaded&&!demo?pages?.alerts??[]:[]),next=demo?null:pages?.next??null;
 return <AnalysisTab title={t('alarms.title')} description={t('alarms.history.meta')} className="sdx-alarm-history">
  {summary}
  {error&&<Notice tone="danger" icon={AlertTriangle} action={<RetryAction loading={loading} onRetry={()=>void load(null)}/>}>{t('alarms.history.loadFailed')}{pages?' '+t('alertRules.staleData'):''}</Notice>}
  {!loaded&&!error?<Skeleton variant="table" label={t('alarms.history.loading')}/>
   :<><AlarmHistoryTable rows={rows} now={now} menu={row=>menu({alert:row,device})}/>
   {next&&<div className="sdx-table-foot"><Btn size="sm" loading={loading} onClick={()=>void load(next)}>{t('alarms.history.loadMore')}</Btn></div>}
   </>}
  {drawer}
 </AnalysisTab>;
}

/** The table of the device alarm history: open rows keep the row menu; an empty history says so. */
export function AlarmHistoryTable({rows,now,menu}:{rows:readonly AlertHistoryEntry[];now:number;menu:(row:AlertHistoryEntry)=>MenuEntry[]}){
 const t=useT(),[locale]=useLocale();
 const columns:DataColumn<AlertHistoryEntry>[]=[
  {id:'level',label:t('alarms.history.column.level'),cell:row=><LevelPill level={row.peakLevel}/>},
  {id:'alarm',label:t('alarms.history.column.alarm'),primary:true,cell:row=><><AlarmCell alert={row} now={now}/>{row.state==='open'&&(row.acknowledged||row.muted)&&<small className="sdx-alarm-status">{alarmStatus(row,locale)}</small>}</>},
  {id:'start',label:t('alarms.history.column.start'),cell:row=><span title={exactTime(row.startedAt,locale)}>{relativeTime(row.startedAt,now,locale)}</span>},
  {id:'end',label:t('alarms.history.column.end'),cell:row=>row.closedAt===null?<span className="sdx-tag">{t('alarms.history.stillOpen')}</span>:<span title={exactTime(row.closedAt,locale)}>{relativeTime(row.closedAt,now,locale)}</span>},
  {id:'duration',label:t('alarms.history.column.duration'),mono:true,cell:row=>alarmDuration(row.startedAt,row.closedAt??now,locale)},
  {id:'peak',label:t('alarms.history.column.peak'),cell:row=><Peak alert={row}/>},
  {id:'reason',label:t('alarms.history.column.reason'),cell:row=><span className="sdx-muted-cell">{row.closeReason?t(closeReasonKeys[row.closeReason]):EMPTY_VALUE}</span>},
  {id:'actions',label:t('alarms.column.actions'),hideLabel:true,className:'sdx-col-actions',cell:row=>row.state==='open'?<Menu label={t('alarms.actionsFor',{name:alarmText(row,locale,now).rule})} entries={menu(row)}/>:null},
 ];
 return <DataTable<AlertHistoryEntry> label={t('alarms.title')} columns={columns} rows={rows} rowKey={row=>row.id} cards
  empty={{icon:Siren,title:t('alarms.history.empty.title'),children:t('alarms.history.empty.text')}}/>;
}
