'use client';
// The heatmap of the Dashboard tile "Alarms in the last 7 days": seven rows (the local days), 24 columns (the hours).
// A cell's fill has five steps in the data color (--sd-meter on --sd-meter-track, never the scheme accent). The grid
// is one image for a screen reader: its name holds the total and the busiest hour, and the line below shows the same
// in words, so nothing is carried by color alone. It scrolls inside its own region when a narrow tile cannot hold it.
import {formatClock,formatDate,formatNumber,formatTime} from '@/lib/i18n/format';
import type {Locale} from '@/lib/i18n/locale';
import {translate} from '@/lib/i18n/translate';
import {useLocale,useT} from '@/ui/base/locale';
import {useOverflowFocusable} from '@/ui/kit/overflow-focusable';
import type {WeekCell,WeekGrid,WeekStep} from '@/ui/devices/dashboard/dashboard-model';

const weekSteps:readonly WeekStep[]=[0,1,2,3,4];
/** The hours that carry an axis label; each label spans the six columns that follow it. */
const axisHours=[0,6,12,18];
const dayName=(locale:Locale,at:number,weekday:'short'|'long')=>formatDate(locale,at,{weekday});
/** "Tuesday, 02:00 PM–03:00 PM: 3 alarms": the name of one cell. */
export const weekCellText=(cell:WeekCell,locale:Locale)=>translate(locale,'dashboard.week.cell',{day:dayName(locale,cell.at,'long'),from:formatClock(locale,cell.at),to:formatClock(locale,cell.end),count:cell.count});
/** "Most alarms: Tuesday, 02:00 PM–03:00 PM (3)", or '' for a week without an alarm. */
export const weekBusiestText=(grid:WeekGrid,locale:Locale)=>grid.busiest?translate(locale,'dashboard.week.busiest',{day:dayName(locale,grid.busiest.at,'long'),from:formatClock(locale,grid.busiest.at),to:formatClock(locale,grid.busiest.end),count:formatNumber(locale,grid.busiest.count)}):'';

export function DashboardHeatmap({grid}:{grid:WeekGrid}){
 const t=useT(),[locale]=useLocale(),busiest=weekBusiestText(grid,locale);
 const [ref,focusable]=useOverflowFocusable<HTMLDivElement>(grid.days.length,false);
 return <div className="sdx-dash-week">
  <div ref={ref} className="sdx-dash-week-scroll" role="group" aria-label={t('dashboard.week.region')} tabIndex={focusable?0:undefined}>
   <div className="sdx-dash-heat" role="img" aria-label={t('dashboard.week.label',{count:grid.total,busiest})}>
    <span className="sdx-dash-heat-corner"/>
    {axisHours.map(hour=><span key={hour} className="sdx-dash-heat-hour">{formatTime(locale,grid.days[0].cells[hour].at,{hour:'numeric'})}</span>)}
    {grid.days.map(day=><div key={day.at} className="sdx-dash-heat-row">
     <span className="sdx-dash-heat-day" title={dayName(locale,day.at,'long')}>{dayName(locale,day.at,'short')}</span>
     {day.cells.map(cell=><i key={cell.hour} className="sdx-dash-heat-cell" data-step={cell.step} data-future={cell.future||undefined} title={cell.future?undefined:weekCellText(cell,locale)}/>)}
    </div>)}
   </div>
  </div>
  <div className="sdx-dash-week-foot">
   <p>{busiest}</p>
   <span className="sdx-dash-heat-legend" aria-hidden="true">{t('dashboard.week.fewer')}{weekSteps.map(step=><i key={step} className="sdx-dash-heat-cell" data-step={step}/>)}{t('dashboard.week.more')}</span>
  </div>
 </div>;
}
