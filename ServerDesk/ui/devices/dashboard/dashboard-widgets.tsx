'use client';
// The widgets of the Dashboard (docs/dashboard.md). Each is a kit Card that leads with one number (CountUp); what it
// shows beyond that follows its size (widgetShape): a breakdown bar and its legend, a list whose rows open the place
// where the user acts, day bars or the heatmap. An empty widget shows a calm illustration, the fact and one action
// (in a single row: the number 0 with the fact). The numbers and rows come from dashboard-model.ts and
// dashboard-widgets-model.ts; a row is a link with the console hash, and a plain click hands the hash to onNavigate
// so the console opens it with a history entry.
import type {ReactNode} from 'react';
import {AlertTriangle,Building2,Info,OctagonAlert,TriangleAlert} from 'lucide-react';
import type {AlertLevel} from '@/lib/alert-rules';
import {consoleRouteHash} from '@/lib/console-route';
import {protectionStatusKeys} from '@/lib/defender';
import type {DashboardWidgetId} from '@/lib/dashboard-layout';
import {formatBytes,formatDate,formatPercent} from '@/lib/i18n/format';
import type {MessageKey} from '@/lib/i18n/translate';
import type {AuditEntry,Job,Viewer} from '@/lib/types';
import type {Device} from '@/ui/base/api';
import {useClockNow} from '@/ui/base/clock-store';
import {healthStateKeys,type HealthState} from '@/ui/base/health-score';
import {useLocale,useT} from '@/ui/base/locale';
import {deviceConnection,rebootLabels} from '@/ui/base/ui-device';
import {IconTile,Notice,RetryAction,Skeleton,StatusPill,connectionPillKind,exactTime,relativeTime,type StatusKind} from '@/ui/kit/kit';
import {DeviceTypeMark} from '@/ui/devices/device/device-type-mark';
import {auditActionView,auditTargetView} from '@/ui/devices/history/audit-display';
import {useActionLabel} from '@/ui/devices/history/activity-table';
import {bitlockerStatusKey,certificateStatusText,diskHealthStatusKey,osSupportText} from '@/ui/devices/inventory/health-signals';
import {alarmDuration,alarmLevelKeys,alarmText} from '@/ui/devices/monitoring/alarms-view';
import {JobList,recentJobs} from '@/ui/shell/jobs';
import {DashboardHeatmap} from '@/ui/devices/dashboard/dashboard-heatmap';
import {alarmWeekGrid,alarmsWidget,jobsWidget,offlineWidget,updatesWidget,widgetShape,type WeekGrid,type WidgetShape} from '@/ui/devices/dashboard/dashboard-model';
import {Breakdown,DayBars,EmptyWidget,Figure,Go,Row,Rows,WidgetFrame,type BreakdownItem,type WidgetBase} from '@/ui/devices/dashboard/dashboard-widget-parts';
import {activityWidget,agentsWidget,alarmTrend,autostartWidget,certificatesWidget,crashesWidget,customersWidget,defenderWidget,diskHealthWidget,diskSpaceWidget,encryptionWidget,failedJobsWidget,healthWidget,loadWidget,osSupportWidget,pinnedWidget,restartWidget,runbooksWidget,statusWidget,type BreakdownPart,type ConnectionPart,type DefenderPart,type EncryptionPart} from '@/ui/devices/dashboard/dashboard-widgets-model';
import type {AlarmWeekState} from '@/ui/devices/dashboard/use-alarm-week';

/** The console places the widgets link to. */
export const dashboardLinks={
 devices:consoleRouteHash({view:'devices'}),
 problems:consoleRouteHash({view:'devices',tab:'problems'}),
 alarms:consoleRouteHash({view:'devices',tab:'alarms'}),
 alertRules:consoleRouteHash({view:'devices',tab:'alerts'}),
 jobs:consoleRouteHash({view:'devices',tab:'jobs'}),
 osSupport:consoleRouteHash({view:'devices',tab:'os-support'}),
 protection:consoleRouteHash({view:'devices',tab:'protection'}),
 encryption:consoleRouteHash({view:'devices',tab:'encryption'}),
 certificates:consoleRouteHash({view:'devices',tab:'certificates'}),
 autostart:consoleRouteHash({view:'devices',tab:'autostart'}),
 reliability:consoleRouteHash({view:'devices',tab:'reliability'}),
 runbookRuns:consoleRouteHash({view:'automation',page:'runbooks',tab:'runs'}),
 audit:consoleRouteHash({view:'settings',page:'audit'}),
 customer:(customerId:string)=>consoleRouteHash({view:'devices',customerId}),
 device:(deviceId:string)=>consoleRouteHash({view:'device',deviceId}),
 deviceAlarms:(deviceId:string)=>consoleRouteHash({view:'device',deviceId,deviceSection:'monitoring'}),
 deviceUpdates:(deviceId:string)=>consoleRouteHash({view:'device',deviceId,deviceSection:'management',deviceDetail:'updates'}),
 deviceStorage:(deviceId:string)=>consoleRouteHash({view:'device',deviceId,deviceSection:'management',deviceDetail:'storage'}),
 deviceDefender:(deviceId:string)=>consoleRouteHash({view:'device',deviceId,deviceSection:'management',deviceDetail:'defender'}),
 deviceCertificates:(deviceId:string)=>consoleRouteHash({view:'device',deviceId,deviceSection:'software',deviceDetail:'certificates'}),
 deviceAutostart:(deviceId:string)=>consoleRouteHash({view:'device',deviceId,deviceSection:'software',deviceDetail:'autostart'}),
 deviceDisks:(deviceId:string)=>consoleRouteHash({view:'device',deviceId,deviceSection:'hardware',deviceDetail:'storage'}),
 deviceEvents:(deviceId:string)=>consoleRouteHash({view:'device',deviceId,deviceSection:'diagnostics',deviceDetail:'events'}),
 deviceAccess:(deviceId:string)=>consoleRouteHash({view:'device',deviceId,deviceSection:'history',deviceDetail:'access'}),
} as const;

