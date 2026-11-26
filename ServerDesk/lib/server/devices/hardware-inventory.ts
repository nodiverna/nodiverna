import {z} from 'zod';

// Physical inventory is optional for earlier v3/v4 agents. Keep unknown values
// nullable and bound every provider-controlled field before snapshot storage.
const id=z.string().min(1).max(128);
const text=z.string().max(256).nullable();
const integer=(maximum:number)=>z.number().finite().int().min(1).max(maximum).nullable();
const bytes=integer(Number.MAX_SAFE_INTEGER);
const unique=<T extends z.ZodType<{id:string}>>(row:T,maximum:number)=>z.array(row).max(maximum).superRefine((items,context)=>{
 if(new Set(items.map(item=>item.id)).size!==items.length)context.addIssue({code:'custom',message:'Hardwarekennungen müssen je Kategorie eindeutig sein.'});
});

export const hardwareInventory=z.object({
 collectedAt:z.string().max(60).datetime({offset:true}),intervalSeconds:z.number().int().min(300).max(86400),complete:z.boolean(),
 errors:z.array(z.string().min(1).max(500)).max(10).optional(),
 cpus:unique(z.object({id,name:z.string().max(256),manufacturer:text,cores:integer(8192),threads:integer(8192),maxClockMhz:integer(100000),socket:text}).strict(),64).optional(),
 memoryModules:unique(z.object({id,deviceLocator:text,bankLabel:text,capacityBytes:bytes,speedMhz:integer(100000),configuredClockMhz:integer(100000),formFactor:text,memoryType:text,manufacturer:text,partNumber:text,serialNumber:text}).strict(),512).optional(),
 memoryArray:z.object({slots:integer(8192),maxCapacityBytes:bytes}).strict().optional(),
 disks:unique(z.object({id,model:text,serialNumber:text,sizeBytes:bytes,busType:text,mediaType:text,healthStatus:z.enum(['healthy','warning','unhealthy','unknown']).nullable(),firmwareVersion:text}).strict(),128).optional(),
 system:z.object({manufacturer:text,model:text,systemType:text,uuid:text}).strict().optional(),
 bios:z.object({manufacturer:text,name:text,version:text,releasedAt:z.string().max(60).datetime({offset:true}).nullable(),serialNumber:text}).strict().optional(),
 baseboard:z.object({manufacturer:text,product:text,version:text,serialNumber:text}).strict().optional(),
 networkAdapters:unique(z.object({id,name:text,manufacturer:text,mac:text,speedMbps:z.number().finite().min(0).max(10000000).nullable(),physicalAdapter:z.boolean().nullable()}).strict(),128).optional(),
}).strict().superRefine((inventory,context)=>{
 if(!inventory.complete&&!inventory.errors?.length)context.addIssue({code:'custom',path:['errors'],message:'Unvollständiges Hardwareinventar benötigt einen Fehlerhinweis.'});
 if(inventory.complete&&inventory.errors?.length)context.addIssue({code:'custom',path:['complete'],message:'Hardwareinventar mit Erfassungsfehlern ist unvollständig.'});
});
