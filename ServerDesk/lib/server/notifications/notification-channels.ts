// Server side of the notification channels (docs/notifications.md): the list of
// GET /api/notifications/channels and the actions of POST. Every read and write
// needs the global portal right portal.notifications.manage. Changes rely on the
// live MFA login session (lib/step-up.ts: notification edits are low impact),
// commit behind the session fence and with exactly one portal audit row. test sends one test message without step-up: at most 5 per user in 60 s,
// and its log rows commit with one audit row under the write guard. Secrets
// (the SMTP password, the Microsoft 365 client secret, the Google service account
// private key, the Teams, Discord and webhook URL, the webhook signing key) are
// stored only as keyring ciphertext with the context notification-channel:<id>;
// no answer, audit row or log line carries them, except the signing key once
// after create and rotate-secret. An email channel signs in with a password,
// Microsoft 365 or Google Workspace (auth); a stored config without auth is a
// password channel.
// app/api/notifications/channels/route.ts is a thin adapter.
import {isIP} from 'node:net';
import {createPrivateKey,randomBytes} from 'node:crypto';
import {config,guid,HttpError,now} from '../context';
import {globalPermissionGuard,hasGlobalPermission,principal,type SqlGuard} from '../identity/access';
import {auditAfterChange,auditEvent} from '../audit';
import {featureWriteGuard} from '../identity/feature-authorization';
import {decryptSecret,encryptSecret,mfaSessionFence,requireLiveSessions} from '../identity/mfa';
import {isUniqueViolation} from '../errors/db-codes';
import {productName} from '../../brand';
import {db,sql,type Sql} from '../db';
import type {Locale} from '../../i18n/locale';
import type {Viewer} from '../../types';
import {sendNotification,type ChannelSecret,type ChannelTarget,type ChannelType,type SmtpAuth,type SmtpConfig} from './notify/send';
import {notifyErrorKey,type NotifyFailureReason} from './notify/transport';
import type {SmtpTls} from './notify/smtp';
import {isDiscordWebhookUrl} from '../../discord-webhook-url';
import {portalEmailLogoUrl} from '../branding';

export const notificationsRight='portal.notifications.manage';
export const channelTypes:readonly ChannelType[]=['smtp','teams','discord','webhook'];
export const smtpTlsModes:readonly SmtpTls[]=['tls','starttls','none'];
export const maxRecipients=20;
/** The sign-ins of an email channel, in the order of the drawer. */
export const smtpAuthModes:readonly SmtpAuth[]=['password','microsoft365','google'];
/** The JSON key file of a Google service account: at most 16 KiB. */
export const serviceAccountKeyBytes=16*1024;
export type ChannelField='name'|'type'|'enabled'|'language'|'auth'|'host'|'port'|'tls'|'from'|'recipients'|'username'|'password'|'tenantId'|'clientId'|'clientSecret'|'serviceAccountKey'|'url'|'revision'|'id';
/**
 * The settings a client sees: the SMTP settings with their sign-in (auth) and
 * without the password, client secret or key, nothing for Teams, Discord and
 * webhooks. secretSet: an email channel has a stored secret.
 */
export type ChannelView={
 id:string;type:ChannelType;name:string;enabled:boolean;language:Locale;
 config:SmtpConfig|Record<string,never>;secretSet:boolean;targetHint:string;revision:number;
 /** Notification rules that use the channel (deleted with it). */
 ruleCount:number;
 /** The newest finished delivery: sent_at or the time of the last failed attempt. */
 lastDelivery:{at:number;status:'sent'|'failed'}|null;
};
type ChannelRow={id:string;type:ChannelType;name:string;enabled:number;language:string;config:string;secret:string|null;target_hint:string;revision:number|string;rule_count?:number|string;last_at?:number|string|null;last_status?:string|null};

