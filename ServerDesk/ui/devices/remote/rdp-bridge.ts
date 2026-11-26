import {translate} from '@/lib/i18n/translate';
import {documentLocale} from '@/lib/i18n/locale';
import {apiErrorText} from '@/ui/base/api-error-text';
import type {ServerMessage} from '@/lib/server-messages';
export const RDP_BRIDGE='serverdesk:rdp:bridge';
export const RDP_BRIDGE_PROTOCOL=2;
export const RDP_CANCEL='serverdesk:rdp:cancel';
export const RDP_ACTIVITY='serverdesk:rdp:activity';
export const RDP_PARENT_ACTIVITY='serverdesk:rdp:trusted-activity';
export type RdpAvailability={available?:boolean;featureStatus?:'available'|'paused';ready?:boolean;reason?:ServerMessage|null;online?:boolean;capable?:boolean;webrtcCapable?:boolean;management?:boolean;enabled?:boolean;nla?:boolean|null;port?:number|null;policyBlocked?:boolean;code?:string};
export type RdpSession={id:string;state:string;transport?:'webrtc'|'mailbox';error?:string|null;/** The owner's name (lib/server/devices/rdp.ts), null when it cannot be named. */owner?:string|null;isOwn?:boolean;canClose?:boolean;createdAt?:number;expiresAt?:number|string};
export type RdpMetadata={publicKey?:JsonWebKey;hostname?:string|null;sessions?:RdpSession[];activeSessions?:RdpSession[];availability?:RdpAvailability;maxSessions?:number};
export const rdpAvailable=(availability:RdpAvailability|undefined)=>!!availability&&availability.available!==false&&availability.ready!==false&&availability.online!==false&&availability.capable!==false&&availability.management!==false&&availability.enabled===true&&availability.policyBlocked!==true&&!availability.reason;
export function rdpLogonAccount(username:string,local:boolean,domain:string,hostname:string|null|undefined){
 const parts=username.trim().split('\\');if(parts.length>2||parts.some(part=>!part.trim()))throw new Error(translate(documentLocale(),'rdp.account.invalid'));
 const name=parts[parts.length-1].trim(),explicit=parts.length===2?parts[0].trim():null;
 const useLocal=explicit==='.'||explicit===null&&local;
 if(useLocal&&(!hostname||hostname.length>253))throw new Error(translate(documentLocale(),'rdp.account.noHost'));
 return {username:name,domain:useLocal?hostname!:explicit??(name.includes('@')?'':domain.trim())};
}
export const rdpGuid=(id:unknown):id is string=>typeof id==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id);
export function validatedRdpBridge(body:unknown,serverId:string,owned:Set<string>):Record<string,unknown>|null{
 if(!body||typeof body!=='object'||Array.isArray(body))return null;
 const p=body as Record<string,unknown>;
 if(p.action==='metadata')return p.serverId===serverId&&Object.keys(p).length===2?{action:'metadata',serverId}:null;
 if(p.action==='open'){
  if(p.serverId!==serverId||!rdpGuid(p.id)||typeof p.keyEnvelope!=='string'||p.keyEnvelope.length>2048||!/^[A-Za-z0-9+/]+={0,2}$/.test(p.keyEnvelope))return null;
  if(Object.keys(p).length===4)return {action:'open',serverId,id:p.id,keyEnvelope:p.keyEnvelope};
  if(Object.keys(p).length!==6||p.transport!=='webrtc'||typeof p.offer!=='string'||p.offer.length<24||p.offer.length>65536||p.offer.length%4!==0||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(p.offer))return null;
  try{if(btoa(atob(p.offer))!==p.offer||atob(p.offer).length<17)return null;}catch{return null;}
  return {action:'open',serverId,id:p.id,keyEnvelope:p.keyEnvelope,transport:'webrtc',offer:p.offer};
 }
 if(!rdpGuid(p.id)||!owned.has(p.id))return null;
 if(p.action==='close')return Object.keys(p).length===2?{action:'close',id:p.id}:null;
 if(p.action==='signal')return Object.keys(p).length===2?{action:'signal',id:p.id}:null;
 if(typeof p.ack!=='number'||!Number.isSafeInteger(p.ack)||p.ack<0)return null;
 if(p.action==='receive'){
  const hinted=Object.hasOwn(p,'inputAck');
  if(Object.keys(p).length!==(hinted?5:4)||!Number.isInteger(p.waitMs)||Number(p.waitMs)<0||Number(p.waitMs)>600||hinted&&(typeof p.inputAck!=='number'||!Number.isSafeInteger(p.inputAck)||p.inputAck<0))return null;
  return {action:'receive',id:p.id,ack:p.ack,waitMs:p.waitMs,...(hinted?{inputAck:p.inputAck}:{})};
 }
 const separate=p.receive===false;
 if(p.action!=='exchange'||Object.keys(p).length!==(separate?5:4)||!Array.isArray(p.frames)||p.frames.length>16)return null;
 const frames=[];for(const f of p.frames){if(!f||typeof f!=='object'||Array.isArray(f)||Object.keys(f).length!==2||!Number.isSafeInteger(f.seq)||f.seq<1||typeof f.data!=='string'||f.data.length>21868||!/^[A-Za-z0-9+/]+={0,2}$/.test(f.data))return null;frames.push({seq:f.seq,data:f.data});}
 return {action:'exchange',id:p.id,ack:p.ack,frames,...(separate?{receive:false}:{})};
}

