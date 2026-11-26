'use client';
// The hosts of the console's global overlays. Each one reads its open state from the overlay store (overlay-store.ts),
// so opening or closing the palette or Help re-renders the host and its overlay, not RedesignConsole. Both are
// memoized: the console re-renders every second (its clock) and on every data refresh, and an open overlay must not
// follow it. PaletteHost needs stable props (the console passes a stable getItems); HelpHost compares the route by
// value, since the console builds a new route object on every render.
import {memo,useSyncExternalStore} from 'react';
import CommandPalette,{type PaletteItem} from '@/ui/shell/command-palette';
import HelpPanel from '@/ui/shell/help-panel';
import type {ConsoleRoute} from '@/lib/console-route';
import type {OverlayState,OverlayStore} from '@/ui/shell/overlay-store';

const closedOnServer=()=>false,noOpeningOnServer=()=>0;
function useOverlayOpen(overlays:OverlayStore,name:Exclude<keyof OverlayState,'paletteOpening'>):boolean{
 return useSyncExternalStore(overlays.subscribe,()=>overlays.get()[name],closedOnServer);
}

/** The command palette with its open state and its opening from the store. getItems must keep its identity across console renders. */
export const PaletteHost=memo(function PaletteHost({overlays,getItems}:{overlays:OverlayStore;getItems:()=>PaletteItem[]}){
 const open=useOverlayOpen(overlays,'palette');
 const opening=useSyncExternalStore(overlays.subscribe,()=>overlays.get().paletteOpening,noOpeningOnServer);
 return <CommandPalette open={open} opening={opening} onOpenChange={overlays.setPalette} getItems={getItems}/>;
});

type HelpHostProps={overlays:OverlayStore;route:ConsoleRoute};
/** Equal routes (by value) keep the host and Help as they are; a new route of the shown page renders the new topic. */
export const sameHelpHostProps=(previous:HelpHostProps,next:HelpHostProps)=>previous.overlays===next.overlays&&(previous.route===next.route||JSON.stringify(previous.route)===JSON.stringify(next.route));

/** Help with its open state from the store. Render it after the Navigator (slice 14: Help remembers its opener in a layout effect). */
export const HelpHost=memo(function HelpHost({overlays,route}:HelpHostProps){
 const open=useOverlayOpen(overlays,'help');
 return <HelpPanel open={open} onOpenChange={overlays.setHelp} route={route}/>;
},sameHelpHostProps);