const forbidden=()=>new HttpError('apiError.notify.forbidden');
const invalid=(field:ChannelField)=>new HttpError('apiError.notify.channelInvalid',{field});
const discordUrlWrongType=()=>new HttpError('apiError.notify.discordUrlWrongType',{field:'url'});
const changed=()=>new HttpError('apiError.notify.channelChanged');
const notFound=()=>new HttpError('apiError.notify.channelNotFound');
const nameTaken=()=>new HttpError('apiError.notify.channelNameTaken');
const testRateLimited=()=>new HttpError('apiError.notify.testRateLimited');
/** Test messages per principal and window: at most 5 in a fixed window of 60 s, across all channels. */
export const testMessageLimit={attempts:5,windowMs:60_000};
/** 403 unless the viewer holds the global right portal.notifications.manage (evaluated live). */
export async function requireNotificationsRight(v:Viewer){if(!await hasGlobalPermission(v,notificationsRight))throw forbidden();}
const rightGuard=(v:Viewer):SqlGuard=>featureWriteGuard(v,globalPermissionGuard(sql`${principal(v)}`,notificationsRight));
export const secretContext=(id:string)=>`notification-channel:${id}`;

// ---- Validation ---------------------------------------------------------------

const controlCharacters=/[\u0000-\u001f\u007f]/;
const hostnamePattern=/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.?$/i;
const emailPattern=/^[^\s@<>()",;:\\[\]]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
export const validEmail=(value:unknown):value is string=>typeof value==='string'&&value.length<=254&&!controlCharacters.test(value)&&emailPattern.test(value);
export function validHost(value:unknown):value is string{
 if(typeof value!=='string'||!value||value.length>253||controlCharacters.test(value))return false;
 return isIP(value.replace(/^\[|\]$/g,''))!==0||hostnamePattern.test(value);
}
/** An https: URL without user info, at most 2048 characters. */
export function validTargetUrl(value:unknown):value is string{
 if(typeof value!=='string'||!value||value.length>2048||controlCharacters.test(value))return false;
 try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!!url.hostname;}catch{return false;}
}
const text=(value:unknown)=>typeof value==='string'?value.trim():'';
const given=(value:unknown)=>typeof value==='string'&&value.length>0;
const guidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const validGuid=(value:unknown):value is string=>typeof value==='string'&&guidPattern.test(value);
/** A Microsoft tenant ID: a GUID, or a domain name with at least one dot, at most 253 characters. */
export const validTenantId=(value:unknown):value is string=>validGuid(value)||typeof value==='string'&&value.includes('.')&&!value.endsWith('.')&&hostnamePattern.test(value);
/** A client secret: 1 to 512 characters without control characters. */
export const validClientSecret=(value:unknown):value is string=>typeof value==='string'&&value.length>=1&&value.length<=512&&!controlCharacters.test(value);
export type ServiceAccountKey={clientEmail:string;privateKey:string;privateKeyId:string};
/**
 * The parts of a Google service account key file (JSON, at most 16 KiB) that
 * the channel keeps: type "service_account", a valid client_email, a
 * private_key_id and a private_key PEM that loads as an RSA key. Other fields,
 * token_uri too, are ignored. null for anything else.
 */
export function serviceAccountKeyOf(value:unknown):ServiceAccountKey|null{
 if(typeof value!=='string'||!value||Buffer.byteLength(value)>serviceAccountKeyBytes)return null;
 let file:unknown;
 try{file=JSON.parse(value);}catch{return null;}
 if(!file||typeof file!=='object'||Array.isArray(file))return null;
 const {type,client_email:clientEmail,private_key_id:privateKeyId,private_key:privateKey}=file as Record<string,unknown>;
 if(type!=='service_account'||!validEmail(clientEmail)||typeof privateKeyId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(privateKeyId)||typeof privateKey!=='string'||!/-----BEGIN (?:RSA )?PRIVATE\sKEY-----/.test(privateKey))return null;
 try{if(createPrivateKey(privateKey).asymmetricKeyType!=='rsa')return null;}catch{return null;}
 return {clientEmail,privateKey,privateKeyId};
}
/** The sign-in of a config; a stored config without auth is a password channel. */
const authOf=(config:SmtpConfig|Record<string,never>|undefined):SmtpAuth|undefined=>config&&'recipients' in config?config.auth??'password':undefined;
/**
 * The masked target: https://<host>/… for URLs; for SMTP "<n> recipients via
 * <host>:<port>", "via Microsoft 365" or "via Google Workspace".
 */
