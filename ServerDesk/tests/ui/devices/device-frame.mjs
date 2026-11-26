// The device page frame (slice 3 of the device view), rendered with React SSR and as pure helpers:
// the header without a destructive primary and its "More actions" menu (deviceHeaderMenu), the
// collapsed tag row (collapsedTagChips), the one state notice for offline, never reported and
// updating devices (DeviceStateNotice), the neutral connection pill (connectionPillKind), the meta line
// without the group path, the inline InheritedOrigin, and the console's drawer and fallbacks. No browser, no server.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {serverDeskRoot} from '../../support/paths.mjs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ChevronLeft,ChevronRight,FolderInput,Hourglass,PencilLine,Pin,PinOff,Power,RefreshCw,RotateCw,Tag,Text,Trash2,WifiOff} from 'lucide-react';
const h=React.createElement;
const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
const {translate}=await import('../../../lib/i18n/translate.ts');
const {demoData}=await import('../../../ui/shell/demo.ts');
const {default:DeviceView,deviceHeaderMenu,deviceSubtitle}=await import('../../../ui/devices/device/device.tsx');
const {DeviceStateNotice,deviceState}=await import('../../../ui/devices/device/device-parts.tsx');
const {collapsedTagChips,collapsedTagCount,wideTagCount}=await import('../../../ui/devices/configuration/device-tags.tsx');
const {InheritedOrigin}=await import('../../../ui/kit/inheritance.tsx');
const {connectionPillKind}=await import('../../../ui/kit/kit.tsx');
const {formatDateTime}=await import('../../../lib/i18n/format.ts');
const en=(await import('../../../lib/i18n/messages/en.ts')).default;
const de=(await import('../../../lib/i18n/messages/de.ts')).default;
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const read=file=>readFileSync(serverDeskRoot+file,'utf8');
const render=(element,locale='en')=>renderToStaticMarkup(h(LocaleProvider,{locale},element));
const noop=()=>{};
const tr=locale=>(key,params)=>translate(locale,key,params);
const count=(text,pattern)=>(text.match(pattern)??[]).length;

const now=Date.now(),{servers}=demoData();
const owner={id:'owner',label:'owner',permissions:['*']};
const sample=servers.find(server=>server.id==='demo-file');
const deviceProps=(patch={})=>({server:{...sample,lastSeen:now},servers,viewer:owner,demo:true,saving:false,now,section:'overview',onSection:noop,samples:[],historyLoading:false,jobs:[],audit:[],crumbs:[],
 onConfirm:noop,onSelectJob:noop,onCancelJob:noop,onAssistantOpen:noop,canOffboard:true,onStep:noop,onMove:noop,...patch});
const header=html=>html.slice(html.indexOf('<header'),html.indexOf('</header>'));

