// Exercise the actual services component on the kit and its display/action safety model.
// The panel runs on hook cells (tests/support/panel-harness.mjs); cell 0 holds the filters,
// cell 1 the open service, cell 2 the startup draft, ref 0 the live props.
import assert from 'node:assert/strict';
import {panelHarness} from '../../support/panel-harness.mjs';
import {buttons} from '../../support/blocked-buttons.mjs';
import {de} from '../../support/i18n-stubs.mjs';
const harness=panelHarness({hooked:['ui/devices/management/device-services.tsx']});
const {load,find}=harness;
const {serviceView,serviceStartup,serviceStartupLabel,currentService,serviceConfirmation,serviceActionReason,serviceManagementReason}=load('ui/devices/management/service-view.ts');
const Services=load('ui/devices/management/device-services.tsx').default;
const now=1800000000000,viewer={id:'owner',label:'Owner',permissions:['*']};
const entries=Array.from({length:199},(_,index)=>({name:'svc'+String(index).padStart(3,'0'),displayName:'Dienst '+index,status:index%3===0?'Running':'Stopped',startMode:['Auto','Manual','Disabled','Unknown'][index%4]}));
const server={id:'device',name:'WINDOWS-SRV',lastSeen:now-1000,management:1,revoked:0,snapshot:{mode:'Management',services:entries,agentCapabilities:['start-service','stop-service','restart-service','set-service-startup']}};
const context={server,viewer,demo:false,saving:false,now};
const defaults={query:'',focus:'all',status:'all',startup:'all',sort:'name',direction:'asc',page:1};
const first=serviceView(entries,defaults);
assert.equal(first.items.length,25);assert.equal(first.pageCount,8);assert.equal(first.counts.all,199);assert.equal(first.counts.running,67);
assert.equal(first.counts.autoStopped,entries.filter(entry=>entry.startMode==='Auto'&&entry.status==='Stopped').length);
assert.equal(serviceView(entries,{...defaults,page:99}).items.length,24);assert.equal(serviceView(entries,{...defaults,page:99}).page,8);
assert.ok(serviceView(entries,{...defaults,focus:'auto-stopped'}).items.every(entry=>entry.status==='Stopped'&&entry.startMode==='Auto'));
assert.ok(serviceView(entries,{...defaults,status:'Stopped',startup:'Disabled'}).items.every(entry=>entry.status==='Stopped'&&entry.startMode==='Disabled'));
assert.deepEqual(serviceView(entries,{...defaults,query:'  SVC012  '}).items.map(entry=>entry.name),['svc012']);
assert.equal(serviceView(entries,{...defaults,direction:'desc'}).items[0].name,'svc198');
assert.equal(entries[0].name,'svc000','filtering/sorting leaves the inventory untouched');
assert.equal(serviceStartup('Unknown'),null);assert.equal(serviceStartup('Boot'),null);assert.equal(serviceStartupLabel('Unknown'),'Unbekannt');assert.equal(serviceStartupLabel('System'),'Systemstart');assert.equal(serviceStartup('Auto'),'Automatic');

