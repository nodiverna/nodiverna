// GPU driver updates: the rules of the "Graphics driver" card
// (ui/devices/hardware/gpu-driver-view.ts): the order of the blocked reasons, the confirmation
// and its payload, the sample data, the multi-GPU sentence, the job state, and
// the wiring of the card (ui/devices/hardware/device-gpu-driver.tsx) as source checks.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {sourceLoader} from '../../support/source-database.mjs';

let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const load=sourceLoader();
const view=load('ui/devices/hardware/gpu-driver-view.ts'),{translate}=load('lib/i18n/translate.ts'),{demoData}=load('ui/shell/demo.ts');
const en=(key,params)=>translate('en',key,params);

const now=Date.now();
const viewer={id:'tech',label:'tech@example.test',permissions:[]};
const server={id:'device-a',name:'WS-01',lastSeen:now-1000,management:1,revoked:0,permissions:['view','manage'],snapshot:{mode:'Management',agentCapabilities:['install-gpu-driver']}};
const context={server,viewer,demo:false,now,jobs:[]};
const entry={vendor:'nvidia',gpuIds:['g1'],gpuNames:['NVIDIA GeForce RTX 4070'],installed:'581.57',reported:'581.57',pendingInventory:null,latest:{version:'621.01',releasedAt:'2026-10-21'},status:'outdated',reason:null,checkedAt:now};
const job=(state,extra={})=>({id:'job-'+state,serverId:server.id,action:'install-gpu-driver',state,target:'NVIDIA 621.01',createdAt:now-60000,result:null,...extra});

// ---- Blocked reasons, in their order ----
check(view.gpuDriverActionReason(context,entry,'en'),'','an outdated driver can be updated');
const steps=[
 [{demo:true},en('network.blocked.demo')],
 [{server:{...server,revoked:1}},en('services.blocked.removed')],
 [{server:{...server,permissions:['view']}},en('services.blocked.manage')],
 [{server:{...server,lastSeen:now-600000}},en('network.blocked.offline')],
 [{server:{...server,snapshot:{...server.snapshot,agentCapabilities:['refresh']}}},en('hardware.gpuDriver.blocked.agent')],
 [{server:{...server,management:0}},en('updates.blocked.management')],
 [{server:{...server,snapshot:{...server.snapshot,mode:'ReadOnly'}}},en('updates.blocked.management')],
 [{jobs:[job('running')]},en('hardware.gpuDriver.blocked.active')],
 [{jobs:[job('pending')]},en('hardware.gpuDriver.blocked.active')],
];
for(const [override,reason] of steps)check(view.gpuDriverActionReason({...context,...override},entry,'en'),reason,'reason: '+reason);
check(view.gpuDriverActionReason(context,{...entry,status:'current'},'en'),en('hardware.gpuDriver.blocked.current'),'a current driver');
check(view.gpuDriverActionReason(context,{...entry,status:'unknown'},'en'),en('hardware.gpuDriver.blocked.current'),'an unknown status is not outdated');
// Each earlier reason wins over every later one.
const all={demo:true,server:{...server,revoked:1,permissions:['view'],lastSeen:now-600000,management:0,snapshot:{mode:'ReadOnly',agentCapabilities:[]}},jobs:[job('running')]};
check(view.gpuDriverActionReason({...context,...all},{...entry,status:'current'},'en'),en('network.blocked.demo'),'demo comes first');
check(view.gpuDriverActionReason({...context,...all,demo:false},{...entry,status:'current'},'en'),en('services.blocked.removed'),'then removed');
check(view.gpuDriverActionReason({...context,server:{...all.server,revoked:0},jobs:all.jobs},entry,'en'),en('services.blocked.manage'),'then the right');
check(view.gpuDriverActionReason({...context,server:{...all.server,revoked:0,permissions:['manage']},jobs:all.jobs},entry,'en'),en('network.blocked.offline'),'then offline');
check(view.gpuDriverActionReason({...context,server:{...all.server,revoked:0,permissions:['manage'],lastSeen:now},jobs:all.jobs},entry,'en'),en('hardware.gpuDriver.blocked.agent'),'then the agent');
check(view.gpuDriverActionReason({...context,server:{...server,management:0},jobs:all.jobs},entry,'en'),en('updates.blocked.management'),'then Management mode');
check(view.gpuDriverActionReason({...context,viewer:{...viewer,permissions:['*']},server:{...server,permissions:[]}},entry,'en'),'','an Owner needs no device right');
check(view.gpuDriverActionReason({...context,jobs:[job('running',{serverId:'other'}),job('running',{action:'install-updates'}),job('succeeded')]},entry,'en'),'','jobs of other devices, other kinds and finished jobs do not block');

