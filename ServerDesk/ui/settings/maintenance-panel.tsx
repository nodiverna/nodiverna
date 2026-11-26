'use client';
import {useCallback,useEffect,useRef,useState,type FormEvent,type ReactNode} from 'react';
import {AlertTriangle,Archive,CalendarClock,Database,Eraser,HardDrive,History,Play,Wrench} from 'lucide-react';
import {toast} from 'sonner';
import type {Viewer} from '@/lib/types';
import type {MaintenanceErrorKey,MaintenanceResult,MaintenanceRun,MaintenanceView} from '@/lib/server/maintenance';
import {sortTableRows} from '@/ui/base/table-sort';
import {EMPTY_VALUE,formatBytes,formatNumber} from '@/lib/i18n/format';
import {defaultLocale,type Locale} from '@/lib/i18n/locale';
import {translate,type MessageKey} from '@/lib/i18n/translate';
import {consoleRouteHash} from '@/lib/console-route';
import {api,ApiError,message} from '@/ui/base/api';
import {MfaStepUp} from '@/ui/session/mfa-step-up';
import {useStepUp} from '@/ui/session/step-up-retry';
import {canManageInstanceSettings} from '@/ui/base/access-capabilities';
import {frameHeader,useFrameRefresh,type PageFrame} from '@/ui/shell/page-frame';
import {Btn,Card,Disclosure,Drawer,DrawerCancel,Facts,Kpi,KpiRow,Meter,Notice,RichText,SettingsPage,StatusPill,exactTime,relativeTime,type StatusKind} from '@/ui/kit/kit';
import {DataTable,type DataColumn,type TableSort} from '@/ui/kit/data-table';
import {Field,Select} from '@/ui/kit/field';
import {useLocale,useT,type Translate} from '@/ui/base/locale';
import {maintenanceSaveNeedsStepUp,retentionRows,retentionVariables,storageKpis,type RetentionAreaRow} from '@/ui/settings/retention-model';
import '@/ui/settings/maintenance-panel.css';

// The page Settings → Data retention (Owners only, docs/self-hosting.md
// "Maintenance"): the storage KPI row, the card "Daily cleanup" (the last run,
// Run now, Change schedule… and the recent runs behind a disclosure) and the card
// "Retention by area" (retention, source, size and the last run per area). The
// header primary "Change retention…" and "Change schedule…" open one drawer each;
// both save the one existing set payload. It shows and changes the real
// installation data also with sample devices. Saving needs a fresh MFA proof
// (lib/step-up.ts, rule 6) through useStepUp.
const endpoint='/api/maintenance';
const pollMs=5000;
const timePattern=/^([01]\d|2[0-3]):[0-5]\d$/;
const customersHash=consoleRouteHash({view:'settings',page:'customers'});
const retentionFormId='sdx-maintenance-retention-form',scheduleFormId='sdx-maintenance-schedule-form';

type Form={auditDays:string;jobDays:string;runAt:string;timeZone:string};
type Field=keyof Form;
type FieldErrors=Partial<Record<Field,MessageKey>>;
type DrawerKind='retention'|'schedule';
type Tr=Translate;

/** The UI text of an error code of /api/maintenance; the client never shows the server text for these. */
export const maintenanceErrorKeys:Readonly<Record<string,MessageKey>>={
 MAINTENANCE_RETENTION_INVALID:'maintenancePage.error.retention',
 MAINTENANCE_TIME_INVALID:'maintenancePage.error.time',
 MAINTENANCE_TIME_ZONE_INVALID:'maintenancePage.error.timeZone',
 MAINTENANCE_SETTINGS_CONFLICT:'maintenancePage.error.conflict',
 MAINTENANCE_RUNNING:'maintenancePage.error.running',
 MAINTENANCE_MIGRATIONS_PENDING:'maintenancePage.error.migrations',
 MAINTENANCE_OWNER_ONLY:'maintenancePage.error.ownerOnly',
};
/** The text of a failed request: the catalog text of its code, else the shared message. */
export function maintenanceFailure(failure:unknown,locale:Locale=defaultLocale):string{
 const key=failure instanceof ApiError&&failure.code?maintenanceErrorKeys[failure.code]:undefined;
 return key?translate(locale,key):message(failure,locale);
}

