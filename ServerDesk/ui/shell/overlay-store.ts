// The open state of the console's two global overlays, the command palette and Help. It lives outside the state of
// RedesignConsole: opening or closing one re-renders only its host (overlay-hosts.tsx), never the console body with
// the fleet table, the device view and the navigator. The slice 14 rules stay here: the palette closes Help and Help
// closes the palette. Closing the navigator overlay stays with the console, which owns it.

/** paletteOpening counts the palette's openings (closed to open): each opening gets fresh content (CommandPalette). */
export type OverlayState={readonly palette:boolean;readonly help:boolean;readonly paletteOpening:number};

export type OverlayStore={
 get:()=>OverlayState;
 /** useSyncExternalStore's subscribe: the listener runs after every change. */
 subscribe:(listener:()=>void)=>()=>void;
 /** Ctrl/⌘ K, the top-bar search, /: opens the palette and closes Help. */
 openPalette:()=>void;
 /** The palette's own onOpenChange (Esc, the scrim, a chosen entry). */
 setPalette:(open:boolean)=>void;
 /** F1, ?, the top-bar help button, the palette's Help action: opens, closes or (without open) toggles Help, and closes the palette. */
 toggleHelp:(open?:boolean)=>void;
 /** Help's own onOpenChange (Esc from inside, the close button). */
 setHelp:(open:boolean)=>void;
};

export function overlayStore():OverlayStore{
 let state:OverlayState={palette:false,help:false,paletteOpening:0};
 const listeners=new Set<()=>void>();
 const set=(next:{palette:boolean;help:boolean})=>{
  if(next.palette===state.palette&&next.help===state.help)return;
  state={...next,paletteOpening:state.paletteOpening+(next.palette&&!state.palette?1:0)};
  for(const listener of [...listeners])listener();
 };
 return {
  get:()=>state,
  subscribe(listener){listeners.add(listener);return ()=>{listeners.delete(listener);};},
  openPalette:()=>set({palette:true,help:false}),
  setPalette:open=>set({palette:open,help:state.help}),
  toggleHelp:open=>set({palette:false,help:open??!state.help}),
  setHelp:open=>set({palette:state.palette,help:open}),
 };
}
