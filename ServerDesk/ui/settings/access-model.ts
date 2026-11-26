// The permission catalog of the console: the right as the API sends it, its name in the console language and the
// categories the role drawer groups the rights in (ui/settings/settings-roles.tsx, ui/devices/configuration/permissions-tab.tsx).
import type {MessageKey} from '@/lib/i18n/translate';

/** A right as the API sends it: its id and the catalog key of its name (lib/server/identity/access.ts). */
export type AccessPermission={id:string;labelKey:MessageKey};

// Permission categories; label is a catalog key.
const categories:{id:string;label:MessageKey;matches:(id:string)=>boolean}[]=[
 {id:'monitoring',label:'rbac.category.monitoring',matches:(id:string)=>['view','diagnose','security.events','alerts.manage'].includes(id)},
 {id:'files',label:'rbac.category.files',matches:(id:string)=>id.startsWith('files.')},
 {id:'remote',label:'rbac.category.remote',matches:(id:string)=>['terminal','rdp'].includes(id)},
 {id:'automation',label:'rbac.category.automation',matches:(id:string)=>id==='runbooks'||id.startsWith('runbooks.')},
 {id:'configuration',label:'rbac.category.configuration',matches:(id:string)=>id==='manage'||id.startsWith('drift.')||id.startsWith('desired.')},
 {id:'defender',label:'rbac.category.defender',matches:(id:string)=>id.startsWith('defender.')},
 {id:'extensions',label:'rbac.category.extensions',matches:(id:string)=>id==='plugins.manage'||id.startsWith('dhcp.')||id.startsWith('dns.')},
 {id:'administration',label:'rbac.category.administration',matches:(id:string)=>['update','groups.manage'].includes(id)}
];
/** The name of a right in the console language; an unknown id shows as itself. */
export function accessPermissionName(id:string,definitions:readonly AccessPermission[]|undefined,t:(key:MessageKey)=>string){const definition=definitions?.find(permission=>permission.id===id);return definition?t(definition.labelKey):id;}
export function accessPermissionGroups(definitions:AccessPermission[]){
 const assigned=new Set<string>();
 const groups=categories.map(category=>{const permissions=definitions.filter(permission=>category.matches(permission.id));for(const permission of permissions)assigned.add(permission.id);return {id:category.id,label:category.label,permissions};}).filter(group=>group.permissions.length>0);
 const other=definitions.filter(permission=>!assigned.has(permission.id));
 return other.length?[...groups,{id:'other',label:'rbac.category.other' as MessageKey,permissions:other}]:groups;
}