// What a widget's clock-derived texts change with: the minute for durations, the hour for the heatmap's current cell.
const minuteKey=(now:number)=>Math.floor(now/60_000),hourKey=(now:number)=>Math.floor(now/3_600_000);
type Devices={servers:readonly Device[]};
const mark=(device:Device)=><DeviceTypeMark server={device} size="sm"/>;
/** A breakdown as the bar shows it: each part with its name. */
const named=<K extends string>(parts:readonly BreakdownPart<K>[],label:(id:K)=>string):BreakdownItem[]=>parts.map(item=>({...item,label:label(item.id)}));
/** The rows a widget with a breakdown lists: one less than its shape holds while the legend stands above the list. */
const rowsBelowLegend=(shape:WidgetShape)=>shape.split?shape.rows:Math.max(0,shape.rows-1);
/** The parts every widget frame takes from its props. */
const frame=(id:DashboardWidgetId,{size,edit}:WidgetBase)=>({id,size,edit});

const levelIcons:Readonly<Record<AlertLevel,typeof Info>>={critical:OctagonAlert,warning:TriangleAlert,info:Info};
const levelPills:Readonly<Record<AlertLevel,StatusKind>>={critical:'critical',warning:'warning',info:'neutral'};
const levels:readonly AlertLevel[]=['critical','warning','info'];
function LevelMark({level}:{level:AlertLevel}){
 const t=useT(),Icon=levelIcons[level];
 return <span className={'sdx-dash-level sdx-dash-level-'+level}><Icon size={16} aria-hidden/><span className="sr-only">{t(alarmLevelKeys[level])}</span></span>;
}

// ---- Monitoring ----------------------------------------------------------------------

export function AlarmsWidget({servers,...base}:Devices&WidgetBase){
 const t=useT(),[locale]=useLocale(),now=useClockNow(undefined,minuteKey),model=alarmsWidget(servers),shape=widgetShape(base.size),{onNavigate}=base;
 if(!model.count)return <WidgetFrame {...frame('alarms',base)} empty={<EmptyWidget id="alarms" shape={shape} art="alarms" title={t('dashboard.alarms.empty')} text={t('dashboard.alarms.emptyText')} action={<Go href={dashboardLinks.alertRules} onNavigate={onNavigate}>{t('dashboard.alarms.showRules')}</Go>}/>}/>;
 const tone=model.levels.critical?'danger':model.levels.warning?'warning':undefined;
 return <WidgetFrame {...frame('alarms',base)} tone={tone??'accent'} action={<Go href={dashboardLinks.alarms} onNavigate={onNavigate}>{t('dashboard.alarms.showAll')}</Go>}
  lead={<Figure id="alarms" value={model.count} tone={tone}>
   {levels.filter(level=>model.levels[level]>0).map(level=><StatusPill key={level} kind={levelPills[level]} size="sm">{t('dashboard.alarms.levelCount',{level:t(alarmLevelKeys[level]),count:model.levels[level]})}</StatusPill>)}
  </Figure>}
  list={<Rows items={model.rows} shape={shape} more={dashboardLinks.alarms} onNavigate={onNavigate} render={({alert,device})=><Row key={alert.id} href={dashboardLinks.deviceAlarms(device.id)} onNavigate={onNavigate}
   lead={<LevelMark level={alert.level}/>} title={alarmText(alert,locale,now).title} sub={device.name}
   meta={t('dashboard.alarms.since',{duration:alarmDuration(alert.startedAt,now,locale)})} metaTitle={exactTime(alert.startedAt,locale)}/>}/>}/>;
}

/** The states the two widgets of the alarm week share: a failed load with its retry, the first load, and a week without an alarm. */
function weekState(id:'alarm-week'|'alarm-trend',state:AlarmWeekState,base:WidgetBase,now:number,t:ReturnType<typeof useT>):{grid:WeekGrid;failed:ReactNode}|{view:ReactNode}{
 const shape=widgetShape(base.size);
 // A failed load says so and offers the retry; counts from an earlier load stay below it.
 const failed=state.error?<Notice tone="danger" icon={AlertTriangle} action={<RetryAction loading={state.loading} onRetry={state.retry}/>}>{state.error}{state.week?' '+t('console.staleData'):''}</Notice>:null;
 if(!state.week)return {view:<WidgetFrame {...frame(id,base)}>{failed??<Skeleton variant="chart" label={t('dashboard.week.loading')} after={15000} action={<RetryAction onRetry={state.retry}/>}/>}</WidgetFrame>};
 const grid=alarmWeekGrid(state.week,now);
 if(!grid.total)return {view:<WidgetFrame {...frame(id,base)} empty={<>{failed}<EmptyWidget id={id} shape={shape} art="alarm-week" title={t('dashboard.week.empty')} text={t('dashboard.week.emptyText')} action={<Go href={dashboardLinks.alertRules} onNavigate={base.onNavigate}>{t('dashboard.alarms.showRules')}</Go>}/></>}/>};
 return {grid,failed};
}
/** The seven days of the alarm week as day bars: the weekday in short, and the sentence of each day. */
function useWeekDays(grid:WeekGrid|null){
 const t=useT(),[locale]=useLocale();
 if(!grid)return {days:[],label:''};
 const trend=alarmTrend(grid),days=trend.days.map(day=>({key:day.at,short:formatDate(locale,day.at,{weekday:'short'}),title:t('dashboard.trend.day',{day:formatDate(locale,day.at,{weekday:'long'}),count:day.count}),count:day.count}));
 return {trend,days,label:t('dashboard.trend.label',{days:days.map(day=>day.title).join(', ')})};
}

