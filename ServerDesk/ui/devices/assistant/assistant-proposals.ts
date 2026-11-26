// The commands of the device assistant in the panel (docs/ai-assistant.md,
// "Commands"): the label of a proposal, why Run on device is blocked, the
// confirmation, the run payload, the poll schedule of a queued job and the
// history question of a follow-up. Pure: no React, no network, so the view
// tests run it with fakes. The server checks every run again.
import type {Server,Viewer} from '@/lib/types';
import type {AssistantProposal} from '@/lib/assistant-config';
import {assistantFinalJobStates,scriptLineCount} from '@/lib/assistant-config';
import {jobRequirements} from '@/lib/jobs/requirements';
import {assistantActionNeedsStepUp} from '@/lib/step-up';
import type {Confirmation,ConfirmationOutcome} from '@/ui/base/confirmation';
import {permitted} from '@/ui/base/api';
import {jobActionLabel} from '@/ui/shell/console-jobs';
import type {Locale} from '@/lib/i18n/locale';
import type {Translate} from '@/ui/base/locale';

/** The job label of a proposal (jobActionKeys) or "PowerShell script". */
export const proposalLabel=(proposal:AssistantProposal,t:Translate,locale:Locale)=>proposal.type==='powershell'?t('assistant.proposal.powershell'):jobActionLabel(proposal.kind,locale);
/** The command as one line: label and target, or "PowerShell script, 3 lines". */
export function proposalCommand(proposal:AssistantProposal,t:Translate,locale:Locale):string{
 if(proposal.type==='powershell')return `${t('assistant.proposal.powershell')}, ${t('assistant.proposal.lines',{count:scriptLineCount(proposal.script)})}`;
 return proposal.target?`${proposalLabel(proposal,t,locale)} · ${proposal.target}`:proposalLabel(proposal,t,locale);
}
/** The rights, mode and capabilities a proposal needs, as the console reads them (lib/jobs/requirements.ts). */
const requirementsOf=(proposal:AssistantProposal)=>jobRequirements(proposal.kind,proposal.params);

/**
 * Why Run on device cannot run now, or undefined. The order: demo, offline,
 * a missing right, ReadOnly mode for a changing kind, a missing capability,
 * another command of this conversation still running.
 */
export function proposalBlockedReason(proposal:AssistantProposal,{server,viewer,demo,online,busy}:{server:Pick<Server,'permissions'|'snapshot'>;viewer:Viewer;demo:boolean;online:boolean;busy:boolean},t:Translate):string|undefined{
 if(demo)return t('kit.unavailable.demo');
 if(!online)return t('assistant.proposal.blocked.offline');
 const required=requirementsOf(proposal),missing=required.permissions.find(right=>!permitted(server as Server,viewer,right));
 if(missing)return t('assistant.proposal.blocked.right',{right:missing});
 const snapshot=server.snapshot;
 if(required.managementMode&&snapshot?.mode!=='Management')return t('assistant.proposal.blocked.readOnly');
 if(!required.capabilities.every(capability=>snapshot?.agentCapabilities?.includes(capability)))return t('assistant.proposal.blocked.agent');
 if(busy)return t('assistant.proposal.blocked.busy');
 return undefined;
}

/** POST /api/assistant {action:'run'}: the command exactly as proposed; the server checks it as a console job. */
export function runPayload(proposal:AssistantProposal,serverId:string):Record<string,unknown>{
 const command=proposal.type==='powershell'?{type:'powershell',script:proposal.script,timeoutSeconds:proposal.timeoutSeconds}:{type:'action',kind:proposal.kind,params:proposal.params};
 return {action:'run',serverId,command,confirm:true};
}
/** A read-only action runs on the click; a changing action and every script open a confirmation first. */
export const needsConfirmation=(proposal:AssistantProposal)=>proposal.type==='powershell'||!proposal.readOnly;
/** The send options of a run through the console action: the assistant route and the toast. */
export const runOptions=(t:Translate)=>({endpoint:'/api/assistant' as const,success:t('assistant.proposal.sent')});
/**
 * The warning after the description, or undefined: the console's own GPU
 * driver warning, and the shutdown warning for a shutdown now or at a time.
 */
