// Access tokens for the modern sign-ins of the email channel
// (docs/notifications.md): Microsoft 365 with the OAuth 2.0 client credentials
// of an Entra app registration, Google Workspace with a service account and
// domain-wide delegation (OAuth 2.0 JWT bearer, signed here with node:crypto).
// The hosts are constants, and every request goes through the transport
// (lib/server/notifications/notify/transport.ts): target check, DNS pinning, no redirects, time
// limits. Tokens stay only in process memory, at most 100 of them, the oldest
// go first; one is used again while more than 5 minutes of it remain. The cache
// key is a SHA-256 of the provider, the app or service account, the subject and
// a hash of the secret, so a new secret gets a new token. No error, param or
// log line carries a secret, an assertion or a token.
import {createHash,createPrivateKey,sign} from 'node:crypto';
import {httpsPost,httpStatusFailure,httpStatusRetryable,NotifyError,type NotifyFailureReason,type TransportOptions} from './transport';

export const oauthHosts={microsoftLogin:'login.microsoftonline.com',graph:'graph.microsoft.com',googleToken:'oauth2.googleapis.com',gmailSmtp:'smtp.gmail.com'} as const;
export const graphScope='https://graph.microsoft.com/.default',googleScope='https://mail.google.com/',googleTokenUrl=`https://${oauthHosts.googleToken}/token`;
/** Tokens in memory: at most 100; one is reused while more than 5 minutes of it remain; a Google assertion is valid for 1 hour. */
export const tokenCacheLimits={entries:100,renewBeforeMs:5*60_000,assertionSeconds:3600};
/** A token request body is small; the limit only guards the transport. */
const tokenBodyBytes=8*1024;

export type MicrosoftCredentials={tenantId:string;clientId:string;clientSecret:string};
export type GoogleCredentials={serviceAccount:string;privateKey:string;privateKeyId:string;subject:string};
export type OAuthOptions=TransportOptions&{clock?:()=>number};
/** An access token and its cache key (for dropToken after a refused token). */
export type AccessToken={token:string;key:string};

const sha256=(value:string)=>createHash('sha256').update(value).digest('hex');
const cache=new Map<string,{token:string;expiresAt:number}>();
/** The cache key of a token: SHA-256 of provider, app or service account, subject and a hash of the secret. */
export const tokenCacheKey=(provider:'microsoft'|'google',identity:string[],secret:string)=>sha256(JSON.stringify([provider,...identity,sha256(secret)]));
function cached(key:string,now:number):string|null{
 const entry=cache.get(key);
 if(!entry)return null;
 if(entry.expiresAt-now>tokenCacheLimits.renewBeforeMs)return entry.token;
 cache.delete(key);
 return null;
}
function remember(key:string,token:string,expiresInSeconds:number,now:number){
 cache.delete(key);
 cache.set(key,{token,expiresAt:now+expiresInSeconds*1000});
 // A Map keeps the order of insertion: the first keys are the oldest.
 while(cache.size>tokenCacheLimits.entries)cache.delete(cache.keys().next().value!);
}
/** Forgets a token, for example after the target refused it. */
export function dropToken(key:string){cache.delete(key);}
/** Tests only: empties the cache, or tells its size. */
export const tokenCache={clear:()=>cache.clear(),size:()=>cache.size,has:(key:string)=>cache.has(key)};

const form=(fields:Record<string,string>)=>new URLSearchParams(fields).toString();
type TokenAnswer={access_token?:unknown;expires_in?:unknown;error?:unknown;error_description?:unknown;error_codes?:unknown};
const parsed=(body:string|undefined):TokenAnswer=>{try{const value=JSON.parse(body??'');return value&&typeof value==='object'?value as TokenAnswer:{};}catch{return {};}};

/**
 * One token request. A 2xx with an access token gives the token; 408, 429 and
 * 5xx stay retryable httpStatus; another answer goes to `refused`, which names
 * the reason from the error in the body. The token, the secret and the
 * assertion never reach an error.
 */
