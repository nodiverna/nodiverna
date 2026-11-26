// Sends one notification to one channel (docs/notifications.md): builds the
// channel format of the content, shortens a bundle until it fits the body limit
// of the channel (Teams 24 KiB, else 64 KiB; Discord also at most 10 embeds and
// 6000 embed characters), signs webhook bodies and runs the
// transport (lib/server/notifications/notify/transport.ts) with its retries. An email channel signs
// in with a password (SMTP), Microsoft 365 (Graph sendMail, lib/server/notifications/notify/graph.ts)
// or Google Workspace (SMTP with XOAUTH2 to smtp.gmail.com:465); the tokens come
// from lib/server/notifications/notify/oauth.ts. The test message and the dispatcher
// (lib/server/notifications/notifications.ts) both use it.
import {createHmac} from 'node:crypto';
import {config} from '../../context';
import type {Locale} from '../../../i18n/locale';
import {bundleEntryLimit,discordEmbedLength,discordLimits,discordPayload,emergencyMessage,mailHtml,mailText,notificationMessage,teamsPayload,testMessage,webhookPayload,type EmergencySignIn,type NotificationContent,type NotificationEntry} from '../notification-message';
import {httpsPost,notifyLimits,NotifyError,withRetry,type RetryOutcome,type TransportOptions} from './transport';
import {smtpSend,type SmtpSettings} from './smtp';
import {graphRequestBody,graphSend} from './graph';
import {dropToken,googleToken,oauthHosts} from './oauth';

export type ChannelType='smtp'|'teams'|'discord'|'webhook';
/** The sign-in of an email channel. A stored config without auth is 'password'. */
export type SmtpAuth='password'|'microsoft365'|'google';
/** The settings that are not secret, as notification_channels.config gives them (auth is not stored for 'password'). */
export type SmtpPasswordConfig={auth:'password';host:string;port:number;tls:SmtpSettings['tls'];from:string;recipients:string[];username:string|null};
export type Microsoft365Config={auth:'microsoft365';from:string;recipients:string[];tenantId:string;clientId:string};
/** serviceAccount: the client_email of the service account key. */
export type GoogleConfig={auth:'google';from:string;recipients:string[];serviceAccount:string};
export type SmtpConfig=SmtpPasswordConfig|Microsoft365Config|GoogleConfig;
export type ChannelConfig=SmtpConfig|Record<string,never>;
/**
 * The decrypted secret: the SMTP password, the Microsoft 365 client secret, the
 * Google service account private key and its ID, or the Teams/Discord/webhook
 * URL and the webhook signing key.
 */
export type ChannelSecret={password?:string;clientSecret?:string;privateKey?:string;privateKeyId?:string;url?:string;signingKey?:string};
/** Gmail over SMTP for the sign-in Google Workspace: implicit TLS on port 465. */
export const gmailSmtp={host:oauthHosts.gmailSmtp,port:465,tls:'tls'} as const;
export type ChannelTarget={type:ChannelType;config:ChannelConfig;secret:ChannelSecret};
/** emergency: one emergency sign-in, always its own message (lib/server/notifications/notifications.ts). */
export type Outgoing={kind:'alarms';entries:NotificationEntry[]}|{kind:'test'}|{kind:'emergency';signIn:EmergencySignIn};
/** logoUrl: the logo of the email head (portalEmailLogoUrl in lib/server/branding.ts), null without one; the other channels ignore it. */
export type SendMeta={deliveryId:string;time:number;portal:string;origin:string;locale:Locale;logoUrl:string|null};
type SendOptions=TransportOptions&{sleep?:(ms:number)=>Promise<void>;clock?:()=>number};

let override:SendOptions|null=null;
/** Tests only: replaces the transport options (resolver, routing, CA, timeouts, sleep, clock). null restores the defaults. */
export function useTransportOptions(options:SendOptions|null){override=options;}
/** NOTIFY_ALLOW_PRIVATE_TARGETS=true allows private ranges; loopback, link-local and metadata stay refused. */
function options():SendOptions{return {allowPrivate:String(config('NOTIFY_ALLOW_PRIVATE_TARGETS')??'').trim().toLowerCase()==='true',...override};}

const bodyLimit=(type:ChannelType)=>type==='teams'?notifyLimits.teamsBodyBytes:notifyLimits.bodyBytes;
/** embedLength: the Discord embed characters (titles and descriptions), 0 for the other types. */
type Rendered={content:NotificationContent;body:string;embedLength:number;mail?:{text:string;html:string}};
function render(type:ChannelType,content:NotificationContent,meta:SendMeta,config?:ChannelConfig):Rendered{
 if(type==='smtp'){
  const text=mailText(content),html=mailHtml(content,meta.logoUrl??null);
  // Microsoft 365: the Graph request JSON is what goes out and what the limit measures.
  if(config&&'auth' in config&&config.auth==='microsoft365')return {content,body:graphRequestBody({subject:content.subject,html,recipients:config.recipients}),embedLength:0,mail:{text,html}};
  return {content,body:text+html,embedLength:0,mail:{text,html}};
 }
 if(type==='teams')return {content,body:JSON.stringify(teamsPayload(content)),embedLength:0};
 if(type==='discord'){const payload=discordPayload(content);return {content,body:JSON.stringify(payload),embedLength:discordEmbedLength(payload)};}
 return {content,body:JSON.stringify(webhookPayload(content,meta.deliveryId,meta.time,meta.portal)),embedLength:0};
}
/**
 * The content in the channel format, within the body limit: a bundle drops
 * entries (most severe stay) until it fits; a message that does not fit even
 * with one entry fails with tooLarge and is never sent oversized. A Discord
 * bundle starts with at most 10 entries and must also keep the embed
 * characters at or below 6000; `more` counts every entry that is not shown.
 * For an email channel with the sign-in Microsoft 365 (`config`) the Graph
 * request JSON is measured against the 64 KiB.
 */