export function AlarmWeekWidget({state,...base}:{state:AlarmWeekState}&WidgetBase){
 const t=useT(),now=useClockNow(undefined,hourKey),week=weekState('alarm-week',state,base,now,t),bars=useWeekDays('grid' in week?week.grid:null);
 if('view' in week)return week.view;
 // From three columns the day totals stand next to the heatmap.
 return <WidgetFrame {...frame('alarm-week',base)} lead={<>{week.failed}<Figure id="alarm-week" value={week.grid.total}>{t('dashboard.week.total')}</Figure><DashboardHeatmap grid={week.grid}/></>}>
  {base.size.w>=3?<DayBars days={bars.days} label={bars.label} labels/>:null}
 </WidgetFrame>;
}

export function AlarmTrendWidget({state,...base}:{state:AlarmWeekState}&WidgetBase){
 const t=useT(),now=useClockNow(undefined,hourKey),week=weekState('alarm-trend',state,base,now,t),bars=useWeekDays('grid' in week?week.grid:null),shape=widgetShape(base.size);
 if('view' in week||!bars.trend)return 'view' in week?week.view:null;
 return <WidgetFrame {...frame('alarm-trend',base)} lead={<>{week.failed}<Figure id="alarm-trend" value={bars.trend.today}>{t('dashboard.trend.today')}<span>{t('dashboard.trend.week',{count:bars.trend.total})}</span></Figure></>}>
  <DayBars days={bars.days} label={bars.label} labels={shape.roomy}/>
 </WidgetFrame>;
}

const healthPills:Readonly<Record<HealthState,StatusKind>>={critical:'critical',warning:'warning',good:'success',unknown:'neutral'};
export function HealthWidget({servers,...base}:Devices&WidgetBase){
 const t=useT(),[locale]=useLocale(),now=useClockNow(undefined,minuteKey),model=healthWidget(servers),shape=widgetShape(base.size),{onNavigate}=base;
 const parts=<Breakdown parts={named(model.parts,id=>t(healthStateKeys[id]))} label={t('dashboard.widget.health')} legend={shape.legend}/>;
 if(!model.count)return <WidgetFrame {...frame('health',base)} tone="success" lead={shape.roomy?undefined:<><Figure id="health" value={0}>{t('dashboard.health.empty')}</Figure>{parts}</>}
  empty={shape.roomy?<EmptyWidget id="health" shape={shape} art="devices" title={t('dashboard.health.empty')} text={t('dashboard.health.emptyText')} action={<Go href={dashboardLinks.devices} onNavigate={onNavigate}>{t('dashboard.devices.show')}</Go>}/>:undefined}/>;
 return <WidgetFrame {...frame('health',base)} tone={model.critical?'danger':'warning'} action={<Go href={dashboardLinks.problems} onNavigate={onNavigate}>{t('dashboard.devices.show')}</Go>}
  lead={<><Figure id="health" value={model.count} tone={model.critical?'danger':'warning'}>{t('dashboard.attention',{count:model.count})}</Figure>{parts}</>}
  list={<Rows items={model.rows} shape={shape} limit={rowsBelowLegend(shape)} more={dashboardLinks.problems} onNavigate={onNavigate} render={({device,health,reasons})=><Row key={device.id} href={dashboardLinks.deviceAlarms(device.id)} onNavigate={onNavigate}
   lead={mark(device)} title={device.name} sub={reasons.length>1?t('dashboard.health.reasons',{reason:alarmText(reasons[0],locale,now).title,count:reasons.length-1}):reasons[0]?alarmText(reasons[0],locale,now).title:undefined}
   meta={<StatusPill kind={healthPills[health.state]} size="sm">{t(healthStateKeys[health.state])}</StatusPill>}/>}/>}/>;
}

// ---- Devices -------------------------------------------------------------------------

export function OfflineWidget({servers,...base}:Devices&WidgetBase){
 const t=useT(),[locale]=useLocale(),now=useClockNow(undefined,minuteKey),model=offlineWidget(servers,now),shape=widgetShape(base.size),{onNavigate}=base;
 const show=<Go href={dashboardLinks.devices} onNavigate={onNavigate}>{t('dashboard.devices.show')}</Go>;
 if(!model.count)return <WidgetFrame {...frame('offline',base)} empty={<EmptyWidget id="offline" shape={shape} art="offline" title={t('dashboard.offline.empty')} text={t('dashboard.offline.emptyText')} action={show}/>}/>;
 return <WidgetFrame {...frame('offline',base)} tone="warning" action={show}
  lead={<Figure id="offline" value={model.count} tone="warning">{t('dashboard.offline.of',{count:model.devices})}</Figure>}
  list={<Rows items={model.rows} shape={shape} more={dashboardLinks.devices} onNavigate={onNavigate} render={({device,since})=><Row key={device.id} href={dashboardLinks.device(device.id)} onNavigate={onNavigate}
   lead={mark(device)} title={device.name} sub={t('dashboard.offline.for',{duration:alarmDuration(since,now,locale)})}/>}/>}/>;
}

