// The text of an API error answer in the reader's language. Plain module, no
// React and no server imports: ui/base/http.ts, other client readers and tests
// use it. The server sends {error, code, messageKey, params?}; the client shows
// the catalog text of the key, so a German page shows German and an English
// page English, whatever the server's default language is.
import {catalogs,translate,type MessageKey,type MessageParams} from '@/lib/i18n/translate';
import type {Locale} from '@/lib/i18n/locale';
import {errorCatalog} from '@/lib/errors/codes';

const field=(value:unknown,key:string):unknown=>value!==null&&typeof value==='object'?(value as Record<string,unknown>)[key]:undefined;
const placeholders=(message:unknown)=>(typeof message==='string'?[message]:message&&typeof message==='object'?Object.values(message).filter((form):form is string=>typeof form==='string'):[]).flatMap(text=>[...text.matchAll(/\{(\w+)\}/g)].map(match=>match[1]));

/** Only string and number values of a plain object; anything else counts as no params. */
function paramsOf(value:unknown):MessageParams{
 if(!value||typeof value!=='object'||Array.isArray(value))return {};
 return Object.fromEntries(Object.entries(value).filter(([,item])=>typeof item==='string'||typeof item==='number'));
}

/** The catalog text of an apiError.* key when the catalog has it and every placeholder has a param, else null. */
function keyText(locale:Locale,key:unknown,params:MessageParams):string|null{
 if(typeof key!=='string'||!key.startsWith('apiError.'))return null;
 const catalog=catalogs[locale]??catalogs.en;
 if(!Object.hasOwn(catalog,key))return null;
 if(placeholders(catalog[key]).some(name=>!Object.hasOwn(params,name)))return null;
 return translate(locale,key as MessageKey,params);
}

/**
 * The text to show for an error body, in this order: the text of `messageKey`;
 * for a keyed answer whose key this client cannot resolve, the text of the code's
 * default key; `error` as the server sent it; `fallback`; common.requestFailed.
 * An answer without `messageKey` (the text form of HttpError, which only test doubles use)
 * shows its `error` as sent, because the code's default sentence would hide the
 * specific reason. A key needs the apiError. prefix, an entry in the catalog and a
 * param for every placeholder. Params go in as plain text. An unknown key or code
 * from a newer server never shows as a raw key.
 */
export function apiErrorText(locale:Locale,body:unknown,fallback?:string):string{
 const params=paramsOf(field(body,'params')),code=field(body,'code'),messageKey=field(body,'messageKey'),error=field(body,'error');
 const byKey=keyText(locale,messageKey,params);
 if(byKey!==null)return byKey;
 const sent=typeof error==='string'&&error.trim()?error:null;
 const keyed=typeof messageKey==='string'&&messageKey!=='';
 if(!keyed&&sent!==null)return sent;
 const byCode=typeof code==='string'&&Object.hasOwn(errorCatalog,code)?keyText(locale,errorCatalog[code as keyof typeof errorCatalog].key,params):null;
 if(byCode!==null)return byCode;
 if(sent!==null)return sent;
 return fallback??translate(locale,'common.requestFailed',{status:typeof field(body,'status')==='number'?field(body,'status') as number:'?'});
}
