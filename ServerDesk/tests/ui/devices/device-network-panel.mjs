// Exercise the real network UI on the kit, the existing job schemas and the bounded native diagnosis client.
// The panel runs on hook cells (tests/support/panel-harness.mjs); its effects run through flush().
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {panelHarness} from '../../support/panel-harness.mjs';
import {buttons} from '../../support/blocked-buttons.mjs';
import {de} from '../../support/i18n-stubs.mjs';
let confirmations=[],copies=[],downloads=[],requests=[],responseJobs=[],postWait=null,readWait=null,readFails=0,copyFails=false;
class ApiError extends Error{constructor(message,status){super(message);this.status=status;}}
const shared={ApiError,api:async(url,body,signal)=>{requests.push({url,body,signal});if(body){if(postWait)await postWait;signal.throwIfAborted();return {id:'new-network-job'};}if(readWait)await readWait;signal.throwIfAborted();if(readFails>0){readFails--;throw new Error('Lesefehler');}return {jobs:responseJobs};},permitted:(server,viewer,right)=>viewer.permissions?.includes('*')===true||server.permissions?.includes(right)===true,stamp:value=>value?new Date(value).toISOString():'—',message:error=>error instanceof Error?error.message:String(error),downloadText:(name,text,type)=>downloads.push({name,text,type})};
const harness=panelHarness({hooked:['ui/devices/management/device-network-panel.tsx'],stubs:{'@/ui/base/api':shared}});
const english=panelHarness({hooked:['ui/devices/management/device-network-panel.tsx'],stubs:{'@/ui/base/api':shared},locale:'en'});
const {load,find}=harness;
const {networkAdapters,networkFingerprint,currentNetworkAdapter,networkActionReason,networkConfirmation,ipv4Subnet,networkIdentity}=load('ui/devices/management/network-panel.ts');
const NetworkPanel=load('ui/devices/management/device-network-panel.tsx').default,EnglishPanel=english.load('ui/devices/management/device-network-panel.tsx').default;
const now=1800000000000,viewer={id:'owner',label:'Owner',permissions:['*']};
// The diagnosis client stamps submissions with Date.now(); the panel compares them with its now prop.
Date.now=()=>now;
const adapter={interfaceIndex:5,alias:'Ethernet 4',dhcp:false,status:'Up',addresses:[{address:'10.7.3.20',prefixLength:24}],gateway:['10.7.3.1'],dns:['10.7.3.12','10.7.3.13']};
const other={...adapter,interfaceIndex:9,alias:'Backup',status:'Disconnected',dhcp:true,addresses:[],gateway:[],dns:[]};
const basics=[{name:'Microsoft Hyper-V Adapter',addresses:['10.7.3.20','fe80::1234'],mac:'00-15-5D-AB-CD-EF',speedMbps:1000},...Array.from({length:7},(_,index)=>({name:'Filter '+index,addresses:[],mac:'',speedMbps:0}))];
const server={id:'device',name:'WIN-TEST',lastSeen:now-1000,management:1,revoked:0,snapshot:{protocolVersion:3,mode:'Management',agentCapabilities:['set-network','set-dns','network-diagnostics','refresh'],networkConfig:[adapter,other],networks:basics}};
const context={server,viewer,demo:false,saving:false,now},target={serverId:server.id,interfaceIndex:5,fingerprint:networkFingerprint(adapter)};
assert.equal(networkAdapters(server).length,2);assert.equal(networkAdapters({...server,snapshot:{...server.snapshot,networkConfig:[adapter,adapter,{...adapter,interfaceIndex:0}]}}).length,1,'identity is based on distinct real interface indices');
assert.deepEqual(ipv4Subnet('10.7.3.20',24),{mask:'255.255.255.0',network:'10.7.3.0/24'});assert.deepEqual(ipv4Subnet('255.255.255.254',31),{mask:'255.255.255.254',network:'255.255.255.254/31'});assert.equal(ipv4Subnet('1.2.3.999',24),null);assert.equal(ipv4Subnet('1.2.3.4',33),null);
assert.equal(networkIdentity(server,adapter),basics[0]);assert.equal(networkIdentity({...server,snapshot:{...server.snapshot,networks:[basics[0],basics[0]]}},adapter),null,'ambiguous inventory cannot invent a MAC or linkrate association');
assert.equal(currentNetworkAdapter({...server,id:'another'},target),null);assert.equal(currentNetworkAdapter({...server,snapshot:{...server.snapshot,networkConfig:[{...adapter,dns:['1.1.1.1']}] }},target),null,'a refreshed configuration invalidates an old edit intent');
const ipv4=networkConfirmation(context,target,'set-network',{interfaceIndex:5,dhcp:false,address:'10.7.3.21',prefixLength:24,gateway:'10.7.3.1'});assert.deepEqual(ipv4.payload,{action:'job',id:'device',kind:'set-network',params:{interfaceIndex:5,dhcp:false,address:'10.7.3.21',prefixLength:24,gateway:'10.7.3.1'},confirm:true});assert.match(ipv4.description,/aber nicht, wenn nur die Verbindung abbricht/);
assert.equal(ipv4.confirmLabel,'IPv4 ändern');assert.deepEqual(ipv4.lines,[{label:'Gerät',value:'WIN-TEST'}]);assert.ok(!ipv4.description.includes('WIN-TEST'));assert.match(ipv4.title,/\?$/);
const dns=networkConfirmation(context,target,'set-dns',{interfaceIndex:5,automatic:false,servers:['10.7.3.13','2001:db8::53']});assert.deepEqual(dns.payload.params.servers,['10.7.3.13','2001:db8::53']);assert.match(dns.description,/Domänenanmeldung/);assert.equal(dns.confirmLabel,'DNS ändern');
for(const flags of [{demo:true},{saving:true},{viewer:{...viewer,permissions:[]}},{server:{...server,lastSeen:now-120001}},{server:{...server,management:0}},{server:{...server,revoked:1}},{server:{...server,snapshot:{...server.snapshot,mode:'ReadOnly'}}},{server:{...server,snapshot:{...server.snapshot,agentCapabilities:[]}}},{server:{...server,maintenance:{state:'updating'}}}])assert.equal(networkConfirmation({...context,...flags},target,'set-network',{interfaceIndex:5,dhcp:true}),null);
assert.equal(networkConfirmation(context,target,'set-dns',{interfaceIndex:5,automatic:false,servers:['invalid']}),null);assert.equal(networkConfirmation(context,target,'set-network',{interfaceIndex:9,dhcp:true}),null);
assert.equal(networkActionReason({...context,server:{...server,management:0,snapshot:{...server.snapshot,mode:'ReadOnly'}}},'network-diagnostics'),'','read-only network diagnosis stays supported');
// Full sentences in the helper's order, in the language asked for.
for(const [flags,key] of [[{demo:true},'kit.unavailable.demo'],[{saving:true},'services.blocked.saving'],[{server:{...server,revoked:1}},'kit.unavailable.revoked'],[{viewer:{...viewer,permissions:[]}},'management.blocked.manage'],[{server:{...server,snapshot:{...server.snapshot,mode:'ReadOnly'}}},'management.blocked.readOnly'],[{server:{...server,lastSeen:now-120001}},'management.blocked.offline'],[{server:{...server,snapshot:{...server.snapshot,agentCapabilities:[]}}},'management.blocked.unsupported']]){const reason=networkActionReason({...context,...flags},'set-network','de');assert.equal(reason,de(key));assert.match(reason,/\.$/);}
assert.equal(networkActionReason({...context,demo:true},'set-network','en'),'Not available for sample devices.');
assert.ok(!fs.readFileSync('lib/i18n/messages/en.ts','utf8').includes("'network.readable'")&&!fs.readFileSync('lib/i18n/messages/de.ts','utf8').includes("'network.readable'"),'network.readable is gone from both catalogs');

Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:async value=>{if(copyFails)throw new Error('denied');copies.push(value);}}}});
globalThis.document={visibilityState:'visible',addEventListener(){},removeEventListener(){}};
const originalInterval=globalThis.setInterval,originalClear=globalThis.clearInterval,originalTimeout=globalThis.setTimeout;let intervals=[],timeouts=[];
globalThis.setInterval=callback=>{intervals.push(callback);return intervals.length;};globalThis.clearInterval=()=>{};
const base={...context,onConfirm:value=>confirmations.push(value),onOpenConnections:()=>requests.push({navigation:'connections'})};
function reset(){harness.reset();confirmations=[];copies=[];downloads=[];requests=[];responseJobs=[];postWait=null;readWait=null;readFails=0;copyFails=false;intervals=[];timeouts=[];}
const tree=(overrides={})=>harness.tree(NetworkPanel,{...base,...overrides});
const html=(overrides={})=>harness.html(NetworkPanel,{...base,...overrides});
const field=(element,name)=>find(element,item=>item.type==='input'&&item.props.name===name);
const editorForm=element=>find(element,item=>item.type==='form'&&item.props.id==='sdx-network-editor');
const checkForm=element=>find(element,item=>item.type==='form'&&item.props.className==='sdx-network-check');
const search=element=>find(element,item=>item.props.search).props.search;
const settle=()=>harness.settle(),flush=()=>harness.flush();

