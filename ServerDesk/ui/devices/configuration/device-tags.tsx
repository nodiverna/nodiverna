'use client';
// The tags of a device in the meta line of the page header: one chip per direct and effective inherited tag, a remove
// button on each direct tag, up to three chips (two in the compact header) and "+N" for the rest. "More actions" ›
// "Add tags…" opens the inline add form in the same place (formOpen). The server resolves the inheritance and the
// rights (GET /api/tags); this part only shows them. Changes go through POST /api/tags (remove-tag, set-tag) with the
// same fence, validation and error texts as the group Tags tab (tags.tsx).
import {useCallback,useEffect,useId,useLayoutEffect,useRef,useState,type FormEvent,type KeyboardEvent,type TransitionEvent} from 'react';
import {toast} from 'sonner';
import {AlertTriangle,RefreshCw,X} from 'lucide-react';
import type {Viewer} from '@/lib/types';
import {headerTagChips,tagLabel,validateTag,type DirectTag,type HeaderTagChip,type InheritedTag,type TagView} from '@/lib/tags';
import {api,ApiError,permitted,type Device} from '@/ui/base/api';
import {Btn,cx} from '@/ui/kit/kit';
import {useFocusAfterMenu} from '@/ui/devices/device/device-description';
import {InheritedOrigin} from '@/ui/kit/inheritance';
import {useNarrowLayout} from '@/ui/base/narrow-layout';
import {TagFields,demoTagView,tagFailure,tagOriginLabel,useTagSuggestions,type TagDraft} from '@/ui/devices/configuration/tags';
import {useT,type Translate} from '@/ui/base/locale';

const endpoint='/api/tags';
const emptyDraft:TagDraft={name:'',value:'',inherit:false};
/** Fallback when transitionend never fires: a little longer than the fade (--sd-dur, 180ms). */
const leaveFallbackMs=240;
/** Chips shown in the collapsed row of the compact header (at 760px or narrower). */
export const collapsedTagCount=2;
/** Chips shown in the collapsed meta line of the wide header (761px and wider). */
export const wideTagCount=3;
/** Why the tags of this device cannot be changed here, or undefined: sample devices, or no Manage device groups and permissions (groups.manage). */
export function deviceTagsBlocked(server:Device,viewer:Viewer,demo:boolean,t:Translate):string|undefined{
 if(demo)return t('kit.unavailable.demo');
 if(!permitted(server,viewer,'groups.manage'))return t('device.metadata.noRight');
 return undefined;
}
/** The collapsed row: the first `count` chips in headerTagChips order, and how many more stay behind "+N". Pure. */
export function collapsedTagChips<T>(chips:readonly T[],count=collapsedTagCount):{shown:T[];more:number}{
 return chips.length<=count?{shown:[...chips],more:0}:{shown:chips.slice(0,count),more:chips.length-count};
}
const reducedMotion=()=>typeof window!=='undefined'&&typeof window.matchMedia==='function'&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;

type Props={
 server:Device;viewer:Viewer;demo:boolean;
 /** Reloads the console data after a change, so the fleet table and filter follow at once. */
 onRefresh?:()=>Promise<void>|void;
 /** Opens the Tags tab of an origin group. */
 onOpenOrigin?:(groupId:string)=>void;
 /** A view already at hand (tests render without effects); the component still loads its own. */
 initialView?:TagView;
 /** The add form is open (More actions › "Add tags…"); without the right it stays closed. */
 formOpen?:boolean;
 /** Closes the add form after Esc, Cancel or an added tag. The caller returns the focus to the control that opened it. */
 onFormClose?:()=>void;
};

