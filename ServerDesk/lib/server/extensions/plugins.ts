import {pluginAuditActions} from '../../audit-actions';
import {jobDisplayInput} from '../../job-input';
import {HttpError,guid,now} from '../context';
import {allowedDeviceIds,principal,requireDevice,type DeviceRow} from '../identity/access';
import {can} from '../identity/policy/can';
import {featureDeviceGuard,featureTargetsGuard} from '../identity/feature-authorization';
import {authorizeTargetCustomers,customerEntries,recheckCrossCustomer} from '../identity/cross-customer';
import {mfaSessionFence,requireLiveSessions} from '../identity/mfa';
import {maintenanceBusy,modern} from '../agent/agent-protocol';
import {MAX_QUEUED_JOBS,queueFullError} from '../devices/jobs/queue';
import {db,jsonText,runSteps,sql,type Sql,type Step} from '../db';
import {agentMeetsMinimum,comparePluginVersions,pluginOperations,snapshotPlugin,PLUGIN_HOST,PLUGIN_INSTALL,PLUGIN_JOB,PLUGIN_REMOVE,type PluginOperation} from '../../plugin-catalog';
import {installablePluginRelease,pluginReleases,storedPluginRelease,type PluginReleaseEntry,type StoredPluginRelease} from './plugin-releases';
import {pluginNamePattern} from '../../../runtime/plugin-release-verify.mjs';
import {isDevVersion} from '../../../runtime/release-version.mjs';
import {devBuildsEnabled} from '../agent/release-source';
import {storedDns} from './dns-data';
import {DNS_ZONE_READ} from '../../dns';
import type {Viewer} from '../../types';

// Install, remove and run agent plugins (docs/agent-plugins.md) for
// app/api/plugins/route.ts. Installing, removing and rolling out a plugin
// distributes a signed release (lib/step-up.ts: routine): each needs the device
// right plugins.manage, a confirmation and the live MFA login session. Every
// job INSERT carries the request's mfaSessionFence (lib/server/identity/mfa.ts), so a session
// that ended before the commit writes nothing and answers the MFA-session
// error. A plugin read (dhcp-read) needs only its read right.
// Nothing here changes a device directly: the agent runs the queued job.

export {pluginAuditActions};

/** The plugin name of a request, else 400. */
export function pluginName(value:unknown):string{if(typeof value!=='string'||!pluginNamePattern.test(value))throw new HttpError('apiError.plugin.invalid');return value;}

/** GET /api/plugins: the releases for a viewer with plugins.manage on at least one device, or for an Owner; 403 otherwise. */
export async function pluginReleaseView(v:Viewer):Promise<{releases:PluginReleaseEntry[]}>{
 if(!(await allowedDeviceIds(v,'plugins.manage')).length&&!await can(v,'instance.owner'))throw new HttpError('apiError.plugin.rightMissing');
 return {releases:await pluginReleases()};
}

type QueuedJob={id:string;serverId:string;kind:string;target:string;parameters:Record<string,unknown>;auditTarget:string;auditAction:string};
class NotWritten extends Error {}
const queueChanged=async()=>new HttpError('apiError.console.queueChanged');
/**
 * One transaction: every job with its authorization, the live MFA login session
 * (the request's mfaSessionFence) and the queue limit, one device audit row per
 * job and the customer entries. When one job does not hold, the transaction
 * rolls back and nothing is written; an ended session then answers its own
 * error (requireLiveSessions), anything else the error of `changed`.
 */