// ---- Visibility, sentences and status texts ----
check(['outdated','current','unknown','unsupported'].map(view.gpuDriverUpdateVisible),[true,true,false,false],'"Update driver" is shown for outdated and current');
check(view.gpuDriverSentence(entry,'en'),'NVIDIA offers a newer driver for this graphics card.','outdated sentence');
check(view.gpuDriverSentence({...entry,status:'current'},'en'),'The newest NVIDIA driver is installed.','current sentence');
check(view.gpuDriverSentence({vendor:'amd',status:'unsupported',reason:'unsupported-os'},'en'),'AMD offers no driver for this Windows version.','unsupported OS sentence');
check(view.gpuDriverSentence({vendor:'nvidia',status:'unknown',reason:'installed-unknown'},'de'),'Der Agent hat die installierte NVIDIA-Treiberversion nicht gemeldet. Aktualisiere den Agent auf 4.13.0 oder neuer.','German reason');
check(view.gpuDriverSentence({vendor:'amd',status:'unknown',reason:'lookup-failed'},'en'),'The latest version from AMD could not be checked. Try again later.','lookup failed sentence');
check(view.gpuDriverSentence({vendor:'nvidia',status:'unsupported',reason:'unsupported-model'},'en'),en('hardware.gpuDriver.reason.unsupportedModel'),'unsupported model sentence');
check(view.gpuDriverMultiGpu(entry,'en'),null,'one GPU: no note');
check(view.gpuDriverMultiGpu({...entry,gpuIds:['g1','g2']},'en'),'The update applies to all NVIDIA graphics cards in this device.','several GPUs of one vendor');
check(view.gpuDriverMultiGpu({vendor:'amd',gpuIds:['a','b']},'de'),'Das Update gilt für alle AMD-Grafikkarten in diesem Gerät.','German multi-GPU note');
check(['current','outdated','unknown','unsupported'].map(status=>view.gpuDriverStatusText(status,'en')),['Up to date','Update available','Status unknown','Not supported'],'status texts');
check([view.gpuDriverVendorOf('nvidia'),view.gpuDriverVendorOf('amd'),view.gpuDriverVendorOf('intel')],['nvidia','amd',null],'Intel GPUs get no card');

