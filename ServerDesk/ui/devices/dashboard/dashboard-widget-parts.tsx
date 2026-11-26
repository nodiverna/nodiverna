'use client';
// The shared parts of a Dashboard widget (docs/dashboard.md): the frame (a kit Card with the widget's icon and name), the
// lead number, the list rows, the breakdown bar with its legend, the day bars and the empty state. A widget picks its
// parts by its shape (widgetShape in dashboard-model.ts), so a larger widget gains content. In edit mode the frame
// shows the edit controls in place of the head action and its content is inert. Also the name, the description, the
// icon and the catalog group of every widget.
import type {MouseEvent,ReactNode} from 'react';
import {Activity,BadgeCheck,BarChart3,Building2,CalendarClock,CalendarRange,CircleX,Cpu,Download,HardDrive,HeartPulse,History,Lock,PackageCheck,Pin,Play,Power,Rocket,ServerCrash,ShieldCheck,Siren,Stethoscope,Wifi,WifiOff} from 'lucide-react';
import type {DashboardWidgetId,DashboardWidgetSize} from '@/lib/dashboard-layout';
import type {MessageKey} from '@/lib/i18n/translate';
import {useT} from '@/ui/base/locale';
import {Btn,Card,Empty,Meter,cx,type IconTone,type IconType} from '@/ui/kit/kit';
import {CountUp} from '@/ui/kit/count-up';
import {DashboardArt,type DashboardArtKind} from '@/ui/devices/dashboard/dashboard-art';
import {widgetShape,type WidgetShape} from '@/ui/devices/dashboard/dashboard-model';
import type {BreakdownTone} from '@/ui/devices/dashboard/dashboard-widgets-model';

/** The groups of the widget catalog, in order. */
export const dashboardWidgetGroups=['monitoring','devices','updates','security','hardware','activity'] as const;
export type DashboardWidgetGroup=typeof dashboardWidgetGroups[number];
export const dashboardGroupLabels:Readonly<Record<DashboardWidgetGroup,MessageKey>>={monitoring:'dashboard.group.monitoring',devices:'dashboard.group.devices',updates:'dashboard.group.updates',security:'dashboard.group.security',hardware:'dashboard.group.hardware',activity:'dashboard.group.activity'};
/** The name, the one-line description, the icon and the catalog group of each widget: the heads, the edit controls and the catalog read them. */
export const dashboardWidgetMeta:Readonly<Record<DashboardWidgetId,{title:MessageKey;hint:MessageKey;icon:IconType;group:DashboardWidgetGroup}>>={
 alarms:{title:'dashboard.widget.alarms',hint:'dashboard.widget.alarmsHint',icon:Siren,group:'monitoring'},
 'alarm-week':{title:'dashboard.widget.alarmWeek',hint:'dashboard.widget.alarmWeekHint',icon:CalendarRange,group:'monitoring'},
 'alarm-trend':{title:'dashboard.widget.alarmTrend',hint:'dashboard.widget.alarmTrendHint',icon:BarChart3,group:'monitoring'},
 health:{title:'dashboard.widget.health',hint:'dashboard.widget.healthHint',icon:HeartPulse,group:'monitoring'},
 offline:{title:'dashboard.widget.offline',hint:'dashboard.widget.offlineHint',icon:WifiOff,group:'devices'},
 status:{title:'dashboard.widget.status',hint:'dashboard.widget.statusHint',icon:Wifi,group:'devices'},
 pinned:{title:'dashboard.widget.pinned',hint:'dashboard.widget.pinnedHint',icon:Pin,group:'devices'},
 customers:{title:'dashboard.widget.customers',hint:'dashboard.widget.customersHint',icon:Building2,group:'devices'},
 load:{title:'dashboard.widget.load',hint:'dashboard.widget.loadHint',icon:Cpu,group:'devices'},
 'disk-space':{title:'dashboard.widget.diskSpace',hint:'dashboard.widget.diskSpaceHint',icon:HardDrive,group:'devices'},
 updates:{title:'dashboard.widget.updates',hint:'dashboard.widget.updatesHint',icon:Download,group:'updates'},
 restart:{title:'dashboard.widget.restart',hint:'dashboard.widget.restartHint',icon:Power,group:'updates'},
 'os-support':{title:'dashboard.widget.osSupport',hint:'dashboard.widget.osSupportHint',icon:CalendarClock,group:'updates'},
 agents:{title:'dashboard.widget.agents',hint:'dashboard.widget.agentsHint',icon:PackageCheck,group:'updates'},
 defender:{title:'dashboard.widget.defender',hint:'dashboard.widget.defenderHint',icon:ShieldCheck,group:'security'},
 encryption:{title:'dashboard.widget.encryption',hint:'dashboard.widget.encryptionHint',icon:Lock,group:'security'},
 certificates:{title:'dashboard.widget.certificates',hint:'dashboard.widget.certificatesHint',icon:BadgeCheck,group:'security'},
 autostart:{title:'dashboard.widget.autostart',hint:'dashboard.widget.autostartHint',icon:Rocket,group:'security'},
 'disk-health':{title:'dashboard.widget.diskHealth',hint:'dashboard.widget.diskHealthHint',icon:Stethoscope,group:'hardware'},
 crashes:{title:'dashboard.widget.crashes',hint:'dashboard.widget.crashesHint',icon:ServerCrash,group:'hardware'},
 jobs:{title:'dashboard.widget.jobs',hint:'dashboard.widget.jobsHint',icon:Activity,group:'activity'},
 'failed-jobs':{title:'dashboard.widget.failedJobs',hint:'dashboard.widget.failedJobsHint',icon:CircleX,group:'activity'},
 runbooks:{title:'dashboard.widget.runbooks',hint:'dashboard.widget.runbooksHint',icon:Play,group:'activity'},
 activity:{title:'dashboard.widget.activity',hint:'dashboard.widget.activityHint',icon:History,group:'activity'},
};

