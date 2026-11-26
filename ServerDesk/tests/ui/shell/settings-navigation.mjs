// Settings in the redesigned console: the rail entry "Einstellungen" at the end of
// the rail with the kit Tooltip, the navigator in five named groups, the page "Sitzungen",
// no breadcrumbs on Settings and Automation pages (the crumb button below 900px)
// and the path texts. The pages, groups and the rail entry come from the
// navigation model (ui/shell/nav-model.ts); other modules are transpiled and run with stubbed imports.
import '../../support/register.mjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {de,i18nStubs} from '../../support/i18n-stubs.mjs';
import * as accountDisplay from '../../../lib/account-display.ts';
const navModel=await import('../../../ui/shell/nav-model.ts');
const {translate}=await import('../../../lib/i18n/translate.ts');

let checks=0;
const jsx=(type,props,key)=>({type,props:props??{},key});
const source=filename=>ts.transpileModule(fs.readFileSync(path.resolve(filename),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
const icons=new Proxy({}, {get:(_target,key)=>String(key)});
function loadModule(filename,stubs={}){
 const mod={exports:{}};
 const require=id=>{
  if(id in stubs)return stubs[id];
  if(id==='react')return {useEffect:()=>{},useRef:initial=>({current:initial})};
  if(id==='react/jsx-runtime')return {jsx,jsxs:jsx,Fragment:'Fragment'};
  if(id==='lucide-react')return icons;
  if(id.endsWith('.css'))return {};
  throw Error('Unexpected import '+id+' in '+filename);
 };
 new Function('require','module','exports',source(filename))(require,mod,mod.exports);
 return mod.exports;
}
const nodes=node=>!node||typeof node!=='object'?[]:[node,...[node.props?.children].flat(Infinity).flatMap(nodes)];
const text=node=>typeof node==='string'||typeof node==='number'?String(node):!node||typeof node!=='object'?'':[node.props?.children].flat(Infinity).map(text).join('');

// console-route.ts: new order, page "Sicherheit", the #settings routes and the old links.
const route=loadModule('lib/console-route.ts');
// The section ids are the page names: the old administration tab list and its ids are gone, every old hash still opens its page.
assert.equal(route.administrationTabs,undefined,'no administration tab list');
assert.deepEqual([...route.settingsPages],['accounts','user-groups','roles','entra','sessions','customers','branding','notification-channels','vulnerabilities','assistant','agent-releases','extensions','agent-troubleshooting','retention','audit','usage-data']);
for(const [old,page] of Object.entries({accounts:'accounts',usergroups:'user-groups',roles:'roles',entra:'entra',customers:'customers',license:'usage-data',settings:'sessions',maintenance:'retention',notifications:'notification-channels',vulnerabilities:'vulnerabilities',assistant:'assistant',audit:'audit'})){assert.deepEqual(route.parseConsoleRoute('#administration/'+old),{view:'settings',page},`#administration/${old} opens #settings/${page}`);checks++;}
for(const [hash,expected] of [['#agents/releases',{view:'settings',page:'agent-releases'}],['#agents/troubleshooting',{view:'settings',page:'agent-troubleshooting'}],['#agents/uninstall',{view:'settings',page:'agent-troubleshooting'}],['#agents/installation',{view:'add-device',installer:false}],['#agents/installation/group/g1',{view:'add-device',installer:false,groupId:'g1'}],['#access/permissions',{view:'settings',page:'roles'}],['#audit/jobs',{view:'devices',tab:'jobs'}]]){assert.deepEqual(route.parseConsoleRoute(hash),expected,hash);checks++;}
assert.deepEqual(route.parseConsoleRoute('#administration/settings'),{view:'settings',page:'sessions'},'the old Security link opens Sessions');
assert.deepEqual(route.parseConsoleRoute('#settings/license'),{view:'settings',page:'usage-data'},'the old License link opens Usage data');assert.equal(route.consoleRouteHash(route.parseConsoleRoute('#settings/license')),'#settings/usage-data','its canonical form');checks+=2;
assert.deepEqual(route.parseConsoleRoute('#settings/vulnerabilities'),{view:'settings',page:'vulnerabilities'});assert.equal(route.consoleRouteHash({view:'settings',page:'vulnerabilities'}),'#settings/vulnerabilities');checks+=2;
assert.equal(route.consoleRouteHash({view:'settings',page:'sessions'}),'#settings/sessions');
assert.deepEqual(route.parseConsoleRoute('#access/accounts'),{view:'settings',page:'accounts'},'alias routes still open their page');
assert.deepEqual(route.parseConsoleRoute('#audit'),{view:'settings',page:'audit'},'alias routes still open their page');
checks+=6;

// shell.tsx: Rail places 'end' entries last with their own class; NavGroups drops empty groups.
const shell=loadModule('ui/shell/shell.tsx',{
 '@/ui/kit/kit':{cx:(...names)=>names.filter(Boolean).join(' '),Btn:'Btn',IconBtn:'IconBtn',Kbd:'Kbd',Menu:'Menu',RichText:'RichText',iconButtonTip:(label,shortcut,ctrl)=>shortcut?`${label} (${shortcut.replace('Control',ctrl)})`:label},
 '@/ui/kit/tooltip':{Tooltip:'Tooltip',TooltipProvider:'TooltipProvider'},
 '@/ui/kit/brand-mark':{BrandMark:'BrandMark'},
 '@/ui/kit/brand-logo':{BrandLogo:'BrandLogo'},
 '@/lib/brand':{productName:'Nodiverna'},
 '@/ui/shell/theme':{themeMenuEntry:()=>({}),useTheme:()=>['system',()=>{}]},
 '@/ui/session/session-idle':{useIdleSeconds:()=>null},
 '@/ui/session/session-idle-state':{countdownLabel:String},
 '@/lib/account-display':accountDisplay,
 ...i18nStubs,
});
const item=(id,extra={})=>({id,label:id,icon:'Icon',shortcut:'G X',onSelect:()=>{},...extra});
const rail=shell.Rail({items:[item('devices',{label:'Geräte',shortcut:'G D'}),item('settings',{label:'Einstellungen',shortcut:'G S',placement:'end'}),item('automation',{label:'Automation',shortcut:'G A'})],area:'settings'});
const tips=nodes(rail).filter(node=>node.type==='Tooltip'),buttons=nodes(rail).filter(node=>node.type==='button');
assert.deepEqual(tips.map(node=>node.key),['devices','automation','settings'],'end entries come last');
// U12: each item is the trigger of a kit Tooltip with iconButtonTip text; no native title anywhere in the rail.
assert.equal(rail.type,'TooltipProvider','one provider: moving between items opens the next tooltip at once');
assert.deepEqual(tips.map(node=>[node.props.content,node.props.children.type,node.props.side]),[['Geräte (G D)','button','right'],['Automation (G A)','button','right'],['Einstellungen (G S)','button','right']],'label (keys) on hover and focus');
assert.ok(nodes(rail).every(node=>node.props.title===undefined),'no title= in the rail');
assert.deepEqual(buttons.map(node=>text(node)),['Geräte','Automation','Einstellungen'],'the visible label stays the name');
checks+=4;
assert.deepEqual(buttons.map(node=>node.props.className.split(' ').includes('sdx-rail-item-end')),[false,false,true],'only the end entry gets sdx-rail-item-end');
assert.ok(buttons.every(node=>node.props.className.split(' ').includes('sdx-rail-item')));
assert.equal(buttons[2].props['aria-current'],'page');
checks+=4;

const entry=id=>({id,label:id,icon:'Icon'});
const onSelect=()=>{};
const grouped=shell.NavGroups({label:'Einstellungen',value:'license',onSelect,groups:[{label:'Konten & Zugriff',items:[entry('accounts')]},{label:'Organisation',items:[]},{label:'System',items:[entry('settings'),entry('audit')]}]});
const headings=nodes(grouped).filter(node=>node.type==='h3');
assert.deepEqual(headings.map(node=>node.props.className),['sdx-navlist-heading','sdx-navlist-heading']);
assert.deepEqual(headings.map(text),['Konten & Zugriff','System'],'a group without pages has no heading');
const lists=nodes(grouped).filter(node=>node.type===shell.NavList);
assert.deepEqual(lists.map(node=>node.props.label),['Konten & Zugriff','System']);
assert.deepEqual(lists.map(node=>node.props.items.map(page=>page.id)),[['accounts'],['settings','audit']]);
assert.ok(lists.every(node=>node.props.value==='license'&&node.props.onSelect===onSelect));
checks+=5;

// NavList: one line per entry (nodiverna-ui §8): the icon without a tile, then the label. No hint, no
// small and no title: the page hint is the page subtitle.
{
 const list=shell.NavList({label:'Portal',value:'settings',onSelect,items:[{...entry('settings'),href:'#settings/sessions'},{...entry('audit'),href:'#settings/audit'}]});
 const links=nodes(list).filter(node=>node.type==='a');
 assert.ok(links.every(link=>!nodes(link).some(node=>node.type==='small')),'no hint line');
 assert.ok(links.every(link=>!nodes(link).some(node=>node.props?.title!==undefined)),'no title anywhere in an entry');
 assert.ok(links.every(link=>!nodes(link).some(node=>node.props?.className==='sdx-navlist-icon')),'the icon has no tile');
 assert.deepEqual(links.map(link=>nodes(link).filter(node=>node.type==='Icon').map(node=>node.props.className)),[['sdx-navlist-glyph'],['sdx-navlist-glyph']],'one 16px glyph per entry');
 assert.deepEqual(links.map(link=>[link.props.href,link.props['aria-current'],link.props.className]),[['#settings/sessions','page','active'],['#settings/audit',undefined,'']],'href, aria-current and class stay');
 assert.deepEqual(links.map(link=>nodes(link).filter(node=>node.type==='strong').map(text)),[['settings'],['audit']],'one strong label per entry');
 const clicked=[],recording=shell.NavList({label:'Portal',value:'settings',onSelect:id=>clicked.push(id),items:[entry('audit')]});
 let prevented=false;nodes(recording).find(node=>node.type==='a').props.onClick({button:0,preventDefault(){prevented=true;}});
 assert.ok(prevented);assert.deepEqual(clicked,['audit'],'a click still selects the page');
 checks+=8;
}

// PageHeader: crumbs only where a hierarchy can be climbed. A Settings or Automation page passes the crumb button
// instead: the area name as its text, shell.areaPages as its name, aria-expanded with the overlay state.
{
 const areaHeader=shell.PageHeader({title:'Sitzungen',subtitle:'Lege fest, wann Nodiverna inaktive Konten abmeldet und wann es erneut nach MFA fragt.',areaCrumb:{label:'Einstellungen',expanded:false,onSelect}});
 const paths=nodes(areaHeader).filter(node=>node.props?.className?.split?.(' ').includes('sdx-page-path'));
 assert.deepEqual(paths.map(node=>node.props.className),['sdx-page-path sdx-page-path-area'],'one crumb row, the area variant');
 assert.equal(nodes(areaHeader).some(node=>node.type===shell.Breadcrumbs),false,'no breadcrumbs');
 const button=nodes(areaHeader).find(node=>node.type==='Btn');
 assert.deepEqual([text(button),button.props['aria-label'],button.props['aria-expanded'],button.props.onClick===onSelect,button.props.variant,button.props.size],['Einstellungen','Seiten anzeigen: Einstellungen',false,true,'ghost','sm'],'the crumb button: visible area name, accessible name, aria-expanded, kit Btn (press scale .96)');
 const open=shell.PageHeader({title:'Sitzungen',areaCrumb:{label:'Einstellungen',expanded:true,onSelect}});
 assert.equal(nodes(open).find(node=>node.type==='Btn').props['aria-expanded'],true,'aria-expanded follows the overlay');
 const device=shell.PageHeader({title:'SRV',crumbs:[{label:'Alle Geräte',href:'#devices'},{label:'SRV'}],areaCrumb:{label:'Einstellungen',expanded:false,onSelect}});
 assert.deepEqual([nodes(device).some(node=>node.type==='Btn'),nodes(device).filter(node=>node.type===shell.Breadcrumbs).length],[false,1],'crumbs win over the crumb button');
 const plain=shell.PageHeader({title:'Mein Konto'});
 assert.equal(nodes(plain).some(node=>node.props?.className?.includes?.('sdx-page-path')),false,'My account has no crumb row');
 checks+=7;
}

// nav-model.ts: the rail entry, the five groups and pages, no crumbs on Settings pages, and the palette; console.tsx renders them.
const consoleSource=fs.readFileSync('ui/shell/console.tsx','utf8');
const owner={permissions:['*']};
const railIds=navModel.visibleRail({viewer:owner}).map(node=>node.id),settingsRail=navModel.navTree.rail.find(node=>node.id==='settings');
assert.deepEqual(railIds,['dashboard','devices','automation','settings'],'no Agents item; the Dashboard comes first and Settings last');
assert.deepEqual([de(settingsRail.label),settingsRail.icon,settingsRail.placement.end,settingsRail.shortcut.keys],['Einstellungen','Settings',true,'G S']);
assert.deepEqual(navModel.visibleRail({viewer:{permissions:[]}}).map(node=>node.id),['dashboard','devices','automation'],'visible only with a settings page');
assert.match(consoleSource,/visibleRail\(navContext\)\.map\(node=>\{\s*const id=node\.placement\.area,[^\n]*\s*return \{id,label:t\(node\.label\),icon:navIcons\[node\.icon\],shortcut:node\.shortcut\?\.keys\?\?'',\.\.\.\(node\.placement\.end\?\{placement:'end' as const\}:\{\}\)/,'the console rail reads the model');
const pages=navModel.navigatorPages('settings',{viewer:owner,multipleCustomers:true}).map(node=>({id:node.id,label:de(node.label),description:de(node.hint),icon:node.icon,group:de(node.placement.group)}));
assert.deepEqual(pages.map(page=>page.label),['Konten','Benutzergruppen','Rollen','Microsoft Entra ID','Sitzungen','Kunden','Erscheinungsbild','Benachrichtigungskanäle','Schwachstellenprüfung','KI-Assistent','Agent-Releases','Erweiterungen','Agent-Fehlersuche','Datenaufbewahrung','Audit-Protokoll','Nutzungsdaten'],'the German page labels');
assert.deepEqual(pages.map(page=>translate('en',navModel.navNode(page.id).label)),['Accounts','User groups','Roles','Microsoft Entra ID','Sessions','Customers','Branding','Notification channels','Vulnerability check','AI assistant','Agent releases','Extensions','Agent troubleshooting','Data retention','Audit log','Usage data'],'the English page labels');
assert.deepEqual(pages.find(page=>page.id==='settings.sessions'),{id:'settings.sessions',label:'Sitzungen',description:'Lege fest, wann Nodiverna inaktive Konten abmeldet und wann es erneut nach MFA fragt.',icon:'ShieldCheck',group:'Konten & Zugriff'});
assert.deepEqual(pages.find(page=>page.id==='settings.vulnerabilities'),{id:'settings.vulnerabilities',label:'Schwachstellenprüfung',description:'Finde installierte Software mit bekannten Schwachstellen auf deinen Geräten.',icon:'ShieldAlert',group:'Integrationen'});checks++;
assert.deepEqual(navModel.settingsGroups({viewer:owner,multipleCustomers:true}).map(({group,pages})=>[de(group),pages.length]),[['Konten & Zugriff',5],['Organisation',2],['Integrationen',3],['Agents',3],['System',3]],'the five group headings in German');
assert.deepEqual(navModel.settingsGroups({viewer:owner,multipleCustomers:true}).map(({group})=>translate('en',group)),['Accounts & access','Organization','Integrations','Agents','System'],'the five group headings in English');
assert.match(consoleSource,/\?<NavGroups label=\{navigatorTitle\} groups=\{settingsGroups\(navContext\)/);assert.equal(de(navModel.navTree.rail.find(node=>node.id==='settings').title),'Einstellungen');
assert.doesNotMatch(consoleSource,/label:'Zugriff'/);
const security=navModel.navNode('settings.sessions');
assert.deepEqual([navModel.areaCrumbOf(security),navModel.areaCrumbOf(navModel.navNode('automation.runbooks'))].map(de),['Einstellungen','Automation'],'Settings and Automation pages: the crumb button names the area, no crumbs');
assert.match(consoleSource,/areaCrumb=\{areaCrumb\?\{label:t\(areaCrumb\),expanded:drawerOpen,/,'aria-expanded follows the navigator overlay (drawerOpen)');
assert.deepEqual([security.palette.hint,navModel.paletteKeywords(security,de),security.icon],[['palette.hint.settings'],de('sessionSettings.paletteKeywords')+' einstellungen','ShieldCheck'],'palette hint, extra keyword (the hint in lower case) and page icon');assert.equal(de('palette.hint.settings'),'Einstellungen');
checks+=16;
// ui/styles/console.css: the end entry sits at the bottom, headings use tokens only.
const css=fs.readFileSync('ui/styles/console.css','utf8').replace(/\/\*[\s\S]*?\*\//g,'');
const rules=selector=>[...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([,selectors])=>selectors.split(',').some(part=>part.trim()===selector)).map(([,,body])=>body);
assert.ok(rules('.sdx-rail-item-end').some(body=>/margin-top:\s*auto/.test(body)),'.sdx-rail-item-end pushes the entry down');
assert.ok(rules('.sdx-navlist-heading').length>0,'a heading rule exists');
assert.ok(rules('.sdx-navlist-heading').every(body=>!/#[0-9a-f]{3,8}\b/i.test(body)&&/var\(--sd-muted\)/.test(body)),'headings are muted and use tokens only');
const railWidth=Number(css.match(/--sdx-rail:\s*(\d+)px/)?.[1]);
assert.ok(railWidth>76&&railWidth<=88,'the rail grows to at most 88px');
checks+=4;

// The crumb button takes no room and no Tab stop above 900px.
{
 const media=[...fs.readFileSync('ui/styles/console.css','utf8').replace(/\/\*[\s\S]*?\*\//g,'').matchAll(/@media \(max-width: 900px\) \{([\s\S]*?)\n\}/g)].map(([,body])=>body).join('\n');
 assert.ok(rules('.sdx-page-path-area').some(body=>/display:\s*none/.test(body)),'hidden by default');
 assert.match(media,/\.sdx-page-path-area \{ display: flex; \}/,'shown at 900px or narrower');
 checks+=2;
}

// The agent pages are settings pages of their own (Add device is a page under Devices, ui/devices/add-device/add-device.tsx).
// The console renders them without AgentsArea. Both get the page frame and render their own header (ui/shell/page-frame.ts):
// the console renders no PageHeader for any settings page, and no node flag decides it.
{
 assert.match(consoleSource,/\{agentTab==='agent-releases'&&page&&<AgentReleasesPage\s[^>]*frame=\{pageFrame\}\/>\}/,'the console renders Agent releases (with its plugin releases) with the page frame');
 assert.match(consoleSource,/\{agentTab==='agent-troubleshooting'&&page&&<AgentTroubleshootingPage\s[^>]*frame=\{pageFrame\}\/>\}/,'and Agent troubleshooting with the page frame; the page ends with its own uninstall card');
 assert.ok(!fs.existsSync('app/redesign/areas.tsx')&&!/AgentsArea|AgentUninstallation|<ReleasePanel |<PluginReleases /.test(consoleSource),'no AgentsArea, no separate release panel, plugin releases or uninstall guide in the console');
 assert.deepEqual(navModel.navNodes.filter(node=>'headerPrimary' in node).map(node=>node.id),[],'no node flag says which page owns its header');
 assert.doesNotMatch(consoleSource,/settingsHeader|headerPrimary/,'the console renders no settings page header of its own');
 checks+=5;
}

// help-panel.tsx: new titles; customers stays.
const help=loadModule('ui/shell/help-panel.tsx',{...i18nStubs,'@/ui/kit/kit':{Drawer:'Drawer',Kbd:'Kbd'},'@/ui/base/docs-base':loadModule('ui/base/docs-base.ts'),'@/ui/shell/console-shortcuts':loadModule('ui/shell/console-shortcuts.ts',{'@/ui/shell/nav-model':navModel}),'@/ui/shell/nav-model':navModel,'@/ui/base/health-score':loadModule('ui/base/health-score.ts',i18nStubs)});
const settingsTopic=page=>help.topicFor({view:'settings',page});
for(const page of ['accounts','user-groups','roles','audit'])assert.equal(settingsTopic(page).title,'Konten & Zugriff',page);
assert.equal(settingsTopic('sessions').title,'Sitzungen');
assert.equal(settingsTopic('retention').title,'Datenaufbewahrung');
assert.equal(settingsTopic('usage-data').title,'Nutzungsdaten');
assert.equal(settingsTopic('customers').title,'Kunden');
assert.ok(settingsTopic('audit').tips.includes('„Audit-Protokoll“ zeigt Anmeldungen und Änderungen an Konten und Rollen.'),'the audit tip names the Audit-Protokoll');
{const topic=settingsTopic('vulnerabilities');assert.deepEqual([topic.title,topic.tips.length,topic.docs.map(entry=>entry.file)],['Schwachstellenprüfung',3,['docs/software-vulnerabilities.md']],'the vulnerability check has its help topic');checks++;}
checks+=9;

// console-shortcuts.ts: G S opens the settings and is listed; G I is an unlisted alias.
const {shortcutList}=loadModule('ui/shell/console-shortcuts.ts',{'@/ui/shell/nav-model':navModel});
assert.equal(de(shortcutList.find(entry=>entry.keys.join(' ')==='G S')?.label),'Einstellungen');
assert.equal(shortcutList.find(entry=>entry.keys.join(' ')==='G I'),undefined,'G I is not listed');
assert.equal(navModel.goShortcutNode('i')?.id,'settings','G I still opens the settings');
assert.equal(shortcutList.find(entry=>entry.keys.join(' ')==='G E'),undefined,'no new shortcut');
checks+=4;

// No old area name left in app, lib, docs and tests (this file excluded).
const oldName='Identität & '+'Zugriff',self=path.resolve('tests/ui/shell/settings-navigation.mjs');
const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(item=>{const full=path.join(dir,item.name);return item.isDirectory()?item.name==='node_modules'?[]:walk(full):[full];});
const hits=['app','ui','lib','docs','tests'].flatMap(walk).filter(file=>path.resolve(file)!==self&&/\.(tsx?|mjs|js|md|css|json)$/.test(file)&&fs.readFileSync(file,'utf8').includes(oldName));
assert.deepEqual(hits,[],'old area name still in '+hits.join(', '));
checks++;

// UI-Rework 8: the Roles subtitle names what the page shows (T12, N20), and Help tip 1 of Accounts, User groups and Roles
// says where a role is assigned.
{
 const roles=navModel.navNode('settings.roles');
 assert.equal(roles.hint,'nav.settings.rolesHint','the Roles subtitle is its nav hint');
 assert.deepEqual([translate('en','nav.settings.rolesHint'),translate('de','nav.settings.rolesHint')],['A role is a set of permissions. Assign roles to accounts and user groups to decide what they can see and change.','Eine Rolle ist eine Sammlung von Berechtigungen. Weise Rollen Konten und Benutzergruppen zu, um festzulegen, was sie sehen und ändern dürfen.']);
 for(const id of ['settings.accounts','settings.user-groups','settings.roles'])assert.equal(navModel.navNode(id).help,'access',id+' opens the access help topic');
 assert.match(fs.readFileSync('ui/shell/help-panel.tsx','utf8'),/const accessTopic:TopicKeys=\{title:'help\.access\.title',tips:\['help\.access\.tip1',/,'tip 1 of the access topic');
 assert.deepEqual([translate('en','help.access.tip1'),translate('de','help.access.tip1')],["Assign a role from the menu of an account in “Accounts”. A role applies to all devices, a device group or one device.",'Weise eine Rolle über das Menü eines Kontos unter „Konten“ zu. Eine Rolle gilt für alle Geräte, eine Gerätegruppe oder ein Gerät.']);
 checks+=5;
}

console.log(`PASS settings navigation (${checks} checks): rail with kit tooltips and Einstellungen at the end, five settings groups, page Sitzungen, no crumbs but the crumb button on Settings and Automation pages, Agent releases and troubleshooting as pages without AgentsArea, the page frame for every settings page, palette, help, G S and texts.`);
