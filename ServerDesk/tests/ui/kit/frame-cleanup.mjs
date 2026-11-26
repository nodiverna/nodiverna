// The kit-only console after the UI clean-up (UI-Rework 16). Static checks only, no browser, over all of app/ and ui/:
// - every .ts and .tsx file under app/ and ui/ follows one classic rule set: no shadcn
//   components/ui, LoadingSkeleton, DetailDrawer, ErrorNote, classic loading look, window.confirm, local Fact, classic
//   .panel, Reload label or native disabled with a title (blocked carries the reason);
// - every stylesheet under app/ and ui/ has token radii, no shadcn data-slot or data-variant selector, no classic class rule and
//   no class that nobody renders (only third-party classes from the named list below);
// - the shadcn toolchain, the classic helpers and the dead files are gone, and so are their message keys;
// - one console h1 and one input halo, the classic-panels.css header, the flat job dock bar and the gradient places, a
//   required confirmLabel, the device panel walk (selects, row actions, hand parts) and the German Du-Form copy with
//   one retry label.
import '../../support/register.mjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {classUsage,deadClasses,cssRules,selectorClasses,selectorParts,walk,withoutComments} from '../../support/class-usage.mjs';

const read=file=>fs.readFileSync(file,'utf8');
const lineOf=(text,index)=>text.slice(0,index).split('\n').length;
let checks=0;

// ---- radii as tokens in every stylesheet under app/ and ui/ ----
const stylesheets=[...walk('app'),...walk('ui')].filter(file=>file.endsWith('.css'));
const radiusPart=/^(?:var\(--sd-radius(?:-sm|-lg)?\)|99px|999px|50%|0|inherit)$/;
const literals=[];
// Custom-property declarations (--sd-radius-sm: 8px) are definitions, not uses, so the lookbehind skips them.
const radiusLiterals=css=>{const found=[];for(const match of withoutComments(css).matchAll(/(?<![\w-])border(?:-[a-z]+)*-radius\s*:\s*([^;}]+)/g)){const value=match[1].trim().replace(/\s*!important$/,'');if(value.split(/\s+(?![^(]*\))/).some(part=>!radiusPart.test(part)))found.push({value,index:match.index});}return found;};
// The loop runs the same radiusLiterals that the self-check below tests (comments are blanked line by line, so the index keeps its line).
for(const file of stylesheets){const css=read(file);for(const {value,index} of radiusLiterals(css))literals.push(`${file}:${lineOf(css,index)} ${value}`);}
assert.deepEqual(literals,[],'every radius in every stylesheet under app/ and ui/ is a --sd-radius token, a pill (99px/999px), 50%, 0 or inherit');
assert.ok(stylesheets.length>=45&&stylesheets.includes('ui/styles/classic-forms.css')&&stylesheets.includes('ui/kit/suggest-input.css')&&stylesheets.includes('app/globals.css'),'the radius rule walks every stylesheet under app/ and ui/');
// The rule itself: a literal is found, a token, a pill and a custom-property definition are not.
assert.deepEqual(radiusLiterals('.a{border-radius:7px}.b{border-top-left-radius:var(--sd-radius-sm) 13px}.c{border-radius:var(--sd-radius-lg)}.d{border-radius:99px}:root{--sd-radius-sm:8px}').map(item=>item.value),['7px','var(--sd-radius-sm) 13px']);
checks+=3;
assert.doesNotMatch(read('app/globals.css'),/--sd-radius-(?!sm\b|lg\b)[\w-]+\s*:/,'no new radius token');checks++;
// This guard runs the shared helpers and the tested rule: no local copy of walk, withoutComments or selectorParts,
// no inline copy of the radius rule, and no panelSheets orphan check (the dead-class check below covers every sheet).
{
 const self=read('tests/ui/kit/frame-cleanup.mjs');
 assert.ok(!/const (walk|withoutComments|selectorParts)=/.test(self),'walk, withoutComments and selectorParts come from tests/support/class-usage.mjs');
 assert.ok(!self.includes('const panel'+'Sheets')&&!self.includes('panel'+'Sheets.flatMap'),'the panelSheets orphan check is gone');
 assert.equal(self.split('border(?:-[a-z]+)*'+'-radius').length-1,1,'the radius regex lives only in radiusLiterals');
 checks+=3;
}
// The sparkline's data color is the shared chartSeries, not a second 'var(--sd-meter)' literal in the kit.
{const kitSource=read('ui/kit/kit.tsx');assert.ok(kitSource.includes("import {chartSeries} from '@/ui/kit/chart';")&&kitSource.includes('normal:chartSeries')&&!kitSource.includes("'var(--sd-meter)'"),'kit.tsx imports chartSeries for sparklineStroke.normal');checks++;}
// Kit controls share --sd-radius-sm; menus, popovers and the select picker use a larger token.
const redesign=read('ui/styles/console.css');
const ruleOf=(css,selector)=>{const start=css.indexOf(selector+' {');assert.ok(start>=0,`rule ${selector}`);return css.slice(start,css.indexOf('}',start));};
for(const selector of ['.sdx-menu .sdx-btn',':is(.sdx, .sdx-layer) .sdx-select'])assert.match(ruleOf(redesign,selector),/border-radius: var\(--sd-radius-sm\)/,selector+' uses --sd-radius-sm');
checks+=2;

