'use client';
// Management → System on the console kit: one page without a third navigation level. A SectionHead
// without a visible title, the KPI row (restart, last start, page file), then the cards Page file,
// Restart and shut down, Scheduled maintenance and Computer & domain. Forms open in the kit Drawer;
// every change is confirmed before it runs. Restart and Shut down open the shared power flow
// (ui/devices/management/device-power.tsx). The rules of the identity actions live in ui/devices/management/management-actions.ts.
// Firewall rules are a card of Management → Network (device-firewall.tsx), Scheduled tasks a
// subarea of their own (device-tasks.tsx).
import {useRef,useState,type FormEvent} from 'react';
import {AlertTriangle,Building2,CalendarClock,Clock,MemoryStick,Pencil,Plus,Power,RefreshCw,RotateCw,X} from 'lucide-react';
import type {Job,Viewer} from '@/lib/types';
import {unavailableReason} from '@/ui/devices/device/device-unavailable';
import {confirmationDevice} from '@/ui/devices/management/management-actions';
import {confirmManagementAction,managementActionTitles,panelManageReason} from '@/ui/devices/management/device-management-confirm';
import {PowerDrawer,systemActionReason,type PowerKind,type PowerTarget} from '@/ui/devices/management/device-power';
import {permitted,stamp,type Device} from '@/ui/base/api';
import type {Confirmation} from '@/ui/base/confirmation';
import {defaultLocale,type Locale} from '@/lib/i18n/locale';
import {translate,type MessageKey} from '@/lib/i18n/translate';
import {EMPTY_VALUE,formatBytes,formatDateTime} from '@/lib/i18n/format';
import {agentMessageText} from '@/lib/agent-messages';
import {Btn,Card,Drawer,Facts,Kpi,KpiRow,Meter,Notice,PanelUnavailable,SectionHead,exactTime,relativeTime} from '@/ui/kit/kit';
import {Field,Select} from '@/ui/kit/field';
import {gibBytes} from '@/ui/devices/hardware/drive-list';
import '@/ui/devices/management/device-system.css';