// ---- Head, tiles, adapters ----
reset();let markup=html();
assert.match(markup,/<h2 class="sr-only">Netzwerk<\/h2>/,'the subarea name is only the accessible heading');
assert.match(markup,/Ethernet 4/);assert.match(markup,/10\.7\.3\.0\/24/);assert.match(markup,/00-15-5D-AB-CD-EF/);assert.match(markup,/Linkrate laut Inventar/);assert.match(markup,/Netzwerkdiagnose/);
assert.match(markup,/sdx-skeleton-facts" role="status" aria-label="Diagnoseergebnisse werden geladen/,'the first diagnostics load is a facts skeleton');
assert.match(markup,/aria-label="IPv4-Adapter: 2"/,'two manageable adapters, not eight filter entries');
assert.match(markup,/aria-label="Verbunden: 1">.*?<span class="sdx-kpi-detail"[^>]*>1 von 2</,'connected: 1 of 2');
assert.ok(!markup.includes('sd-network-counts')&&!markup.includes('sd-network-'),'no classic network classes');
assert.match(markup,/sdx-pill sdx-pill-online/);assert.match(markup,/Index 5 · Statisch|Index 5 · /);
assert.match(markup,/aria-label="DNS-Server 10\.7\.3\.12 testen"/,'the DNS test label comes from the catalog');
assert.ok(!fs.readFileSync('ui/devices/management/device-network-panel.tsx','utf8').includes('DNS-Server ${'),'no hard-coded German label');
let element=tree();search(element).onChange('10.7.3.13');markup=html();assert.match(markup,/Ethernet 4/);assert.ok(!markup.includes('>Backup<'));
element=tree();harness.button(element,'Filter zurücksetzen').props.onClick();element=tree();find(element,item=>item.props['aria-label']==='Adapterstatus filtern').props.onChange({target:{value:'other'}});markup=html();assert.match(markup,/>Backup</);assert.ok(!markup.includes('>Ethernet 4<'));
element=tree();search(element).onChange('nothing');markup=html();assert.match(markup,/Keine passenden Adapter/);assert.match(markup,/Filter zurücksetzen/,'no match offers Reset filters');
// A disconnected-only inventory turns the Connected tile into a warning.
reset();markup=html({server:{...server,snapshot:{...server.snapshot,networkConfig:[other]}}});assert.match(markup,/sdx-kpi sdx-kpi-warning/);

