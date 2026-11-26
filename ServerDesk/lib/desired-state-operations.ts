import {z} from 'zod';
import {HttpError} from './errors/http-error';

export const desiredEngine=z.enum(['dsc3','powershell-dsc','mof']);
// A record drops an own `__proto__` key before the key check sees it, so the raw input is checked first.
const ownProto=(value:unknown)=>value!==null&&typeof value==='object'&&Object.hasOwn(value,'__proto__');
export const desiredParameters=z.unknown().refine(value=>!ownProto(value),'Ungültige Konfigurationsparameter.').pipe(z.record(z.string(),z.union([z.string().max(4096),z.number().finite(),z.boolean()])).refine(v=>Object.keys(v).length<=30&&Object.keys(v).every(k=>/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k)&&!['__proto__','constructor','prototype','OutputPath','ConfigurationData'].includes(k)),'Ungültige Konfigurationsparameter.'));
const encoded=z.string().min(1).max(550000).regex(/^[A-Za-z0-9+/]+={0,2}$/);
export const desiredJobSchema=z.object({assignmentId:z.guid(),versionId:z.guid(),engine:desiredEngine,contentSha256:z.string().regex(/^[0-9a-f]{64}$/),configurationName:z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/).optional(),parameters:desiredParameters.default({}),timeoutSeconds:z.number().int().min(30).max(1800),configuration:z.object({key:encoded,iv:encoded,data:encoded,mac:encoded}).strict()}).strict();
export const desiredStateOperations={
 'desired-state-test':{label:'Sollkonfiguration prüfen',category:'Sollkonfiguration',readOnly:false,sensitive:true,schema:desiredJobSchema},
 'desired-state-apply':{label:'Sollkonfiguration anwenden',category:'Sollkonfiguration',readOnly:false,sensitive:true,disruptive:true,schema:desiredJobSchema}
};

export function validateDesiredContent(engine:z.infer<typeof desiredEngine>,content:string,configurationName?:string){
 if(!content.trim()||new TextEncoder().encode(content).length>65536||content.includes('\u0000'))throw new HttpError('apiError.desired.contentSize');
 if(engine!=='dsc3'){
  let parsed:unknown;try{parsed=JSON.parse(content);}catch{/* PowerShell and MOF are validated by their respective runtimes. */}
  if(parsed!==null&&typeof parsed==='object')throw new HttpError(engine==='powershell-dsc'?'apiError.desired.jsonForDsc':'apiError.desired.jsonForMof');
 }
 if(engine==='dsc3'){
  let value:unknown;try{value=JSON.parse(content);}catch{throw new HttpError('apiError.desired.dsc3Json');}
  const parsed=z.object({resources:z.array(z.object({name:z.string().min(1).max(200),type:z.string().min(1).max(200),properties:z.record(z.string(),z.unknown()).optional()}).passthrough()).min(1).max(200)}).passthrough().safeParse(value);
  if(!parsed.success)throw new HttpError('apiError.desired.dsc3Resources');
  if(new Set(parsed.data.resources.map(r=>r.name)).size!==parsed.data.resources.length)throw new HttpError('apiError.desired.uniqueResources');
 }else if(engine==='powershell-dsc'){
  if(!configurationName||!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(configurationName))throw new HttpError('apiError.desired.configurationName');
 }else if(!/\binstance\s+of\b/i.test(content))throw new HttpError('apiError.desired.noMof');
}

export const desiredTemplates={
 dsc3:JSON.stringify({$schema:'https://aka.ms/dsc/schemas/v3/bundled/config/document.json',resources:[{name:'Arbeitsordner',type:'PSDesiredStateConfiguration/File',directives:{requireAdapter:'Microsoft.Adapter/WindowsPowerShell'},properties:{DestinationPath:'C:\\Managed\\Demo',Ensure:'Present',Type:'Directory'}}]},null,2),
 'powershell-dsc':"Configuration ServerDeskConfig {\n    Import-DscResource -ModuleName PSDesiredStateConfiguration\n    Node localhost {\n        File ManagedFolder {\n            DestinationPath = 'C:\\Managed\\Demo'\n            Ensure = 'Present'\n            Type = 'Directory'\n        }\n    }\n}\n",
 mof:''
};
