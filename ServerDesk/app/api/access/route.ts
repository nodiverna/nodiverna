import {body,failure,requireViewer,sameOrigin} from '@/lib/server/context';
import {rbacFailure} from '@/lib/server/identity/rbac';
import {accessOverview,changeAccess} from '@/lib/server/identity/access-admin';
const headers={'Cache-Control':'no-store'};
export async function GET(){try{
 const v=await requireViewer();
 return Response.json(await accessOverview(v),{headers});
}catch(e){return failure(e);}}
export async function POST(request:Request){try{
 sameOrigin(request);const v=await requireViewer(),p=await body(request,131072);
 return Response.json(await changeAccess(request,v,p),{headers});
}catch(e){return failure(rbacFailure(e));}}
