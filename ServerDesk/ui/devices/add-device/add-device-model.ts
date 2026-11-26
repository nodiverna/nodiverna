// The pure logic of the page Add device (#devices/add, ui/devices/add-device/add-device.tsx and
// add-device-installers.tsx): the step states of "One device", the customer and group
// preselection, the blocked reasons, the registration file, the waiting state, the tab links
// and the texts of the installer list ("Several devices"). No React, so tests import it directly.
import {connectionKind} from '@/lib/device-connection';
import {defaultCustomerId} from '@/lib/default-customer';
import {consoleRouteHash} from '@/lib/console-route';
import {defaultLocale,type Locale} from '@/lib/i18n/locale';
import {translate,type MessageKey} from '@/lib/i18n/translate';
import type {Customer} from '@/lib/server/identity/customers';
import type {CustomerInstaller,InstallerDeviceGroup,InstallerMode,InstallerStatus} from '@/lib/server/agent/customer-installers';
import type {StatusKind} from '@/ui/kit/kit';

// The agent modes and their D5 labels come from ui/base/agent-mode.ts (agentModeLabel), never the raw ReadOnly.
export type {AgentMode} from '@/ui/base/agent-mode';

// ---- Tabs ----
/** The choice the page carries in its tab links: the customer and the group of the current form. */
export type AddDeviceChoice={customerId:string;groupId:string};
/** The hash of a tab of the page with the current choice: #devices/add[/installer][/customer/<id>][/group/<id>]. */
export function addDeviceTabHref(installer:boolean,choice:AddDeviceChoice):string{
 return consoleRouteHash({view:'add-device',installer,customerId:choice.customerId,groupId:choice.groupId});
}

// ---- One device: preselection ----
export type EnrollCustomers={
 /** True once a second customer exists (ConsoleData.multipleCustomers) and the console is not in demo mode. */
 multipleCustomers:boolean;
 /** The visible customers of the console data. */
 customers:ReadonlyArray<{id:string;name:string}>;
 /** The customer of each group (id → customerId). */
 groupCustomers:Readonly<Record<string,string|undefined>>;
};
/**
 * The customer and group the form starts with. With one customer: no customer, the route group. With several
 * customers: the route customer when it is visible (an unknown id is ignored); a route group preselects itself and,
 * without a route customer, its customer; a group of another customer than the route customer is dropped. A
 * route group that no longer exists stays chosen, so the form can show "Group no longer available".
 */
export function enrollStartChoice({routeCustomer,routeGroup,groups,multipleCustomers,customers,groupCustomers}:{routeCustomer:string;routeGroup:string;groups:ReadonlyArray<readonly [string,string]>}&EnrollCustomers):AddDeviceChoice{
 if(!multipleCustomers)return {customerId:'',groupId:routeGroup};
 const visible=(id:string|undefined):id is string=>!!id&&customers.some(customer=>customer.id===id);
 const customer=visible(routeCustomer)?routeCustomer:'';
 if(!routeGroup)return {customerId:customer,groupId:''};
 if(!groups.some(([id])=>id===routeGroup))return {customerId:customer,groupId:routeGroup};
 const ofGroup=groupCustomers[routeGroup];
 if(customer)return {customerId:customer,groupId:ofGroup===customer?routeGroup:''};
 return visible(ofGroup)?{customerId:ofGroup,groupId:routeGroup}:{customerId:'',groupId:''};
}
/** The groups the group field offers: all with one customer, else only the chosen customer's (none before a customer is chosen). */
export function enrollGroupChoices(groups:ReadonlyArray<readonly [string,string]>,customerId:string,{multipleCustomers,groupCustomers}:Pick<EnrollCustomers,'multipleCustomers'|'groupCustomers'>){
 return multipleCustomers?groups.filter(([id])=>!!customerId&&groupCustomers[id]===customerId):[...groups];
}
/** A customer change keeps the group only when it belongs to the new customer. */
export function chooseEnrollCustomer(choice:AddDeviceChoice,customerId:string,groupCustomers:Readonly<Record<string,string|undefined>>):AddDeviceChoice{
 return {customerId,groupId:choice.groupId&&groupCustomers[choice.groupId]!==customerId?'':choice.groupId};
}
/** The chosen group is gone (a route group that no longer exists, or one deleted meanwhile). */
export const enrollGroupMissing=(groupId:string,groups:ReadonlyArray<readonly [string,string]>)=>!!groupId&&!groups.some(([id])=>id===groupId);

