import type {Job} from './types';
import {defaultLocale,type Locale} from './i18n/locale';
import {translate,type MessageKey} from './i18n/translate';
import {DHCP_CHANGE_OPERATIONS,DNS_CHANGE_OPERATIONS,isPluginOperation,PLUGIN_INSTALL,PLUGIN_JOB,PLUGIN_REMOVE} from './plugin-catalog';
import {AD_SIGN_IN} from './plugin-ad';
import {operations} from './management';
import {diagnosticDefinitions} from './diagnostics';
import {inputObject,parseJobInput} from './job-input';

/**
 * The label key of an agent plugin job (docs/agent-plugins.md): Install plugin,
 * Remove plugin, or the plugin operation, which a plugin job keeps as its target
 * (Read DHCP server for dhcp-read, Create DHCP scope for dhcp-scope-create and
 * so on; Read DNS server for dns-read, Create DNS zone for dns-zone-create).
 * Undefined for any other kind.
 */
export function pluginJobLabelKey(action:string,target?:string|null):MessageKey|undefined{
 if(action===PLUGIN_INSTALL)return 'jobs.kind.pluginInstall';
 if(action===PLUGIN_REMOVE)return 'jobs.kind.pluginRemove';
 if(action===AD_SIGN_IN)return 'jobs.kind.adSignIn';
 if(action===PLUGIN_JOB){
  if(target==='dhcp-read')return 'jobs.kind.dhcpRead';
  if((DHCP_CHANGE_OPERATIONS as readonly string[]).includes(target??''))return `jobs.kind.dhcp.${target!.slice(5).replace(/-(\w)/g,(_,letter:string)=>letter.toUpperCase())}` as MessageKey;
  // The DNS plugin (docs/dns-server.md): Read DNS server, Read DNS zone, Create DNS zone and so on.
  if(target==='dns-read')return 'jobs.kind.dnsRead';
  if(target==='dns-zone-read')return 'jobs.kind.dnsZoneRead';
  if((DNS_CHANGE_OPERATIONS as readonly string[]).includes(target??''))return `jobs.kind.dns.${target!.slice(4).replace(/-(\w)/g,(_,letter:string)=>letter.toUpperCase())}` as MessageKey;
  return 'jobs.kind.pluginJob';
 }
 return undefined;
}

/** The counts of the job dock and the Jobs sheet: running, waiting (pending and due) and scheduled (pending with a later start). The badge shows running + waiting. */
export function jobCounts(jobs:readonly Job[],now:number):{running:number;waiting:number;scheduled:number}{
 const running=jobs.filter(job=>job.state==='running').length,scheduled=jobs.filter(job=>job.state==='pending'&&(job.notBefore??0)>now).length,waiting=jobs.filter(job=>job.state==='pending').length-scheduled;
 return {running,waiting,scheduled};
}

/** Deterministic summary; scheduled work must never look as though it is running. */
export function currentJob(jobs:Job[],now:number,preferredServerId?:string,recentFinishedId?:string):Job|undefined {
 const order=(a:Job,b:Job)=>(a.claimedAt??a.createdAt)-(b.claimedAt??b.createdAt)||a.id.localeCompare(b.id);
 const running=jobs.filter(j=>j.state==='running').sort(order);
 if(running.length)return running.find(j=>j.serverId===preferredServerId)??running[0];
 const waiting=jobs.filter(j=>j.state==='pending'&&(j.notBefore??0)<=now).sort(order);
 if(waiting.length)return waiting.find(j=>j.serverId===preferredServerId)??waiting[0];
 return jobs.find(j=>j.id===recentFinishedId&&!['pending','running'].includes(j.state));
}

/** A span of milliseconds as "12 s", "3 min 4 s" or "1 h 5 min" (jobs.elapsed.*). */
export function durationText(milliseconds:number,locale:Locale=defaultLocale):string {
 const seconds=Math.max(0,Math.floor(milliseconds/1000));
 if(seconds<60)return translate(locale,'jobs.elapsed.seconds',{seconds});
 const minutes=Math.floor(seconds/60);
 return minutes<60?translate(locale,'jobs.elapsed.minutes',{minutes,seconds:seconds%60}):translate(locale,'jobs.elapsed.hours',{hours:Math.floor(minutes/60),minutes:minutes%60});
}
export function jobElapsed(job:Job,now:number,locale:Locale=defaultLocale):string {
 if(job.state!=='running'||job.claimedAt==null)return '';
 return durationText(now-job.claimedAt,locale);
}
/** When a succeeded or failed job ended: its last progress, which the agent result path sets. null for other states. */
export const jobEnded=(job:Pick<Job,'state'|'lastProgress'>):number|null=>(job.state==='succeeded'||job.state==='failed')&&job.lastProgress!=null?job.lastProgress:null;
/** Ended − Started of a finished job, or the elapsed time of a running one; '' when either end is missing. */
export function jobDuration(job:Job,now:number,locale:Locale=defaultLocale):string {
 if(job.state==='running')return jobElapsed(job,now,locale);
 const ended=jobEnded(job);
 return ended!==null&&job.claimedAt!=null?durationText(ended-job.claimedAt,locale):'';
}

/** Runbook progress belongs to its single parent row in tables and the job bar. */
export function jobProgress(job:Job,locale:Locale=defaultLocale):string {
 const progress=job.metadata;if(job.action!=='runbook-run'||!progress)return '';
 const counts={done:progress.completedSteps,total:progress.totalSteps};
 if(progress.cancelRequested&&['pending','running'].includes(job.state))return translate(locale,'jobs.progress.cancelRequested',counts);
 if(progress.currentStep)return progress.currentStepName?translate(locale,'jobs.progress.stepNamed',{...counts,step:progress.currentStep,name:progress.currentStepName}):translate(locale,'jobs.progress.step',{...counts,step:progress.currentStep});
 return translate(locale,'jobs.progress.steps',counts);
}

const bareGuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,bareHash=/^[0-9a-f]{12,128}$/i,scriptTarget=/^(.+) \/ [0-9a-f]{12}$/;
/** The German label a kind's queue path writes as the target when it has no object (safeTarget falls back to it). */
const kindLabel=(kind:string)=>Object.hasOwn(operations,kind)?operations[kind].label:Object.hasOwn(diagnosticDefinitions,kind)?diagnosticDefinitions[kind as keyof typeof diagnosticDefinitions].label:undefined;
/**
 * The object of a job in the admin's words (the job list's second line, the drawer description), or null:
 * the primary field of the kind's kept input (lib/job-input.ts: the service, the DHCP scope, the DNS zone,
 * the path, the local user, the script's first line); else the stored target, unless it is the plugin
 * operation id, the kind itself, its label, a bare GUID or hash, or a text the portal built for a kind
 * whose target is not the admin's words; a script target "<first line> / <hash>" gives its first line.
 * displayInput: the stored jobs.display_input (server side only).
 */
export function jobObject(job:{action:string;target?:string|null;displayInput?:unknown}):string|null{
 const input=parseJobInput(job.displayInput??'{}'),{object,target:targetAllowed}=inputObject(job.action,input);
 if(object)return object;
 const target=(job.target??'').trim();
 if(!target||!targetAllowed||isPluginOperation(target)||target===job.action||target===kindLabel(job.action)||bareGuid.test(target)||bareHash.test(target))return null;
 const script=scriptTarget.exec(target);
 return script?script[1]:target;
}
/** The object of a job in a list: the server's (scopeJobs sets it) or, without it, jobObject of the stored target. */
export const shownJobObject=(job:Pick<Job,'action'|'target'|'object'>)=>job.object!==undefined?job.object:jobObject(job);
