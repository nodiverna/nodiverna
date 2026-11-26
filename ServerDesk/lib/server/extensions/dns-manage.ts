import {jobDisplayInput} from '../../job-input';
import {HttpError,guid,now} from '../context';
import {principal,requireDevice,type DeviceRow} from '../identity/access';
import {featureDeviceGuard} from '../identity/feature-authorization';
import {mfaSessionFence,requireLiveSessions,requireMfa} from '../identity/mfa';
import {maintenanceBusy} from '../agent/agent-protocol';
import {MAX_QUEUED_JOBS,queueFullError} from '../devices/jobs/queue';
import {db,runSteps,sql,type Step} from '../db';
import {pluginReady,PLUGIN_HOST,PLUGIN_JOB} from '../../plugin-catalog';
import {DNS_PLUGIN} from '../../dns';
import {dnsChangeObject,isDnsChangeOperation,normalizeDnsChange,validateDnsChange,DNS_RECORD_OPERATIONS,type DnsChangeOperation,type DnsFieldError} from '../../dns-changes';
import {storedDns,storedDnsZone} from './dns-data';
import {translate} from '../../i18n/translate';
import {pluginJobLabelKey} from '../../job-display';
import {requireAdSessions} from './plugin-ad-sessions';
import type {ServerSnapshot,Viewer} from '../../types';

// DNS changes through the DNS plugin (docs/dns-server.md, "Change the DNS
// server") for POST /api/dns. Every change is one plugin-job with the operation
// as its target, gated like a DHCP change (lib/server/extensions/dhcp-manage.ts): the right
// dns.manage, online, a plugin host whose DNS plugin reports the operation,
// MFA, no maintenance, Management mode, the AD sign-in of this portal session
// for the device's directory (lib/server/extensions/plugin-ad-sessions.ts, carried as actAs) and
// a confirmation; then the stored read, its running service and the
// validation (lib/dns-changes.ts) against it and, for a record change, the
// stored records of the zone. The job and its audit row commit in one
// transaction or not at all. Nothing here changes a device directly; the
// plugin is the final check (OBJECT_EXISTS, OBJECT_MISSING).

/** The English job label of an operation: the audit action. */
export const dnsAuditAction=(operation:DnsChangeOperation)=>translate('en',pluginJobLabelKey(PLUGIN_JOB,operation)!);
const onlineWindowMs=120_000;

/** A change refused by its values: 400 apiError.dns.changeInvalid with the field errors in the answer. */
export class DnsChangeInvalid extends HttpError{
 readonly errors:DnsFieldError[];
 constructor(errors:DnsFieldError[]){super('apiError.dns.changeInvalid',{fields:[...new Set(errors.map(error=>error.field))].join(', ')});this.errors=errors;}
}
const parsedSnapshot=(device:DeviceRow):ServerSnapshot|null=>{try{return device.snapshot?JSON.parse(device.snapshot):null;}catch{return null;}};
async function waiting(serverId:string){return Number((await db().one<{n:number}>(sql`SELECT count(*) AS n FROM jobs WHERE server_id=${serverId} AND state IN ('pending','running')`))?.n??0);}

/**
 * change: one DNS change on one device, checked in the order of
 * docs/dns-server.md and written with nothing else on any refusal. Answers
 * {jobs:[{id,serverId}]}; several change jobs may wait on one device.
 */
export async function queueDnsChange(request:Request,v:Viewer,input:{serverId:unknown;operation:unknown;parameters:unknown;confirm:unknown}):Promise<{jobs:{id:string;serverId:string}[]}>{
 const operation=input.operation;
 if(!isDnsChangeOperation(operation))throw new HttpError('apiError.plugin.operationUnknown');
 if(!guid(input.serverId))throw new HttpError('apiError.device.invalid');
 const device=await requireDevice(v,input.serverId,'dns.manage'),label={name:device.name};
 if(!device.last_seen||now()-device.last_seen>onlineWindowMs)throw new HttpError('apiError.agent.notConnected',label);
 const snapshot=parsedSnapshot(device);
 if(snapshot?.protocolVersion!==3||!snapshot.agentCapabilities?.includes(PLUGIN_HOST))throw new HttpError('apiError.agent.v3FunctionRequired',label);
 if(!pluginReady(snapshot,DNS_PLUGIN,operation))throw new HttpError('apiError.dns.pluginMissing',label);
 await requireMfa(request,v);
 if(await maintenanceBusy(device.id))throw new HttpError('apiError.agent.maintenanceRetry');
 if(!device.management||snapshot.mode!=='Management')throw new HttpError('apiError.agent.readOnlyEnableManagement');
 const actAs=(await requireAdSessions(request,v,[{device,snapshot}])).get(device.id)!;
 if(input.confirm!==true)throw new HttpError('apiError.console.confirmServerChange');
 const data=await storedDns(device.id);
 if(!data)throw new HttpError('apiError.dns.noData',label);
 if(data.service!=='running')throw new HttpError('apiError.dns.serviceStopped',label);
 // The schema and the validation against the stored read; a record change also against the stored records of its zone.
 const zone=input.parameters&&typeof input.parameters==='object'&&typeof (input.parameters as {zone?:unknown}).zone==='string'?(input.parameters as {zone:string}).zone.trim().replace(/\.$/,'').toLowerCase():null;
 const records=DNS_RECORD_OPERATIONS.has(operation)&&zone?(await storedDnsZone(device.id,zone))?.records??null:null;
 const validation=validateDnsChange(operation,input.parameters,data.snapshot,records);
 if(!validation.ok)throw new DnsChangeInvalid(validation.errors);
 const parameters=normalizeDnsChange(operation,input.parameters as Record<string,unknown>);
 if(await waiting(device.id)>=MAX_QUEUED_JOBS)throw queueFullError();
 // One transaction: the job with dns.manage, the live MFA login session and the queue limit in its insert, and its audit row.
 const id=crypto.randomUUID(),time=now(),fence=await mfaSessionFence(request,v);
 const target=`${device.name} / ${dnsChangeObject(operation,parameters)} (AD: ${actAs.account})`;
 const steps:Step[]=[
  sql`INSERT INTO jobs (id,server_id,action,target,parameters,display_input,created_at,actor,actor_email,actor_principal) SELECT ${id},${device.id},${PLUGIN_JOB},${operation},${JSON.stringify({plugin:DNS_PLUGIN,operation,parameters,actAs})},${jobDisplayInput(PLUGIN_JOB,{plugin:DNS_PLUGIN,operation,parameters,actAs})},${time},${v.id},${v.label.trim().toLowerCase()},${principal(v)}
   WHERE (${featureDeviceGuard(v,device.id,['dns.manage'])}) AND (${fence}) AND (SELECT count(*) FROM jobs WHERE server_id=${device.id} AND state IN ('pending','running'))<${MAX_QUEUED_JOBS}`,
  sql`INSERT INTO audit (at,actor,action,target,server_id,scope) SELECT ${time},${v.label},${dnsAuditAction(operation)},${target},${device.id},'device' WHERE EXISTS (SELECT 1 FROM jobs WHERE id=${id})`,
 ];
 class NotWritten extends Error {}
 let written=false;
 try{
  await db().transaction(async tx=>{
   const results=await runSteps(tx,steps);
   written=results[0].rowCount>0;
   if(!written)throw new NotWritten();
  });
 }catch(error){if(!(error instanceof NotWritten))throw error;}
 if(!written){await requireLiveSessions(request,v);throw new HttpError('apiError.console.queueChanged');}
 return {jobs:[{id,serverId:device.id}]};
}
