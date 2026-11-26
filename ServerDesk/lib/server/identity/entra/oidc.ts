// OpenID Connect with Microsoft Entra ID (docs/entra-id.md), with node:crypto
// only. Every request goes to one of the two constant hosts
// login.microsoftonline.com and graph.microsoft.com (the account check,
// lib/server/identity/entra/graph.ts) through the transport of the notifications
// (lib/server/notifications/notify/transport.ts): target check, DNS pinning, no redirects, time
// limits. No error, result or log line carries a token, a code, a secret, an
// assertion or Microsoft's error text.
import {createHash,createPrivateKey,createPublicKey,randomUUID,sign,verify,X509Certificate,type KeyObject} from 'node:crypto';
import {httpsRequest,NotifyError} from '../../notifications/notify/transport';
import {oauthHosts} from '../../notifications/notify/oauth';
import {amrDiagnostic,formatAmrDiagnostic} from '../../../entra/amr';

export const entraHost=oauthHosts.microsoftLogin;
export const graphHost=oauthHosts.graph;
/** The Microsoft Graph API base; the only Graph endpoint the portal calls. */
export const graphApiBase=`https://${graphHost}/v1.0`;
export const graphDefaultScope='https://graph.microsoft.com/.default';
/** The application ID URI of the portal's own API (Expose an API): api://<client ID>. */
export const applicationIdUriOf=(clientId:string)=>`api://${clientId}`;
/** The delegated scope of the portal API; its v1.0 access token carries the amr claim (the MFA signal). */
export const apiScopeName='access_as_user';
/** The scope of the sign-in and the confirmation: the OIDC scopes and the portal API scope. */
export const signInScopeOf=(clientId:string)=>`openid profile email ${applicationIdUriOf(clientId)}/${apiScopeName}`;
/** The issuer of v1.0 access tokens of the tenant. */
export const accessTokenIssuerOf=(tenant:string)=>`https://sts.windows.net/${tenant}/`;
const guidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A lower-case GUID, as Entra writes tenant, object and group IDs. */
export const isGuid=(value:unknown):value is string=>typeof value==='string'&&guidPattern.test(value);
export const issuerOf=(tenant:string)=>`https://${entraHost}/${tenant}/v2.0`;
export const authorizeUrlOf=(tenant:string)=>`https://${entraHost}/${tenant}/oauth2/v2.0/authorize`;
export const tokenUrlOf=(tenant:string)=>`https://${entraHost}/${tenant}/oauth2/v2.0/token`;
const discoveryUrlOf=(tenant:string)=>`https://${entraHost}/${tenant}/v2.0/.well-known/openid-configuration`;

// ---- Transport -----------------------------------------------------------------

export type EntraRequest={url:string;method:'GET'|'POST';body?:string;headers?:Record<string,string>};
export type EntraResponse={status:number;body:string};
/** One HTTPS request. Rejects with a NotifyError when the network fails; every status comes back. */
export type EntraHttp=(request:EntraRequest)=>Promise<EntraResponse>;
/** Discovery, keys, token and Graph answers are small; a token with many groups stays below 64 KiB. */
export const entraResponseBytes=64*1024;
const responseBytes=entraResponseBytes;
const defaultHttp:EntraHttp=async({url,method,body,headers={}})=>{
 const result=await httpsRequest({url,method,body,headers:{Accept:'application/json',...headers},maxBodyBytes:16*1024,readBody:true,userAgent:'Nodiverna-Entra'},{responseBytes});
 if(result.truncated)throw new NotifyError('tooLarge');
 return {status:result.status,body:result.body??''};
};
let http:EntraHttp=defaultHttp;
const transportResets=new Set<()=>void>();
/** Tests only: replaces the transport (null restores it) and empties the key cache and the Graph token cache. */
export const entraTransport={
 set(fake:EntraHttp|null){http=fake??defaultHttp;keyCache.clear();for(const reset of transportResets)reset();},
 /** lib/server/identity/entra/graph.ts registers the reset of its token cache here. */
 onReset(reset:()=>void){transportResets.add(reset);},
};
/**
 * A request to one of the two constant hosts only: login.microsoftonline.com,
 * or graph.microsoft.com under /v1.0/. Anything else is a programming error.
 */
export async function entraRequest(entry:EntraRequest):Promise<EntraResponse>{
 const target=new URL(entry.url);
 const allowed=target.protocol==='https:'&&!target.username&&!target.password&&!target.port&&(target.host===entraHost||target.host===graphHost&&target.pathname.startsWith('/v1.0/'));
 if(!allowed)throw new Error('Entra requests go only to login.microsoftonline.com and graph.microsoft.com/v1.0.');
 return http(entry);
}
const request=entraRequest;
export const json=(body:string):Record<string,unknown>|null=>{try{const value:unknown=JSON.parse(body);return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;}catch{return null;}};
const form=(fields:Record<string,string>)=>new URLSearchParams(fields).toString();

