// The display-safe copy of a job's input (jobs.display_input, migration 0032).
// The parameters of a job are wiped to '{}' when it ends, because some kinds
// carry passwords or sealed secrets. At queue time every INSERT INTO jobs also
// writes jobDisplayInput(kind, parameters): only the fields of an explicit
// allowlist per kind, only string, number and boolean values (a list of such
// values becomes one text), never a key that names a secret. The job drawer
// shows it (lib/server/devices/job-detail.ts), and jobObject (lib/job-display.ts) reads the
// kind's object from it. Pure: no database, so the client and the tests use it.
import {operations} from './management';
import {diagnosticDefinitions} from './diagnostics';
import {DHCP_CHANGE_OPERATIONS,DNS_CHANGE_OPERATIONS,DNS_READ_OPERATIONS,PLUGIN_INSTALL,PLUGIN_JOB,PLUGIN_REMOVE} from './plugin-catalog';
import {AD_SIGN_IN} from './plugin-ad';
import {assistantPowerShellKind,scriptFirstLine} from './assistant-config';
import {AGENT_UNINSTALL_KIND} from './offboarding';

/** A kept value: the drawer shows it as text. */
export type JobInputValue=string|number|boolean;
export type JobInput=Record<string,JobInputValue>;
/** One kept field: the key, or [key, dotted path] for a field inside a nested object. */
type Field=string|readonly [key:string,path:string];
type Allowlist={
 fields:readonly Field[];
 /** The object of the job in the admin's words, from the kept input; undefined when the input has none. */
 object?:(input:JobInput)=>string|undefined;
 /** false: the stored target is a text the portal built (often German), never the admin's words, so jobObject does not fall back to it. */
 target?:false;
};

/** Text values are cut here; the script of assistant-powershell keeps up to scriptLimit characters. */
export const inputTextLimit=512,scriptLimit=8000;
/** A key that names a secret, also when an allowlist lists it: password, secretParameters, token, credentials and so on. */
export const secretKeyPattern=/(^|[a-z])(password|secret|token|credential)s?$/i;
const secretKeys:ReadonlySet<string>=new Set(['password','secretParameters','secrets']);
export const isSecretKey=(key:string)=>secretKeys.has(key)||secretKeyPattern.test(key);

const text=(value:JobInputValue|undefined)=>value===undefined||value===''?undefined:String(value);
/** The first present field. */
const first=(...keys:string[])=>(input:JobInput)=>keys.map(key=>text(input[key])).find(value=>value!==undefined);
/** The present fields joined, for example "3 / 10.0.0.0 / Office". */
const joined=(separator:string,...keys:string[])=>(input:JobInput)=>{const parts=keys.map(key=>text(input[key])).filter((value):value is string=>value!==undefined);return parts.length?parts.join(separator):undefined;};

const none:Allowlist={fields:[],target:false};
const service:Allowlist={fields:['name'],object:first('name')};
const feature:Allowlist={fields:['name','includeManagementTools'],object:first('name')};
const power:Allowlist={fields:['delaySeconds','reason'],object:first('reason'),target:false};
const localUser:Allowlist={fields:['name','fullName','description','passwordNeverExpires'],object:first('name')};
const localGroup:Allowlist={fields:['name','groupSid'],object:first('name')};
const disk=['diskNumber'],partition=['diskNumber','partitionNumber'];
const session:Allowlist={fields:['sessionId','username'],object:first('username'),target:false};