const selected={serverId:server.id,name:'svc000'};
assert.equal(currentService(server,selected),entries[0]);assert.equal(currentService({...server,id:'another-device'},selected),null);
assert.equal(serviceConfirmation(context,selected,'start-service'),null,'running services cannot be started');
const stop=serviceConfirmation(context,selected,'stop-service');assert.deepEqual(stop.payload,{action:'job',id:server.id,kind:'stop-service',params:{name:'svc000'},confirm:true});
assert.match(stop.description,/Aktuell: Running/);assert.match(stop.description,/Apps, die von diesem Dienst abhängen/);
// The device is a line, not part of the description; the confirm button repeats the trigger.
assert.deepEqual(stop.lines,[{label:'Gerät',value:'WINDOWS-SRV'}]);assert.ok(!stop.description.includes('WINDOWS-SRV'));assert.equal(stop.confirmLabel,'Stoppen');assert.match(stop.title,/\?$/);
const startup=serviceConfirmation(context,selected,'set-service-startup','Manual','Auto');assert.deepEqual(startup.payload,{action:'job',id:server.id,kind:'set-service-startup',params:{name:'svc000',startup:'Manual'},confirm:true});assert.equal(startup.confirmLabel,'Starttyp ändern');
assert.equal(serviceConfirmation(context,selected,'set-service-startup','Automatic','Auto'),null,'unchanged aliases do not submit');
assert.equal(serviceConfirmation(context,selected,'set-service-startup','Manual','Unknown'),null,'stale startup intent cannot overwrite a refreshed mode');
assert.equal(serviceConfirmation(context,selected,'set-service-startup','unexpected','Auto'),null);
for(const flags of [{demo:true},{saving:true},{viewer:{...viewer,permissions:[]}},{server:{...server,lastSeen:now-180000}},{server:{...server,management:0}},{server:{...server,snapshot:{...server.snapshot,mode:'ReadOnly'}}},{server:{...server,snapshot:{...server.snapshot,mode:undefined}}},{server:{...server,snapshot:{...server.snapshot,agentCapabilities:[]}}},{server:{...server,revoked:1}}])assert.equal(serviceConfirmation({...context,...flags},selected,'stop-service'),null);
assert.ok(serviceConfirmation({...context,viewer:{...viewer,permissions:[]},server:{...server,permissions:['manage']}},selected,'stop-service'));
assert.equal(serviceConfirmation({...context,server:{...server,snapshot:{...server.snapshot,services:[{...entries[0],status:'Stopped'}]}}},selected,'stop-service'),null,'actions revalidate the current service state');
assert.equal(serviceActionReason(context,{serverId:server.id,name:'svc002'},'start-service'),de('services.blocked.disabled'));
assert.equal(serviceConfirmation(context,{serverId:server.id,name:'svc003'},'start-service'),null,'running/transition statuses remain protected');
// Every reason is a full sentence, in the fixed order of the helper.
const reasons=[[{demo:true},'kit.unavailable.demo'],[{saving:true},'services.blocked.saving'],[{server:{...server,revoked:1}},'kit.unavailable.revoked'],[{viewer:{...viewer,permissions:[]}},'management.blocked.manage'],[{server:{...server,snapshot:{...server.snapshot,mode:'ReadOnly'}}},'management.blocked.readOnly'],[{server:{...server,snapshot:{...server.snapshot,mode:undefined}}},'services.blocked.modeUnconfirmed'],[{server:{...server,lastSeen:now-180000}},'management.blocked.offline']];
for(const [flags,key] of reasons){const reason=serviceManagementReason({...context,...flags});assert.equal(reason,de(key));assert.match(reason,/\.$/,'a reason ends with a period');}
assert.equal(serviceActionReason({...context,server:{...server,snapshot:{...server.snapshot,agentCapabilities:[]}}},selected,'stop-service'),de('management.blocked.unsupported'));
assert.equal(serviceManagementReason({...context,demo:true,saving:true,server:{...server,revoked:1}}),de('kit.unavailable.demo'),'demo comes first');

let confirmations=[];
const props={...context,onConfirm:value=>confirmations.push(value)};
function reset(){harness.reset();confirmations=[];}
const tree=(overrides={})=>harness.tree(Services,{...props,...overrides});
const html=(overrides={})=>harness.html(Services,{...props,...overrides});