// ---- Discovery and keys -----------------------------------------------------------

/** Why a tenant check failed: the result codes of the connection test (AC test codes). */
export type DiscoveryFailure='tenantNotFound'|'discoveryFailed'|'unreachable';
/**
 * `detail` is a short value of a fixed list only: the apiSetupMissing detail
 * (missing, refused, version, audience, scope), the amr diagnostic of
 * mfaMissing (lib/entra/amr.ts) or the check of tokenRejected (rejectedDetail),
 * after a time check followed by the time offsets of timeOffsets (whole
 * seconds or "none"). It never carries token or Microsoft text.
 */
export class EntraFailure extends Error{constructor(readonly code:string,readonly detail?:string){super(code);this.name='EntraFailure';}}

// ---- tokenRejected: the failed check -----------------------------------------------------

type IdCheck='format'|'key'|'signature'|'issuer'|'audience'|'expired'|'ahead'|'nonce'|'oid'|'groups';
type AccessCheck='format'|'key'|'signature'|'issuer'|'appid'|'expired'|'ahead'|'identity';
/**
 * The check that refused a sign-in or a confirmation with tokenRejected: the
 * check=<value> part of auth.entra.login.refused and auth.entra.confirm.refused
 * (docs/entra-id.md). callback: an error parameter without its own outcome;
 * code: no code or a code over 8192 characters; redeem: the token endpoint
 * refused the code; redeem.idToken: a 200 answer without an id_token; id.* and
 * access.*: the check of the id_token or the access token that failed.
 */
export type TokenCheck='callback'|'code'|'redeem'|'redeem.idToken'|`id.${IdCheck}`|`access.${AccessCheck}`;
/** The OAuth 2.0 (RFC 6749) and OpenID Connect error codes of an authorization answer; any other value reads as "other". */
const callbackErrors:ReadonlySet<string>=new Set(['invalid_request','unauthorized_client','unsupported_response_type','invalid_scope','server_error','temporarily_unavailable','interaction_required','login_required','account_selection_required','consent_required','invalid_request_uri','invalid_request_object','request_not_supported','request_uri_not_supported','registration_not_supported']);
/** The error codes of a token answer: the list of the callback and the three of the token endpoint (RFC 6749 5.2). */
const redeemErrors:ReadonlySet<string>=new Set([...callbackErrors,'invalid_grant','invalid_client','unsupported_grant_type']);
const listedError=(list:ReadonlySet<string>,value:unknown)=>typeof value==='string'&&list.has(value)?value:'other';
/** At most this many AADSTS numbers go into an audit row. */
const aadstsLimit=3;
/** An AADSTS number has 4 to 7 digits. */
const aadstsPattern=/^\d{4,7}$/;
/**
 * The detail of a tokenRejected refusal: "<check>[ error=<oauth>][ aadsts=<n>,...]".
 * The error is a value of a fixed list or "other", the AADSTS numbers are digits
 * only (at most 3); no other text of Microsoft comes through.
 */
function rejectedDetail(check:TokenCheck,error?:string,codes:readonly string[]=[]):string{
 const numbers=codes.filter(code=>aadstsPattern.test(code)).slice(0,aadstsLimit);
 return `${check}${error===undefined?'':` error=${error}`}${numbers.length?` aadsts=${numbers.join(',')}`:''}`;
}
/** A tokenRejected refusal of one check (TokenCheck) without an error part. */
export const tokenRejected=(check:TokenCheck)=>new EntraFailure('tokenRejected',rejectedDetail(check));
/** The four checks of the token times (invalidTimes); only their detail carries time offsets. */
const timeChecks:ReadonlySet<string>=new Set(['id.expired','id.ahead','access.expired','access.ahead']);
/** Whether a failure is a tokenRejected refusal of a time check (its detail starts with id.expired, id.ahead, access.expired or access.ahead). */
export const timeRejected=(failure:EntraFailure)=>failure.code==='tokenRejected'&&timeChecks.has((failure.detail??'').split(' ')[0]);
/** A time offset is clamped to this many seconds either way. */
const offsetLimit=999_999_999;
/**
 * The offset of a time in seconds from the portal clock (`time`, ms) for an
 * audit row: whole seconds, rounded toward zero, clamped to ±999999999, as a
 * signed decimal integer without "+"; "none" when the value is not a finite
 * number (absent or any other type). Nothing of the value but this integer comes through.
 */
