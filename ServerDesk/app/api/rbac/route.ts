import {body,failure,requireViewer,sameOrigin} from '@/lib/server/context';
import {manageRbac,prepareManagementAuthorization,rbacData,rbacFailure,rbacScope} from '@/lib/server/identity/rbac';
const headers={'Cache-Control':'no-store'};
export async function GET(request:Request){try{return Response.json(await rbacData(await requireViewer(),rbacScope(new URL(request.url).searchParams)),{headers});}catch(e){return failure(e);}}
export async function POST(request:Request){try{sameOrigin(request);const viewer=await requireViewer(),p=await body(request,32768),proof=await prepareManagementAuthorization(request,viewer,p.managementToken);return Response.json(await manageRbac(viewer,p,proof),{headers});}catch(e){return failure(rbacFailure(e));}}