let zoneCache:string[]|null=null;
/** The time zones of the browser (as on the customers page), with UTC and the stored zone always included. */
export function maintenanceTimeZones(current:string):string[]{
 if(!zoneCache){try{zoneCache=typeof Intl.supportedValuesOf==='function'?Intl.supportedValuesOf('timeZone'):[];}catch{zoneCache=[];}}
 const zones=zoneCache.includes('UTC')?zoneCache:['UTC',...zoneCache];
 return zones.includes(current)?zones:[current,...zones];
}

const formOf=(view:MaintenanceView):Form=>({auditDays:view.settings.auditDays===null?'':String(view.settings.auditDays),jobDays:view.settings.jobDays===null?'':String(view.settings.jobDays),runAt:view.settings.runAt,timeZone:view.settings.timeZone});
const validDays=(value:string)=>/^\d{1,4}$/.test(value)&&Number(value)>=1&&Number(value)<=3650;
/** Client validation with the server rules (lib/server/maintenance.ts). */
export function maintenanceFormErrors(form:Form,zones:string[]=maintenanceTimeZones(form.timeZone)):FieldErrors{
 const errors:FieldErrors={};
 if(!validDays(form.auditDays))errors.auditDays='maintenancePage.error.retention';
 if(!validDays(form.jobDays))errors.jobDays='maintenancePage.error.retention';
 if(!timePattern.test(form.runAt))errors.runAt='maintenancePage.error.time';
 if(!form.timeZone||!(form.timeZone==='UTC'||zones.includes(form.timeZone)))errors.timeZone='maintenancePage.error.timeZone';
 return errors;
}
// The fields each drawer edits; the other pair is sent with its current values.
const drawerFields:Record<DrawerKind,readonly Field[]>={retention:['auditDays','jobDays'],schedule:['runAt','timeZone']};

const stateKind:Record<MaintenanceRun['status'],StatusKind>={running:'waiting',succeeded:'success',failed:'critical'};
const stateKey:Record<MaintenanceRun['status'],MessageKey>={running:'maintenancePage.state.running',succeeded:'maintenancePage.state.succeeded',failed:'maintenancePage.state.failed'};
/** The status pill of a run. */
export function RunState({run,size}:{run:MaintenanceRun;size?:'md'|'lg'}){const t=useT();return <StatusPill kind={stateKind[run.status]} size={size}>{t(stateKey[run.status])}</StatusPill>;}

/** Who or what started a run. */
export function triggerLabel(run:Pick<MaintenanceRun,'trigger'|'requestedBy'>,t:Tr):string{
 if(run.trigger==='manual')return t('maintenancePage.trigger.manual',{name:run.requestedBy??EMPTY_VALUE});
 return t(run.trigger==='schedule'?'maintenancePage.trigger.schedule':run.trigger==='continuation'?'maintenancePage.trigger.continuation':'maintenancePage.trigger.cli');
}
// The reason keys of a failed run (runtime/maintenance.mjs, maintenanceFailures).
const runErrorKeys:ReadonlySet<string>=new Set<MaintenanceErrorKey>(['serverMessage.maintenance.retentionInvalid','serverMessage.maintenance.lockLost','serverMessage.maintenance.lockExpired','serverMessage.maintenance.transfersFailed','serverMessage.maintenance.internal']);
/** The text of a failed run: the catalog text of its reason key; any other value shows the internal text, never raw text. */
export function runErrorText(error:string|null|undefined,t:Tr):string{
 return t(typeof error==='string'&&runErrorKeys.has(error)?error as MaintenanceErrorKey:'serverMessage.maintenance.internal');
}
/** The duration of a finished run; EMPTY_VALUE while it runs. */
export function durationText(run:Pick<MaintenanceRun,'startedAt'|'finishedAt'>,t:Tr):string{
 if(run.finishedAt===null)return EMPTY_VALUE;
 const total=Math.max(0,Math.round((run.finishedAt-run.startedAt)/1000)),minutes=Math.floor(total/60),seconds=total%60;
 return minutes?t('maintenancePage.durationMinutes',{minutes,seconds}):t('maintenancePage.durationSeconds',{seconds});
}
const count=(value:number|undefined,locale:Locale)=>formatNumber(locale,Number(value??0));
/** The short result of a history row; EMPTY_VALUE without a result. */
export function historySummary(result:MaintenanceResult|null,t:Tr,locale:Locale):string{
 if(!result)return EMPTY_VALUE;
 const audit=(result.audit?.deleted??0)+(result.customerAudit??[]).reduce((sum,pass)=>sum+pass.deleted,0);
 return t('maintenancePage.historySummary',{audit:count(audit,locale),jobs:count(result.jobs?.deleted,locale),transfers:count(result.transfers?.cleared,locale)});
}

