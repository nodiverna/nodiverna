'use client';
import {useId,useMemo,useRef,useState,type CSSProperties,type ReactNode} from 'react';
import {Activity,AlertTriangle,ArrowUpRight,CalendarClock,ChevronDown,ExternalLink,HeartPulse,Info,Lock,LockOpen,CheckCircle2,Cpu,Download,Flame,Gauge,HardDrive,MemoryStick,MonitorPlay,Network,OctagonAlert,RefreshCw,RotateCcw,ShieldAlert,ShieldCheck} from 'lucide-react';
import {Area,AreaChart,CartesianGrid,ResponsiveContainer,Tooltip,XAxis,YAxis} from 'recharts';
import {chartSeries,chartTooltip} from '@/ui/kit/chart';
import type {Job,Sample,Viewer} from '@/lib/types';
import type {AlertLevel} from '@/lib/alert-rules';
import {deviceConnection,deviceIssues,diskSummary,issueTarget,liveValue,type DeviceIssue,type IssueTarget} from '@/ui/base/ui-device';
import {deviceHealth,healthText,type HealthState} from '@/ui/base/health-score';
import {deviceIpv4Addresses,primaryDeviceAddress} from '@/ui/devices/device/device-network';
import {deviceOverviewGpus,deviceOverviewHistory,type DeviceOverviewTarget} from '@/ui/devices/device/device-overview';
import {diagnosticsDetailLabels,extensionsDetailLabels,hardwareDetailLabels,managementDetailLabels,softwareDetailLabels} from '@/lib/console-route';
import AgentUpdateNotice from '@/ui/devices/device/agent-update-notice';
import {permitted,type Device} from '@/ui/base/api';
import {Btn,Card,Empty,EntranceList,Skeleton,Facts,IconBtn,IconTile,Kpi,KpiRow,Meter,Segmented,Sparkline,StatusPill,cx,exactTime,relativeTime,shortOs,sparklineValues,type FactItem,type IconTone,type KpiTone,type StatusKind} from '@/ui/kit/kit';
import {bitlockerStatus,osSupportText,suspendedDuration,systemVolume} from '@/ui/devices/inventory/health-signals';
import {defenderProtectionRow} from '@/lib/defender';
import {formatSupportDate} from '@/ui/base/ui-device';
import {EsuDrawer,EsuOrigin,toneKind} from '@/ui/devices/inventory/os-support';
import {windowsLicenseText} from '@/ui/devices/device/windows-license-model';
import {DriveList,gibBytes} from '@/ui/devices/hardware/drive-list';
import {deviceType,deviceTypeLabels} from '@/ui/devices/device/device-type-model';
import {deviceManufacturer} from '@/ui/devices/hardware/manufacturer-model';
import {ManufacturerMark} from '@/ui/devices/hardware/manufacturer-mark';
import type {Locale} from '@/lib/i18n/locale';
import {translate,type MessageKey} from '@/lib/i18n/translate';
import {EMPTY_VALUE,formatBytes,formatDuration,formatNumber,formatPercent,formatRate,formatTemperature,formatTime} from '@/lib/i18n/format';

import {useLocale,useT} from '@/ui/base/locale';
type Range='30'|'60'|'360'|'1440';
const number=(locale:Locale,value:number|null|undefined,digits=1)=>typeof value==='number'&&Number.isFinite(value)?formatNumber(locale,value,{maximumFractionDigits:digits}):EMPTY_VALUE;
const percent=(value:number|null|undefined)=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=100?value:null;
/** A positive byte count in IEC units, or null when it is missing. */
const sizeOf=(locale:Locale,bytes:number|null|undefined)=>typeof bytes==='number'&&Number.isFinite(bytes)&&bytes>0?formatBytes(locale,bytes):null;
function uptime(locale:Locale,seconds:number|null|undefined){
 if(typeof seconds!=='number'||!Number.isFinite(seconds)||seconds<0)return EMPTY_VALUE;
 const days=Math.floor(seconds/86400),hours=Math.floor(seconds%86400/3600),minutes=Math.floor(seconds%3600/60);
 return days?translate(locale,'device.uptime.days',{count:days,hours}):hours?translate(locale,'device.uptime.hours',{hours,minutes}):translate(locale,'device.uptime.minutes',{minutes});
}

