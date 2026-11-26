import {createPublicKey,verify} from 'node:crypto';
import {HttpError} from '../context';
import publisher from '../../release-publisher.json';
import {pluginManifestSchema} from '../../../runtime/release-schema.mjs';
import {agentMeetsMinimum,comparePluginVersions,type PluginReleaseSummary} from '../../plugin-catalog';
import {isDevVersion} from '../../../runtime/release-version.mjs';
import {db,sql} from '../db';

// The imported plugin releases (runtime/release-import.mjs, docs/agent-plugins.md).
// Every use checks the stored manifest bytes against the pinned publisher key
// again, the same key that signs agent releases (lib/release-publisher.json), so
// a changed database row never reaches an agent or the console as a release.
// A dev build (X.Y.Z-dev.<sha7>) is listed with dev true for the rollout of an
// Owner; it is never the newest release of a name and never installed by an
// install or a repair.

/**
 * A verified plugin manifest. target is normalized (the manifest's target, else its role for a role-only manifest);
 * role stays as signed, because deployed agents require it. The stored bytes are never rewritten.
 */
export type PluginManifest={kind:'plugin';name:string;target:string;role:string;version:string;minAgentVersion:string;protocolVersion:1;os:string[];arch:'x64';
 capabilities:string[];exe:{path:string;sha256:string;size:number;parts?:{path:string;sha256:string;size:number}[]};changelog:{features:string[];fixes:string[]};createdAt:string};
export type {PluginReleaseSummary};
/** dev: a dev pre-release X.Y.Z-dev.<sha7>. */
export type PluginReleaseEntry=PluginReleaseSummary&{active:boolean;dev:boolean};
/** A stored release with its signed bytes, for a job (lib/server/extensions/plugins.ts). */
export type StoredPluginRelease=PluginReleaseSummary&{active:boolean;manifest:string;signature:string};

// Read at use, not at module load, like every check of this module.
const releasePublicKey=()=>publisher.publicKey;
/**
 * The parsed manifest when the signature over the exact bytes checks against
 * the pinned publisher key and the manifest passes the schema; otherwise 400
 * apiError.plugin.releaseInvalid.
 */
export function verifiedPluginRelease(manifest:string,signature:string):PluginManifest{
 const invalid=()=>new HttpError('apiError.plugin.releaseInvalid');
 if(typeof manifest!=='string'||Buffer.byteLength(manifest,'utf8')>8192||typeof signature!=='string'||!signature||signature.length>256||Buffer.from(signature,'base64').toString('base64')!==signature)throw invalid();
 let valid=false;try{valid=verify('sha256',Buffer.from(manifest,'utf8'),createPublicKey(releasePublicKey()),Buffer.from(signature,'base64'));}catch{valid=false;}
 if(!valid)throw invalid();
 let parsed:unknown;try{parsed=JSON.parse(manifest);}catch{throw invalid();}
 const result=pluginManifestSchema.safeParse(parsed);if(!result.success)throw invalid();
 const data=result.data as Omit<PluginManifest,'target'>&{target?:string};
 return {...data,target:data.target??data.role};
}

type Row={id:string;name:string;version:string;manifest:string;signature:string;created_at:number;state:string};
/** The verified rows; a row whose bytes do not verify is left out. */
async function storedReleases(name?:string):Promise<StoredPluginRelease[]>{
 const rows=await db().query<Row>(sql`SELECT id,name,version,manifest,signature,created_at,state FROM plugin_releases ${name===undefined?sql``:sql`WHERE name=${name}`}`);
 return rows.flatMap(row=>{
  try{
   const manifest=verifiedPluginRelease(row.manifest,row.signature);
   if(manifest.name!==row.name||manifest.version!==row.version)return [];
   return [{id:row.id,name:manifest.name,target:manifest.target,version:manifest.version,minAgentVersion:manifest.minAgentVersion,capabilities:[...manifest.capabilities],changelog:manifest.changelog,createdAt:Number(row.created_at),active:row.state==='active',manifest:row.manifest,signature:row.signature}];
  }catch{return [];}
 }).sort((a,b)=>a.name.localeCompare(b.name)||(comparePluginVersions(b.version,a.version)??0)||b.createdAt-a.createdAt);
}
const summary=({id,name,target,version,minAgentVersion,capabilities,changelog,createdAt}:StoredPluginRelease):PluginReleaseSummary=>({id,name,target,version,minAgentVersion,capabilities,changelog,createdAt});

/** Every imported plugin release, by name, the highest rank first per name (ties: the newest). */
export async function pluginReleases():Promise<PluginReleaseEntry[]>{
 return (await storedReleases()).map(release=>({...summary(release),active:release.active,dev:isDevVersion(release.version)}));
}
/** The newest active release of each plugin name that is not a dev build. */
export async function latestPluginReleases():Promise<PluginReleaseSummary[]>{
 const seen=new Set<string>();
 return (await storedReleases()).filter(release=>release.active&&!isDevVersion(release.version)&&!seen.has(release.name)&&!!seen.add(release.name)).map(summary);
}
/** One stored release by id with its signed bytes, or null. */
export async function storedPluginRelease(id:string):Promise<StoredPluginRelease|null>{
 return (await storedReleases()).find(release=>release.id===id)??null;
}
/**
 * The release an install of `name` takes on an agent of `agentVersion`: the
 * newest active release that is not a dev build and whose minimum agent version
 * the agent meets (a dev agent by its base). Without any such active release:
 * missing. With releases that all need a newer agent: tooOld with the lowest
 * minimum agent version among them.
 */
export async function installablePluginRelease(name:string,agentVersion:string):Promise<{release:StoredPluginRelease}|{missing:true}|{tooOld:string}>{
 const active=(await storedReleases(name)).filter(release=>release.active&&!isDevVersion(release.version));
 if(!active.length)return {missing:true};
 const release=active.find(item=>agentMeetsMinimum(agentVersion,item.minAgentVersion));
 if(release)return {release};
 return {tooOld:[...active].sort((a,b)=>comparePluginVersions(a.minAgentVersion,b.minAgentVersion)??0)[0].minAgentVersion};
}