/** Why "Download registration" cannot run, the first that applies; null when it can. */
export function enrollBlockedKey({demo,owner,name,multipleCustomers,customerId,groupMissing}:{demo:boolean;owner:boolean;name:string;multipleCustomers:boolean;customerId:string;groupMissing:boolean}):MessageKey|null{
 if(demo)return 'kit.unavailable.demo';
 if(!owner)return 'agents.enroll.adminsOnly';
 if(!name.trim())return 'agents.enroll.nameFirst';
 if(multipleCustomers&&!customerId)return 'agents.enroll.customerFirst';
 if(groupMissing)return 'agents.enroll.groupMissing';
 return null;
}

// ---- One device: registration and steps ----
/** The file name of a downloaded registration: ServerDesk-<name>.registration.json, every character outside [a-z0-9-] as "_". */
export const registrationFileName=(name:string)=>`ServerDesk-${name.replace(/[^a-z0-9-]/gi,'_')}.registration.json`;
/** The device id of a registration JSON (agent/package-v3.ts), or null when the text holds none. */
export function registrationDeviceId(text:string):string|null{
 try{const value=JSON.parse(text) as {id?:unknown};return typeof value?.id==='string'&&value.id?value.id:null;}catch{return null;}
}
/** A registration downloaded on this page visit. */
export type Registration={name:string;fileName:string;deviceId:string|null};

/** Where the new device is: no registration yet, waiting for its first report, or reported (online or offline). */
export type AddDevicePhase='form'|'waiting'|'online'|'offline';
export function addDevicePhase(registration:Registration|null,servers:ReadonlyArray<{id:string;lastSeen:number|null;maintenance?:{state:string}|null}>,now:number):AddDevicePhase{
 if(!registration)return 'form';
 const server=registration.deviceId?servers.find(item=>item.id===registration.deviceId):undefined;
 if(!server||!server.lastSeen)return 'waiting';
 return connectionKind(server,now)==='online'?'online':'offline';
}
export type AddDeviceStepId='register'|'download'|'install'|'wait';
export const addDeviceStepIds:readonly AddDeviceStepId[]=['register','download','install','wait'];
export const addDeviceStepTitles:Record<AddDeviceStepId,MessageKey>={register:'addDevice.step.register',download:'addDevice.step.download',install:'addDevice.step.install',wait:'addDevice.step.wait'};
/** The state of each step: current then waiting before the download; done, none, none, current while waiting; all done after the first report. */
export function addDeviceStepStates(phase:AddDevicePhase):Record<AddDeviceStepId,'done'|'current'|'waiting'|undefined>{
 if(phase==='form')return {register:'current',download:'waiting',install:'waiting',wait:'waiting'};
 if(phase==='waiting')return {register:'done',download:undefined,install:undefined,wait:'current'};
 return {register:'done',download:'done',install:'done',wait:'done'};
}
/** How often step 4 asks the console for fresh data while it waits. */
export const waitingRefreshMs=10_000;
/** The refresh timer runs only while the page waits for the device, shows One device and is not in demo mode. */
export const waitingRefreshActive=({phase,shown,demo}:{phase:AddDevicePhase;shown:boolean;demo:boolean})=>phase==='waiting'&&shown&&!demo;

// ---- Several devices: installers ----
/** What GET /api/customers answers (app/api/customers/route.ts); the page reads the customers, installers and groups. */
export type InstallersView={customers:Customer[];installers?:CustomerInstaller[];deviceGroups?:InstallerDeviceGroup[]};

/** Group column of an installer: no group, deleted when the group is gone, otherwise its name. */
export function installerGroupText(groupId:string|null,groupName:string|null,locale:Locale=defaultLocale){return groupId===null?translate(locale,'groups.noGroup'):groupName??translate(locale,'customers.installer.groupDeleted');}
/** Devices column: the count without a limit, count of limit with one. */
export function installerDevicesText(enrollments:number,maxDevices:number|null,locale:Locale=defaultLocale){return maxDevices===null?String(enrollments):translate(locale,'customers.installer.devices',{enrollments,max:maxDevices});}
const installerStatusTexts:Record<InstallerStatus,MessageKey>={active:'management.active',expired:'jobs.state.expired',revoked:'customers.installer.revoked',exhausted:'customers.installer.exhausted','group-missing':'customers.installer.groupMissing'};
export function installerStatusText(status:InstallerStatus,locale:Locale=defaultLocale){return translate(locale,installerStatusTexts[status]);}
/** The pill of a status: active success, a missing group warning, every other end state neutral. */
export const installerStatusKinds:Record<InstallerStatus,StatusKind>={active:'success',expired:'neutral',exhausted:'neutral',revoked:'neutral','group-missing':'warning'};
/** The share of the maximum that is used, in percent, or null without a maximum. */
export const installerUsage=(enrollments:number,maxDevices:number|null)=>maxDevices===null||maxDevices<=0?null:Math.min(100,enrollments/maxDevices*100);