async function requestToken(url:string,body:string,refused:(status:number,answer:TokenAnswer)=>NotifyFailureReason|null,signInRefused:NotifyFailureReason,options:OAuthOptions):Promise<{token:string;expiresIn:number}>{
 const result=await httpsPost({url,body,headers:{'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},maxBodyBytes:tokenBodyBytes,readBody:true},options);
 const answer=parsed(result.body);
 if(result.status>=200&&result.status<300){
  if(typeof answer.access_token!=='string'||!answer.access_token)throw new NotifyError(signInRefused);
  const expiresIn=Number(answer.expires_in);
  return {token:answer.access_token,expiresIn:Number.isFinite(expiresIn)&&expiresIn>0?expiresIn:0};
 }
 if(httpStatusRetryable(result.status))throw httpStatusFailure(result.status);
 const reason=refused(result.status,answer);
 throw reason?new NotifyError(reason):httpStatusFailure(result.status);
}

const text=(value:unknown)=>typeof value==='string'?value:'';
const microsoftRefusedCodes=/\b(?:invalid_client|unauthorized_client)\b|AADSTS(?:7000215|700016|90002|900023)\b/;
/**
 * The reason of a refused Microsoft token request: AADSTS7000222 (expired
 * client secret) is microsoftSecretExpired; invalid_client,
 * unauthorized_client, AADSTS7000215, AADSTS700016, AADSTS90002, AADSTS900023
 * or another 400 or 401 is microsoftSignInRefused.
 */
export function microsoftTokenFailure(status:number,answer:TokenAnswer):NotifyFailureReason|null{
 const codes=Array.isArray(answer.error_codes)?answer.error_codes.map(Number):[];
 const words=`${text(answer.error)} ${text(answer.error_description)}`;
 if(codes.includes(7000222)||/AADSTS7000222\b/.test(words))return 'microsoftSecretExpired';
 if(microsoftRefusedCodes.test(words)||codes.some(code=>[7000215,700016,90002,900023].includes(code))||status===400||status===401)return 'microsoftSignInRefused';
 return null;
}
/**
 * The reason of a refused Google token request: unauthorized_client (no
 * domain-wide delegation for the scope) is googleDelegationMissing;
 * invalid_grant with "Invalid email or User ID" (the sender is no Workspace
 * user) is mailboxNotFound; another invalid_grant, invalid_client or another 400
 * or 401 is googleSignInRefused.
 */
export function googleTokenFailure(status:number,answer:TokenAnswer):NotifyFailureReason|null{
 const error=text(answer.error),description=text(answer.error_description);
 if(error==='unauthorized_client')return 'googleDelegationMissing';
 if(error==='invalid_grant'&&/Invalid email or User ID/i.test(description))return 'mailboxNotFound';
 if(error==='invalid_grant'||error==='invalid_client'||status===400||status===401)return 'googleSignInRefused';
 return null;
}

/** A Microsoft Graph token (client credentials), from the cache while more than 5 minutes of it remain. */
export async function microsoftToken(credentials:MicrosoftCredentials,options:OAuthOptions={}):Promise<AccessToken>{
 const clock=options.clock??Date.now,key=tokenCacheKey('microsoft',[credentials.tenantId.toLowerCase(),credentials.clientId.toLowerCase(),''],credentials.clientSecret);
 const hit=cached(key,clock());
 if(hit)return {token:hit,key};
 const url=`https://${oauthHosts.microsoftLogin}/${encodeURIComponent(credentials.tenantId)}/oauth2/v2.0/token`;
 const body=form({grant_type:'client_credentials',client_id:credentials.clientId,client_secret:credentials.clientSecret,scope:graphScope});
 const {token,expiresIn}=await requestToken(url,body,microsoftTokenFailure,'microsoftSignInRefused',options);
 remember(key,token,expiresIn,clock());
 return {token,key};
}

const base64url=(value:string|Buffer)=>Buffer.from(value).toString('base64url');
/**
 * The signed JWT of a Google service account: header {alg RS256, typ JWT, kid},
 * claims {iss, sub, scope https://mail.google.com/, aud the token URL, iat,
 * exp iat+3600}, RS256 with the private key.
 */
export function googleAssertion(credentials:GoogleCredentials,issuedAt:number):string{
 const header=base64url(JSON.stringify({alg:'RS256',typ:'JWT',kid:credentials.privateKeyId}));
 const claims=base64url(JSON.stringify({iss:credentials.serviceAccount,sub:credentials.subject,scope:googleScope,aud:googleTokenUrl,iat:issuedAt,exp:issuedAt+tokenCacheLimits.assertionSeconds}));
 let key;
 try{key=createPrivateKey(credentials.privateKey);}catch{throw new NotifyError('secretUndecryptable');}
 return `${header}.${claims}.${base64url(sign('sha256',Buffer.from(`${header}.${claims}`),key))}`;
}
/** A Gmail token for the sender (JWT bearer with domain-wide delegation), from the cache while more than 5 minutes of it remain. */
export async function googleToken(credentials:GoogleCredentials,options:OAuthOptions={}):Promise<AccessToken>{
 const clock=options.clock??Date.now,key=tokenCacheKey('google',[credentials.serviceAccount.toLowerCase(),credentials.privateKeyId,credentials.subject.toLowerCase()],credentials.privateKey);
 const hit=cached(key,clock());
 if(hit)return {token:hit,key};
 const assertion=googleAssertion(credentials,Math.floor(clock()/1000));
 const body=form({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion});
 const {token,expiresIn}=await requestToken(googleTokenUrl,body,googleTokenFailure,'googleSignInRefused',options);
 remember(key,token,expiresIn,clock());
 return {token,key};
}
