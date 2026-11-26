// The kit Tooltip (ui/kit/tooltip.tsx) and the blocked state of Btn and IconBtn
// (ui/kit/kit.tsx), rendered with React SSR: a blocked button stays focusable
// (aria-disabled, no native disabled, no title) and names its reason through aria-describedby;
// its activation handlers cancel click, Enter and Space, so no caller action and no form submit
// runs. Available icon buttons show their label in the Tooltip instead of a native title. Then the
// CSS of the blocked look and the tooltip, the refresh button of an offline device and "Delete
// group" in the settings of a group with subgroups. No browser, no server.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {postcss,colorLiterals} from '../../support/theme-colors.mjs';
import {buttons} from '../../support/blocked-buttons.mjs';
const h=React.createElement;
const kit=await import('../../../ui/kit/kit.tsx');
const {Tooltip,TooltipProvider}=await import('../../../ui/kit/tooltip.tsx');
const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
const {default:DeviceView}=await import('../../../ui/devices/device/device.tsx');
const {GroupSettings}=await import('../../../ui/devices/fleet/groups.tsx');
const {demoData}=await import('../../../ui/shell/demo.ts');
const {translate}=await import('../../../lib/i18n/translate.ts');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const render=(element,locale='en')=>renderToStaticMarkup(h(LocaleProvider,{locale},element));
const noop=()=>{};
const Icon=()=>h('i',{'aria-hidden':true});
const read=file=>readFileSync(file,'utf8');
const one=html=>{const list=buttons(html);assert.equal(list.length,1,`one button in ${html}`);return list[0];};
const srOnly=(html,id)=>html.match(new RegExp(`<span id="${id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}" class="sr-only" aria-hidden="true">([^<]*)</span>`))?.[1]??null;

// ---- Btn blocked ----
let html=render(h(kit.Btn,{blocked:'No changes.',variant:'primary',onClick:()=>{throw new Error('ran');}},'Save'));
let button=one(html);
ok(button.blocked&&!button.disabled,'blocked: aria-disabled="true", no native disabled');
check(button.title,null,'blocked: no title');
const id=button.attributes.match(/aria-describedby="([^"]+)"/)?.[1];
ok(id,'blocked: aria-describedby names the reason');
check(srOnly(html,id),'No changes.','the reason sits in a persistent sr-only element, outside the accessible name');
ok(/<span>Save<\/span>/.test(button.inner),'the label stays the visible content');
ok(!/tabindex="-1"/.test(button.attributes),'focusable with Tab');

// ---- IconBtn blocked ----
html=render(h(kit.IconBtn,{icon:Icon,label:'Refresh inventory',shortcut:'R',blocked:'The device is offline'}));
button=one(html);
ok(button.blocked&&!button.disabled&&button.title===null,'IconBtn blocked: aria-disabled, no disabled, no title');
check(button.description,'The device is offline','IconBtn blocked: the reason is the description');
check([button.label,/aria-keyshortcuts="R"/.test(button.attributes)],['Refresh inventory',true],'name and shortcut stay');

// ---- IconBtn and Btn available ----
html=render(h(kit.IconBtn,{icon:Icon,label:'Refresh data',shortcut:'R',pressed:true}));
button=one(html);
ok(!button.blocked&&!button.disabled&&button.title===null,'available IconBtn: no native title (the Tooltip shows the label)');
ok(/aria-label="Refresh data"/.test(button.attributes)&&/aria-keyshortcuts="R"/.test(button.attributes)&&/aria-pressed="true"/.test(button.attributes),'aria-label, aria-keyshortcuts and aria-pressed stay');
ok(!/aria-describedby/.test(button.attributes),'the label is not repeated as a description');
check([kit.iconButtonTip('Refresh data','R','Ctrl'),kit.iconButtonTip('Search','Control+K',translate('en','kit.ctrl')),kit.iconButtonTip('Suchen','Control+K',translate('de','kit.ctrl')),kit.iconButtonTip('Close',undefined,'Ctrl')],['Refresh data (R)','Search (Ctrl+K)','Suchen (Strg+K)','Close'],'the icon button tooltip: label with the shortcut, Control as kit.ctrl');
html=render(h(kit.Btn,{hint:'Opens the device list'},'Devices'));
button=one(html);
ok(button.title===null&&button.description==='Opens the device list'&&!button.blocked,'Btn hint: in the Tooltip and the description, no title');
html=render(h(kit.Btn,null,'Plain'));
ok(!/aria-describedby|title=|aria-disabled/.test(one(html).attributes),'a plain Btn has no description');

