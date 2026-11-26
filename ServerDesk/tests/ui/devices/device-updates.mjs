// Real update-view safety model plus the actual Windows Update panel on the kit and retained actions.
// The panel runs on hook cells (tests/support/panel-harness.mjs): cell 0 the filters, cell 1 the
// selection, cell 2 the hotfix search; ref 0 the live props.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {panelHarness} from '../../support/panel-harness.mjs';
import {buttons} from '../../support/blocked-buttons.mjs';
import {de} from '../../support/i18n-stubs.mjs';
let downloads=[];
const harness=panelHarness({hooked:['ui/devices/management/device-updates.tsx'],stubs:{'@/ui/base/api':api=>({...api.load('ui/base/api.tsx'),downloadText:(...args)=>downloads.push(args)})}});
const {load,find}=harness;
const {updateInventory,updateView,updateActionReason,updateConfirmation,updateSelected,updateCsv,updateSeverity,updateStatus}=load('ui/devices/management/update-view.ts'),Updates=load('ui/devices/management/device-updates.tsx').default;
const now=1800000000000,viewer={id:'owner',label:'Owner',permissions:['*']},items=Array.from({length:61},(_,index)=>({id:`00000000-0000-4000-8000-${String(index).padStart(12,'0')}`,title:`Update ${String(index).padStart(2,'0')}`,kb:`${5000000+index}`,severity:['Critical','Important','Moderate','Low',''][index%5],rebootRequired:index%3===0}));
const server={id:'device-a',name:'WINDOWS-SRV',lastSeen:now-1000,management:1,revoked:0,snapshot:{mode:'Management',agentCapabilities:['scan-updates','install-updates','install-all-updates'],updates:{checkedAt:new Date(now-30000).toISOString(),pendingCount:125,items},hotfixes:[{id:'KB123456',installedOn:'2026-09-01'},{id:'KB999999',installedOn:'2026-10-01'}]}},context={server,viewer,demo:false,saving:false,now,jobs:[]};
const inventory=updateInventory(server),candidate={serverId:server.id,inventoryKey:inventory.key},filters={query:'',severity:'all',reboot:'all',page:1};
assert.equal(inventory.truncated,true);assert.equal(inventory.pendingCount,125);assert.equal(inventory.items.length,61);
assert.equal(updateInventory({...server,snapshot:null}).pendingCount,null);assert.equal(updateInventory({...server,snapshot:{...server.snapshot,updates:{...server.snapshot.updates,checkedAt:'invalid'}}}).known,false);
assert.equal(updateInventory({...server,snapshot:{...server.snapshot,updates:{...server.snapshot.updates,items:[items[0],{...items[0],id:items[0].id.toUpperCase()},{id:'not-guid'},...items]}}}).items.length,61);
const filtered=updateView(items,filters);assert.equal(filtered.items.length,20);assert.equal(filtered.pageCount,4);assert.equal(filtered.items[0].severity,'Critical');assert.equal(updateView(items,{...filters,page:999}).page,4);assert.equal(updateView(items,{...filters,query:'Update 60'}).filtered.length,1);
assert.ok(updateView(items,{...filters,severity:'urgent',reboot:'yes'}).filtered.every(item=>['Critical','Important'].includes(item.severity)&&item.rebootRequired));assert.equal(updateSeverity(''), 'Nicht angegeben');
const scan=updateConfirmation(context,'scan-updates',candidate);assert.deepEqual(scan.payload,{action:'job',id:server.id,kind:'scan-updates',params:{},confirm:true});assert.equal(scan.confirmLabel,de('management.updates.scan'));assert.deepEqual(scan.lines,[{label:'Gerät',value:'WINDOWS-SRV'}]);
const all=updateConfirmation(context,'install-updates',{...candidate,all:true});assert.deepEqual(all.payload,{action:'job',id:server.id,kind:'install-updates',params:{all:true},confirm:true});assert.match(all.description,/die in der Liste hier fehlen/);assert.match(all.description,/startet nicht von selbst neu/);assert.match(all.description,/Lizenzbedingungen/);
assert.equal(all.confirmLabel,'Alle verfügbaren installieren');assert.ok(!all.description.includes('WINDOWS-SRV'),'the device is a line, not part of the description');assert.match(all.title,/\?$/);
const selection={...candidate,ids:[items[0].id,items[1].id]},install=updateConfirmation(context,'install-updates',selection);assert.deepEqual(install.payload.params,{updateIds:selection.ids});assert.equal(updateSelected(server,selection).length,2);assert.equal(install.confirmLabel,'2 ausgewählte installieren');
assert.equal(updateConfirmation(context,'install-updates',{...candidate,ids:items.slice(0,51).map(item=>item.id)}),null);assert.equal(updateConfirmation(context,'install-updates',{...candidate,ids:['bad-guid']}),null);assert.equal(updateConfirmation(context,'install-updates',{...candidate,ids:[]}),null);
for(const flags of [{demo:true},{saving:true},{viewer:{...viewer,permissions:[]}},{server:{...server,lastSeen:now-180000}},{server:{...server,management:0}},{server:{...server,snapshot:{...server.snapshot,mode:'ReadOnly'}}},{server:{...server,snapshot:{...server.snapshot,mode:undefined}}},{server:{...server,snapshot:{...server.snapshot,agentCapabilities:[]}}},{server:{...server,revoked:1}},{server:{...server,id:'device-b'}},{jobs:[{id:'busy',serverId:server.id,action:'scan-updates',state:'running',createdAt:now}]}])assert.equal(updateConfirmation({...context,...flags},'install-updates',{...candidate,all:true}),null);
const oldAgent={...server,snapshot:{...server.snapshot,agentCapabilities:['scan-updates','install-updates']}};assert.equal(updateConfirmation({...context,server:oldAgent},'install-updates',{...candidate,all:true}),null);assert.ok(updateConfirmation({...context,server:oldAgent},'install-updates',selection));assert.equal(updateActionReason({...context,server:oldAgent},'install-updates',true),de('updates.blocked.updateAgent'));
const readonly={...context,server:{...server,management:0,snapshot:{...server.snapshot,mode:'ReadOnly'}},viewer:{...viewer,permissions:[]},};readonly.server.permissions=['diagnose'];assert.ok(updateConfirmation(readonly,'scan-updates',candidate));assert.equal(updateConfirmation(readonly,'install-updates',selection),null);
assert.ok(updateConfirmation({...context,jobs:[{id:'other',serverId:'foreign',action:'scan-updates',state:'running',createdAt:now}]},'install-updates',selection));
const changed={...server,snapshot:{...server.snapshot,updates:{...server.snapshot.updates,items:items.map((item,index)=>index===0?{...item,title:'New intent'}:item)}}};assert.equal(updateConfirmation({...context,server:changed},'install-updates',selection),null);assert.equal(updateSelected(changed,selection).length,0);
const csv=updateCsv([{...items[0],title:'=CMD()',kb:'"quote"'}]);assert.match(csv,/'=CMD\(\)/);assert.match(csv,/""quote""/);assert.ok(csv.startsWith('﻿'));
// Full-sentence reasons in the helper's order.
for(const [flags,key] of [[{demo:true},'kit.unavailable.demo'],[{server:{...server,revoked:1}},'kit.unavailable.revoked'],[{viewer:{...viewer,permissions:[]}},'management.blocked.manage'],[{server:{...server,lastSeen:now-180000}},'management.blocked.offline'],[{server:{...server,snapshot:{...server.snapshot,agentCapabilities:[]}}},'management.blocked.unsupported'],[{server:{...server,snapshot:{...server.snapshot,mode:'ReadOnly'}}},'management.blocked.readOnly'],[{jobs:[{id:'busy',serverId:server.id,action:'scan-updates',state:'running',createdAt:now}]},'updates.blocked.active']]){const reason=updateActionReason({...context,...flags},'install-updates');assert.equal(reason,de(key));assert.match(reason,/\.$/);}

let confirmations=[];const props={...context,onConfirm:value=>confirmations.push(value)};
function reset(){harness.reset();confirmations=[];downloads=[];}
const tree=(overrides={})=>harness.tree(Updates,{...props,...overrides}),html=(overrides={})=>harness.html(Updates,{...props,...overrides});
const rowCount=markup=>(markup.match(/aria-label="Update \d\d auswählen"/g)||[]).length;
const blocked=(markup,label)=>buttons(markup).find(button=>button.inner.includes(`<span>${label}</span>`)||button.label===label);

// ---- Head, tiles, table ----
reset();let markup=html();
assert.match(markup,/<h2 class="sr-only">Windows Update<\/h2>/);assert.ok(!markup.includes('sdu-eyebrow')&&!markup.includes('Windows Update · '),'no eyebrow');
assert.ok(!fs.readFileSync('lib/i18n/messages/en.ts','utf8').includes("'updates.eyebrow'"),'updates.eyebrow is removed');
assert.equal((markup.match(/Letzte Suche: /g)||[]).length,1,'"Last search: …" shows once, in the head meta');assert.equal(find(tree(),node=>node.props?.label==='Verfügbar'&&'value' in node.props).props.detail,undefined,'the Available tile has no detail');assert.match(markup,/61 von 125/);assert.match(markup,/sucht erneut und installiert alle/);
assert.match(markup,/1–20 von 61/);assert.equal(rowCount(markup),20);assert.match(markup,/61 von 61 Updates/);
assert.match(markup,/role="region" aria-label="Windows-Updates"/);assert.match(markup,/Hotfix-Verlauf/);assert.ok(!markup.includes('Letzte 20'),'history identifies captured records rather than inventing a complete history');
assert.equal((markup.match(/aria-pressed="(true|false)"/g)||[]).length,2,'two filter tiles');
assert.ok(!/>CSV</.test(markup),'no text button CSV');
// "Install all available" is a secondary action (the panel has no primary); old agents see it blocked with the reason.
let element=tree();const allButton=harness.button(element,'Alle verfügbaren installieren');assert.equal(allButton.props.variant,undefined,'a secondary Btn');assert.ok(!html().includes('sdx-btn-primary'),'no primary in the panel');allButton.props.onClick();assert.equal(confirmations.length,1);assert.deepEqual(confirmations[0].payload,all.payload);
for(const overrides of [{viewer:{...viewer,permissions:[]}},{server:oldAgent},{server:{...server,snapshot:{...server.snapshot,mode:'ReadOnly'}}},{server:{...server,id:'another'}},{server:changed},{jobs:[{id:'pending',serverId:server.id,action:'install-updates',state:'pending',createdAt:now}]},{now:now+120000}]){tree(overrides);allButton.props.onClick();assert.equal(confirmations.length,1,'retained installation callbacks obey current device/rights/capabilities/inventory/jobs/online state');}
reset();markup=html({server:oldAgent});assert.equal(blocked(markup,'Alle verfügbaren installieren').description,de('updates.blocked.updateAgent'),'blocked with allReason');
// Tiles toggle the filters.
reset();element=tree();find(element,item=>item.props.label==='Kritisch & wichtig'&&item.props.onSelect).props.onSelect();markup=html();assert.equal(harness.h.states.get(0).filters.severity,'urgent');assert.match(markup,/aria-pressed="true"><span class="sdx-kpi-head">.*?Kritisch &amp; wichtig/);
element=tree();find(element,item=>item.props.label==='Kritisch & wichtig'&&item.props.onSelect).props.onSelect();assert.equal(harness.h.states.get(0).filters.severity,'all','a second press turns it off');
element=tree();find(element,item=>item.props.label==='Neustart gemeldet'&&item.props.onSelect).props.onSelect();assert.equal(harness.h.states.get(0).filters.reboot,'yes');
// Selection: the kit DataTable selection and BulkBar, the limit, install.
reset();element=tree();assert.ok(!html().includes('sdx-bulkbar')&&!html().includes('sdx-updates-selection'),'no selection bar without a selection and no hand selection row');
let table=harness.table(element,'Windows-Updates');assert.equal(table.props.selection.allLabel,'Alle angezeigten Updates auswählen');assert.equal(table.props.selection.blocked(items[0]),undefined,'below the limit nothing is blocked');
table.props.selection.onChange(items.map(item=>item.id));element=tree();assert.match(html(),/<strong aria-live="polite">50 ausgewählt<\/strong>/);
table=harness.table(element,'Windows-Updates');assert.equal(table.props.selection.blocked(items[60]),'Du kannst bis zu 50 Updates auf einmal auswählen.','at the limit unselected rows are blocked with the reason');
harness.button(element,'50 ausgewählte installieren').props.onClick();assert.equal(confirmations[0].payload.params.updateIds.length,50);assert.ok(!confirmations[0].payload.params.all);assert.equal(confirmations[0].confirmLabel,'50 ausgewählte installieren');
// Selecting works on a blocked device; installing stays refused.
reset();element=tree({demo:true});harness.table(element,'Windows-Updates').props.selection.onChange([items[0].id]);markup=html({demo:true});assert.match(markup,/1 ausgewählt/);
assert.equal(blocked(markup,'1 ausgewählte installieren').description,de('kit.unavailable.demo'));element=tree({demo:true});harness.button(element,'1 ausgewählte installieren').props.onClick();assert.equal(confirmations.length,0,'installing stays refused');
// CSV: the filtered rows, a toast; blocked without rows.
reset();element=tree();find(element,item=>item.props.search).props.search.onChange('Update 60');markup=html();assert.equal(rowCount(markup),1);
element=tree();harness.labelled(element,'Als CSV exportieren').props.onClick();assert.equal(downloads.length,1);assert.match(downloads[0][1],/Update 60/);assert.ok(!downloads[0][1].includes('Update 00'));assert.deepEqual(harness.toasts,['1 Update als CSV exportiert.']);
element=tree();find(element,item=>item.props.search).props.search.onChange('nothing');markup=html();assert.equal(blocked(markup,'Als CSV exportieren').description,de('updates.csv.nothing'));
element=tree();harness.labelled(element,'Als CSV exportieren').props.onClick();assert.equal(downloads.length,1,'nothing is downloaded without rows');
reset();element=tree();harness.labelled(element,'Als CSV exportieren').props.onClick();assert.equal(harness.toasts[0],'61 Updates als CSV exportiert.','plural text');
element=tree();const retainedCsv=harness.labelled(element,'Als CSV exportieren');tree({server:{...server,revoked:1}});retainedCsv.props.onClick();assert.equal(downloads.length,1,'a revoked device exports nothing');
// Hotfixes: newest first, search.
reset();markup=html();assert.ok(markup.indexOf('KB999999')<markup.indexOf('KB123456'),'newest first');assert.match(markup,/2 von 2 Hotfixes/);
element=tree();find(element,item=>item.props.search?.label==='Installierte Hotfixes suchen').props.search.onChange('KB123456');markup=html();assert.match(markup,/KB123456/);assert.ok(!markup.includes('KB999999'));
// Loading, scan and job states.
reset();markup=html({server:{...server,snapshot:null}});assert.match(markup,/sdx-skeleton-table" role="status" aria-label="Windows-Updates werden geladen/);assert.ok(!markup.includes('Keine verfügbaren Updates gemeldet'));
reset();const pending={id:'scan',serverId:server.id,action:'scan-updates',state:'running',createdAt:now,claimedAt:now-1000,lastProgress:now-500,result:null};markup=html({server:{...server,snapshot:{...server.snapshot,updates:undefined}},jobs:[pending]});assert.match(markup,/Windows-Updates werden geladen/);assert.match(markup,/class="sdx-notice sdx-notice-info" role="status">.*?Updatesuche läuft/);
reset();markup=html({jobs:[pending]});assert.match(markup,/aria-busy="true"/);assert.match(markup,/Update 00/);assert.ok(!markup.includes('Windows-Updates werden geladen'),'existing inventory remains visible during scan');
assert.match(blocked(markup,de('management.updates.scan')).attributes,/aria-busy="true"/,'search is loading while a scan runs');
// A succeeded search after the last report: one status sentence in the head, no notice.
reset();markup=html({jobs:[{...pending,state:'succeeded',result:'Updatesuche abgeschlossen'}]});assert.match(markup,/Die Liste erscheint, sobald sich der Agent das nächste Mal meldet\./);assert.ok(!markup.includes('sdx-updates-output')&&!markup.includes('sdx-notice-info'),'a succeeded job adds no notice');
// A failed job keeps the warning notice with the output disclosure; coded results are translated.
reset();markup=html({jobs:[{...pending,state:'failed',result:'Update search completed: 3 available updates.',resultCode:'AGENT_UPDATE_SCAN_DONE',resultArgs:{count:'3'}}]});assert.match(markup,/sdx-notice-warning/);assert.match(markup,/Updatesuche abgeschlossen: 3 Updates verfügbar./);assert.ok(!markup.includes('Update search completed'),'the English fallback is replaced');
reset();markup=html({jobs:[{...pending,state:'cancelled',result:'Updatesuche abgeschlossen: 2 verfügbare Updates.'}]});assert.match(markup,/Updatesuche abgeschlossen: 2 verfügbare Updates./,'a legacy result keeps its stored text');
reset();markup=html({server:{...server,snapshot:{...server.snapshot,updates:{checkedAt:new Date(now).toISOString(),pendingCount:0,items:[]}}}});assert.match(markup,/Keine verfügbaren Updates gemeldet/);assert.ok(!markup.includes('Updatesuche ausstehend'));
reset();markup=html({jobs:[{...pending,state:'failed',result:'<script>oops</script>',outputRedacted:true}]});assert.match(markup,/sdx-notice-warning/);assert.match(markup,/erlauben nicht, das ganze Ergebnis zu sehen/);assert.ok(!markup.includes('oops'));
// The panel notice.
reset();markup=html({demo:true});assert.match(markup,new RegExp(`${de('kit.unavailable.demo')} ${de('updates.readOnly')}`));assert.equal((markup.match(/class="sdx-notice sdx-notice-info"/g)||[]).length,1,"one panel notice about blocked actions");
reset();markup=html({server:{...server,lastSeen:now-600000}});assert.ok(!markup.includes('class="sdx-notice sdx-notice-info"'),'offline: the shared DeviceStateNotice, no own text');
// One status sentence from updateStatus, in its order.
{
 const at=Date.parse(server.snapshot.updates.checkedAt),job=(action,state,createdAt=now)=>({id:action+state,serverId:server.id,action,state,createdAt,claimedAt:createdAt,lastProgress:createdAt+1000,result:null});
 const empty={...server,snapshot:{...server.snapshot,updates:undefined}};
 assert.equal(updateStatus({...context,jobs:[job('scan-updates','running'),job('install-updates','pending')]}),'Suche nach Updates läuft…','1. a running or queued search');
 assert.equal(updateStatus({...context,jobs:[job('install-updates','running')]}),'Updates werden installiert…','2. a running or queued install');
 assert.match(updateStatus(context),/^Letzte Suche: /,'3. the inventory has checkedAt');
 assert.match(updateStatus({...context,jobs:[job('scan-updates','succeeded',at+5000)]}),/^Suche beendet .+\. Die Liste erscheint, sobald sich der Agent das nächste Mal meldet\.$/,'4. a search that finished after checkedAt');
 assert.match(updateStatus({...context,server:empty,jobs:[job('scan-updates','succeeded')]}),/^Suche beendet /,'4. or without checkedAt');
 assert.equal(updateStatus({...context,server:empty}),'Noch keine abgeschlossene Suche','5. otherwise no search yet');
 assert.match(updateStatus({...context,jobs:[job('scan-updates','failed',at+5000)]}),/^Letzte Suche: /,'a failed search keeps the last search time');
 // "Install all available" needs a search that listed updates.
 const none={...server,snapshot:{...server.snapshot,updates:{checkedAt:new Date(now).toISOString(),pendingCount:0,items:[]}}};
 assert.equal(updateActionReason({...context,server:none},'install-updates',true),'Suche zuerst nach Updates.','an empty inventory: search first');
 assert.equal(updateActionReason({...context,server:empty},'install-updates',true),'Suche zuerst nach Updates.','no search yet: search first');
 assert.equal(updateActionReason(context,'install-updates',true),'','a listed inventory: free');
 assert.equal(updateActionReason({...context,server:{...empty,snapshot:{...empty.snapshot,agentCapabilities:['scan-updates','install-updates']}}},'install-updates',true),de('updates.blocked.updateAgent'),'the older reasons come first');
 // Before a search: no KPI tile, the empty state offers the search.
 reset();markup=html({server:empty});assert.ok(!markup.includes('sdx-kpi-row'),'no KPI row before a search');assert.ok(!/sdx-kpi-value">—/.test(markup),'no tile shows a dash');
 assert.match(markup,/<strong>Updatesuche ausstehend<\/strong>/);const emptyAction=harness.table(tree({server:empty}),'Windows-Updates').props.empty.action;assert.equal(emptyAction.props.children,de('management.updates.scan'),'the empty state carries "Search for updates"');
 emptyAction.props.onClick();assert.equal(confirmations.at(-1).payload.kind,'scan-updates','it asks for the same search');
 reset();markup=html({server:empty});assert.equal(blocked(markup,'Alle verfügbaren installieren').description,'Suche zuerst nach Updates.','Install all available is blocked until updates are listed');
 assert.ok(!/class="[^"]*sdx-updates-selection/.test(fs.readFileSync('ui/devices/management/device-updates.tsx','utf8'))&&!/variant="primary"/.test(fs.readFileSync('ui/devices/management/device-updates.tsx','utf8')),'no hand selection row and no primary in device-updates.tsx');
}
console.log('PASS: Windows Update on the kit: hidden title, KPI filter tiles, job notices, DataTable with selection row, CSV IconBtn with toast, hotfix DataTable newest first, exact confirmations with confirmLabel and device line, old-agent compatibility, ReadOnly scan and retained-callback guards.');
