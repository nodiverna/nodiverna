// Management → Storage on the kit (ui/devices/management/storage-panel.tsx, ui/devices/hardware/disk-health.tsx): the panel
// notice, IEC sizes, the disk health dash, the focusable table regions, the disk and partition menus
// with their blocked reasons, the edit Drawer, load and action errors and the exact confirmation
// payloads. The panel runs on hook cells (tests/support/panel-harness.mjs): cell 0 the storage jobs,
// cell 4 the open edit, cells 5/6 size and unit, cell 12 the typed erase confirmation.
import assert from 'node:assert/strict';
import {panelHarness} from '../../support/panel-harness.mjs';
import {buttons} from '../../support/blocked-buttons.mjs';
import {de} from '../../support/i18n-stubs.mjs';
let loads=0,posts=[],failLoad=false,failPost=false,confirmations=[];
const now=Date.now(),GiB=1073741824;
const harness=panelHarness({hooked:['ui/devices/management/storage-panel.tsx'],stubs:{'@/ui/base/api':api=>({...api.load('ui/base/api.tsx'),api:async(url,body)=>{if(body){posts.push(body);if(failPost)throw new Error('Auftrag abgelehnt');return {id:'job'};}loads++;if(failLoad)throw new Error('Speicher nicht erreichbar');return {jobs:responseJobs};}})}});
const Storage=harness.load('ui/devices/management/storage-panel.tsx').default;
let responseJobs=[];
const viewer={id:'owner',label:'owner@test.example',permissions:['*']};
const capabilities=['storage-inspect','storage-initialize','storage-resize','storage-new-volume','storage-set-disk','storage-drive-letter','storage-format','storage-delete-partition'];
const usb={id:'usb',number:2,model:'USB Stick',busType:'USB',mediaType:'unspecified',health:'unknown',operationalStatus:[],driveLetters:['E:'],countersAvailable:false,wearPercent:null,temperatureC:null,temperatureMaxC:null,readErrorsUncorrected:null,powerOnHours:null};
const ssd={id:'ssd',number:0,model:'NVMe SSD',busType:'NVMe',mediaType:'ssd',health:'healthy',operationalStatus:['ok'],driveLetters:['C:'],countersAvailable:true,wearPercent:4,temperatureC:38,temperatureMaxC:70,readErrorsUncorrected:0,powerOnHours:1200};
const snapshot={protocolVersion:3,mode:'Management',agentCapabilities:capabilities,disks:[{name:'C:',label:'Windows',totalGb:128,freeGb:40.5},{name:'E:',label:'USB',totalGb:32,freeGb:30}],diskHealth:{collectedAt:new Date(now).toISOString(),disks:[ssd,usb],events:{windowDays:30,items:[],counts:{},truncated:false}}};
const server={id:'server-a',name:'WIN-TEST',snapshot,management:1,lastSeen:now,permissions:['view','diagnose','manage'],revoked:0};
const part=(number,letter,changes={})=>({number,offsetBytes:number*GiB,sizeBytes:20*GiB,type:'Basic',gptType:'Basic',driveLetter:letter,accessPaths:[letter+':\\'],fileSystem:'NTFS',label:'Data'+number,health:'Healthy',freeBytes:10*GiB,sizeMinBytes:10*GiB,sizeMaxBytes:50*GiB,protected:false,growOnly:false,protectionReasons:[],...changes});
const disk=(number,changes={})=>({number,uniqueId:'disk-'+number,name:'Disk '+number,serial:'s'+number,busType:'SCSI',partitionStyle:'GPT',sizeBytes:128*GiB,allocatedBytes:60*GiB,largestFreeExtentBytes:10*GiB,offline:false,readOnly:false,health:'Healthy',operationalStatus:'OK',protected:false,protectionReasons:[],partitions:[],...changes});
const system=disk(0,{protected:true,protectionReasons:['Windows-Systemdatenträger'],partitions:[part(2,'C',{protected:true,growOnly:true,protectionReasons:['Windows-Systemvolume'],sizeMinBytes:100*GiB,sizeMaxBytes:120*GiB,sizeBytes:100*GiB})]});
const data=disk(1,{partitions:[part(1,'E',{sizeMinBytes:null,sizeMaxBytes:null}),part(2,'F')]});
const offline=disk(2,{offline:true,partitions:[part(1,'G')]});
const inventory={disks:[system,data,offline],truncated:false,warnings:[]};
const stored={serverId:'server-a',jobs:[{id:'inspect-1',kind:'storage-inspect',state:'succeeded',createdAt:now,result:'Inventar gelesen.',data:{kind:'storage-inspect',at:new Date(now).toISOString(),data:inventory}}],loaded:true};
const base={server,viewer,demo:false,saving:false,onConfirm:value=>confirmations.push(value)};
function reset(cells={}){harness.reset(cells);loads=0;posts=[];failLoad=false;failPost=false;confirmations=[];responseJobs=stored.jobs;}
const tree=(props={})=>harness.tree(Storage,{...base,...props}),html=(props={})=>harness.html(Storage,{...base,...props});
const identity=(d,p)=>({diskNumber:d.number,diskUniqueId:d.uniqueId,expectedDiskSizeBytes:d.sizeBytes,confirm:true,...(p?{partitionNumber:p.number,expectedOffsetBytes:p.offsetBytes,expectedSizeBytes:p.sizeBytes}:{})});
const entry=(element,label,id)=>harness.menu(element,label)?.find(item=>item.id===id);
const submit=element=>harness.find(element,item=>item.type==='form'&&item.props.id==='sdx-storage-editor').props.onSubmit({preventDefault(){}});

