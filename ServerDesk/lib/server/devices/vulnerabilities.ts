// The vulnerability check of the software inventory (docs/software-vulnerabilities.md):
// the Owner-only settings page (GET/PUT /api/vulnerabilities/settings, POST
// /api/vulnerabilities/sync) and the CVE detail of one program version
// (GET /api/software/vulnerabilities). The check opens an outbound connection
// for the whole instance, so only global Owners read or change it, like the
// usage data and the maintenance. The API key is stored as keyring ciphertext and
// never leaves the server, nor goes into an audit row or a log line.
// The sync itself lives in lib/server/devices/vulnerability-sync.ts.
import {vulnerabilityAuditActions} from '../../audit-actions';
import {guid,HttpError,now} from '../context';
import {requireDevice} from '../identity/access';
import {auditAfterChange,auditEvent} from '../audit';
import {can,viewerCanSql} from '../identity/policy/can';
import {encryptSecret} from '../identity/mfa';
import {scopeDeviceIds} from './software';
import {commitAll,db,sql,type Step} from '../db';
import type {Viewer} from '../../types';
import {cveListErrorKey,secondSourceDue,syncErrorKey,vulnerabilityApiKeyContext,vulnerabilityLimits,vulnerabilitySyncDue,vulnerabilitySyncFailures,type CveListErrorKey,type VulnerabilitySyncErrorKey} from './vulnerability-sync';
import {checkedProduct,productCves,vulnerabilityContext} from './vulnerability-verdicts';
import {catalogProductFor,compareCves,cveAffects,productVerdict,vulnerabilityCatalog,vulnerabilityRulesVersion,type SoftwareVulnerabilityDetail,type VulnerabilityCve} from '../../software-vulnerabilities';
export type {SoftwareVulnerabilityDetail,VulnerabilityCve};

export const vulnerabilityAuditTarget='Vulnerability check';
export {vulnerabilityAuditActions};
/** The detail lists at most this many CVEs, the most severe first. */
export const vulnerabilityDetailLimit=500;
const apiKeyPattern=/^[A-Za-z0-9-]{20,64}$/;

export type VulnerabilitySyncState='off'|'idle'|'queued'|'running'|'failed';
/** The state of the CVE.org source: off (its switch or the check is off), idle, or failed (its last part failed). */
export type SecondSourceState='off'|'idle'|'failed';
export type VulnerabilitySettingsView={
 enabled:boolean;apiKeySet:boolean;revision:number;catalogCheckedAt:string;
 sync:{state:VulnerabilitySyncState;lastSuccessAt:number|null;lastFinishedAt:number|null;lastError:VulnerabilitySyncErrorKey|null;nextDueAt:number|null};
 secondSource:{enabled:boolean;state:SecondSourceState;lastSuccessAt:number|null;lastFinishedAt:number|null;lastError:CveListErrorKey|null};
 /** secondSourceCount: the CVEs that only CVE.org lists for the product (CVE.org ranges and no NVD range). */
 products:{id:string;label:string;cveCount:number;syncedAt:number|null;secondSourceCount:number}[];
};

type SettingsRow={enabled:number;api_key:string|null;revision:number;cvelist_enabled:number};
type SyncRow={lease_until:number|null;requested_at:number|null;last_started_at:number|null;last_finished_at:number|null;last_success_at:number|null;last_status:'ok'|'failed'|null;last_error:string|null;
 cvelist_last_finished_at:number|null;cvelist_last_success_at:number|null;cvelist_last_status:'ok'|'failed'|null;cvelist_last_error:string|null};
const num=(value:unknown)=>value===null||value===undefined?null:Number(value);
const ownerOnly=()=>new HttpError('apiError.vulnerabilities.ownerOnly');
// The re-check after a refused commit asks the database again (fresh): a demoted Owner gets 403, not a conflict.
async function requireOwner(viewer:Viewer,fresh=false){if(!await can(viewer,'instance.owner',{fresh}))throw ownerOnly();}
const syncKeys:ReadonlySet<string>=new Set(vulnerabilitySyncFailures.map(syncErrorKey));
const isSyncKey=(value:string|null):value is VulnerabilitySyncErrorKey=>!!value&&syncKeys.has(value);
const cveListKeys:ReadonlySet<string>=new Set(vulnerabilitySyncFailures.map(cveListErrorKey));
const isCveListKey=(value:string|null):value is CveListErrorKey=>!!value&&cveListKeys.has(value);

