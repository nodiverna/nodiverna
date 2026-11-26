'use client';

import {useMemo,useState} from 'react';
import {Select} from '@/ui/kit/field';
import {Clock3,Gpu,Info,LineChart,Lock,Microchip,MemoryStick,ShieldCheck} from 'lucide-react';
import {Area,AreaChart,CartesianGrid,ResponsiveContainer,Tooltip,XAxis,YAxis} from 'recharts';
import {chartSeries,chartTooltip} from '@/ui/kit/chart';
import type {Job,Sample,Viewer} from '@/lib/types';
import {agentBaseVersion} from '@/lib/agent-update-state';
import {deviceConnection} from '@/ui/base/ui-device';
import {permitted,type Device} from '@/ui/base/api';
import {deviceOverviewGpus,deviceOverviewHistory} from '@/ui/devices/device/device-overview';
import AgentUpdateNotice from '@/ui/devices/device/agent-update-notice';
import DeviceGpuDriver from '@/ui/devices/hardware/device-gpu-driver';
import type {Confirmation} from '@/ui/base/confirmation';
import {gpuDriverVendorOf} from '@/ui/devices/hardware/gpu-driver-view';
import type {Locale} from '@/lib/i18n/locale';
import {translate,type MessageKey} from '@/lib/i18n/translate';
import {EMPTY_VALUE,formatBytes,formatDateTime,formatNumber,formatTemperature,formatTime} from '@/lib/i18n/format';
import {Card,Empty,Facts,Kpi,KpiRow,Meter,Notice,Skeleton,type FactItem,type KpiTone} from '@/ui/kit/kit';
import {HistoryRangeSwitch,type HistoryRange} from '@/ui/devices/hardware/history-range';
import '@/ui/devices/hardware/device-gpu.css';

import {useLocale,useT} from '@/ui/base/locale';
const vendors={nvidia:'NVIDIA',amd:'AMD',intel:'Intel'};
const number=(locale:Locale,value:number|null,digits=1)=>value===null?EMPTY_VALUE:formatNumber(locale,value,{maximumFractionDigits:digits});
/** A value with a non-byte unit from the catalog (hardware.unit.*), or null when it is missing. */
const unitValue=(locale:Locale,key:MessageKey,value:number|null,digits=1)=>value===null?null:translate(locale,key,{value:number(locale,value,digits)});
const bytes=(locale:Locale,value:number|null)=>value===null?EMPTY_VALUE:formatBytes(locale,value);
const hex=(value:number|null,digits:number)=>value===null?EMPTY_VALUE:'0x'+value.toString(16).toUpperCase().padStart(digits,'0');
const usageTone=(value:number|null):KpiTone=>value===null?'neutral':value>=90?'critical':value>=80?'warning':'accent';
const numericFields:[string,number,number,boolean][]=[
 ['vendorId',0,65535,true],['deviceId',0,65535,true],['subsystemId',0,4294967295,true],['revision',0,4294967295,true],
 ...['dedicatedMemoryBytes','sharedMemoryBytes','dedicatedMemoryUsedBytes','sharedMemoryUsedBytes'].map(key=>[key,0,Number.MAX_SAFE_INTEGER,true] as [string,number,number,boolean]),
 ['temperatureCelsius',-50,200,false],['coreClockMhz',0,100000,false],['memoryClockMhz',0,100000,false],['powerWatts',0,10000,false],['powerLimitWatts',0,10000,false],['fanPercent',0,200,false],
 ['pcieGeneration',1,16,true],['pcieMaxGeneration',1,16,true],['pcieLinkWidth',1,128,true],['pcieMaxLinkWidth',1,128,true],['memoryBusWidthBits',1,65536,true],['cudaCores',1,10000000,true]
];
const dynamicFields=new Set(['dedicatedMemoryUsedBytes','sharedMemoryUsedBytes','temperatureCelsius','coreClockMhz','memoryClockMhz','powerWatts','powerLimitWatts','fanPercent','pcieGeneration','pcieLinkWidth']);
export function deviceGpuDetails(server:Device,now:number,gpuId:string){
 const rows=server.snapshot?.gpuDetails,raw=Array.isArray(rows)?rows.slice(0,16).find(row=>row&&typeof row==='object'&&row.id===gpuId):undefined;
 const source=raw as unknown as Record<string,unknown>|undefined,at=typeof source?.collectedAt==='string'?Date.parse(source.collectedAt):NaN;
 const fresh=server.revoked===0&&deviceConnection(server,now).kind==='online'&&Number.isFinite(now)&&Number.isFinite(at)&&at<=now&&now-at<=120000;
 const fields:Record<string,string|number|null>={};
 for(const [key,min,max,integer] of numericFields){const value=source?.[key];fields[key]=typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max&&(!integer||Number.isSafeInteger(value))&&(!dynamicFields.has(key)||fresh)?value:null;}
 for(const key of ['driverVersion','vendorDriverVersion','driverModel','vbiosVersion','pciBusId']){const value=source?.[key];fields[key]=typeof value==='string'&&value.trim()&&value.length<=(key==='pciBusId'?32:128)?value.trim():null;}
 fields.sensorProvider=source?.sensorProvider==='windows'||source?.sensorProvider==='nvidia-nvml'?source.sensorProvider:null;
 return {known:!!source,fresh,collectedAt:Number.isFinite(at)?at:null,fields};
}
function GpuHistory({history,gpuId}:{history:ReturnType<typeof deviceOverviewHistory>;gpuId:string}){
 const t=useT(),[locale]=useLocale();
 const series=history.gpus.find(gpu=>gpu.id===gpuId);
 if(!series)return null;
 const points=history.points.map(point=>({at:point.at,value:point[series.key]})),count=points.filter(point=>point.value!==null).length;
 if(!count)return null;
 return <div className="dgp-chart" role="img" aria-label={t('device.gpu.historyFor',{name:series.name})}><ResponsiveContainer width="100%" height={216} minWidth={1}><AreaChart data={points} margin={{top:12,right:12,bottom:0,left:-16}}><CartesianGrid stroke="var(--sd-soft-line)" vertical={false}/><XAxis dataKey="at" type="number" scale="time" domain={['dataMin','dataMax']} minTickGap={48} tickFormatter={at=>formatTime(locale,at,{hour:'2-digit',minute:'2-digit'})} tick={{fontSize:12,fill:'var(--sd-muted)'}} axisLine={false} tickLine={false}/><YAxis domain={[0,100]} ticks={[0,25,50,75,100]} unit="%" tick={{fontSize:12,fill:'var(--sd-muted)'}} axisLine={false} tickLine={false}/><Tooltip {...chartTooltip} labelFormatter={at=>formatTime(locale,Number(at),{hour:'2-digit',minute:'2-digit',second:'2-digit'})} formatter={value=>[typeof value==='number'?translate(locale,'device.chart.percent',{value:number(locale,value)}):EMPTY_VALUE,series.name]}/><Area dataKey="value" name={series.name} type="monotone" stroke={chartSeries} fill={chartSeries} fillOpacity={0.07} strokeWidth={2} dot={count<3?{r:3}:false} activeDot={{r:4}} connectNulls={false} isAnimationActive={false}/></AreaChart></ResponsiveContainer></div>;
}