// ---- no destructive or primary button in the header; the title row: stepper, refresh, Ask assistant, Move to group…, More actions ----
{
 const html=render(h(DeviceView,deviceProps())),head=header(html);
 ok(head.length>100,'the header renders');
 ok(!/sdx-btn-primary|sdx-btn-danger/.test(head),'the header has no primary and no danger button');
 const actions=head.slice(head.indexOf('class="sdx-page-actions"'));
 const order=[actions.indexOf('aria-label="Previous device"'),actions.indexOf('aria-label="Next device"'),actions.indexOf('aria-label="Refresh inventory"'),actions.indexOf('<span>Ask assistant</span>'),actions.indexOf('<span>Move to group…</span>'),actions.indexOf('aria-label="More actions"')];
 ok(order.every(index=>index>=0),'stepper, refresh, Ask assistant, Move to group… and "More actions" are all in the actions');
 check([...order].sort((a,b)=>a-b),order,'in this order: stepper, refresh, Ask assistant, Move to group…, More actions');
 // Ask assistant is the one tinted control of the header: the focal action, not a primary.
 ok(/<button type="button" class="sdx-btn sdx-btn-tinted" aria-expanded="false"[^>]*>(?:(?!<\/button>)[\s\S])*lucide-sparkles(?:(?!<\/button>)[\s\S])*<span>Ask assistant<\/span>/.test(actions),'Ask assistant is a tinted Btn with Sparkles, aria-expanded and its label');
 check(count(head,/sdx-btn-tinted/g),1,'exactly one tinted control in the header');
 ok(/class="sdx-btn sdx-btn-secondary"[^>]*>(?:(?!<\/button>)[\s\S])*<span>Move to group…<\/span>/.test(actions),'Move to group… stays secondary');
 ok(header(render(h(DeviceView,deviceProps()),'de')).includes('<span>Assistent fragen</span>'),'the German label "Assistent fragen"');
 ok(/class="sdx-btn sdx-btn-tinted" aria-expanded="true"/.test(header(render(h(DeviceView,deviceProps({assistantOpen:true}))))),'open drawer: aria-expanded="true"');
 // Compact header: 32px high in the line; at 520px or narrower a 32px square whose label is clipped, not removed.
 const css=read('ui/styles/console.css');
 const compact=css.slice(css.indexOf('/* Compact header at 760px or narrower'));
 const compactBlock=compact.slice(0,compact.indexOf('\n}\n'));
 ok(compactBlock.includes(':is(.sdx, .sdx-layer) .sdx-page-head-device .sdx-device-ask { position: relative; height: 32px; padding: 0 12px; }'),'760px: the compact Ask assistant is 32px high');
 const small=css.slice(css.indexOf('@media (max-width: 520px) {'));
 const smallBlock=small.slice(0,small.indexOf('\n}\n'));
 ok(smallBlock.includes('.sdx-page-head-device .sdx-device-ask { width: 32px; padding: 0; gap: 0; }'),'520px: a 32px square');
 const clip=smallBlock.match(/\.sdx-device-ask > span \{([^}]*)\}/)?.[1]??'';
 ok(/clip: rect\(0, 0, 0, 0\)/.test(clip)&&/width: 1px; height: 1px/.test(clip)&&!/display: none|visibility: hidden/.test(clip),'520px: the label is clipped (sr-only technique), so it stays the accessible name');
 ok(/<button type="button"[^>]*class="sdx-icon-btn sdx-btn-ghost"[^>]*aria-label="More actions"[^>]*aria-haspopup="menu"[^>]*>(?:(?!<\/button>)[\s\S])*lucide-ellipsis/.test(actions),'the trigger is an IconBtn with MoreHorizontal and aria-haspopup="menu"');
 ok(/aria-keyshortcuts="K"/.test(actions)&&/aria-keyshortcuts="J"/.test(actions),'the stepper keeps K and J');
 ok(head.includes('class="sdx-page-head sdx-page-head-device"'),'the device variant of PageHeader');
 check([en['device.header.move'],de['device.header.move']],['Move to group…','In Gruppe verschieben…'],'the Move label names its target');
 // The Overview "Hostname" fact names the newest previous name (the demo file server was renamed once).
 check(sample.previousNames,['SRV-FS01'],'one sample device has a previous name');
 ok(html.includes('Previously SRV-FS01'),'the Hostname fact shows "Previously" with the newest previous name');
 ok(!render(h(DeviceView,deviceProps({server:{...sample,lastSeen:now,previousNames:[]}}))).includes('Previously'),'without previous names there is no hint');
 // The rename drawer opens with the stored source; pending counts as the computer name when the names match.
 const {initialNameChoice,nameDraftChanged}=await import('../../../ui/devices/device/device-name.tsx');
 const named=(nameSource,name='SRV-A',hostname='SRV-A')=>({name,nameSource,snapshot:hostname===null?null:{hostname}});
 check([initialNameChoice(named('hostname')),initialNameChoice(named('custom')),initialNameChoice(named(undefined))],['hostname','custom','hostname'],'the stored source is preselected');
 check([initialNameChoice(named('pending','srv-a')),initialNameChoice(named('pending','Other')),initialNameChoice(named('pending','SRV-A',null))],['hostname','custom','custom'],'pending: the computer name when it matches, else a custom name');
 check([nameDraftChanged(named('hostname'),'hostname','SRV-A'),nameDraftChanged(named('hostname'),'custom','SRV-A'),nameDraftChanged(named('custom'),'custom',' SRV-A '),nameDraftChanged(named('custom'),'custom','SRV-B')],[false,true,false,true],'"No changes" until the choice or the trimmed name differs');
 // Pin device: above 760px an IconBtn before the refresh, pressed while pinned; blocked for sample devices; absent without onPin.
 const pinned=header(render(h(DeviceView,deviceProps({demo:false,pinned:true,onPin:noop})))),unpinned=header(render(h(DeviceView,deviceProps({demo:false,pinned:false,onPin:noop}))));
 const pinButton=html=>html.match(/<button[^>]*aria-label="Pin device"[^>]*>/)?.[0]??'';
 ok(/aria-pressed="true"/.test(pinButton(pinned))&&/aria-pressed="false"/.test(pinButton(unpinned)),'the pin IconBtn is pressed while the device is pinned');
 ok(pinned.indexOf('aria-label="Pin device"')<pinned.indexOf('aria-label="Refresh inventory"'),'the pin IconBtn comes before the refresh');
 ok(/aria-disabled="true"/.test(pinButton(header(render(h(DeviceView,deviceProps({pinned:false,onPin:noop})))))),'sample devices: the pin IconBtn is blocked');
 ok(!head.includes('aria-label="Pin device"'),'without onPin there is no pin control');
 // The menu always has Restart… and Shut down…, so it renders also without removal, stepper and Move.
 const plain=header(render(h(DeviceView,deviceProps({canOffboard:false,onStep:undefined,onMove:undefined}))));
 ok(/aria-haspopup="menu"/.test(plain),'the power entries keep the menu trigger');
 const scope=renderToStaticMarkup(h(LocaleProvider,{locale:'en'},h((await import('../../../ui/shell/shell.tsx')).PageHeader,{title:'All devices',subtitle:'12 devices'})));
 ok(scope.startsWith('<header class="sdx-page-head">'),'other PageHeaders keep their class');
}

