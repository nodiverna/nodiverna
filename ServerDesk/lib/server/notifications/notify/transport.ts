// The one way out for notifications (docs/notifications.md): every connection to
// a channel target goes through this module. Before each connection the host is
// resolved and every address must pass isAllowedTarget; the socket then opens
// the checked address (DNS pinning through a lookup function), with SNI and Host
// set to the host name, so a second DNS answer cannot redirect it. Redirects are
// never followed, connect and total time are limited, bodies and responses are
// capped, and a failed send is tried again at most twice for errors that can pass.
// Every failure is one NotifyError with a reason; its catalog key is
// apiError.notify.<reason>. No message here carries a socket text, a URL or a secret.
import {lookup as dnsLookup} from 'node:dns/promises';
import {isIP,type LookupFunction} from 'node:net';
import {request as nodeHttpsRequest} from 'node:https';
import type {IncomingMessage} from 'node:http';

export type NotifyFailureReason='dnsFailed'|'targetBlocked'|'connectFailed'|'timeout'|'tlsFailed'|'starttlsMissing'|'authFailed'|'authMfaRequired'|'authBasicDisabled'|'recipientRejected'|'smtpRejected'|'httpRejected'|'httpStatus'|'redirect'|'tooLarge'|'secretUndecryptable'
 |'microsoftSignInRefused'|'microsoftSecretExpired'|'microsoftPermissionMissing'|'googleSignInRefused'|'googleDelegationMissing'|'mailboxNotFound';
export const notifyFailureReasons:readonly NotifyFailureReason[]=['dnsFailed','targetBlocked','connectFailed','timeout','tlsFailed','starttlsMissing','authFailed','authMfaRequired','authBasicDisabled','recipientRejected','smtpRejected','httpRejected','httpStatus','redirect','tooLarge','secretUndecryptable',
 'microsoftSignInRefused','microsoftSecretExpired','microsoftPermissionMissing','googleSignInRefused','googleDelegationMissing','mailboxNotFound'];
export type NotifyErrorKey=`apiError.notify.${NotifyFailureReason}`;
export const notifyErrorKey=(reason:NotifyFailureReason):NotifyErrorKey=>`apiError.notify.${reason}`;

/** A failed send. `retryable` decides whether the retry loop tries again; params fill the catalog text. */
export class NotifyError extends Error{
 readonly reason:NotifyFailureReason;readonly params:Record<string,string|number>;readonly retryable:boolean;
 constructor(reason:NotifyFailureReason,{params={},retryable}:{params?:Record<string,string|number>;retryable?:boolean}={}){
  super(notifyErrorKey(reason));
  this.name='NotifyError';this.reason=reason;this.params=params;
  this.retryable=retryable??(reason==='dnsFailed'||reason==='connectFailed'||reason==='timeout');
 }
 get key():NotifyErrorKey{return notifyErrorKey(this.reason);}
}

/** DNS lookup 3 s, connect 5 s, 10 s per attempt in total, 64 KiB per request (Teams 24 KiB), 16 KiB of a response. */
export const notifyLimits={dnsMs:3000,connectMs:5000,totalMs:10_000,bodyBytes:64*1024,teamsBodyBytes:24*1024,responseBytes:16*1024};
/** Three attempts per send: the first, then after 1 s and after 4 s. */
export const notifyBackoffMs:readonly number[]=[1000,4000];

// ---- Target check -------------------------------------------------------------

type Range=[bigint,bigint];
const big=BigInt,zero=big(0),one=big(1),sixteen=big(16);
const v4=(text:string):number|null=>{
 const parts=text.split('.');
 if(parts.length!==4||parts.some(part=>!/^\d{1,3}$/.test(part)||Number(part)>255))return null;
 return parts.reduce((value,part)=>value*256+Number(part),0);
};
const v4Range=(cidr:string):[number,number]=>{const [base,bits]=cidr.split('/'),start=v4(base)!,size=2**(32-Number(bits));return [start,start+size-1];};
// Never a target: this host, link-local, multicast, reserved, the Alibaba metadata
// address, documentation (RFC 5737), benchmarking (RFC 2544) and the 6to4 relay anycast (RFC 7526).
const v4Always=['0.0.0.0/8','127.0.0.0/8','169.254.0.0/16','224.0.0.0/4','240.0.0.0/4','100.100.100.200/32',
 '192.0.2.0/24','198.51.100.0/24','203.0.113.0/24','198.18.0.0/15','192.88.99.0/24'].map(v4Range);