// ---- disabled and loading keep the native attribute; loading wins over blocked ----
button=one(render(h(kit.Btn,{disabled:true},'Off')));
ok(button.disabled&&/aria-disabled="true"/.test(button.attributes),'disabled: native disabled as before');
button=one(render(h(kit.Btn,{loading:true,blocked:'No changes.'},'Save')));
ok(button.disabled&&/aria-busy="true"/.test(button.attributes)&&!button.description,'loading wins over blocked: native disabled, aria-busy, no reason');
button=one(render(h(kit.IconBtn,{icon:Icon,label:'Refresh',loading:true})));
ok(button.disabled&&!/aria-disabled/.test(button.attributes),'IconBtn loading: native disabled');
button=one(render(h(kit.IconBtn,{icon:Icon,label:'Refresh',disabled:true})));
ok(button.disabled,'IconBtn disabled: native disabled');

// ---- Activation of a blocked button ----
{
 const event=(extra={})=>{const record={prevented:0,preventDefault(){record.prevented++;},...extra};return record;};
 const calls=[];
 const caller={onClick:()=>calls.push('click'),onKeyDown:()=>calls.push('keydown'),onKeyUp:()=>calls.push('keyup'),onPointerDown:()=>calls.push('pointerdown'),onMouseDown:()=>calls.push('mousedown')};
 let taps=0;
 const blocked=kit.buttonHandlers(true,caller,()=>taps++);
 const click=event();blocked.onClick(click);
 check([click.prevented,calls],[1,[]],'a click on a blocked button is prevented and the caller onClick does not run (also a submit, also implicit submission)');
 for(const key of ['Enter',' ']){const down=event({key});blocked.onKeyDown(down);const up=event({key});blocked.onKeyUp(up);check([down.prevented,up.prevented],[1,1],`${key==='Enter'?'Enter':'Space'} is cancelled`);}
 const tab=event({key:'Tab'});blocked.onKeyDown(tab);
 check([tab.prevented,calls],[0,[]],'Tab moves on; no caller key handler runs (a menu trigger does not open)');
 blocked.onPointerDown(event({pointerType:'touch'}));blocked.onPointerDown(event({pointerType:'mouse'}));
 check([taps,calls,blocked.onMouseDown],[1,[],undefined],'a tap toggles the reason; no caller pointer handler runs');
 const open=kit.buttonHandlers(false,caller);
 ok(open===caller,'an available button keeps the caller handlers');
 const source=read('ui/kit/kit.tsx');
 ok(/<button ref=\{ref\} type=\{type\}[^>]*\{\.\.\.rest\} \{\.\.\.buttonHandlers\(isBlocked,\{onClick,onKeyDown,onKeyUp,onPointerDown,onMouseDown\},\(\)=>setTip\(open=>!open\)\)\}>/.test(source),'Btn: the guarded handlers come after the rest props, so nothing overrides them');
 ok((source.match(/\{\.\.\.buttonHandlers\(isBlocked,/g)??[]).length===2,'Btn and IconBtn both use them');
}

// ---- Refs and asChild triggers ----
{
 let node=null;
 const ref={set current(value){node=value;},get current(){return node;}};
 ok(kit.Btn.$$typeof===Symbol.for('react.forward_ref')&&kit.IconBtn.$$typeof===Symbol.for('react.forward_ref'),'Btn and IconBtn forward their ref');
 html=render(h(kit.Menu,{label:'More',entries:[{id:'a',label:'A',onSelect:noop}],trigger:h(kit.Btn,{ref},'Open')}));
 button=one(html);
 ok(/aria-haspopup="menu"/.test(button.attributes)&&/aria-expanded="false"/.test(button.attributes)&&/data-state="closed"/.test(button.attributes)&&/class="sdx-btn sdx-btn-secondary"/.test(button.attributes),'a Btn as Menu trigger gets the menu props');
 html=render(h(kit.Menu,{label:'More',entries:[{id:'a',label:'A',onSelect:noop}],trigger:h(kit.IconBtn,{icon:Icon,label:'Row actions'})}));
 ok(/aria-haspopup="menu"/.test(one(html).attributes)&&/aria-label="Row actions"/.test(one(html).attributes),'an IconBtn as Menu trigger too');
}

// ---- Tooltip ----
html=render(h(Tooltip,{content:'Hello'},h('button',{type:'button'},'Trigger')));
ok(html==='<button type="button" data-state="closed">Trigger</button>','the closed tooltip renders only its trigger (content is portaled when open)');
html=render(h(TooltipProvider,null,h(Tooltip,{content:'Hello',open:true},h('button',{type:'button'},'Trigger'))));
ok(html.startsWith('<button type="button"'),'it renders inside a shared provider and alone');
html=render(h(Tooltip,{content:'',open:true},h('button',{type:'button'},'Trigger')));
ok(!/describedby/.test(html),'empty content never opens');
{
 const source=read('ui/kit/tooltip.tsx');
 ok(/<TooltipPrimitive\.Trigger asChild>\{children\}<\/TooltipPrimitive\.Trigger>/.test(source)&&/<TooltipPrimitive\.Portal><TooltipPrimitive\.Content className="sdx-tooltip" side=\{side\}/.test(source),'radix Tooltip: asChild trigger, portaled content with .sdx-tooltip');
 ok(/return shared\?root:<TooltipPrimitive\.Provider/.test(source),'a Tooltip without a provider above brings its own');
}

// ---- CSS ----
{
 const css=read('ui/styles/console.css'),root=postcss.parse(css);
 const disabledRules=[];
 root.walkRules(rule=>{for(const selector of rule.selectors)if(/\.sdx-(?:icon-)?btn\b[^,]*:disabled/.test(selector))disabledRules.push(selector);});
 ok(disabledRules.length>=10,`the kit button :disabled rules are found (${disabledRules.length})`);
 for(const selector of disabledRules)ok(/:(?:not|is)\(:disabled, \[aria-disabled="true"\]\)/.test(selector),`${selector} also matches [aria-disabled="true"]`);
 let tooltip=null;root.walkRules('.sdx-tooltip',rule=>{tooltip=rule;});
 ok(tooltip,'.sdx-tooltip exists');
 const decls=Object.fromEntries(tooltip.nodes.filter(node=>node.type==='decl').map(decl=>[decl.prop,decl.value]));
 check([decls.color,decls.background,decls['max-width'],decls['border-radius'],decls['box-shadow'],decls.font,decls.animation],['var(--sd-panel)','var(--sd-ink)','280px','var(--sd-radius-sm)','var(--sd-shadow-md)','500 12px/1.4 var(--sd-font)','sdx-fade var(--sd-dur-fast) var(--sd-ease-out)'],'inverted surface, 12px/1.4, 280px, radius and shadow tokens, the shared fade');
 ok(Number(decls['z-index'])>80,'above menus (80), drawers and dialogs');
 check(colorLiterals(tooltip.toString()),[],'tokens only');
 ok(/\.sdx-tooltip,/.test(read('ui/styles/motion.css').split('prefers-reduced-motion')[1]??''),'no fade under reduced motion');
}

// ---- The refresh button of an offline device ----
{
 const {servers}=demoData(),now=Date.now();
 const offline={...servers[0],lastSeen:now-3*86_400_000};
 const viewer={id:'owner',label:'owner',permissions:['*']};
 const props={server:offline,servers,viewer,demo:false,saving:false,now,section:'overview',onSection:noop,samples:[],historyLoading:false,jobs:[],audit:[],crumbs:[],onConfirm:()=>{throw new Error('no job');},onSelectJob:noop,onCancelJob:noop,onStep:noop,panel:null,onPanel:noop,canOffboard:true};
 html=render(h(DeviceView,props));
 const list=buttons(html),index=list.findIndex(entry=>entry.label==='Refresh inventory'),next=list.findIndex(entry=>entry.label==='Next device');
 ok(index>=0&&list[index].blocked&&!list[index].disabled,'the refresh button is blocked and focusable');
 check(list[index].description,'The device is offline','its description is the offline reason');
 ok(next>=0&&next<index&&list.slice(next+1,index).every(entry=>!entry.disabled),'Tab from "Next device" reaches it: no native disabled button in between');
 html=render(h(DeviceView,props),'de');
 check(buttons(html).find(entry=>entry.label===translate('de','management.action.refresh'))?.description,'Das Gerät ist offline','the German reason');
 html=render(h(DeviceView,{...props,server:servers[0],demo:true,saving:false}));
 // Remove device is a blocked entry of the header's More actions menu (radix renders it only when open): the trigger stays focusable, the entry keeps the reason.
 const more=buttons(html).find(entry=>entry.label==='More actions');
 ok(more&&!more.disabled&&!more.blocked,'the More actions trigger stays focusable on sample devices');
 ok(readFileSync('ui/devices/device/device.tsx','utf8').includes("blocked:demo?t('kit.unavailable.demo'):saving?t('fleet.menu.saving'):undefined"),'the Remove device entry is blocked with the demo reason');
}

// ---- "Delete group" in a group with subgroups ----
{
 const group={id:'g1',name:'Berlin',description:'',parentId:null,depth:1,deviceCount:3,path:'Berlin'};
 const groups=[group,{id:'g2',name:'Mitte',description:'',parentId:'g1',depth:2,deviceCount:1,path:'Berlin / Mitte'}];
 const viewer={id:'owner',label:'owner',permissions:['*']};
 const props={group,groups,viewer,busy:false,demo:false,onUpdate:async()=>{throw new Error('no save');},onCreateChild:noop,onDelete:()=>{throw new Error('no delete');}};
 html=render(h(GroupSettings,props));
 const list=buttons(html);
 const del=list.find(entry=>entry.inner.includes('<span>Delete group</span>')),create=list.findIndex(entry=>/Create subgroup|subgroup/i.test(entry.inner)),save=list.find(entry=>/type="submit"/.test(entry.attributes));
 ok(del?.blocked&&!del.disabled,'"Delete group" is focusable and aria-disabled');
 check(del.description,'Delete or move the subgroups first','with the reason');
 ok(create>=0&&list.indexOf(del)>create,'it follows "Create subgroup" in the Tab order');
 ok(save?.blocked&&!save.disabled&&save.description==='No changes.','"Save" stays focusable, blocked with "No changes."; Enter in the name field clicks it, which is cancelled');
 html=render(h(GroupSettings,props),'de');
 check(buttons(html).find(entry=>entry.inner.includes('<span>Gruppe löschen</span>'))?.description,'Lösche oder verschiebe zuerst die Untergruppen','the German reason');
}

console.log(`PASS kit tooltip (${checks} checks): blocked Btn and IconBtn stay focusable with aria-disabled and a lasting description, cancel click, Enter and Space, show labels and hints in the Tooltip instead of a title, keep refs and asChild triggers; tooltip and blocked CSS; the offline refresh button and "Delete group".`);