// ---- Head, focus Segmented, table ----
reset();let markup=html();
// UI-Rework 13b: the two toolbar filters are the kit Select sm; the search keeps room for its placeholder (kit Toolbar rule).
assert.equal((markup.match(/<select class="sdx-select sdx-select-sm" aria-label="(Dienststatus filtern|Starttyp filtern)"/g)||[]).length,2,"the status and startup filters are Select size sm");
assert.match(markup,/<label class="sdx-searchfield sdx-toolbar-search">/,"the search is the kit toolbar search");
assert.match(markup,/<h2 class="sr-only">Dienste<\/h2>/,'the subarea name is only the accessible heading');
assert.equal((markup.match(/>Dienste</g)||[]).length,1,'no visible duplicate title');
assert.match(markup,/199 erfasst · /,'meta: count and freshness');
assert.match(markup,/Automatisch · gestoppt/);
assert.ok(!markup.includes('sdx-kpi'),'no KPI row: the focus filters sit in the table toolbar');
const focus=markup.match(/<div class="sdx-segmented sdx-segmented-sm" role="group" aria-label="Dienstgruppen">([\s\S]*?)<\/div>/)?.[1]??'';
assert.deepEqual([...focus.matchAll(/<button type="button" aria-pressed="(true|false)"[^>]*><span>([^<]+)<\/span><b(?: class="([^"]+)")?>(\d+)<\/b><\/button>/g)].map(match=>[match[2],match[4],match[3]??null,match[1]]),
 [['Alle','199',null,'true'],['Laufend','67',null,'false'],['Automatisch · gestoppt','33','sdx-count-warning','false'],['Deaktiviert','50',null,'false']],'four focus filters with counts; All pressed; only Automatic · stopped warns');
assert.ok(markup.indexOf('aria-label="Dienstgruppen"')<markup.indexOf('aria-label="Dienststatus filtern"')||markup.indexOf('aria-label="Dienstgruppen"')<markup.indexOf('<select'),'the Segmented sits before the two selects');
assert.ok(markup.indexOf('sdx-toolbar')<markup.indexOf('aria-label="Dienstgruppen"'),'inside the table toolbar');
{const quiet={...server,snapshot:{...server.snapshot,services:entries.filter(entry=>!(entry.startMode==='Auto'&&entry.status==='Stopped'))}};
 const none=html({server:quiet}).match(/aria-label="Dienstgruppen">([\s\S]*?)<\/div>/)[1];
 assert.match(none,/<span>Automatisch · gestoppt<\/span><b>0<\/b>/,'no warning tone while the count is 0');}
assert.match(markup,/role="region" aria-label="Dienste"/);assert.match(markup,/aria-sort="ascending"/);
assert.ok(!markup.includes('>Details<')&&!markup.includes('sd-service-sort'),'no Details column and no own sort buttons');
assert.match(markup,/1–25 von 199/);assert.match(markup,/199 von 199 Diensten/);
assert.equal((markup.match(/aria-label="Dienst Dienst \d+ öffnen"/g)||[]).length,25,'only one page is rendered');
const focusFilter=element=>find(element,item=>item.props.label==='Dienstgruppen'&&Array.isArray(item.props.items));
let element=tree();find(element,item=>(item.type==='select'||item.type?.render?.name==='Select')&&item.props['aria-label']==='Dienststatus filtern').props.onChange({target:{value:'Stopped'}});
element=tree();find(element,item=>(item.type==='select'||item.type?.render?.name==='Select')&&item.props['aria-label']==='Starttyp filtern').props.onChange({target:{value:'Manual'}});
element=tree();focusFilter(element).props.onChange('running');
markup=html();assert.match(markup,/67 von 199 Diensten/,'a focus filters');
assert.deepEqual([harness.h.states.get(0).filters.focus,harness.h.states.get(0).filters.status,harness.h.states.get(0).filters.startup],['running','all','all'],'choosing a focus resets status and startup, as the tiles did');
element=tree();assert.equal(focusFilter(element).props.value,'running','the chosen focus is pressed');
harness.button(element,'Filter zurücksetzen').props.onClick();assert.equal(harness.h.states.get(0).filters.focus,'all','"Reset filter" resets the focus too');
// Paging, then search resets to page 1.
reset();element=tree();harness.table(element,'Dienste').props.pagination.onPage(2);markup=html();assert.match(markup,/26–50 von 199/);
element=tree();find(element,item=>item.props.search).props.search.onChange('svc012');markup=html();assert.ok(!markup.includes('sdx-pagination'));assert.equal(harness.h.states.get(0).filters.page,1);
assert.equal((markup.match(/aria-label="Dienst Dienst \d+ öffnen"/g)||[]).length,1);
// Sort through onSort goes back to page 1 as well.
reset();element=tree();harness.table(element,'Dienste').props.pagination.onPage(3);element=tree();harness.table(element,'Dienste').props.onSort({column:'status',direction:'asc'});
assert.deepEqual([harness.h.states.get(0).filters.sort,harness.h.states.get(0).filters.page],['status',1]);assert.match(html(),/aria-sort="ascending"[^>]*><button[^>]*>Status/);
// No match: a cause-specific Empty with Reset filters.
reset();element=tree();find(element,item=>item.props.search).props.search.onChange('nothing-matches');markup=html();assert.match(markup,/Keine passenden Dienste/);
element=tree();harness.button(element,'Filter zurücksetzen').props.onClick();assert.equal(harness.h.states.get(0).filters.query,'');

// ---- Drawer ----
reset();element=tree();harness.table(element,'Dienste').props.onOpen(entries[12]);markup=html();
assert.match(markup,/role="dialog"/);assert.match(markup,/class="sdx-facts"/);assert.match(markup,/svc012/);
const drawerButtons=buttons(markup);
assert.equal(drawerButtons.find(button=>button.inner.includes('<span>Starten</span>')).description,de('services.blocked.running'),'Start is blocked with its reason');
assert.ok(!drawerButtons.find(button=>button.inner.includes('<span>Neu starten</span>')).blocked,'Restart is available');
assert.equal(drawerButtons.find(button=>button.inner.includes('<span>Starttyp ändern</span>')).description,de('services.blocked.sameStartup'));
assert.ok(!drawerButtons.find(button=>button.inner.includes('<span>Stoppen</span>')).blocked,'Stop is available');
element=tree();const stopButton=harness.button(element,'Stoppen');stopButton.props.onClick();assert.equal(confirmations[0].payload.params.name,'svc012');assert.equal(confirmations[0].confirmLabel,'Stoppen');
for(const overrides of [{viewer:{...viewer,permissions:[]}},{server:{...server,snapshot:{...server.snapshot,mode:'ReadOnly'}}},{server:{...server,snapshot:{...server.snapshot,agentCapabilities:['start-service']}}},{now:now+120000}]){
  tree(overrides);stopButton.props.onClick();assert.equal(confirmations.length,1,'retained callbacks obey current rights/mode/capability/inventory freshness');
}
const changed={...server,snapshot:{...server.snapshot,services:entries.map(entry=>entry.name==='svc012'?{...entry,status:'Stopped',displayName:'Aktualisierter Dienst'}:entry)}};
tree({server:changed});stopButton.props.onClick();assert.equal(confirmations.length,1,'a previously rendered button revalidates fresh props before confirming');assert.match(html({server:changed}),/Aktualisierter Dienst/);
tree({server:{...changed,id:'different-device'}});stopButton.props.onClick();assert.equal(confirmations.length,1,'a retained old callback cannot act on another device');
reset();element=tree();harness.table(element,'Dienste').props.onOpen(entries[0]);element=tree();
const startupSelect=find(element,item=>(item.type==='select'||item.type?.render?.name==='Select')&&item.props.value==='Automatic');assert.ok(startupSelect);startupSelect.props.onChange({target:{value:'Manual'}});assert.equal(confirmations.length,0,'selecting a startup option alone performs no action');
markup=html();assert.ok(!buttons(markup).find(button=>button.inner.includes('<span>Starttyp ändern</span>')).blocked,'a different type unblocks the change');
element=tree();harness.button(element,'Starttyp ändern').props.onClick();assert.deepEqual(confirmations[0].payload,startup.payload);assert.equal(confirmations[0].confirmLabel,'Starttyp ändern');
reset();element=tree();harness.table(element,'Dienste').props.onOpen(entries[3]);element=tree();assert.ok(find(element,item=>(item.type==='select'||item.type?.render?.name==='Select')&&item.props.value==='unknown'),'unknown startup never defaults to Manual');
const missing={...server,snapshot:{...server.snapshot,services:entries.filter(entry=>entry.name!=='svc003')}};markup=html({server:missing});assert.match(markup,/nicht mehr auf dem Gerät/);

// ---- Panel notice and reasons ----
const readOnly={...server,snapshot:{...server.snapshot,mode:'ReadOnly'}};
reset();markup=html({server:readOnly});
assert.match(markup,new RegExp(`class="sdx-notice sdx-notice-info" role="status">.*?<div>${de('kit.unavailable.mode')} ${de('services.readOnly')}</div>`),'ReadOnly online: the mode sentence and services.readOnly');
assert.equal((markup.match(/class="sdx-notice /g)||[]).length,1,'one panel notice');
const offline={...server,lastSeen:now-600000};
reset();markup=html({server:offline});assert.ok(!markup.includes('sdx-notice'),'offline Management: no panel notice (DeviceStateNotice covers it)');
element=tree({server:offline});harness.table(element,'Dienste').props.onOpen(entries[1]);markup=html({server:offline});
assert.equal(buttons(markup).find(button=>button.inner.includes('<span>Starten</span>')).description,'Dafür muss das Gerät online sein.');
reset();markup=html({demo:true});assert.match(markup,new RegExp(`${de('kit.unavailable.demo')} ${de('services.readOnly')}`));
assert.ok(!/\{reason\}/.test(markup)&&!markup.includes(de('kit.unavailable.demo')+'.'),'nothing is glued');

// ---- Loading and no inventory ----
reset();markup=html({server:{...server,snapshot:null}});assert.match(markup,/sdx-skeleton-table" role="status" aria-label="Dienste werden geladen/);assert.ok(!markup.includes('0 erfasst'),'missing inventory is not reported as zero services');
element=tree({server:{...server,snapshot:null}});assert.ok(!focusFilter(element),'without an inventory the focus Segmented is not shown');
assert.ok(!markup.includes('sdx-kpi')&&!markup.includes('aria-label="Dienstgruppen"'),'no tiles and no Segmented while loading');
console.log('PASS: services on the kit: hidden title, no KPI row, the focus Segmented with counts in the toolbar, DataTable sort/paging/foot/empty, Drawer with Facts and blocked reasons, one panel notice, exact confirmation payloads with confirmLabel and device line, fresh action revalidation and permission/mode/offline/capability/saving guards.');