export default function DeviceTags({server,viewer,demo,onRefresh,onOpenOrigin,initialView,formOpen=false,onFormClose=()=>{}}:Props){
 const t=useT();
 const [loaded,setLoaded]=useState<{serverId:string;view:TagView}|null>(initialView?{serverId:server.id,view:initialView}:null);
 const [failed,setFailed]=useState(false),[loading,setLoading]=useState(false);
 const [removing,setRemoving]=useState<string|null>(null),[adding,setAdding]=useState(false);
 // Direct tags this user removed: "leaving" while the chip fades, from the tag's last data, so a reload that
 // returns sooner cannot cut the fade short; "gone" once it has left, so a reload still pending cannot bring it back.
 const [departed,setDeparted]=useState<Record<string,{tag:DirectTag;phase:'leaving'|'gone'}>>({});
 const sequence=useRef(0),mounted=useRef(true),leaveTimers=useRef(new Map<string,ReturnType<typeof setTimeout>>());
 useEffect(()=>{
  mounted.current=true;const timers=leaveTimers.current;
  return()=>{mounted.current=false;for(const timer of timers.values())clearTimeout(timer);timers.clear();};
 },[]);
 const load=useCallback(async()=>{
  if(demo)return;
  const current=++sequence.current;setLoading(true);
  try{
   const view=await api<TagView>(`${endpoint}?${new URLSearchParams({scopeType:'device',scopeId:server.id})}`);
   if(mounted.current&&current===sequence.current){setLoaded({serverId:server.id,view});setFailed(false);}
  }catch{if(mounted.current&&current===sequence.current)setFailed(true);}
  finally{if(mounted.current&&current===sequence.current)setLoading(false);}
 },[demo,server.id]);
 useEffect(()=>{queueMicrotask(()=>void load());},[load]);

 const view=demo?demoTagView(server):loaded?.serverId===server.id?loaded.view:null;
 // Until the first load ends (or after it failed) the console's tags keep the row filled, read-only.
 const base=view??demoTagView(server);
 const leaving=Object.values(departed).filter(entry=>entry.phase==='leaving').map(entry=>entry.tag);
 const chips=headerTagChips({inherited:base.inherited,direct:[...base.direct.filter(tag=>!departed[tag.id]),...leaving]});
 const right=!demo&&permitted(server,viewer,'groups.manage')&&view?.canEdit!==false;
 const canRemove=right&&!!view;
 // A fading chip keeps the other tag actions disabled until it has left, like a running remove.
 const busy=removing!==null||adding||leaving.length>0;
 const left=useCallback((id:string)=>{
  const timer=leaveTimers.current.get(id);
  if(timer!==undefined){clearTimeout(timer);leaveTimers.current.delete(id);}
  if(!mounted.current)return;
  setDeparted(current=>current[id]?.phase==='leaving'?{...current,[id]:{tag:current[id].tag,phase:'gone'}}:current);
 },[]);
 // After a successful remove: fade the chip out (transitionend, or the fallback timeout), then drop it.
 // With reduced motion it goes at once.
 const leave=(tag:DirectTag)=>{
  if(reducedMotion()){setDeparted(current=>({...current,[tag.id]:{tag,phase:'gone'}}));return;}
  setDeparted(current=>({...current,[tag.id]:{tag,phase:'leaving'}}));
  leaveTimers.current.set(tag.id,setTimeout(()=>left(tag.id),leaveFallbackMs));
 };
 const remove=async(tag:DirectTag)=>{
  if(!canRemove||busy)return;
  setRemoving(tag.id);
  try{
   await api(endpoint,{action:'remove-tag',scopeType:'device',scopeId:server.id,tagId:tag.id,expected:tag.updatedAt});
   toast.success(t(tag.overrides?'tags.reset':'tags.removed'));
   if(mounted.current)leave(tag);
   await Promise.all([load(),onRefresh?.()]);
  }catch(failure){toast.error(tagFailure(failure,t,{scopeType:'device'}));if(failure instanceof ApiError&&failure.code==='TAG_CHANGED')void load();}
  finally{if(mounted.current)setRemoving(null);}
 };
 const editing=formOpen&&right;
 // The meta line keeps the row short: 3 chips (2 in the compact header at 760px or narrower, after mount), then "+N".
 const narrow=useNarrowLayout(),[expanded,setExpanded]=useState(false),listId=useId(),limit=narrow?collapsedTagCount:wideTagCount;
 // The wide meta line stays one line and a chip never shrinks: when the line overflows (the description has given way
 // first), the last shown chip moves behind "+N". A new width or other chips start again from the limit.
 const rowRef=useRef<HTMLDivElement>(null),fitKey=`${chips.map(chipKey).join('\u0001')}\u0000${limit}`;
 const [fitState,setFitState]=useState<{key:string;count:number}|null>(null);
 const fitted=!narrow&&fitState?.key===fitKey?Math.min(fitState.count,limit):limit;
 const fitRef=useRef({key:fitKey,count:fitted,measure:!narrow&&!expanded&&!editing});
 useLayoutEffect(()=>{fitRef.current={key:fitKey,count:fitted,measure:!narrow&&!expanded&&!editing};});
 const measureFit=useCallback(()=>{
  const row=rowRef.current?.closest<HTMLElement>('.sdx-device-meta-line'),current=fitRef.current;
  if(!row||!current.measure||current.count<=0)return;
  if(row.scrollWidth>row.clientWidth+1)setFitState({key:current.key,count:current.count-1});
 },[]);
 useLayoutEffect(()=>{measureFit();});
 useLayoutEffect(()=>{
  const row=rowRef.current?.closest<HTMLElement>('.sdx-device-meta-line');
  if(!row||typeof ResizeObserver==='undefined')return;
  let width=row.clientWidth;
  const observer=new ResizeObserver(()=>{if(row.clientWidth===width)return;width=row.clientWidth;setFitState(null);});
  observer.observe(row);
  return ()=>observer.disconnect();
 },[narrow]);
 const {shown,more}=!expanded?collapsedTagChips(chips,fitted):{shown:chips,more:0};
 const collapsible=chips.length>fitted;
 if(!chips.length&&!editing&&!failed)return null;

 return <div ref={rowRef} className={cx('sdx-device-tags',editing&&'sdx-device-tags-editing',collapsible&&!expanded&&'sdx-device-tags-collapsed',collapsible&&expanded&&'sdx-device-tags-open')}>
  {chips.length>0&&<ul id={listId} className="sdx-device-tag-list" aria-label={t('tags.title')}>
   {shown.map((chip,index)=>{
    const fading=chip.kind==='direct'&&departed[chip.tag.id]?.phase==='leaving';
    // Chips revealed by "+N" fade in once; the first ones never move.
    return <li key={chipKey(chip)} aria-hidden={fading||undefined} className={collapsible&&expanded&&index>=fitted?'sdx-device-tag-revealed':undefined}>
     {chip.kind==='direct'
      ?<DirectChip tag={chip.tag} removable={canRemove||fading} busy={removing===chip.tag.id&&!fading} disabled={busy} leaving={fading} onRemove={()=>void remove(chip.tag)} onLeft={()=>left(chip.tag.id)}/>
      :<InheritedChip tag={chip.tag} onOpenOrigin={onOpenOrigin}/>}
    </li>;
   })}
  </ul>}
  {collapsible&&<Btn variant="ghost" size="sm" className="sdx-device-tags-more" aria-expanded={expanded} aria-controls={listId} aria-label={expanded?undefined:t('device.tags.showMore',{count:more})} onClick={()=>setExpanded(open=>!open)}>{expanded?t('device.tags.showFewer'):t('device.tags.moreCount',{count:more})}</Btn>}
  {editing&&<AddTagForm serverId={server.id} onBusy={setAdding} onClose={onFormClose} onDone={async()=>{await Promise.all([load(),onRefresh?.()]);}}/>}
  {failed&&<p className="sdx-device-tags-failed" role="alert"><AlertTriangle size={14} aria-hidden/>{t('tags.loadFailed')}<Btn variant="ghost" size="sm" icon={RefreshCw} loading={loading} onClick={()=>void load()}>{t('common.retry')}</Btn></p>}
 </div>;
}

