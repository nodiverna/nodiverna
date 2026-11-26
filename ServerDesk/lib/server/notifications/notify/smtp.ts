// Email over SMTP for the notification channels (docs/notifications.md), through
// nodemailer. The connection goes to the address that checkedTarget
// (lib/server/notifications/notify/transport.ts) resolved and checked; the certificate is checked
// against the host name (SNI). tls 'tls' is implicit TLS, 'starttls' requires
// STARTTLS and fails when the server does not offer it, 'none' sends plain text
// and never with credentials. The sign-in is a user name and password, or for
// Google Workspace XOAUTH2 with an access token from lib/server/notifications/notify/oauth.ts;
// nodemailer gets no client ID or refresh token, so it never fetches a token
// itself. Every failure becomes one NotifyError.
import {isIP} from 'node:net';
import {createTransport} from 'nodemailer';
import {checkedTarget,notifyLimits,NotifyError,socketFailure,type TransportOptions} from './transport';

export type SmtpTls='tls'|'starttls'|'none';
/** oauth: the XOAUTH2 sign-in (user and access token) instead of the user name and password. */
export type SmtpSettings={host:string;port:number;tls:SmtpTls;from:string;recipients:string[];username:string|null;password:string|null;oauth?:{user:string;accessToken:string}|null};
export type MailMessage={subject:string;text:string;html:string;messageId:string};

/** One header line: no CR, LF or other control characters, so nothing can start a new header. */
export const headerText=(value:string)=>value.replace(/[\u0000-\u001f\u007f]+/g,' ').trim();
/** The first line of an SMTP reply, without control characters, at most 120 characters. */
const replyText=(value:unknown)=>typeof value==='string'?headerText(value.split(/\r?\n/)[0]??'').slice(0,120):'';

/**
 * The reason of a refused password sign-in, from the SMTP reply. Microsoft
 * answers 5.7.139 when basic authentication or SMTP AUTH is off, and also when
 * the account needs MFA (security defaults, "did not meet the criteria"); Gmail
 * answers 5.7.9 ("Application-specific password required") and 5.7.14. Any
 * other reply stays authFailed.
 */
export function passwordSignInFailure(reply:string):NotifyError{
 if(/(^|[^\d.])5\.7\.139(?![\d])/.test(reply))
  return new NotifyError(/basic authentication is disabled|SmtpClientAuthentication is disabled/i.test(reply)?'authBasicDisabled':'authMfaRequired');
 if(/(^|[^\d.])5\.7\.(?:9|14)(?![\d])/.test(reply))return new NotifyError('authMfaRequired');
 return new NotifyError('authFailed');
}

type MailerError={code?:string;responseCode?:number;command?:string;response?:string;rejected?:string[];message?:string};
/** The NotifyError of a nodemailer error; SMTP 4xx replies can pass. With `oauth`, a refused sign-in is googleDelegationMissing. */
export function smtpFailure(error:unknown,{oauth=false}:{oauth?:boolean}={}):NotifyError{
 if(error instanceof NotifyError)return error;
 const failure=(error??{}) as MailerError,code=failure.responseCode,temporary=typeof code==='number'&&code>=400&&code<500;
 switch(failure.code){
  case 'EAUTH':return oauth?new NotifyError('googleDelegationMissing'):passwordSignInFailure(typeof failure.response==='string'?failure.response:'');
  case 'ETLS':return failure.command==='STARTTLS'&&typeof failure.response==='string'?new NotifyError('starttlsMissing'):new NotifyError('tlsFailed');
  case 'ETIMEDOUT':return new NotifyError('timeout');
  case 'EDNS':return new NotifyError('dnsFailed');
  case 'EENVELOPE':
   if(failure.rejected?.length||/^RCPT/i.test(failure.command??''))return new NotifyError('recipientRejected',{retryable:temporary});
   return new NotifyError('smtpRejected',{params:{reply:replyText(failure.response)},retryable:temporary});
  case 'ECONNECTION':case 'ESOCKET':case undefined:
   if(typeof code==='number')return new NotifyError('smtpRejected',{params:{reply:replyText(failure.response)},retryable:temporary});
   return socketFailure(error);
  default:
   if(typeof code==='number')return new NotifyError('smtpRejected',{params:{reply:replyText(failure.response)},retryable:temporary});
   return socketFailure(error);
 }
}

/** Sends one message (text/plain UTF-8 plus a simple HTML part) to all recipients. */
export async function smtpSend(settings:SmtpSettings,message:MailMessage,options:TransportOptions={}):Promise<void>{
 if(settings.tls==='none'&&(settings.username||settings.password||settings.oauth))throw new NotifyError('authFailed');
 const checked=await checkedTarget(settings.host,options);
 const address=options.routeAddress?.(checked.address)??checked.address;
 const host=settings.host.replace(/^\[|\]$/g,''),connectMs=options.connectMs??notifyLimits.connectMs,totalMs=options.totalMs??notifyLimits.totalMs;
 const oauth=settings.oauth??null;
 const transport=createTransport({
  host:address,port:options.routePort?.(host,settings.port)??settings.port,secure:settings.tls==='tls',requireTLS:settings.tls==='starttls',ignoreTLS:settings.tls==='none',
  auth:oauth?{type:'OAuth2',user:oauth.user,accessToken:oauth.accessToken}:settings.username?{user:settings.username,pass:settings.password??''}:undefined,
  tls:{servername:isIP(host)?undefined:host,rejectUnauthorized:true,...(options.ca?{ca:options.ca}:{})},
  connectionTimeout:connectMs,greetingTimeout:connectMs,socketTimeout:totalMs,
  disableFileAccess:true,disableUrlAccess:true,
 });
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  await Promise.race([
   transport.sendMail({from:headerText(settings.from),to:settings.recipients.map(headerText),subject:headerText(message.subject),text:message.text,html:message.html,messageId:`<${message.messageId}@nodiverna>`,textEncoding:'quoted-printable'}),
   new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new NotifyError('timeout')),totalMs);}),
  ]);
 }catch(error){throw smtpFailure(error,{oauth:!!oauth});}
 finally{clearTimeout(timer);transport.close();}
}