/**
 * The state shown on the settings page and the time the scheduler takes up the
 * next run. rulesStale: a stored product was synced with other matching rules,
 * so the run is due now or, after a failure, when the back-off ends. With the
 * CVE.org source on, nextDueAt is the earlier of the NVD's due time and the
 * CVE.org part's (secondSourceDueAt).
 */
export function syncStateOf(enabled:boolean,row:SyncRow,time:number,rulesStale:boolean,secondSource=false):{state:VulnerabilitySyncState;nextDueAt:number|null}{
 if(!enabled)return {state:'off',nextDueAt:null};
 if(num(row.lease_until)!==null&&Number(row.lease_until)>time)return {state:'running',nextDueAt:null};
 const requested=num(row.requested_at),started=num(row.last_started_at);
 if(requested!==null&&(started===null||requested>started))return {state:'queued',nextDueAt:time};
 const failed=row.last_status==='failed',due=vulnerabilitySyncDue(row,time,rulesStale);
 const success=num(row.last_success_at),finished=num(row.last_finished_at);
 const backoffEnd=failed&&finished!==null?finished+vulnerabilityLimits.backoffMs:0;
 const nvdDueAt=due?time:rulesStale?backoffEnd:Math.max(success===null?time:success+vulnerabilityLimits.dailyMs,backoffEnd);
 return {state:failed?'failed':'idle',nextDueAt:secondSource?Math.min(nvdDueAt,secondSourceDueAt(row,time)):nvdDueAt};
}
/** When the CVE.org part is due next: now when due, else 24 hours after its last success, not before the end of its back-off. */
export function secondSourceDueAt(row:SyncRow,time:number):number{
 if(secondSourceDue(row,time))return time;
 const success=num(row.cvelist_last_success_at),finished=num(row.cvelist_last_finished_at);
 const backoffEnd=row.cvelist_last_status==='failed'&&finished!==null?finished+vulnerabilityLimits.backoffMs:0;
 return Math.max(success===null?time:success+vulnerabilityLimits.dailyMs,backoffEnd);
}

async function view():Promise<VulnerabilitySettingsView>{
 const time=now();
 const [settings,sync,products,counts]=await Promise.all([
  db().one<SettingsRow>(sql`SELECT enabled,api_key,revision,cvelist_enabled FROM vulnerability_settings WHERE id=1`),
  db().one<SyncRow>(sql`SELECT lease_until,requested_at,last_started_at,last_finished_at,last_success_at,last_status,last_error,cvelist_last_finished_at,cvelist_last_success_at,cvelist_last_status,cvelist_last_error FROM vulnerability_sync WHERE id=1`),
  db().query<{product_id:string;cpe:string;cve_count:number;synced_at:number|null;rules_version:number}>(sql`SELECT product_id,cpe,cve_count,synced_at,rules_version FROM vulnerability_products`),
  db().query<{product_id:string;n:number}>(sql`SELECT r.product_id,count(DISTINCT r.cve_id)::int AS n FROM vulnerability_ranges r WHERE r.source='cvelist'
   AND NOT EXISTS (SELECT 1 FROM vulnerability_ranges o WHERE o.product_id=r.product_id AND o.cve_id=r.cve_id AND o.source='nvd') GROUP BY r.product_id`),
 ]);
 if(!settings||!sync)throw new Error('vulnerability_settings or vulnerability_sync is missing');
 const enabled=Number(settings.enabled)===1,secondSource=Number(settings.cvelist_enabled)===1,stored=new Map(products.map(row=>[row.product_id,row])),onlyCveList=new Map(counts.map(row=>[row.product_id,Number(row.n)]));
 const {state,nextDueAt}=syncStateOf(enabled,sync,time,products.some(row=>Number(row.rules_version)!==vulnerabilityRulesVersion),secondSource);
 return {
  enabled,apiKeySet:settings.api_key!==null,revision:Number(settings.revision),catalogCheckedAt:vulnerabilityCatalog.checkedAt,
  sync:{state,lastSuccessAt:num(sync.last_success_at),lastFinishedAt:num(sync.last_finished_at),lastError:isSyncKey(sync.last_error)?sync.last_error:null,nextDueAt},
  secondSource:{enabled:secondSource,state:!secondSource||!enabled?'off':sync.cvelist_last_status==='failed'?'failed':'idle',
   lastSuccessAt:num(sync.cvelist_last_success_at),lastFinishedAt:num(sync.cvelist_last_finished_at),lastError:isCveListKey(sync.cvelist_last_error)?sync.cvelist_last_error:null},
  products:vulnerabilityCatalog.products.map(product=>{const row=stored.get(product.id),current=row?.cpe===product.cpe;return {id:product.id,label:product.label,cveCount:current?Number(row.cve_count):0,syncedAt:current?num(row.synced_at):null,secondSourceCount:onlyCveList.get(product.id)??0};}),
 };
}

