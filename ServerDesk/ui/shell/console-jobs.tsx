'use client';
import type {Job,Server,Viewer} from '@/lib/types';
import {permitted} from '@/ui/base/api';
import {operationLabel} from '@/ui/devices/management/management-actions';
import {pluginJobLabelKey} from '@/lib/job-display';
import {jobParametersFromTarget,jobRequirements} from '@/lib/jobs/requirements';
import {defaultLocale,type Locale} from '@/lib/i18n/locale';
import {operationKey} from '@/ui/base/operation-labels';
import {translate,type MessageKey} from '@/lib/i18n/translate';

// Job kinds that are no management operation, as message keys.
const jobActionKeys:Record<string,MessageKey>={'agent-update':'jobs.action.agentUpdate','assistant-powershell':'jobs.action.assistantPowershell','agent-uninstall':'jobs.action.agentUninstall','runbook-step':'jobs.action.runbookStep','runbook-run':'jobs.action.runbookRun','list-processes':'jobs.action.listProcesses','kill-process':'jobs.action.killProcess','list-sessions':'jobs.action.listSessions','message-session':'jobs.action.messageSession','disconnect-session':'jobs.action.disconnectSession','logoff-session':'jobs.action.logoffSession','list-connections':'jobs.action.listConnections','network-diagnostics':'jobs.action.networkDiagnostics','query-events':'jobs.action.queryEvents','export-events':'jobs.action.exportEvents','support-bundle':'jobs.action.supportBundle'};
const jobStateKeys:Record<string,MessageKey>={pending:'jobs.state.pending',running:'jobs.state.running',succeeded:'jobs.state.succeeded',failed:'jobs.state.failed',expired:'jobs.state.expired',cancelled:'jobs.state.cancelled',unknown:'jobs.state.unknown'};
const own=<T,>(map:Record<string,T>,key:string)=>Object.hasOwn(map,key)?map[key]:undefined;

export const jobActionLabel=(action:string,locale:Locale=defaultLocale,target?:string|null)=>{const key=pluginJobLabelKey(action,target)??own(jobActionKeys,action)??operationKey(action);return key?translate(locale,key):operationLabel(action,locale);};
export const jobLabel=(state:string,locale:Locale=defaultLocale)=>translate(locale,own(jobStateKeys,state)??'jobs.state.other');
// The cancel button exists for a pending job of a known device. Runbook runs are
// cancelled elsewhere. Rights do not hide it: canCancelJob decides whether it is enabled.
export function cancelJobVisible(job:Job,servers:Pick<Server,'id'>[]){
 return job.state==='pending'&&job.action!=='runbook-run'&&servers.some(s=>s.id===job.serverId);
}
export function canCancelJob(job:Job,servers:Server[],viewer:Viewer){
 const server=servers.find(s=>s.id===job.serverId);if(!server||!cancelJobVisible(job,servers))return false;
 // The list carries no parameters, so the button reflects the kind's base rights.
 return jobRequirements(job.action,jobParametersFromTarget(job.action,job.target)).permissions.every(right=>permitted(server,viewer,right));
}
/**
 * Why "Cancel job" cannot act, or null when it can: sample devices first, then the missing permission, then another
 * change that is still saving. The drawer button, the History row menu entry and the dock button show it as their
 * blocked reason (nodiverna-ui §5 Blocked), never as a bare native disabled.
 */
export function cancelJobBlocked(job:Job,servers:Server[],viewer:Viewer,{demo,saving}:{demo:boolean;saving:boolean}):MessageKey|null{
 if(demo)return 'kit.unavailable.demo';
 if(!canCancelJob(job,servers,viewer))return 'jobs.cancel.blockedPermission';
 if(saving)return 'kit.busy';
 return null;
}
