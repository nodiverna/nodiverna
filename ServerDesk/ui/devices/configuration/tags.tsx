'use client';
// The "Tags" area of a device group (TagsPanel), the add and edit
// drawer, the bulk drawers of the fleet and the tag chips of the fleet table.
// The server resolves the inheritance (GET /api/tags, effectiveDeviceTags in
// lib/server/devices/tag-store.ts); these parts only show it, following the inheritance
// pattern (nodiverna-ui skill §7). The drawers validate with the server's
// function (validateTag in lib/tags.ts).
import {useCallback,useEffect,useId,useRef,useState,type FormEvent} from 'react';
import {toast} from 'sonner';
import {ArrowUpRight,Pencil,Plus,RotateCcw,Tag,Trash2} from 'lucide-react';
import type {MessageKey} from '@/lib/i18n/translate';
import {compareTagNames,tagKey,tagLength,tagNameMax,tagValueMax,tagLabel,validateTag,type DirectTag,type EffectiveTag,type InheritedTag,type TagOriginView,type TagProblems,type TagScopeType,type TagSuggestions,type TagView} from '@/lib/tags';
import {api,ApiError,message,permitted,type Device} from '@/ui/base/api';
import type {Viewer} from '@/lib/types';
import {EMPTY_VALUE} from '@/lib/i18n/format';
import {Btn,Card,Drawer,Menu,PickRow,cx,type EmptyProps,type MenuEntry} from '@/ui/kit/kit';
import {DataTable,type DataColumn} from '@/ui/kit/data-table';
import {AnalysisTab,FirstLoad,LoadFailed} from '@/ui/kit/analysis-tab';
import {InheritedOrigin} from '@/ui/kit/inheritance';
import {useLocale,useT,type Translate} from '@/ui/base/locale';

export type TagsScope={type:TagScopeType;id:string};
export type TagDraft={name:string;value:string;inherit:boolean};
const endpoint='/api/tags';

/** The origin as the user knows it: "Device group: Berlin". */
export const tagOriginLabel=(origin:TagOriginView,t:Translate)=>t('tags.origin.group',{name:origin.name});
/** The localized text of a failed change, by error code. bulk: the change covered several devices. */
export function tagFailure(failure:unknown,t:Translate,{scopeType='device',bulk=false,missingRight=1}:{scopeType?:TagScopeType;bulk?:boolean;missingRight?:number}={}):string{
 if(failure instanceof ApiError){
  if(failure.code==='TAG_INVALID')return t('tags.error.invalid');
  if(failure.code==='TAG_NAME_TAKEN')return t('tags.error.nameTaken');
  if(failure.code==='TAG_LIMIT')return t(bulk?'tags.error.bulkLimit':'tags.error.limit');
  if(failure.code==='TAG_CHANGED')return t('tags.error.changed');
  if(failure.status===403&&!failure.code)return bulk?t('tags.bulk.noRight',{count:Math.max(1,missingRight)}):t(scopeType==='group'?'tags.groupNoRight':'device.metadata.noRight');
 }
 return message(failure);
}
/** The tag view of a sample device, built from the tags of the fixture (sample devices cannot be changed). */
export function demoTagView(server:Device):TagView{
 const tags=server.tags??[],group=(id:string|null)=>server.groups?.find(item=>item.id===id)?.name??server.groupName??'';
 return {scope:{type:'device',id:server.id,name:server.name},canEdit:false,reason:null,
  direct:tags.filter(tag=>!tag.inherited).map((tag,index)=>({id:`demo-${index}`,name:tag.name,value:tag.value,inherit:false,updatedAt:0,overrides:null})),
  inherited:tags.filter(tag=>tag.inherited).map(tag=>({name:tag.name,value:tag.value,origin:{type:'group',id:tag.groupId??'',name:group(tag.groupId),visible:false}}))};
}

