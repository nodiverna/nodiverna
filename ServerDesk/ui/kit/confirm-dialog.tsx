'use client';
// The kit confirmation (nodiverna-ui §5 "Confirmation"): a centred radix AlertDialog for jobs on
// devices and destructive changes. The title asks the question, Facts lines name what it applies to
// ("Device: SRV-01"), the body says what happens, children hold switches, and the footer has Cancel
// on the leading side and the confirm verb on the trailing side. tone="danger" uses the kit danger
// Btn and puts the first focus on Cancel. Glass and tokens only; the portal carries .sdx-layer.
// It opens from state (no radix Trigger), so it remembers the element that had focus outside it and
// gives focus back there on close (focus-return.ts); an open layer below it, else the console's main region, is the fallback.
// Dialog is the plain centred base in the same look, for prompts that are not a yes/no question (MfaStepUp), and with
// variant="search" the frame of the command palette.
import {useCallback,useEffect,useLayoutEffect,useRef,useState,type ReactNode,type RefObject} from 'react';
import {AlertDialog,Dialog as DialogPrimitive} from 'radix-ui';
// kit.tsx imports ConfirmDialog back (the Drawer's discard question), and data-table.tsx imports the kit:
// a cycle that is safe only because each side uses the other's exports at render time. Keep it that way:
// no top-level code here or in data-table.tsx may use a kit export (and the kit none of these).
import {Btn,Facts,cx,type FactItem} from '@/ui/kit/kit';
import {useOverflowFocusable} from '@/ui/kit/data-table';
import {useT} from '@/ui/base/locale';
import {focusReturn,type FocusReturn} from '@/ui/kit/focus-return';

export type ConfirmLine={label:string;value:string;mono?:boolean};

// The modal kit layers with a scrim that are mounted now (ScrimLayerMark), and the elements that carry the mark.
const scrimLayers=new Set<object>();
let scrimMarked:Element[]=[];
type MarkNode={classList:{contains:(name:string)=>boolean};children:ArrayLike<MarkNode>};
/**
 * The elements the scrim mark goes on: the console frame (.sdx), its skip link and the navigator overlay with its scrim
 * (children of the frame's body). Found by structure, a few steps from the frame, not by a query over the console.
 */
export function scrimMarkTargets(doc:{querySelector:(selector:string)=>unknown}):MarkNode[]{
 const frame=doc.querySelector('.sdx') as MarkNode|null;
 if(!frame)return [];
 const targets:MarkNode[]=[frame];
 for(const child of Array.from(frame.children)){
  if(child.classList.contains('sdx-skip'))targets.push(child);
  else if(child.classList.contains('sdx-body'))for(const inner of Array.from(child.children))if(inner.classList.contains('sdx-navigator')||inner.classList.contains('sdx-navigator-scrim'))targets.push(inner);
 }
 return targets;
}
/**
 * Marks the console frame (data-sdx-scrim on .sdx, its skip link and the navigator overlay, scrimMarkTargets) while a
 * modal kit layer with a scrim is mounted: Dialog, ConfirmDialog and the modal Drawer render it inside their radix
 * Content. radix sets body { pointer-events: none } for every modal layer, and pointer-events is inherited, so the whole
 * console restyled on every open and again on every close (about 90 ms with 250 devices, several hundred ms on a slow
 * phone). While the mark is set, the console frame keeps pointer-events: auto itself (ui/styles/console.css), so the body
 * change stops there; the scrim still takes every pointer outside the layer. The mark sits on those few elements, not on
 * the root: a mark on html made every opening and closing check each of the console's elements against the rules that
 * follow it (a few ms of the key press at 4× CPU). The layout effect sets the mark before radix's effect changes the
 * body; the effect cleanup removes it after radix has restored the body (radix's layer is the outer component and
 * unmounts first).
 */
export function ScrimLayerMark(){
 const [token]=useState(()=>({}));
 useLayoutEffect(()=>{
  if(typeof document==='undefined')return;
  if(!scrimLayers.size){scrimMarked=scrimMarkTargets(document) as unknown as Element[];for(const element of scrimMarked)element.setAttribute('data-sdx-scrim','');}
  scrimLayers.add(token);
 },[token]);
 useEffect(()=>()=>{
  if(typeof document==='undefined')return;
  scrimLayers.delete(token);
  if(!scrimLayers.size){for(const element of scrimMarked)element.removeAttribute('data-sdx-scrim');scrimMarked=[];}
 },[token]);
 return null;
}

