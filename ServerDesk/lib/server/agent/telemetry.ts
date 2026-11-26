import {z} from 'zod';
import {hardwareInventory} from '../devices/hardware-inventory';
import {AGENT_INTEGRITY_SERVICES,AGENT_INTEGRITY_TARGETS,AGENT_START_TYPES} from '../../agent-integrity-contract';
import {withOptionalDevSuffix} from '../../../runtime/release-version.mjs';
const text=z.string().max(500),nonnegative=z.number().min(0),metric=nonnegative.nullable();
export const gpuSnapshots=z.array(z.object({id:z.string().min(1).max(128),name:z.string().min(1).max(256),vendor:z.enum(['nvidia','amd','intel']),utilization:z.number().finite().min(0).max(100).nullable(),collectedAt:z.string().max(60).datetime({offset:true})}).strict()).max(16).superRefine((gpus,context)=>{
 if(new Set(gpus.map(gpu=>gpu.id)).size!==gpus.length)context.addIssue({code:'custom',message:'GPU-Kennungen müssen eindeutig sein.'});
});
const gpuDetailText=z.string().max(128).nullable().optional();
const gpuDetailMetric=(minimum:number,maximum:number)=>z.number().finite().min(minimum).max(maximum).nullable().optional();
const gpuDetailInteger=(minimum:number,maximum:number)=>z.number().finite().int().min(minimum).max(maximum).nullable().optional();
const gpuDetails=z.array(z.object({
 id:z.string().min(1).max(128),collectedAt:z.string().max(60).datetime({offset:true}),
 driverVersion:gpuDetailText,vendorDriverVersion:gpuDetailText,driverModel:gpuDetailText,vbiosVersion:gpuDetailText,
 vendorId:gpuDetailInteger(0,65535),deviceId:gpuDetailInteger(0,65535),subsystemId:gpuDetailInteger(0,4294967295),revision:gpuDetailInteger(0,4294967295),pciBusId:z.string().max(32).nullable().optional(),
 dedicatedMemoryBytes:gpuDetailInteger(0,Number.MAX_SAFE_INTEGER),sharedMemoryBytes:gpuDetailInteger(0,Number.MAX_SAFE_INTEGER),dedicatedMemoryUsedBytes:gpuDetailInteger(0,Number.MAX_SAFE_INTEGER),sharedMemoryUsedBytes:gpuDetailInteger(0,Number.MAX_SAFE_INTEGER),
 temperatureCelsius:gpuDetailMetric(-50,200),coreClockMhz:gpuDetailMetric(0,100000),memoryClockMhz:gpuDetailMetric(0,100000),powerWatts:gpuDetailMetric(0,10000),powerLimitWatts:gpuDetailMetric(0,10000),fanPercent:gpuDetailMetric(0,200),
 pcieGeneration:gpuDetailInteger(1,16),pcieMaxGeneration:gpuDetailInteger(1,16),pcieLinkWidth:gpuDetailInteger(1,128),pcieMaxLinkWidth:gpuDetailInteger(1,128),memoryBusWidthBits:gpuDetailInteger(1,65536),cudaCores:gpuDetailInteger(1,10000000),
 sensorProvider:z.enum(['windows','nvidia-nvml']).nullable().optional()
}).strict()).max(16).superRefine((details,context)=>{
 if(new Set(details.map(gpu=>gpu.id)).size!==details.length)context.addIssue({code:'custom',message:'GPU-Diagnosekennungen müssen eindeutig sein.'});
});
// Health signals of agent 4.10.0 (docs/v3-health-signals.md): strict objects, so
// an unknown key (for example a recovery password) rejects the whole heartbeat.
const isoDate=z.string().max(60).datetime({offset:true});
const shortText=z.string().max(256);
export const crashEntries=z.array(z.object({
 id:z.string().min(1).max(64).regex(/^[0-9a-f]+$/),kind:z.enum(['bugcheck','unexpected-shutdown','hardware-error']),at:isoDate,
 stopCode:z.number().int().min(0).max(4294967295).nullable(),parameters:z.array(z.string().regex(/^0x[0-9a-fA-F]{1,16}$/)).length(4).nullable(),
 driver:z.object({name:z.string().min(1).max(256),version:shortText.nullable(),manufacturer:shortText.nullable()}).strict().nullable(),
 source:z.enum(['event','minidump','event+minidump']),dumpFile:z.string().min(1).max(256).regex(/^[^\\/:]+$/).nullable(),dumpStatus:z.enum(['parsed','unreadable','too-large','none']),detail:shortText.nullable()
}).strict()).max(50);
export const crashInventory=z.object({collectedAt:isoDate,windowDays:z.literal(30),complete:z.boolean(),truncated:z.boolean(),error:shortText.optional()}).strict();
const osText=z.string().max(100).nullable();
export const osInfo=z.object({editionId:osText,installationType:osText,displayVersion:osText,ubr:z.number().int().min(0).max(4294967295).nullable(),productName:osText,currentBuild:osText}).strict();
export const bitlockerState=z.object({
 available:z.boolean(),reason:z.enum(['not-supported','access-denied','error']).optional(),collectedAt:isoDate,
 volumes:z.array(z.object({
  drive:z.string().regex(/^[A-Z]:$/).nullable(),volumeType:z.enum(['os','fixed','removable']),
  conversion:z.enum(['decrypted','encrypted','encrypting','decrypting','paused-encrypting','paused-decrypting','unknown']),percent:z.number().min(0).max(100).nullable(),
  protection:z.enum(['on','off','suspended','unknown']),
  method:z.enum(['none','aes-128-diffuser','aes-256-diffuser','aes-128','aes-256','hardware','xts-aes-128','xts-aes-256','unknown']),
  protectors:z.array(z.enum(['tpm','tpm-pin','tpm-startup-key','tpm-pin-startup-key','external-key','numerical-password','passphrase','public-key','tpm-certificate','ad-account','unknown'])).max(11).refine(list=>new Set(list).size===list.length,'BitLocker protectors must be unique.'),
  suspendedSince:isoDate.nullable()
 }).strict()).max(64)
}).strict();
// Health signals of agent 4.11.0 (docs/v3-health-signals.md): strict objects as in
// 4.10.0, so an unknown key (a private key, raw certificate data) rejects the heartbeat.
const nullableText=shortText.nullable();
// No folder of a program: file names only.
const fileName=z.string().min(1).max(256).regex(/^[^\\/]+$/);
export const driverHealth=z.object({
 collectedAt:isoDate,checksum:z.string().regex(/^[0-9a-f]{64}$/),count:z.number().int().min(0).max(1_000_000),truncated:z.boolean(),unsignedCount:z.number().int().min(0).max(1_000_000),
 unsigned:z.array(z.object({key:z.string().regex(/^[0-9a-f]{16}$/),deviceName:z.string().min(1).max(256),infName:nullableText,file:fileName.nullable(),provider:nullableText,version:nullableText}).strict()).max(20),
 problems:z.array(z.object({key:z.string().regex(/^[0-9a-f]{16}$/),name:z.string().min(1).max(256),class:nullableText,code:z.number().int().min(1).max(999),manufacturer:nullableText}).strict()).max(100),
 problemsTruncated:z.boolean()
}).strict().superRefine((value,context)=>{
 if(value.unsigned.length>value.unsignedCount)context.addIssue({code:'custom',path:['unsignedCount'],message:'unsignedCount is smaller than the list.'});
});
// Microsoft Defender of agent 4.14.0 (docs/v3-health-signals.md, "Microsoft Defender in 4.14.0"):
// strict like the other health signals, so an unknown key rejects the heartbeat.
// Detections and exclusions hold paths and user names; the console strips them
// without defender.read (app/api/console/route.ts).
const defenderText=z.string().max(500),defenderVersion=z.string().max(64).nullable();
const defenderSeverity=z.enum(['low','moderate','high','severe','unknown']);
export const defenderDetection=z.object({
 id:z.string().min(1).max(500),threatId:defenderText,name:defenderText.nullable(),severity:defenderSeverity,
 status:z.enum(['detected','cleaned','quarantined','removed','allowed','blocked','failed','abandoned','unknown']),active:z.boolean(),
 path:defenderText.nullable(),resourceCount:z.number().int().min(0).max(1_000_000),at:isoDate.nullable(),user:defenderText.nullable()
}).strict();
const defenderList=z.array(defenderText).max(200);
export const defenderState=z.union([
 z.object({available:z.literal(false),reason:z.enum(['not-installed','access-denied','error']).optional(),collectedAt:isoDate}).strict(),
 z.object({
  available:z.literal(true),collectedAt:isoDate,mode:z.enum(['normal','passive','sxs-passive','edr-block','not-running','unknown']),
  antivirusEnabled:z.boolean(),realTimeProtection:z.boolean(),tamperProtected:z.boolean().nullable(),
  quickScanAt:isoDate.nullable(),fullScanAt:isoDate.nullable(),signatureAt:isoDate.nullable(),signatureVersion:defenderVersion,productVersion:defenderVersion,
  otherAntivirus:z.array(z.object({name:z.string().min(1).max(256),enabled:z.boolean()}).strict()).max(4).nullable(),
  detectionCount:z.number().int().min(0).max(1_000_000),activeCount:z.number().int().min(0).max(1_000_000),highestActiveSeverity:defenderSeverity.nullable(),truncated:z.boolean(),
  detections:z.array(defenderDetection).max(100),
  exclusions:z.object({paths:defenderList,extensions:defenderList,processes:defenderList}).strict().nullable()
 }).strict().superRefine((value,context)=>{
  if(value.detectionCount<value.detections.length)context.addIssue({code:'custom',path:['detectionCount'],message:'detectionCount is smaller than the list.'});
  if(value.truncated!==(value.detectionCount>value.detections.length))context.addIssue({code:'custom',path:['truncated'],message:'truncated does not match detectionCount.'});
  if(value.activeCount<value.detections.filter(item=>item.active).length)context.addIssue({code:'custom',path:['activeCount'],message:'activeCount is smaller than the active rows.'});
  if(new Set(value.detections.map(item=>item.id)).size!==value.detections.length)context.addIssue({code:'custom',path:['detections'],message:'Detection IDs must be unique.'});
 })
]);
// A portal scan of agent 4.15.0 that is still running (docs/device-health-signals.md):
// a top-level key next to the strict defender object, so an older portal drops it
// and accepts the heartbeat. Absent while no portal scan runs.
export const defenderScanState=z.object({kind:z.enum(['quick','full']),startedAt:isoDate}).strict();
/** The heartbeat key agentIntegrity (agent 4.18.0): strict, at most 2 services and 16 findings. */
export const agentIntegrity=z.object({
 checkedAt:z.string().max(40).datetime({offset:true}),
 services:z.array(z.object({service:z.enum(AGENT_INTEGRITY_SERVICES),startType:z.enum(AGENT_START_TYPES)}).strict()).max(2),
 findings:z.array(z.object({target:z.enum(AGENT_INTEGRITY_TARGETS),service:z.enum(AGENT_INTEGRITY_SERVICES).optional()}).strict()).max(16)
}).strict();
// Collector errors of agent 4.11.1 (docs/v3-health-signals.md, "Collector errors in 4.11.1"):
// one strict entry per collector whose most recent run failed, at most 30.
export const collectorErrorCodes=['timeout','access-denied','not-supported','broker-unavailable','error'] as const;
// The plugins of agent 4.16.0 (docs/agent-plugins.md). A damaged plugin whose manifest cannot be read reports role unknown and version 0.0.0.
// A dev build of a plugin reports X.Y.Z-dev.<sha7> (runtime/release-version.mjs).
// Current agents report role; a later agent may report target. A report needs one of them; the parsed and stored
// report carries target (target, else role) and no role.
const pluginTargetId=z.string().regex(/^[a-z][a-z0-9-]{1,31}$/);
export const pluginReports=z.array(z.object({
 name:z.string().regex(/^[a-z][a-z0-9-]{1,31}$/),target:pluginTargetId.optional(),role:pluginTargetId.optional(),version:z.string().regex(withOptionalDevSuffix('\\d{1,5}\\.\\d{1,5}\\.\\d{1,5}')),
 capabilities:z.array(z.string().regex(/^[a-z][a-z0-9-]{1,63}$/)).max(32),state:z.enum(['ready','damaged']),networkBlocked:z.boolean(),
 error:z.string().regex(/^AGENT_PLUGIN_[A-Z0-9_]{1,48}$/).optional()
}).strict().refine(plugin=>plugin.target!==undefined||plugin.role!==undefined,{message:'A plugin report needs target or role.',path:['target']})
 .transform(({target,role,...plugin})=>({...plugin,target:(target??role)!})))
 .max(16).refine(plugins=>new Set(plugins.map(plugin=>plugin.name)).size===plugins.length,'Plugin names must be unique.');