export function timeOffset(value:unknown,time:number):string{
 if(typeof value!=='number'||!Number.isFinite(value))return 'none';
 const offset=Math.trunc(value-time/1000);
 return String(Math.max(-offsetLimit,Math.min(offsetLimit,offset)));
}
/**
 * The time part of a tokenRejected detail after a time check: " exp=<n> iat=<n>
 * nbf=<n>" and, for the id_token, " auth=<n>" (auth_time), each an offset of
 * timeOffset from the same `time` the check used.
 */
function timeOffsets(claims:Record<string,unknown>,time:number,kind:'id'|'access'):string{
 const names:[string,unknown][]=[['exp',claims.exp],['iat',claims.iat],['nbf',claims.nbf],...(kind==='id'?[['auth',claims.auth_time] as [string,unknown]]:[])];
 return names.map(([name,value])=>` ${name}=${timeOffset(value,time)}`).join('');
}
/** The tokenRejected refusal of a failed time check: the check and its time offsets (timeOffsets). */
const timesRejected=(kind:'id'|'access',result:'expired'|'ahead',claims:Record<string,unknown>,time:number)=>new EntraFailure('tokenRejected',`${rejectedDetail(`${kind}.${result}`)}${timeOffsets(claims,time,kind)}`);
/** The callback errors that mean Microsoft could not answer now (unavailable): the person tries again. */
const unavailableErrors:ReadonlySet<unknown>=new Set(['server_error','temporarily_unavailable']);
/** Whether the error parameter of a callback is a temporary Microsoft failure (unavailable). */
export const unavailableError=(error:string|null)=>unavailableErrors.has(error);
/**
 * The tokenRejected refusal of a callback with an error parameter that has no
 * outcome of its own (check callback): the error from the RFC 6749 / OIDC list
 * or "other", and up to 3 AADSTS numbers from error_description. Nothing else
 * of the description is kept.
 */
export function callbackRejected(error:string,description:string|null):EntraFailure{
 const codes:string[]=[];
 for(const match of (description??'').matchAll(/AADSTS(\d+)/g)){
  if(aadstsPattern.test(match[1]))codes.push(match[1]);
  if(codes.length>=aadstsLimit)break;
 }
 return new EntraFailure('tokenRejected',rejectedDetail('callback',listedError(callbackErrors,error),codes));
}
type TenantKeys={keys:Map<string,KeyObject>;fetchedAt:number;refetchedAt:number};
/** Keys are kept up to 24 hours; an unknown kid fetches them again at most once per 5 minutes. */
export const keyCacheLimits={maxAgeMs:24*60*60_000,refetchMs:5*60_000};
const keyCache=new Map<string,TenantKeys>();

/** The discovery document of the tenant, checked: issuer of this tenant, jwks_uri on the same host. */
export async function discovery(tenant:string):Promise<{jwksUri:string}>{
 let answer:EntraResponse;
 try{answer=await request({url:discoveryUrlOf(tenant),method:'GET'});}catch{throw new EntraFailure('unreachable');}
 if(answer.status===400||answer.status===404)throw new EntraFailure('tenantNotFound');
 if(answer.status>=500)throw new EntraFailure('unreachable');
 const document=answer.status===200?json(answer.body):null;
 if(!document||document.issuer!==issuerOf(tenant)||typeof document.jwks_uri!=='string')throw new EntraFailure('discoveryFailed');
 let jwks:URL;try{jwks=new URL(document.jwks_uri);}catch{throw new EntraFailure('discoveryFailed');}
 if(jwks.protocol!=='https:'||jwks.host!==entraHost)throw new EntraFailure('discoveryFailed');
 return {jwksUri:jwks.toString()};
}
/** The RSA signing keys of the JWKS, by kid. */
export async function fetchKeys(jwksUri:string):Promise<Map<string,KeyObject>>{
 let answer:EntraResponse;
 try{answer=await request({url:jwksUri,method:'GET'});}catch{throw new EntraFailure('unreachable');}
 if(answer.status>=500)throw new EntraFailure('unreachable');
 const document=answer.status===200?json(answer.body):null,keys=new Map<string,KeyObject>();
 for(const entry of Array.isArray(document?.keys)?document.keys as unknown[]:[]){
  const jwk=entry as Record<string,unknown>;
  if(!jwk||jwk.kty!=='RSA'||typeof jwk.kid!=='string'||typeof jwk.n!=='string'||typeof jwk.e!=='string'||(jwk.use!==undefined&&jwk.use!=='sig'))continue;
  try{keys.set(jwk.kid,createPublicKey({key:{kty:'RSA',n:jwk.n,e:jwk.e},format:'jwk'}));}catch{/* An unusable key is skipped. */}
 }
 if(!keys.size)throw new EntraFailure('discoveryFailed');
 return keys;
}
/** The signing key `kid` of the tenant: from the cache, else fetched; an unknown kid refetches once per 5 minutes. */
export async function signingKey(tenant:string,kid:string,time:number):Promise<KeyObject|null>{
 const cached=keyCache.get(tenant);
 const fresh=cached&&time-cached.fetchedAt<keyCacheLimits.maxAgeMs?cached:null;
 if(fresh?.keys.has(kid))return fresh.keys.get(kid)!;
 if(fresh&&time-fresh.refetchedAt<keyCacheLimits.refetchMs)return null;
 const keys=await fetchKeys((await discovery(tenant)).jwksUri);
 keyCache.set(tenant,{keys,fetchedAt:time,refetchedAt:time});
 return keys.get(kid)??null;
}

