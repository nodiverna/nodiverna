'use client';
// The scope tab "Extensions" (<scope>/inventory/extensions, docs/extensions.md): which devices of the scope have a
// role or product that the portal detects (lib/extensions.ts), and which agent extensions they run. In this order:
// - the focal point: one summary card per extension of the catalog that is detected in the scope, with its release,
//   the coverage meter (installed on N of M devices), Offered, Update available, Damaged, and "Roll out" (the update
//   of older installs on pilot devices, the same drawer and confirmation as Settings → Extensions);
// - one Toolbar (device search, the state Segmented, the detection Select) and one DataTable, one row per (device,
//   detected target); a row opens the device on Extensions, or its DHCP or DNS server when that extension is installed;
// - the data cards of the extensions: "DHCP scope usage" (GET /api/dhcp?usage=1, docs/dhcp-server.md) and "DNS zones"
//   (GET /api/dns?zones=1, docs/dns-server.md), each loaded once per mount, as a flush DataTable in its Card.
import {useEffect,useMemo,useRef,useState} from 'react';
import {ChevronRight,Download,ExternalLink,Globe,Router,Search,ScanSearch,Upload} from 'lucide-react';
import type {Job,Server,Viewer} from '@/lib/types';
import type {Confirmation} from '@/ui/base/confirmation';
import {extensionCatalog,extensionState,fleetTargetRows,targetCounts,detectionIds,type ExtensionState,type FleetTargetRow} from '@/lib/extensions';
import {dhcpUsageRows,dhcpUsageSummary,sortDhcpUsageRows,type DhcpUsageRow} from '@/lib/dhcp';
import {demoDhcpServerId,demoDhcpSnapshot} from '@/ui/shell/demo-dhcp';
import {dnsFleetRows,dnsZoneSummary,sortDnsFleetRows,type DnsFleetZone} from '@/lib/dns';
import {demoDnsReadAt,demoDnsServerId,demoDnsSnapshot} from '@/ui/shell/demo-dns';
import {sortTableRows} from '@/ui/base/table-sort';
import {dnsDynamicLabel,dnsKindLabel,dnsStorageLabel} from '@/ui/devices/extensions/device-dns';
import type {PluginReleaseSummary} from '@/lib/plugin-catalog';
import {api,message,permitted} from '@/ui/base/api';
import {Btn,Card,EntranceList,Facts,Menu,Meter,Segmented,percentLabel,relativeTime,type EmptyProps,type MenuEntry} from '@/ui/kit/kit';
import {Select} from '@/ui/kit/field';
import {DataTable,Toolbar,type DataColumn,type TableSort} from '@/ui/kit/data-table';
import {AnalysisTab,FirstLoad,LoadFailed,ResetAction} from '@/ui/kit/analysis-tab';
import {useLocale,useT} from '@/ui/base/locale';
import {useClockNow} from '@/ui/base/clock-store';
import {DetectedName,DetectedVersion,ExtensionStatePill,extensionGroup,extensionName,pluginActionBlocked,pluginInstallConfirmation,pluginStateBlocked,targetIcon,targetLabel} from '@/ui/devices/extensions/device-extensions';
import {ExtensionRollout,pluginRolloutCandidates,rolloutBlockedReason} from '@/ui/settings/extension-releases';
import {EMPTY_VALUE} from '@/lib/i18n/format';

/** The state filter of the table: every row, or one of the three groups of the device area (installed, offered, no extension). */
export type ExtensionStateFilter='all'|'installed'|'offered'|'none';
/** The filter group of an extension state: installed (also damaged, installing, reporting), offered (available, planned) or none. */
export function stateFilterOf(entry:Pick<FleetTargetRow['entry'],'extension'>,state:ExtensionState):Exclude<ExtensionStateFilter,'all'>{
 const group=extensionGroup(entry,state);
 return group==='available'?'offered':group==='installed'?'installed':'none';
}
type SortColumn='device'|'detected';
type Row=FleetTargetRow&{state:ExtensionState};
const noJobs:readonly Job[]=[];

type Props={devices:Server[];viewer:Viewer;demo:boolean;
 /** Pins the time (tests); without it the tab follows the console clock. */
 now?:number;releases?:readonly PluginReleaseSummary[];
 /** The console's jobs: an open or just finished install shows in the Extension column and blocks a second install. */
 jobs?:readonly Job[];
 onConfirm:(confirmation:Confirmation)=>void;
 onOpen:(id:string,section:'extensions',detail?:'dhcp'|'dns')=>void;onShowDevices:()=>void};