// ---- Without storage-inspect: the notice, the disk health card and the reported drives ----
reset();let markup=html({demo:true});
assert.match(markup,new RegExp(`class="sdx-notice sdx-notice-info" role="status">.*?<div>${de('kit.unavailable.demo')} ${de('storage.readOnly')}</div>`),'demo: the sample-device sentence and storage.readOnly');
assert.ok(!markup.includes('zugewiesenen Rechte')&&!markup.includes('Datenträgerverwaltung ist für dieses Gerät'),'no generic capability note');
assert.match(markup,/128\sGiB/);assert.match(markup,/41\sGiB/);assert.ok(!/\d GB\b/.test(markup),'IEC units, no GB');
assert.match(markup,/role="region" aria-label="Gemeldete Laufwerke"/);assert.match(markup,/role="region" aria-label="Datenträgerzustand"/);
const usbRow=markup.match(/<tr[^>]*>(?:(?!<\/tr>).)*?USB Stick.*?<\/tr>/)?.[0]??'';
assert.equal((usbRow.match(/>—</g)||[]).length,4,'the USB disk shows four dashes');
assert.ok(!markup.includes('Nicht verfügbar'),'never "Nicht verfügbar" in the cells');
assert.equal((markup.match(new RegExp(de('diskHealth.notReportedFoot')))||[]).length,1,'one foot line explains the dash');
for(const [props,reason] of [[{viewer:{...viewer,permissions:[]},server:{...server,permissions:['view']}},'right'],[{server:{...server,revoked:1}},'revoked'],[{server:{...server,snapshot:{...snapshot,agentCapabilities:[]}}},'agent']]){
 reset();markup=html(props);assert.match(markup,new RegExp(`<div>${de('kit.unavailable.'+reason)} ${de('storage.readOnly')}</div>`),reason+' names its reason');
}