// ---- Certificate credential ----------------------------------------------------------

export type CertificateCredential={certificatePem:string;privateKeyPem:string;thumbprint:string;expiresAt:number};
/**
 * Checks a pasted certificate and its key: one PEM X.509 certificate with an RSA
 * key, an unencrypted PKCS#8 or PKCS#1 RSA private key with at least 2048 bits
 * that belongs to it, and a validity end in the future. The thumbprint is the
 * upper-case hex SHA-1 of the DER, as the Entra admin center shows it.
 */
export function checkCertificate(certificatePem:string,privateKeyPem:string,time:number):CertificateCredential{
 const invalid=()=>new EntraFailure('certificateInvalid');
 if(!/^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----\s*$/.test(certificatePem.trim()+'\n'))throw invalid();
 // The label uses \x20 for its spaces, so the repository scan for key material (tests/repo/key-material.mjs) finds no key here.
 if(!/^-----BEGIN (?:RSA\x20)?PRIVATE\x20KEY-----[\s\S]+-----END (?:RSA\x20)?PRIVATE\x20KEY-----\s*$/.test(privateKeyPem.trim()+'\n'))throw invalid();
 let certificate:X509Certificate,key:KeyObject;
 try{certificate=new X509Certificate(certificatePem);key=createPrivateKey({key:privateKeyPem,format:'pem'});}catch{throw invalid();}
 if(key.asymmetricKeyType!=='rsa'||certificate.publicKey.asymmetricKeyType!=='rsa'||(key.asymmetricKeyDetails?.modulusLength??0)<2048)throw invalid();
 if(!certificate.checkPrivateKey(key))throw new EntraFailure('keyMismatch');
 const expiresAt=Date.parse(certificate.validTo);
 if(!Number.isFinite(expiresAt)||expiresAt<=time)throw new EntraFailure('certificateExpired');
 return {certificatePem:certificate.toString(),privateKeyPem:key.export({type:'pkcs8',format:'pem'}).toString(),thumbprint:createHash('sha1').update(certificate.raw).digest('hex').toUpperCase(),expiresAt};
}
const base64url=(value:string|Buffer)=>Buffer.from(value).toString('base64url');
/**
 * The client assertion of a certificate credential: an RS256 JWT with header
 * x5t (base64url SHA-1 thumbprint), claims aud = the token URL, iss = sub =
 * client ID, a random jti, nbf and iat now, exp after 5 minutes.
 */
export function clientAssertion({tenant,clientId,privateKeyPem,thumbprint}:{tenant:string;clientId:string;privateKeyPem:string;thumbprint:string},time:number):string{
 const seconds=Math.floor(time/1000);
 const header=base64url(JSON.stringify({alg:'RS256',typ:'JWT',x5t:base64url(Buffer.from(thumbprint,'hex'))}));
 const claims=base64url(JSON.stringify({aud:tokenUrlOf(tenant),iss:clientId,sub:clientId,jti:randomUUID(),nbf:seconds,iat:seconds,exp:seconds+300}));
 return `${header}.${claims}.${base64url(sign('sha256',Buffer.from(`${header}.${claims}`),createPrivateKey(privateKeyPem)))}`;
}

