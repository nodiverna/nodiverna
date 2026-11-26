'use client';
// OS support (docs/device-health-signals.md): the ESU drawer of a customer, a group
// or a device, and the scope tab "OS support" with the status filter, one row per
// catalog entry and the devices of a row. The server computes the status
// (osSupport in the console data) and resolves the ESU inheritance
// (GET /api/os-support/esu); this view only shows it.
import {useCallback,useEffect,useId,useMemo,useRef,useState,type FormEvent,type RefObject} from 'react';
import {toast} from 'sonner';
import {AlertTriangle,CalendarClock,ChevronRight,ExternalLink,RotateCcw,Search,Trash2} from 'lucide-react';
import type {OsSupport,Server} from '@/lib/types';
import {osLifecycleCatalog} from '@/lib/os-support';
import {formatSupportDate} from '@/ui/base/ui-device';
import {osSupportChannelKey,osSupportCounts,osSupportGroups,osSupportStatusRank,osSupportStatusTone,osSupportText,type HealthTone,type OsSupportFilter,type OsSupportGroup} from '@/ui/devices/inventory/health-signals';
import {EMPTY_VALUE} from '@/lib/i18n/format';
import {sortTableRows} from '@/ui/base/table-sort';
import type {MessageKey} from '@/lib/i18n/translate';
import {api,ApiError,message} from '@/ui/base/api';
import {Btn,Drawer,Notice,Segmented,Skeleton,StatusPill,type EmptyProps,type StatusKind} from '@/ui/kit/kit';
import {DataTable,Toolbar,type DataColumn,type TableSort} from '@/ui/kit/data-table';
import {AnalysisTab,ResetAction,RetryAction,ShowDevicesAction,worstTone} from '@/ui/kit/analysis-tab';
import {InheritedOrigin} from '@/ui/kit/inheritance';
import {useLocale,useT,type Translate} from '@/ui/base/locale';

export type EsuScope={type:'customer'|'group'|'device';id:string};
type EsuOriginView={type:'customer'|'group';id:string;name:string;visible?:boolean};
type EsuView={override:{until:string;updatedAt:number}|null;inherited:{until:string;origin:EsuOriginView}|null;effective:string|null;canEdit:boolean;reason:string|null};
type OriginOpeners={
 /** Opens a group on its OS support tab. */
 onOpenGroup?:(groupId:string)=>void;
 /** Opens a customer on its OS support tab; absent while the viewer has no customer view. */
 onOpenCustomer?:(customerId:string)=>void;
};
const endpoint='/api/os-support/esu';
export const toneKind:Record<HealthTone,StatusKind>={ok:'success',warning:'warning',critical:'critical',neutral:'neutral'};
const statusKeys:Record<OsSupport['status'],MessageKey>={supported:'osSupport.status.supported',ending:'osSupport.status.ending',ended:'osSupport.status.ended',unknown:'osSupport.status.unknown'};

/** The localized text of a failed ESU change, by error code. */
export function esuFailure(failure:unknown,t:Translate):string{
 if(failure instanceof ApiError){
  if(failure.code==='OS_ESU_INVALID')return t('osSupport.error.invalid');
  if(failure.code==='OS_ESU_CHANGED')return t('osSupport.error.changed');
  if(failure.status===403&&!failure.code)return t('osSupport.esu.blockedRight');
 }
 return message(failure);
}

/** Why the ESU date of the scope cannot change: sample devices, or the missing right (a customer needs the global alerts.manage). */
export function esuBlocked(view:Pick<EsuView,'canEdit'|'reason'>|null,demo:boolean,t:Translate):string|undefined{
 if(demo)return t('kit.unavailable.demo');
 if(!view||view.canEdit)return undefined;
 return t(view.reason==='customer-right'?'osSupport.esu.blockedCustomerRight':'osSupport.esu.blockedRight');
}
/**
 * The origin of an inherited ESU date, "Device group: …" or "Customer: …". It links to the scope's OS support tab when
 * the viewer may open it (a visible group, a customer with its customer view); else it is plain text.
 */
export function EsuOrigin({origin,onOpenGroup,onOpenCustomer,onBeforeOpen}:{origin:EsuOriginView;onBeforeOpen?:()=>void}&OriginOpeners){
 const t=useT();
 const open=origin.type==='customer'?onOpenCustomer:origin.visible!==false?onOpenGroup:undefined;
 return <InheritedOrigin label={t(origin.type==='customer'?'alertRules.origin.customer':'alertRules.origin.group',{name:origin.name})} onOpen={open?()=>{onBeforeOpen?.();open(origin.id);}:undefined} hint={null}/>;
}

