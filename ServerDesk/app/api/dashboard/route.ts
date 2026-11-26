import {failure,requireViewer} from '@/lib/server/context';
import {dashboardData} from '@/lib/server/dashboard-data';

// The data of the Dashboard that GET /api/console does not carry
// (lib/server/dashboard-data.ts, docs/dashboard.md): the hourly alarm counts of the
// last 192 hours on the devices the viewer may see.
export async function GET(){try{
 const viewer=await requireViewer();
 return Response.json(await dashboardData(viewer),{headers:{'Cache-Control':'no-store'}});
}catch(e){return failure(e);}}