function proposalWarning(proposal:AssistantProposal,t:Translate):string|undefined{
 if(proposal.type!=='action')return undefined;
 if(proposal.kind==='install-gpu-driver')return t('hardware.gpuDriver.confirm.warning');
 if(proposal.kind==='shutdown-computer'||proposal.kind==='schedule-power'&&proposal.params.operation==='shutdown')return t('assistant.confirm.shutdownWarning');
 return undefined;
}
/**
 * The confirmation of a changing action or a script; danger for a disruptive
 * action and every script. The GPU driver and a shutdown add their concrete
 * consequence after an empty line. A script also needs a fresh step-up proof
 * (lib/step-up.ts, as the terminal): the MFA dialog opens before it is sent.
 */
export function proposalConfirmation(proposal:AssistantProposal,server:Pick<Server,'id'|'name'>,t:Translate,locale:Locale,onSettled:(outcome:ConfirmationOutcome)=>void):Confirmation{
 const script=proposal.type==='powershell',payload=runPayload(proposal,server.id),warning=proposalWarning(proposal,t);
 return {
  title:t('assistant.confirm.title',{command:script?t('assistant.proposal.powershell'):proposalCommand(proposal,t,locale),device:server.name}),
  description:[t(script?'assistant.confirm.powershellText':'assistant.confirm.text'),...(warning?['',warning]:[])].join('\n'),
  lines:[{label:t('assistant.confirm.device'),value:server.name},{label:t('assistant.confirm.command'),value:proposalCommand(proposal,t,locale)}],
  confirmLabel:t('assistant.proposal.run'),tone:script||proposal.disruptive?'danger':'default',
  payload,...runOptions(t),onSettled,...(assistantActionNeedsStepUp(payload.action,payload.command)?{stepUpFirst:true}:{}),
 };
}

// ---- After the run ----

/** Polling: every 2 s for the first 30 s, then every 5 s, for at most 10 minutes. */
export const assistantPollLimits={fastMs:2000,fastForMs:30_000,slowMs:5000,windowMs:10*60_000} as const;
/** The wait before the next poll after `elapsed` ms, or null when the 10 minutes are over. */
export function pollDelay(elapsed:number):number|null{
 if(elapsed>=assistantPollLimits.windowMs)return null;
 return elapsed<assistantPollLimits.fastForMs?assistantPollLimits.fastMs:assistantPollLimits.slowMs;
}
export type PolledJob={id:string;kind:string;state:string;result:string|null;resultCode:string|null;resultArgs:Readonly<Record<string,string>>|null;finished:boolean};
export type TrackDeps={
 /** GET /api/assistant?serverId=&jobId=. */
 fetchJob:()=>Promise<PolledJob>;
 /** Waits; resolves false when the conversation ended meanwhile. */
 wait:(ms:number)=>Promise<boolean>;
 now:()=>number;
 /** Every state that the poll read. */
 onUpdate:(job:PolledJob)=>void;
};
/**
 * Polls one job until it is final (the job), the 10 minutes are over
 * ('stale'), or the conversation ended ('ended'). A failed poll is tried again
 * at the next interval.
 */
export async function trackAssistantJob(deps:TrackDeps):Promise<PolledJob|'stale'|'ended'>{
 const start=deps.now();
 for(;;){
  const delay=pollDelay(deps.now()-start);
  if(delay===null)return 'stale';
  if(!await deps.wait(delay))return 'ended';
  try{
   const job=await deps.fetchJob();
   deps.onUpdate(job);
   if(job.finished||assistantFinalJobStates.includes(job.state))return job;
  }catch{/* The next interval tries again. */}
 }
}
/** The state word of a final job: Finished after success, Failed otherwise. */
export const finalStateWord=(state:string,t:Translate)=>t(state==='succeeded'?'assistant.proposal.finished':'assistant.proposal.failed');
/** The question of a follow-up in the history, in the UI language: "Result of Restart service · Spooler: Finished". */
export const resultQuestion=(proposal:AssistantProposal,state:string,t:Translate,locale:Locale)=>t('assistant.proposal.resultQuestion',{command:proposalCommand(proposal,t,locale),state:finalStateWord(state,t)});
