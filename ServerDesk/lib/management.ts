import {z} from 'zod';
import {fileDefinitions} from './file-operations';
import {storageOperations,storageTarget,isStorageOperation} from './storage-operations';
import {desiredStateOperations} from './desired-state-operations';
import {gpuDriverVendorNames,gpuDriverVersionPattern,type GpuDriverVendor} from './gpu-drivers/installed';
const name=z.string().trim().min(1).max(128).regex(/^[a-zA-Z0-9_. -]+$/);
const feature=z.string().min(1).max(128).regex(/^[a-zA-Z0-9-]+$/);
const localName=z.string().trim().min(1).max(20).regex(/^[^"/\\\[\]:;|=,+*?<>@\s]+$/).refine(s=>!/^\.+$/.test(s));
const password=z.string().min(1).max(127).regex(/^[^\u0000-\u001f]+$/);
const username=z.string().min(1).max(256).regex(/^[^\u0000-\u001f]+$/);
const dnsName=z.string().min(1).max(253).regex(/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/);
const ipv4=z.ipv4(),ip=z.union([z.ipv4(),z.ipv6()]);
const plain=z.string().regex(/^[^\u0000-\u001f]*$/);
const remoteAddress=z.string().min(1).max(500).refine(s=>s==='Any'||s==='LocalSubnet'||s.split(',').every(part=>{const [address,prefix,...rest]=part.trim().split('/');const valid=ip.safeParse(address);return valid.success&&!rest.length&&(prefix===undefined||/^\d{1,3}$/.test(prefix)&&Number(prefix)<=(address.includes(':')?128:32));}));
const credentials={username,password};
const service=z.object({name}).strict();
const network=z.object({interfaceIndex:z.number().int().min(1).max(2147483647),dhcp:z.boolean(),address:ipv4.optional(),prefixLength:z.number().int().min(1).max(32).optional(),gateway:ipv4.optional()}).strict().refine(p=>p.dhcp||!!p.address&&p.prefixLength!==undefined,'Statische IPv4-Adresse und Präfix erforderlich.');
const pagefile=z.object({automatic:z.boolean(),drive:z.string().regex(/^[A-Z]:$/).optional(),initialMb:z.number().int().min(16).max(1048576).optional(),maximumMb:z.number().int().min(16).max(1048576).optional()}).strict().refine(p=>p.automatic||!!p.drive&&p.initialMb!==undefined&&p.maximumMb!==undefined&&p.maximumMb>=p.initialMb,'Laufwerk und gültige Größen erforderlich.');
const group=z.object({name:localName,groupSid:z.string().max(184).regex(/^S-1-5-(?:32-\d+|21-\d+-\d+-\d+-\d+)$/)}).strict();
const power=z.object({delaySeconds:z.number().int().min(60).max(3600),reason:z.string().min(1).max(200)}).strict();
const calendarPower=z.object({operation:z.enum(['shutdown','restart']),scheduledAt:z.string().datetime().refine(value=>{const delay=Date.parse(value)-Date.now();return delay>=60000&&delay<=30*86400000;},'Termin muss zwischen einer Minute und 30 Tagen in der Zukunft liegen.'),reason:plain.min(1).max(200)}).strict();
// Vendor and version only: the console adds URL and size from the server's own lookup (lib/server/devices/gpu-drivers/device.ts).
const gpuDriverInstallation=z.object({vendor:z.enum(['nvidia','amd']),version:z.string().regex(gpuDriverVersionPattern)}).strict();
const updateInstallation=z.union([z.object({updateIds:z.array(z.guid()).min(1).max(50).refine(ids=>new Set(ids.map(id=>id.toLowerCase())).size===ids.length,'Doppelte Update-IDs sind nicht erlaubt.')}).strict(),z.object({all:z.literal(true)}).strict()]);
type Definition={label:string;category:string;readOnly:boolean;schema:z.ZodTypeAny;sensitive?:boolean;disruptive?:boolean};
export const operations:Record<string,Definition>={
 ...fileDefinitions,...storageOperations,...desiredStateOperations,
 refresh:{label:'Inventar aktualisieren',category:'Diagnose',readOnly:true,schema:z.object({}).strict()},
 'scan-updates':{label:'Updates suchen',category:'Updates',readOnly:true,schema:z.object({}).strict()},
 'test-connection':{label:'Verbindung prüfen',category:'Diagnose',readOnly:true,schema:z.object({host:dnsName,port:z.number().int().min(1).max(65535)}).strict()},
 'start-service':{label:'Dienst starten',category:'Dienste',readOnly:false,schema:service},
 'stop-service':{label:'Dienst stoppen',category:'Dienste',readOnly:false,schema:service},
 'restart-service':{label:'Dienst neu starten',category:'Dienste',readOnly:false,schema:service},
 'set-service-startup':{label:'Dienststarttyp ändern',category:'Dienste',readOnly:false,schema:z.object({name,startup:z.enum(['Automatic','Manual','Disabled'])}).strict()},
 'install-feature':{label:'Rolle / Feature installieren',category:'Rollen',readOnly:false,schema:z.object({name:feature,includeManagementTools:z.boolean().default(true)}).strict()},
 'remove-feature':{label:'Rolle / Feature entfernen',category:'Rollen',readOnly:false,disruptive:true,schema:z.object({name:feature,includeManagementTools:z.boolean().default(true)}).strict()},
 'set-network':{label:'IPv4-Konfiguration ändern',category:'Netzwerk',readOnly:false,disruptive:true,schema:network},
 'set-dns':{label:'DNS-Server ändern',category:'Netzwerk',readOnly:false,disruptive:true,schema:z.object({interfaceIndex:z.number().int().positive().max(2147483647),automatic:z.boolean(),servers:z.array(ip).max(8)}).strict().refine(p=>p.automatic||p.servers.length>0,'Mindestens ein DNS-Server erforderlich.')},
 'join-domain':{label:'Domäne beitreten',category:'System',readOnly:false,sensitive:true,disruptive:true,schema:z.object({domain:dnsName,ouPath:plain.max(1000).optional(),...credentials}).strict()},
 'leave-domain':{label:'Domäne verlassen',category:'System',readOnly:false,sensitive:true,disruptive:true,schema:z.object({workgroup:z.string().min(1).max(15).regex(/^[a-zA-Z0-9_-]+$/),...credentials}).strict()},
 'rename-computer':{label:'Computer umbenennen',category:'System',readOnly:false,sensitive:true,disruptive:true,schema:z.object({name:z.string().min(1).max(15).regex(/^(?!\d+$)[a-zA-Z0-9][a-zA-Z0-9-]*$/),username:username.optional(),password:password.optional()}).strict().refine(p=>Boolean(p.username)===Boolean(p.password),'Benutzername und Passwort gemeinsam angeben.')},
 'set-rdp':{label:'Remote Desktop einschalten / ausschalten',category:'System',readOnly:false,disruptive:true,schema:z.object({enabled:z.boolean(),confirm:z.literal(true)}).strict()},
 'set-pagefile':{label:'Auslagerungsdatei ändern',category:'System',readOnly:false,disruptive:true,schema:pagefile},
 'create-local-user':{label:'Lokalen Benutzer erstellen',category:'Benutzer',readOnly:false,sensitive:true,schema:z.object({name:localName,fullName:plain.max(256),description:plain.max(48),passwordNeverExpires:z.boolean(),password}).strict()},
 'set-local-user':{label:'Lokalen Benutzer ändern',category:'Benutzer',readOnly:false,schema:z.object({name:localName,enabled:z.boolean(),fullName:plain.max(256),description:plain.max(48),passwordNeverExpires:z.boolean()}).strict()},
 'reset-local-password':{label:'Lokales Passwort ändern',category:'Benutzer',readOnly:false,sensitive:true,schema:z.object({name:localName,password}).strict()},
 'delete-local-user':{label:'Lokalen Benutzer löschen',category:'Benutzer',readOnly:false,disruptive:true,schema:z.object({name:localName}).strict()},
 'local-group-add':{label:'Lokale Gruppenmitgliedschaft hinzufügen',category:'Benutzer',readOnly:false,schema:group},
 'local-group-remove':{label:'Lokale Gruppenmitgliedschaft entfernen',category:'Benutzer',readOnly:false,schema:group},
 'restart-computer':{label:'Server neu starten',category:'System',readOnly:false,disruptive:true,schema:power},
 'shutdown-computer':{label:'Server herunterfahren',category:'System',readOnly:false,disruptive:true,schema:power},
 'schedule-power':{label:'Systemaktion zum Termin planen',category:'System',readOnly:false,disruptive:true,schema:calendarPower},
 'cancel-power-schedule':{label:'Geplante Systemaktion abbrechen',category:'System',readOnly:false,disruptive:true,schema:z.object({scheduleId:z.guid()}).strict()},
 'install-updates':{label:'Windows-Updates installieren',category:'Updates',readOnly:false,schema:updateInstallation},
 'install-gpu-driver':{label:'Grafiktreiber aktualisieren',category:'Updates',readOnly:false,disruptive:true,schema:gpuDriverInstallation},
 'set-firewall-rule':{label:'Firewallregel einschalten / ausschalten',category:'Firewall',readOnly:false,disruptive:true,schema:z.object({name:plain.min(1).max(256),enabled:z.boolean()}).strict()},
 'add-firewall-rule':{label:'Firewallregel erstellen',category:'Firewall',readOnly:false,disruptive:true,schema:z.object({name:z.string().min(1).max(120).regex(/^[a-zA-Z0-9_. -]+$/),direction:z.enum(['Inbound','Outbound']),action:z.enum(['Allow','Block']),protocol:z.enum(['TCP','UDP']),port:z.string().max(100).regex(/^\d{1,5}(?:-\d{1,5})?(?:,\d{1,5}(?:-\d{1,5})?)*$/).refine(s=>s.split(',').every(r=>{const a=r.split('-').map(Number);return a.every(n=>n>=1&&n<=65535)&&(a.length===1||a[0]<=a[1]);})),remoteAddress}).strict()},
 // Microsoft Defender of agent 4.15.0: no parameters; the job needs defender.control (lib/jobs/requirements.ts).
 'defender-quick-scan':{label:'Defender-Schnellscan starten',category:'Defender',readOnly:false,schema:z.object({}).strict()},
 'defender-full-scan':{label:'Defender-Vollscan starten',category:'Defender',readOnly:false,schema:z.object({}).strict()},
 'defender-update-signatures':{label:'Defender-Signaturen aktualisieren',category:'Defender',readOnly:false,schema:z.object({}).strict()},
 'defender-clean-detections':{label:'Alle aktiven Defender-Funde bereinigen',category:'Defender',readOnly:false,schema:z.object({}).strict()},
 'set-task':{label:'Geplante Aufgabe einschalten / ausschalten',category:'Aufgaben',readOnly:false,schema:z.object({name:z.string().min(1).max(238).regex(/^[^\\*?\[\]\u0000-\u001f]+$/),path:z.string().min(1).max(500).regex(/^\\[^*?\[\]\u0000-\u001f]*\\$|^\\$/),enabled:z.boolean()}).strict()}
};
export function safeTarget(kind:string,p:Record<string,unknown>):string{
 // A Defender job acts on the whole device: the audit target is the device name only.
 if(kind.startsWith('defender-'))return '';
 if(isStorageOperation(kind))return storageTarget(kind,p);
 if(['list-files','create-directory','rename-file','delete-file'].includes(kind))return String(p.path??'Laufwerke')+(kind==='rename-file'?' → '+String(p.name):'');
 if(kind==='join-domain')return String(p.domain);
 if(kind==='leave-domain')return String(p.workgroup);
 if(kind==='set-network'||kind==='set-dns')return 'Adapter '+p.interfaceIndex;
 if(kind==='test-connection')return p.host+':'+p.port;
 if(kind==='install-gpu-driver')return (gpuDriverVendorNames[p.vendor as GpuDriverVendor]??String(p.vendor))+' '+String(p.version);
 if(kind==='install-updates')return p.all===true?'Alle verfügbaren Softwareupdates':String((p.updateIds as unknown[]).length)+' Updates';
 if(kind==='schedule-power')return (p.operation==='restart'?'Neustart':'Herunterfahren')+' / '+String(p.scheduledAt);
 if(kind==='cancel-power-schedule')return String(p.scheduleId);
 if(p.name)return String(p.name);
 if(kind==='set-pagefile')return p.automatic?'Automatisch':String(p.drive);
 return operations[kind]?.label??kind;
}
