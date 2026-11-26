import type {Server} from '@/lib/types';
import {manufacturerLogos} from '@/ui/devices/hardware/manufacturer-logos';

// The manufacturer that a device reports (docs/manufacturer-logos.md): the raw WMI value normalized to a known
// manufacturer with its display name and, where the vendored Simple Icons release has one, its monochrome logo.
// Manufacturer names are proper names and stay literal here.

export type Manufacturer={id:string;name:string;logo:boolean};

/** BIOS placeholders that name no manufacturer. */
const placeholders=new Set(['system manufacturer','to be filled by o.e.m.','default string','o.e.m.','oem','not applicable','unknown']);

/** The known manufacturers, first match wins (HPE before HP). slug: the Simple Icons slug of the logo, null without one.
 * Microsoft and Apple never get a logo: their trademark guidelines do not allow this use. */
export const manufacturerTable:readonly {id:string;match:readonly RegExp[];name:string;slug:string|null}[]=[
 {id:'hpe',match:[/hewlett packard enterprise/,/^hpe\b/],name:'HPE',slug:null},
 {id:'hp',match:[/^hp\b/,/^hewlett-packard/,/^hewlett packard/],name:'HP',slug:'hp'},
 {id:'dell',match:[/^dell\b/],name:'Dell',slug:'dell'},
 {id:'lenovo',match:[/^lenovo/],name:'Lenovo',slug:'lenovo'},
 {id:'asus',match:[/^asus/],name:'ASUS',slug:'asus'},
 {id:'acer',match:[/^acer\b/],name:'Acer',slug:'acer'},
 {id:'msi',match:[/^micro-star/,/^msi\b/],name:'MSI',slug:'msi'},
 {id:'fujitsu',match:[/fujitsu/],name:'Fujitsu',slug:'fujitsu'},
 {id:'supermicro',match:[/supermicro/,/super micro/],name:'Supermicro',slug:'supermicro'},
 {id:'gigabyte',match:[/gigabyte/],name:'GIGABYTE',slug:null},
 {id:'samsung',match:[/^samsung/],name:'Samsung',slug:'samsung'},
 {id:'toshiba',match:[/^toshiba/],name:'Toshiba',slug:'toshiba'},
 {id:'intel',match:[/^intel/],name:'Intel',slug:'intel'},
 {id:'vmware',match:[/^vmware/],name:'VMware',slug:'vmware'},
 {id:'qemu',match:[/^qemu/],name:'QEMU',slug:'qemu'},
 {id:'virtualbox',match:[/^innotek/],name:'VirtualBox',slug:'virtualbox'},
 {id:'cisco',match:[/^cisco/],name:'Cisco',slug:'cisco'},
 {id:'huawei',match:[/^huawei/],name:'Huawei',slug:'huawei'},
 {id:'panasonic',match:[/^panasonic/],name:'Panasonic',slug:'panasonic'},
 {id:'google',match:[/^google/],name:'Google',slug:'google'},
 {id:'microsoft',match:[/^microsoft/],name:'Microsoft',slug:null},
 {id:'apple',match:[/^apple/],name:'Apple',slug:null},
 {id:'dynabook',match:[/^dynabook/],name:'Dynabook',slug:null},
 {id:'medion',match:[/^medion/],name:'Medion',slug:null},
 {id:'wortmann',match:[/^wortmann/],name:'Wortmann',slug:null},
 {id:'xen',match:[/^xen/],name:'Xen',slug:null},
 {id:'amazon',match:[/^amazon/],name:'Amazon EC2',slug:null},
];

const logoPaths=new Map(manufacturerLogos.map(logo=>[logo.id,logo.path]));

/** The manufacturer of a raw WMI value: null for an empty value or a placeholder, a known manufacturer from the table,
 * else {id:'other'} with the trimmed value as its name and no logo. */
export function manufacturerOf(raw:string|null|undefined):Manufacturer|null{
 const value=(raw??'').trim(),lower=value.toLowerCase();
 if(!value||placeholders.has(lower))return null;
 const known=manufacturerTable.find(entry=>entry.match.some(pattern=>pattern.test(lower)));
 if(!known)return {id:'other',name:value,logo:false};
 return {id:known.id,name:known.name,logo:!!known.slug&&logoPaths.has(known.id)};
}

/** The logo path (viewBox 0 0 24 24) of a manufacturer id, undefined without a logo. */
export const manufacturerLogoPath=(id:string)=>logoPaths.get(id);

/** The manufacturer and model of a device: the hardware inventory first, else the snapshot. */
export function deviceManufacturer(server:Pick<Server,'snapshot'>):{manufacturer:Manufacturer|null;raw:string;model:string}{
 const snapshot=server.snapshot,system=snapshot?.hardware?.system;
 const raw=(system?.manufacturer||snapshot?.manufacturer||'').trim(),model=(system?.model||snapshot?.model||'').trim();
 return {manufacturer:manufacturerOf(raw),raw,model};
}
