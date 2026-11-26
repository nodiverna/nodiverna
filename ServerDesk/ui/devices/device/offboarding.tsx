'use client';
import {useEffect,useRef,useState} from 'react';
import {AlertTriangle,PackageX,RefreshCw,RotateCcw,Trash2} from 'lucide-react';
import type {Job} from '@/lib/types';
import type {Device} from '@/ui/base/api';
import {agentMessageText} from '@/lib/agent-messages';
import {AGENT_UNINSTALL_KIND,canUninstall,offboardingState,type OffboardingEntry,type OffboardingState} from '@/lib/offboarding';
import type {MessageKey,MessageParams} from '@/lib/i18n/translate';
import {Btn,Drawer,Notice,Skeleton,StatusPill,type StatusKind} from '@/ui/kit/kit';
import {useT} from '@/ui/base/locale';

// The offboarding drawer: the devices of one removal request with uninstall,
// from GET /api/console?offboarding=…, refreshed every 5 s while a row can
// still change. Rows that end failed or still registered can be removed
// without the uninstall or tried again. The device page shows the same state
// for one device from the console's job list (deviceUninstallNotice).

type Translate=(key:MessageKey,params?:MessageParams)=>string;
export const OFFBOARDING_POLL_MS=5000;
const stateKeys:Record<OffboardingState,MessageKey>={uninstalled:'console.offboarding.state.uninstalled',revoked:'console.offboarding.state.revoked',waiting:'console.offboarding.state.waiting',running:'console.offboarding.state.running',failed:'console.offboarding.state.failed',registered:'console.offboarding.state.registered'};
const stateKinds:Record<OffboardingState,StatusKind>={uninstalled:'success',revoked:'neutral',waiting:'waiting',running:'maintenance',failed:'critical',registered:'warning'};

/** Rows that keep the drawer polling: the uninstall can still start or the device is still registered. */
export const offboardingPolling=(rows:readonly Pick<OffboardingEntry,'state'>[])=>rows.some(row=>row.state==='waiting'||row.state==='running'||row.state==='registered');
/** Counts for the summary line: uninstalled, only revoked, still open (waiting, running, failed or registered). */
export function offboardingSummary(rows:readonly Pick<OffboardingEntry,'state'>[]){
 const uninstalled=rows.filter(row=>row.state==='uninstalled').length,revoked=rows.filter(row=>row.state==='revoked').length;
 return {uninstalled,revoked,open:rows.length-uninstalled-revoked};
}
/** The reason line of a failed row in the user's language. An agent failure shows its message code, else the stored text. */
export function offboardingReason(entry:Pick<OffboardingEntry,'state'|'reason'|'code'|'args'|'result'>,t:Translate):string|null{
 if(entry.state!=='failed')return null;
 if(entry.reason==='agent'){
  const coded=entry.code?agentMessageText({result:entry.result??null,resultCode:entry.code,resultArgs:entry.args??null},t):null;
  return coded??t('console.offboarding.reason.agentFallback',{message:entry.result??''});
 }
 return t(entry.reason==='offline'?'console.offboarding.reason.offline':entry.reason==='unsupported'?'console.offboarding.reason.unsupported':'console.offboarding.reason.cancelled');
}
/** The removal payload for the drawer's actions; uninstall:true for "Try again". */
export function offboardingPayload(ids:readonly string[],uninstall:boolean):Record<string,unknown>{
 const base=ids.length===1?{action:'remove-server',id:ids[0],confirm:true}:{action:'remove-servers',ids:[...ids],confirm:true};
 return uninstall?{...base,uninstall:true}:base;
}
const isOpen=(row:OffboardingEntry)=>row.state==='failed'||row.state==='registered';

/** The latest agent-uninstall job of a device from the console's job list, newest first. */
export function latestUninstallJob(serverId:string,jobs:readonly Job[]):Job|null{
 return jobs.filter(job=>job.serverId===serverId&&job.action===AGENT_UNINSTALL_KIND).sort((a,b)=>b.createdAt-a.createdAt||b.id.localeCompare(a.id))[0]??null;
}
/** The device page notice: waiting while the latest uninstall job is open, failed with its reason afterwards. */
export function deviceUninstallNotice(server:Pick<Device,'id'|'snapshot'>,jobs:readonly Job[],now:number,t:Translate):{tone:'warning'|'danger';text:string;reason?:string}|null{
 const job=latestUninstallJob(server.id,jobs);if(!job)return null;
 const {state,reason}=offboardingState({revoked:false,capable:canUninstall(server.snapshot),job:{state:job.state,createdAt:job.createdAt,notBefore:job.notBefore??0,claimedAt:job.claimedAt,result:job.result},now});
 if(state==='waiting'||state==='running')return {tone:'warning',text:t('device.uninstall.pending')};
 if(state!=='failed'||!['failed','cancelled','expired','pending'].includes(job.state))return null;
 return {tone:'danger',text:t('device.uninstall.failed'),reason:offboardingReason({state,reason,code:job.resultCode??null,args:job.resultArgs??null,result:job.result},t)??undefined};
}

