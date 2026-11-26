// The pure rules of the Dashboard (ui/devices/dashboard/dashboard-view.tsx, docs/dashboard.md): the status line, the grid and
// what a widget shows at a size, what the five first widgets count and list, the grid of the alarm heatmap, and the
// rules of the edit mode (the draft, moving and resizing). The other widgets are in dashboard-widgets-model.ts. No
// React, no fetch; the views format and translate.
import type {AlertLevel} from '@/lib/alert-rules';
import {connectionKind} from '@/lib/device-connection';
import {jobCounts} from '@/lib/job-display';
import type {Job,Server} from '@/lib/types';
import {builtInDashboardLayout,dashboardColumns,dashboardMaxRows,dashboardWidgetSizes,effectiveDashboardLayout,moveDashboardWidget,sameDashboardLayout,type DashboardLayout,type DashboardPreference,type DashboardWidget,type DashboardWidgetId,type DashboardWidgetSize} from '@/lib/dashboard-layout';
import {alarmRows,type AlarmRow} from '@/ui/devices/monitoring/alarms-view';

/** A device as the Dashboard reads it; maintenance comes from the console's Device (ui/base/api.tsx). */
export type DashboardDevice=Server&{maintenance?:{state:string}|null};
export const byDeviceName=(a:{name:string},b:{name:string})=>a.name.localeCompare(b.name,'en',{numeric:true});
/** The devices the Dashboard counts: revoked devices are left out. */
export const dashboardDevices=<D extends DashboardDevice>(servers:readonly D[]):D[]=>servers.filter(server=>!server.revoked);

// ---- Status line ---------------------------------------------------------------------

export type DashboardTone='neutral'|'danger'|'warning'|'success';
export type DashboardHeadline='none'|'alarms'|'offline'|'fine';
export type DashboardStatus={tone:DashboardTone;headline:DashboardHeadline;counts:{devices:number;online:number;offline:number;alarms:number;critical:number;warning:number}};
/**
 * The answer to "Is everything running?". The first match wins: no device; an open critical alarm (danger); any open
 * alarm (warning); an offline device (warning); else fine. Online and offline follow connectionKind, so a device that
 * never connected or is in maintenance is neither.
 */
export function dashboardStatus(servers:readonly DashboardDevice[],now:number):DashboardStatus{
 const devices=dashboardDevices(servers),counts={devices:devices.length,online:0,offline:0,alarms:0,critical:0,warning:0};
 for(const device of devices){
  const kind=connectionKind(device,now);
  if(kind==='online')counts.online++;else if(kind==='offline')counts.offline++;
  for(const alert of device.alerts??[]){counts.alarms++;if(alert.level==='critical')counts.critical++;else if(alert.level==='warning')counts.warning++;}
 }
 if(!counts.devices)return {tone:'neutral',headline:'none',counts};
 if(counts.critical)return {tone:'danger',headline:'alarms',counts};
 if(counts.alarms)return {tone:'warning',headline:'alarms',counts};
 if(counts.offline)return {tone:'warning',headline:'offline',counts};
 return {tone:'success',headline:'fine',counts};
}

// ---- Grid and sizes ------------------------------------------------------------------

/** The columns the grid shows at its width: 4, then 2, then 1 on a phone. */
export const dashboardGridColumns=(width:number):number=>width>=1100?dashboardColumns:width>=620?2:1;
/** The size a widget has on a grid with that many columns: never wider than the grid. */
export const shownWidgetSize=(widget:DashboardWidgetSize,columns:number):DashboardWidgetSize=>({w:Math.max(1,Math.min(widget.w,columns)),h:widget.h});
/**
 * What a widget shows at a size, so a larger widget gains content and a small one stays readable:
 * rows: the list rows that fit (none at 1 x 1, two beside the lead of a wide single row, then 4 or 8 by height, 6 or
 * 10 when the list has its own column); split: the lead and the list (or the legend) stand side by side; legend: the
 * breakdown names its parts in words (always but at 1 x 1); roomy: there is room for the full empty state.
 */