export const collectorErrors=z.array(z.object({
 collector:z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),code:z.enum(collectorErrorCodes),since:isoDate,lastAt:isoDate,
 failures:z.number().int().min(1).max(1_000_000),elapsedMs:z.number().int().min(0).max(3_600_000).nullable()
}).strict()).max(30);
const stabilityDay=z.object({day:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),index:z.number().min(1).max(10)}).strict();
export const reliabilityState=z.object({
 collectedAt:isoDate,windowDays:z.literal(30),
 stability:z.discriminatedUnion('available',[
  z.object({available:z.literal(true),current:z.number().min(1).max(10),days:z.array(stabilityDay).max(30)}).strict(),
  z.object({available:z.literal(false),reason:z.enum(['collection-disabled','not-supported','access-denied','error'])}).strict(),
 ]),
 events:z.array(z.object({at:isoDate,kind:z.enum(['crash','hang','install-failure']),program:z.string().min(1).max(256).regex(/^[^\\]+$/),version:nullableText,module:fileName.nullable(),moduleVersion:nullableText}).strict()).max(100),
 truncated:z.boolean()
}).strict();
const nullableMetric=(minimum:number,maximum:number,integer=false)=>(integer?z.number().int():z.number().finite()).min(minimum).max(maximum).nullable();
export const diskHealthState=z.object({
 collectedAt:isoDate,
 disks:z.array(z.object({
  id:z.string().min(1).max(128),number:z.number().int().min(0).max(4096).nullable(),model:z.string().max(256),busType:z.string().max(64),
  mediaType:z.enum(['ssd','hdd','scm','unspecified']),health:z.enum(['healthy','warning','unhealthy','unknown']),
  operationalStatus:z.array(z.enum(['ok','degraded','stressed','predictive-failure','failed','starting','stopping','stopped','in-service','no-contact','lost-communication','aborted','dormant','supporting-entity-in-error','completed','power-mode','unknown'])).max(8),
  driveLetters:z.array(z.string().regex(/^[A-Z]:$/)).max(26),countersAvailable:z.boolean(),
  wearPercent:nullableMetric(0,100),temperatureC:nullableMetric(-50,200),temperatureMaxC:nullableMetric(-50,200),
  readErrorsUncorrected:nullableMetric(0,Number.MAX_SAFE_INTEGER,true),powerOnHours:nullableMetric(0,10_000_000,true)
 }).strict()).max(64),
 events:z.object({
  windowDays:z.literal(30),
  items:z.array(z.object({at:isoDate,source:z.enum(['disk','ntfs']),eventId:z.union([z.literal(7),z.literal(51),z.literal(153),z.literal(55)]),disk:z.number().int().min(0).max(4096).nullable(),volume:z.string().regex(/^[A-Z]:$/).nullable()}).strict()).max(50),
  counts:z.record(z.string().regex(/^(?:\d{1,4}|unknown)$/),z.number().int().min(1).max(1_000_000)).refine(counts=>Object.keys(counts).length<=65,'too many disks'),
  truncated:z.boolean()
 }).strict()
}).strict();
export const batteryState=z.object({
 collectedAt:isoDate,present:z.boolean(),reason:z.enum(['no-battery','not-supported','access-denied','error']).optional(),
 batteries:z.array(z.object({id:z.number().int().min(0).max(3),name:nullableText,designCapacityMWh:nullableMetric(0,10_000_000,true),fullChargeCapacityMWh:nullableMetric(0,10_000_000,true),healthPercent:nullableMetric(0,150,true),cycleCount:nullableMetric(0,1_000_000,true)}).strict()).max(4)
}).strict().superRefine((value,context)=>{
 if(!value.present&&!value.reason)context.addIssue({code:'custom',path:['reason'],message:'A missing battery needs a reason.'});
 if(!value.present&&value.batteries.length)context.addIssue({code:'custom',path:['batteries'],message:'No battery but a battery list.'});
});
export const certificateInventory=z.object({
 collectedAt:isoDate,
 items:z.array(z.object({
  thumbprint:z.string().regex(/^[0-9A-F]{40}$/),stores:z.array(z.enum(['My','WebHosting','Remote Desktop'])).min(1).max(3),
  subject:z.string().max(1024),sans:z.array(shortText).max(10),issuer:z.string().max(1024),notBefore:isoDate,notAfter:isoDate,hasPrivateKey:z.boolean(),selfSigned:z.boolean(),
  bindings:z.array(z.discriminatedUnion('type',[z.object({type:z.literal('https'),endpoint:z.string().min(1).max(300)}).strict(),z.object({type:z.literal('rdp'),endpoint:z.literal('RDP-Tcp')}).strict()])).max(20)
 }).strict()).max(100),
 truncated:z.boolean()
}).strict();
export const telemetry=z.object({hostname:text,os:text,build:text,manufacturer:text,model:text,domain:text,cores:z.number().int().min(1).max(8192),memoryGb:nonnegative,cpu:z.number().min(0).max(100).nullable(),memory:z.number().min(0).max(100),uptimeSeconds:nonnegative,rebootPending:z.boolean(),management:z.boolean(),
 rebootReasons:z.array(z.enum(['windows-servicing','windows-update','file-replacement','file-operations-unknown'])).max(4).optional(),pendingFileOperationsCount:z.number().int().min(0).max(1_000_000).optional(),
 disks:z.array(z.object({name:text,label:text,totalGb:nonnegative,freeGb:nonnegative})).max(100),
 services:z.array(z.object({name:text,displayName:text,status:text,startMode:text})).max(1000),
 processes:z.array(z.object({name:text,pid:z.number().int().min(0).max(2147483647),memoryMb:nonnegative,cpuSeconds:metric,
  startedAt:z.string().max(60).datetime({offset:true}).optional(),parentPid:z.number().int().min(0).max(2147483647).optional(),
  sessionId:z.number().int().min(0).optional(),user:text.nullable().optional(),path:text.nullable().optional(),
  cpuPercent:z.number().min(0).max(100).nullable().optional(),protected:z.boolean().optional()
 })).max(5000),
 processInventory:z.object({collectedAt:z.string().max(60).datetime({offset:true}),count:z.number().int().min(0),truncated:z.boolean(),complete:z.boolean(),intervalSeconds:z.number().int().min(10).max(3600),error:text.optional()}).optional(),
 gpus:gpuSnapshots.optional(),gpuDetails:gpuDetails.optional(),hardware:hardwareInventory.optional(),
 events:z.array(z.object({id:z.number(),level:text,source:text,message:z.string().max(4000),at:text})).max(50),
 networks:z.array(z.object({name:text,addresses:z.array(text).max(20),mac:text,speedMbps:z.number()})).max(100),
 hotfixes:z.array(z.object({id:text,installedOn:text})).max(30),collectionErrors:z.array(text).max(20),
 protocolVersion:z.literal(3),agentVersion:z.string().regex(withOptionalDevSuffix('[34]\\.\\d+\\.\\d+')).max(30),mode:z.enum(['ReadOnly','Management']),
 publicKey:z.object({kty:z.literal('RSA'),n:z.string().regex(/^[a-zA-Z0-9_-]{342}$/),e:z.literal('AQAB')}),
 agentCapabilities:z.array(z.string().max(80)).max(100),
 agentIsolation:z.object({split:z.boolean(),brokerVersion:z.string().max(30),account:text,elevated:z.boolean(),privileges:z.array(text).max(40)}).strict().optional(),
 features:z.array(z.object({name:text,displayName:text,installed:z.boolean(),featureType:text,parent:text.nullable().optional(),subFeatures:z.array(text).max(1000).optional(),depth:z.number().int().min(0).max(32).optional()})).max(1000).optional(),
 localUsers:z.array(z.object({name:text,sid:text,enabled:z.boolean(),fullName:text,description:text,passwordExpires:z.boolean(),lastLogon:text})).max(500).optional(),
 localGroups:z.array(z.object({name:text,sid:text,members:z.array(text).max(500)})).max(100).optional(),
 networkConfig:z.array(z.object({interfaceIndex:z.number().int().positive(),alias:text,dhcp:z.boolean(),addresses:z.array(z.object({address:text,prefixLength:z.number().int().min(0).max(128)})).max(50),gateway:z.array(text).max(20),dns:z.array(text).max(20),status:text})).max(100).optional(),
 pagefile:z.object({automatic:z.boolean(),files:z.array(z.object({name:text,initialMb:nonnegative,maximumMb:nonnegative,allocatedMb:nonnegative,currentUsageMb:nonnegative,peakUsageMb:nonnegative})).max(20)}).optional(),
 rdp:z.object({enabled:z.boolean(),nla:z.boolean(),port:z.number().int().min(1).max(65535),policyBlocked:z.boolean()}).optional(),
 security:z.object({domainJoined:z.boolean(),domainRole:z.number().int().min(0).max(5),rdpEnabled:z.boolean(),firewall:z.array(z.object({name:text,enabled:z.boolean()})).max(3),defender:z.object({available:z.boolean(),enabled:z.boolean(),signatureAt:text,realTimeProtection:z.boolean()}),lastBoot:text,
  // Agent 4.19.0 (docs/plugin-ad-sign-in.md): the directory for the AD sign-in of plugin changes, read through LSA without network.
  directory:z.object({kind:z.enum(['domain','local']),name:z.string().min(1).max(256),netbiosName:z.string().min(1).max(256),sid:z.string().max(256).regex(/^S-1-5-21(-\d+){3}$/)}).strict().optional()}).optional(),
 firewallRules:z.array(z.object({name:text,displayName:text,enabled:z.boolean(),direction:text,action:text,protocol:text,port:text,remoteAddress:text})).max(300).optional(),
 powerSchedule:z.object({id:z.guid(),operation:z.enum(['shutdown','restart']),scheduledAt:z.string().max(60).datetime(),reason:z.string().min(1).max(200).regex(/^[^\u0000-\u001f]+$/)}).strict().nullable().optional(),
 tasks:z.array(z.object({name:text,path:text,state:text,lastRun:text,nextRun:text,lastResult:z.number()})).max(200).optional(),
 updates:z.object({checkedAt:text,pendingCount:z.number().int().min(0),items:z.array(z.object({id:z.guid(),title:text,kb:text,severity:text,rebootRequired:z.boolean()})).max(100)}).optional(),
 performance:z.object({diskReadBytesSec:metric,diskWriteBytesSec:metric,networkBytesSec:metric,diskLatencyMs:metric,processorQueue:metric,pagefilePercent:metric}).optional(),
 osInfo:osInfo.optional(),crashes:crashEntries.optional(),crashInventory:crashInventory.optional(),bitlocker:bitlockerState.optional(),
 softwareChecksum:z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(),
 driverHealth:driverHealth.optional(),reliability:reliabilityState.optional(),diskHealth:diskHealthState.optional(),battery:batteryState.optional(),certificates:certificateInventory.optional(),
 autostartChecksum:z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(),defender:defenderState.optional(),defenderScan:defenderScanState.optional(),
 collectorErrors:collectorErrors.optional(),
 plugins:pluginReports.optional(),
 // The broker's integrity check of agent 4.18.0 (lib/agent-integrity-contract.ts): both start types and the open findings.
 agentIntegrity:agentIntegrity.optional()
}).superRefine((s,context)=>{
 if(s.gpuDetails){const ids=new Set(s.gpus?.map(gpu=>gpu.id));s.gpuDetails.forEach((gpu,index)=>{if(!ids.has(gpu.id))context.addIssue({code:'custom',path:['gpuDetails',index,'id'],message:'GPU-Diagnosedaten benötigen eine gemeldete GPU.'});});}
 if(s.management!==(s.mode==='Management'))context.addIssue({code:'custom',path:['mode'],message:'Agentmodus und Managementstatus stimmen nicht überein.'});
 if(s.rebootReasons&&(s.rebootPending!==(s.rebootReasons.length>0)||new Set(s.rebootReasons).size!==s.rebootReasons.length))context.addIssue({code:'custom',path:['rebootReasons'],message:'Neustartstatus und Ursachen stimmen nicht überein.'});
 if(s.processInventory){
  if(s.processInventory.count<s.processes.length)context.addIssue({code:'custom',path:['processInventory','count'],message:'Prozessanzahl ist kleiner als die übermittelte Liste.'});
  if(s.processInventory.truncated!==(s.processInventory.count>s.processes.length))context.addIssue({code:'custom',path:['processInventory','truncated'],message:'Kürzungsstatus stimmt nicht mit der Prozessanzahl überein.'});
  if(!s.processInventory.complete&&!s.processInventory.error)context.addIssue({code:'custom',path:['processInventory','error'],message:'Unvollständiges Prozessinventar benötigt einen Fehlerhinweis.'});
 }
});
