// Microsoft Graph for the account check (lib/server/identity/entra/directory-check.ts,
// docs/entra-id.md). The access token comes from the client-credentials grant
// of the app registration (graphTokenRequest in lib/server/identity/entra/oidc.ts, the same
// path as the connection test). It stays in process memory only, per settings
// revision, and is reused while more than 5 minutes of it remain. Every request
// goes through entraRequest (only https://graph.microsoft.com/v1.0/…), at most
// 4 at a time. A Graph 401 drops the token, fetches one new token and repeats
// the request once. No error, result or log line carries a token, an assertion
// or Graph's error text: failures are one of the codes of GraphFailure.
import {credentialFailure,entraRequest,entraResponseBytes,entraTransport,graphApiBase,graphTokenRequest,isGuid,json,type ClientCredential,type EntraResponse} from './oidc';
import {directoryCheckLimits,type DirectoryCheckResult} from './directory-check-state';

export type GraphFailureCode=Exclude<DirectoryCheckResult,'ok'>;
/** A failure that stops the whole run; its message is the code only. */
export class GraphFailure extends Error{constructor(readonly code:GraphFailureCode){super(code);this.name='GraphFailure';}}

/** A token is renewed when 5 minutes or less of it remain. */
export const graphTokenRenewBeforeMs=5*60_000;
type CachedToken={key:string;token:string;expiresAt:number};
let cached:CachedToken|null=null,pending:{key:string;promise:Promise<CachedToken>}|null=null;
entraTransport.onReset(()=>{cached=null;pending=null;});

// ---- Concurrency ------------------------------------------------------------------

let inFlight=0;
const waiting:(()=>void)[]=[];
/** Runs `task` once fewer than 4 Graph requests are in flight in this process. */
async function limited<T>(task:()=>Promise<T>):Promise<T>{
 if(inFlight>=directoryCheckLimits.concurrency)await new Promise<void>(resolve=>waiting.push(resolve));
 else inFlight++;
 try{return await task();}
 finally{const next=waiting.shift();if(next)next();else inFlight--;}
}

// ---- Session ----------------------------------------------------------------------

/** The app registration a run uses; `revision` keys the token cache. */
export type GraphSession={tenant:string;clientId:string;credential:ClientCredential;revision:number;clock:()=>number};
const keyOf=(session:GraphSession)=>`${session.revision}:${session.tenant}:${session.clientId}`;

async function fetchToken(session:GraphSession,key:string):Promise<CachedToken>{
 const time=session.clock();
 let result:Awaited<ReturnType<typeof graphTokenRequest>>;
 try{result=await graphTokenRequest(session.tenant,session.clientId,session.credential,time);}
 catch{throw new GraphFailure('unavailable');}
 if('answer' in result){
  const code=credentialFailure(session.credential.kind,result.answer);
  throw new GraphFailure(code==='unreachable'?'unavailable':code);
 }
 return {key,token:result.token,expiresAt:time+result.expiresIn*1000};
}
/** The cached token of this revision while more than 5 minutes remain, else one new token (one request for parallel callers). */
async function accessToken(session:GraphSession):Promise<CachedToken>{
 const key=keyOf(session);
 if(cached?.key===key&&cached.expiresAt-session.clock()>graphTokenRenewBeforeMs)return cached;
 if(pending?.key===key)return pending.promise;
 const promise=fetchToken(session,key);
 pending={key,promise};
 try{cached=await promise;return cached;}
 finally{if(pending?.promise===promise)pending=null;}
}
/** Drops `used` when it is still the cached token, so the next call fetches a new one. */
function dropToken(used:CachedToken){if(cached===used)cached=null;}

/**
 * One Graph request: 200 and 404 come back to the caller. A 401 drops the token
 * and repeats once with a new token; a second 401 is credentialRefused. 403 is
 * permissionMissing; 408, 429, 5xx, any other status, a network failure or an
 * answer over 64 KiB is unavailable.
 */
async function graph(session:GraphSession,path:string,body?:unknown):Promise<EntraResponse>{
 const send=async(token:string)=>{
  let answer:EntraResponse;
  try{
   answer=await limited(()=>entraRequest({url:graphApiBase+path,method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})}));
  }catch{throw new GraphFailure('unavailable');}
  if(Buffer.byteLength(answer.body??'')>entraResponseBytes)throw new GraphFailure('unavailable');
  return answer;
 };
 let token=await accessToken(session),answer=await send(token.token);
 if(answer.status===401){
  dropToken(token);
  token=await accessToken(session);
  answer=await send(token.token);
  if(answer.status===401){dropToken(token);throw new GraphFailure('credentialRefused');}
 }
 if(answer.status===200||answer.status===404)return answer;
 if(answer.status===403)throw new GraphFailure('permissionMissing');
 throw new GraphFailure('unavailable');
}

// ---- Requests per account -------------------------------------------------------------

export type AccountState='enabled'|'disabled'|'deleted';
/**
 * GET /v1.0/users/<oid>?$select=id,accountEnabled: accountEnabled true is
 * enabled, false is disabled, 404 is deleted. A 200 without a boolean
 * accountEnabled means the permission to read it is missing.
 */
export async function graphAccountState(session:GraphSession,objectId:string):Promise<AccountState>{
 if(!isGuid(objectId))throw new Error('The object ID of an Entra account is a GUID.');
 const answer=await graph(session,`/users/${objectId}?$select=id,accountEnabled`);
 if(answer.status===404)return 'deleted';
 const enabled=json(answer.body)?.accountEnabled;
 if(typeof enabled!=='boolean')throw new GraphFailure('permissionMissing');
 return enabled?'enabled':'disabled';
}
/**
 * POST /v1.0/users/<oid>/checkMemberGroups with at most 20 group IDs per
 * request: the asked groups the account is still a (transitive) member of.
 * Returned IDs that are no GUID or were not asked are ignored. No groups, no
 * request. A 404 here (the account went away between both requests) is
 * unavailable: the run stops and the next run sees the deleted account.
 */
export async function graphMemberGroups(session:GraphSession,objectId:string,groupIds:readonly string[]):Promise<Set<string>>{
 if(!isGuid(objectId))throw new Error('The object ID of an Entra account is a GUID.');
 const asked=[...new Set(groupIds.filter(isGuid))].sort(),member=new Set<string>();
 for(let start=0;start<asked.length;start+=directoryCheckLimits.groupBatch){
  const batch=asked.slice(start,start+directoryCheckLimits.groupBatch),wanted=new Set(batch);
  const answer=await graph(session,`/users/${objectId}/checkMemberGroups`,{groupIds:batch});
  if(answer.status!==200)throw new GraphFailure('unavailable');
  const value=json(answer.body)?.value;
  if(!Array.isArray(value))throw new GraphFailure('unavailable');
  for(const id of value)if(isGuid(id)&&wanted.has(id))member.add(id);
 }
 return member;
}

/** Tests only: the number of Graph requests in flight now. */
export const graphInFlight=()=>inFlight;
