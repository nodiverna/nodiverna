'use client';
// The device tabs of the Automation pages. Device status (Runbooks, Configuration drift): every device with its
// effective template, where it comes from and its state, with a search, a group filter and 50 rows per page; a row
// opens the device's automation subarea. Reference devices (Configuration drift): the devices with the drift
// management right, each opening its data sources and scan. The Origin cell is shared with the Desired State page.
import {useState,type ReactNode} from 'react';
import {Folder,GitCompareArrows,Search,Server} from 'lucide-react';
import {Btn,Card,IconBtn,StatusPill} from '@/ui/kit/kit';
import {DataTable,Toolbar,type DataColumn} from '@/ui/kit/data-table';
import {Select} from '@/ui/kit/field';
import {automationGroupPath,automationStates,effectiveDeviceAssignments,type AutomationData} from '@/ui/automation/automation-data';
import type {AutomationKind} from '@/lib/automation-resolution';
import {EMPTY_VALUE} from '@/lib/i18n/format';
import {storedMessageText} from '@/lib/server-messages';
import type {Device} from '@/ui/base/api';
import {useLocale,useT} from '@/ui/base/locale';

export const deviceStatusPageSize=50;
type Translate=ReturnType<typeof useT>;

/** The effective templates of a device and their origin: the group path, or "Device" for a device assignment. */
export function originCell(server:Device,data:AutomationData|null,kind:AutomationKind,t:Translate):ReactNode{
 const effective=data?effectiveDeviceAssignments(server,data,kind):[];
 if(!effective.length)return EMPTY_VALUE;
 return <span className="sdx-cell-stack">{effective.map(entry=>{const group=data?.groups.find(g=>g.id===entry.scopeId);return <span key={entry.slot}>{entry.templateName}<small>{entry.scopeType==='device'?t('automation.origin.device'):group?automationGroupPath(group,data?.groups??[]):t('fleet.col.group')}</small></span>;})}</span>;
}

/** The devices that match the search (name, host name, groups) and the group filter, by name. */
export function matchingDevices(servers:readonly Device[],search:string,group:string,locale:string):Device[]{
 const needle=search.trim().toLocaleLowerCase(locale);
 return servers.filter(s=>(group==='all'||s.groups?.some(g=>g.id===group)||s.groupId===group)&&[s.name,s.snapshot?.hostname,s.groupName,...(s.groups?.map(g=>g.name)??[])].filter(Boolean).join(' ').toLocaleLowerCase(locale).includes(needle))
  .sort((a,b)=>a.name.localeCompare(b.name,locale,{numeric:true}));
}

