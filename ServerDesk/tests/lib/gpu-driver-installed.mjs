// GPU driver updates: the installed vendor version of each GPU, the
// numeric version comparison and the status rules (lib/gpu-drivers/installed.ts).
import assert from 'node:assert/strict';
import {compareGpuDriverVersions,effectiveGpuDriverVersion,gpuDriverGroups,gpuDriverPosition,gpuDriverStatus,installedGpuDriverVersion,nvidiaVersionFromWindows,oldestGpuDriverVersion,validGpuDriverVersion} from '../../lib/gpu-drivers/installed.ts';

let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};

// ---- NVIDIA from the Windows driver version: the last five digits of the last two fields ----
for(const [windows,nvidia] of [['32.0.15.8157','581.57'],['32.0.15.8180','581.80'],['31.0.15.5222','552.22'],['32.0.15.6094','560.94'],['30.0.14.7141','471.41'],['27.21.14.6079','460.79'],['32.0.15.7342','573.42'],['32.0.16.0101','601.01']])
 check(nvidiaVersionFromWindows(windows),nvidia,`Windows ${windows} → NVIDIA ${nvidia}`);
for(const value of [null,undefined,'',42,'581.57','32.0.15','32.0.15.8157.1','32.0.x.8157','32.0.10.0001',' ','32.0.15.81572'])
 check(nvidiaVersionFromWindows(value),null,`no NVIDIA version from ${JSON.stringify(value)}`);

// ---- Installed version per vendor ----
check(installedGpuDriverVersion('nvidia',{vendorDriverVersion:'581.57',driverVersion:'32.0.15.8157'}),'581.57','NVIDIA: NVML and Windows agree');
check(installedGpuDriverVersion('nvidia',{vendorDriverVersion:'581.80',driverVersion:'32.0.15.8157'}),'581.80','NVIDIA: NVML newer than the Windows version wins');
check(installedGpuDriverVersion('nvidia',{vendorDriverVersion:'581.57',driverVersion:'32.0.15.8180'}),'581.80','NVIDIA: the Windows version newer than NVML wins (stale NVML after a driver update)');
check(installedGpuDriverVersion('nvidia',{vendorDriverVersion:'581.57',driverVersion:'32.0.16.2114'}),'621.14','NVIDIA: NVML still 581.57 after the update to 621.14');
check(installedGpuDriverVersion('nvidia',{vendorDriverVersion:'621.14',driverVersion:'32.0.15.8157'}),'621.14','NVIDIA: the reverse gives the newer one too');
check(installedGpuDriverVersion('nvidia',{vendorDriverVersion:'581.57',driverVersion:'not a version'}),'581.57','NVIDIA: only NVML is valid');
check(installedGpuDriverVersion('nvidia',{vendorDriverVersion:null,driverVersion:'32.0.15.8157'}),'581.57','NVIDIA: from the Windows version when vendorDriverVersion is missing');
check(installedGpuDriverVersion('nvidia',{vendorDriverVersion:'unknown',driverVersion:'32.0.15.8157'}),'581.57','NVIDIA: a malformed vendor version falls back to Windows');
check(installedGpuDriverVersion('amd',{vendorDriverVersion:'25.10.1',driverVersion:'32.0.21030.2001'}),'25.10.1','AMD: vendorDriverVersion');
check(installedGpuDriverVersion('amd',{vendorDriverVersion:null,driverVersion:'32.0.21030.2001'}),null,'AMD: never from the Windows version');
check(installedGpuDriverVersion('amd',{vendorDriverVersion:'25.10.1',driverVersion:'32.0.16.2114'}),'25.10.1','AMD: a Windows version that looks newer does not count');
check(installedGpuDriverVersion('amd',{vendorDriverVersion:'25.10.1 beta'}),null,'AMD: a malformed value gives null');
check(installedGpuDriverVersion('nvidia',null),null,'no details row');
check(installedGpuDriverVersion('nvidia',{}),null,'empty details row');
for(const [value,valid] of [['581.57',true],['25.10.1',true],['1.2.3.4',true],['1',false],['1.2.3.4.5',false],['12345.1',false],['581.123456',false],['581.57 ',false]])check(validGpuDriverVersion(value),valid,`version format ${value}`);

// ---- Numeric comparison, segment by segment ----
check(compareGpuDriverVersions('581.9','581.57'),-1,'581.9 < 581.57');
check(compareGpuDriverVersions('25.9.1','25.10.1'),-1,'25.9.1 < 25.10.1');
check(compareGpuDriverVersions('581.57','581.57'),0,'equal');
check(compareGpuDriverVersions('581.57','581.57.0'),0,'a missing segment is 0');
check(compareGpuDriverVersions('600.10','581.80'),1,'600.10 > 581.80');
check(compareGpuDriverVersions('25.10.1','25.10'),1,'25.10.1 > 25.10');
check(oldestGpuDriverVersion(['581.80','573.42','581.57']),'573.42','the oldest version');
check(oldestGpuDriverVersion([null,'581.80',null]),'581.80','unknown versions are skipped');
check(oldestGpuDriverVersion([null,null]),null,'no known version');