/** onSelect reports a GPU chosen in the list, so the caller can keep its position in the link. */
type Props={server:Device;viewer:Viewer;demo:boolean;now:number;samples:Sample[];jobs:Job[];historyLoading?:boolean;focusGpu?:string;onSelect?:(id:string)=>void;onConfirm?:(confirmation:Confirmation)=>void};
/** The GPU subarea of Hardware: the GPU head with its KPI row (the focal point), the driver card, the facts and the history. */
export default function DeviceGpu({server,viewer,demo,now,samples,jobs,historyLoading=false,focusGpu,onSelect,onConfirm}:Props){
 const t=useT(),[locale]=useLocale();
 const [selection,setSelection]=useState({serverId:server.id,focusGpu,id:focusGpu}),[range,setRange]=useState<HistoryRange>('60');
 const online=server.revoked===0&&deviceConnection(server,now,locale).kind==='online';
 const gpus=deviceOverviewGpus(server.snapshot,online,now),selectedId=selection.serverId===server.id&&selection.focusGpu===focusGpu?selection.id:focusGpu,gpu=gpus.find(row=>row.id===selectedId)??gpus[0];
 const history=useMemo(()=>deviceOverviewHistory(samples,server.id,now,Number(range)),[samples,server.id,now,range]);
 if(!permitted(server,viewer,'view')||server.revoked!==0)return <Card><Empty icon={Lock} title={t('hardware.noAccess')}>{t('hardware.noPermission')}</Empty></Card>;
 if(!gpu)return <Card><Empty icon={Gpu} title={t('device.gpu.noneTitle')}>{t('device.gpu.noneHint')}</Empty></Card>;
 const detail=deviceGpuDetails(server,now,gpu.id),value=(key:string)=>typeof detail.fields[key]==='number'?detail.fields[key] as number:null;
 // A missing text fact says so; a reported one in the mono face when it is an identifier.
 const text=(key:string,mono=false):Pick<FactItem,'value'|'mono'>=>typeof detail.fields[key]==='string'?{value:detail.fields[key],mono}:{value:t('hardware.notReported')};
 const dedicated=value('dedicatedMemoryBytes'),used=value('dedicatedMemoryUsedBytes'),vram=dedicated!==null&&dedicated>0&&used!==null&&used<=dedicated?used/dedicated*100:null;
 const series=history.gpus.find(row=>row.id===gpu.id),hasHistory=!!series&&history.points.some(point=>point[series.key]!==null);
 const beforeHardware=/^(?:[0-3]\.|4\.(?:[0-5]\.|6\.[0-5](?:$|[+-])))/.test(agentBaseVersion(server.snapshot?.agentVersion));
 const sensorVisible=(key:string)=>gpu.vendor==='nvidia'||value(key)!==null,driverVendor=gpuDriverVendorOf(gpu.vendor);
 const pcie=(generation:number|null,width:number|null)=>generation===null&&width===null?EMPTY_VALUE:`${generation===null?EMPTY_VALUE:t('device.gpu.generation',{generation})} · ${width===null?EMPTY_VALUE:'x'+width}`;
 const choose=(id:string)=>{if(!gpus.some(row=>row.id===id))return;setSelection({serverId:server.id,focusGpu,id});onSelect?.(id);};
 const utilizationLabel=t('device.gpu.utilization'),vramLabel=t('device.gpu.vramUsed'),powerLimit=value('powerLimitWatts');
 const hardwareFacts:FactItem[]=[
  {id:'vendor',label:t('device.gpu.vendor'),value:vendors[gpu.vendor]},
  {id:'vendor-id',label:t('device.gpu.vendorId'),value:hex(value('vendorId'),4),mono:true},
  {id:'device-id',label:t('device.gpu.deviceId'),value:hex(value('deviceId'),4),mono:true},
  {id:'subsystem-id',label:t('device.gpu.subsystemId'),value:hex(value('subsystemId'),8),mono:true},
  {id:'revision',label:t('device.gpu.revision'),value:hex(value('revision'),2),mono:true},
  {id:'pci',label:t('device.gpu.pciAddress'),...text('pciBusId',true)},
  {id:'pcie',label:t('device.gpu.pcieCurrent'),value:pcie(value('pcieGeneration'),value('pcieLinkWidth'))},
  {id:'pcie-max',label:t('device.gpu.pcieMax'),value:pcie(value('pcieMaxGeneration'),value('pcieMaxLinkWidth'))},
  ...(gpu.vendor==='nvidia'?[{id:'cuda',label:t('device.gpu.cudaCores'),value:number(locale,value('cudaCores'),0)}]:[]),
 ];
 const memoryFacts:FactItem[]=[
  {id:'dedicated',label:t('device.gpu.dedicated'),value:bytes(locale,dedicated)},
  {id:'shared',label:t('device.gpu.shared'),value:bytes(locale,value('sharedMemoryBytes'))},
  {id:'dedicated-used',label:t('device.gpu.dedicatedUsed'),value:bytes(locale,used)},
  {id:'shared-used',label:t('device.gpu.sharedUsed'),value:bytes(locale,value('sharedMemoryUsedBytes'))},
  {id:'bus',label:t('device.gpu.memoryBus'),value:unitValue(locale,'hardware.unit.bit',value('memoryBusWidthBits'),0)??EMPTY_VALUE},
 ];
 const driverFacts:FactItem[]=[
  {id:'windows',label:t('device.gpu.windowsDriver'),...text('driverVersion',true)},
  {id:'vendor-driver',label:t('device.gpu.vendorDriver',{vendor:vendors[gpu.vendor]}),...text('vendorDriverVersion',true)},
  {id:'model',label:t('device.gpu.driverModel'),...text('driverModel')},
  {id:'vbios',label:t('device.gpu.vbios'),...text('vbiosVersion',true)},
  {id:'sensors',label:t('device.gpu.sensorSource'),value:detail.fields.sensorProvider==='nvidia-nvml'?'NVIDIA NVML':detail.fields.sensorProvider==='windows'?'Windows':t('hardware.notReported')},
 ];
 return <div className="dgp-workspace">
  <Card className="dgp-head" title={gpu.name} icon={Gpu} iconTone="accent" description={t('device.gpu.vendorCard',{value:vendors[gpu.vendor]})} meta={online?t('device.gpu.current'):t('device.gpu.lastInventory')}
   actions={gpus.length>1?<Select size="sm" aria-label={t('device.gpu.choose')} value={gpu.id} onChange={event=>choose(event.target.value)}>{gpus.map((row,index)=><option key={row.id} value={row.id}>{index+1}. {row.name}</option>)}</Select>:undefined}>{null}</Card>
  {driverVendor&&<DeviceGpuDriver key={server.id+':'+driverVendor} server={server} viewer={viewer} demo={demo} now={now} jobs={jobs} vendor={driverVendor} onConfirm={onConfirm}/>}
  {!detail.known&&<Notice tone="info" icon={Info}>{beforeHardware?t('device.gpu.needsAgent'):t('device.gpu.noData')}</Notice>}
  <KpiRow label={t('device.gpu.kpi')} entranceId="hardware-gpu-kpis">
   <Kpi live key="utilization" label={utilizationLabel} value={gpu.utilization} unit="%" digits={1} tone={usageTone(gpu.utilization)} visual={gpu.utilization===null?undefined:<Meter value={gpu.utilization} label={utilizationLabel}/>}/>
   {/* VRAM stays as a live tile with "—" without details (older agent), so the utilization keeps its row (KpiRow needs two tiles). */}
   <Kpi live key="vram" label={vramLabel} value={used===null?null:formatBytes(locale,used)} tone={usageTone(vram)} detail={dedicated===null?t('device.gpu.capacityUnknown'):t('device.gpu.of',{total:formatBytes(locale,dedicated)})} visual={vram===null?undefined:<Meter value={vram} label={vramLabel}/>}/>
   {detail.known&&sensorVisible('temperatureCelsius')&&<Kpi live key="temperature" label={t('device.gpu.temperature')} tone="neutral" value={value('temperatureCelsius')===null?null:formatTemperature(locale,value('temperatureCelsius'))}/>}
   {detail.known&&sensorVisible('powerWatts')&&<Kpi live key="power" label={t('device.gpu.power')} tone="neutral" value={unitValue(locale,'hardware.unit.watt',value('powerWatts'))} detail={powerLimit===null?undefined:t('device.gpu.limit',{value:unitValue(locale,'hardware.unit.watt',powerLimit)??EMPTY_VALUE})}/>}
   {detail.known&&sensorVisible('coreClockMhz')&&<Kpi live key="core-clock" label={t('device.gpu.coreClock')} tone="neutral" value={unitValue(locale,'hardware.unit.mhz',value('coreClockMhz'),0)}/>}
   {detail.known&&sensorVisible('memoryClockMhz')&&<Kpi live key="memory-clock" label={t('device.gpu.memoryClock')} tone="neutral" value={unitValue(locale,'hardware.unit.mhz',value('memoryClockMhz'),0)}/>}
   {detail.known&&sensorVisible('fanPercent')&&<Kpi live key="fan" label={t('device.gpu.fan')} tone="neutral" value={value('fanPercent')} unit="%" digits={1}/>}
  </KpiRow>
  {detail.known&&<>
   <p className="dgp-sensor-status"><Clock3 size={14} aria-hidden/><span>{detail.fresh?t('device.gpu.sensorTime'):t('device.gpu.sensorStale')}</span>{detail.collectedAt!==null&&<time>{formatDateTime(locale,detail.collectedAt,{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'})}</time>}</p>
   <div className="dgp-facts-grid">
    <Card title={t('device.section.hardware')} icon={Microchip} iconTone="accent"><Facts items={hardwareFacts}/></Card>
    <Card title={t('hardware.tab.memory')} icon={MemoryStick} iconTone="accent"><Facts items={memoryFacts}/></Card>
    <Card title={t('device.gpu.drivers')} icon={ShieldCheck} iconTone="accent"><Facts items={driverFacts}/></Card>
   </div>
  </>}
  <Card title={t('device.gpu.history')} icon={LineChart} iconTone="neutral" className="dgp-history" actions={<HistoryRangeSwitch label={t('device.gpu.rangeLabel')} value={range} onChange={setRange}/>}>
   {hasHistory?<GpuHistory history={history} gpuId={gpu.id}/>:historyLoading?<Skeleton variant="chart" label={t('device.gpu.loading')}/>:<Empty icon={LineChart} title={t('device.gpu.noHistoryTitle')}>{t('hardware.history.emptyHint')}</Empty>}
  </Card>
  {!detail.known&&beforeHardware&&<AgentUpdateNotice server={server} viewer={viewer} demo={demo} jobs={jobs} now={now}/>}
 </div>;
}