export default function ExtensionsTab({devices,viewer,demo,now:pinnedNow,releases,jobs=noJobs,onConfirm,onOpen,onShowDevices}:Props){
 const now=useClockNow(pinnedNow);
 const t=useT();
 const [query,setQuery]=useState(''),[stateFilter,setStateFilter]=useState<ExtensionStateFilter>('all'),[target,setTarget]=useState(''),[rollout,setRollout]=useState<string|null>(null);
 // No sort until a head is pressed: the rows keep the order of fleetTargetRows (catalog order, then device name).
 const [sort,setSort]=useState<TableSort<SortColumn>|null>(null);
 const byId=useMemo(()=>new Map(devices.map(device=>[device.id,device])),[devices]);
 const all:Row[]=useMemo(()=>fleetTargetRows(devices).map(row=>({...row,state:extensionState(row.entry,byId.get(row.deviceId)??{snapshot:null},releases,jobs)})),[devices,byId,releases,jobs]);
 const counts=useMemo(()=>targetCounts(all),[all]);
 const needle=query.trim().toLowerCase();
 const releaseOf=(name:string)=>releases?.find(release=>release.name===name);
 // Search and detection narrow the rows; the state filter comes last, so its counts are those of the other two filters.
 const narrowed=all.filter(row=>(!target||row.entry.id===target)&&(!needle||row.deviceName.toLowerCase().includes(needle)));
 const stateCounts={all:narrowed.length,installed:0,offered:0,none:0};
 for(const row of narrowed)stateCounts[stateFilterOf(row.entry,row.state)]++;
 const filtered=narrowed.filter(row=>stateFilter==='all'||stateFilterOf(row.entry,row.state)===stateFilter);
 const rows=sortTableRows(filtered,sort,{device:row=>row.deviceName,detected:row=>targetLabel(row.entry.id,t)});
 // One option per detected entry, in catalog order; a chosen target stays selectable while no device has it (after a refresh).
 const options=detectionIds.filter(id=>counts.has(id)||id===target);
 const reset=()=>{setQuery('');setStateFilter('all');setTarget('');};

 // The summary cards: one per catalog extension whose target a scoped device detects, in catalog order.
 const summaries=extensionCatalog.filter(extension=>counts.has(extension.target)).map(extension=>{
  const release=releaseOf(extension.name),targetRows=all.filter(row=>row.entry.id===extension.target);
  const installed=targetRows.filter(row=>row.state.state==='installed').length,offered=targetRows.filter(row=>row.state.state==='available'||row.state.state==='planned').length;
  const damaged=targetRows.filter(row=>row.state.state==='damaged').length,updates=release?pluginRolloutCandidates(release,devices,viewer).length:0;
  return {extension,release,count:counts.get(extension.target)??0,installed,offered,damaged,updates};
 });
 const rolloutRelease=rollout?releases?.find(release=>release.id===rollout):undefined;
 const summaryCard=({extension,release,count,installed,offered,damaged,updates}:typeof summaries[number])=>{
  const coverage=t('extensions.summary.coverage',{installed,count});
  // The release of the console is the newest active one, so only the scope (sample devices, no older install) can block it.
  const blocked=release?rolloutBlockedReason({...release,active:true},devices,viewer,demo,t):t('extensions.blocked.noRelease');
  return <Card key={extension.name} className="sdx-extension-summary-card" title={extensionName(extension.target,t)} icon={targetIcon(extension.target)} iconTone="accent"
   meta={release?t('extensions.release',{version:release.version}):t('extensions.noRelease')}
   actions={<Btn size="sm" icon={Upload} blocked={blocked} onClick={()=>{if(release&&!blocked)setRollout(release.id);}}>{t('extensions.releases.rollOut')}</Btn>}>
   <div className="sdx-extension-coverage"><span>{coverage}</span><Meter value={count?installed/count*100:0} label={coverage} warning={101} critical={101}/></div>
   <Facts columns={3} items={[
    {id:'offered',label:t('extensions.summary.offered'),value:offered,mono:true},
    {id:'updates',label:t('extensions.summary.updates'),value:updates,mono:true},
    ...(damaged>0?[{id:'damaged',label:t('extensions.summary.damaged'),value:damaged,mono:true}]:[]),
   ]}/>
  </Card>;
 };

 // The row Menu (nodiverna-ui §4): Open the device; Install extension when offered (blocked like the device area); Open DHCP or DNS when installed.
 const detailOf=(row:Row):'dhcp'|'dns'|undefined=>row.state.state==='installed'&&(row.entry.extension==='dhcp'||row.entry.extension==='dns')?row.entry.extension:undefined;
 const entries=(row:Row):MenuEntry[]=>{
  const list:MenuEntry[]=[{id:'open',label:t('extensions.openDevice',{name:row.deviceName}),icon:ChevronRight,onSelect:()=>onOpen(row.deviceId,'extensions')}];
  const device=byId.get(row.deviceId);
  if(row.state.state==='available'&&device){
   const release=row.state.release,reason=pluginStateBlocked(row.state,t)??pluginActionBlocked({server:device,viewer,demo,now,jobs,minAgentVersion:release.minAgentVersion},t);
   list.push({id:'install',label:t('extensions.install'),icon:Download,blocked:reason,onSelect:()=>{if(!reason)onConfirm(pluginInstallConfirmation(device,release,false,t));}});
  }
  const detail=detailOf(row);
  if(detail)list.push({id:'detail',label:t(detail==='dhcp'?'extensions.openDhcp':'extensions.openDns'),icon:ExternalLink,onSelect:()=>onOpen(row.deviceId,'extensions',detail)});
  return list;
 };
 const columns:DataColumn<Row>[]=[
  {id:'device',label:t('extensions.col.device'),primary:true,sort:{first:'asc'},cell:row=>row.deviceName},
  {id:'detected',label:t('extensions.col.detected'),sort:{first:'asc'},cell:row=><DetectedName entry={row.entry} small/>},
  {id:'version',label:t('extensions.col.version'),cell:row=><DetectedVersion entry={row.entry} os={row.os} t={t}/>},
  {id:'extension',label:t('extensions.col.extension'),cell:row=><ExtensionStatePill state={row.state} t={t}/>},
  {id:'actions',label:t('fleet.col.actions'),hideLabel:true,className:'sdx-col-actions',align:'end',cell:row=><Menu label={t('tree.actionsForName',{name:`${row.deviceName} · ${targetLabel(row.entry.id,t)}`})} entries={entries(row)}/>},
 ];
 const filters=all.length>0&&<>
  <Segmented<ExtensionStateFilter> label={t('extensions.filter.state')} size="sm" value={stateFilter} onChange={setStateFilter}
   items={[{id:'all',label:t('fleet.status.all'),count:stateCounts.all},{id:'installed',label:t('extensions.filter.installed'),count:stateCounts.installed},{id:'offered',label:t('extensions.filter.offered'),count:stateCounts.offered},{id:'none',label:t('extensions.filter.none'),count:stateCounts.none}]}/>
  <Select size="sm" wide aria-label={t('extensions.filter.target')} value={target} onChange={event=>setTarget(event.target.value)}>
   <option value="">{t('extensions.filter.all')}</option>
   {options.map(id=><option key={id} value={id}>{t('extensions.filter.option',{name:targetLabel(id,t),count:counts.get(id)??0})}</option>)}
  </Select>
 </>;
 const empty:EmptyProps=!all.length
  ?{icon:ScanSearch,title:t('extensions.empty.none'),children:t('extensions.empty.noneHint'),action:<Btn onClick={onShowDevices}>{t('extensions.empty.showDevices')}</Btn>}
  :{icon:Search,title:t('extensions.empty.filter'),children:t('extensions.empty.filterHint'),action:<ResetAction label={t('fleet.empty.resetFilter')} onReset={reset}/>};
 // The data cards: each only with its target in the scope, the read right on a scoped device (or demo), and the detection filter empty or that target.
 const canRead=(right:'dhcp.read'|'dns.read')=>demo||devices.some(device=>permitted(device,viewer,right));
 const dataCards=extensionCatalog.map(extension=>{
  const shown=counts.has(extension.target)&&(!target||target===extension.target);
  if(extension.target==='dhcp'&&shown&&canRead('dhcp.read'))return <DhcpUsageCard key="dhcp" devices={devices} demo={demo} now={now} query={needle} onOpen={id=>onOpen(id,'extensions','dhcp')} onShowDhcp={()=>setTarget('dhcp')}/>;
  if(extension.target==='dns'&&shown&&canRead('dns.read'))return <DnsZonesCard key="dns" devices={devices} demo={demo} now={now} query={needle} onOpen={id=>onOpen(id,'extensions','dns')} onShowDns={()=>setTarget('dns')}/>;
  return null;
 });
 return <AnalysisTab title={t('extensions.tab')} description={t('extensions.fleet.meta')}>
  {summaries.length>0&&<EntranceList id="extensions-summary" className="sdx-extension-summary">{summaries.map(summaryCard)}</EntranceList>}
  <DataTable<Row> label={t('extensions.tab')} columns={columns} rows={rows} rowKey={row=>row.deviceId+'\u0000'+row.entry.id}
   toolbar={<Toolbar search={{value:query,onChange:setQuery,label:t('extensions.search.label'),placeholder:t('extensions.search.placeholder')}} filters={filters}/>}
   sort={sort} onSort={next=>setSort(next as TableSort<SortColumn>)}
   onOpen={row=>onOpen(row.deviceId,'extensions',detailOf(row))} openLabel={row=>t('extensions.openDevice',{name:row.deviceName})}
   cards entranceId="extensions-rows" empty={empty} foot={t('extensions.count',{shown:rows.length,count:all.length})}/>
  {dataCards}
  {rolloutRelease&&<ExtensionRollout release={rolloutRelease} devices={devices} viewer={viewer} onClose={()=>setRollout(null)} onConfirm={onConfirm}/>}
 </AnalysisTab>;
}

