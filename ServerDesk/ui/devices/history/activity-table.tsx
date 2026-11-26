'use client';
// The one table of audit entries (nodiverna-ui §4 "Table with sort, columns, filter and CSV"): the audit log page
// (ui/settings/audit-log.tsx) and the device access views of History (ui/devices/history/history.tsx). Each row shows the action
// in the viewer's language with its stable code as a mono second line (ui/devices/history/audit-display.ts), a readable target,
// and opens a detail drawer with the facts, the target's details and the stored target. The kit Toolbar holds the
// search, the "Action type" filter and the CSV export; the table pages 25 rows at a time.
import {useMemo,useRef,useState,type ReactNode} from 'react';
import type {MessageKey} from '@/lib/i18n/translate';
import {Download,ScrollText} from 'lucide-react';
import {toast} from 'sonner';
import type {AuditEntry} from '@/lib/types';
import {activityCategories,activityCsv,activityCsvFileName,activitySearchText,auditAreaText,auditActionView,auditTargetView,type ActivityCategory,type ActivityRowView} from '@/ui/devices/history/audit-display';
import {EMPTY_VALUE} from '@/lib/i18n/format';
import {jobActionLabel} from '@/ui/shell/console-jobs';
import {downloadText} from '@/ui/base/api';
import {Btn,CommandBlock,Drawer,DrawerCancel,Facts,IconBtn,exactTime,type FactItem} from '@/ui/kit/kit';
import {DataTable,Toolbar,type DataColumn} from '@/ui/kit/data-table';
import {pageWindow} from '@/ui/kit/data-table-model';
import {Select} from '@/ui/kit/field';
import {ResetAction} from '@/ui/kit/analysis-tab';
import {useLocale,useT} from '@/ui/base/locale';

export const activityPageSize=25;
type Row={entry:AuditEntry;key:string;view:ActivityRowView;device:string|null;area:string;search:string};

export type ActivityTableProps={
 entries:readonly AuditEntry[];
 /** The devices whose names the Device column, the target and the search use. */
 servers:readonly {id:string;name:string}[];
 /** The table's accessible name (and the region of the cards). */
 label:string;
 entranceId:string;
 /** The CSV file name prefix: audit-log or device-access. */
 exportName:'audit-log'|'device-access';
 /** The Device column (the scope view of several devices). */
 showDevice?:boolean;
 /** The Area column: Portal or the customer (the audit log with customer entries). */
 showArea?:boolean;
 /** The caller loads at most this many entries; at the limit the foot says they are the newest. */
 limit?:number;
 /** Older entries may exist beyond the loaded ones (default: the entries reach limit). */
 more?:boolean;
 /** The Empty state without any entries: a title that states the fact and one sentence. */
 empty:{title:string;hint?:ReactNode};
 /** Opens a device: the drawer's Device fact becomes a link (the scope view). */
 onOpenDevice?:(id:string)=>void;
 /** Controls before the "Action type" filter in the toolbar, for example the view Segmented of a device History. */
 filters?:ReactNode;
 /** A control in the foot after its text, for example "Load older entries". */
 footAction?:ReactNode;
 /** Today, for the CSV file name. */
 now?:number;
 /** The download of the CSV file (tests replace it). */
 download?:(name:string,text:string,type:string)=>void;
};

/** The label of an action in the viewer's language: the catalog label, the job's label, or the unknown code itself. */
export function useActionLabel(){
 const t=useT(),[locale]=useLocale();
 return (view:ReturnType<typeof auditActionView>)=>view.labelKey?t(view.labelKey):view.label==='job'&&view.jobKind?jobActionLabel(view.jobKind,locale,view.jobTarget):view.code;
}