/** The kinds of lib/management.ts (with the file, storage and desired-state operations) and lib/diagnostics.ts. */
const operationAllowlists:Record<string,Allowlist>={
 refresh:none,'scan-updates':none,
 'test-connection':{fields:['host','port'],object:joined(':','host','port')},
 'start-service':service,'stop-service':service,'restart-service':service,
 'set-service-startup':{fields:['name','startup'],object:first('name')},
 'install-feature':feature,'remove-feature':feature,
 'set-network':{fields:['interfaceIndex','dhcp','address','prefixLength','gateway'],object:first('address'),target:false},
 'set-dns':{fields:['interfaceIndex','automatic','servers'],object:first('servers'),target:false},
 'join-domain':{fields:['domain','ouPath'],object:first('domain')},
 'leave-domain':{fields:['workgroup'],object:first('workgroup')},
 // The name only: the credentials of a rename are a secret.
 'rename-computer':{fields:['name'],object:first('name')},
 'set-rdp':{fields:['enabled'],target:false},
 'set-pagefile':{fields:['automatic','drive','initialMb','maximumMb'],object:first('drive'),target:false},
 'create-local-user':localUser,'set-local-user':{...localUser,fields:['name','enabled','fullName','description','passwordNeverExpires']},
 'reset-local-password':{fields:['name'],object:first('name')},
 'delete-local-user':{fields:['name'],object:first('name')},
 'local-group-add':localGroup,'local-group-remove':localGroup,
 'restart-computer':power,'shutdown-computer':power,
 'schedule-power':{fields:['operation','scheduledAt','reason'],object:first('reason'),target:false},
 'cancel-power-schedule':{fields:['scheduleId'],target:false},
 'install-updates':{fields:['all','updateIds'],target:false},
 'install-gpu-driver':{fields:['vendor','version'],object:first('version')},
 'set-firewall-rule':{fields:['name','enabled'],object:first('name')},
 'add-firewall-rule':{fields:['name','direction','action','protocol','port','remoteAddress'],object:first('name')},
 'defender-quick-scan':none,'defender-full-scan':none,'defender-update-signatures':none,'defender-clean-detections':none,
 'set-task':{fields:['name','path','enabled'],object:first('name')},
 // Files (lib/file-operations.ts).
 'list-files':{fields:['path','offset','limit','includeSecurity'],object:first('path'),target:false},
 'create-directory':{fields:['path'],object:first('path')},
 'rename-file':{fields:['path','name'],object:first('path')},
 'delete-file':{fields:['path'],object:first('path')},
 // Storage (lib/storage-operations.ts): the disk number and the settings, never the disk's unique id.
 'storage-inspect':none,
 'storage-initialize':{fields:[...disk,'partitionStyle'],target:false},
 'storage-set-disk':{fields:[...disk,'setting'],target:false},
 'storage-new-volume':{fields:[...disk,'sizeBytes','useMaximumSize','driveLetter','fileSystem','label'],object:first('driveLetter','label'),target:false},
 'storage-resize':{fields:[...partition,'sizeBytes'],target:false},
 'storage-drive-letter':{fields:[...partition,'driveLetter','remove'],object:first('driveLetter'),target:false},
 'storage-format':{fields:[...partition,'fileSystem','label'],object:first('label'),target:false},
 'storage-delete-partition':{fields:partition,target:false},
 // Desired state (lib/desired-state-operations.ts): the version and its engine, never the sealed configuration or its parameters.
 'desired-state-test':{fields:['engine','configurationName','versionId','assignmentId','timeoutSeconds'],object:first('configurationName')},
 'desired-state-apply':{fields:['engine','configurationName','versionId','assignmentId','timeoutSeconds'],object:first('configurationName')},
 // Diagnostics (lib/diagnostics.ts).
 'list-processes':{fields:['limit','sampleMs'],target:false},
 'kill-process':{fields:['pid','startedAt'],object:first('pid')},
 'list-sessions':none,
 'message-session':{fields:['sessionId','username','message'],object:first('username'),target:false},
 'disconnect-session':session,'logoff-session':session,
 'list-connections':{fields:['limit','pid'],target:false},
 'network-diagnostics':{fields:['host','port'],object:first('host'),target:false},
 'query-events':{fields:['channel','from','to','levels','provider','eventIds','text','limit'],object:first('channel')},
 'export-events':{fields:[['channel','filter.channel'],['from','filter.from'],['to','filter.to'],['provider','filter.provider'],'format'],object:first('channel')},
 'support-bundle':{fields:['channels','includeEvents'],target:false},
};