const connectionKeys:Readonly<Record<ConnectionPart,MessageKey>>={online:'device.connection.online',offline:'device.connection.offline',maintenance:'device.connection.maintenance',waiting:'device.connection.firstReportPending'};
export function StatusWidget({servers,...base}:Devices&WidgetBase){
 const t=useT(),now=useClockNow(undefined,minuteKey),model=statusWidget(servers,now),shape=widgetShape(base.size);
 return <WidgetFrame {...frame('status',base)} tone={model.devices&&model.online===model.devices?'success':'accent'}
  lead={<><Figure id="status" value={model.online}>{t('dashboard.status.onlineOf',{count:model.devices})}</Figure><Breakdown parts={named(model.parts,id=>t(connectionKeys[id]))} label={t('dashboard.widget.status')} legend={shape.legend}/></>}/>;
}

export function PinnedWidget({servers,pinnedIds,...base}:Devices&{pinnedIds:readonly string[]}&WidgetBase){
 const t=useT(),[locale]=useLocale(),now=useClockNow(undefined,minuteKey),model=pinnedWidget(servers,pinnedIds),shape=widgetShape(base.size),{onNavigate}=base;
 const show=<Go href={dashboardLinks.devices} onNavigate={onNavigate}>{t('dashboard.devices.show')}</Go>;
 if(!model.count)return <WidgetFrame {...frame('pinned',base)} empty={<EmptyWidget id="pinned" shape={shape} art="pinned" title={t('dashboard.pinned.empty')} text={t('dashboard.pinned.emptyText')} action={show}/>}/>;
 return <WidgetFrame {...frame('pinned',base)}
  lead={<Figure id="pinned" value={model.count}>{t('dashboard.pinned.detail',{count:model.count})}</Figure>}
  list={<Rows items={model.rows} shape={shape} onNavigate={onNavigate} render={device=>{
   const connection=deviceConnection(device,now,locale);
   return <Row key={device.id} href={dashboardLinks.device(device.id)} onNavigate={onNavigate} lead={mark(device)} title={device.name} sub={device.groupName??undefined}
    meta={<StatusPill kind={connectionPillKind(connection.kind)} size="sm">{connection.label}</StatusPill>}/>;
  }}/>}/>;
}

export function CustomersWidget({servers,customers,...base}:Devices&{customers:readonly {id:string;name:string}[]}&WidgetBase){
 const t=useT(),now=useClockNow(undefined,minuteKey),model=customersWidget(servers,customers,now),shape=widgetShape(base.size),{onNavigate}=base;
 return <WidgetFrame {...frame('customers',base)}
  lead={<Figure id="customers" value={model.count}>{t('dashboard.customers.detail',{count:model.count})}</Figure>}
  list={<Rows items={model.rows} shape={shape} onNavigate={onNavigate} render={row=><Row key={row.id} href={dashboardLinks.customer(row.id)} onNavigate={onNavigate}
   lead={<IconTile icon={Building2} tone="neutral" size="sm"/>} title={row.name} sub={t('dashboard.customers.devices',{count:row.devices})}
   meta={row.alarms||row.offline?<>
    {row.alarms>0&&<StatusPill kind={row.critical?'critical':'warning'} size="sm">{t('dashboard.customers.alarms',{count:row.alarms})}</StatusPill>}
    {row.offline>0&&<StatusPill kind="offline" size="sm">{t('dashboard.customers.offline',{count:row.offline})}</StatusPill>}
   </>:undefined}/>}/>}/>;
}

export function LoadWidget({servers,...base}:Devices&WidgetBase){
 const t=useT(),[locale]=useLocale(),now=useClockNow(undefined,minuteKey),model=loadWidget(servers,now),shape=widgetShape(base.size),{onNavigate}=base;
 if(!model.online)return <WidgetFrame {...frame('load',base)} empty={<EmptyWidget id="load" shape={shape} art="offline" title={t('dashboard.load.empty')} text={t('dashboard.load.emptyText')} action={<Go href={dashboardLinks.devices} onNavigate={onNavigate}>{t('dashboard.devices.show')}</Go>}/>}/>;
 const percent=(value:number|null)=>formatPercent(locale,value);
 return <WidgetFrame {...frame('load',base)} tone={model.count?'danger':'accent'}
  lead={<Figure id="load" value={model.count} tone={model.count?'danger':undefined}>{t('dashboard.load.detail')}</Figure>}
  list={<Rows items={model.rows} shape={shape} onNavigate={onNavigate} render={({device,cpu,memory,peak})=><Row key={device.id} href={dashboardLinks.device(device.id)} onNavigate={onNavigate}
   lead={mark(device)} title={device.name} sub={t('dashboard.load.values',{cpu:percent(cpu),memory:percent(memory)})} meter={{value:peak,label:t('dashboard.load.meter',{name:device.name})}}/>}/>}/>;
}