type Navigate=(target:DeviceOverviewTarget)=>void;
type Props={server:Device;viewer:Viewer;demo:boolean;now:number;samples:Sample[];jobs:Job[];historyLoading:boolean;onNavigate?:Navigate;onRefreshInventory:()=>void;refreshBlocked:string;
 /** Opens a group on its OS support tab (the origin of an inherited ESU date). */
 onOpenEsuGroup?:(groupId:string)=>void;
 /** Opens the customer on its OS support tab; absent while the viewer has no customer view (the origin is plain text then). */
 onOpenEsuCustomer?:(customerId:string)=>void;
 /** Reloads the console data after the description or an ESU date changed. */
 onRefresh?:()=>Promise<void>|void};
type Tone='ok'|'warning'|'critical'|'neutral';
const rowTiles:Record<Tone,IconTone>={ok:'success',warning:'warning',critical:'danger',neutral:'neutral'};
// A usage value against its limits; the KPI tile, meter and sparkline take their tone from it.
type Usage='normal'|'warning'|'critical'|'unknown';
const usageOf=(value:number|null,warning=80,critical=90):Usage=>value==null?'unknown':value>=critical?'critical':value>=warning?'warning':'normal';
const usageTones:Record<Usage,KpiTone>={normal:'accent',warning:'warning',critical:'critical',unknown:'neutral'};
const sparkTone=(usage:Usage)=>usage==='warning'||usage==='critical'?usage:undefined;

// ---- Health line ----
const healthTiles:Record<HealthState,IconTone>={critical:'danger',warning:'warning',good:'success',unknown:'neutral'};
const healthPills:Record<HealthState,StatusKind>={critical:'critical',warning:'warning',good:'success',unknown:'neutral'};
const levelIcons={critical:OctagonAlert,warning:AlertTriangle,info:Info} satisfies Record<AlertLevel,unknown>;
const levelKeys:Record<AlertLevel,MessageKey>={critical:'alertRules.level.critical',warning:'alertRules.level.warning',info:'alertRules.level.info'};
export type HealthIssue=DeviceIssue&{target:IssueTarget|null};
/**
 * The issues of the health line in server order (critical → warning → info), each with the
 * area that fixes it. Device offline is left out: the shared state notice above the area says it.
 */
export function healthLineIssues(server:Device,now:number,locale:Locale):HealthIssue[]{
 const sources=new Map((server.issues??[]).map(issue=>[issue.key,issue]));
 return deviceIssues(server,now,locale).flatMap(issue=>{
  const source=sources.get(issue.key);
  return source?.ruleId==='device-offline'?[]:[{...issue,target:source?issueTarget(source,server):null}];
 });
}
/**
 * The label of a fix link: the driver inventory for a crash with a driver, otherwise "Open <area>" with the
 * subarea name ("Open DHCP server" for the DHCP server of the Extensions area, "Open Extensions" for its overview).
 */
export function fixLinkLabel(locale:Locale,target:IssueTarget):string{
 if(target.section==='software'&&target.software==='drivers'&&target.driver)return translate(locale,'drivers.showInInventory');
 const area=target.section==='diagnostics'?diagnosticsDetailLabels[target.diagnosis]:target.section==='management'?managementDetailLabels[target.management]:target.section==='software'?softwareDetailLabels[target.software]:target.section==='extensions'?extensionsDetailLabels[target.extensions]:target.hardware==='overview'?'device.section.hardware':hardwareDetailLabels[target.hardware];
 return translate(locale,'device.health.openArea',{area:translate(locale,area)});
}
export type HealthLineProps={server:Device;now:number;locale:Locale;
 /** The other issues show below the line. DeviceSummary owns the state. */
 expanded:boolean;onToggle:()=>void;
 /** The id of the list of the other issues (aria-controls of the toggle). */
 listId:string;
 /** Without it (no view right, removed device) the line shows no fix links. */
 onNavigate?:Navigate;
 /** Set by EntranceList for the entrance. */
 className?:string;style?:CSSProperties};
/**
 * The focal point of the Overview: the health state with its score, the most urgent issue
 * with the link to the area that fixes it, and the other issues behind one disclosure
 * button. Without hooks, so a test can render each state directly.
 */
/** Agent reasons the catalog does not know (ui/base/agent-reasons.ts), as received in mono after the issue title. */
const agentReasons=(issue:Pick<DeviceIssue,'unknown'>)=>issue.unknown?.map((line,index)=><span key={index} className="mono sdx-agent-reason">{line}</span>);

