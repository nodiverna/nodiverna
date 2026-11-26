// Looks up a console text in the catalog of a locale. Plain module,
// no React: server code, tests and the client hooks in ui/base/locale.tsx
// all use it.
import en,{type Message,type MessageKey} from './messages/en';
import de from './messages/de';
import {defaultLocale,type Locale} from './locale';

export type {MessageKey} from './messages/en';
export type MessageParams=Readonly<Record<string,string|number>>;

/** The catalogs by locale, for resolvers that check a key before they translate it. */
export const catalogs:Record<Locale,Readonly<Record<string,Message>>>={en,de};
const pluralRules=new Map<Locale,Intl.PluralRules>();
const pluralOf=(locale:Locale)=>{let rules=pluralRules.get(locale);if(!rules){rules=new Intl.PluralRules(locale);pluralRules.set(locale,rules);}return rules;};

/**
 * The text for key in locale. {name} placeholders take params.name, a plural
 * entry picks its form from params.count. An unknown key returns the key itself,
 * so a stale key shows up on screen instead of throwing.
 */
export function translate(locale:Locale,key:MessageKey,params?:MessageParams):string{
 const known:Locale=Object.hasOwn(catalogs,locale)?locale:defaultLocale,catalog=catalogs[known];
 const message=Object.hasOwn(catalog,key)?catalog[key]:undefined;
 if(message===undefined)return String(key);
 const text=typeof message==='string'?message:pluralOf(known).select(Number(params?.count??0))==='one'?message.one:message.other;
 return params?text.replace(/\{(\w+)\}/g,(match,name:string)=>Object.hasOwn(params,name)?String(params[name]):match):text;
}