/** A line value that scrolls inside its box (max 160px) and takes a Tab stop only while it overflows. */
function LineValue({value}:{value:string}){
 const [ref,focusable]=useOverflowFocusable<HTMLDivElement>(value);
 return <div ref={ref} className="sdx-confirm-value" tabIndex={focusable?0:undefined} role={focusable?'group':undefined} aria-label={focusable?value:undefined}>{value}</div>;
}

/** On open: remember the element focused before the dialog; default tone moves the first focus to the confirm button (danger leaves it to radix: Cancel). */
export function openFocus(event:{preventDefault:()=>void},returner:FocusReturn,confirm:HTMLElement|null){
 returner.clear();
 returner.remember(typeof document==='undefined'?null:document.activeElement);
 if(confirm){event.preventDefault();confirm.focus();}
}
/**
 * The first control inside a container (a field before a button), else the container itself.
 * It skips only native disabled controls (and tabindex="-1" and hidden inputs). It keeps aria-disabled
 * controls on purpose: a blocked kit Btn stays focusable (aria-disabled="true") and shows its reason in
 * the Tooltip when it takes the focus, so it is a valid first focus.
 */
export function firstFocusable(container:HTMLElement):HTMLElement{
 const ready=':not([disabled]):not([tabindex="-1"]):not([type="hidden"])';
 return container.querySelector<HTMLElement>(`:is(input, select, textarea)${ready}`)??container.querySelector<HTMLElement>(`:is(button, [href], [tabindex])${ready}`)??container;
}
/**
 * The topmost modal layer that is still open (a Drawer or dialog the closing one sat on), or null.
 * The kit portals append in opening order, so the last open one is on top; the closing layer is no
 * longer data-state="open" when its close focus runs. The non-modal drawer (the assistant, Help) is
 * beside the page, not a layer below it: focus after a page dialog never jumps into it.
 */
export function openLayer():HTMLElement|null{
 const layers=document.querySelectorAll<HTMLElement>('.sdx-layer:is([role="dialog"], [role="alertdialog"])[data-state="open"]:not(.sdx-drawer-nonmodal)');
 return layers.length?layers[layers.length-1]:null;
}
/**
 * Where focus goes when a Drawer closes with focus inside it (or on the "Discard changes?" question that
 * closes it): returnFocus, else the element that had focus when the drawer opened, while it is still
 * connected; else the first control of the topmost open layer (openLayer); else the console's main region.
 * Never the body: null only when none of these exists.
 */
export function drawerReturnTarget(returnFocus:HTMLElement|null|undefined,opener:HTMLElement|null|undefined):HTMLElement|null{
 for(const candidate of [returnFocus,opener])if(candidate?.isConnected)return candidate;
 if(typeof document==='undefined')return null;
 const layer=openLayer();
 return layer?firstFocusable(layer):document.querySelector<HTMLElement>('main[tabindex]');
}
/**
 * On close: focus back to the remembered trigger. When it is gone (or nothing was remembered, as when
 * the button that opened the dialog was busy and disabled), the first control of the layer below takes
 * focus: a step-up dialog over a Drawer gives focus back into the Drawer. Without such a layer the
 * console's main region is the fallback. With within (a question about a drawer), focus stays inside
 * it: a remembered element outside it (or none, after a scrim click) gives way to the container's first control.
 * Without within, a given `to` wins: the question that closed its drawer ("Discard") hands focus to the
 * drawer's return target, not to the remembered control inside the closing drawer, which is removed with it.
 */
export function closeFocus(event:{preventDefault:()=>void},returner:FocusReturn,within?:HTMLElement|null,to?:HTMLElement|null){
 if(typeof document==='undefined')return;
 if(!within&&to){returner.clear();event.preventDefault();to.focus();return;}
 const remembered=returner.current() as unknown as Node|null;
 if(within&&!(remembered&&within.contains(remembered))){returner.clear();event.preventDefault();firstFocusable(within).focus();return;}
 if(returner.restore(()=>{const layer=openLayer();return layer?firstFocusable(layer):document.querySelector<HTMLElement>('main[tabindex]');}))event.preventDefault();
}