export function fittingMessage(type:ChannelType,outgoing:Outgoing,meta:SendMeta,config?:ChannelConfig):Rendered{
 const limit=bodyLimit(type),embedLimit=type==='discord'?discordLimits.embedTotal:Infinity;
 const fits=(rendered:Rendered)=>Buffer.byteLength(rendered.body)<=limit&&rendered.embedLength<=embedLimit;
 if(outgoing.kind==='test'||outgoing.kind==='emergency'){
  const content=outgoing.kind==='test'?testMessage(meta.locale,meta.portal,meta.time):emergencyMessage(meta.locale,meta.portal,meta.origin,outgoing.signIn);
  const rendered=render(type,content,meta,config);if(!fits(rendered))throw new NotifyError('tooLarge');return rendered;
 }
 let count=Math.min(type==='discord'?discordLimits.embeds:bundleEntryLimit,outgoing.entries.length);
 for(;;){
  const rendered=render(type,notificationMessage(outgoing.entries,meta.locale,meta.origin,count),meta,config);
  if(fits(rendered))return rendered;
  if(count<=1)throw new NotifyError('tooLarge');
  const byBytes=count*limit/Buffer.byteLength(rendered.body),byEmbeds=rendered.embedLength>embedLimit?count*embedLimit/rendered.embedLength:Infinity;
  count=Math.min(count-1,Math.max(1,Math.floor(Math.min(byBytes,byEmbeds))));
 }
}
/** X-Nodiverna-Signature: v1=<hex HMAC-SHA256(key, timestamp + "." + body)>. */
export const webhookSignature=(key:string,timestamp:number,body:string)=>`v1=${createHmac('sha256',key).update(`${timestamp}.${body}`).digest('hex')}`;

/** Sends with up to three attempts; never rejects. The outcome carries the attempts and the last error. */
export async function sendNotification(target:ChannelTarget,outgoing:Outgoing,meta:SendMeta):Promise<RetryOutcome<void>>{
 const settings=options(),clock=settings.clock??Date.now;
 let rendered:Rendered;
 try{rendered=fittingMessage(target.type,outgoing,meta,target.config);}
 catch(error){return {ok:false,error:error instanceof NotifyError?error:new NotifyError('tooLarge'),attempts:0};}
 const attempt=async()=>{
  if(target.type==='smtp'){
   const smtp=target.config as SmtpConfig,secret=target.secret;
   const mail={subject:rendered.content.subject,text:rendered.mail!.text,html:rendered.mail!.html,messageId:meta.deliveryId};
   if(smtp.auth==='microsoft365'){
    if(!secret.clientSecret)throw new NotifyError('secretUndecryptable');
    await graphSend({tenantId:smtp.tenantId,clientId:smtp.clientId,clientSecret:secret.clientSecret},smtp.from,rendered.body,settings);
    return;
   }
   if(smtp.auth==='google'){
    if(!secret.privateKey||!secret.privateKeyId)throw new NotifyError('secretUndecryptable');
    const access=await googleToken({serviceAccount:smtp.serviceAccount,privateKey:secret.privateKey,privateKeyId:secret.privateKeyId,subject:smtp.from},settings);
    try{await smtpSend({...gmailSmtp,from:smtp.from,recipients:smtp.recipients,username:null,password:null,oauth:{user:smtp.from,accessToken:access.token}},mail,settings);}
    catch(error){
     // A refused token is not used again; the next attempt fetches a new one.
     if(error instanceof NotifyError&&error.reason==='googleDelegationMissing')dropToken(access.key);
     throw error;
    }
    return;
   }
   await smtpSend({...smtp,password:secret.password??null},mail,settings);
   return;
  }
  const url=target.secret.url;
  if(!url)throw new NotifyError('secretUndecryptable');
  const headers:Record<string,string>={'Content-Type':'application/json; charset=utf-8'};
  if(target.type==='webhook'){
   if(!target.secret.signingKey)throw new NotifyError('secretUndecryptable');
   const timestamp=Math.floor(clock()/1000);
   Object.assign(headers,{'X-Nodiverna-Event':rendered.content.event,'X-Nodiverna-Delivery':meta.deliveryId,'X-Nodiverna-Timestamp':String(timestamp),'X-Nodiverna-Signature':webhookSignature(target.secret.signingKey,timestamp,rendered.body)});
  }
  await httpsPost({url,body:rendered.body,headers,maxBodyBytes:bodyLimit(target.type)},settings);
 };
 return withRetry(attempt,{sleep:settings.sleep});
}
