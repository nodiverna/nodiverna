// The read tools of the device assistant (docs/ai-assistant.md). Each tool
// reads data that the portal already stores for one device, for one viewer,
// through the same projection as the console (lib/server/devices/device-projection.ts) or the
// same per-viewer reads as the device areas. No tool queues a job, sends to the
// agent or writes data. A tool that needs a right the viewer lacks returns
// {unavailable:'missingRight'}; a right that only reduces the data gives the
// reduced data, as in the console. Every result is JSON of at most 24 KiB:
// longer lists are cut and the result says so (truncated, total, shown).
// The rights are read again for every question (assistantToolContext).
import {effectivePermissions,type Permission} from '../identity/access';
import {can} from '../identity/policy/can';
import {featureDeviceGuard} from '../identity/feature-authorization';
import {consoleAudit,consoleDevices,consoleJobs,consoleRunbookJobs,multipleCustomers as readMultipleCustomers,pendingAgentUpdates} from '../console-data';
import {consoleAlertOverrides} from './alert-rule-overrides';
import {consoleEsuOverrides} from './os-esu';
import {consoleDeviceTags} from './tag-store';
import {consoleAlerts} from './alerts';
import {consoleAutostart,deviceAutostartView} from './autostart';
import {consoleServerSoftware} from '../extensions/server-role-software';
import {deviceSoftwareView} from './software';
import {deviceDriverView} from './drivers';
import {deviceSamples} from './device-history';
import {deviceAuditGuard} from '../audit-scope';
import {connectionKind} from '../../device-connection';
import {mergedJobs,projectDevices,scopeJobs,scopeRunbookJobs} from './device-projection';
import {isAssistantToolName,type AssistantToolName} from '../../assistant-config';
import type {ToolOutcome,ToolSpec} from './assistant-provider';
import type {ServerSnapshot,Viewer} from '../../types';
import {consoleDhcpAlerts} from '../extensions/plugin-data';
import {consoleDnsAlerts} from '../extensions/dns-data';
import {consoleAgentIntegrity} from '../agent/agent-integrity';
import {gpuDriverDeviceView} from './gpu-drivers/device';

/** 24 KiB per tool result; strings longer than 2,000 characters are shortened first. */
export const assistantToolLimits={resultBytes:24*1024,stringChars:2000,samplePoints:200,jobs:50,auditRows:100};

/** The console row with the columns of consoleDevices that the tools read. */
type ProjectedDevice=ReturnType<typeof projectDevices>[number]&{name:string;lastSeen:number|null;groupName?:string|null;customerName?:string;maintenance?:{state:string}};
/** What every tool of one question shares: the viewer, the device, its rights and the console row, read once. */
export type AssistantToolContext={v:Viewer;serverId:string;permissions:Permission[];now:number;device:()=>Promise<ProjectedDevice|null>};

/**
 * The context of one question. The rights and the console row are read now,
 * not cached across questions, so a right that was taken away is gone at the
 * next question.
 */
export async function assistantToolContext(v:Viewer,serverId:string,now:number):Promise<AssistantToolContext>{
 const permissions=(await effectivePermissions(v,[serverId])).get(serverId)??[];
 let device:Promise<ProjectedDevice|null>|null=null;
 return {v,serverId,permissions,now,device:()=>device??=consoleDeviceRow(v,serverId,permissions,now)};
}
/** The console row of one device, exactly as GET /api/console builds it for this viewer. */
async function consoleDeviceRow(v:Viewer,serverId:string,permissions:Permission[],now:number):Promise<ProjectedDevice|null>{
 const scope=JSON.stringify([serverId]);
 const [servers,updates,multipleCustomers,alertOverrides,esuOverrides,deviceTags,openAlerts,autostart,serverSoftware,dhcpAlerts,dnsAlerts,agentIntegrity]=await Promise.all([
  consoleDevices(scope),pendingAgentUpdates(scope),readMultipleCustomers(),consoleAlertOverrides(scope),consoleEsuOverrides(scope),consoleDeviceTags(scope),consoleAlerts(scope,now),consoleAutostart(scope),consoleServerSoftware(scope),consoleDhcpAlerts(scope),consoleDnsAlerts(scope),consoleAgentIntegrity(scope),
 ]);
 return projectDevices({servers,updates,permissionMap:new Map([[serverId,permissions]]),multipleCustomers,alertOverrides,esuOverrides,deviceTags,openAlerts,autostart,serverSoftware,dhcpAlerts,dnsAlerts,agentIntegrity,evaluatedAt:now,now})[0] as ProjectedDevice|undefined??null;
}