// ---- the Overview facts: Device type after the OS, the manufacturer mark in Hardware ----
{
 const fact=(markup,label)=>{const start=markup.indexOf(`<dt>${label}</dt><dd>`);return start<0?'':markup.slice(start+label.length+13,markup.indexOf('</dd>',start));};
 const file=render(h(DeviceView,deviceProps()));
 check(fact(file,'Device type'),'Server','the file server (domain role 2): Server');
 ok(file.indexOf('<dt>Operating system</dt>')<file.indexOf('<dt>Device type</dt>')&&file.indexOf('<dt>Device type</dt>')<file.indexOf('<dt>Hardware</dt>'),'Device type right after the OS');
 ok(/^<span class="sdx-manufacturer sdx-manufacturer-md"><svg[^>]*lucide-factory[\s\S]*>HPE<\/span><\/span> · ProLiant DL380 Gen10$/.test(fact(file,'Hardware')),'HPE without a logo: the neutral glyph, the name and the model');
 const sql=render(h(DeviceView,deviceProps({server:{...servers.find(server=>server.id==='demo-db'),lastSeen:now}})));
 ok(/^<span class="sdx-manufacturer sdx-manufacturer-md"><svg class="sdx-manufacturer-logo"[^>]*fill="currentColor"[\s\S]*>Dell<\/span><\/span> · PowerEdge R750$/.test(fact(sql,'Hardware')),'Dell: the logo, the name and the model');
 const dc=render(h(DeviceView,deviceProps({server:{...servers.find(server=>server.id==='demo-dc'),lastSeen:now}})),'de');
 check(fact(dc,'Gerätetyp'),'Domänencontroller','the domain controller, German');
 ok(fact(dc,'Hardware').includes('>Lenovo</span>'),'Lenovo');
 const app=render(h(DeviceView,deviceProps({server:{...servers.find(server=>server.id==='demo-app'),lastSeen:now}})));
 ok(/lucide-factory[\s\S]*>Microsoft<\/span><\/span> · Virtual Machine$/.test(fact(app,'Hardware')),'the Hyper-V machine: the neutral glyph and Microsoft');
 const bare=render(h(DeviceView,deviceProps({server:{...sample,lastSeen:now,snapshot:{...sample.snapshot,manufacturer:'System manufacturer',model:'System Product Name'}}})));
 check(fact(bare,'Hardware'),'System manufacturer · System Product Name','a placeholder keeps the old text');
}