/**
 * A direct tag: the label, truncated inside the chip, and a remove button when the viewer may change tags.
 * leaving: the fade after a remove. The chip is hidden from screen readers and its button is disabled
 * (kept, so the chip does not change width while it fades); onLeft runs when the opacity transition ends.
 * Exported for the SSR test of the leaving state.
 */
export function DirectChip({tag,removable,busy,disabled,leaving=false,onRemove,onLeft}:{tag:DirectTag;removable:boolean;busy:boolean;disabled:boolean;leaving?:boolean;onRemove:()=>void;onLeft?:()=>void}){
 const t=useT(),label=tagLabel(tag);
 // An override names the inherited value it replaces, as on the group Tags tab.
 const title=tag.overrides?t('tags.inheritedValue',{value:tag.overrides.value||t('tags.noValue'),origin:tagOriginLabel(tag.overrides.origin,t)}):label;
 const transitionEnd=leaving&&onLeft?(event:TransitionEvent<HTMLSpanElement>)=>{if(event.target===event.currentTarget&&event.propertyName==='opacity')onLeft();}:undefined;
 return <span className={cx('sdx-tag','sdx-device-tag',tag.overrides&&'sdx-tag-changed',leaving&&'sdx-device-tag-leaving')} title={title} aria-busy={busy||undefined} aria-hidden={leaving||undefined} onTransitionEnd={transitionEnd}>
  <span className="sdx-device-tag-label">{label}</span>
  {removable&&<button type="button" className="sdx-device-tag-remove" aria-label={t('device.tags.remove',{tag:label})} disabled={disabled||leaving} tabIndex={leaving?-1:undefined} onClick={onRemove}><X size={13} aria-hidden/></button>}
 </span>;
}