// ---- one console h1 and one input halo ----
const consoleScope=/(?:^|[\s,(])(?:\.sd-console|\.sdx|:is\(\.sdx|\.sdx-layer)\b/;
const h1Rules=[];
for(const file of [...walk('app'),...walk('ui')].filter(file=>file.endsWith('.css'))){
 const css=withoutComments(read(file));
 for(const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)){
  const [,selector,body]=match;
  if(!/\bh1\b/.test(selector)||!/font-(?:size|weight)\s*:/.test(body))continue;
  for(const part of selectorParts(selector).filter(item=>/\bh1\b/.test(item)))if(consoleScope.test(part))h1Rules.push(`${file} ${part.replace(/\s+/g,' ')}`);
 }
}
assert.deepEqual([...new Set(h1Rules)],['ui/styles/console.css :is(.sdx, .sdx-layer) .sdx-page-line h1'],'exactly one console rule sets the size and weight of h1');
assert.match(ruleOf(redesign,':is(.sdx, .sdx-layer) .sdx-page-line h1'),/font-size: 24px; font-weight: 680;[^}]*letter-spacing: -\.6px/,'24px/680 with -.6px');
assert.match(redesign,/:is\(\.sdx, \.sdx-layer\) \.sdx-page-line h1 \{ font-size: 21px; \}/,'its ≤900px variant at 21px');
for(const file of ['ui/styles/classic-console.css','ui/styles/classic-panels.css'])assert.doesNotMatch(read(file),/\.sd-console h1\b|\.sd-page-heading|\.sd-device-header/,file+' has no .sd-console h1 rule and no dead heading rule');
assert.match(read('ui/styles/classic-console.css'),/\.sd-console :is\(h1, h2, h3, p\) \{ margin: 0; \}/,'the margin reset stays');checks+=6;
const design=read('ui/styles/classic-panels.css');
assert.doesNotMatch(design,/0 0 0 4px color-mix\(in srgb, ?var\(--sd-accent\)/,'no 4px accent halo');
assert.match(design,/textarea\):focus-visible \{[^}]*box-shadow: 0 0 0 3px color-mix\(in srgb, var\(--sd-accent\) 18%, transparent\);/,'classic inputs use the kit halo');checks+=2;

