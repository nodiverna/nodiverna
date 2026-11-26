'use client';
// Read-only parts of Desired State (ui/automation/desired-state-panel.tsx) on the console kit: the status
// pill of a run or an assignment, the success feedback with its "View job" link, the resource
// result, the assignment state card of a device (the focal point of the device view), the saved
// source of a version and the details of one run.
import type {ReactNode} from 'react';
import {AlertTriangle,Check,Clock3,FileCode2,LoaderCircle,ShieldCheck,X} from 'lucide-react';
import {desiredAssignmentRuns,desiredFormats,desiredRunStates,desiredRunStatus,desiredScheduleLabel,desiredVersionLabel,type DesiredAssignment,type DesiredConfiguration,type DesiredResult,type DesiredRun,type DesiredVersion} from '@/ui/automation/desired-state-ui';
import {stamp} from '@/ui/base/api';
import {EMPTY_VALUE} from '@/lib/i18n/format';
import {agentMessageText} from '@/lib/agent-messages';
import {Card,Facts,IconBtn,Notice,Skeleton,StatusPill,type IconTone,type StatusKind} from '@/ui/kit/kit';
import {DataTable,type DataColumn} from '@/ui/kit/data-table';

import {useLocale,useT} from '@/ui/base/locale';
/** The kit pill of a Desired State tone (ui/automation/desired-state-ui.ts): good, warning, danger, live (a running job) or neutral. */
export const desiredPillKind=(tone:string):StatusKind=>tone==='good'?'success':tone==='warning'?'warning':tone==='danger'?'critical':tone==='live'?'waiting':'neutral';
const desiredTileTone=(tone:string):IconTone=>tone==='good'?'success':tone==='warning'?'warning':tone==='danger'?'danger':tone==='live'?'accent':'neutral';
export function DesiredStatus({run,label,tone}:{run?:DesiredRun|null;label?:string;tone?:string}){
 const [locale]=useLocale(),status=desiredRunStatus(run,locale);
 return <StatusPill kind={desiredPillKind(tone??status.tone)}>{label??status.label}</StatusPill>;
}

export function DesiredFeedback({text,warning=false,onDismiss,children}:{text:string;warning?:boolean;onDismiss:()=>void;children?:ReactNode}){
 const t=useT();
 return <div className={'ds-feedback '+(warning?'ds-feedback-warning':'')} role="status" aria-live="polite"><span>{warning?<AlertTriangle size={16} aria-hidden/>:<Check size={16} aria-hidden/>}</span><div>{text}{children}</div><IconBtn icon={X} label={t('desired.closeNotice')} onClick={onDismiss}/></div>;
}

type Resource=NonNullable<DesiredResult['resources']>[number]&{index:number};
export function DesiredResources({result}:{result:DesiredResult|null|undefined}){
 const t=useT();
 if(typeof result?.compliant!=='boolean')return null;
 const resources=Array.isArray(result.resources)?result.resources:[],different=resources.filter(r=>r.inDesiredState===false).length;
 const columns:DataColumn<Resource>[]=[
  {id:'resource',label:t('desired.resource'),primary:true,wrap:true,cell:resource=><span className="sdx-cell-stack"><strong>{resource.name}</strong><small>{resource.type}</small></span>},
  {id:'status',label:t('management.status'),cell:resource=><DesiredStatus label={resource.inDesiredState===true?t('desired.compliant'):resource.inDesiredState===false?t('desired.drifted'):t('services.unknown')} tone={resource.inDesiredState===true?'good':resource.inDesiredState===false?'warning':'neutral'}/>},
  {id:'properties',label:t('desired.driftedProperties'),wrap:true,cell:resource=>resource.differingProperties?.length?resource.differingProperties.join(', '):EMPTY_VALUE},
 ];
 return <div className="ds-resource-result">
  {result.rebootPending&&<Notice tone="warning" icon={AlertTriangle}>{t('desired.rebootPending')}</Notice>}
  {result.resourceDetail==='overall-reference'&&<p className="ds-help">{t('desired.psdscSummary')}</p>}
  {!!resources.length&&<details className="ds-disclosure" open={different>0}><summary><span>{t('desired.resources',{count:resources.length})}</span><span>{different?t('desired.driftedCount',{count:different}):t('desired.viewDetails')}</span></summary>
   <DataTable<Resource> label={t('desired.resources',{count:resources.length})} cards columns={columns} rows={resources.map((resource,index)=>({...resource,index}))} rowKey={resource=>resource.name+'-'+resource.index} empty={{icon:ShieldCheck,title:t('desired.noStructured')}}/>
  </details>}
 </div>;
}

