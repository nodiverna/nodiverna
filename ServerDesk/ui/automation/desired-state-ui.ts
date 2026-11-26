import {desiredTemplates} from '@/lib/desired-state-operations';
import type {ServerMessage} from '@/lib/server-messages';
import {defaultLocale,type Locale} from '@/lib/i18n/locale';
import {translate,type MessageKey} from '@/lib/i18n/translate';

export type DesiredEngine='dsc3'|'powershell-dsc'|'mof';
export type DesiredVersion={id:string;configId:string;version:number;engine:DesiredEngine;sha256:string;configurationName:string|null;parameters?:Record<string,string|number|boolean>;source:{kind?:string;owner?:string;repository?:string;ref?:string;path?:string;commit?:string};createdAt:number;content?:string};
export type DesiredConfiguration={id:string;name:string;description:string;versions:DesiredVersion[];versionCount?:number;assignmentCount?:number;canDelete?:boolean;deleteReason?:ServerMessage};
export type DesiredResult={engine:string;runtime?:string;compliant:boolean|null;rebootPending:boolean;checkedAt:string;resourceDetail?:string;resourceCount?:number;nonCompliantCount?:number;resources?:{name:string;type:string;inDesiredState:boolean|null;differingProperties:string[]}[]};
export type DesiredRun={id:string;assignmentId:string;serverId:string;versionId:string;jobId:string;operation:string;state:string;message:string|null;/** Agent message code and arguments of message (lib/agent-messages.ts). */resultCode?:string|null;resultArgs?:Record<string,string>|null;createdAt:number;lastProgressAt?:number|null;resultAt?:number|null;configuration?:{name:string;version:number;deleted:boolean}|null;data:DesiredResult|null};
export type DesiredAssignment={id:string;serverId:string;versionId:string;assignedAt?:number;enabled:boolean;intervalSeconds:number;lastCheckedAt:number|null;latestRun?:DesiredRun|null;latestComplianceRun?:DesiredRun|null;lastJobId?:string|null;lastResultState?:'succeeded'|'failed'|null;lastResultAt?:number|null;lastCompliant?:boolean|null;lastCompliantAt?:number|null};
export type DesiredStatusTone='neutral'|'good'|'warning'|'danger'|'live';
export type DesiredData={configs:DesiredConfiguration[];assignments:DesiredAssignment[];runs:DesiredRun[];selectedVersion?:DesiredVersion;selectedRun?:DesiredRun;github:{privateAvailable:boolean}};
export type DesiredDraft={content:string;configurationName:string;parameters:string};
export type DesiredDrafts=Record<DesiredEngine,DesiredDraft>;
/** Engine formats; label and hint are message keys. */
export const desiredFormats:Record<DesiredEngine,{label:MessageKey;short:string;extension:string;language:string;hint:MessageKey}>={
 dsc3:{label:'desired.format.dsc3',short:'JSON',extension:'.json',language:'JSON',hint:'desired.format.dsc3Hint'},
 'powershell-dsc':{label:'desired.format.powershell',short:'PowerShell',extension:'.ps1',language:'PowerShell',hint:'desired.format.powershellHint'},
 mof:{label:'desired.format.mof',short:'MOF',extension:'.mof',language:'MOF',hint:'desired.format.mofHint'}
};
/** Run states as message keys. */
export const desiredRunStates:Record<string,MessageKey>={pending:'jobs.state.pending',running:'jobs.state.running',succeeded:'updates.terminal.succeeded',failed:'jobs.state.failed',cancelled:'jobs.state.cancelled',expired:'storage.state.expired'};
const runState=(state:string,locale:Locale)=>Object.hasOwn(desiredRunStates,state)?translate(locale,desiredRunStates[state]):state;
export function desiredDrafts(version?:DesiredVersion):DesiredDrafts{
 const drafts:DesiredDrafts={dsc3:{content:desiredTemplates.dsc3,configurationName:'',parameters:'{}'},'powershell-dsc':{content:desiredTemplates['powershell-dsc'],configurationName:'ServerDeskConfig',parameters:'{}'},mof:{content:'',configurationName:'',parameters:'{}'}};
 if(version)drafts[version.engine]={content:version.content??'',configurationName:version.configurationName??'ServerDeskConfig',parameters:JSON.stringify(version.parameters??{},null,2)};
 return drafts;
}
export function desiredFileEngine(filename:string):DesiredEngine|null{const extension=filename.split('.').pop()?.toLowerCase();return extension==='json'?'dsc3':extension==='ps1'?'powershell-dsc':extension==='mof'?'mof':null;}
export function desiredScheduleLabel(seconds:number,locale:Locale=defaultLocale){return translate(locale,seconds===0?'services.startup.manual':seconds<3600?'desired.schedule.minutes':seconds===3600?'desired.schedule.hourly':seconds===86400?'customers.days.daily':'desired.schedule.hours',{minutes:seconds/60,hours:seconds/3600});}
export function desiredVersionLabel(configs:DesiredConfiguration[],id:string,locale:Locale=defaultLocale){for(const config of configs){const version=config.versions.find(v=>v.id===id);if(version)return `${config.name} · v${version.version}`;}return translate(locale,'desired.versionMissing');}
export function desiredAssignmentRuns(assignment:DesiredAssignment,runs:DesiredRun[],locale:Locale=defaultLocale){
 const matching=runs.filter(r=>r.assignmentId===assignment.id&&r.versionId===assignment.versionId).sort((a,b)=>b.createdAt-a.createdAt);
 const belongs=(run:DesiredRun|null|undefined)=>run?.assignmentId===assignment.id&&run.versionId===assignment.versionId;
 const latest=belongs(assignment.latestRun)?assignment.latestRun!:matching[0]??null;
 const candidate=belongs(assignment.latestComplianceRun)?assignment.latestComplianceRun!:matching.find(r=>r.state==='succeeded'&&typeof r.data?.compliant==='boolean')??null;
 const compliance=candidate?.state==='succeeded'&&typeof candidate.data?.compliant==='boolean'?candidate:null;
 // Runs win while their jobs exist. After job retention the assignment keeps the
 // last result and verdict, so the status falls back to those stored values.
 const compliant=compliance?compliance.data?.compliant??null:assignment.lastCompliant??null;
 const compliantAt=compliance?compliance.data?.checkedAt??compliance.resultAt??compliance.createdAt:assignment.lastCompliantAt??null;
 return {latest,compliance,compliant,compliantAt,status:latest?desiredRunStatus(latest,locale):desiredStoredStatus(assignment,locale)};
}
function desiredStoredStatus(assignment:DesiredAssignment,locale:Locale):{label:string;tone:DesiredStatusTone}{
 if(assignment.lastResultState==='failed')return {label:runState('failed',locale),tone:'danger'};
 if(assignment.lastResultState==='succeeded'){
  if(typeof assignment.lastCompliant==='boolean')return {label:translate(locale,assignment.lastCompliant?'desired.compliant':'desired.drifted'),tone:assignment.lastCompliant?'good':'warning'};
  return {label:runState('succeeded',locale),tone:'neutral'};
 }
 return desiredRunStatus(null,locale);
}
export function desiredRunStatus(run:DesiredRun|null|undefined,locale:Locale=defaultLocale):{label:string;tone:DesiredStatusTone}{
 if(!run)return {label:translate(locale,'desired.notChecked'),tone:'neutral'};
 if(run.state==='pending'||run.state==='running')return {label:runState(run.state,locale),tone:'live'};
 if(run.state==='succeeded'&&typeof run.data?.compliant==='boolean')return {label:translate(locale,run.data.compliant?'desired.compliant':'desired.drifted'),tone:run.data.compliant?'good':'warning'};
 return {label:runState(run.state,locale),tone:run.state==='failed'?'danger':'neutral'};
}
type ReadinessDevice={management:number;snapshot:{mode?:string;protocolVersion?:number;os?:string;agentCapabilities?:string[]}|null};
export function desiredExecutionReason(device:ReadinessDevice|undefined,allowed:boolean,operation:'test'|'apply',locale:Locale=defaultLocale){
 if(!allowed)return translate(locale,'desired.blocked.permission');
 if(!device?.snapshot)return translate(locale,'desired.blocked.noData');
 if(device.management!==1||device.snapshot.mode!=='Management')return translate(locale,'desired.blocked.management');
 if(device.snapshot.protocolVersion!==3||!device.snapshot.agentCapabilities?.includes('desired-state-'+operation))return translate(locale,operation==='test'?'desired.blocked.updateTest':'desired.blocked.updateApply');
 if(!/Windows (?:Server (?:2022|2025)|11)/i.test(device.snapshot.os??''))return translate(locale,'desired.blocked.os');
 return '';
}
export function desiredTargetReason({assignment,versionId,intervalSeconds,canManage,executionReason}:{assignment?:DesiredAssignment;versionId:string;intervalSeconds:number;canManage:boolean;executionReason:string},locale:Locale=defaultLocale){
 if(!canManage)return translate(locale,'desired.blocked.assign');
 if(assignment?.enabled&&assignment.versionId!==versionId)return translate(locale,'desired.blocked.removeFirst');
 if(assignment?.enabled&&assignment.intervalSeconds!==intervalSeconds)return translate(locale,'desired.blocked.changeSchedule');
 if(intervalSeconds>0&&executionReason)return executionReason;
 return '';
}