// ---- Recent install the device has not reported yet ----
const pendingEntry={...entry,installed:'621.01',reported:'581.57',status:'current',pendingInventory:{version:'621.01',finishedAt:now-60000}};
check(view.gpuDriverSentence(pendingEntry,'en'),'NVIDIA driver 621.01 is installed. The new version shows here once the device reports it.','pending sentence instead of the current sentence');
check(view.gpuDriverSentence(pendingEntry,'de'),'NVIDIA-Treiber 621.01 ist installiert. Die neue Version erscheint hier, sobald das Gerät sie meldet.','German pending sentence');
check(view.gpuDriverSentence({...pendingEntry,status:'outdated'},'en'),en('hardware.gpuDriver.pending.sentence',{vendor:'NVIDIA',version:'621.01'}),'the pending sentence also when a newer version is available');
check(view.gpuDriverPendingReported(pendingEntry,'en'),'The device still reports 581.57.','the reported version follows in meta style');
check(view.gpuDriverPendingReported(pendingEntry,'de'),'Das Gerät meldet noch 581.57.','German reported line');
check(view.gpuDriverPendingReported({...pendingEntry,reported:null},'en'),null,'no reported line when the device reports no version');
check(view.gpuDriverPendingReported(entry,'en'),null,'no reported line without pendingInventory');
check(view.gpuDriverSentence(entry,'en')===en('hardware.gpuDriver.sentence.outdated',{vendor:'NVIDIA'})&&view.gpuDriverSentence({...entry,status:'current'},'en')===en('hardware.gpuDriver.sentence.current',{vendor:'NVIDIA'}),true,'no pending text without pendingInventory');
check(view.gpuDriverActionReason(context,pendingEntry,'en'),en('hardware.gpuDriver.blocked.current'),'"Update driver" is blocked with the current reason while pending');
check(view.gpuDriverConfirmation(context,{...pendingEntry,installed:'617.42',status:'outdated',pendingInventory:{version:'617.42',finishedAt:now}},'en').description.split('\n')[1],'Version: 617.42 → 621.01','the confirmation starts from the effective installed version');
check(view.gpuDriverReloadCodes,['GPU_DRIVER_ALREADY_INSTALLED','GPU_DRIVER_JOB_ACTIVE','GPU_DRIVER_VERSION_CHANGED'],'the refusals that reload the card');

// ---- Confirmation ----
const confirmation=view.gpuDriverConfirmation(context,entry,'en');
check(confirmation.payload,{action:'job',id:'device-a',kind:'install-gpu-driver',params:{vendor:'nvidia',version:'621.01'},confirm:true},'the payload names vendor and version only');
check(confirmation.title,'Update the NVIDIA graphics driver?','the title is a question');
check(confirmation.description.split('\n'),['Device: WS-01','Version: 581.57 → 621.01','',en('hardware.gpuDriver.confirm.warning')],'device and version lines, then the disruption warning');
assert.match(confirmation.description,/remote desktop sessions can disconnect.*The agent does not restart it\./s);checks++;
check(view.gpuDriverConfirmation({...context,demo:true},entry,'en'),null,'no confirmation while blocked');
check(view.gpuDriverConfirmation(context,{...entry,status:'current'},'en'),null,'no confirmation for a current driver');
check(view.gpuDriverConfirmation({...context,jobs:[job('pending')]},entry,'en'),null,'no confirmation while a driver job waits');

// ---- Job state ----
const jobs=[job('succeeded',{id:'old',createdAt:now-90000}),job('failed',{id:'new',createdAt:now-30000}),job('running',{id:'other-device',serverId:'b'})];
check(view.activeGpuDriverJob({server,jobs}),undefined,'no active job');
check(view.finishedGpuDriverJob({server,jobs})?.id,'new','the newest finished job');
check(view.activeGpuDriverJob({server,jobs:[...jobs,job('running',{id:'live'})]})?.id,'live','the running job');

// ---- Sample devices: fixed data, NVIDIA outdated ----
const sample=demoData().servers.find(device=>device.snapshot?.gpus?.length);
check(sample?.id,'demo-app','one sample device has a GPU');
const demoView=view.demoGpuDriverView(sample,now);
check(demoView.entries.map(item=>[item.vendor,item.gpuIds.length,item.installed,item.latest,item.status,item.reason]),[['nvidia',1,'573.42',view.demoGpuDriverLatest,'outdated',null]],'one NVIDIA GPU, outdated');
check(demoView.entries.map(item=>[item.reported,item.pendingInventory]),[['573.42',null]],'sample devices: reported = installed, nothing pending');
check(view.gpuDriverActionReason({server:sample,viewer:{...viewer,permissions:['*']},demo:true,now,jobs:[]},demoView.entries[0],'en'),en('network.blocked.demo'),'the update stays blocked with the demo reason');
check(sample.snapshot.agentCapabilities.includes('install-gpu-driver'),true,'sample agents advertise the capability');

