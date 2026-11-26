// Agent extensions (docs/extensions.md, docs/agent-plugins.md): what a device
// runs (a Windows role, a Windows feature or a known software product) and
// which agent extension (plugin) belongs to it. Two catalogs:
// - detectionCatalog: what the portal detects, from data the agent already
//   sends: the "Roles and features" telemetry (snapshot.features, ServerManager
//   UniqueName) for role and feature entries, the software inventory
//   (device_software, matched on the server by lib/server/extensions/server-role-software.ts) for
//   software entries. Each entry says on which devices it counts: only on
//   Windows Server (devices 'server', every entry today, so a laptop with Veeam
//   Agent or SQL Express never gets an Extensions area) or on any device ('any').
// - extensionCatalog: the extensions the portal knows, each linked to the
//   detection id it extends (its target).
// Pure, without server imports: the console, the device tab, the fleet tab, the
// demo data and the tests use it.
import type {Job,Server,ServerSoftwareMatch} from './types';
import {PLUGIN_INSTALL,PLUGIN_REMOVE,type PluginReleaseSummary} from './plugin-catalog';
import type {MessageKey} from './i18n/translate';

/** How a target is detected: a Windows role or feature from the installed features, a product from the software inventory. */
export type DetectionKind='role'|'feature'|'software';
/** Where a target counts: only on a Windows Server, or on any device with a snapshot. */
export type DetectionDevices='server'|'any';
/** lucide-react icon names; the UI maps them to components. */
export type DetectionIcon='Network'|'Router'|'Globe'|'FolderTree'|'FolderSync'|'Printer'|'AppWindow'|'Boxes'|'MonitorCog'|'RefreshCcwDot'|'BadgeCheck'|'KeyRound'|'ShieldCheck'|'Waypoints'|'HardDriveDownload'|'Layers'
 |'Database'|'Mail'|'LayoutGrid'|'DatabaseBackup'|'ArchiveRestore'|'CloudCog';
type DetectionBase={id:string;label:MessageKey;icon:DetectionIcon;devices:DetectionDevices};
/** A Windows role or feature: one installed name is enough. */
export type FeatureDetection=DetectionBase&{kind:'role'|'feature';
 /** ServerManager UniqueNames (snapshot.features[].name), matched case-insensitively. */
 names:readonly string[]};
/** A known software product of the software inventory. */
export type SoftwareDetection=DetectionBase&{kind:'software';
 /** Lower-case prefixes of the normalized name for the SQL prefilter (LIKE 'prefix%'); together they cover every name the pattern matches. */
 prefixes:readonly string[];
 /** Tested on normalizeSoftwareName(name, version). */
 pattern:RegExp};
export type DetectionDefinition=FeatureDetection|SoftwareDetection;

const role=(id:string,label:MessageKey,icon:DetectionIcon,names:readonly string[]):FeatureDetection=>({id,label,icon,kind:'role',devices:'server',names});
const software=(id:string,label:MessageKey,icon:DetectionIcon,prefixes:readonly string[],pattern:RegExp):SoftwareDetection=>({id,label,icon,kind:'software',devices:'server',prefixes,pattern});

/**
 * Everything the portal detects, in display order: the Windows roles, then the
 * known server products. FileAndStorage-Services and Storage-Services are
 * installed on every Windows Server by default and are deliberately absent. A
 * product pattern matches the product entry itself, not its consoles, setup
 * programs, shared files or language packs ("Microsoft Exchange Server 2019
 * Language Pack" is no Exchange server).
 */
