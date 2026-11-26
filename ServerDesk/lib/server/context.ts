import { env } from 'cloudflare:workers';
import { headers } from 'next/headers';
import type { Viewer } from '../types';
import {classifyFailure} from './errors/failure';
import {HttpError} from '../errors/http-error';
import {db,sql} from './db';
export function config(key:string):string { return String((env as unknown as Record<string,unknown>)[key]??''); }
export {HttpError} from '../errors/http-error';
export const now=()=>Date.now();
export const guid=(s:unknown):s is string=>typeof s==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
export const random=()=>{const bytes=crypto.getRandomValues(new Uint8Array(32));return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');};
export async function hash(value:string){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');}
export async function viewer():Promise<Viewer|null>{
 const {localIdentity}=await import('./identity/local-auth');return localIdentity(new Request(config('SITE_ORIGIN')||'https://serverdesk.invalid',{headers:await headers()}));
}
export async function requireAuthIdentity(request:Request){const {localIdentity}=await import('./identity/local-auth');const v=await localIdentity(request);if(!v)throw new HttpError('apiError.auth.loginRequired');return v;}
// Every right is checked by the caller: requireCan(v,'instance.owner') (lib/server/identity/policy/can.ts) or the device and portal permission helpers in lib/server/identity/access.ts.
export async function requireIdentity(){
 const v=await viewer();if(!v)throw new HttpError('apiError.auth.loginRequired');return v;
}
export async function requireViewer(){
 const v=await requireIdentity(),h=await headers();
 // Every human API passes through this gate. Reading data and background polling
 // deliberately never renew the browser session's inactivity deadline.
 const {requireMfa}=await import('./identity/mfa');
 const request=new Request(config('SITE_ORIGIN')||'https://serverdesk.invalid',{headers:h});await requireMfa(request,v);
 const {requireBoundLocalMfa}=await import('./identity/local-auth');await requireBoundLocalMfa(request,v);
 return v;
}
export function sameOrigin(request:Request){const origin=request.headers.get('origin');if(origin!==config('SITE_ORIGIN'))throw new HttpError('apiError.request.invalidOrigin');}
export async function body(request:Request,limit=256000){
 if(Number(request.headers.get('content-length')??0)>limit)throw new HttpError('apiError.request.tooLarge');
 const chunks:Uint8Array[]=[],reader=request.body?.getReader();let length=0;
 if(reader){try{while(true){const chunk=await reader.read();if(chunk.done)break;length+=chunk.value.byteLength;if(length>limit){await reader.cancel();throw new HttpError('apiError.request.tooLarge');}chunks.push(chunk.value);}}finally{reader.releaseLock();}}
 const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 try{const parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('Expected an object');return parsed;}catch{throw new HttpError('apiError.request.invalidJson');}
}
// The API error contract (lib/server/errors/failure.ts): {error, code, messageKey, params?}
// for an HttpError as thrown; otherwise a registered trigger conflict
// (lib/server/errors/db-codes.ts), 400 VALIDATION_FAILED for a ZodError, 503
// STORAGE_UNAVAILABLE only for storage and connection failures, and 500
// INTERNAL_ERROR with a logged reference for everything else.
export function failure(e:unknown){
 const answer=classifyFailure(e);
 console.error(answer.log);
 return Response.json(answer.body,{status:answer.status,headers:{'Cache-Control':'no-store'}});
}
// Device events are associated with immutable IDs at the operation itself.
// A campaign creates independent rows so scoped viewers never see other devices.
export async function log(actor:string,action:string,target:string,serverIds?:string|string[]){
 const ids=serverIds===undefined?[null]:[...new Set(Array.isArray(serverIds)?serverIds:[serverIds])];
 if(ids.some(id=>id!==null&&!guid(id)))throw new Error('Ungültige Gerätezuordnung für das Zugriffsprotokoll.');
 if(!ids.length)return;
 const at=now();
 // One statement for all rows, so they commit together.
 await db().exec(sql`INSERT INTO audit (at,actor,action,target,server_id,scope) VALUES ${sql.join(ids.map(id=>sql`(${at},${actor},${action},${target},${id},${id===null?'portal':'device'})`))}`);
}