export function createRdpChildBridge(serverId:string){
 let disposed=false,protocol=0;const pending=new Map<string,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>;cleanup:()=>void}>();
 const receive=(event:MessageEvent)=>{
  if(event.origin!==window.location.origin||event.source!==window.parent||!event.data||event.data.type!==RDP_BRIDGE||event.data.serverId!==serverId)return;
  const id=event.data.requestId;if(typeof id!=='string')return;const item=pending.get(id);if(!item)return;pending.delete(id);clearTimeout(item.timer);item.cleanup();
  // This version belongs to the parent JavaScript, not the backend metadata:
  // an already-open old dashboard can forward a new server response unchanged.
  protocol=Number.isSafeInteger(event.data.bridgeProtocol)&&event.data.bridgeProtocol>0?event.data.bridgeProtocol:0;
  if(event.data.ok===true)item.resolve(event.data.result);else {const error=new Error(apiErrorText(documentLocale(),event.data,translate(documentLocale(),'rdp.bridge.failed')));Object.assign(error,{status:event.data.status,code:event.data.code});item.reject(error);}
 };
 window.addEventListener('message',receive);
 return {
  get protocol(){return protocol;},
  request(body:Record<string,unknown>,signal?:AbortSignal):Promise<unknown>{
   if(disposed||signal?.aborted)return Promise.reject(new DOMException(translate(documentLocale(),'rdp.bridge.ended'),'AbortError'));
   if(window.parent===window)return Promise.reject(new Error(translate(documentLocale(),'rdp.bridge.openFromDevice')));
   if(pending.size>=4)return Promise.reject(new Error('Zu viele gleichzeitige RDP-Anfragen.'));
   const requestId=crypto.randomUUID();return new Promise((resolve,reject)=>{
    const cancel=()=>window.parent.postMessage({type:RDP_CANCEL,serverId,requestId},window.location.origin);
    const stop=()=>{const item=pending.get(requestId);if(!item)return;pending.delete(requestId);clearTimeout(item.timer);item.cleanup();cancel();reject(new DOMException(translate(documentLocale(),'rdp.bridge.aborted'),'AbortError'));};
    const timer=setTimeout(()=>{pending.delete(requestId);signal?.removeEventListener('abort',stop);cancel();reject(Object.assign(new Error(translate(documentLocale(),'rdp.bridge.timeout')),{name:'TimeoutError',code:'RDP_BRIDGE_TIMEOUT',status:504}));},12000);
    pending.set(requestId,{resolve,reject,timer,cleanup:()=>signal?.removeEventListener('abort',stop)});signal?.addEventListener('abort',stop,{once:true});
    window.parent.postMessage({type:RDP_BRIDGE,serverId,requestId,body},window.location.origin);
   });
  },
  dispose(){disposed=true;window.removeEventListener('message',receive);for(const [requestId,item] of pending){clearTimeout(item.timer);item.cleanup();window.parent.postMessage({type:RDP_CANCEL,serverId,requestId},window.location.origin);item.reject(new DOMException(translate(documentLocale(),'rdp.bridge.closed'),'AbortError'));}pending.clear();},
 };
}
