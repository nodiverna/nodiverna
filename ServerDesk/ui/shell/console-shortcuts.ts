'use client';
import {useEffect,useRef} from 'react';
import type {MessageKey} from '@/lib/i18n/translate';
import {goShortcutNode,goShortcuts,type NavNode} from '@/ui/shell/nav-model';

export type ShortcutHandlers={
 palette:()=>void;
 help:()=>void;
 search:()=>void;
 refresh:()=>void;
 jobs:()=>void;
 /** G then a letter: the node of the navigation model whose shortcut or alias it is (goShortcutNode). */
 go:(target:NavNode)=>void;
 section:(index:number)=>void;
 step:(direction:1|-1)=>void;
};

/** Marks the word "or" between two keys; the help panel shows it translated, not as a key. */
export const shortcutOr:MessageKey='shortcuts.or';
// Labels and scopes are message keys (lib/i18n), translated where they are shown. The G rows come from the navigation model.
export const shortcutList:ReadonlyArray<{keys:string[];label:MessageKey;scope?:MessageKey}>=[
 {keys:['Ctrl','K'],label:'shortcuts.search'},
 {keys:['/'],label:'shortcuts.deviceSearch'},
 {keys:['F1',shortcutOr,'?'],label:'shortcuts.help'},
 ...goShortcuts.map(({node,label})=>({keys:node.shortcut!.keys.split(' '),label})),
 {keys:['1','–','9'],label:'shortcuts.switchArea',scope:'shortcuts.scopeDevice'},
 {keys:['J'],label:'shortcuts.nextDevice',scope:'shortcuts.scopeDevice'},
 {keys:['K'],label:'shortcuts.previousDevice',scope:'shortcuts.scopeDevice'},
 {keys:['R'],label:'shortcuts.refresh'},
 {keys:['T'],label:'shortcuts.jobs'},
 {keys:['Esc'],label:'shortcuts.close'},
];

// A non-modal drawer (the kit Drawer with modal={false}) leaves the page usable, so the
// keys still work there, except in its fields.
const typing=(target:EventTarget|null)=>target instanceof HTMLElement&&(target.isContentEditable||['INPUT','TEXTAREA','SELECT'].includes(target.tagName)||!!target.closest('[role="dialog"]:not(.sdx-drawer-nonmodal),[role="alertdialog"],.xterm'));

// Single-key shortcuts stay quiet while the user types or works inside a dialog or terminal.
export function useConsoleShortcuts(handlers:ShortcutHandlers){
 const current=useRef(handlers);
 useEffect(()=>{current.current=handlers;});
 useEffect(()=>{
  let pendingG=0;
  const onKey=(event:KeyboardEvent)=>{
   const h=current.current,key=event.key.toLowerCase();
   if((event.ctrlKey||event.metaKey)&&!event.altKey&&key==='k'){event.preventDefault();h.palette();return;}
   if(event.key==='F1'){event.preventDefault();h.help();return;}
   if(event.defaultPrevented||event.ctrlKey||event.metaKey||event.altKey||typing(event.target))return;
   if(pendingG&&Date.now()-pendingG<1200){
    pendingG=0;
    const target=goShortcutNode(key);
    if(target){event.preventDefault();h.go(target);}
    return;
   }
   pendingG=0;
   if(key==='g'){pendingG=Date.now();return;}
   if(event.key==='?'){event.preventDefault();h.help();return;}
   if(key==='/'){event.preventDefault();h.search();return;}
   if(key==='r'){event.preventDefault();h.refresh();return;}
   if(key==='t'){event.preventDefault();h.jobs();return;}
   if(key==='j'||key==='k'){event.preventDefault();h.step(key==='j'?1:-1);return;}
   // 1–9 are the key areas of the device (deviceKeyAreas); 9 is Extensions, which the handler ignores on a device without it.
   if(/^[1-9]$/.test(key)){event.preventDefault();h.section(Number(key)-1);}
  };
  window.addEventListener('keydown',onKey);
  return()=>window.removeEventListener('keydown',onKey);
 },[]);
}
