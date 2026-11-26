// The release source of Settings → Agent releases (docs/self-hosting.md, "Agent
// releases from GitHub"): the Owner view, Check now, the scheduler entry for a
// requested check and the download of imported files. The check itself lives
// in runtime/release-import.mjs, shared with the maintenance and
// scripts/selfhost.mjs import-release; it reads the public repository without
// sign-in. Only global Owners see the source, ask for a check or turn on
// Import dev builds (dev pre-releases agent-vX.Y.Z-dev.<sha7>: the check imports
// them and device updates offer them; the latest release never is one).
import {releaseSourceAuditActions} from '../../audit-actions';
import {env} from 'cloudflare:workers';
import {HttpError,now} from '../context';
import {auditEvent,auditAfterChange} from '../audit';
import {can,viewerCanSql} from '../identity/policy/can';
import {commitAll,db,sql} from '../db';
import type {Viewer} from '../../types';
import {releaseImportFailures,releaseRepository,runReleaseCheck,streamReleaseFile} from '../../../runtime/release-import.mjs';

export const releaseSourceAuditTarget='Agent releases';
export {releaseSourceAuditActions};
/** The view lists at most this many import rows, the newest first. */
export const releaseSourceImportLimit=30;

export type ReleaseImportFailure=(typeof releaseImportFailures)[number];
export type ReleaseImportErrorKey=`serverMessage.releaseImport.${ReleaseImportFailure}`;
export type ReleaseSourceState='idle'|'queued'|'running'|'failed';
/** kind plugin: a plugin release (tag plugin-<name>-vX.Y.Z, docs/agent-plugins.md). */
export type ReleaseImportRow={tag:string;version:string;source:'github'|'folder';status:'imported'|'present'|'failed';reason:ReleaseImportErrorKey|null;releaseId:string|null;attemptedAt:number;kind:'agent'|'plugin'};
export type ReleaseSourceView={
 repository:typeof releaseRepository;state:ReleaseSourceState;lastStartedAt:number|null;lastFinishedAt:number|null;lastError:ReleaseImportErrorKey|null;
 /** Import dev builds: the check also imports dev pre-releases, and device updates offer them. */
 devBuilds:boolean;
 imports:ReleaseImportRow[];
};

type SourceRow={lease_until:number|null;requested_at:number|null;last_started_at:number|null;last_finished_at:number|null;last_status:'ok'|'failed'|null;last_error:string|null;dev_builds:boolean};
type ImportRow={tag:string;version:string;source:'github'|'folder';status:'imported'|'present'|'failed';reason:string|null;release_id:string|null;attempted_at:number;kind:string};
const num=(value:unknown)=>value===null||value===undefined?null:Number(value);
const failureKeys=new Set<string>(releaseImportFailures.map(reason=>`serverMessage.releaseImport.${reason}`));
const isFailureKey=(value:string|null):value is ReleaseImportErrorKey=>!!value&&failureKeys.has(value);
/**
 * The key of a stored reason: agent_release_imports.reason holds the bare
 * reason (rateLimited), agent_release_source.last_error the key. An unknown
 * value gives null (the view shows "—").
 */
export function releaseImportReasonKey(value:string|null):ReleaseImportErrorKey|null{
 if(value===null)return null;
 if(isFailureKey(value))return value;
 const key=`serverMessage.releaseImport.${value}`;
 return isFailureKey(key)?key:null;
}
const ownerOnly=()=>new HttpError('apiError.releaseSource.ownerOnly');
// The re-check after a refused commit asks the database again (fresh): a demoted Owner gets 403, not a conflict.
async function requireOwner(viewer:Viewer,fresh=false){if(!await can(viewer,'instance.owner',{fresh}))throw ownerOnly();}
/** 403 apiError.releaseSource.ownerOnly unless the viewer is a global Owner. */
export const requireReleaseSourceOwner=(viewer:Viewer)=>requireOwner(viewer);

/** The state on the page: running under a live lease, queued after a request newer than the last start. */
export function releaseSourceState(row:Pick<SourceRow,'lease_until'|'requested_at'|'last_started_at'|'last_status'>,time:number):ReleaseSourceState{
 if(num(row.lease_until)!==null&&Number(row.lease_until)>time)return 'running';
 const requested=num(row.requested_at),started=num(row.last_started_at);
 if(requested!==null&&(started===null||requested>started))return 'queued';
 return row.last_status==='failed'?'failed':'idle';
}

/** The release source for an Owner. */
export async function releaseSourceView():Promise<ReleaseSourceView>{
 const [row,imports]=await Promise.all([
  db().one<SourceRow>(sql`SELECT lease_until,requested_at,last_started_at,last_finished_at,last_status,last_error,dev_builds FROM agent_release_source WHERE id=1`),
  db().query<ImportRow>(sql`SELECT tag,version,source,status,reason,release_id,attempted_at,kind FROM agent_release_imports ORDER BY attempted_at DESC,tag DESC LIMIT ${releaseSourceImportLimit}`),
 ]);
 if(!row)throw new Error('agent_release_source is missing');
 return {
  repository:releaseRepository,state:releaseSourceState(row,now()),lastStartedAt:num(row.last_started_at),lastFinishedAt:num(row.last_finished_at),lastError:isFailureKey(row.last_error)?row.last_error:null,devBuilds:row.dev_builds===true,
  imports:imports.map(item=>({tag:item.tag,version:item.version,source:item.source,status:item.status,reason:releaseImportReasonKey(item.reason),releaseId:item.release_id,attemptedAt:Number(item.attempted_at),kind:item.kind==='plugin'?'plugin':'agent'})),
 };
}