/** The ESU drawer: date field, the inherited value with its origin, save, remove or reset to the inherited value. */
export function EsuDrawer({open,onClose,scope,demo,onRefresh,onOpenGroup,onOpenCustomer,returnFocus}:{open:boolean;onClose:()=>void;scope:EsuScope;demo:boolean;onRefresh:()=>Promise<void>|void;
 /** The button that opened the drawer; it gets the focus back on close. */
 returnFocus?:RefObject<HTMLElement|null>}&OriginOpeners){
 const t=useT(),[locale]=useLocale(),formId=useId();
 const [view,setView]=useState<EsuView|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[until,setUntil]=useState(''),[submitted,setSubmitted]=useState(false);
 const sequence=useRef(0);
 const load=useCallback(async()=>{
  if(demo)return;
  const current=++sequence.current;setLoading(true);
  try{const next=await api<EsuView>(`${endpoint}?${new URLSearchParams({scopeType:scope.type,scopeId:scope.id})}`);if(current===sequence.current){setView(next);setUntil(next.override?.until??'');setError('');}}
  catch(failure){if(current===sequence.current)setError(message(failure,locale));}
  finally{if(current===sequence.current)setLoading(false);}
 },[demo,scope.type,scope.id,locale]);
 useEffect(()=>{if(open)queueMicrotask(()=>{setSubmitted(false);void load();});},[open,load]);
 const blocked=esuBlocked(view,demo,t);
 const invalid=!/^\d{4}-\d{2}-\d{2}$/.test(until)||until<'2000-01-01'||until>'2040-12-31';
 const send=async(body:Record<string,unknown>,success:string)=>{
  setBusy(true);
  try{await api(endpoint,body);toast.success(success);await onRefresh();onClose();}
  catch(failure){toast.error(esuFailure(failure,t));if(failure instanceof ApiError&&failure.code==='OS_ESU_CHANGED')void load();}
  finally{setBusy(false);}
 };
 const save=(event:FormEvent)=>{event.preventDefault();setSubmitted(true);if(blocked||busy||invalid||!view)return;void send({action:'set-esu',scopeType:scope.type,scopeId:scope.id,until,expected:view.override?.updatedAt??null},t('osSupport.esu.saved'));};
 const clear=()=>{if(blocked||busy||!view?.override)return;void send({action:'clear-esu',scopeType:scope.type,scopeId:scope.id,expected:view.override.updatedAt},t('osSupport.esu.removed'));};
 const inherited=view?.inherited;
 return <Drawer open={open} onClose={onClose} returnFocus={returnFocus} title={t('osSupport.esu.drawerTitle')} description={t(scope.type==='customer'?'osSupport.esu.customerHint':scope.type==='group'?'osSupport.esu.groupHint':'osSupport.esu.hint')}
  footer={<>{view?.override&&<Btn icon={inherited?RotateCcw:Trash2} blocked={blocked} loading={busy} onClick={clear}>{t(inherited?'osSupport.esu.reset':'osSupport.esu.remove')}</Btn>}<Btn onClick={onClose}>{t('common.cancel')}</Btn><Btn variant="primary" type="submit" form={formId} blocked={blocked} loading={busy}>{t('common.save')}</Btn></>}>
  {demo?<Notice tone="info" icon={CalendarClock}>{t('kit.unavailable.demo')}</Notice>
   :error?<Notice tone="danger" icon={AlertTriangle} action={<RetryAction loading={loading} onRetry={()=>void load()}/>}>{t('osSupport.esu.loadFailed')}</Notice>
   :!view?<Skeleton variant="facts" rows={2} label={t('osSupport.esu.drawerTitle')} after={15000} action={<RetryAction loading={loading} onRetry={()=>void load()}/>}/>
   :<form id={formId} className="sdx-form-grid" onSubmit={save} noValidate>
    <label className="sdx-field"><span>{t('osSupport.esu.field')}</span>
     <input type="date" autoFocus min="2000-01-01" max="2040-12-31" value={until} disabled={!!blocked} aria-invalid={submitted&&invalid} onChange={event=>setUntil(event.target.value)}/>
     {submitted&&invalid?<small className="sdx-field-error">{t('osSupport.error.invalid')}</small>:<small>{t('osSupport.esu.hint')}</small>}
    </label>
    {view.override&&<p className="sdx-inline-note"><span className="sdx-tag sdx-tag-changed">{t('osSupport.esu.changed')}</span></p>}
    {inherited&&<div className="sdx-esu-inherited"><small>{t('osSupport.esu.inherited',{date:formatSupportDate(locale,inherited.until)})}</small><EsuOrigin origin={inherited.origin} onOpenGroup={onOpenGroup} onOpenCustomer={onOpenCustomer} onBeforeOpen={onClose}/></div>}
   </form>}
 </Drawer>;
}

