import {body,failure,HttpError,requireViewer,sameOrigin} from '@/lib/server/context';
import {requireMfa} from '@/lib/server/identity/mfa';
import {setDriftPolicy,setDriftEnabled,applyGroupDriftPolicy,listDrift,acceptDriftBaseline} from '@/lib/server/automation/drift';
const headers={'Cache-Control':'no-store'};
export async function GET(request:Request){try{const url=new URL(request.url);return Response.json(await listDrift(await requireViewer(),url.searchParams.get('serverId')??'',url.searchParams.get('reportId')??undefined,url.searchParams.get('compact')==='1'),{headers});}catch(e){return failure(e);}}
export async function POST(request:Request){try{sameOrigin(request);const v=await requireViewer(),p=await body(request);if(!p||typeof p!=='object'||Array.isArray(p))throw new HttpError('apiError.request.invalid');let result;
 switch(p.action){case 'apply-group':await requireMfa(request,v);result=await applyGroupDriftPolicy(v,p.groupId,p.policy,p.confirm);break;case 'set-policy':await requireMfa(request,v);result=await setDriftPolicy(v,p.serverId,p.policy);break;case 'set-enabled':await requireMfa(request,v);if(Object.keys(p).some(key=>!['action','serverId','enabled','version'].includes(key)))throw new HttpError('apiError.drift.invalidActivation');result=await setDriftEnabled(v,p.serverId,p.enabled,p.version);break;case 'accept-baseline':await requireMfa(request,v);result=await acceptDriftBaseline(v,p.serverId,p.reportId,p.confirm);break;default:throw new HttpError('apiError.drift.unknownAction');}
 return Response.json(result,{headers});}catch(e){return failure(e);}}