/** GET /api/vulnerabilities/settings. Owners only. */
export async function vulnerabilitySettingsView(viewer:Viewer):Promise<VulnerabilitySettingsView>{await requireOwner(viewer);return view();}

type SetInput={enabled?:unknown;apiKey?:unknown;revision?:unknown;secondSource?:unknown};
/**
 * PUT /api/vulnerabilities/settings. apiKey omitted or "" keeps the stored key,
 * null removes it, a string replaces it. secondSource omitted keeps the
 * stored switch of the CVE.org source. One transaction holds the
 * compare-and-set update against the revision (guarded by the live Owner
 * right), one audit row per change and, when the check is turned on or the
 * CVE.org source is turned on while the check is on, the request for a run.
 */
export async function setVulnerabilitySettings(viewer:Viewer,input:SetInput):Promise<VulnerabilitySettingsView>{
 const {enabled,apiKey,revision,secondSource}=input;
 if(typeof enabled!=='boolean'||typeof revision!=='number'||!Number.isSafeInteger(revision)||revision<0)throw new HttpError('apiError.vulnerabilities.settingsInvalid');
 if(secondSource!==undefined&&typeof secondSource!=='boolean')throw new HttpError('apiError.vulnerabilities.settingsInvalid');
 if(apiKey!==undefined&&apiKey!==null&&(typeof apiKey!=='string'||(apiKey!==''&&!apiKeyPattern.test(apiKey))))throw new HttpError('apiError.vulnerabilities.settingsInvalid');
 await requireOwner(viewer);
 const current=await db().one<SettingsRow>(sql`SELECT enabled,api_key,revision,cvelist_enabled FROM vulnerability_settings WHERE id=1`);
 if(!current)throw new Error('vulnerability_settings is missing');
 if(Number(current.revision)!==revision)throw new HttpError('apiError.vulnerabilities.settingsStale');
 const wasEnabled=Number(current.enabled)===1,hadSecondSource=Number(current.cvelist_enabled)===1,secondSourceOn=secondSource??hadSecondSource;
 const key=apiKey===null?(current.api_key===null?undefined:null):typeof apiKey==='string'&&apiKey!==''?await encryptSecret(apiKey,vulnerabilityApiKeyContext):undefined;
 const actions:string[]=[];
 if(enabled!==wasEnabled)actions.push(enabled?vulnerabilityAuditActions.on:vulnerabilityAuditActions.off);
 if(secondSourceOn!==hadSecondSource)actions.push(secondSourceOn?vulnerabilityAuditActions.secondSourceOn:vulnerabilityAuditActions.secondSourceOff);
 if(key===null)actions.push(vulnerabilityAuditActions.keyRemoved);
 else if(key!==undefined)actions.push(vulnerabilityAuditActions.keySet);
 if(!actions.length)return view();
 const time=now();
 const steps:Step[]=[
  sql`SELECT id FROM vulnerability_settings WHERE id=1 FOR UPDATE`,
  sql`UPDATE vulnerability_settings SET enabled=${enabled?1:0},cvelist_enabled=${secondSourceOn?1:0},api_key=${key===undefined?sql`api_key`:key},revision=revision+1,updated_at=${time},updated_by=${viewer.label} WHERE id=1 AND revision=${revision} AND (${viewerCanSql(viewer,'instance.owner')})`,
  // Each audit row follows the step before it, so all exist exactly when the update happened.
  ...actions.flatMap(action=>auditEvent({actor:viewer.label,action,target:vulnerabilityAuditTarget,guard:auditAfterChange,at:time})),
 ];
 // A run for a check that was off, or for a CVE.org source that was off while the check stays on.
 if(enabled&&(!wasEnabled||(secondSourceOn&&!hadSecondSource)))steps.push({afterChange:sql`UPDATE vulnerability_sync SET requested_at=${time} WHERE id=1`});
 const results=await commitAll(steps);
 if(results[1].rowCount)return view();
 await requireOwner(viewer,true);
 throw new HttpError('apiError.vulnerabilities.settingsStale');
}