export function targetHint(type:ChannelType,config:SmtpConfig|Record<string,never>,url?:string):string{
 if(type==='smtp'){
  const smtp=config as SmtpConfig,recipients=`${smtp.recipients.length} ${smtp.recipients.length===1?'recipient':'recipients'}`;
  if(smtp.auth==='microsoft365')return `${recipients} via Microsoft 365`;
  if(smtp.auth==='google')return `${recipients} via Google Workspace`;
  return `${recipients} via ${smtp.host}:${smtp.port}`;
 }
 try{return `https://${new URL(url??'').host}/…`;}catch{return 'https://…';}
}
/** The fields of the other sign-ins, which a request must not send. */
const foreignFields:Record<SmtpAuth,readonly ChannelField[]>={
 password:['tenantId','clientId','clientSecret','serviceAccountKey'],
 microsoft365:['host','port','tls','username','password','serviceAccountKey'],
 google:['host','port','tls','username','password','tenantId','clientId','clientSecret'],
};
/** The secret field of each sign-in: empty or omitted, it keeps the stored secret while the sign-in stays. */
const secretField:Record<SmtpAuth,'password'|'clientSecret'|'serviceAccountKey'>={password:'password',microsoft365:'clientSecret',google:'serviceAccountKey'};
/** The sign-in a request asks for: auth, else the current one, else password. */
const requestedAuth=(p:Record<string,unknown>,current:SmtpAuth|undefined)=>p.auth===undefined||p.auth===null?current??'password':p.auth;
/** The config as notification_channels.config stores it: a password channel without auth. */
export function storedConfig(config:SmtpConfig|Record<string,never>):Record<string,unknown>{
 if(!('recipients' in config)||config.auth!=='password')return config;
 const rest:Record<string,unknown>={...config};
 delete rest.auth;
 return rest;
}
/** A new webhook signing key: 32 random bytes, base64url. */
export const newSigningKey=()=>randomBytes(32).toString('base64url');

type Parsed={name:string;enabled:boolean;language:Locale;config:SmtpConfig|Record<string,never>;secret:ChannelSecret;secretChanged:boolean;targetHint:string};
/**
 * Validates the settings of one type (400 NOTIFY_CHANNEL_INVALID with the field
 * as param). `stored` is the current secret on update: an omitted or empty
 * secret field keeps it, a new URL, password, client secret or key replaces it.
 * The current state gives the on/off state, the language and the sign-in for
 * fields an update leaves out. An email channel keeps its stored secret only
 * while its sign-in (auth) stays; a new sign-in needs its own secret and drops
 * the old one. A new Discord URL must be a Discord webhook URL
 * (lib/discord-webhook-url.ts); a new URL of a Teams or webhook channel must
 * not be one. A stored URL is not checked again.
 */