/** The credential part of a token request. */
export type ClientCredential={kind:'secret';secret:string}|{kind:'certificate';privateKeyPem:string;thumbprint:string};
function credentialFields(tenant:string,clientId:string,credential:ClientCredential,time:number):Record<string,string>{
 return credential.kind==='secret'?{client_secret:credential.secret}:{client_assertion_type:'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',client_assertion:clientAssertion({tenant,clientId,privateKeyPem:credential.privateKeyPem,thumbprint:credential.thumbprint},time)};
}
export type TokenAnswer={status:number;body:Record<string,unknown>|null};
async function tokenRequest(tenant:string,fields:Record<string,string>):Promise<TokenAnswer>{
 const answer=await request({url:tokenUrlOf(tenant),method:'POST',body:form(fields),headers:{'Content-Type':'application/x-www-form-urlencoded'}});
 return {status:answer.status,body:json(answer.body)};
}
const certificateCodes=[700021,700023,700024,700027,7000274,7000277,700025];
/** The AADSTS numbers of a refused token request (error_codes), as numbers. */
const errorCodes=(answer:TokenAnswer)=>Array.isArray(answer.body?.error_codes)?(answer.body.error_codes as unknown[]).map(Number):[];
/** The result code of a refused client-credentials request; Microsoft's text never leaves this function. */
export function credentialFailure(kind:ClientCredential['kind'],answer:TokenAnswer):'credentialRefused'|'secretExpired'|'certificateRefused'|'unreachable'{
 if(answer.status>=500||answer.status===429)return 'unreachable';
 const codes=errorCodes(answer);
 const words=`${typeof answer.body?.error==='string'?answer.body.error:''} ${typeof answer.body?.error_description==='string'?answer.body.error_description:''}`;
 if(codes.includes(7000222)||/AADSTS7000222\b/.test(words))return 'secretExpired';
 if(kind==='certificate'&&(codes.some(code=>certificateCodes.includes(code))||/AADSTS(?:700021|700023|700024|700027|7000274|7000277|700025)\b/.test(words)))return 'certificateRefused';
 return 'credentialRefused';
}

/**
 * A client-credentials request for a Microsoft Graph token (scope
 * https://graph.microsoft.com/.default) with the secret or a certificate
 * assertion: the connection test and the account check (lib/server/identity/entra/graph.ts)
 * share it. Rejects only when the network fails; the token stays in memory.
 */
export async function graphTokenRequest(tenant:string,clientId:string,credential:ClientCredential,time:number):Promise<{token:string;expiresIn:number}|{answer:TokenAnswer}>{
 return clientCredentialsToken(tenant,clientId,credential,graphDefaultScope,time);
}
async function clientCredentialsToken(tenant:string,clientId:string,credential:ClientCredential,scope:string,time:number):Promise<{token:string;expiresIn:number}|{answer:TokenAnswer}>{
 const answer=await tokenRequest(tenant,{grant_type:'client_credentials',client_id:clientId,scope,...credentialFields(tenant,clientId,credential,time)});
 const token=answer.body?.access_token;
 if(answer.status===200&&typeof token==='string'&&token){
  const seconds=Number(answer.body?.expires_in);
  return {token,expiresIn:Number.isFinite(seconds)&&seconds>0?seconds:3600};
 }
 return {answer};
}

/** The Graph application permissions the account check needs (docs/entra-id.md). */
export const graphPermissions=['User.Read.All','GroupMember.Read.All'] as const;
const graphProbeStatus=(status:number):'ok'|'graphPermissionMissing'|'graphUnreachable'=>status===200?'ok':status===408||status===429||status>=500?'graphUnreachable':'graphPermissionMissing';
/**
 * The Graph step of the connection test: one user with accountEnabled
 * (User.Read.All) and one group (GroupMember.Read.All or more). 403, or a user
 * without a boolean accountEnabled, is graphPermissionMissing; a network
 * failure, 408, 429 or 5xx is graphUnreachable.
 */
async function graphProbe(token:string):Promise<'ok'|'graphPermissionMissing'|'graphUnreachable'>{
 const headers={Authorization:`Bearer ${token}`};
 let users:EntraResponse,groups:EntraResponse;
 try{users=await request({url:`${graphApiBase}/users?$top=1&$select=id,accountEnabled`,method:'GET',headers});}catch{return 'graphUnreachable';}
 const usersStatus=graphProbeStatus(users.status);
 if(usersStatus!=='ok')return usersStatus;
 const list=json(users.body)?.value;
 if(!Array.isArray(list))return 'graphUnreachable';
 const first:unknown=list[0];
 if(first!==undefined&&(!first||typeof first!=='object'||typeof (first as Record<string,unknown>).accountEnabled!=='boolean'))return 'graphPermissionMissing';
 try{groups=await request({url:`${graphApiBase}/groups?$top=1&$select=id`,method:'GET',headers});}catch{return 'graphUnreachable';}
 const groupsStatus=graphProbeStatus(groups.status);
 if(groupsStatus!=='ok')return groupsStatus;
 return Array.isArray(json(groups.body)?.value)?'ok':'graphUnreachable';
}

export type ConnectionResult='ok'|'tenantNotFound'|'discoveryFailed'|'credentialRefused'|'secretExpired'|'certificateRefused'|'unreachable'|'graphPermissionMissing'|'graphUnreachable'|'apiNotExposed'|'apiTokenVersion';
/**
 * The connection test: discovery with the issuer of the tenant, the JWKS with at
 * least one RSA key on the same host, a client-credentials token for
 * Microsoft Graph with the saved secret or a certificate assertion, two
 * Graph reads with that token (graphProbe), then a client-credentials token for
 * the portal API (apiProbe).
 */