/** The tag names and values of the objects the viewer may view, for the input suggestions; [] while loading or after a failure. */
export function useTagSuggestions(enabled:boolean):TagSuggestions['names']{
 const [names,setNames]=useState<TagSuggestions['names']>([]);
 useEffect(()=>{
  if(!enabled)return;
  let live=true;
  api<TagSuggestions>(`${endpoint}/suggestions`).then(result=>{if(live)setNames(result.names);},()=>{});
  return ()=>{live=false;};
 },[enabled]);
 return names;
}

type Props={
 scope:TagsScope;
 /** Name of the device or group as the user knows it. */
 scopeName:string;
 demo:boolean;
 /** The view in demo mode (sample devices), without a request. */
 demoView?:TagView;
 /** Reloads the console data after a change, so the fleet table and filter follow at once. */
 onRefresh:()=>Promise<void>|void;
 /** Opens the Tags tab of an origin group. */
 onOpenOrigin:(groupId:string)=>void;
};

export default function TagsPanel({scope,scopeName,demo,demoView,onRefresh,onOpenOrigin}:Props){
 const t=useT(),[locale]=useLocale();
 const key=`${scope.type}:${scope.id}`;
 const [loaded,setLoaded]=useState<{key:string;view:TagView}|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[busy,setBusy]=useState(false);
 const [editing,setEditing]=useState<DirectTag|'new'|null>(null);
 const sequence=useRef(0),mounted=useRef(true);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 const load=useCallback(async()=>{
  if(demo)return;
  const current=++sequence.current;setLoading(true);
  try{
   const view=await api<TagView>(`${endpoint}?${new URLSearchParams({scopeType:scope.type,scopeId:scope.id})}`);
   if(mounted.current&&current===sequence.current){setLoaded({key,view});setError('');}
  }catch(failure){if(mounted.current&&current===sequence.current)setError(message(failure,locale));}
  finally{if(mounted.current&&current===sequence.current)setLoading(false);}
 },[demo,key,scope.type,scope.id,locale]);
 useEffect(()=>{queueMicrotask(()=>void load());},[load]);
 const suggestions=useTagSuggestions(!demo&&editing!==null);
 const view=demo?demoView??{scope:{type:scope.type,id:scope.id,name:scopeName},direct:[],inherited:[],canEdit:false,reason:null}:loaded?.key===key?loaded.view:null;
 // Why changes are impossible here at all (sample devices, missing right); busy only pauses them.
 const locked=demo?t('kit.unavailable.demo'):view&&!view.canEdit?t(scope.type==='group'?'tags.groupNoRight':'device.metadata.noRight'):undefined;
 const blocked=locked??(busy?t('fleet.menu.saving'):undefined);
 const send=async(body:Record<string,unknown>,success:MessageKey)=>{
  setBusy(true);
  try{await api(endpoint,{scopeType:scope.type,scopeId:scope.id,...body});toast.success(t(success));await Promise.all([load(),onRefresh()]);return true;}
  catch(failure){toast.error(tagFailure(failure,t,{scopeType:scope.type}));if(failure instanceof ApiError&&failure.code==='TAG_CHANGED')void load();return false;}
  finally{if(mounted.current)setBusy(false);}
 };
 const remove=(tag:DirectTag,success:MessageKey)=>{if(blocked)return;void send({action:'remove-tag',tagId:tag.id,expected:tag.updatedAt},success);};
 const add=()=>{if(!blocked)setEditing('new');};

 return <AnalysisTab title={t('tags.title')} description={t('tags.meta')} actions={<Btn icon={Plus} blocked={blocked} onClick={add}>{t('tags.add')}</Btn>} className="sdx-tags">
  {error&&<LoadFailed text={t('tags.loadFailed')} loading={loading} onRetry={()=>void load()}/>}
  {!view?(!error&&<FirstLoad label={t('tags.loading')} rows={3} loading={loading} onRetry={()=>void load()}/>)
   :<TagsTable view={view} blocked={blocked} busy={loading} onAdd={add} onEdit={tag=>{if(!blocked)setEditing(tag);}} onRemove={tag=>remove(tag,'tags.removed')} onReset={tag=>remove(tag,'tags.reset')} onOpenOrigin={onOpenOrigin}/>}
  <TagDrawer key={editing==='new'?'new':editing?.id??''} open={editing!==null&&!locked} scopeType={scope.type} tag={editing==='new'?null:editing} busy={busy} suggestions={suggestions} onClose={()=>setEditing(null)}
   onSave={draft=>{const tag=editing==='new'?null:editing;void send({action:'set-tag',tagId:tag?.id??null,expected:tag?.updatedAt??null,...draft},'tags.saved').then(done=>{if(done)setEditing(null);});}}/>
 </AnalysisTab>;
}

