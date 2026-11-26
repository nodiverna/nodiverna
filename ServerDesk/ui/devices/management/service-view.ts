import type {Service,Server,Viewer} from '@/lib/types';
import {deviceConnection} from '@/ui/base/ui-device';
import {isOwner} from '@/ui/base/access-capabilities';
import {confirmationDevice} from '@/ui/devices/management/management-actions';

import {translate} from '@/lib/i18n/translate';
import {defaultLocale,type Locale} from '@/lib/i18n/locale';
export const SERVICE_PAGE_SIZE=25;
export type ServiceFocus='all'|'running'|'auto-stopped'|'disabled';
export type ServiceSort='name'|'status'|'startup';
export type ServiceStartup='Automatic'|'Manual'|'Disabled';
export type ServiceSelection={serverId:string;name:string};
export type ServiceContext={server:Server&{permissions?:string[]};viewer:Viewer;demo:boolean;saving:boolean;now:number};
export type ServiceFilters={query:string;focus:ServiceFocus;status:string;startup:string;sort:ServiceSort;direction:'asc'|'desc';page:number};
const collator=new Intl.Collator('de',{sensitivity:'base',numeric:true});
export function serviceStartup(mode:string):ServiceStartup|null{
  const value=mode.trim().toLowerCase();
  return ['auto','automatic'].includes(value)?'Automatic':value==='manual'?'Manual':value==='disabled'?'Disabled':null;
}
export function serviceStartupLabel(mode:string,locale:Locale=defaultLocale){
  const known=serviceStartup(mode);
  return known==='Automatic'?translate(locale,'management.automatic'):known==='Manual'?translate(locale,'services.startup.manual'):known==='Disabled'?translate(locale,'fleet.disabled'):mode==='Boot'?translate(locale,'services.startup.boot'):mode==='System'?translate(locale,'services.startup.system'):translate(locale,'services.unknown');
}
export function serviceStatusLabel(status:string,locale:Locale=defaultLocale){
  return ({Running:translate(locale,'jobs.state.running'),Stopped:translate(locale,'services.status.stopped'),Paused:translate(locale,'services.status.paused'),StartPending:translate(locale,'services.status.starting'),StopPending:translate(locale,'services.status.stopping'),ContinuePending:translate(locale,'services.status.continuing'),PausePending:translate(locale,'services.status.pausing')} as Record<string,string>)[status]??(status.trim()||translate(locale,'services.unknown'));
}
export function serviceStatusTone(status:string){return status==='Running'?'running':status==='Stopped'?'stopped':['StartPending','StopPending','ContinuePending','PausePending'].includes(status)?'changing':'unknown';}
export function serviceInventory(server:ServiceContext['server']):Service[]{return Array.isArray(server.snapshot?.services)?server.snapshot.services:[];}
export function currentService(server:ServiceContext['server'],selection:ServiceSelection|null):Service|null{
  if(!selection||selection.serverId!==server.id||server.revoked)return null;
  return serviceInventory(server).find(service=>service.name.toLowerCase()===selection.name.toLowerCase())??null;
}
export function serviceView(services:Service[],filters:ServiceFilters,locale:Locale=defaultLocale){
  const counts={all:services.length,running:services.filter(service=>service.status==='Running').length,autoStopped:services.filter(service=>service.status==='Stopped'&&serviceStartup(service.startMode)==='Automatic').length,disabled:services.filter(service=>serviceStartup(service.startMode)==='Disabled').length};
  const query=filters.query.trim().toLocaleLowerCase(locale);
  const matches=services.filter(service=>{
    if(query&&![service.name,service.displayName].join(' ').toLocaleLowerCase(locale).includes(query))return false;
    if(filters.focus==='running'&&service.status!=='Running'||filters.focus==='auto-stopped'&&!(service.status==='Stopped'&&serviceStartup(service.startMode)==='Automatic')||filters.focus==='disabled'&&serviceStartup(service.startMode)!=='Disabled')return false;
    if(filters.status!=='all'&&(filters.status==='changing'?serviceStatusTone(service.status)!=='changing':filters.status==='unknown'?serviceStatusTone(service.status)!=='unknown':service.status!==filters.status))return false;
    const startup=serviceStartup(service.startMode)??(['Boot','System'].includes(service.startMode)?'system':'unknown');
    return filters.startup==='all'||filters.startup===startup;
  });
  const rank=(service:Service)=>filters.sort==='status'?({running:0,changing:1,stopped:2,unknown:3}[serviceStatusTone(service.status)]):filters.sort==='startup'?({Automatic:0,Manual:1,Disabled:2}[serviceStartup(service.startMode) as ServiceStartup]??3):0;
  const sorted=[...matches].sort((a,b)=>{
    const primary=filters.sort==='name'?collator.compare(a.displayName||a.name,b.displayName||b.name):rank(a)-rank(b);
    return (filters.direction==='asc'?1:-1)*(primary||collator.compare(a.name,b.name));
  });
  const pageCount=Math.max(1,Math.ceil(sorted.length/SERVICE_PAGE_SIZE)),page=Math.min(pageCount,Math.max(1,Math.floor(filters.page)||1)),offset=(page-1)*SERVICE_PAGE_SIZE;
  return {counts,total:services.length,filteredCount:sorted.length,pageCount,page,start:sorted.length?offset+1:0,end:Math.min(offset+SERVICE_PAGE_SIZE,sorted.length),items:sorted.slice(offset,offset+SERVICE_PAGE_SIZE)};
}
export function serviceManagementReason(context:ServiceContext,kind?:string,locale:Locale=defaultLocale){
  const {server,viewer,demo,saving,now}=context,snapshot=server.snapshot;
  if(demo)return translate(locale,'kit.unavailable.demo');
  if(saving)return translate(locale,'services.blocked.saving');
  if(server.revoked)return translate(locale,'kit.unavailable.revoked');
  if(!(isOwner(viewer)||server.permissions?.includes('manage')))return translate(locale,'management.blocked.manage');
  if(server.management!==1||snapshot?.mode==='ReadOnly')return translate(locale,'management.blocked.readOnly');
  if(snapshot?.mode!=='Management')return translate(locale,'services.blocked.modeUnconfirmed');
  if(deviceConnection(server,now).kind!=='online')return translate(locale,'management.blocked.offline');
  if(kind&&!snapshot?.agentCapabilities?.includes(kind))return translate(locale,'management.blocked.unsupported');
  return '';
}
export function serviceActionReason(context:ServiceContext,selection:ServiceSelection|null,kind:string,locale:Locale=defaultLocale){
  const reason=serviceManagementReason(context,kind,locale);if(reason)return reason;
  const service=currentService(context.server,selection);if(!service)return translate(locale,'services.blocked.gone');
  if(kind==='start-service')return service.status!=='Stopped'?service.status==='Running'?translate(locale,'services.blocked.running'):translate(locale,'services.blocked.notStopped'):serviceStartup(service.startMode)==='Disabled'?translate(locale,'services.blocked.disabled'):'';
  if(['stop-service','restart-service'].includes(kind)&&service.status!=='Running')return translate(locale,'services.blocked.notRunning');
  if(!['start-service','stop-service','restart-service','set-service-startup'].includes(kind))return translate(locale,'services.blocked.unknownAction');
  return '';
}
export function serviceConfirmation(context:ServiceContext,selection:ServiceSelection|null,kind:string,startup?:string,expectedStartMode?:string,locale:Locale=defaultLocale){
  if(serviceActionReason(context,selection,kind,locale))return null;
  const service=currentService(context.server,selection)!;
  if(kind==='set-service-startup'){
    if(!['Automatic','Manual','Disabled'].includes(startup??'')||startup===serviceStartup(service.startMode)||expectedStartMode!==undefined&&expectedStartMode!==service.startMode)return null;
    return {title:translate(locale,'services.confirm.startupTitle'),description:translate(locale,'services.confirm.startupDescription',{name:context.server.name,name2:service.name,startMode:service.startMode,startup:String(startup)}),payload:{action:'job',id:context.server.id,kind,params:{name:service.name,startup},confirm:true},confirmLabel:translate(locale,'services.changeStartup'),lines:confirmationDevice(context.server.name,locale)};
  }
  return {title:translate(locale,kind==='start-service'?'services.confirm.startTitle':kind==='stop-service'?'services.confirm.stopTitle':'services.confirm.restartTitle',{name:service.displayName||service.name}),description:translate(locale,'services.confirm.description',{name:context.server.name,name2:service.name,status:service.status}),payload:{action:'job',id:context.server.id,kind,params:{name:service.name},confirm:true},confirmLabel:translate(locale,kind==='start-service'?'services.action.start':kind==='stop-service'?'services.action.stop':'services.action.restart'),lines:confirmationDevice(context.server.name,locale)};
}