export function AutomationDeviceStatus({kind,servers,data,onOpenDevice}:{kind:AutomationKind;servers:readonly Device[];data:AutomationData;onOpenDevice:(id:string)=>void}){
 const t=useT(),[locale]=useLocale();
 const [search,setSearch]=useState(''),[group,setGroup]=useState('all'),[page,setPage]=useState(1);
 const matching=matchingDevices(servers,search,group,locale),pages=Math.max(1,Math.ceil(matching.length/deviceStatusPageSize)),current=Math.min(page,pages);
 const rows=matching.slice((current-1)*deviceStatusPageSize,current*deviceStatusPageSize);
 // A new search or filter starts at page 1 again.
 const filter=(next:()=>void)=>{next();setPage(1);};
 const effectiveOf=(server:Device)=>effectiveDeviceAssignments(server,data,kind);
 const columns:DataColumn<Device>[]=[
  {id:'device',label:t('fleet.col.device'),primary:true,cell:server=><span className="sdx-cell-stack"><strong>{server.name}</strong><small>{server.groupName??t('groups.noGroup')}</small></span>},
  {id:'template',label:t('automation.effectiveTemplate'),wrap:true,cell:server=>{const effective=effectiveOf(server);return effective.length?<span className="sdx-cell-stack">{effective.map(entry=><span key={entry.slot}>{entry.templateName}</span>)}</span>:EMPTY_VALUE;}},
  {id:'origin',label:t('rbac.origin'),wrap:true,cell:server=>{const effective=effectiveOf(server);return effective.length?<span className="sdx-cell-stack">{effective.map(entry=>{const owner=data.groups.find(g=>g.id===entry.scopeId);return <span key={entry.slot}>{entry.scopeType==='device'?t('automation.origin.device'):owner?automationGroupPath(owner,data.groups):t('fleet.col.group')}</span>;})}</span>:EMPTY_VALUE;}},
  {id:'status',label:t('management.status'),cell:server=>{const effective=effectiveOf(server);if(!effective.length)return <span className="sdx-muted-cell">{t('automation.noAssignment')}</span>;
   return <span className="sdx-cell-stack">{effective.map(entry=>{const stored=data.states.find(s=>s.serverId===server.id&&s.kind===kind&&s.slot===entry.slot&&s.assignmentId===entry.id),state=entry.conflict?'conflict':entry.disabled?'paused':stored?.status??'pending',known=Object.hasOwn(automationStates,state)?automationStates[state]:null;
    return <StatusPill key={entry.slot} kind={known?.kind??'neutral'} title={stored?.message?storedMessageText(stored.message,t):undefined}>{known?t(known.label):state}</StatusPill>;})}</span>;}},
  {id:'actions',label:t('fleet.col.actions'),hideLabel:true,className:'sdx-col-actions',cell:server=><Btn size="sm" variant="ghost" onClick={()=>onOpenDevice(server.id)}>{t('common.open')}</Btn>},
 ];
 const clear=()=>filter(()=>{setSearch('');setGroup('all');});
 const toolbar=<Toolbar search={{value:search,onChange:value=>filter(()=>setSearch(value)),label:t('automation.searchDevices'),placeholder:t('automation.searchPlaceholder')}}
  filters={<Select size="sm" aria-label={t('automation.filterGroup')} value={group} onChange={event=>filter(()=>setGroup(event.target.value))}><option value="all">{t('automation.allGroups')}</option>{data.groups.map(g=><option key={g.id} value={g.id}>{automationGroupPath(g,data.groups)}</option>)}</Select>}/>;
 // The tab already names the view: the card has no visible title, the table keeps its accessible name.
 return <Card flush>
  <DataTable<Device> label={t('automation.deviceState')} variant="flush" cards entranceId="automation-device-status" columns={columns} rows={rows} rowKey={server=>server.id} toolbar={toolbar}
   onOpen={server=>onOpenDevice(server.id)} openLabel={server=>t('fleet.openDevice',{name:server.name})}
   foot={t('automation.devicesFoot',{shown:matching.length,total:servers.length})}
   pagination={{page:current,pageSize:deviceStatusPageSize,total:matching.length,onPage:setPage}}
   empty={servers.length?{icon:Search,title:t('automation.noDevices'),action:<Btn onClick={clear}>{t('automation.clearSearch')}</Btn>}:{icon:Server,title:t('automation.noDevicesYet')}}/>
 </Card>;
}

export function ReferenceDevices({devices,onOpenDevice}:{
 /** The devices with the drift management right. */
 devices:readonly Device[];onOpenDevice:(id:string)=>void}){
 const t=useT();
 const columns:DataColumn<Device>[]=[
  {id:'device',label:t('fleet.col.device'),primary:true,cell:server=><strong>{server.name}</strong>},
  {id:'group',label:t('fleet.col.group'),cell:server=>server.groupName?<span><Folder size={13} aria-hidden/> {server.groupName}</span>:<span className="sdx-muted-cell">{t('groups.noGroup')}</span>},
  {id:'actions',label:t('fleet.col.actions'),hideLabel:true,className:'sdx-col-actions',cell:server=><IconBtn icon={GitCompareArrows} label={t('automation.openSourcesFor',{name:server.name})} onClick={()=>onOpenDevice(server.id)}/>},
 ];
 return <Card flush>
  <DataTable<Device> label={t('automation.referenceDevices')} variant="flush" cards entranceId="automation-reference-devices" columns={columns} rows={devices} rowKey={server=>server.id}
   onOpen={server=>onOpenDevice(server.id)} openLabel={server=>t('automation.openSourcesFor',{name:server.name})} empty={{icon:Server,title:t('automation.noDriftDevices')}}/>
 </Card>;
}