/** A group or customer: the scopes whose OS support tab shows and sets their own ESU date. */
export type EsuTabScope={type:'customer'|'group';id:string};
/**
 * The ESU value of a group or a customer in its OS support tab, with the same actions as on a device: the effective
 * date, its origin while it is inherited (a customer has none above it) and "Set ESU date".
 */
export function ScopeEsu({scope,demo,onRefresh,...openers}:{scope:EsuTabScope;demo:boolean;onRefresh:()=>Promise<void>|void}&OriginOpeners){
 const t=useT(),[locale]=useLocale();
 const [view,setView]=useState<EsuView|null>(null),[open,setOpen]=useState(false),[revision,setRevision]=useState(0);
 useEffect(()=>{if(demo)return;let live=true;void api<EsuView>(`${endpoint}?${new URLSearchParams({scopeType:scope.type,scopeId:scope.id})}`).then(next=>{if(live)setView(next);},()=>{if(live)setView(null);});return()=>{live=false;};},[demo,scope.type,scope.id,revision]);
 const value=view?.override?.until??view?.inherited?.until;
 return <div className="sdx-esu-group">
  <span><small>{t(scope.type==='customer'?'osSupport.esu.customerValue':'osSupport.esu.groupValue')}</small><strong>{value?t('osSupport.esu',{date:formatSupportDate(locale,value)}):t('osSupport.esu.none')}</strong>{!view?.override&&view?.inherited&&<EsuOrigin origin={view.inherited.origin} {...openers}/>}</span>
  <Btn size="sm" icon={CalendarClock} blocked={esuBlocked(view,demo,t)} onClick={()=>setOpen(true)}>{t('osSupport.esu.menu')}</Btn>
  <EsuDrawer open={open} onClose={()=>setOpen(false)} scope={scope} demo={demo} onRefresh={async()=>{setRevision(value=>value+1);await onRefresh();}} {...openers}/>
 </div>;
}

export type OsSupportSortColumn='product'|'securityEnd'|'status'|'devices';
/** The default sort: the worst status first, the order of osSupportGroups. */
export const defaultOsSupportSort:TableSort<OsSupportSortColumn>={column:'status',direction:'asc'};
/** The rows in the sort: osSupportGroups order in, sortTableRows out. A row without a date sorts last. */
export function sortedOsSupportRows(rows:readonly OsSupportGroup[],sort:TableSort<OsSupportSortColumn>|null,name:(row:OsSupportGroup)=>string):OsSupportGroup[]{
 return sortTableRows(rows,sort,{product:name,securityEnd:row=>row.securityEnd,status:row=>osSupportStatusRank[row.status],devices:row=>row.deviceIds.length});
}

