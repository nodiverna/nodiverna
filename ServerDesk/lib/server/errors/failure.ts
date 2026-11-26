import {defaultLocale} from '../../i18n/locale';
import en from '../../i18n/messages/en';
import de from '../../i18n/messages/de';
import {translate} from '../../i18n/translate';
import {apiErrorCodes,type ApiErrorKey} from '../../errors/api-error-keys';
import {dbConflictKey,dbDriverCodes,dbFailure,dbTriggerCode,dbTriggerCodes} from './db-codes';
import {HttpError,type ApiErrorParams} from '../../errors/http-error';

// How failure() in lib/server/context.ts answers everything that is not an HttpError.
// Kept apart from lib/server/context.ts so it imports nothing server-only.

/** db() without DATABASE_URL. The code marks it as a storage failure. */
export class StorageUnavailableError extends Error{
 readonly code='STORAGE_UNAVAILABLE';
 constructor(message='The data storage cannot be reached at the moment.'){super(message);}
}

/**
 * The body of every error answer: `error` is the defaultLocale text, `messageKey`
 * the catalog key the client translates, `params` its placeholder values. Only a
 * text-form HttpError with an unregistered text (test doubles) has no messageKey.
 */
export type FailureBody={error:string;code:string;messageKey?:ApiErrorKey;params?:ApiErrorParams;reference?:string};
export type FailureAnswer={status:number;body:FailureBody;log:string};

// Connection failures of the driver and the object storage, by code.
const storageCodes=new Set(['STORAGE_UNAVAILABLE','ECONNREFUSED','ECONNRESET','ETIMEDOUT','EPIPE','ENOTFOUND','EAI_AGAIN','ENOSPC','EIO','EROFS','CONNECT_TIMEOUT','CONNECTION_CLOSED','CONNECTION_ENDED','CONNECTION_DESTROYED']);
// SQLSTATE: connection exceptions (08), insufficient resources (53), admin or
// crash shutdown and cannot connect now (57P01-57P03), and serialization
// failure or deadlock (40001, 40P01), which reach failure() only after the
// data layer's retries.
const storageStates=new Set(['57P01','57P02','57P03','40001','40P01']);

const field=(value:unknown,key:string):unknown=>value!==null&&typeof value==='object'?(value as Record<string,unknown>)[key]:undefined;
const isStorageCode=(code:string)=>storageCodes.has(code)||storageStates.has(code)||/^(08|53)[0-9A-Z]{3}$/.test(code);
const printable=(value:unknown)=>{try{return String(value);}catch{return typeof value;}};
const isZodError=(error:unknown)=>error instanceof Error&&error.name==='ZodError'&&Array.isArray(field(error,'issues'));
/** Message and stack for the log line; the body never carries either. */
const messageOf=(error:unknown)=>{const message=field(error,'message');return typeof message==='string'?message:'';};
const description=(error:unknown)=>error instanceof Error?error.stack??`${error.name}: ${error.message}`:`Non-Error value: ${printable(error)}`;

// A plural text (apiError.console.queueFull) contributes the placeholders of both forms.
const placeholders=(key:ApiErrorKey)=>new Set([en[key],de[key]].flatMap(value=>typeof value==='string'?[value]:[value.one,value.other]).flatMap(value=>[...value.matchAll(/\{(\w+)\}/g)].map(match=>match[1])));
/**
 * Params that stay in the body also when the text does not show them: `field`
 * names the form field an error belongs to (for example the URL field of
 * apiError.notify.discordUrlWrongType), so a client can mark that field.
 */
const structuralParams:ReadonlySet<string>=new Set(['field']);
/**
 * The error body for a message key: the code of the key unless `code` overrides
 * it, the defaultLocale text, and params only for the text's placeholders and
 * the structural params (`field`).
 */
export function apiErrorBody(key:ApiErrorKey,params?:ApiErrorParams,code:string=apiErrorCodes[key]):FailureBody{
 const names=placeholders(key),used=params?Object.fromEntries(Object.entries(params).filter(([name,value])=>(names.has(name)||structuralParams.has(name))&&(typeof value==='string'||typeof value==='number'))):{};
 return {error:translate(defaultLocale,key,used),code,messageKey:key,...(Object.keys(used).length?{params:used}:{})};
}

/** The answer for an HttpError: keyed, or a text-form error as it was thrown. */
function httpErrorAnswer(error:HttpError):FailureAnswer{
 const body=error.messageKey?apiErrorBody(error.messageKey,error.params,error.code):{error:error.message,code:error.code};
 return {status:error.status,body,log:error.message};
}

/** 8 random lowercase hex characters. */
export function failureReference():string{return Array.from(crypto.getRandomValues(new Uint8Array(4)),byte=>byte.toString(16).padStart(2,'0')).join('');}

/**
 * Classifies an error: an HttpError as thrown; otherwise, in this order, registered conflict (trigger or
 * constraint), ZodError, storage or connection failure, anything else.
 * A conflict logs its code, trigger literal or constraint key, message and
 * stack; the last class additionally logs a reference and the driver codes.
 * The body never contains the original message or the stack.
 */
export function classifyFailure(error:unknown):FailureAnswer{
 if(error instanceof HttpError)return httpErrorAnswer(error);
 const shortLog=error instanceof Error?error.message:'API failure';
 const conflict=dbFailure(error),key=conflict?dbConflictKey(error):null;
 if(conflict&&key){
  const origin=Object.hasOwn(dbTriggerCodes,key)?`trigger ${key}`:`constraint ${key}`;
  return {status:conflict.status,body:apiErrorBody(conflict.key,undefined,conflict.code),log:`API conflict ${conflict.code} (${origin}): ${messageOf(error)}\n${description(error)}`};
 }
 if(isZodError(error))return {status:400,body:apiErrorBody('apiError.validationFailed'),log:shortLog};
 const codes=dbDriverCodes(error);
 if(error instanceof StorageUnavailableError||codes.some(isStorageCode))return {status:503,body:apiErrorBody('apiError.storageUnavailable'),log:shortLog};
 const reference=failureReference(),trigger=dbTriggerCode(error);
 const detail=[...new Set(codes)].concat(trigger?[`trigger ${trigger}`]:[]);
 return {status:500,body:{...apiErrorBody('apiError.internalError',{reference}),reference},log:`API failure ${reference}${detail.length?` (${detail.join(', ')})`:''}: ${error instanceof Error?error.message:''}\n${description(error)}`};
}
