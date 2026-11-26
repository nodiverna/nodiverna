import {failure,requireViewer} from '@/lib/server/context';
import {notificationLog} from '@/lib/server/notifications/notifications';

// Settings → Notifications, delivery log (docs/notifications.md). Logic and SQL
// live in lib/server/notifications/notifications.ts.
const headers={'Cache-Control':'no-store'};
export async function GET(request:Request){try{const viewer=await requireViewer();return Response.json(await notificationLog(viewer,new URL(request.url).searchParams),{headers});}catch(e){return failure(e);}}