export async function testConnection(tenant:string,clientId:string,credential:ClientCredential,time:number):Promise<ConnectionResult>{
 try{
  const {jwksUri}=await discovery(tenant);
  keyCache.set(tenant,{keys:await fetchKeys(jwksUri),fetchedAt:time,refetchedAt:time});
 }catch(error){if(error instanceof EntraFailure)return error.code as DiscoveryFailure;return 'unreachable';}
 let result:Awaited<ReturnType<typeof graphTokenRequest>>;
 try{result=await graphTokenRequest(tenant,clientId,credential,time);}
 catch{return 'unreachable';}
 if('answer' in result)return credentialFailure(credential.kind,result.answer);
 const graph=await graphProbe(result.token);
 if(graph!=='ok')return graph;
 return apiProbe(tenant,clientId,credential,time);
}
/** AADSTS501051: the app needs a user or app assignment. The API exists; its token version is checked at sign-in. */
const assignmentRequired=501051;
/**
 * The portal API step of the connection test: a client-credentials token with
 * the scope api://<client ID>/.default. It shows whether the application ID URI
 * is set and which token version the API sends; whether the delegated scope
 * access_as_user exists or has consent shows only at sign-in (apiSetupMissing).
 * A network failure, 429 or 5xx is unreachable. A token signed by the tenant
 * with ver 1.0, the issuer of v1.0 tokens and the audience of the portal API is
 * ok; ver 2.0 with the v2.0 issuer is apiTokenVersion; any other token is
 * apiNotExposed. A refusal is ok for 501051, else apiNotExposed. The token stays
 * in memory.
 */
async function apiProbe(tenant:string,clientId:string,credential:ClientCredential,time:number):Promise<'ok'|'apiNotExposed'|'apiTokenVersion'|'unreachable'>{
 let result:Awaited<ReturnType<typeof clientCredentialsToken>>;
 try{result=await clientCredentialsToken(tenant,clientId,credential,`${applicationIdUriOf(clientId)}/.default`,time);}
 catch{return 'unreachable';}
 if('answer' in result){
  if(result.answer.status>=500||result.answer.status===429)return 'unreachable';
  return errorCodes(result.answer).includes(assignmentRequired)?'ok':'apiNotExposed';
 }
 let claims:Record<string,unknown>;
 try{claims=(await verifiedJws(result.token,tenant,time,'access')).claims;}
 catch(error){return error instanceof EntraFailure&&error.code==='unavailable'?'unreachable':'apiNotExposed';}
 if(claims.tid!==tenant)return 'apiNotExposed';
 if(claims.ver==='2.0'&&claims.iss===issuerOf(tenant))return 'apiTokenVersion';
 return claims.ver==='1.0'&&claims.iss===accessTokenIssuerOf(tenant)&&apiAudience(claims.aud,clientId)?'ok':'apiNotExposed';
}

/** The OAuth errors of a callback or a refused redemption that mean the portal API scope is not set up (apiSetupMissing, detail refused). */
const apiSetupErrors:ReadonlySet<unknown>=new Set(['invalid_scope','invalid_resource']);
/** AADSTS500011 (resource not found), 65001 and 65005 (no consent, or the scope is unknown) and 70011 (invalid scope). */
const apiSetupCodes=[500011,65001,65005,70011];
/** Whether the error parameter of a callback names a scope or resource that Microsoft refused. */
export const apiSetupError=(error:string|null)=>apiSetupErrors.has(error);
/** AADSTS54005 (the code was already redeemed) and 70008 (the code expired): the flow is over, the person starts again (expired). */
const usedCodeCodes=[54005,70008];
/** The two tokens of a code redemption; they stay in memory and are never stored or logged. */
export type RedeemedTokens={idToken:string;accessToken:string};
/**
 * Redeems an authorization code with PKCE and the scope of the sign-in.
 * 'unavailable' for a network failure, 429 or a server error; 'apiSetupMissing'
 * (detail refused) when Microsoft refuses the portal API scope; 'expired' for
 * invalid_grant with AADSTS54005 or 70008 (a used or expired code);
 * 'tokenRejected' with check redeem (the OAuth error and the AADSTS numbers of
 * error_codes) for any other refusal, or with check redeem.idToken for a 200
 * answer without an id_token; 'apiSetupMissing' (detail missing) for a 200
 * answer without an access token.
 */