// ---- deviceHeaderMenu ----
{
 const t=tr('en'),calls=[];
 const action=(id,blocked)=>({blocked,onSelect:()=>calls.push(id)});
 const all={step:direction=>calls.push('step'+direction),move:()=>calls.push('move'),rename:action('rename'),description:{...action('description'),filled:false},tags:action('tags'),power:{restart:action('restart'),shutdown:action('shutdown')},removal:action('remove')};
 const wide=deviceHeaderMenu({narrow:false,...all},t);
 check(wide.map(entry=>entry.separator?'—':entry.id),['rename','description','tags','—','restart','shutdown','—','remove'],'wide: rename, description, tags, separator, Restart…, Shut down…, separator, remove');
 check(wide.filter(entry=>!entry.separator).map(entry=>[entry.label,entry.icon,entry.danger]),[['Rename device',PencilLine,undefined],['Add description…',Text,undefined],['Add tags…',Tag,undefined],['Restart…',RotateCw,undefined],['Shut down…',Power,undefined],['Remove device',Trash2,true]],'labels with an ellipsis for the entries that open a further step; Remove is the danger entry');
 const narrow=deviceHeaderMenu({narrow:true,...all},t);
 check(narrow.map(entry=>entry.separator?'—':entry.id),['previous','next','move','rename','description','tags','—','restart','shutdown','—','remove'],'narrow: Previous, Next and Move to group… first');
 check(narrow.slice(0,3).map(entry=>[entry.label,entry.icon,entry.shortcut]),[['Previous device',ChevronLeft,'K'],['Next device',ChevronRight,'J'],['Move to group…',FolderInput,undefined]],'the stepper entries carry their shortcuts');
 for(const entry of narrow)if(!entry.separator)entry.onSelect();
 check(calls,['step-1','step1','move','rename','description','tags','restart','shutdown','remove'],'every entry runs its action');
 check(deviceHeaderMenu({narrow:false,...all,description:{...action('description'),filled:true}},t)[1].label,'Edit description…','"Edit description…" with a description');
 check(deviceHeaderMenu({narrow:false,...all},tr('de')).filter(entry=>!entry.separator).map(entry=>entry.label),['Gerät umbenennen','Beschreibung hinzufügen…','Tags hinzufügen…','Neu starten…','Herunterfahren…','Gerät entfernen'],'German labels');
 // Pin device: only narrow, the first entry; the label follows the state, blocked keeps its reason.
 const pinCalls=[];
 const pin=(pinned,blocked)=>({pinned,blocked,onSelect:()=>pinCalls.push(pinned?'unpin':'pin')});
 check(deviceHeaderMenu({narrow:false,pin:pin(false),...all},t).map(entry=>entry.id).includes('pin'),false,'wide: no pin entry (the header IconBtn)');
 const narrowPin=deviceHeaderMenu({narrow:true,pin:pin(false),...all},t);
 check([narrowPin[0].id,narrowPin[0].label,narrowPin[0].icon],['pin','Pin device',Pin],'narrow: Pin device is the first entry');
 const narrowUnpin=deviceHeaderMenu({narrow:true,pin:pin(true),...all},tr('de'));
 check([narrowUnpin[0].id,narrowUnpin[0].label,narrowUnpin[0].icon],['unpin','Gerät lösen',PinOff],'a pinned device: Unpin device');
 narrowPin[0].onSelect();narrowUnpin[0].onSelect();check(pinCalls,['pin','unpin'],'the entries run the toggle');
 check(deviceHeaderMenu({narrow:true,pin:pin(false,en['kit.unavailable.demo'])},t)[0].blocked,en['kit.unavailable.demo'],'sample devices: blocked with the demo reason');
 // Blocked entries keep their place and their reason.
 const reason=en['device.metadata.noRight'],offline=en['management.blocked.offline'];
 const blocked=deviceHeaderMenu({narrow:false,description:{...action('description',reason),filled:false},tags:action('tags',reason),power:{restart:action('restart',offline),shutdown:action('shutdown',offline)}},t);
 check(blocked.filter(entry=>!entry.separator).map(entry=>[entry.id,entry.blocked]),[['description',reason],['tags',reason],['restart',offline],['shutdown',offline]],'blocked with their reasons');
 // A separator stands only between two groups with entries.
 check(deviceHeaderMenu({narrow:false,rename:action('rename'),removal:action('remove')},t).map(entry=>entry.separator?'—':entry.id),['rename','—','remove'],'without power entries one separator');
 check(deviceHeaderMenu({narrow:false},t),[],'nothing: empty, so no trigger');
 check(deviceHeaderMenu({narrow:true},t),[],'narrow without anything: empty');
 const source=read('ui/devices/device/device.tsx');
 ok(source.includes("blocked:demo?t('kit.unavailable.demo'):saving?t('fleet.menu.saving'):undefined,onSelect:()=>onConfirm(deviceRemovalConfirmation(server,locale,removalContext))"),'DeviceView blocks removal on demo and while saving, and confirms with the same dialog');
 ok(source.includes("entries={deviceHeaderMenu({narrow,pin,step:onStep,move:onMove,moveCustomer,rename,description,tags:tagsEntry,power:powerEntries,removal},t)}"),'the menu entries come from deviceHeaderMenu');
 ok(source.includes("const rename=onRename&&live?{blocked:deviceNameBlocked(server,viewer,demo,t),onSelect:onRename}:undefined;"),'rename: absent for a removed device, blocked with the reason');
 ok(source.includes("const description=live?{filled:!!server.description,blocked:deviceDescriptionBlocked(server,viewer,demo,t),")&&source.includes("const tagsEntry=live?{blocked:deviceTagsBlocked(server,viewer,demo,t),"),'description and tags: absent for a removed device, blocked with the reasons');
 // DeviceView: the entries of a sample device and of a removed device.
 const {deviceNameBlocked}=await import('../../../ui/devices/device/device-name.tsx');
 const {deviceDescriptionBlocked}=await import('../../../ui/devices/device/device-description.tsx');
 const {deviceTagsBlocked}=await import('../../../ui/devices/configuration/device-tags.tsx');
 const reader={id:'reader',label:'reader',permissions:['view']},device={...sample,permissions:['view']};
 check([deviceNameBlocked(sample,owner,true,t),deviceDescriptionBlocked(sample,owner,true,t),deviceTagsBlocked(sample,owner,true,t)],Array(3).fill(en['kit.unavailable.demo']),'sample devices: blocked with the demo reason');
 check([deviceNameBlocked(device,reader,false,t),deviceDescriptionBlocked(device,reader,false,t),deviceTagsBlocked(device,reader,false,t)],Array(3).fill(reason),'without groups.manage: blocked with the right reason');
 check(deviceTagsBlocked({...sample,permissions:['view','groups.manage']},reader,false,t),undefined,'open with groups.manage on the device');
 const revoked=header(render(h(DeviceView,deviceProps({server:{...sample,lastSeen:now,revoked:1},onRename:noop,canOffboard:false,onStep:undefined,onMove:undefined}))));
 ok(/aria-haspopup="menu"/.test(revoked),'a removed device keeps the power entries (blocked)');
 ok(!/primary=\{/.test(source.slice(source.indexOf('<PageHeader'),source.indexOf('<Tabs items={areaTabs}'))),'the device PageHeader has no primary');
}

// ---- collapsedTagChips ----
check([collapsedTagCount,wideTagCount],[2,3],'two chips in the compact header, three in the wide meta line');
check(collapsedTagChips([]),{shown:[],more:0},'no chips');
check(collapsedTagChips(['a','b']),{shown:['a','b'],more:0},'two chips: no "+N"');
check(collapsedTagChips(['a','b','c','d','e']),{shown:['a','b'],more:3},'five chips: two shown, "+3"');
check(collapsedTagChips(['a','b','c','d','e'],wideTagCount),{shown:['a','b','c'],more:2},'wide: three shown, "+2"');
check(collapsedTagChips(['a','b','c'],1),{shown:['a'],more:2},'the count is a parameter');
check([translate('en','device.tags.showMore',{count:1}),translate('en','device.tags.showMore',{count:3}),translate('de','device.tags.showMore',{count:1}),translate('de','device.tags.showMore',{count:3})],['Show 1 more tag','Show 3 more tags','1 weiteren Tag zeigen','3 weitere Tags zeigen'],'device.tags.showMore is a plural in both catalogs');
check([en['device.tags.moreCount'],en['device.tags.showFewer'],de['device.tags.showFewer']],['+{count}','Show fewer tags','Weniger Tags zeigen'],'the visible "+N" and "Show fewer tags"');
{
 const source=read('ui/devices/configuration/device-tags.tsx');
 ok(source.includes("aria-expanded={expanded} aria-controls={listId} aria-label={expanded?undefined:t('device.tags.showMore',{count:more})}"),'"+N" names the hidden count, says whether it is expanded and controls the list');
 ok(!/\bPlus\b/.test(source),'no inline "Add tag" control: adding is in More actions');
 ok(source.includes('useNarrowLayout()'),'the collapsed row follows the shared 760px hook');
 ok(!read('ui/devices/device/device-description.tsx').includes('icon={Pencil}'),'no pencil next to the description');
}

// ---- deviceState and DeviceStateNotice ----
{
 const lastSeen=now-3_600_000,base={snapshot:sample.snapshot,lastSeen,maintenance:null,registration:null};
 for(const locale of ['en','de']){
  const t=tr(locale);
  check(deviceState({...base},now,locale),{tone:'warning',icon:WifiOff,text:t('device.state.offline',{exactTime:formatDateTime(locale,lastSeen)})},locale+': offline with an inventory');
  check(deviceState({...base,snapshot:null},now,locale),{tone:'warning',icon:WifiOff,text:t('device.state.offlineNoInventory')},locale+': offline without an inventory');
  check(deviceState({...base,lastSeen:null,snapshot:null},now,locale),{tone:'info',icon:Hourglass,text:t('device.neverReported')},locale+': never reported');
  check(deviceState({...base,maintenance:{state:'updating'}},now,locale),{tone:'info',icon:RefreshCw,text:t('device.summary.updating')},locale+': agent update');
  check(deviceState({...base,lastSeen:now},now,locale),null,locale+': online has no notice');
 }
 check(en['device.state.offline'],'The device is offline. You see the inventory from {exactTime}. Check that the device is on and that the agent can reach Nodiverna.','the English offline text');
 check(de['device.state.offlineNoInventory'],'Das Gerät ist offline und hat noch kein Inventar gesendet. Prüfe, ob das Gerät eingeschaltet ist und der Agent Nodiverna erreicht.','the German offline text without inventory');
 const offline=render(h(DeviceStateNotice,{server:base,now}));
 ok(/^<div class="sdx-notice sdx-notice-warning" role="status"><svg[^>]*lucide-wifi-off/.test(offline),'offline: a warning Notice with WifiOff');
 ok(/^<div class="sdx-notice sdx-notice-info" role="status"><svg[^>]*lucide-hourglass/.test(render(h(DeviceStateNotice,{server:{...base,lastSeen:null},now}),'de')),'never reported: an info Notice with Hourglass');
 check(render(h(DeviceStateNotice,{server:{...base,lastSeen:now},now})),'','online: nothing');
}

// ---- exactly one notice on every area, none on Configuration ----
{
 const offline={...sample,lastSeen:now-3_600_000};
 const props=patch=>deviceProps({server:offline,demo:false,alerts:h('div',null,'rules'),permissions:h('div',null,'perms'),...patch});
 const body=html=>html.slice(html.indexOf('class="sdx-device-body"'));
 const notices=html=>count(body(html),/sdx-notice-warning" role="status"><svg[^>]*lucide-wifi-off/g);
 for(const section of ['overview','hardware','software','diagnostics','management','remote','automation','history']){
  const html=render(h(DeviceView,props({section})));
  check(notices(html),1,section+': exactly one offline notice');
  ok(/^class="sdx-device-body"[^>]*><div class="sdx-notice sdx-notice-warning"/.test(body(html)),section+': the notice is the first thing in the area body');
  ok(!html.includes('sdx-summary-banner'),section+': no summary banner');
 }
 check(notices(render(h(DeviceView,props({section:'configuration'})))),0,'Configuration › Alert rules: no notice');
 check(notices(render(h(DeviceView,props({section:'configuration',detail:{deviceDetail:'permissions'}})))),0,'Configuration › Permissions: no notice');
 const waiting=render(h(DeviceView,props({server:{...sample,lastSeen:null}})));
 check(count(body(waiting),/sdx-notice-info" role="status"><svg[^>]*lucide-hourglass/g),1,'never reported: one info notice');
 // The uninstall notice stays below the state notice.
 const uninstalling=render(h(DeviceView,props({jobs:[{id:'j1',serverId:offline.id,action:'agent-uninstall',state:'pending',createdAt:now-1000,target:null}]})));
 const at=[body(uninstalling).indexOf('lucide-wifi-off'),body(uninstalling).indexOf('lucide-package-x')];
 ok(at[0]>=0&&at[1]>at[0],'the uninstall notice stays below the state notice');
 ok(!/sdx-summary-banner/.test(read('ui/styles/console.css')),'the .sdx-summary-banner rules are gone');
 ok(!/sdx-summary-banner/.test(read('ui/devices/device/device-summary.tsx')),'DeviceSummary renders no banner');
 ok(!/dhw-offline|hardware\.noLive/.test(read('ui/devices/hardware/device-hardware.tsx')+read('ui/devices/hardware/device-hardware.css')),'the hardware status line drops its offline part');
 for(const key of ['device.offlineNotice','device.summary.stale','device.summary.noInventory','hardware.noLive'])check([key in en,key in de],[false,false],key+' is gone from both catalogs');
}

// ---- one connection pill mapping ----
check(['online','offline','waiting','maintenance'].map(connectionPillKind),['online','offline','neutral','maintenance'],'waiting is neutral; the other kinds keep theirs');
{
 const sources=[['ui/devices/device/device.tsx',1],['ui/devices/fleet/fleet.tsx',2],['ui/settings/troubleshooting.tsx',1]];
 for(const [file,expected] of sources)check(count(read(file),/<StatusPill kind=\{connectionPillKind\(connection\.kind\)\}>/g),expected,file+': connection pills use connectionPillKind');
 ok(!/connection\.kind as StatusKind/.test(sources.map(([file])=>read(file)).join('')),'no call site passes the raw kind');
 const html=render(h(DeviceView,deviceProps({server:{...sample,lastSeen:null}})));
 ok(/<span class="sdx-pill sdx-pill-neutral"><i aria-hidden="true"><\/i>First report pending<\/span>/.test(header(html)),'the header pill of a never-reported device is neutral');
 ok(/\.sdx-pill-waiting, \.sdx-pill-maintenance, \.sdx-pill-accent \{ color: var\(--sd-accent-strong\)/.test(read('ui/styles/console.css')),'job and run pills keep the accent waiting look');
}

// ---- the meta line: the facts without the group path (the breadcrumb shows it) ----
{
 check(deviceSubtitle(['Windows Server 2025',null,'10.10.1.12']),'Windows Server 2025 · 10.10.1.12','the facts, joined');
 const head=header(render(h(DeviceView,deviceProps())));
 const facts=head.match(/<span class="sdx-device-facts">([^<]*)<\/span>/)?.[1];
 ok(facts?.startsWith('Windows 10 Enterprise · Build 19045')&&facts.endsWith(' · 10.10.1.30'),'wide: the facts open the meta line');
 ok(!/No group|Ohne Gruppe/.test(head),'no group path in the header');
 ok(head.includes('<div class="sdx-device-meta sdx-device-meta-line"><span class="sdx-device-facts">'),'the facts lead the one meta line');
 ok(!read('ui/devices/device/device.tsx').includes('deviceGroupPathText'),'the group path helper is gone');
 // The icon-only mode tag names the mode with context for screen readers.
 ok(read('ui/devices/device/device.tsx').includes("<span className=\"sr-only\">{t('device.mode.label',{mode:agentModeLabel(mode,t)})}</span>"),'the compact mode tag reads "Mode: …" with the translated mode (D5)');
 check([translate('en','device.mode.label',{mode:translate('en','agentMode.readOnly')}),translate('de','device.mode.label',{mode:translate('de','agentMode.readOnly')})],['Mode: Read-only','Modus: Nur lesen'],'the mode label in both catalogs');
 ok(!read('ui/shell/console.tsx').includes('groupPath={groupPath(deviceGroupId(active))'),'the console passes no group path to the header');
}

// ---- InheritedOrigin inline ----
{
 const inline=render(h(InheritedOrigin,{label:'Berlin',variant:'inline',onOpen:noop,openLabel:'SLA: Gold, inherited from Berlin. Open the tags of Berlin.'}));
 ok(!/<small/.test(inline),'inline: no visible hint line');
 ok(!/class="sdx-tag"/.test(inline)&&inline.includes('<span class="sdx-inherited-word">Inherited</span>'),'inline: "Inherited" as text, not a nested tag');
 const id=inline.match(/aria-describedby="([^"]+)"/)?.[1];
 ok(id&&inline.includes(`<span id="${id}" class="sr-only">${en['inheritance.lockedHint']}</span>`),'inline: the hint is sr-only and describes the link');
 ok(inline.includes('aria-label="SLA: Gold, inherited from Berlin. Open the tags of Berlin."'),'inline: openLabel is the link name');
 ok(/<span class="sdx-inherited-label">Berlin<\/span>/.test(render(h(InheritedOrigin,{label:'Berlin',variant:'inline'}))),'inline without onOpen: plain text');
 const block=render(h(InheritedOrigin,{label:'Device group: Berlin',onOpen:noop}));
 check(block,'<span class="sdx-inherited-origin"><span class="sdx-tag">Inherited</span><button type="button" class="sdx-inherited-link" aria-label="Open Device group: Berlin">Device group: Berlin</button><small>You can change or remove this only where it is set.</small></span>','block (default) renders as before');
 const css=read('ui/styles/console.css');
 const inlineRules=[...css.matchAll(/([^{}]*sdx-inherited-(?:inline|word)[^{}]*)\{([^{}]*)\}/g)].map(match=>match[2]);
 ok(inlineRules.length>0&&inlineRules.every(rule=>!/#[0-9a-f]{3,8}\b|rgba?\(/i.test(rule)),'inline CSS uses tokens only');
}

// ---- the assistant drawer and the Configuration fallback in the console ----
{
 const source=read('ui/shell/console.tsx');
 ok(source.includes("setAssistantDevice(current=>route.view!=='device'||!route.deviceId?'':route.assistant||current===route.deviceId?route.deviceId:'');"),'applyRoute opens the drawer for an assistant link and keeps it on the same device');
 ok(source.includes("const route:ConsoleRoute=view==='device'?{view,deviceId:selected,deviceSection,...deviceDetail}"),'the hash writer has no drawer state');
 ok(/const routeHash=consoleRouteHash\(route\);\n useEffect\(\(\)=>\{\n  if\(!routeReady\|\|window\.location\.hash===routeHash\)return;/.test(source)&&source.includes('},[routeHash,routeReady]);'),'an area change writes a new hash (pushState)');
 ok(source.includes("run:()=>setAssistantDevice(active.id)")&&source.includes("openServer(device.id,'configuration','permissions');"),'the palette opens the drawer; inventoryAction opens Configuration › Permissions');
 ok(source.includes("  if(!detailFallback)return;\n  replaceHash(detailFallback);\n")&&source.includes("queueMicrotask(()=>{setDeviceSection(section);setDeviceDetail(deviceDetailRoute(section,next.deviceDetail));});\n },[detailFallback]);")&&source.includes("const replaceHash=(hash:string)=>window.history.replaceState("),'a subarea the viewer or device cannot have is replaced by the link it shows (Configuration without the right: Monitoring › Alert rules) without a new history entry');
 const {assistantAvailable}=await import('../../../ui/devices/device/device.tsx');
 const reader={id:'reader',label:'reader',permissions:[]};
 check([assistantAvailable(sample,owner),assistantAvailable({...sample,revoked:1},owner),assistantAvailable({...sample,permissions:[]},reader)],[true,false,false],'the assistant: not on a revoked device, not without the view right');
}

// ---- copy in both catalogs ----
for(const key of ['device.tags.openOriginNamed','device.tags.showMore','device.tags.moreCount','device.tags.showFewer','device.state.offline','device.state.offlineNoInventory','device.remoteArea','device.automationArea','device.softwareArea','device.monitoringArea','device.extensionsArea','device.historyArea','device.assistant.ask','device.header.move','device.menu.addDescription','device.menu.editDescription','device.menu.addTags','device.menu.restart','device.menu.shutdown'])ok(key in en&&key in de,key+' in both catalogs');
check([en['device.remoteArea'],de['device.remoteArea'],en['device.automationArea'],de['device.automationArea']],['Remote access area','Bereich Fernzugriff','Automation area','Bereich Automation'],'the subarea bar names');

console.log(`PASS device frame (${checks} checks): header without a destructive primary, the tinted Ask assistant (wide, open, German, compact 32px and 520px square), "More actions" (wide and narrow entries with Restart… and Shut down…), collapsed tags, one state notice per area, neutral waiting pill, the meta line without the group path, inline inherited origin and the console's drawer and fallbacks.`);