type TableActions={blocked?:string;onAdd:()=>void;onEdit:(tag:DirectTag)=>void;onRemove:(tag:DirectTag)=>void;onReset:(tag:DirectTag)=>void;onOpenOrigin:(groupId:string)=>void};
/**
 * Two cards (nodiverna-ui §7, "one list, two sections"): "Direct" with the editable tags of this object and,
 * only when some exist, "Inherited" with the tags of higher groups, nearest origin first (the server's order).
 * In a group a direct tag that passes down says so; an override shows "Changed" and the inherited value.
 */
export function TagsTable({view,blocked,busy,onAdd,onEdit,onRemove,onReset,onOpenOrigin}:{view:TagView;busy?:boolean}&TableActions){
 const t=useT(),group=view.scope.type==='group';
 const value=(text:string)=>text?<span className="sdx-tag-value">{text}</span>:<span className="sdx-muted-cell">{t('tags.noValue')}</span>;
 const directMenu=(tag:DirectTag):MenuEntry[]=>[
  {id:'edit',label:t('tags.edit'),icon:Pencil,blocked,onSelect:()=>onEdit(tag)},
  ...(tag.overrides?[{id:'reset',label:t('tags.resetToInherited'),icon:RotateCcw,blocked,onSelect:()=>{if(!blocked)onReset(tag);}}]:[]),
  {id:'separator',separator:true},
  {id:'remove',label:t('tags.remove'),icon:Trash2,danger:true,blocked,onSelect:()=>{if(!blocked)onRemove(tag);}},
 ];
 const inheritedMenu=(tag:InheritedTag):MenuEntry[]=>[
  ...(tag.origin.visible?[{id:'origin',label:t('tags.openOrigin'),icon:ArrowUpRight,onSelect:()=>onOpenOrigin(tag.origin.id)}]:[]),
  {id:'edit',label:t('tags.edit'),icon:Pencil,blocked:t('tags.lockedAt',{origin:tagOriginLabel(tag.origin,t)})},
 ];
 const directColumns:DataColumn<DirectTag>[]=[
  {id:'name',label:t('tags.column.name'),primary:true,className:'sdx-tag-name',cell:tag=><><strong>{tag.name}</strong>{group&&tag.inherit&&<> <span className="sdx-tag">{t('tags.passesDown')}</span></>}</>},
  {id:'value',label:t('tags.column.value'),className:'sdx-tag-value-cell',cell:tag=>tag.overrides
   ?<span className="sdx-cell-stack"><span>{value(tag.value)} <span className="sdx-tag sdx-tag-changed">{t('tags.overrides')}</span></span><small>{t('tags.inheritedValue',{value:tag.overrides.value||t('tags.noValue'),origin:tagOriginLabel(tag.overrides.origin,t)})}</small></span>
   :value(tag.value)},
  {id:'actions',label:t('tags.column.actions'),hideLabel:true,className:'sdx-col-actions',cell:tag=><Menu label={t('tags.actionsFor',{name:tag.name})} entries={directMenu(tag)}/>},
 ];
 const inheritedColumns:DataColumn<InheritedTag>[]=[
  {id:'name',label:t('tags.column.name'),primary:true,className:'sdx-tag-name',cell:tag=><strong>{tag.name}</strong>},
  {id:'value',label:t('tags.column.value'),className:'sdx-tag-value-cell',cell:tag=>value(tag.value)},
  {id:'origin',label:t('tags.column.origin'),className:'sdx-tag-origin-cell',cell:tag=><InheritedOrigin label={tagOriginLabel(tag.origin,t)} onOpen={tag.origin.visible?()=>onOpenOrigin(tag.origin.id):undefined}/>},
  {id:'actions',label:t('tags.column.actions'),hideLabel:true,className:'sdx-col-actions',cell:tag=><Menu label={t('tags.actionsFor',{name:tag.name})} entries={inheritedMenu(tag)}/>},
 ];
 const addAction=<Btn icon={Plus} blocked={blocked} onClick={onAdd}>{t('tags.add')}</Btn>;
 const directEmpty:EmptyProps=view.inherited.length
  ?{icon:Tag,title:t('tags.emptyDirect'),children:t('tags.emptyDirectText'),action:addAction}
  :{icon:Tag,title:t('tags.empty'),children:t('tags.emptyHint'),action:addAction};
 return <>
  <Card title={t('tags.section.direct')} icon={Tag} iconTone="accent" flush>
   <DataTable<DirectTag> label={t('tags.table.direct')} variant="flush" cards entranceId="tag-direct-rows" columns={directColumns} rows={view.direct} rowKey={tag=>tag.id} empty={directEmpty} busy={busy}/>
  </Card>
  {view.inherited.length>0&&<Card title={t('tags.section.inherited')} icon={ArrowUpRight} iconTone="neutral" flush>
   <DataTable<InheritedTag> label={t('tags.table.inherited')} variant="flush" cards columns={inheritedColumns} rows={view.inherited} rowKey={tag=>tag.origin.id+':'+tag.name} empty={{icon:ArrowUpRight,title:t('tags.emptyDirect')}} busy={busy}/>
  </Card>}
 </>;
}