export function HealthLineView({server,now,locale,expanded,onToggle,listId,onNavigate,className,style}:HealthLineProps){
 const health=deviceHealth(server),text=healthText(health,locale);
 const [lead,...others]=healthLineIssues(server,now,locale);
 const online=deviceConnection(server,now,locale).kind==='online';
 const pill=health.state==='unknown'||health.score===null?text.label:translate(locale,'health.withScore',{state:text.label,score:health.score});
 const fix=(issue:HealthIssue)=>issue.target&&onNavigate?<Btn variant="ghost" size="sm" icon={ArrowUpRight} className="sdx-health-fix" onClick={()=>onNavigate(issue.target!)}>{fixLinkLabel(locale,issue.target)}</Btn>:null;
 const leadFix=lead?fix(lead):null,titleId=listId+'-title';
 return <section className={cx('sdx-health-line','sdx-health-line-'+health.state,className)} style={style} aria-labelledby={titleId}>
  <h2 id={titleId} className="sr-only">{translate(locale,'device.health.title')}</h2>
  <div className="sdx-health-line-main">
   <span className="sdx-health-line-state"><IconTile icon={HeartPulse} tone={healthTiles[health.state]}/><StatusPill kind={healthPills[health.state]} title={text.tooltip}>{pill}</StatusPill></span>
   {lead?<p className="sdx-health-line-issue"><strong>{lead.title}</strong>{agentReasons(lead)}{lead.detail&&<span>{lead.detail}</span>}</p>
    :<p className="sdx-health-line-issue sdx-health-line-calm">{translate(locale,!server.snapshot?'device.summary.issuesAfterInventory':online?'device.summary.noIssues':'device.summary.issuesNextReport')}</p>}
   {(leadFix||others.length>0)&&<span className="sdx-health-line-actions">
    {leadFix}
    {others.length>0&&<Btn variant="ghost" size="sm" icon={ChevronDown} className="sdx-health-toggle" aria-expanded={expanded} aria-controls={listId} onClick={onToggle}>{expanded?translate(locale,'device.health.showFewer'):translate(locale,'device.health.showMore',{count:others.length})}</Btn>}
   </span>}
  </div>
  {expanded&&others.length>0&&<ul id={listId} className="sdx-health-issues" aria-label={translate(locale,'device.health.allIssues')}>{others.map(issue=>{
   const Icon=levelIcons[issue.level];
   return <li key={issue.key}>
    <Icon size={16} aria-hidden className={'sdx-health-level-'+issue.level}/><span className="sr-only">{translate(locale,levelKeys[issue.level])}</span>
    <span className="sdx-health-issue-text"><strong>{issue.title}</strong>{agentReasons(issue)}{issue.detail&&<span>{issue.detail}</span>}</span>
    {fix(issue)}
   </li>;
  })}</ul>}
 </section>;
}