// ---- The card's wiring (source checks) ----
const card=fs.readFileSync('ui/devices/hardware/device-gpu-driver.tsx','utf8'),gpu=fs.readFileSync('ui/devices/hardware/device-gpu.tsx','utf8');
check(/const view=demo\?demoGpuDriverView\(server,now\)/.test(card)&&/const fetchable=!demo&&server\.revoked===0;/.test(card)&&/if\(!fetchable\)return;/.test(card),true,'sample devices read the fixed data and send no request');
check(/<Skeleton variant="facts" rows=\{2\} label=\{t\('hardware\.gpuDriver\.loading'\)\} after=\{15000\} action=\{<RetryAction /.test(card)&&!card.includes('sdx-loading'),true,'the first load shows the kit Skeleton (role status) with the slow-load retry');
check(/<Notice tone="danger"[^>]*action=\{<RetryAction onRetry=/.test(card)&&!card.includes('hardware.gpuDriver.retry'),true,'a failed load shows a danger notice with the common retry');
check(/outcome\.code&&gpuDriverReloadCodes\.includes\(outcome\.code\)\)setRevision/.test(card),true,'alreadyInstalled, jobActive and versionChanged reload the card, by code');
check(/pending\?<div className="dgd-inventory" role="status"><RefreshCw size=\{16\} aria-hidden\/>/.test(card)&&/\{reported&&<small>\{reported\}<\/small>\}/.test(card),true,'the pending row has role status, a static RefreshCw icon and the reported line in meta style');
check(/key=\{entry\.installed\?\?'none'\}>\{entry\.installed\?\?EMPTY_VALUE\}/.test(card),true,'the Installed figure shows the effective version and cross-fades by key');
check(/\.dgd-inventory\{[^}]*animation:sdx-fade/.test(fs.readFileSync('ui/devices/hardware/device-gpu.css','utf8'))&&!/\.dgd-inventory[^{]*\{[^}]*infinite/.test(fs.readFileSync('ui/devices/hardware/device-gpu.css','utf8')),true,'the pending row fades in once and never loops');
check(/recent\?\.resultCode==='AGENT_GPU_DRIVER_INSTALLED_REBOOT'&&<Notice tone="warning"/.test(card),true,'the reboot result shows a warning notice, by code');
check(/IconBtn icon=\{RefreshCw\} label=\{t\('hardware\.gpuDriver\.checkAgain'\)\} loading=\{refreshing\}/.test(card),true,'"Check again" is an IconBtn with loading');
check(/<Btn variant="primary" icon=\{Download\}[^>]*blocked=\{reason\|\|undefined\}/.test(card),true,'"Update driver" is the primary Btn, blocked with its reason');
check(/if\(previousActive\.current&&!activeId\)/.test(card),true,'a job that ends reloads the status');
check(/\{driverVendor&&<DeviceGpuDriver key=\{server\.id\+':'\+driverVendor\}/.test(gpu)&&gpu.indexOf('<DeviceGpuDriver')>gpu.indexOf('className="dgp-head"')&&gpu.indexOf('<DeviceGpuDriver')<gpu.indexOf('<KpiRow'),true,'the card sits below the GPU head and above the GPU KpiRow, one state per vendor');
check(gpu.includes("t('device.gpu.drivers')"),true,'the Drivers facts card stays');
const css=fs.readFileSync('ui/devices/hardware/device-gpu.css','utf8');
check(/@keyframes/.test(css)||/#[0-9a-f]{3,8}\b|rgba?\(/i.test(css),false,'no new keyframes, hex or rgba values in the GPU styles');

console.log(`PASS: ${checks} GPU driver view checks.`);