import {useLocale,useT} from '@/ui/base/locale';
type Props={server:Device;viewer:Viewer;demo:boolean;saving:boolean;onConfirm:(confirmation:Confirmation)=>void;now:number;jobs:Job[]};
type PowerOperation='shutdown'|'restart';
type PowerSchedule={id:string;operation:PowerOperation;scheduledAt:string;reason:string};
type ScheduleDraft={serverId:string;operation:PowerOperation;localAt:string;reason:string};
type Editor={serverId:string;kind:'set-pagefile';automatic:boolean;drive:string;initialMb:string;maximumMb:string};
/** The identity forms: their kind, the typed values and the field errors after a submit. */
type IdentityKind='rename-computer'|'join-domain'|'leave-domain';
type IdentityForm={serverId:string;kind:IdentityKind;values:Record<string,string>};
type FormError={field:string|null;text:string};
const scheduleActions=['schedule-power','cancel-power-schedule'];
/** The focus target of "Open scheduling": the heading of the Scheduled maintenance card. */
export const SYSTEM_SCHEDULE_HEADING='sdx-system-schedule';
/** Moves the focus to the Scheduled maintenance card heading; false while it is not rendered yet. */
export function focusSystemSchedule():boolean{
  const heading=typeof document==='undefined'?null:document.getElementById(SYSTEM_SCHEDULE_HEADING);
  heading?.scrollIntoView({block:'start',behavior:'auto'});heading?.focus({preventScroll:true});
  return !!heading;
}
export {systemActionReason};
/** A size in MiB (page files report binary megabytes) in IEC units. */
const mib=(locale:Locale,value:number|null|undefined)=>typeof value==='number'&&Number.isFinite(value)&&value>=0?formatBytes(locale,value*1024**2):EMPTY_VALUE;
export const SYSTEM_SCHEDULE_WINDOW=30*86400000;
export function systemLocalDate(value:number){const date=new Date(value),pad=(value:number)=>String(value).padStart(2,'0');return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;}
export function systemScheduleTime(value:string,now:number,locale:Locale=defaultLocale):{at:number;error:string}{
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))return {at:NaN,error:translate(locale,'system.schedule.pickTime')};
  const [year,month,day,hour,minute]=value.split(/[-T:]/).map(Number),date=new Date(year,month-1,day,hour,minute);
  if(date.getFullYear()!==year||date.getMonth()!==month-1||date.getDate()!==day||date.getHours()!==hour||date.getMinutes()!==minute)return {at:NaN,error:translate(locale,'system.schedule.invalidTime')};
  const at=date.getTime();
  return at<now+120000?{at,error:translate(locale,'system.schedule.tooSoon')}:at>now+SYSTEM_SCHEDULE_WINDOW?{at,error:translate(locale,'system.schedule.tooLate')}:{at,error:''};
}
function powerSchedule(server:Device):PowerSchedule|null{
  const value=(server.snapshot as (Device['snapshot']&{powerSchedule?:PowerSchedule|null}))?.powerSchedule;
  return value&&typeof value.id==='string'&&value.id.length>0&&['shutdown','restart'].includes(value.operation)&&Number.isFinite(Date.parse(value.scheduledAt))?value:null;
}
function scheduleKnown(server:Device){const value=(server.snapshot as (Device['snapshot']&{powerSchedule?:PowerSchedule|null}))?.powerSchedule;return value===null||powerSchedule(server)!==null;}
const freshDraft=(serverId:string):ScheduleDraft=>({serverId,operation:'shutdown',localAt:'',reason:''});
/** The fields of an identity form; password fields always start empty. */
function identityDefaults(kind:IdentityKind,hostname:string|undefined):Record<string,string>{
  if(kind==='rename-computer')return {name:hostname??'',username:'',password:''};
  if(kind==='join-domain')return {domain:'',ouPath:'',username:'',password:''};
  return {workgroup:'WORKGROUP',username:'',password:''};
}
/** The job parameters of an identity form, exactly as the classic management panel built them. */
function identityParams(kind:IdentityKind,values:Record<string,string>):Record<string,unknown>{
  const trim=(key:string)=>String(values[key]??'').trim();
  if(kind==='rename-computer')return {name:trim('name'),...(trim('username')?{username:trim('username'),password:String(values.password??'')}:{})};
  if(kind==='join-domain')return {domain:trim('domain'),ouPath:trim('ouPath'),username:trim('username'),password:String(values.password??'')};
  return {workgroup:trim('workgroup'),username:trim('username'),password:String(values.password??'')};
}
const identityRequired:Record<IdentityKind,string[]>={'rename-computer':['name'],'join-domain':['domain','username','password'],'leave-domain':['workgroup','username','password']};
const identityDescriptions:Record<IdentityKind,MessageKey>={'rename-computer':'management.rename.description','join-domain':'management.join.description','leave-domain':'management.leave.description'};
const identityTriggers:Record<IdentityKind,MessageKey>={'rename-computer':'tree.rename','join-domain':'management.action.joinDomain','leave-domain':'management.action.leaveDomain'};

