// The device and group model of the navigator tree (ui/devices/fleet/inventory-tree.tsx): the targets and actions of its
// menus, the devices it lists (with metadata-only permission targets) and the group folders with their device counts.
// Pure, so the console and the tests share it.
import type {DeviceGroup,Server as ServerRecord} from '@/lib/types';
import {translate} from '@/lib/i18n/translate';
import {defaultLocale,type Locale} from '@/lib/i18n/locale';

export type InventoryTarget={type:'global'|'group'|'device'|'customer';id?:string;name:string};
export type InventoryAction='create-group'|'manage-group'|'rename-group'|'delete-group'|'permissions'|'provision'|'manage-customer'|'customer-access'|'customer-installers'|'pin'|'unpin';
export type NavigationDevice=Pick<ServerRecord,'id'|'name'|'groupId'|'groupName'|'groups'|'permissions'|'customerId'>&{permissionOnly?:boolean};
export type PermissionDevice=Pick<NavigationDevice,'id'|'name'|'groupId'|'groupName'|'groups'|'customerId'>;
export type NavigationGroup={id:string;name:string;parentId:string|null;depth:number;permissions?:string[];customerId?:string;servers:NavigationDevice[];directServers:NavigationDevice[]};

const sortDevices=(items:NavigationDevice[])=>items.sort((a,b)=>a.name.localeCompare(b.name,'de',{numeric:true})||a.id.localeCompare(b.id));

/** The visible devices plus, for a viewer who manages permissions, the permission-only targets (no monitoring fields). */
export function navigationDevices(servers:NavigationDevice[],permissionDevices:PermissionDevice[]|undefined,canManagePermissions:boolean):NavigationDevice[]{
 const devices=[...servers],seen=new Set(servers.map(server=>server.id));
 if(canManagePermissions)for(const target of permissionDevices??[]){if(seen.has(target.id))continue;seen.add(target.id);const {id,name,groupId,groupName,groups,customerId}=target;devices.push({id,name,groupId,groupName,groups,customerId,permissionOnly:true});}
 return devices;
}

/** The group folders: the catalog owns every folder when it is loaded; each folder counts its own and its descendants' devices once. */
export function navigationDeviceGroups(servers:NavigationDevice[],catalog?:DeviceGroup[],locale:Locale=defaultLocale):NavigationGroup[]{
 const groups=new Map<string,NavigationGroup>();
 if(catalog!==undefined)for(const group of catalog)groups.set(group.id,{id:group.id,name:group.name,parentId:group.parentId??null,depth:group.depth??0,permissions:group.permissions,customerId:group.customerId,servers:[],directServers:[]});
 else for(const server of servers){const references=server.groups?.length?server.groups:server.groupId?[{id:server.groupId,name:server.groupName||translate(locale,'tree.deviceGroup'),parentId:null,depth:0,direct:true}]:[];for(const reference of references)if(!groups.has(reference.id))groups.set(reference.id,{id:reference.id,name:reference.name,parentId:reference.parentId??null,depth:reference.depth??0,servers:[],directServers:[]});}
 for(const server of servers){
  const direct=server.groups?.length?server.groups.filter(group=>group.direct).map(group=>group.id):server.groupId?[server.groupId]:[];
  for(const id of new Set(direct)){
   const group=groups.get(id);if(!group)continue;
   group.directServers.push(server);
   const seen=new Set<string>();let ancestor:NavigationGroup|undefined=group;
   while(ancestor&&!seen.has(ancestor.id)){seen.add(ancestor.id);if(!ancestor.servers.some(item=>item.id===server.id))ancestor.servers.push(server);ancestor=ancestor.parentId?groups.get(ancestor.parentId):undefined;}
  }
 }
 return [...groups.values()].sort((a,b)=>a.name.localeCompare(b.name,'de',{numeric:true})||a.id.localeCompare(b.id)).map(group=>({...group,servers:sortDevices(group.servers),directServers:sortDevices(group.directServers)}));
}
