import {body,failure,HttpError,requireViewer,sameOrigin} from '@/lib/server/context';
import {deviceDhcpView,dhcpUsage} from '@/lib/server/extensions/plugin-data';
import {DhcpChangeInvalid,queueDhcpChange,queueDhcpReplicate} from '@/lib/server/extensions/dhcp-manage';
// The DHCP server of the DHCP plugin (docs/dhcp-server.md): ?serverId= gives
// the latest read of one device for a viewer with dhcp.read there, ?usage=1
// the scope usage of every device where the viewer holds dhcp.read ([] without one).
// POST change queues one DHCP change (mirrored to a managed failover partner),
// POST replicate copies the scope settings of a relationship to its partner
// (lib/server/extensions/dhcp-manage.ts). Both need dhcp.manage, MFA, Management mode and confirm:true.
const headers={'Cache-Control':'no-store'};
export async function GET(request:Request){try{
 const v=await requireViewer(),params=new URL(request.url).searchParams;
 if(params.get('usage')==='1')return Response.json({rows:await dhcpUsage(v)},{headers});
 return Response.json(await deviceDhcpView(v,params.get('serverId')),{headers});
}catch(e){return failure(e);}}
export async function POST(request:Request){try{
 sameOrigin(request);const v=await requireViewer(),p=await body(request,262_144);
 if(p.action==='change')return Response.json(await queueDhcpChange(request,v,{serverId:p.serverId,operation:p.operation,parameters:p.parameters,confirm:p.confirm,secret:p.secret}),{headers});
 if(p.action==='replicate')return Response.json(await queueDhcpReplicate(request,v,{serverId:p.serverId,relationship:p.relationship,scopeId:p.scopeId,confirm:p.confirm}),{headers});
 throw new HttpError('apiError.request.unknownAction');
}catch(e){
 // changeInvalid carries the field errors next to its key, so the drawer marks the fields.
 if(e instanceof DhcpChangeInvalid){const answer=failure(e),json=await answer.json() as Record<string,unknown>;return Response.json({...json,errors:e.errors},{status:answer.status,headers});}
 return failure(e);
}}
