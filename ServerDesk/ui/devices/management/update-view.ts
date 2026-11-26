import type {Server,Viewer,Job,ServerSnapshot} from '@/lib/types';
import {deviceConnection} from '@/ui/base/ui-device';
import {isOwner} from '@/ui/base/access-capabilities';
import {confirmationDevice} from '@/ui/devices/management/management-actions';

import {translate} from '@/lib/i18n/translate';
import {formatDateTime} from '@/lib/i18n/format';
import {defaultLocale,type Locale} from '@/lib/i18n/locale';
export type WindowsUpdate=NonNullable<ServerSnapshot['updates']>['items'][number];
export type UpdateContext={server:Server;viewer:Viewer;demo:boolean;saving:boolean;now:number;jobs:Job[]};
export type UpdateSelection={serverId:string;inventoryKey:string;ids:string[]};
export type UpdateFilters={query:string;severity:string;reboot:string;page:number};
export const UPDATE_SELECTION_LIMIT=50,UPDATE_PAGE_SIZE=20;
const guid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function updateInventory(server:Server){
  const source=server.snapshot?.updates,checked=source?.checkedAt?Date.parse(source.checkedAt):NaN;
  const checkedAt=Number.isFinite(checked)?checked:null,seen=new Set<string>();
  const items:WindowsUpdate[]=[];
  for(const item of source?.items??[]){
    if(!item||typeof item.id!=='string'||!guid.test(item.id)||seen.has(item.id.toLowerCase()))continue;
    seen.add(item.id.toLowerCase());items.push({...item,title:String(item.title??''),kb:String(item.kb??''),severity:String(item.severity??''),rebootRequired:item.rebootRequired===true});
  }
  const count=source?.pendingCount;
  const pendingCount=checkedAt!==null&&typeof count==='number'&&Number.isSafeInteger(count)&&count>=0?count:null;
  // Include content so a retained callback cannot apply a selection to changed
  // update metadata, even when an inventory timestamp was reused.
  const key=JSON.stringify([server.id,checkedAt,pendingCount,items.map(item=>[item.id,item.title,item.kb,item.severity,item.rebootRequired])]);
  return {checkedAt,pendingCount,items,key,known:checkedAt!==null,truncated:pendingCount!==null&&pendingCount>items.length};
}
export function updateSeverity(severity:string,locale:Locale=defaultLocale){
  const value=severity.trim().toLowerCase();
  return ({critical:translate(locale,'updates.severity.critical'),important:translate(locale,'updates.severity.important'),moderate:translate(locale,'updates.severity.moderate'),low:translate(locale,'updates.severity.low')} as Record<string,string>)[value]??translate(locale,'management.updates.notSpecified');
}
export function updateSeverityTone(severity:string):'critical'|'important'|'moderate'|'low'|'unknown'{const value=severity.trim().toLowerCase();return value==='critical'||value==='important'||value==='moderate'||value==='low'?value:'unknown';}
export function updateView(items:WindowsUpdate[],filters:UpdateFilters,locale:Locale=defaultLocale){
  const query=filters.query.trim().toLocaleLowerCase(locale),filtered=items.filter(item=>{
    if(query&&![item.title,item.kb,item.id].join(' ').toLocaleLowerCase(locale).includes(query))return false;
    const tone=updateSeverityTone(item.severity);
    if(filters.severity==='urgent'&&!['critical','important'].includes(tone)||filters.severity!=='all'&&filters.severity!=='urgent'&&filters.severity!==tone)return false;
    return filters.reboot==='all'||(filters.reboot==='yes'?item.rebootRequired:!item.rebootRequired);
  }).sort((a,b)=>({critical:0,important:1,moderate:2,low:3,unknown:4}[updateSeverityTone(a.severity)] - {critical:0,important:1,moderate:2,low:3,unknown:4}[updateSeverityTone(b.severity)]||a.title.localeCompare(b.title,'de',{numeric:true})));
  const pageCount=Math.max(1,Math.ceil(filtered.length/UPDATE_PAGE_SIZE)),page=Math.min(pageCount,Math.max(1,Math.floor(filters.page)||1)),offset=(page-1)*UPDATE_PAGE_SIZE;
  return {filtered,items:filtered.slice(offset,offset+UPDATE_PAGE_SIZE),page,pageCount,start:filtered.length?offset+1:0,end:Math.min(offset+UPDATE_PAGE_SIZE,filtered.length),urgent:items.filter(item=>['critical','important'].includes(updateSeverityTone(item.severity))).length,reboot:items.filter(item=>item.rebootRequired).length};
}
export function updateJobs(context:UpdateContext){
  return context.jobs.filter(job=>job.serverId===context.server.id&&['scan-updates','install-updates'].includes(job.action)).sort((a,b)=>b.createdAt-a.createdAt);
}
export function updateActionReason(context:UpdateContext,kind:'scan-updates'|'install-updates',all=false,locale:Locale=defaultLocale){
  const {server,viewer,demo,saving,now}=context,snapshot=server.snapshot;
  if(demo)return translate(locale,'kit.unavailable.demo');
  if(saving)return translate(locale,'services.blocked.saving');
  if(server.revoked)return translate(locale,'kit.unavailable.revoked');
  if(!(isOwner(viewer)||server.permissions?.includes(kind==='scan-updates'?'diagnose':'manage')))return kind==='scan-updates'?translate(locale,'management.blocked.diagnose'):translate(locale,'management.blocked.manage');
  if(deviceConnection(server,now).kind!=='online')return translate(locale,'management.blocked.offline');
  if(!snapshot?.agentCapabilities?.includes(kind))return translate(locale,'management.blocked.unsupported');
  if(kind==='install-updates'&&(server.management!==1||snapshot.mode!=='Management'))return translate(locale,'management.blocked.readOnly');
  if(all&&!snapshot.agentCapabilities.includes('install-all-updates'))return translate(locale,'updates.blocked.updateAgent');
  if(updateJobs(context).some(job=>['pending','running'].includes(job.state)))return translate(locale,'updates.blocked.active');
  // "Install all available" needs a search that listed updates; the agent would otherwise install blind.
  if(all&&!(updateInventory(server).pendingCount??0))return translate(locale,'updates.blocked.searchFirst');
  return '';
}
/** When a finished job ended: its last progress, else its claim, else its creation. */
const jobEnd=(job:Job)=>job.lastProgress??job.claimedAt??job.createdAt;
/**
 * The one status sentence of the Windows Update panel (the head meta), in this order: a running or queued
 * search, a running or queued install, a search the agent already reported (its time), a search that finished
 * after the last report (the list arrives with the next report), else no completed search yet.
 */
