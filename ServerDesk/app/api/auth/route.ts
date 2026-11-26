import {body,failure,sameOrigin} from '@/lib/server/context';
import {localIdentity} from '@/lib/server/identity/local-auth';
import {accountAction} from '@/lib/server/identity/account-admin';
import {entraSignInState} from '@/lib/server/identity/entra/sign-in';

const noStore={'Cache-Control':'no-store'};
function reply(value:Record<string,unknown>){const {cookies,...data}=value;const headers=new Headers(noStore);for(const cookie of cookies as string[]??[])headers.append('Set-Cookie',cookie);return Response.json(data,{headers});}

export async function GET(request:Request){try{
 const [viewer,entra]=await Promise.all([localIdentity(request),entraSignInState()]);
 // entra tells the sign-in card whether to offer "Sign in with Microsoft" and
 // whether only the emergency access may use the password form; it names no
 // tenant, client or account.
 return reply({viewer,passwordConfigured:!!viewer,entra});
 }catch(e){return failure(e);}}

export async function POST(request:Request){try{
 sameOrigin(request);const p=await body(request,16_384) as Record<string,unknown>;
 return reply(await accountAction(request,p));
 }catch(e){return failure(e);}}