async function queueFencedJobs(request:Request,v:Viewer,jobs:QueuedJob[],authorization:Sql,changed:()=>Promise<HttpError>,extra:(written:Sql)=>Step[]=()=>[]):Promise<void>{
 const time=now(),ids=JSON.stringify(jobs.map(job=>job.id)),fence=await mfaSessionFence(request,v);
 const all=sql`(SELECT count(*) FROM jobs WHERE id IN (SELECT value FROM jsonb_array_elements_text(${ids}::jsonb)))=${jobs.length}`;
 const steps:Step[]=[
  ...jobs.map(job=>sql`INSERT INTO jobs (id,server_id,action,target,parameters,display_input,created_at,actor,actor_email,actor_principal) SELECT ${job.id},${job.serverId},${job.kind},${job.target},${JSON.stringify(job.parameters)},${jobDisplayInput(job.kind,job.parameters)},${time},${v.id},${v.label.trim().toLowerCase()},${principal(v)} WHERE ${authorization} AND (${fence}) AND (SELECT count(*) FROM jobs WHERE server_id=${job.serverId} AND state IN ('pending','running'))<${MAX_QUEUED_JOBS}`),
  ...jobs.map(job=>sql`INSERT INTO audit (at,actor,action,target,server_id,scope) SELECT ${time},${v.label},${job.auditAction},${job.auditTarget},${job.serverId},'device' WHERE EXISTS (SELECT 1 FROM jobs WHERE id=${job.id})`),
  ...extra(all),
 ];
 let written=false;
 try{
  await db().transaction(async tx=>{
   const results=await runSteps(tx,steps);
   written=results.slice(0,jobs.length).every(result=>result.rowCount>0);
   if(!written)throw new NotWritten();
  });
 }catch(error){if(!(error instanceof NotWritten))throw error;}
 if(!written){await requireLiveSessions(request,v);throw await changed();}
}

async function waitingJobs(serverId:string){return Number((await db().one<{n:number}>(sql`SELECT count(*) AS n FROM jobs WHERE server_id=${serverId} AND state IN ('pending','running')`))?.n??0);}
/** The device of an install or removal: the right, online, a plugin host, no maintenance and room in the queue. */
async function pluginDevice(v:Viewer,serverId:unknown,permission:'plugins.manage'|'dhcp.read'|'dhcp.manage'|'dns.read'|'dns.manage'){
 if(!guid(serverId))throw new HttpError('apiError.device.invalid');
 const device=await requireDevice(v,serverId,permission),snapshot=modern(device,PLUGIN_HOST);
 if(await maintenanceBusy(serverId))throw new HttpError('apiError.agent.maintenanceRetry');
 return {device,snapshot};
}

/**
 * install: queues plugin-install of the newest active release of `name` whose
 * minimum agent version the device agent meets. A damaged or older install is
 * replaced; the same ready version is refused.
 */
export async function preparePluginInstall(v:Viewer,input:{serverId:unknown;plugin:unknown;confirm:unknown}){
 const name=pluginName(input.plugin);
 if(input.confirm!==true)throw new HttpError('apiError.plugin.confirmRequired');
 const {device,snapshot}=await pluginDevice(v,input.serverId,'plugins.manage');
 const choice=await installablePluginRelease(name,snapshot.agentVersion);
 if('missing' in choice)throw new HttpError('apiError.plugin.releaseMissing');
 if('tooOld' in choice)throw new HttpError('apiError.plugin.agentTooOld',{name:device.name,version:choice.tooOld});
 const installed=snapshotPlugin(snapshot,name);
 if(installed?.state==='ready'&&installed.version===choice.release.version)throw new HttpError('apiError.plugin.alreadyInstalled',{name:device.name});
 if(await waitingJobs(device.id)>=MAX_QUEUED_JOBS)throw queueFullError();
 return {device,release:choice.release};
}
export async function queuePluginInstall(request:Request,v:Viewer,prepared:{device:DeviceRow;release:StoredPluginRelease}):Promise<{id:string}>{
 const {device,release}=prepared,id=crypto.randomUUID(),target=`${release.name} ${release.version}`;
 await queueFencedJobs(request,v,[{id,serverId:device.id,kind:PLUGIN_INSTALL,target,parameters:{name:release.name,releaseId:release.id,version:release.version,manifest:release.manifest,signature:release.signature},auditAction:pluginAuditActions.installQueued,auditTarget:`${device.name} / ${target}`}],
  sql`(${featureDeviceGuard(v,device.id,['plugins.manage'])}) AND EXISTS (SELECT 1 FROM plugin_releases WHERE id=${release.id} AND state='active')`,queueChanged);
 return {id};
}

