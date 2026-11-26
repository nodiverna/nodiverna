import {body,failure,requireViewer,sameOrigin} from '@/lib/server/context';
import {changeChannel,channelList} from '@/lib/server/notifications/notification-channels';

// Settings → Notifications, channels (docs/notifications.md). Logic and SQL live
// in lib/server/notifications/notification-channels.ts; changes rely on the live
// MFA login session (no step-up, lib/step-up.ts), test sends one test message (at most 5 per user in 60 s).
const headers={'Cache-Control':'no-store'};
export async function GET(){try{const viewer=await requireViewer();return Response.json(await channelList(viewer),{headers});}catch(e){return failure(e);}}
export async function POST(request:Request){
 try{sameOrigin(request);const viewer=await requireViewer(),p=await body(request,16384);return Response.json(await changeChannel(request,viewer,p),{headers});}
 catch(e){return failure(e);}
}
