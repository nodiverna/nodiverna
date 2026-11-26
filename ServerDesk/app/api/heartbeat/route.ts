import {z} from 'zod';
import {body,now,HttpError,failure} from '@/lib/server/context';
import {telemetry} from '@/lib/server/agent/telemetry';
import {deviceFromBearer} from '@/lib/server/agent/device-tokens';
import {activeDeviceKey,recordHeartbeat,recordHeartbeatSample} from '@/lib/server/agent/heartbeat';
import {softwareResyncNeeded} from '@/lib/server/devices/software';
import {driverResyncNeeded} from '@/lib/server/devices/drivers';
import {autostartResyncNeeded} from '@/lib/server/devices/autostart';
import {syncDeviceAlerts} from '@/lib/server/devices/alerts';
import {issueFields} from '@/lib/server/errors/issues';
import {MAX_REPORTED_RUNNING_JOBS} from '@/lib/server/devices/jobs/concurrency';

// Native telemetry is independent of the command channel. Completed jobs are
// acknowledged exclusively through /api/agent/channel.
// Global retention of jobs and audit runs in the daily maintenance (runtime/maintenance.mjs),
// so this write transaction only touches the reporting device's own rows.
const envelope=z.object({
 serverId:z.guid(),snapshot:telemetry,
 results:z.array(z.never()).max(0).default([]),
 runningJobs:z.array(z.guid()).max(MAX_REPORTED_RUNNING_JOBS).default([])
}).strict();

const errorText=(error:unknown)=>error instanceof Error?error.message:String(error);

export async function POST(request:Request){try{
 // Authenticate from the headers before buffering up to 2 MB of telemetry.
 const time=now(),{device:s,tokenHash}=await deviceFromBearer<{id:string;last_seen:number|null;agent_public_key:string|null}>(request,'id,last_seen,agent_public_key',{allowTokenRetry:true,time});
 const parsed=envelope.safeParse(await body(request,2097152));
 if(!parsed.success){
  const fields=parsed.error.issues.slice(0,10).map(issue=>({field:issue.path.join('.'),code:issue.code}));
  console.error('heartbeat validation',JSON.stringify(fields));
  throw new HttpError('apiError.heartbeat.invalidTelemetry',{fields:issueFields(parsed.error.issues,10)});
 }
 const p=parsed.data;
 if(p.serverId!==s.id)throw new HttpError('apiError.agent.notApproved');
 // Shortcut only. The binding interval check is part of every batch statement.
 if(s.last_seen&&time-Number(s.last_seen)<10000)throw new HttpError('apiError.heartbeat.intervalTooShort');
 if(!/Windows Server (2022|2025)|Windows 11 (Pro|Enterprise)/i.test(p.snapshot.os))throw new HttpError('apiError.heartbeat.unsupportedOs');
 const publicKey=JSON.stringify({kty:p.snapshot.publicKey.kty,n:p.snapshot.publicKey.n,e:p.snapshot.publicKey.e});
 if(s.agent_public_key&&s.agent_public_key!==publicKey)throw new HttpError('apiError.heartbeat.keyMismatch');
 // One transaction, admitted as a whole by token, key and interval (lib/server/agent/heartbeat.ts).
 // The device name follows the reported computer name unless it is a custom name.
 const stored=await recordHeartbeat({serverId:s.id,tokenHash,time,publicKey,snapshot:JSON.stringify(p.snapshot),hostname:p.snapshot.hostname,management:!!p.snapshot.management,capabilities:p.snapshot.agentCapabilities??[],runningJobs:p.runningJobs});
 if(!stored){
  const current=await activeDeviceKey(s.id,tokenHash,time);
  if(!current)throw new HttpError('apiError.agent.notApproved');
  if(current.agent_public_key!=null&&current.agent_public_key!==publicKey)throw new HttpError('apiError.heartbeat.keyChanged');
  throw new HttpError('apiError.heartbeat.intervalTooShort');
 }
 // The history sample runs after the core commit in its own transaction, admitted
 // only for the request that won it. A failure never changes the answer to the
 // agent: the device state is stored, and the next heartbeat writes the next sample.
 try{await recordHeartbeatSample({serverId:s.id,tokenHash,time,publicKey,cpu:p.snapshot.cpu,memory:p.snapshot.memory,gpus:p.snapshot.gpus===undefined?null:JSON.stringify(p.snapshot.gpus)});}
 catch(error){console.error(`ServerDesk: The history sample of device ${s.id} could not be stored: ${errorText(error)}`);}
 // The device's alarms follow the stored snapshot at once. A failure never changes
 // the answer to the agent: it is logged without snapshot data, and the periodic
 // alarm check (runAlertSweep) catches up within a minute.
 try{await syncDeviceAlerts(s.id,time);}
 catch(error){console.error(`ServerDesk: The alarm state of device ${s.id} could not be updated: ${errorText(error)}`);}
 // softwareResync, driverResync and autostartResync ask the agent to send that list
 // (POST /api/agent/software, /drivers, /autostart) again; each appears only when true.
 // They are only hints: on a failure the answer omits that field and the next heartbeat asks again.
 const hint=async(name:string,check:()=>Promise<boolean>)=>{
  try{return await check();}
  catch(error){console.error(`ServerDesk: The ${name} state of device ${s.id} could not be checked: ${errorText(error)}`);return false;}};
 const [resync,drivers,autostart]=await Promise.all([
  hint('software',()=>softwareResyncNeeded(s.id,p.snapshot.softwareChecksum)),
  hint('driver',()=>driverResyncNeeded(s.id,p.snapshot.driverHealth?.checksum)),
  hint('autostart',()=>autostartResyncNeeded(s.id,p.snapshot.autostartChecksum))]);
 return Response.json({ok:true,intervalSeconds:30,...(resync?{softwareResync:true}:{}),...(drivers?{driverResync:true}:{}),...(autostart?{autostartResync:true}:{})},{headers:{'Cache-Control':'no-store'}});
 }catch(e){return failure(e);}}