export const detectionCatalog:readonly DetectionDefinition[]=[
 role('ad-ds','serverRoles.role.adDs','Network',['AD-Domain-Services']),
 role('dhcp','serverRoles.role.dhcp','Router',['DHCP']),
 role('dns','serverRoles.role.dns','Globe',['DNS']),
 role('file-server','serverRoles.role.fileServer','FolderTree',['FS-FileServer']),
 role('dfs','serverRoles.role.dfs','FolderSync',['FS-DFS-Namespace','FS-DFS-Replication']),
 role('print','serverRoles.role.print','Printer',['Print-Services']),
 role('iis','serverRoles.role.iis','AppWindow',['Web-Server']),
 role('hyper-v','serverRoles.role.hyperV','Boxes',['Hyper-V']),
 role('rds','serverRoles.role.rds','MonitorCog',['Remote-Desktop-Services','RDS-RD-Server','RDS-Connection-Broker','RDS-Gateway','RDS-Licensing','RDS-Web-Access']),
 role('wsus','serverRoles.role.wsus','RefreshCcwDot',['UpdateServices']),
 role('ad-cs','serverRoles.role.adCs','BadgeCheck',['AD-Certificate']),
 role('ad-fs','serverRoles.role.adFs','KeyRound',['ADFS-Federation']),
 role('npas','serverRoles.role.npas','ShieldCheck',['NPAS']),
 role('remote-access','serverRoles.role.remoteAccess','Waypoints',['RemoteAccess']),
 role('wds','serverRoles.role.wds','HardDriveDownload',['WDS']),
 role('failover-clustering','serverRoles.role.failoverClustering','Layers',['Failover-Clustering']),
 software('sql-server','serverRoles.software.sqlServer','Database',['microsoft sql server 20','sql server 20'],
  /^(microsoft )?sql server (2008 r2|2008|2012|2014|2016|2017|2019|2022|2025)( database engine services)?$/),
 software('exchange','serverRoles.software.exchange','Mail',['microsoft exchange server '],
  /^microsoft exchange server (2010|2013|2016|2019|subscription edition)\b(?!.*\blanguage pack\b)/),
 software('sharepoint','serverRoles.software.sharepoint','LayoutGrid',['microsoft sharepoint server '],
  /^microsoft sharepoint server (2013|2016|2019|subscription edition)\b(?!.*\blanguage pack\b)/),
 software('veeam-br','serverRoles.software.veeamBr','DatabaseBackup',['veeam backup & replication'],/^veeam backup & replication$/),
 software('veeam-agent','serverRoles.software.veeamAgent','ArchiveRestore',['veeam agent for microsoft windows'],/^veeam agent for microsoft windows$/),
 software('entra-connect','serverRoles.software.entraConnect','CloudCog',['microsoft entra connect','microsoft azure ad connect'],
  /^(microsoft entra connect( sync)?|microsoft azure ad connect)$/),
];
const softwareCatalog=detectionCatalog.filter((entry):entry is SoftwareDetection=>entry.kind==='software');

/** An agent extension: its plugin name and the detection id it extends. */
export type ExtensionDefinition={name:string;target:string};
/** The extensions of this portal; every target is an id of detectionCatalog. */
export const extensionCatalog:readonly ExtensionDefinition[]=[{name:'dhcp',target:'dhcp'},{name:'dns',target:'dns'}];
/** The extension of a detection id, or undefined. */
export const extensionForTarget=(id:string):ExtensionDefinition|undefined=>extensionCatalog.find(entry=>entry.target===id);
/** The extension of a plugin name, or undefined. */
export const extensionByName=(name:string):ExtensionDefinition|undefined=>extensionCatalog.find(entry=>entry.name===name);

/** Every prefix of the software entries, for the one prefilter statement. */
export const detectionSoftwarePrefixes:readonly string[]=softwareCatalog.flatMap(entry=>entry.prefixes);
const positions=new Map(detectionCatalog.map((entry,index)=>[entry.id,index]));
/** The catalog entry of a detection id, or undefined for an unknown id. */
export const detectionEntry=(id:string):DetectionDefinition|undefined=>detectionCatalog[positions.get(id)??-1];
/** The position in the detection catalog; unknown ids last. */
export const detectionPosition=(id:string)=>positions.get(id)??detectionCatalog.length;
/** Every detection id, in catalog order. */
export const detectionIds:readonly string[]=detectionCatalog.map(entry=>entry.id);

/** True for a device whose reported OS is a Windows Server. */
export const isWindowsServer=(server:Pick<Server,'snapshot'>)=>/windows server/i.test(server.snapshot?.os??'');

/** Compares two normalized versions per dot segment, numerically; a missing segment counts as 0. */
export function compareNormalizedVersions(a:string,b:string):number{
 const left=a.split('.').map(Number),right=b.split('.').map(Number);
 for(let index=0;index<Math.max(left.length,right.length);index++){const diff=(left[index]??0)-(right[index]??0);if(diff)return diff<0?-1:1;}
 return 0;
}

const names=new Intl.Collator('en',{numeric:true,sensitivity:'base'});
/** The most program names one product entry lists. */
export const maxServerSoftwareNames=5;
export type ServerSoftwareRow={name:string;version:string|null;normalizedName:string;normalizedVersion:string|null};
/**
 * The known software products of one device's software rows: at most one
 * entry per product, in catalog order. version is the raw version of the
 * matched row with the highest normalized version (rows without one lose; null
 * when no row has one), names the distinct matched program names, sorted, at most 5.
 */