/** The assignment state of one device: the compliance pill, the facts, a running job, the last failure, the actions (children) and the resources. */
export function DesiredDeviceState({assignment,configs,runs,deviceName,connected,children}:{assignment:DesiredAssignment;configs:DesiredConfiguration[];runs:DesiredRun[];deviceName:string;connected:boolean;children?:ReactNode}){
 const t=useT(),[locale]=useLocale();
 const {latest,compliance,compliant,compliantAt,status}=desiredAssignmentRuns(assignment,runs,locale),active=latest?.state==='pending'||latest?.state==='running';
 const label=desiredVersionLabel(configs,assignment.versionId,locale);
 return <Card title={deviceName} icon={ShieldCheck} iconTone={desiredTileTone(status.tone)} description={t('desired.activeAssignment',{desiredVersionLabel:label})} meta={<DesiredStatus label={status.label} tone={status.tone}/>}>
  <div className="ds-device-state">
   <Facts columns={3} items={[
    {id:'schedule',label:t('desired.schedule'),value:desiredScheduleLabel(assignment.intervalSeconds,locale),hint:assignment.intervalSeconds?t('desired.scheduleChecks'):t('desired.scheduleManual')},
    {id:'check',label:t('desired.lastCheck'),value:compliant===true?t('desired.compliant'):compliant===false?t('desired.drifted'):t('desired.noSuccess'),hint:compliant!==null?stamp(compliantAt,locale):t('desired.assignmentOnly')},
    {id:'version',label:t('desired.fixedVersion'),value:label,hint:t('desired.fixedVersionHint')},
   ]}/>
   {active&&latest&&<Notice tone="info" icon={LoaderCircle}><strong>{t(latest.operation==='apply'?'desired.run.apply':'desired.run.check',{state:Object.hasOwn(desiredRunStates,latest.state)?t(desiredRunStates[latest.state]):latest.state})}</strong> {latest.state==='pending'&&!connected?t('desired.waitingConnection'):latest.state==='pending'?t('desired.waitingAgent'):latest.lastProgressAt?t('desired.lastFeedback',{time:stamp(latest.lastProgressAt,locale)}):t('desired.running')} · {t('desired.started',{stamp:stamp(latest.createdAt,locale)})}</Notice>}
   {latest?.state==='failed'&&<Notice tone="danger" icon={AlertTriangle}>{runMessage(latest,t)||t('desired.lastFailed')}{compliance&&<> {t('desired.complianceFromLast')}</>}</Notice>}
   {compliance?.data&&typeof compliance.data.resourceCount==='number'&&compliance.data.resourceCount>0&&<p className="ds-help">{t(compliance.id===latest?.id?'desired.resourcesSummaryLatest':'desired.resourcesSummaryCompliance',{count:compliance.data.resourceCount,drifted:compliance.data.nonCompliantCount??0})}</p>}
   {children}
   <DesiredResources result={compliance?.data}/>
  </div>
 </Card>;
}