/** remove: queues plugin-remove for a plugin the device reports. */
export async function preparePluginRemove(v:Viewer,input:{serverId:unknown;plugin:unknown;confirm:unknown}){
 const name=pluginName(input.plugin);
 if(input.confirm!==true)throw new HttpError('apiError.plugin.confirmRequired');
 const {device,snapshot}=await pluginDevice(v,input.serverId,'plugins.manage');
 if(!snapshotPlugin(snapshot,name))throw new HttpError('apiError.plugin.notInstalled',{name:device.name});
 if(await waitingJobs(device.id)>=MAX_QUEUED_JOBS)throw queueFullError();
 return {device,name};
}
export async function queuePluginRemove(request:Request,v:Viewer,prepared:{device:DeviceRow;name:string}):Promise<{id:string}>{
 const {device,name}=prepared,id=crypto.randomUUID();
 await queueFencedJobs(request,v,[{id,serverId:device.id,kind:PLUGIN_REMOVE,target:name,parameters:{name},auditAction:pluginAuditActions.removalQueued,auditTarget:`${device.name} / ${name}`}],featureDeviceGuard(v,device.id,['plugins.manage']),queueChanged);
 return {id};
}

/** The parameters of a zone read: exactly {zone}. */
function zoneReadParameters(value:unknown):{zone:string}{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new HttpError('apiError.request.invalid');
 const keys=Object.keys(value),zone=(value as {zone?:unknown}).zone;
 if(keys.length!==1||typeof zone!=='string'||!zone||zone.length>255)throw new HttpError('apiError.request.invalid');
 return {zone};
}
/**
 * job: queues one plugin read without confirmation or MFA. Only readOnly
 * operations: a DHCP change goes through POST /api/dhcp (lib/server/extensions/dhcp-manage.ts),
 * a DNS change through POST /api/dns (lib/server/extensions/dns-manage.ts). At most one
 * pending or running job of the operation exists per device: a second request
 * answers with the id of the open one. The target is the operation, so the
 * finished job keeps its rights (jobParametersFromTarget). Only dns-zone-read
 * takes parameters, {zone} of a zone in the latest stored DNS read (else
 * apiError.dns.zoneMissing); its open job is unique per device and zone.
 */
export async function queuePluginJob(v:Viewer,input:{serverId:unknown;plugin:unknown;operation:unknown;parameters?:unknown}):Promise<{id:string}>{
 const operation=input.operation as PluginOperation;
 if(typeof input.operation!=='string'||!Object.hasOwn(pluginOperations,input.operation)||pluginOperations[operation].plugin!==input.plugin||!pluginOperations[operation].readOnly)throw new HttpError('apiError.plugin.operationUnknown');
 const definition=pluginOperations[operation];
 const {device,snapshot}=await pluginDevice(v,input.serverId,definition.permission);
 const plugin=snapshotPlugin(snapshot,definition.plugin);
 if(plugin?.state!=='ready'||!plugin.capabilities.includes(operation))throw new HttpError('apiError.plugin.notInstalled',{name:device.name});
 let job:Record<string,unknown>={plugin:definition.plugin,operation},same=sql`TRUE`;
 if(operation===DNS_ZONE_READ){
  const {zone}=zoneReadParameters(input.parameters),stored=await storedDns(device.id);
  if(!stored?.snapshot.zones.some(item=>item.name===zone&&item.kind!=='forwarder'))throw new HttpError('apiError.dns.zoneMissing',{zone});
  job={...job,parameters:{zone}};
  same=sql`${jsonText(sql`parameters`,'parameters','zone')}=${zone}`;
 }
 const open=()=>db().one<{id:string}>(sql`SELECT id FROM jobs WHERE server_id=${device.id} AND action=${PLUGIN_JOB} AND target=${operation} AND state IN ('pending','running') AND ${same} ORDER BY created_at LIMIT 1`);
 const existing=await open();if(existing)return {id:existing.id};
 const id=crypto.randomUUID(),time=now(),parameters=JSON.stringify(job);
 const inserted=await db().exec(sql`INSERT INTO jobs (id,server_id,action,target,parameters,display_input,created_at,actor,actor_email,actor_principal) SELECT ${id},${device.id},${PLUGIN_JOB},${operation},${parameters},${jobDisplayInput(PLUGIN_JOB,parameters)},${time},${v.id},${v.label.trim().toLowerCase()},${principal(v)}
  WHERE ${featureDeviceGuard(v,device.id,[definition.permission])} AND (SELECT count(*) FROM jobs WHERE server_id=${device.id} AND state IN ('pending','running'))<${MAX_QUEUED_JOBS}
  AND NOT EXISTS (SELECT 1 FROM jobs WHERE server_id=${device.id} AND action=${PLUGIN_JOB} AND target=${operation} AND state IN ('pending','running') AND ${same})`);
 if(inserted.rowCount)return {id};
 const raced=await open();if(raced)return {id:raced.id};
 throw new HttpError('apiError.console.queueChanged');
}

