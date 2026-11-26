// The shared rules of the device assistant (docs/ai-assistant.md): providers,
// default models, key and model validation, the question and history limits,
// the device area that each read tool opens, and the commands the assistant
// may propose with their limits. Shared by server modules and
// client components: this module imports nothing, so it never pulls
// lib/server/context.ts or the database into a bundle or a test.

export type AssistantProvider='anthropic'|'openai';
export type AssistantScope='organization'|'personal'|'customer';
export type AssistantSource=AssistantScope;
export const assistantProviders:readonly AssistantProvider[]=['anthropic','openai'];
/** The model a new key starts with, per provider. The model is a free-text field, so an Owner can choose another one. */
export const assistantDefaultModels:Readonly<Record<AssistantProvider,string>>={anthropic:'claude-opus-5-5',openai:'gpt-5'};
/** The company name in server texts ("{provider} rejected the API key"). */
export const assistantProviderNames:Readonly<Record<AssistantProvider,string>>={anthropic:'Anthropic',openai:'OpenAI'};
/** The prefix every key of a provider starts with. */
export const assistantKeyPrefixes:Readonly<Record<AssistantProvider,string>>={anthropic:'sk-ant-',openai:'sk-'};

export const isAssistantProvider=(value:unknown):value is AssistantProvider=>value==='anthropic'||value==='openai';
const printableKey=/^[\x21-\x7e]{20,512}$/;
/** A key: 20 to 512 printable ASCII characters without spaces, with the prefix of its provider. */
export function validAssistantKey(provider:AssistantProvider,value:unknown):value is string{
 return typeof value==='string'&&printableKey.test(value)&&value.startsWith(assistantKeyPrefixes[provider]);
}
const modelPattern=/^[A-Za-z0-9._:/-]{1,100}$/;
/** A model name: 1 to 100 characters of letters, digits and . _ : / -. */
export const validAssistantModel=(value:unknown):value is string=>typeof value==='string'&&modelPattern.test(value);
/** The last 4 characters of a key; the only part that is ever shown again. */
export const assistantKeyHint=(key:string)=>key.slice(-4);

/** Questions and history (lib/server/devices/assistant.ts). */
export const assistantLimits={questionChars:2000,answerChars:16_000,historyPairs:10,questionsPerWindow:20,questionWindowMinutes:10,testsPerWindow:5,testWindowSeconds:60} as const;
const forbiddenControl=/[\u0000-\u0008\u000b-\u001f\u007f]/;
/** A question: 1 to 2,000 characters after trim, no control characters except newline and tab. */
export function validAssistantQuestion(value:unknown):value is string{
 if(typeof value!=='string')return false;
 const text=value.trim();
 return text.length>=1&&text.length<=assistantLimits.questionChars&&!forbiddenControl.test(text);
}

/** The read tools of this version; a later version adds tools to this list. */
export const assistantToolNames=['device_overview','device_hardware','device_gpu_drivers','device_metrics','device_services','device_processes','device_events','device_updates','device_storage','device_network','device_security','device_software','device_drivers','device_autostart','device_features','device_tasks','device_jobs','device_audit'] as const;
export type AssistantToolName=typeof assistantToolNames[number];
export const isAssistantToolName=(value:unknown):value is AssistantToolName=>typeof value==='string'&&(assistantToolNames as readonly string[]).includes(value);
/**
 * The device area a source chip opens: a main section and, for Diagnostics, Software,
 * Management and the graphics card in Hardware, the subarea. The labels are
 * the existing area names.
 */
