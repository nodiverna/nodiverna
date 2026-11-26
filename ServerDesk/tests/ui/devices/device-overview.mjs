// The Overview helpers of ui/devices/device/device-overview.tsx. The classic DeviceOverview component is deleted;
// the console Overview (ui/devices/device/device-summary.tsx), Hardware and GPU use these helpers.
import '../../support/register.mjs';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const overview=await import('../../../ui/devices/device/device-overview.tsx');
const {deviceOverviewSamples,deviceOverviewHistory,deviceOverviewGpus}=overview;
assert.equal(overview.default,undefined,'the classic DeviceOverview default export is gone');
assert.doesNotMatch(fs.readFileSync('ui/devices/device/device-overview.tsx','utf8'),/@\/components\/ui\/|loading-skeleton|device-overview\.css|MonitoringPanel/,'the helper module imports no shadcn part, no LoadingSkeleton, no stylesheet and no classic panel');
assert.equal(fs.existsSync('app/device-overview.css'),false,'the classic Overview stylesheet is deleted with the component');
for(const file of ['ui/devices/device/device-summary.tsx','ui/devices/device/device.tsx','ui/devices/hardware/device-gpu.tsx','ui/devices/hardware/device-hardware.tsx'])assert.doesNotMatch(fs.readFileSync(file,'utf8'),/import [A-Z]\w* from '@\/ui\/devices\/device\/device-overview'|default as/,file+' imports only the helpers');
const now=Date.now();
const snapshot={hostname:'WIN-SRV',os:'Microsoft Windows Server 2025 Datacenter',security:{domainJoined:true,domainRole:3,rdpEnabled:true,lastBoot:new Date(now-86400000).toISOString(),firewall:[{name:'Domain',enabled:true}],defender:{available:true,enabled:true,realTimeProtection:true,signatureAt:new Date(now).toISOString()}}};
const gpu=(id,name,vendor,utilization,collectedAt=new Date(now).toISOString())=>({id,name,vendor,utilization,collectedAt});

// Current GPUs: physical adapters only, live load only while the device is online and the value is fresh.
const physicalGpus=[gpu('nv-1','NVIDIA GeForce RTX 4090','nvidia',27.5),gpu('amd-1','AMD Radeon RX 7900 XTX','amd',0),gpu('arc-1','Intel(R) Arc(TM) A770 Graphics','intel',100),gpu('nv-2','NVIDIA GeForce RTX 4090','nvidia',54)];
assert.deepEqual(deviceOverviewGpus({gpus:physicalGpus},true,now).map(entry=>[entry.id,entry.utilization]),[['nv-1',27.5],['amd-1',0],['arc-1',100],['nv-2',54]],'physical adapters keep their order and zero load');
assert.deepEqual(deviceOverviewGpus({gpus:[gpu('igpu','Intel(R) UHD Graphics 770','intel',5),gpu('soft','Microsoft Basic Display','microsoft',1),gpu('nv-1','NVIDIA','nvidia',1),gpu('nv-1','NVIDIA','nvidia',2),{id:'',name:'x',vendor:'amd'}]},true,now).map(entry=>entry.id),['nv-1'],'integrated Intel, unknown vendors, duplicates and empty ids are skipped');
for(const collectedAt of [new Date(now-120001).toISOString(),new Date(now+1).toISOString(),'not-a-date',undefined])assert.equal(deviceOverviewGpus({gpus:[{...gpu('stale','NVIDIA RTX A5000','nvidia',47),collectedAt}]},true,now)[0].utilization,null,'old, future or absent timestamps are no live load');
assert.equal(deviceOverviewGpus({gpus:[gpu('boundary','Intel Arc B580','intel',47,new Date(now-120000).toISOString())]},true,now)[0].utilization,47,'a value exactly 120 seconds old is still fresh');
assert.deepEqual(deviceOverviewGpus({gpus:physicalGpus},false,now).map(entry=>entry.utilization),[null,null,null,null],'offline devices keep their adapters without live load');
assert.equal(deviceOverviewGpus({gpus:Array.from({length:20},(_,index)=>gpu('many-'+index,'NVIDIA RTX '+index,'nvidia',index))},true,now).length,16,'bounded by the telemetry maximum');
assert.deepEqual(deviceOverviewGpus({gpus:{unexpected:true}},true,now),[],'a malformed GPU container gives no adapters');
assert.deepEqual(deviceOverviewGpus(null,true,now),[]);