export default function DeviceSystem(props:Props){
  const t=useT(),[locale]=useLocale();
  const {server,viewer,demo,saving,now,jobs}=props,live=useRef(props);live.current=props;
  const [draft,setDraft]=useState<ScheduleDraft>(()=>freshDraft(server.id));
  const [editor,setEditor]=useState<Editor|null>(null),[error,setError]=useState<FormError|null>(null);
  const [identity,setIdentity]=useState<IdentityForm|null>(null);
  const [power,setPower]=useState<PowerTarget|null>(null);
  const form=draft.serverId===server.id?draft:freshDraft(server.id),snapshot=server.snapshot,pagefile=snapshot?.pagefile;
  const operation=editor?.serverId===server.id?editor:null,identityForm=identity?.serverId===server.id?identity:null;
  const plan=powerSchedule(server),scheduleReported=scheduleKnown(server),pending=jobs.some(job=>job.serverId===server.id&&['pending','running'].includes(job.state)&&scheduleActions.includes(job.action));
  const latestScheduleJob=jobs.filter(job=>job.serverId===server.id&&scheduleActions.includes(job.action)).reduce<Job|undefined>((latest,job)=>!latest||job.createdAt>latest.createdAt?job:latest,undefined);
  const scheduleFailed=latestScheduleJob&&['failed','interrupted'].includes(latestScheduleJob.state);
  const scheduleTime=systemScheduleTime(form.localAt,now,locale),zone=Intl.DateTimeFormat().resolvedOptions().timeZone||t('system.browserZone');
  const reasonOf=(kind:string)=>systemActionReason(props,kind,locale);
  // Computer & domain keeps the rules of the classic management panel; a running save blocks too.
  const manageReason=(kind:string)=>panelManageReason(props,kind,locale);
  const notice=unavailableReason({demo,revoked:!!server.revoked,permitted:permitted(server,viewer,'manage'),reported:true,supported:true,management:!snapshot||server.management===1&&snapshot.mode==='Management'});
  const changeDraft=(values:Partial<ScheduleDraft>)=>{setError(null);setDraft(previous=>({...freshDraft(server.id),...(previous.serverId===server.id?previous:{}),...values,serverId:server.id}));};
  const action=(kind:string,params:Record<string,unknown>,title:string,description:string,confirmLabel:string,expectedServer=server.id,tone?:'danger')=>{
    const current=live.current;if(current.server.id!==expectedServer||systemActionReason(current,kind,locale))return;
    current.onConfirm({title,description,lines:confirmationDevice(current.server.name,locale),confirmLabel,...(tone?{tone}:{}),payload:{action:'job',id:current.server.id,kind,params,confirm:true}});
  };
  const openPower=(kind:PowerKind)=>{if(live.current.server.id!==server.id||systemActionReason(live.current,kind,locale))return;setPower({serverId:server.id,kind});};
  const openPagefile=()=>{
    const current=live.current;if(current.server.id!==server.id||systemActionReason(current,'set-pagefile',locale)||!current.server.snapshot?.pagefile)return;
    const files=current.server.snapshot.pagefile.files;setError(null);setEditor({serverId:server.id,kind:'set-pagefile',automatic:current.server.snapshot.pagefile.automatic,drive:files[0]?.name.slice(0,2)??current.server.snapshot.disks.find(disk=>/^[A-Z]:$/i.test(disk.name))?.name??'C:',initialMb:String(files[0]?.initialMb||4096),maximumMb:String(files[0]?.maximumMb||8192)});
  };
  const submitSchedule=(event:FormEvent)=>{
    event.preventDefault();const current=live.current;if(form.serverId!==current.server.id||systemActionReason(current,'schedule-power',locale)||!scheduleKnown(current.server)||powerSchedule(current.server)||current.jobs.some(job=>job.serverId===current.server.id&&['pending','running'].includes(job.state)&&scheduleActions.includes(job.action)))return;
    const time=systemScheduleTime(form.localAt,current.now,locale),reason=form.reason.trim();
    if(time.error){setError({field:'time',text:time.error});return;}if(!reason||reason.length>200||/[\u0000-\u001f]/.test(reason)){setError({field:'reason',text:t('system.reasonInvalid')});return;}
    const scheduledAt=new Date(time.at).toISOString();
    action('schedule-power',{operation:form.operation,scheduledAt,reason},t(form.operation==='shutdown'?'system.schedule.shutdownTitle':'system.schedule.restartTitle'),t(form.operation==='shutdown'?'system.schedule.shutdownDescription':'system.schedule.restartDescription',{time:formatDateTime(locale,time.at),zone,scheduledAt,reason}),t('system.scheduled.confirm'),form.serverId);
  };
  const cancelSchedule=(selected:PowerSchedule)=>{
    const current=live.current,latest=powerSchedule(current.server);if(current.server.id!==server.id||latest?.id!==selected.id||latest.scheduledAt!==selected.scheduledAt||latest.operation!==selected.operation)return;
    if(current.jobs.some(job=>job.serverId===current.server.id&&['pending','running'].includes(job.state)&&scheduleActions.includes(job.action)))return;
    action('cancel-power-schedule',{scheduleId:selected.id},t('system.cancel.title'),t(latest.operation==='shutdown'?'system.cancel.shutdownDescription':'system.cancel.restartDescription',{time:stamp(latest.scheduledAt,locale),reason:latest.reason}),t('system.scheduled.remove'),server.id,'danger');
  };
  const submitEditor=(event:FormEvent)=>{
    event.preventDefault();if(!operation)return;const current=live.current;if(operation.serverId!==current.server.id||systemActionReason(current,operation.kind,locale))return;
    const initialMb=Number(operation.initialMb),maximumMb=Number(operation.maximumMb),currentPagefile=current.server.snapshot?.pagefile;
    if(!currentPagefile)return;
    if(!operation.automatic&&(!/^[A-Z]:$/.test(operation.drive)||!current.server.snapshot?.disks.some(disk=>disk.name===operation.drive)||![initialMb,maximumMb].every(value=>Number.isInteger(value)&&value>=16&&value<=1048576)||maximumMb<initialMb)){setError({field:null,text:t('system.pagefileInvalid')});return;}
    action(operation.kind,{automatic:operation.automatic,...(!operation.automatic?{drive:operation.drive,initialMb,maximumMb}:{})},t('system.pagefile.title'),t('system.pagefile.description',{before:currentPagefile.automatic?t('management.automatic'):currentPagefile.files.map(file=>`${file.name}: ${mib(locale,file.initialMb)}–${mib(locale,file.maximumMb)}`).join(', '),after:operation.automatic?t('management.automatic'):`${operation.drive} · ${mib(locale,initialMb)}–${mib(locale,maximumMb)}`}),t('management.pagefile.submit'),operation.serverId);
    setEditor(null);setError(null);
  };
  // Computer & domain: the confirmation of a classic management action, with its review lines.
  const confirmManagement=(kind:string,params:Record<string,unknown>,description:string,confirmLabel:string,tone?:'danger')=>confirmManagementAction(live.current,server.id,kind,params,description,confirmLabel,locale,tone);
  const openIdentity=(kind:IdentityKind)=>{if(manageReason(kind))return;setError(null);setIdentity({serverId:server.id,kind,values:identityDefaults(kind,snapshot?.hostname)});};
  const changeIdentity=(key:string,value:string)=>setIdentity(previous=>previous?{...previous,values:{...previous.values,[key]:value}}:previous);
  const submitIdentity=(event:FormEvent)=>{
    event.preventDefault();if(!identityForm)return;const {kind,values}=identityForm;
    const missing=identityRequired[kind].find(key=>!String(values[key]??'').trim());
    if(missing){setError({field:missing,text:t('system.fieldRequired')});return;}
    confirmManagement(kind,identityParams(kind,values),t(identityDescriptions[kind]),t(identityTriggers[kind]),kind==='leave-domain'?'danger':undefined);
    setIdentity(null);setError(null);
  };
  // KPI values: the restart state, the last start and the summed page file use.
  const files=pagefile?.files??[],sum=(pick:(file:typeof files[number])=>number)=>files.reduce((total,file)=>total+(Number.isFinite(pick(file))&&pick(file)>=0?pick(file):0),0);
  const used=sum(file=>file.currentUsageMb),reserved=sum(file=>file.allocatedMb),peak=sum(file=>file.peakUsageMb);
  const lastBoot=snapshot?.security?.lastBoot?Date.parse(snapshot.security.lastBoot):NaN;
  const usage=(current:number,allocated:number)=>Number.isFinite(current)&&current>=0&&Number.isFinite(allocated)&&allocated>0?Math.min(100,current/allocated*100):null;
  const usageLabel=(name:string,current:number,allocated:number)=>t('system.pagefileUsage',{name,mb:mib(locale,current),mb2:mib(locale,allocated)});
  const scheduleReason=reasonOf('schedule-power')||(pending?t('system.scheduled.syncing'):'')||(!scheduleReported?t('system.scheduled.notCollected'):'');
  const fieldError=(name:string)=>error?.field===name?error.text:undefined;
  const identityField=(key:string,label:string,options:{hint?:string;type?:'password';maxLength?:number;autoFocus?:boolean}={})=><Field key={key} label={label} hint={options.hint} error={fieldError(key)}><input name={key} type={options.type??'text'} value={identityForm?.values[key]??''} maxLength={options.maxLength} autoFocus={options.autoFocus} autoComplete={options.type==='password'?'new-password':'off'} required={identityForm?identityRequired[identityForm.kind].includes(key):false} onChange={event=>changeIdentity(key,event.target.value)}/></Field>;
  const editorReason=operation?reasonOf(operation.kind):'',identityReason=identityForm?manageReason(identityForm.kind):'';
  return <div className="sdx-system">
    <SectionHead hideTitle title={t('management.category.system')} description={t('system.description')} actions={<Btn icon={RefreshCw} blocked={reasonOf('refresh')||undefined} onClick={()=>action('refresh',{},t('system.refreshTitle'),t('system.refreshDescription'),t('management.action.refresh'))}>{t('management.action.refresh')}</Btn>}/>
    <PanelUnavailable reason={notice} readOnly={t('system.readOnly')}/>
    <KpiRow label={t('system.overview')} entranceId={'system-kpi:'+server.id}>
      <Kpi key="restart" label={t('system.restartKpi')} icon={RotateCw} value={snapshot?snapshot.rebootPending?t('system.restartPending'):t('system.restartNotRequired'):null} tone={snapshot?snapshot.rebootPending?'warning':'success':'neutral'} detail={snapshot?snapshot.rebootPending?t('system.rebootWaiting'):t('system.noReboot'):t('device.overview.systemPending')}/>
      <Kpi key="boot" label={t('system.lastStartKpi')} icon={Clock} value={Number.isFinite(lastBoot)?relativeTime(lastBoot,now,locale):null} tone={Number.isFinite(lastBoot)?'accent':'neutral'} detail={Number.isFinite(lastBoot)?exactTime(lastBoot,locale):t('device.overview.bootUnknown')}/>
      <Kpi key="pagefile" label={t('management.pagefileTitle')} icon={MemoryStick} value={files.length?mib(locale,used):null} tone={files.length?'accent':'neutral'} detail={files.length?t('system.pagefileDetail',{total:mib(locale,reserved),peak:mib(locale,peak)}):pagefile?t('system.noPagefile'):t('system.pagefilePending')}
        visual={files.length?<Meter value={usage(used,reserved)} label={usageLabel(files.map(file=>file.name).join(', '),used,reserved)}/>:undefined}/>
    </KpiRow>
    <div className="sdx-system-grid">
      <Card title={t('management.pagefileTitle')} icon={MemoryStick} iconTone="accent" description={pagefile?pagefile.automatic?t('system.managedByWindows'):t('system.configuredManually'):t('management.notCollected')}
        actions={<Btn size="sm" icon={Pencil} blocked={reasonOf('set-pagefile')||(!pagefile?t('system.configPending'):undefined)} onClick={openPagefile}>{t('management.pagefile.submit')}</Btn>}>
        {files.length?<div className="sdx-system-files">{files.map(file=><div className="sdx-system-file" key={file.name}>
          <strong className="mono">{file.name}</strong>
          <Facts columns={3} stacked items={[{id:'current',label:t('storage.current'),value:mib(locale,file.currentUsageMb),mono:true},{id:'peak',label:t('system.peak'),value:mib(locale,file.peakUsageMb),mono:true},{id:'reserved',label:t('monitoring.reserved'),value:mib(locale,file.allocatedMb),mono:true}]}/>
          <Meter value={usage(file.currentUsageMb,file.allocatedMb)} label={usageLabel(file.name,file.currentUsageMb,file.allocatedMb)}/>
          {!pagefile?.automatic&&<small>{t('system.pagefileConfig',{mb:mib(locale,file.initialMb),mb2:mib(locale,file.maximumMb)})}</small>}
        </div>)}</div>:<p className="sdx-system-muted">{pagefile?t('system.noPagefile'):t('system.pagefilePending')}</p>}
      </Card>
      <Card title={t('system.powerTitle')} icon={Power} iconTone="accent" description={t('system.actionsHint')}>
        <div className="sdx-system-actions"><Btn icon={RotateCw} blocked={reasonOf('restart-computer')||undefined} onClick={()=>openPower('restart-computer')}>{t('management.power.restart')}</Btn><Btn icon={Power} blocked={reasonOf('shutdown-computer')||undefined} onClick={()=>openPower('shutdown-computer')}>{t('management.power.shutdown')}</Btn></div>
        <p className="sdx-system-muted">{t('system.actionsHelp')}</p>
      </Card>
    </div>
    <Card id={SYSTEM_SCHEDULE_HEADING} focusTarget title={t('system.scheduled.title')} icon={CalendarClock} iconTone="accent" description={t('system.scheduled.hint')} meta={t('system.scheduled.limit')} className="sdx-system-schedule">
      {plan?<div className="sdx-system-plan">
        <Facts items={[{id:'operation',label:t('system.scheduled.inWindows'),value:t(plan.operation==='shutdown'?'system.operation.shutdown':'system.operation.restart')},{id:'time',label:t('system.scheduled.dateTime'),value:stamp(plan.scheduledAt,locale),hint:`${zone} · ${new Date(plan.scheduledAt).toISOString()}`},{id:'reason',label:t('management.power.reason'),value:plan.reason}]}/>
        <Btn size="sm" icon={X} blocked={reasonOf('cancel-power-schedule')||(pending?t('system.scheduled.syncing'):undefined)} onClick={()=>cancelSchedule(plan)}>{t('system.scheduled.remove')}</Btn>
      </div>:<form className="sdx-system-schedule-form" onSubmit={submitSchedule}>
        <div className="sdx-system-schedule-fields">
          <Field label={t('management.power.scheduled')}><Select name="operation" value={form.operation} onChange={event=>changeDraft({operation:event.target.value as PowerOperation})}><option value="shutdown">{t('management.power.shutdown')}</option><option value="restart">{t('management.power.restart')}</option></Select></Field>
          <Field label={t('system.scheduled.dateTime')} hint={t('system.scheduled.zone',{zone})} error={fieldError('time')}><input name="time" type="datetime-local" value={form.localAt} min={systemLocalDate(now+120000)} max={systemLocalDate(now+SYSTEM_SCHEDULE_WINDOW)} required onChange={event=>changeDraft({localAt:event.target.value})}/></Field>
          <Field label={t('management.power.reason')} error={fieldError('reason')}><input name="reason" value={form.reason} required maxLength={200} placeholder={t('system.scheduled.reasonPlaceholder')} onChange={event=>changeDraft({reason:event.target.value})}/></Field>
        </div>
        <div className="sdx-system-schedule-submit">
          <Btn type="submit" variant="primary" icon={CalendarClock} blocked={scheduleReason||undefined}>{t('system.scheduled.review')}</Btn>
          {form.localAt&&!scheduleTime.error&&<span className="sdx-system-muted"><Clock size={14} aria-hidden/>{t('system.scheduled.pending',{stamp:stamp(scheduleTime.at,locale),toISOString:new Date(scheduleTime.at).toISOString()})}</span>}
        </div>
      </form>}
      {scheduleFailed&&<Notice tone="danger" icon={AlertTriangle}>{t('system.scheduled.failed')} {agentMessageText(latestScheduleJob,t)||t('system.scheduled.unconfirmed')}</Notice>}
      {pending&&<p className="sdx-system-muted" role="status">{t('system.scheduled.syncing')}</p>}
      {!scheduleReported&&!reasonOf('schedule-power')&&<p className="sdx-system-muted" role="status">{t('system.scheduled.missing')}</p>}
      <p className="sdx-system-muted">{t('system.scheduled.persistent')}</p>
    </Card>
    <Card title={t('management.category.identity')} icon={Building2} iconTone="accent" className="sdx-system-identity"
      actions={<><Btn size="sm" icon={Pencil} blocked={manageReason('rename-computer')||undefined} onClick={()=>openIdentity('rename-computer')}>{t('tree.rename')}</Btn><Btn size="sm" icon={Plus} blocked={manageReason('join-domain')||undefined} onClick={()=>openIdentity('join-domain')}>{t('management.action.joinDomain')}</Btn><Btn size="sm" variant="danger" blocked={manageReason('leave-domain')||undefined} onClick={()=>openIdentity('leave-domain')}>{t('management.action.leaveDomain')}</Btn></>}>
      <Facts columns={2} items={[
        {id:'name',label:t('management.computerName'),value:snapshot?.hostname??EMPTY_VALUE,mono:true},
        {id:'domain',label:t('management.domainOrWorkgroup'),value:snapshot?.domain??EMPTY_VALUE,mono:true},
        {id:'membership',label:t('management.domainMembership'),value:snapshot?.security?snapshot.security.domainJoined?t('management.domainMember'):t('management.param.workgroup'):t('management.notCollected')},
        {id:'role',label:t('management.systemRole'),value:snapshot?.security?.domainRole===4||snapshot?.security?.domainRole===5?t('management.domainController'):snapshot?.security?t('management.memberServer'):t('management.notCollected')},
      ]}/>
    </Card>
    <Drawer open={!!operation} onClose={()=>{setEditor(null);setError(null);}} title={t('management.pagefile.configure')}
      footer={<><Btn onClick={()=>{setEditor(null);setError(null);}}>{t('common.cancel')}</Btn><Btn type="submit" form="sdx-system-editor" variant="primary" blocked={editorReason||undefined}>{t('management.reviewChange')}</Btn></>}>
      {operation&&<form id="sdx-system-editor" className="sdx-system-editor" onSubmit={submitEditor}>
          <Field inline label={t('system.pagefileAutomatic')}><input name="automatic" type="checkbox" role="switch" checked={operation.automatic} onChange={event=>setEditor({...operation,automatic:event.target.checked})}/></Field>
          {!operation.automatic&&<>
            <Field label={t('system.pagefileDrive')}><Select name="drive" value={operation.drive} onChange={event=>setEditor({...operation,drive:event.target.value})}>{snapshot?.disks.filter(disk=>/^[A-Z]:$/.test(disk.name)).map(disk=><option key={disk.name} value={disk.name}>{t('system.driveOption',{name:disk.name,free:Number.isFinite(disk.freeGb)&&disk.freeGb>=0?formatBytes(locale,gibBytes(disk.freeGb)):EMPTY_VALUE})}</option>)}</Select></Field>
            <Field label={t('management.param.initialMb')}><input name="initialMb" type="number" min={16} max={1048576} required value={operation.initialMb} onChange={event=>setEditor({...operation,initialMb:event.target.value})}/></Field>
            <Field label={t('management.param.maximumMb')}><input name="maximumMb" type="number" min={16} max={1048576} required value={operation.maximumMb} onChange={event=>setEditor({...operation,maximumMb:event.target.value})}/></Field>
          </>}
          <p className="sdx-system-muted">{t('system.pagefileOthers')}</p>
        {error&&<p className="sdx-field-error" role="alert">{error.text}</p>}
      </form>}
    </Drawer>
    <Drawer open={!!identityForm} onClose={()=>{setIdentity(null);setError(null);}} title={identityForm?t(managementActionTitles[identityForm.kind]):''} description={identityForm?t(identityDescriptions[identityForm.kind]):undefined}
      footer={<><Btn onClick={()=>{setIdentity(null);setError(null);}}>{t('common.cancel')}</Btn><Btn type="submit" form="sdx-system-identity" variant="primary" blocked={identityReason||undefined}>{t('management.reviewChange')}</Btn></>}>
      {identityForm&&<form id="sdx-system-identity" className="sdx-system-editor" onSubmit={submitIdentity}>
        {identityForm.kind==='rename-computer'&&<>{identityField('name',t('management.rename.newName'),{hint:t('management.rename.help'),maxLength:15,autoFocus:true})}{identityField('username',t('management.rename.account'),{hint:t('management.rename.accountHelp'),maxLength:256})}{identityField('password',t('management.rename.password'),{type:'password',maxLength:127})}</>}
        {identityForm.kind==='join-domain'&&<>{identityField('domain',t('management.join.domain'),{hint:t('management.join.domainHelp'),maxLength:253,autoFocus:true})}{identityField('ouPath',t('management.join.ou'),{hint:t('management.join.ouHelp'),maxLength:1000})}{identityField('username',t('management.field.domainAccount'),{hint:t('management.field.domainAccountHelp'),maxLength:256})}{identityField('password',t('management.field.password'),{type:'password',maxLength:127})}</>}
        {identityForm.kind==='leave-domain'&&<>{identityField('workgroup',t('management.leave.workgroup'),{maxLength:15,autoFocus:true})}{identityField('username',t('management.field.domainAccount'),{hint:t('management.field.domainAccountHelp'),maxLength:256})}{identityField('password',t('management.field.password'),{type:'password',maxLength:127})}</>}
        <p className="sdx-system-muted">{t('management.passwordNote')}</p>
      </form>}
    </Drawer>
    <PowerDrawer target={power} servers={[server]} viewer={viewer} demo={demo} saving={saving} now={now} onConfirm={props.onConfirm} onClose={()=>setPower(null)}/>
  </div>;
}
