'use client';

import {useLayoutEffect,useMemo,useRef,useState,type ReactNode} from 'react';
import {ArrowUpRight,Check,CircuitBoard,Clock3,Copy,Cpu,FileStack,Gpu,HardDrive,Info,LineChart,Lock,MemoryStick,Network,Server as ServerIcon,ShieldCheck,TriangleAlert} from 'lucide-react';
import {Area,AreaChart,CartesianGrid,ResponsiveContainer,Tooltip,XAxis,YAxis} from 'recharts';
import {chartSeries,chartTooltip} from '@/ui/kit/chart';
import {toast} from 'sonner';
import type {HardwareCpu,HardwareInventory,HardwareMemoryModule,HardwareNetworkAdapter,HardwarePhysicalDisk,Job,Sample,Viewer} from '@/lib/types';
import {deviceConnection,liveValue} from '@/ui/base/ui-device';
import {permitted,type Device} from '@/ui/base/api';
import {deviceOverviewGpus,deviceOverviewSamples,type DeviceOverviewTarget} from '@/ui/devices/device/device-overview';
import {BatteryBlock,batteryView} from '@/ui/devices/hardware/disk-health';
import DeviceGpu from '@/ui/devices/hardware/device-gpu';
import type {Confirmation} from '@/ui/base/confirmation';
import {defaultLocale,type Locale} from '@/lib/i18n/locale';
import {translate,type MessageKey} from '@/lib/i18n/translate';
import {hardwareDetailLabels} from '@/lib/console-route';
import {EMPTY_VALUE,formatBytes,formatDateTime,formatDuration,formatNumber,formatRate,formatTime} from '@/lib/i18n/format';
import {Btn,Card,Empty,EntranceList,Facts,Kpi,KpiRow,Meter,Notice,Skeleton,StatusPill,type FactItem,type KpiTone} from '@/ui/kit/kit';
import {DataTable,type DataColumn} from '@/ui/kit/data-table';
import {DriveList,gibBytes} from '@/ui/devices/hardware/drive-list';
import {ComponentCard} from '@/ui/devices/hardware/component-card';
import {deviceType,deviceTypeIcons} from '@/ui/devices/device/device-type-model';
import {deviceManufacturer} from '@/ui/devices/hardware/manufacturer-model';
import {ManufacturerMark} from '@/ui/devices/hardware/manufacturer-mark';
import {HistoryRangeSwitch,type HistoryRange} from '@/ui/devices/hardware/history-range';
import '@/ui/devices/hardware/device-hardware.css';

import {useLocale,useT} from '@/ui/base/locale';
import {Tabs,tabId} from '@/ui/kit/tabs';
export type HardwareSection='overview'|'cpu'|'memory'|'storage'|'network'|'system'|'gpu';
type Focus={serverId:string;section:HardwareSection;gpuId?:string;drive?:string;revision:number};
type Navigate=(target:DeviceOverviewTarget)=>void;
/**
 * detail and gpu control the tab and the 1-based GPU position from the link. Without
 * detail the component keeps its own tab state. onDetailChange reports tab and GPU changes.
 */
type Props={server:Device;viewer:Viewer;demo:boolean;now:number;samples:Sample[];jobs:Job[];historyLoading?:boolean;focus?:Focus;onNavigate?:Navigate;detail?:HardwareSection;gpu?:number;onDetailChange?:(section:HardwareSection,gpu?:number)=>void;/** Opens the console's confirmation (GPU driver update). */onConfirm?:(confirmation:Confirmation)=>void;
 /** The link of a subarea (and GPU position); with it every subarea tab is a link tab. */subareaHref?:(section:HardwareSection,gpu?:number)=>string;
 /** id of the subarea tabpanel; the tab bar points to it. */panelId?:string};
