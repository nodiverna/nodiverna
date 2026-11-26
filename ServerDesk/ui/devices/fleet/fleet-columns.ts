import type {Server} from '@/lib/types';
import {defaultLocale,type Locale} from '@/lib/i18n/locale';
import {translate,type MessageKey} from '@/lib/i18n/translate';
import {deviceManufacturer} from '@/ui/devices/hardware/manufacturer-model';

// Optional columns of the fleet table (ui/devices/fleet/fleet.tsx), in table and menu
// order. The customer column exists only once a second customer exists (customerColumn).
// Device, Status, Health (level and issue counts), Last report and the actions are fixed columns, not in the menu.
export const fleetColumnKeys=['customer','group','description','tags','os','manufacturer','cpu','memory','disk','agent','osSupport','bitlocker','diskHealth','ssdWear','battery'] as const;
export type FleetColumnKey=typeof fleetColumnKeys[number];
export type Columns=Record<FleetColumnKey,boolean>;
/** The live values (CPU, RAM, Free) and the group show by default; description and tags stay in the menu, the search and the tag filter. */
export const defaultFleetColumns:Columns={customer:true,group:true,description:false,tags:false,os:false,manufacturer:false,cpu:true,memory:true,disk:true,agent:false,osSupport:false,bitlocker:false,diskHealth:false,ssdWear:false,battery:false};
/** Message keys of the column names. */
export const fleetColumnNames:Record<FleetColumnKey,MessageKey>={customer:'csv.customer',group:'csv.group',description:'fleet.col.description',tags:'fleet.col.tags',os:'csv.os',manufacturer:'fleet.col.manufacturer',cpu:'fleet.col.cpu',memory:'fleet.col.memory',disk:'fleet.col.diskFree',agent:'fleet.col.agent',osSupport:'fleet.col.osSupport',bitlocker:'fleet.col.bitlocker',diskHealth:'fleet.col.diskHealth',ssdWear:'fleet.col.ssdWear',battery:'fleet.col.battery'};

/** The column keys the menu offers: the customer only when the column is available, the group only while a device of the view is in a group (groupColumnShows). */
export function availableFleetColumns(customerColumn:boolean,groupColumn:boolean):FleetColumnKey[]{
 return fleetColumnKeys.filter(key=>(key!=='customer'||customerColumn)&&(key!=='group'||groupColumn));
}

/**
 * Whether the Group column (and card line) says something: true when at least one device is in a group
 * (a groupId, or a non-blank groupName). Without any, every row would read "No group", so the column and
 * its menu entry leave; the stored column choice stays and applies again once a device joins a group.
 */
export function groupColumnShows(devices:readonly Pick<Server,'groupId'|'groupName'>[]):boolean{
 return devices.some(device=>!!device.groupId||!!device.groupName?.trim());
}

/**
 * Whether a Customer column (and card line) tells the devices apart: true when they belong to two or
 * more customers. The key is the customer id, or else the trimmed customer name; devices without
 * either are ignored. A customer or group view holds one customer (database rule), so it gives false.
 */
export function customerColumnDistinguishes(devices:readonly Pick<Server,'customerId'|'customerName'>[]):boolean{
 const keys=new Set<string>();
 for(const device of devices){
  const name=device.customerName?.trim();
  const key=device.customerId?'id:'+device.customerId:name?'name:'+name:null;
  if(!key)continue;
  keys.add(key);
  if(keys.size>1)return true;
 }
 return false;
}

/**
 * The stored selection (localStorage serverdesk.redesign.columns). Every key that
 * is not a boolean takes its default, so a selection saved before the customer column existed
 * shows the column; anything that is not an object gives the defaults. A stored key that is no
 * longer a column (health, now fixed) is ignored.
 */
export function parseFleetColumns(value:unknown):Columns{
 const stored=value&&typeof value==='object'?value as Record<string,unknown>:{};
 return Object.fromEntries(fleetColumnKeys.map(key=>[key,typeof stored[key]==='boolean'?stored[key]:defaultFleetColumns[key]])) as Columns;
}

/**
 * Lower-case text the fleet search matches: name, OS, addresses, group, customer, description, previous names (a renamed device is found by its old name), the names and values of the effective tags, and the manufacturer (display name and raw value) and model.
 * A minimal or partial snapshot may lack the networks list or a network's addresses (the type says required, stored data does not always follow).
 */
export function fleetSearchText(server:Server&{groupName?:string|null}):string{
 const made=deviceManufacturer(server);
 return [server.name,server.snapshot?.os,made.manufacturer?.name,made.raw,made.model,(server.snapshot?.networks??[]).flatMap(network=>network?.addresses??[]).join(' '),server.groupName,server.customerName,server.description,...(server.previousNames??[]),...(server.tags??[]).flatMap(tag=>[tag.name,tag.value])].filter(Boolean).join(' ').toLowerCase();
}

/**
 * The search field's placeholder: the main fields only, at most 26 code points
 * so it fits the field at 1440 px. The search still matches every field of
 * fleetSearchText, description included.
 */
export function fleetSearchPlaceholder(customerColumn:boolean,locale:Locale=defaultLocale):string{
 return translate(locale,customerColumn?'fleet.searchWithCustomer':'fleet.search');
}
