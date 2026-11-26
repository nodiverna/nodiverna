'use client';
// Language switch: the one place that changes <html lang> and writes
// the language cookie. app/layout.tsx wraps the page in LocaleProvider with the
// language from the cookie; the account menu (Topbar), the Preferences card of My
// account and the command palette switch it. Every translated component reads it through useT(), so a switch
// changes all text at once, without a reload and without losing open state.
import {createContext,useCallback,useContext,useEffect,useMemo,useRef,useState,type ReactNode} from 'react';
import {Languages} from 'lucide-react';
import {defaultLocale,localeCookie,locales,parseLocale,type Locale} from '@/lib/i18n/locale';
import {translate,type MessageKey,type MessageParams} from '@/lib/i18n/translate';
import type {PaletteItem} from '@/ui/shell/command-palette';
import type {MenuRadioEntry} from '@/ui/kit/kit';

export type Translate=(key:MessageKey,params?:MessageParams)=>string;
type LocaleTarget={document:{documentElement:{lang:string};cookie:string};location:Pick<Location,'protocol'>};
const browser=():LocaleTarget=>({document,location});
const listeners=new Set<(locale:Locale)=>void>();

/** Calls listener with every language that applyLocale applies. Returns the unsubscribe function. */
export function subscribeLocale(listener:(locale:Locale)=>void):()=>void{
 listeners.add(listener);
 return ()=>{listeners.delete(listener);};
}

/** Shows the language at once and remembers it in the cookie. A blocked cookie only loses persistence. */
export function applyLocale(locale:Locale,target:LocaleTarget=browser()){
 target.document.documentElement.lang=locale;
 try{target.document.cookie=localeCookie(locale,target.location.protocol==='https:');}catch{/* The language still applies to this page. */}
 for(const listener of listeners)listener(locale);
}

const LocaleContext=createContext<{locale:Locale;setLocale:(locale:Locale)=>void}>({locale:defaultLocale,setLocale:locale=>applyLocale(locale)});

/** Holds the current language for the page. Without it, the hooks use defaultLocale. */
export function LocaleProvider({locale:initial,children}:{locale:Locale;children:ReactNode}){
 const [locale,setLocale]=useState<Locale>(()=>parseLocale(initial));
 useEffect(()=>subscribeLocale(setLocale),[]);
 const value=useMemo(()=>({locale,setLocale:(next:Locale)=>applyLocale(next)}),[locale]);
 return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale():[Locale,(locale:Locale)=>void]{
 const {locale,setLocale}=useContext(LocaleContext);
 return [locale,setLocale];
}

/** Translation function for the current language. */
export function useT():Translate{
 const [locale]=useLocale();
 return useCallback<Translate>((key,params)=>translate(locale,key,params),[locale]);
}

/**
 * Translation function with a stable identity that always uses the current
 * language. For callbacks and effects that must not run again when the language
 * changes, such as a load callback that an effect depends on.
 */
export function useStableT():Translate{
 const [locale]=useLocale();
 const current=useRef(locale);
 useEffect(()=>{current.current=locale;},[locale]);
 return useCallback<Translate>((key,params)=>translate(current.current,key,params),[]);
}

/** The radio group "Language" of the account menu (a kit MenuRadioEntry). Each item names its language in that language. */
export function languageMenuEntry(locale:Locale,setLocale:(locale:Locale)=>void,t:Translate):MenuRadioEntry{
 return {id:'language',label:t('language.heading'),value:locale,onValueChange:value=>setLocale(parseLocale(value)),items:locales.map(value=>({id:value,value,label:translate(value,'language.name'),lang:value}))};
}

export const languagePaletteKeywords='language sprache english englisch deutsch german locale';
const paletteLabels:Record<Locale,MessageKey>={en:'language.paletteEnglish',de:'language.paletteGerman'};

/** Command palette actions with the same effect as the menu group, labelled in the current language. */
export function languagePaletteItems(locale:Locale=defaultLocale,setLocale:(locale:Locale)=>void=applyLocale):PaletteItem[]{
 return locales.map(value=>({id:'action-language-'+value,group:translate(locale,'palette.group.actions'),label:translate(locale,paletteLabels[value]),keywords:languagePaletteKeywords,Icon:Languages,run:()=>setLocale(value)}));
}