/**
 * deploy: the rollout of a release to 1 to 20 pilot devices. Every device is
 * checked before any write: online, a plugin host, the plugin installed at a
 * lower rank or another dev build of the same base, the minimum agent version
 * (a dev agent by its base) and no maintenance. A dev build needs Import dev
 * builds (apiError.plugin.devBuildsOff before any write). Then the
 * cross-customer gate; the jobs, their audit rows and the customer entries
 * commit in one transaction, admitted by the live MFA login session.
 */
export async function preparePluginDeploy(v:Viewer,input:{releaseId:unknown;serverIds:unknown;confirm:unknown}){
 const ids=input.serverIds;
 if(input.confirm!==true||!Array.isArray(ids)||ids.length<1||ids.length>20||!ids.every(guid)||new Set(ids).size!==ids.length)throw new HttpError('apiError.plugin.pilotDevicesRequired');
 if(!guid(input.releaseId))throw new HttpError('apiError.plugin.releaseMissing');
 const release=await storedPluginRelease(input.releaseId);if(!release||!release.active)throw new HttpError('apiError.plugin.releaseMissing');
 if(isDevVersion(release.version)&&!await devBuildsEnabled())throw new HttpError('apiError.plugin.devBuildsOff');
 const staged:{id:string;serverId:string;name:string}[]=[];
 for(const serverId of ids as string[]){
  const device=await requireDevice(v,serverId,'plugins.manage'),snapshot=modern(device,PLUGIN_HOST),installed=snapshotPlugin(snapshot,release.name);
  if(!installed)throw new HttpError('apiError.plugin.notInstalled',{name:device.name});
  const comparison=comparePluginVersions(release.version,installed.version);
  if(release.version===installed.version)throw new HttpError('apiError.plugin.sameVersion',{name:device.name});
  if(comparison===null||comparison<0)throw new HttpError('apiError.plugin.noDowngrade',{name:device.name});
  if(!agentMeetsMinimum(snapshot.agentVersion,release.minAgentVersion))throw new HttpError('apiError.plugin.agentTooOld',{name:device.name,version:release.minAgentVersion});
  if(await maintenanceBusy(serverId))throw new HttpError('apiError.release.updateActive',{name:device.name});
  staged.push({id:crypto.randomUUID(),serverId,name:device.name});
 }
 // Cross-customer: the gate after the per-device checks, its guard in every job.
 const customers=await authorizeTargetCustomers(v,staged.map(job=>job.serverId));
 return {release,staged,customers};
}
export async function queuePluginDeploy(request:Request,v:Viewer,prepared:Awaited<ReturnType<typeof preparePluginDeploy>>):Promise<{jobs:string[]}>{
 const {release,staged,customers}=prepared,target=`${release.name} ${release.version}`;
 const authorization=sql`(${featureTargetsGuard(v,staged.map(job=>job.serverId),['plugins.manage'])}) AND (${customers.guard}) AND EXISTS (SELECT 1 FROM plugin_releases WHERE id=${release.id} AND state='active')`;
 const jobs=staged.map(job=>({id:job.id,serverId:job.serverId,kind:PLUGIN_INSTALL,target,parameters:{name:release.name,releaseId:release.id,version:release.version,manifest:release.manifest,signature:release.signature},auditAction:pluginAuditActions.rolloutPlanned,auditTarget:`${job.name} / ${target}`}));
 const changed=async()=>{await recheckCrossCustomer(v,customers);return new HttpError('apiError.plugin.rolloutChanged');};
 await queueFencedJobs(request,v,jobs,authorization,changed,written=>customerEntries(customers,{actor:v.label,action:pluginAuditActions.rolloutAcrossCustomers,target,condition:written}));
 return {jobs:staged.map(job=>job.id)};
}
