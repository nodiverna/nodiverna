// The job drawer's on-demand read (GET /api/console?job=&serverId=): the kept
// input of one job (jobs.display_input, lib/job-input.ts) and its stored output
// (job_outputs.data), under exactly the visibility of the console job list
// (scopeJobs in lib/server/devices/device-projection.ts). Missing and not allowed give the
// same 404, so the answer never says that a job exists.
import {HttpError,guid} from '../context';
import {allowedDeviceIds,effectivePermissions} from '../identity/access';
import {can} from '../identity/policy/can';
import {consoleJobRow} from '../console-data';
import {scopeJobs} from './device-projection';
import {isSecretKey,keepsInput,parseJobInput,type JobInputValue} from '../../job-input';
import {assistantPowerShellKind} from '../../assistant-config';
import {AD_SIGN_IN} from '../../plugin-ad';
import {assistantScriptRetentionDays} from '../../../runtime/maintenance.mjs';
import type {Viewer} from '../../types';

export type JobDetailOutput={text?:string;stderr?:string;exitCode?:number;data?:string;truncated:boolean};
export type JobDetail={
 input:{script?:string;fields:{key:string;value:JobInputValue}[]};
 /** False for a kind that keeps input when the job kept none: a job from before migration 0032. */
 inputKept:boolean;
 /**
  * The days the portal keeps the script of an assistant job, when the maintenance has already removed this job's script
  * (runtime/maintenance.mjs assistantScriptRetentionDays): the kept input still has its other fields (timeoutSeconds), so
  * inputKept stays true. Null for every other job.
  */
 scriptRemovedAfterDays:number|null;
 output:JobDetailOutput|null;
 /** The list would redact this job's output (scopeJobs outputRedacted): output is null. */
 outputRedacted:boolean;
};

/** The output text limit: 64 KiB of UTF-8. */
export const outputByteLimit=64*1024;
/** The text cut to at most `limit` bytes of UTF-8 without splitting a character; truncated when it was cut. */
export function cutUtf8(value:string,limit=outputByteLimit):{text:string;truncated:boolean}{
 const bytes=Buffer.from(value,'utf8');
 if(bytes.length<=limit)return {text:value,truncated:false};
 // TextDecoder drops the incomplete character at the cut ("fatal" off replaces it, so trim the replacement).
 const text=new TextDecoder('utf-8').decode(bytes.subarray(0,limit)).replace(/�$/,'');
 return {text,truncated:true};
}
/** The value without the key scope at the top and without every key that names a secret, at any depth. */
export function scrubOutput(value:unknown,top=true):unknown{
 if(Array.isArray(value))return value.map(item=>scrubOutput(item,false));
 if(value&&typeof value==='object'){
  const clean:Record<string,unknown>={};
  for(const [key,item] of Object.entries(value as Record<string,unknown>)){
   if(top&&key==='scope'||isSecretKey(key))continue;
   clean[key]=scrubOutput(item,false);
  }
  return clean;
 }
 return value;
}
/** The drawer's output of a stored job output: a script gives text, stderr and exit code; anything else compact JSON. Null without output and for ad-sign-in. */
export function jobDetailOutput(kind:string,stored:unknown):JobDetailOutput|null{
 if(kind===AD_SIGN_IN||stored==null||stored==='')return null;
 let parsed:unknown;
 try{parsed=JSON.parse(String(stored));}catch{const cut=cutUtf8(String(stored));return {data:cut.text,truncated:cut.truncated};}
 const clean=scrubOutput(parsed);
 if(kind===assistantPowerShellKind&&clean&&typeof clean==='object'&&!Array.isArray(clean)){
  const script=clean as Record<string,unknown>,output:JobDetailOutput={truncated:script.truncated===true};
  if(typeof script.output==='string'&&script.output){const cut=cutUtf8(script.output);output.text=cut.text;output.truncated||=cut.truncated;}
  if(typeof script.stderr==='string'&&script.stderr){const cut=cutUtf8(script.stderr);output.stderr=cut.text;output.truncated||=cut.truncated;}
  if(typeof script.exitCode==='number'&&Number.isFinite(script.exitCode))output.exitCode=script.exitCode;
  return output;
 }
 if(clean==null)return null;
 const cut=cutUtf8(JSON.stringify(clean));
 return {data:cut.text,truncated:cut.truncated};
}
/** The drawer's input of a kept display input: the script apart, every other field in allowlist order. */
export function jobDetailInput(kind:string,displayInput:unknown):JobDetail['input']{
 const kept=parseJobInput(displayInput),fields:{key:string;value:JobInputValue}[]=[];
 let script:string|undefined;
 for(const [key,value] of Object.entries(kept)){
  if(kind===assistantPowerShellKind&&key==='script'&&typeof value==='string'){script=value;continue;}
  fields.push({key,value});
 }
 return {...(script!==undefined?{script}:{}),fields};
}

/**
 * GET /api/console?job=<jobId>&serverId=<serverId>: the input and output of one job of the console job list.
 * 404 apiError.job.notFound unless the device is visible to the viewer, the kind is one the list shows, and the
 * viewer passes the list's own check (scopeJobs: the owner shortcut, jobViewRequirements with the kept input and
 * the stored parameters, the target and the output scope).
 */
export async function consoleJobDetail(viewer:Viewer,serverId:unknown,jobId:unknown):Promise<JobDetail>{
 const notFound=()=>new HttpError('apiError.job.notFound');
 if(!guid(serverId)||!guid(jobId))throw notFound();
 const visible=await allowedDeviceIds(viewer);
 if(!visible.includes(serverId))throw notFound();
 const row=await consoleJobRow(serverId,jobId);
 if(!row)throw notFound();
 const [owner,permissionMap]=await Promise.all([can(viewer,'instance.owner'),effectivePermissions(viewer,[serverId])]);
 const {outputData,...listRow}=row;
 const [shown]=scopeJobs([listRow],owner,permissionMap) as {outputRedacted?:boolean}[];
 if(!shown)throw notFound();
 const kind=String(row.action),displayInput=String(row.displayInput??'{}');
 const input=jobDetailInput(kind,displayInput);
 let stored:Record<string,unknown>={};try{const parsed:unknown=JSON.parse(String(row.accessParameters||'{}'));if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))stored=parsed as Record<string,unknown>;}catch{}
 const inputKept=!(Object.keys(parseJobInput(displayInput)).length===0&&keepsInput(kind,stored));
 const scriptRemovedAfterDays=kind===assistantPowerShellKind&&inputKept&&input.script===undefined?assistantScriptRetentionDays:null;
 if(shown.outputRedacted)return {input,inputKept,scriptRemovedAfterDays,output:null,outputRedacted:true};
 return {input,inputKept,scriptRemovedAfterDays,output:jobDetailOutput(kind,outputData),outputRedacted:false};
}