const v4Private=['10.0.0.0/8','172.16.0.0/12','192.168.0.0/16','100.64.0.0/10'].map(v4Range);
function v4Allowed(value:number,allowPrivate:boolean){
 if(v4Always.some(([start,end])=>value>=start&&value<=end))return false;
 return allowPrivate||!v4Private.some(([start,end])=>value>=start&&value<=end);
}
/** The 128-bit value of an IPv6 address (with an embedded dotted IPv4 tail), or null. */
function v6(text:string):bigint|null{
 let address=text.toLowerCase();
 const zone=address.indexOf('%');if(zone>=0)address=address.slice(0,zone);
 const tail=/(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
 if(tail){const value=v4(tail[1]);if(value===null)return null;address=address.slice(0,-tail[1].length)+(value>>>16).toString(16)+':'+(value&0xffff).toString(16);}
 const halves=address.split('::');
 if(halves.length>2)return null;
 const head=halves[0]?halves[0].split(':'):[],rest=halves.length===2&&halves[1]?halves[1].split(':'):[];
 const missing=8-head.length-rest.length;
 if(halves.length===1?missing!==0:missing<1)return null;
 const groups=[...head,...Array(halves.length===2?missing:0).fill('0'),...rest];
 if(groups.some(group=>!/^[0-9a-f]{1,4}$/.test(group)))return null;
 return groups.reduce((value,group)=>(value<<sixteen)|big(parseInt(group,16)),zero);
}
const v6Range=(cidr:string):Range=>{const [base,bits]=cidr.split('/'),start=v6(base)!,size=one<<big(128-Number(bits));return [start,start+size-one];};
const inRange=(value:bigint,[start,end]:Range)=>value>=start&&value<=end;
// Never a target: unspecified, loopback, link-local, multicast, the AWS metadata
// address, documentation (RFC 3849, RFC 9637), 6to4 (RFC 3056) and Teredo (RFC 4380).
// 6to4 and Teredo are refused as a whole; their embedded IPv4 is not decoded.
const v6Always=['::/128','::1/128','fe80::/10','ff00::/8','fd00:ec2::254/128','2001:db8::/32','3fff::/20','2002::/16','2001::/32'].map(v6Range);
const v6Private=['fc00::/7'].map(v6Range);
// IPv4 inside IPv6: mapped (::ffff:a.b.c.d), translated (::ffff:0:a.b.c.d),
// IPv4-in-IPv6 (::a.b.c.d) and NAT64 (64:ff9b::a.b.c.d). They count as the IPv4 address.
const embedded=[v6Range('::ffff:0:0/96'),v6Range('::ffff:0:0:0/96'),v6Range('::/96'),v6Range('64:ff9b::/96')];
const blockedNames=new Set(['localhost','metadata.google.internal']);

/**
 * Whether a resolved address may be a target. Always refused: loopback,
 * unspecified, link-local (also 169.254.169.254), fd00:ec2::254, multicast,
 * broadcast and reserved IPv4, 100.100.100.200, the documentation ranges
 * (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24, 2001:db8::/32, 3fff::/20),
 * benchmarking (198.18.0.0/15), the 6to4 relay anycast (192.88.99.0/24), 6to4
 * (2002::/16), Teredo (2001::/32), and the IPv4-in-IPv6 forms of the IPv4
 * ranges. Private ranges (10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7)
 * only with allowPrivate (NOTIFY_ALLOW_PRIVATE_TARGETS=true). Anything that is
 * no IP address is refused.
 */
export function isAllowedTarget(address:string,allowPrivate=false):boolean{
 const text=address.replace(/^\[|\]$/g,'');
 if(isIP(text)===4)return v4Allowed(v4(text)!,allowPrivate);
 if(isIP(text)!==6)return false;
 const value=v6(text);
 if(value===null)return false;
 if(v6Always.some(range=>inRange(value,range)))return false;
 const mapped=embedded.find(range=>inRange(value,range));
 if(mapped)return v4Allowed(Number(value-mapped[0]),allowPrivate);
 return allowPrivate||!v6Private.some(range=>inRange(value,range));
}
/** Host names that are refused before any lookup: localhost (and below it) and the metadata host. */
export function isBlockedHostName(host:string):boolean{
 const name=host.toLowerCase().replace(/\.$/,'');
 return blockedNames.has(name)||name.endsWith('.localhost');
}

export type ResolvedAddress={address:string;family:4|6};
export type Resolver=(host:string)=>Promise<ResolvedAddress[]>;
const systemResolver:Resolver=async host=>(await dnsLookup(host,{all:true,verbatim:true})).map(entry=>({address:entry.address,family:entry.family===6?6:4}));

/** Options of one connection. resolver, routeAddress and routePort exist for the tests. */
export type TransportOptions={
 allowPrivate?:boolean;
 resolver?:Resolver;
 /** Tests only: the address the socket opens for a checked address (the check itself is unchanged). */
 routeAddress?:(address:string)=>string;
 /** Tests only: the port the socket opens for a host and its port, so a fixed provider host (port 443 or 465) reaches a local fake server. */
 routePort?:(host:string,port:number)=>number;
 /** Extra trusted certificates (tests); the system store applies otherwise. */
 ca?:string|string[];
 dnsMs?:number;connectMs?:number;totalMs?:number;responseBytes?:number;
};

/**
 * Resolves the host and checks every address: one refused address refuses the
 * host. An IP literal is checked as it is. Returns the first address, which the
 * connection then uses. The lookup has its own time limit (dnsMs): a resolver
 * that does not answer in time fails as dnsFailed, and its late answer is ignored.
 */
export async function checkedTarget(host:string,{allowPrivate=false,resolver=systemResolver,dnsMs=notifyLimits.dnsMs}:Pick<TransportOptions,'allowPrivate'|'resolver'|'dnsMs'>={}):Promise<ResolvedAddress>{
 const name=host.replace(/^\[|\]$/g,'');
 if(isBlockedHostName(name))throw new NotifyError('targetBlocked');
 const family=isIP(name);
 if(family){if(!isAllowedTarget(name,allowPrivate))throw new NotifyError('targetBlocked');return {address:name,family:family===6?6:4};}
 let addresses:ResolvedAddress[],timer:ReturnType<typeof setTimeout>|undefined;
 try{
  addresses=await Promise.race([
   resolver(name),
   new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new NotifyError('dnsFailed')),dnsMs);}),
  ]);
 }catch{throw new NotifyError('dnsFailed');}
 finally{clearTimeout(timer);}
 if(!addresses.length)throw new NotifyError('dnsFailed');
 if(addresses.some(entry=>!isAllowedTarget(entry.address,allowPrivate)))throw new NotifyError('targetBlocked');
 return addresses[0];
}
/** A lookup function that answers every query with the checked address. */
export function pinnedLookup(address:string,family:4|6):LookupFunction{
 return ((_host:string,options:unknown,callback?:unknown)=>{
  const done=(typeof options==='function'?options:callback) as (error:Error|null,address:string|{address:string;family:number}[],family?:number)=>void;
  if(typeof options==='object'&&options!==null&&(options as {all?:boolean}).all)done(null,[{address,family}]);
  else done(null,address,family);
 }) as LookupFunction;
}

