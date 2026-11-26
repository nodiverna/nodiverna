// Display texts that the server sends in successful answers or stores in text
// columns. Plain module without server imports: lib modules, API routes,
// client components and tests use it.
//
// - A display text in an answer is a ServerMessage {key, params?, text}: the
//   client shows the catalog text of key in its language and falls back to
//   text (the defaultLocale text) when it does not know the key.
// - A fixed status text in a column (jobs.result, transfers.message,
//   terminal_sessions.error, rdp_sessions.error, runbook results, automation
//   states) holds the serverMessage.* key itself, or the apiError.* key of an
//   HttpError reason. storedMessageText() turns a known key into text and
//   leaves every other value as it is: old German rows and agent text. No
//   server logic compares these columns with text.
import {catalogs,translate,type MessageKey,type MessageParams} from './i18n/translate';
import {defaultLocale} from './i18n/locale';

export type ServerMessageKey=Extract<MessageKey,`serverMessage.${string}`>;
export type ServerMessage={key:ServerMessageKey;params?:MessageParams;text:string};
/** The translate function of a component (useT) or a test. */
export type MessageTranslate=(key:MessageKey,params?:MessageParams)=>string;

const placeholders=(message:unknown)=>(typeof message==='string'?[message]:message&&typeof message==='object'?Object.values(message).filter((form):form is string=>typeof form==='string'):[]).flatMap(text=>[...text.matchAll(/\{(\w+)\}/g)].map(match=>match[1]));
/** A key of the English catalog with the prefix, and a param for every placeholder. */
const known=(key:unknown,prefixes:readonly string[],params:MessageParams={}):key is MessageKey=>typeof key==='string'&&prefixes.some(prefix=>key.startsWith(prefix))&&Object.hasOwn(catalogs.en,key)&&placeholders(catalogs.en[key]).every(name=>Object.hasOwn(params,name));

/** A display text for a successful answer. */
export function serverMessage(key:ServerMessageKey,params?:MessageParams):ServerMessage{
 return {key,...(params?{params}:{}),text:translate(defaultLocale,key,params)};
}

/** The text of a ServerMessage from an answer: the catalog text of its key, else the text it carries. */
export function serverMessageText(message:unknown,t:MessageTranslate):string{
 if(typeof message==='string')return storedMessageText(message,t)??message;
 if(!message||typeof message!=='object')return '';
 const {key,params,text}=message as {key?:unknown;params?:unknown;text?:unknown};
 const values=params&&typeof params==='object'&&!Array.isArray(params)?Object.fromEntries(Object.entries(params).filter(([,value])=>typeof value==='string'||typeof value==='number')):{};
 if(known(key,['serverMessage.'],values))return t(key,values);
 return typeof text==='string'?text:'';
}

/**
 * The text of a stored status value: the catalog text when the value is exactly
 * a known serverMessage.* or apiError.* key without placeholders, else the value
 * unchanged.
 */
export function storedMessageText<T extends string|null|undefined>(value:T,t:MessageTranslate):T|string{
 return known(value,['serverMessage.','apiError.'])?t(value):value;
}

/** A single display text of an answer as the fields message, messageKey and messageParams. */
export function messageFields(key:ServerMessageKey,params?:MessageParams):{message:string;messageKey:ServerMessageKey;messageParams?:MessageParams}{
 return {message:translate(defaultLocale,key,params),messageKey:key,...(params?{messageParams:params}:{})};
}

/** The stored form of an HttpError reason: its message key when it has no params, else its defaultLocale text. */
export function storedReason(error:{messageKey?:string;params?:MessageParams;message:string}):string{
 return error.messageKey&&!error.params?error.messageKey:error.message;
}

/** The text of the message fields of an answer (messageFields) in the reader's language, else `fallback`. */
export function messageFieldsText(result:{message?:unknown;messageKey?:unknown;messageParams?:unknown}|null|undefined,t:MessageTranslate,fallback:string):string{
 if(!result)return fallback;
 const text=serverMessageText({key:result.messageKey,params:result.messageParams,text:result.message},t);
 return text||fallback;
}
