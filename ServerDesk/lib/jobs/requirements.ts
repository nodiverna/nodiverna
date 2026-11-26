import type {Permission} from '../server/identity/access';
import {operations} from '../management';
import {diagnosticDefinitions,diagnosticSecurityAccess,isDiagnosticKind} from '../diagnostics';
import {fileManagementAccess,fileSecurityAccess,isFileKind} from '../file-operations';
import {isReadOnlyRunbookJob} from './runbook-step';
import {isPluginOperation,pluginOperations,PLUGIN_HOST,PLUGIN_INSTALL,PLUGIN_JOB,PLUGIN_REMOVE} from '../plugin-catalog';
import {assistantPowerShellKind} from '../assistant-config';
import {AD_SIGN_IN,PLUGIN_AD_IDENTITY,pluginManagePermission} from '../plugin-ad';

// The single source for what a device job needs: queueing, claim, display and
// cancel all read it, so a new job kind is described here once. Pure: no
// database, no server bindings, so the client cancel button can use it too.
export type JobRequirements={
 // False for a kind this portal does not know; only an owner may see or cancel it.
 known:boolean;
 // Every device right, in order: base rights, then manage for a privileged path, then security.events.
 permissions:Permission[];
 // manage is required because a path names a privileged location.
 privilegedPath:boolean;
 // security.events is required because the job reads or touches Security event data.
 securityEvents:boolean;
 // The agent must have Management enabled (servers.management=1 and mode Management).
 managementMode:boolean;
 // Queueing needs a fresh MFA session.
 mfa:boolean;
 // Agent capabilities that must all be advertised.
 capabilities:string[];
};
export type JobViewContext={target?:string|null;outputScope?:unknown};

// The two rights the parameters can add to any kind's base rights.
export const privilegedPathPermission:Permission='manage';
export const securityEventsPermission:Permission='security.events';

type Base=Pick<JobRequirements,'known'|'permissions'|'managementMode'|'mfa'>;
const reading=(permissions:Permission[]):Base=>({known:true,permissions,managementMode:false,mfa:false});
const changing=(permissions:Permission[]):Base=>({known:true,permissions,managementMode:true,mfa:true});
const fileChanges=new Set(['create-directory','rename-file','delete-file']);
const desiredState=new Set(['desired-state-test','desired-state-apply']);
const defenderJobKinds=new Set(['defender-quick-scan','defender-full-scan','defender-update-signatures','defender-clean-detections']);

function record(value:unknown):Record<string,unknown>{return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};}
function base(kind:string,params:Record<string,unknown>):Base{
 if(kind==='list-files')return reading(['files.read']);
 if(fileChanges.has(kind))return changing(['files.write']);
 if(desiredState.has(kind))return changing(['desired.apply']);
 // Microsoft Defender actions need only their own right, not manage (docs/local-identity-rbac.md).
 if(defenderJobKinds.has(kind))return changing(['defender.control']);
 if(Object.hasOwn(operations,kind))return operations[kind].readOnly?reading(['diagnose']):changing(['manage']);
 // A changing diagnostic needs diagnose as well as manage, as when it was queued.
 if(isDiagnosticKind(kind))return diagnosticDefinitions[kind].readOnly?reading(['diagnose']):changing(['diagnose','manage']);
 if(kind==='runbook-step'){const changes=!isReadOnlyRunbookJob(params);return {known:true,permissions:['runbooks.execute'],managementMode:changes,mfa:changes};}
 // A PowerShell script from the assistant runs as SYSTEM like the terminal: terminal, Management mode and MFA (docs/ai-assistant.md).
 if(kind===assistantPowerShellKind)return {known:true,permissions:['terminal'],managementMode:true,mfa:true};
 // Releases are deployed with MFA; the agent updates itself in any mode.
 if(kind==='agent-update')return {known:true,permissions:['update'],managementMode:false,mfa:true};
 // Offboarding with uninstall: manage is the device part of the removal right;
 // every queue and claim path also requires instance.owner (lib/server/devices/device-lifecycle.ts).
 if(kind==='agent-uninstall')return {known:true,permissions:['manage'],managementMode:false,mfa:true};
 // Agent plugins (docs/agent-plugins.md): installing and removing distributes SYSTEM code, with MFA in any mode, like an agent update.
 if(kind===PLUGIN_INSTALL||kind===PLUGIN_REMOVE)return {known:true,permissions:['plugins.manage'],managementMode:false,mfa:true};
 // A plugin operation needs the right of the operation: a read runs in any mode,
 // a change (the DHCP changes of plugin 1.1.0) needs Management mode and MFA.
 if(kind===PLUGIN_JOB){
  const operation=params.operation;
  if(!isPluginOperation(operation)||params.plugin!==pluginOperations[operation].plugin)return {known:false,permissions:['manage'],managementMode:true,mfa:true};
  const definition=pluginOperations[operation];
  return definition.readOnly?reading([definition.permission]):changing([definition.permission]);
 }
 // The AD sign-in of plugin changes (docs/plugin-ad-sign-in.md): the manage right of the plugin and MFA; it changes nothing, so any mode.
 if(kind===AD_SIGN_IN){
  const permission=pluginManagePermission(params.plugin);
  if(permission)return {known:true,permissions:[permission],managementMode:false,mfa:true};
 }
 return {known:false,permissions:['manage'],managementMode:true,mfa:true};
}
/**
 * The parameters a finished job keeps through its target: a plugin job stores
 * its operation as the target, so its rights outlive the wiped parameters.
 */