export default function ActivityTable({entries,servers,label,entranceId,exportName,showDevice=false,showArea=false,limit,more,empty,onOpenDevice,filters,footAction,now=Date.now(),download=downloadText}:ActivityTableProps){
 const t=useT(),[locale]=useLocale(),actionLabel=useActionLabel();
 const [search,setSearch]=useState(''),[category,setCategory]=useState<'all'|ActivityCategory>('all'),[page,setPage]=useState(1),[openKey,setOpenKey]=useState('');
 const opener=useRef<HTMLElement|null>(null);
 const deviceNames=useMemo(()=>new Map(servers.map(server=>[server.id,server.name])),[servers]);
 // Labels follow the locale, so the rows are built on each render (a few hundred at most).
 const rows:Row[]=entries.map(entry=>{
  const action=auditActionView(entry.action),view:ActivityRowView={action,label:actionLabel(action),target:auditTargetView(entry,{deviceNames,locale})};
  const device=entry.serverId?deviceNames.get(entry.serverId)??null:null,area=auditAreaText(entry,locale);
  return {entry,key:String(entry.id),view,device,area,search:activitySearchText(entry,view,showDevice?device:showArea?area:null)};
 });
 const counts=new Map<ActivityCategory,number>();for(const row of rows)counts.set(row.view.action.category,(counts.get(row.view.action.category)??0)+1);
 // A chosen category that no row has any more (after a refresh) shows all again.
 const activeCategory=category!=='all'&&counts.has(category)?category:'all';
 const query=search.trim().toLocaleLowerCase(locale);
 const shown=rows.filter(row=>(activeCategory==='all'||row.view.action.category===activeCategory)&&(!query||row.search.includes(query)));
 const view=pageWindow(page,activityPageSize,shown.length),pageRows=shown.slice(view.from,view.to);
 const filtered=!!query||activeCategory!=='all';
 const reset=()=>{setSearch('');setCategory('all');setPage(1);};
 const open=rows.find(row=>row.key===openKey);

 const exportCsv=()=>{
  if(!shown.length)return;
  try{
   const header=[t('activity.csv.time'),t('activity.csv.account'),...(showDevice?[t('activity.csv.device')]:showArea?[t('activity.csv.area')]:[]),t('activity.csv.action'),t('activity.csv.code'),t('activity.csv.target')];
   const lines=shown.map(row=>[new Date(row.entry.at).toISOString(),row.entry.actor||'',...(showDevice?[row.device??'']:showArea?[row.area]:[]),row.view.label,row.view.action.code,row.view.target.text===EMPTY_VALUE?'':row.view.target.text]);
   download(activityCsvFileName(exportName,now),activityCsv(header,lines),'text/csv;charset=utf-8');
   toast.success(t('activity.exported',{count:shown.length}));
  }catch{toast.error(t('activity.exportFailed'));}
 };

 const time=(row:Row)=><time dateTime={new Date(row.entry.at).toISOString()}>{exactTime(row.entry.at,locale)}</time>;
 const actionCell=(row:Row)=>row.view.action.known||row.view.action.labelKey
  ?<span className="sdx-cell-stack sdx-activity-action"><strong>{row.view.label}</strong>{row.view.action.code&&<small className="mono">{row.view.action.code}</small>}</span>
  :<span className="mono">{row.view.action.code}</span>;
 const columns:DataColumn<Row>[]=[
  {id:'time',label:t('audit.time'),className:'sdx-cell-nowrap',cell:time},
  {id:'account',label:t('activity.col.account'),primary:true,className:'sdx-cell-nowrap',cell:row=>row.entry.actor||EMPTY_VALUE},
  ...(showDevice?[{id:'device',label:t('fleet.col.device'),className:'sdx-cell-nowrap',cell:(row:Row)=>row.device??EMPTY_VALUE}]:[]),
  ...(showArea?[{id:'area',label:t('activity.col.area'),className:'sdx-cell-nowrap',cell:(row:Row)=>row.area}]:[]),
  {id:'action',label:t('activity.col.action'),cell:actionCell},
  {id:'target',label:t('audit.target'),className:'sdx-activity-target',cell:row=><span className={row.view.target.mono?'sdx-cell-clamp mono':'sdx-cell-clamp'} title={row.view.target.text}>{row.view.target.text}</span>},
 ];
 // In card mode the action label is the card title; the table keeps the account as the open control.
 const cardColumns:DataColumn<Row>[]=[{id:'title',label:t('activity.col.action'),primary:true,table:false,cell:row=>row.view.label},...columns.map(column=>column.id==='action'?{...column,card:false}:column)];

 const toolbar=<Toolbar
  search={{value:search,onChange:value=>{setSearch(value);setPage(1);},label:t('activity.search.label'),placeholder:showDevice?t('activity.search.placeholder'):t('activity.search.placeholderDevice')}}
  filters={(filters||rows.length>0)&&<>{filters}{rows.length>0&&<Select size="sm" aria-label={t('activity.filter.category')} value={activeCategory} onChange={event=>{setCategory(event.target.value as 'all'|ActivityCategory);setPage(1);}}>
   <option value="all">{t('activity.category.all')}</option>
   {activityCategories.filter(id=>counts.has(id)).map(id=><option key={id} value={id}>{t('activity.category.option',{label:t(`activity.category.${id}` as MessageKey),count:counts.get(id)??0})}</option>)}
  </Select>}</>}
  actions={<IconBtn icon={Download} label={t('activity.export')} className="sdx-icon-btn-framed" blocked={shown.length?undefined:t('activity.export.none')} onClick={exportCsv}/>}/>;
 const newest=more??(limit!==undefined&&entries.length>=limit);
 const footText=t(newest?'activity.foot.newest':'history.access.foot',{shown:shown.length,count:entries.length});

 // The drawer: the facts of the row, the target's details and the stored target.
 const facts=(row:Row):FactItem[]=>[
  {id:'time',label:t('audit.time'),value:exactTime(row.entry.at,locale)},
  {id:'account',label:t('activity.col.account'),value:row.entry.actor||EMPTY_VALUE},
  ...(row.entry.serverId?[{id:'device',label:t('fleet.col.device'),value:onOpenDevice&&row.device?<Btn variant="ghost" size="sm" onClick={()=>{const id=row.entry.serverId!;setOpenKey('');onOpenDevice(id);}}>{t('fleet.openDevice',{name:row.device})}</Btn>:row.device??EMPTY_VALUE}]
   :[{id:'area',label:t('activity.col.area'),value:row.area}]),
  {id:'action',label:t('activity.col.action'),value:row.view.label},
  ...(row.view.action.code?[{id:'code',label:t('activity.detail.code'),value:row.view.action.code,mono:true}]:[]),
  ...(!row.view.action.known&&!row.view.action.code?[{id:'stored',label:t('activity.detail.storedAction'),value:row.entry.action}]:[]),
  {id:'target',label:t('audit.target'),value:row.view.target.text,mono:row.view.target.mono},
 ];
 const storedTarget=open?String(open.entry.target??''):'';

 return <>
  <DataTable<Row> label={label} cards entranceId={entranceId} columns={cardColumns} rows={pageRows} rowKey={row=>row.key} toolbar={toolbar}
   onOpen={row=>{opener.current=typeof document!=='undefined'&&document.activeElement instanceof HTMLElement?document.activeElement:null;setOpenKey(row.key);}} openLabel={row=>t('activity.open',{action:row.view.label})}
   empty={filtered?{icon:ScrollText,title:t('activity.noMatch'),action:<ResetAction label={t('activity.resetFilters')} onReset={reset}/>}:{icon:ScrollText,title:empty.title,children:empty.hint}}
   foot={<><span>{footText}</span>{footAction}</>}
   pagination={{page:view.page,pageSize:activityPageSize,total:shown.length,onPage:setPage}}/>
  <Drawer open={!!open} onClose={()=>setOpenKey('')} returnFocus={opener} icon={ScrollText} title={open?.view.label??''} description={open?exactTime(open.entry.at,locale):undefined} footer={<DrawerCancel label={t('common.close')}/>}>
   {open&&<div className="sdx-detail">
    <Facts items={facts(open)}/>
    {open.view.target.details.length>0&&<section className="sdx-detail-section" aria-label={t('activity.detail.details')}>
     <h3 className="sdx-detail-subhead">{t('activity.detail.details')}</h3>
     <Facts items={open.view.target.details.map((detail,index)=>({id:`${index}`,label:detail.label,value:detail.value,mono:true}))}/>
    </section>}
    {storedTarget&&storedTarget!==open.view.target.text&&<CommandBlock label={t('activity.detail.rawTarget')} command={storedTarget}/>}
   </div>}
  </Drawer>
 </>;
}