const problemText=(problems:TagProblems,field:'name'|'value',t:Translate)=>{
 const problem=problems[field];
 if(!problem)return '';
 if(problem==='required')return t('tags.error.nameRequired');
 if(problem==='too-long')return t(field==='name'?'tags.error.nameTooLong':'tags.error.valueTooLong');
 return t('tags.error.invalid');
};
/** Name and value fields with suggestions and counters; shared by the tag drawer, the bulk drawer and the device header (device-tags.tsx). */
export function TagFields({draft,onChange,problems,submitted,busy,suggestions,autoFocus=true}:{draft:TagDraft;onChange:(draft:TagDraft)=>void;problems:TagProblems;submitted:boolean;busy:boolean;suggestions:TagSuggestions['names'];autoFocus?:boolean}){
 const t=useT(),id=useId();
 const values=suggestions.find(entry=>tagKey(entry.name)===tagKey(draft.name.trim()))?.values??[];
 const field=(name:'name'|'value')=>{
  const error=submitted?problemText(problems,name,t):'',max=name==='name'?tagNameMax:tagValueMax,count=tagLength(draft[name].trim());
  return <label className="sdx-field" htmlFor={`${id}-${name}`}>
   <span>{t(name==='name'?'tags.field.name':'tags.field.value')}</span>
   <input id={`${id}-${name}`} autoFocus={name==='name'&&autoFocus} list={`${id}-${name}-list`} autoComplete="off" value={draft[name]} disabled={busy} aria-invalid={!!error||undefined} aria-describedby={`${id}-${name}-count`} onChange={event=>onChange({...draft,[name]:event.target.value})}/>
   <datalist id={`${id}-${name}-list`}>{(name==='name'?suggestions.map(entry=>entry.name):values).map(option=><option key={option} value={option}/>)}</datalist>
   <span className="sdx-field-foot">{error?<span className="sdx-field-error">{error}</span>:<span/>}<small id={`${id}-${name}-count`} className={cx('sdx-counter',count>max&&'sdx-counter-over')}>{t('tags.field.counter',{count,max})}</small></span>
  </label>;
 };
 return <>{field('name')}{field('value')}</>;
}