// ---- Results --------------------------------------------------------------------

const missingRight={unavailable:'missingRight'} as const;
const noData={unavailable:'noInventory'} as const;
const iso=(value:number|null|undefined)=>typeof value==='number'&&value>0?new Date(value).toISOString():null;
/** Removes publicKey at any depth and shortens long strings. */
function clean(value:unknown):unknown{
 if(typeof value==='string')return value.length>assistantToolLimits.stringChars?value.slice(0,assistantToolLimits.stringChars)+'…':value;
 if(Array.isArray(value))return value.map(clean);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key,entry])=>key!=='publicKey'&&entry!==undefined).map(([key,entry])=>[key,clean(entry)]));
 return value;
}
const bytes=(value:unknown)=>Buffer.byteLength(JSON.stringify(value));
type ListRef={path:string[];length:number};
function lists(value:unknown,path:string[]=[],depth=0):ListRef[]{
 if(!value||typeof value!=='object'||Array.isArray(value)||depth>2)return [];
 return Object.entries(value).flatMap(([key,entry])=>Array.isArray(entry)?[{path:[...path,key],length:entry.length}]:lists(entry,[...path,key],depth+1));
}
const getAt=(value:unknown,path:string[])=>path.reduce<unknown>((current,key)=>(current as Record<string,unknown>)[key],value);
function setAt(value:Record<string,unknown>,path:string[],entry:unknown):Record<string,unknown>{
 const [head,...rest]=path;
 return {...value,[head]:rest.length?setAt(value[head] as Record<string,unknown>,rest,entry):entry};
}
/**
 * The result as JSON of at most 24 KiB. The longest list is cut first, to the
 * most entries that fit, then the next one. The first cut list sets truncated,
 * total and shown; every cut list is named in truncatedLists.
 */
export function cappedResult(raw:unknown):string{
 let value=clean(raw);
 if(bytes(value)<=assistantToolLimits.resultBytes)return JSON.stringify(value);
 if(!value||typeof value!=='object'||Array.isArray(value))value={items:value};
 let result=value as Record<string,unknown>,cut:Record<string,{total:number;shown:number}>={};
 const marked=(base:Record<string,unknown>,cuts:typeof cut)=>{const entries=Object.values(cuts);return entries.length?{...base,truncated:true,total:entries[0].total,shown:entries[0].shown,truncatedLists:cuts}:base;};
 const fits=(base:Record<string,unknown>,cuts:typeof cut)=>bytes(marked(base,cuts))<=assistantToolLimits.resultBytes;
 for(const list of lists(result).sort((x,y)=>y.length-x.length)){
  if(fits(result,cut))break;
  const items=getAt(result,list.path) as unknown[],key=list.path.join('.');
  const trial=(shown:number)=>[setAt(result,list.path,items.slice(0,shown)),{...cut,[key]:{total:items.length,shown}}] as const;
  // The most entries of this list that still fit, by bisection.
  let low=0,high=items.length;
  while(low<high){const middle=Math.ceil((low+high)/2);if(fits(...trial(middle)))low=middle;else high=middle-1;}
  [result,cut]=trial(low);
 }
 const final=marked(result,cut);
 return bytes(final)<=assistantToolLimits.resultBytes?JSON.stringify(final):JSON.stringify({truncated:true,unavailable:'tooLarge'});
}
const matches=(filter:string|undefined,...values:(string|null|undefined)[])=>!filter||values.some(value=>typeof value==='string'&&value.toLowerCase().includes(filter.toLowerCase()));

// ---- Inputs ---------------------------------------------------------------------

type Input={filter?:string;level?:'critical'|'error'|'warning'|'information'};
const filterSchema={type:'string',maxLength:100,description:'Optional text that the name must contain (case-insensitive).'};
const noInput={type:'object',properties:{},additionalProperties:false};
const levels=['critical','error','warning','information'] as const;
/** The input of a tool call, or null when it is outside the schema of the tool. */
function parseInput(name:AssistantToolName,input:unknown):Input|null{
 if(input===undefined||input===null)input={};
 if(typeof input!=='object'||Array.isArray(input))return null;
 const allowed=name==='device_events'?['level']:['device_services','device_software','device_features'].includes(name)?['filter']:[];
 const entries=Object.entries(input as Record<string,unknown>);
 if(entries.some(([key])=>!allowed.includes(key)))return null;
 const result:Input={};
 for(const [key,value] of entries){
  if(key==='filter'){if(typeof value!=='string'||value.length>100)return null;if(value.trim())result.filter=value.trim();}
  if(key==='level'){if(!levels.includes(value as Input['level']&string))return null;result.level=value as Input['level'];}
 }
 return result;
}