export type AssistantSourceArea={section:'overview'|'hardware'|'history'}|{section:'hardware';detail:'gpu'}|{section:'diagnostics';detail:'processes'|'events'}|{section:'software';detail:'programs'|'drivers'|'autostart'}|{section:'management';detail:'services'|'updates'|'storage'|'network'|'defender'|'features'|'tasks'};
export const assistantSourceAreas:Readonly<Record<AssistantToolName,AssistantSourceArea>>={
 device_overview:{section:'overview'},
 device_hardware:{section:'hardware'},
 device_gpu_drivers:{section:'hardware',detail:'gpu'},
 device_metrics:{section:'overview'},
 device_services:{section:'management',detail:'services'},
 device_processes:{section:'diagnostics',detail:'processes'},
 device_events:{section:'diagnostics',detail:'events'},
 device_updates:{section:'management',detail:'updates'},
 device_storage:{section:'management',detail:'storage'},
 device_network:{section:'management',detail:'network'},
 device_security:{section:'management',detail:'defender'},
 device_software:{section:'software',detail:'programs'},
 device_drivers:{section:'software',detail:'drivers'},
 device_autostart:{section:'software',detail:'autostart'},
 device_features:{section:'management',detail:'features'},
 device_tasks:{section:'management',detail:'tasks'},
 device_jobs:{section:'history'},
 device_audit:{section:'history'},
};

// ---- Commands (docs/ai-assistant.md, "Commands") ----

/**
 * The only allow-list of portal actions that the assistant may propose and
 * that POST /api/assistant {action:'run'} queues. The first nine only read
 * (no MFA, any agent mode); the others change the device. Every run goes
 * through the console's own checks (lib/server/devices/device-job-queue.ts). The decision
 * for every other job kind of the portal (docs/ai-assistant.md, "Allowed
 * actions"):
 * - install-gpu-driver: allowed. The model gives only the vendor and the
 *   version; the download URL and size come only from the server's own vendor
 *   lookup (resolveGpuDriverJob).
 * - install-feature, set-pagefile, storage-inspect, defender-clean-detections:
 *   allowed. No secret, file or network target; Defender removes only what it
 *   already detected.
 * - shutdown-computer, schedule-power, cancel-power-schedule: allowed. The
 *   risk of restart-computer; they get the danger confirmation.
 * - remove-feature: excluded. Removes a role and its configuration, which does
 *   not come back the same way, and can remove security features.
 * - set-network, set-dns: excluded. Can disconnect the device from the portal;
 *   set-dns sends all name resolution to a server that the model chose.
 * - set-rdp, add-firewall-rule: excluded. Open remote access or ports to
 *   addresses that the model chose.
 * - join-domain, leave-domain, rename-computer, create-local-user,
 *   reset-local-password: excluded. Carry credentials, which must never go
 *   through the model or its provider, and change the device identity.
 * - set-local-user, delete-local-user, local-group-add, local-group-remove:
 *   excluded. Grant or remove access and privileges.
 * - list-files, create-directory, rename-file, delete-file: excluded. File access.
 * - storage-initialize, storage-set-disk, storage-new-volume, storage-resize,
 *   storage-drive-letter, storage-format, storage-delete-partition: excluded.
 *   Can destroy data, and it cannot be undone.
 * - desired-state-test, desired-state-apply: excluded. Run only from a
 *   desired-state version (apiError.job.desiredStateViaVersion).
 * - message-session: excluded. Text from the model on a user's desktop is a
 *   phishing channel after a prompt injection.
 * - export-events, support-bundle: excluded. Make a file for download;
 *   query-events covers reading the events.
 * - agent-update: excluded. A release rollout, not a device action.
 * - agent-uninstall: excluded. Offboarding; needs instance.owner.
 * - plugin-install, plugin-remove: excluded. Distribute SYSTEM code; this
 *   stays a portal action with a confirmation.
 * - plugin-job dhcp-read: excluded. The read job is shared per device and
 *   writes no audit row, so it cannot carry assistant.run or an own-job
 *   follow-up. plugin-job DHCP changes: excluded. A change is copied to a
 *   failover partner, and failover creation carries a shared secret.
 * - runbook-step, runbook-run: excluded. Runbooks run from Automation with
 *   their own run model.
 * - assistant-powershell: its own tool, propose_powershell.
 */
