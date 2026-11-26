// What a viewer sees of devices and jobs: the snapshot projection per device
// rights, the job and runbook scoping, and the device rows of GET /api/console
// with their alarms, tags, OS support and issues. The console route and the
// read tools of the device assistant (lib/server/devices/assistant-tools.ts) use these same
// functions, so the assistant never sees more than the console shows.
import {allPermissions,type Permission} from '../identity/access';
import {agentResultFields} from '../../agent-messages';
import {jobViewRequirements} from '../../jobs/requirements';
import {jobObject} from '../../job-display';
import {parseJobInput} from '../../job-input';
import {runbookHistoryJob,type RunbookHistoryStep} from '../automation/runbook-history';
import {deviceAlertChain,effectiveAlertSettings,evaluateAlertRules,resolveAlertRules} from '../../alert-rules';
import {deviceOsSupport} from '../../os-support';
import {isDeviceNameSource,type DeviceNameSource} from '../../device-name';
import type {consoleRunbookJobs} from '../console-data';
import type {consoleAlertOverrides} from './alert-rule-overrides';
import type {consoleEsuOverrides} from './os-esu';
import type {consoleDeviceTags} from './tag-store';
import type {consoleAlerts} from './alerts';
import type {consoleAutostart} from './autostart';
import type {consoleDhcpAlerts} from '../extensions/plugin-data';
import type {consoleDnsAlerts} from '../extensions/dns-data';
import type {consoleAgentIntegrity} from '../agent/agent-integrity';
import type {consoleServerSoftware} from '../extensions/server-role-software';
import type {Job,Server,ServerSnapshot} from '../../types';

/**
 * The snapshot a viewer with these device rights gets. Defender detections
 * and exclusions only with defender.read; process users, paths and the process
 * inventory only with diagnose.
 */
export function snapshotForPermissions(raw:unknown,permissions:Permission[]):ServerSnapshot|null{
 if(!raw)return null;
 const snapshot=JSON.parse(String(raw)) as ServerSnapshot;
 // Defender detections and exclusions hold file paths and user names: only with
 // defender.read on this device. The summary (mode, flags, times, counts) stays.
 if(snapshot.defender?.available&&!permissions.includes('defender.read')){const summary={...snapshot.defender};delete summary.detections;delete summary.exclusions;snapshot.defender=summary;}
 if(permissions.includes('diagnose'))return snapshot;
 // Monitoring keeps the original four process metrics. User, path and exact
 // process-instance details belong to the device's scoped diagnosis permission.
 const {processes,...monitoring}=snapshot;delete monitoring.processInventory;
 return {...monitoring,processes:processes.map(({name,pid,memoryMb,cpuSeconds})=>({name,pid,memoryMb,cpuSeconds}))};
}
/** The runbook runs a viewer may see: runbooks.read, security.events for security output, outputs only with runbooks.outputs. */
export function scopeRunbookJobs(history:Awaited<ReturnType<typeof consoleRunbookJobs>>,permissionMap:Map<string,Permission[]>):Job[]{
 const stepMap=new Map<string,RunbookHistoryStep[]>();
 for(const step of history.steps){const key=`${step.runId}:${step.serverId}`;const list=stepMap.get(key)??[];list.push(step);stepMap.set(key,list);}
 return history.runs.flatMap(row=>{
  const allowed=permissionMap.get(row.serverId)??[],steps=stepMap.get(`${row.runId}:${row.serverId}`)??[];
  if(!allowed.includes('runbooks.read')||steps.some(s=>s.outputSecurity)&&!allowed.includes('security.events'))return [];
  return [runbookHistoryJob(row,steps,allowed.includes('runbooks.outputs'))];
 });
}
/** Jobs and runbook runs in one list, newest first. */
export function mergedJobs(jobs:Record<string,unknown>[],runbooks:Job[]){
 return [...jobs,...runbooks].sort((a,b)=>Number(b.createdAt)-Number(a.createdAt)||String(a.id).localeCompare(String(b.id)));
}
/**
 * The jobs a viewer may see, with the rights that each job's stored parameters
 * and kept input require, each with its object (jobObject). owner:
 * can(v,'instance.owner'), asked once by the caller.
 */
export function scopeJobs(rows:Record<string,unknown>[],owner:boolean,permissionMap:Map<string,Permission[]>){
 return rows.flatMap(j=>{
  // display_input never leaves the server in the list: the job drawer reads the input on demand (lib/server/devices/job-detail.ts).
  const {accessParameters,displayInput,outputSecurity,outputManagement,scriptOutput,result_code,result_args,...columns}=j;
  const visibleJob={...columns,...agentResultFields({result_code,result_args}),object:jobObject({action:String(j.action),target:j.target==null?null:String(j.target),displayInput})};
  const allowed=permissionMap.get(String(j.serverId))??[];if(owner&&allPermissions.every(right=>allowed.includes(right)))return [visibleJob];
  const required=jobViewRequirements(String(j.action),jobAccessParameters(accessParameters,displayInput),{target:j.target==null?null:String(j.target),outputScope:{security:outputSecurity,management:outputManagement}});
  if(!required.known||!required.permissions.every(right=>allowed.includes(right)))return [];
  if(scriptOutput&&!allowed.includes('runbooks.outputs'))return [{...visibleJob,result:null,resultCode:null,resultArgs:null,outputRedacted:true}];
  return [visibleJob];
 });
}
/**
 * The parameters a job's rights are read from: the kept display input (lib/job-input.ts) with the stored
 * parameters over it. Both are queue-time values, so a finished job (parameters wiped to '{}') keeps the
 * rights its kept fields name; the target and the output scope add theirs in jobViewRequirements.
 */
