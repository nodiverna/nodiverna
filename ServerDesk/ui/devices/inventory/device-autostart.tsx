'use client';
// The device area Management → Autostart (docs/device-health-signals.md): the
// programs that start automatically, from GET /api/autostart/device, with the
// filter All / New / Suspicious (a Segmented with counts), the details drawer of an entry and the
// confirmation of new entries as known (POST /api/autostart/device, right
// manage, audited). Sample devices get their list in the browser and cannot
// confirm. Paths break only after a separator (ui/devices/inventory/path-wrap.ts).
import {Fragment,useEffect,useMemo,useRef,useState} from 'react';
import {toast} from 'sonner';
import {AlertTriangle,CheckCheck,RefreshCw,Rocket,ShieldAlert} from 'lucide-react';
import type {AutostartCategory,Server,Viewer} from '@/lib/types';
import type {AutostartConfirmReason,AutostartEntry,DeviceAutostartView} from '@/lib/server/devices/autostart';
import {demoAutostartView} from '@/ui/shell/demo';
import {unavailableReason} from '@/ui/devices/device/device-unavailable';
import {pathBreakParts} from '@/ui/devices/inventory/path-wrap';
import {EMPTY_VALUE,formatDate} from '@/lib/i18n/format';
import type {MessageKey} from '@/lib/i18n/translate';
import {api,ApiError,message,permitted,type Device} from '@/ui/base/api';
import {Btn,Card,Drawer,Empty,Facts,Notice,PanelUnavailable,SectionHead,Segmented,Skeleton,exactTime,type SegmentItem} from '@/ui/kit/kit';
import {BulkBar,DataTable,Toolbar,type DataColumn} from '@/ui/kit/data-table';
import {useLocale,useT,type Translate} from '@/ui/base/locale';
import {SignatureCell} from '@/ui/devices/inventory/health-table';

type Filter='all'|'new'|'suspicious';
const categoryKeys:Record<AutostartCategory,MessageKey>={run:'autostart.category.run','run-once':'autostart.category.runOnce','startup-folder':'autostart.category.startupFolder',winlogon:'autostart.category.winlogon',service:'autostart.category.service',task:'autostart.category.task'};
export const autostartCategoryKey=(category:AutostartCategory)=>categoryKeys[category];
const reasonKeys:Record<AutostartConfirmReason,MessageKey>={right:'autostart.blockedRight','read-only':'autostart.blockedReadOnly'};

/** The localized text of a failed confirmation, by error code. */
export function autostartFailure(failure:unknown,t:Translate):string{
 if(failure instanceof ApiError){
  if(failure.code==='AUTOSTART_CHANGED')return t('autostart.error.changed');
  if(failure.code==='AUTOSTART_NOTHING_TO_CONFIRM')return t('autostart.error.nothingToConfirm');
  if(failure.status===403&&!failure.code)return t('autostart.blockedRight');
 }
 return message(failure);
}

/** A path or command line that breaks only after "\", "/" or a space (<wbr> between the parts), never inside a file name. */
export function PathText({text}:{text:string}){
 return <span className="mono sdx-path">{pathBreakParts(text).map((part,index)=><Fragment key={index}>{index>0&&<wbr/>}{part}</Fragment>)}</span>;
}

/** The table status on one line: "New since <date>", "Confirmed <date>" (the actor is in the drawer) or "Known since first report". */
function StatusCell({entry}:{entry:AutostartEntry}){
 const t=useT(),[locale]=useLocale();
 if(entry.isNew)return <span className="sdx-tag sdx-tag-changed sdx-nowrap">{t('autostart.status.new',{date:formatDate(locale,entry.firstSeen)})}</span>;
 if(entry.acknowledgedAt!==null)return <span className="sdx-muted-cell sdx-nowrap">{t('autostart.status.confirmedShort',{date:formatDate(locale,entry.acknowledgedAt)})}</span>;
 return <span className="sdx-muted-cell">{t('autostart.status.baseline')}</span>;
}

