'use client';
// The confirmation of an irreversible delete of a named object (nodiverna-ui §5): a drawer in which the user types the
// name. The danger button stays blocked with its reason until the trimmed input equals the name, and Enter in the field
// confirms while it matches. Cancel is the kit DrawerCancel: usable while the delete runs, it closes through the
// drawer's close, which also clears the typed name; a new opening starts with an empty field. The typed name stays while
// the drawer is open, also when an MFA dialog of the delete is cancelled. Used by the device group delete
// (GroupDeleteDrawer in ui/devices/fleet/groups.tsx) and the customer delete (ui/settings/customer-drawers.tsx).
import {useState,type ReactNode,type RefObject} from 'react';
import {Trash2} from 'lucide-react';
import {Btn,Drawer,DrawerCancel,type IconTone,type IconType} from '@/ui/kit/kit';

export type NameConfirmDrawerProps={
 open:boolean;
 /** The name to type; null while there is nothing to delete (no field). */
 name:string|null;
 title:ReactNode;description?:ReactNode;
 /** The head icon tile, usually Trash2 with iconTone danger. */
 icon?:IconType;iconTone?:IconTone;
 /** The consequences above the field. */
 children?:ReactNode;
 /** The label of the name field. */
 fieldLabel:string;
 /** The verb of the danger button. */
 confirmLabel:string;
 /** The blocked reason of the danger button while the name does not match. */
 enterNameFirst:string;
 busy:boolean;
 /** Passed to the Drawer: the focus target after the close, and a value whose change closes the drawer (the console route). */
 returnFocus?:RefObject<HTMLElement|null>;closeKey?:unknown;
 onClose:()=>void;
 onConfirm:()=>void;
};

/** Whether the typed text confirms the name: equal after trimming. */
export const nameConfirmed=(typed:string,name:string|null)=>name!==null&&typed.trim()===name;

export function NameConfirmDrawer({open,name,title,description,icon,iconTone,children,fieldLabel,confirmLabel,enterNameFirst,busy,returnFocus,closeKey,onClose,onConfirm}:NameConfirmDrawerProps){
 const [typed,setTyped]=useState(''),[shown,setShown]=useState(open);
 // Each opening starts with an empty field, also after a close that did not run onClose (a success).
 if(shown!==open){setShown(open);if(open)setTyped('');}
 const matches=nameConfirmed(typed,name);
 const field=name!==null&&<label className="sdx-field"><span>{fieldLabel}</span><input autoFocus value={typed} placeholder={name} disabled={busy} onChange={event=>setTyped(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'&&matches&&!busy)onConfirm();}}/></label>;
 return <Drawer open={open} onClose={()=>{setTyped('');onClose();}} title={title} description={description} icon={icon} iconTone={iconTone} returnFocus={returnFocus} closeKey={closeKey}
  footer={<><DrawerCancel/><Btn variant="danger" icon={Trash2} loading={busy} blocked={matches?undefined:enterNameFirst} onClick={onConfirm}>{confirmLabel}</Btn></>}>
  {children?<div className="sdx-form-grid">{children}{field}</div>:field}
 </Drawer>;
}
