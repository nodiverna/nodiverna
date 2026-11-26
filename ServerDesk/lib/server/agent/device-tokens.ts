import {body,config,guid,hash,HttpError,now,random} from '../context';
import {defaultLocale} from '../../i18n/locale';
import {translate} from '../../i18n/translate';
import {deriveKeyBytes} from '../../../runtime/secret-keyring.mjs';
import {commitAll,db,sql} from '../db';

export const deviceAccessTokenLifetime=15*60*1000;
export const deviceAccessTokenOverlap=2*60*1000;
export const deviceTokenChallengeLifetime=2*60*1000;
const encoder=new TextEncoder();
const purpose='ServerDesk device access token v1';
type DeviceTokenRow={id:string;token_hash:string;token_expires_at:number|null;agent_public_key:string|null};
type Challenge={version:1;serverId:string;challengeId:string;nonce:string;expiresAt:number;origin:string;algorithm:'RS256';message:string;proof:string};

// Registrations that no agent has picked up expire: a personal registration
// after 7 days, a customer-installer registration after 24 hours. Measured from
// creation; a connected agent switches to rotating key-bound tokens at once.
export const PERSONAL_REGISTRATION_LIFETIME=7*24*60*60*1000;
export const INSTALLER_REGISTRATION_LIFETIME=24*60*60*1000;
export const registrationExpiredMessage=translate(defaultLocale,'apiError.deviceToken.registrationExpired');