export type WidgetShape={rows:number;split:boolean;legend:boolean;roomy:boolean};
export function widgetShape({w,h}:DashboardWidgetSize):WidgetShape{
 const wide=w>=3;
 return {rows:h<=1?w>=2?2:0:wide?h===2?6:10:h===2?4:8,split:h<=1?w>=2:wide,legend:w>1||h>1,roomy:h>=2};
}
/** Whether a widget can show for this viewer: Customers needs two visible customers, Recent activity an account that may read audit entries. A widget that cannot show stays in the stored layout. */
export type WidgetContext={customers:number;audit:boolean};
export const widgetAvailable=(id:DashboardWidgetId,context:WidgetContext):boolean=>id==='customers'?context.customers>=2:id==='activity'?context.audit:true;

// ---- The first widgets ---------------------------------------------------------------

export type AlarmsWidget<D extends DashboardDevice>={count:number;levels:Record<AlertLevel,number>;rows:AlarmRow<D>[]};
/** Open alarms: all of them counted and split by level; the list is critical first, then the oldest. */
export function alarmsWidget<D extends DashboardDevice>(servers:readonly D[]):AlarmsWidget<D>{
 const rows=alarmRows(dashboardDevices(servers)),levels:Record<AlertLevel,number>={critical:0,warning:0,info:0};
 for(const row of rows)levels[row.alert.level]++;
 return {count:rows.length,levels,rows};
}

export type OfflineWidget<D extends DashboardDevice>={count:number;devices:number;rows:{device:D;since:number}[]};
/** Offline devices, the one that is offline longest first. since is its last heartbeat. */
export function offlineWidget<D extends DashboardDevice>(servers:readonly D[],now:number):OfflineWidget<D>{
 const devices=dashboardDevices(servers);
 const offline=devices.filter(device=>connectionKind(device,now)==='offline').map(device=>({device,since:device.lastSeen??0}))
  .sort((a,b)=>a.since-b.since||byDeviceName(a.device,b.device));
 return {count:offline.length,devices:devices.length,rows:offline};
}

export type UpdatesWidget<D extends DashboardDevice>={count:number;devices:number;rows:{device:D;pending:number;restart:boolean}[]};
/** Updates due: the pending Windows updates of all devices that report some; the list has the most pending first. */
export function updatesWidget<D extends DashboardDevice>(servers:readonly D[]):UpdatesWidget<D>{
 const due=dashboardDevices(servers).map(device=>({device,pending:Math.max(0,Math.floor(Number(device.snapshot?.updates?.pendingCount??0))||0),restart:device.snapshot?.rebootPending===true}))
  .filter(row=>row.pending>0).sort((a,b)=>b.pending-a.pending||byDeviceName(a.device,b.device));
 return {count:due.reduce((sum,row)=>sum+row.pending,0),devices:due.length,rows:due};
}

/** Recent jobs: the jobs that run or wait now. The list is the dock's (recentJobs in ui/shell/jobs.tsx). */
export function jobsWidget(jobs:readonly Job[],now:number):{active:number;running:number;waiting:number}{
 const {running,waiting}=jobCounts(jobs,now);
 return {active:running+waiting,running,waiting};
}

// ---- Alarm week (heatmap) ------------------------------------------------------------

const hourMs=3_600_000;
/** What GET /api/dashboard sends: hourly counts in UTC hours from start (lib/server/devices/alerts.ts, alarmWeek). */
export type AlarmWeek={start:number;hours:readonly number[]};
export type WeekStep=0|1|2|3|4;
export type WeekCell={at:number;end:number;hour:number;count:number;step:WeekStep;future:boolean};
export type WeekDay={at:number;cells:WeekCell[]};
export type WeekGrid={days:WeekDay[];total:number;max:number;busiest:WeekCell|null};
/** The start of an hour of a local day: dayOffset days from the day of now (0 today, -6 six days ago). */
export type CellTime=(now:number,dayOffset:number,hour:number)=>number;
/** The browser's time zone, daylight saving included. */
export const localCellTime:CellTime=(now,dayOffset,hour)=>{const date=new Date(now);return new Date(date.getFullYear(),date.getMonth(),date.getDate()+dayOffset,hour).getTime();};
export const weekDays=7,weekHours=24;