const hardwarePanelId='dhw-panel';
const labels:Readonly<Record<HardwareSection,MessageKey>>=hardwareDetailLabels;
/** How long the copy button shows its check after a successful copy (ms). */
const copiedFor=1200;
const valid=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const number=(locale:Locale,value:unknown,digits=1)=>valid(value)?formatNumber(locale,value,{maximumFractionDigits:digits}):EMPTY_VALUE;
/** A positive byte count in IEC units; a missing, zero or invalid capacity gives EMPTY_VALUE. */
const capacity=(locale:Locale,value:unknown)=>valid(value)&&value>0?formatBytes(locale,value):EMPTY_VALUE;
/** A size in MiB (page files) in IEC units. */
const mib=(locale:Locale,value:unknown)=>valid(value)?formatBytes(locale,value*1024**2):EMPTY_VALUE;
const mhz=(locale:Locale,value:unknown)=>valid(value)?translate(locale,'hardware.unit.mhz',{value:number(locale,value,0)}):EMPTY_VALUE;
const text=(value:unknown)=>typeof value==='string'&&value.trim()?value.trim():EMPTY_VALUE;
const percent=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=100?value:null;
const usageTone=(value:number|null):KpiTone=>value===null?'neutral':value>=90?'critical':value>=80?'warning':'accent';
const date=(locale:Locale,value:unknown)=>{const stamp=typeof value==='number'?value:typeof value==='string'?Date.parse(value):NaN;return Number.isFinite(stamp)?formatDateTime(locale,stamp,{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}):EMPTY_VALUE;};
export function deviceHardwareInventory(server:Device):HardwareInventory|undefined{
 const hardware=server.snapshot?.hardware;
 return hardware&&typeof hardware==='object'&&!Array.isArray(hardware)?hardware:undefined;
}
export function deviceInstalledMemoryBytes(hardware:HardwareInventory|undefined):number|null{
 const modules=hardware?.memoryModules;
 if(hardware?.complete!==true||!Array.isArray(modules)||!modules.length||modules.some(module=>typeof module.capacityBytes!=='number'||!Number.isSafeInteger(module.capacityBytes)||module.capacityBytes<=0))return null;
 const total=modules.reduce((sum,module)=>sum+module.capacityBytes!,0);
 return Number.isSafeInteger(total)?total:null;
}
/** The inventory as plain text for the clipboard. Sizes in IEC units; no serial numbers. The drive line drops the colon of "C:", which the sentence adds. */
export function deviceHardwareSummary(server:Device,locale:Locale=defaultLocale):string{
 const snapshot=server.snapshot,hardware=deviceHardwareInventory(server),gpu=deviceOverviewGpus(snapshot,false,0),installedBytes=deviceInstalledMemoryBytes(hardware);
 const usable=valid(snapshot?.memoryGb)&&snapshot.memoryGb>0?formatBytes(locale,gibBytes(snapshot.memoryGb)):EMPTY_VALUE;
 const lines=[
  translate(locale,'hardware.copy.title',{name:server.name}),
  translate(locale,'hardware.copy.inventory',{date:date(locale,hardware?.collectedAt??server.lastSeen)}),
  translate(locale,'hardware.copy.system',{value:[hardware?.system?.manufacturer??snapshot?.manufacturer,hardware?.system?.model??snapshot?.model].filter(Boolean).join(' · ')||EMPTY_VALUE}),
  translate(locale,'hardware.copy.os',{text:text(snapshot?.os)}),
  translate(locale,'hardware.copy.cpu',{model:hardware?.cpus?.map(cpu=>cpu.name).join(' / ')||translate(locale,'hardware.copy.noModel'),cores:number(locale,snapshot?.cores,0)}),
  translate(locale,'hardware.copy.ram',{size:usable}),
  ...gpu.map(row=>`GPU: ${row.name}`),
  ...hardware?.memoryModules?.map(module=>translate(locale,'hardware.copy.module',{slot:text(module.deviceLocator),size:capacity(locale,module.capacityBytes),type:text(module.memoryType),clock:number(locale,module.configuredClockMhz??module.speedMhz,0)}))??[],
  ...hardware?.disks?.map(disk=>translate(locale,'hardware.copy.disk',{text:text(disk.model),bytes:capacity(locale,disk.sizeBytes),text2:text(disk.busType)}))??[],
  ...snapshot?.disks?.map(disk=>translate(locale,'hardware.copy.drive',{name:disk.name.replace(/:$/,''),free:valid(disk.freeGb)?formatBytes(locale,gibBytes(disk.freeGb)):EMPTY_VALUE,total:valid(disk.totalGb)?formatBytes(locale,gibBytes(disk.totalGb)):EMPTY_VALUE}))??[],
  `BIOS: ${text(hardware?.bios?.version)}`,
 ];
 if(installedBytes!==null)lines.splice(6,0,translate(locale,'hardware.copy.installed',{bytes:formatBytes(locale,installedBytes)}));
 return lines.join('\n');
}
/**
 * The CPU or RAM utilization history: a kit Card with the range in its head next to "Open
 * processes" (only with onNavigate), the chart of real samples with gaps, a chart skeleton
 * while the first samples load, and an empty state without values.
 */
