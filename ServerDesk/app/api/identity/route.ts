import {failure,requireAuthIdentity} from '@/lib/server/context';
import {mfaStatus} from '@/lib/server/identity/mfa';

// Identity and the existing MFA session are checked together. This read never
// issues a session, resumes remembered trust or renews the inactivity deadline.
export async function GET(request:Request){
 try{const viewer=await requireAuthIdentity(request);return Response.json({viewer,session:await mfaStatus(request,viewer)},{headers:{'Cache-Control':'no-store'}});}
 catch(error){return failure(error);}
}