/**
 * The heatmap: 7 local days (6 days ago to today), 24 hours each. A cell holds the alarms of the UTC hours from its
 * start to the start of the next cell, so a day with a clock change still counts every hour once. A cell that starts
 * after now is future. The step is 0 for no alarm, else 1 to 4 by the share of the busiest cell.
 */
export function alarmWeekGrid(week:AlarmWeek,now:number,cellTime:CellTime=localCellTime):WeekGrid{
 const index=(time:number)=>Math.floor((time-week.start)/hourMs);
 const days:WeekDay[]=[];let total=0,max=0;
 for(let day=1-weekDays;day<=0;day++){
  const cells:WeekCell[]=[];
  for(let hour=0;hour<weekHours;hour++){
   const at=cellTime(now,day,hour),end=hour<weekHours-1?cellTime(now,day,hour+1):cellTime(now,day+1,0);
   let count=0;
   for(let bucket=Math.max(0,index(at));bucket<Math.min(week.hours.length,index(end));bucket++)count+=Math.max(0,Number(week.hours[bucket])||0);
   total+=count;max=Math.max(max,count);
   cells.push({at,end,hour,count,step:0,future:at>now});
  }
  days.push({at:cellTime(now,day,0),cells});
 }
 let busiest:WeekCell|null=null;
 for(const day of days)for(const cell of day.cells){
  cell.step=cell.count?Math.max(1,Math.ceil(4*cell.count/max)) as WeekStep:0;
  if(cell.count&&(!busiest||cell.count>busiest.count))busiest=cell;
 }
 return {days,total,max,busiest};
}

/** The server's window for a time: the full UTC hour 191 hours before the current one. */
export const alarmWeekStart=(now:number,hours=192)=>Math.floor(now/hourMs)*hourMs-(hours-1)*hourMs;
/**
 * The alarm week of the sample devices: a fixed pattern over the hours (more alarms in the working hours, a quiet
 * weekend), a pure function of now, so sample mode calls no API.
 */
export function demoAlarmWeek(now:number):AlarmWeek{
 const start=alarmWeekStart(now),hours:number[]=[];
 for(let bucket=0;bucket<192;bucket++){
  const at=start+bucket*hourMs,date=new Date(at),hour=date.getUTCHours(),weekend=date.getUTCDay()===0||date.getUTCDay()===6;
  const seed=(Math.floor(at/hourMs)*2654435761)>>>0,dice=seed%11;
  const working=hour>=7&&hour<=17&&!weekend;
  hours.push(at>now?0:working?[0,0,1,0,2,0,1,3,0,1,0][dice]:dice===0?1:0);
 }
 return {start,hours};
}

// ---- Edit mode -----------------------------------------------------------------------

/** What the edit mode changes: the account's own layout, or (Owner) the default layout of the portal. */
export type LayoutMode='own'|'default';
/** A draft. follow (own mode): the account goes back to the default layout, so Save stores no layout of its own. */
export type LayoutEdit={mode:LayoutMode;draft:DashboardLayout;follow:boolean};
/** The draft the edit mode starts with: the layout the page shows in that mode. */
export function startLayoutEdit(mode:LayoutMode,preference:DashboardPreference):LayoutEdit{
 return mode==='own'?{mode,draft:effectiveDashboardLayout(preference.own,preference.default),follow:preference.own===null}:{mode,draft:preference.default,follow:false};
}
/**
 * What Save stores. own: null while the account follows the default (after "Reset to default", or it never had a
 * layout and the draft equals the default again), else the draft. default: null for the built-in layout, else the draft.
 */
