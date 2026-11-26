import {createPublicKey,verify} from 'node:crypto';
import {z} from 'zod';
import {HttpError,now} from '../context';
import publisher from '../../release-publisher.json';
import {changelogSchema,manifestSchema} from '../../../runtime/release-schema.mjs';
import {isReleaseDownloadPath,releaseFileEntries,releaseManifestForm} from '../../../runtime/release-manifest.mjs';
import {compareReleaseRank,isDevVersion} from '../../../runtime/release-version.mjs';
import {commitAll,db,jsonText,sql} from '../db';
import type {SqlGuard} from '../identity/access';
// The catalog of agent releases. The import (runtime/release-import.mjs) is
// the only writer of agent_releases: it writes the release row and its file
// rows in one transaction. The catalog lists a row only when the portal serves
// every file of its manifest (agent_release_files), so each listed release can
// be installed and deployed from this portal. A dev build (X.Y.Z-dev.<sha7>,
// runtime/release-version.mjs) is listed with dev true but never becomes the
// latest release: new installations, the bootstrap and the EXE download never
// use one.
// Generated alongside the native Agent's embedded release-public.pem. No
// runtime configuration can replace this trust pin.
export const releasePublicKey:string=publisher.publicKey;
// The manifest schema is shared with the import (runtime/release-schema.mjs).
export {manifestSchema};
export type ReleaseManifest=z.infer<typeof manifestSchema>;
export type Release={id:string;version:string;manifest:string;signature:string;sha256:string;size:number;createdAt:number};
/** dev: a dev pre-release X.Y.Z-dev.<sha7>; it is never latest. */
export type ReleaseSummary=Release&{active:boolean;latest:boolean;dev:boolean;changelog:z.infer<typeof changelogSchema>|null};
/** The signed envelope of one release: the path form, valid on every origin. */
export type ReleaseEnvelopes={path:Release};
type FileRow={release_id:string;path:string;size:number|string;sha256:string};
/** The path below /downloads/ of a file entry of a verified manifest. */
export function releaseFilePath(file:{path?:string}):string{return String(file.path);}
function releaseManifest(manifest:string){
 if(typeof manifest!=='string'||manifest.length>8192)throw new HttpError('apiError.release.invalid');
 let raw:unknown,parsed;try{raw=JSON.parse(manifest);parsed=manifestSchema.safeParse(raw);}catch{throw new HttpError('apiError.release.invalidManifest');}
 if(!parsed.success)throw new HttpError('apiError.release.invalidReleaseManifest');
 // Only the path form: entries with both keys, with none, with a URL or of both forms are invalid.
 let form:'path'|'url';try{form=releaseManifestForm(raw);}catch{throw new HttpError('apiError.release.invalidReleaseManifest');}
 if(form!=='path')throw new HttpError('apiError.release.invalidReleaseManifest');
 if(releaseFileEntries(parsed.data).some(file=>!isReleaseDownloadPath(file.path)))throw new HttpError('apiError.release.downloadPath');
 if(Number(parsed.data.version.split('.')[0])>=4&&(parsed.data.layout!=='single-exe'||!parsed.data.exe))throw new HttpError('apiError.release.nativeNeedsSignedExe');
 if(parsed.data.exe?.parts&&parsed.data.exe.parts.reduce((n,p)=>n+p.size,0)!==parsed.data.exe.size)throw new HttpError('apiError.release.exePartsSize');
 return parsed.data;
}
/** A path-form manifest signed by the pinned publisher; the same bytes verify on every origin. */
export function verifiedRelease(manifest:string,signature:string){const parsed=releaseManifest(manifest);if(typeof signature!=='string'||!signature||signature.length>256||Buffer.from(signature,'base64').toString('base64')!==signature)throw new HttpError('apiError.release.invalid');if(!verify('sha256',Buffer.from(manifest),createPublicKey(releasePublicKey),Buffer.from(signature,'base64')))throw new HttpError('apiError.release.signatureInvalid');return parsed;}
function assertReleaseMetadata(fixed:Omit<Release,'signature'>,manifest:ReleaseManifest){if(fixed.version!==manifest.version||fixed.sha256!==manifest.sha256||fixed.size!==manifest.size||manifest.parts&&manifest.parts.reduce((size,part)=>size+part.size,0)!==manifest.size)throw new HttpError('apiError.release.metadataMismatch');}
/** Whether every file of the manifest has a file row of this release with its size and SHA-256. */
function served(manifest:ReleaseManifest,files:FileRow[]){
 return releaseFileEntries(manifest).every(entry=>files.some(file=>file.path===entry.path&&Number(file.size)===entry.size&&file.sha256===entry.sha256));
}
/** The verified manifest of a stored row, or null when the catalog does not list it. */
function listable(release:Release,files:FileRow[]):ReleaseManifest|null{
 try{const manifest=verifiedRelease(release.manifest,release.signature);assertReleaseMetadata(release,manifest);return served(manifest,files)?manifest:null;}catch{return null;}
}
const releaseColumns=sql`r.id,r.version,r.manifest,r.signature,r.sha256,r.size,r.created_at AS "createdAt"`;
const toRelease=(row:Release):Release=>({...row,size:Number(row.size),createdAt:Number(row.createdAt)});
async function fileRows(ids:string[]){
 if(!ids.length)return new Map<string,FileRow[]>();
 const rows=await db().query<FileRow>(sql`SELECT release_id,path,size,sha256 FROM agent_release_files WHERE release_id IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))`);
 const byRelease=new Map<string,FileRow[]>();for(const row of rows)byRelease.set(row.release_id,[...byRelease.get(row.release_id)??[],row]);
 return byRelease;
}
/** By rank (a release above a dev build of its base), then the newest first. */
function newest(left:Release,right:Release){return (compareReleaseRank(right.version,left.version)??0)||right.createdAt-left.createdAt||left.id.localeCompare(right.id);}
/**
 * The catalog: the stored releases that are not deleted, whose signature
 * verifies and whose files are all served, the highest rank first. The latest
 * release is the active one with the highest rank that is not a dev build
 * (ties: the newest).
 */