const checkOff=()=>new HttpError('apiError.vulnerabilities.checkOff');
const checkEnabled=async()=>Number((await db().one<{enabled:number}>(sql`SELECT enabled FROM vulnerability_settings WHERE id=1`))?.enabled)===1;
/**
 * POST /api/vulnerabilities/sync: asks for a run within a minute. Nothing
 * changes while one is queued or running. The write is guarded by the live
 * Owner right and the check being on, in the same statement; when it changes
 * no row, a fresh check tells a demoted Owner (403) and a check turned off in
 * the meantime (409) from a run that is already queued or running.
 */
export async function requestVulnerabilitySync(viewer:Viewer):Promise<VulnerabilitySettingsView>{
 await requireOwner(viewer);
 const time=now();
 if(!await checkEnabled())throw checkOff();
 const written=await db().exec(sql`UPDATE vulnerability_sync SET requested_at=${time} WHERE id=1
  AND (requested_at IS NULL OR (last_started_at IS NOT NULL AND requested_at<=last_started_at)) AND (lease_until IS NULL OR lease_until<=${time})
  AND EXISTS (SELECT 1 FROM vulnerability_settings WHERE id=1 AND enabled=1) AND (${viewerCanSql(viewer,'instance.owner')})`);
 if(!written.rowCount){
  await requireOwner(viewer,true);
  if(!await checkEnabled())throw checkOff();
 }
 return view();
}

const notFound=()=>new HttpError('apiError.vulnerabilities.notFound');
/**
 * GET /api/software/vulnerabilities?name=&version=&(device=|scope=): the CVEs
 * that affect one program version, most severe first (known exploited, score
 * and the newest break ties), at most 500 with the total. 404 while the check
 * is off, for a program outside the catalog, and when no device the viewer
 * sees in the device or scope has this name and version.
 */
export async function softwareVulnerabilityDetail(viewer:Viewer,params:URLSearchParams):Promise<SoftwareVulnerabilityDetail>{
 const name=params.get('name'),version=params.get('version'),device=params.get('device');
 if(!name||!version||name.length>256||version.length>256)throw notFound();
 let devices:string[];
 if(device!==null){if(!guid(device))throw notFound();await requireDevice(viewer,device,'view');devices=[device];}
 else devices=await scopeDeviceIds(viewer,params.get('scope'));
 const context=await vulnerabilityContext();
 if(!context.enabled||!devices.length)throw notFound();
 const publishers=await db().query<{publisher:string|null}>(sql`SELECT DISTINCT publisher FROM device_software WHERE server_id IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(devices)}::jsonb)) AND normalized_name=${name} AND normalized_version=${version}`);
 if(!publishers.length)throw notFound();
 const product=publishers.map(row=>catalogProductFor(name,row.publisher)).find(Boolean);
 if(!product)throw notFound();
 const productInfo={id:product.id,label:product.label,cpe:product.cpe};
 if(!checkedProduct(context,{normalizedName:name,normalizedVersion:version,publisher:publishers.find(row=>catalogProductFor(name,row.publisher))?.publisher??null}))return {product:productInfo,verdict:productVerdict(null,null),cves:[],total:0};
 const cves=(await productCves(new Map([[product.id,new Set([version])]]),context.secondSource)).get(product.id)??[];
 const verdict=productVerdict(cves,version);
 const affecting=cves.map(cve=>({cve,...cveAffects(cve.ranges,version)})).filter(item=>item.affected);
 if(!affecting.length)return {product:productInfo,verdict,cves:[],total:0};
 const details=new Map((await db().query<{cve_id:string;vector:string|null;published:number|null;summary:string}>(sql`SELECT cve_id,vector,published,summary FROM vulnerabilities WHERE cve_id IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(affecting.map(item=>item.cve.id))}::jsonb))`)).map(row=>[row.cve_id,row]));
 const list:VulnerabilityCve[]=affecting.map(({cve,fixedIn})=>{const row=details.get(cve.id);return {id:cve.id,severity:cve.severity,score:cve.score,vector:row?.vector??null,knownExploited:cve.knownExploited,published:num(row?.published),summary:row?.summary??'',fixedIn,source:cve.source};});
 list.sort(compareCves);
 return {product:productInfo,verdict,cves:list.slice(0,vulnerabilityDetailLimit),total:list.length};
}
