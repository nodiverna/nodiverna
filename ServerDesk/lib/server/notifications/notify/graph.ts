// Email through Microsoft Graph sendMail for the sign-in Microsoft 365 of an
// email channel (docs/notifications.md). The token comes from lib/server/notifications/notify/oauth.ts
// (client credentials); the request goes through the transport
// (lib/server/notifications/notify/transport.ts) to the constant host graph.microsoft.com. A Graph
// message has one body, so it carries the HTML part only. Status 202 is
// success. A 401 drops the cached token, fetches one new token and sends once
// more in the same attempt; a second 401 is microsoftSignInRefused.
import {headerText} from './smtp';
import {dropToken,microsoftToken,oauthHosts,type MicrosoftCredentials,type OAuthOptions} from './oauth';
import {httpsPost,httpStatusFailure,httpStatusRetryable,notifyLimits,NotifyError} from './transport';

export type GraphMail={from:string;recipients:string[];subject:string;html:string};

/** The request body of sendMail: subject (one header line), the HTML body, the recipients, and no copy in Sent Items. */
export function graphRequestBody({subject,html,recipients}:Omit<GraphMail,'from'>):string{
 return JSON.stringify({message:{subject:headerText(subject),body:{contentType:'HTML',content:html},toRecipients:recipients.map(address=>({emailAddress:{address}}))},saveToSentItems:false});
}
export const graphSendMailUrl=(from:string)=>`https://${oauthHosts.graph}/v1.0/users/${encodeURIComponent(from)}/sendMail`;

const mailboxCodes=/"code"\s*:\s*"(?:ErrorInvalidUser|ResourceNotFound|MailboxNotEnabledForRESTAPI)"/;
/**
 * The failure of a Graph answer that is no success: 401 microsoftSignInRefused,
 * 403 microsoftPermissionMissing, 404 (ErrorInvalidUser, ResourceNotFound,
 * MailboxNotEnabledForRESTAPI) mailboxNotFound, 400 and 422 httpRejected;
 * 408, 429 and 5xx stay retryable.
 */
export function graphFailure(status:number,body=''):NotifyError{
 if(httpStatusRetryable(status))return httpStatusFailure(status);
 if(status===401)return new NotifyError('microsoftSignInRefused');
 if(status===403)return new NotifyError('microsoftPermissionMissing');
 if(status===404||mailboxCodes.test(body))return new NotifyError('mailboxNotFound');
 return httpStatusFailure(status);
}

/** One sendMail attempt with the request body that fittingMessage measured. */
export async function graphSend(credentials:MicrosoftCredentials,from:string,body:string,options:OAuthOptions={}):Promise<void>{
 const post=(token:string)=>httpsPost({url:graphSendMailUrl(from),body,headers:{'Content-Type':'application/json; charset=utf-8',Authorization:`Bearer ${token}`},maxBodyBytes:notifyLimits.bodyBytes,readBody:true},options);
 let access=await microsoftToken(credentials,options);
 let result=await post(access.token);
 if(result.status===401){
  dropToken(access.key);
  access=await microsoftToken(credentials,options);
  result=await post(access.token);
  if(result.status===401){dropToken(access.key);throw new NotifyError('microsoftSignInRefused');}
 }
 if(result.status>=200&&result.status<300)return;
 throw graphFailure(result.status,result.body);
}
