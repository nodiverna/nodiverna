import {featureDeviceGuard,featureTargetsGuard} from '@/lib/server/identity/feature-authorization';
import {can,requireCan,viewerCanSql} from '@/lib/server/identity/policy/can';
import {requireViewer,sameOrigin,body,config,now,random,hash,HttpError,failure,log,guid} from '@/lib/server/context';
import {installerV3,registrationV3} from '@/agent/package-v3';
import {portalCertificateView,portalRootCertificate} from '@/lib/server/agent/portal-certificate';
import {dispatchSigner,signingKeyFailure} from '@/lib/server/agent/agent-dispatch';
import {operations} from '@/lib/management';
import {allowedDeviceIds,effectivePermissions,principal,requireDevice,requireGroup} from '@/lib/server/identity/access';
import {deviceGroupCatalog,devicePermissionTargets} from '@/lib/server/devices/device-group-catalog';
import {requireMfa} from '@/lib/server/identity/mfa';
import {maintenanceBusy} from '@/lib/server/agent/agent-protocol';
import {PERSONAL_REGISTRATION_LIFETIME} from '@/lib/server/agent/device-tokens';
import {jobRequirements} from '@/lib/jobs/requirements';
import {mergedJobs,projectDevices,scopeJobs,scopeRunbookJobs} from '@/lib/server/devices/device-projection';
import {MAX_QUEUED_JOBS,queueFullError} from '@/lib/server/devices/jobs/queue';
import {offboardingStatus,removeDevice,removeDevices,requestAgentUninstall,sweepRemovedTransfers,validateDeviceRemoval,type RemovalAction} from '@/lib/server/devices/device-lifecycle';
import {moveDevicesToCustomer,validateDeviceCustomerMove} from '@/lib/server/devices/device-customer-move';
import {prepareManagementAuthorization} from '@/lib/server/identity/rbac';
import {consoleActionNeedsStepUp,isDeviceRemovalAction} from '@/lib/step-up';
import {sweepRdp} from '@/lib/server/devices/rdp';
import type {ServerSnapshot} from '@/lib/types';
import {deviceAuditGuard,portalAuditGuard} from '@/lib/server/audit-scope';
import {visibleCustomers} from '@/lib/server/identity/customers';
import {dbFailure} from '@/lib/server/errors/db-codes';
import {auditCursor,cancelPendingJob,consoleMaintenance,consolePortalAuditBefore,withAuditTargetNames,consolePreviousSecretRemovable,consoleAudit,consoleDevices,consoleJobs,consoleRunbookJobs,enrollDevice,enrollmentTarget,jobById,multipleCustomers as readMultipleCustomers,pendingAgentUpdates} from '@/lib/server/console-data';
import {waitingJobCount} from '@/lib/server/devices/job-records';
import {consoleJobDetail} from '@/lib/server/devices/job-detail';
import {queueDeviceOperation} from '@/lib/server/devices/device-job-queue';
import {consoleAlertOverrides} from '@/lib/server/devices/alert-rule-overrides';
import {consoleDeviceTags} from '@/lib/server/devices/tag-store';
import {consoleAlerts} from '@/lib/server/devices/alerts';
import {consoleEsuOverrides} from '@/lib/server/devices/os-esu';
import {consoleAutostart} from '@/lib/server/devices/autostart';
import {consoleServerSoftware} from '@/lib/server/extensions/server-role-software';
import {routeAuditActions} from '@/lib/audit-actions';
import {latestPluginReleases} from '@/lib/server/extensions/plugin-releases';
import {consoleDhcpAlerts} from '@/lib/server/extensions/plugin-data';
import {consoleDnsAlerts} from '@/lib/server/extensions/dns-data';
import {consoleAgentIntegrity} from '@/lib/server/agent/agent-integrity';
import {DEFENDER_BULK_MAX,defenderControlRight,defenderStateBlock,isDefenderJobKind,type DefenderStateBlock} from '@/lib/defender';
import {queueDefenderJobs,type DefenderBulkJob} from '@/lib/server/devices/defender-jobs';
import {authorizeTargetCustomers,recheckCrossCustomer} from '@/lib/server/identity/cross-customer';
import {deviceNamePattern} from '@/lib/device-name';
import type {ApiErrorKey} from '@/lib/errors/api-error-keys';
import {consoleEmergencyAlarms} from '@/lib/server/identity/security-alarms';
import {consoleBranding} from '@/lib/server/branding';
import {accountPreferences} from '@/lib/server/account-preferences';
import {pinnedDeviceIds} from '@/lib/server/pinned-devices';
import {dashboardPreference} from '@/lib/server/dashboard-data';
const headers={'Cache-Control':'no-store'};
// The Defender state of the last report refuses a bulk action Defender cannot run (lib/defender.ts).
const defenderDeviceErrors:Record<DefenderStateBlock,ApiErrorKey>={unavailable:'apiError.defender.deviceUnavailable','scan-running':'apiError.defender.deviceScanRunning','no-detections':'apiError.defender.deviceNoDetections'};
export async function GET(request:Request){try{
 const v=await requireViewer();
 // The offboarding drawer: state of the devices of one removal request (Owners only).
 const offboarding=new URL(request.url).searchParams.get('offboarding');
 if(offboarding!==null)return Response.json({devices:await offboardingStatus(v,offboarding.split(','))},{headers});
 const params=new URL(request.url).searchParams;
 // The job drawer: the kept input and the output of one job, under the job list's own visibility (lib/server/devices/job-detail.ts).
 if(params.get('job')!==null)return Response.json(await consoleJobDetail(v,params.get('serverId'),params.get('job')),{headers});
 // "Load older entries" of the audit log page: the next 100 portal rows before the cursor <at>.<id>.
 if(params.get('audit')!==null){
  const cursor=params.get('audit')==='portal'?auditCursor(params.get('before')):null;
  if(!cursor)throw new HttpError('apiError.request.invalidAction');
  return Response.json({audit:await consolePortalAuditBefore(v,cursor.at,cursor.id,100)},{headers});
 }
 const visible=await allowedDeviceIds(v),scope=JSON.stringify(visible),owner=await can(v,'instance.owner');
 if(new URL(request.url).searchParams.get('jobsOnly')==='1'){
  const [jobs,runbooks,permissionMap]=await Promise.all([visible.length?consoleJobs(scope):[],visible.length?consoleRunbookJobs(scope):{runs:[],steps:[]},effectivePermissions(v,visible)]);
  return Response.json({jobs:mergedJobs(scopeJobs(jobs,owner,permissionMap),scopeRunbookJobs(runbooks,permissionMap)),viewer:v},{headers});
 }
 if(owner){await sweepRemovedTransfers();await sweepRdp();}
 // One statement for every visible device's rights. The device audit
 // gets only the devices with view and security.events and re-checks them live.
 const permissionMap=await effectivePermissions(v,visible),auditDevices=visible.filter(id=>{const rights=permissionMap.get(id)??[];return rights.includes('view')&&rights.includes('security.events');});
 const auditAuthorization=portalAuditGuard(v),deviceAuditAuthorization=deviceAuditGuard(v,auditDevices);
 const evaluatedAt=now();
 const [servers,jobs,runbooks,audit,deviceAudit,updates,deviceGroups,permissionDevices,multipleCustomers,alertOverrides,esuOverrides,deviceTags,openAlerts,autostart,serverSoftware,pluginReleases,dhcpAlerts,dnsAlerts,agentIntegrity]=await Promise.all([
 visible.length?consoleDevices(scope):[],
 visible.length?consoleJobs(scope):[],
 visible.length?consoleRunbookJobs(scope):{runs:[],steps:[]},
 consoleAudit(auditAuthorization,100).then(withAuditTargetNames),
 auditDevices.length?consoleAudit(deviceAuditAuthorization,200):[],
 visible.length?pendingAgentUpdates(scope):[],
 deviceGroupCatalog(v,visible),devicePermissionTargets(v),
 // Once a second customer exists the fleet shows customer names.
 readMultipleCustomers(),
 // The alert rule overrides of every visible device in one statement (global, group paths, devices).
 visible.length?consoleAlertOverrides(scope):[],
 // The ESU dates of every visible device and its group paths in one statement (lib/server/devices/os-esu.ts).
 visible.length?consoleEsuOverrides(scope):[],
 // The effective tags of every visible device in one statement (own tags and inherited group tags).
 visible.length?consoleDeviceTags(scope):new Map(),
 // The open alarms of every visible device in one statement (lib/server/devices/alerts.ts).
 visible.length?consoleAlerts(scope,evaluatedAt):new Map(),
 // The autostart summary of every visible device in one statement (lib/server/devices/autostart.ts); the autostart rules use it.
 visible.length?consoleAutostart(scope):new Map(),
 // The known server products of every visible device in one statement (lib/server/extensions/server-role-software.ts); the Roles tabs use them.
 visible.length?consoleServerSoftware(scope):new Map(),
 // The newest active release of each agent plugin, metadata only (lib/server/extensions/plugin-releases.ts); the Roles tabs show install and repair with it.
 latestPluginReleases(),
 // The stored DHCP data of every visible device in one statement (lib/server/extensions/plugin-data.ts); only the two DHCP alert rules read it.
 visible.length?consoleDhcpAlerts(scope):new Map(),
 visible.length?consoleDnsAlerts(scope):new Map(),
 // The integrity events of every visible device in one statement (lib/server/agent/agent-integrity.ts); only the three agent alert rules read them.
 visible.length?consoleAgentIntegrity(scope):new Map()
]),customers=await visibleCustomers(v);
 // The portal logo and the logos of the visible customers for the top bar (lib/server/branding.ts).
 const branding=await consoleBranding({owner,visibleCustomerIds:customers.map(customer=>customer.id),multipleCustomers});
 // The account's own display preferences (lib/server/account-preferences.ts): whether the console shows its background,
 // its pinned devices that it may still see (lib/server/pinned-devices.ts), and its Dashboard layout with the default
 // layout (lib/server/dashboard-data.ts).
 const preferences={...await accountPreferences(v),pinnedDeviceIds:await pinnedDeviceIds(v),dashboard:await dashboardPreference(v)};
 const evaluatedServers=projectDevices({servers,updates,permissionMap,multipleCustomers,alertOverrides,esuOverrides,deviceTags,openAlerts,autostart,serverSoftware,dhcpAlerts,dnsAlerts,agentIntegrity,evaluatedAt,now:now()});
 const scopedJobs=mergedJobs(scopeJobs(jobs,owner,permissionMap),scopeRunbookJobs(runbooks,permissionMap));
 return Response.json({servers:evaluatedServers,multipleCustomers,branding,preferences,pluginReleases,deviceGroups,permissionDevices,customers,jobs:scopedJobs,audit,deviceAudit,viewer:v,auth:{mode:'local',origin:config('SITE_ORIGIN')},...(owner?{maintenance:await consoleMaintenance(now()),portalCertificate:portalCertificateView(),emergencyAlarms:await consoleEmergencyAlarms(v),...(await consolePreviousSecretRemovable({SESSION_SECRET:config('SESSION_SECRET'),SESSION_SECRET_PREVIOUS:config('SESSION_SECRET_PREVIOUS')})?{previousSecretRemovable:true}:{})}:{})},{headers});
 }catch(e){return failure(e);}}
