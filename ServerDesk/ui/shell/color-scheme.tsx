'use client';
// Color scheme switch: the one place that changes <html data-scheme-light
// data-scheme-dark> and writes the scheme cookie. The Preferences card of My account
// and the command palette use it. The list of schemes is lib/color-schemes.ts; the
// colors are only in app/globals.css. The Preferences card shows a preview swatch
// that the scheme blocks there color through [data-scheme-swatch], so no color value
// appears here.
// The brand colors (lib/color-schemes.ts "brand") are the default of an account without its own choice. While the
// portal has no brand scheme they look exactly like Aurora, so the lists leave "brand" out and show it as Aurora
// (shownSchemeChoice); with one, "Brand colors (default)" leads the list and Aurora drops its "(default)".
import {useSyncExternalStore} from 'react';
import {Palette} from 'lucide-react';
import {chooseScheme,defaultScheme,formatSchemeChoice,parseSchemeChoice,schemeCookie,schemesFor,type ColorScheme,type SchemeChoice,type SchemeId,type SchemeMode} from '@/lib/color-schemes';
import type {Theme} from '@/lib/theme';
import {defaultLocale,type Locale} from '@/lib/i18n/locale';
import {translate,type MessageKey} from '@/lib/i18n/translate';
import type {PaletteItem} from '@/ui/shell/command-palette';
import {currentTheme,useTheme} from '@/ui/shell/theme';

export const schemeHeading:MessageKey='scheme.heading';
export const schemeModeHeadings:Record<SchemeMode,MessageKey>={light:'scheme.forLight',dark:'scheme.forDark'};
export const schemePaletteKeywords='farbschema farbe schema color scheme akzent';
const darkQuery='(prefers-color-scheme: dark)';

type SchemeDataset={schemeLight?:string;schemeDark?:string};
type SchemeTarget={document:{documentElement:{dataset:SchemeDataset};cookie:string};location:Pick<Location,'protocol'>};
type MediaSource={matchMedia?:(query:string)=>Pick<MediaQueryList,'matches'>};
const browser=():SchemeTarget=>({document,location});
const listeners=new Set<()=>void>();

/** The choice the page shows now, read from <html data-scheme-light data-scheme-dark>. */
export function currentSchemeChoice(target:{document:{documentElement:{dataset:SchemeDataset}}}=browser()):SchemeChoice{
 const {schemeLight,schemeDark}=target.document.documentElement.dataset;
 return parseSchemeChoice(`${schemeLight}.${schemeDark}`);
}

/** Shows the choice at once and remembers it in the cookie. A blocked cookie only loses persistence. */
export function applySchemeChoice(choice:SchemeChoice,target:SchemeTarget=browser()){
 const {dataset}=target.document.documentElement;
 dataset.schemeLight=choice.light;
 dataset.schemeDark=choice.dark;
 try{target.document.cookie=schemeCookie(choice,target.location.protocol==='https:');}catch{/* The scheme still applies to this page. */}
 for(const listener of listeners)listener();
}

/** Picks a scheme for a mode (and for the other mode if it is offered there), see chooseScheme. */
export function selectScheme(id:SchemeId,mode:SchemeMode,target:SchemeTarget=browser()){
 applySchemeChoice(chooseScheme(currentSchemeChoice(target),id,mode),target);
}

/** The mode the page shows: the theme, or for "system" the OS setting. */
export function effectiveMode(theme:Theme,media:MediaSource=globalThis):SchemeMode{
 if(theme!=='system')return theme;
 return media.matchMedia?.(darkQuery).matches?'dark':'light';
}

const subscribe=(listener:()=>void)=>{listeners.add(listener);return ()=>{listeners.delete(listener);};};
/** Calls listener when the OS switches between light and dark. Returns the unsubscribe function. */
export const subscribeSystemMode=(listener:()=>void)=>{
 const query=globalThis.matchMedia?.(darkQuery);
 query?.addEventListener('change',listener);
 return ()=>query?.removeEventListener('change',listener);
};

export function useSchemeChoice():SchemeChoice{
 const value=useSyncExternalStore(subscribe,()=>formatSchemeChoice(currentSchemeChoice()),()=>formatSchemeChoice({light:defaultScheme,dark:defaultScheme}));
 return parseSchemeChoice(value);
}

/** The effective mode, following the theme switch and, for "system", a change of the OS mode. */
export function useEffectiveMode():SchemeMode{
 const [theme]=useTheme();
 const systemDark=useSyncExternalStore(subscribeSystemMode,()=>effectiveMode('system')==='dark',()=>false);
 return theme==='system'?(systemDark?'dark':'light'):theme;
}

/** The choice a scheme list shows: without a brand scheme, "brand" (the default) shows as Aurora, which it equals. */
export function shownSchemeChoice(choice:SchemeChoice,brand:boolean):SchemeChoice{
 if(brand)return choice;
 const shown=(id:SchemeId):SchemeId=>id==='brand'?'aurora':id;
 return {light:shown(choice.light),dark:shown(choice.dark)};
}
/** The label of a scheme in a list: "Brand colors (default)" with a brand scheme, then Aurora without "(default)". */
export function schemeLabel(scheme:Pick<ColorScheme,'id'|'name'>,brand:boolean):MessageKey{
 if(scheme.id==='brand')return 'scheme.brandDefault';
 if(scheme.id==='aurora'&&brand)return 'scheme.auroraPlain';
 return scheme.name;
}

/** The entries of the scheme list for a mode, in list order, with the active one marked; `brand` while the portal has a brand scheme. */
export function schemeOptions(mode:SchemeMode,choice:SchemeChoice,brand=false){
 const shown=shownSchemeChoice(choice,brand)[mode];
 return schemesFor(mode,{brand}).map(scheme=>({id:scheme.id,name:schemeLabel(scheme,brand),checked:shown===scheme.id}));
}

/** Command palette actions for the schemes of the current mode, with the same effect as the menu; `brand` while the portal has a brand scheme. */
export function schemePaletteItems(mode:SchemeMode=effectiveMode(currentTheme()),locale:Locale=defaultLocale,select:(id:SchemeId,mode:SchemeMode)=>void=selectScheme,brand=false):PaletteItem[]{
 return schemesFor(mode,{brand}).map(scheme=>({id:'action-scheme-'+scheme.id,group:translate(locale,'palette.group.actions'),label:translate(locale,'scheme.palette',{name:translate(locale,schemeLabel(scheme,brand))}),keywords:schemePaletteKeywords,Icon:Palette,run:()=>select(scheme.id,mode)}));
}
