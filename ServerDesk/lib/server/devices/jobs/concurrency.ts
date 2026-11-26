import {isReadOnlyRunbookJob} from '../../../jobs/runbook-step';
import {assistantPowerShellKind} from '../../../assistant-config';
import {DHCP_CHANGE_OPERATIONS,DNS_CHANGE_OPERATIONS,isPluginOperation,PLUGIN_INSTALL,PLUGIN_JOB,PLUGIN_REMOVE,pluginOperations} from '../../../plugin-catalog';
import {AD_SIGN_IN} from '../../../plugin-ad';

// The single source for which device jobs may run at the same time
// (docs/native-agent-v4.md "Parallel jobs"). The claim (lib/server/agent/agent-channel.ts)
// stores the class on the job row and guards with it; the agent mirrors this
// table in agent/v3/JobConcurrency.cs. Pure: no database.
//
// parallel:  changes nothing on the device. Runs next to other parallel jobs
//            and next to one exclusive job, never next to a sole job.
// exclusive: changes the device. At most one exclusive job runs per device.
// sole:      needs the device alone: claimed only when no job runs, and no
//            job is claimed while it runs.
// group:     at most one running job per group and device, whatever the class.
export type JobConcurrencyMode='parallel'|'exclusive'|'sole';
export type JobConcurrency={mode:JobConcurrencyMode;group:string|null};

// At most this many jobs run on one device at the same time.
export const MAX_RUNNING_JOBS=4;
// At most this many running job IDs an agent reports in a heartbeat or channel
// poll: the cap plus the ID of a pending agent update the agent still finishes.
export const MAX_REPORTED_RUNNING_JOBS=MAX_RUNNING_JOBS+1;

const parallel=(group:string|null=null):JobConcurrency=>({mode:'parallel',group});
const exclusive=(group:string|null=null):JobConcurrency=>({mode:'exclusive',group});
const sole:JobConcurrency={mode:'sole',group:null};

// Every job kind with a fixed class. runbook-step and plugin-job depend on
// their parameters and follow below.
export const jobConcurrencyKinds:Readonly<Record<string,JobConcurrency>>=Object.freeze({
 // Management operations (lib/management.ts).
 refresh:parallel('inventory'),
 'scan-updates':parallel('windows-update'),
 'test-connection':parallel(),
 'start-service':exclusive(),'stop-service':exclusive(),'restart-service':exclusive(),'set-service-startup':exclusive(),
 'install-feature':exclusive(),'remove-feature':exclusive(),
 'set-network':exclusive(),'set-dns':exclusive(),'set-rdp':exclusive(),'set-pagefile':exclusive(),'set-task':exclusive(),
 'join-domain':exclusive(),'leave-domain':exclusive(),'rename-computer':exclusive(),
 'create-local-user':exclusive(),'set-local-user':exclusive(),'reset-local-password':exclusive(),'delete-local-user':exclusive(),'local-group-add':exclusive(),'local-group-remove':exclusive(),
 'set-firewall-rule':exclusive(),'add-firewall-rule':exclusive(),
 // A schedule only writes a task; a restart or shutdown now ends every running job.
 'schedule-power':exclusive(),'cancel-power-schedule':exclusive(),
 'restart-computer':sole,'shutdown-computer':sole,
 // The Windows Update Agent must not search while it installs.
 'install-updates':exclusive('windows-update'),
 // The queue keeps its own rule: one driver job pending or running (lib/server/devices/device-job-queue.ts).
 'install-gpu-driver':exclusive(),
 // One Defender job at a time; a scan changes no configuration.
 'defender-quick-scan':parallel('defender'),'defender-full-scan':parallel('defender'),
 'defender-update-signatures':exclusive('defender'),'defender-clean-detections':exclusive('defender'),
 // Files (lib/file-operations.ts).
 'list-files':parallel(),
 'create-directory':exclusive(),'rename-file':exclusive(),'delete-file':exclusive(),
 // Storage (lib/storage-operations.ts): no disk read during a disk change.
 'storage-inspect':parallel('storage'),
 'storage-initialize':exclusive('storage'),'storage-set-disk':exclusive('storage'),'storage-new-volume':exclusive('storage'),'storage-resize':exclusive('storage'),
 'storage-drive-letter':exclusive('storage'),'storage-format':exclusive('storage'),'storage-delete-partition':exclusive('storage'),
 // Desired State (lib/desired-state-operations.ts): the DSC Local Configuration Manager runs one operation at a time.
 'desired-state-test':exclusive(),'desired-state-apply':exclusive(),
 // Diagnostics (lib/diagnostics.ts).
 'list-processes':parallel(),'list-sessions':parallel(),'list-connections':parallel(),'network-diagnostics':parallel(),
 'query-events':parallel(),'export-events':parallel(),'support-bundle':parallel(),
 'kill-process':exclusive(),'message-session':exclusive(),'disconnect-session':exclusive(),'logoff-session':exclusive(),
 // A PowerShell script from the assistant runs as SYSTEM.
 [assistantPowerShellKind]:exclusive(),
 // The AD sign-in only checks an account.
 [AD_SIGN_IN]:parallel(),
 // Replace SYSTEM code that plugin jobs use, or the agent itself.
 [PLUGIN_INSTALL]:sole,[PLUGIN_REMOVE]:sole,
 'agent-update':sole,'agent-uninstall':sole,
});

// Plugin operations that only read (pluginOperations readOnly); the plugin host
// serves one request per plugin, so each plugin is a group.
export const parallelPluginOperations:readonly string[]=Object.freeze(['dhcp-read','dns-read','dns-zone-read']);
export const exclusivePluginOperations:readonly string[]=Object.freeze([...DHCP_CHANGE_OPERATIONS,...DNS_CHANGE_OPERATIONS]);

function record(value:unknown):Record<string,unknown>{return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};}

/**
 * The class and group of a job. params is the job's parameter object as parsed
 * or stored. Never throws; a kind or plugin operation this portal does not know
 * is sole, the fail-safe.
 */
export function jobConcurrency(kind:string,params:Record<string,unknown>):JobConcurrency{
 try{
  const p=record(params),action=String(kind);
  if(action==='runbook-step'){
   // A fixed diagnosis does the work of its console kind; any script is a change.
   if(isReadOnlyRunbookJob(p))return {...jobConcurrencyKinds[String(p.operation)]};
   return exclusive();
  }
  if(action===PLUGIN_JOB){
   const operation=p.operation;
   if(!isPluginOperation(operation)||p.plugin!==pluginOperations[operation].plugin)return {...sole};
   const group='plugin:'+pluginOperations[operation].plugin;
   if(parallelPluginOperations.includes(operation))return parallel(group);
   if(exclusivePluginOperations.includes(operation))return exclusive(group);
   return {...sole};
  }
  return Object.hasOwn(jobConcurrencyKinds,action)?{...jobConcurrencyKinds[action]}:{...sole};
 }catch{return {...sole};}
}