export default function DeviceAutostart({server,viewer,demo,now,onRefresh}:{server:Server;viewer:Viewer;demo:boolean;now:number;/** Reloads the console data, so the autostart issues follow at once. */onRefresh?:()=>Promise<void>|void}){
 const t=useT(),[locale]=useLocale();
 const [filter,setFilter]=useState<Filter>('all'),[selection,setSelection]=useState<string[]>([]),[busy,setBusy]=useState(false),[openId,setOpenId]=useState<string|null>(null);
 const [loaded,setLoaded]=useState<{id:string;data:DeviceAutostartView}|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[revision,setRevision]=useState(0);
 const sequence=useRef(0);
 useEffect(()=>{
  if(demo)return;
  const current=++sequence.current;queueMicrotask(()=>setLoading(true));
  api<DeviceAutostartView>(`/api/autostart/device?${new URLSearchParams({id:server.id})}`)
   .then(data=>{if(current===sequence.current){setLoaded({id:server.id,data});setError('');}},failure=>{if(current===sequence.current)setError(message(failure,locale));})
   .finally(()=>{if(current===sequence.current)setLoading(false);});
 },[demo,server.id,locale,revision]);
 // "Try again" repeats exactly the failed GET; the rows already shown stay.
 const retry=()=>setRevision(value=>value+1);
 const data=demo?demoAutostartView(server.id,now):loaded?.id===server.id?loaded.data:null;
 const all=useMemo(()=>data?.items??[],[data]);
 const counts={all:all.length,new:all.filter(item=>item.isNew).length,suspicious:all.filter(item=>item.suspicious).length};
 const items=all.filter(item=>filter==='all'||filter==='new'&&item.isNew||filter==='suspicious'&&item.suspicious);
 const chosen=selection.filter(id=>all.some(item=>item.id===id&&item.isNew));
 const opened=openId?all.find(item=>item.id===openId)??null:null;
 const blocked=demo?t('kit.unavailable.demo'):data&&!data.canConfirm?t(reasonKeys[data.reason??'right']):undefined;
 const blockedAll=blocked??(counts.new?undefined:t('autostart.nothingNew'));
 const reported=server.snapshot?.autostartChecksum!==undefined;
 // One panel notice (nodiverna-ui §5): sample device or missing right. The session reason read-only stays on the buttons.
 const notice=unavailableReason({demo,revoked:!!server.revoked,permitted:permitted(server as Device,viewer,'manage'),reported:true,supported:true});
 const confirm=async(body:Record<string,unknown>)=>{
  if(busy)return;
  setBusy(true);
  try{
   const result=await api<{ok:true;count:number}>('/api/autostart/device',{...body,id:server.id});
   toast.success(t('autostart.confirmed',{count:result.count}));setSelection([]);setRevision(value=>value+1);await onRefresh?.();
  }catch(failure){toast.error(autostartFailure(failure,t));if(failure instanceof ApiError&&failure.code==='AUTOSTART_CHANGED')setRevision(value=>value+1);}
  finally{setBusy(false);}
 };
 // The filters with their counts; New warns and Suspicious is critical only while they have entries.
 const filterItems:SegmentItem<Filter>[]=[
  {id:'all',label:t('autostart.filter.all'),count:counts.all},
  {id:'new',label:t('autostart.filter.new'),count:counts.new,...(counts.new>0?{tone:'warning' as const}:{})},
  {id:'suspicious',label:t('autostart.filter.suspicious'),count:counts.suspicious,...(counts.suspicious>0?{tone:'critical' as const}:{})},
 ];
 const columns:DataColumn<AutostartEntry>[]=[
  {id:'entry',label:t('autostart.col.entry'),primary:true,wrap:true,cell:item=><span className="sdx-cell-stack"><strong>{item.name}</strong>{item.suspicious&&<small className="sdx-cell-note"><ShieldAlert size={12} aria-hidden/> {t('autostart.filter.suspicious')}</small>}</span>},
  {id:'type',label:t('autostart.col.type'),hideBelow:1100,cell:item=>t(categoryKeys[item.category])},
  {id:'program',label:t('autostart.col.program'),className:'sdx-path-cell',cell:item=><PathText text={item.target??item.command??EMPTY_VALUE}/>},
  {id:'signature',label:t('autostart.col.signature'),cell:item=><SignatureCell signature={item.signature} signer={item.signer} publisher={item.publisher}/>},
  {id:'status',label:t('autostart.col.status'),cell:item=><StatusCell entry={item}/>},
 ];
 const retryButton=<Btn size="sm" icon={RefreshCw} loading={loading} onClick={retry}>{t('common.retry')}</Btn>;
 const statusText=(entry:AutostartEntry)=>entry.isNew?t('autostart.status.new',{date:formatDate(locale,entry.firstSeen)}):entry.acknowledgedAt!==null?t('autostart.status.confirmed',{date:formatDate(locale,entry.acknowledgedAt),actor:entry.acknowledgedBy??''}):t('autostart.status.baseline');
 return <div className="sdx-health-panel sdx-device-autostart">
  <SectionHead hideTitle title={t('autostart.title')} description={t('autostart.meta')} meta={data?.state?t('software.reportedAt',{time:exactTime(data.state.reportedAt,locale)}):undefined}
   actions={data?.state?<Btn icon={CheckCheck} loading={busy} blocked={blockedAll} onClick={()=>void confirm({action:'confirm-all',expected:data.state!.checksum})}>{t('autostart.confirmAll')}</Btn>:undefined}/>
  <PanelUnavailable reason={notice} readOnly={t('autostart.readOnly')}/>
  {error&&<Notice tone="danger" icon={AlertTriangle} action={retryButton}>{t('autostart.loadFailed')}</Notice>}
  {data?.state?.truncated&&<Notice tone="info" icon={Rocket}>{t('autostart.truncated')}</Notice>}
  <Card title={t('autostart.listTitle')} icon={Rocket} iconTone="accent" className="sdx-health-card" flush>
   {!data?(error?null:<Skeleton variant="table" label={t('autostart.loading')} after={15000} action={retryButton}/>)
    :!data.state?<Empty icon={Rocket} title={t('autostart.empty')}>{reported?undefined:t('autostart.notReported')}</Empty>
    :<>
     {/* The list filter sits in the list's own Toolbar; only new entries can be confirmed, so only they carry a checkbox. */}
     <DataTable variant="flush" cards label={t('autostart.tableLabel')} className="sdx-autostart-table" columns={columns} rows={items} rowKey={item=>item.id} busy={loading} entranceId={'device-autostart:'+server.id}
      toolbar={<Toolbar filters={<Segmented<Filter> label={t('autostart.title')} size="sm" value={filter} onChange={setFilter} items={filterItems}/>}/>}
      selection={{selected:chosen,onChange:setSelection,selectable:item=>item.isNew,rowLabel:item=>t('autostart.selectEntry',{name:item.name}),allLabel:t('autostart.col.select')}}
      onOpen={item=>setOpenId(item.id)} openLabel={item=>t('autostart.open',{name:item.name})}
      empty={{icon:Rocket,title:all.length?t('autostart.noMatch'):t('autostart.empty')}}
      foot={t('autostart.foot',{shown:items.length,count:all.length})}/>
     <BulkBar count={chosen.length} onClear={()=>setSelection([])}>
      <Btn size="sm" icon={CheckCheck} loading={busy} blocked={blocked} onClick={()=>void confirm({action:'confirm',entryIds:chosen})}>{t('autostart.confirm')}</Btn>
     </BulkBar>
    </>}
  </Card>
  <Drawer open={!!opened} onClose={()=>setOpenId(null)} title={opened?.name??''}>
   {opened&&<Facts items={[
    {id:'type',label:t('autostart.col.type'),value:t(categoryKeys[opened.category])},
    {id:'location',label:t('autostart.col.location'),value:<PathText text={opened.location}/>},
    {id:'command',label:t('autostart.col.command'),value:opened.command?<PathText text={opened.command}/>:EMPTY_VALUE},
    {id:'target',label:t('autostart.col.target'),value:opened.target?<PathText text={opened.target}/>:EMPTY_VALUE},
    {id:'signature',label:t('autostart.col.signature'),value:<SignatureCell signature={opened.signature} signer={opened.signer} publisher={opened.publisher}/>},
    {id:'status',label:t('autostart.col.status'),value:statusText(opened)},
    {id:'firstSeen',label:t('autostart.firstSeen'),value:exactTime(opened.firstSeen,locale)},
   ]}/>}
  </Drawer>
 </div>;
}