// ---- Error mapping --------------------------------------------------------------

const tlsCodes=/^(CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|ERR_TLS_|ERR_SSL_|HOSTNAME_MISMATCH)/;
/** The reason of a socket or TLS error. */
export function socketFailure(error:unknown):NotifyError{
 if(error instanceof NotifyError)return error;
 const code=String((error as {code?:unknown})?.code??'');
 if(code==='ENOTFOUND'||code==='EAI_AGAIN')return new NotifyError('dnsFailed');
 if(code==='ETIMEDOUT')return new NotifyError('timeout');
 if(tlsCodes.test(code)||/certificate|ssl|tls/i.test(String((error as {message?:unknown})?.message??'')))return new NotifyError('tlsFailed');
 return new NotifyError('connectFailed');
}

// ---- HTTPS ------------------------------------------------------------------------

/** `readBody`: the result also carries the answer body, and every status that is no redirect comes back for the caller to map. */
export type HttpPost={url:string;body:string;headers:Record<string,string>;maxBodyBytes:number;readBody?:boolean};
/** A request of another method (GET sends no body) and its own User-Agent; the device assistant uses it (lib/server/devices/assistant-provider.ts). */
export type HttpRequest=Omit<HttpPost,'body'>&{method:'GET'|'POST';body?:string;userAgent?:string};
/** truncated: the answer was longer than responseBytes and body holds only its start (readBody only). */
export type HttpResult={status:number;body?:string;truncated?:boolean};
/** Whether a status can pass on a new attempt: 408, 429 and 5xx. */
export const httpStatusRetryable=(status:number)=>status===408||status===429||status>=500;
/** The failure of a status that is no 2xx: a 3xx is redirect, 400 and 422 are httpRejected, another is httpStatus (retryable for 408, 429 and 5xx). */
export function httpStatusFailure(status:number):NotifyError{
 if(status>=300&&status<400)return new NotifyError('redirect');
 if(status===400||status===422)return new NotifyError('httpRejected',{params:{status}});
 return new NotifyError('httpStatus',{params:{status},retryable:httpStatusRetryable(status)});
}