export function matchServerSoftware(items:readonly ServerSoftwareRow[]):ServerSoftwareMatch[]{
 const result:ServerSoftwareMatch[]=[];
 for(const entry of softwareCatalog){
  const matched=items.filter(item=>entry.pattern.test(item.normalizedName));
  if(!matched.length)continue;
  let best:ServerSoftwareRow|null=null;
  for(const item of matched)if(item.normalizedVersion!==null&&(best===null||compareNormalizedVersions(item.normalizedVersion,best.normalizedVersion!)>0))best=item;
  result.push({id:entry.id,version:best?.version??null,names:[...new Set(matched.map(item=>item.name))].sort(names.compare).slice(0,maxServerSoftwareNames)});
 }
 return result;
}

/** A detected target of one device. */
export type DetectedTarget={id:string;kind:DetectionKind;
 /** The name of the linked extension (extensionCatalog), or null for a target without one. */
 extension:string|null;
 /** The product version; null for roles and features (they are part of the OS) and for products without a reported version. */
 version:string|null;
 /** Roles and features: the display names of the installed matched features. Software: the matched program names. */
 sources:string[]};

/**
 * The detected targets of a device, in catalog order: a role or feature entry
 * with an installed matched feature, a software entry with a match in
 * device.serverSoftware (its version and names; unknown product ids are
 * dropped). An entry with devices 'server' counts only on a Windows Server, one
 * with 'any' on every device. A device without a snapshot gives [].
 */
export function detectTargets(device:Pick<Server,'snapshot'|'serverSoftware'>,catalog:readonly DetectionDefinition[]=detectionCatalog,extensions:readonly ExtensionDefinition[]=extensionCatalog):DetectedTarget[]{
 if(!device.snapshot)return [];
 const server=isWindowsServer(device);
 const installed=new Map<string,string>();
 for(const feature of device.snapshot.features??[])if(feature.installed===true){const key=String(feature.name).toLowerCase();if(!installed.has(key))installed.set(key,feature.displayName||feature.name);}
 const result:DetectedTarget[]=[];
 for(const entry of catalog){
  if(entry.devices==='server'&&!server)continue;
  const extension=extensions.find(item=>item.target===entry.id)?.name??null;
  if(entry.kind==='software'){
   const match=device.serverSoftware?.find(item=>item.id===entry.id);
   if(match)result.push({id:entry.id,kind:'software',extension,version:match.version??null,sources:[...match.names]});
   continue;
  }
  const sources=[...new Set(entry.names.flatMap(name=>{const shown=installed.get(name.toLowerCase());return shown===undefined?[]:[shown];}))];
  if(sources.length)result.push({id:entry.id,kind:entry.kind,extension,version:null,sources});
 }
 return result;
}

/**
 * How long after a succeeded install job the device waits for the agent to
 * report the plugin: the 15-minute report cache of agents before 4.21.1 plus
 * one heartbeat. Measured against the device's lastSeen, so an offline device
 * keeps waiting.
 */
export const PLUGIN_REPORT_GRACE_MS=16*60_000;

/** The job fields the extension state reads (lib/types.ts Job). */
export type ExtensionStateJob=Pick<Job,'serverId'|'action'|'target'|'state'|'createdAt'|'claimedAt'|'lastProgress'>;
const openJob=(job:Pick<Job,'state'>)=>job.state==='pending'||job.state==='running';
/** The plugin name of a plugin-install target ("<name> <version>") or plugin-remove target ("<name>"). */
const jobPlugin=(job:Pick<Job,'target'>)=>job.target.trim().split(/\s+/)[0]??'';
/**
 * The newest plugin-install job of this device for this plugin, or undefined.
 * Without server.id the jobs are taken as the device's own.
 */
export function newestPluginInstallJob<T extends ExtensionStateJob>(jobs:readonly T[],serverId:string|undefined,plugin:string):T|undefined{
 let newest:T|undefined;
 for(const job of jobs)if(job.action===PLUGIN_INSTALL&&(serverId===undefined||job.serverId===serverId)&&jobPlugin(job)===plugin&&(!newest||job.createdAt>newest.createdAt))newest=job;
 return newest;
}

/** Whether a plugin-remove job of this device for this plugin, created after `after`, succeeded. */
function removedAfter(jobs:readonly ExtensionStateJob[],serverId:string|undefined,plugin:string,after:number):boolean{
 return jobs.some(job=>job.action===PLUGIN_REMOVE&&job.state==='succeeded'&&(serverId===undefined||job.serverId===serverId)&&jobPlugin(job)===plugin&&job.createdAt>after);
}

/**
 * The extension state of a detected target, in this order: installed (the
 * snapshot reports the plugin ready, with its version); damaged (reported
 * damaged, with its AGENT_PLUGIN_* code, and no install job for it is open);
 * installing (the newest install job for it is pending or running; repair
 * when the plugin is reported damaged); reporting (that newest install job
 * succeeded, no newer remove job for the plugin succeeded, the snapshot does
 * not report the plugin ready at the job's version or later yet, and the
 * device was last seen less than PLUGIN_REPORT_GRACE_MS after the job
 * ended); then available (an active
 * release of the plugin exists), planned (an extension is linked but no release
 * is imported) or none (no extension). Pure: the device tab, the fleet tab and the tests use it.
 */
