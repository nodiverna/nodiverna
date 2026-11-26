// The portal's own record of a plugin install or removal (docs/agent-plugins.md, "Install and remove"). A
// succeeded plugin-install or plugin-remove job writes its result into the device's stored snapshot
// (lib/server/agent/agent-channel.ts), and for PLUGIN_RESULT_HOLD_MS after the job a heartbeat cannot undo that result
// (lib/server/agent/heartbeat.ts). The agent keeps the last entry of a busy plugin while the removal holds its gate, so a
// heartbeat whose broker status was taken during the removal still lists the plugin and can arrive after the
// job result. Pure: no database, so the channel, the heartbeat and the tests use it.
import {PLUGIN_INSTALL,PLUGIN_REMOVE,type PluginReport} from '../../plugin-catalog';

/**
 * How long after a succeeded plugin-install or plugin-remove job (from the job's end) the heartbeat keeps its
 * result: three heartbeat intervals (30 s) plus the 15 s broker status timeout. Long enough for one stale
 * report, short enough that a real report of the agent wins soon.
 */
export const PLUGIN_RESULT_HOLD_MS=90_000;
/** The most plugin entries a snapshot holds (lib/server/agent/telemetry.ts pluginReports). */
export const MAX_SNAPSHOT_PLUGINS=16;

/** Ordinal comparison of two plugin names (the names are lower-case ASCII). */
export const comparePluginNames=(left:string,right:string)=>left<right?-1:left>right?1:0;

/**
 * The snapshot entry of a succeeded plugin-install job (install, repair and rollout), from the job parameters
 * {name,version,manifest}: name, target (the manifest's target, else its role), version, capabilities, ready and
 * network-blocked (the install sets both block rules). Null when the parameters have no name or version, the
 * manifest does not parse, has no target or role, or no capabilities array of strings. The next report of the
 * agent replaces the entry.
 */
export function installedPluginEntry(params:unknown):PluginReport|null{
 if(!params||typeof params!=='object'||Array.isArray(params))return null;
 const {name,version,manifest}=params as {name?:unknown;version?:unknown;manifest?:unknown};
 if(typeof name!=='string'||!name||typeof version!=='string'||!version||typeof manifest!=='string')return null;
 let parsed:unknown;try{parsed=JSON.parse(manifest);}catch{return null;}
 if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return null;
 const {target,role,capabilities}=parsed as {target?:unknown;role?:unknown;capabilities?:unknown};
 const detection=typeof target==='string'&&target?target:typeof role==='string'&&role?role:null;
 if(detection===null||!Array.isArray(capabilities)||capabilities.some(entry=>typeof entry!=='string'))return null;
 return {name,target:detection,version,capabilities:[...capabilities] as string[],state:'ready',networkBlocked:true};
}

/** One plugin-install or plugin-remove job of a device as the heartbeat reads it. endedAt: COALESCE(last_progress,claimed_at,created_at). */
export type PluginJobRecord={action:string;state:string;target:string;createdAt:number;endedAt:number};
/** A result the heartbeat keeps: the plugin was removed, or installed at this version. */
export type HeldPluginResult={kind:'remove'}|{kind:'install';version:string};
/** The plugin name of a plugin-install target ("<name> <version>") or plugin-remove target ("<name>"). */
const targetWords=(target:string)=>target.trim().split(/\s+/);

/**
 * The results to keep at the heartbeat time, by plugin name: for each plugin whose newest plugin-install or
 * plugin-remove job (by createdAt, any state) succeeded and ended at most PLUGIN_RESULT_HOLD_MS before `time`.
 * A plugin whose newest job is open, failed or older gets none.
 */
export function heldPluginResults(jobs:readonly PluginJobRecord[],time:number):Map<string,HeldPluginResult>{
 const newest=new Map<string,PluginJobRecord>();
 for(const job of jobs){
  if(job.action!==PLUGIN_INSTALL&&job.action!==PLUGIN_REMOVE)continue;
  const plugin=targetWords(job.target)[0]??'';if(!plugin)continue;
  const current=newest.get(plugin);
  if(!current||job.createdAt>current.createdAt)newest.set(plugin,job);
 }
 const held=new Map<string,HeldPluginResult>();
 for(const [plugin,job] of newest){
  if(job.state!=='succeeded'||time-job.endedAt>PLUGIN_RESULT_HOLD_MS)continue;
  held.set(plugin,job.action===PLUGIN_REMOVE?{kind:'remove'}:{kind:'install',version:targetWords(job.target)[1]??''});
 }
 return held;
}

/**
 * The plugin list a heartbeat stores, from the incoming report, the stored snapshot's list and the device's
 * plugin jobs (heldPluginResults):
 * - removed: an incoming entry of that plugin is dropped;
 * - installed: without an incoming entry of that plugin, the stored entry at the job's version is kept (at its
 *   name position, while the list has fewer than MAX_SNAPSHOT_PLUGINS entries). An incoming entry, ready or
 *   damaged, always wins.
 * Returns `incoming` itself when nothing changes, so the caller stores the report unchanged.
 */
export function reconcilePluginReports<T extends {name:string;version:string}>(incoming:readonly T[]|undefined,stored:readonly T[]|undefined,jobs:readonly PluginJobRecord[],time:number):readonly T[]|undefined{
 let list=incoming;
 for(const [plugin,result] of heldPluginResults(jobs,time)){
  const reported=list?.some(entry=>entry.name===plugin)??false;
  if(result.kind==='remove'){if(reported)list=list!.filter(entry=>entry.name!==plugin);continue;}
  if(reported||(list?.length??0)>=MAX_SNAPSHOT_PLUGINS)continue;
  const kept=stored?.find(entry=>entry.name===plugin&&entry.version===result.version);
  if(!kept)continue;
  const next=[...(list??[])],at=next.findIndex(entry=>comparePluginNames(entry.name,plugin)>0);
  next.splice(at<0?next.length:at,0,kept);list=next;
 }
 return list;
}
