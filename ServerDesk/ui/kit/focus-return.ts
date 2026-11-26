// Where focus goes back when a dialog that was opened from state closes. A radix dialog returns
// focus to its own Trigger; the console opens ConfirmDialog from a Confirmation instead, so the
// dialog remembers the element outside it that had focus: the element focused when it opened, or
// one that takes focus while it is open. On close that element gets focus back; if it is gone, the
// fallback does. Focus inside a menu (a row menu entry that opened the dialog) stands for the
// menu's trigger button: the entry unmounts with the menu, the button stays.

type MenuLookup={getElementById?:(id:string)=>unknown;querySelector?:(selector:string)=>unknown};
/** What the helper needs of a DOM element: focus, whether it is still in the document, and for menu entries closest(). */
export type FocusTarget={focus:(options?:FocusOptions)=>void;isConnected?:boolean;ownerDocument?:({body?:unknown}&MenuLookup)|null;closest?:(selector:string)=>{getAttribute:(name:string)=>string|null}|null};
/** The dialog content, to ignore focus inside it. */
export type FocusContainer={contains:(node:never)=>boolean};

export type FocusReturn={
 /** Keeps `candidate` as the return target unless it is missing, the body or inside the dialog. A menu entry is replaced by its menu's trigger. */
 remember:(candidate:unknown,inside?:FocusContainer|null)=>void;
 /** Focuses the remembered element if it is still connected, else the fallback. False when neither exists. */
 restore:(fallback?:()=>FocusTarget|null|undefined)=>boolean;
 clear:()=>void;
 current:()=>FocusTarget|null;
};

const focusable=(value:unknown):value is FocusTarget=>!!value&&typeof value==='object'&&typeof (value as FocusTarget).focus==='function';

/**
 * The trigger of the menu that holds `element`, or `element` itself outside a menu. radix names the
 * menu content by its trigger (aria-labelledby = trigger id); without that, the open menu button
 * (aria-haspopup="menu", aria-expanded="true") stands in. null when a menu entry has no findable trigger.
 */
export function menuTrigger(element:FocusTarget):FocusTarget|null{
 const menu=typeof element.closest==='function'?element.closest('[role="menu"]'):null;
 if(!menu)return element;
 const doc=element.ownerDocument,id=menu.getAttribute('aria-labelledby');
 const byId=id&&typeof doc?.getElementById==='function'?doc.getElementById(id):null;
 if(focusable(byId))return byId;
 const open=typeof doc?.querySelector==='function'?doc.querySelector('[aria-haspopup="menu"][aria-expanded="true"]'):null;
 return focusable(open)?open:null;
}

export function focusReturn():FocusReturn{
 let target:FocusTarget|null=null;
 return {
  remember(candidate,inside){
   if(!focusable(candidate))return;
   if(candidate.ownerDocument&&candidate===candidate.ownerDocument.body)return;
   if(inside?.contains(candidate as never))return;
   const resolved=menuTrigger(candidate);
   if(resolved)target=resolved;
  },
  restore(fallback){
   const remembered=target;
   target=null;
   if(remembered&&remembered.isConnected!==false){remembered.focus();return true;}
   const other=fallback?.();
   if(other&&other.isConnected!==false){other.focus({preventScroll:true});return true;}
   return false;
  },
  clear(){target=null;},
  current(){return target;},
 };
}
