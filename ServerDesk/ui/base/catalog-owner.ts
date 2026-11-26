import {defaultCustomerId} from '@/lib/default-customer';
import type {CatalogOwnership} from '@/lib/server/catalog-ownership';
import {defaultLocale,type Locale} from '@/lib/i18n/locale';
import {translate,type MessageKey} from '@/lib/i18n/translate';

// Owner of runbooks, automation templates and roles (docs/customers.md):
// the MSP library or one customer. The APIs send `catalog` with every list; while
// only the default customer exists (separated=false) no surface shows an owner field or label
// and requests carry no customerId. In select fields '' stands for the library.
// The type comes from the server module as a type only; no server code reaches the client.
export type {CatalogOwnership};
export type CatalogEntryOwner={customerId?:string|null;customerName?:string|null};
// Texts are message keys; the components translate them, the functions take a locale.
export const catalogOwnerFieldLabel:MessageKey='catalog.owner';
export const libraryOwnerLabel:MessageKey='catalog.library';
export const libraryOwnerChoiceLabel:MessageKey='catalog.libraryChoice';
export const catalogOwnerHints={
 runbook:'catalog.hint.runbook',
 template:'catalog.hint.template',
 drift:'catalog.hint.drift',
 role:'catalog.hint.role',
} as const satisfies Record<string,MessageKey>;
export const catalogCreateLockText:MessageKey='catalog.createLock';

/** Owner field and labels appear only once catalogs are separated. */
export function showCatalogOwner(catalog:CatalogOwnership|null|undefined):boolean{return !!catalog?.separated;}
/** The MSP library or the customer's name. */
export function catalogOwnerLabel(entry:CatalogEntryOwner,locale:Locale=defaultLocale):string{return entry.customerId?entry.customerName||entry.customerId:translate(locale,libraryOwnerLabel);}
/** The owner line of an existing entry, whose owner never changes. */
export function catalogOwnerText(entry:CatalogEntryOwner,locale:Locale=defaultLocale):string{return translate(locale,'catalog.ownerText',{owner:catalogOwnerLabel(entry,locale)});}
/** Choices for a new entry: the library only when writable, then the customers in API order. */
export function catalogOwnerChoices(catalog:CatalogOwnership|null|undefined,locale:Locale=defaultLocale):{value:string;label:string}[]{
 if(!catalog)return [];
 return [...(catalog.libraryWritable?[{value:'',label:translate(locale,libraryOwnerChoiceLabel)}]:[]),...catalog.customers.map(customer=>({value:customer.id,label:customer.name}))];
}
/** Library for Owners (libraryWritable), else the default customer when listed, else the first customer. */
export function defaultCatalogOwner(catalog:CatalogOwnership|null|undefined):string{
 if(!catalog||catalog.libraryWritable)return '';
 return (catalog.customers.find(customer=>customer.id===defaultCustomerId)??catalog.customers[0])?.id??'';
}
/** A library entry fits everywhere, a customer entry only the same customer. */
export function fitsCatalogOwner(entryCustomerId:string|null|undefined,targetCustomerId:string|null|undefined):boolean{return !entryCustomerId||entryCustomerId===targetCustomerId;}
/** Why "create" is locked: separated, the library is not writable and no customer is assigned. */
export function catalogCreateLockReason(catalog:CatalogOwnership|null|undefined,locale:Locale=defaultLocale):string{return catalog?.separated&&!catalog.libraryWritable&&!catalog.customers.length?translate(locale,catalogCreateLockText):'';}
/** The request field for a new entry: nothing before the separation, null for the library. */
export function catalogOwnerRequest(catalog:CatalogOwnership|null|undefined,selected:string):{customerId?:string|null}{return showCatalogOwner(catalog)?{customerId:selected||null}:{};}
