// Source, stylesheet and catalog scan of the Automation, History, Alert rules and Permissions views on the
// console kit: no classic parts in the panel files, the assignments view of RbacPanel on kit parts only,
// token-only stylesheets on the 4px grid with used selectors, the new and removed catalog keys, and one
// German term ("Sollkonfiguration") for Desired State.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import '../../support/register.mjs';
import {postcss} from '../../support/theme-colors.mjs';
const {default:en}=await import('../../../lib/i18n/messages/en.ts');
const {default:de}=await import('../../../lib/i18n/messages/de.ts');
const {default:deServer}=await import('../../../lib/i18n/messages/de-server.ts');
let checks=0;
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const read=file=>fs.readFileSync(file,'utf8');

// ---- Panel sources: kit only ----
const panels=['ui/automation/runbook-panel.tsx','ui/automation/runbook-editor.tsx','ui/automation/desired-state-panel.tsx','ui/automation/desired-state-components.tsx','ui/automation/drift-panel.tsx','ui/automation/drift-overview.tsx','ui/devices/history/history.tsx','ui/devices/monitoring/alert-rules.tsx'];
const classic=['@/components/ui/','LoadingSkeleton','DetailDrawer','ErrorNote','CapabilityNote','window.confirm','<table','className="panel','v3-empty','ds-empty','v3-panel-tabs','ds-tabs','sdx-loading','common.demoBlocked','variant="destructive"'];
for(const file of panels){
 const source=read(file);
 for(const part of classic)ok(!source.includes(part),`${file}: no ${part}`);
 ok(!/disabled=\{[^}]*\}\s*title=/.test(source)&&!/title=\{[^}]*\}\s*disabled=/.test(source),`${file}: no native disabled with a title as the reason`);
 ok(!/<Button\b|<Input\b|<Dialog\b/.test(source),`${file}: no shadcn controls`);
}
// The device view loads Unavailable through the one helper with the inputs of the spec.
const runbooks=read('ui/automation/runbook-panel.tsx'),desired=read('ui/automation/desired-state-panel.tsx'),drift=read('ui/automation/drift-panel.tsx');
ok(/unavailableReason\(\{demo,revoked:!!device\?\.revoked,permitted:!!device&&\['runbooks\.read','runbooks\.execute','runbooks\.manage'\]\.some\(right=>permitted\(device,viewer,right\)\),reported:!!device\?\.snapshot,supported:!!device&&v3\(device\)\}\):demo\?'demo':null/.test(runbooks),'Runbooks: demo, revoked, the three rights, reported, v3; library scope only demo');
ok(/unavailableReason\(\{demo,revoked:!!scopeDevice\?\.revoked,permitted:!!scopeDevice&&permitted\(scopeDevice,viewer,'desired\.read'\),reported:!!scopeDevice\?\.snapshot,supported:true\}\):demo\?'demo':null/.test(desired),'Desired State: desired.read, supported true');
ok(/unavailableReason\(\{demo,revoked:!!server\.revoked,permitted:permitted\(server,viewer,'drift\.read'\)\|\|permitted\(server,viewer,'drift\.manage'\),reported:!!server\.snapshot,supported:v3\(server\)\}\)/.test(drift)&&/const enabled=!reason,/.test(drift)&&!/v3\(server\)&&!demo/.test(drift),'Drift: the reason decides, enabled has no hidden demo check');
for(const [file,source] of [['runbook-panel',runbooks],['desired-state-panel',desired],['drift-panel',drift]])ok(/<SectionHead title=\{t\('device\.section\.(runbooks|desired|drift)'\)\} hideTitle/.test(source),`${file}: SectionHead hideTitle with the tab label`);
ok(read('ui/devices/monitoring/alert-rules.tsx').includes("<AnalysisTab title={t('alertRules.title')} description={t('alertRules.meta')}"),'Alert rules: the shared AnalysisTab frame with the hidden section label');
// Every on/off field is a switch; checkboxes only pick list items.
for(const file of ['ui/automation/runbook-panel.tsx','ui/automation/drift-panel.tsx','ui/automation/desired-state-panel.tsx']){
 const boxes=[...read(file).matchAll(/<input type="checkbox"([^>]*)>/g)].map(match=>match[1]);
 ok(boxes.every(attributes=>attributes.includes('role="switch"')||/checked=\{(targets\.includes|!targetReason&&targets\.includes|policy\.config\.includes)/.test(attributes)),`${file}: checkboxes only for target or source lists, else role="switch"`);
}

// ---- The Permissions view (ui/devices/configuration/permissions-tab.tsx) and the Settings pages render kit parts only ----
const assignments=read('ui/devices/configuration/permissions-tab.tsx');
for(const part of ['<Button','<Input','<table','ErrorNote','sd-rbac-table','sd-access-empty','sd-rbac-scope-summary','rbac.permissionsTitle','<IconBtn','<select'])ok(!assignments.includes(part),`assignments view: no ${part}`);
for(const part of ['<AnalysisTab','<Toolbar','<Card','<DataTable','<ConfirmDialog','<Drawer','<Unavailable','rbacBody(','<Menu','<Select'])ok(assignments.includes(part),`assignments view: ${part}`);
// The body states of the access views (FirstLoad, LoadFailed, Unavailable) live in the one ladder they share.
{const ladder=read('ui/settings/rbac-body.tsx');for(const part of ['<FirstLoad','<LoadFailed','<Unavailable'])ok(ladder.includes(part),`access body ladder: ${part}`);}
for(const file of ['ui/settings/settings-accounts.tsx','ui/settings/settings-user-groups.tsx','ui/settings/settings-roles.tsx'])ok(!/<table|<select|components\/ui\/|ErrorNote|sd-access-loading|sd-rbac-/.test(read(file)),`${file}: no classic table, select, shadcn part, ErrorNote or old class`);
ok(!read('ui/base/api.tsx').includes('CapabilityNote')&&!read('ui/devices/remote/rdp-panel.tsx').includes('ErrorNote'),'CapabilityNote is gone; the RDP panel has no ErrorNote');

// ---- Stylesheets: tokens, 4px grid, fonts >= 12px, no keyframes, used selectors ----
const sources=['app','ui'].filter(dir=>fs.existsSync(dir)).flatMap(function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{const full=path.join(dir,entry.name);return entry.isDirectory()?walk(full):/\.tsx?$/.test(entry.name)?[read(full)]:[];});}).join('\n');
const spacing=/^(padding|margin|gap|row-gap|column-gap)(-(top|right|bottom|left|inline|block)(-(start|end))?)?$/;
for(const file of ['ui/automation/drift.css','ui/automation/desired-state.css','ui/automation/runbooks.css']){
 const css=read(file),tree=postcss.parse(css);
 ok(!/#[0-9a-f]{3,8}\b/i.test(css.replace(/\/\*[\s\S]*?\*\//g,''))&&!/rgba?\(/.test(css),`${file}: no hex or rgb values`);
 let keyframes=0;const small=[],grid=[],radius=[],unused=new Set();
 tree.walkAtRules('keyframes',()=>{keyframes++;});
 tree.walkDecls(decl=>{
  const px=[...decl.value.matchAll(/(-?[\d.]+)px/g)].map(match=>Number(match[1]));
  if(decl.prop==='font-size'&&px.some(value=>value<12))small.push(decl.toString());
  if(spacing.test(decl.prop)&&px.some(value=>value%4!==0))grid.push(decl.toString());
  if(decl.prop==='border-radius'&&!/^(var\(--sd-radius(?:-sm|-lg)?\)|99px|0)$/.test(decl.value))radius.push(decl.toString());
 });
 tree.walkRules(rule=>{for(const name of rule.selector.match(/\.([a-z][\w-]*)/g)??[]){const cls=name.slice(1);if(!sources.includes(cls))unused.add(cls);}});
 check([keyframes,small,grid,radius,[...unused]],[0,[],[],[],[]],`${file}: no keyframes, fonts >= 12px, spacing on the 4px grid, token radii, every class used`);
}
const tokens=read('tests/ui/styles/theme-tokens.mjs');
for(const name of ['drift.css','desired-state.css'])ok(tokens.includes(`'ui/automation/${name}'`)&&fs.existsSync('ui/automation/'+name),`${name} stays in theme-tokens`);
const consoleCss=read('ui/styles/classic-console.css'),redesignCss=read('ui/styles/console.css');
ok(!/rb-editor|v3-runbook/.test(consoleCss)&&!read('ui/styles/classic-forms.css').includes('v3-runbook-editor'),'the classic runbook editor rules are gone');
ok(!redesignCss.includes('sdx-alert-rules-head')&&!read('ui/devices/inventory/health-signals.css').includes('sdx-alert-limit-cell'),'the old alert rule head and limit cell rules are gone');

// ---- Catalogs ----
const added=['automation.busy','runbooks.description.device','runbooks.description.library','runbooks.unavailable.right','runbooks.catalogTitle','runbooks.blocked.manage','runbooks.blocked.redacted','runbooks.blocked.noTargets','runbooks.blocked.preview','runbooks.blocked.precondition','runbooks.blocked.scheduleOff','runbooks.blocked.nameRequired','runbooks.rowActions','runbooks.menu.prepare','runbooks.menu.newVersion','runbooks.menu.delete','runbooks.menu.output','runbooks.menu.stop','runbooks.start','runbooks.runConfirmBody','runbooks.line.runbook','runbooks.line.version','runbooks.line.devices','runbooks.noneHint','runbooks.noRunsHint','runbooks.noSchedulesTitle','runbooks.noSchedulesHint','desired.unavailable.demo','desired.blocked.consent','desired.blocked.noTargets','desired.noRunsHint','desired.line.configuration','drift.description','drift.blocked.manage','drift.blocked.incomplete','drift.blocked.outdated','drift.blocked.alreadyBaseline','drift.blocked.saveFirst','drift.panel.copyToGroup','drift.panel.copyTitle','drift.panel.copyBody','drift.panel.acceptTitle','drift.panel.acceptBody','drift.panel.removePath','drift.line.scan','drift.changesTitle','history.access.noneDevice','history.access.noneDeviceHint','history.access.noneHint','history.access.foot','rbac.assignments.description.device','rbac.assignments.description.group','rbac.assignments.description.global','rbac.direct','rbac.assignments.noDirectHint','rbac.assignments.noneHereHint','rbac.assignments.noneHint','rbac.removeAssignment.body','rbac.removeAssignment.confirm','rbac.line.subject'];
for(const key of added)ok(Object.hasOwn(en,key)&&Object.hasOwn(de,key),`${key} in en and de`);
const removed=['desired.needsAgent','runbooks.demo','runbooks.noSchedules','drift.panel.copyConfirm','drift.panel.acceptConfirm','rbac.permissionsTitle','rbac.scopeHint.global','rbac.scopeHint.group','rbac.scopeHint.device','common.capability.unavailable','common.capability.noData'];
for(const key of removed)ok(!Object.hasOwn(en,key)&&!Object.hasOwn(de,key),`${key} is removed`);
const mixed=Object.entries({...de,...deServer}).filter(([,value])=>JSON.stringify(value).match(/Desired[ -]State/)).map(([key])=>key);
check(mixed,[],'no German value says "Desired State" or "Desired-State"');
check([de['device.section.desired'],de['nav.automation.desired']],['Sollkonfiguration','Sollkonfiguration'],'the German name is "Sollkonfiguration"');
check([en['device.section.desired'],en['nav.automation.desired']],['Desired State','Desired State'],'English keeps "Desired State"');
const fixture=JSON.parse(read('tests/fixtures/server-messages-de.json'));
check(Object.entries(fixture).filter(([,value])=>/Desired[ -]State/.test(value)).map(([key])=>key),[],'the server message fixture follows the German texts');
check(de['apiError.desired.runNotFound'],'Der Lauf der Sollkonfiguration wurde nicht gefunden. Lade die Seite neu.','a genitive instead of a hyphenated mix');
console.log(`PASS automation panels kit (${checks} checks): kit-only panel sources, the kit assignments view, token-only stylesheets on the 4px grid with used selectors, the catalog changes and one German term for Desired State.`);
