'use client';
import type {Server,Viewer} from '@/lib/types';
import {deviceConnection} from '@/ui/base/ui-device';
import {credentialFetch,captureServerClock,readApiJson} from '@/ui/base/http';
import {isOwner} from '@/ui/base/access-capabilities';
import {defaultLocale,documentLocale,type Locale} from '@/lib/i18n/locale';
import {EMPTY_VALUE,formatDateTime} from '@/lib/i18n/format';
import {translate} from '@/lib/i18n/translate';
import {apiErrorText} from '@/ui/base/api-error-text';
export {credentialFetch,readApiJson,invalidApiReply,ApiError} from '@/ui/base/http';
export type Device=Server&{permissions?:string[];groupId?:string|null;groupName?:string|null;maintenanceUntil?:number|null};
export type V3Props={server:Device;viewer:Viewer;demo:boolean;onRefresh?:()=>Promise<void>|void};
export async function api<T>(url:string,body?:Record<string,unknown>,signal?:AbortSignal):Promise<T>{const r=await credentialFetch(url,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined,cache:'no-store',signal});const result=await readApiJson<T>(r);signal?.throwIfAborted();captureServerClock(url,body,result);if(body&&typeof window!=='undefined'&&/^\/api\/(diagnostics|runbooks|releases|transfers|plugins)(\?|$)/.test(url))window.dispatchEvent(new Event('serverdesk:refresh'));return result as T;}
/** The message of a failed request; the fallback follows the page language unless a locale is given. */
/** The text of a failure in the locale: a keyed error (ApiError, a client-side HttpError) through apiErrorText, else its message. */
export const message=(e:unknown,locale:Locale=documentLocale())=>e instanceof Error?typeof (e as {messageKey?:unknown}).messageKey==='string'?apiErrorText(locale,{...e,error:e.message}):e.message:translate(locale,'common.requestIncomplete');
export const stamp=(n:number|string|null|undefined,locale:Locale=defaultLocale)=>n?formatDateTime(locale,n):EMPTY_VALUE;
export const permitted=(server:Device,viewer:Viewer,right:string)=>isOwner(viewer)||server.permissions?.includes(right)===true;
export const online=(server:Device)=>deviceConnection(server,Date.now()).kind==='online';
export const v3=(server:Device)=>server.snapshot?.protocolVersion===3;
export function downloadText(name:string,text:string,type='application/json'){const url=URL.createObjectURL(new Blob([text],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}