// ---- With storage-inspect: inventory card, disks, menus ----
reset({0:stored});markup=html();
assert.ok(!markup.includes('sdx-notice-info'),'a manager sees no panel notice');
for(const label of ['Datenträgerzustand','Partitionen auf Datenträger 0','Partitionen auf Datenträger 1','Partitionen auf Datenträger 2'])assert.match(markup,new RegExp(`role="region" aria-label="${label}"`),label+' is a labelled region');
assert.equal((markup.match(/class="sdx-table-wrap[^"]*" role="region" aria-label="[^"]+"/g)||[]).length,(markup.match(/class="sdx-table-wrap/g)||[]).length,'every table wrap is a labelled region');
assert.match(markup,/role="img" aria-label="Partitionen auf Datenträger 1"/,'the partition map stays');assert.match(markup,/Stand /);
assert.match(markup,/<span class="sr-only">Geschützt<\/span>/,'the protected disk is labelled');
assert.equal(buttons(markup).find(button=>button.inner.includes('<span>Neues Volume</span>')&&button.blocked)?.description,de('storage.blocked.protectedDiskReasons').replace('{reasons}','Windows-Systemdatenträger'));
assert.ok(!/<select[^>]*aria-label="(Aktion für|Status von Datenträger)/.test(markup),'no native select triggers actions');
let element=tree();
assert.equal(entry(element,'Datenträgereinstellungen für Datenträger 0','state').blocked,'Dieser Datenträger ist geschützt: Windows-Systemdatenträger.','protected disk settings name the reasons');
assert.equal(entry(element,'Aktion für Datenträger 1 · Partition 1 (E:)','storage-resize').blocked,de('storage.blocked.noSizeRange'),'no size range');
assert.equal(entry(element,'Aktion für Datenträger 2 · Partition 1 (G:)','storage-format').blocked,de('storage.blocked.diskOffline'),'offline disk');
assert.equal(entry(element,'Aktion für Datenträger 0 · Partition 2 (C:)','storage-format').blocked,'Dieser Datenträger ist geschützt: Windows-Systemdatenträger.');
assert.equal(entry(element,'Aktion für Datenträger 0 · Partition 2 (C:)','storage-resize').blocked,undefined,'a grow-only Windows volume can be extended');
assert.equal(entry(element,'Aktion für Datenträger 1 · Partition 2 (F:)','storage-format').danger,true);
assert.equal(entry(element,'Datenträgereinstellungen für Datenträger 1','state').blocked,undefined);
markup=html();assert.equal(buttons(markup).filter(button=>button.inner.includes('<span>Neues Volume</span>')).map(button=>button.description)[2],de('storage.blocked.diskOffline'));
// A running job blocks the actions with its reason; the query button is loading.
reset({0:{...stored,jobs:[{id:'run',kind:'storage-resize',state:'running',createdAt:now+1,result:null,data:null},...stored.jobs]}});element=tree();
assert.equal(entry(element,'Aktion für Datenträger 1 · Partition 2 (F:)','storage-resize').blocked,de('storage.blocked.jobRunning'));markup=html();assert.match(markup,/role="status"><span class="sdx-pill sdx-pill-waiting">/,'the latest job is a status line with a pill');
assert.match(buttons(markup).find(button=>button.inner.includes('<span>Inventar abfragen</span>')).attributes,/aria-busy="true"/);

// ---- Edit Drawer and confirmations ----
const f=data.partitions[1];
reset({0:stored});element=tree();entry(element,'Aktion für Datenträger 1 · Partition 2 (F:)','storage-resize').onSelect();markup=html();
assert.match(markup,/role="dialog"/);assert.match(markup,/class="sdx-field"/);assert.match(markup,/Volumegröße ändern/);assert.match(markup,/Minimum/);assert.match(markup,/50\sGiB/);
element=tree();harness.find(element,item=>item.type==='input'&&item.props.name==='size').props.onChange({target:{value:'30'}});submit(tree());
assert.deepEqual(confirmations[0].payload,{action:'job',id:'server-a',kind:'storage-resize',params:{...identity(data,f),sizeBytes:30*GiB},confirm:true},'resize payload as before');
assert.equal(confirmations[0].confirmLabel,'Volumegröße ändern');assert.deepEqual(confirmations[0].lines,[{label:'Gerät',value:'WIN-TEST'}]);assert.equal(confirmations[0].tone,undefined);assert.match(confirmations[0].title,/\?$/);
reset({0:stored});element=tree();entry(element,'Aktion für Datenträger 1 · Partition 2 (F:)','storage-resize').onSelect();element=tree();harness.find(element,item=>item.type==='input'&&item.props.name==='size').props.onChange({target:{value:'999'}});submit(tree());assert.equal(confirmations.length,0);markup=html();assert.match(markup,/aria-invalid="true"/,'a size error shows at the field');
reset({0:stored});element=tree();entry(element,'Aktion für Datenträger 1 · Partition 2 (F:)','storage-format').onSelect();submit(tree());assert.equal(confirmations.length,0,'the typed confirmation is required');markup=html();assert.match(markup,new RegExp(`class="sdx-field-error">${de('storage.erase.confirmMismatch')}`));
element=tree();harness.find(element,item=>item.type==='input'&&item.props.name==='erase').props.onChange({target:{value:'1/2'}});submit(tree());
assert.deepEqual(confirmations[0].payload,{action:'job',id:'server-a',kind:'storage-format',params:{...identity(data,f),fileSystem:'NTFS',label:'Data2'},confirm:true},'format payload as before');assert.equal(confirmations[0].tone,'danger');assert.equal(confirmations[0].confirmLabel,'Volume formatieren');
reset({0:stored});element=tree();entry(element,'Aktion für Datenträger 1 · Partition 2 (F:)','storage-delete-partition').onSelect();element=tree();harness.find(element,item=>item.type==='input'&&item.props.name==='erase').props.onChange({target:{value:'1/2'}});submit(tree());
assert.deepEqual(confirmations[0].payload,{action:'job',id:'server-a',kind:'storage-delete-partition',params:identity(data,f),confirm:true},'delete payload as before');assert.equal(confirmations[0].tone,'danger');assert.equal(confirmations[0].confirmLabel,'Partition löschen');
reset({0:stored});element=tree();entry(element,'Datenträgereinstellungen für Datenträger 1','state').onSelect();assert.deepEqual(confirmations[0].payload,{action:'job',id:'server-a',kind:'storage-set-disk',params:{...identity(data),setting:'offline'},confirm:true});assert.equal(confirmations[0].confirmLabel,'Offline setzen');

// ---- Load and action errors ----
reset({0:stored});failLoad=true;tree();await harness.flush();markup=html();
assert.match(markup,/class="sdx-notice sdx-notice-danger" role="alert">.*?Speicher nicht erreichbar/);assert.match(markup,/Partitionen auf Datenträger 1/,'the shown disks stay');
const before=loads;failLoad=false;element=tree();harness.find(element,item=>item.props.onClick&&harness.text(item).trim()==='Erneut versuchen').props.onClick();await harness.settle();assert.equal(loads,before+1,'Try again repeats load');
reset({0:stored});failPost=true;element=tree();harness.button(element,'Inventar abfragen').props.onClick();await harness.settle();assert.deepEqual(harness.toasts,['error:Auftrag abgelehnt'],'a failed queueInspect is a toast');assert.ok(!html().includes('sdx-notice-danger'));
// First load and an empty inventory.
reset();markup=html();assert.match(markup,/sdx-skeleton-table" role="status" aria-label="Datenträgerinventar wird geladen/);
reset({0:{serverId:'server-a',jobs:[],loaded:true}});markup=html();assert.match(markup,/class="sdx-empty">.*?Frage das Inventar ab|class="sdx-empty">/);assert.match(markup,new RegExp(de('storage.queryHint')));
console.log('PASS: storage on the kit: the panel notice, IEC sizes, the disk health dash with one foot line, labelled table regions, disk and partition menus with blocked reasons, the edit Drawer with Fields, load and action errors, and the unchanged resize/format/delete payloads.');
