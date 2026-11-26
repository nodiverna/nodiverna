import {z} from 'zod';

// Only local Windows paths: no shares, alternate streams, ambiguous names or agent data.
export function validFilePath(value:string){
 return value.length>=3&&value.length<=240&&/^[a-z]:\\/i.test(value)&&!/[\x00-\x1f*?<>"|]/.test(value)&&!value.slice(2).includes(':')&&!value.split(/[\\/]/).some(part=>part==='..'||part==='.'||part.endsWith('.')||part.endsWith(' '))&&!/\\(?:ServerDesk|ServerDeskAgent)(?:\\|$)/i.test(value);
}
const path=z.string().refine(validFilePath,'Absoluten lokalen Windows-Pfad ohne Platzhalter angeben.').transform(value=>value.replaceAll('/','\\'));
export const fileNameSchema=z.string().min(1).max(255).refine(value=>!/[\x00-\x1f\\/:*?<>"|]/.test(value)&&!value.endsWith('.')&&!value.endsWith(' ')&&!/^\.{1,2}$/.test(value)&&! /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value)&&! /^(?:ServerDesk|ServerDeskAgent)$/i.test(value),'Gültigen Datei- oder Ordnernamen angeben.');
export const fileDefinitions={
 'list-files':{label:'Ordner anzeigen',category:'Dateien',readOnly:true,schema:z.object({path:path.optional(),offset:z.number().int().min(0).max(19800).default(0),limit:z.number().int().min(1).max(200).default(200),includeSecurity:z.boolean().default(false)}).strict()},
 'create-directory':{label:'Ordner erstellen',category:'Dateien',readOnly:false,schema:z.object({path}).strict()},
 'rename-file':{label:'Datei / Ordner umbenennen',category:'Dateien',readOnly:false,schema:z.object({path,name:fileNameSchema}).strict()},
 'delete-file':{label:'Datei / leeren Ordner löschen',category:'Dateien',readOnly:false,disruptive:true,schema:z.object({path}).strict()}
} as const;
export type FileKind=keyof typeof fileDefinitions;
export function isFileKind(value:unknown):value is FileKind{return typeof value==='string'&&Object.hasOwn(fileDefinitions,value);}
export function filePermission(kind:FileKind):'files.read'|'files.write'{return fileDefinitions[kind].readOnly?'files.read':'files.write';}
export function fileSecurityPath(value:string){return /\\(?:Security\.evtx|security-(?:events|support)-[^\\]+)$/i.test(value);}
export function fileSecurityAccess(kind:string,params:Record<string,unknown>){return kind==='list-files'?params.includeSecurity===true:typeof params.path==='string'&&(fileSecurityPath(params.path)||(kind==='rename-file'&&typeof params.name==='string'&&fileSecurityPath(params.path.substring(0,params.path.lastIndexOf('\\')+1)+params.name)));}
// Guided file rights must not silently grant SYSTEM access to credential stores,
// user profiles or executable/configuration trees. Windows short names are
// ambiguous until resolved on the device and always require privileged rights.
export function privilegedFilePath(value:string){
 const path=value.replaceAll('/','\\').replace(/\\+/g,'\\');
 return path.split('\\').some(part=>part==='.'||part==='..'||part.endsWith('.')||part.endsWith(' '))||/~/.test(path)||/^[a-z]:\\(?:Windows|Winnt|Program Files(?: \(x86\))?|ProgramData|Users|Documents and Settings|System Volume Information|Recovery)(?:\\|$)/i.test(path)||/\\(?:NTDS|Microsoft\\(?:Protect|Credentials|Vault|Crypto))(?:\\|$)/i.test(path)||/\\(?:SAM|SYSTEM|SECURITY|SOFTWARE|DEFAULT)(?:\.(?:bak|sav|old|log\d*|regtrans-ms))?$/i.test(path)||/\.(?:dit|pfx|p12|key|pem|kdbx)$/i.test(path);
}
export function fileManagementAccess(kind:string,parameters:Record<string,unknown>){
 if(typeof parameters.path!=='string')return false;
 return privilegedFilePath(parameters.path)||(kind==='rename-file'&&typeof parameters.name==='string'&&privilegedFilePath(parameters.path.slice(0,parameters.path.lastIndexOf('\\')+1)+parameters.name));
}
