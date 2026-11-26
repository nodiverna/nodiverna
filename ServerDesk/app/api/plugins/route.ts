import {body,failure,HttpError,requireViewer,sameOrigin} from '@/lib/server/context';
import {requireMfa} from '@/lib/server/identity/mfa';
import {pluginReleaseView,preparePluginDeploy,preparePluginInstall,preparePluginRemove,queuePluginDeploy,queuePluginInstall,queuePluginJob,queuePluginRemove} from '@/lib/server/extensions/plugins';
// Agent plugins (lib/server/extensions/plugins.ts, docs/agent-plugins.md). GET lists the plugin
// releases for a viewer with plugins.manage on a device or an Owner. POST:
// install and remove (one device) and deploy (1 to 20 pilot devices) distribute
// a signed release, which is routine (lib/step-up.ts): they need a confirmation
// and the live MFA login session, checked after every other check, so a broken
// request never asks for MFA first. lib/server/extensions/plugins.ts admits the job writes with
// the session fence. A supplied managementToken is ignored and its proof stays.
// job queues a plugin read without confirmation or MFA (dns-zone-read with
// parameters {zone}).
const headers={'Cache-Control':'no-store'};
// The actions besides job; anything else answers unknownAction.
const distributionActions:ReadonlySet<string>=new Set(['install','remove','deploy']);
export async function GET(){try{const v=await requireViewer();return Response.json(await pluginReleaseView(v),{headers});}catch(e){return failure(e);}}
export async function POST(request:Request){try{
 sameOrigin(request);const v=await requireViewer(),p=await body(request);
 if(p.action==='job')return Response.json(await queuePluginJob(v,{serverId:p.serverId,plugin:p.plugin,operation:p.operation,parameters:p.parameters}),{headers});
 if(typeof p.action!=='string'||!distributionActions.has(p.action))throw new HttpError('apiError.request.unknownAction');
 if(p.action==='install'){
  const prepared=await preparePluginInstall(v,p);await requireMfa(request,v);
  return Response.json(await queuePluginInstall(request,v,prepared),{headers});
 }
 if(p.action==='remove'){
  const prepared=await preparePluginRemove(v,p);await requireMfa(request,v);
  return Response.json(await queuePluginRemove(request,v,prepared),{headers});
 }
 const prepared=await preparePluginDeploy(v,p);await requireMfa(request,v);
 return Response.json(await queuePluginDeploy(request,v,prepared),{headers});
}catch(e){return failure(e);}}
