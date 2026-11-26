'use client';
// The start page of the console: a per-browser preference (localStorage
// serverdesk.redesign.startPage) with "Dashboard" (default), "All devices" and "Alarms"
// (the Alarms tab of All devices, view by device). An older stored "problems" reads as "alarms".
// The Preferences card of My account and the command palette change it; the console reads it
// once, on the first route read without a hash (startHash in console-route.ts).
import {useSyncExternalStore} from 'react';
import {LayoutDashboard,MonitorSmartphone,Siren} from 'lucide-react';
import {startPageKey,startPages,type StartPage} from '@/lib/console-route';
import {defaultLocale,type Locale} from '@/lib/i18n/locale';
import {translate,type MessageKey} from '@/lib/i18n/translate';
import type {PaletteItem} from '@/ui/shell/command-palette';

export const startPageOptions:readonly {page:StartPage;label:MessageKey;action:MessageKey;Icon:typeof Siren}[]=[
 {page:'dashboard',label:'startPage.dashboard',action:'palette.action.startDashboard',Icon:LayoutDashboard},
 {page:'devices',label:'startPage.devices',action:'palette.action.startDevices',Icon:MonitorSmartphone},
 {page:'alarms',label:'startPage.alarms',action:'palette.action.startAlarms',Icon:Siren},
];
export const startPagePaletteKeywords='start page startseite home dashboard alarms alarme problems probleme';
/** The start page of a browser without a stored choice. */
export const defaultStartPage:StartPage='dashboard';
export const isStartPage=(value:unknown):value is StartPage=>typeof value==='string'&&(startPages as readonly string[]).includes(value);

type Storage=Pick<globalThis.Storage,'getItem'|'setItem'>;
const browser=():Storage=>localStorage;
const listeners=new Set<()=>void>();

/** The stored start page; an older "problems" is alarms, anything missing, invalid or unreadable is the Dashboard. */
export function readStartPage(storage:()=>Storage=browser):StartPage{
 try{const value=JSON.parse(storage().getItem(startPageKey)??'null');return value==='problems'?'alarms':isStartPage(value)?value:defaultStartPage;}catch{return defaultStartPage;}
}
/** Saves the start page at once. A blocked storage only loses persistence. */
export function saveStartPage(page:StartPage,storage:()=>Storage=browser){
 try{storage().setItem(startPageKey,JSON.stringify(page));}catch{/* The choice stays for this page. */}
 for(const listener of listeners)listener();
}
const subscribe=(listener:()=>void)=>{listeners.add(listener);return ()=>{listeners.delete(listener);};};
export function useStartPage():StartPage{
 return useSyncExternalStore(subscribe,()=>readStartPage(),()=>defaultStartPage);
}

/** Command palette actions with the same effect as the menu group; onSaved shows the toast. */
export function startPagePaletteItems(locale:Locale=defaultLocale,onSaved:()=>void=()=>{},save:(page:StartPage)=>void=saveStartPage):PaletteItem[]{
 return startPageOptions.map(({page,action,Icon})=>({id:'action-start-'+page,group:translate(locale,'palette.group.actions'),label:translate(locale,action),keywords:startPagePaletteKeywords,Icon,run:()=>{save(page);onSaved();}}));
}
