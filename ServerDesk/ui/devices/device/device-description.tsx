'use client';
// The free-text description of a device in the meta line of the page header: one line with an ellipsis, the full
// text on hover (title) and, when it does not fit or has line breaks, on a click. "More actions" › "Add description…"
// or "Edit description…" opens the inline editor in the same place (editing). The editor validates with the server's
// function (validateDeviceDescription in lib/device-description.ts); the server stores only what it accepts
// (POST /api/device-description).
import {useEffect,useId,useRef,useState,type FormEvent,type KeyboardEvent} from 'react';
import {toast} from 'sonner';
import {ChevronDown} from 'lucide-react';
import type {Viewer} from '@/lib/types';
import {deviceDescriptionLength,deviceDescriptionMax,validateDeviceDescription} from '@/lib/device-description';
import {api,ApiError,message,permitted,type Device} from '@/ui/base/api';
import {Btn,cx} from '@/ui/kit/kit';
import {useT,type Translate} from '@/ui/base/locale';

type Props={
 server:Device;viewer:Viewer;demo:boolean;
 /** Reloads the console data after a save, so every place shows the new text. */
 onRefresh?:()=>Promise<void>|void;
 /** The editor is open (More actions › "Add description…" or "Edit description…"); a blocked viewer never gets it. */
 editing?:boolean;
 /** Closes the editor after Esc, Cancel or a save. The caller returns the focus to the control that opened it. */
 onClose?:()=>void;
};
/**
 * Moves the focus into a field once the menu that opened its form has given the focus back to its trigger: the
 * menu does that in a timer when it closes, so the field takes the focus in a later one. On a form, its first field.
 */
export function useFocusAfterMenu<T extends HTMLElement>(){
 const ref=useRef<T>(null);
 useEffect(()=>{
  const timer=setTimeout(()=>{const node=ref.current;(node?.tagName==='FORM'?node.querySelector<HTMLElement>('input,textarea'):node)?.focus();},0);
  return()=>clearTimeout(timer);
 },[]);
 return ref;
}

/** Why the description cannot be changed here, or undefined. The right is Manage device groups and permissions (groups.manage). */
export function deviceDescriptionBlocked(server:Device,viewer:Viewer,demo:boolean,t:Translate):string|undefined{
 if(demo)return t('kit.unavailable.demo');
 if(!permitted(server,viewer,'groups.manage'))return t('device.metadata.noRight');
 return undefined;
}
/** The localized text of a failed save, by error code. */
export function deviceDescriptionFailure(failure:unknown,t:Translate):string{
 if(failure instanceof ApiError){
  if(failure.code==='DEVICE_DESCRIPTION_INVALID')return t('device.description.invalid');
  if(failure.code==='DEVICE_DESCRIPTION_CHANGED')return t('device.description.changed');
  if(failure.status===403&&!failure.code)return t('device.metadata.noRight');
 }
 return message(failure);
}

export default function DeviceDescription({server,viewer,demo,onRefresh,editing=false,onClose=()=>{}}:Props){
 const t=useT();
 const stored=server.description??'',blocked=deviceDescriptionBlocked(server,viewer,demo,t);
 if(editing&&!blocked)return <DescriptionEditor serverId={server.id} stored={stored} onRefresh={onRefresh} onClose={onClose}/>;
 // An empty description shows nothing: the meta line keeps the facts only. Adding one is in "More actions".
 if(!stored)return null;
 return <div className="sdx-device-description sdx-device-description-filled">
  <DescriptionText text={stored}/>
 </div>;
}

/**
 * The stored text in one line. When it does not fit (measured, again on every
 * resize) or has a line break, it is a button that expands the full text with
 * its line breaks and collapses it again; otherwise a plain paragraph. The button keeps the ink color
 * in every state; a trailing chevron says it expands and turns when it is open.
 */
export function DescriptionText({text}:{text:string}){
 const [node,setNode]=useState<HTMLElement|null>(null),[truncated,setTruncated]=useState(false),[expanded,setExpanded]=useState(false);
 const multiline=text.includes('\n'),expandable=multiline||truncated;
 useEffect(()=>{
  if(!node||expanded)return;
  const measure=()=>setTruncated(node.scrollWidth>node.clientWidth);
  measure();
  if(typeof ResizeObserver==='undefined')return;
  const observer=new ResizeObserver(measure);observer.observe(node);
  return ()=>observer.disconnect();
 },[node,expanded,text]);
 const className=cx('sdx-device-description-text',expanded?'sdx-device-description-full':'sdx-device-description-line');
 if(!expandable)return <p ref={setNode} className={className} title={text}>{text}</p>;
 return <button type="button" className="sdx-device-description-toggle" title={text} aria-expanded={expanded} onClick={()=>setExpanded(open=>!open)}><span ref={setNode} className={className}>{text}</span><ChevronDown size={14} className="sdx-device-description-chevron" aria-hidden/></button>;
}

/** The inline editor: textarea with a live counter, Save and Cancel. Escape cancels without leaving the page. */
function DescriptionEditor({serverId,stored,onRefresh,onClose}:{serverId:string;stored:string;onRefresh?:()=>Promise<void>|void;onClose:()=>void}){
 const t=useT(),fieldId=useId(),field=useFocusAfterMenu<HTMLTextAreaElement>();
 const [draft,setDraft]=useState(stored),[busy,setBusy]=useState(false);
 const result=validateDeviceDescription(draft),count=deviceDescriptionLength(result.text),over=count>deviceDescriptionMax;
 const error=result.ok?'':result.problem==='too-long'?t('device.description.tooLong'):t('device.description.invalid');
 const saveBlocked=result.ok&&result.text===stored?t('common.noChanges'):error||undefined;
 const cancel=()=>{if(!busy)onClose();};
 const submit=async(event:FormEvent)=>{
  event.preventDefault();
  if(saveBlocked||busy)return;
  setBusy(true);
  try{
   await api('/api/device-description',{serverId,description:draft,expected:stored});
   toast.success(t('device.description.saved'));
   await onRefresh?.();
   onClose();
  }catch(failure){toast.error(deviceDescriptionFailure(failure,t));setBusy(false);}
 };
 // Escape belongs to the editor: it closes it and never reaches the console (drawers, shortcuts).
 const keyDown=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();cancel();}};
 return <form className="sdx-description-editor" noValidate onSubmit={event=>void submit(event)} onKeyDown={keyDown}>
  <label className="sdx-field" htmlFor={fieldId}>
   <span className="sr-only">{t('device.description.label')}</span>
   <textarea ref={field} id={fieldId} autoFocus rows={3} value={draft} placeholder={t('device.description.placeholder')} disabled={busy} aria-invalid={!!error||undefined} aria-describedby={`${fieldId}-counter${error?` ${fieldId}-error`:''}`} onChange={event=>setDraft(event.target.value)}/>
   {error&&<span id={`${fieldId}-error`} className="sdx-field-error">{error}</span>}
  </label>
  <div className="sdx-description-editor-foot">
   <span id={`${fieldId}-counter`} className={cx('sdx-counter',over&&'sdx-counter-over')} aria-live="polite">{t('device.description.counter',{count})}</span>
   <Btn size="sm" onClick={cancel} disabled={busy}>{t('common.cancel')}</Btn>
   <Btn size="sm" variant="primary" type="submit" loading={busy} blocked={saveBlocked}>{t('common.save')}</Btn>
  </div>
 </form>;
}
