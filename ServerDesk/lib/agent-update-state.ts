import type {Job,Server} from './types';
import {isReleaseDownloadPath,releaseFileEntries,releaseManifestForm} from '../runtime/release-manifest.mjs';
import {baseVersion,compareReleaseRank,isDevVersion} from '../runtime/release-version.mjs';
export type DeviceRelease={id:string;version:string;manifest:Record<string,unknown>|string;signature:string;sha256:string;size:number;createdAt:number;active?:boolean;latest?:boolean;dev?:boolean;changelog?:{features:string[];fixes:string[]}|null};
export type DeviceUpdateCampaign={id:string;serverId:string;version:string;state:string;result?:string|null;notBefore?:number|null;createdAt?:number};
export type UpdateReceipt={jobId:string;version:string;createdAt:number};
export type DeviceUpdateState={phase:'scheduled'|'queued'|'installing'|'waiting'|'verified'|'failed';version:string;message?:string|null;notBefore?:number|null};
/**
 * The base X.Y.Z of an agent version as numbers: X.Y.Z or a dev build
 * X.Y.Z-dev.<sha7> (runtime/release-version.mjs); null for any other value.
 */
export function agentVersion(value:unknown):[number,number,number]|null{
 const base=baseVersion(value);if(base===null)return null;
 const parts=base.split('.').map(Number);return parts.every(Number.isSafeInteger)?parts as [number,number,number]:null;
}
/**
 * The rank order of two agent versions (runtime/release-version.mjs): the base
 * first, then a release above a dev build of its base. Two dev builds of the
 * same base have rank 0 although they differ; compare the strings for identity.
 */
export function compareAgentVersions(left:string,right:string):number|null{return compareReleaseRank(left,right);}
/** The base X.Y.Z of an agent version for a version-gated view: a dev agent counts as its base. */
export function agentBaseVersion(value:unknown):string{return baseVersion(value)??'';}
export {isDevVersion};
/** The capability of agents (4.12.0 and later) that verify path-form release manifests. */
export const releasePathsCapability='release-paths';
function manifestOf(release:DeviceRelease):Record<string,unknown>|null{try{if(typeof release.manifest==='string'&&release.manifest.length>8192)return null;const manifest=typeof release.manifest==='string'?JSON.parse(release.manifest):release.manifest;return manifest&&typeof manifest==='object'&&!Array.isArray(manifest)?manifest:null;}catch{return null;}}
function manifestForm(manifest:Record<string,unknown>):'path'|'url'|null{try{return releaseManifestForm(manifest);}catch{return null;}}
/** The catalog has only the path form: every file path is valid. */
function usableFiles(manifest:Record<string,unknown>){
 if(manifestForm(manifest)!=='path')return false;
 return releaseFileEntries(manifest).every(file=>isReleaseDownloadPath(file.path));
}
export function usableDeviceRelease(release:DeviceRelease){
 if(!release||release.active===false||typeof release.id!=='string'||!release.id||!agentVersion(release.version)||typeof release.signature!=='string'||!release.signature||release.signature.length>256||!Number.isSafeInteger(release.size)||release.size<=0||release.size>104857600||!/^[a-f0-9]{64}$/.test(release.sha256))return false;
 const manifest=manifestOf(release);
 if(!manifest||manifest.version!==release.version||manifest.sha256!==release.sha256||manifest.size!==release.size||manifest.protocolVersion!==3||manifest.minProtocolVersion!==3||manifest.arch!=='x64'||!Array.isArray(manifest.os)||!manifest.os.length)return false;
 if(!usableFiles(manifest))return false;
 if(agentVersion(release.version)![0]>=4){const exe=manifest.exe as Record<string,unknown>|undefined;if(manifest.layout!=='single-exe'||!exe||typeof exe.sha256!=='string'||!/^[a-f0-9]{64}$/.test(exe.sha256)||!Number.isSafeInteger(exe.size)||Number(exe.size)<=0||Number(exe.size)>250000000)return false;}
 return true;
}
/**
 * Whether the deploy can give a release to a device: only agents that report
 * release-paths (4.12.0 and later) verify the path form. Any other device is
 * not updatable from the portal and needs one local installation.
 */
export function deliverableDeviceRelease(capabilities?:readonly string[]|null){
 return capabilities?.includes(releasePathsCapability)===true;
}
/**
 * Whether a release is newer than the installed version: a higher rank, or,
 * for a dev build of the same base as an installed dev build with another
 * commit, a newer catalog entry than the one of the installed version (or the
 * catalog has no entry of the installed version).
 */
function newerThanInstalled(release:DeviceRelease,installed:string,releases:readonly DeviceRelease[]){
 const rank=compareAgentVersions(release.version,installed);
 if(rank===1)return true;
 if(rank!==0||release.version===installed||!isDevVersion(release.version)||!isDevVersion(installed))return false;
 const current=releases.find(item=>item.version===installed);
 return !current||release.createdAt>current.createdAt;
}
/**
 * The update and the migration a device is offered. Dev builds only with
 * devBuilds (Import dev builds is on); without the option none is offered.
 */
