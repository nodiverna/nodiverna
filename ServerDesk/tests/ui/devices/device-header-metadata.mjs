// The device header metadata rendered with React SSR: the tag chips
// of the header (ui/devices/configuration/device-tags.tsx, headerTagChips in lib/tags.ts)
// with remove buttons, inherited chips and their origin, overrides and the
// rights; the one-line description (ui/devices/device/device-description.tsx);
// and source checks that the device Tags panel and the Overview Description
// card are gone. No browser, no server.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {serverDeskRoot} from '../../support/paths.mjs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const h=React.createElement;
const {default:DeviceTags,DirectChip}=await import('../../../ui/devices/configuration/device-tags.tsx');
const {default:DeviceDescription}=await import('../../../ui/devices/device/device-description.tsx');
const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
const {headerTagChips}=await import('../../../lib/tags.ts');
const en=(await import('../../../lib/i18n/messages/en.ts')).default??(await import('../../../lib/i18n/messages/en.ts')).en;
const de=(await import('../../../lib/i18n/messages/de.ts')).default??(await import('../../../lib/i18n/messages/de.ts')).de;
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const read=file=>readFileSync(serverDeskRoot+file,'utf8');
const decode=text=>text.replace(/&quot;/g,'"').replace(/&#x27;/g,"'").replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');

const berlin={type:'group',id:'g-berlin',name:'Berlin',visible:true},hidden={type:'group',id:'g-hidden',name:'Hidden',visible:false};
const view=(patch={})=>({scope:{type:'device',id:'d-1',name:'SRV-1'},canEdit:true,reason:null,
 direct:[
  {id:'t-env',name:'Env',value:'Prod',inherit:false,updatedAt:11,overrides:null},
  {id:'t-owner',name:'owner',value:'',inherit:false,updatedAt:12,overrides:{value:'Team A',origin:berlin}},
 ],
 inherited:[
  {name:'Site',value:'Berlin',origin:berlin},
  {name:'backup',value:'nightly',origin:hidden},
 ],...patch});

// ---- headerTagChips: one list, sorted without regard to case ----
const chips=headerTagChips(view());
check(chips.map(chip=>[chip.kind,chip.tag.name]),[['inherited','backup'],['direct','Env'],['direct','owner'],['inherited','Site']],'direct and inherited mixed, sorted case-insensitively');
check(headerTagChips({direct:[],inherited:[]}),[],'an empty view has no chips');
// The view holds only effective inherited entries: an overridden one is never there twice.
check(chips.filter(chip=>chip.tag.name.toLowerCase()==='owner').length,1,'an overridden inherited tag is not duplicated');
check(headerTagChips(view()).map(chip=>chip.tag.name),chips.map(chip=>chip.tag.name),'pure: the same view gives the same list');

// ---- DeviceTags with an injected view ----
const owner={id:'u-1',label:'owner',permissions:['*']},manager={id:'u-2',label:'manager',permissions:[]},reader={id:'u-3',label:'reader',permissions:[]};
const device=(patch={})=>({id:'d-1',name:'SRV-1',permissions:['view','groups.manage'],groupId:'g-berlin',groupName:'Berlin',groups:[{id:'g-berlin',name:'Berlin'}],
 tags:[{name:'Env',value:'Prod',inherited:false,groupId:null},{name:'Site',value:'Berlin',inherited:true,groupId:'g-berlin'}],...patch});
const noop=()=>{};
const renderTags=(props,locale='en')=>decode(renderToStaticMarkup(h(LocaleProvider,{locale},h(DeviceTags,{server:device(),viewer:manager,demo:false,onRefresh:noop,onOpenOrigin:noop,...props}))));
const removeButtons=html=>[...html.matchAll(/<button[^>]*class="sdx-device-tag-remove"[^>]*aria-label="([^"]+)"/g)].map(match=>match[1]);
const addTag=(html,label='Add tag')=>[...html.matchAll(/<button([^>]*)>(?:(?!<\/button>).)*?<\/button>/g)].find(match=>match[0].includes(`>${label}<`)||match[0].endsWith(`${label}</button>`));

let html=renderTags({initialView:view()});
check(removeButtons(html),['Remove tag Env: Prod','Remove tag owner'],'each direct chip has a remove button named after its label');
check(removeButtons(renderTags({initialView:view()},'de')),['Tag Env: Prod entfernen','Tag owner entfernen'],'German remove labels');
ok(/<ul id="[^"]+" class="sdx-device-tag-list" aria-label="Tags">/.test(html),'the chips are a labelled list (with an id for the "+N" button)');
ok(html.includes('<span class="sdx-tag sdx-device-tag" title="Env: Prod"><span class="sdx-device-tag-label">Env: Prod</span>'),'a direct chip shows its label with the full label in title');
ok(html.includes('<span class="sdx-tag sdx-device-tag sdx-tag-changed" title="Inherited: Team A from Device group: Berlin">'),'an override chip carries sdx-tag-changed and the inherited value');
// An inherited chip (DV-header-2, DV-header-3): a non-interactive dashed chip with the label, "Inherited" and the group.
const inheritedChip=(markup,label)=>markup.match(new RegExp(`<span class="sdx-tag sdx-tag-inherited sdx-device-tag" title="${label}"><span class="sdx-device-tag-label">${label}</span>(?:(?!<li).)*?</span></span></span>`))?.[0];
// The wide meta line shows three chips and "+N" for the rest (backup, Env and owner here; Site behind "+1").
ok(!inheritedChip(html,'Site: Berlin')&&html.includes('aria-label="Show 1 more tag"')&&html.includes('>+1<'),'three chips, then "+1"');
const threeChips=view({direct:[view().direct[0]]}),three=renderTags({initialView:threeChips});
const site=inheritedChip(three,'Site: Berlin'),backup=inheritedChip(html,'backup: nightly');
ok(site&&site.includes('<span class="sdx-inherited-word">Inherited</span>'),'the inherited chip shows the word "Inherited" as text, not as a nested tag');
const originButton=site?.match(/<button type="button" class="sdx-inherited-link" aria-label="([^"]+)" aria-describedby="([^"]+)">Berlin<\/button>/);
check(originButton?.[1],'Site: Berlin, inherited from Berlin. Open the tags of Berlin.','a visible origin: the group name is a button named device.tags.openOriginNamed');
ok(originButton&&originButton[1].includes('Berlin'),'the accessible name contains the visible group name (WCAG 2.5.3)');
ok(originButton&&site.includes(`<span id="${originButton[2]}" class="sr-only">${en['inheritance.lockedHint']}</span>`),'the button is described by the sr-only hint');
ok(!/<button[^>]*class="sdx-tag/.test(html),'no chip is a button any more');
ok(backup&&backup.includes('<span class="sdx-inherited-label">Hidden</span>')&&!/<button/.test(backup),'an invisible origin leaves the group name plain text');
ok(!/title="[^"]*inherited from/.test(html),'no chip title carries text the chip does not show');
check((three.match(/sdx-tag-inherited/g)??[]).length,2,'both inherited chips are marked');
ok(!/sdx-tag-inherited[^>]*>(?:(?!<\/(?:button|span)>).)*sdx-device-tag-remove/.test(three),'inherited chips have no remove button');
ok(!addTag(html),'no inline "Add tag": More actions › "Add tags…" opens the form');
ok(renderTags({initialView:view(),formOpen:true}).includes('class="sdx-device-tag-form"'),'formOpen shows the add form in the meta line');
const german=renderTags({initialView:threeChips},'de');
ok(german.includes('aria-label="Site: Berlin, geerbt von Berlin. Öffnet die Tags von Berlin."')&&german.includes('<span class="sdx-inherited-word">Geerbt</span>'),'German inherited chip');
// Without the opener, a visible origin stays plain text too.
ok(!/sdx-inherited-link/.test(renderTags({initialView:threeChips,onOpenOrigin:undefined})),'without onOpenOrigin no origin button');

// ---- DirectChip: the leaving state after a remove ----
const renderChip=props=>decode(renderToStaticMarkup(h(LocaleProvider,{locale:'en'},h(DirectChip,{tag:view().direct[0],removable:true,busy:false,disabled:false,onRemove:noop,...props}))));
const leavingChip=renderChip({leaving:true,onLeft:noop});
ok(/<span class="[^"]*\bsdx-device-tag-leaving\b[^"]*"[^>]*aria-hidden="true"/.test(leavingChip),'a leaving chip carries sdx-device-tag-leaving and aria-hidden');
ok(![...leavingChip.matchAll(/<button[^>]*class="sdx-device-tag-remove"[^>]*>/g)].some(match=>!/\sdisabled=""/.test(match[0])),'a leaving chip has no enabled remove button');
const stayingChip=renderChip({});
ok(!stayingChip.includes('sdx-device-tag-leaving')&&!/<span class="sdx-tag[^>]*aria-hidden/.test(stayingChip),'without leaving: no leaving class and no aria-hidden on the chip');
ok(/<button[^>]*class="sdx-device-tag-remove"[^>]*>/.test(stayingChip)&&!/class="sdx-device-tag-remove"[^>]*disabled/.test(stayingChip),'without leaving: the remove button is enabled');
ok(renderChip({busy:true}).includes('aria-busy="true"'),'a chip being removed is aria-busy');

// ---- CSS and source checks for busy and fade ----
const css=read('ui/styles/console.css');
const selectors=[...css.replace(/\/\*[\s\S]*?\*\//g,'').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(match=>({selector:match[1].trim(),body:match[2]}));
const busySelectors=selectors.flatMap(rule=>rule.selector.split(',')).filter(selector=>/\.sdx-tag[^,]*\[aria-busy/.test(selector));
ok(busySelectors.length>0&&busySelectors.every(selector=>selector.includes('.sdx-device-tag')),'every .sdx-tag[aria-busy] selector is scoped to .sdx-device-tag');
ok(selectors.some(rule=>rule.selector.endsWith('.sdx-device-tag[aria-busy="true"]')&&/opacity:\s*\.6/.test(rule.body)),'the busy rule .sdx-device-tag[aria-busy="true"] keeps opacity .6');
const leavingRule=selectors.find(rule=>/^:is\(\.sdx, \.sdx-layer\) [^,]*\.sdx-device-tag-leaving$/.test(rule.selector));
ok(leavingRule&&/opacity:\s*0\s*;/.test(leavingRule.body)&&/transform:\s*scale\(\.96\)/.test(leavingRule.body)&&/pointer-events:\s*none/.test(leavingRule.body),'the leaving rule under :is(.sdx, .sdx-layer) fades to 0 and scales to .96');
const chipRule=selectors.find(rule=>rule.selector==='.sdx-tag.sdx-device-tag');
const transition=chipRule?.body.match(/transition:\s*([^;]+);/)?.[1].split(',').map(part=>part.trim());
check(transition,['opacity var(--sd-dur) var(--sd-ease-out)','transform var(--sd-dur) var(--sd-ease-out)'],'the header chip transitions opacity and transform only, with --sd-dur and --sd-ease-out');
const tagsSource=read('ui/devices/configuration/device-tags.tsx');
ok(tagsSource.includes("matchMedia('(prefers-reduced-motion: reduce)')"),'device-tags.tsx checks prefers-reduced-motion');
ok(/onTransitionEnd=/.test(tagsSource)&&/propertyName==='opacity'/.test(tagsSource),'device-tags.tsx ends the fade on the opacity transitionend');
ok(/setTimeout\(.*,leaveFallbackMs\)/.test(tagsSource)&&/leaveFallbackMs=240\b/.test(tagsSource),'device-tags.tsx has a 240 ms fallback timeout');
ok(/clearTimeout/.test(tagsSource),'device-tags.tsx clears pending fade timers');
ok(!tagsSource.includes('@keyframes'),'device-tags.tsx adds no keyframes');

// ---- Rights ----
html=renderTags({initialView:view(),viewer:reader,server:device({permissions:['view']})});
check(removeButtons(html),[],'without groups.manage: no remove buttons');
ok(!renderTags({initialView:view(),viewer:reader,server:device({permissions:['view']}),formOpen:true}).includes('sdx-device-tag-form'),'without groups.manage: formOpen shows no form');
ok(html.includes('Env: Prod')&&html.includes('backup: nightly'),'without groups.manage the chips still show');
html=renderTags({initialView:view({canEdit:false,reason:'right'}),formOpen:true});
check([removeButtons(html),html.includes('sdx-device-tag-form')],[[],false],'the server says canEdit false: no remove buttons, no form');
html=renderTags({initialView:view(),viewer:owner,server:device({permissions:[]}),formOpen:true});
check([removeButtons(html).length,html.includes('sdx-device-tag-form')],[2,true],'an Owner gets both');
// Demo: the view of the sample device; the add form stays closed (the menu entry is blocked with the demo reason).
html=renderTags({demo:true,formOpen:true});
check([removeButtons(html),html.includes('sdx-device-tag-form'),!!addTag(html)],[[],false,false],'demo: no remove buttons, no form, no inline add');
ok(html.includes('>Env: Prod<')&&html.includes('<span class="sdx-device-tag-label">Site: Berlin</span><span class="sdx-inherited-origin sdx-inherited-inline">'),'demo: chips from the sample device');
// Before the first load: the console's tags, read-only, never a blank row.
html=renderTags({});
check(removeButtons(html),[],'before the load: no remove buttons');
ok(html.includes('>Env: Prod<')&&html.includes('>Site: Berlin<'),'before the load: the chips from server.tags');
ok(!addTag(html),'before the load: no inline "Add tag"');
check(renderTags({viewer:reader,server:device({permissions:['view'],tags:[]})}),'','no tags and no right: nothing');

// ---- DeviceDescription: one line, expandable when it has a line break ----
const renderDescription=(description,props={})=>decode(renderToStaticMarkup(h(LocaleProvider,{locale:'en'},h(DeviceDescription,{server:device({description}),viewer:manager,demo:false,onRefresh:noop,...props}))));
html=renderDescription('Accounting, room 2.14');
ok(html.includes('<p class="sdx-device-description-text sdx-device-description-line" title="Accounting, room 2.14">Accounting, room 2.14</p>'),'a single line is a plain p with the one-line class and the full text in title');
ok(!html.includes('sdx-clamp-2'),'the two-line clamp is gone');
ok(!html.includes('aria-label="Edit description"'),'no pencil: "Edit description…" is in More actions');
ok(renderDescription('Accounting, room 2.14',{editing:true}).includes('<textarea'),'editing opens the editor in the meta line');
ok(!renderDescription('Accounting, room 2.14',{editing:true,viewer:reader,server:device({permissions:['view'],description:'Accounting, room 2.14'})}).includes('<textarea'),'without the right editing opens nothing');
html=renderDescription('Accounting\nroom 2.14');
ok(/<button type="button" class="sdx-device-description-toggle" title="Accounting\nroom 2.14" aria-expanded="false"><span class="sdx-device-description-text sdx-device-description-line">Accounting\nroom 2.14<\/span><svg[^>]*class="lucide lucide-chevron-down[^"]*sdx-device-description-chevron"[^>]*aria-hidden="true"/.test(html),'a text with a line break is a collapsed button with a trailing chevron (DV-header-8)');
ok(!/chevron/.test(renderDescription('Accounting, room 2.14')),'a description that is not expandable has no chevron');
check(renderDescription(''),'','empty with the right: nothing, "Add description…" is in More actions');
check(renderDescription('',{viewer:reader,server:device({permissions:['view'],description:''})}),'','empty without the right: nothing');
const descriptionSource=read('ui/devices/device/device-description.tsx');
ok(!/\bvariant\??:/.test(descriptionSource.match(/type Props=\{[\s\S]*?\n\};/)[0])&&!/variant==='card'|<Card\b/.test(descriptionSource),'DeviceDescription has no variant prop and no card branch');

// ---- Source checks ----
const deviceSource=read('ui/devices/device/device.tsx'),consoleSource=read('ui/shell/console.tsx');
ok(!/devicePanels|DevicePanel/.test(read('lib/console-route.ts')),'there are no device panels any more');
ok(!/onPanel\('tags'\)|panel==='tags'/.test(deviceSource),'device.tsx has no Tags nav link or panel');
ok(/<DeviceTags /.test(deviceSource)&&/className="sdx-device-meta"/.test(deviceSource),'the header shows the metadata block with DeviceTags');
ok(!/device-description/.test(read('ui/devices/device/device-summary.tsx')),'device-summary.tsx does not import the description');
const deviceView=consoleSource.match(/<DeviceView\s[\s\S]*?\/>\s*:/)[0];
ok(!/ tags=/.test(deviceView),'console.tsx passes no tags panel to DeviceView');
ok(/onOpenTagOrigin=\{openTagOrigin\}/.test(deviceView),'DeviceView gets the origin opener');
const {navNodes}=await import('../../../ui/shell/nav-model.ts');
ok(/<HelpHost overlays=\{overlays\} route=\{shownRoute\}\/>/.test(consoleSource)&&/<HelpPanel open=\{open\} onOpenChange=\{overlays\.setHelp\} route=\{route\}\/>/.test(read('ui/shell/overlay-hosts.tsx'))&&!navNodes.some(node=>node.route.view==='device'&&node.help==='tags'),'no device area or panel has the tags help topic');
ok(!/\.sdx-description-card/.test(read('ui/styles/console.css')),'console.css has no description card');
check(['device.description.empty' in en,'device.description.empty' in de],[false,false],'the unused key is gone from both catalogs');
for(const key of ['device.tags.remove','device.tags.openOriginNamed','device.tags.added','device.tags.moreCount','device.tags.showFewer'])check([typeof en[key],typeof de[key]],['string','string'],`${key} in both catalogs`);
for(const key of ['device.tags.openOrigin','device.tags.inheritedTitle'])check([key in en,key in de],[false,false],`the unused ${key} is gone from both catalogs`);
ok(!/device\.tags\.openOrigin'|device\.tags\.inheritedTitle/.test(read('ui/devices/configuration/device-tags.tsx')),'device-tags.tsx uses neither old key');
// ---- The description toggle keeps the ink color (DV-header-8) ----
const toggleRules=selectors.filter(rule=>rule.selector.split(',').some(part=>part.includes('.sdx-device-description-toggle')));
ok(toggleRules.length>0&&toggleRules.every(rule=>!/accent/.test(rule.body)),'no .sdx-device-description-toggle rule uses an accent color');
ok(toggleRules.some(rule=>/:hover/.test(rule.selector)&&/:focus-visible/.test(rule.selector)&&/color:\s*var\(--sd-ink\)/.test(rule.body)),'hover, focus, pressed and expanded keep --sd-ink');
const chevronRule=selectors.find(rule=>rule.selector.includes('[aria-expanded="true"] > .sdx-device-description-chevron'));
ok(chevronRule&&/rotate\(180deg\)/.test(chevronRule.body),'the chevron turns 180° when expanded');
ok(selectors.some(rule=>rule.selector==='.sdx-device-description-chevron'&&/color:\s*var\(--sd-muted\)/.test(rule.body)),'the chevron is muted');

console.log(`PASS device header metadata (${checks} checks): header tag chips, remove buttons, inherited origin, overrides, rights, demo, one-line description and the removed Tags panel and Description card.`);