// Plugin operations (docs/agent-plugins.md): the plugin and the operation, then the fields of the operation's parameters.
const dhcpScope=first('scopeId','prefix');
const pluginOperationAllowlists:Record<string,Allowlist>={
 'dhcp-read':{fields:[]},
 'dhcp-scope-create':{fields:['family','scopeId','prefix','name','description','startRange','endRange','subnetMask','leaseDurationSeconds','type','preference','activate'],object:first('scopeId','prefix','startRange')},
 'dhcp-scope-edit':{fields:['family','scopeId','prefix','name','description','startRange','endRange','leaseDurationSeconds','type','preference'],object:dhcpScope},
 'dhcp-scope-activate':{fields:['family','scopeId','prefix'],object:dhcpScope},
 'dhcp-scope-deactivate':{fields:['family','scopeId','prefix'],object:dhcpScope},
 'dhcp-scope-delete':{fields:['family','scopeId','prefix'],object:dhcpScope},
 'dhcp-superscope-create':{fields:['name','scopeIds'],object:first('name')},
 'dhcp-superscope-edit':{fields:['name','newName','scopeIds'],object:first('name')},
 'dhcp-superscope-activate':{fields:['name'],object:first('name')},
 'dhcp-superscope-deactivate':{fields:['name'],object:first('name')},
 'dhcp-superscope-delete':{fields:['name'],object:first('name')},
 'dhcp-exclusion-add':{fields:['family','scopeId','prefix','start','end'],object:joined(' – ','start','end')},
 'dhcp-exclusion-remove':{fields:['family','scopeId','prefix','start','end'],object:joined(' – ','start','end')},
 'dhcp-reservation-add':{fields:['family','scopeId','prefix','address','clientId','duid','iaid','name','description','type'],object:first('address')},
 'dhcp-reservation-edit':{fields:['family','scopeId','prefix','address','newAddress','clientId','duid','iaid','name','description','type'],object:first('address')},
 'dhcp-reservation-remove':{fields:['family','scopeId','prefix','address'],object:first('address')},
 'dhcp-lease-delete':{fields:['family','scopeId','prefix','addresses'],object:first('addresses')},
 'dhcp-option-set':{fields:['family','level','scopeId','prefix','policy','code','vendorClass','userClass','values'],object:joined(' / ','code','scopeId','prefix','policy')},
 'dhcp-option-remove':{fields:['family','level','scopeId','prefix','policy','code','vendorClass','userClass'],object:joined(' / ','code','scopeId','prefix','policy')},
 'dhcp-policy-create':{fields:['scopeId','name','description','enabled','order','condition','leaseDurationSeconds'],object:joined(' / ','name','scopeId')},
 'dhcp-policy-edit':{fields:['scopeId','name','newName','description','enabled','order','condition','leaseDurationSeconds'],object:joined(' / ','name','scopeId')},
 'dhcp-policy-delete':{fields:['scopeId','name'],object:joined(' / ','name','scopeId')},
 'dhcp-failover-create':{fields:['name','partner','serverType','mode','loadBalancePercent','serverRole','reservePercent','mcltSeconds','autoStateTransition','stateSwitchIntervalSeconds','scopeIds'],object:first('name')},
 'dhcp-failover-edit':{fields:['name','loadBalancePercent','reservePercent','mcltSeconds','autoStateTransition','stateSwitchIntervalSeconds','addScopeIds','removeScopeIds','deleteRemovedScopes'],object:first('name')},
 'dhcp-failover-remove':{fields:['name','deletePartnerScopes'],object:first('name')},
 'dhcp-scope-apply':{fields:['scopeId','part','parts'],object:first('scopeId')},
 'dns-read':{fields:[]},
 'dns-zone-read':{fields:['zone'],object:first('zone')},
 'dns-zone-create':{fields:['kind','lookup','name','networkId','storage','replicationScope','fileName','masters','dynamicUpdate'],object:first('name','networkId')},
 'dns-zone-edit':{fields:['zone','dynamicUpdate','storage','replicationScope','masters'],object:first('zone')},
 'dns-zone-delete':{fields:['zone'],object:first('zone')},
 'dns-zone-transfer':{fields:['zone'],object:first('zone')},
 'dns-record-add':{fields:['zone','name','type','ttlSeconds'],object:joined(' / ','zone','name')},
 'dns-record-edit':{fields:['zone',['name','record.name'],['type','record.type'],'ttlSeconds','ageRecord'],object:joined(' / ','zone','name')},
 'dns-record-delete':{fields:['zone'],object:first('zone')},
 'dns-conditional-create':{fields:['name','masters','storage','replicationScope','timeoutSeconds'],object:first('name')},
 'dns-conditional-edit':{fields:['name','masters','storage','replicationScope','timeoutSeconds'],object:first('name')},
 'dns-conditional-delete':{fields:['name'],object:first('name')},
 'dns-forwarders-set':{fields:['servers','timeoutSeconds','useRootHints'],object:first('servers')},
 'dns-scavenging-set':{fields:['enabled','intervalHours','applyToAdZones']},
 'dns-scavenge-now':{fields:[]},
 'dns-cache-clear':{fields:[]},
};