/** The scope usage of the DHCP extension across the scope: the fullest scope first, as a meter list. */
export function DhcpUsageCard({devices,demo,now,query,onOpen,onShowDhcp}:{devices:Server[];demo:boolean;now:number;query:string;onOpen:(id:string)=>void;onShowDhcp:()=>void}){
 const t=useT(),[locale]=useLocale();
 const [loaded,setLoaded]=useState<DhcpUsageRow[]|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[revision,setRevision]=useState(0);
 const sequence=useRef(0);
 useEffect(()=>{
  if(demo)return;
  const current=++sequence.current;
  queueMicrotask(()=>setLoading(true));
  api<{rows:DhcpUsageRow[]}>('/api/dhcp?usage=1').then(result=>{if(current===sequence.current){setLoaded(result.rows);setError('');}},failure=>{if(current===sequence.current)setError(message(failure,locale));}).finally(()=>{if(current===sequence.current)setLoading(false);});
 },[demo,revision,locale]);
 const names=useMemo(()=>new Map(devices.map(device=>[device.id,device.name])),[devices]);
 const source=demo?dhcpUsageRows(demoDhcpServerId,dhcpUsageSummary(demoDhcpSnapshot(now)),now-6*60_000):loaded;
 const rows=sortDhcpUsageRows((source??[]).filter(row=>names.has(row.serverId)&&(!query||(names.get(row.serverId)??'').toLowerCase().includes(query))),id=>names.get(id)??id);
 const servers=new Set(rows.map(row=>row.serverId)).size;
 const retry=()=>setRevision(value=>value+1);
 const serverName=(row:DhcpUsageRow)=>names.get(row.serverId)??row.serverId;
 const columns:DataColumn<DhcpUsageRow>[]=[
  {id:'server',label:t('dhcp.fleet.col.server'),primary:true,cell:serverName},
  {id:'scope',label:t('dhcp.col.scope'),cell:row=><span className="sdx-dhcp-scope"><strong>{row.name||row.scopeId}</strong><small className="mono">{row.scopeId}</small></span>},
  {id:'family',label:t('dhcp.fleet.col.family'),cell:row=>row.family==='ipv4'?'IPv4':'IPv6'},
  {id:'range',label:t('dhcp.col.range'),mono:true,cell:row=>row.range},
  {id:'usage',label:t('dhcp.col.usage'),cell:row=><span className="sdx-dhcp-usage"><Meter size="sm" value={row.percent} label={t('dhcp.col.usage')+': '+percentLabel(row.percent,locale)}/><span className="mono">{percentLabel(row.percent,locale)}</span></span>},
  {id:'inUse',label:t('dhcp.col.inUse'),mono:true,cell:row=>row.total===null?row.inUse:t('dhcp.usageValue',{inUse:row.inUse,total:row.total})},
  {id:'read',label:t('dhcp.fleet.col.read'),cell:row=>relativeTime(row.collectedAt,now,locale)},
 ];
 // First load: the Skeleton; a failed load without data: the error with its retry; a failed refresh keeps the rows below the error and the stale sentence.
 return <Card title={t('dhcp.fleet.title')} icon={targetIcon('dhcp')} iconTone="accent" meta={t('dhcp.fleet.meta')} className="sdx-dhcp-fleet sdx-extensions-fleet-card" flush>
  {error&&<LoadFailed text={source?<>{t('dhcp.error.load')} {t('dhcp.error.stale')}</>:t('dhcp.error.load')} loading={loading} onRetry={retry}/>}
  {!source?!error&&<FirstLoad label={t('common.loading')} loading={loading} onRetry={retry}/>
   :<DataTable<DhcpUsageRow> label={t('dhcp.fleet.title')} variant="flush" cards entranceId="dhcp-usage-rows" columns={columns} rows={rows} rowKey={row=>row.serverId+'\u0000'+row.family+row.scopeId}
     onOpen={row=>onOpen(row.serverId)} openLabel={row=>t('dhcp.fleet.open',{name:serverName(row)})}
     empty={{icon:Router,title:t('dhcp.fleet.empty'),children:t('dhcp.fleet.emptyHint'),action:<Btn onClick={onShowDhcp}>{t('dhcp.fleet.showDhcp')}</Btn>}}
     foot={t('dhcp.fleet.count',{count:rows.length,servers:t('dhcp.fleet.servers',{count:servers})})}/>}
 </Card>;
}

