import {
 generateRegistrationOptions,verifyRegistrationResponse,
 generateAuthenticationOptions,verifyAuthenticationResponse,
 type RegistrationResponseJSON,type AuthenticationResponseJSON,type AuthenticatorTransportFuture,
} from '@simplewebauthn/server';
import {config,hash,HttpError,now,random} from '../context';
import {principal} from './access';
import {localFactorsSql,refuseEntraFactors,authenticatorCount,countAttempt,factorsRemainSql,isMfaEnabled,issueSession,managementAuthorization,mfaAvailable,mfaProofUntil,mfaSessionFence,mfaSessionHash,ownProofDelete,recoveryCodes,requireLiveSessions,requireMfa,type PasskeySessionGrant} from './mfa';
import type {ManagementAuthorization} from './rbac';
import {commitWithAudit} from '../security-commit';
import {emergencyPrincipalFixed} from './entra/emergency';
import type {Viewer} from '../../types';
import {productName} from '../../brand';
import {commitAll,db,dbNow,sql} from '../db';
import {isUniqueViolation} from '../errors/db-codes';

const challengeLifetime=300000,maximumCredentials=20;
const setupNames={local:'Dieses Gerät',phone:'Mein Smartphone'} as const;
const browserCookie='__Host-serverdesk-passkey';
const encoder=new TextEncoder();
type Device='local'|'phone'|'any';
type CredentialRow={id:string;principal:string;public_key:string;counter:number;transports:string;name:string;device:string;device_type:string;backed_up:number;created_at:number;last_used_at:number|null};
type ChallengeRow={id:string;principal:string;purpose:string;challenge:string;browser_hash:string;session_hash:string|null;rp_id:string;origin:string;name:string;device:string;expires_at:number};
const encode=(bytes:Uint8Array)=>btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const decode=(value:string)=>Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
export const clearPasskeyCookie=()=>`${browserCookie}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
function cookieToken(request:Request){return (request.headers.get('cookie')??'').split(';').map(p=>p.trim()).find(p=>p.startsWith(browserCookie+'='))?.slice(browserCookie.length+1)??'';}
function relyingParty(){
 const configured=config('SITE_ORIGIN');let url:URL;
 try{url=new URL(configured);}catch{throw new HttpError('apiError.passkey.originNotConfigured');}
 if(url.protocol!=='https:'||url.origin!==configured||url.username||url.password||!mfaAvailable())throw new HttpError('apiError.passkey.httpsRequired');
 return {origin:url.origin,rpID:url.hostname};
}
export function passkeysAvailable(){try{relyingParty();return true;}catch{return false;}}
function deviceValue(value:unknown,registration=false):Device{
 if(value==='local'||value==='phone'||!registration&&(value==='any'||value===undefined))return (value??'any') as Device;
 throw new HttpError('apiError.passkey.invalidDevice');
}
function nameValue(value:unknown){if(typeof value!=='string'||!value.trim()||value.trim().length>80||/[\u0000-\u001f\u007f]/.test(value))throw new HttpError('apiError.passkey.name');return value.trim();}
function idValue(value:unknown){if(typeof value!=='string'||!/^[A-Za-z0-9_-]{1,1400}$/.test(value))throw new HttpError('apiError.passkey.invalid');return value;}
async function userHandle(v:Viewer){return decode(encode(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode('ServerDesk:passkey-user:'+principal(v))))));}
function transports(row:CredentialRow):AuthenticatorTransportFuture[]{
 const allowed=['usb','nfc','ble','internal','hybrid','cable','smart-card'];
 const values:unknown=JSON.parse(row.transports);return Array.isArray(values)?values.filter((t):t is AuthenticatorTransportFuture=>typeof t==='string'&&allowed.includes(t)):[];
}
async function credentials(v:Viewer){return (await db().query<CredentialRow>(sql`SELECT * FROM passkey_credentials WHERE principal = ${principal(v)} ORDER BY created_at DESC`));}
export async function passkeyStatus(request:Request,v:Viewer){
 const rows=await credentials(v),canManage=!!await mfaProofUntil(request,v);
 // The step-up dialog learns from authenticatorCount whether a TOTP field fits.
 return {available:passkeysAvailable(),count:rows.length,authenticatorCount:await authenticatorCount(v),canManage,passkeys:canManage?rows.map(row=>({id:row.id,name:row.name,device:row.device,deviceType:row.device_type,backedUp:!!row.backed_up,createdAt:row.created_at,lastUsedAt:row.last_used_at})):[]};
}
async function limitOptions(v:Viewer){
 const time=now(),cutoff=time-60000;
 const changed=await db().one<{attempts:number}>(sql`INSERT INTO passkey_rate_limits (principal,attempts,window_at) VALUES (${principal(v)},1,${time}) ON CONFLICT(principal) DO UPDATE SET attempts = CASE WHEN passkey_rate_limits.window_at < ${cutoff} THEN 1 ELSE passkey_rate_limits.attempts + 1 END,window_at = CASE WHEN passkey_rate_limits.window_at < ${cutoff} THEN excluded.window_at ELSE passkey_rate_limits.window_at END RETURNING attempts`);
 if(changed&&changed.attempts>30)throw new HttpError('apiError.passkey.rateLimited');
}
// A registration challenge needs the live management proof: its insert is
// guarded by `authorization` and the proof is consumed in the same batch. A setup
// challenge (first enrollment) needs the live primary session and no MFA yet.
async function makeChallenge(request:Request,v:Viewer,purpose:'registration'|'authentication'|'setup',challenge:string,{name='',device='any',authorization}:{name?:string;device?:Device;authorization?:ManagementAuthorization}={}){
 const {origin,rpID}=relyingParty(),id=random(),token=random(),time=now(),key=principal(v);
 const sessionHash=purpose==='registration'?await mfaSessionHash(request,v):null;
 if(purpose==='registration'&&(!authorization||sessionHash!==authorization.sessionHash))throw new HttpError('apiError.mfa.stepUpRequired');
 let guard=sql``;
 if(purpose==='registration')guard=sql` WHERE EXISTS (SELECT 1 FROM mfa_sessions WHERE token_hash = ${sessionHash} AND principal = ${key} AND idle_expires_at > ${time} AND expires_at > ${time}) AND EXISTS (SELECT 1 FROM mfa_accounts WHERE principal = ${key}) AND (${authorization!.guard})`;
 else if(purpose==='setup'){
  const {primaryAuthenticationGuard}=await import('./local-auth'),authentication=await primaryAuthenticationGuard(request,v);
  guard=sql` WHERE (${authentication}) AND NOT EXISTS (SELECT 1 FROM mfa_accounts WHERE principal = ${key})`;
 }
 const results=await commitAll([
  sql`DELETE FROM passkey_challenges WHERE expires_at <= ${time}`,
  sql`INSERT INTO passkey_challenges (id,principal,purpose,challenge,browser_hash,session_hash,rp_id,origin,name,device,expires_at) SELECT ${id},${key},${purpose},${challenge},${await hash(token)},${sessionHash},${rpID},${origin},${name},${device},${time+challengeLifetime}${guard}`,
  ...(authorization?[ownProofDelete(authorization)]:[]),
 ]);
 if(!results[1]?.rowCount){
  if(purpose==='setup'){
   if(await isMfaEnabled(v))throw new HttpError('apiError.passkey.setupDone');
   throw new HttpError('apiError.auth.loginExpiredSignIn');
  }
  if(authorization&&results[2]?.rowCount)await requireLiveSessions(request,v);
  throw new HttpError('apiError.mfa.stepUpRequired');
 }
 return {challengeId:id,cookies:[`${browserCookie}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${challengeLifetime/1000}`]};
}
async function loadChallenge(request:Request,v:Viewer,id:unknown,purpose:string){
 if(typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id))throw new HttpError('apiError.passkey.invalidRequest');
 const token=cookieToken(request);if(!/^[a-f0-9]{64}$/.test(token))throw new HttpError('apiError.passkey.ceremonyExpired');
 const row=await db().one<ChallengeRow>(sql`SELECT * FROM passkey_challenges WHERE id = ${id} AND principal = ${principal(v)} AND purpose = ${purpose} AND browser_hash = ${await hash(token)} AND expires_at > ${now()}`);
 const {origin,rpID}=relyingParty();
 if(!row||row.origin!==origin||row.rp_id!==rpID)throw new HttpError('apiError.passkey.ceremonyExpiredOrUsed');
 return row;
}
// A primary-key clash on the credential ID (SQLSTATE 23505 on
// passkey_credentials_pkey). No other constraint maps to the duplicate-passkey 409.
const duplicateCredential=(e:unknown)=>isUniqueViolation(e,'passkey_credentials_pkey');
async function discardChallenge(row:ChallengeRow){await db().exec(sql`DELETE FROM passkey_challenges WHERE id = ${row.id} AND principal = ${row.principal}`);}
function responseValue(value:unknown){
 if(!value||typeof value!=='object'||Array.isArray(value))throw new HttpError('apiError.passkey.invalidResponse');
 const response=value as Record<string,unknown>;
 idValue(response.id);
 if(response.type!=='public-key'||response.rawId!==response.id||!response.response||typeof response.response!=='object'||Array.isArray(response.response))throw new HttpError('apiError.passkey.invalidResponse');
 const clientData=(response.response as Record<string,unknown>).clientDataJSON;
 if(typeof clientData!=='string'||clientData.length>8192)throw new HttpError('apiError.passkey.invalidResponse');
 let client:Record<string,unknown>;
 try{client=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(decode(clientData)));}catch{throw new HttpError('apiError.passkey.invalidResponse');}
 if(client.crossOrigin===true||client.topOrigin!==undefined)throw new HttpError('apiError.passkey.ownTab',{product:productName});
 return response;
}
// Registration options shared by adding a passkey and the first enrollment:
// user verification and a discoverable credential are always required.
async function creationOptions(v:Viewer,device:Device,existing:CredentialRow[]){
 return generateRegistrationOptions({
  rpName:productName,rpID:relyingParty().rpID,userName:v.label,userDisplayName:v.label,userID:await userHandle(v),
  timeout:challengeLifetime,attestationType:'none',supportedAlgorithmIDs:[-7,-257],
  excludeCredentials:existing.map(row=>({id:row.id,transports:transports(row)})),
  authenticatorSelection:{residentKey:'required',userVerification:'required',authenticatorAttachment:device==='local'?'platform':'cross-platform'},
  preferredAuthenticatorType:device==='local'?'localDevice':'remoteDevice',
 });
}
type Registration=NonNullable<Awaited<ReturnType<typeof verifyRegistrationResponse>>['registrationInfo']>;
// A failed verification discards the challenge: the same response cannot pass later.
async function verifiedRegistration(row:ChallengeRow,response:unknown):Promise<Registration>{
 try{
  const verification=await verifyRegistrationResponse({response:responseValue(response) as unknown as RegistrationResponseJSON,expectedChallenge:row.challenge,expectedOrigin:row.origin,expectedRPID:row.rp_id,requireUserVerification:true,supportedAlgorithmIDs:[-7,-257]});
  if(!verification.verified||!verification.registrationInfo)throw new Error('Verification failed');
  return verification.registrationInfo;
 }catch(e){await discardChallenge(row);if(e instanceof HttpError)throw e;throw new HttpError('apiError.passkey.verifyFailed');}
}
export async function registrationOptions(request:Request,v:Viewer,p:Record<string,unknown>){
 refuseEntraFactors(v);
 relyingParty();await requireMfa(request,v);await limitOptions(v);
 const name=nameValue(p.name),device=deviceValue(p.device,true),existing=await credentials(v);
 if(existing.length>=maximumCredentials)throw new HttpError('apiError.passkey.limit');
 const authorization=await managementAuthorization(request,v,p.managementToken);
 const options=await creationOptions(v,device,existing);
 return {...await makeChallenge(request,v,'registration',options.challenge,{name,device,authorization}),options};
}
export async function registrationVerify(request:Request,v:Viewer,p:Record<string,unknown>){
 refuseEntraFactors(v);
 await requireMfa(request,v);const row=await loadChallenge(request,v,p.challengeId,'registration');
 if(row.session_hash!==await mfaSessionHash(request,v)){await discardChallenge(row);throw new HttpError('apiError.passkey.loginChanged');}
 await countAttempt(principal(v));
 const registration=await verifiedRegistration(row,p.response);
 // The credential, the challenge delete and the audit row share one batch. A
 // failed commit changed nothing. A credential ID that is already stored (for
 // this or another account) cannot succeed on retry, so that case discards the
 // challenge and returns one neutral 409. Any other failure (for example the
 // audit insert) keeps the challenge open for a retry with the same response.
 const {credential,credentialDeviceType,credentialBackedUp}=registration,time=now(),fence=await mfaSessionFence(request,v);
 // Effect marker: this batch's credential row and the still-open challenge,
 // which only the batch that deletes it can see.
 const marker=sql`(${fence}) AND EXISTS (SELECT 1 FROM passkey_credentials WHERE id = ${credential.id} AND principal = ${row.principal} AND created_at = ${time}) AND EXISTS (SELECT 1 FROM passkey_challenges WHERE id = ${row.id} AND principal = ${row.principal} AND browser_hash = ${row.browser_hash})`;
 // The UNIQUE error can only occur once the insert's session and account
 // guards passed, so a stale request still gets its stale outcome below.
 const {results,audited}=await commitWithAudit([
  sql`INSERT INTO passkey_credentials (id,principal,public_key,counter,transports,name,device,device_type,backed_up,created_at,last_used_at) SELECT ${credential.id},${row.principal},${encode(credential.publicKey)},${credential.counter},${JSON.stringify(credential.transports??[])},${row.name},${row.device},${credentialDeviceType},${credentialBackedUp?1:0},${time},NULL WHERE EXISTS (SELECT 1 FROM passkey_challenges WHERE id = ${row.id} AND principal = ${row.principal} AND browser_hash = ${row.browser_hash} AND expires_at > ${time}) AND EXISTS (SELECT 1 FROM mfa_sessions WHERE token_hash = ${row.session_hash} AND principal = ${row.principal} AND idle_expires_at > ${time} AND expires_at > ${time}) AND EXISTS (SELECT 1 FROM mfa_accounts WHERE principal = ${row.principal}) AND (SELECT COUNT(*) FROM passkey_credentials WHERE principal = ${row.principal}) < ${maximumCredentials} AND (${fence})`,
  sql`DELETE FROM passkey_challenges WHERE id = ${row.id} AND principal = ${row.principal}`,
 ],{audit:{actor:v.label,action:'Passkey eingerichtet',target:v.label},guard:marker,at:1}).catch(async(e:unknown)=>{
  if(!duplicateCredential(e))throw e;
  await discardChallenge(row);
  throw new HttpError('apiError.passkey.duplicate');
 });
 if(!audited||!results[0]?.rowCount){
  await requireLiveSessions(request,v);
  throw new HttpError('apiError.passkey.setupExpired');
 }
 return {ok:true,cookies:[clearPasskeyCookie()]};
}
// First enrollment with a passkey instead of an authenticator app. Like beginMfa
// it needs only the live (pending or bound) primary session, never an MFA session
// or management proof.
export async function setupOptions(request:Request,v:Viewer,p:Record<string,unknown>){
 refuseEntraFactors(v);
 relyingParty();await limitOptions(v);
 if(await isMfaEnabled(v))throw new HttpError('apiError.passkey.setupDone');
 const device=deviceValue(p.device,true) as 'local'|'phone',options=await creationOptions(v,device,await credentials(v));
 return {...await makeChallenge(request,v,'setup',options.challenge,{name:setupNames[device],device}),options};
}
export async function setupVerify(request:Request,v:Viewer,p:Record<string,unknown>){
 refuseEntraFactors(v);
 const row=await loadChallenge(request,v,p.challengeId,'setup');await countAttempt(principal(v));
 const {credential,credentialDeviceType,credentialBackedUp}=await verifiedRegistration(row,p.response);
 try{
  const key=row.principal,time=now(),recovery=await recoveryCodes(key);
  // The account insert runs before the session binding in the same batch, so it is
  // guarded by the binding's own predicates at the same app time (`at` below): a
  // session that cannot be bound leaves no account or credential behind. Keep this
  // coupled to bindLocalMfaStatements().bind (tests/api/passkey-first-setup.mjs, session-binding refusals).
  const {localBindGuard}=await import('./local-auth'),authentication=await localBindGuard(request,v,time);
  const challenge=sql`EXISTS (SELECT 1 FROM passkey_challenges WHERE id = ${row.id} AND principal = ${key} AND browser_hash = ${row.browser_hash} AND purpose = 'setup' AND expires_at > ${time} AND expires_at > ${dbNow})`;
  // The new recovery-hash list is unique to this batch and marks its account row.
  const account=sql`EXISTS (SELECT 1 FROM mfa_accounts WHERE principal = ${key} AND recovery_hashes = ${recovery.hashes})`;
  // Account, credential, pending TOTP setup and challenge commit together with the
  // session, management proof and audit row (issueSession). The challenge delete
  // is unguarded: a refused batch leaves nothing behind but an unusable challenge.
  const enrollment=[
   sql`INSERT INTO mfa_accounts (principal,secret_enc,recovery_hashes,last_counter,created_at,authenticators_migrated) SELECT ${key},'migrated:authenticator-managed',${recovery.hashes},-1,${time},1 WHERE ${challenge} AND NOT EXISTS (SELECT 1 FROM mfa_accounts WHERE principal = ${key}) AND ${localFactorsSql(key)} AND (${authentication})`,
   sql`INSERT INTO passkey_credentials (id,principal,public_key,counter,transports,name,device,device_type,backed_up,created_at,last_used_at) SELECT ${credential.id},${key},${encode(credential.publicKey)},${credential.counter},${JSON.stringify(credential.transports??[])},${row.name},${row.device},${credentialDeviceType},${credentialBackedUp?1:0},${time},NULL WHERE ${challenge} AND ${account}`,
   sql`DELETE FROM mfa_challenges WHERE principal = ${key} AND ${account}`,
   sql`DELETE FROM passkey_challenges WHERE id = ${row.id} AND principal = ${key}`,
  ];
  // The session insert also requires this batch's credential, so a concurrent
  // enrollment (account already present) issues no session, proof or audit row.
  const session=await issueSession(v,{request,resetAttempts:true,passkeySetup:{credentialId:credential.id,createdAt:time},prelude:{statements:enrollment},at:time,audit:{actor:v.label,action:'MFA mit Passkey eingerichtet',target:v.label},conflict:new HttpError('apiError.mfa.setupUsed')});
  return {...session,cookies:[...session.cookies,clearPasskeyCookie()],recoveryCodes:recovery.codes};
 }catch(e){
  // A stored credential ID or a refused commit cannot succeed on retry. Any other
  // failure (for example the audit insert) rolled back and keeps the challenge.
  if(duplicateCredential(e)){await discardChallenge(row);throw new HttpError('apiError.passkey.duplicate');}
  if(e instanceof HttpError)await discardChallenge(row);
  throw e;
 }
}
export async function authenticationOptions(request:Request,v:Viewer,p:Record<string,unknown>){
 refuseEntraFactors(v);
 relyingParty();await limitOptions(v);
 if(!await isMfaEnabled(v))throw new HttpError('apiError.passkey.setUpMfaFirst');
 const device=deviceValue(p.device),existing=await credentials(v);
 if(!existing.length)throw new HttpError('apiError.passkey.noneForAccount');
 const options=await generateAuthenticationOptions({rpID:relyingParty().rpID,timeout:challengeLifetime,userVerification:'required',allowCredentials:existing.map(row=>({id:row.id,transports:transports(row)}))});
 // Hints guide the native chooser; browsers retain control over available providers.
 const hinted={...options,...(device==='any'?{}:{hints:[device==='local'?'client-device':'hybrid']})};
 return {...await makeChallenge(request,v,'authentication',options.challenge,{device}),options:hinted};
}
export async function authenticationVerify(request:Request,v:Viewer,p:Record<string,unknown>){
 refuseEntraFactors(v);
 const row=await loadChallenge(request,v,p.challengeId,'authentication');await countAttempt(principal(v));
 let passkeyGrant:PasskeySessionGrant;
 try{
  const response=responseValue(p.response) as unknown as AuthenticationResponseJSON;
  const credential=await db().one<CredentialRow>(sql`SELECT * FROM passkey_credentials WHERE id = ${response.id} AND principal = ${principal(v)}`);
  if(!credential)throw new Error('Unknown credential');
  const user=response.response.userHandle;
  if(user!==undefined&&user!==null&&user!==encode(await userHandle(v)))throw new Error('Wrong user handle');
  const verification=await verifyAuthenticationResponse({response,expectedChallenge:row.challenge,expectedOrigin:row.origin,expectedRPID:row.rp_id,requireUserVerification:true,credential:{id:credential.id,publicKey:decode(credential.public_key),counter:credential.counter,transports:transports(credential)}});
  if(!verification.verified)throw new Error('Verification failed');
  passkeyGrant={challengeId:row.id,browserHash:row.browser_hash,credentialId:credential.id,counter:credential.counter,newCounter:verification.authenticationInfo.newCounter,backedUp:verification.authenticationInfo.credentialBackedUp};
 }catch(e){await discardChallenge(row);if(e instanceof HttpError)throw e;throw new HttpError('apiError.passkey.loginFailed');}
 // The challenge delete, counter update, session and audit row share one batch.
 // A failed commit (no HttpError) changed nothing, so the challenge stays open.
 try{
  const session=await issueSession(v,{request,resetAttempts:true,passkeyGrant,audit:{actor:v.label,action:'Mit Passkey angemeldet',target:v.label}});
  return {...session,cookies:[...session.cookies,clearPasskeyCookie()]};
 }catch(e){if(e instanceof HttpError)await discardChallenge(row);throw e;}
}
export async function renamePasskey(request:Request,v:Viewer,p:Record<string,unknown>){
 refuseEntraFactors(v);
 await requireMfa(request,v);const name=nameValue(p.name),id=idValue(p.id),key=principal(v),fence=await mfaSessionFence(request,v);
 // at:0 is valid: the rename changes neither the fence nor the credential's
 // existence, so the guard reads the same before and after the update.
 const {results,audited}=await commitWithAudit([
  sql`UPDATE passkey_credentials SET name = ${name} WHERE id = ${id} AND principal = ${key} AND ${fence}`,
 ],{audit:{actor:v.label,action:'Passkey umbenannt',target:v.label},guard:sql`(${fence}) AND EXISTS (SELECT 1 FROM passkey_credentials WHERE id = ${id} AND principal = ${key})`,at:0});
 if(!audited||!results[0]?.rowCount){
  if(!await credentialExists(id,key))throw new HttpError('apiError.passkey.notFound');
  throw new HttpError('apiError.auth.signInAgain');
 }
 return {ok:true};
}
const credentialExists=async(id:string,key:string)=>!!await db().one(sql`SELECT 1 AS found FROM passkey_credentials WHERE id = ${id} AND principal = ${key}`);
const factorsRemain=async(key:string)=>!!await db().one(sql`SELECT 1 AS remain WHERE ${factorsRemainSql(key)}`);
export async function deletePasskey(request:Request,v:Viewer,p:Record<string,unknown>){
 refuseEntraFactors(v);
 await requireMfa(request,v);const key=principal(v),id=idValue(p.id);
 const auth=await managementAuthorization(request,v,p.managementToken);
 // An unknown id and the last factor write nothing and leave the proof unused.
 if(!await credentialExists(id,key))throw new HttpError('apiError.passkey.notFound');
 if(!await factorsRemain(key))throw new HttpError(await emergencyPrincipalFixed(key)?'apiError.mfa.emergencyFactorRequired':'apiError.passkey.lastFactor');
 // G: live primary session, live MFA session and proof, the credential and a
 // second factor. Challenge and grant deletes do not change G, so the audit row
 // at index 0 sees the same guard as the credential delete (delete rule of
 // commitWithAudit).
 const guard=sql`(${auth.guard}) AND EXISTS (SELECT 1 FROM passkey_credentials WHERE id = ${id} AND principal = ${key}) AND ${factorsRemainSql(key)}`;
 const {results,audited}=await commitWithAudit([
  sql`DELETE FROM passkey_challenges WHERE principal = ${key} AND ${guard}`,
  sql`DELETE FROM mfa_grants WHERE principal = ${key} AND ${guard}`,
  sql`DELETE FROM passkey_credentials WHERE id = ${id} AND principal = ${key} AND ${auth.guard} AND ${factorsRemainSql(key)}`,
  // Runs after the credential delete and without `auth`: the current MFA session
  // may itself have been opened with this passkey, and removing it ends `auth`.
  // The credential is gone only if this batch (or an earlier delete) removed it.
  sql`DELETE FROM mfa_sessions WHERE principal = ${key} AND passkey_id = ${id} AND NOT EXISTS (SELECT 1 FROM passkey_credentials WHERE id = ${id} AND principal = ${key})`,
  sql`DELETE FROM mfa_management_proofs WHERE token_hash = ${auth.tokenHash} AND principal = ${auth.key} AND session_hash = ${auth.sessionHash}`,
 ],{audit:{actor:v.label,action:'Passkey entfernt',target:v.label},guard,at:0});
 if(audited&&results[2]?.rowCount===1)return {ok:true};
 if(!results[4]?.rowCount)throw new HttpError('apiError.mfa.stepUpRequired');
 if(!await credentialExists(id,key))throw new HttpError('apiError.passkey.notFound');
 // A concurrent delete removed the other factor: the proof is consumed as for
 // every stale request, and the passkey stays.
 if(!await factorsRemain(key))throw new HttpError(await emergencyPrincipalFixed(key)?'apiError.mfa.emergencyFactorRequired':'apiError.passkey.lastFactor');
 throw new HttpError('apiError.auth.signInAgain');
}