export function ConfirmDialog({open,onOpenChange,title,lines,body,confirmLabel,tone='default',busy=false,blocked,onConfirm,children,cancelLabel,focusWithin,closeFocusTo}:{open:boolean;onOpenChange:(open:boolean)=>void;
 /** A question: "Remove SRV-01 from the portal?" */
 title:ReactNode;
 /** What the action applies to, as label/value facts. */
 lines?:readonly ConfirmLine[];
 /** What happens; a blank line (\n\n) starts a new paragraph. */
 body?:string;
 /** A verb that matches the trigger: "Remove device". */
 confirmLabel:string;
 tone?:'danger'|'default';
 /** The confirm button shows its spinner; Cancel stays usable. */
 busy?:boolean;
 /** Why the action cannot run; the confirm button stays focusable and shows the reason. */
 blocked?:string;
 /** Runs on the confirm button; the caller closes the dialog (open is controlled). */
 onConfirm:()=>void;
 children?:ReactNode;
 /** Default common.cancel. */
 cancelLabel?:string;
 /** On close, focus returns into this element (a drawer whose close the dialog questions). */
 focusWithin?:RefObject<HTMLElement|null>;
 /** Read on close (without focusWithin): an element here takes the focus instead of the remembered one (the Drawer after "Discard"). */
 closeFocusTo?:()=>HTMLElement|null}){
 const t=useT(),confirmRef=useRef<HTMLButtonElement>(null),contentRef=useRef<HTMLDivElement>(null),[returner]=useState(focusReturn);
 // A menu gives focus back to its button only after its item opened the dialog; that button is the return target then.
 useEffect(()=>{
  if(!open)return;
  const remember=(event:FocusEvent)=>returner.remember(event.target,contentRef.current);
  document.addEventListener('focusin',remember,true);
  return ()=>document.removeEventListener('focusin',remember,true);
 },[open,returner]);
 const paragraphs=(body??'').split(/\n\s*\n/).map(part=>part.trim()).filter(Boolean);
 const facts:FactItem[]|undefined=lines?.map((line,index)=>({id:String(index),label:line.label,value:<LineValue value={line.value}/>,mono:line.mono}));
 return <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
  <AlertDialog.Portal>
   <AlertDialog.Overlay className="sdx-layer sdx-confirm-scrim"/>
   {/* Danger: radix focuses Cancel first. Default: the confirm button takes the first focus. */}
   <AlertDialog.Content className={cx('sdx-layer','sdx-confirm-dialog',tone==='danger'&&'sdx-confirm-danger')} ref={contentRef} onOpenAutoFocus={event=>openFocus(event,returner,tone==='danger'?null:confirmRef.current)} onCloseAutoFocus={event=>closeFocus(event,returner,focusWithin?.current,closeFocusTo?.())} {...(!paragraphs.length?{'aria-describedby':undefined}:{})}>
    <ScrimLayerMark/>
    <AlertDialog.Title className="sdx-confirm-title">{title}</AlertDialog.Title>
    {facts&&facts.length>0&&<Facts items={facts} className="sdx-confirm-lines"/>}
    {paragraphs.length>0&&<AlertDialog.Description asChild><div className="sdx-confirm-body">{paragraphs.map((text,index)=><p key={index}>{text}</p>)}</div></AlertDialog.Description>}
    {children}
    <footer className="sdx-confirm-foot">
     <AlertDialog.Cancel asChild><Btn>{cancelLabel??t('common.cancel')}</Btn></AlertDialog.Cancel>
     <Btn ref={confirmRef} variant={tone==='danger'?'danger':'primary'} loading={busy} blocked={blocked} onClick={()=>onConfirm()}>{confirmLabel}</Btn>
    </footer>
   </AlertDialog.Content>
  </AlertDialog.Portal>
 </AlertDialog.Root>;
}

/** The mark of the search surface whose entrance has ended: its glass layer blurs only from then on (glassAfterEntrance). */
const enteredMark='data-sdx-entered';
const scrimPointer={pointerEvents:'auto'} as const;
const reducedMotion=()=>typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches;
/**
 * The glass of the search surface (Dialog variant="search") turns on its backdrop blur when the entrance (sdx-rise)
 * has ended: at once under reduced motion (no entrance), else on animationend, at the latest after one second. While the
 * surface fades in it is a backdrop root (opacity below 1), so the blur behind its content shows nothing, yet the
 * compositor still computed it on every entrance frame: about 17 ms per frame in software compositing at 1440×900,
 * which held back the frames that present the opening key press. The look at rest is the same, and so is the look of
 * the entrance. Returns the cleanup of the fallback timer.
 */