// CPU and RAM samples of one device and window.
const samples=[{serverId:'other',at:now-1000,cpu:99,memory:99},{serverId:'device',at:now+1,cpu:99,memory:99},{serverId:'device',at:now-60001,cpu:99,memory:99},{serverId:'device',at:now-2000,cpu:0,memory:20},{serverId:'device',at:now-1000,cpu:-1,memory:101},{serverId:'device',at:now,cpu:null,memory:0}];
assert.deepEqual(deviceOverviewSamples(samples,'device',now,1),[{at:now-2000,cpu:0,memory:20},{at:now-1000,cpu:null,memory:null},{at:now,cpu:null,memory:0}],'history isolates the device/window, keeps zero and masks invalid samples');assert.equal(samples.length,6);
const legacy=deviceOverviewHistory(samples,'device',now,60);
assert.deepEqual(legacy.gpus,[],'legacy samples never receive a GPU series');assert.equal(legacy.points.length,4);assert.equal(legacy.available,true);

// GPU history: zero and null gaps, freshness at sample.at, separate same-model adapters, at most 16 series.
const sample=(at,gpus,cpu=null,memory=null,serverId='device')=>({at,gpus,cpu,memory,serverId});
const historicalGpu=(at,value,collectedAt=new Date(at).toISOString())=>gpu('luid_0x00000000_0x0000ABCD_phys_0','NVIDIA GeForce RTX 4090','nvidia',value,collectedAt);
const historyAt=now-600000;
const gpuHistory=[sample(historyAt,[historicalGpu(historyAt,0)]),sample(historyAt+1000,undefined),sample(historyAt+2000,[historicalGpu(historyAt+2000,null)]),sample(historyAt+3000,[historicalGpu(historyAt+3000,-1)]),sample(historyAt+4000,[historicalGpu(historyAt+4000,60,new Date(historyAt+4000-120001).toISOString())]),sample(historyAt+5000,[historicalGpu(historyAt+5000,60,new Date(historyAt+5001).toISOString())]),sample(historyAt+6000,[historicalGpu(historyAt+6000,42)])];
const mixedHistory=[sample(now+1,[historicalGpu(now+1,99)]),sample(now-3600001,[historicalGpu(now-3600001,99)]),sample(historyAt,[historicalGpu(historyAt,99)],99,99,'other'),...gpuHistory.toReversed()];
const history=deviceOverviewHistory(mixedHistory,'device',now,60);
assert.deepEqual(history.points.map(point=>point.at),gpuHistory.map(point=>point.at),'excludes another device, future and out-of-window samples and sorts the rest');
assert.deepEqual(history.gpus.map(series=>[series.key,series.label,series.name]),[['gpu_0','GPU','NVIDIA GeForce RTX 4090']]);
assert.deepEqual(history.points.map(point=>point.gpu_0),[0,null,null,null,null,null,42],'keeps zero and explicit null gaps for absent, invalid, stale and future telemetry');
assert.ok(history.points.every(point=>point.cpu===null&&point.memory===null)&&history.available,'GPU-only history is available without CPU/RAM values');
assert.equal(mixedHistory.length,10,'history preparation does not mutate the caller\'s measurement list');
const twoGpuHistory=[sample(historyAt,[gpu('adapter.a','NVIDIA RTX A5000','nvidia',0,new Date(historyAt).toISOString()),gpu('adapter.b','NVIDIA RTX A5000','nvidia',83,new Date(historyAt).toISOString())]),sample(historyAt+1000,[gpu('adapter.b','NVIDIA RTX A5000','nvidia',80,new Date(historyAt+1000).toISOString())])];
const two=deviceOverviewHistory(twoGpuHistory,'device',now,60);
assert.equal(two.gpus.length,2,'same-model physical adapters have separate series');assert.equal(new Set(two.gpus.map(series=>series.color)).size,2,'separate GPUs use separate colors');
assert.deepEqual(two.gpus.map(series=>series.label),['GPU 1','GPU 2']);
for(const series of two.gpus)assert.deepEqual(two.points.map(point=>point[series.key]),series.id==='adapter.a'?[0,null]:[83,80]);
const boundary=[sample(historyAt,[historicalGpu(historyAt,12,new Date(historyAt-120000).toISOString())]),sample(historyAt+1000,[historicalGpu(historyAt+1000,101)]),sample(historyAt+2000,[historicalGpu(historyAt+2000,Infinity)]),sample(historyAt+3000,[historicalGpu(historyAt+3000,NaN)]),sample(historyAt+4000,[historicalGpu(historyAt+4000,12,'invalid')])];
assert.deepEqual(deviceOverviewHistory(boundary,'device',now,60).points.map(point=>point.gpu_0),[12,null,null,null,null],'120-second freshness is measured at sample.at; invalid values and timestamps stay gaps');
assert.equal(deviceOverviewHistory([sample(historyAt,[historicalGpu(historyAt,null)])],'device',now,60).available,false,'all-null GPU history is not available');
const replacements=Array.from({length:20},(_,index)=>{const at=historyAt+index*1000;return sample(at,[gpu('replacement-'+index,'NVIDIA Adapter '+index,'nvidia',index,new Date(at).toISOString())]);});
const limited=deviceOverviewHistory(replacements,'device',now,60);
assert.equal(limited.gpus.length,16,'at most 16 GPU series');assert.equal(new Set(limited.gpus.map(series=>series.color)).size,16);
assert.deepEqual(limited.gpus.map(series=>series.id),replacements.slice(4).map(point=>point.gpus[0].id),'the limit keeps the most recently seen adapters');
// The Defender row of the card "Protection & maintenance" (lib/defender.ts, agent 4.14.0).
{
 const {defenderProtectionRow}=await import('../../../lib/defender.ts'),day=86400000,at=offset=>new Date(now-offset).toISOString(),target={section:'management',management:'defender'};
 const report=(extra={})=>({available:true,collectedAt:at(60000),mode:'normal',antivirusEnabled:true,realTimeProtection:true,tamperProtected:true,quickScanAt:at(day),fullScanAt:null,signatureAt:at(3600000),signatureVersion:'1.0',productVersion:'4.18',otherAntivirus:[],detectionCount:0,activeCount:0,highestActiveSeverity:null,truncated:false,...extra});
 const row=(defender,locale='en',legacy=snapshot.security.defender)=>defenderProtectionRow({snapshot:{...snapshot,security:{...snapshot.security,defender:legacy},...(defender===undefined?{}:{defender})}},now,locale);
 const named=[{name:'Contoso Endpoint Security',enabled:true}];
 assert.deepEqual(row(report({mode:'passive',realTimeProtection:false,otherAntivirus:named})),{value:'Passive',detail:'Contoso Endpoint Security protects this device.',tone:'neutral',target},'passive with the product name');
 assert.deepEqual(row(report({mode:'sxs-passive',otherAntivirus:null})),{value:'Passive',detail:'Another antivirus protects this device.',tone:'neutral',target},'passive without a name');
 assert.deepEqual(row(report({mode:'passive',otherAntivirus:named}),'de'),{value:'Passiv',detail:'Contoso Endpoint Security schützt dieses Gerät.',tone:'neutral',target},'passive (de)');
 assert.deepEqual(row(report({activeCount:2,detectionCount:3,highestActiveSeverity:'severe'})),{value:'2 active detections',detail:'Highest severity: Severe',tone:'critical',target},'active detections');
 assert.deepEqual(row(report({activeCount:1,detectionCount:1,highestActiveSeverity:'high'}),'de').value,'1 aktiver Fund','one active detection (de)');
 assert.deepEqual(row(report({realTimeProtection:false,otherAntivirus:named})),{value:'Off',detail:'Contoso Endpoint Security protects this device.',tone:'neutral',target},'off next to another antivirus');
 assert.deepEqual(row(report({antivirusEnabled:false})),{value:'Off',detail:'Antivirus or real-time protection is turned off.',tone:'critical',target},'off without another antivirus');
 assert.deepEqual(row(report()),{value:'Real-time protection on',detail:'Signatures from today',tone:'ok',target},'normal: the real-time and signature texts');
 assert.deepEqual(row({available:false,reason:'not-installed',collectedAt:at(0)}),{value:'Not installed',tone:'neutral',target},'not installed');
 assert.deepEqual(row(undefined,'en',{available:false,enabled:false,signatureAt:'',realTimeProtection:false}),{value:'Not available',detail:'Update the agent to 4.14.0 or later to see why.',tone:'neutral'},'older agent without Defender: Not available with the update hint');
 assert.deepEqual(row(undefined,'de',{available:false,enabled:false,signatureAt:'',realTimeProtection:false}).detail,'Aktualisiere den Agent auf 4.14.0 oder neuer, um den Grund zu sehen.','older agent (de)');
 assert.deepEqual(row(undefined).value,'Real-time protection on','older agent with Defender: the texts of today');
 assert.equal(defenderProtectionRow({snapshot:{...snapshot,security:undefined}},now),null,'no Defender data: no row');
 const catalogs=['lib/i18n/messages/en.ts','lib/i18n/messages/de.ts'].map(file=>fs.readFileSync(file,'utf8'));
 assert.ok(catalogs.every(text=>!text.includes("'device.protection.otherAv'")),'device.protection.otherAv is removed from both catalogs');
 assert.ok(!fs.readFileSync('ui/devices/device/device-summary.tsx','utf8').includes('device.protection.otherAv'),'the overview no longer guesses another antivirus');
}
console.log('PASS: the Overview helpers (current GPUs, CPU/RAM samples, GPU history with honest gaps and the 16-series limit) without the deleted classic component; the Defender row of the protection card with its target.');