export function latestDeviceReleases(installed:string|undefined,releases:DeviceRelease[],capabilities?:readonly string[]|null,{devBuilds=false}:{devBuilds?:boolean}={}){
 const current=agentVersion(installed);if(!current)return {update:null,migration:null} as {update:DeviceRelease|null;migration:DeviceRelease|null};
 const newer=releases.filter(release=>usableDeviceRelease(release)&&deliverableDeviceRelease(capabilities)&&(devBuilds||!isDevVersion(release.version))&&newerThanInstalled(release,installed!,releases)).sort((a,b)=>(compareAgentVersions(b.version,a.version)??0)||(b.createdAt-a.createdAt)||a.id.localeCompare(b.id));
 const migration=current[0]<4?newer.find(release=>agentVersion(release.version)![0]>=4)??null:null;
 const update=newer.find(release=>current[0]>=4?agentVersion(release.version)![0]>=4:current[0]===3&&agentVersion(release.version)![0]===3)??null;
 return {update,migration};
}
/** One entry of lib/agent-changelog-history.json, as GET /api/releases answers it in history. */
export type AgentChangelogEntry={version:string;features:string[];fixes:string[]};
/** The changes of one agent version; published is false when no source has its notes. */
export type AgentChange=AgentChangelogEntry&{published:boolean};
const textList=(value:unknown):value is string[]=>Array.isArray(value)&&value.every(entry=>typeof entry==='string');
/** The history of the answer: anything that is not a list, and any entry that is not a changelog, counts as missing. */
export function agentChangelogHistoryOf(value:unknown):AgentChangelogEntry[]{
 if(!Array.isArray(value))return [];
 return value.flatMap(entry=>{
  const {version,features,fixes}=(entry&&typeof entry==='object'?entry:{}) as Partial<Record<keyof AgentChangelogEntry,unknown>>;
  return typeof version==='string'&&agentVersion(version)&&textList(features)&&textList(fixes)?[{version,features,fixes}]:[];
 });
}
/**
 * The changes an update from installed to target brings: every version above
 * installed up to the target, newest first. A signed catalog changelog wins over
 * the bundled history. A version that only a catalog release without notes
 * knows appears with published false; the target always appears first. Versions
 * that no source knows are missing. An invalid installed version gives only the target.
 */
export function agentChangesBetween(installed:string|undefined|null,target:DeviceRelease,releases:readonly DeviceRelease[],history:unknown):AgentChange[]{
 const entries=agentChangelogHistoryOf(history),known=new Map<string,AgentChange>();
 const signed=(release:DeviceRelease)=>release.changelog&&textList(release.changelog.features)&&textList(release.changelog.fixes)?release.changelog:null;
 for(const release of [target,...releases]){
  if(!agentVersion(release?.version))continue;
  const changelog=signed(release),existing=known.get(release.version);
  if(changelog&&!existing?.published)known.set(release.version,{version:release.version,features:changelog.features,fixes:changelog.fixes,published:true});
  else if(!existing)known.set(release.version,{version:release.version,features:[],fixes:[],published:false});
 }
 for(const entry of entries)if(!known.get(entry.version)?.published)known.set(entry.version,{...entry,published:true});
 const first=known.get(target.version)??{version:target.version,features:[],fixes:[],published:false};
 if(!agentVersion(installed??undefined))return [first];
 const between=[...known.values()].filter(change=>compareAgentVersions(change.version,installed!)===1&&compareAgentVersions(change.version,target.version)===-1).sort((a,b)=>compareAgentVersions(b.version,a.version)??0);
 return [first,...between];
}
const activeStates=new Set(['pending','queued','scheduled','running','updating']);
export function deviceUpdateState(server:Server,jobs:Job[],campaigns:DeviceUpdateCampaign[],receipt:UpdateReceipt|null,now:number):DeviceUpdateState|null{
 const installed=server.snapshot?.agentVersion;
 const rows=[...campaigns.filter(item=>item.serverId===server.id).map(item=>({id:item.id,version:item.version,state:item.state,result:item.result,notBefore:item.notBefore,createdAt:item.createdAt??0})),...jobs.filter(item=>item.serverId===server.id&&item.action==='agent-update').map(item=>({id:item.id,version:item.target,state:item.state,result:item.result,notBefore:item.notBefore,createdAt:item.createdAt}))];
 const merged=new Map<string,typeof rows[number]>();
 const rank=(state:string)=>activeStates.has(state)?['running','updating'].includes(state)?1:0:2;
 for(const row of rows){const existing=merged.get(row.id);if(!existing||rank(row.state)>rank(existing.state))merged.set(row.id,row);}
 const currentRows=[...merged.values()];
 const active=currentRows.filter(row=>activeStates.has(row.state)).sort((a,b)=>b.createdAt-a.createdAt)[0];
 if(active)return {phase:['running','updating'].includes(active.state)?'installing':active.notBefore&&active.notBefore>now?'scheduled':'queued',version:active.version,notBefore:active.notBefore,message:active.result};
 if(server.maintenance&&['scheduled','queued','updating'].includes(server.maintenance.state))return {phase:server.maintenance.state==='updating'?'installing':server.maintenance.state==='scheduled'?'scheduled':'queued',version:server.maintenance.version,notBefore:server.maintenance.notBefore};
 // Verified only when the installed version is the receipt version or ranks above it (another dev build of the same base is not).
 if(receipt&&installed&&(installed===receipt.version||compareAgentVersions(installed,receipt.version)===1))return {phase:'verified',version:installed};
 const latest=receipt?currentRows.find(row=>row.id===receipt.jobId):currentRows.sort((a,b)=>b.createdAt-a.createdAt).find(row=>now-row.createdAt<86400000&&installed&&row.version!==installed&&(compareAgentVersions(row.version,installed)??-1)>=0);
 if(latest){if(['failed','cancelled','expired','unknown','interrupted'].includes(latest.state))return {phase:'failed',version:latest.version,message:latest.result};if(latest.state==='succeeded')return {phase:'waiting',version:latest.version,message:latest.result};}
 return receipt?{phase:'queued',version:receipt.version}:null;
}