/**
 * The customer whose installers the tab shows: with one customer the default customer of the answer (else
 * its only one); with it the chosen customer when it is in the answer, else the only customer, else none.
 */
export function installerCustomer(customers:readonly Customer[],{multipleCustomers,chosen}:{multipleCustomers:boolean;chosen:string}):Customer|null{
 if(!multipleCustomers)return customers.find(customer=>customer.id===defaultCustomerId)??(customers.length===1?customers[0]:null);
 return customers.find(customer=>customer.id===chosen)??(customers.length===1?customers[0]:null);
}
/** The copy of the tab Several devices: with one customer it names no customer, with several the shown one. */
export type InstallerCopy={description:string;table:string;emptyTitle:string;drawerTitle:string};
export function installerCopy(multipleCustomers:boolean,customerName:string,locale:Locale=defaultLocale):InstallerCopy{
 if(!multipleCustomers)return {description:translate(locale,'addDevice.installers.descriptionSingle'),table:translate(locale,'addDevice.installers.tableSingle'),
  emptyTitle:translate(locale,'addDevice.installers.emptyTitleSingle'),drawerTitle:translate(locale,'addDevice.installers.create')};
 const customer={customer:customerName};
 return {description:translate(locale,'addDevice.installers.description'),table:translate(locale,'addDevice.installers.table',customer),
  emptyTitle:translate(locale,'addDevice.installers.emptyTitle',customer),drawerTitle:translate(locale,'addDevice.installers.drawerTitle',customer)};
}
/** Why "Create installer" cannot run, the first that applies: demo, no customer, a disabled customer. */
export function installerCreateBlocked({demo,customer,locale=defaultLocale}:{demo:boolean;customer:Customer|null;locale?:Locale}):string|null{
 if(demo)return translate(locale,'kit.unavailable.demo');
 if(!customer)return translate(locale,'agents.enroll.customerFirst');
 if(customer.status==='disabled')return translate(locale,'customers.installer.disabledCustomer');
 return null;
}

export const installerValidDays=[1,7,30,90,365] as const;
export type InstallerForm={name:string;groupId:string;mode:InstallerMode;validDays:number;maxDevices:string};
/** A new form: no name, the route group when it belongs to this customer, Read-only, 30 days, unlimited. */
export function installerStartForm(customerId:string,routeGroup:string,deviceGroups:readonly InstallerDeviceGroup[]):InstallerForm{
 return {name:'',groupId:deviceGroups.some(group=>group.id===routeGroup&&group.customerId===customerId)?routeGroup:'',mode:'ReadOnly',validDays:30,maxDevices:''};
}
/** The maximum: null for empty (unlimited), the number for a whole number from 1 to 10000, else invalid. */
export function installerMaxDevices(value:string):{valid:true;value:number|null}|{valid:false}{
 const typed=value.trim();
 if(typed==='')return {valid:true,value:null};
 if(!/^\d+$/.test(typed))return {valid:false};
 const number=Number(typed);
 return number>=1&&number<=10000?{valid:true,value:number}:{valid:false};
}
/** The body of POST /api/customers create-installer without the managementToken; null while the maximum is invalid. */
export function installerCreateBody(customerId:string,form:InstallerForm):{action:'create-installer';customerId:string;name:string;groupId:string|null;mode:InstallerMode;validDays:number;maxDevices:number|null}|null{
 const max=installerMaxDevices(form.maxDevices);
 if(!max.valid)return null;
 return {action:'create-installer',customerId,name:form.name.trim(),groupId:form.groupId||null,mode:form.mode,validDays:form.validDays,maxDevices:max.value};
}
/** The file name of the created installer: the Content-Disposition name, else Install-ServerDesk.ps1. */
export const installerFileName=(disposition:string|null)=>/filename="([^"]+)"/.exec(disposition??'')?.[1]??'Install-ServerDesk.ps1';
/** The ids of a reloaded list that the list before did not have: the new installer to highlight. */
export const newInstallerIds=(before:readonly {id:string}[],after:readonly {id:string}[])=>after.filter(item=>!before.some(old=>old.id===item.id)).map(item=>item.id);
