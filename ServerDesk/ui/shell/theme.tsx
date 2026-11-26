'use client';
// Appearance switch: the one place that changes <html data-theme> and
// writes the theme cookie. The account menu (Topbar), the Preferences card of My
// account and the command palette use it. The color scheme switch (./color-scheme) and the language group (./locale)
// sit next to it.
// Texts are message keys (lib/i18n), translated at render time.
import {useSyncExternalStore,type ComponentType} from 'react';
import {Monitor,Moon,Sun} from 'lucide-react';
import {parseTheme,themeCookie,type Theme} from '@/lib/theme';
import {defaultLocale,type Locale} from '@/lib/i18n/locale';
import {translate,type MessageKey} from '@/lib/i18n/translate';
import type {PaletteItem} from '@/ui/shell/command-palette';
import type {Translate} from '@/ui/base/locale';
import type {MenuRadioEntry} from '@/ui/kit/kit';

export const themeHeading:MessageKey='theme.heading';
export const themePaletteGroup:MessageKey='palette.group.actions';
export const themePaletteKeywords='theme darkmode dark light hell dunkel modus augenschonend';
export const themeOptions:readonly {theme:Theme;label:MessageKey;action:MessageKey;Icon:ComponentType<{size?:number}>}[]=[
 {theme:'light',label:'theme.light',action:'theme.paletteLight',Icon:Sun},
 {theme:'dark',label:'theme.dark',action:'theme.paletteDark',Icon:Moon},
 {theme:'system',label:'theme.system',action:'theme.paletteSystem',Icon:Monitor},
];

type ThemeTarget={document:Pick<Document,'documentElement'|'cookie'>;location:Pick<Location,'protocol'>};
const browser=():ThemeTarget=>({document,location});
const listeners=new Set<()=>void>();

/** The theme the page shows now, read from <html data-theme>. */
export function currentTheme(target:Pick<ThemeTarget,'document'>=browser()):Theme{
 return parseTheme(target.document.documentElement.dataset.theme);
}

/** Shows the theme at once and remembers it in the cookie. A blocked cookie only loses persistence. */
export function applyTheme(theme:Theme,target:ThemeTarget=browser()){
 target.document.documentElement.dataset.theme=theme;
 try{target.document.cookie=themeCookie(theme,target.location.protocol==='https:');}catch{/* The theme still applies to this page. */}
 for(const listener of listeners)listener();
}

const subscribe=(listener:()=>void)=>{listeners.add(listener);return ()=>{listeners.delete(listener);};};

export function useTheme():[Theme,(theme:Theme)=>void]{
 const theme=useSyncExternalStore(subscribe,()=>currentTheme(),()=>'system' as Theme);
 return [theme,applyTheme];
}

/** The radio group "Appearance" of the account menu (a kit MenuRadioEntry): choosing an item applies it at once. */
export function themeMenuEntry(theme:Theme,setTheme:(theme:Theme)=>void,t:Translate):MenuRadioEntry{
 return {id:'theme',label:t(themeHeading),value:theme,onValueChange:value=>setTheme(parseTheme(value)),items:themeOptions.map(({theme:value,label,Icon})=>({id:value,value,label:t(label),icon:Icon}))};
}

/** Command palette actions with the same effect as the menu group. */
export function themePaletteItems(setTheme:(theme:Theme)=>void=applyTheme,locale:Locale=defaultLocale):PaletteItem[]{
 return themeOptions.map(({theme,action,Icon})=>({id:'action-theme-'+theme,group:translate(locale,themePaletteGroup),label:translate(locale,action),keywords:themePaletteKeywords,Icon,run:()=>setTheme(theme)}));
}