/** What every widget gets from the page. */
export type WidgetBase={
 /** The size the widget shows on the grid (never wider than the grid). */
 size:DashboardWidgetSize;
 /** Edit mode: the edit controls of this widget. They stand in place of the head action and the content is inert. */
 edit?:ReactNode;
 /** Opens a console hash with a history entry. */
 onNavigate:(hash:string)=>void};
type Navigate=WidgetBase['onNavigate'];
/** A plain primary click: the console opens the hash itself; any other click (a new tab, a new window) stays the browser's. */
const plainClick=(event:MouseEvent)=>event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey;
const follow=(href:string,onNavigate:Navigate)=>(event:MouseEvent)=>{if(!plainClick(event))return;event.preventDefault();onNavigate(href);};

/**
 * The frame of a widget: the card with its icon tile and name, then the body. `lead` (the number and what belongs to
 * it) stands above `list` (rendered only when the shape holds rows) or `children` (a chart); a split shape puts them
 * side by side. `empty` takes the whole body. The head action shows from two columns: a single column has no room
 * for it next to the name, and the "more" line of the list leads to the same place.
 */
export function WidgetFrame({id,tone='accent',action,size,edit,lead,list,empty,children}:{id:DashboardWidgetId;tone?:IconTone;action?:ReactNode;size:DashboardWidgetSize;edit?:ReactNode;lead?:ReactNode;list?:ReactNode;empty?:ReactNode;children?:ReactNode}){
 const t=useT(),meta=dashboardWidgetMeta[id],shape=widgetShape(size),has=(node:ReactNode)=>node!=null&&node!==false;
 const main=has(children)?children:shape.rows>0&&has(list)?list:null;
 return <Card className="sdx-dash-widget" id={'dashboard-widget-'+id} title={t(meta.title)} icon={meta.icon} iconTone={tone} actions={edit??(size.w>=2?action:undefined)}>
  <div className={cx('sdx-dash-body',has(empty)?'sdx-dash-body-empty':shape.split&&has(lead)&&has(main)&&'sdx-dash-body-split')} inert={edit?true:undefined}>
   {has(empty)?empty:<>
    {has(lead)&&<div className="sdx-dash-lead">{lead}</div>}
    {has(main)&&<div className="sdx-dash-main">{main}</div>}
   </>}
  </div>
 </Card>;
}
/** The lead number of a widget and what stands next to it. */
export function Figure({id,value,tone,children}:{id:DashboardWidgetId;value:number;tone?:'warning'|'danger';children?:ReactNode}){
 return <div className="sdx-dash-figure"><span className={cx('sdx-dash-number',tone&&'sdx-dash-number-'+tone)}><CountUp value={value} entranceId={'dashboard-'+id}/></span>{children!=null&&children!==false&&<span className="sdx-dash-figure-detail">{children}</span>}</div>;
}
/** One row of a widget list. With an href it opens a console place; without one it is plain text. */
export function Row({href,onNavigate,lead,title,mono,sub,meta,metaTitle,meter}:{href?:string;onNavigate:Navigate;lead?:ReactNode;title:string;mono?:boolean;sub?:string;meta?:ReactNode;metaTitle?:string;meter?:{value:number;label:string}}){
 const content=<>
  {lead}
  <span className="sdx-dash-row-text"><strong className={mono?'mono':undefined}>{title}</strong>{sub&&<small>{sub}</small>}{meter&&<Meter value={meter.value} label={meter.label} size="sm" critical={90} warning={80}/>}</span>
  {meta!=null&&meta!==false&&<span className="sdx-dash-row-meta" title={metaTitle}>{meta}</span>}
 </>;
 return <li>{href?<a className="sdx-dash-row" href={href} onClick={follow(href,onNavigate)}>{content}</a>:<div className="sdx-dash-row sdx-dash-row-static">{content}</div>}</li>;
}
/**
 * The list of a widget: the first `limit` items, and a last line "{count} more" when the list is longer and the
 * widget is roomy (a link to the place that shows all, when the widget has one). Nothing at a limit of 0.
 */