// ---- the classic-panels.css header ----
const header=design.slice(0,design.indexOf('*/')+2);
assert.ok(design.startsWith('/*'),'the file starts with its header comment');
assert.doesNotMatch(header,/\bblue\b|loaded after every|Loaded after every|loads last/i,'no blue accent and no "loads last" claim');
assert.match(header,/classic-console\.css → classic-panels\.css → console\.css/,'the real load order');
assert.match(header,/violet Aurora accent\s+--sd-accent/,'the violet Aurora accent');
for(const word of ['surfaces','controls','switches','embedded classic panels'])assert.ok(header.includes(word),'the header says what the file holds: '+word);
assert.doesNotMatch(withoutComments(design)===design?'':design.match(/\/\*[\s\S]*?\*\//g).join(' '),/\bblue\b/i,'no comment calls the accent blue');
const consoleSource=read('ui/shell/console.tsx'),order=['@/ui/styles/classic-console.css','@/ui/styles/classic-panels.css','@/ui/styles/console.css'].map(file=>consoleSource.indexOf(`import '${file}';`));
assert.ok(order.every(index=>index>=0)&&order[0]<order[1]&&order[1]<order[2],'the comment matches the imports in console.tsx');checks+=9;

// ---- no dead class in any stylesheet under app/ and ui/ ----
// A class selector needs a user: a class literal in a .ts or .tsx file under app/, ui/ or lib/, or the static
// prefix of a class built from a literal and a value (tests/support/class-usage.mjs). Third-party classes, by library:
const thirdPartyClasses=[
 /^xterm/, // @xterm/xterm: the terminal canvas (ui/devices/remote/terminal.css, ui/styles/classic-forms.css)
 /^recharts-/, // recharts: the chart surfaces
];
const rendered=classUsage(thirdPartyClasses);
const dead=stylesheets.flatMap(file=>deadClasses(read(file),rendered).map(({name,line})=>`${file}:${line} .${name}`));
assert.deepEqual([...new Set(dead)],[],'every class selector in every stylesheet under app/ and ui/ has a user');
// The check itself: planted unused classes are reported; a class literal, a prefix-built class and a third-party class are not.
const planted='.sdx-planted-unused-class { color: red; } .sdx-card { color: red; } .sdx-icon-tile-accent { color: red; } .xterm-screen { color: red; } :is(.sdx-card, .sdx-planted-other) p { color: red; }';
assert.deepEqual(deadClasses(planted,rendered).map(item=>item.name),['sdx-planted-unused-class','sdx-planted-other'],'the dead-class check reports planted unused classes');
assert.deepEqual(selectorClasses('.a:not(.b) [data-x=".c"] :is(.d, .e)'),['a','b','d','e'],'classes inside :not() and :is() count, attribute values do not');
assert.ok(stylesheets.length>=45,'the check walks every stylesheet');checks+=4;
const shell=['sd-sidebar','sd-sidebar-profile','sd-topbar','sd-topbar-end','sd-jobbar','sd-global-nav','sd-brand','sd-search-trigger','sd-fleet-summary','sd-content','sd-subnav','sd-device-route-subnav','sd-status','sd-nav-group-label','sd-add-device-link','sd-column-options','sd-health','sd-snapshot-note','sd-shell','sd-main','sd-page-heading','sd-device-header','sd-device-layout','sd-device-nav','sd-device-body','sd-device-overview','sd-device-row-actions','sd-fleet-table','sd-fleet-tools','sd-fleet-actions','sd-event-table','sd-drawer','sd-jobs-panel','sd-account','sd-scope-picker','sd-table-sort','sd-job-state'];
for(const file of ['ui/styles/classic-console.css','ui/styles/classic-panels.css','ui/styles/motion.css']){const css=withoutComments(read(file));for(const name of shell)assert.doesNotMatch(css,new RegExp(`\\.${name}(?![\\w-])`),`${file} has no .${name}`);}
checks+=shell.length*3;
// The classic section tabs are gone: every page and device view navigates with the kit Tabs.
assert.deepEqual([...walk('app'),...walk('ui')].filter(file=>/\.(tsx?|css)$/.test(file)&&read(file).includes('sd-section-tabs')),[],'no file in app/ or ui/ renders or styles sd-section-tabs');checks++;

// ---- no classic class and no shadcn selector in any stylesheet; no classic class rendered ----
// The classic surfaces, notices, empty states, loading looks, drawer, access workspace, agent guide, paused RDP panel and ring.
const classicClasses=[/^panel$/,/^panel-heading$/,/^notice$/,/^v3-note$/,/^v3-empty$/,/^sd-detail-/,/^sd-access-/,/^sd-identity-tabs$/,/^sd-agent-guide/,/^sd-rdp-paused/,/^sd-skeleton-bar$/,/^sdx-loading$/,/^sdx-skeleton$/,/^sdx-ring/];
const classicCss=stylesheets.flatMap(file=>cssRules(read(file)).flatMap(rule=>selectorClasses(rule.selector).filter(name=>classicClasses.some(pattern=>pattern.test(name))).map(name=>`${file} .${name}`)));
assert.deepEqual([...new Set(classicCss)],[],'no stylesheet under app/ or ui/ has a rule for a classic class');
const shadcnSelectors=stylesheets.flatMap(file=>cssRules(read(file)).filter(rule=>/\[data-(?:slot|variant)\b/.test(rule.selector)).map(rule=>`${file}:${lineOf(read(file),rule.index)} ${rule.selector}`));
assert.deepEqual(shadcnSelectors,[],'no stylesheet under app/ or ui/ has a [data-slot] or [data-variant] selector');
const classAttributes=source=>[...source.matchAll(/className=(?:"([^"]*)"|\{'([^']*)'\}|\{`([^`$]*))/g)].flatMap(match=>(match[1]??match[2]??match[3]).split(/\s+/)).filter(Boolean);
const classicRendered=[...walk('app'),...walk('ui')].filter(file=>file.endsWith('.tsx')).flatMap(file=>classAttributes(read(file)).filter(name=>classicClasses.some(pattern=>pattern.test(name))).map(name=>`${file} ${name}`));
assert.deepEqual(classicRendered,[],'no .tsx under app/ or ui/ renders a classic class');
assert.deepEqual(classAttributes('<a className="panel x"/><b className={\'sdx-loading\'}/><c className={`notice ${tone}`}/>'),['panel','x','sdx-loading','notice'],'the class attribute reader');
checks+=4;

// ---- the job dock bar without the gradient; the gradient places ----
assert.match(ruleOf(redesign,'.sdx-dock-progress i'),/background: var\(--sd-accent\); animation: sdx-progress 1\.4s var\(--sd-ease-out\) infinite;/,'flat accent, the same sdx-progress loop');
assert.match(read('ui/styles/motion.css'),/\.sdx-dock-progress i,/,'the reduced-motion rule keeps the bar');checks+=2;
const allowedGradient=[/\.sdx-btn-primary\b/,/\[role="switch"\]:checked/,/\.drift-switch\[aria-checked="true"\]/,/\.sdx-menu-switch\[data-state="checked"\]/,/\.sd-palette-results button\[aria-selected="true"\]/,/\.sdx-logo\b/,/\.sd-session-brand\b/];
const gradientUses=[];
for(const file of stylesheets.filter(file=>file!=='app/globals.css')){
 const css=withoutComments(read(file));
 for(const match of css.matchAll(/([^{}]+)\{([^{}]*--sd-accent-grad[^{}]*)\}/g)){
  for(const part of selectorParts(match[1]))if(!allowedGradient.some(rule=>rule.test(part)))gradientUses.push(`${file}:${lineOf(css,match.index)} ${part}`);
 }
}
assert.deepEqual(gradientUses,[],'--sd-accent-grad only on primary buttons, switches that are on, the search selection and the logo marks');checks++;

// ---- the shadcn toolchain, the classic helpers and the dead code are gone ----
const deletedFiles=['components/ui','components.json','lib/utils.ts','vendor/shadcn-tailwind-4.13.0.css','vendor/shadcn-tailwind-4.13.0.LICENSE.md',
 'app/loading-skeleton.tsx','app/loading-skeleton.css','app/detail-drawer.tsx','app/access-panel.tsx','app/agent-installation.tsx','app/agent-guide.css',
 'app/device-navigation-tree.tsx','app/device-navigation-tree.css','app/rdp-paused.tsx','app/access-workspace.css'];
for(const file of deletedFiles)assert.ok(!fs.existsSync(file),file+' does not exist');
checks+=deletedFiles.length;
const pkg=JSON.parse(read('package.json')),lock=read('pnpm-lock.yaml'),importers=lock.slice(0,lock.indexOf('\npackages:'));
for(const name of ['class-variance-authority','tailwind-merge','clsx','tw-animate-css']){
 assert.ok(!pkg.dependencies?.[name]&&!pkg.devDependencies?.[name],name+' is not in package.json');
 assert.doesNotMatch(importers,new RegExp(`\\n {6}'?${name}'?:`),name+' is no direct dependency in the lockfile');checks+=2;
}
assert.ok(pkg.devDependencies?.tailwindcss||pkg.dependencies?.tailwindcss,'Tailwind stays for the preflight reset and sr-only');checks++;
const globals=read('app/globals.css');
assert.doesNotMatch(globals,/tw-animate-css|vendor\/shadcn|@theme inline|@custom-variant/,'globals.css imports no tw-animate-css or vendor CSS and has no @theme inline block');
assert.doesNotMatch(withoutComments(globals),/(?<![\w-])--(?:background|foreground|card|popover|primary|secondary|muted|accent|destructive|border|input|ring|radius)(?:-foreground)?\s*:/,'globals.css defines no shadcn bridge property');
assert.doesNotMatch(stylesheets.map(read).join('\n'),/var\(--(?:background|foreground|card|popover|primary|secondary|muted|accent|destructive|border|input|ring|radius)(?:-foreground)?\)/,'no stylesheet reads a shadcn bridge property');
assert.doesNotMatch(read('eslint.config.mjs'),/components\/ui/,'eslint.config.mjs has no components/ui override');
assert.doesNotMatch(read('tests/repo/lint-scope.mjs'),/components\/ui/,'lint-scope neither accepts nor skips components/ui');
checks+=5;
assert.doesNotMatch(read('ui/base/api.tsx'),/\bErrorNote\b/,'ui/base/api.tsx exports no ErrorNote');
assert.doesNotMatch(read('ui/kit/kit.tsx'),/export function Ring\b/,'the kit exports no Ring');
for(const [file,name] of [['ui/devices/device/device-overview.tsx','DeviceOverview'],['ui/shell/console-jobs.tsx','JobsTable'],['ui/devices/device/device-removal.tsx','DeviceRemoval']])assert.doesNotMatch(read(file),/export default/,`${file}: ${name} is deleted`);
assert.ok(!fs.existsSync('app/device-overview.css'),'the DeviceOverview stylesheet is deleted');
const overview=await import('../../../ui/devices/device/device-overview.tsx'),jobs=await import('../../../ui/shell/console-jobs.tsx'),removal=await import('../../../ui/devices/device/device-removal.tsx');
for(const helper of [overview.deviceOverviewGpus,overview.deviceOverviewHistory,overview.deviceOverviewSamples,jobs.jobActionLabel,jobs.jobLabel,jobs.canCancelJob,removal.deviceRemovalConfirmation,removal.bulkDeviceRemovalConfirmation])assert.equal(typeof helper,'function','the helpers stay');
checks+=2+3+1+8;
// The navigator helpers moved to a pure module; the console and the tree import them from there.
for(const file of ['ui/devices/fleet/inventory-tree.tsx','ui/shell/console.tsx'])assert.match(read(file),/from '@\/ui\/devices\/fleet\/inventory-navigation';/,file+' imports the navigator helpers from ui/devices/fleet/inventory-navigation.ts');
assert.doesNotMatch(read('ui/devices/fleet/inventory-navigation.ts'),/from 'react'|\.css'/,'ui/devices/fleet/inventory-navigation.ts is pure');checks+=3;

// ---- one classic rule set over every .ts and .tsx file under app/ and ui/ ----
// The opening tags of a source with their top-level attributes (attribute braces are skipped), so a title on a Card and a
// disabled Btn inside its actions are two elements.
function openingTags(source){
 const tags=[];
 for(const match of source.matchAll(/<([A-Za-z][\w.]*)(?=[\s/>])/g)){
  let depth=0,index=match.index+match[0].length,attributes='',quote='';
  for(;index<source.length;index++){
   const char=source[index];
   if(quote){if(char===quote)quote='';attributes+=char;continue;}
   if(depth===0&&(char==='"'||char==="'")){quote=char;attributes+=char;continue;}
   if(char==='{'){depth++;if(depth===1)attributes+='{';continue;}
   if(char==='}'){depth--;if(depth===0)attributes+='}';continue;}
   if(char==='>'&&depth===0)break;
   if(depth===0)attributes+=char;
  }
  tags.push({name:match[1],attributes});
 }
 return tags;
}
// Native disabled together with a title on one element: blocked carries the reason instead (nodiverna-ui §5).
const disabledWithTitle=source=>openingTags(source).some(tag=>/(?:^|\s)disabled=\{\}/.test(tag.attributes)&&/(?:^|\s)title=/.test(tag.attributes));
const classicRules=[
 [/from\s*['"]@\/components\/ui\//,'imports @/components/ui'],
 [/from\s*['"][^'"]*\/loading-skeleton['"]/,'imports loading-skeleton'],
 [/from\s*['"][^'"]*\/detail-drawer['"]/,'imports detail-drawer'],
 [/<ErrorNote\b|import\s*\{[^}]*\bErrorNote\b|\bfunction ErrorNote\b/,'uses ErrorNote'],
 [/className="sdx-loading"/,'renders sdx-loading'],
 [/className="sdx-skeleton"/,'renders sdx-skeleton'],
 [/window\.confirm\b/,'uses window.confirm'],
 [/components\/ui\/alert-dialog/,'imports the shadcn AlertDialog'],
 [/function Fact\(/,'has a local Fact'],
 [/className=\{?['"`]panel/,'renders a classic .panel'],
 [/common\.reload/,'uses common.reload'],
 [disabledWithTitle,'sets a title on a natively disabled element'],
];
const matches=(rule,source)=>typeof rule==='function'?rule(source):rule.test(source);
const codeFiles=['app','ui'].filter(dir=>fs.existsSync(dir)).flatMap(dir=>walk(dir)).filter(file=>/\.tsx?$/.test(file));
const violations=codeFiles.flatMap(file=>{const source=read(file);return classicRules.filter(([rule])=>matches(rule,source)).map(([,what])=>`${file} ${what}`);});
assert.deepEqual(violations,[],'no file in app/ or ui/ uses a classic control, the classic drawer, ErrorNote, an old loading look, window.confirm, a local Fact, a classic panel, the Reload label or a title on a disabled element');
assert.ok(codeFiles.length>250&&codeFiles.includes('ui/account/account-panel.tsx')&&codeFiles.includes('ui/settings/access-workspace.tsx')&&codeFiles.includes('ui/shell/console.tsx'),'the rule set covers every file under app/ and ui/');
// Each rule matches a bad snippet and leaves the kit form alone.
const samples=[
 ["import {Button} from '@/components/ui/button';","import {Btn} from '@/ui/kit/kit';"],
 ["import LoadingSkeleton from './loading-skeleton';","import {Skeleton} from '@/ui/kit/kit';"],
 ["import {DetailDrawer} from '../detail-drawer';","import {Drawer} from '@/ui/kit/kit';"],
 ['<ErrorNote error={error}/>','<LoadFailed text={error}/>'],
 ['<div className="sdx-loading"/>','<Skeleton variant="table"/>'],
 ['<div className="sdx-skeleton"/>','<div className="sdx-skeleton-set"/>'],
 ["if(window.confirm('Delete?'))remove();","onConfirm({title,confirmLabel});"],
 ["const sheet='@/components/ui/alert-dialog';","import {ConfirmDialog} from '@/ui/kit/confirm-dialog';"],
 ['function Fact({label}){return label;}','<Facts items={items}/>'],
 ['<section className="panel">','<section className="sdx-card">'],
 ["t('common.reload')","t('common.retry')"],
 ['<button type="button" disabled={busy} title={reason}>Save</button>',"<Card title={t('x')} actions={<Btn disabled={busy} onClick={()=>{}}>Back</Btn>}>"],
];
assert.equal(samples.length,classicRules.length,'one sample pair per rule');
classicRules.forEach(([rule,what],index)=>{assert.ok(matches(rule,samples[index][0]),'the rule matches: '+what);assert.ok(!matches(rule,samples[index][1]),'the rule leaves the kit form: '+what);});
checks+=3+samples.length*2;
// Raw selects are the kit Select (field.tsx renders the one <select>), except the places named here with their reason.
const rawSelectPlaces={
 'ui/kit/field.tsx':'the kit Select itself',
 'ui/devices/monitoring/alert-rules.tsx':'the alert rule editor, outside the UI-Rework scope',
 'ui/devices/monitoring/notification-rules.tsx':'the notification rule editor, outside the UI-Rework scope',
 'ui/devices/remote/remote-desktop-client.tsx':'the full-page Remote Desktop client outside the console',
};
assert.deepEqual(codeFiles.filter(file=>!rawSelectPlaces[file]&&/<select\b/.test(read(file))),[],'no raw <select> in app/ or ui/ outside the named places');checks++;
// The settings pages (the section components AccessWorkspace imports and the files they import, read from the
// sources) use the kit Switch and the shared step-up flow: no raw switch and no MFA pending logic of their own.
const resolveImport=(from,id)=>{
 const base=id.startsWith('@/app/')||id.startsWith('@/ui/')?id.slice(2):id.startsWith('.')?path.posix.join(path.posix.dirname(from),id):null;
 if(!base)return null;
 return [base+'.tsx',base+'.ts',base+'/index.tsx',base+'/index.ts',base].find(file=>/\.tsx?$/.test(file)&&fs.existsSync(file)&&fs.statSync(file).isFile())??null;
};
// Type-only imports load nothing at run time.
const importsOf=file=>[...read(file).matchAll(/(?:import|export)\s(?!type\s)[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)].map(match=>resolveImport(file,match[1]??match[2])).filter(Boolean);
// The shared console parts that the pages reuse stay out: the kit, the language hooks and the ActivityTable.
const sharedPart=file=>file.startsWith('ui/kit/')||['ui/base/locale.tsx','ui/devices/history/activity-table.tsx'].includes(file);
const settingsSections=importsOf('ui/settings/access-workspace.tsx').filter(file=>!sharedPart(file));
const settingsFiles=[...new Set([...settingsSections,...settingsSections.flatMap(importsOf).filter(file=>!sharedPart(file))])].filter(file=>file.endsWith('.tsx')&&file!=='ui/session/mfa-step-up.tsx');
assert.deepEqual(['ui/settings/customers-panel.tsx','ui/settings/customer-drawers.tsx','ui/settings/usage-data-page.tsx','ui/settings/usage-data.tsx','ui/settings/session-settings-panel.tsx','ui/settings/settings-accounts.tsx','ui/settings/entra-settings-panel.tsx'].filter(file=>!settingsFiles.includes(file)),[],'the settings files are found from AccessWorkspace');
const settingsRules=[[/<select/,'renders a raw select'],[/role="switch"/,'renders a raw switch'],[/MFA_LOGIN_REQUIRED|MFA_STEP_UP_REQUIRED|opensMfaPrompt|pending\.current/,'keeps its own MFA pending logic']];
assert.deepEqual(settingsFiles.flatMap(file=>{const source=read(file);return settingsRules.filter(([pattern])=>pattern.test(source)).map(([,what])=>`${file} ${what}`);}),[],'the settings pages use the kit Select and Switch and useStepUp');
assert.ok(!fs.existsSync('app/skeleton-bar.css')&&!fs.existsSync('app/session-settings-panel.css'),'the unused classic skeleton bar and the sessions stylesheet are deleted');checks+=3;
// The settings wrapper is gone: AccessWorkspace renders the section page directly.
assert.deepEqual([...walk('app'),...walk('ui')].filter(file=>/\.(tsx?|css)$/.test(file)&&/sd-access-workspace|sd-identity-tabs/.test(read(file))),[],'no file in app/ or ui/ renders or styles sd-access-workspace or sd-identity-tabs');
const workspace=read('ui/settings/access-workspace.tsx');
assert.doesNotMatch(workspace,/administrationTabs|onSectionChange|className="panel/,'AccessWorkspace has no tab list, no section change and no classic panel');
assert.match(workspace,/<>\{frameHeader\(frame\)\}<SettingsPage label=\{t\('nav\.settings\.title'\)\}><Unavailable reason="right">\{t\('access\.noPermission'\)\}<\/Unavailable><\/SettingsPage><\/>/,'the no-permission branch is the page header, then SettingsPage with the kit Unavailable');
checks+=3;
// A confirmation always names its verb: confirmLabel is required, so tsc checks every caller.
assert.match(read('ui/base/confirmation.ts'),/export type Confirmation=\{[^}]*\bconfirmLabel:string;/,'Confirmation.confirmLabel is required');
assert.doesNotMatch(read('ui/base/confirmation.ts'),/confirmLabel\?:/,'no optional confirmLabel');checks+=2;
const palette=read('ui/shell/command-palette.tsx');
assert.doesNotMatch(palette,/from\s*['"]radix-ui['"]|DialogPrimitive/,'the palette uses no radix Dialog directly');
assert.match(palette,/import \{Dialog\} from '@\/ui\/kit\/confirm-dialog';/,'the palette is built on the kit Dialog');checks+=2;
// Their old loading looks and the floating idle notice are gone.
for(const file of ['app/account-loading.tsx','app/session-loading.tsx','app/session-idle-notice.tsx']){assert.ok(!fs.existsSync(file),file+' does not exist');checks++;}
// My account renders no classic notice, v3 classes or a raw details element.
for(const file of ['ui/account/account-panel.tsx','ui/account/passkeys-panel.tsx','ui/account/password-settings.tsx']){const source=read(file);assert.doesNotMatch(source,/className="[^"]*\b(?:notice|v3-[\w-]+)\b|<details\b|account-loading/,file+' renders no .notice, .v3-* or <details>');checks++;}
// The Automation pages (UI-Rework 11): no classic surface, no German literal, files split by job.
const automationFiles=['ui/automation/automation-workspace.tsx','ui/automation/automation-assignments.tsx','ui/automation/automation-template-drawers.tsx','ui/automation/automation-device-status.tsx','ui/automation/automation-data.ts','ui/automation/runbook-schedules.tsx'];
assert.ok(!fs.existsSync('app/automation-workspace.css'),'the Automation stylesheet is deleted');
for(const file of automationFiles){
 const source=read(file);
 assert.deepEqual([/className="(?:[^"]* )?(?:panel|v3-empty|aw-[\w-]+|sd-section-tabs)[" ]/.test(source),/[äöüÄÖÜß]/.test(source),source.split('\n').length<=400],[false,false,true],file+': no classic class, no German literal, at most 400 lines');
}
checks+=1+automationFiles.length;
// The message keys of the deleted code are gone from both catalogs, and so are the old navigation label keys.
const catalogs={en:(await import('../../../lib/i18n/messages/en.ts')).default,de:(await import('../../../lib/i18n/messages/de.ts')).default};
const removedKeyPrefixes=['accessPanel.','agents.trouble.','access.tab.','nav.access.','nav.agents.'];
const removedKeys=['access.settingsLabel','tree.renameGroup','tree.manageMembers','tree.actionsShortcutDot','tree.permissionsOnlyLabel','tree.permissionsFor','tree.navigation','tree.allDevicesCount'];
for(const [name,messages] of Object.entries(catalogs)){
 assert.deepEqual(Object.keys(messages).filter(key=>removedKeyPrefixes.some(prefix=>key.startsWith(prefix))||removedKeys.includes(key)),[],name+': the keys of the deleted code are removed');checks++;
}
assert.deepEqual(codeFiles.filter(file=>/['"`](?:nav\.access\.|nav\.agents\.|access\.tab\.|accessPanel\.)/.test(read(file))),[],'no file in app/ or ui/ reads a removed key');checks++;
// This guard keeps no file exception list for the classic rules (self-read).
const guardSource=read('tests/ui/kit/frame-cleanup.mjs');
for(const word of ['allow'+'list','outside'+'Pages','kit'+'Pages','customerSettings'+'Pages','settingsKit'+'Pages'])assert.ok(!guardSource.includes(word),`the guard has no ${word}`);
checks+=5;

// ---- Device panels on the kit (UI-Rework 13b) ----
// The files the device view reaches by the same import walk, started at device.tsx alone.
const deviceReached=new Set(),deviceQueue=['ui/devices/device/device.tsx'];
while(deviceQueue.length){
 const file=deviceQueue.shift();if(deviceReached.has(file))continue;deviceReached.add(file);
 for(const target of importsOf(file))if(!deviceReached.has(target))deviceQueue.push(target);
}
assert.ok(deviceReached.has('ui/devices/extensions/device-dhcp.tsx')&&deviceReached.has('ui/devices/remote/file-browser.tsx')&&deviceReached.has('ui/devices/remote/terminal-panel.tsx')&&deviceReached.has('ui/automation/runbook-panel.tsx'),'the device walk reaches the device panels');checks++;
const appSources=codeFiles;
// Card mode keeps row actions: DataCards renders every sdx-col-actions column, so no such column opts out with card:false.
const optOuts=appSources.flatMap(file=>[...read(file).matchAll(/\{id:'[^']*'[^{}\n]*?className:'[^']*sdx-col-actions[^']*'[^{}\n]*?\}|\{id:'[^']*'[^{}\n]*?card:false[^{}\n]*?\}/g)].filter(match=>match[0].includes('sdx-col-actions')&&match[0].includes('card:false')).map(()=>file));
assert.deepEqual(optOuts,[],'no DataColumn in app/ or ui/ combines sdx-col-actions with card:false');checks++;
// Row actions are one row Menu: no Btn or IconBtn inside a DataColumn cell of the device files (cell links such as sdx-row-open are not row actions).
const cellBody=(source,start)=>{let depth=0,body='';for(let index=start;index<source.length;index++){const char=source[index];if('{(['.includes(char))depth++;if('})]'.includes(char)){if(depth===0)break;depth--;}if(depth===0&&char===',')break;body+=char;}return body;};
// Named exceptions: reached for shared helpers only; the table with the button renders on a settings page, not in the device view.
const cellButtonPages={'ui/settings/assistant-settings-panel.tsx':'Settings → Assistant: the customer key table; the device view imports providerLabel and the personal key card only'};
const cellButtons=[...deviceReached].filter(file=>!cellButtonPages[file]).flatMap(file=>{const source=read(file);return [...source.matchAll(/cell:\(?[\w{}, ]*\)?=>/g)].filter(match=>/<(?:Btn|IconBtn)\b/.test(cellBody(source,match.index+match[0].length).replace(/<button[^>]*sdx-row-open[\s\S]*?<\/button>/g,''))).map(match=>`${file}:${source.slice(0,match.index).split('\n').length}`);});
assert.deepEqual(cellButtons,[],'no device file renders a Btn or IconBtn in a DataColumn cell');checks++;
// The last window.confirm is gone: every confirmation is a kit ConfirmDialog.
assert.deepEqual(appSources.filter(file=>/window\.confirm\s*\(/.test(read(file))),[],'no file in app/ or ui/ calls window.confirm');checks++;
// Native selects in device panels are the kit Select (field.tsx renders the one <select>).
assert.deepEqual([...deviceReached].filter(file=>file!=='ui/kit/field.tsx'&&/<select\b/.test(read(file))),[],'no file reached from device.tsx has a <select> literal except field.tsx');checks++;
// The rebuilt panels keep none of their hand parts.
const handParts={
 'ui/devices/protection/device-defender.tsx':[/<table\b/,/function Fact\b/,/dl className="sdx-facts"/,/variant="primary"/],
 'ui/devices/extensions/device-extensions.tsx':[/<table\b/,/sdx-health-head/],
 'ui/devices/extensions/device-dhcp.tsx':[/<table\b/,/<select\b/,/sdx-searchfield/,/className="sdx-bulkbar"/,/sdx-roles-count/,/sdx-health-head/,/function Fact\b/],
 'ui/devices/extensions/device-dns.tsx':[/<select\b/,/className="sdx-bulkbar"/,/sdx-health-head/,/card:false/],
 'ui/devices/remote/file-browser.tsx':[/className=\{?['"`]panel/,/panel-heading/,/<h2\b/,/<table\b/,/<progress\b/],
 'ui/devices/remote/file-panel.tsx':[/className=\{?['"`]panel/,/panel-heading/,/<h2\b/],
 'ui/devices/remote/terminal-panel.tsx':[/className="panel/,/panel-heading/,/v3-terminal-session/],
};
assert.deepEqual(Object.entries(handParts).flatMap(([file,patterns])=>patterns.filter(pattern=>pattern.test(read(file))).map(pattern=>`${file} ${pattern}`)),[],'the rebuilt device panels keep no hand head, table, select, bulk bar, fact list or classic panel');checks++;
for(const name of ['file-table','file-selection','v3-terminal-session','sdx-updates-selection','sdx-dhcp-empty','sdx-defender-table','sdx-roles-count','sdx-health-head','v3-disconnected']){assert.ok(![...walk('app'),...walk('ui')].some(file=>/\.css$/.test(file)&&new RegExp(`\\.${name}(?![\\w-])`).test(read(file))),`.${name} has no CSS left`);checks++;}

// ---- "Versuche es erneut" ----
const catalog=async file=>(await import(file)).default;
const de=await catalog("../../../lib/i18n/messages/de.ts"),en=await catalog("../../../lib/i18n/messages/en.ts");
const deServer=await catalog("../../../lib/i18n/messages/de-server.ts");
const changed={
 'diagnostics.client.timeout':['Die Diagnoseanfrage hat das Zeitlimit überschritten. Versuche es erneut.'],
 'diagnostics.client.sessionCheck':['Nodiverna konnte die bereits laufende Abfrage nicht prüfen. Versuche es erneut.'],
 'diagnostics.processes.stale':['Der Prozess hat sich geändert oder lässt sich nicht mehr beenden. Wähle ihn erneut aus.'],
 'diagnostics.processes.changed':['Der Prozess hat sich geändert oder ist jetzt geschützt. Wähle ihn erneut aus.'],
 'diagnostics.events.xmlHint':['Für XML-Details schalte „XML einschließen“ ein und frage erneut ab.'],
 'drift.panel.loadTimeout':['Die Drift-Daten konnten nicht rechtzeitig geladen werden. Versuche es erneut.'],
 'drift.panel.changeTimeout':['Nodiverna konnte die Änderung nicht rechtzeitig bestätigen. Lade die Seite neu, um zu sehen, ob sie gespeichert wurde.'],
 'files.transfer.timeout':['Der Dateitransfer hat zu lange gedauert. Prüfe die Agentverbindung und lade die Datei erneut herunter.'],
 'files.upload.cannotResume':['Der Upload kann nicht mehr fortgesetzt werden. Wähle die Dateien erneut aus.'],
 'storage.size.noRange':['Windows meldet keinen Größenbereich für dieses Volume. Aktualisiere das Inventar und versuche es erneut.'],
 'storage.focus.multiple':['Windows meldet mehrere Volumes mit diesem Buchstaben. Frage das Inventar erneut ab.'],
 'storage.noRange':['Windows meldet keinen Größenbereich für dieses Volume. Frage das Inventar erneut ab.'],
 'rdp.transport.mailboxTimeout':['Nodiverna hat mehrere Remote-Desktop-Anfragen nicht rechtzeitig beantwortet. Verbinde dich erneut.'],
 'rdp.webrtc.signalTimeout':['Nodiverna hat die Verbindungsdaten nicht rechtzeitig weitergegeben. Verbinde dich erneut, und prüfe das Agentprotokoll, wenn das wieder passiert.','Nodiverna did not pass on the connection data in time. Connect again, and check the agent log if this happens again.'],
 'rdp.webrtc.signalUnavailable':['Nodiverna kann die Verbindungsdaten gerade nicht weitergeben. Verbinde dich erneut.','Nodiverna cannot pass on the connection data at the moment. Connect again.'],
 'rdp.webrtc.signalInterrupted':['Der Austausch der Verbindungsdaten über Nodiverna wurde unterbrochen. Verbinde dich erneut.','The exchange of connection data through Nodiverna was interrupted. Connect again.'],
 'rdp.panel.tooMany':['Vier Remote-Desktop-Anfragen laufen bereits. Wenn eine davon endet, verbinde dich erneut.','Four Remote Desktop requests are already running. When one of them ends, connect again.'],
 'rdp.panel.mismatch':['Diese Remote-Desktop-Anfrage gehört zu einer anderen Ansicht. Lade die Seite neu und öffne Remote Desktop erneut.'],
 'rdp.client.stale':['Nodiverna wurde aktualisiert, aber diese Seite läuft noch mit der alten Version. Lade die Seite neu und öffne Remote Desktop erneut.'],
 'runbooks.diagnosis.again':['Wähle die Diagnoseaktion erneut aus.'],
 'runbooks.diagnosis.choose':['Wähle eine Diagnoseaktion aus.'],
 'agentUpdates.fleet.selectionChanged':['Die Geräteauswahl hat sich geändert. Prüfe die Auswahl erneut.','The device selection has changed. Check the selection again.'],
 'common.serviceUnavailable':['Der Dienst ist gerade nicht erreichbar. Versuche es erneut.'],
 'common.invalidApiReply':['Der Server hat eine Antwort gesendet, die Nodiverna nicht lesen kann. Versuche es erneut.'],
 'rbac.noManagementToken':['Nodiverna konnte deine Identität für diese Änderung nicht bestätigen. Versuche es erneut.'],
};
for(const [key,[german,english]] of Object.entries(changed)){assert.equal(de[key],german,key+' (de)');if(english)assert.equal(en[key],english,key+' (en)');checks++;}
assert.equal(deServer['apiError.agent.maintenanceRetry'],'Der Agent wird gerade gewartet. Versuche es nach Abschluss erneut.');
assert.equal(deServer['apiError.rbac.proofExpired'],'Die Bestätigung ist abgelaufen oder wurde bereits verwendet. Bestätige erneut.');checks+=2;
const added={'rdp.panel.enable':['Turn on Remote Desktop','Remote Desktop einschalten'],'rdp.panel.disable':['Turn off Remote Desktop','Remote Desktop ausschalten'],'files.blocked.write':['You don\'t have permission to change files on this device.','Dir fehlt die Berechtigung, auf diesem Gerät Dateien zu ändern.'],'files.blocked.transfer':['Wait until the current transfer ends.','Warte, bis die laufende Übertragung endet.'],'files.blocked.noFolder':['Open a folder first.','Öffne zuerst einen Ordner.']};
for(const [key,[english,german]] of Object.entries(added)){assert.deepEqual([en[key],de[key]],[english,german],key);checks++;}
// The guard: no "Bitte …" and no bare infinitive instruction anywhere in the German copy (UI-Rework 15:
// every key of de.ts and de-server.ts). A sentence that ends with an instruction verb in the infinitive
// and has no subject, modal or conjunction is a bare infinitive ("Inventar erneut abfragen.").
const bitte=/(?:^|[\s„(])[Bb]itte\b/;
const bare=/(?:^|\s)(?:versuchen|aktualisieren|aktivieren|deaktivieren|abfragen|prüfen|laden|angeben|auswählen|eingeben|wählen|starten|öffnen|verwenden|installieren|einrichten|entfernen|bestätigen|anmelden|hinzufügen|kontaktieren|speichern|wiederholen|beheben|erstellen|löschen|warten|einschalten|ausschalten|ändern|zuweisen|freigeben|nutzen|neustarten|ergänzen|korrigieren|setzen|eintragen|anpassen|hochladen|herunterladen|ausführen|verbinden|beenden|schließen|trennen|abschließen)\.$/;
const subject=/(?:^|\s)(?:ich|du|dich|dir|wir|ihr|sie|Sie|es|er|man|kann|können|kannst|konnte|konnten|ließ|ließen|lässt|musst|muss|müssen|wird|werden|ist|sind|darf|dürfen|soll|sollen|zu|um|wenn|bevor|nachdem|damit|dass|ob|weil|sobald|solange)(?=[\s,.]|$)/;
const notDuForm=value=>value!=='Erneut versuchen'&&(bitte.test(value)||value.split(/(?<=[.!?])\s+/).some(sentence=>bare.test(sentence)&&!subject.test(sentence.replace(bare,''))));
const offending=[];
for(const [name,messages] of [['de.ts',de],['de-server.ts',deServer]])for(const [key,message] of Object.entries(messages)){
 if(/Keywords$/.test(key))continue;
 // A plural message checks each of its forms.
 for(const value of typeof message==='string'?[message]:Object.values(message))if(notDuForm(value))offending.push(`${name} ${key}: ${value}`);
}
assert.deepEqual(offending,[],'German copy uses the Du-Form');checks++;
// The rule itself.
for(const sample of ['Bitte erneut laden.','Inventar erneut abfragen.','Name, Format und Konfiguration prüfen.','Fehler. Agentprotokoll prüfen. {detail}'])assert.ok(notDuForm(sample),sample);
for(const sample of ['Prüfe das Inventar.','Die Liste konnte nicht geladen werden.','Erneut versuchen','Du kannst sie erneut starten.','Remote Desktop einschalten?'])assert.ok(!notDuForm(sample),sample);
checks+=2;
// One retry label: common.retry on every load-error retry of the views; the duplicates are gone.
for(const file of ['ui/shell/console.tsx','ui/devices/monitoring/alarms.tsx','ui/devices/inventory/os-support.tsx','ui/devices/inventory/vulnerability-list.tsx','ui/devices/assistant/device-assistant.tsx','ui/devices/hardware/device-gpu-driver.tsx','ui/devices/extensions/device-dhcp.tsx','ui/devices/extensions/device-dns.tsx','ui/devices/extensions/extensions-tab.tsx','ui/devices/configuration/device-tags.tsx']){
 assert.doesNotMatch(read(file),/common\.reload|hardware\.gpuDriver\.retry|dhcp\.error\.retry|dns\.error\.retry/,file+' has no other retry label');checks++;
}
for(const key of ['hardware.gpuDriver.retry','dhcp.error.retry','dns.error.retry'])for(const messages of [en,de]){assert.equal(messages[key],undefined,key+' is removed');checks++;}
assert.equal(en['common.retry'],'Try again');assert.equal(de['common.retry'],'Erneut versuchen');checks+=2;
// The last views with a Reload label moved to the kit (Try again), so the key is gone.
assert.deepEqual([...walk('app'),...walk('ui')].filter(file=>/\.tsx?$/.test(file)&&read(file).includes("'common.reload'")),[],'no view uses common.reload');checks++;
for(const messages of [en,de]){assert.equal(messages['common.reload'],undefined,'common.reload is removed');checks++;}

console.log(`PASS frame clean-up (${checks} checks): radii as tokens and no dead or classic class in ${stylesheets.length} stylesheets, one console h1 and input halo, the classic-panels.css header, the flat dock bar and the gradient places, no shadcn toolchain or dead code, one classic rule set over ${codeFiles.length} files in app/, a required confirmLabel, the device panels, Du-Form copy and one retry label.`);
