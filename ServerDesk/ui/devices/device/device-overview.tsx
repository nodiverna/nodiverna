// Overview helpers shared by the console Overview (ui/devices/device/device-summary.tsx), Hardware and GPU:
// the jump targets, the current GPUs and the CPU, RAM and GPU history of one device.
import type {Sample} from '@/lib/types';
import type {DiagnosticsDetail,ExtensionsDetail,HardwareDetail,ManagementDetail,SoftwareDetail} from '@/lib/console-route';

// A jump from the Overview into a device area: every Diagnostics and Management subarea (the fix links of
// the health line take the subarea of the rule's area), a hardware subarea, a drive, a driver, or an Extensions
// subarea (the DHCP issues open the DHCP server of the Extensions area).
export type DeviceOverviewTarget={section:'diagnostics';diagnosis:DiagnosticsDetail}|{section:'hardware';hardware:HardwareDetail;gpuId?:string;drive?:string}|{section:'management';management:ManagementDetail;drive?:string}
 // A Software subarea; drivers with the search set to a driver file (the link of a crash issue).
 |{section:'software';software:SoftwareDetail;driver?:string}
 |{section:'extensions';extensions:ExtensionsDetail};
const percent=(value:number|null|undefined)=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=100?value:null;
const overviewWindow=(samples:Sample[],serverId:string,now:number,minutes:number)=>samples.filter(sample=>sample.serverId===serverId&&Number.isFinite(sample.at)&&sample.at>now-minutes*60000&&sample.at<=now).sort((a,b)=>a.at-b.at);
export function deviceOverviewSamples(samples:Sample[],serverId:string,now:number,minutes:number){return overviewWindow(samples,serverId,now,minutes).map(sample=>({at:sample.at,cpu:percent(sample.cpu),memory:percent(sample.memory)}));}
type OverviewGpu={id:string;name:string;vendor:'nvidia'|'amd'|'intel';utilization:number|null};
export function deviceOverviewGpus(snapshot:unknown,online:boolean,now:number):OverviewGpu[]{
 const raw=snapshot&&typeof snapshot==='object'?(snapshot as {gpus?:unknown}).gpus:undefined;
 if(!Array.isArray(raw))return [];
 const seen=new Set<string>(),gpus:OverviewGpu[]=[];
 for(const candidate of raw.slice(0,16)){
  if(!candidate||typeof candidate!=='object'||Array.isArray(candidate))continue;
  const gpu=candidate as Record<string,unknown>,vendor=gpu.vendor;
  if(typeof gpu.id!=='string'||!gpu.id.trim()||typeof gpu.name!=='string'||!gpu.name.trim())continue;
  if(vendor!=='nvidia'&&vendor!=='amd'&&vendor!=='intel')continue;
  const id=gpu.id,name=gpu.name.trim();
  if(seen.has(id)||vendor==='intel'&&!/\barc\b/i.test(name))continue;
  seen.add(id);
  const collectedAt=typeof gpu.collectedAt==='string'?Date.parse(gpu.collectedAt):NaN;
  const current=online&&Number.isFinite(now)&&Number.isFinite(collectedAt)&&collectedAt<=now&&now-collectedAt<=120000;
  gpus.push({id,name,vendor,utilization:current&&typeof gpu.utilization==='number'?percent(gpu.utilization):null});
 }
 return gpus;
}
const gpuColors=['#568aba','#c47e2f','#6574b4','#a8639a','#428478','#a56849','#44739a','#926aab','#78823c','#b95368','#527c72','#9a7434','#4e6697','#9c6267','#548391','#805e9d'];
type GpuHistorySeries={id:string;key:string;name:string;vendor:OverviewGpu['vendor'];label:string;color:string};
type HistoryPoint={at:number;cpu:number|null;memory:number|null;[key:string]:number|null};
export function deviceOverviewHistory(samples:Sample[],serverId:string,now:number,minutes:number){
 const selected=overviewWindow(samples,serverId,now,minutes),catalog=new Map<string,OverviewGpu>();
 const readings=selected.map(sample=>{
  // Age is relative to this historical heartbeat, never to the current clock.
  const gpus=deviceOverviewGpus(sample,true,sample.at);
  for(const gpu of gpus){catalog.delete(gpu.id);catalog.set(gpu.id,gpu);}
  return {sample,gpus:new Map(gpus.map(gpu=>[gpu.id,gpu.utilization]))};
 });
 // Adapter replacements can introduce more IDs than one heartbeat. Bound the
 // chart to the most recently observed 16, using safe internal column keys.
 const catalogEntries=[...catalog.values()].slice(-16);
 const gpus:GpuHistorySeries[]=catalogEntries.map((gpu,index)=>({id:gpu.id,key:'gpu_'+index,name:gpu.name,vendor:gpu.vendor,label:catalogEntries.length===1?'GPU':`GPU ${index+1}`,color:gpuColors[index]}));
 const points:HistoryPoint[]=readings.map(({sample,gpus:values})=>({at:sample.at,cpu:percent(sample.cpu),memory:percent(sample.memory),...Object.fromEntries(gpus.map(gpu=>[gpu.key,values.get(gpu.id)??null]))}));
 const available=points.some(point=>point.cpu!==null||point.memory!==null||gpus.some(gpu=>point[gpu.key]!==null));
 return {points,gpus,available};
}