/** Every other kind that the console job list shows, plus the runbook step. */
const kindAllowlists:Record<string,Allowlist>={
 'agent-update':{fields:['releaseId']},
 [AGENT_UNINSTALL_KIND]:none,
 [PLUGIN_INSTALL]:{fields:['name','version','releaseId'],object:joined(' ','name','version')},
 [PLUGIN_REMOVE]:{fields:['name'],object:first('name')},
 // The plugin and the account only: the sealed password stays out.
 [AD_SIGN_IN]:{fields:['plugin','account'],object:first('account'),target:false},
 [assistantPowerShellKind]:{fields:['script','timeoutSeconds'],object:input=>typeof input.script==='string'?scriptFirstLine(input.script)||undefined:undefined},
 // A runbook step keeps its name and kind (and the fixed operation of a diagnosis step), never its script or parameters.
 'runbook-step':{fields:['name','kind','operation'],object:first('name')},
};

/** The allowlist of a kind; for a plugin job the one of its operation. undefined for a kind this portal does not keep input of. */
function allowlistOf(kind:string,params:Record<string,unknown>):Allowlist|undefined{
 if(kind===PLUGIN_JOB){
  const operation=typeof params.operation==='string'&&Object.hasOwn(pluginOperationAllowlists,params.operation)?pluginOperationAllowlists[params.operation]:undefined;
  return operation?{...operation,fields:['plugin','operation',...operation.fields.map(field=>typeof field==='string'?[field,`parameters.${field}`] as const:[field[0],`parameters.${field[1]}`] as const)]}:undefined;
 }
 if(Object.hasOwn(kindAllowlists,kind))return kindAllowlists[kind];
 if(Object.hasOwn(operationAllowlists,kind)&&(Object.hasOwn(operations,kind)||Object.hasOwn(diagnosticDefinitions,kind)))return operationAllowlists[kind];
 return undefined;
}