// ---- Tools ----------------------------------------------------------------------

type Tool={description:string;inputSchema:Record<string,unknown>;run:(context:AssistantToolContext,input:Input)=>Promise<unknown>};
type Snapshot=ServerSnapshot;
/** A tool over the console row's snapshot; null snapshot answers noInventory. */
const fromSnapshot=(pick:(snapshot:Snapshot,device:ProjectedDevice,input:Input,context:AssistantToolContext)=>unknown)=>async(context:AssistantToolContext,input:Input)=>{
 const device=await context.device();
 if(!device)return noData;
 const snapshot=device.snapshot as Snapshot|null;
 if(!snapshot)return {...noData,lastSeen:iso(device.lastSeen)};
 return pick(snapshot,device,input,context);
};
const freshness=(device:ProjectedDevice,now:number)=>({connection:connectionKind({lastSeen:device.lastSeen,maintenance:device.maintenance},now),lastSeen:iso(device.lastSeen)});

const tools:Record<AssistantToolName,Tool>={
 device_overview:{description:'Summary of the device: name, operating system, build, uptime, pending reboot and reasons, agent mode and version, connection and last contact, group, customer, description, tags, open alarms, current CPU and memory, and collection errors.',inputSchema:noInput,
  run:async context=>{
   const device=await context.device();
   if(!device)return noData;
   const snapshot=device.snapshot as Snapshot|null,row=device;
   return {
    name:device.name,...freshness(device,context.now),group:row.groupName??null,...(row.customerName!==undefined?{customer:row.customerName}:{}),description:device.description||null,
    tags:device.tags,openAlarms:device.alerts.map(alarm=>({rule:alarm.ruleId,key:alarm.key,level:alarm.level,since:iso(alarm.startedAt),acknowledged:!!alarm.acknowledged,muted:!!alarm.muted})),
    issues:device.issues,
    ...(snapshot?{os:snapshot.os,build:snapshot.build,uptimeSeconds:snapshot.uptimeSeconds,rebootPending:snapshot.rebootPending,rebootReasons:snapshot.rebootReasons??[],mode:snapshot.mode,agentVersion:snapshot.agentVersion,cpuPercent:snapshot.cpu,memoryPercent:snapshot.memory,collectionErrors:snapshot.collectionErrors,collectorErrors:snapshot.collectorErrors??[]}:{inventory:'none'}),
   };
  }},
 device_hardware:{description:'Hardware of the device: manufacturer, model, cores, memory, the hardware inventory (CPUs, memory modules, disks, BIOS, board, adapters), GPUs, disk health, battery, page file and performance counters.',inputSchema:noInput,
  run:fromSnapshot(snapshot=>({manufacturer:snapshot.manufacturer,model:snapshot.model,cores:snapshot.cores,memoryGb:snapshot.memoryGb,hardware:snapshot.hardware??null,gpus:snapshot.gpus??[],gpuDetails:snapshot.gpuDetails??[],diskHealth:snapshot.diskHealth??null,battery:snapshot.battery??null,pagefile:snapshot.pagefile??null,performance:snapshot.performance??null}))},
 device_gpu_drivers:{description:'Graphics driver status per vendor (NVIDIA, AMD): installed version, latest version from the vendor, status (current, outdated, unknown, unsupported) and the reason. Read it before you propose install-gpu-driver. pendingInventory is a finished driver install that the next inventory has not reported yet; installed then already shows that version.',inputSchema:noInput,
  run:async context=>{
   if(!context.permissions.includes('view'))return missingRight;
   // Never a forced lookup (refresh false), so the model cannot use up the vendor lookup budget. No download URL and no GPU IDs.
   let view:Awaited<ReturnType<typeof gpuDriverDeviceView>>;
   try{view=await gpuDriverDeviceView(context.v,context.serverId,false);}
   catch(error){if((error as {messageKey?:unknown})?.messageKey==='apiError.access.devicePermissionMissing')return missingRight;throw error;}
   return {entries:view.entries.map(entry=>({vendor:entry.vendor,gpuNames:entry.gpuNames,installed:entry.installed,pendingInventory:entry.pendingInventory?{version:entry.pendingInventory.version,finishedAt:iso(entry.pendingInventory.finishedAt)}:null,latest:entry.latest,status:entry.status,reason:entry.reason,checkedAt:iso(entry.checkedAt)})),...(view.notice?{notice:view.notice.messageKey}:{})};
  }},
 device_metrics:{description:'Stored CPU and memory samples of the last 24 hours (at most 200 points, evenly spread) with minimum, average and maximum.',inputSchema:noInput,
  run:async context=>{
   const samples=await deviceSamples(context.serverId,featureDeviceGuard(context.v,context.serverId,['view']));
   const stats=(values:(number|null)[])=>{const list=values.filter((value):value is number=>typeof value==='number');return list.length?{min:Math.min(...list),avg:Math.round(list.reduce((sum,value)=>sum+value,0)/list.length*10)/10,max:Math.max(...list)}:null;};
   const step=Math.max(1,Math.ceil(samples.length/assistantToolLimits.samplePoints));
   return {count:samples.length,from:iso(samples[0]?.at),to:iso(samples.at(-1)?.at),cpu:stats(samples.map(sample=>sample.cpu)),memory:stats(samples.map(sample=>sample.memory)),
    points:samples.filter((_,index)=>index%step===0).slice(0,assistantToolLimits.samplePoints).map(sample=>({at:iso(sample.at),cpu:sample.cpu,memory:sample.memory}))};
  }},
 device_services:{description:'Windows services of the device with status and start mode. Optional filter on the service name or display name.',inputSchema:{type:'object',properties:{filter:filterSchema},additionalProperties:false},
  run:fromSnapshot((snapshot,device,input,context)=>{const services=snapshot.services.filter(service=>matches(input.filter,service.name,service.displayName));return {...freshness(device,context.now),total:snapshot.services.length,matching:services.length,services};})},
 device_processes:{description:'Processes of the device as the console shows them to you, sorted by memory. User and path details only with the diagnose right.',inputSchema:noInput,
  run:fromSnapshot((snapshot,device,_input,context)=>({...freshness(device,context.now),details:context.permissions.includes('diagnose')?'full':'reduced',inventory:snapshot.processInventory??null,processes:[...snapshot.processes].sort((a,b)=>(b.memoryMb??0)-(a.memoryMb??0))}))},
 device_events:{description:'Stored Windows events, crashes and reliability records of the device. Optional level filter.',inputSchema:{type:'object',properties:{level:{type:'string',enum:[...levels]}},additionalProperties:false},
  run:fromSnapshot((snapshot,device,input,context)=>({...freshness(device,context.now),events:snapshot.events.filter(event=>!input.level||event.level.toLowerCase().startsWith(input.level.slice(0,4))),crashes:snapshot.crashes??[],crashInventory:snapshot.crashInventory??null,reliability:snapshot.reliability??null}))},
 device_updates:{description:'Pending Windows updates, installed hotfixes, the OS version details and the OS support status, and whether a reboot is pending.',inputSchema:noInput,
  run:fromSnapshot((snapshot,device,_input,context)=>({...freshness(device,context.now),rebootPending:snapshot.rebootPending,rebootReasons:snapshot.rebootReasons??[],updates:snapshot.updates??null,osInfo:snapshot.osInfo??null,osSupport:device.osSupport,hotfixes:snapshot.hotfixes}))},
 device_storage:{description:'Disks and volumes with size and free space, and the BitLocker state.',inputSchema:noInput,
  run:fromSnapshot((snapshot,device,_input,context)=>({...freshness(device,context.now),disks:snapshot.disks,bitlocker:snapshot.bitlocker??null}))},
 device_network:{description:'Network adapters, network configuration, firewall profiles and rules, and the Remote Desktop settings.',inputSchema:noInput,
  run:fromSnapshot((snapshot,device,_input,context)=>({...freshness(device,context.now),adapters:snapshot.networks,configuration:snapshot.networkConfig??[],firewallProfiles:snapshot.security?.firewall??[],rdp:snapshot.rdp??null,firewallRules:snapshot.firewallRules??[]}))},
 device_security:{description:'Security summary, Microsoft Defender (detections and exclusions only with the defender.read right, and a scan that the portal started and that still runs), machine certificates, local users and groups.',inputSchema:noInput,
  run:fromSnapshot((snapshot,device,_input,context)=>({...freshness(device,context.now),security:snapshot.security??null,defender:snapshot.defender??null,defenderScan:snapshot.defenderScan??null,defenderDetails:context.permissions.includes('defender.read')?'full':'summary',certificates:snapshot.certificates??null,localUsers:snapshot.localUsers??[],localGroups:snapshot.localGroups??[]}))},
 device_software:{description:'Installed software of the device and recent software changes. Optional filter on the name or publisher.',inputSchema:{type:'object',properties:{filter:filterSchema},additionalProperties:false},
  run:async(context,input)=>{
   const view=await deviceSoftwareView(context.v,context.serverId);
   const items=view.items.filter(item=>matches(input.filter,item.name,item.publisher)).map(({name,version,publisher,installDate,architecture,scope,verdict})=>({name,version,publisher,installDate,architecture,scope,...(verdict?{verdict}:{})}));
   return {reportedAt:iso(view.state?.reportedAt),total:view.items.length,matching:items.length,items,changes:view.changes.filter(change=>matches(input.filter,change.name,change.publisher)).map(change=>({...change,at:iso(change.at)}))};
  }},
 device_drivers:{description:'Drivers of the device with provider, version, date and signature.',inputSchema:noInput,
  run:async context=>{const view=await deviceDriverView(context.v,context.serverId);return {reportedAt:iso(view.state?.reportedAt),total:view.items.length,drivers:view.items};}},
 device_autostart:{description:'Autostart entries of the device (run keys, startup folder, services, tasks) with signature and whether they are new or suspicious.',inputSchema:noInput,
  run:async context=>{const view=await deviceAutostartView(context.v,context.serverId);return {reportedAt:iso(view.state?.reportedAt),total:view.items.length,entries:view.items.map(entry=>({...entry,acknowledgedBy:undefined,firstSeen:iso(entry.firstSeen),acknowledgedAt:iso(entry.acknowledgedAt)}))};}},
 device_features:{description:'Windows roles and features of the device and whether each is installed. Optional filter on the name or display name.',inputSchema:{type:'object',properties:{filter:filterSchema},additionalProperties:false},
  run:fromSnapshot((snapshot,_device,input)=>{
   if(!Array.isArray(snapshot.features))return {features:null};
   const features=snapshot.features.filter(feature=>matches(input.filter,feature.name,feature.displayName)).map(({name,displayName,installed,featureType,parent})=>({name,displayName,installed,featureType,parent:parent??null}));
   return {total:snapshot.features.length,matching:features.length,features};
  })},
 device_tasks:{description:'Scheduled tasks of the device and a planned shutdown or restart.',inputSchema:noInput,
  run:fromSnapshot((snapshot,device,_input,context)=>({...freshness(device,context.now),powerSchedule:snapshot.powerSchedule??null,tasks:snapshot.tasks??[]}))},
 device_jobs:{description:'Recent jobs and runbook runs of the device that you may see, newest first.',inputSchema:noInput,
  run:async context=>{
   const scope=JSON.stringify([context.serverId]),permissionMap=new Map([[context.serverId,context.permissions]]);
   const [jobs,runbooks,owner]=await Promise.all([consoleJobs(scope),consoleRunbookJobs(scope),can(context.v,'instance.owner')]);
   const visible=mergedJobs(scopeJobs(jobs,owner,permissionMap),scopeRunbookJobs(runbooks,permissionMap)).filter(job=>String(job.serverId)===context.serverId).slice(0,assistantToolLimits.jobs);
   return {jobs:visible.map(job=>({...job,createdAt:iso(Number(job.createdAt)),claimedAt:iso(Number(job.claimedAt)||null)}))};
  }},
 device_audit:{description:'Audit rows of the device: who changed what and when. Needs the security.events right.',inputSchema:noInput,
  run:async context=>{
   if(!context.permissions.includes('view')||!context.permissions.includes('security.events'))return missingRight;
   const rows=await consoleAudit(deviceAuditGuard(context.v,[context.serverId]),assistantToolLimits.auditRows) as {at:number;actor:string;action:string;target:string}[];
   return {rows:rows.map(row=>({at:iso(Number(row.at)),actor:row.actor,action:row.action,target:row.target}))};
  }},
};

/** The tools as the model sees them. */
export const assistantToolSpecs:readonly ToolSpec[]=Object.entries(tools).map(([name,tool])=>({name,description:tool.description,inputSchema:tool.inputSchema}));

/**
 * Runs one tool call. An unknown name or an input outside the schema gives an
 * error result; a failed read gives an error result too. Never throws.
 */
export async function runAssistantTool(context:AssistantToolContext,name:string,input:unknown):Promise<ToolOutcome>{
 if(!isAssistantToolName(name))return {content:JSON.stringify({error:'unknownTool',message:'There is no tool with this name.'}),isError:true};
 const parsed=parseInput(name,input);
 if(!parsed)return {content:JSON.stringify({error:'invalidInput',message:'The input does not match the tool schema.'}),isError:true};
 try{return {content:cappedResult(await tools[name].run(context,parsed)),isError:false};}
 catch{return {content:JSON.stringify({error:'readFailed',message:'The data could not be read.'}),isError:true};}
}