/** Device overview: the health line, headline values, one clear history chart, protection state, drives, throughput and system facts. */
export default function DeviceSummary({server,viewer,demo,now,samples,jobs,historyLoading,onNavigate,onRefreshInventory,refreshBlocked,onOpenEsuGroup,onOpenEsuCustomer,onRefresh}:Props){
 const t=useT(),[locale]=useLocale();
 const [range,setRange]=useState<Range>('60'),[metric,setMetric]=useState('cpu'),chartId=useId().replace(/[^a-zA-Z0-9_-]/g,''),listId=chartId+'-issues';
 // The issue list is open for one device only; another device starts collapsed.
 const [expandedFor,setExpandedFor]=useState<string|null>(null),expanded=expandedFor===server.id;
 const snapshot=server.snapshot,connection=deviceConnection(server,now,locale),online=connection.kind==='online';
 const cpu=percent(liveValue(server,snapshot?.cpu,now)),memory=percent(liveValue(server,snapshot?.memory,now));
 const disk=diskSummary(server),address=primaryDeviceAddress(server),ipv4=deviceIpv4Addresses(server);
 const gpus=deviceOverviewGpus(snapshot,online&&server.revoked===0,now);
 const history=useMemo(()=>deviceOverviewHistory(samples,server.id,now,Number(range)),[samples,server.id,now,range]);
 // The KPI sparklines always show the last 60 minutes, whatever range the chart shows.
 const recent=useMemo(()=>deviceOverviewHistory(samples,server.id,now,60),[samples,server.id,now]);
 const navigate=server.revoked===0&&permitted(server,viewer,'view')?onNavigate:undefined;
 const diskUsed=disk?100-disk.freeGb/disk.totalGb*100:null;
 const cpuName=snapshot?.hardware?.cpus?.[0]?.name?.replace(/\s+/g,' ').trim();
 const link=(label:string,target:DeviceOverviewTarget)=>navigate?<IconBtn icon={ArrowUpRight} label={label} onClick={()=>navigate(target)}/>:null;
 // Live values only: a sparkline once there are 2 values in the last hour, otherwise a meter of the
 // current value. Offline or never reported, the tile shows no visual: a trend of old values would look live.
 const usageVisual=(value:number|null,usage:Usage,key:string|undefined,label:string)=>{
  if(!online)return undefined;
  const values=key?recent.points.map(point=>point[key]):[];
  if(sparklineValues(values).length>=2)return <Sparkline values={values} label={t('device.summary.sparkline',{label})} tone={sparkTone(usage)}/>;
  return value==null?undefined:<Meter value={value} label={label}/>;
 };
 const cpuUsage=usageOf(cpu),memoryUsage=usageOf(memory),diskUsage=usageOf(diskUsed,85,95);
 const memoryTotal=snapshot?.memoryGb?formatBytes(locale,gibBytes(snapshot.memoryGb)):null;
 const storageLabel=disk?t('device.summary.fullestDrive',{name:disk.name}):t('device.summary.storage');

 // One series at a time keeps the chart readable. GPUs only appear when they reported values.
 const metrics=[{id:'cpu',label:t('fleet.col.cpu')},{id:'memory',label:t('fleet.col.memory')},...history.gpus.map(gpu=>({id:gpu.key,label:gpu.label}))];
 const activeMetric=metrics.some(item=>item.id===metric)?metric:'cpu';
 const series=history.points.map(point=>point[activeMetric]).filter((value):value is number=>typeof value==='number');
 const average=series.length?series.reduce((sum,value)=>sum+value,0)/series.length:null,peak=series.length?Math.max(...series):null;
 const metricLabel=metrics.find(item=>item.id===activeMetric)?.label??t('fleet.col.cpu');

 const made=deviceManufacturer(server);
 const systemFacts:FactItem[]=[
  {id:'os',label:t('fleet.col.os'),value:shortOs(snapshot?.os)||EMPTY_VALUE,hint:snapshot?.build?t('device.summary.build',{build:snapshot.build}):null},
  {id:'type',label:t('deviceType.label'),value:t(deviceTypeLabels[deviceType(server)])},
  {id:'hardware',label:t('device.section.hardware'),value:snapshot?made.manufacturer?<><ManufacturerMark manufacturer={made.manufacturer}/>{made.model&&<> · {made.model}</>}</>:[snapshot.manufacturer,snapshot.model].filter(Boolean).join(' · ')||t('device.summary.notCollected'):EMPTY_VALUE},
  {id:'hostname',label:t('device.summary.hostname'),value:snapshot?.hostname||server.name,hint:server.previousNames?.[0]?t('device.name.previously',{name:server.previousNames[0]}):null},
  {id:'domain',label:t('management.param.domain'),value:snapshot?.domain||EMPTY_VALUE,hint:snapshot?.security&&snapshot.security.domainRole>=4?t('management.domainController'):null},
  {id:'address',label:t('device.overview.ipAddress'),value:address??EMPTY_VALUE,mono:true,hint:ipv4.length>1?t('device.summary.moreIps',{value:ipv4.length-1}):null},
  {id:'agent',label:t('fleet.col.agent'),value:snapshot?.agentVersion||EMPTY_VALUE,mono:true,hint:snapshot?.mode??t('device.summary.modePending')},
  {id:'last-seen',label:t('fleet.col.lastSeen'),value:<span title={exactTime(server.lastSeen,locale)}>{relativeTime(server.lastSeen,now,locale)}</span>},
  // Uptime is a fact, not a KPI tile: the row keeps four tiles. Only a device that is online now has a current uptime.
  {id:'uptime',label:t('device.summary.uptime'),value:online&&typeof snapshot?.uptimeSeconds==='number'&&Number.isFinite(snapshot.uptimeSeconds)&&snapshot.uptimeSeconds>=0?uptime(locale,snapshot.uptimeSeconds):EMPTY_VALUE,hint:snapshot?.security?.lastBoot?t('device.summary.since',{exactTime:exactTime(snapshot.security.lastBoot,locale)}):t('device.summary.bootUnknown')},
  {id:'os-support',label:t('osSupport.fact'),value:<OsSupportValue server={server} viewer={viewer} demo={demo} onOpenEsuGroup={onOpenEsuGroup} onOpenEsuCustomer={onOpenEsuCustomer} onRefresh={onRefresh}/>},
  {id:'windows-license',label:t('windowsLicense.fact'),value:<WindowsLicenseValue server={server} now={now} locale={locale}/>},
  ...(gpus.length>0?[{id:'graphics',label:t('device.summary.graphics'),value:gpus.map(gpu=>gpu.name).join(', ')}]:[]),
 ];

 return <div className="sdx-summary">
  <EntranceList id="device-health" className="sdx-health-wrap">
   <HealthLineView key="health" server={server} now={now} locale={locale} expanded={expanded} onToggle={()=>setExpandedFor(expanded?null:server.id)} listId={listId} onNavigate={navigate}/>
  </EntranceList>

  <KpiRow label={t('device.summary.currentValues')} entranceId="device-kpis">
   <Kpi live key="cpu" icon={Cpu} tone={usageTones[cpuUsage]} label={t('fleet.col.cpu')} value={cpu} unit="%" visual={usageVisual(cpu,cpuUsage,'cpu',t('fleet.col.cpu'))} detail={cpuName||(snapshot?.cores?t('device.summary.cores',{count:snapshot.cores}):t('device.summary.cpuPending'))} detailTitle={cpuName} action={link(t('device.summary.openCpu'),{section:'hardware',hardware:'cpu'})}/>
   <Kpi live key="memory" icon={MemoryStick} tone={usageTones[memoryUsage]} label={t('fleet.col.memory')} value={memory} unit="%" visual={usageVisual(memory,memoryUsage,'memory',t('fleet.col.memory'))} detail={snapshot?.memoryGb&&memoryTotal?memory!=null?t('device.summary.memoryUsedOf',{used:formatBytes(locale,gibBytes(snapshot.memoryGb*memory/100)),total:memoryTotal}):t('device.summary.memorySizeUsable',{size:memoryTotal}):t('device.summary.memoryPending')} action={link(t('device.summary.openMemory'),{section:'hardware',hardware:'memory'})}/>
   {gpus.slice(0,1).map(gpu=>{
    // At most four tiles: one GPU tile for the first card; the other cards stay in the chart's metric switch and in Hardware.
    const details=snapshot?.gpuDetails?.find(item=>item.id===gpu.id),vram=sizeOf(locale,details?.dedicatedMemoryBytes),used=sizeOf(locale,details?.dedicatedMemoryUsedBytes);
    const detail=[gpu.name,used&&vram?t('device.summary.vram',{used,vram}):vram,typeof details?.temperatureCelsius==='number'?formatTemperature(locale,details.temperatureCelsius):null].filter(Boolean).join(' · ');
    const usage=usageOf(gpu.utilization),label='GPU';
    return <Kpi live key={gpu.id} icon={MonitorPlay} tone={usageTones[usage]} label={label} value={gpu.utilization} unit="%" visual={usageVisual(gpu.utilization,usage,recent.gpus.find(series=>series.id===gpu.id)?.key,label)} detail={detail||(online?t('device.summary.noDetails'):t('device.summary.afterNextReport'))} detailTitle={gpu.name} action={link(t('fleet.openDevice',{name:gpu.name}),{section:'hardware',hardware:'gpu',gpuId:gpu.id})}/>;
   })}
   <Kpi live key="storage" icon={HardDrive} tone={usageTones[diskUsage]} label={storageLabel} value={disk?formatBytes(locale,gibBytes(disk.freeGb)):null} unit={disk?t('device.summary.free'):undefined} visual={disk?<Meter value={diskUsed} label={storageLabel} warning={85} critical={95}/>:undefined} detail={disk?t('device.summary.ofSize',{size:formatBytes(locale,gibBytes(disk.totalGb))}):t('device.summary.drivesPending')} action={disk?link(t('device.summary.openDisk',{name:disk.name}),{section:'management',management:'storage',drive:disk.name}):null}/>
  </KpiRow>

  <EntranceList id="device-cards" className="sdx-summary-grid">
   <Card key="history" title={t('device.summary.utilization')} icon={Activity} iconTone="neutral" className="sdx-span-2 sdx-history-card" meta={history.available&&average!=null?t('device.summary.metricMeta',{metric:metricLabel,average:formatPercent(locale,average),peak:formatPercent(locale,peak)}):online?t('device.summary.agentValues'):t('device.summary.historicValues')}
    actions={<>
     <Segmented label={t('device.summary.metric')} size="sm" value={activeMetric} onChange={setMetric} items={metrics}/>
     <Segmented<Range> label={t('device.summary.range')} size="sm" value={range} onChange={setRange} items={[{id:'30',label:t('device.summary.range30')},{id:'60',label:t('device.summary.range60')},{id:'360',label:t('device.summary.range360')},{id:'1440',label:t('device.summary.range1440')}]}/>
    </>}>
    <UsageChart history={history} metric={activeMetric} label={metricLabel} chartId={chartId} loading={historyLoading}/>
   </Card>
   <Protection key="protection" server={server} now={now} online={online} onNavigate={navigate}/>

   <Card key="drives" title={t('device.summary.drives')} icon={HardDrive} iconTone="neutral" className="sdx-span-2" meta={t('device.summary.drivesMeta')}>
    <DriveList disks={snapshot?.disks} onOpen={navigate?name=>navigate({section:'management',management:'storage',drive:name}):undefined}/>
   </Card>
   <Card key="throughput" title={t('device.summary.throughput')} icon={Gauge} iconTone="neutral" meta={online?t('device.summary.currentValues'):t('device.summary.afterNextReportAvailable')}>
    <dl className="sdx-throughput">
     <Throughput label={t('device.summary.diskRead')} value={online?formatRate(locale,snapshot?.performance?.diskReadBytesSec):EMPTY_VALUE}/>
     <Throughput label={t('device.summary.diskWrite')} value={online?formatRate(locale,snapshot?.performance?.diskWriteBytesSec):EMPTY_VALUE}/>
     <Throughput label={t('device.summary.diskLatency')} value={online?formatDuration(locale,snapshot?.performance?.diskLatencyMs):EMPTY_VALUE} warn={online&&(snapshot?.performance?.diskLatencyMs??0)>=25}/>
     <Throughput label={t('management.category.network')} value={online?formatRate(locale,snapshot?.performance?.networkBytesSec):EMPTY_VALUE}/>
    </dl>
   </Card>

   <Card key="system" title={t('management.category.system')} icon={Network} iconTone="neutral" className="sdx-span-full sdx-system-card" actions={<><IconBtn icon={RefreshCw} label={t('management.action.refresh')} blocked={refreshBlocked||undefined} onClick={onRefreshInventory}/>{link(t('device.summary.openSystemConfig'),{section:'management',management:'system'})}</>}>
    <Facts items={systemFacts} columns={3} stacked/>
    <div className="sdx-embedded"><AgentUpdateNotice server={server} viewer={viewer} demo={demo} jobs={jobs} now={now}/></div>
   </Card>
  </EntranceList>
 </div>;
}