export function parseChannel(type:ChannelType,p:Record<string,unknown>,stored:ChannelSecret|null,current?:{enabled:boolean;language:Locale;config?:SmtpConfig|Record<string,never>}):Parsed{
 const name=text(p.name);
 if(!name||name.length>80||controlCharacters.test(name))throw invalid('name');
 const enabled=p.enabled===undefined?current?.enabled??true:p.enabled;
 if(typeof enabled!=='boolean')throw invalid('enabled');
 const language=p.language===undefined?current?.language??'en':p.language;
 if(language!=='en'&&language!=='de')throw invalid('language');
 if(type==='smtp'){
  const currentAuth=authOf(current?.config),auth=requestedAuth(p,currentAuth);
  if(!smtpAuthModes.includes(auth as SmtpAuth))throw invalid('auth');
  const mode=auth as SmtpAuth,switched=currentAuth!==undefined&&currentAuth!==mode;
  // The stored secret counts only while the sign-in stays.
  const kept=switched?null:stored;
  for(const field of foreignFields[mode])if(p[field]!==undefined&&p[field]!==null)throw invalid(field);
  const from=text(p.from);
  if(!validEmail(from))throw invalid('from');
  const recipients=Array.isArray(p.recipients)?p.recipients.map(text).filter(Boolean):[];
  if(!Array.isArray(p.recipients)||!recipients.length||recipients.length>maxRecipients||!recipients.every(validEmail)||new Set(recipients.map(item=>item.toLowerCase())).size!==recipients.length)throw invalid('recipients');
  if(mode==='microsoft365'){
   const tenantId=text(p.tenantId),clientId=text(p.clientId);
   if(!validTenantId(tenantId))throw invalid('tenantId');
   if(!validGuid(clientId))throw invalid('clientId');
   if(p.clientSecret!==undefined&&p.clientSecret!==null&&p.clientSecret!==''&&!validClientSecret(p.clientSecret))throw invalid('clientSecret');
   const newSecret=given(p.clientSecret)?p.clientSecret as string:null,clientSecret=newSecret??kept?.clientSecret;
   if(!clientSecret)throw invalid('clientSecret');
   const config:SmtpConfig={auth:'microsoft365',from,recipients,tenantId,clientId};
   return {name,enabled,language,config,secret:{clientSecret},secretChanged:newSecret!==null||switched,targetHint:targetHint('smtp',config)};
  }
  if(mode==='google'){
   if(p.serviceAccountKey!==undefined&&p.serviceAccountKey!==null&&typeof p.serviceAccountKey!=='string')throw invalid('serviceAccountKey');
   const keyText=given(p.serviceAccountKey)?p.serviceAccountKey as string:null;
   const storedAccount=current?.config&&'serviceAccount' in current.config?current.config.serviceAccount:'';
   const key=keyText!==null?serviceAccountKeyOf(keyText):kept?.privateKey&&kept.privateKeyId&&storedAccount?{clientEmail:storedAccount,privateKey:kept.privateKey,privateKeyId:kept.privateKeyId}:null;
   if(!key)throw invalid('serviceAccountKey');
   const config:SmtpConfig={auth:'google',from,recipients,serviceAccount:key.clientEmail};
   return {name,enabled,language,config,secret:{privateKey:key.privateKey,privateKeyId:key.privateKeyId},secretChanged:keyText!==null||switched,targetHint:targetHint('smtp',config)};
  }
  const host=text(p.host);
  if(!validHost(host))throw invalid('host');
  if(typeof p.port!=='number'||!Number.isInteger(p.port)||p.port<1||p.port>65535)throw invalid('port');
  if(!smtpTlsModes.includes(p.tls as SmtpTls))throw invalid('tls');
  const tls=p.tls as SmtpTls;
  const username=p.username===undefined||p.username===null?'':text(p.username);
  if(username.length>256||controlCharacters.test(username))throw invalid('username');
  if(p.password!==undefined&&p.password!==null&&(typeof p.password!=='string'||p.password.length>256))throw invalid('password');
  const newPassword=given(p.password)?p.password as string:null;
  // No credentials over plain text; without a user name a stored password is dropped.
  if(tls==='none'&&username)throw invalid('username');
  if(tls==='none'&&newPassword)throw invalid('password');
  if(!username&&newPassword)throw invalid('username');
  const password=username?newPassword??kept?.password:undefined;
  const config:SmtpConfig={auth:'password',host,port:p.port,tls,from,recipients,username:username||null};
  return {name,enabled,language,config,secret:password?{password}:{},secretChanged:newPassword!==null||switched||!!kept?.password&&!password,targetHint:targetHint('smtp',config)};
 }
 if(p.url!==undefined&&p.url!==null&&p.url!==''){
  if(!validTargetUrl(p.url))throw invalid('url');
  if(type==='discord'&&!isDiscordWebhookUrl(p.url))throw invalid('url');
  if(type!=='discord'&&isDiscordWebhookUrl(p.url))throw discordUrlWrongType();
 }
 const url=given(p.url)?p.url as string:stored?.url;
 if(!url)throw invalid('url');
 const secret:ChannelSecret=type==='webhook'?{url,signingKey:stored?.signingKey??newSigningKey()}:{url};
 return {name,enabled,language,config:{},secret,secretChanged:given(p.url),targetHint:targetHint(type,{},url)};
}