const chipKey=(chip:HeaderTagChip)=>chip.kind+':'+(chip.kind==='direct'?chip.tag.id:chip.tag.origin.id+':'+chip.tag.name);

/**
 * An inherited tag: a read-only chip with the label, then "Inherited" and the origin group (InheritedOrigin inline).
 * The group name is a button to the group's Tags tab when the viewer may see the group; its name repeats the
 * visible group name (WCAG 2.5.3) and its description says where the tag can be changed.
 */
export function InheritedChip({tag,onOpenOrigin}:{tag:InheritedTag;onOpenOrigin?:(groupId:string)=>void}){
 const t=useT(),label=tagLabel(tag),group=tag.origin.name;
 const open=tag.origin.visible&&onOpenOrigin?()=>onOpenOrigin(tag.origin.id):undefined;
 return <span className="sdx-tag sdx-tag-inherited sdx-device-tag" title={label}>
  <span className="sdx-device-tag-label">{label}</span>
  <InheritedOrigin variant="inline" label={group} onOpen={open} openLabel={t('device.tags.openOriginNamed',{tag:label,group})}/>
 </span>;
}

/** "Add tag" inline: name and value with suggestions, Cancel and Add tag. Escape cancels without leaving the page. */
function AddTagForm({serverId,onBusy,onClose,onDone}:{serverId:string;onBusy:(busy:boolean)=>void;onClose:()=>void;onDone:()=>Promise<void>}){
 const t=useT(),formRef=useFocusAfterMenu<HTMLFormElement>();
 const [draft,setDraft]=useState<TagDraft>(emptyDraft),[submitted,setSubmitted]=useState(false),[busy,setBusy]=useState(false);
 const suggestions=useTagSuggestions(true);
 const result=validateTag(draft,'device'),problems=result.ok?{}:result.problems;
 const pending=(value:boolean)=>{setBusy(value);onBusy(value);};
 const cancel=()=>{if(!busy)onClose();};
 const submit=async(event:FormEvent)=>{
  event.preventDefault();setSubmitted(true);
  if(!result.ok||busy)return;
  pending(true);
  try{
   await api(endpoint,{action:'set-tag',scopeType:'device',scopeId:serverId,tagId:null,expected:null,name:result.tag.name,value:result.tag.value,inherit:false});
   toast.success(t('device.tags.added'));
   pending(false);onClose();
   await onDone();
  }catch(failure){toast.error(tagFailure(failure,t,{scopeType:'device'}));pending(false);}
 };
 // Escape belongs to the form: it closes it and never reaches the console (drawers, shortcuts).
 const keyDown=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();cancel();}};
 return <form ref={formRef} className="sdx-device-tag-form" noValidate onSubmit={event=>void submit(event)} onKeyDown={keyDown}>
  <TagFields draft={draft} onChange={setDraft} problems={problems} submitted={submitted} busy={busy} suggestions={suggestions}/>
  <div className="sdx-device-tag-form-actions">
   <Btn size="sm" onClick={cancel} disabled={busy}>{t('common.cancel')}</Btn>
   <Btn size="sm" variant="primary" type="submit" loading={busy} blocked={submitted&&!result.ok?t('tags.error.invalid'):undefined}>{t('tags.add')}</Btn>
  </div>
 </form>;
}
