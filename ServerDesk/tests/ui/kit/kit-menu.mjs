// The kit Menu (ui/kit/kit.tsx) with a blocked entry, rendered open with React SSR (radix
// portals in place, as in tests/support/panel-harness.mjs): a blocked entry stays in the roving focus
// (no radix disabled), is aria-disabled, names its visible reason through aria-describedby and has no
// title; selecting it runs nothing and keeps the menu open. Available entries are unchanged. Checkbox
// entries (menuitemcheckbox), radio groups (menuitemradio) and submenus follow the same rules.
// No browser, no server.
import {mock} from '../../support/register.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import React from 'react';
import * as radix from 'radix-ui';
import {renderToStaticMarkup} from 'react-dom/server';
const inline=({children})=>children;
// The submenu content renders only while open; SubOpen opens every submenu, so its content shows in the markup.
const SubOpen=({children})=>h(radix.DropdownMenu.Sub,{open:true,onOpenChange(){}},children);
mock('radix-ui',{...radix,DropdownMenu:{...radix.DropdownMenu,Portal:inline}});
const h=React.createElement;
const {Menu,menuEntrySelect,menuCheckboxSelect,menuRadioSelect,submenuEscape}=await import('../../../ui/kit/kit.tsx');
const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const render=element=>renderToStaticMarkup(h(LocaleProvider,{locale:'en'},element));
const attr=(tag,name)=>tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1]??null;
const Icon=()=>h('i');

const calls=[];
const entries=[
 {id:'edit',label:'Change user…',icon:Icon,onSelect:()=>calls.push('edit')},
 {id:'separator',separator:true},
 {id:'delete',label:'Delete user…',icon:Icon,danger:true,blocked:'Not available for sample devices.',onSelect:()=>calls.push('delete')},
];
const html=render(h(Menu,{label:'Actions for Gast',entries,open:true}));
const items=[...html.matchAll(/<div[^>]*role="menuitem"[^>]*>/g)].map(match=>match[0]);
check(items.length,2,'both entries render as menu items');
const [available,blocked]=items;

// ---- The blocked entry ----
ok(attr(blocked,'data-disabled')===null&&!/\sdisabled(=|\s|>)/.test(blocked),'no radix disabled: the roving focus reaches it');
check(attr(blocked,'aria-disabled'),'true','aria-disabled="true"');
ok(/\bsdx-menu-blocked\b/.test(attr(blocked,'class'))&&/\bsdx-menu-danger\b/.test(attr(blocked,'class')),'the blocked look on top of the danger entry');
check(attr(blocked,'title'),null,'no title tooltip');
const reasonId=attr(blocked,'aria-describedby');
ok(!!reasonId,'aria-describedby names the reason');
const reason=html.match(new RegExp(`<small id="${reasonId.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}">([^<]*)</small>`));
check(reason?.[1],'Not available for sample devices.','the reason is the visible small line with that id');

// ---- The available entry is unchanged ----
check([attr(available,'aria-disabled'),attr(available,'aria-describedby'),attr(available,'data-disabled'),attr(available,'title')],[null,null,null,null],'an available entry has no blocked attributes');
ok(!/\bsdx-menu-blocked\b/.test(attr(available,'class')),'and no blocked look');

// ---- Selecting ----
const event=()=>{const value={prevented:false,preventDefault(){value.prevented=true;}};return value;};
let selected=event();menuEntrySelect(entries[2])(selected);
ok(selected.prevented&&calls.length===0,'a blocked entry: preventDefault keeps the menu open, onSelect does not run');
selected=event();menuEntrySelect(entries[0])(selected);
ok(!selected.prevented&&calls.join()==='edit','an available entry: onSelect runs and the menu closes');
// Menu wires every item through menuEntrySelect.
const built=[];
renderToStaticMarkup(h(LocaleProvider,{locale:'en'},h(()=>{built.push(Menu({label:'Actions for Gast',entries,open:true}));return null;})));
const walk=node=>!node||typeof node!=='object'?[]:Array.isArray(node)?node.flatMap(walk):[node,...Object.values(node.props??{}).flatMap(value=>typeof value==='object'?walk(value):[])];
const menuItems=walk(built).filter(node=>node.type===radix.DropdownMenu.Item);
check(menuItems.map(item=>item.props.disabled),[undefined,undefined],'no item gets the radix disabled prop');
calls.length=0;
selected=event();menuItems[1].props.onSelect(selected);
ok(selected.prevented&&calls.length===0,'the rendered blocked item cancels the select');
selected=event();menuItems[0].props.onSelect(selected);
ok(!selected.prevented&&calls.join()==='edit','the rendered available item selects');