// ---- Reading ------------------------------------------------------------------------

/** The settings of a stored config. Without auth (channels from before the sign-in choice) it is a password channel; no migration needed. */
export const configOf=(type:ChannelType,text:string):SmtpConfig|Record<string,never>=>{
 if(type!=='smtp')return {};
 try{
  const value=JSON.parse(text) as Record<string,unknown>,from=String(value.from),recipients=Array.isArray(value.recipients)?value.recipients.map(String):[];
  if(value.auth==='microsoft365')return {auth:'microsoft365',from,recipients,tenantId:String(value.tenantId),clientId:String(value.clientId)};
  if(value.auth==='google')return {auth:'google',from,recipients,serviceAccount:String(value.serviceAccount)};
  return {auth:'password',host:String(value.host),port:Number(value.port),tls:value.tls as SmtpTls,from,recipients,username:value.username?String(value.username):null};
 }
 catch{return {auth:'password',host:'',port:0,tls:'tls',from:'',recipients:[],username:null};}
};
/** Decrypts a stored secret; a value that does not decrypt throws apiError.notify.secretUndecryptable. */
export async function readSecret(id:string,secret:string|null):Promise<ChannelSecret>{
 if(!secret)return {};
 try{const value=JSON.parse(await decryptSecret(secret,secretContext(id)));return value&&typeof value==='object'?value as ChannelSecret:{};}
 catch{throw new HttpError(notifyErrorKey('secretUndecryptable'));}
}
const encrypted=async(id:string,secret:ChannelSecret)=>Object.keys(secret).length?encryptSecret(JSON.stringify(secret),secretContext(id)):null;
const viewOf=(row:ChannelRow):ChannelView=>{
 const type=row.type,config=configOf(type,row.config);
 return {id:row.id,type,name:row.name,enabled:Number(row.enabled)===1,language:row.language==='de'?'de':'en',config,secretSet:type==='smtp'&&!!row.secret,targetHint:row.target_hint,revision:Number(row.revision),
  ruleCount:Number(row.rule_count??0),lastDelivery:row.last_at!==null&&row.last_at!==undefined&&(row.last_status==='sent'||row.last_status==='failed')?{at:Number(row.last_at),status:row.last_status}:null};
};
const columns=sql`c.id,c.type,c.name,c.enabled,c.language,c.config,c.secret,c.target_hint,c.revision`;

/** GET /api/notifications/channels: every channel, sorted by name. */
export async function channelList(v:Viewer):Promise<{channels:ChannelView[]}>{
 await requireNotificationsRight(v);
 const rows=await db().query<ChannelRow>(sql`SELECT ${columns},
  (SELECT count(*) FROM notification_rules r WHERE r.channel_id=c.id) AS rule_count,
  last.at AS last_at,last.status AS last_status
  FROM notification_channels c
  LEFT JOIN LATERAL (SELECT coalesce(d.sent_at,d.last_attempt_at) AS at,d.status FROM notification_deliveries d WHERE d.channel_id=c.id AND d.status IN ('sent','failed') AND d.last_attempt_at IS NOT NULL ORDER BY d.last_attempt_at DESC LIMIT 1) last ON TRUE
  ORDER BY lower(c.name),c.id`);
 return {channels:rows.map(viewOf)};
}
async function channelRow(id:string):Promise<ChannelRow|null>{return db().one<ChannelRow>(sql`SELECT ${columns} FROM notification_channels c WHERE c.id=${id}`);}

/** The decrypted target of a stored channel for sending. */
export async function channelTarget(row:Pick<ChannelRow,'id'|'type'|'config'|'secret'>):Promise<ChannelTarget>{
 return {type:row.type,config:configOf(row.type,row.config),secret:await readSecret(row.id,row.secret)};
}

// ---- Changes -------------------------------------------------------------------------