function CpuMemoryHistory({serverId,samples,now,kind,loading,onNavigate}:{serverId:string;samples:Sample[];now:number;kind:'cpu'|'memory';loading:boolean;onNavigate?:Navigate}){
 const t=useT(),[locale]=useLocale();
 const [range,setRange]=useState<HistoryRange>('60'),points=useMemo(()=>deviceOverviewSamples(samples,serverId,now,Number(range)),[samples,serverId,now,range]);
 const count=points.filter(point=>point[kind]!==null).length,label=kind==='cpu'?'CPU':'RAM',color=kind==='cpu'?chartSeries:'var(--sd-muted)';
 return <Card title={t('hardware.history.title',{label})} icon={LineChart} iconTone="neutral" className="dhw-history" actions={<>
  <HistoryRangeSwitch label={t('hardware.history.range',{label})} value={range} onChange={setRange}/>
  {onNavigate&&<Btn variant="ghost" size="sm" icon={ArrowUpRight} onClick={()=>onNavigate({section:'diagnostics',diagnosis:'processes'})}>{t('hardware.openProcesses')}</Btn>}
 </>}>
  {count?<div className="dhw-chart" role="img" aria-label={t('hardware.history.chart',{label})}><ResponsiveContainer width="100%" height={216} minWidth={1}><AreaChart data={points} margin={{top:12,right:12,bottom:0,left:-16}}><CartesianGrid stroke="var(--sd-soft-line)" vertical={false}/><XAxis dataKey="at" type="number" scale="time" domain={['dataMin','dataMax']} minTickGap={48} tickFormatter={at=>formatTime(locale,at,{hour:'2-digit',minute:'2-digit'})} tick={{fontSize:12,fill:'var(--sd-muted)'}} axisLine={false} tickLine={false}/><YAxis domain={[0,100]} unit="%" tick={{fontSize:12,fill:'var(--sd-muted)'}} axisLine={false} tickLine={false}/><Tooltip {...chartTooltip} labelFormatter={at=>formatTime(locale,Number(at))} formatter={value=>[translate(locale,'device.chart.percent',{value:number(locale,value)}),label]}/><Area type="monotone" dataKey={kind} stroke={color} fill={color} fillOpacity={.07} strokeWidth={2} dot={count<3?{r:3}:false} connectNulls={false} isAnimationActive={false}/></AreaChart></ResponsiveContainer></div>
   :loading?<Skeleton variant="chart" label={t('hardware.history.loading',{label})}/>
   :<Empty icon={LineChart} title={t('hardware.history.emptyTitle',{label})}>{t('hardware.history.emptyHint')}</Empty>}
 </Card>;
}
/** A ghost button in a card head that opens another area; absent without onNavigate. */
function HeadLink({label,target,onNavigate}:{label:string;target:DeviceOverviewTarget;onNavigate?:Navigate}){
 return onNavigate?<Btn variant="ghost" size="sm" icon={ArrowUpRight} onClick={()=>onNavigate(target)}>{label}</Btn>:null;
}
type AdapterRow=Pick<HardwareNetworkAdapter,'id'|'name'|'manufacturer'|'mac'|'speedMbps'|'physicalAdapter'>;
type Indexed<T>={item:T;position:number};
const indexed=<T,>(items:readonly T[]):Indexed<T>[]=>items.map((item,index)=>({item,position:index+1}));