const gib=1024**3;
export function DiskSpaceWidget({servers,...base}:Devices&WidgetBase){
 const t=useT(),[locale]=useLocale(),model=diskSpaceWidget(servers),shape=widgetShape(base.size),{onNavigate}=base;
 if(!model.rows.length)return <WidgetFrame {...frame('disk-space',base)} empty={<EmptyWidget id="disk-space" shape={shape} art="devices" title={t('dashboard.diskSpace.empty')} text={t('dashboard.diskSpace.emptyText')} action={<Go href={dashboardLinks.devices} onNavigate={onNavigate}>{t('dashboard.devices.show')}</Go>}/>}/>;
 return <WidgetFrame {...frame('disk-space',base)} tone={model.count?'danger':'accent'}
  lead={<Figure id="disk-space" value={model.count} tone={model.count?'danger':undefined}>{t('dashboard.diskSpace.detail',{count:model.count})}</Figure>}
  list={<Rows items={model.rows} shape={shape} onNavigate={onNavigate} render={({device,disk,used})=><Row key={device.id+':'+disk.name} href={dashboardLinks.deviceStorage(device.id)} onNavigate={onNavigate}
   lead={mark(device)} title={device.name} sub={t('dashboard.diskSpace.volume',{volume:disk.name,free:formatBytes(locale,disk.freeGb*gib),total:formatBytes(locale,disk.totalGb*gib)})}
   meter={{value:used,label:t('dashboard.diskSpace.meter',{volume:disk.name,name:device.name})}}/>}/>}/>;
}

// ---- Updates and lifecycle -----------------------------------------------------------

export function UpdatesWidget({servers,...base}:Devices&WidgetBase){
 const t=useT(),model=updatesWidget(servers),shape=widgetShape(base.size),{onNavigate}=base;
 if(!model.count)return <WidgetFrame {...frame('updates',base)} empty={<EmptyWidget id="updates" shape={shape} art="updates" title={t('dashboard.updates.empty')} text={t('dashboard.updates.emptyText')} action={<Go href={dashboardLinks.devices} onNavigate={onNavigate}>{t('dashboard.devices.show')}</Go>}/>}/>;
 return <WidgetFrame {...frame('updates',base)}
  lead={<Figure id="updates" value={model.count}>{t('dashboard.updates.on',{count:model.devices})}</Figure>}
  list={<Rows items={model.rows} shape={shape} onNavigate={onNavigate} render={({device,pending,restart})=><Row key={device.id} href={dashboardLinks.deviceUpdates(device.id)} onNavigate={onNavigate}
   lead={mark(device)} title={device.name} sub={t('dashboard.updates.count',{count:pending})}
   meta={restart?<StatusPill kind="warning" size="sm">{t('dashboard.updates.restart')}</StatusPill>:undefined}/>}/>}/>;
}

export function RestartWidget({servers,...base}:Devices&WidgetBase){
 const t=useT(),model=restartWidget(servers),shape=widgetShape(base.size),{onNavigate}=base;
 if(!model.count)return <WidgetFrame {...frame('restart',base)} empty={<EmptyWidget id="restart" shape={shape} art="updates" title={t('dashboard.restart.empty')} text={t('dashboard.restart.emptyText')} action={<Go href={dashboardLinks.devices} onNavigate={onNavigate}>{t('dashboard.devices.show')}</Go>}/>}/>;
 return <WidgetFrame {...frame('restart',base)} tone="warning"
  lead={<Figure id="restart" value={model.count} tone="warning">{t('dashboard.restart.detail',{count:model.count})}</Figure>}
  list={<Rows items={model.rows} shape={shape} onNavigate={onNavigate} render={({device,reason})=><Row key={device.id} href={dashboardLinks.device(device.id)} onNavigate={onNavigate}
   lead={mark(device)} title={device.name} sub={t(reason&&Object.hasOwn(rebootLabels,reason)?rebootLabels[reason]:'device.issue.rebootDetail')}/>}/>}/>;
}

const supportKeys={ended:'osSupport.status.ended',ending:'osSupport.status.ending',supported:'osSupport.status.supported',unknown:'osSupport.status.unknown'} as const satisfies Record<string,MessageKey>;
export function OsSupportWidget({servers,...base}:Devices&WidgetBase){
 const t=useT(),[locale]=useLocale(),model=osSupportWidget(servers),shape=widgetShape(base.size),{onNavigate}=base;
 const tone=model.ended?'danger':model.count?'warning':undefined;
 return <WidgetFrame {...frame('os-support',base)} tone={tone??'success'} action={<Go href={dashboardLinks.osSupport} onNavigate={onNavigate}>{t('dashboard.osSupport.show')}</Go>}
  lead={<><Figure id="os-support" value={model.count} tone={tone}>{model.count?t('dashboard.osSupport.detail',{count:model.count}):t('dashboard.osSupport.empty')}</Figure><Breakdown parts={named(model.parts,id=>t(supportKeys[id]))} label={t('dashboard.widget.osSupport')} legend={shape.legend}/></>}
  list={<Rows items={model.rows} shape={shape} limit={rowsBelowLegend(shape)} more={dashboardLinks.osSupport} onNavigate={onNavigate} render={({device,support})=><Row key={device.id} href={dashboardLinks.device(device.id)} onNavigate={onNavigate}
   lead={mark(device)} title={device.name} sub={osSupportText(support,locale).text}/>}/>}/>;
}