/** The value of the fact "OS support": status with the ESU button, ESU date with its origin, the Microsoft source and the ESU drawer. */
function OsSupportValue({server,viewer,demo,onOpenEsuGroup,onOpenEsuCustomer,onRefresh}:{server:Device;viewer:Viewer;demo:boolean;onOpenEsuGroup?:(groupId:string)=>void;onOpenEsuCustomer?:(customerId:string)=>void;onRefresh?:()=>Promise<void>|void}){
 const t=useT(),[locale]=useLocale(),[open,setOpen]=useState(false),button=useRef<HTMLButtonElement>(null);
 const support=server.osSupport,text=osSupportText(support,locale),esu=support?.esu;
 const blocked=demo?t('kit.unavailable.demo'):!permitted(server,viewer,'alerts.manage')?t('osSupport.esu.blockedRight'):undefined;
 return <span className="sdx-os-support-value">
  <span className="sdx-fact-line"><StatusPill kind={toneKind[text.tone]}>{text.text}</StatusPill><IconBtn ref={button} icon={CalendarClock} label={t('osSupport.esu.menu')} blocked={blocked} onClick={()=>setOpen(true)}/></span>
  {text.hint&&<small>{text.hint}</small>}
  {esu&&<small className="sdx-fact-line">{t('osSupport.esu',{date:formatSupportDate(locale,esu.until)})}{esu.origin.type!=='device'&&<EsuOrigin origin={{...esu.origin,type:esu.origin.type}} onOpenGroup={onOpenEsuGroup} onOpenCustomer={onOpenEsuCustomer}/>}</small>}
  {support?.entry&&<small><a href={support.entry.source} target="_blank" rel="noopener noreferrer" className="sdx-external"><ExternalLink size={12} aria-hidden/>{t('osSupport.source')}</a></small>}
  <EsuDrawer open={open} onClose={()=>setOpen(false)} returnFocus={button} scope={{type:'device',id:server.id}} demo={demo} onRefresh={()=>onRefresh?.()} onOpenGroup={onOpenEsuGroup} onOpenCustomer={onOpenEsuCustomer}/>
 </span>;
}
/** The value of the fact "Windows activation": the state as a pill (its colour follows the device's issue), then up to two meta lines. */
export function WindowsLicenseValue({server,now,locale}:{server:Device;now:number;locale:Locale}){
 const text=windowsLicenseText(server,now,locale);
 return <span className="sdx-os-support-value">
  <span className="sdx-fact-line"><StatusPill kind={toneKind[text.tone]}>{text.text}</StatusPill></span>
  {text.lines.map(line=><small key={line}>{line}</small>)}
 </span>;
}
function Throughput({label,value,warn=false}:{label:string;value:string;warn?:boolean}){return <div className={cx(warn&&'warn')}><dt>{label}</dt><dd className="mono">{value}</dd></div>;}

