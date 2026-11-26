// Management → Roles & features on the kit (ui/devices/management/roles-features.tsx), run on hook cells
// (tests/support/panel-harness.mjs; cell 0 holds the tab and the search, cell 1 the drawer). German
// SSR: installed first, the alphabetic catalog, collapsed role services, search ancestry, orphan
// sections and optional-only inventories as before; the Roles/Features Segmented beside the search (UI-Rework 13b),
// the counts that name their unit, one row Menu per feature (Install… or Remove…, danger), the blocked
// reasons and the payload of install and remove.
import assert from 'node:assert/strict';
import {panelHarness} from '../../support/panel-harness.mjs';
import {de} from '../../support/i18n-stubs.mjs';
const harness=panelHarness({hooked:['ui/devices/management/roles-features.tsx']});
const {load,walk}=harness;
const RolesFeatures=load('ui/devices/management/roles-features.tsx').default;
let checks=0;
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};

const now=1800000000000,viewer={id:'owner',label:'Owner',permissions:['*']};
const features=[{name:'Z',displayName:'Zebra',installed:false,featureType:'Role',parent:null},{name:'IIS',displayName:'Webserver',installed:true,featureType:'Role',parent:null},{name:'Static',displayName:'Statischer Inhalt',installed:false,featureType:'Role Service',parent:'IIS'},{name:'HTTP',displayName:'HTTP-Protokoll',installed:false,featureType:'Role Service',parent:'IIS'},{name:'DNS',displayName:'DNS-Server',installed:true,featureType:'Role',parent:null},{name:'Telnet-Client',displayName:'Telnet-Client',installed:false,featureType:'Feature',parent:null}];
const server={id:'server',name:'Test',lastSeen:now-1000,revoked:0,management:1,snapshot:{hostname:'Test',features,mode:'Management',management:true,agentCapabilities:['install-feature','remove-feature']}};
let confirmations=[];
const props={server,viewer,demo:false,saving:false,now,onConfirm:value=>confirmations.push(value)};
const reset=()=>{harness.reset();confirmations=[];};
const html=(overrides={})=>harness.html(RolesFeatures,{...props,...overrides});
const tree=(overrides={})=>harness.tree(RolesFeatures,{...props,...overrides});
const withFeatures=list=>({server:{...server,snapshot:{...server.snapshot,features:list}}});
const sections=markup=>markup.split('<section').slice(1);
// The tree rows are FeatureTree elements: their reason and onAction props are the panel's.
const rows=root=>walk(root).filter(item=>item.type?.name==='FeatureTree');
const act=(root,name)=>{const row=rows(root).find(item=>item.props.node.feature.name===name);row.props.onAction(row.props.node.feature);};
/** The row Menu of a feature: its FeatureTree runs once on the hook cells, which are restored afterwards. */
const menuOf=(root,name)=>{const row=rows(root).find(item=>item.props.node.feature.name===name),saved=new Map(harness.h.states);const built=harness.tree(row.type,row.props);harness.h.states=saved;return walk(built).find(item=>Array.isArray(item.props?.entries))?.props;};

// ---- Head and tabs ----
reset();let markup=html();
ok(/<h2 class="sr-only">Rollen &amp; Features<\/h2>/.test(markup),'the subarea name is only the accessible heading');
ok(markup.includes(de('roles.description'))&&markup.includes('2 installiert'),'description and the installed count of the active tab as meta');
ok(/<div class="sdx-toolbar sdx-rf-toolbar"><label class="sdx-searchfield sdx-toolbar-search">.*?<div class="sdx-toolbar-filters"><div class="sdx-segmented sdx-segmented-sm" role="group" aria-label="Rollen und Features">/.test(markup),'the view switch is a small Segmented in the filters of the kit Toolbar, beside the search');
ok(/aria-pressed="true" class="active"><span>Rollen<\/span><b>3<\/b>/.test(markup)&&/aria-pressed="false"><span>Features<\/span><b>1<\/b>/.test(markup),'Rollen and Features with their counts');
ok(!/role="tablist"|role="tabpanel"/.test(markup),'no underline Tabs and no tabpanel wrapper');
ok(!markup.includes('rf-tabs')&&!markup.includes('aria-current')&&!markup.includes('count-chip')&&!markup.includes('class="panel'),'no classic tabs, no aria-current buttons, no count chip');

