import {z} from 'zod';

const bytes=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const disk=z.object({diskNumber:z.number().int().min(0).max(65535),diskUniqueId:z.string().min(1).max(512).regex(/^[^\u0000-\u001f]+$/),expectedDiskSizeBytes:bytes.min(1),confirm:z.literal(true)}).strict();
const partition=disk.extend({partitionNumber:z.number().int().min(1).max(65535),expectedOffsetBytes:bytes,expectedSizeBytes:bytes.min(1)}).strict();
const label=z.string().max(32).regex(/^[^\u0000-\u001f\\/:*?"<>|]+$|^$/);
const driveLetter=z.string().regex(/^[D-Z]$/);
const fileSystem=z.enum(['NTFS','ReFS']);
type Definition={label:string;category:string;readOnly:boolean;schema:z.ZodTypeAny;disruptive?:boolean};

export const storageOperations:Record<string,Definition>={
 'storage-inspect':{label:'Datenträgerinventar abfragen',category:'Datenträger',readOnly:true,schema:z.object({}).strict()},
 'storage-initialize':{label:'Datenträger initialisieren',category:'Datenträger',readOnly:false,disruptive:true,schema:disk.extend({partitionStyle:z.enum(['GPT','MBR'])}).strict()},
 'storage-set-disk':{label:'Datenträgerstatus ändern',category:'Datenträger',readOnly:false,disruptive:true,schema:disk.extend({setting:z.enum(['online','offline','readOnly','writable'])}).strict()},
 'storage-new-volume':{label:'Volume erstellen',category:'Datenträger',readOnly:false,disruptive:true,schema:disk.extend({sizeBytes:bytes.min(16777216).optional(),useMaximumSize:z.boolean(),driveLetter:driveLetter.optional(),fileSystem,label}).strict().refine(p=>p.useMaximumSize?p.sizeBytes===undefined:p.sizeBytes!==undefined,'Entweder maximale Größe oder eine Volumegröße angeben.')},
 'storage-resize':{label:'Volumegröße ändern',category:'Datenträger',readOnly:false,disruptive:true,schema:partition.extend({sizeBytes:bytes.min(16777216)}).strict()},
 'storage-drive-letter':{label:'Laufwerkbuchstaben ändern',category:'Datenträger',readOnly:false,disruptive:true,schema:partition.extend({driveLetter:driveLetter.optional(),remove:z.boolean()}).strict().refine(p=>p.remove?p.driveLetter===undefined:p.driveLetter!==undefined,'Laufwerkbuchstaben angeben oder entfernen.')},
 'storage-format':{label:'Volume formatieren',category:'Datenträger',readOnly:false,disruptive:true,schema:partition.extend({fileSystem,label}).strict()},
 'storage-delete-partition':{label:'Partition löschen',category:'Datenträger',readOnly:false,disruptive:true,schema:partition}
};
export const isStorageOperation=(kind:unknown):kind is string=>typeof kind==='string'&&Object.hasOwn(storageOperations,kind);
export function storageTarget(kind:string,p:Record<string,unknown>){return kind==='storage-inspect'?'Datenträgerinventar':`Datenträger ${p.diskNumber}${p.partitionNumber?` / Partition ${p.partitionNumber}`:''}`;}

export type StoragePartition={number:number;offsetBytes:number;sizeBytes:number;type:string;gptType:string;driveLetter:string;accessPaths:string[];fileSystem:string;label:string;health:string;freeBytes:number|null;sizeMinBytes:number|null;sizeMaxBytes:number|null;protected:boolean;growOnly?:boolean;protectionReasons:string[];};
export type StorageDisk={number:number;uniqueId:string;name:string;serial:string;busType:string;partitionStyle:string;sizeBytes:number;allocatedBytes:number;largestFreeExtentBytes:number;offline:boolean;readOnly:boolean;health:string;operationalStatus:string;protected:boolean;protectionReasons:string[];partitions:StoragePartition[];};
export type StorageInventory={disks:StorageDisk[];truncated:boolean;warnings:string[];};