export function AgentsWidget({servers,...base}:Devices&WidgetBase){
 const t=useT(),model=agentsWidget(servers),shape=widgetShape(base.size),{onNavigate}=base;
 if(!model.newest)return <WidgetFrame {...frame('agents',base)} empty={<EmptyWidget id="agents" shape={shape} art="devices" title={t('dashboard.agents.empty')} text={t('dashboard.agents.emptyText')} action={<Go href={dashboardLinks.devices} onNavigate={onNavigate}>{t('dashboard.devices.show')}</Go>}/>}/>;
 const partKeys={newest:'dashboard.agents.newest',older:'dashboard.agents.older'} as const;
 return <WidgetFrame {...frame('agents',base)}
  lead={<><Figure id="agents" value={model.count}>{t('dashboard.agents.detail',{count:model.count})}</Figure><Breakdown parts={named(model.parts,id=>t(partKeys[id]))} label={t('dashboard.widget.agents')} legend={shape.legend}/></>}
  list={<Rows items={model.rows} shape={shape} limit={rowsBelowLegend(shape)} onNavigate={onNavigate} render={row=><Row key={row.version} onNavigate={onNavigate} title={row.version} mono
   sub={t('dashboard.agents.devices',{count:row.count})} meta={row.version===model.newest?<StatusPill kind="success" size="sm">{t('dashboard.agents.newest')}</StatusPill>:undefined}/>}/>}/>;
}

// ---- Security ------------------------------------------------------------------------

const defenderKeys:Readonly<Record<DefenderPart,MessageKey>>={threat:'protection.status.threat',off:'protection.status.off','scan-old':'protection.status.scanOld',protected:'protection.status.protected',other:'dashboard.part.other'};
export function DefenderWidget({servers,...base}:Devices&WidgetBase){
 const t=useT(),model=defenderWidget(servers),shape=widgetShape(base.size),{onNavigate}=base;
 const tone=model.urgent?'danger':model.count?'warning':undefined;
 return <WidgetFrame {...frame('defender',base)} tone={tone??'success'} action={<Go href={dashboardLinks.protection} onNavigate={onNavigate}>{t('dashboard.defender.show')}</Go>}
  lead={<><Figure id="defender" value={model.count} tone={tone}>{model.count?t('dashboard.attention',{count:model.count}):t('dashboard.defender.empty')}</Figure><Breakdown parts={named(model.parts,id=>t(defenderKeys[id]))} label={t('dashboard.widget.defender')} legend={shape.legend}/></>}
  list={<Rows items={model.rows} shape={shape} limit={rowsBelowLegend(shape)} more={dashboardLinks.protection} onNavigate={onNavigate} render={({device,status})=><Row key={device.id} href={dashboardLinks.deviceDefender(device.id)} onNavigate={onNavigate}
   lead={mark(device)} title={device.name} sub={t(protectionStatusKeys[status])}/>}/>}/>;
}

const encryptionKeys:Readonly<Record<EncryptionPart,MessageKey>>={encrypted:'bitlocker.status.encrypted',encrypting:'bitlocker.status.encrypting','not-encrypted':'bitlocker.status.notEncrypted',suspended:'bitlocker.status.suspended',none:'health.state.unknown'};
export function EncryptionWidget({servers,...base}:Devices&WidgetBase){
 const t=useT(),model=encryptionWidget(servers),shape=widgetShape(base.size),{onNavigate}=base;
 return <WidgetFrame {...frame('encryption',base)} tone={model.count?'warning':'success'} action={<Go href={dashboardLinks.encryption} onNavigate={onNavigate}>{t('dashboard.encryption.show')}</Go>}
  lead={<><Figure id="encryption" value={model.count} tone={model.count?'warning':undefined}>{model.count?t('dashboard.encryption.detail',{count:model.count}):t('dashboard.encryption.empty')}</Figure><Breakdown parts={named(model.parts,id=>t(encryptionKeys[id]))} label={t('dashboard.widget.encryption')} legend={shape.legend}/></>}
  list={<Rows items={model.rows} shape={shape} limit={rowsBelowLegend(shape)} more={dashboardLinks.encryption} onNavigate={onNavigate} render={({device,status})=><Row key={device.id} href={dashboardLinks.device(device.id)} onNavigate={onNavigate}
   lead={mark(device)} title={device.name} sub={t(bitlockerStatusKey(status))}/>}/>}/>;
}

export function CertificatesWidget({servers,...base}:Devices&WidgetBase){
 const t=useT(),[locale]=useLocale(),now=useClockNow(undefined,hourKey),model=certificatesWidget(servers,now),shape=widgetShape(base.size),{onNavigate}=base;
 const show=<Go href={dashboardLinks.certificates} onNavigate={onNavigate}>{t('dashboard.certificates.show')}</Go>;
 if(!model.count)return <WidgetFrame {...frame('certificates',base)} tone="success" empty={<EmptyWidget id="certificates" shape={shape} art="certificates" title={t('dashboard.certificates.empty')} text={t('dashboard.certificates.emptyText')} action={show}/>}/>;
 return <WidgetFrame {...frame('certificates',base)} tone={model.expired?'danger':'warning'} action={show}
  lead={<Figure id="certificates" value={model.count} tone={model.expired?'danger':'warning'}>
   {model.expired>0&&<StatusPill kind="critical" size="sm">{t('dashboard.certificates.expired',{count:model.expired})}</StatusPill>}
   {model.expiring>0&&<StatusPill kind="warning" size="sm">{t('dashboard.certificates.expiring',{count:model.expiring})}</StatusPill>}
  </Figure>}
  list={<Rows items={model.rows} shape={shape} more={dashboardLinks.certificates} onNavigate={onNavigate} render={row=><Row key={row.deviceId+':'+row.cert.thumbprint} href={dashboardLinks.deviceCertificates(row.deviceId)} onNavigate={onNavigate}
   lead={<LevelMark level={row.status==='expired'?'critical':'warning'}/>} title={row.cert.subject} sub={row.deviceName} meta={certificateStatusText(row.cert,now,locale)} metaTitle={exactTime(row.cert.notAfter,locale)}/>}/>}/>;
}