// ---- Editors in the kit Drawer ----
reset();element=tree();harness.button(element,'IPv4 ändern').props.onClick();markup=html();assert.match(markup,/role="dialog"/);assert.ok(!markup.includes('data-slot="dialog'),'no shadcn dialog');assert.match(markup,/class="sdx-drawer/);
element=tree();field(element,'address').props.onChange({target:{value:'10.7.3.21'}});element=tree();const editForm=editorForm(element);editForm.props.onSubmit({preventDefault(){}});assert.deepEqual(confirmations[0].payload,ipv4.payload);assert.equal(confirmations[0].confirmLabel,'IPv4 ändern');editForm.props.onSubmit({preventDefault(){}});assert.equal(confirmations.length,1,'double submission cannot replay a cleared edit intent');
reset();element=tree();harness.button(element,'IPv4 ändern').props.onClick();element=tree();field(element,'address').props.onChange({target:{value:'bad;whoami'}});element=tree();editorForm(element).props.onSubmit({preventDefault(){}});assert.equal(confirmations.length,0);markup=html();assert.match(markup,/aria-invalid="true"/);assert.match(markup,/class="sdx-field-error">Gib eine gültige IPv4-Adresse|Gültige IPv4-Adresse/,'the error shows at the field');
reset();element=tree();harness.button(element,'DNS ändern').props.onClick();element=tree();field(element,'dns').props.onChange({target:{value:'10.7.3.13, 2001:db8::53'}});element=tree();editorForm(element).props.onSubmit({preventDefault(){}});assert.deepEqual(confirmations[0].payload,dns.payload);
for(const overrides of [{viewer:{...viewer,permissions:[]}},{server:{...server,management:0}},{server:{...server,snapshot:{...server.snapshot,mode:'ReadOnly'}}},{now:now+150000},{server:{...server,snapshot:{...server.snapshot,agentCapabilities:[]}}},{saving:true},{server:{...server,id:'other-device'}}]){reset();element=tree();const retained=harness.button(element,'IPv4 ändern');tree(overrides);retained.props.onClick();assert.equal(confirmations.length,0,'retained editor opener obeys fresh scope/rights/ReadOnly/capability/offline/saving guards');assert.ok(!html(overrides).includes('name="address"'));}
reset();element=tree();harness.button(element,'IPv4 ändern').props.onClick();element=tree();const retainedForm=editorForm(element);const changed={...server,snapshot:{...server.snapshot,networkConfig:[{...adapter,dns:['1.1.1.1']}]}};tree({server:changed});retainedForm.props.onSubmit({preventDefault(){}});assert.equal(confirmations.length,0);assert.match(html({server:changed}),/Adaptereinstellungen haben sich auf dem Gerät geändert/);

// ---- Copy, export, refresh ----
reset();globalThis.setTimeout=(callback,delay)=>{timeouts.push({callback,delay});return timeouts.length;};
element=tree();harness.labelled(element,'IPv4 von Ethernet 4 kopieren').props.onClick();await settle();assert.deepEqual(copies,['10.7.3.20']);
markup=html();assert.match(markup,/aria-label="IPv4 von Ethernet 4 kopieren"[^>]*><svg[^>]*lucide-check/,'the copy icon swaps to a check');assert.equal(timeouts.at(-1).delay,1200);
timeouts.at(-1).callback();markup=html();assert.match(markup,/aria-label="IPv4 von Ethernet 4 kopieren"[^>]*><svg[^>]*lucide-copy/,'and back after 1.2 s');
element=tree();harness.labelled(element,'DNS von Ethernet 4 kopieren').props.onClick();await settle();assert.equal(copies[1],'10.7.3.12, 10.7.3.13');
element=tree();harness.labelled(element,'Konfiguration kopieren').props.onClick();await settle();assert.equal(JSON.parse(copies[2]).adapters.length,2);
copyFails=true;element=tree();harness.labelled(element,'Konfiguration kopieren').props.onClick();await settle();assert.deepEqual(harness.toasts,['error:'+de('network.copyUnavailable')]);
globalThis.setTimeout=originalTimeout;
reset();element=tree();harness.labelled(element,'Netzwerkbericht exportieren').props.onClick();assert.equal(JSON.parse(downloads[0].text).adapters.length,2);assert.equal(JSON.parse(downloads[0].text).networkInventory.length,8);assert.deepEqual(harness.toasts,['Netzwerkbericht exportiert.']);
element=tree();const retainedExport=harness.labelled(element,'Netzwerkbericht exportieren');tree({viewer:{...viewer,permissions:[]},server:{...server,permissions:[]}});retainedExport.props.onClick();assert.equal(downloads.length,1,'revoked view rights cannot export retained inventory');
reset();{const named={...server,name:'SRV APP01.lab'};element=tree({server:named});harness.labelled(element,'Netzwerkbericht exportieren').props.onClick();assert.equal(downloads[0].name,'ServerDesk-Netzwerk-SRV_APP01_lab.json','the report file name comes from the catalog with the sanitised device name');assert.equal(downloads[0].type,undefined,'the report keeps the default MIME type');}
reset();markup=html({server:{...server,snapshot:null}});for(const label of ['Konfiguration kopieren','Netzwerkbericht exportieren'])assert.equal(buttons(markup).find(button=>button.label===label).description,de('network.noInventory'),label+' is blocked without a snapshot');
reset();element=tree();harness.button(element,'Inventar aktualisieren').props.onClick();assert.deepEqual(confirmations[0].payload,{action:'job',id:'device',kind:'refresh',params:{},confirm:true});assert.equal(confirmations[0].confirmLabel,'Inventar aktualisieren');assert.deepEqual(confirmations[0].lines,[{label:'Gerät',value:'WIN-TEST'}]);

// ---- Diagnostics ----
reset();element=tree();harness.labelled(element,'DNS-Server 10.7.3.12 testen').props.onClick();element=tree();assert.equal(field(element,'host').props.value,'10.7.3.12');assert.equal(field(element,'port').props.value,'53');assert.equal(requests.length,0,'choosing a DNS target does not queue an implicit diagnosis');
markup=html();assert.match(markup,/aria-pressed="true"[^>]*>(<svg[^>]*>.*?<\/svg>)?<span>DNS 53<\/span>/,'the matching preset is pressed');
reset();tree();await flush();assert.equal(requests.filter(request=>!request.body).length,1);intervals[0]();await settle();assert.equal(requests.length,1,'idle inventory does not perform repeated diagnostic reads');element=tree();field(element,'host').props.onChange({target:{value:'server.test'}});element=tree();field(element,'port').props.onChange({target:{value:'445'}});element=tree();const testForm=checkForm(element);testForm.props.onSubmit({preventDefault(){}});testForm.props.onSubmit({preventDefault(){}});await settle();assert.equal(requests.filter(request=>request.body).length,1,'diagnostic double click is deduplicated by the existing client');assert.deepEqual(requests.find(request=>request.body).body,{serverId:'device',kind:'network-diagnostics',params:{host:'server.test',port:445}});
markup=html();assert.match(buttons(markup).find(button=>button.inner.includes('<span>Prüfen</span>')).attributes,/aria-busy="true"/,'Check is loading while it runs');
intervals[0]();await settle();assert.ok(requests.filter(request=>!request.body).length>=3,'a newly submitted job remains polled if the first GET has not exposed it yet');
responseJobs=[{id:'new-network-job',kind:'network-diagnostics',state:'succeeded',createdAt:now,claimedAt:now,result:null,data:{kind:'network-diagnostics',at:new Date(now).toISOString(),data:{tcp:{host:'server.test',port:445,connected:true,durationMs:13},dns:['10.7.3.30'],routes:[{DestinationPrefix:'0.0.0.0/0',NextHop:'10.7.3.1',InterfaceIndex:5,RouteMetric:15}],listeners:[{LocalAddress:'0.0.0.0',LocalPort:445,OwningProcess:4}],proxy:'Direct access'}}}];intervals[0]();await settle();markup=html();
assert.match(markup,/sdx-pill sdx-pill-success"><i aria-hidden="true"><\/i>Erreichbar/);assert.match(markup,/13 ms/);assert.match(markup,/10\.7\.3\.30/);assert.match(markup,/0\.0\.0\.0\/0/);assert.match(markup,/Direct access/);
assert.match(markup,/role="region" aria-label="Routen"/);assert.match(markup,/role="region" aria-label="TCP-Listener"/);
const before=requests.length;intervals[0]();await settle();assert.equal(requests.length,before,'completed diagnostics stop polling');
element=tree();harness.labelled(element,'Ergebnis als JSON herunterladen').props.onClick();assert.equal(downloads.at(-1).name,'ServerDesk-Netzwerkdiagnose.json','the diagnosis file name comes from the catalog');assert.equal(JSON.parse(downloads.at(-1).text).kind,'network-diagnostics');assert.equal(harness.toasts.at(-1),'Ergebnis heruntergeladen.');
element=tree();const oldTestForm=checkForm(element);tree({viewer:{...viewer,permissions:[]},server:{...server,permissions:['view']}});oldTestForm.props.onSubmit({preventDefault(){}});await settle();assert.equal(requests.filter(request=>request.body).length,1,'retained diagnostic callbacks obey revoked rights');assert.ok(!html({viewer:{...viewer,permissions:[]},server:{...server,permissions:['view']}}).includes('0.0.0.0/0'),'diagnostic output immediately disappears on permission loss');
// A read error: danger notice with Try again, which reads again.
reset();readFails=1;tree();await flush();markup=html();assert.match(markup,/class="sdx-notice sdx-notice-danger" role="alert">.*?Lesefehler/);const reads=requests.filter(request=>!request.body).length;
element=tree();harness.button(element,'Erneut versuchen').props.onClick();await settle();assert.equal(requests.filter(request=>!request.body).length,reads+1,'Try again repeats the read');assert.ok(!html().includes('sdx-notice-danger'));
// A timeout: warning notice with Try again.
reset();responseJobs=[{id:'slow',kind:'network-diagnostics',state:'running',createdAt:now-61000,claimedAt:now-61000,result:null,data:null}];tree();await flush();markup=html();assert.match(markup,/class="sdx-notice sdx-notice-warning" role="status">.*?Die Prüfung dauert länger als üblich/);assert.match(markup,/Erneut versuchen/);
// A failed last job: warning notice.
reset();responseJobs=[{id:'failed',kind:'network-diagnostics',state:'failed',createdAt:now,claimedAt:now,result:'Kaputt',data:null}];tree();await flush();assert.match(html(),/sdx-notice-warning" role="status">.*?Kaputt/);
reset();tree({server:{...server,snapshot:null}});markup=html({server:{...server,snapshot:null}});assert.match(markup,/Erweitertes Netzwerkinventar ausstehend/);assert.ok(!markup.includes('sdx-kpi'),'missing inventory is not zero adapters: tiles without a value are left out, and with them the row');
reset();tree({server:{...server,management:0,snapshot:{...server.snapshot,mode:'ReadOnly'}}});await flush();element=tree({server:{...server,management:0,snapshot:{...server.snapshot,mode:'ReadOnly'}}});checkForm(element).props.onSubmit({preventDefault(){}});await settle();assert.equal(requests.filter(request=>request.body).length,1,'native diagnostics remain usable in ReadOnly mode');

// ---- Panel notice and access ----
reset();markup=html({demo:true});assert.match(markup,/<div>Bei Beispielgeräten nicht möglich\. Die Netzwerkeinstellungen kannst du weiter lesen\.<\/div>/,'DV-management-4 in German');
assert.equal((markup.match(/class="sdx-notice sdx-notice-info"/g)||[]).length,1);
english.reset();markup=english.html(EnglishPanel,{...base,demo:true});assert.match(markup,/<div>Not available for sample devices\. You can still read the network settings\.<\/div>/,'DV-management-4 in English');
assert.equal(buttons(markup).find(button=>button.inner.includes('<span>Change IPv4</span>')).description,'Not available for sample devices.','the panel passes the viewer locale');
english.reset();markup=english.html(EnglishPanel,{...base,viewer:{...viewer,permissions:[]},server:{...server,permissions:['view','diagnose']}});assert.equal(buttons(markup).find(button=>button.inner.includes('<span>Change DNS</span>')).description,'You need the management permission for this.');
assert.match(markup,/aria-label="Test DNS server 10\.7\.3\.12"/);
reset();markup=html({server:{...server,management:0,snapshot:{...server.snapshot,mode:'ReadOnly'}}});assert.match(markup,new RegExp(`<div>${de('kit.unavailable.mode')} ${de('network.readOnly')}</div>`));
reset();markup=html({server:{...server,lastSeen:now-600000}});assert.ok(!markup.includes('sdx-notice-info'),'offline: no own notice');
reset();markup=html({viewer:{...viewer,permissions:[]},server:{...server,permissions:[]}});assert.match(markup,/sdx-notice-info" role="status">.*?Dein Zugriff auf dieses Gerät hat sich geändert\./);assert.ok(!markup.includes('sd-network-unavailable')&&!markup.includes('sdx-kpi'),'only the notice');
reset();markup=html({server:{...server,revoked:1}});assert.match(markup,/lucide-ban/,'revoked uses its own icon');

// ---- Firewall rules: the last card of Network since slice 6 (ui/devices/management/device-firewall.tsx) ----
{
 const rules=[{name:'RDP-In',displayName:'Remotedesktop',enabled:true,direction:'Inbound',action:'Allow',protocol:'TCP',port:'3389',remoteAddress:'LocalSubnet'},{name:'Old-Out',displayName:'Alte Regel',enabled:false,direction:'Outbound',action:'Block',protocol:'UDP',port:'500',remoteAddress:'Any'}];
 const firewallServer={...server,snapshot:{...server.snapshot,agentCapabilities:[...server.snapshot.agentCapabilities,'set-firewall-rule','add-firewall-rule'],firewallRules:rules}};
 reset();let markup=html({server:firewallServer});
 const headings=[...markup.matchAll(/<h2[^>]*>(?:<span class="sdx-icon-tile[^"]*"[^>]*>.*?<\/span>)?([^<]+)<\/h2>/g)].map(match=>match[1]);
 assert.equal(headings.at(-1),'Firewall-Regeln','Firewall rules is the last card');assert.ok(headings.indexOf('Firewall-Regeln')>headings.indexOf('Netzwerkdiagnose'),'below the adapters and the diagnostics');
 assert.match(markup,/role="region" aria-label="Firewall-Regeln"/);assert.match(markup,/2 von 2 Regeln/);
 const fw=panelHarness({hooked:['ui/devices/management/device-firewall.tsx']}),Firewall=fw.load('ui/devices/management/device-firewall.tsx').default;
 let asked=[];const fwProps={server:firewallServer,viewer,demo:false,saving:false,now,onConfirm:value=>asked.push(value)};
 const fwTree=(extra={})=>fw.tree(Firewall,{...fwProps,...extra}),fwHtml=(extra={})=>fw.html(Firewall,{...fwProps,...extra});
 const reason=(markup,label)=>buttons(markup).find(item=>item.inner.includes(`<span>${label}</span>`));
 // Enable and Disable keep the classic payloads.
 // one row Menu per rule ("Aktionen für …") with Turn on or Turn off.
 const ruleEntry=(element,name)=>fw.menu(element,de('tree.actionsForName',{name}))?.[0];
 fw.reset();assert.deepEqual([ruleEntry(fwTree(),'Remotedesktop').label,ruleEntry(fwTree(),'Alte Regel').label],['Ausschalten','Einschalten'],'one entry per rule');
 const fwColumn=fw.table(fwTree(),'Firewall-Regeln').props.columns.find(column=>column.id==='actions');assert.deepEqual([fwColumn.hideLabel,fwColumn.className,fwColumn.card],[true,'sdx-col-actions',undefined],'the row Menu column also renders in card mode');
 fw.reset();ruleEntry(fwTree(),'Remotedesktop').onSelect();
 assert.deepEqual(asked[0].payload,{action:'job',id:'device',kind:'set-firewall-rule',params:{name:'RDP-In',enabled:false},confirm:true});assert.equal(asked[0].confirmLabel,'Ausschalten');assert.match(asked[0].title,/\?$/);assert.match(asked[0].description,/Remotedesktop/);assert.deepEqual(asked[0].lines,[{label:'Gerät',value:'WIN-TEST'}]);
 // Create rule: the drawer with the classic fields and payload; required fields first.
 fw.reset();asked=[];fw.button(fwTree(),'Regel erstellen').props.onClick();markup=fwHtml();assert.match(markup,/role="dialog"/);assert.match(markup,/name="remoteAddress"[^>]*value="LocalSubnet"/);
 fw.find(fwTree(),item=>item.type==='form').props.onSubmit({preventDefault(){}});assert.equal(asked.length,0,'required fields');assert.match(fwHtml(),/aria-invalid="true"/);
 for(const [name,value] of [['name','Web'],['port','443']])fw.find(fwTree(),item=>item.type==='input'&&item.props.name===name).props.onChange({target:{value}});
 fw.find(fwTree(),item=>item.type==='form').props.onSubmit({preventDefault(){}});
 assert.deepEqual(asked[0].payload,{action:'job',id:'device',kind:'add-firewall-rule',params:{name:'Web',direction:'Inbound',action:'Allow',protocol:'TCP',port:'443',remoteAddress:'LocalSubnet'},confirm:true},'Create rule: the classic payload');
 // Blocked with the reasons of the classic rules; search and empty states stay.
 fw.reset();markup=fwHtml({server:{...firewallServer,snapshot:{...firewallServer.snapshot,mode:'ReadOnly'}}});
 assert.equal(reason(markup,'Regel erstellen').description,de('management.blocked.readOnly'),'Create rule is blocked with its reason');assert.equal(ruleEntry(fwTree({server:{...firewallServer,snapshot:{...firewallServer.snapshot,mode:'ReadOnly'}}}),'Alte Regel').blocked,de('management.blocked.readOnly'));
 markup=fwHtml({demo:true});assert.ok(reason(markup,'Regel erstellen').blocked,'demo: Create rule blocked');
 fw.reset();fw.find(fwTree(),item=>item.props.search?.label==='Firewallregeln suchen').props.search.onChange('nichts');assert.match(fwHtml(),/Keine passenden Firewallregeln/);
 fw.reset();assert.match(fwHtml({server:{...firewallServer,snapshot:{...firewallServer.snapshot,firewallRules:undefined}}}),new RegExp(de('management.firewall.noInventory')));
 // A retained toggle checks the live device again.
 fw.reset();asked=[];const retained=ruleEntry(fwTree(),'Remotedesktop');fwTree({server:{...firewallServer,lastSeen:now-600000}});retained.onSelect();assert.equal(asked.length,0,'offline now: nothing to confirm');
 reset();
}
reset();globalThis.setInterval=originalInterval;globalThis.clearInterval=originalClear;
console.log('PASS: network on the kit: hidden title, KPI row, adapter cards, the Firewall rules card last (toggle and Create rule payloads, blocked reasons, search), IPv4/DNS editors in the Drawer, copy check swap, export toasts, diagnostics card with notices and result tables, exact confirmations with confirmLabel and device line, the DV-management-4 sentence in German and English, no idle polling, double-click dedupe and fresh permission/device/mode/offline/saving/capability guards.');