type ProtectionRow={key:string;icon:typeof Cpu;label:string;value:string;detail?:string;tone:Tone;target?:DeviceOverviewTarget};
/** Security and maintenance state at a glance: Defender, firewall, updates, restart, BitLocker and remote access, as flat rows. */
function Protection({server,now,online,onNavigate,className,style}:{server:Device;now:number;online:boolean;onNavigate?:Navigate;className?:string;style?:CSSProperties}){
 const t=useT(),[locale]=useLocale();
 const snapshot=server.snapshot,security=snapshot?.security,updates=snapshot?.updates,rows:ProtectionRow[]=[];
 // From agent 4.14.0 the row reads snapshot.defender and opens the Defender area; older agents keep security.defender.
 const defender=defenderProtectionRow(server,now,locale);
 if(defender)rows.push({key:'defender',icon:ShieldAlert,label:t('defender.title'),...defender});
 if(security?.firewall?.length){
  const active=security.firewall.filter(profile=>profile.enabled),off=security.firewall.filter(profile=>!profile.enabled).map(profile=>profile.name);
  rows.push({key:'firewall',icon:off.length?ShieldAlert:Flame,label:t('device.protection.firewall'),value:t('device.firewallProfiles',{active:active.length,count:security.firewall.length}),detail:off.length?t('device.protection.off',{join:off.join(', ')}):undefined,tone:off.length?'warning':'ok',target:{section:'management',management:'network'}});
 }
 if(updates)rows.push({key:'updates',icon:Download,label:t('device.area.updates'),value:updates.pendingCount?t('device.updatesPending',{count:updates.pendingCount}):t('device.updatesCurrent'),detail:updates.checkedAt?t('device.updatesChecked',{time:relativeTime(Date.parse(updates.checkedAt),now,locale).toLocaleLowerCase(locale)}):undefined,tone:updates.pendingCount?'warning':'ok',target:{section:'management',management:'updates'}});
 // File operations that wait for a restart explain the restart row, so they are its detail.
 const pendingFiles=snapshot?.pendingFileOperationsCount??0;
 if(snapshot)rows.push({key:'restart',icon:RotateCcw,label:t('device.protection.restart'),value:snapshot.rebootPending?t('device.protection.pending'):t('device.protection.notRequired'),detail:pendingFiles>0?t('device.pendingFileOperations',{count:pendingFiles}):undefined,tone:snapshot.rebootPending?'warning':'ok',target:{section:'management',management:'system'}});
 const bitlocker=snapshot?.bitlocker;
 if(bitlocker){
  const status=bitlockerStatus(bitlocker),system=systemVolume(bitlocker),storage:DeviceOverviewTarget={section:'management',management:'storage'};
  const percent=formatPercent(locale,system?.percent??0);
  if(status==='not-available')rows.push({key:'bitlocker',icon:Lock,label:t('bitlocker.protection.label'),value:t('bitlocker.notAvailable'),detail:t('bitlocker.protection.notAvailableHint'),tone:'neutral',target:storage});
  else if(status==='suspended')rows.push({key:'bitlocker',icon:LockOpen,label:t('bitlocker.protection.label'),value:system?.suspendedSince?t('bitlocker.protection.suspendedFor',{duration:suspendedDuration(system.suspendedSince,now,locale)}):t('bitlocker.suspended'),tone:'warning',target:storage});
  else if(status==='encrypted')rows.push({key:'bitlocker',icon:Lock,label:t('bitlocker.protection.label'),value:t('bitlocker.protection.systemEncrypted'),tone:'ok',target:storage});
  else if(status==='encrypting')rows.push({key:'bitlocker',icon:Lock,label:t('bitlocker.protection.label'),value:t('bitlocker.encrypting',{percent}),tone:'neutral',target:storage});
  else if(status==='not-encrypted')rows.push({key:'bitlocker',icon:LockOpen,label:t('bitlocker.protection.label'),value:t('bitlocker.protection.systemNotEncrypted'),tone:'warning',target:storage});
 }
 if(security){const weak=snapshot?.rdp?.enabled===true&&!snapshot.rdp.nla;rows.push({key:'rdp',icon:MonitorPlay,label:t('device.section.rdp'),value:security.rdpEnabled?t('device.protection.allowed'):t('device.protection.blocked'),detail:weak?t('device.protection.noNla'):undefined,tone:weak?'warning':'neutral'});}
 return <Card title={t('device.protection.title')} icon={ShieldCheck} iconTone="neutral" className={className} style={style} meta={online?undefined:t('device.protection.lastReport')}>
  {rows.length?<ul className="sdx-protection">{rows.map(row=>{
   const content:ReactNode=<><IconTile icon={row.tone==='ok'?CheckCircle2:row.icon} tone={rowTiles[row.tone]} size="sm"/><span className="sdx-protection-text"><small>{row.label}</small><strong>{row.value}</strong>{row.detail&&<em>{row.detail}</em>}</span></>;
   return <li key={row.key}>{row.target&&onNavigate?<button type="button" onClick={()=>onNavigate(row.target!)} aria-label={t('device.protection.open',{label:row.label,value:row.value})}>{content}<ArrowUpRight size={14} aria-hidden className="sdx-drive-go"/></button>:<div>{content}</div>}</li>;
  })}</ul>:<Empty icon={ShieldCheck} title={t('device.protection.none')}>{t('device.protection.noneHint')}</Empty>}
 </Card>;
}

