// Security alarms of the portal itself (docs/entra-id.md, "Emergency access"):
// every emergency sign-in writes one (lib/server/identity/entra/emergency.ts). Global Owners see
// the open ones in the console (consoleEmergencyAlarms) until another Owner
// acknowledges them (POST /api/security-alarms). The account that signed in
// never acknowledges its own alarm, so the person who used the emergency
// access cannot hide it.
import {guid,HttpError,now} from '../context';
import {auditAfterChange,auditEvent} from '../audit';
import {can,viewerCanSql} from './policy/can';
import {mfaSessionFence,requireLiveSessions} from './mfa';
import type {Viewer} from '../../types';
import {commitAll,db,sql} from '../db';

/** Console data for global Owners: the number of open emergency sign-ins and the newest one. */
export type EmergencyAlarms={open:number;latest:{id:string;at:number;displayName:string;address:string;own:boolean}|null};

/** The open emergency sign-in alarms; `own` marks the viewer's own sign-in (it cannot acknowledge it). */
export async function consoleEmergencyAlarms(v:Viewer):Promise<EmergencyAlarms>{
 const [count,latest]=await Promise.all([
  db().one<{open:number}>(sql`SELECT count(*)::int AS open FROM security_alarms WHERE acknowledged_at IS NULL`),
  db().one<{id:string;occurred_at:number;display_name:string;address:string;user_id:string}>(sql`SELECT id,occurred_at,display_name,address,user_id FROM security_alarms WHERE acknowledged_at IS NULL ORDER BY occurred_at DESC,id DESC LIMIT 1`),
 ]);
 return {open:Number(count?.open??0),latest:latest?{id:latest.id,at:Number(latest.occurred_at),displayName:latest.display_name,address:latest.address,own:latest.user_id===v.userId}:null};
}

/**
 * POST /api/security-alarms {action:'acknowledge', id}: a global Owner with
 * live sessions (no step-up) acknowledges one open alarm, never the alarm of
 * its own sign-in (apiError.alarm.ownEmergency). An alarm acknowledged
 * meanwhile answers apiError.alarm.changed. One audit row
 * auth.emergency.acknowledge per acknowledged alarm.
 */
export async function acknowledgeSecurityAlarm(request:Request,v:Viewer,p:Record<string,unknown>):Promise<{ok:true;alarms:EmergencyAlarms}>{
 if(p.action!=='acknowledge')throw new HttpError('apiError.request.unknownAction');
 if(!await can(v,'instance.owner'))throw new HttpError('apiError.policy.permissionMissing');
 if(!guid(p.id))throw new HttpError('apiError.alarm.changed');
 const id=p.id as string,d=db();
 const alarm=await d.one<{user_id:string;acknowledged_at:number|null}>(sql`SELECT user_id,acknowledged_at FROM security_alarms WHERE id=${id}`);
 if(!alarm||alarm.acknowledged_at!==null)throw new HttpError('apiError.alarm.changed');
 if(alarm.user_id===v.userId)throw new HttpError('apiError.alarm.ownEmergency');
 const fence=await mfaSessionFence(request,v),time=now();
 const results=await commitAll([
  sql`UPDATE security_alarms SET acknowledged_at=${time},acknowledged_by=${v.label} WHERE id=${id} AND acknowledged_at IS NULL AND user_id<>${v.userId??''} AND (${viewerCanSql(v,'instance.owner')}) AND (${fence})`,
  ...auditEvent({actor:v.label,action:'auth.emergency.acknowledge',target:`alarm=${id}`,guard:auditAfterChange}),
 ]);
 if(!results[0].rowCount){
  await requireLiveSessions(request,v);
  if(!await can(v,'instance.owner',{fresh:true}))throw new HttpError('apiError.policy.permissionMissing');
  throw new HttpError('apiError.alarm.changed');
 }
 return {ok:true,alarms:await consoleEmergencyAlarms(v)};
}
