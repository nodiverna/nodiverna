import {body,failure,requireViewer,sameOrigin} from '@/lib/server/context';
import {changeNotificationRule,notificationRulesView} from '@/lib/server/notifications/notification-rules';

// The "Notifications" tab of All devices, a device group and a customer
// (docs/notifications.md). Logic and SQL live in lib/server/notifications/notification-rules.ts.
const headers={'Cache-Control':'no-store'};
export async function GET(request:Request){try{const viewer=await requireViewer();return Response.json(await notificationRulesView(viewer,new URL(request.url).searchParams),{headers});}catch(e){return failure(e);}}
export async function POST(request:Request){
 try{sameOrigin(request);const viewer=await requireViewer(),p=await body(request,8192);return Response.json(await changeNotificationRule(request,viewer,p),{headers});}
 catch(e){return failure(e);}
}
