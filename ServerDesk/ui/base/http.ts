'use client';
import {documentLocale} from '@/lib/i18n/locale';
import {translate,type MessageParams} from '@/lib/i18n/translate';
import {apiErrorText} from '@/ui/base/api-error-text';
// Session tokens travel only in HttpOnly cookies (docs/portal-sessions.md). This
// module keeps no token in memory and sends no credential header; the browser
// attaches the cookies to same-origin requests. Nothing is stored in localStorage.
let clock:{serverTime:number;monotonicTime:number}|null=null;
let cookieCheck:Promise<boolean>|null=null;
export const SESSION_LOCK_EVENT='serverdesk:session-lock';
export const SESSION_SYNC_EVENT='serverdesk:session-sync';
// Client fallbacks when the service sends no message of its own, in the page language.
const identityMessage=()=>translate(documentLocale(),'session.identityExpired');
const unavailableMessage=()=>translate(documentLocale(),'common.serviceUnavailable');
const requestFailed=(status:number)=>translate(documentLocale(),'common.requestFailed',{status});
// Former credential headers. The server ignores them; the client never sends them.
const strippedHeaders=['X-ServerDesk-Session','X-ServerDesk-Mfa','X-ServerDesk-Embedded'];
/** A failed API request. The message is the text of messageKey in the page language (apiErrorText); branch on code, never on the text. */
export class ApiError extends Error {
 constructor(text:string,public status:number,public code?:string,public messageKey?:string,public params?:MessageParams){super(text);}
}
const paramsOf=(value:unknown):MessageParams|undefined=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).filter(([,item])=>typeof item==='string'||typeof item==='number')):undefined;
const monotonicNow=()=>typeof performance!=='undefined'?performance.now():Date.now();
// Windows clock changes must not shorten a live server session or a remembered
// browser window. Authorization itself is always enforced against server time.
export const portalNow=()=>clock?clock.serverTime+Math.max(0,monotonicNow()-clock.monotonicTime):Date.now();
function sameApi(input:RequestInfo|URL){
 if(typeof window==='undefined')return false;
 try{const url=new URL(input instanceof Request?input.url:String(input),window.location.href);return url.origin===window.location.origin&&url.pathname.startsWith('/api/');}catch{return false;}
}
function apiPath(input:RequestInfo|URL){return new URL(input instanceof Request?input.url:String(input),window.location.href).pathname;}
/** Takes the server clock from a reply of /api/mfa, /api/auth or a passkey login. Called only with parsed replies of our own API. */
export function captureServerClock(url:string,body:Record<string,unknown>|undefined,result:unknown){
 if(!sameApi(url)||!result||typeof result!=='object')return;
 const path=apiPath(url),passkeyLogin=path==='/api/passkeys'&&(body?.action==='authentication-verify'||body?.action==='setup-verify');
 if(path!=='/api/mfa'&&path!=='/api/auth'&&!passkeyLogin)return;
 const data=result as Record<string,unknown>;
 if(typeof data.serverTime==='number'&&Number.isFinite(data.serverTime))clock={serverTime:data.serverTime,monotonicTime:monotonicNow()};
}
const isJson=(response:Response)=>/\bapplication\/(?:[\w.+-]*\+)?json\b/i.test(response.headers.get('Content-Type')??'');
function jsonFailure(status:number,text:string,code?:string){return Response.json({error:text,...(code?{code}:{})},{status,headers:{'Cache-Control':'no-store'}});}
async function normalizedResponse(response:Response):Promise<Response>{
 // The portal API never redirects and always answers with JSON. A redirect, a
 // non-JSON 401/403 or an HTML page comes from something in between (proxy,
 // gateway) and is no verdict on the session: it becomes a code-less 502, so no
 // session lock fires. Only the server's JSON codes end a session, never an
 // uncaught JSON SyntaxError or fetch redirect error.
 if(response.type==='opaqueredirect'||response.status===0||response.redirected||[301,302,303,307,308].includes(response.status))return jsonFailure(502,unavailableMessage());
 if(isJson(response))return response;
 if([401,403].includes(response.status)||(response.ok&&/\btext\/html\b/i.test(response.headers.get('Content-Type')??'')))return jsonFailure(502,unavailableMessage());
 if(!response.ok)return jsonFailure(response.status,unavailableMessage());
 return response; // Scripts and encrypted file blocks are intentional binaries.
}
// One read-only status check at a time. It detects a login that already
// succeeded in another tab through the shared cookie; it never retries a
// mutation and never revives a failed session.
async function sharedSessionIsLive(){
 if(!cookieCheck){
  cookieCheck=(async()=>{
   const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),3000);
   try{
    const response=await fetch('/api/mfa',{credentials:'same-origin',cache:'no-store',redirect:'manual',signal:controller.signal});
    if(!response.ok||!isJson(response))return false;
    const state=await response.json() as {authenticated?:boolean};return state.authenticated===true;
   }catch{return false;}finally{clearTimeout(timer);}
  })().finally(()=>{cookieCheck=null;});
 }
 return cookieCheck;
}
export async function credentialFetch(input:RequestInfo|URL,init:RequestInit={}):Promise<Response>{
 const headers=new Headers(input instanceof Request?input.headers:undefined);new Headers(init.headers).forEach((value,key)=>headers.set(key,value));
 for(const name of strippedHeaders)headers.delete(name);
 const scoped=sameApi(input);
 const raw=await fetch(input,{...init,headers,credentials:'same-origin',...(scoped?{redirect:'manual' as const}:{})});
 const response=scoped?await normalizedResponse(raw):raw;
 if(scoped&&[401,403].includes(response.status)){
  let failure:{code?:string;error?:string}={};try{failure=await response.clone().json();}catch{}
  const code=failure.code,lock=()=>window.dispatchEvent(new CustomEvent(SESSION_LOCK_EVENT,{detail:{code,message:apiErrorText(documentLocale(),failure,identityMessage())}}));
  // A lost identity locks at once. An MFA failure may come from a
  // cookie that another tab has just replaced: one status read decides.
  if(code==='IDENTITY_LOGIN_REQUIRED')lock();
  else if(code==='MFA_LOGIN_REQUIRED'||code==='SESSION_EXPIRED'){
   if(await sharedSessionIsLive())window.dispatchEvent(new Event(SESSION_SYNC_EVENT));else lock();
  }
 }
 return response;
}
/** The failure of an ok answer that is no JSON (common.invalidApiReply), as readApiJson throws it. */
export const invalidApiReply=(status:number)=>new ApiError(translate(documentLocale(),'common.invalidApiReply'),status);
export async function readApiJson<T>(response:Response):Promise<T>{
 let data:unknown;
 try{data=await response.json();}
 catch{throw response.ok?invalidApiReply(response.status):new ApiError(response.status===401?identityMessage():requestFailed(response.status),response.status);}
 if(!response.ok){
  const failure=data&&typeof data==='object'?data as {error?:unknown;code?:unknown;messageKey?:unknown;params?:unknown}:{};
  throw new ApiError(apiErrorText(documentLocale(),failure,requestFailed(response.status)),response.status,typeof failure.code==='string'?failure.code:undefined,typeof failure.messageKey==='string'?failure.messageKey:undefined,paramsOf(failure.params));
 }
 return data as T;
}
