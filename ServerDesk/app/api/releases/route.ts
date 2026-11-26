import {requireViewer,sameOrigin,body,failure,HttpError,now,guid,log} from '@/lib/server/context';
import {requireDevice,allowedDeviceIds,principal} from '@/lib/server/identity/access';
import {featureTargetsGuard} from '@/lib/server/identity/feature-authorization';
import {can,requireCan,viewerCanSql} from '@/lib/server/identity/policy/can';
import {mfaSessionFence,requireLiveSessions,requireMfa} from '@/lib/server/identity/mfa';
import {modern,maintenanceBusy} from '@/lib/server/agent/agent-protocol';
import {releases,releaseEnvelopes,retireRelease} from '@/lib/server/agent/releases';
import {updateCampaigns,hasOpenRdpSession,hasActiveAgentUpdate,scheduleAgentUpdates} from '@/lib/server/agent/release-rollout';
import {sweepRdp} from '@/lib/server/devices/rdp';
import {compareAgentVersions,isDevVersion,releasePathsCapability} from '@/lib/agent-update-state';
import {agentChangelogHistory} from '@/lib/server/agent/agent-changelog-history';
import {authorizeTargetCustomers,recheckCrossCustomer} from '@/lib/server/identity/cross-customer';
import {routeAuditActions} from '@/lib/audit-actions';
import {devBuildsEnabled,releaseSourceView,requestReleaseCheck,requireReleaseSourceOwner,setDevBuilds} from '@/lib/server/agent/release-source';
// Rolling out a signed agent release is routine (lib/step-up.ts): it needs the
// right update, a confirmation and the live MFA login session. After validation
// and the per-device checks, lib/server/agent/release-rollout.ts admits every job only with
// the request's live primary and MFA session (mfaSessionFence); a session that
// ended meanwhile writes nothing and answers the MFA-session error. A supplied
// managementToken is ignored and its proof stays unused.
// Releases enter the catalog only through the import of the release source
// (runtime/release-import.mjs), never through this route.
// The release source (lib/server/agent/release-source.ts) is Owner only: check relies on
// the login session. The portal reads the public repository without a token, so
// the source has only check and devBuilds (Import dev builds, the same MFA as
// check); an unknown action answers like a failed deploy.
// Dev builds (X.Y.Z-dev.<sha7>): every release viewer gets devBuilds; a deploy of
// a dev build answers devBuildsOff while the switch is off, before any write.
// Release management is open to the Owner and to a viewer with the right update on at least one device.
async function requireReleaseViewer(viewer?:Awaited<ReturnType<typeof requireViewer>>){const v=viewer??await requireViewer(),ids=await allowedDeviceIds(v,'update');if(!ids.length&&!await can(v,'instance.owner'))throw new HttpError('apiError.release.maintenanceRightMissing');return {v,ids};}
// history: the bundled changelogs of every agent version (lib/server/agent/agent-changelog-history.ts), for the changes between the installed and the offered agent.
// devBuilds: whether device updates offer dev builds (Import dev builds).
export async function GET(){try{const {v,ids}=await requireReleaseViewer();const owner=await can(v,'instance.owner');return Response.json({releases:await releases(),campaigns:await updateCampaigns(ids),history:agentChangelogHistory,devBuilds:await devBuildsEnabled(),...(owner?{source:await releaseSourceView()}:{})},{headers:{'Cache-Control':'no-store'}});}catch(e){return failure(e);}}
const sourceActions=new Set(['check','devBuilds']);
export async function POST(request:Request){try{sameOrigin(request);const viewer=await requireViewer(),p=await body(request);
 // The release source answers ownerOnly to every non-Owner, before the MFA check.
 if(sourceActions.has(p.action))await requireReleaseSourceOwner(viewer);
 const {v}=await requireReleaseViewer(viewer);await requireMfa(request,v);
 if(p.action==='check'){return Response.json({source:await requestReleaseCheck(v)});}
 if(p.action==='devBuilds'){if(typeof p.enabled!=='boolean')throw new HttpError('apiError.request.invalid');return Response.json({source:await setDevBuilds(v,p.enabled)});}
 if(p.action==='disable'||p.action==='delete'){
  await requireCan(v,'instance.owner');if(!guid(p.releaseId)||p.confirm!==true)throw new HttpError('apiError.release.releaseAndConfirmRequired');
  const result=await retireRelease(p.releaseId,p.action,v.id,viewerCanSql(v,'instance.owner'));await log(v.label,p.action==='delete'?routeAuditActions.releaseDeleted:routeAuditActions.releaseDisabled,result.release.version);return Response.json({ok:true,cancelledJobs:result.cancelledJobs});
 }
 if(p.action!=='deploy'||p.confirm!==true||!Array.isArray(p.serverIds)||p.serverIds.length<1||p.serverIds.length>20||!p.serverIds.every(guid))throw new HttpError('apiError.release.pilotDevicesRequired');const {release:r,path}=await releaseEnvelopes(p.releaseId),time=now();if(isDevVersion(r.version)&&!await devBuildsEnabled())throw new HttpError('apiError.release.devBuildsOff');const scheduledAt=p.scheduledAt===undefined?time:Number(p.scheduledAt);if(!Number.isSafeInteger(scheduledAt)||scheduledAt<time-60000||scheduledAt>time+7*86400000)throw new HttpError('apiError.release.windowTooFar');const staged:{id:string;serverId:string;name:string;envelope:{manifest:string;signature:string}}[]=[];
 // Every device gets the signed path envelope. An agent that does not report release-paths (before 4.12.0) cannot verify it: the whole request fails before any write.
 for(const id of [...new Set<string>(p.serverIds)]){const d=await requireDevice(v,id,'update'),s=modern(d,'agent-update');await sweepRdp(id,time);if(await hasOpenRdpSession(id))throw new HttpError('apiError.release.disconnectRdp',{name:d.name});if(await maintenanceBusy(id)||await hasActiveAgentUpdate(id))throw new HttpError('apiError.release.updateActive',{name:d.name});if(Number(r.version.split('.')[0])>=4&&Number(s.agentVersion.split('.')[0])<4)throw new HttpError('apiError.release.nativeSwitch',{name:d.name});const comparison=compareAgentVersions(r.version,s.agentVersion);if(comparison===null)throw new HttpError('apiError.release.versionUnverifiable');if(comparison<0)throw new HttpError('apiError.release.noDowngrade');if(r.version===s.agentVersion)throw new HttpError('apiError.release.sameVersion',{name:d.name});if(!s.agentCapabilities?.includes(releasePathsCapability))throw new HttpError('apiError.release.legacyFormUnavailable',{name:d.name});staged.push({id:crypto.randomUUID(),serverId:id,name:d.name,envelope:{manifest:path.manifest,signature:path.signature}});}
 const authorization=featureTargetsGuard(v,staged.map(j=>j.serverId),['update']);
 // Cross-customer: gate after the per-device checks, its guard in every job, one customer entry per customer in the same batch.
 const customers=await authorizeTargetCustomers(v,staged.map(j=>j.serverId));
 const fence=await mfaSessionFence(request,v);
 const result=await scheduleAgentUpdates({staged,release:r,time,scheduledAt,actor:{id:v.id,label:v.label,principal:principal(v)},authorization,customers,fence});
 // Not written: an ended session answers its own error first, then the customer gate, else the rollout changed.
 if(!result.written){await requireLiveSessions(request,v);await recheckCrossCustomer(v,customers);throw new HttpError('apiError.release.rolloutChanged');}await log(v.label,routeAuditActions.agentUpdateScheduled,r.version,staged.map(j=>j.serverId));return Response.json({jobs:staged.map(j=>j.id),scheduledAt});
 }catch(e){return failure(e);}}