// ---- Grouping: one entry per vendor; the oldest installed version among its GPUs decides ----
const at='2026-11-03T12:00:00Z';
const snapshot={
 gpus:[
  {id:'a',name:'NVIDIA GeForce RTX 4070',vendor:'nvidia',utilization:1,collectedAt:at},
  {id:'b',name:'Intel(R) Arc(TM) A380 Graphics',vendor:'intel',utilization:1,collectedAt:at},
  {id:'c',name:'NVIDIA GeForce RTX 4070',vendor:'nvidia',utilization:1,collectedAt:at},
  {id:'d',name:'AMD Radeon RX 7900 XTX',vendor:'amd',utilization:1,collectedAt:at},
  {id:'a',name:'duplicate',vendor:'nvidia',utilization:1,collectedAt:at},
  {id:'',name:'no id',vendor:'amd',utilization:1,collectedAt:at},
 ],
 gpuDetails:[
  {id:'a',collectedAt:at,vendorDriverVersion:'581.80',driverVersion:'32.0.15.8180',deviceId:0x2786},
  {id:'c',collectedAt:at,vendorDriverVersion:null,driverVersion:'32.0.15.8157'},
  {id:'d',collectedAt:at,vendorDriverVersion:'25.10.1',deviceId:0x744c},
 ],
};
const groups=gpuDriverGroups(snapshot);
check(groups.map(group=>group.vendor),['nvidia','amd'],'NVIDIA and AMD, Intel left out, in first-GPU order');
check(groups[0],{vendor:'nvidia',gpus:[{id:'a',name:'NVIDIA GeForce RTX 4070',deviceId:0x2786,installed:'581.80'},{id:'c',name:'NVIDIA GeForce RTX 4070',deviceId:null,installed:'581.57'}],installed:'581.57'},'two NVIDIA GPUs: the oldest version decides, duplicates are dropped');
check(groups[1].installed,'25.10.1','the AMD version');
check(gpuDriverGroups(null),[],'no snapshot');
check(gpuDriverGroups({gpus:[{id:'x',name:'Intel Arc A770',vendor:'intel'}]}),[],'no NVIDIA or AMD GPU');
check(gpuDriverPosition(snapshot),1,'position of the first NVIDIA or AMD GPU');
check(gpuDriverPosition({gpus:[{id:'x',name:'Intel Arc A770',vendor:'intel'},{id:'y',name:'Intel UHD 770',vendor:'intel'},{id:'z',name:'AMD Radeon RX 6600',vendor:'amd'}]}),2,'an Intel GPU without Arc is not listed, so the AMD GPU is the second');
check(gpuDriverPosition({gpus:[]}),0,'no GPU');

// ---- Status for each reason ----
const latest={ok:true,version:'581.80',releasedAt:'2026-10-21'};
check(gpuDriverStatus(null,latest),{status:'unknown',reason:'installed-unknown'},'no installed version');
check(gpuDriverStatus('581.57',{ok:false,reason:'lookup-failed'}),{status:'unknown',reason:'lookup-failed'},'lookup failed');
check(gpuDriverStatus('581.57',{ok:false,reason:'unsupported-model'}),{status:'unsupported',reason:'unsupported-model'},'unsupported model');
check(gpuDriverStatus('25.10.1',{ok:false,reason:'unsupported-os'}),{status:'unsupported',reason:'unsupported-os'},'unsupported OS');
check(gpuDriverStatus('581.57',latest),{status:'outdated',reason:null},'older installed version');
check(gpuDriverStatus('581.80',latest),{status:'current',reason:null},'same version');
check(gpuDriverStatus('590.01',latest),{status:'current',reason:null},'a newer installed version counts as current');
check(gpuDriverStatus('581.9',latest),{status:'outdated',reason:null},'581.9 is older than 581.80');
check(gpuDriverStatus(null,{ok:false,reason:'unsupported-model'}),{status:'unknown',reason:'installed-unknown'},'an unknown installed version comes first');

// ---- Effective version: a recent install counts until the device reports it ----
const recent={version:'621.14',finishedAt:1000};
check(effectiveGpuDriverVersion('581.57',null),{installed:'581.57',pending:null},'no recent install');
check(effectiveGpuDriverVersion(null,undefined),{installed:null,pending:null},'nothing reported, no recent install');
check(effectiveGpuDriverVersion('581.57',recent),{installed:'621.14',pending:recent},'reported older: the recent install counts and is pending');
check(effectiveGpuDriverVersion('621.14',recent),{installed:'621.14',pending:null},'reported equal: nothing pending');
check(effectiveGpuDriverVersion('621.20',recent),{installed:'621.20',pending:null},'reported newer: the reported version');
check(effectiveGpuDriverVersion(null,recent),{installed:'621.14',pending:recent},'nothing reported: the recent install, pending');
check(effectiveGpuDriverVersion('621.9',recent),{installed:'621.14',pending:recent},'numeric comparison: 621.9 is older than 621.14');

console.log(`PASS: ${checks} GPU driver version and status checks.`);
