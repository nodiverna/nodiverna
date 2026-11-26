import type {MessageKey} from '@/lib/i18n/translate';
/** A tree node that may belong to a customer: a root group or a device. */
export type CustomerFolderItem={id:string;customerId?:string|null};
export type CustomerFolder={id:string;name:string;groupIds:string[];deviceIds:string[];count:number};
export type CustomerFolderLayout={folders:CustomerFolder[];rest:{groupIds:string[];deviceIds:string[]}};

/**
 * Sorts the root groups and ungrouped devices of the device tree into one
 * folder per visible customer, also for a customer without groups and devices
 * (count 0). Returns null for fewer than two customers, so a portal with one customer
 * and single-customer technicians keep the flat tree. Groups and devices of an
 * unknown or missing customer stay in the rest.
 */
export function customerFolders(customers:readonly {id:string;name:string}[]|undefined,rootGroups:readonly CustomerFolderItem[],looseDevices:readonly CustomerFolderItem[],treeDevices:readonly CustomerFolderItem[]):CustomerFolderLayout|null{
 if(!customers||customers.length<2)return null;
 const folders=new Map<string,CustomerFolder>(customers.map(customer=>[customer.id,{id:customer.id,name:customer.name,groupIds:[],deviceIds:[],count:0}]));
 const rest={groupIds:[] as string[],deviceIds:[] as string[]};
 const folderOf=(item:CustomerFolderItem)=>item.customerId?folders.get(item.customerId):undefined;
 for(const group of rootGroups){const folder=folderOf(group);(folder?folder.groupIds:rest.groupIds).push(group.id);}
 for(const device of looseDevices){const folder=folderOf(device);(folder?folder.deviceIds:rest.deviceIds).push(device.id);}
 for(const device of treeDevices){const folder=folderOf(device);if(folder)folder.count++;}
 const list=[...folders.values()]
  .sort((a,b)=>a.name.localeCompare(b.name,'de',{numeric:true})||(a.id<b.id?-1:a.id>b.id?1:0));
 return {folders:list,rest};
}

/** One node "Ungrouped" of the device tree: under All devices (no customerId) or in the folder of customerId, with its loose devices. */
export type UngroupedNode={customerId?:string;deviceIds:string[]};
/**
 * The nodes "Ungrouped" of the device tree: one under a parent that has at least one root group and one loose device.
 * In a flat tree (layout null) the parent is All devices; with folders it is each customer folder, and All devices gets
 * none (its rest of groups and devices without a visible customer stays as it is). The tree and the palette read it.
 */
export function ungroupedNodes(layout:CustomerFolderLayout|null,rootGroupCount:number,looseDeviceIds:readonly string[]):UngroupedNode[]{
 if(!layout)return rootGroupCount>0&&looseDeviceIds.length>0?[{deviceIds:[...looseDeviceIds]}]:[];
 return layout.folders.filter(folder=>folder.groupIds.length>0&&folder.deviceIds.length>0).map(folder=>({customerId:folder.id,deviceIds:folder.deviceIds}));
}

export type CustomerFolderAction='create-group'|'manage-customer'|'customer-access'|'customer-installers';
/**
 * The actions of a customer folder in menu order: the tree context menu and the
 * "More actions" menu of the customer view show the same list. Creating a root
 * group needs the root group right; the customer dialogs are Owner-only
 * (canManageCustomers). The server checks every right again.
 */
export function customerFolderActions(rights:{canCreateRootGroup:boolean;canManageCustomers:boolean}):{action:CustomerFolderAction;label:MessageKey}[]{
 return [
  ...(rights.canCreateRootGroup?[{action:'create-group' as const,label:'tree.customer.createGroup' as const}]:[]),
  ...(rights.canManageCustomers?[{action:'manage-customer' as const,label:'tree.customer.manage' as const},{action:'customer-access' as const,label:'tree.customer.access' as const},{action:'customer-installers' as const,label:'tree.customer.installers' as const}]:[]),
 ];
}
