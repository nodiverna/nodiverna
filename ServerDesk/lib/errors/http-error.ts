// The error that API code throws to answer with a 4xx or 5xx status. A plain
// module without server imports, so lib/server/errors/failure.ts, shared lib modules
// and tests use it; lib/server/context.ts re-exports it.
import {defaultLocale} from '../i18n/locale';
import {translate,type MessageParams} from '../i18n/translate';
import {apiErrorCodes,type ApiErrorKey} from './api-error-keys';
import {errorCatalog,genericCodeFor} from './codes';

/** Dynamic parts of an error text: names, ids, counts, limits, field paths and technical details. Never a sentence. */
export type ApiErrorParams=MessageParams;

let textKeys:Map<string,ApiErrorKey[]>|null=null;
/** The registered keys whose defaultLocale text is exactly `text` (texts without placeholders only). */
function keysForText(text:string):ApiErrorKey[]{
 if(!textKeys){
  textKeys=new Map();
  for(const key of Object.keys(apiErrorCodes) as ApiErrorKey[]){
   const value=translate(defaultLocale,key);
   if(/\{\w+\}/.test(value))continue;
   textKeys.set(value,[...textKeys.get(value)??[],key]);
  }
 }
 return textKeys.get(text)??[];
}

/**
 * The key and code of a text-form message. The key is the one whose code has `status`,
 * else the first key with that text. The code is that key's code only when its catalog
 * status equals `status`; otherwise it is the generic code of the status, so the code
 * never claims a different status than the answer has. The key still goes along, so the
 * client shows the text in its language.
 */
export function apiErrorKeyForText(text:string,status:number):{key:ApiErrorKey,code:string}|null{
 const keys=keysForText(text),matching=keys.find(key=>errorCatalog[apiErrorCodes[key]].status===status);
 if(matching)return {key:matching,code:apiErrorCodes[matching]};
 return keys[0]?{key:keys[0],code:genericCodeFor(status)}:null;
}

/**
 * new HttpError(key, params?) answers with the code of the key (lib/errors/api-error-keys.ts),
 * the status of that code (errorCatalog) and the message key with its params. `message`
 * is the defaultLocale text, for logs.
 *
 * The text form new HttpError(status, message, code?) exists only for test doubles
 * under tests/: a message that is exactly the defaultLocale text of a
 * registered key (the exported constants) carries that key, and, when the caller gave
 * no code, the key's code if its status matches, else the generic code of the status.
 * Any other text is sent as it is, with the given code or the
 * generic code of the status. Code under app/, ui/ and lib/ never uses it
 * (tests/repo/error-codes.mjs scans for it).
 */
export class HttpError extends Error{
 readonly status:number;
 readonly code:string;
 readonly messageKey?:ApiErrorKey;
 readonly params?:ApiErrorParams;
 constructor(key:ApiErrorKey,params?:ApiErrorParams);
 constructor(status:number,message:string,code?:string);
 constructor(first:ApiErrorKey|number,second?:ApiErrorParams|string,third?:string){
  if(typeof first==='number'){
   const message=typeof second==='string'?second:'',match=apiErrorKeyForText(message,first);
   super(message);
   this.status=first;
   this.code=third??match?.code??genericCodeFor(first);
   if(match)this.messageKey=match.key;
  }else{
   const params=typeof second==='object'&&second!==null?second:undefined;
   super(translate(defaultLocale,first,params));
   this.messageKey=first;
   this.code=apiErrorCodes[first];
   this.status=errorCatalog[apiErrorCodes[first]].status;
   if(params)this.params=params;
  }
 }
}