// ---- Style: muted ink, not a fade, so the reason keeps its contrast ----
const css=readFileSync('ui/styles/console.css','utf8');
ok(/\.sdx-menu-blocked[^{]*\{[^}]*color: var\(--sd-muted\)/.test(css)&&!/\.sdx-menu-blocked[^{]*\{[^}]*opacity/.test(css),'the blocked entry is muted, without opacity');
ok(/\.sdx-menu-item small \{[^}]*font-size: 12px/.test(css),'the reason is at least 12px');

// ---- Checkbox entries ----
{
 const toggled=[];
 const entries=[{id:'heading',heading:'Visible columns'},{id:'health',label:'Health',checked:true,onCheckedChange:value=>toggled.push(['health',value])},{id:'os',label:'OS',icon:Icon,checked:false,onCheckedChange:value=>toggled.push(['os',value])},{id:'tags',label:'Tags',checked:false,blocked:'Not available for sample devices.',onCheckedChange:value=>toggled.push(['tags',value])}];
 const html=render(h(Menu,{label:'Choose columns',entries,open:true}));
 const items=[...html.matchAll(/<div[^>]*role="menuitemcheckbox"[^>]*>(.*?)<\/div>/g)];
 check(items.map(item=>attr(item[0],'aria-checked')),['true','false','false'],'checkbox entries: menuitemcheckbox with aria-checked');
 ok(items.every(item=>/\bsdx-menu-item sdx-menu-switch\b/.test(attr(item[0],'class'))&&item[1].includes('<span class="sdx-switch-visual" aria-hidden="true"></span>')),'the switch look: sdx-menu-switch and .sdx-switch-visual');
 ok(/sdx-menu-switch-icon/.test(attr(items[1][0],'class'))&&!/sdx-menu-switch-icon/.test(attr(items[0][0],'class')),'with an icon the icon takes the first column');
 const event=()=>{const value={prevented:false,preventDefault(){value.prevented=true;}};return value;};
 let selected=event();menuCheckboxSelect(entries[1])(selected);
 check([selected.prevented,toggled],[true,[['health',false]]],'toggling calls onCheckedChange(!checked) and keeps the menu open');
 // The blocked checkbox entry.
 const blocked=items[2][0],reasonId=attr(blocked,'aria-describedby');
 ok(attr(blocked,'aria-disabled')==='true'&&attr(blocked,'data-disabled')===null&&/sdx-menu-blocked/.test(attr(blocked,'class'))&&new RegExp(`<small id="${reasonId.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}">Not available for sample devices\\.</small>`).test(html),'a blocked checkbox stays in the roving focus, aria-disabled, its visible reason named');
 toggled.length=0;selected=event();menuCheckboxSelect(entries[3])(selected);
 check([selected.prevented,toggled],[true,[]],'a blocked checkbox changes nothing and keeps the menu open');
 // The rendered items use the helper and pass no onCheckedChange to radix (it would run for blocked entries too).
 const built=[];renderToStaticMarkup(h(LocaleProvider,{locale:'en'},h(()=>{built.push(Menu({label:'Choose columns',entries,open:true}));return null;})));
 const nodes=walk(built).filter(node=>node.type===radix.DropdownMenu.CheckboxItem);
 check(nodes.map(node=>[node.props.checked,node.props.onCheckedChange,node.props.disabled]),[[true,undefined,undefined],[false,undefined,undefined],[false,undefined,undefined]],'radix CheckboxItem gets checked only');
 toggled.length=0;selected=event();nodes[2].props.onSelect(selected);nodes[0].props.onSelect(event());
 check(toggled,[['health',false]],'the rendered items toggle through menuCheckboxSelect');
}
// ---- Radio groups ----
{
 const chosen=[];
 const entries=[{id:'theme',label:'Appearance',value:'dark',onValueChange:value=>chosen.push(value),items:[{id:'light',value:'light',label:'Light',icon:Icon},{id:'dark',value:'dark',label:'Dark'},{id:'auto',value:'system',label:'System',blocked:'Your administrator fixed the appearance.'}]}];
 const html=render(h(Menu,{label:'Appearance',entries,open:true}));
 const group=html.match(/<div[^>]*role="group"[^>]*>/)?.[0];
 const labelId=attr(group,'aria-labelledby');
 ok(group&&new RegExp(`id="${labelId.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}"[^>]*>Appearance<`).test(html),'a role="group" named by its label');
 const radios=[...html.matchAll(/<div[^>]*role="menuitemradio"[^>]*>/g)].map(match=>match[0]);
 check(radios.map(item=>attr(item,'aria-checked')),['false','true','false'],'menuitemradio items with aria-checked');
 const blocked=radios[2];
 ok(attr(blocked,'aria-disabled')==='true'&&attr(blocked,'data-disabled')===null&&!!attr(blocked,'aria-describedby')&&html.includes('<small id="'+attr(blocked,'aria-describedby')+'">Your administrator fixed the appearance.</small>'),'a blocked radio item stays focusable with its visible reason');
 const event=()=>{const value={prevented:false,preventDefault(){value.prevented=true;}};return value;};
 let selected=event();menuRadioSelect(entries[0],entries[0].items[0])(selected);
 check([selected.prevented,chosen],[false,['light']],'choosing an item calls onValueChange(value) and closes the menu');
 chosen.length=0;selected=event();menuRadioSelect(entries[0],entries[0].items[2])(selected);
 check([selected.prevented,chosen],[true,[]],'a blocked item changes nothing and keeps the menu open');
 const built=[];renderToStaticMarkup(h(LocaleProvider,{locale:'en'},h(()=>{built.push(Menu({label:'Appearance',entries,open:true}));return null;})));
 const radioGroup=walk(built).find(node=>node.type===radix.DropdownMenu.RadioGroup);
 check([radioGroup.props.value,radioGroup.props.onValueChange],['dark',undefined],'the radix group gets the value, no onValueChange (menuRadioSelect decides)');
 const items=walk(built).filter(node=>node.type===radix.DropdownMenu.RadioItem);
 chosen.length=0;items[2].props.onSelect(event());items[1].props.onSelect(event());
 check(chosen,['dark'],'the rendered items choose through menuRadioSelect');
 ok(attr(render(h(Menu,{label:'Sort',entries:[{id:'sort',value:'a',onValueChange(){},items:[{id:'a',value:'a',label:'A'}]}],open:true})).match(/<div[^>]*role="group"[^>]*>/)[0],'aria-labelledby')===null,'without a label the group has no name reference');
}
// ---- Submenus ----
{
 const picked=[];
 const entries=[{id:'open',label:'Open',onSelect:()=>picked.push('open')},{id:'scheme',label:'Color scheme',icon:Icon,entries:[{id:'aurora',label:'Aurora',onSelect:()=>picked.push('aurora')},{id:'ocean',label:'Ocean',blocked:'Only for Owners.'}]}];
 const closed=render(h(Menu,{label:'More',entries,open:true}));
 const trigger=closed.match(/<div[^>]*aria-haspopup="menu"[^>]*>(.*?)<\/div>/);
 ok(trigger&&/sdx-menu-item sdx-menu-sub/.test(attr(trigger[0],'class'))&&attr(trigger[0],'role')==='menuitem'&&trigger[1].includes('lucide-chevron-right')&&trigger[1].includes('<span>Color scheme</span>'),'the submenu trigger: aria-haspopup="menu", the label and a chevron');
 ok(!closed.includes('Aurora'),'the submenu content waits until it opens');
 // Rendered open (radix Sub with open=true): the content uses .sdx-menu with its entries.
 const built=[];renderToStaticMarkup(h(LocaleProvider,{locale:'en'},h(()=>{built.push(Menu({label:'More',entries,open:true}));return null;})));
 const sub=walk(built).find(node=>typeof node.type==='function'&&node.props?.entry?.id==='scheme');
 let subTree;renderToStaticMarkup(h(()=>{subTree=sub.type(sub.props);return null;}));
 const content=walk(subTree).find(node=>node.type===radix.DropdownMenu.SubContent);
 ok(content.props.className==='sdx-menu','the submenu content uses .sdx-menu');
 const subItems=walk(content).filter(node=>node.type===radix.DropdownMenu.Item);
 check(subItems.map(item=>[item.props.className,item.props['aria-disabled']??null]),[['sdx-menu-item',null],['sdx-menu-item sdx-menu-blocked','true']],'its entries follow the same rules');
 subItems[0].props.onSelect({preventDefault(){}});check(picked,['aurora'],'a submenu entry selects');
 const html=renderToStaticMarkup(h(LocaleProvider,{locale:'en'},h(radix.DropdownMenu.Root,{open:true},h(radix.DropdownMenu.Content,null,h(SubOpen,null,h(radix.DropdownMenu.SubTrigger,null,'x'),h(radix.DropdownMenu.SubContent,{className:'sdx-menu'},h(radix.DropdownMenu.Item,null,'Aurora')))))));
 ok(html.includes('class="sdx-menu"')&&html.includes('Aurora'),'an open submenu renders its .sdx-menu content');
 // Esc closes only the submenu and gives focus back to the trigger.
 const calls=[];const event={prevented:false,preventDefault(){event.prevented=true;}};
 submenuEscape(event,()=>calls.push('close'),{focus:()=>calls.push('focus')});
 check([event.prevented,calls],[true,['close','focus']],'Esc: the whole menu stays, the submenu closes and the trigger takes focus');
 ok(typeof content.props.onEscapeKeyDown==='function','the submenu content handles Esc');
}
// ---- Plain, separator, heading and blocked entries behave as before ----
ok(render(h(Menu,{label:'X',entries:[{id:'s',separator:true},{id:'h',heading:'Only a heading'}],open:true}))==='','a menu without a labelled entry renders nothing');

// ---- The head entry and the content class (the account menu) ----
{
 const head={id:'head',head:h('div',{className:'sdx-account-head'},h('strong',null,'Server User'))};
 const entries=[head,{id:'sep',separator:true},{id:'account',label:'My account',shortcut:'G K',onSelect(){}}];
 const html=render(h(Menu,{label:'Account',entries,open:true,className:'sdx-account-menu'}));
 const content=html.match(/<div[^>]*role="menu"[^>]*>/)[0];
 ok(attr(content,'class')==='sdx-menu sdx-account-menu','the content class name joins .sdx-menu');
 const headTag=html.match(/<div class="sdx-menu-head">/);ok(headTag,'the head renders as .sdx-menu-head');
 const headHtml=html.slice(html.indexOf('<div class="sdx-menu-head">'),html.indexOf('</strong>'));
 ok(!/role="menuitem"|tabindex=/.test(headHtml),'the head is no menuitem and takes no focus');
 check(html.match(/role="menuitem"/g).length,1,'only My account is a menu item');
 ok(html.indexOf('sdx-menu-head')<html.indexOf('role="menuitem"'),'the head comes first');
 ok(render(h(Menu,{label:'X',entries:[head],open:true}))==='','a head alone is no labelled entry');
 const plain=render(h(Menu,{label:'Actions',entries:[{id:'a',label:'A',onSelect(){}}],open:true}));
 ok(attr(plain.match(/<div[^>]*role="menu"[^>]*>/)[0],'class')==='sdx-menu','without className the content keeps .sdx-menu only');
}

console.log(`PASS kit menu (${checks} checks): blocked entries stay focusable, are aria-disabled, describe their visible reason, have no title, and cancel the select; available entries are unchanged; checkbox entries in the switch look keep the menu open, radio groups choose and close, submenus open beside and close alone on Esc.`);
