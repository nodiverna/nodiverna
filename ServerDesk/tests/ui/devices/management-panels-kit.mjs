// Hygiene of Management → Services, Windows Update, Storage, Network and System on the console kit
// (and, since slice 8, Accounts, Roles & features, Software, Drivers, Certificates and Autostart):
// the five panel files and disk-health.tsx use the kit only (no shadcn, no classic
// loading/notes/drawer, no native disabled+title reasons, no classic panel classes, no literal size or
// duration units, no glued "{reason}." sentences), their stylesheets use tokens on the 4px grid with
// selectors that have a user, the catalogs lost the fragment keys and gained the new sentences, and
// every networkActionReason call in app/ passes the viewer locale.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import {readFileSync,existsSync,readdirSync,statSync} from 'node:fs';
import path from 'node:path';
import {postcss,colorLiterals} from '../../support/theme-colors.mjs';
const en=(await import('../../../lib/i18n/messages/en.ts')).default,de=(await import('../../../lib/i18n/messages/de.ts')).default;
let checks=0;
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const read=file=>readFileSync(file,'utf8');
const withoutComments=text=>text.replace(/\/\*[\s\S]*?\*\//g,'').replace(/(^|[^:'"\\])\/\/[^\n]*/g,'$1');
const panels=['ui/devices/management/device-services.tsx','ui/devices/management/device-updates.tsx','ui/devices/management/storage-panel.tsx','ui/devices/management/device-network-panel.tsx','ui/devices/management/device-system.tsx'];
const files=[...panels,'ui/devices/hardware/disk-health.tsx'];

// ---- Kit only ----
for(const file of files){
 const source=withoutComments(read(file));
 ok(!/from '@\/components\/ui\//.test(source),`${file}: no shadcn import`);
 for(const name of ['LoadingSkeleton','CapabilityNote','ErrorNote','DetailDrawer'])ok(!new RegExp(`\\b${name}\\b`).test(source),`${file}: no ${name}`);
 ok(!/disabled=\{[^}]*\}[^>]*\btitle=\{/.test(source)&&!/\btitle=\{[^}]*\}[^>]*\bdisabled=\{/.test(source),`${file}: no native disabled with a title as the reason`);
 ok(!/className="[^"]*\b(panel|panel-heading|count-chip)\b/.test(source),`${file}: no classic panel classes`);
 // A unit as display text: after a number or a space ("512 MB", `${value} ms`) or alone ('GiB'); key names such as 'storage.wholeMiB' are not units.
 ok(!/["'`][^"'`\n]*(?:\d|\s|\})(?:MB|GB|GiB|MiB|ms)\b|["'`](?:GiB|MiB|MB|GB)["'`]/.test(source),`${file}: no literal size or duration units`);
 ok(!/\{reason\}\./.test(source),`${file}: no glued "{reason}." text`);
}
for(const file of panels)ok(/import \{[^}]*\bPanelUnavailable\b[^}]*\} from '@\/ui\/kit\/kit';/.test(read(file))||file==='ui/devices/management/device-network-panel.tsx'&&/PanelUnavailable/.test(read(file)),`${file}: one panel notice through PanelUnavailable`);
ok(/<SectionHead hideTitle /.test(read('ui/devices/management/device-services.tsx'))&&/<SectionHead hideTitle /.test(read('ui/devices/management/device-updates.tsx'))&&/<SectionHead hideTitle /.test(read('ui/devices/management/device-network-panel.tsx'))&&/<SectionHead hideTitle /.test(read('ui/devices/management/device-system.tsx')),'the panels with a head use SectionHead hideTitle');
// Every blocked reason of these panels comes from a full sentence; the helpers no longer return fragments.
for(const key of ['kit.unavailable.demo','kit.unavailable.revoked','management.blocked.manage','management.blocked.diagnose','management.blocked.readOnly','management.blocked.offline','management.blocked.unsupported','services.blocked.saving','services.blocked.modeUnconfirmed','services.blocked.gone','services.blocked.running','services.blocked.notStopped','services.blocked.disabled','services.blocked.notRunning','services.blocked.unknownAction','services.blocked.sameStartup','updates.blocked.updateAgent','updates.blocked.active','updates.csv.nothing','storage.blocked.jobRunning','storage.blocked.diskOffline','storage.blocked.diskReadOnly','storage.blocked.noFreeSpace','storage.blocked.noSizeRange','storage.blocked.protectedDisk','storage.blocked.protectedDiskReasons','storage.blocked.protectedPartition','storage.blocked.protectedPartitionReasons','network.noInventory','network.targetInvalid','network.blocked.running','system.blocked.scheduleUpdate','system.scheduled.notCollected','system.scheduled.syncing','system.configPending','storage.noRange'])for(const [name,catalog] of [['en',en],['de',de]])ok(typeof catalog[key]==='string'&&/\.$/.test(catalog[key]),`${name} ${key} is a full sentence`);

