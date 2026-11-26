import {z} from 'zod';

const empty=z.object({}).strict();
const limit=z.number().int().min(1).max(1000).default(500);
const session=z.object({sessionId:z.number().int().min(1).max(65535),username:z.string().min(1).max(256),confirm:z.literal(true)}).strict();
const timestamp=z.string().datetime({offset:true});
const channel=z.string().trim().min(1).max(200).regex(/^[a-zA-Z0-9_. /-]+$/);
export const eventFilterSchema=z.object({
 channel:channel.default('System'),from:timestamp.optional(),to:timestamp.optional(),levels:z.array(z.number().int().min(0).max(5)).max(6).default([]),
 provider:z.string().min(1).max(200).regex(/^[a-zA-Z0-9_. -]+$/).optional(),eventIds:z.array(z.number().int().min(0).max(65535)).max(50).default([]),
 text:z.string().max(200).default(''),limit:z.number().int().min(1).max(100).default(50),includeXml:z.boolean().default(false),
 cursor:z.object({channel,recordId:z.number().int().positive(),timeCreated:timestamp}).strict().optional()
}).strict().refine(p=>!p.from||!p.to||Date.parse(p.from)<=Date.parse(p.to),'Start muss vor Ende liegen.').refine(p=>!p.cursor||p.cursor.channel===p.channel,'Cursor gehört zu einem anderen Ereignisprotokoll.');

export const diagnosticDefinitions={
 'list-processes':{label:'Prozesse abfragen',readOnly:true,schema:z.object({limit,sampleMs:z.number().int().min(250).max(1000).default(350)}).strict()},
 'kill-process':{label:'Prozess beenden',readOnly:false,schema:z.object({pid:z.number().int().min(1).max(2147483647),startedAt:timestamp,confirm:z.literal(true)}).strict()},
 'list-sessions':{label:'Benutzersitzungen abfragen',readOnly:true,schema:empty},
 'message-session':{label:'Benutzersitzung benachrichtigen',readOnly:false,schema:session.extend({message:z.string().min(1).max(2000)}).strict()},
 'disconnect-session':{label:'Benutzersitzung trennen',readOnly:false,schema:session},
 'logoff-session':{label:'Benutzersitzung abmelden',readOnly:false,schema:session},
 'list-connections':{label:'TCP-Verbindungen und UDP-Endpunkte abfragen',readOnly:true,schema:z.object({limit,pid:z.number().int().positive().optional()}).strict()},
 'network-diagnostics':{label:'Netzwerkdiagnose ausführen',readOnly:true,schema:z.object({host:z.string().min(1).max(253).regex(/^[a-zA-Z0-9.:-]+$/).optional(),port:z.number().int().min(1).max(65535).default(443)}).strict()},
 'query-events':{label:'Ereignisprotokoll abfragen',readOnly:true,schema:eventFilterSchema},
 'export-events':{label:'Ereignisprotokoll exportieren',readOnly:true,schema:z.object({filter:eventFilterSchema,format:z.enum(['json','csv','evtx'])}).strict()},
 'support-bundle':{label:'Supportpaket erstellen',readOnly:true,schema:z.object({channels:z.array(channel).min(1).max(3).default(['System','Application']),includeEvents:z.boolean().default(true)}).strict()}
} as const;
export type DiagnosticKind=keyof typeof diagnosticDefinitions;
export const diagnosticKinds=Object.keys(diagnosticDefinitions) as DiagnosticKind[];
export const readOnlyDiagnostics:readonly string[]=diagnosticKinds.filter(k=>diagnosticDefinitions[k].readOnly);
export function isDiagnosticKind(value:unknown):value is DiagnosticKind{return typeof value==='string'&&Object.hasOwn(diagnosticDefinitions,value);}
export function diagnosticSecurityAccess(kind:string,params:Record<string,unknown>){
 if(!isDiagnosticKind(kind))return false;
 // Stored parameters may be malformed, so this fails closed: a string is one
 // channel and an array counts by its string elements, whatever the field's
 // well-formed shape is. Other values never count as Security.
 const filter=params.filter,field:unknown=kind==='export-events'?filter&&typeof filter==='object'&&!Array.isArray(filter)?(filter as {channel?:unknown}).channel:undefined:kind==='support-bundle'?params.channels:params.channel;
 const selected:unknown[]=Array.isArray(field)?field:[field];
 return selected.some(value=>typeof value==='string'&&value.trim().toLowerCase()==='security');
}
export function diagnosticTarget(kind:DiagnosticKind,params:Record<string,unknown>){
 if(kind==='kill-process')return 'PID '+params.pid;
 if(kind.includes('session')&&kind!=='list-sessions')return 'Sitzung '+params.sessionId;
 if(kind==='query-events')return String(params.channel);
 if(kind==='export-events')return String((params.filter as {channel:string}).channel)+' / '+params.format;
 if(kind==='network-diagnostics')return params.host?String(params.host)+':'+params.port:'Lokale Netzwerkübersicht';
 return kind;
}