export default function OffboardingDrawer({ids,open,servers,demo,saving,load,onAction,onRemoved,onClose}:{ids:string[];open:boolean;servers:readonly Device[];demo:boolean;saving:boolean;load:(ids:string[])=>Promise<OffboardingEntry[]>;onAction:(payload:Record<string,unknown>)=>void|Promise<void>;onRemoved:(ids:string[])=>void;onClose:()=>void}){
 const t=useT();
 const [rows,setRows]=useState<OffboardingEntry[]>([]),[failed,setFailed]=useState(false),[busy,setBusy]=useState<'remove'|'retry'|null>(null),[tick,setTick]=useState(0);
 const key=ids.join(','),reported=useRef(new Set<string>()),wasSaving=useRef(saving),latest=useRef({ids,load});
 useEffect(()=>{latest.current={ids,load};});
 // Load on open, on every tick and after a drawer action; keep the last rows on a failure.
 useEffect(()=>{
  if(!open||!key)return;
  let current=true;
  latest.current.load(latest.current.ids).then(next=>{if(current){setRows(next);setFailed(false);}},()=>{if(current)setFailed(true);});
  return()=>{current=false;};
 },[open,key,tick]);
 const polling=open&&offboardingPolling(rows);
 useEffect(()=>{if(!polling)return;const timer=setTimeout(()=>setTick(value=>value+1),OFFBOARDING_POLL_MS);return()=>clearTimeout(timer);},[polling,tick]);
 // A finished removal or retry (saving goes off) reloads the rows.
 useEffect(()=>{const ended=wasSaving.current&&!saving;wasSaving.current=saving;if(ended)queueMicrotask(()=>{setBusy(null);setTick(value=>value+1);});},[saving]);
 // Devices that left the portal leave the console list through its removal path.
 useEffect(()=>{const done=rows.filter(row=>(row.state==='revoked'||row.state==='uninstalled')&&!reported.current.has(row.id)).map(row=>row.id);if(!done.length)return;for(const id of done)reported.current.add(id);onRemoved(done);},[rows,onRemoved]);

 const summary=offboardingSummary(rows),openRows=rows.filter(isOpen);
 const capable=openRows.filter(row=>canUninstall(servers.find(server=>server.id===row.id)?.snapshot));
 const demoBlocked=demo?t('kit.unavailable.demo'):undefined;
 const act=(kind:'remove'|'retry',list:OffboardingEntry[])=>{setBusy(kind);void onAction(offboardingPayload(list.map(row=>row.id),kind==='retry'));};
 return <Drawer open={open} onClose={onClose} title={t('console.offboarding.title')}
  description={rows.length?<span aria-live="polite">{t('console.offboarding.summary',summary)}</span>:undefined}
  footer={openRows.length?<>
   <Btn icon={RotateCcw} loading={saving&&busy==='retry'} disabled={saving} blocked={demoBlocked??(capable.length?undefined:t('console.offboarding.retryBlocked'))} onClick={()=>act('retry',capable)}>{t('common.retry')}</Btn>
   <Btn variant="danger" icon={Trash2} loading={saving&&busy==='remove'} disabled={saving} blocked={demoBlocked} onClick={()=>act('remove',openRows)}>{t('console.offboarding.removeWithout')}</Btn>
  </>:undefined}>
  {failed&&<Notice tone="danger" icon={AlertTriangle} action={<Btn size="sm" icon={RefreshCw} onClick={()=>setTick(value=>value+1)}>{t('console.offboarding.reload')}</Btn>}>{t('console.offboarding.loadFailed')}</Notice>}
  {!rows.length&&!failed?<Skeleton variant="table" rows={3} label={t('console.offboarding.title')}/>
   :<ul className="sdx-pick-list sdx-offboarding-list">{rows.map(row=>{const reason=offboardingReason(row,t);return <li key={row.id} className="sdx-pick-row sdx-offboarding-row">
    <span className="sdx-pick-icon"><PackageX size={15} aria-hidden/></span>
    <span className="sdx-pick-text"><strong>{row.name}</strong>{reason&&<small>{reason}</small>}</span>
    <StatusPill kind={stateKinds[row.state]}>{t(stateKeys[row.state])}</StatusPill>
   </li>;})}</ul>}
 </Drawer>;
}