export async function POST(request:Request){try{
 sameOrigin(request);const v=await requireViewer();const p=await body(request);
 if(p.action==='enroll'){
  await requireCan(v,'instance.owner');await requireMfa(request,v);const name=String(p.name??'').trim();if(!deviceNamePattern.test(name))throw new HttpError('apiError.console.serverName');
  const mode=p.mode??'ReadOnly';if(!['ReadOnly','Management'].includes(mode))throw new HttpError('apiError.console.agentMode');
  const agentVersion=p.agentVersion??4;if(![3,4].includes(agentVersion))throw new HttpError('apiError.console.agentVersion');const format=p.format??'json';if(!['json','bootstrap'].includes(format))throw new HttpError('apiError.console.registrationFormat');
  // Every new agent pins the portal's job-signing key; without it no device
  // record is created whose agent could never accept work.
  let signer;try{signer=dispatchSigner(config('AGENT_JOB_SIGNING_KEY'));}catch(error){throw signingKeyFailure(error);}
  if(!signer)throw new HttpError('apiError.signing.keyMissing');
  const groupId=p.groupId===undefined||p.groupId===null?null:p.groupId;
  if(groupId!==null){if(!guid(groupId))throw new HttpError('apiError.group.invalid');await requireGroup(v,groupId);}
  // The new device's customer: customerId, else the group's customer. Once a
  // second customer exists one of them is required (docs/customers.md); the
  // insert re-checks this in its own SQL against a new customer meanwhile.
  const customerId=p.customerId===undefined||p.customerId===null?null:p.customerId;
  if(customerId!==null&&!guid(customerId))throw new HttpError('apiError.customer.invalid');
  const target=await enrollmentTarget(customerId as string|null,groupId as string|null);
  if(customerId!==null&&!target.customerExists)throw new HttpError('apiError.customer.gone');
  if(customerId!==null&&groupId!==null&&target.groupCustomerId!==null&&target.groupCustomerId!==customerId)throw new HttpError('apiError.customer.mismatch');
  const customerRequired=()=>new HttpError('apiError.console.enrollCustomerRequired');
  if(customerId===null&&groupId===null&&await readMultipleCustomers())throw customerRequired();
  // A personal registration is an access credential and needs a fresh step-up
  // proof (lib/step-up.ts), read after validation so a broken request never asks
  // for MFA first. The proof admits the device row and is consumed in its batch.
  const proof=consoleActionNeedsStepUp(p.action)?await prepareManagementAuthorization(request,v,p.managementToken):null;
  const id=crypto.randomUUID(),token=random(),createdAt=now(),authorization=viewerCanSql(v,'instance.owner');
  // Enrollment and the selected membership commit together. If the selected
  // group disappears after the pre-read, no ungrouped device is created.
  // A disabled customer takes no new device (trigger from 0031), and a group of
  // another customer no membership (customer-mismatch): the batch rolls back
  // and the answer is 409 with the reason.
  let created;
  try{
   const result=await enrollDevice({id,name,tokenHash:await hash(token),createdAt,expiresAt:createdAt+PERSONAL_REGISTRATION_LIFETIME,groupId:groupId as string|null,customerId:customerId as string|null},authorization,proof);
   if(!result.confirmed)throw new HttpError('apiError.mfa.proofExpired');
   created=result.created;
  }catch(error){const conflict=error instanceof Error?dbFailure(error,{},['customer-disabled','customer-mismatch','customer-missing']):null;if(conflict)throw new HttpError(conflict.key);throw error;}
  if(!created.rowCount&&customerId===null&&groupId===null&&await readMultipleCustomers())throw customerRequired();
  if(!created.rowCount)throw new HttpError(groupId===null?'apiError.console.adminRightsChanged':'apiError.console.groupOrAdminRightsChanged');
  await log(v.label,routeAuditActions.agentCreated,name,id);
  const c={id,token,origin:config('SITE_ORIGIN'),jobSigningKey:signer.publicKey,mode};
  if(format==='json')return new Response(registrationV3(c),{headers:{...headers,'Content-Type':'application/json; charset=utf-8','Content-Disposition':`attachment; filename="ServerDesk-${name.replace(/[^a-z0-9-]/gi,'_')}.registration.json"`,'X-Content-Type-Options':'nosniff'}});
  // The portal's own root certificate, if any, lets the script offer its import (lib/server/agent/portal-certificate.ts).
  return new Response("\uFEFF"+installerV3(c,portalRootCertificate()?.der),{headers:{...headers,'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename="Install-ServerDesk-v${agentVersion}-${name.replace(/[^a-z0-9-]/gi,'_')}.ps1"`}});
 }
 if(isDeviceRemovalAction(p.action)){
  // Removing devices is irreversible and needs a fresh step-up proof (lib/step-up.ts),
  // read after the input check so a broken request never asks for MFA first.
  await requireCan(v,'instance.owner');await requireMfa(request,v);validateDeviceRemoval(p.action as RemovalAction,p);const proof=await prepareManagementAuthorization(request,v,p.managementToken);
  // uninstall:true queues the agent uninstall instead; the device is revoked when its agent confirms the start.
  if(p.uninstall===true)return Response.json(await requestAgentUninstall(v,p.action==='remove-servers'?p.ids:[p.id],p.confirm,proof),{headers});
  return Response.json(p.action==='remove-servers'?await removeDevices(v,p.ids,p.confirm,proof):await removeDevice(v,p.id,p.confirm,proof),{headers});
 }else if(p.action==='move-customer'){
  // Moving devices to another customer changes who sees them and needs a fresh step-up proof (lib/step-up.ts, rule 1),
  // read after the input check so a broken request never asks for MFA first (docs/customers.md).
  validateDeviceCustomerMove(p);await requireMfa(request,v);const proof=await prepareManagementAuthorization(request,v,p.managementToken);
  return Response.json(await moveDevicesToCustomer(v,p,proof),{headers});
 }else if(p.action==='cancel-job'){
  if(!guid(p.id))throw new HttpError('apiError.job.invalid');
  const job=await jobById(p.id);if(!job)throw new HttpError('apiError.job.notFound');
  let params:Record<string,unknown>={};try{params=JSON.parse(job.parameters||'{}');}catch{}
  const required=jobRequirements(job.action,params);if(!required.known&&!await can(v,'instance.owner'))throw new HttpError('apiError.job.forbidden');
  for(const right of required.permissions)await requireDevice(v,job.server_id,right);
  const authorization=featureDeviceGuard(v,job.server_id,required.permissions);
  const changed=await cancelPendingJob(p.id,job,authorization);
  if(!changed)throw new HttpError('apiError.job.cancelNotStarted');await log(v.label,routeAuditActions.jobCancelled,String(p.id),changed.server_id);
 }else if(p.action==='job'){
  // One job on one device (lib/server/devices/device-job-queue.ts); the assistant runs its commands through the same checks.
  return Response.json(await queueDeviceOperation(request,v,{serverId:p.id,kind:p.kind,params:p.params,confirm:p.confirm}),{headers});
 }else if(p.action==='defender-jobs'){
  // One Defender action on 1–100 devices (scope tab "Protection"): every device
  // gets the checks of a single job, the first failure names the device and
  // rejects the whole request, and one transaction writes all jobs or none.
  if(!isDefenderJobKind(p.kind))throw new HttpError('apiError.request.invalidAction');
  const ids:unknown[]=Array.isArray(p.ids)?p.ids:[];
  if(!ids.length||ids.length>DEFENDER_BULK_MAX||!ids.every(guid)||new Set(ids.map(id=>String(id).toLowerCase())).size!==ids.length)throw new HttpError('apiError.defender.targets');
  if(p.confirm!==true)throw new HttpError('apiError.console.confirmServerChange');
  await requireMfa(request,v);
  const kind=p.kind,definition=operations[kind],time=now(),staged:DefenderBulkJob[]=[];
  for(const id of ids as string[]){
   const s=await requireDevice(v,id,defenderControlRight),name=String(s.name);
   if(!s.last_seen||now()-s.last_seen>120000)throw new HttpError('apiError.defender.deviceOffline',{name});
   const snapshot:ServerSnapshot|null=s.snapshot?JSON.parse(s.snapshot):null;
   if(snapshot?.protocolVersion!==3)throw new HttpError('apiError.defender.deviceAgent',{name});
   if(await maintenanceBusy(id))throw new HttpError('apiError.agent.maintenanceRetry');
   if(!s.management||snapshot.mode!=='Management')throw new HttpError('apiError.defender.deviceReadOnly',{name});
   if(!snapshot.agentCapabilities?.includes(kind))throw new HttpError('apiError.defender.deviceAgent',{name});
   const block=defenderStateBlock(snapshot,kind);if(block)throw new HttpError(defenderDeviceErrors[block],{name});
   if(await waitingJobCount(id)>=MAX_QUEUED_JOBS)throw queueFullError();
   staged.push({id:crypto.randomUUID(),serverId:id,kind,target:'',parameters:'{}',at:time,actor:v.id,actorEmail:v.label.trim().toLowerCase(),actorPrincipal:principal(v),deviceName:name});
  }
  const serverIds=staged.map(job=>job.serverId);
  // Cross-customer: gate after the per-device checks, its guard in every job, one customer entry per customer in the same transaction.
  const customers=await authorizeTargetCustomers(v,serverIds);
  const written=await queueDefenderJobs({jobs:staged,authorization:featureTargetsGuard(v,serverIds,[defenderControlRight]),customers,maxQueued:MAX_QUEUED_JOBS,actor:v.label,label:definition.label});
  if(!written){await recheckCrossCustomer(v,customers);throw new HttpError('apiError.console.queueChanged');}
  return Response.json({jobs:staged.map(job=>job.id)},{headers});
 }else throw new HttpError('apiError.request.unknownAction');
 return Response.json({ok:true},{headers});
 }catch(e){return failure(e);}}
