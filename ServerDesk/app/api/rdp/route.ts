import {z} from 'zod';
import {body,failure,guid,HttpError,log,requireIdentity,sameOrigin} from '@/lib/server/context';
import {principal} from '@/lib/server/identity/access';
import {requireMfa} from '@/lib/server/identity/mfa';
import {browserRdpExchange,browserRdpReceive,browserRdpSignal,closeAuthorizedRdp,openRdp,ownedRdp,rdpBrowserExchange,rdpBrowserReceive,rdpBrowserSignal,rdpId,rdpMetadata,rdpRtcDescription} from '@/lib/server/devices/rdp';
import {routeAuditActions} from '@/lib/audit-actions';
const headers={'Cache-Control':'no-store'};
const envelope=z.string().length(344).regex(/^[A-Za-z0-9+/]{342}==$/).refine(value=>{try{return atob(value).length===256&&btoa(atob(value))===value;}catch{return false;}});
const schema=z.union([z.object({action:z.literal('open'),id:rdpId,serverId:z.guid(),keyEnvelope:envelope}).strict(),z.object({action:z.literal('open'),id:rdpId,serverId:z.guid(),keyEnvelope:envelope,transport:z.literal('webrtc'),offer:rdpRtcDescription}).strict(),rdpBrowserSignal,rdpBrowserExchange,rdpBrowserReceive,z.object({action:z.literal('close'),id:rdpId,confirm:z.boolean().optional()}).strict()]);
export async function GET(request:Request){try{const v=await requireIdentity();await requireMfa(request,v);const id=new URL(request.url).searchParams.get('serverId');if(!guid(id))throw new HttpError('apiError.device.invalid');return Response.json(await rdpMetadata(id,v),{headers});}catch(e){return failure(e);}}
export async function POST(request:Request){try{
 sameOrigin(request);const v=await requireIdentity(),parsed=schema.safeParse(await body(request,380_000));if(!parsed.success)throw new HttpError('apiError.rdp.invalidRequest');const p=parsed.data;
 if(p.action!=='close')await requireMfa(request,v);
 if(p.action==='open'){const result=await openRdp(request,v,p.id,p.serverId,p.keyEnvelope,'transport' in p?{transport:p.transport,offer:p.offer}:undefined);await log(v.label,routeAuditActions.rdpOpened,p.id,p.serverId);return Response.json(result,{headers});}
 if(p.action==='signal')return Response.json(await browserRdpSignal(v,p.id),{headers});
 if(p.action==='exchange')return Response.json(await browserRdpExchange(v,p.id,p.ack,p.frames,p.receive),{headers});
 if(p.action==='receive')return Response.json(await browserRdpReceive(v,p.id,p.ack,p.waitMs,request.signal,p.inputAck),{headers});
 const s=await ownedRdp(p.id,v,true);if(s.principal!==principal(v)){await requireMfa(request,v);if(p.confirm!==true)throw new HttpError('apiError.rdp.confirmCloseForeign');}
 await closeAuthorizedRdp(v,s.id,s.principal!==principal(v)?'Durch Administrator geschlossen':null);await log(v.label,routeAuditActions.rdpClosed,s.id,s.server_id);return Response.json({ok:true},{headers});
}catch(e){if(request.signal.aborted||e instanceof DOMException&&e.name==='AbortError')return new Response(null,{status:499,headers});return failure(e);}}