export function jobParametersFromTarget(kind:string,target:string|null|undefined):Record<string,unknown>{
 if(kind===PLUGIN_JOB&&isPluginOperation(target))return {plugin:pluginOperations[target].plugin,operation:target};
 // An ad-sign-in job keeps "<plugin>/<account>" as its target.
 if(kind===AD_SIGN_IN&&typeof target==='string'&&target.includes('/')&&pluginManagePermission(target.slice(0,target.indexOf('/'))))return {plugin:target.slice(0,target.indexOf('/'))};
 return {};
}
function withExtras(permissions:Permission[],privilegedPath:boolean,securityEvents:boolean){
 const all=[...permissions];
 if(privilegedPath&&!all.includes(privilegedPathPermission))all.push(privilegedPathPermission);
 if(securityEvents&&!all.includes(securityEventsPermission))all.push(securityEventsPermission);
 return all;
}

/**
 * The job kinds whose agent capability has another name than the kind: the
 * plugin host runs plugin-install, plugin-remove and plugin-job, and the AD
 * identity runs ad-sign-in. Every other kind is its own capability.
 */
const kindCapabilities:Readonly<Record<string,string>>={[PLUGIN_INSTALL]:PLUGIN_HOST,[PLUGIN_REMOVE]:PLUGIN_HOST,[PLUGIN_JOB]:PLUGIN_HOST,[AD_SIGN_IN]:PLUGIN_AD_IDENTITY};
/** The agent capability that runs a job kind. */
const kindCapability=(kind:string)=>Object.hasOwn(kindCapabilities,kind)?kindCapabilities[kind]:kind;
/**
 * The job kinds an agent with these capabilities runs, as far as the kind
 * alone decides it (the heartbeat cancels a pending job of any other kind):
 * each capability that is its own kind, and each mapped kind whose capability
 * is present. An agent reports plugin-host, never plugin-job.
 */
export function jobKindsOfCapabilities(capabilities:readonly string[]):string[]{
 const present=new Set(capabilities);
 return [...new Set([...capabilities.filter(capability=>!Object.hasOwn(kindCapabilities,capability)),...Object.keys(kindCapabilities).filter(kind=>present.has(kindCapabilities[kind]))])];
}

// params is the job's parameter object as parsed or stored. Never throws, also
// not for malformed stored parameters.
export function jobRequirements(kind:string,params:Record<string,unknown>):JobRequirements{
 const p=record(params),required=base(String(kind),p);
 const privilegedPath=fileManagementAccess(kind,p),securityEvents=diagnosticSecurityAccess(kind,p)||fileSecurityAccess(kind,p);
 const capabilities=kind==='install-updates'&&p.all===true?[kind,'install-all-updates']:[kindCapability(String(kind))];
 return {...required,permissions:withExtras(required.permissions,privilegedPath,securityEvents),privilegedPath,securityEvents,capabilities};
}

// Showing a job: parameters are wiped to '{}' when a job finishes, so the stored
// target and the output scope keep a finished job as private as it was when
// queued. They only ever add rights to the canonical set. Only a file job's
// target is its path; other kinds store a label there (for example
// "Security / json"), which must not be read as a path.
export function jobViewRequirements(kind:string,params:Record<string,unknown>,{target,outputScope}:JobViewContext={}):JobRequirements{
 const stored=record(params),p=Object.keys(stored).length?stored:jobParametersFromTarget(kind,target),scope=record(outputScope),required=jobRequirements(kind,p);
 const privilegedPath=required.privilegedPath||isFileKind(kind)&&typeof target==='string'&&fileManagementAccess(kind,{...p,path:target})||!!scope.management;
 const securityEvents=required.securityEvents||!!scope.security;
 return {...required,permissions:withExtras(required.permissions,privilegedPath,securityEvents),privilegedPath,securityEvents};
}