export type ChannelAction='create'|'update'|'delete'|'set-enabled'|'rotate-secret'|'test';
export type ChannelChangeResult={ok:true;id?:string;revision?:number;signingSecret?:string};
const nonSecret=(parsed:Pick<Parsed,'name'|'enabled'|'language'|'config'>)=>({name:parsed.name,enabled:parsed.enabled,language:parsed.language,...parsed.config});
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const revisionOf=(value:unknown)=>{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)throw invalid('revision');return value;};
const idOf=(value:unknown)=>{if(!guid(value))throw invalid('id');return value.toLowerCase();};

/**
 * POST /api/notifications/channels. The right comes before the body (403
 * before 400). create, update, delete, set-enabled and rotate-secret need no
 * step-up proof (a supplied managementToken is ignored); the committing
 * statement holds only while the live primary and MFA session (mfaSessionFence),
 * the right and the revision hold, and its audit row commits with it.
 */
export async function changeChannel(request:Request,v:Viewer,p:Record<string,unknown>):Promise<ChannelChangeResult>{
 await requireNotificationsRight(v);
 const action=p.action;
 if(action==='test')return testChannel(request,v,p);
 if(action!=='create'&&action!=='update'&&action!=='delete'&&action!=='set-enabled'&&action!=='rotate-secret')throw new HttpError('apiError.request.unknownAction');
 const time=now();
 let statement:(guard:SqlGuard)=>Sql,auditAction:string,auditTarget:Record<string,unknown>,result:ChannelChangeResult;
 let current:ChannelRow|null=null;
 if(action==='create'){
  if(!channelTypes.includes(p.type as ChannelType))throw invalid('type');
  const type=p.type as ChannelType,parsed=parseChannel(type,p,null),id=crypto.randomUUID();
  if(await db().one(sql`SELECT 1 AS taken FROM notification_channels WHERE lower(name)=lower(${parsed.name})`))throw nameTaken();
  const secret=await encrypted(id,parsed.secret);
  statement=(guard:SqlGuard)=>sql`INSERT INTO notification_channels(id,type,name,enabled,language,config,secret,target_hint,revision,created_at,created_by,updated_at,updated_by)
   SELECT ${id},${type},${parsed.name},${parsed.enabled?1:0},${parsed.language},${JSON.stringify(storedConfig(parsed.config))},${secret}::text,${parsed.targetHint},0,${time},${v.label},${time},${v.label} WHERE ${guard} ON CONFLICT DO NOTHING RETURNING revision`;
  auditAction='notification-channel.create';auditTarget={id,name:parsed.name,type};
  result={ok:true,id,revision:0,...(type==='webhook'?{signingSecret:parsed.secret.signingKey}:{})};
 }else{
  const id=idOf(p.id),revision=revisionOf(p.revision);
  current=await channelRow(id);
  if(!current)throw notFound();
  if(Number(current.revision)!==revision)throw changed();
  const base={id,name:current.name,type:current.type};
  const match=sql`id=${id} AND revision=${revision}`;
  if(action==='delete'){
   statement=(guard:SqlGuard)=>sql`DELETE FROM notification_channels WHERE ${match} AND ${guard} RETURNING revision`;
   auditAction='notification-channel.delete';auditTarget=base;result={ok:true};
  }else if(action==='set-enabled'){
   if(typeof p.enabled!=='boolean')throw invalid('enabled');
   const enabled=p.enabled;
   if((Number(current.enabled)===1)===enabled)return {ok:true,revision};
   statement=(guard:SqlGuard)=>sql`UPDATE notification_channels SET enabled=${enabled?1:0},revision=revision+1,updated_at=${time},updated_by=${v.label} WHERE ${match} AND ${guard} RETURNING revision`;
   auditAction=enabled?'notification-channel.enable':'notification-channel.disable';auditTarget=base;result={ok:true,revision:revision+1};
  }else if(action==='rotate-secret'){
   if(current.type!=='webhook')throw invalid('type');
   const stored=await readSecret(id,current.secret),signingKey=newSigningKey(),secret=await encrypted(id,{...stored,signingKey});
   statement=(guard:SqlGuard)=>sql`UPDATE notification_channels SET secret=${secret},revision=revision+1,updated_at=${time},updated_by=${v.label} WHERE ${match} AND type='webhook' AND ${guard} RETURNING revision`;
   auditAction='notification-channel.rotate-secret';auditTarget={...base,secretChanged:true};result={ok:true,revision:revision+1,signingSecret:signingKey};
  }else{
   if(p.type!==undefined&&p.type!==current.type)throw invalid('type');
   // The stored secret is read only when the request keeps part of it: for
   // email, the same sign-in without a new secret of that sign-in.
   const currentConfig=configOf(current.type,current.config),currentAuth=authOf(currentConfig);
   const smtpAuth=currentAuth?requestedAuth(p,currentAuth):null;
   const keeps=current.type==='smtp'?smtpAuth===currentAuth&&smtpAuthModes.includes(smtpAuth as SmtpAuth)&&!given(p[secretField[smtpAuth as SmtpAuth]])&&!!current.secret:current.type==='webhook'||!given(p.url);
   const stored=keeps?await readSecret(id,current.secret):null;
   const parsed=parseChannel(current.type,p,stored,{enabled:Number(current.enabled)===1,language:current.language==='de'?'de':'en',config:currentConfig});
   const before=nonSecret({name:current.name,enabled:Number(current.enabled)===1,language:current.language==='de'?'de':'en',config:currentConfig}),after=nonSecret(parsed);
   const fields=[...new Set([...Object.keys(before),...Object.keys(after)])].filter(key=>!same((before as Record<string,unknown>)[key],(after as Record<string,unknown>)[key]));
   if(!fields.length&&!parsed.secretChanged)return {ok:true,revision};
   if(parsed.name.toLowerCase()!==current.name.toLowerCase()&&await db().one(sql`SELECT 1 AS taken FROM notification_channels WHERE lower(name)=lower(${parsed.name}) AND id<>${id}`))throw nameTaken();
   const secret=parsed.secretChanged?await encrypted(id,parsed.secret):current.secret;
   statement=(guard:SqlGuard)=>sql`UPDATE notification_channels SET name=${parsed.name},enabled=${parsed.enabled?1:0},language=${parsed.language},config=${JSON.stringify(storedConfig(parsed.config))},secret=${secret}::text,target_hint=${parsed.targetHint},revision=revision+1,updated_at=${time},updated_by=${v.label} WHERE ${match} AND ${guard} RETURNING revision`;
   auditAction='notification-channel.update';
   auditTarget={...base,name:parsed.name,changed:fields,old:Object.fromEntries(fields.map(key=>[key,(before as Record<string,unknown>)[key]??null])),new:Object.fromEntries(fields.map(key=>[key,(after as Record<string,unknown>)[key]??null])),...(parsed.secretChanged?{secretChanged:true}:{})};
   result={ok:true,revision:revision+1};
  }
 }
 const {commitSessionChange}=await import('../identity/rbac');
 const guard=sql`(${await mfaSessionFence(request,v)}) AND (${rightGuard(v)})`;
 const audit=auditEvent({actor:v.label,action:auditAction,target:JSON.stringify(auditTarget),guard:auditAfterChange,at:time});
 let row;
 try{row=await commitSessionChange(statement(guard),audit);}
 catch(error){if(isUniqueViolation(error))throw nameTaken();throw error;}
 if(!row){
  // Refused in the transaction: an ended session answers its own 401, a lost
  // right 403, a taken name 409; otherwise the channel changed.
  await requireLiveSessions(request,v);
  await requireNotificationsRight(v);
  if(action==='create')throw nameTaken();
  throw changed();
 }
 return result;
}