/**
 * One HTTPS POST attempt to the checked address. https: only and no user info
 * (the channel validation already ensures both). A body over maxBodyBytes is
 * refused with tooLarge; the caller shortens messages before. The caller sets
 * the content type (JSON, or application/x-www-form-urlencoded for a token
 * request). Success is a 2xx status; a 3xx is the failure redirect and is never
 * followed; other statuses fail as httpStatusFailure says. With readBody the
 * result carries the answer body (UTF-8, at most responseBytes), and every
 * status but a redirect comes back, so the caller can map the error in the body.
 * Without readBody the result is only {status}, as before.
 */
export async function httpsPost(post:HttpPost,options:TransportOptions={}):Promise<HttpResult>{return httpsRequest({...post,method:'POST'},options);}

/**
 * One HTTPS attempt with the rules of httpsPost for POST and GET. A GET sends
 * no body and no Content-Length. userAgent replaces the notification User-Agent.
 */
export async function httpsRequest({url,body='',headers,maxBodyBytes,readBody=false,method,userAgent='Nodiverna-Notifications'}:HttpRequest,options:TransportOptions={}):Promise<HttpResult>{
 const target=new URL(url);
 if(target.protocol!=='https:'||target.username||target.password)throw new NotifyError('targetBlocked');
 const bytes=Buffer.byteLength(body);
 if(bytes>maxBodyBytes)throw new NotifyError('tooLarge');
 const host=target.hostname,checked=await checkedTarget(host,options);
 const address=options.routeAddress?.(checked.address)??checked.address;
 const connectMs=options.connectMs??notifyLimits.connectMs,totalMs=options.totalMs??notifyLimits.totalMs,responseBytes=options.responseBytes??notifyLimits.responseBytes;
 const name=host.replace(/^\[|\]$/g,''),port=target.port?Number(target.port):443;
 return new Promise<HttpResult>((resolve,reject)=>{
  let settled=false;
  const finish=(error:NotifyError|null,result?:HttpResult)=>{if(settled)return;settled=true;clearTimeout(total);clearTimeout(connect);if(error)reject(error);else resolve(result!);};
  const request=nodeHttpsRequest({
   host:name,port:options.routePort?.(name,port)??port,path:`${target.pathname}${target.search}`,method,
   servername:isIP(name)?undefined:name,lookup:pinnedLookup(address,isIP(address)===6?6:4),agent:false,ca:options.ca,rejectUnauthorized:true,
   headers:{...headers,Host:target.host,...(method==='POST'?{'Content-Length':String(bytes)}:{}),'User-Agent':userAgent},
  },(response:IncomingMessage)=>{
   const status=response.statusCode??0,chunks:Buffer[]=[];let read=0,truncated=false;
   const done=()=>{
    if(status>=300&&status<400)finish(new NotifyError('redirect'));
    else if(readBody)finish(null,{status,body:Buffer.concat(chunks).subarray(0,responseBytes).toString('utf8'),...(truncated?{truncated:true}:{})});
    else if(status>=200&&status<300)finish(null,{status});
    else finish(httpStatusFailure(status));
   };
   // At most responseBytes of the answer are read; then the socket is closed.
   response.on('data',(chunk:Buffer)=>{read+=chunk.length;if(readBody)chunks.push(chunk);if(read>responseBytes)truncated=true;if(read>=responseBytes){response.destroy();done();}});
   response.on('end',done);
   response.on('error',()=>done());
   response.on('close',done);
  });
  const total=setTimeout(()=>{finish(new NotifyError('timeout'));request.destroy();},totalMs);
  const connect=setTimeout(()=>{finish(new NotifyError('timeout'));request.destroy();},connectMs);
  request.on('socket',socket=>{
   if(!socket.connecting)clearTimeout(connect);
   else socket.once('connect',()=>clearTimeout(connect));
  });
  request.on('error',error=>finish(socketFailure(error)));
  if(method==='POST')request.end(body);else request.end();
 });
}

// ---- Retry ------------------------------------------------------------------------

export type RetryOutcome<T>={ok:true;value:T;attempts:number}|{ok:false;error:NotifyError;attempts:number};
const realSleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
/**
 * Runs `attempt` up to three times: again after 1 s and after 4 s while the
 * failure is retryable (network errors, timeouts, HTTP 408/429/5xx, SMTP 4xx).
 * Never rejects; the outcome carries the last error and the number of attempts.
 */
export async function withRetry<T>(attempt:()=>Promise<T>,{sleep=realSleep,backoff=notifyBackoffMs}:{sleep?:(ms:number)=>Promise<void>;backoff?:readonly number[]}={}):Promise<RetryOutcome<T>>{
 for(let index=0;;index++){
  try{return {ok:true,value:await attempt(),attempts:index+1};}
  catch(error){
   const failure=error instanceof NotifyError?error:socketFailure(error);
   if(!failure.retryable||index>=backoff.length)return {ok:false,error:failure,attempts:index+1};
   await sleep(backoff[index]);
  }
 }
}