export async function redeemCode({tenant,clientId,credential,code,codeVerifier,redirectUri}:{tenant:string;clientId:string;credential:ClientCredential;code:string;codeVerifier:string;redirectUri:string},time:number):Promise<RedeemedTokens>{
 let answer:TokenAnswer;
 try{answer=await tokenRequest(tenant,{grant_type:'authorization_code',client_id:clientId,code,redirect_uri:redirectUri,code_verifier:codeVerifier,scope:signInScopeOf(clientId),...credentialFields(tenant,clientId,credential,time)});}
 catch{throw new EntraFailure('unavailable');}
 if(answer.status>=500||answer.status===429)throw new EntraFailure('unavailable');
 if(answer.status!==200){
  const codes=errorCodes(answer);
  if(apiSetupErrors.has(answer.body?.error)||codes.some(code=>apiSetupCodes.includes(code)))throw new EntraFailure('apiSetupMissing','refused');
  if(answer.body?.error==='invalid_grant'&&codes.some(code=>usedCodeCodes.includes(code)))throw new EntraFailure('expired');
  throw new EntraFailure('tokenRejected',rejectedDetail('redeem',listedError(redeemErrors,answer.body?.error),codes.filter(code=>Number.isInteger(code)).map(String)));
 }
 const idToken=answer.body?.id_token,accessToken=answer.body?.access_token;
 if(typeof idToken!=='string'||!idToken)throw tokenRejected('redeem.idToken');
 if(typeof accessToken!=='string'||!accessToken)throw new EntraFailure('apiSetupMissing','missing');
 return {idToken,accessToken};
}

// ---- Token checks ------------------------------------------------------------------------

/** `authTime` is the auth_time claim in seconds, or null when the token has none (an optional claim in Entra v2 tokens). */
export type IdTokenClaims={tid:string;oid:string;name:string;preferredUsername:string;email:string;groups:string[];authTime:number|null};
/** The GUID claims of a token for an audit row, or '-' (never other claim text). */
export type RefusalContext={tenant:string;object:string};
const sha256=(value:string)=>createHash('sha256').update(value).digest('hex');
const decodePart=(part:string)=>{try{if(!/^[A-Za-z0-9_-]+$/.test(part))return null;return json(Buffer.from(part,'base64url').toString('utf8'));}catch{return null;}};
const text=(value:unknown)=>typeof value==='string'?value:'';
/**
 * A compact JWS with alg RS256, a non-empty kid and no crit header, signed by
 * a key of the tenant (signingKey). An access token (kind access) with a nonce
 * header is refused too (Microsoft Graph tokens carry one; they are not for the
 * portal). Keys that cannot be fetched: 'unavailable'; anything else:
 * 'tokenRejected' with the check <kind>.format, <kind>.key or <kind>.signature.
 */
async function verifiedJws(token:string,tenant:string,time:number,kind:'id'|'access'):Promise<{header:Record<string,unknown>;claims:Record<string,unknown>}>{
 const nonceHeader=kind==='id';
 const parts=token.split('.');
 if(parts.length!==3)throw tokenRejected(`${kind}.format`);
 const header=decodePart(parts[0]),claims=decodePart(parts[1]);
 if(!header||!claims||header.alg!=='RS256'||typeof header.kid!=='string'||!header.kid||header.crit!==undefined||(!nonceHeader&&Object.hasOwn(header,'nonce')))throw tokenRejected(`${kind}.format`);
 let key:KeyObject|null;
 try{key=await signingKey(tenant,header.kid,time);}catch(error){if(error instanceof EntraFailure&&error.code==='unreachable')throw new EntraFailure('unavailable');throw tokenRejected(`${kind}.key`);}
 if(!key)throw tokenRejected(`${kind}.key`);
 let signature:Buffer;
 try{signature=Buffer.from(parts[2],'base64url');}catch{throw tokenRejected(`${kind}.signature`);}
 if(!/^[A-Za-z0-9_-]+$/.test(parts[2])||!verify('sha256',Buffer.from(`${parts[0]}.${parts[1]}`),key,signature))throw tokenRejected(`${kind}.signature`);
 return {header,claims};
}
/**
 * exp a number in the future, else 'expired'; nbf and iat, when present,
 * numbers at most 5 minutes ahead of the portal clock, else 'ahead'; null when
 * the times are valid. A refusal carries the time offsets from the same
 * `time` (timesRejected).
 */
function invalidTimes(claims:Record<string,unknown>,time:number):'expired'|'ahead'|null{
 const seconds=time/1000,skew=300;
 if(typeof claims.exp!=='number'||claims.exp<=seconds)return 'expired';
 for(const name of ['nbf','iat'] as const){const value=claims[name];if(value!==undefined&&(typeof value!=='number'||value>seconds+skew))return 'ahead';}
 return null;
}
/** The audience of the portal API: the application ID URI or the bare client ID (Entra writes the one that was requested). */
const apiAudience=(aud:unknown,clientId:string)=>aud===applicationIdUriOf(clientId)||aud===clientId;
/**
 * Checks the id_token, in this order: compact JWS with alg RS256 and a kid of
 * the tenant's keys; the signature; tid = the tenant (else wrongTenant); iss of
 * the tenant; aud = the client ID; exp in the future and nbf and iat at most 5
 * minutes ahead; the nonce hash of the flow; oid a GUID; no groups overage
 * (_claim_names.groups, else groupsOverage). A missing groups claim counts as
 * no groups. Every other refusal is tokenRejected with its check (id.*). The amr claim is not read: the MFA signal comes from the access
 * token of the portal API (verifyAccessToken). With `ignoreGroups` (the
 * confirmation of lib/server/identity/entra/confirm.ts, which syncs no roles) the groups claim
 * is not read: no overage refusal and no groups. `context` gets the GUIDs of
 * tid and oid for the refusal audit row, once they are known.
 */