export function Rows<T>({items,shape,limit=shape.rows,render,more,onNavigate}:{items:readonly T[];shape:WidgetShape;limit?:number;render:(item:T)=>ReactNode;more?:string;onNavigate:Navigate}){
 const t=useT(),rest=items.length-limit;
 if(limit<=0||!items.length)return null;
 return <ul className="sdx-dash-list">
  {items.slice(0,limit).map(render)}
  {rest>0&&shape.roomy&&<li className="sdx-dash-more">{more?<a href={more} onClick={follow(more,onNavigate)}>{t('dashboard.more',{count:rest})}</a>:<span>{t('dashboard.more',{count:rest})}</span>}</li>}
 </ul>;
}
/** The action of a widget head or an empty widget: a quiet button that opens a console place. */
export function Go({href,onNavigate,children}:{href:string;onNavigate:Navigate;children:ReactNode}){
 return <Btn size="sm" variant="ghost" onClick={()=>onNavigate(href)}>{children}</Btn>;
}
/**
 * The empty state of a widget. Roomy: the illustration, the fact, one sentence and one action. In a single row there
 * is no room for it, so the lead number 0 stands with the fact as its detail.
 */
export function EmptyWidget({id,shape,art,title,text,action}:{id:DashboardWidgetId;shape:WidgetShape;art:DashboardArtKind;title:string;text:string;action:ReactNode}){
 return shape.roomy?<Empty art={<DashboardArt kind={art}/>} title={title} action={action}>{text}</Empty>:<Figure id={id} value={0}>{title}</Figure>;
}

/** A part of a breakdown as the bar and its legend show it. */
export type BreakdownItem={id:string;label:string;count:number;tone:BreakdownTone};
/**
 * How a count splits into parts: one bar with a segment per part that is not empty, in the tone of the part, and
 * (with legend) the parts in words with their counts. The bar is one image whose name holds every part, and each
 * segment names itself on hover, so nothing is carried by color alone.
 */
export function Breakdown({parts,label,legend}:{parts:readonly BreakdownItem[];label:string;legend:boolean}){
 const t=useT(),shown=parts.filter(item=>item.count>0);
 if(!shown.length)return null;
 return <div className="sdx-dash-break">
  <div className="sdx-dash-break-bar" role="img" aria-label={t('dashboard.breakdown.label',{name:label,parts:shown.map(item=>t('dashboard.breakdown.part',{label:item.label,count:item.count})).join(', ')})}>
   {shown.map(item=><i key={item.id} data-tone={item.tone} title={t('dashboard.breakdown.part',{label:item.label,count:item.count})} style={{flexGrow:item.count}}/>)}
  </div>
  {legend&&<ul className="sdx-dash-break-legend" aria-hidden="true">{shown.map(item=><li key={item.id}><i data-tone={item.tone}/>{item.label}<b>{item.count}</b></li>)}</ul>}
 </div>;
}
/** One day of the day bars: its weekday in short, the sentence of its tooltip and its count. */
export type DayBar={key:string|number;short:string;title:string;count:number};
/**
 * Seven bars, one per day, in the data color. The group is one image whose name holds the seven counts; with labels
 * each bar carries its count and its weekday as text.
 */
export function DayBars({days,label,labels}:{days:readonly DayBar[];label:string;labels:boolean}){
 const max=Math.max(1,...days.map(day=>day.count));
 return <div className={cx('sdx-dash-days',labels&&'sdx-dash-days-labelled')} role="img" aria-label={label}>
  {days.map(day=><span key={day.key} className="sdx-dash-day" title={day.title}>
   {labels&&<b>{day.count}</b>}
   <span className="sdx-dash-day-track"><i style={{height:`${Math.round(day.count/max*100)}%`}} data-empty={day.count===0||undefined}/></span>
   {labels&&<small>{day.short}</small>}
  </span>)}
 </div>;
}