export function layoutSaveValue(edit:LayoutEdit,preference:DashboardPreference):DashboardLayout|null{
 if(edit.mode==='default')return sameDashboardLayout(edit.draft,builtInDashboardLayout)?null:edit.draft;
 return edit.follow||preference.own===null&&sameDashboardLayout(edit.draft,preference.default)?null:edit.draft;
}
/** Whether Save would change what is stored (and the page). */
export function layoutDirty(edit:LayoutEdit,preference:DashboardPreference):boolean{
 if(edit.mode==='default')return !sameDashboardLayout(edit.draft,preference.default);
 const value=layoutSaveValue(edit,preference);
 return value===null?preference.own!==null:!sameDashboardLayout(value,preference.own);
}
/** The layout the page shows: the draft while the edit mode is on, else the account's layout. */
export const shownDashboardLayout=(preference:DashboardPreference,edit:LayoutEdit|null):DashboardLayout=>edit?edit.draft:effectiveDashboardLayout(preference.own,preference.default);

/** One step of the resize menu and of the arrow keys on the resize handle. */
export type ResizeDirection='wider'|'narrower'|'taller'|'shorter';
/** Why a step cannot be taken: one column shows, or the widget is at that limit. */
export type ResizeBlock='columns'|'widest'|'narrowest'|'tallest'|'shortest';
/**
 * The size after one step, from the size the widget shows on a grid with that many columns; or why the step cannot
 * be taken. A step in the height keeps the stored width, so a widget that a narrow grid shows smaller is not cut.
 */
export function resizeStep(widget:DashboardWidget,direction:ResizeDirection,columns:number):DashboardWidgetSize|{blocked:ResizeBlock}{
 const rule=dashboardWidgetSizes[widget.id],shown=shownWidgetSize(widget,columns);
 if(direction==='taller')return widget.h>=dashboardMaxRows?{blocked:'tallest'}:{w:widget.w,h:widget.h+1};
 if(direction==='shorter')return widget.h<=rule.minH?{blocked:'shortest'}:{w:widget.w,h:widget.h-1};
 if(columns<=1)return {blocked:'columns'};
 if(direction==='wider')return shown.w>=columns?{blocked:'widest'}:{w:shown.w+1,h:widget.h};
 return shown.w<=rule.minW?{blocked:'narrowest'}:{w:shown.w-1,h:widget.h};
}
/** The cell of the grid as the page measured it: one column by one row, and the gap between cells. */
export type GridCell={width:number;height:number;gap:number};
/**
 * The size a pointer drag on the resize handle asks for: the shown size at the start plus the pointer distance in
 * whole cells, inside the grid. The width stays the stored one while the drag does not change the shown width.
 */
export function resizeTarget(widget:DashboardWidget,delta:{x:number;y:number},cell:GridCell,columns:number):DashboardWidgetSize{
 const shown=shownWidgetSize(widget,columns);
 const w=Math.min(columns,Math.max(1,shown.w+Math.round(delta.x/(cell.width+cell.gap)))),h=Math.min(dashboardMaxRows,Math.max(1,widget.h+Math.round(delta.y/(cell.height+cell.gap))));
 return {w:w===shown.w?widget.w:w,h};
}
/** The pointer distance from which a press on a widget is a drag. */
export const dragThreshold=4;
export const dragStarted=(delta:{x:number;y:number})=>Math.hypot(delta.x,delta.y)>=dragThreshold;
/** A running move: the dragged widget, the layout at its start (Escape restores it) and the widget whose place it took last. */
export type DragState={id:DashboardWidgetId;origin:DashboardLayout;last:DashboardWidgetId|null};
/**
 * The pointer of a running move is over a widget (or over none): the dragged widget takes the place of the widget
 * under the pointer. The same widget does not trade places again until the pointer has left it, so two widgets of
 * different sizes do not swap back and forth under a resting pointer.
 */
export function dragOver(layout:DashboardLayout,state:DragState,over:DashboardWidgetId|null):{layout:DashboardLayout;state:DragState}{
 if(over===null||over===state.id)return state.last===null?{layout,state}:{layout,state:{...state,last:null}};
 if(over===state.last)return {layout,state};
 const to=layout.findIndex(item=>item.id===over);
 return to<0?{layout,state}:{layout:moveDashboardWidget(layout,state.id,to),state:{...state,last:over}};
}
