import {failure} from '@/lib/server/context';
import {callbackLocale,callbackPage,clearEntraFlowCookie} from '@/lib/server/identity/entra/sign-in';
import {confirmPage,entraCallback} from '@/lib/server/identity/entra/confirm';

// The redirect URI of the app registration (docs/entra-id.md). It serves the
// sign-in and the confirmation ("Confirm with Microsoft"); the purpose comes from
// the stored flow row. It always answers with a same-origin HTML page, never with
// a redirect, so the SameSite=Strict session cookies reach the portal on the next
// navigation.
export async function GET(request:Request){
 try{
  const result=await entraCallback(request),locale=callbackLocale(request);
  return result.purpose==='confirm'?confirmPage(result.outcome,locale,result.cookies,result.amr):callbackPage(result.outcome,locale,result.cookies,result.amr);
 }
 // failure() logs the reference; the browser still gets the page.
 catch(e){failure(e);return callbackPage('unavailable',callbackLocale(request),[clearEntraFlowCookie()]);}
}