type RunColumn='started';
export default function MaintenancePanel({viewer,frame}:{viewer:Viewer;frame?:PageFrame}){
 const t=useT(),[locale]=useLocale();
 const [view,setView]=useState<MaintenanceView|null>(null),[loadFailed,setLoadFailed]=useState(false),[loading,setLoading]=useState(true);
 const [drawer,setDrawer]=useState<DrawerKind|null>(null),[form,setForm]=useState<Form|null>(null),[submitted,setSubmitted]=useState(false),[starting,setStarting]=useState(false);
 const [watching,setWatching]=useState<number|null>(null),[sort,setSort]=useState<TableSort<RunColumn>|null>(null);
 // The time of the last answer: "now" of the relative times, so a render stays pure.
 const [seenAt,setSeenAt]=useState(0);
 const mounted=useRef(false),sequence=useRef(0);
 const load=useCallback(async()=>{
  const current=++sequence.current;setLoading(true);
  try{
   const next=await api<MaintenanceView>(endpoint);
   if(!mounted.current||current!==sequence.current)return;
   setView(next);setSeenAt(Date.now());setLoadFailed(false);
  }catch{if(mounted.current&&current===sequence.current)setLoadFailed(true);}
  finally{if(mounted.current&&current===sequence.current)setLoading(false);}
 },[]);
 useEffect(()=>{mounted.current=true;void Promise.resolve().then(()=>load());return()=>{mounted.current=false;};},[load,viewer.id]);
 useFrameRefresh(frame,()=>load());
 // A shorter retention deletes audit evidence: only then does the MFA proof come first
 // (maintenanceSaveNeedsStepUp, lib/step-up.ts). Any other save goes out at once; a
 // reply that asks for a proof still opens the dialog and resends once.
 const save=useStepUp<Record<string,unknown>,MaintenanceView>({locale,needsStepUp:payload=>maintenanceSaveNeedsStepUp(view?.settings,payload),send:payload=>api<MaintenanceView>(endpoint,payload),
  onError:failure=>{toast.error(maintenanceFailure(failure,locale));return true;}});
 const running=!!view?.status.running;
 // While a run is active the page asks again every 5 seconds.
 useEffect(()=>{
  if(!running)return;
  const timer=setInterval(()=>{void load();},pollMs);
  return()=>clearInterval(timer);
 },[running,load]);
 // A run started here reports its end once.
 useEffect(()=>{
  if(watching===null||!view)return;
  const run=view.history.find(item=>item.id===watching);
  if(!run||run.status==='running')return;
  queueMicrotask(()=>{
   if(!mounted.current)return;
   setWatching(null);
   if(run.status==='succeeded')toast.success(t('maintenancePage.runSucceeded'));else toast.error(t('maintenancePage.runFailed'));
  });
 },[view,watching,t]);

 const owner=canManageInstanceSettings(viewer),saving=save.busy;
 const locked=!owner?t('maintenancePage.error.ownerOnly'):undefined;
 const zones=maintenanceTimeZones(view?.settings.timeZone??'UTC');
 const runNow=async()=>{
  if(locked||running||starting)return;
  setStarting(true);
  try{
   const {runId}=await api<{runId:number}>(endpoint,{action:'run'});
   if(!mounted.current)return;
   toast.success(t('maintenancePage.runStarted'));setWatching(runId);
   await load();
  }catch(failure){if(mounted.current)toast.error(maintenanceFailure(failure,locale));}
  finally{if(mounted.current)setStarting(false);}
 };
 const open=(kind:DrawerKind)=>{if(!view||locked)return;setForm(formOf(view));setSubmitted(false);setDrawer(kind);};
 const primary=<Btn variant="primary" icon={Archive} blocked={locked} onClick={()=>open('retention')}>{t('maintenancePage.changeRetention')}</Btn>;
 const page=(children:ReactNode,wide?:ReactNode)=><>{frameHeader(frame,primary)}<SettingsPage className="sdx-maintenance" label={t('nav.settings.retention')} loading={!view&&!loadFailed} wide={wide}
  loadError={loadFailed?`${t('maintenancePage.loadError')}${view?' '+t('notifications.staleData'):''}`:undefined} onRetry={()=>void load()} retrying={loading}>{children}</SettingsPage></>;
 if(!view)return page(null);

 // ---- The drawers: each edits its own pair and sends the current values of the other ----
 const baseline=formOf(view),fields=drawer?drawerFields[drawer]:[];
 const dirty=!!form&&fields.some(field=>form[field]!==baseline[field]);
 const values:Form|null=form&&drawer?{...baseline,...Object.fromEntries(fields.map(field=>[field,form[field]]))}:null;
 const errors=values?maintenanceFormErrors(values,zones):{};
 const fieldError=(field:Field):MessageKey|undefined=>{
  if(submitted&&errors[field])return errors[field];
  // An invalid start value shows as an empty field with its error.
  if((field==='auditDays'||field==='jobDays')&&view.envInvalid[field]&&form?.[field]==='')return 'maintenancePage.error.retention';
  return undefined;
 };
 // The server refuses a null day value, so the schedule waits for a valid retention.
 const retentionMissing=view.settings.auditDays===null||view.settings.jobDays===null;
 const saveBlocked=locked??(drawer==='schedule'&&retentionMissing?t('maintenancePage.blockedRetentionInvalid'):!dirty?t('common.noChanges'):undefined);
 const submit=async(event:FormEvent)=>{
  event.preventDefault();
  if(!values||!drawer||saveBlocked||saving)return;
  setSubmitted(true);
  if(fields.some(field=>errors[field]))return;
  const kind=drawer;
  // Cancelling the step-up sends nothing and keeps the input.
  const next=await save.run({action:'set',auditDays:Number(values.auditDays),jobDays:Number(values.jobDays),runAt:values.runAt,timeZone:values.timeZone,revision:view.settings.revision});
  if(!next||!mounted.current)return;
  setView(next);setDrawer(null);setForm(null);setSubmitted(false);
  toast.success(t(kind==='retention'?'maintenancePage.retentionSaved':'maintenancePage.scheduleSaved'));
 };
 const change=(field:Field,value:string)=>setForm(previous=>previous?{...previous,[field]:value}:previous);
 const errorText=(field:Field)=>{const key=fieldError(field);return key?t(key):undefined;};
 const daysField=(field:'auditDays'|'jobDays',label:MessageKey,first:boolean)=>
  <Field label={t(label)} error={errorText(field)} hint={view.settings.source[field]==='env'?<RichText text={t('maintenancePage.sourceEnv')} parts={{variable:<span className="mono">{retentionVariables[field]}</span>}}/>:undefined}>
   <input type="number" inputMode="numeric" min={1} max={3650} step={1} autoFocus={first} value={form?.[field]??''} disabled={saving} onChange={event=>change(field,event.target.value)}/>
  </Field>;
 const footer=(formId:string)=><><DrawerCancel/><Btn variant="primary" type="submit" form={formId} loading={save.sending} blocked={saveBlocked??(saving?t('kit.busy'):undefined)}>{t('common.save')}</Btn></>;
 const close=()=>{setDrawer(null);setSubmitted(false);};

 // ---- The cleanup card ----
 const last=view.status.lastRun,runBlocked=locked??(running?t('maintenancePage.blockedRunning'):undefined);
 const facts=[
  ...(last?[{id:'lastRun',label:t('maintenancePage.fact.lastRun'),value:exactTime(last.startedAt,locale)}]:[]),
  {id:'nextRun',label:t('maintenancePage.fact.nextRun'),value:view.status.nextRunAt===null?EMPTY_VALUE:exactTime(view.status.nextRunAt,locale)},
  {id:'dailyRun',label:t('maintenancePage.fact.dailyRun'),value:t('maintenancePage.dailyRunValue',{time:view.settings.runAt,zone:view.settings.timeZone})},
  ...(last&&last.status!=='succeeded'?[{id:'lastSuccess',label:t('maintenancePage.fact.lastSuccess'),value:view.status.lastSuccessAt===null?EMPTY_VALUE:exactTime(view.status.lastSuccessAt,locale)}]:[]),
 ];
 const history=sortTableRows(view.history,sort,{started:run=>run.startedAt});
 const runColumns:DataColumn<MaintenanceRun>[]=[
  {id:'started',label:t('maintenancePage.col.started'),primary:true,sort:{first:'desc'},cell:run=>exactTime(run.startedAt,locale)},
  {id:'duration',label:t('maintenancePage.col.duration'),mono:true,cell:run=>durationText(run,t)},
  {id:'trigger',label:t('maintenancePage.col.trigger'),cell:run=>triggerLabel(run,t)},
  {id:'status',label:t('maintenancePage.col.status'),cell:run=><RunState run={run}/>},
  {id:'result',label:t('maintenancePage.col.result'),wrap:true,cell:run=><span className="sdx-maintenance-result"><span>{historySummary(run.result,t,locale)}</span>{run.status==='failed'&&run.error&&<small>{runErrorText(run.error,t)}</small>}</span>},
 ];

 // ---- The KPI row and the area table ----
 const kpis=storageKpis(view);
 const rows=retentionRows(view,t,locale);
 const areaColumns:DataColumn<RetentionAreaRow>[]=[
  {id:'area',label:t('maintenancePage.col.area'),primary:true,cell:row=><strong>{row.label}</strong>},
  {id:'keptFor',label:t('maintenancePage.col.keptFor'),cell:row=>row.keptFor},
  {id:'setBy',label:t('maintenancePage.col.setBy'),wrap:true,cell:row=><span className="sdx-maintenance-setby"><RichText text={t(row.setBy.key)} parts={{
   variable:<span className="mono">{row.setBy.variable}</span>,
   customers:<a href={customersHash}>{t('nav.settings.customers')}</a>,
  }}/></span>},
  {id:'size',label:t('maintenancePage.col.size'),cell:row=><span className="sdx-maintenance-size"><span className="mono">{row.size}</span>
   {row.share!==null&&row.shareLabel&&<Meter size="sm" value={row.share} label={row.shareLabel} warning={101} critical={101}/>}</span>},
  {id:'entries',label:t('maintenancePage.col.entries'),align:'end',mono:true,hideBelow:1280,cell:row=>row.entries},
  {id:'lastRun',label:t('maintenancePage.col.lastRun'),wrap:true,cell:row=>row.lastRun},
 ];

 return page(<>
  <KpiRow label={t('maintenancePage.kpi.label')} entranceId="maintenance-kpis">
   <Kpi label={t('maintenancePage.kpi.database')} icon={Database} value={kpis.databaseBytes===null?null:formatBytes(locale,kpis.databaseBytes)}
    detail={kpis.areaBytes===null?undefined:t('maintenancePage.kpi.databaseDetail',{size:formatBytes(locale,kpis.areaBytes)})}/>
   <Kpi label={t('maintenancePage.kpi.transfers')} icon={HardDrive} tone="neutral" value={kpis.transferObjectBytes===null?null:formatBytes(locale,kpis.transferObjectBytes)} detail={t('maintenancePage.kpi.transfersDetail')}/>
   <Kpi label={t('maintenancePage.kpi.deleted')} icon={Eraser} tone={kpis.lastRun?.failed?'critical':'neutral'} value={kpis.lastRun?kpis.lastRun.deleted:null}
    detail={kpis.lastRun?relativeTime(kpis.lastRun.finishedAt,seenAt,locale):undefined}/>
  </KpiRow>
  <Card title={t('maintenancePage.cleanupTitle')} icon={Wrench} iconTone={last?.status==='failed'?'danger':'accent'} description={t('maintenancePage.cleanupDescription')} id="sdx-maintenance-cleanup"
   actions={<>
    <Btn size="sm" icon={CalendarClock} blocked={locked} onClick={()=>open('schedule')}>{t('maintenancePage.changeSchedule')}</Btn>
    <Btn size="sm" icon={Play} loading={starting} blocked={runBlocked} onClick={()=>void runNow()}>{t('maintenancePage.runNow')}</Btn>
   </>}>
   <div className="sdx-maintenance-status">
    {last?<div className="sdx-maintenance-state" aria-live="polite"><RunState run={last} size="lg"/></div>:<p className="sdx-maintenance-never">{t('maintenancePage.neverRun')}</p>}
    {last?.status==='failed'&&<Notice tone="danger" icon={AlertTriangle}>{runErrorText(last.error,t)}</Notice>}
    <Facts columns={2} items={facts}/>
    {view.history.length>0&&<Disclosure title={t('maintenancePage.historyTitle')} icon={History} className="sdx-maintenance-history">
     <DataTable<MaintenanceRun> columns={runColumns} rows={history} rowKey={run=>String(run.id)} label={t('maintenancePage.historyTitle')} variant="flush" cards sort={sort} onSort={next=>setSort(next as TableSort<RunColumn>)}
      // Never shown: the disclosure exists only with runs (the card says "No run yet" without one).
      empty={{icon:History,title:t('maintenancePage.historyTitle'),children:t('maintenancePage.neverRun')}}/>
    </Disclosure>}
   </div>
  </Card>
  <Drawer open={drawer==='retention'} onClose={close} dirty={drawer==='retention'&&dirty} icon={Archive} title={t('maintenancePage.retentionDrawerTitle')} description={t('maintenancePage.retentionDrawerDescription')} footer={footer(retentionFormId)}>
   <form id={retentionFormId} className="sdx-form-grid" noValidate onSubmit={event=>void submit(event)}>
    {daysField('auditDays','maintenancePage.auditDays',true)}
    {daysField('jobDays','maintenancePage.jobDays',false)}
   </form>
  </Drawer>
  <Drawer open={drawer==='schedule'} onClose={close} dirty={drawer==='schedule'&&dirty} icon={CalendarClock} title={t('maintenancePage.scheduleDrawerTitle')} description={t('maintenancePage.scheduleDrawerDescription')} footer={footer(scheduleFormId)}>
   <form id={scheduleFormId} className="sdx-form-grid" noValidate onSubmit={event=>void submit(event)}>
    <Field label={t('maintenancePage.runAt')} error={errorText('runAt')}>
     <input type="time" step={60} autoFocus value={form?.runAt??''} disabled={saving} onChange={event=>change('runAt',event.target.value)}/>
    </Field>
    <Field label={t('maintenancePage.timeZone')} error={errorText('timeZone')}>
     <Select value={form?.timeZone??'UTC'} blocked={saving?t('kit.busy'):undefined} onChange={event=>change('timeZone',event.target.value)}>{zones.map(zone=><option key={zone} value={zone}>{zone}</option>)}</Select>
    </Field>
   </form>
  </Drawer>
  <MfaStepUp {...save.dialog}/>
 </>,<Card title={t('maintenancePage.areasTitle')} icon={Archive} iconTone="accent" description={t('maintenancePage.areasDescription')} id="sdx-maintenance-areas" flush>
  <DataTable<RetentionAreaRow> columns={areaColumns} rows={rows} rowKey={row=>row.id} label={t('maintenancePage.areasTitle')} variant="flush" cards entranceId="maintenance-areas"
   // Never shown: the audit, job and fixed areas are always rows.
   empty={{icon:Archive,title:t('maintenancePage.areasTitle'),children:t('maintenancePage.areasDescription')}}/>
 </Card>);
}
