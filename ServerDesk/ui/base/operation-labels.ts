// Operation labels for the client. lib/management.ts and lib/diagnostics.ts keep
// their German labels for the server (validation, audit); the console shows the
// catalog text instead. Each operation id and diagnostics kind has one key,
// operation.<id in camelCase>, whose German text equals the lib label.
import en from '@/lib/i18n/messages/en';
import {defaultLocale,type Locale} from '@/lib/i18n/locale';
import {translate,type MessageKey} from '@/lib/i18n/translate';

const camelCase=(id:string)=>id.replace(/-([a-z0-9])/g,(_,letter:string)=>letter.toUpperCase());

/** The message key of an operation id, or undefined for an id without one. */
export function operationKey(id:string):MessageKey|undefined{
 const key='operation.'+camelCase(id);
 return Object.hasOwn(en,key)?key as MessageKey:undefined;
}

/** The label of an operation id in locale; an unknown id gives fallback, or the id itself. */
export function operationText(id:string,locale:Locale=defaultLocale,fallback?:string):string{
 const key=operationKey(id);
 return key?translate(locale,key):fallback??id;
}