/** The scope tab "OS support": status counts, one row per catalog entry, the devices of a row in a drawer. */
export default function OsSupportTab({devices,esuScope,demo,onOpen,onRefresh,onOpenGroup,onOpenCustomer,onShowDevices}:{devices:Server[];
 /** The group or customer whose own ESU date the tab shows and sets; none for All devices and Ungrouped. */
 esuScope?:EsuTabScope;demo:boolean;onOpen:(id:string)=>void;onRefresh:()=>Promise<void>|void;
 /** Switches the view to its Devices tab (the empty state without devices). */
 onShowDevices:()=>void}&OriginOpeners){
 const t=useT(),[locale]=useLocale();
 const [filter,setFilter]=useState<OsSupportFilter>('all'),[openRow,setOpenRow]=useState<string|null>(null),[sort,setSort]=useState<TableSort<OsSupportSortColumn>>(defaultOsSupportSort);
 const counts=useMemo(()=>osSupportCounts(devices),[devices]);
 const total=useMemo(()=>osSupportGroups(devices).length,[devices]);
 const filtered=useMemo(()=>devices.filter(device=>filter==='all'||(device.osSupport?.status??'unknown')===filter),[devices,filter]);
 const rowName=(entry:OsSupportGroup['entry'])=>entry?`${entry.product} ${entry.version}`:t('osSupport.unknownRow');
 const groups=sortedOsSupportRows(osSupportGroups(filtered),sort,row=>rowName(row.entry));
 const row=groups.find(item=>item.key===openRow);
 const byId=new Map(devices.map(device=>[device.id,device]));
 const columns:DataColumn<OsSupportGroup>[]=[
  {id:'product',label:t('osSupport.col.product'),primary:true,sort:{first:'asc'},cell:item=>rowName(item.entry)},
  {id:'channel',label:t('osSupport.col.channel'),cell:item=><span className="sdx-muted-cell">{item.entry?t(osSupportChannelKey(item.entry.channel)):EMPTY_VALUE}</span>},
  {id:'securityEnd',label:t('osSupport.col.securityEnd'),mono:true,sort:{first:'asc'},cell:item=>item.securityEnd?formatSupportDate(locale,item.securityEnd):EMPTY_VALUE},
  {id:'status',label:t('osSupport.col.status'),sort:{first:'asc'},cell:item=><StatusPill kind={toneKind[osSupportStatusTone[item.status]]}>{t(statusKeys[item.status])}</StatusPill>},
  {id:'devices',label:t('osSupport.col.devices'),mono:true,align:'end',sort:{first:'desc'},cell:item=>item.deviceIds.length},
 ];
 const empty:EmptyProps=!devices.length
  ?{icon:CalendarClock,title:t('osSupport.empty'),children:t('fleet.analysis.noDevicesText'),action:<ShowDevicesAction onShowDevices={onShowDevices}/>}
  :{icon:Search,title:t('osSupport.noMatch'),children:t('fleet.analysis.noMatchText'),action:<ResetAction label={t('fleet.analysis.showAll')} onReset={()=>setFilter('all')}/>};
 const toolbar=<Toolbar filters={<Segmented<OsSupportFilter> label={t('osSupport.col.status')} size="sm" value={filter} onChange={setFilter} items={worstTone<OsSupportFilter>([{id:'all',label:t('osSupport.status.all'),count:counts.all},{id:'supported',label:t('osSupport.status.supported'),count:counts.supported,tone:'success'},{id:'ending',label:t('osSupport.status.ending'),count:counts.ending,tone:'warning'},{id:'ended',label:t('osSupport.status.ended'),count:counts.ended,tone:'critical'},{id:'unknown',label:t('osSupport.status.unknown'),count:counts.unknown,tone:'neutral'}],['ended','ending','unknown','supported'])}/>}/>;
 return <AnalysisTab title={t('osSupport.title')} description={t('osSupport.meta')} meta={t('osSupport.catalogAsOf',{date:formatSupportDate(locale,osLifecycleCatalog.asOf)})}
  actions={esuScope&&<ScopeEsu key={esuScope.type+':'+esuScope.id} scope={esuScope} demo={demo} onRefresh={onRefresh} onOpenGroup={onOpenGroup} onOpenCustomer={onOpenCustomer}/>}>
  <DataTable<OsSupportGroup> label={t('osSupport.title')} toolbar={toolbar} columns={columns} rows={groups} rowKey={item=>item.key}
   sort={sort} onSort={next=>setSort(next as TableSort<OsSupportSortColumn>)} onOpen={item=>setOpenRow(item.key)}
   empty={empty} foot={t('osSupport.foot',{count:total,shown:groups.length})} cards entranceId="os-support-rows"/>
  <Drawer open={!!row} onClose={()=>setOpenRow(null)} title={row?t('osSupport.devicesDrawer',{name:rowName(row.entry)}):''} description={row?.entry?<a href={row.entry.source} target="_blank" rel="noopener noreferrer" className="sdx-external"><ExternalLink size={12} aria-hidden/>{t('osSupport.source')}</a>:undefined}>
   {row&&<ul className="sdx-health-devices">{row.deviceIds.map(id=>{const device=byId.get(id);if(!device)return null;const text=osSupportText(device.osSupport,locale),esu=device.osSupport?.esu;return <li key={id}>
    <button type="button" onClick={()=>{setOpenRow(null);onOpen(id);}} aria-label={t('osSupport.openDevice',{name:device.name})}><span><strong>{device.name}</strong><small>{text.text}{esu?' · '+t('osSupport.esu',{date:formatSupportDate(locale,esu.until)}):''}</small></span><ChevronRight size={14} aria-hidden/></button>
   </li>;})}</ul>}
  </Drawer>
 </AnalysisTab>;
}