function UsageChart({history,metric,label,chartId,loading}:{history:ReturnType<typeof deviceOverviewHistory>;metric:string;label:string;chartId:string;loading:boolean}){
 const t=useT(),[locale]=useLocale();
 const {points,available}=history;
 if(!available)return <div className="sdx-chart-empty" aria-busy={loading}>{loading?<Skeleton variant="chart" label={t('common.loading')}/>:<Empty icon={Activity} title={t('device.chart.empty')}>{t('device.chart.emptyHint')}</Empty>}</div>;
 const gradient=chartId+'-fill';
 return <div className="sdx-chart" role="img" aria-label={t('device.chart.label',{label})}>
  <ResponsiveContainer className="sdx-chart-fill" width="100%" height="100%" minWidth={1} minHeight={230}><AreaChart data={points} margin={{top:8,right:8,bottom:0,left:-18}}>
   <defs><linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={chartSeries} stopOpacity={0.26}/><stop offset="100%" stopColor={chartSeries} stopOpacity={0}/></linearGradient></defs>
   <CartesianGrid stroke="var(--sd-soft-line)" vertical={false}/>
   <XAxis dataKey="at" type="number" scale="time" domain={['dataMin','dataMax']} minTickGap={48} tickFormatter={at=>formatTime(locale,at,{hour:'2-digit',minute:'2-digit'})} tick={{fontSize:11,fill:'var(--sd-muted)'}} axisLine={false} tickLine={false}/>
   <YAxis domain={[0,100]} ticks={[0,25,50,75,100]} unit="%" tick={{fontSize:11,fill:'var(--sd-muted)'}} axisLine={false} tickLine={false}/>
   <Tooltip {...chartTooltip} labelFormatter={at=>formatTime(locale,Number(at))} formatter={value=>[t('device.chart.percent',{value:number(locale,typeof value==='number'?value:null)}),label]}/>
   <Area type="monotone" dataKey={metric} name={metric} stroke={chartSeries} fill={`url(#${gradient})`} strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false}/>
  </AreaChart></ResponsiveContainer>
 </div>;
}