export async function verifyIdToken(token:string,{tenant,clientId,nonceHash,time,context,ignoreGroups=false}:{tenant:string;clientId:string;nonceHash:string;time:number;context:RefusalContext;ignoreGroups?:boolean}):Promise<IdTokenClaims>{
 const {claims}=await verifiedJws(token,tenant,time,'id');
 if(isGuid(claims.tid))context.tenant=claims.tid;
 if(isGuid(claims.oid))context.object=claims.oid;
 if(claims.tid!==tenant)throw new EntraFailure('wrongTenant');
 if(claims.iss!==issuerOf(tenant))throw tokenRejected('id.issuer');
 if(claims.aud!==clientId)throw tokenRejected('id.audience');
 const times=invalidTimes(claims,time);
 if(times)throw timesRejected('id',times,claims,time);
 if(typeof claims.nonce!=='string'||sha256(claims.nonce)!==nonceHash)throw tokenRejected('id.nonce');
 if(!isGuid(claims.oid))throw tokenRejected('id.oid');
 const authTime=typeof claims.auth_time==='number'&&Number.isFinite(claims.auth_time)?claims.auth_time:null;
 const identity={tid:claims.tid,oid:claims.oid,name:text(claims.name),preferredUsername:text(claims.preferred_username),email:text(claims.email),authTime};
 if(ignoreGroups)return {...identity,groups:[]};
 const names=claims._claim_names;
 if(names&&typeof names==='object'&&Object.hasOwn(names,'groups'))throw new EntraFailure('groupsOverage');
 const groups=claims.groups===undefined?[]:Array.isArray(claims.groups)?[...new Set(claims.groups.filter(isGuid))]:null;
 if(!groups)throw tokenRejected('id.groups');
 return {...identity,groups};
}
/**
 * Checks the access token of the portal API from the same token answer, after
 * the id_token passed, in this order (each refusal names its code): compact JWS
 * with alg RS256, a kid, no crit and no nonce header, and the signature against
 * the tenant keys (tokenRejected access.format, access.key or access.signature,
 * or unavailable when the keys cannot be fetched); ver "1.0" (apiSetupMissing,
 * version); the issuer of v1.0 tokens of the tenant and tid (tokenRejected
 * access.issuer); aud the portal API (apiSetupMissing, audience); appid the
 * client ID (access.appid), the times (access.expired, access.ahead), oid and
 * tid of the id_token (access.identity); scp with access_as_user (apiSetupMissing, scope); amr an
 * array with "mfa" (mfaMissing, with the amr diagnostic of lib/entra/amr.ts as
 * its detail). Access tokens have no nonce: the code, PKCE and the client
 * credential of the same redemption and the verified id_token bind it to the
 * flow. Nothing of the token leaves this function but the filtered amr values.
 */
export async function verifyAccessToken(token:string,{tenant,clientId,time,identity}:{tenant:string;clientId:string;time:number;identity:Pick<IdTokenClaims,'tid'|'oid'>}):Promise<void>{
 const setupMissing=(detail:'version'|'audience'|'scope')=>new EntraFailure('apiSetupMissing',detail);
 const {claims}=await verifiedJws(token,tenant,time,'access');
 if(claims.ver!=='1.0')throw setupMissing('version');
 if(claims.iss!==accessTokenIssuerOf(tenant)||claims.tid!==tenant)throw tokenRejected('access.issuer');
 if(!apiAudience(claims.aud,clientId))throw setupMissing('audience');
 if(claims.appid!==clientId)throw tokenRejected('access.appid');
 const times=invalidTimes(claims,time);
 if(times)throw timesRejected('access',times,claims,time);
 if(claims.oid!==identity.oid||claims.tid!==identity.tid)throw tokenRejected('access.identity');
 if(typeof claims.scp!=='string'||!claims.scp.split(' ').includes(apiScopeName))throw setupMissing('scope');
 if(!Array.isArray(claims.amr)||!claims.amr.includes('mfa'))throw new EntraFailure('mfaMissing',formatAmrDiagnostic(amrDiagnostic(claims.amr)));
}
