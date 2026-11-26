import {body,failure,HttpError,requireViewer,sameOrigin} from '@/lib/server/context';
import {deviceDnsView,deviceDnsZoneView,dnsFleetZones} from '@/lib/server/extensions/dns-data';
import {DnsChangeInvalid,queueDnsChange} from '@/lib/server/extensions/dns-manage';
// The DNS server of the DNS plugin (docs/dns-server.md): ?serverId= gives the
// latest server read of one device for a viewer with dns.read there,
// ?serverId=&zone= the stored records of one zone, ?zones=1 the zones of every
// device where the viewer holds dns.read ([] without one). POST change queues
// one DNS change (lib/server/extensions/dns-manage.ts): dns.manage, MFA, Management mode, the AD
// sign-in and confirm:true.
const headers={'Cache-Control':'no-store'};
export async function GET(request:Request){try{
 const v=await requireViewer(),params=new URL(request.url).searchParams;
 if(params.get('zones')==='1')return Response.json({rows:await dnsFleetZones(v)},{headers});
 if(params.has('zone'))return Response.json(await deviceDnsZoneView(v,params.get('serverId'),params.get('zone')),{headers});
 return Response.json(await deviceDnsView(v,params.get('serverId')),{headers});
}catch(e){return failure(e);}}
export async function POST(request:Request){try{
 sameOrigin(request);const v=await requireViewer(),p=await body(request,262_144);
 if(p.action==='change')return Response.json(await queueDnsChange(request,v,{serverId:p.serverId,operation:p.operation,parameters:p.parameters,confirm:p.confirm}),{headers});
 throw new HttpError('apiError.request.unknownAction');
}catch(e){
 // changeInvalid carries the field errors next to its key, so the drawer marks the fields.
 if(e instanceof DnsChangeInvalid){const answer=failure(e),json=await answer.json() as Record<string,unknown>;return Response.json({...json,errors:e.errors},{status:answer.status,headers});}
 return failure(e);
}}