// Every device token expires: a registration token after its registration
// lifetime, a key-bound token after deviceAccessTokenLifetime, the previous token
// after its overlap. A token without expiry (token_expires_at NULL) is admitted
// nowhere; such a device needs a new registration.
export function deviceTokenSql(tokenHash:string,time=now(),alias=''){
 const p=alias?sql`${sql.ident(alias)}.`:sql``;
 return sql`${p}revoked=0 AND ((${p}token_hash=${tokenHash} AND ${p}token_expires_at>${time}) OR (${p}previous_token_hash=${tokenHash} AND ${p}previous_token_expires_at>${time}))`;
}
/** A column list of servers for deviceFromBearer: names separated by commas. */
const columnList=(columns:string)=>sql.join(columns.split(',').map(column=>sql.ident(column.trim())));
export async function deviceBearer(request:Request){
 const token=request.headers.get('authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
 if(!token)throw new HttpError('apiError.deviceToken.accessRequired');
 return hash(token);
}
export async function deviceTokenRejected(serverId:string,allowTokenRetry=false,tokenHash?:string):Promise<never>{
 const row=await db().one<{token_hash:string;token_expires_at:number|null;agent_public_key:string|null}>(sql`SELECT token_hash,token_expires_at,agent_public_key FROM servers WHERE id=${serverId} AND revoked=0`);
 // Only a caller holding the exact expired registration token learns that it
 // expired. Everyone else gets the unchanged generic rejection.
 if(row&&tokenHash!==undefined&&row.agent_public_key==null&&row.token_hash===tokenHash&&row.token_expires_at!=null&&row.token_expires_at<=now())throw new HttpError('apiError.deviceToken.registrationExpired');
 // This code is emitted only at the initial authentication gate and only when a
 // key proof can help (pinned key). The agent can safely obtain a new key proof
 // and retry without duplicating a dispatched job.
 throw new HttpError(allowTokenRetry&&row?.agent_public_key!=null?'apiError.agent.tokenRejected':'apiError.agent.notApproved');
}
// Resolves the device from the request headers alone, before any body is read,
// so an unauthenticated caller cannot make the portal buffer and parse large
// agent payloads. A GUID in X-ServerDesk-Device-Id (key-bound agents) selects
// the device and keeps the exact retry code even for tokens no device knows.
// Without it the device is found by its current or previous token hash; an
// unknown hash gets the generic rejection. `columns` is a trusted, constant
// column list of `servers`, never caller input.
export async function deviceFromBearer<Row extends {id:string}={id:string}>(request:Request,columns='id',options:{allowTokenRetry?:boolean;time?:number}={}):Promise<{device:Row;tokenHash:string}>{
 const tokenHash=await deviceBearer(request),auth=deviceTokenSql(tokenHash,options.time??now());
 const retry=options.allowTokenRetry===true,headerId=request.headers.get('X-ServerDesk-Device-Id');
 if(guid(headerId)){
  const device=await db().one<Row>(sql`SELECT ${columnList(columns)} FROM servers WHERE id=${headerId} AND ${auth}`);
  if(!device)return deviceTokenRejected(headerId,retry,tokenHash);
  return {device,tokenHash};
 }
 const device=await db().one<Row>(sql`SELECT ${columnList(columns)} FROM servers WHERE ${auth} LIMIT 1`);
 if(device)return {device,tokenHash};
 const known=await db().one<{id:string}>(sql`SELECT id FROM servers WHERE revoked=0 AND (token_hash=${tokenHash} OR previous_token_hash=${tokenHash}) LIMIT 1`);
 if(known)await deviceTokenRejected(known.id,retry,tokenHash);
 throw new HttpError('apiError.agent.notApproved');
}
function encode(bytes:Uint8Array){return btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');}
function decode(value:string){return Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')),character=>character.charCodeAt(0));}
/** SITE_ORIGIN when it is a bare https: origin; otherwise 503. Agents and installers pin this value. */
export function secureSiteOrigin(){
 const value=config('SITE_ORIGIN');
 try{const url=new URL(value);if(url.origin!==value||url.protocol!=='https:')throw new Error();return value;}
 catch{throw new HttpError('apiError.deviceToken.originNotConfigured');}
}
async function signingKey(){
 const secret=config('SESSION_SECRET');
 if(secret.length<32)throw new HttpError('apiError.deviceToken.registrationUnavailable');
 // Own HKDF purpose of the keyring. Challenges live two minutes and are only
 // signed and verified with the current secret, never with a previous one.
 return crypto.subtle.importKey('raw',await deriveKeyBytes(secret,'device-token-challenges'),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
}
function message(challenge:Pick<Challenge,'origin'|'serverId'|'challengeId'|'nonce'|'expiresAt'>){
 return [purpose,challenge.origin,challenge.serverId,challenge.challengeId,challenge.nonce,challenge.expiresAt].join('\n');
}
async function proofMaterial(challenge:Pick<Challenge,'origin'|'serverId'|'challengeId'|'nonce'|'expiresAt'>,device:DeviceTokenRow){
 return encoder.encode(message(challenge)+'\n'+await hash(device.agent_public_key!)+'\n'+device.token_hash);
}
function publicKey(device:DeviceTokenRow):JsonWebKey{
 try{
  const value=JSON.parse(device.agent_public_key??'');
  if(value.kty!=='RSA'||!/^[a-zA-Z0-9_-]{342}$/.test(value.n)||value.e!=='AQAB')throw new Error();
  return {kty:'RSA',n:value.n,e:value.e,ext:true};
 }catch{throw new HttpError('apiError.deviceToken.keyRequired');}
}
// A key proof renews only a token with expiry; a device whose token never
// expires (token_expires_at NULL) needs a new registration.
async function device(serverId:string){
 const row=await db().one<DeviceTokenRow>(sql`SELECT id,token_hash,token_expires_at,agent_public_key FROM servers WHERE id=${serverId} AND revoked=0 AND token_expires_at IS NOT NULL`);
 if(!row)throw new HttpError('apiError.agent.notApproved');
 publicKey(row);
 return row;
}

export async function issueDeviceTokenChallenge(request:Request):Promise<Challenge>{
 const payload=await body(request,4096);
 if(!guid(payload.serverId)||Object.keys(payload).some(key=>key!=='serverId'))throw new HttpError('apiError.deviceToken.invalidRequest');
 const row=await device(payload.serverId);
 const challenge={version:1 as const,serverId:row.id,challengeId:crypto.randomUUID(),nonce:encode(crypto.getRandomValues(new Uint8Array(32))),expiresAt:Math.floor((now()+deviceTokenChallengeLifetime)/1000),origin:secureSiteOrigin(),algorithm:'RS256' as const};
 // Issuance is stateless: callers cannot exhaust a device's nonce quota or
 // invalidate a legitimate challenge by requesting another one.
 const proof=encode(new Uint8Array(await crypto.subtle.sign('HMAC',await signingKey(),await proofMaterial(challenge,row))));
 return {...challenge,message:message(challenge),proof};
}

export async function renewDeviceToken(request:Request){
 const payload=await body(request,4096);
 const allowed=['serverId','challengeId','nonce','expiresAt','proof','signature'];
 if(!guid(payload.serverId)||!guid(payload.challengeId)||typeof payload.nonce!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(payload.nonce)||!Number.isSafeInteger(payload.expiresAt)||typeof payload.proof!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(payload.proof)||typeof payload.signature!=='string'||!/^[A-Za-z0-9+/]{342}==$/.test(payload.signature)||Object.keys(payload).some(key=>!allowed.includes(key)))throw new HttpError('apiError.deviceToken.invalidProof');
 const time=now(),expiresAt=payload.expiresAt*1000;
 if(expiresAt<=time||expiresAt>time+deviceTokenChallengeLifetime)throw new HttpError('apiError.deviceToken.challengeExpired');
 const row=await device(payload.serverId),challenge={serverId:row.id,challengeId:payload.challengeId,nonce:payload.nonce,expiresAt:payload.expiresAt,origin:secureSiteOrigin()};
 if(!await crypto.subtle.verify('HMAC',await signingKey(),decode(payload.proof),await proofMaterial(challenge,row)))throw new HttpError('apiError.deviceToken.challengeChanged');
 const key=await crypto.subtle.importKey('jwk',publicKey(row),{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
 if(!await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,Uint8Array.from(atob(payload.signature),character=>character.charCodeAt(0)),encoder.encode(message(challenge))))throw new HttpError('apiError.deviceToken.proofRejected');
 const token=random(),tokenHash=await hash(token),tokenExpiresAt=time+deviceAccessTokenLifetime;
 const nonceHash=await hash(row.id+'\n'+payload.challengeId+'\n'+payload.nonce);
 // The old token keeps a two-minute overlap, never past its own expiry.
 // The device row is locked first, so parallel rotations queue instead of retrying.
 const [,...results]=await commitAll([
  sql`SELECT id FROM servers WHERE id=${row.id} FOR UPDATE`,
  sql`UPDATE servers SET previous_token_hash=token_hash,previous_token_expires_at=LEAST(token_expires_at,${time+deviceAccessTokenOverlap}),token_hash=${tokenHash},token_expires_at=${tokenExpiresAt},token_rotated_at=${time} WHERE id=${row.id} AND revoked=0 AND token_hash=${row.token_hash} AND token_expires_at IS NOT NULL AND agent_public_key=${row.agent_public_key} AND NOT EXISTS (SELECT 1 FROM device_token_nonces WHERE nonce_hash=${nonceHash})`,
  sql`INSERT INTO device_token_nonces (nonce_hash,server_id,expires_at) SELECT ${nonceHash},${row.id},${expiresAt} WHERE EXISTS (SELECT 1 FROM servers WHERE id=${row.id} AND revoked=0 AND token_hash=${tokenHash} AND agent_public_key=${row.agent_public_key}) ON CONFLICT DO NOTHING`,
  sql`DELETE FROM device_token_nonces WHERE expires_at<=${time}`
 ]);
 if(results[0].rowCount!==1||results[1].rowCount!==1)throw new HttpError('apiError.deviceToken.challengeUsed');
 // Only hashes are stored. A lost response is recovered with a fresh proof of
 // the durable device key, even after the client's last bearer has expired.
 return {serverId:row.id,token,tokenMode:'key-bound',expiresIn:deviceAccessTokenLifetime/1000,expiresAt:new Date(tokenExpiresAt).toISOString()};
}