/** "Add tag" and "Edit tag": name, value and, for groups, the inheritance switch. */
function TagDrawer({open,scopeType,tag,busy,suggestions,onClose,onSave}:{open:boolean;scopeType:TagScopeType;tag:DirectTag|null;busy:boolean;suggestions:TagSuggestions['names'];onClose:()=>void;onSave:(draft:TagDraft)=>void}){
 const t=useT(),formId=useId();
 const [draft,setDraft]=useState<TagDraft>(()=>({name:tag?.name??'',value:tag?.value??'',inherit:tag?.inherit??false})),[submitted,setSubmitted]=useState(false);
 const result=validateTag(draft,scopeType),problems=result.ok?{}:result.problems;
 const unchanged=!!tag&&result.ok&&result.tag.name===tag.name&&result.tag.value===tag.value&&result.tag.inherit===tag.inherit;
 const saveBlocked=unchanged?t('common.noChanges'):submitted&&!result.ok?t('tags.error.invalid'):undefined;
 const submit=(event:FormEvent)=>{event.preventDefault();setSubmitted(true);if(result.ok&&!unchanged&&!busy)onSave(result.tag);};
 return <Drawer open={open} onClose={onClose} title={t(tag?'tags.edit':'tags.add')}
  footer={<><Btn onClick={onClose} disabled={busy}>{t('common.cancel')}</Btn><Btn variant="primary" type="submit" form={formId} loading={busy} blocked={saveBlocked}>{t('common.save')}</Btn></>}>
  <form id={formId} className="sdx-form-grid" noValidate onSubmit={submit}>
   <TagFields draft={draft} onChange={setDraft} problems={problems} submitted={submitted} busy={busy} suggestions={suggestions}/>
   {scopeType==='group'&&<div className="sdx-switch-field">
    <label><input type="checkbox" role="switch" checked={draft.inherit} disabled={busy} aria-describedby={`${formId}-inherit`} onChange={event=>setDraft({...draft,inherit:event.target.checked})}/>{t('tags.field.inherit')}</label>
    <small id={`${formId}-inherit`}>{t('tags.field.inheritHint')}</small>
   </div>}
  </form>
 </Drawer>;
}

/** The devices among `devices` on which the viewer lacks the right to change tags. */
export const devicesWithoutTagRight=(devices:readonly Device[],viewer:Viewer)=>devices.filter(device=>!permitted(device,viewer,'groups.manage'));
/** The direct tag names of the devices, de-duplicated without regard to case, with the number of devices that have each. */
export function directTagNames(devices:readonly Device[]):{name:string;count:number}[]{
 const names=new Map<string,{name:string;devices:Set<string>}>();
 for(const device of devices)for(const tag of device.tags??[]){
  if(tag.inherited)continue;
  const entry=names.get(tagKey(tag.name))??{name:tag.name,devices:new Set<string>()};
  entry.devices.add(device.id);names.set(tagKey(tag.name),entry);
 }
 return [...names.values()].map(entry=>({name:entry.name,count:entry.devices.size})).sort(compareTagNames);
}