/** The zones of every DNS server with the DNS extension: zone name first, then the server; the device search filters by server or zone. */
export function DnsZonesCard({devices,demo,now,query,onOpen,onShowDns}:{devices:Server[];demo:boolean;now:number;query:string;onOpen:(id:string)=>void;onShowDns:()=>void}){
 const t=useT(),[locale]=useLocale();
 const [loaded,setLoaded]=useState<DnsFleetZone[]|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[revision,setRevision]=useState(0);
 const sequence=useRef(0);
 useEffect(()=>{
  if(demo)return;
  const current=++sequence.current;
  queueMicrotask(()=>setLoading(true));
  api<{rows:DnsFleetZone[]}>('/api/dns?zones=1').then(result=>{if(current===sequence.current){setLoaded(result.rows);setError('');}},failure=>{if(current===sequence.current)setError(message(failure,locale));}).finally(()=>{if(current===sequence.current)setLoading(false);});
 },[demo,revision,locale]);
 const names=useMemo(()=>new Map(devices.map(device=>[device.id,device.name])),[devices]);
 const source=demo?dnsFleetRows(demoDnsServerId,dnsZoneSummary(demoDnsSnapshot(now)),demoDnsReadAt(now)):loaded;
 const rows=sortDnsFleetRows((source??[]).filter(row=>names.has(row.serverId)&&(!query||(names.get(row.serverId)??'').toLowerCase().includes(query)||row.zone.includes(query))),id=>names.get(id)??id);
 const servers=new Set(rows.map(row=>row.serverId)).size;
 const retry=()=>setRevision(value=>value+1);
 const serverName=(row:DnsFleetZone)=>names.get(row.serverId)??row.serverId;
 const columns:DataColumn<DnsFleetZone>[]=[
  {id:'server',label:t('dns.fleet.col.server'),primary:true,cell:serverName},
  {id:'zone',label:t('dns.col.zone'),mono:true,cell:row=>row.zone},
  {id:'type',label:t('dns.col.type'),cell:row=>dnsKindLabel(row.kind,t)},
  {id:'storage',label:t('dns.col.storage'),cell:row=>dnsStorageLabel({storage:row.storage,replicationScope:row.replicationScope,partition:null},t)},
  {id:'dynamic',label:t('dns.col.dynamic'),cell:row=>dnsDynamicLabel(row.dynamicUpdate,t)},
  {id:'records',label:t('dns.col.records'),mono:true,cell:row=>row.recordCount??EMPTY_VALUE},
  {id:'read',label:t('dns.fleet.col.read'),cell:row=>relativeTime(row.collectedAt,now,locale)},
 ];
 return <Card title={t('dns.fleet.title')} icon={targetIcon('dns')} iconTone="accent" meta={t('dns.fleet.meta')} className="sdx-dns-fleet sdx-extensions-fleet-card" flush>
  {error&&<LoadFailed text={source?<>{t('dns.error.load')} {t('dns.error.stale')}</>:t('dns.error.load')} loading={loading} onRetry={retry}/>}
  {!source?!error&&<FirstLoad label={t('common.loading')} loading={loading} onRetry={retry}/>
   :<DataTable<DnsFleetZone> label={t('dns.fleet.title')} variant="flush" cards entranceId="dns-fleet-rows" columns={columns} rows={rows} rowKey={row=>row.serverId+'\u0000'+row.zone}
     onOpen={row=>onOpen(row.serverId)} openLabel={row=>t('dns.fleet.open',{name:serverName(row)})}
     empty={{icon:Globe,title:t('dns.fleet.empty'),children:t('dns.fleet.emptyHint'),action:<Btn onClick={onShowDns}>{t('dns.fleet.showDns')}</Btn>}}
     foot={t('dns.fleet.count',{count:rows.length,servers:t('dns.fleet.servers',{count:servers})})}/>}
 </Card>;
}