export const assistantCommandKinds=[
 'refresh','scan-updates','test-connection','list-processes','list-sessions','list-connections','network-diagnostics','query-events','storage-inspect',
 'start-service','stop-service','restart-service','set-service-startup','set-task','set-firewall-rule','install-updates','restart-computer','kill-process','disconnect-session','logoff-session','defender-quick-scan','defender-full-scan','defender-update-signatures',
 'install-gpu-driver','install-feature','set-pagefile','shutdown-computer','schedule-power','cancel-power-schedule','defender-clean-detections',
] as const;
export type AssistantCommandKind=typeof assistantCommandKinds[number];
export const isAssistantCommandKind=(value:unknown):value is AssistantCommandKind=>typeof value==='string'&&(assistantCommandKinds as readonly string[]).includes(value);
/** The job kind of a PowerShell script from the assistant (agent 4.17.0). */
export const assistantPowerShellKind='assistant-powershell';
/** At most 3 proposals per answer, a reason of 1–300 characters, a script of 1–8,000 characters and a timeout of 10–600 s (120 s by default). */
export const assistantCommandLimits={proposalsPerAnswer:3,reasonChars:300,scriptChars:8000,timeoutMin:10,timeoutMax:600,timeoutDefault:120} as const;
/** The two command tools; a call only shows a proposal to the user. */
export const assistantCommandToolNames=['propose_action','propose_powershell'] as const;
export type AssistantCommandToolName=typeof assistantCommandToolNames[number];
export const isAssistantCommandToolName=(value:unknown):value is AssistantCommandToolName=>typeof value==='string'&&(assistantCommandToolNames as readonly string[]).includes(value);
const scriptControl=/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
/** A script: 1 to 8,000 characters with at least one visible character, no control characters except newline, carriage return and tab. */
export function validAssistantScript(value:unknown):value is string{
 return typeof value==='string'&&value.length<=assistantCommandLimits.scriptChars&&value.trim().length>0&&!scriptControl.test(value);
}
/** A timeout in whole seconds from 10 to 600. */
export const validAssistantTimeout=(value:unknown):value is number=>typeof value==='number'&&Number.isInteger(value)&&value>=assistantCommandLimits.timeoutMin&&value<=assistantCommandLimits.timeoutMax;
/** A reason: 1 to 300 characters after trim, no control characters except newline and tab. */
export function validAssistantReason(value:unknown):value is string{
 if(typeof value!=='string')return false;
 const text=value.trim();
 return text.length>=1&&text.length<=assistantCommandLimits.reasonChars&&!forbiddenControl.test(text);
}
/** The first non-empty line of a script, at most 120 characters: the only script text that a job target or an audit row shows. */
export function scriptFirstLine(script:string):string{
 const line=script.split(/\r?\n|\r/).map(entry=>entry.trim()).find(entry=>entry.length>0)??'';
 return line.length>120?line.slice(0,119)+'…':line;
}
/** The number of lines of a script, without trailing empty lines. */
export const scriptLineCount=(script:string)=>script.replace(/(?:\r?\n|\r)+$/,'').split(/\r?\n|\r/).length;

/** The refusal codes of a command tool call. */
export type AssistantProposalRefusal='notAllowed'|'missingRight'|'deviceOffline'|'agentUnsupported'|'managementRequired'|'invalidParameters'|'invalidScript'|'proposalLimit';
type ProposalBase={id:string;reason:string;target:string;readOnly:boolean;disruptive:boolean;mfa:boolean};
/** A command the model proposed. It runs only when the user clicks Run on device; the server does not store it. */
export type AssistantProposal=ProposalBase&({type:'action';kind:AssistantCommandKind;params:Record<string,unknown>}|{type:'powershell';kind:typeof assistantPowerShellKind;params:Record<string,never>;script:string;timeoutSeconds:number});
/** Job states after which a job does not change any more. */
export const assistantFinalJobStates:readonly string[]=['succeeded','failed','cancelled','expired'];