export function DesiredVersionSource({version,name,source,loading,error,children}:{version:DesiredVersion;name:string;source:DesiredVersion|null;loading:boolean;error:string;children?:ReactNode}){
 const t=useT(),[locale]=useLocale();
 const format=desiredFormats[version.engine],matches=source?.id===version.id&&source.engine===version.engine;
 return <section className="ds-source-viewer">
  <div className="ds-source-head"><div><h4><FileCode2 size={16} aria-hidden/>{name.replace(/[^A-Za-z0-9_.-]/g,'_')+'-v'+version.version+format.extension}</h4><p className="ds-help">{t('desired.savedVersion',{label:t(format.label),language:format.language})}</p></div>{children}</div>
  {loading&&!matches?<Skeleton variant="facts" rows={3} label={t('desired.sourceLoading')}/>:error?<Notice tone="danger" icon={AlertTriangle}>{error}</Notice>:matches?<pre className="ds-source-code" aria-label={t('desired.savedConfig',{language:format.language})}><code>{source.content}</code></pre>:<p className="ds-help">{t('desired.sourceMissing')}</p>}
  <details className="ds-disclosure"><summary><span>{t('desired.versionOrigin')}</span><span>{version.source.kind==='github'?t('desired.githubCommit'):t('desired.portalFile')}</span></summary>
   <Facts items={[
    {id:'format',label:t('desired.format'),value:`${t(format.label)} (${format.extension})`},
    {id:'created',label:t('runbooks.created'),value:stamp(version.createdAt,locale)},
    {id:'sha',label:t('releases.sha256'),value:version.sha256,mono:true},
    ...(version.engine==='powershell-dsc'&&version.configurationName?[{id:'name',label:t('desired.configurationName'),value:version.configurationName}]:[]),
    ...(version.source.kind==='github'?[{id:'repository',label:t('desired.repository'),value:`${version.source.owner}/${version.source.repository} · ${version.source.path}`},{id:'commit',label:t('desired.fixedCommit'),value:version.source.commit??'',mono:true},{id:'ref',label:t('desired.importedBy'),value:version.source.ref??''}]:[]),
    ...(matches&&version.engine!=='mof'&&source.parameters&&Object.keys(source.parameters).length>0?[{id:'parameters',label:t('desired.parameters'),value:<pre className="ds-source-code">{JSON.stringify(source.parameters,null,2)}</pre>}]:[]),
   ]}/>
  </details>
 </section>;
}

// A run's message is the job result: coded agent messages show in the UI language.
const runMessage=(run:DesiredRun,t:ReturnType<typeof useT>)=>agentMessageText({result:run.message,resultCode:run.resultCode,resultArgs:run.resultArgs},t);

export function DesiredRunDetails({run,deviceName,versionLabel,children,loading=false}:{run:DesiredRun;deviceName:string;versionLabel:string;children?:ReactNode;loading?:boolean}){
  const t=useT(),[locale]=useLocale(),message=runMessage(run,t);
  return <Card title={`${deviceName} · ${run.operation==='apply'?t('desired.apply'):t('network.check')}`} description={versionLabel} meta={<DesiredStatus run={run}/>} actions={children}>
   <div className="ds-device-state">
    <p className="ds-run-summary"><span><Clock3 size={14} aria-hidden/>{t('desired.started',{stamp:stamp(run.createdAt,locale)})}</span>{run.resultAt&&<span>{t('desired.result',{stamp:stamp(run.resultAt,locale)})}</span>}{run.data?.runtime&&<span>{run.data.runtime}</span>}</p>
    {message&&(run.state==='failed'?<Notice tone="danger" icon={AlertTriangle}>{message}</Notice>:<p className="ds-help">{message}</p>)}
    {loading?<Skeleton variant="facts" rows={3} label={t('desired.resultLoading')}/>:<DesiredResources result={run.state==='succeeded'?run.data:null}/>}
    {!loading&&run.state==='succeeded'&&!run.data&&<p className="ds-help">{t('desired.noStructured')}</p>}
   </div>
  </Card>;
}