export function updateStatus(context:UpdateContext,locale:Locale=defaultLocale):string{
  const jobs=updateJobs(context),open=(action:string)=>jobs.some(job=>job.action===action&&['pending','running'].includes(job.state));
  if(open('scan-updates'))return translate(locale,'updates.status.searching');
  if(open('install-updates'))return translate(locale,'updates.status.installing');
  const {checkedAt}=updateInventory(context.server),scan=jobs.find(job=>job.action==='scan-updates');
  const arriving=scan?.state==='succeeded'&&(checkedAt===null||scan.createdAt>checkedAt);
  if(checkedAt!==null&&!arriving)return translate(locale,'updates.lastScanAt',{stamp:formatDateTime(locale,checkedAt)});
  if(arriving)return translate(locale,'updates.status.arriving',{stamp:formatDateTime(locale,jobEnd(scan))});
  return translate(locale,'updates.noScan');
}
export function updateSelected(server:Server,selection:UpdateSelection|null){
  const inventory=updateInventory(server);
  return selection?.serverId===server.id&&selection.inventoryKey===inventory.key?inventory.items.filter(item=>selection.ids.includes(item.id)):[];
}
export function updateConfirmation(context:UpdateContext,kind:'scan-updates'|'install-updates',candidate:{serverId:string;inventoryKey:string;ids?:string[];all?:boolean},locale:Locale=defaultLocale){
  if(candidate.serverId!==context.server.id||updateActionReason(context,kind,candidate.all,locale))return null;
  if(kind==='scan-updates')return {title:translate(locale,'updates.confirm.scanTitle'),description:translate(locale,'updates.confirm.scanDescription',{name:context.server.name}),payload:{action:'job',id:context.server.id,kind,params:{},confirm:true},confirmLabel:translate(locale,'management.updates.scan'),lines:confirmationDevice(context.server.name,locale)};
  const inventory=updateInventory(context.server);
  if(candidate.inventoryKey!==inventory.key)return null;
  const safety=translate(locale,'updates.confirm.safety');
  if(candidate.all){
    return {title:translate(locale,'updates.confirm.allTitle'),description:translate(locale,'updates.confirm.allDescription',{name:context.server.name,count:inventory.pendingCount??translate(locale,'updates.confirm.unknownCount'),safety}),payload:{action:'job',id:context.server.id,kind,params:{all:true},confirm:true},confirmLabel:translate(locale,'updates.install.all'),lines:confirmationDevice(context.server.name,locale)};
  }
  const ids=[...new Set(candidate.ids??[])];
  if(!inventory.known||!ids.length||ids.length>UPDATE_SELECTION_LIMIT)return null;
  const chosen=inventory.items.filter(item=>ids.includes(item.id));
  if(chosen.length!==ids.length)return null;
  return {title:translate(locale,'updates.confirm.selectedTitle',{count:chosen.length}),description:translate(locale,'updates.confirm.selectedDescription',{name:context.server.name,join:chosen.map(item=>`${item.kb||item.id} · ${item.title}`).join('\n'),safety}),payload:{action:'job',id:context.server.id,kind,params:{updateIds:chosen.map(item=>item.id)},confirm:true},confirmLabel:translate(locale,'updates.install.selected',{length:chosen.length}),lines:confirmationDevice(context.server.name,locale)};
}
export function updateCsv(items:WindowsUpdate[],locale:Locale=defaultLocale){
  const quote=(value:string)=>'"'+value.replaceAll('"','""')+'"';
  // Neutralize formula prefixes in spreadsheet exports of agent-supplied text.
  const cell=(value:string)=>quote(/^[\s]*[=+\-@]/.test(value)?"'"+value:value);
  return '\uFEFF'+[[translate(locale,'updates.csv.id'),'KB',translate(locale,'updates.csv.title'),translate(locale,'management.updates.priority'),translate(locale,'updates.csv.restart')],...items.map(item=>[item.id,item.kb,item.title,updateSeverity(item.severity,locale),item.rebootRequired?translate(locale,'management.yes'):translate(locale,'management.no')])].map(row=>row.map(cell).join(';')).join('\r\n');
}