export default function DeviceHardware({server,viewer,demo,now,samples,jobs,historyLoading=false,focus,onNavigate,detail,gpu:gpuPosition,onDetailChange,onConfirm,subareaHref,panelId=hardwarePanelId}:Props){
 const t=useT(),[locale]=useLocale();
 const [selection,setSelection]=useState<{serverId:string;revision?:number;section:HardwareSection}>({serverId:server.id,revision:focus?.revision,section:focus?.section??'overview'}),[gpuSelection,setGpuSelection]=useState<{serverId:string;revision?:number;id:string}>(),[copiedServer,setCopiedServer]=useState<string|null>(null);
 const copyTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
 const hardware=deviceHardwareInventory(server),snapshot=server.snapshot,connection=deviceConnection(server,now,locale),online=connection.kind==='online'&&server.revoked===0;
 const controlled=detail!==undefined,localSection=selection.serverId===server.id&&selection.revision===focus?.revision?selection.section:focus?.section??'overview';
 const gpus=deviceOverviewGpus(snapshot,online,now);
 // A GPU link on a device without a supported GPU shows the components with a note; the hash stays.
 const gpuMissing=controlled&&detail==='gpu'&&!gpus.length,section=controlled?gpuMissing?'overview':detail:localSection;
 // A link addresses the GPU by position. Positions past the end show the first GPU.
 const linkedGpu=controlled?(typeof gpuPosition==='number'&&gpuPosition>=1?gpus[gpuPosition-1]:undefined)??gpus[0]:undefined;
 const context=useRef({server,viewer});useLayoutEffect(()=>{context.current={server,viewer};},[server,viewer]);
 const canView=server.revoked===0&&permitted(server,viewer,'view'),navigate=canView?onNavigate:undefined;
 const allowed=(current:{server:Device;viewer:Viewer})=>current.server.id===server.id&&current.server.revoked===0&&permitted(current.server,current.viewer,'view');
 const rememberedGpu=()=>{const index=gpuSelection?.serverId===server.id?gpus.findIndex(gpu=>gpu.id===gpuSelection.id):-1;return index>=0?index+1:undefined;};
 const choose=(next:HardwareSection,position?:number)=>{setSelection({serverId:server.id,revision:focus?.revision,section:next});onDetailChange?.(next,next==='gpu'?position??rememberedGpu():undefined);};
 const chooseGpu=(id:string)=>{const current=context.current,list=deviceOverviewGpus(current.server.snapshot,false,now),index=list.findIndex(gpu=>gpu.id===id);if(!allowed(current)||index<0)return;setGpuSelection({serverId:server.id,revision:focus?.revision,id});choose('gpu',index+1);};
 const copy=async()=>{
  const current=context.current;
  if(!allowed(current))return;
  try{await navigator.clipboard.writeText(deviceHardwareSummary(current.server,locale));}
  catch{toast.error(t('hardware.copyUnavailable'));return;}
  if(!allowed(context.current))return;
  toast.success(t('hardware.copied'));
  setCopiedServer(server.id);
  if(copyTimer.current)clearTimeout(copyTimer.current);
  copyTimer.current=setTimeout(()=>{copyTimer.current=null;setCopiedServer(null);},copiedFor);
 };
 if(!canView)return <Card className="dhw-state"><Empty icon={Lock} title={t('hardware.noAccess')}>{t('hardware.noPermission')}</Empty></Card>;
 if(!snapshot)return <Card className="dhw-state"><Empty icon={Cpu} title={t('hardware.empty.title')}>{t('hardware.empty.body')}</Empty></Card>;
 const cpu=percent(liveValue(server,snapshot.cpu,now)),memory=percent(liveValue(server,snapshot.memory,now));
 const modules=hardware?.memoryModules??[],cpus=hardware?.cpus??[],physicalDisks=hardware?.disks??[],adapters=hardware?.networkAdapters??[];
 const tabItems:HardwareSection[]=['overview','cpu','memory','storage','network','system',...(gpus.length?['gpu' as const]:[])];
 const usableMemory=valid(snapshot.memoryGb)&&snapshot.memoryGb>0?snapshot.memoryGb:null,used=memory!==null&&usableMemory!==null?usableMemory*memory/100:null,installedBytes=deviceInstalledMemoryBytes(hardware);
 const slots=hardware?.memoryArray?.slots,slotSummary=typeof slots==='number'&&Number.isSafeInteger(slots)&&slots>=modules.length?t('hardware.slots',{used:modules.length,count:slots}):modules.length?t('hardware.modules',{count:modules.length}):t('hardware.noModules');
 const hardwareDate=hardware?.collectedAt??server.lastSeen,performance=snapshot.performance;
 // Lists that stay empty: an agent without the detail inventory, or none reported in the last inventory.
 const emptyReason=hardware?t('hardware.emptyNextInventory'):t('hardware.emptyNeedsAgent');
 const reported=(value:unknown)=>typeof value==='string'&&value.trim()?value.trim():t('hardware.notReported');
 const meter=(value:number|null,label:string)=>online&&value!==null?<Meter value={value} label={label}/>:undefined;
 const battery=batteryView(snapshot.battery);
 const cpuFacts=(item:HardwareCpu):FactItem[]=>[
  {id:'vendor',label:t('device.gpu.vendor'),value:reported(item.manufacturer)},
  {id:'socket',label:t('hardware.socket'),value:reported(item.socket)},
  {id:'cores',label:t('hardware.physicalCores'),value:number(locale,item.cores,0)},
  {id:'threads',label:t('hardware.logicalProcessors'),value:number(locale,item.threads,0)},
  {id:'clock',label:t('hardware.maxClock'),value:mhz(locale,item.maxClockMhz)},
 ];
 const moduleColumns:DataColumn<Indexed<HardwareMemoryModule>>[]=[
  {id:'slot',label:t('hardware.slot'),primary:true,cell:({item,position})=>item.deviceLocator||item.bankLabel||t('hardware.module',{value:position})},
  {id:'capacity',label:t('storage.capacity'),align:'end',cell:({item})=>capacity(locale,item.capacityBytes)},
  {id:'type',label:t('hardware.memoryType'),cell:({item})=>reported(item.memoryType)},
  {id:'form',label:t('hardware.formFactor'),cell:({item})=>reported(item.formFactor)},
  {id:'configured',label:t('hardware.configuredClock'),align:'end',cell:({item})=>mhz(locale,item.configuredClockMhz)},
  {id:'rated',label:t('hardware.ratedSpeed'),align:'end',cell:({item})=>mhz(locale,item.speedMhz)},
  {id:'vendor',label:t('device.gpu.vendor'),cell:({item})=>reported(item.manufacturer)},
  {id:'part',label:t('hardware.partNumber'),mono:true,cell:({item})=>reported(item.partNumber)},
  {id:'serial',label:t('hardware.serial'),mono:true,hideBelow:1280,cell:({item})=>reported(item.serialNumber)},
 ];
 const pagefileColumns:DataColumn<NonNullable<typeof snapshot.pagefile>['files'][number]>[]=[
  {id:'file',label:t('management.pagefile.file'),primary:true,mono:true,cell:file=>file.name},
  {id:'reserved',label:t('monitoring.reserved'),align:'end',cell:file=>mib(locale,file.allocatedMb)},
  {id:'current',label:t('storage.current'),align:'end',cell:file=>online?mib(locale,file.currentUsageMb):EMPTY_VALUE},
  {id:'peak',label:t('hardware.peak'),align:'end',cell:file=>mib(locale,file.peakUsageMb)},
 ];
 const health=(status:HardwarePhysicalDisk['healthStatus']):ReactNode=>status==='healthy'?<StatusPill kind="success">{t('hardware.healthy')}</StatusPill>:status==='warning'?<StatusPill kind="warning">{t('hardware.warning')}</StatusPill>:status==='unhealthy'?<StatusPill kind="critical">{t('hardware.error')}</StatusPill>:<span className="sdx-muted-cell">{t('hardware.notReported')}</span>;
 const diskColumns:DataColumn<Indexed<HardwarePhysicalDisk>>[]=[
  {id:'model',label:t('hardware.model'),primary:true,wrap:true,cell:({item,position})=>item.model||t('hardware.diskIndex',{value:position})},
  {id:'capacity',label:t('storage.capacity'),align:'end',cell:({item})=>capacity(locale,item.sizeBytes)},
  {id:'media',label:t('hardware.mediaType'),cell:({item})=>reported(item.mediaType)},
  {id:'bus',label:t('hardware.busType'),cell:({item})=>reported(item.busType)},
  {id:'firmware',label:t('hardware.firmware'),mono:true,cell:({item})=>reported(item.firmwareVersion)},
  {id:'serial',label:t('hardware.serial'),mono:true,hideBelow:1280,cell:({item})=>reported(item.serialNumber)},
  {id:'health',label:t('hardware.health'),cell:({item})=>health(item.healthStatus)},
 ];
 const adapterRows:AdapterRow[]=adapters.length?adapters:(snapshot.networks??[]).map((adapter,index)=>({id:String(index),name:adapter.name,manufacturer:null,mac:adapter.mac,speedMbps:adapter.speedMbps,physicalAdapter:null}));
 const adapterColumns:DataColumn<AdapterRow>[]=[
  {id:'name',label:t('common.name'),primary:true,wrap:true,cell:adapter=>adapter.name||t('hardware.adapter')},
  {id:'vendor',label:t('device.gpu.vendor'),cell:adapter=>reported(adapter.manufacturer)},
  {id:'mac',label:t('network.mac'),mono:true,cell:adapter=>reported(adapter.mac)},
  {id:'speed',label:t('hardware.speed'),align:'end',cell:adapter=>valid(adapter.speedMbps)&&adapter.speedMbps>0?t('network.speed',{speed:number(locale,adapter.speedMbps,0)}):EMPTY_VALUE},
  {id:'type',label:t('hardware.adapterType'),cell:adapter=>adapter.physicalAdapter===true?t('hardware.physical'):adapter.physicalAdapter===false?t('hardware.virtual'):t('hardware.notReported')},
 ];
 const systemFacts:FactItem[]=[
  {id:'vendor',label:t('device.gpu.vendor'),value:<ManufacturerMark manufacturer={deviceManufacturer(server).manufacturer} fallback={t('hardware.notReported')}/>},
  {id:'model',label:t('hardware.model'),value:reported(hardware?.system?.model??snapshot.model)},
  {id:'type',label:t('hardware.systemType'),value:reported(hardware?.system?.systemType)},
  {id:'uuid',label:t('hardware.uuid'),value:reported(hardware?.system?.uuid),mono:!!hardware?.system?.uuid},
  {id:'hostname',label:t('device.summary.hostname'),value:reported(snapshot.hostname)},
  {id:'os',label:t('fleet.col.os'),value:reported(snapshot.os)},
  {id:'build',label:t('hardware.windowsBuild'),value:reported(snapshot.build),mono:!!snapshot.build},
 ];
 const bios=hardware?.bios,board=hardware?.baseboard;
 const biosFacts:FactItem[]=[
  {id:'vendor',label:t('device.gpu.vendor'),value:reported(bios?.manufacturer)},
  {id:'name',label:t('common.name'),value:reported(bios?.name)},
  {id:'version',label:t('hardware.version'),value:reported(bios?.version),mono:!!bios?.version},
  {id:'released',label:t('hardware.released'),value:date(locale,bios?.releasedAt)},
  {id:'serial',label:t('hardware.serial'),value:reported(bios?.serialNumber),mono:!!bios?.serialNumber},
 ];
 const queue=online&&valid(performance?.processorQueue)?performance.processorQueue:null;
 const pagefilePercent=online?percent(performance?.pagefilePercent):null;
 const latency=online&&valid(performance?.diskLatencyMs)?formatDuration(locale,performance.diskLatencyMs):null;
 const rate=(value:unknown)=>online&&valid(value)?formatRate(locale,value):null;
 return <div className="dhw-workspace">
  <div className="dhw-toolbar"><Tabs variant="pill" overflow="menu" label={t('hardware.areas')} panelId={panelId} value={section} onChange={id=>choose(id as HardwareSection)} items={tabItems.map(id=>({id,label:id==='gpu'&&gpus.length>1?t('hardware.gpus'):t(labels[id]),href:subareaHref?.(id,id==='gpu'?section==='gpu'?gpuPosition:rememberedGpu():undefined)}))}/><Btn variant="secondary" size="sm" icon={copiedServer===server.id?Check:Copy} aria-label={t('hardware.copyLabel')} onClick={()=>void copy()}>{t('hardware.copy')}</Btn></div>
  <div className="dhw-panel" id={panelId} role="tabpanel" aria-labelledby={tabId(panelId,section)}>
  <p className="dhw-status"><Clock3 size={14} aria-hidden/><span>{online?t('hardware.inventory'):t('device.gpu.lastInventory')}</span><time>{date(locale,hardwareDate)}</time>{!hardware&&<span>{t('hardware.noDetail')}</span>}{hardware?.complete===false&&<span>{t('hardware.incomplete')}</span>}</p>
  {!!hardware?.errors?.length&&<Notice tone="warning" icon={TriangleAlert}><p>{t('hardware.collectionNotice')}</p><details className="dhw-notes"><summary>{t('hardware.collectionNotes',{length:hardware.errors.length})}</summary><ul>{hardware.errors.map((error,index)=><li key={index}>{error}</li>)}</ul></details></Notice>}
  {section==='overview'&&<>
   {gpuMissing&&<Notice tone="info" icon={Info}>{t('hardware.gpuMissing')}</Notice>}
   <EntranceList id="hardware-components" className="dhw-parts">
    <ComponentCard key="cpu" icon={Cpu} kind={t('hardware.processor')} value={cpus.length?cpus.map(item=>item.name).join(' / '):'CPU'} detail={t('device.summary.cores',{count:snapshot.cores})} onOpen={()=>choose('cpu')}/>
    <ComponentCard key="memory" icon={MemoryStick} kind={t('hardware.tab.memory')} value={usableMemory===null?t('device.gpu.capacityUnknown'):t('device.summary.memorySizeUsable',{size:formatBytes(locale,gibBytes(usableMemory))})} detail={slotSummary} onOpen={()=>choose('memory')}/>
    {gpus.length?gpus.map(gpu=><ComponentCard key={'gpu:'+gpu.id} icon={Gpu} kind={t('device.gpu.card')} value={gpu.name} detail={gpu.vendor==='nvidia'?'NVIDIA':gpu.vendor==='amd'?'AMD':'Intel'} onOpen={()=>chooseGpu(gpu.id)} openData={{'data-gpu-id':gpu.id}}/>)
     :<ComponentCard key="gpu" icon={Gpu} kind={t('device.gpu.card')} value={t('hardware.notReported')} detail={t('device.gpu.none')}/>}
    <ComponentCard key="storage" icon={HardDrive} kind={t('hardware.tab.storage')} value={physicalDisks.length?t('hardware.physicalDisks',{count:physicalDisks.length}):t('device.summary.drives')} detail={t('hardware.drivesCollected',{count:snapshot.disks?.length??0})} onOpen={()=>choose('storage')}/>
    <ComponentCard key="network" icon={Network} kind={t('management.category.network')} value={adapters.length?t('hardware.adapters',{count:adapters.length}):t('hardware.interfaces')} detail={t('hardware.interfacesCollected',{count:snapshot.networks?.length??0})} onOpen={()=>choose('network')}/>
    <ComponentCard key="system" icon={deviceTypeIcons[deviceType(server)]} kind={t('hardware.tab.system')} value={hardware?.system?.model||snapshot.model||server.name} detail={hardware?.system?.manufacturer||snapshot.manufacturer||t('hardware.noManufacturer')} onOpen={()=>choose('system')}/>
    {battery!=='data'&&<BatteryBlock key="battery" server={server}/>}
   </EntranceList>
   {battery==='data'&&<BatteryBlock server={server}/>}
  </>}
  {section==='cpu'&&<>
   <KpiRow label={t('hardware.kpi.cpu')} entranceId="hardware-cpu-kpis">
    <Kpi live key="load" label={t('hardware.cpuUtilization')} value={cpu} unit="%" digits={1} tone={usageTone(cpu)} visual={meter(cpu,t('hardware.cpuUtilization'))}/>
    <Kpi key="logical" label={t('hardware.logicalProcessors')} value={valid(snapshot.cores)?snapshot.cores:null} tone="neutral"/>
    <Kpi live key="queue" label={t('monitoring.queue')} value={queue} tone="neutral" detail={Math.round(queue??0)===1?t('hardware.thread'):t('hardware.threadsLabel')}/>
   </KpiRow>
   <div className="dhw-fact-grid">{cpus.length?cpus.map(item=><Card key={item.id} title={reported(item.name)} icon={Cpu} iconTone="accent"><Facts items={cpuFacts(item)}/></Card>)
    :<Card title={t('hardware.processor')} icon={Cpu} iconTone="accent"><Facts items={[{id:'threads',label:t('hardware.logicalProcessors'),value:number(locale,snapshot.cores,0)},{id:'model',label:t('hardware.model'),value:t('hardware.notReported')}]}/></Card>}</div>
   <CpuMemoryHistory serverId={server.id} samples={samples} now={now} kind="cpu" loading={historyLoading} onNavigate={navigate}/>
  </>}
  {section==='memory'&&<>
   <KpiRow label={t('hardware.kpi.memory')} entranceId="hardware-memory-kpis">
    <Kpi live key="load" label={t('hardware.ramUtilization')} value={memory} unit="%" digits={1} tone={usageTone(memory)} visual={meter(memory,t('hardware.ramUtilization'))}/>
    <Kpi key="usable" label={t('hardware.usableByWindows')} value={usableMemory===null?null:formatBytes(locale,gibBytes(usableMemory))} tone="neutral" detail={slotSummary}/>
    {installedBytes!==null&&<Kpi key="installed" label={t('hardware.installedModules')} value={formatBytes(locale,installedBytes)} tone="neutral" detail={slotSummary}/>}
    <Kpi live key="used" label={t('hardware.used')} value={used===null?null:formatBytes(locale,gibBytes(used))} tone="neutral" detail={t('hardware.fromRam')}/>
    <Kpi key="pagefile" label={t('management.pagefileTitle')} value={pagefilePercent} unit="%" digits={1} tone="neutral" detail={snapshot.pagefile?snapshot.pagefile.automatic?t('hardware.pagefileAutomatic'):t('hardware.pagefileManual'):undefined}/>
   </KpiRow>
   <Card title={t('hardware.memoryModules')} icon={MemoryStick} iconTone="accent" meta={slotSummary} flush>
    <DataTable variant="flush" cards label={t('hardware.memoryModules')} columns={moduleColumns} rows={indexed(modules)} rowKey={({item})=>item.id} empty={{icon:MemoryStick,title:t('hardware.noMemoryModules'),children:emptyReason}}/>
   </Card>
   {!!snapshot.pagefile?.files?.length&&<Card title={t('hardware.pagefiles')} icon={FileStack} iconTone="accent" flush>
    <DataTable variant="flush" label={t('hardware.pagefiles')} columns={pagefileColumns} rows={snapshot.pagefile.files} rowKey={file=>file.name} empty={{icon:FileStack,title:t('hardware.pagefiles')}}/>
   </Card>}
   <CpuMemoryHistory serverId={server.id} samples={samples} now={now} kind="memory" loading={historyLoading} onNavigate={navigate}/>
  </>}
  {section==='storage'&&<>
   <Card title={t('device.summary.drives')} icon={HardDrive} iconTone="accent" meta={t('device.summary.drivesMeta')} actions={<HeadLink label={t('hardware.manageDisks')} target={{section:'management',management:'storage'}} onNavigate={navigate}/>}>
    <DriveList disks={snapshot.disks} selected={focus?.serverId===server.id?focus.drive:undefined} onOpen={navigate?name=>navigate({section:'management',management:'storage',drive:name}):undefined}/>
   </Card>
   <KpiRow label={t('hardware.kpi.storage')} entranceId="hardware-storage-kpis">
    <Kpi live key="latency" label={t('device.summary.diskLatency')} value={latency} tone="neutral"/>
    <Kpi live key="read" label={t('hardware.readRate')} value={rate(performance?.diskReadBytesSec)} tone="neutral"/>
    <Kpi live key="write" label={t('hardware.writeRate')} value={rate(performance?.diskWriteBytesSec)} tone="neutral"/>
   </KpiRow>
   <Card title={t('hardware.physicalDisksTitle')} icon={HardDrive} iconTone="accent" flush>
    <DataTable variant="flush" cards label={t('hardware.physicalDisksTitle')} columns={diskColumns} rows={indexed(physicalDisks)} rowKey={({item})=>item.id} empty={{icon:HardDrive,title:t('hardware.noDisks'),children:emptyReason}}/>
   </Card>
  </>}
  {section==='network'&&<Card title={t('hardware.networkAdapters')} icon={Network} iconTone="accent" flush actions={<HeadLink label={t('hardware.configureNetwork')} target={{section:'management',management:'network'}} onNavigate={navigate}/>}>
   <DataTable variant="flush" cards label={t('hardware.networkAdapters')} columns={adapterColumns} rows={adapterRows} rowKey={adapter=>adapter.id} empty={{icon:Network,title:t('hardware.noAdapters'),children:emptyReason}}/>
  </Card>}
  {section==='system'&&<div className="dhw-fact-grid">
   <Card title={t('management.category.system')} icon={ServerIcon} iconTone="accent" actions={<HeadLink label={t('hardware.manageSystem')} target={{section:'management',management:'system'}} onNavigate={navigate}/>}><Facts items={systemFacts}/></Card>
   <Card title={t('hardware.biosTitle')} icon={ShieldCheck} iconTone="accent"><Facts items={biosFacts}/></Card>
   {board&&<Card title={t('hardware.mainboard')} icon={CircuitBoard} iconTone="accent"><Facts items={[
    {id:'vendor',label:t('device.gpu.vendor'),value:reported(board.manufacturer)},
    {id:'model',label:t('hardware.model'),value:reported(board.product)},
    {id:'version',label:t('hardware.version'),value:reported(board.version),mono:!!board.version},
    {id:'serial',label:t('hardware.serial'),value:reported(board.serialNumber),mono:!!board.serialNumber},
   ]}/></Card>}
  </div>}
  {section==='gpu'&&<DeviceGpu server={server} viewer={viewer} demo={demo} now={now} samples={samples} jobs={jobs} historyLoading={historyLoading} focusGpu={controlled?linkedGpu?.id:gpuSelection?.serverId===server.id&&gpuSelection.revision===focus?.revision?gpuSelection.id:focus?.gpuId} onSelect={chooseGpu} onConfirm={onConfirm}/>}
  </div>
 </div>;
}