// ---- networkActionReason always gets the viewer locale in app/ ----
const walk=dir=>readdirSync(dir).flatMap(name=>{const file=path.join(dir,name);return statSync(file).isDirectory()?walk(file):/\.tsx?$/.test(name)?[file]:[];});
const calls=[];
for(const file of [...walk('app'),...walk('ui')]){
 const source=read(file);let at=source.indexOf('networkActionReason(');
 while(at>=0){
  if(!/import|function/.test(source.slice(Math.max(0,at-20),at))){
   let depth=0,commas=0,index=at+'networkActionReason'.length;
   for(;index<source.length;index++){const char=source[index];if('([{'.includes(char))depth++;else if(')]}'.includes(char)){depth--;if(depth===0)break;}else if(char===','&&depth===1)commas++;}
   calls.push({file,commas});
  }
  at=source.indexOf('networkActionReason(',at+1);
 }
}
ok(calls.length>=8,`the calls are found (${calls.length})`);
ok(calls.every(call=>call.commas>=2),'every call passes the locale (no defaultLocale fallback reaches the UI)');

// ---- The stylesheets ----
const sheets=['ui/devices/management/device-services.css','ui/devices/management/device-updates.css','ui/devices/management/storage.css','ui/devices/management/device-network-panel.css','ui/devices/management/device-system.css'];
const sources=[...walk('app'),...walk('ui')].map(read).join('\n');
const onGrid=value=>value.split(/\s+/).every(part=>!/^-?\d+(\.\d+)?px$/.test(part)||Number.parseFloat(part)%4===0);
for(const sheet of sheets){
 ok(existsSync(sheet),`${sheet} exists`);
 const text=read(sheet),root=postcss.parse(text);
 ok(colorLiterals(text).length===0&&!/rgba?\(|hsla?\(/.test(text),`${sheet}: no color literals`);
 ok(!/@keyframes/.test(text),`${sheet}: no own keyframes`);
 root.walkDecls(decl=>{
  if(['border-radius'].includes(decl.prop))ok(/^(0|var\(--sd-radius(-sm|-lg)?\))$/.test(decl.value),`${sheet} ${decl.parent.selector}: radius is a token`);
  if(decl.prop==='box-shadow')ok(/^(none|var\(--sd-shadow-(sm|md|lg)\))$/.test(decl.value),`${sheet} ${decl.parent.selector}: shadow is a token`);
  if(decl.prop==='font-size')ok(Number.parseFloat(decl.value)>=12,`${sheet} ${decl.parent.selector}: font-size ${decl.value} is at least 12px`);
  if(/^(padding|margin|gap|row-gap|column-gap)(-|$)/.test(decl.prop))ok(onGrid(decl.value),`${sheet} ${decl.parent.selector}: ${decl.prop} ${decl.value} is on the 4px grid`);
 });
 const classes=new Set([...text.matchAll(/\.(sdx-[\w-]+)/g)].map(match=>match[1]));
 for(const name of classes)ok(sources.includes(name),`${sheet}: .${name} has a user`);
 ok(![...classes].some(name=>/^sd-/.test(name))&&!/\.sd-(service|network|system|storage)|\.sdu-/.test(text),`${sheet}: no classic selectors`);
}
const tokens=read('tests/ui/styles/theme-tokens.mjs');
for(const sheet of sheets)ok(tokens.includes(`'${sheet}'`),`${sheet} keeps its theme-tokens entry`);

// ---- Catalogs: removed fragment keys, new sentences in both ----
const removed=['services.controlDisabled','services.changesUnavailable','network.readable','updates.eyebrow','system.confirmDescription','management.blocked.demo','diskHealth.notAvailable','services.blocked.readOnly','services.blocked.unsupported','network.blocked.management','network.blocked.unsupported','storage.blocked.permission','storage.blocked.agentUpdate','system.blocked.demo','system.blocked.offline','system.blocked.management','system.blocked.unsupported','network.savedConfig','network.export','updates.matching','updates.install.title','management.systemNav.identity','management.systemNav.tasks','management.nav.system','system.areas','system.section.overview'];
for(const key of removed)ok(!Object.hasOwn(en,key)&&!Object.hasOwn(de,key),`${key} is removed from both catalogs`);
const added=['services.readOnly','updates.readOnly','storage.readOnly','network.readOnly','system.readOnly','services.blocked.sameStartup','services.open','services.foot','services.meta','updates.csv.nothing','updates.csv.exported','updates.showUrgent','updates.showRestart','updates.foot','updates.hotfixes.foot','updates.hotfixes.title','updates.hotfixes.column','updates.tableLabel','storage.blocked.jobRunning','storage.blocked.diskOffline','storage.blocked.diskReadOnly','storage.blocked.noFreeSpace','storage.blocked.noSizeRange','storage.blocked.protectedDiskReasons','storage.blocked.protectedPartitionReasons','storage.diskSettings','storage.partitionsLabel','storage.minimum','storage.maximum','diskHealth.notReportedFoot','diskHealth.unknownErrors','network.exportReport','network.exported','network.noInventory','network.testDns','network.downloadResult','network.resultExported','network.overview','network.upOf','network.adapterMeta','network.targetInvalid','network.blocked.running','system.description','system.restartKpi','system.restartPending','system.restartNotRequired','system.lastStartKpi','system.pagefileDetail','system.powerTitle','system.driveOption','system.firewall.foot','system.tasks.foot','system.overview','system.scheduled.confirm','system.firewall.search','system.firewall.noMatch','system.tasks.search','system.tasks.noMatch','system.fieldRequired','management.confirm.device'];
for(const key of added)ok(Object.hasOwn(en,key)&&Object.hasOwn(de,key)&&JSON.stringify(en[key])!==JSON.stringify(de[key])||['storage.minimum','storage.maximum','network.adapterMeta','updates.hotfixes.column'].includes(key)&&Object.hasOwn(en,key)&&Object.hasOwn(de,key),`${key} is in both catalogs`);
ok(en['network.readOnly']==='You can still read the network settings.'&&de['network.readOnly']==='Die Netzwerkeinstellungen kannst du weiter lesen.','the network panel sentence');
ok(/\(MiB\)$/.test(en['management.param.initialMb'])&&/\(MiB\)$/.test(de['management.param.maximumMb']),'page file sizes say MiB');
ok(!/\\\\n/.test(JSON.stringify([en['services.confirm.description'],en['storage.confirm.description'],en['network.confirm.description'],en['management.review.domainAccount']]).replace(/\\n/g,'')),'no literal backslash-n in the English confirmation texts');
// ---- Slice 8: Accounts, Roles & features, Software, Drivers, Certificates and Autostart ----
const panels8=['ui/devices/management/device-accounts.tsx','ui/devices/management/roles-features.tsx','ui/devices/inventory/device-software.tsx','ui/devices/inventory/device-drivers.tsx','ui/devices/inventory/device-certificates.tsx','ui/devices/inventory/device-autostart.tsx'];
for(const file of panels8){
 const source=withoutComments(read(file));
 ok(!/from '@\/components\/ui\//.test(source),`${file}: no shadcn import`);
 ok(!/\bLoadingSkeleton\b|loading-skeleton/.test(source),`${file}: no LoadingSkeleton`);
 ok(!/className="(?:[^"]*\s)?(panel|panel-heading|count-chip)[\s"]/.test(source),`${file}: no classic panel classes`);
 ok(!/<table\b/.test(source),`${file}: no raw table`);
 ok(!/sdx-wrap-cell|sdx-loading|sdx-table-wrap/.test(source),`${file}: no anywhere-wrapping cell, old loader or raw table wrap`);
 ok(!/common\.demoBlocked|common\.reload|software\.offline/.test(source),`${file}: no reason without a period, no "Reload", no own offline notice`);
 ok(!/\bdisabled=\{/.test(source)&&!/\btitle=\{[^}]*\b(reason|blocked)\b/.test(source),`${file}: no native disabled, no title as the reason`);
 ok(!/variant=\{?['"]destructive/.test(source),`${file}: no solid red shadcn button`);
 ok(/<SectionHead hideTitle /.test(source),`${file}: SectionHead hideTitle`);
 // Autostart filters its list with one small Segmented (All, New, Suspicious; UI review slice 2). Roles & features and
 // Programs switch their views with one small Segmented beside the search (UI-Rework 13b): a view switch without a route.
 if(file==='ui/devices/inventory/device-autostart.tsx')ok((source.match(/<Segmented\b/g)||[]).length===1&&/<Segmented<Filter> label=\{t\('autostart\.title'\)\} size="sm"/.test(source),`${file}: one small Segmented, the list filter`);
 else if(file==='ui/devices/management/roles-features.tsx')ok((source.match(/<Segmented\b/g)||[]).length===1&&/<Segmented<Tab> size="sm" label=\{t\('roles\.label'\)\}/.test(source),`${file}: one small Segmented, the Roles/Features switch`);
 else if(file==='ui/devices/inventory/device-software.tsx')ok((source.match(/<Segmented\b/g)||[]).length===1&&/<Segmented<DeviceSoftwareTab> size="sm" label=\{t\('software\.title'\)\}/.test(source),`${file}: one small Segmented, the view switch`);
 else ok(!/<Segmented\b/.test(source),`${file}: no Segmented for views or filters`);
}
for(const file of ['ui/devices/management/device-accounts.tsx','ui/devices/management/roles-features.tsx','ui/devices/inventory/device-autostart.tsx'])ok((read(file).match(/<PanelUnavailable /g)||[]).length===1,`${file}: exactly one PanelUnavailable`);
for(const file of ['ui/devices/inventory/device-software.tsx','ui/devices/inventory/device-drivers.tsx','ui/devices/inventory/device-certificates.tsx'])ok(!read(file).includes('PanelUnavailable'),`${file}: no write action, no panel notice`);
ok(!/online:/.test(read('ui/devices/management/device-accounts.tsx').match(/unavailableReason\(\{[^}]*\}/)?.[0]??'online:')&&!/management:/.test(read('ui/devices/inventory/device-autostart.tsx').match(/unavailableReason\(\{[^}]*\}/)?.[0]??'management:'),'Accounts: no online input; Autostart: no management input');
for(const file of ['ui/devices/inventory/device-software.tsx','ui/devices/inventory/device-drivers.tsx','ui/devices/inventory/device-autostart.tsx'])ok(/common\.retry/.test(read(file))&&/<Skeleton variant="table" label=\{t\('[\w.]+'\)\} after=\{15000\}/.test(read(file)),`${file}: Skeleton with after and "Try again"`);
ok(!/<Tabs\b|role="tabpanel"|'tabpanel'/.test(read('ui/devices/management/roles-features.tsx'))&&!/<Tabs\b|role="tabpanel"/.test(read('ui/devices/inventory/device-software.tsx')),'Roles/Features and the Software views switch with a Segmented, no underline Tabs or tabpanel');
ok(/danger:true/.test(read('ui/devices/management/roles-features.tsx'))&&/variant="danger"/.test(read('ui/devices/management/device-accounts.tsx'))&&/danger:true/.test(read('ui/devices/management/device-accounts.tsx')),'destructive buttons are kit danger Btns, destructive menu entries danger');
ok(!existsSync('app/management-panel.tsx')&&!read('eslint.config.mjs').includes('management-panel'),'the classic ManagementPanel and its lint override are gone');
const device8=read('ui/devices/device/device.tsx');
ok(!device8.includes('ManagementPanel')&&/management==='accounts'\?<DeviceAccounts /.test(device8)&&/management==='features'\?<RolesFeatures /.test(device8),'device.tsx renders DeviceAccounts and RolesFeatures');

const sheets8=['ui/devices/management/device-accounts.css','ui/devices/management/roles-features.css','ui/devices/inventory/health-signals.css'];
for(const sheet of sheets8){
 const text=read(sheet),root=postcss.parse(text);
 ok(colorLiterals(text).length===0&&!/rgba?\(|hsla?\(/.test(text),`${sheet}: no color literals`);
 ok(!/@keyframes/.test(text),`${sheet}: no own keyframes`);
 root.walkDecls(decl=>{
  if(decl.prop==='border-radius')ok(/^(0|var\(--sd-radius(-sm|-lg)?\))$/.test(decl.value),`${sheet} ${decl.parent.selector}: radius is a token`);
  if(decl.prop==='box-shadow')ok(/^(none|var\(--sd-shadow-(sm|md|lg)\))$/.test(decl.value),`${sheet} ${decl.parent.selector}: shadow is a token`);
  if(decl.prop==='font-size')ok(Number.parseFloat(decl.value)>=12,`${sheet} ${decl.parent.selector}: font-size ${decl.value} is at least 12px`);
  if(/^(padding|margin|gap|row-gap|column-gap)(-|$)/.test(decl.prop))ok(onGrid(decl.value),`${sheet} ${decl.parent.selector}: ${decl.prop} ${decl.value} is on the 4px grid`);
  if(decl.prop==='overflow-wrap'&&/sdx-path/.test(decl.parent.selector))ok(decl.value==='break-word',`${sheet} ${decl.parent.selector}: paths break only at separators`);
 });
 const classes=new Set([...text.matchAll(/\.(sdx-[\w-]+)/g)].map(match=>match[1]));
 for(const name of classes)ok(sources.includes(name),`${sheet}: .${name} has a user`);
 ok(!/\.rf-|\.sd-|\.operation-|\.management-/.test(text),`${sheet}: no classic selectors`);
}
for(const sheet of ['ui/devices/management/device-accounts.css','ui/devices/management/roles-features.css'])ok(tokens.includes(`'${sheet}'`)||sheet==='ui/devices/management/device-accounts.css',`${sheet}: theme-tokens entry where the list names it`);
for(const name of ['management-workspace','management-nav','management-context','operation-dialog','operation-field','operation-fields','operation-secret-note','operation-toggle','network-grid','network-panel','management-table-actions','management-card-actions','management-toolbar','power-actions','instruction-panel'])ok(!new RegExp(`\\.${name}(?![\\w-])`).test(read('app/globals.css')+read('ui/styles/classic-console.css')),`the classic .${name} selector is gone`);
ok(!/\.operation-confirmation|\.chart-empty(?![\w-])/.test(read('app/globals.css')+read('ui/styles/classic-console.css'))&&/\.table-sub/.test(read('app/globals.css')+read('ui/styles/classic-console.css')),'the classic classes without a user are gone (operation-confirmation, chart-empty; tests/ui/kit/frame-cleanup.mjs checks every class), table-sub with its users stays');

const added8=['accounts.description','accounts.metaUsers','accounts.metaGroups','accounts.readOnly','accounts.kpi.users','accounts.kpi.active','accounts.kpi.disabled','accounts.showDisabled','accounts.kpi.admins','accounts.kpi.adminsDetail','accounts.kpi.groups','accounts.rowActions','accounts.menu.edit','accounts.menu.password','accounts.menu.delete','accounts.confirm.create','accounts.confirm.edit','accounts.confirm.password','accounts.confirm.delete','accounts.confirm.addMember','accounts.confirm.removeMember','accounts.title.create','accounts.title.edit','accounts.title.password','accounts.title.delete','accounts.title.addMember','accounts.title.removeMember','accounts.foot','accounts.noMatch','accounts.clearSearch','accounts.blocked.noUsersOrGroups','roles.description','roles.metaInstalled','roles.readOnly','roles.tab.features','roles.roleServices','roles.subfeatures','roles.install','roles.drawer.install','roles.drawer.remove','roles.title.install','roles.title.remove','drivers.listTitle','certificates.listTitle','certificates.kpi.expired','certificates.kpi.expiring','certificates.kpi.valid','autostart.listTitle','autostart.readOnly','autostart.col.program','autostart.status.confirmedShort','autostart.open','autostart.firstSeen','software.loading','drivers.loading','autostart.loading','autostart.tableLabel'];
for(const key of added8)ok(Object.hasOwn(en,key)&&Object.hasOwn(de,key)&&(JSON.stringify(en[key])!==JSON.stringify(de[key])||['roles.tab.features'].includes(key)),`${key} is in both catalogs`);
ok(en['roles.roleServices'].other==='{installed} of {count} role services installed'&&de['roles.roleServices'].other==='{installed} von {count} Rollendiensten installiert','the count names its unit');
const removed8=['roles.components','management.banner.demo','management.banner.readAccess','management.banner.offline','management.banner.readOnly','management.nav.server','software.offline','management.category.features','management.category.accounts','management.category.updates','management.changeButton','management.power.title','management.test.title','management.updates.title','management.network.noInventory','management.pagefile.isAutomatic'];
for(const key of removed8)ok(!Object.hasOwn(en,key)&&!Object.hasOwn(de,key),`${key} is removed from both catalogs`);
console.log(`PASS management panels on the kit (${checks} checks): kit-only sources without classic parts, literal units or glued reasons, full-sentence reasons, networkActionReason with the locale, token-only stylesheets on the 4px grid with used selectors, and the catalog changes, for the slice 7 and slice 8 panels.`);
