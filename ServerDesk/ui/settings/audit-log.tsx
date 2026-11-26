'use client';
// Settings › Audit log on the kit (nodiverna-ui §4 "Settings page", full-width table): the portal audit entries of
// the console load (the newest 100) in the shared ActivityTable with search, the "Action type" filter, paging and
// CSV, and "Load older entries" in the table foot, which appends the next 100 rows before the oldest loaded one
// (GET /api/console?audit=portal&before=<at>.<id>). The Area column shows only while a second customer exists
// (ConsoleData.multipleCustomers); with one customer its entries name no area. A console refresh replaces the rows with the newest 100 again. The page
// renders the header of its console frame (ui/shell/page-frame.ts) once at its top, also during the first load.
import {useState} from 'react';
import {toast} from 'sonner';
import type {AuditEntry} from '@/lib/types';
import {api,message,type Device} from '@/ui/base/api';
import {Btn,SettingsPage,Skeleton} from '@/ui/kit/kit';
import ActivityTable from '@/ui/devices/history/activity-table';
import {useT} from '@/ui/base/locale';
import {frameHeader,type PageFrame} from '@/ui/shell/page-frame';

/** The console loads this many portal entries, and each "Load older entries" as many more. */
export const auditPageLimit=100;
type Older={base:readonly AuditEntry[];rows:AuditEntry[];more:boolean};
const loadOlder=(before:AuditEntry,signal?:AbortSignal)=>api<{audit:AuditEntry[]}>(`/api/console?audit=portal&before=${before.at}.${before.id}`,undefined,signal);

export default function AuditLogPage({entries,servers=[],loading=false,load=loadOlder,multipleCustomers=false,frame}:{
 /** The newest portal entries of the console load (empty in demo mode). */
 entries:readonly AuditEntry[];servers?:readonly Pick<Device,'id'|'name'>[];
 /** The console's first load runs: the table Skeleton. */
 loading?:boolean;
 /** The read of the next older entries (tests replace it). */
 load?:(before:AuditEntry)=>Promise<{audit:AuditEntry[]}>;
 /** ConsoleData.multipleCustomers: a second customer exists. Only then the table shows the Area column. */
 multipleCustomers?:boolean;
 /** The console frame: the page header at the top of the page. */
 frame?:PageFrame}){
 const t=useT();
 const [older,setOlder]=useState<Older>({base:entries,rows:[],more:entries.length>=auditPageLimit}),[busy,setBusy]=useState(false);
 // A console refresh brings a new list: the older rows go and the newest load decides again whether more exist.
 const current=older.base===entries?older:{base:entries,rows:[],more:entries.length>=auditPageLimit};
 const rows=current.rows.length?[...entries,...current.rows]:entries;
 const loadMore=async()=>{
  const oldest=rows[rows.length-1];if(!oldest||busy)return;
  setBusy(true);
  try{
   const result=await load(oldest);
   setOlder({base:entries,rows:[...current.rows,...result.audit],more:result.audit.length>=auditPageLimit});
  }catch(error){toast.error(message(error));}
  finally{setBusy(false);}
 };
 const table=loading?<Skeleton variant="table" label={t('access.auditLoading')}/>
  :<ActivityTable entries={rows} servers={servers} label={t('nav.settings.audit')} entranceId="audit-log" exportName="audit-log" limit={auditPageLimit} more={current.more}
   showArea={multipleCustomers} empty={{title:t('audit.emptyTitle'),hint:t('audit.emptyHint')}}
   footAction={current.more?<Btn size="sm" loading={busy} onClick={()=>void loadMore()}>{t('activity.loadOlder')}</Btn>:null}/>;
 return <>{frameHeader(frame)}<SettingsPage label={t('nav.settings.audit')} wide={table}/></>;
}