export function AutostartWidget({servers,...base}:Devices&WidgetBase){
 const t=useT(),model=autostartWidget(servers),shape=widgetShape(base.size),{onNavigate}=base;
 const show=<Go href={dashboardLinks.autostart} onNavigate={onNavigate}>{t('dashboard.autostart.show')}</Go>;
 if(!model.count)return <WidgetFrame {...frame('autostart',base)} empty={<EmptyWidget id="autostart" shape={shape} art="jobs" title={t('dashboard.autostart.empty')} text={t('dashboard.autostart.emptyText')} action={show}/>}/>;
 return <WidgetFrame {...frame('autostart',base)} tone={model.suspicious?'warning':'accent'} action={show}
  lead={<Figure id="autostart" value={model.count} tone={model.suspicious?'warning':undefined}>{model.suspicious?<StatusPill kind="warning" size="sm">{t('dashboard.autostart.suspiciousCount',{count:model.suspicious})}</StatusPill>:t('dashboard.autostart.detail',{count:model.count})}</Figure>}
  list={<Rows items={model.rows} shape={shape} more={dashboardLinks.autostart} onNavigate={onNavigate} render={({device,entry})=><Row key={device.id+':'+entry.id} href={dashboardLinks.deviceAutostart(device.id)} onNavigate={onNavigate}
   lead={mark(device)} title={entry.name} sub={device.name} meta={entry.suspicious?<StatusPill kind="warning" size="sm">{t('dashboard.autostart.suspicious')}</StatusPill>:undefined}/>}/>}/>;
}

// ---- Hardware ------------------------------------------------------------------------

export function DiskHealthWidget({servers,...base}:Devices&WidgetBase){
 const t=useT(),model=diskHealthWidget(servers),shape=widgetShape(base.size),{onNavigate}=base;
 const tone=model.failed?'danger':model.count?'warning':undefined;
 return <WidgetFrame {...frame('disk-health',base)} tone={tone??'success'}
  lead={<><Figure id="disk-health" value={model.count} tone={tone}>{model.count?t('dashboard.diskHealth.detail',{count:model.count}):t('dashboard.diskHealth.empty')}</Figure><Breakdown parts={named(model.parts,id=>t(id==='not-available'?'health.state.unknown':diskHealthStatusKey(id)))} label={t('dashboard.widget.diskHealth')} legend={shape.legend}/></>}
  list={<Rows items={model.rows} shape={shape} limit={rowsBelowLegend(shape)} onNavigate={onNavigate} render={({device,status})=><Row key={device.id} href={dashboardLinks.deviceDisks(device.id)} onNavigate={onNavigate}
   lead={mark(device)} title={device.name} sub={t(diskHealthStatusKey(status))}/>}/>}/>;
}

export function CrashesWidget({servers,...base}:Devices&WidgetBase){
 const t=useT(),[locale]=useLocale(),now=useClockNow(undefined,minuteKey),model=crashesWidget(servers,now),shape=widgetShape(base.size),{onNavigate}=base;
 const show=<Go href={dashboardLinks.reliability} onNavigate={onNavigate}>{t('dashboard.crashes.show')}</Go>;
 if(!model.count)return <WidgetFrame {...frame('crashes',base)} tone="success" empty={<EmptyWidget id="crashes" shape={shape} art="devices" title={t('dashboard.crashes.empty')} text={t('dashboard.crashes.emptyText')} action={show}/>}/>;
 return <WidgetFrame {...frame('crashes',base)} tone="warning" action={show}
  lead={<Figure id="crashes" value={model.count} tone="warning">{t('dashboard.crashes.on',{count:model.devices})}</Figure>}
  list={<Rows items={model.rows} shape={shape} more={dashboardLinks.reliability} onNavigate={onNavigate} render={({device,count,last})=><Row key={device.id} href={dashboardLinks.deviceEvents(device.id)} onNavigate={onNavigate}
   lead={mark(device)} title={device.name} sub={t('dashboard.crashes.count',{count})} meta={relativeTime(last,now,locale)} metaTitle={exactTime(last,locale)}/>}/>}/>;
}

// ---- Activity ------------------------------------------------------------------------

export type JobsWidgetProps={jobs:Job[];servers:Device[];viewer:Viewer;demo:boolean;saving:boolean;onSelectJob:(job:Job)=>void;onCancelJob:(job:Job)=>void}&WidgetBase;
/** The job rows a widget holds: a narrow widget stacks the state above the text, so fewer rows fit. */
const jobRows=(base:WidgetBase)=>{const {rows}=widgetShape(base.size);return base.size.w>=2?rows:Math.floor(rows*.75);};
export function JobsWidget({jobs,servers,viewer,demo,saving,onSelectJob,onCancelJob,...base}:JobsWidgetProps){
 // A running job shows its elapsed time, so the widget follows every tick only while one runs.
 const t=useT(),now=useClockNow(undefined,jobs.some(job=>job.state==='running')?undefined:minuteKey),model=jobsWidget(jobs,now),rows=recentJobs(jobs),shape=widgetShape(base.size),{onNavigate}=base,limit=jobRows(base);
 if(!rows.length)return <WidgetFrame {...frame('jobs',base)} empty={<EmptyWidget id="jobs" shape={shape} art="jobs" title={t('dashboard.jobs.empty')} text={t('dashboard.jobs.emptyText')} action={<Go href={dashboardLinks.devices} onNavigate={onNavigate}>{t('dashboard.devices.show')}</Go>}/>}/>;
 return <WidgetFrame {...frame('jobs',base)} action={<Go href={dashboardLinks.jobs} onNavigate={onNavigate}>{t('dashboard.jobs.showAll')}</Go>}
  lead={<Figure id="jobs" value={model.active}><span>{t('jobs.dock.running',{count:model.running})}</span><span>{t('jobs.dock.waiting',{count:model.waiting})}</span></Figure>}
  list={limit>0?<div className="sdx-dash-jobs"><JobList jobs={rows.slice(0,limit)} servers={servers} viewer={viewer} demo={demo} saving={saving} now={now} onSelect={onSelectJob} onCancel={onCancelJob}/></div>:undefined}/>;
}

