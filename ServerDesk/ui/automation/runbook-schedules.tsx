'use client';
// The Schedules tab of the Runbooks page (D7): one DataTable lists both ways a runbook runs on a recurrence, a
// "Save as schedule" schedule (GET /api/runbooks) and a runbook assignment whose template runs regularly
// (GET /api/automation). Each row names its Source. A schedule's row Menu turns it off; an assignment's row Menu
// shows the assignment on the Assignments tab. RunbookPanel renders it in library mode and owns the requests.
import {BookOpen,CalendarClock,Eye,Square} from 'lucide-react';
import type {AssignmentSchedule} from '@/ui/automation/automation-data';
import {Btn,Card,Menu,StatusPill,type MenuEntry} from '@/ui/kit/kit';
import {DataTable,type DataColumn} from '@/ui/kit/data-table';
import {stamp,type Device} from '@/ui/base/api';
import {useLocale,useT} from '@/ui/base/locale';
import type {Locale} from '@/lib/i18n/locale';
import {translate} from '@/lib/i18n/translate';

/** A "Save as schedule" schedule of GET /api/runbooks. */
export type RunbookSchedule={id:string;versionId:string;runbookName?:string;targets:string[];nextDue:number;recurrence:Record<string,unknown>;enabled:boolean};
/** One row of the union: a schedule or an assignment, with the texts of its columns. */
export type ScheduleRow={key:string;source:'schedule'|'assignment';id:string;name:string;recurrence:string;targets:string;targetsHint:string|null;nextDue:number|null;active:boolean};

/** "Daily at 02:00 · Europe/Berlin" or "Every 60 minutes". */
export function recurrenceLabel(recurrence:Record<string,unknown>,locale:Locale):string{
 return recurrence.kind==='daily'
  ?translate(locale,'runbooks.dailyAt',{padStart:String(recurrence.hour).padStart(2,'0'),padStart2:String(recurrence.minute).padStart(2,'0'),timeZone:String(recurrence.timeZone??'')})
  :translate(locale,'desired.schedule.minutes',{minutes:String(recurrence.minutes)});
}
/** The union of schedules and recurring assignments: the schedules first, both in the order of their API. */
export function scheduleRows(schedules:readonly RunbookSchedule[],assignments:readonly AssignmentSchedule[],{name,servers,locale}:{name:(schedule:RunbookSchedule)=>string;servers:readonly Pick<Device,'id'|'name'>[];locale:Locale}):ScheduleRow[]{
 return [
  ...schedules.map(s=>({key:'schedule:'+s.id,source:'schedule' as const,id:s.id,name:name(s),recurrence:recurrenceLabel(s.recurrence,locale),targets:s.targets.map(id=>servers.find(d=>d.id===id)?.name??id).join(', '),targetsHint:null,nextDue:s.nextDue,active:s.enabled})),
  ...assignments.map(a=>({key:'assignment:'+a.id,source:'assignment' as const,id:a.id,name:a.templateName,recurrence:recurrenceLabel(a.recurrence,locale),targets:a.scope,targetsHint:a.path,nextDue:a.nextDue,active:!a.paused})),
 ];
}

export function RunbookSchedules({schedules,assignments,servers,runName,busyReason,onTurnOff,onShowAssignment,onShowLibrary}:{schedules:readonly RunbookSchedule[];assignments:readonly AssignmentSchedule[];servers:readonly Pick<Device,'id'|'name'>[];
 /** The runbook name of a schedule's version. */
 runName:(versionId:string)=>string;
 /** Why no change can start now (another change runs). */
 busyReason?:string;onTurnOff:(scheduleId:string)=>void;onShowAssignment:(assignmentId:string)=>void;onShowLibrary:()=>void}){
 const t=useT(),[locale]=useLocale();
 const rows=scheduleRows(schedules,assignments,{name:schedule=>runName(schedule.versionId),servers,locale});
 const menu=(row:ScheduleRow):MenuEntry[]=>row.source==='schedule'
  ?[{id:'off',label:t('runbooks.menu.turnOff'),icon:Square,blocked:!row.active?t('runbooks.blocked.scheduleOff'):busyReason,onSelect:()=>onTurnOff(row.id)}]
  :[{id:'show',label:t('runbooks.menu.showAssignment'),icon:Eye,onSelect:()=>onShowAssignment(row.id)}];
 const columns:DataColumn<ScheduleRow>[]=[
  {id:'runbook',label:t('runbooks.line.runbook'),primary:true,wrap:true,cell:row=><span className="sdx-cell-stack"><strong>{row.name}</strong><small>{row.recurrence}</small></span>},
  {id:'source',label:t('runbooks.source'),cell:row=>row.source==='schedule'?t('runbooks.source.schedule'):t('runbooks.source.assignment')},
  {id:'targets',label:t('runbooks.col.targets'),wrap:true,cell:row=>row.targetsHint?<span className="sdx-cell-stack"><span>{row.targets}</span><small>{row.targetsHint}</small></span>:row.targets},
  {id:'next',label:t('runbooks.nextRun'),cell:row=>row.nextDue===null?<span className="sdx-muted-cell">{t('runbooks.nextAfterReport')}</span>:stamp(row.nextDue,locale)},
  {id:'status',label:t('management.status'),cell:row=>row.active?<StatusPill kind="success">{t('management.active')}</StatusPill>:<StatusPill kind="neutral">{row.source==='schedule'?t('runbooks.state.off'):t('automation.state.paused')}</StatusPill>},
  {id:'actions',label:t('fleet.col.actions'),hideLabel:true,className:'sdx-col-actions',cell:row=><Menu label={t('runbooks.rowActions',{name:row.name})} entries={menu(row)}/>},
 ];
 // The tab already names the view: the card has no visible title, the table keeps its accessible name.
 return <Card flush>
  <DataTable<ScheduleRow> label={t('runbooks.schedules')} variant="flush" cards entranceId="runbook-schedules" columns={columns} rows={rows} rowKey={row=>row.key}
   empty={{icon:CalendarClock,title:t('runbooks.noSchedulesTitle'),children:t('runbooks.noSchedulesHint'),action:<Btn icon={BookOpen} onClick={onShowLibrary}>{t('runbooks.showLibrary')}</Btn>}}/>
 </Card>;
}
