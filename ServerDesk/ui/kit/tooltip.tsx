'use client';
// The console's one tooltip (nodiverna-ui §3), on radix Tooltip. It explains an icon button,
// a hint or the reason of a blocked action on hover and keyboard focus. Content is portaled to
// <body>, so it sits above drawers and menus. Every Tooltip brings its own provider unless a
// TooltipProvider is above it, so it works in the console, drawers, portals and SSR tests alike.
import {createContext,useContext,type ReactElement,type ReactNode} from 'react';
import {Tooltip as TooltipPrimitive} from 'radix-ui';

/** Hover delay before a tooltip opens; moving to a neighbour within skipDelay opens it at once. */
const delayDuration=400,skipDelayDuration=300;
const Shared=createContext(false);

/** Optional: one provider for a whole tree, so neighbouring tooltips open without a second delay. */
export function TooltipProvider({children}:{children:ReactNode}){
 return <TooltipPrimitive.Provider delayDuration={delayDuration} skipDelayDuration={skipDelayDuration}><Shared.Provider value>{children}</Shared.Provider></TooltipPrimitive.Provider>;
}

export type TooltipProps={
 /** The tooltip text. Empty content never opens, so a caller can keep the wrapper mounted. */
 content:ReactNode;
 /** One focusable element that takes a ref and props (asChild). */
 children:ReactElement;
 side?:'top'|'right'|'bottom'|'left';
 open?:boolean;onOpenChange?:(open:boolean)=>void;
};

export function Tooltip({content,children,side='top',open,onOpenChange}:TooltipProps){
 const shared=useContext(Shared);
 const empty=content==null||content===false||content==='';
 const root=<TooltipPrimitive.Root open={empty?false:open} onOpenChange={next=>onOpenChange?.(empty?false:next)}>
  <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
  {!empty&&<TooltipPrimitive.Portal><TooltipPrimitive.Content className="sdx-tooltip" side={side} sideOffset={6} collisionPadding={8}>{content}</TooltipPrimitive.Content></TooltipPrimitive.Portal>}
 </TooltipPrimitive.Root>;
 return shared?root:<TooltipPrimitive.Provider delayDuration={delayDuration} skipDelayDuration={skipDelayDuration}>{root}</TooltipPrimitive.Provider>;
}