// ---- Installed first, alphabetic catalog, collapsed children, search ancestry ----
ok(markup.indexOf('Installierte Rollen')<markup.indexOf('Rollenkatalog'),'installed section is above catalog');
const [installed,catalog]=sections(markup);
ok(!installed.includes('Zebra'),'available role not mixed into installed overview');
ok(catalog.indexOf('DNS-Server')<catalog.indexOf('Webserver')&&catalog.indexOf('Webserver')<catalog.indexOf('Zebra'),'actual catalog renders alphabetically');
ok(catalog.includes('3 · '+de('roles.alphabetical')),'the catalog meta: count and alphabetical');
ok(!markup.includes('Statischer Inhalt'),'children start collapsed');ok(/aria-expanded="false"/.test(markup)&&/aria-controls="/.test(markup),'the expand button names its children');
ok(markup.includes('0 von 2 Rollendiensten installiert')&&!markup.includes('Komponenten installiert'),'the count names its unit');
ok(/sdx-pill-success[^>]*>.*?Installiert|sdx-pill sdx-pill-success"><i aria-hidden="true"><\/i>Installiert/.test(markup)&&/sdx-pill-neutral"><i aria-hidden="true"><\/i>Verfügbar/.test(markup),'status pills');
reset();let root=tree();walk(root).find(item=>item.props.search).props.search.onChange('statischer');markup=html();
ok(/Statischer Inhalt/.test(markup)&&/Webserver/.test(markup)&&!markup.includes('HTTP-Protokoll')&&/aria-expanded="true"/.test(markup),'search keeps the ancestry and opens it');
reset();markup=html(withFeatures(features.map(feature=>{const flat={...feature};delete flat.parent;return flat;})));
ok(/Weitere Rollendienste/.test(markup)&&/HTTP-Protokoll/.test(markup),'orphan role services in the catalog');
reset();markup=html(withFeatures(features.map(feature=>{const flat={...feature,installed:feature.name==='HTTP'?true:feature.installed};delete flat.parent;return flat;})));
ok(/Installierte Rollendienste ohne Rollenbezug/.test(markup),'installed orphans');
reset();markup=html(withFeatures([{name:'Sandbox',displayName:'Sandbox',installed:true,featureType:'OptionalFeature'}]));
ok(/Installierte Features/.test(markup)&&/Featurekatalog/.test(markup)&&!markup.includes('Installierte Rollen'),'Windows client optional features remain coherent');
ok(!markup.includes('aria-label="Rollen und Features"'),'optional features only: no view switch');
reset();root=tree();walk(root).find(item=>item.props.label==='Rollen und Features'&&Array.isArray(item.props.items)).props.onChange('features');markup=html();
ok(/Installierte Features/.test(markup)&&markup.includes('Telnet-Client')&&markup.includes(de('roles.featureCatalog')),'the Features tab');

// ---- One row Menu per feature: Install… or Remove… (danger), blocked with the reason ----
reset();markup=html();root=tree();
ok(markup.includes('aria-label="Aktionen für DNS-Server"')&&markup.includes('aria-label="Aktionen für Zebra"'),'one row Menu per feature, named after it');
ok(!/<button[^>]*class="sdx-btn[^"]*"[^>]*>(?:(?!<\/button>).)*(Installieren|Entfernen)/.test(markup)&&!markup.includes('data-slot="button"'),'no Btn per row and no shadcn Button');
let menu=menuOf(root,'DNS');
check([menu.label,menu.entries.map(entry=>[entry.label,!!entry.danger,entry.blocked])],['Aktionen für DNS-Server',[['Entfernen…',true,undefined]]],'an installed feature: Remove…, danger');
menu=menuOf(root,'Z');
check(menu.entries.map(entry=>[entry.label,!!entry.danger,entry.blocked]),[['Installieren…',false,undefined]],'a feature that is not installed: Install…');
menu.entries[0].onSelect();root=tree();ok(html().includes('Zebra installieren'),'selecting the entry opens the drawer');
const blockedCases=[
 [{viewer:{...viewer,permissions:[]}},de('management.blocked.manage')],
 [{server:{...server,snapshot:{...server.snapshot,mode:'ReadOnly',management:false}}},de('management.blocked.readOnly')],
 [{server:{...server,lastSeen:now-3600000}},de('management.blocked.offline')],
 [{server:{...server,snapshot:{...server.snapshot,agentCapabilities:[]}}},de('management.blocked.unsupported')],
 [{demo:true},'Bei Beispielgeräten nicht möglich.'],
 [{saving:true},de('fleet.menu.saving')],
];
for(const [overrides,reason] of blockedCases){
 reset();root=tree(overrides);
 ok(rows(root).length>0&&rows(root).every(item=>item.props.reason('install-feature')===reason&&item.props.reason('remove-feature')===reason),`blocked with "${reason}"`);
 check([menuOf(root,'DNS').entries[0].blocked,menuOf(root,'Z').entries[0].blocked],[reason,reason],`the menu entries stay visible with the reason (${reason})`);
}
reset();markup=html({demo:true});
ok(markup.includes(`${de('kit.unavailable.demo')} ${de('roles.readOnly')}`),'demo: the one panel notice');
reset();markup=html({viewer:{...viewer,permissions:[]}});
ok(markup.includes(de('roles.readOnly'))&&!markup.includes('Lesezugriff ·'),'missing right: the panel notice, no classic banner');
reset();markup=html({server:{...server,snapshot:{...server.snapshot,mode:'ReadOnly'}}});
ok(markup.includes(de('roles.readOnly'))&&!markup.includes('--set-mode'),'ReadOnly mode: the panel notice without the --set-mode code');
reset();markup=html({server:{...server,snapshot:{...server.snapshot,features:undefined}}});
ok(/role="status"/.test(markup)&&markup.includes(de('roles.loading'))&&!markup.includes('loading-skeleton'),'first load: the kit Skeleton');

// ---- Drawer, confirmation and payload ----
reset();root=tree();
act(root,'DNS');root=tree();markup=html();
ok(markup.includes('DNS-Server entfernen')&&markup.includes(de('management.feature.description',{displayName:'DNS-Server'})),'remove: the drawer with title and description');
ok(/role="switch"[^>]*checked=""/.test(markup)&&markup.includes(de('management.feature.includeTools')),'remove: the tools switch, on by default');
walk(root).find(item=>item.type==='form').props.onSubmit({preventDefault(){}});
check(confirmations[0].payload,{action:'job',id:'server',kind:'remove-feature',params:{name:'DNS',includeManagementTools:true},confirm:true},'remove: the payload as before');
check([confirmations[0].title,confirmations[0].confirmLabel,confirmations[0].tone],['DNS-Server entfernen?','Entfernen','danger'],'remove: title, confirm label, danger');
check(confirmations[0].lines,[{label:'Gerät',value:'Test'}],'remove: the device line');
ok(confirmations[0].description.endsWith('\n\n'+de('management.feature.description',{displayName:'DNS-Server'}))&&!confirmations[0].description.includes('Server:'),'remove: review + description');
reset();root=tree();
act(root,'Z');root=tree();
walk(root).find(item=>item.type==='input'&&item.props.role==='switch').props.onChange({target:{checked:false}});root=tree();
walk(root).find(item=>item.type==='form').props.onSubmit({preventDefault(){}});
check(confirmations[0].payload,{action:'job',id:'server',kind:'install-feature',params:{name:'Z',includeManagementTools:false},confirm:true},'install: the payload as before');
check([confirmations[0].title,confirmations[0].confirmLabel,confirmations[0].tone],['Zebra installieren?','Installieren',undefined],'install: no danger');
reset();root=tree();
act(root,'Z');root=tree({demo:true});
walk(root).find(item=>item.type==='form').props.onSubmit({preventDefault(){}});
check(confirmations.length,0,'the reason is checked again before the confirmation');

console.log(`PASS roles and features (${checks} checks): installed first, alphabetic catalog, collapsed services and search ancestry, orphans and optional-only inventories, the Segmented view switch with counts, unit counts, one row Menu per feature with danger Remove…, the blocked reasons (right, ReadOnly, offline, unsupported, demo, saving) and the install/remove payloads.`);