export function jobAccessParameters(parameters:unknown,displayInput:unknown):Record<string,unknown>{
 let params:Record<string,unknown>={};try{const parsed:unknown=JSON.parse(String(parameters||'{}'));if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))params=parsed as Record<string,unknown>;}catch{}
 return {...parseJobInput(displayInput??'{}'),...params};
}

/** The name source and the previous names (newest first) of a consoleDevices row (lib/device-name.ts). */
function deviceNameFields(row:Record<string,unknown>):{nameSource:DeviceNameSource;previousNames:string[]}{
 let previous:unknown=[];
 try{previous=JSON.parse(String(row.previousNames??'[]'));}catch{previous=[];}
 return {nameSource:isDeviceNameSource(row.nameSource)?row.nameSource:'hostname',previousNames:Array.isArray(previous)?previous.filter((name):name is string=>typeof name==='string'):[]};
}
/** The reads of GET /api/console that the device rows are built from, for the devices in scope. */
export type DeviceRowInputs={
 servers:Record<string,unknown>[];
 updates:{server_id:string;state:string;version:string;notBefore:number}[];
 permissionMap:Map<string,Permission[]>;
 multipleCustomers:boolean;
 alertOverrides:Awaited<ReturnType<typeof consoleAlertOverrides>>;
 esuOverrides:Awaited<ReturnType<typeof consoleEsuOverrides>>;
 deviceTags:Awaited<ReturnType<typeof consoleDeviceTags>>|Map<string,never>;
 openAlerts:Awaited<ReturnType<typeof consoleAlerts>>;
 autostart:Awaited<ReturnType<typeof consoleAutostart>>|Map<string,never>;
 /** The stored DHCP data of the DHCP alert rules; only for the evaluation, never in the row. */
 dhcpAlerts:Awaited<ReturnType<typeof consoleDhcpAlerts>>|Map<string,never>;
 dnsAlerts:Awaited<ReturnType<typeof consoleDnsAlerts>>|Map<string,never>;
 /** The stored integrity events of the agent alert rules; only for the evaluation, never in the row. */
 agentIntegrity?:Awaited<ReturnType<typeof consoleAgentIntegrity>>|Map<string,never>;
 serverSoftware:Awaited<ReturnType<typeof consoleServerSoftware>>|Map<string,never>;
 evaluatedAt:number;now:number;
};
/**
 * The device rows of GET /api/console: the snapshot per the viewer's rights,
 * the customer name once a second customer exists, the registration deadline
 * of a never-connected device, the group path, the agent update state, and
 * the description, tags, open alarms, OS support, autostart summary, server
 * products and the issues of the alert rules, evaluated now.
 */
export function projectDevices(input:DeviceRowInputs){
 const {servers,updates,permissionMap,multipleCustomers,alertOverrides,esuOverrides,deviceTags,openAlerts,autostart,serverSoftware,dhcpAlerts,dnsAlerts,agentIntegrity,evaluatedAt,now}=input;
 // A never-connected device carries its registration deadline (null for a
 // registration created before expiry existed); connected devices do not.
 // Every visible device lies inside the customer boundary, so its own customer's
 // name leaks nothing; disabled customers keep their name (visibleCustomers lists active ones only).
 const scopedServers=servers.map(({neverConnected,registrationExpiresAt,customerName,customerStatus,...s})=>{const update=updates.find(j=>j.server_id===s.id),permissions=permissionMap.get(String(s.id))??[];return {...s,id:String(s.id),...(multipleCustomers?{customerName:customerName==null?'':String(customerName),customerDisabled:customerStatus==='disabled'}:{}),...(neverConnected?{registration:{expiresAt:registrationExpiresAt==null?null:Number(registrationExpiresAt)}}:{}),groups:JSON.parse(String(s.groups??'[]')).map((g:{direct:boolean})=>({...g,direct:!!g.direct})),snapshot:snapshotForPermissions(s.snapshot,permissions),permissions,...(update?{maintenance:{state:update.state==='running'?'updating':update.notBefore>now?'scheduled':'queued',version:update.version,notBefore:update.notBefore}}:{})};});
 // The customer of each device for its alert rule chain and ESU origin (the device's own customer, see above).
 const customers=new Map(servers.map(s=>[String(s.id),{id:s.customerId==null?null:String(s.customerId),name:s.customerName==null?'':String(s.customerName)}]));
 // Issues from the alert rules with each device's effective settings, evaluated now (no cache).
 // The chain includes the device's customer. The OS support status uses the same settings (the warning
 // step of os-support-end) and the ESU rows, also of the customer.
 return scopedServers.map(s=>{
  const customer=customers.get(s.id)??{id:null,name:''};
  const settings=effectiveAlertSettings(resolveAlertRules(alertOverrides,deviceAlertChain(s.id,s.groups as {id:string;depth:number}[],customer.id))),osSupport=deviceOsSupport({...(s as unknown as Server),customerName:customer.name},esuOverrides,settings,evaluatedAt);
  const summary=autostart.get(s.id),software=serverSoftware.get(s.id);
  return {...s,description:String((s as {description?:unknown}).description??''),...deviceNameFields(s),tags:deviceTags.get(s.id)??[],alerts:openAlerts.get(s.id)??[],osSupport,...(summary?{autostart:summary}:{}),...(software?{serverSoftware:software}:{}),issues:evaluateAlertRules({...(s as unknown as Server),osSupport,autostart:summary,dhcpAlerts:dhcpAlerts.get(s.id),dnsAlerts:dnsAlerts.get(s.id),agentIntegrity:agentIntegrity?.get(s.id)},settings,evaluatedAt)};
 });
}