/** The bulk drawers of the fleet: one tag on the selected devices, or one direct tag removed from them. */
export function BulkTagDrawer({mode,devices,viewer,onClose,onDone}:{mode:'add'|'remove'|null;devices:Device[];viewer:Viewer;onClose:()=>void;onDone:()=>void}){
 const t=useT(),formId=useId();
 const [draft,setDraft]=useState<TagDraft>({name:'',value:'',inherit:false}),[pick,setPick]=useState(''),[submitted,setSubmitted]=useState(false),[busy,setBusy]=useState(false);
 const suggestions=useTagSuggestions(mode==='add');
 const result=validateTag(draft,'device'),names=mode==='remove'?directTagNames(devices):[];
 const close=()=>{if(busy)return;setDraft({name:'',value:'',inherit:false});setPick('');setSubmitted(false);onClose();};
 const submit=async(event:FormEvent)=>{
  event.preventDefault();setSubmitted(true);
  if(busy||(mode==='add'?!result.ok:!pick))return;
  setBusy(true);
  try{
   const serverIds=devices.map(device=>device.id);
   const answer=await api<{changed:number}>(endpoint,mode==='add'&&result.ok?{action:'bulk-set-tag',serverIds,name:result.tag.name,value:result.tag.value}:{action:'bulk-remove-tag',serverIds,name:pick});
   toast.success(t(mode==='add'?'tags.bulk.added':'tags.bulk.removed',{count:answer.changed}));
   setBusy(false);close();onDone();
  }catch(failure){toast.error(tagFailure(failure,t,{bulk:true,missingRight:devicesWithoutTagRight(devices,viewer).length}));setBusy(false);}
 };
 const count=devices.length;
 return <Drawer open={mode!==null} onClose={close} title={t(mode==='remove'?'tags.bulk.removeTitle':'tags.bulk.addTitle',{count})} description={t(mode==='remove'?'tags.bulk.removeHint':'tags.bulk.addHint')}
  footer={<><Btn onClick={close} disabled={busy}>{t('common.cancel')}</Btn><Btn variant="primary" type="submit" form={formId} loading={busy} blocked={mode==='remove'&&!pick?names.length?t('tags.bulk.pickReason'):t('tags.bulk.noDirect'):submitted&&mode==='add'&&!result.ok?t('tags.error.invalid'):undefined}>{t(mode==='remove'?'tags.bulk.remove':'tags.bulk.add')}</Btn></>}>
  <form id={formId} className="sdx-form-grid" noValidate onSubmit={event=>void submit(event)}>
   {mode==='add'&&<TagFields draft={draft} onChange={setDraft} problems={result.ok?{}:result.problems} submitted={submitted} busy={busy} suggestions={suggestions}/>}
   {mode==='remove'&&(names.length?<div className="sdx-pick-list" role="radiogroup" aria-label={t('tags.bulk.pick')}>
    {names.map(entry=><PickRow key={entry.name} selected={tagKey(pick)===tagKey(entry.name)} icon={<Tag size={15} aria-hidden/>} label={entry.name} hint={t('tags.bulk.onDevices',{count:entry.count})} onSelect={()=>setPick(entry.name)}/>)}
   </div>:<p className="sdx-muted-cell">{t('tags.bulk.noDirect')}</p>)}
  </form>
 </Drawer>;
}

/** The tag cell of the fleet table: up to three chips, then "+N"; the title lists every tag, inherited ones with their origin. */
export function TagChips({tags,groups,limit=3}:{tags:readonly EffectiveTag[]|undefined;groups?:readonly {id:string;name:string}[];limit?:number}){
 const t=useT();
 if(!tags?.length)return <span className="sdx-muted-cell">{EMPTY_VALUE}</span>;
 const title=(tag:EffectiveTag)=>tag.inherited?t('fleet.tags.inheritedChip',{tag:tagLabel(tag),group:groups?.find(group=>group.id===tag.groupId)?.name??t('tags.section.inherited')}):tagLabel(tag);
 const rest=tags.length-limit;
 return <span className="sdx-tag-chips" title={tags.map(title).join('\n')}>
  {tags.slice(0,limit).map(tag=><span key={tag.name} className={cx('sdx-tag',tag.inherited&&'sdx-tag-inherited')} title={title(tag)}><span className="sdx-tag-text">{tagLabel(tag)}</span></span>)}
  {rest>0&&<span className="sdx-tag-more">{t('fleet.tags.more',{count:rest})}</span>}
 </span>;
}