export async function releases():Promise<ReleaseSummary[]>{
 const rows=(await db().query<Release>(sql`SELECT ${releaseColumns} FROM agent_releases r WHERE NOT EXISTS (SELECT 1 FROM agent_release_states s WHERE s.release_id=r.id AND s.state='deleted') ORDER BY r.created_at DESC LIMIT 100`)).map(toRelease);
 const files=await fileRows(rows.map(row=>row.id));
 const disabled=new Set((await db().query<{release_id:string}>(sql`SELECT release_id FROM agent_release_states WHERE state='disabled'`)).map(row=>row.release_id));
 const catalog=rows.flatMap(release=>{const manifest=listable(release,files.get(release.id)??[]);return manifest?[{...release,active:!disabled.has(release.id),latest:false,dev:isDevVersion(release.version),changelog:manifest.changelog??null}]:[];}).sort(newest);
 const latest=catalog.find(release=>release.active&&!release.dev);if(latest)latest.latest=true;return catalog;
}
/** The latest release of the catalog (never a dev build), or null when there is none. */
export async function latestRelease():Promise<Release|null>{
 const latest=(await releases()).find(release=>release.latest);if(!latest)return null;
 return {id:latest.id,version:latest.version,manifest:latest.manifest,signature:latest.signature,sha256:latest.sha256,size:latest.size,createdAt:latest.createdAt};
}
/** How long GET /Agent-v3-release.json serves the latest release from this process's cache. */
export const bootstrapReleaseTtlMs=30_000;
let bootstrapRelease:{at:number;value:Promise<Release|null>}|null=null;
/**
 * The latest release for the unauthenticated GET /Agent-v3-release.json only:
 * at most one catalog read (releases(), a signature check per row) per process
 * every 30 s. Concurrent requests share the read in flight. No release (null)
 * is cached too; a failed read is not, so the next request reads again. A new
 * import shows within the TTL. latestRelease() and its other callers stay
 * uncached.
 */
export function bootstrapLatestRelease():Promise<Release|null>{
 const time=now();
 if(bootstrapRelease&&time>=bootstrapRelease.at&&time-bootstrapRelease.at<bootstrapReleaseTtlMs)return bootstrapRelease.value;
 const entry={at:time,value:latestRelease()};
 bootstrapRelease=entry;
 entry.value.catch(()=>{if(bootstrapRelease===entry)bootstrapRelease=null;});
 return entry.value;
}
/**
 * One release with its signed envelope, for the deploy. A release that the
 * catalog does not list is not found; a disabled one is gone.
 */
export async function releaseEnvelopes(id:string):Promise<ReleaseEnvelopes&{release:Release}>{
 const state=await db().one<{state:string}>(sql`SELECT state FROM agent_release_states WHERE release_id=${id}`);
 if(state?.state==='deleted')throw new HttpError('apiError.release.notFound');
 // Campaign identities remain resolvable after they leave the newest-100 list.
 const stored=await db().one<Release>(sql`SELECT ${releaseColumns} FROM agent_releases r WHERE r.id=${id}`);
 const release=stored?toRelease(stored):null;
 if(!release||!listable(release,(await fileRows([id])).get(id)??[]))throw new HttpError('apiError.release.notFound');
 if(state)throw new HttpError('apiError.release.disabled');
 return {release,path:release};
}
export async function releaseById(id:string):Promise<Release>{return (await releaseEnvelopes(id)).release;}
/** Keep a tombstone so a deleted release never reappears. */
export async function retireRelease(id:string,action:'disable'|'delete',actor:string,authorization:SqlGuard){
 const catalog=await releases(),release=catalog.find(item=>item.id===id);if(!release)throw new HttpError('apiError.release.notFound');
 if(release.latest)throw new HttpError('apiError.release.latestStays');
 const time=now(),state=action==='delete'?'deleted':'disabled';
 const unused=action==='delete'?sql`AND NOT EXISTS (SELECT 1 FROM jobs WHERE action='agent-update' AND state IN ('pending','running') AND ${jsonText(sql`parameters`,'releaseId')}=${id})`:sql``;
 const changed=await commitAll([
  sql`INSERT INTO agent_release_states (release_id,state,updated_at,updated_by) SELECT ${id},${state},${time},${actor} WHERE ${authorization} ${unused} ON CONFLICT(release_id) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at,updated_by=excluded.updated_by WHERE agent_release_states.state<>'deleted' AND ${authorization} ${unused}`,
  // A planned update must not begin after deactivation. Already dispatched
  // updates retain their exact signed envelope and finish safely.
  sql`UPDATE jobs SET state='cancelled',parameters='{}',result='serverMessage.release.disabled',last_progress=${time} WHERE action='agent-update' AND state='pending' AND ${jsonText(sql`parameters`,'releaseId')}=${id} AND EXISTS (SELECT 1 FROM agent_release_states WHERE release_id=${id} AND state='disabled' AND updated_at=${time} AND updated_by=${actor}) AND ${authorization}`,
 ]);
 if(!changed[0].rowCount)throw new HttpError('apiError.release.inUse');
 return {release,cancelledJobs:changed[1].rowCount};
}
