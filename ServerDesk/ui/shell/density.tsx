'use client';
// Density switch: the one place that changes <html data-density> and writes the
// density cookie (lib/density.ts). The Preferences card of My account and the
// command palette use it. It applies at once, with no motion and no toast.
// Texts are message keys (lib/i18n), translated at render time.
import {useSyncExternalStore} from 'react';
import {Rows3,Rows4} from 'lucide-react';
import {densityCookie,parseDensity,type Density} from '@/lib/density';
import {defaultLocale,type Locale} from '@/lib/i18n/locale';
import {translate,type MessageKey} from '@/lib/i18n/translate';
import type {PaletteItem} from '@/ui/shell/command-palette';

export const densityHeading:MessageKey='density.heading';
export const densityPaletteGroup:MessageKey='palette.group.actions';
export const densityPaletteKeywords='density compact comfortable rows dichte kompakt komfortabel zeilen';
export const densityOptions:readonly {density:Density;label:MessageKey;action:MessageKey}[]=[
 {density:'comfortable',label:'density.comfortable',action:'palette.action.densityComfortable'},
 {density:'compact',label:'density.compact',action:'palette.action.densityCompact'},
];

type DensityTarget={document:Pick<Document,'documentElement'|'cookie'>;location:Pick<Location,'protocol'>};
const browser=():DensityTarget=>({document,location});
const listeners=new Set<()=>void>();

/** The density the page shows now, read from <html data-density>. */
export function currentDensity(target:Pick<DensityTarget,'document'>=browser()):Density{
 return parseDensity(target.document.documentElement.dataset.density);
}

/** Shows the density at once and remembers it in the cookie. A blocked cookie only loses persistence. */
export function applyDensity(density:Density,target:DensityTarget=browser()){
 target.document.documentElement.dataset.density=density;
 try{target.document.cookie=densityCookie(density,target.location.protocol==='https:');}catch{/* The density still applies to this page. */}
 for(const listener of listeners)listener();
}

const subscribe=(listener:()=>void)=>{listeners.add(listener);return ()=>{listeners.delete(listener);};};

export function useDensity():[Density,(density:Density)=>void]{
 const density=useSyncExternalStore(subscribe,()=>currentDensity(),()=>'comfortable' as Density);
 return [density,applyDensity];
}

/** One command palette action: the other density than the one shown. */
export function densityPaletteItems(density:Density,setDensity:(density:Density)=>void=applyDensity,locale:Locale=defaultLocale):PaletteItem[]{
 const other=densityOptions.find(option=>option.density!==density)!;
 return [{id:'action-density-'+other.density,group:translate(locale,densityPaletteGroup),label:translate(locale,other.action),keywords:densityPaletteKeywords,Icon:other.density==='compact'?Rows4:Rows3,run:()=>setDensity(other.density)}];
}