export type ExtensionState={state:'installed';version:string}|{state:'damaged';error:string|null;version:string}|{state:'installing';repair:boolean}|{state:'reporting';version:string}
 |{state:'available';release:PluginReleaseSummary}|{state:'planned'}|{state:'none'};
export function extensionState(entry:Pick<DetectedTarget,'extension'>,device:Pick<Server,'snapshot'>&{id?:string;lastSeen?:number|null},releases:readonly PluginReleaseSummary[]|undefined,jobs:readonly ExtensionStateJob[]=[]):ExtensionState{
 const name=entry.extension;
 if(!name)return {state:'none'};
 const reported=device.snapshot?.plugins?.find(plugin=>plugin.name===name);
 if(reported?.state==='ready')return {state:'installed',version:reported.version};
 const job=newestPluginInstallJob(jobs,device.id,name);
 if(job&&openJob(job))return {state:'installing',repair:reported?.state==='damaged'};
 if(reported?.state==='damaged')return {state:'damaged',error:reported.error??null,version:reported.version};
 if(job?.state==='succeeded'&&!removedAfter(jobs,device.id,name,job.createdAt)){
  const version=job.target.trim().split(/\s+/)[1]??'';
  const ended=job.lastProgress??job.claimedAt??job.createdAt,lastSeen=device.lastSeen;
  if(lastSeen===null||lastSeen===undefined||lastSeen-ended<PLUGIN_REPORT_GRACE_MS)return {state:'reporting',version};
 }
 const release=releases?.find(item=>item.name===name);
 return release?{state:'available',release}:{state:'planned'};
}

/** The plugin-install and plugin-remove jobs the console reloads after: their kinds and the open states. */
const pluginStateJob=(job:Pick<Job,'action'|'state'>)=>(job.action===PLUGIN_INSTALL||job.action===PLUGIN_REMOVE)&&openJob(job);
/** The ids of the pending or running plugin-install and plugin-remove jobs: of one device with serverId, else of every device. */
export const openPluginJobIds=(jobs:readonly Pick<Job,'id'|'serverId'|'action'|'state'>[],serverId?:string):ReadonlySet<string>=>
 new Set(jobs.filter(job=>(serverId===undefined||job.serverId===serverId)&&pluginStateJob(job)).map(job=>job.id));
/** True when a job that was open before is no longer open: the console then reloads once, so the new extension state arrives without waiting for the 30 s reload. */
export const pluginJobSettled=(before:ReadonlySet<string>,after:ReadonlySet<string>)=>[...before].some(id=>!after.has(id));

const kindOrder:Readonly<Record<DetectionKind,number>>={role:0,feature:1,software:2};
/** The device area order: kinds in the order role, feature, software; inside a kind, entries with an extension first, then catalog order. */
export function deviceTargetOrder(detected:readonly DetectedTarget[]):DetectedTarget[]{
 const rank=(entry:DetectedTarget)=>entry.extension?0:1;
 return [...detected].sort((a,b)=>kindOrder[a.kind]-kindOrder[b.kind]||rank(a)-rank(b)||detectionPosition(a.id)-detectionPosition(b.id));
}

export type FleetTargetRow={deviceId:string;deviceName:string;os:string;entry:DetectedTarget};
const deviceNames=new Intl.Collator('en',{numeric:true});
/** One row per (device, detected target), sorted by catalog position, then device name, then device id. */
export function fleetTargetRows(devices:readonly Pick<Server,'id'|'name'|'snapshot'|'serverSoftware'>[]):FleetTargetRow[]{
 return devices.flatMap(device=>detectTargets(device).map(entry=>({deviceId:device.id,deviceName:device.name,os:device.snapshot?.os??'',entry})))
  .sort((a,b)=>detectionPosition(a.entry.id)-detectionPosition(b.entry.id)||deviceNames.compare(a.deviceName,b.deviceName)||(a.deviceId<b.deviceId?-1:a.deviceId>b.deviceId?1:0));
}
/** The number of distinct devices per detection id. */
export function targetCounts(rows:readonly FleetTargetRow[]):Map<string,number>{
 const devices=new Map<string,Set<string>>();
 for(const row of rows){const set=devices.get(row.entry.id)??new Set<string>();set.add(row.deviceId);devices.set(row.entry.id,set);}
 return new Map([...devices].map(([id,set])=>[id,set.size]));
}