const record=(value:unknown):Record<string,unknown>|undefined=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
/** The value at a dotted path, or undefined; a secret key anywhere on the path gives undefined. */
function at(params:Record<string,unknown>,path:string):unknown{
 let current:unknown=params;
 for(const part of path.split('.')){
  const object=record(current);
  if(!object||isSecretKey(part)||!Object.hasOwn(object,part))return undefined;
  current=object[part];
 }
 return current;
}
const cut=(value:string,limit:number)=>value.length>limit?value.slice(0,limit):value;
/** A kept value: a string (cut), a finite number, a boolean, or a list of those as one text. Anything else is not kept. */
function kept(value:unknown,limit:number):JobInputValue|undefined{
 if(typeof value==='string')return cut(value,limit);
 if(typeof value==='number')return Number.isFinite(value)?value:undefined;
 if(typeof value==='boolean')return value;
 if(Array.isArray(value)){
  const items=value.filter(item=>typeof item==='string'||typeof item==='boolean'||typeof item==='number'&&Number.isFinite(item));
  return items.length?cut(items.map(String).join(', '),limit):undefined;
 }
 return undefined;
}
const parsed=(params:unknown):Record<string,unknown>=>{
 if(typeof params==='string'){try{return record(JSON.parse(params))??{};}catch{return {};}}
 return record(params)??{};
};

/**
 * The display-safe input of a job, as the JSON text of jobs.display_input: the
 * fields of the kind's allowlist with string, number and boolean values (strings
 * cut at 512 characters, the script of assistant-powershell at 8000). A key
 * that names a secret is never kept, also when an allowlist lists it. An
 * unknown kind keeps '{}'. params: the parameter object or its JSON text, the
 * same that the insert writes to jobs.parameters.
 */
export function jobDisplayInput(kind:string,params:unknown):string{
 const source=parsed(params),allowlist=allowlistOf(String(kind),source);
 if(!allowlist)return '{}';
 const input:JobInput={};
 for(const field of allowlist.fields){
  const [key,path]=typeof field==='string'?[field,field]:field;
  if(isSecretKey(key))continue;
  const value=kept(at(source,path),kind===assistantPowerShellKind&&key==='script'?scriptLimit:inputTextLimit);
  if(value!==undefined)input[key]=value;
 }
 return JSON.stringify(input);
}

/** The kept input of a stored display_input text, or {} when it is malformed. Values that are no string, number or boolean are dropped. */
export function parseJobInput(value:unknown):JobInput{
 const source=parsed(value),input:JobInput={};
 for(const [key,item] of Object.entries(source))if(!isSecretKey(key)&&(typeof item==='string'||typeof item==='boolean'||typeof item==='number'&&Number.isFinite(item)))input[key]=item;
 return input;
}

/** Whether the kind keeps any input field (a job of such a kind with '{}' predates migration 0032 or kept nothing). */
export function keepsInput(kind:string,params:Record<string,unknown>={}):boolean{
 if(kind===PLUGIN_JOB)return true;
 return (allowlistOf(kind,params)?.fields.length??0)>0;
}

/** The object of a job from its kept input, and whether its stored target may stand in when the input has none. */
export function inputObject(kind:string,input:JobInput):{object?:string;target:boolean}{
 const allowlist=allowlistOf(kind,input);
 return {object:allowlist?.object?.(input),target:allowlist?.target!==false};
}

/** Every key an allowlist can keep (the catalog has jobs.input.<key> for each). */
export function jobInputKeys():string[]{
 const keys=new Set<string>(['plugin','operation']);
 for(const allowlist of [...Object.values(operationAllowlists),...Object.values(pluginOperationAllowlists),...Object.values(kindAllowlists)])
  for(const field of allowlist.fields)keys.add(typeof field==='string'?field:field[0]);
 return [...keys].sort();
}

/** The kinds with an allowlist (the plugin job by its operations): for the tests. */
export const jobInputKinds={operations:Object.keys(operationAllowlists),pluginOperations:Object.keys(pluginOperationAllowlists),others:Object.keys(kindAllowlists)};
/** The plugin operations of this portal; the tests compare them with jobInputKinds. */
export const knownPluginOperations=['dhcp-read',...DHCP_CHANGE_OPERATIONS,...DNS_READ_OPERATIONS,...DNS_CHANGE_OPERATIONS] as const;
