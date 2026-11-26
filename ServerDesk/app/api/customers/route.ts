import {body,failure,HttpError,requireViewer,sameOrigin} from '@/lib/server/context';
import {requireCan} from '@/lib/server/identity/policy/can';
import {prepareManagementAuthorization} from '@/lib/server/identity/rbac';
import {listCustomers,listCustomerTechnicians} from '@/lib/server/identity/customers';
import {createCustomerInstaller,customerInstallerDownload,installerPrerequisites,listCustomerInstallers,listInstallerDeviceGroups,revokeCustomerInstaller} from '@/lib/server/agent/customer-installers';
import {removeCustomerTechnicians,techniciansRemoveOnly} from '@/lib/server/identity/customer-technicians';
import {multipleCustomersSetting,setMultipleCustomers} from '@/lib/server/identity/multiple-customers';
import {createCustomer,deleteCustomer,setCustomerStatus,setCustomerTechnicians,updateCustomer,type CustomerInput} from '@/lib/server/identity/customer-admin';
import type {Viewer} from '@/lib/types';

// Customer administration (docs/customers.md). Only global Owners read the
// customers, because contact data can be personal. The technicians, the
// installers and the delete need a management MFA confirmation, an edit only when it shortens
// the audit retention, create and set-status none (lib/step-up.ts). A set-technicians request that only removes
// goes to removeCustomerTechnicians (lib/server/identity/customer-technicians.ts),
// which never inserts; every other write is in lib/server/identity/customer-admin.ts
// and lib/server/agent/customer-installers.ts; the setting "Multiple customers"
// (set-multiple-customers) in lib/server/identity/multiple-customers.ts.
const headers={'Cache-Control':'no-store'};
const actions=['create','update','set-status','set-technicians','create-installer','revoke-installer','set-multiple-customers','delete'];
const requireOwner=(viewer:Viewer)=>requireCan(viewer,'instance.owner','apiError.customer.ownerOnly');
async function state(){
 const customerList=await listCustomers(),{users,groups,assignments}=await listCustomerTechnicians();
 const [installers,deviceGroups,multipleCustomers]=await Promise.all([listCustomerInstallers(),listInstallerDeviceGroups(),multipleCustomersSetting()]);
 return {customers:customerList,technicians:{users,groups},assignments,installers,deviceGroups,multipleCustomers};
}
const input=(p:Record<string,unknown>):CustomerInput=>({name:p.name,contactName:p.contactName,contactEmail:p.contactEmail,contactPhone:p.contactPhone,auditRetentionDays:p.auditRetentionDays,maintenanceWindow:p.maintenanceWindow});

export async function GET(){try{const viewer=await requireViewer();await requireOwner(viewer);return Response.json(await state(),{headers});}catch(e){return failure(e);}}
export async function POST(request:Request){
 try{
  // 128 KB: a technician assignment can carry up to 2000 ids.
  sameOrigin(request);const viewer=await requireViewer(),p=await body(request,128*1024) as Record<string,unknown>;
  await requireOwner(viewer);
  if(typeof p.action!=='string'||!actions.includes(p.action))throw new HttpError('apiError.customer.unknownAction');
  if(p.action==='set-multiple-customers'){
   await setMultipleCustomers(viewer,p.enabled,p.revision,await prepareManagementAuthorization(request,viewer,p.managementToken));
   return Response.json(await state(),{headers});
  }
  if(p.action==='delete'){
   await deleteCustomer(viewer,p.id,p.revision,await prepareManagementAuthorization(request,viewer,p.managementToken));
   return Response.json(await state(),{headers});
  }
  if(p.action==='revoke-installer'){
   await revokeCustomerInstaller(viewer,p.id,await prepareManagementAuthorization(request,viewer,p.managementToken));
   return Response.json(await state(),{headers});
  }
  // Only removing technicians: the path that never inserts. Anything that
  // adds, and the unchanged set, takes setCustomerTechnicians below.
  const technicians={userIds:p.userIds,groupIds:p.groupIds};
  if(p.action==='set-technicians'&&await techniciansRemoveOnly(p.id,technicians)){
   await removeCustomerTechnicians(viewer,p.id,{...technicians,revision:p.revision},await prepareManagementAuthorization(request,viewer,p.managementToken));
   return Response.json(await state(),{headers});
  }
  if(p.action==='create-installer'){
   // Every agent pins origin and job-signing key: without them no installer is created.
   const {origin}=installerPrerequisites();
   const proof=await prepareManagementAuthorization(request,viewer,p.managementToken);
   const created=await createCustomerInstaller(viewer,{customerId:p.customerId,name:p.name,groupId:p.groupId,mode:p.mode,validDays:p.validDays,maxDevices:p.maxDevices},proof);
   return customerInstallerDownload(created,origin);
  }
  let id:string|undefined;
  // create and set-status rely on the login session; update reads the proof itself, only when it shortens the retention.
  if(p.action==='create')id=await createCustomer(request,viewer,input(p));
  else if(p.action==='update')await updateCustomer(request,viewer,p.id,{...input(p),revision:p.revision},p.managementToken);
  else if(p.action==='set-status')await setCustomerStatus(request,viewer,p.id,p.status,p.revision);
  else await setCustomerTechnicians(viewer,p.id,{...technicians,revision:p.revision},await prepareManagementAuthorization(request,viewer,p.managementToken));
  return Response.json({...await state(),...(id?{id}:{})},{headers});
 }catch(e){return failure(e);}
}