export function glassAfterEntrance(surface:HTMLElement):()=>void{
 const mark=()=>{if(!surface.hasAttribute(enteredMark))surface.setAttribute(enteredMark,'');};
 if(reducedMotion()){mark();return ()=>{};}
 const end=(event:Event)=>{if(event.target===surface)mark();};
 surface.addEventListener('animationend',end);
 surface.addEventListener('animationcancel',end);
 const fallback=setTimeout(mark,1000);
 return ()=>{clearTimeout(fallback);surface.removeEventListener('animationend',end);surface.removeEventListener('animationcancel',end);};
}

/**
 * The plain centred dialog in the look of ConfirmDialog: the same scrim, glass surface, title and foot.
 * role="dialog" labelled by its title and described by description only when one is given. Esc and the
 * scrim close it through onOpenChange; it opens from state, so focus goes back to the element that had it
 * before (openFocus/closeFocus). hideTitle keeps the title as the dialog's name for screen readers only.
 * variant="search" is the command palette frame: near the top of the window, 640px wide, no padding and no
 * gap, so the search field, the result list and the foot hints run edge to edge.
 * closing: the dialog is already closed for the user (the scrim and the surface are hidden at once and take no pointer)
 * but stays mounted, still open for radix, until the caller sets open={false}. A caller with a large content (the
 * command palette) uses it to remove that content after the next paint instead of in the closing event.
 */
export function Dialog({open,onOpenChange,title,hideTitle=false,variant='default',description,children,footer,className,closing=false}:{open:boolean;onOpenChange:(open:boolean)=>void;title:ReactNode;
 /** The title names the dialog but is not shown (sr-only). */
 hideTitle?:boolean;
 /** default: the centred prompt; search: the top-aligned search frame (CommandPalette). */
 variant?:'default'|'search';
 description?:ReactNode;children?:ReactNode;
 /** The action row (Cancel leading, the verb trailing). */
 footer?:ReactNode;className?:string;
 /** Hidden for the user while it waits for its teardown (open stays true until then). */
 closing?:boolean}){
 const [returner]=useState(focusReturn);
 const described=description!=null&&description!==false&&description!=='';
 const search=variant==='search',closingMark=closing?{'data-sdx-closing':''}:{};
 // The search surface's glass: see glassAfterEntrance. A callback ref, so it runs once per mounted surface.
 const glassCleanup=useRef<(()=>void)|null>(null);
 const glass=useCallback((surface:HTMLDivElement|null)=>{glassCleanup.current?.();glassCleanup.current=surface?glassAfterEntrance(surface):null;},[]);
 return <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
  <DialogPrimitive.Portal>
   {/* The search variant lives only in the console, whose document never scrolls (console.css), so its scrim is a plain
       layer without radix's scroll lock: react-remove-scroll added a style element on every opening and removed it on
       every closing, and each change restyled the whole document (about 5 ms of the opening key at 4× CPU). The scrim
       takes the pointer itself (radix sets body pointer-events: none), and a press on it closes the dialog as before. */}
   {search?<div className="sdx-layer sdx-confirm-scrim" style={scrimPointer} {...closingMark}/>:<DialogPrimitive.Overlay className="sdx-layer sdx-confirm-scrim" {...closingMark}/>}
   <DialogPrimitive.Content ref={search?glass:undefined} className={cx('sdx-layer','sdx-confirm-dialog',search&&'sdx-dialog-search',className)} {...closingMark} onOpenAutoFocus={event=>openFocus(event,returner,null)} onCloseAutoFocus={event=>closeFocus(event,returner)} {...(!described?{'aria-describedby':undefined}:{})}>
    <ScrimLayerMark/>
    <DialogPrimitive.Title className={hideTitle?'sr-only':'sdx-confirm-title'}>{title}</DialogPrimitive.Title>
    {described&&<DialogPrimitive.Description className="sdx-confirm-body">{description}</DialogPrimitive.Description>}
    {children}
    {footer&&<footer className="sdx-confirm-foot">{footer}</footer>}
   </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
 </DialogPrimitive.Root>;
}