export function FailedJobsWidget({jobs,servers,viewer,demo,saving,onSelectJob,onCancelJob,...base}:JobsWidgetProps){
 const t=useT(),now=useClockNow(undefined,minuteKey),model=failedJobsWidget(jobs,now),shape=widgetShape(base.size),{onNavigate}=base,limit=jobRows(base);
 const show=<Go href={dashboardLinks.jobs} onNavigate={onNavigate}>{t('dashboard.jobs.showAll')}</Go>;
 if(!model.count)return <WidgetFrame {...frame('failed-jobs',base)} tone="success" empty={<EmptyWidget id="failed-jobs" shape={shape} art="jobs" title={t('dashboard.failedJobs.empty')} text={t('dashboard.failedJobs.emptyText')} action={show}/>}/>;
 return <WidgetFrame {...frame('failed-jobs',base)} tone="danger" action={show}
  lead={<Figure id="failed-jobs" value={model.count} tone="danger">{t('dashboard.failedJobs.detail')}</Figure>}
  list={limit>0?<div className="sdx-dash-jobs"><JobList jobs={model.rows.slice(0,limit)} servers={servers} viewer={viewer} demo={demo} saving={saving} now={now} onSelect={onSelectJob} onCancel={onCancelJob}/></div>:undefined}/>;
}

export function RunbooksWidget({jobs,servers,viewer,demo,saving,onSelectJob,onCancelJob,...base}:JobsWidgetProps){
 const t=useT(),now=useClockNow(undefined,jobs.some(job=>job.state==='running')?undefined:minuteKey),model=runbooksWidget(jobs,now),shape=widgetShape(base.size),{onNavigate}=base,limit=jobRows(base);
 const show=<Go href={dashboardLinks.runbookRuns} onNavigate={onNavigate}>{t('dashboard.runbooks.show')}</Go>;
 if(!model.rows.length)return <WidgetFrame {...frame('runbooks',base)} empty={<EmptyWidget id="runbooks" shape={shape} art="jobs" title={t('dashboard.runbooks.empty')} text={t('dashboard.runbooks.emptyText')} action={show}/>}/>;
 return <WidgetFrame {...frame('runbooks',base)} action={show}
  lead={<Figure id="runbooks" value={model.count}><span>{t('jobs.dock.running',{count:model.running})}</span><span>{t('jobs.dock.waiting',{count:model.waiting})}</span></Figure>}
  list={limit>0?<div className="sdx-dash-jobs"><JobList jobs={model.rows.slice(0,limit)} servers={servers} viewer={viewer} demo={demo} saving={saving} now={now} onSelect={onSelectJob} onCancel={onCancelJob}/></div>:undefined}/>;
}

export function ActivityWidget({servers,audit,deviceAudit,owner,...base}:Devices&{audit:readonly AuditEntry[];deviceAudit:readonly AuditEntry[];owner:boolean}&WidgetBase){
 const t=useT(),[locale]=useLocale(),now=useClockNow(undefined,minuteKey),model=activityWidget(audit,deviceAudit,now),shape=widgetShape(base.size),{onNavigate}=base,actionLabel=useActionLabel();
 const show=owner?<Go href={dashboardLinks.audit} onNavigate={onNavigate}>{t('dashboard.activity.show')}</Go>:undefined;
 if(!model.rows.length)return <WidgetFrame {...frame('activity',base)} empty={<EmptyWidget id="activity" shape={shape} art="jobs" title={t('dashboard.activity.empty')} text={t('dashboard.activity.emptyText')} action={show??<Go href={dashboardLinks.devices} onNavigate={onNavigate}>{t('dashboard.devices.show')}</Go>}/>}/>;
 const deviceNames=new Map(servers.map(server=>[server.id,server.name]));
 return <WidgetFrame {...frame('activity',base)} action={show}
  lead={<Figure id="activity" value={model.count}>{t('dashboard.activity.detail',{count:model.count})}</Figure>}
  list={<Rows items={model.rows} shape={shape} more={owner?dashboardLinks.audit:undefined} onNavigate={onNavigate} render={entry=>{
   const device=entry.serverId?deviceNames.get(entry.serverId):undefined,target=device??auditTargetView(entry,{deviceNames,locale}).text;
   return <Row key={entry.id} href={entry.scope==='device'&&entry.serverId&&device?dashboardLinks.deviceAccess(entry.serverId):owner?dashboardLinks.audit:undefined} onNavigate={onNavigate}
    title={actionLabel(auditActionView(entry.action))} sub={t('dashboard.activity.by',{actor:entry.actor,target})} meta={relativeTime(entry.at,now,locale)} metaTitle={exactTime(entry.at,locale)}/>;
  }}/>}/>;
}