/** The portal as recipients know it: SITE_ORIGIN, else the product name. */
export const portalName=()=>config('SITE_ORIGIN')||productName;

/**
 * test {id}: one test message through the same transport and retries, also on a
 * disabled channel. Answers {ok:true} or 422 with the reason's key. The order:
 * the right (changeChannel), the id, the channel, the rate limit, the send. The
 * reservation is one upsert per principal that holds only under the live right,
 * the viewer write guard and the MFA session; the attempt counts also when it is
 * refused. After the send, the synthetic event of kind test, its delivery and
 * one portal audit row commit together under the same guard. A refused guard
 * answers 403: before the send nothing goes out, after it no row is written.
 */
async function testChannel(request:Request,v:Viewer,p:Record<string,unknown>):Promise<ChannelChangeResult>{
 const id=idOf(p.id),row=await channelRow(id);
 if(!row)throw notFound();
 const time=now(),eventId=crypto.randomUUID(),deliveryId=crypto.randomUUID();
 const guard=sql`(${rightGuard(v)}) AND (${await mfaSessionFence(request,v)})`;
 const cutoff=time-testMessageLimit.windowMs;
 const reserved=await db().one<{attempts:number|string}>(sql`INSERT INTO notification_test_limits(principal,attempts,window_at) SELECT ${principal(v)},1,${time}::bigint WHERE ${guard}
  ON CONFLICT(principal) DO UPDATE SET attempts=CASE WHEN notification_test_limits.window_at<=${cutoff} THEN 1 ELSE notification_test_limits.attempts+1 END,
  window_at=CASE WHEN notification_test_limits.window_at<=${cutoff} THEN excluded.window_at ELSE notification_test_limits.window_at END RETURNING attempts`);
 if(!reserved)throw forbidden();
 if(Number(reserved.attempts)>testMessageLimit.attempts)throw testRateLimited();
 let outcome:{ok:boolean;attempts:number;reason:NotifyFailureReason|null;params:Record<string,string|number>};
 try{
  const target=await channelTarget(row);
  const sent=await sendNotification(target,{kind:'test'},{deliveryId,time,portal:portalName(),origin:config('SITE_ORIGIN'),locale:row.language==='de'?'de':'en',logoUrl:target.type==='smtp'?await portalEmailLogoUrl():null});
  outcome=sent.ok?{ok:true,attempts:sent.attempts,reason:null,params:{}}:{ok:false,attempts:sent.attempts,reason:sent.error.reason,params:sent.error.params};
 }catch(error){
  if(error instanceof HttpError&&error.messageKey===notifyErrorKey('secretUndecryptable'))outcome={ok:false,attempts:0,reason:'secretUndecryptable',params:{}};
  else throw error;
 }
 const finished=now(),errorKey=outcome.reason?notifyErrorKey(outcome.reason):null;
 // The event holds only under the guard; the delivery only with its event; the
 // audit row only after the delivery (auditAfterChange). A failing step rolls back all.
 const {commitSessionChange}=await import('../identity/rbac');
 const committed=await commitSessionChange(sql`INSERT INTO notification_events(id,kind,occurred_at,status,routed_at) SELECT ${eventId},'test',${time}::bigint,'routed',${time}::bigint WHERE ${guard} RETURNING id`,[
  sql`INSERT INTO notification_deliveries(id,event_id,channel_id,channel_name,channel_type,target_hint,message_id,status,attempts,sent_at,last_attempt_at,error_key,error_params,created_at)
   SELECT ${deliveryId},${eventId},${row.id},${row.name},${row.type},${row.target_hint},${deliveryId},${outcome.ok?'sent':'failed'},${Math.max(1,outcome.attempts)}::bigint,${outcome.ok?finished:null}::bigint,${finished}::bigint,${errorKey}::text,${outcome.reason&&Object.keys(outcome.params).length?JSON.stringify(outcome.params):null}::text,${time}::bigint
   WHERE EXISTS (SELECT 1 FROM notification_events WHERE id=${eventId})`,
  ...auditEvent({actor:v.label,action:'notification-channel.test',target:JSON.stringify({id:row.id,name:row.name,type:row.type,status:outcome.ok?'sent':'failed',...(errorKey?{errorKey}:{})}),guard:auditAfterChange,at:finished}),
 ]);
 if(!committed)throw forbidden();
 if(!outcome.ok)throw new HttpError(notifyErrorKey(outcome.reason!),outcome.params);
 return {ok:true};
}