/**
 * Check now: asks for a check within about one minute, guarded by the live
 * Owner right in the same statement, with its audit row in the same commit.
 * Nothing changes while one is queued or running. A write of zero rows asks
 * the database again: a demoted Owner gets 403, a busy check the unchanged view.
 */
export async function requestReleaseCheck(viewer:Viewer):Promise<ReleaseSourceView>{
 await requireOwner(viewer);
 const time=now();
 const [update]=await commitAll([
  sql`UPDATE agent_release_source SET requested_at=${time} WHERE id=1
   AND (requested_at IS NULL OR (last_started_at IS NOT NULL AND requested_at<=last_started_at)) AND (lease_until IS NULL OR lease_until<=${time})
   AND (${viewerCanSql(viewer,'instance.owner')})`,
  ...auditEvent({actor:viewer.label,action:releaseSourceAuditActions.checkRequested,target:releaseSourceAuditTarget,guard:auditAfterChange,at:time}),
 ]);
 if(update.rowCount===0)await requireOwner(viewer,true);
 return releaseSourceView();
}

/** Whether an Owner turned on Import dev builds; every release viewer may know it (GET /api/releases). */
export async function devBuildsEnabled():Promise<boolean>{
 const row=await db().one<{dev_builds:boolean}>(sql`SELECT dev_builds FROM agent_release_source WHERE id=1`);
 return row?.dev_builds===true;
}

/**
 * Import dev builds on or off, guarded by the live Owner right in the same
 * statement, with its audit row in the same commit. The current value again
 * writes nothing and adds no audit row. A write of zero rows asks the database
 * again: a demoted Owner gets 403, an unchanged switch the unchanged view.
 */
export async function setDevBuilds(viewer:Viewer,enabled:boolean):Promise<ReleaseSourceView>{
 await requireOwner(viewer);
 const time=now();
 const [update]=await commitAll([
  sql`UPDATE agent_release_source SET dev_builds=${enabled} WHERE id=1 AND dev_builds<>${enabled} AND (${viewerCanSql(viewer,'instance.owner')})`,
  ...auditEvent({actor:viewer.label,action:enabled?releaseSourceAuditActions.devBuildsOn:releaseSourceAuditActions.devBuildsOff,target:releaseSourceAuditTarget,guard:auditAfterChange,at:time}),
 ]);
 if(update.rowCount===0)await requireOwner(viewer,true);
 return releaseSourceView();
}

type Bindings={BUCKET:Parameters<typeof streamReleaseFile>[0]};
const bindings=()=>env as unknown as Bindings;

/**
 * The scheduler tick (instrumentation.ts): a check only when one was requested,
 * or once by itself on a fresh installation that never checked.
 */
export async function runRequestedReleaseCheck(time:number){
 const started=Date.now();
 return runReleaseCheck(db(),{trigger:'request',storage:bindings().BUCKET,clock:()=>time+Math.max(0,Date.now()-started)});
}

/**
 * GET /downloads/<file>: the file row of a stored agent release that is not
 * deleted (a disabled one still serves dispatched updates), else the file row
 * of a plugin release (active or disabled), or null.
 */
export async function importedReleaseDownload(path:string):Promise<Response|null>{
 if(path.length>256)return null;
 const file=await db().one<{size:number;chunks:string}>(sql`SELECT size,chunks FROM (SELECT 0 AS source,f.release_id,f.size,f.chunks FROM agent_release_files f WHERE f.path=${path}
  AND NOT EXISTS (SELECT 1 FROM agent_release_states s WHERE s.release_id=f.release_id AND s.state='deleted')
  UNION ALL SELECT 1 AS source,p.release_id,p.size,p.chunks FROM plugin_release_files p JOIN plugin_releases r ON r.id=p.release_id WHERE p.path=${path} AND r.state IN ('active','disabled')) served ORDER BY source,release_id LIMIT 1`);
 if(!file)return null;
 return streamReleaseFile(bindings().BUCKET,{size:Number(file.size),chunks:file.chunks});
}

/** One file of one release, streamed from its stored chunks, or null without its file row. */
export async function storedReleaseFile(releaseId:string,path:string):Promise<Response|null>{
 const file=await db().one<{size:number;chunks:string}>(sql`SELECT size,chunks FROM agent_release_files WHERE release_id=${releaseId} AND path=${path}`);
 if(!file)return null;
 return streamReleaseFile(bindings().BUCKET,{size:Number(file.size),chunks:file.chunks});
}

