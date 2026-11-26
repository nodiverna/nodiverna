// The kit parts of ui/kit/kit.tsx extracted in Kit III, rendered with React SSR in English:
// SettingsPage (loading, error without and with data, wide, aside), CopyValue (markup, name, the copy with a
// stubbed clipboard that works and fails, the toasts through a mocked sonner, the 1.2 s check),
// CommandBlock (markup, tall, its toast keys), Steps (ol, aria-current, sr-only states), Disclosure,
// DangerZone (region name, blocked danger Btn), PickList and PickRow / PickCheckRow; the
// troubleshooting page on them, with its uninstall card; and SectionHead leading (a back control
// before the text, the markup unchanged without it). No browser, no server.
import {mock} from '../../support/register.mjs';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {buttons} from '../../support/blocked-buttons.mjs';
const toasts=[];
mock('sonner',{toast:{success:text=>toasts.push(['success',text]),error:text=>toasts.push(['error',text]),info:text=>toasts.push(['info',text])},Toaster:()=>null});
const h=React.createElement;
const kit=await import('../../../ui/kit/kit.tsx');
const {SettingsPage,CopyValue,CommandBlock,Steps,Disclosure,DangerZone,PickList,PickRow,PickCheckRow,copyText,copiedFor}=kit;
const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
const {translate}=await import('../../../lib/i18n/translate.ts');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const render=(element,locale='en')=>renderToStaticMarkup(h(LocaleProvider,{locale},element));
const t=(key,params)=>translate('en',key,params);
const text=html=>html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
const noop=()=>{};
const Icon=()=>h('i');

// ---- SettingsPage ----
{
 const card=h('section',{className:'sdx-card'},'General');
 let html=render(h(SettingsPage,{label:'Microsoft Entra ID',loading:true},card));
 ok(/^<div class="sdx-settings-page"><div class="sdx-settings"><div class="sdx-skeleton-set sdx-skeleton-facts" role="status" aria-label="Microsoft Entra ID">/.test(html)&&!html.includes('General'),'loading: the Skeleton with the label takes the place of the children');
 html=render(h(SettingsPage,{label:'Page',loadError:'The settings could not be loaded.',onRetry:noop},null));
 ok(/<div class="sdx-settings"><div class="sdx-notice sdx-notice-danger" role="alert">/.test(html)&&text(html).includes('The settings could not be loaded.')&&buttons(html).map(button=>text(button.inner)).join()===t('common.retry'),'error without data: LoadFailed with Try again in their place');
 html=render(h(SettingsPage,{label:'Page',loading:true,loadError:'Failed.',onRetry:noop},card));
 ok(html.indexOf('sdx-notice-danger')<html.indexOf('General')&&!html.includes('sdx-skeleton'),'error with data: the notice above the children, no Skeleton');
 html=render(h(SettingsPage,{label:'Page',wide:h('table',null)},card));
 ok(/<div class="sdx-settings"><section class="sdx-card">General<\/section><\/div><div class="sdx-settings-wide"><table><\/table><\/div>/.test(html),'wide: full-width content below the 760px column');
 const css=readFileSync('ui/styles/console.css','utf8');
 ok(/\.sdx-settings \{ display: grid; gap: 16px; max-width: 760px; \}/.test(css),'the column is at most 760px wide');
 // aside: a companion column (a live preview), first in the document; without it the markup stays as it was.
 html=render(h(SettingsPage,{label:'Page',aside:h('section',{className:'sdx-card'},'Preview'),wide:h('table',null)},card));
 ok(/^<div class="sdx-settings-page sdx-settings-page-split"><div class="sdx-settings-split"><div class="sdx-settings-aside"><section class="sdx-card">Preview<\/section><\/div><div class="sdx-settings"><section class="sdx-card">General<\/section><\/div><\/div><div class="sdx-settings-wide"><table><\/table><\/div><\/div>$/.test(html),'aside: the split holds the aside before the column, wide content stays below');
 ok(!render(h(SettingsPage,{label:'Page',aside:null},card)).includes('sdx-settings-page-split')&&/^<div class="sdx-settings-page"><div class="sdx-settings">/.test(render(h(SettingsPage,{label:'Page',aside:false},card))),'no aside: the markup of a plain page');
 ok(css.includes('.sdx-settings-page-split { container-type: inline-size; }'),'the split page is an inline-size container');
 const split=/@container \(min-width: 820px\) \{([\s\S]*?)\n\}/.exec(css)?.[1]??'';
 ok(split.includes('.sdx-settings-split { grid-template-columns: minmax(0, 760px) clamp(300px, 38cqi, 480px);')&&split.includes('.sdx-settings-split > .sdx-settings-aside { grid-column: 2; grid-row: 1;')&&split.includes('.sdx-settings-split > .sdx-settings { grid-column: 1; grid-row: 1; }'),'at 820px or wider: the card column (at most 760px), then the aside column');
 ok(/@media \(min-height: 600px\) \{\s*@container \(min-width: 820px\) \{\s*\.sdx-settings-split > \.sdx-settings-aside \{ position: sticky; top: var\(--sd-space-4\); \}/.test(css),'the aside stays in view beside the cards, only in a viewport of 600px or higher');
 ok(!/@container \(max-width[^)]*\) \{[^}]*sdx-settings-aside[^}]*sticky/.test(css)&&(css.match(/sdx-settings-aside \{[^}]*position: sticky/g)??[]).length===1,'below 820px the aside is not sticky');
}

// ---- CopyValue and copyText ----
{
 let html=render(h(CopyValue,{value:'https://portal.example/api/auth/entra/callback',label:'Copy redirect URI'}));
 ok(/^<div class="sdx-copy-value"><code class="mono">https:\/\/portal\.example\/api\/auth\/entra\/callback<\/code><button[^>]*aria-label="Copy redirect URI"/.test(html),'the value in mono, then the copy IconBtn named by label');
 html=render(h(CopyValue,{value:'A, B',label:'Copy permissions',display:h('ul',null,h('li',null,'A'),h('li',null,'B'))}));
 ok(/^<div class="sdx-copy-value sdx-copy-value-custom"><ul><li>A<\/li><li>B<\/li><\/ul><button/.test(html)&&!html.includes('<code'),'display renders other content instead of the code');
 // The copy itself, with a stubbed clipboard.
 const saved=Object.getOwnPropertyDescriptor(globalThis,'navigator');
 const setNavigator=value=>Object.defineProperty(globalThis,'navigator',{value,configurable:true,writable:true});
 try{
  const written=[];
  setNavigator({clipboard:{writeText:async value=>{written.push(value);}}});
  toasts.length=0;
  check(await copyText('value-1',{success:t('kit.copy.done'),failed:t('kit.copy.failed')}),true,'a successful copy resolves true');
  check([written,toasts],[['value-1'],[['success','Copied to the clipboard.']]],'it writes the value and confirms with kit.copy.done');
  setNavigator({clipboard:{writeText:async()=>{throw new Error('denied');}}});toasts.length=0;
  check([await copyText('value-2',{success:'Copied.',failed:t('kit.copy.failed')}),toasts],[false,[['error',t('kit.copy.failed')]]],'a refused write: toast.error(kit.copy.failed)');
  setNavigator({});toasts.length=0;
  check([await copyText('value-3',{success:'Copied.',failed:t('kit.copy.failed')}),toasts],[false,[['error','Nodiverna could not copy the value. Select it and copy it by hand.']]],'no clipboard: the same failure toast');
 }finally{if(saved)Object.defineProperty(globalThis,'navigator',saved);else delete globalThis.navigator;}
 check(copiedFor,1200,'the check shows for 1.2 s');
 const source=readFileSync('ui/kit/kit.tsx','utf8');
 ok(/useEffect\(\(\)=>\(\)=>clearTimeout\(timer\.current\),\[\]\)/.test(source)&&/timer\.current=setTimeout\(\(\)=>setCopied\(false\),copiedFor\)/.test(source),'the 1.2 s timer is cleared on unmount');
 ok(/\{display\?\?<code className=\{mono\?'mono':undefined\}>\{value\}<\/code>\}/.test(source)&&source.includes("success:success??t('kit.copy.done')"),'mono by default; the default success text is kit.copy.done');
}

// ---- CommandBlock ----
{
 const html=render(h(CommandBlock,{label:'Start',command:'Start-Service ServerDeskAgent'}));
 ok(/^<div class="sdx-command"><span class="sdx-command-label">Start<\/span><div class="sdx-command-box"><pre tabindex="0" aria-label="Command: Start"><code>Start-Service ServerDeskAgent<\/code><\/pre><button[^>]*aria-label="Copy command"/.test(html),'label, the pre with a Tab stop and its name, the copy button');
 ok(/<pre class="sdx-command-tall" tabindex="0" aria-label="Command">/.test(render(h(CommandBlock,{command:'x',tall:true}))),'tall, without a label: the plain name');
 const source=readFileSync('ui/kit/kit.tsx','utf8');
 ok(source.includes("useCopy(command,{success:t('troubleshooting.copied'),failed:t('troubleshooting.copyFailed')})"),'the toasts troubleshooting.copied and troubleshooting.copyFailed, with the shared 1.2 s check');
 const page=readFileSync('ui/settings/troubleshooting.tsx','utf8');
 ok(!/function CommandBlock|navigator\.clipboard|<ol |<details/.test(page)&&/import \{[^}]*CommandBlock[^}]*Disclosure[^}]*Steps[^}]*\} from '@\/ui\/kit\/kit';/.test(page),'troubleshooting.tsx uses the kit CommandBlock, Steps and Disclosure; no local copy');
}

// ---- Steps ----
{
 const html=render(h(Steps,{label:'Setup',items:[{id:'a',title:'Register the app',state:'done',children:h('p',null,'Body A')},{id:'b',title:'Test the connection',state:'current'},{id:'c',title:'Turn it on',state:'waiting'},{id:'d',title:'Plain'}]}));
 ok(/^<ol class="sdx-steps" aria-label="Setup">/.test(html),'an ol of steps');
 const items=[...html.matchAll(/<li class="([^"]+)"([^>]*)>(.*?)<\/li>/g)];
 check(items.map(item=>item[1]),['sdx-step sdx-step-done','sdx-step sdx-step-current','sdx-step sdx-step-waiting','sdx-step'],'the state as the tile tone');
 check(items.map(item=>/aria-current="step"/.test(item[2])),[false,true,false,false],'the current step has aria-current="step"');
 ok(items[0][3].includes('lucide-check')&&/<span class="sdx-step-tile" aria-hidden="true">2<\/span>/.test(items[1][3]),'done shows a check, the others their number');
 check(items.map(item=>item[3].match(/<span class="sr-only"> \(([^)]+)\)<\/span>/)?.[1]??null),[t('kit.steps.done'),t('kit.steps.current'),t('kit.steps.waiting'),null],'the state as sr-only text');
 ok(/<div class="sdx-step-body"><p>Body A<\/p><\/div>/.test(html),'the body');
}
// ---- The troubleshooting steps keep their titles, commands and results ----
{
 const {default:Troubleshooting}=await import('../../../ui/settings/troubleshooting.tsx');
 const html=render(h(Troubleshooting,{servers:[],now:Date.now(),onOpenDevice:noop}));
 const steps=html.slice(html.indexOf('<ol class="sdx-steps"'),html.indexOf('</ol>')+5);
 check([...steps.matchAll(/<h3 class="sdx-step-title">([^<]+)</g)].map(match=>match[1]),['services','portal','reports','repair'].map(key=>t(`troubleshooting.${key}.title`)),'the four step titles in order');
 check((steps.match(/<div class="sdx-command">/g)??[]).length,6,'the six commands of the steps: status, portal, health, log, repair, register again');
 check((steps.match(/class="sdx-ts-result"/g)??[]).length,4,'one result line per step');
 ok(/<details class="sdx-disclosure">/.test(html)&&html.includes(t('troubleshooting.tools'))&&(html.match(/class="sdx-command"/g)??[]).length>=10,'"More tools" is a Disclosure with its command blocks');
 // one SettingsPage, the uninstall guide as the last section, a kit Card with Steps and the CommandBlock.
 ok(/^<div class="sdx-settings-page"><div class="sdx-settings"><\/div><div class="sdx-settings-wide"><div class="sdx-ts">/.test(html),'the guide is the wide content of one SettingsPage, at the same inset as the other settings pages');
 const uninstall=html.slice(html.indexOf('<section class="sdx-card" aria-labelledby="sdx-ts-uninstall-title"'));
 ok(uninstall.length<html.length&&html.lastIndexOf('<section class="sdx-card"')===html.indexOf('<section class="sdx-card" aria-labelledby="sdx-ts-uninstall-title"'),'Uninstall is the last card');
 ok(new RegExp(`<h2 id="sdx-ts-uninstall-title"><span class="sdx-icon-tile[^"]*"[^>]*><svg[^>]*lucide-trash2`).test(uninstall)&&uninstall.includes(t('agents.uninstall.title')),'its head: the Trash2 icon tile and "Uninstall the agent"');
 check([...uninstall.matchAll(/<h3 class="sdx-step-title">([^<]+)</g)].map(match=>match[1]),['step1','step2','step3'].map(key=>t(`agents.uninstall.${key}`)),'the three steps');
 const {agentUninstallCommand}=await import('../../../ui/devices/add-device/agent-guide.ts');
 ok((uninstall.match(/<div class="sdx-command">/g)??[]).length===1&&uninstall.includes(agentUninstallCommand.replace(/&/g,'&amp;').replace(/"/g,'&quot;').split(String.fromCharCode(10))[0]),'the uninstall command in one CommandBlock');
 ok(/<a href="#devices\/add">/.test(uninstall)&&uninstall.includes(t('agents.uninstall.downloadedExe')),'the link to the downloaded EXE on Add device');
 ok(!/class="panel|sd-agent-guide/.test(html),'no classic .panel or .sd-agent-guide markup');
 ok(!existsSync('app/agent-installation.tsx'),'app/agent-installation.tsx (with the old AgentUninstallation) does not exist');
}

// ---- Disclosure ----
{
 const html=render(h(Disclosure,{title:'More tools',hint:'Start, stop, crashes.',icon:Icon,open:true,onOpenChange:noop},h('p',null,'Inside')));
 ok(/^<details class="sdx-disclosure" open=""><summary><i><\/i><span class="sdx-disclosure-title"><strong>More tools<\/strong><small>Start, stop, crashes\.<\/small><\/span><svg[^>]*class="lucide lucide-chevron-right sdx-disclosure-caret"/.test(html),'details/summary with the icon, title, hint and the chevron');
 ok(/<div class="sdx-disclosure-body"><p>Inside<\/p><\/div><\/details>$/.test(html),'the body');
 ok(!/ open=""/.test(render(h(Disclosure,{title:'Closed',open:false},'x'))),'closed without open');
 const css=readFileSync('ui/styles/console.css','utf8');
 ok(/\.sdx-disclosure\[open\] \.sdx-disclosure-caret \{ transform: rotate\(90deg\); \}/.test(css)&&!/\.sdx-disclosure > summary:focus-visible/.test(css),'the chevron turns when open; the focus ring is the global one');
 const page=readFileSync('ui/settings/troubleshooting.tsx','utf8');
 ok(page.includes('<Disclosure ref={tools}')&&page.includes('tools.current?.scrollIntoView'),'troubleshooting keeps the ref for the scroll into view');
}

// ---- DangerZone ----
{
 const html=render(h(DangerZone,{title:'Delete group',description:'Devices move to No group.',label:'Delete group',icon:Icon,blocked:'Delete or move the subgroups first',onClick:noop}));
 const titleId=html.match(/<section class="sdx-danger-zone" aria-labelledby="([^"]+)">/)?.[1];
 ok(titleId&&new RegExp(`<strong id="${titleId}">Delete group</strong><p>Devices move to No group\\.</p>`).test(html),'a section labelled by its title, with the consequence sentence');
 const [button]=buttons(html);
 ok(/sdx-btn-danger/.test(button.attributes)&&button.blocked&&!button.disabled&&button.description==='Delete or move the subgroups first','one danger Btn, blocked with its reason and still focusable');
 ok(/aria-busy="true"/.test(render(h(DangerZone,{title:'X',description:'Y',label:'Z',loading:true,onClick:noop}))),'loading passes on');
 ok(!/disabled/.test(readFileSync('ui/kit/kit.tsx','utf8').match(/export function DangerZone[^\n]*/)[0]),'DangerZone has no native disabled: loading or blocked only');
}

// ---- PickList, PickRow, PickCheckRow ----
{
 let html=render(h(PickList,{mode:'radio',label:'Target group',search:{value:'',onChange:noop,label:'Filter groups',placeholder:'Search'}},h(PickRow,{selected:true,icon:h(Icon),label:'Berlin',hint:'3 devices',onSelect:noop}),h(PickRow,{selected:false,icon:h(Icon),label:'Munich',onSelect:noop})));
 ok(/^<div class="sdx-pick"><label class="sdx-searchfield sdx-pick-search">.*<input type="search" aria-label="Filter groups" placeholder="Search" value=""\/><\/label><div class="sdx-pick-list" role="radiogroup" aria-label="Target group">/.test(html),'radio: the search field, then a named radiogroup');
 check([...html.matchAll(/<button type="button" role="radio" aria-checked="(true|false)"/g)].map(match=>match[1]),['true','false'],'PickRow: role radio with aria-checked');
 html=render(h(PickList,{mode:'checkbox',label:'Devices'},h(PickCheckRow,{checked:true,icon:h(Icon),label:'SRV-01',hint:'No group',onChange:noop})));
 ok(/<div class="sdx-pick-list" role="group" aria-label="Devices"><label class="sdx-pick-row selected"><input type="checkbox" class="sdx-check" checked=""\/>/.test(html),'checkbox: a named group of checkbox rows');
 // blocked: the row stays focusable (no native disabled) with aria-disabled, the reason is a second hint line that the box names.
 html=render(h(PickList,{mode:'checkbox',label:'Users and user groups'},h(PickCheckRow,{checked:false,icon:h(Icon),label:'Anna',hint:'anna@example.test',blocked:'Adding is not possible now.',onChange:noop})));
 const blockedBox=html.match(/<input[^>]*>/)[0],reasonId=blockedBox.match(/aria-describedby="([^"]+)"/)?.[1];
 ok(/<label class="sdx-pick-row sdx-pick-blocked">/.test(html)&&/aria-disabled="true"/.test(blockedBox)&&!/\sdisabled/.test(blockedBox),'blocked: aria-disabled, still focusable');
 ok(reasonId&&html.includes(`<small>anna@example.test</small><small id="${reasonId}" class="sdx-pick-reason">Adding is not possible now.</small>`),'the reason is the second hint line and the box describes itself with it');
 const changes=[];let cancelled=0;const event={preventDefault(){cancelled++;},target:{checked:true}};
 const lockedHandlers=kit.pickCheckHandlers(true,value=>changes.push(value));lockedHandlers.onClick(event);lockedHandlers.onChange(event);
 const openHandlers=kit.pickCheckHandlers(false,value=>changes.push(value));openHandlers.onChange(event);
 check([cancelled,changes,openHandlers.onClick],[1,[true],undefined],'blocked: a click is cancelled and reports nothing; available: the change reports the new state');
 ok(!/sdx-pick-blocked|aria-disabled/.test(render(h(PickCheckRow,{checked:true,icon:h(Icon),label:'Ben',onChange:noop}))),'an available row has no blocked look');
 // A pressed toggle Btn (the weekdays of a maintenance window).
 ok(/<button type="button" class="sdx-btn sdx-btn-secondary sdx-btn-sm" aria-pressed="true"[ >]/.test(render(h(kit.Btn,{size:'sm',pressed:true},'Mon'))),'Btn pressed: aria-pressed');
 ok(!/aria-pressed/.test(render(h(kit.Btn,{},'Plain'))),'a plain Btn has no aria-pressed');
 ok(readFileSync('ui/styles/console.css','utf8').includes('.sdx-btn-secondary[aria-pressed="true"] { color: var(--sd-accent-strong); background: var(--sd-accent-soft);'),'the pressed look is the accent-soft selection'); html=render(h(PickList,{mode:'radio',label:'Target group',empty:h('p',null,'No groups match.')},[]));
 ok(html==='<div class="sdx-pick"><p>No groups match.</p></div>','the empty slot shows when there are no rows');
 for(const file of ['ui/settings/notifications-panel.tsx','ui/devices/monitoring/alarms.tsx','ui/devices/device/device-name.tsx'])ok(/import \{[^}]*\bPickRow\b[^}]*\} from '@\/ui\/kit\/kit';/.test(readFileSync(file,'utf8')),`${file} imports PickRow from the kit`);
 const groups=readFileSync('ui/devices/fleet/groups.tsx','utf8');
 ok(!/export function PickRow/.test(groups)&&(groups.match(/<PickList mode=/g)??[]).length===2&&!groups.includes('className="sdx-pick-list"'),'groups.tsx: PickRow moved, Move and Assign render through PickList');
}

// ---- Btn count: the badge after the label, the name with the number ----
{
 const tag=html=>html.match(/<button[^>]*>/)[0],label=html=>tag(html).match(/\saria-label="([^"]*)"/)?.[1]??null;
 const three=render(h(kit.Btn,{count:3,countLabel:'Agent updates, 3 available'},'Agent updates'));
 ok(three.includes('<span>Agent updates<b class="sdx-btn-count" aria-hidden="true">3</b></span>'),'count 3: the badge after the label, hidden from the name');
 check(label(three),'Agent updates, 3 available','count 3 with countLabel: the aria-label says the number');
 const zero=render(h(kit.Btn,{count:0,countLabel:'Agent updates, 0 available'},'Agent updates'));
 ok(!zero.includes('sdx-btn-count')&&label(zero)===null,'count 0: no badge and no aria-label');
 const unset=render(h(kit.Btn,{countLabel:'Agent updates, 3 available'},'Agent updates'));
 ok(!unset.includes('sdx-btn-count')&&label(unset)===null,'countLabel without count: no aria-label');
 const bare=render(h(kit.Btn,{count:2},'Filter'));
 ok(bare.includes('<span>Filter<b class="sdx-btn-count" aria-hidden="true">2</b></span>')&&label(bare)===null,'count without countLabel: the badge, the visible text stays the name');
}

// ---- SectionHead leading ----
{
 const {SectionHead,IconBtn}=kit;
 const back=h(IconBtn,{icon:Icon,label:'Back to Extensions',onClick:noop});
 const plain=render(h(SectionHead,{title:'DHCP server',hideTitle:true,id:'head',meta:'read 6 min ago',actions:h('button',null,'Read again')}));
 check(plain,'<header class="sdx-section-head"><div class="sdx-section-head-text"><h2 id="head" class="sr-only">DHCP server</h2><p class="sdx-section-head-meta">read 6 min ago</p></div><div class="sdx-section-head-actions"><button>Read again</button></div></header>','without leading the markup is unchanged');
 for(const empty of [undefined,null,false,''])check(render(h(SectionHead,{title:'DHCP server',hideTitle:true,id:'head',meta:'read 6 min ago',actions:h('button',null,'Read again'),leading:empty})),plain,`leading ${JSON.stringify(empty)} renders no wrapper`);
 const led=render(h(SectionHead,{title:'DHCP server',hideTitle:true,id:'head',meta:'read 6 min ago',actions:h('button',null,'Read again'),leading:back}));
 ok(/^<header class="sdx-section-head"><div class="sdx-section-head-lead"><button[^>]*aria-label="Back to Extensions"[^>]*>.*<\/button><\/div><div class="sdx-section-head-text">/.test(led),'leading: the wrapper is the first child of the header, before the text');
 ok(led.indexOf('sdx-section-head-lead')<led.indexOf('sdx-section-head-actions')&&!/sdx-section-head-actions">[^]*Back to Extensions/.test(led),'the leading control is not in the actions');
 {
  // The tinted variant ("Ask assistant" in the device header): a flat accent tint, never the gradient or the danger tone.
  const tinted=render(h(kit.Btn,{variant:'tinted',icon:Icon,'aria-expanded':false},'Ask assistant'))
  ok(/^<button type="button" class="sdx-btn sdx-btn-tinted" aria-expanded="false"[ >]/.test(tinted)&&tinted.includes('<span>Ask assistant</span>'),'Btn variant="tinted": class sdx-btn sdx-btn-tinted with its label');
  const tintedIcon=render(h(kit.IconBtn,{variant:'tinted',icon:Icon,label:'Ask assistant'}));
  ok(/^<button type="button" class="sdx-icon-btn sdx-btn-tinted" aria-label="Ask assistant"/.test(tintedIcon),'IconBtn variant="tinted": class sdx-icon-btn sdx-btn-tinted with its aria-label');
  const blockedTinted=render(h(kit.Btn,{variant:'tinted',blocked:'Not available for sample devices.'},'Ask assistant'));
  ok(/class="sdx-btn sdx-btn-tinted" aria-disabled="true" aria-describedby="([^"]+)"/.test(blockedTinted)&&blockedTinted.includes('Not available for sample devices.'),'a blocked tinted Btn keeps aria-disabled and its reason');
  ok(/class="sdx-btn sdx-btn-tinted" aria-pressed="true"/.test(render(h(kit.Btn,{variant:'tinted',pressed:true},'On'))),'a tinted Btn passes pressed like the other variants');
  const css=readFileSync('ui/styles/console.css','utf8');
  ok(css.includes(':is(.sdx, .sdx-layer) .sdx-btn-tinted { color: var(--sd-accent-strong); background: var(--sd-accent-soft); border-color: color-mix(in srgb, var(--sd-accent) 40%, transparent); box-shadow: var(--sd-shadow-sm); font-weight: 600; }'),'the tinted rest look: strong accent on accent-soft, 40% accent border, the small shadow');
  ok(css.includes(':is(.sdx, .sdx-layer) .sdx-btn-tinted:hover:not(:disabled, [aria-disabled="true"]) { color: var(--sd-accent-strong); background: color-mix(in srgb, var(--sd-accent) 16%, var(--sd-panel)); border-color: color-mix(in srgb, var(--sd-accent) 50%, transparent); }'),'the tinted hover, not on a blocked button');
  ok(css.includes(':is(.sdx, .sdx-layer) .sdx-btn-tinted[aria-expanded="true"] { color: var(--sd-accent-strong); background: color-mix(in srgb, var(--sd-accent) 16%, var(--sd-panel));'),'the tinted open state (aria-expanded)');
  const tintedRules=[...css.matchAll(/([^{}]*sdx-btn-tinted[^{}]*)\{([^{}]*)\}/g)];
  ok(tintedRules.length>=4,'the tinted rules are found');
  ok(tintedRules.every(([,,body])=>!/--sd-accent-grad|--sd-danger|#[0-9a-f]{3,8}\b|rgba?\(|@keyframes|animation/i.test(body)),'no tinted rule uses the gradient, the danger tone, a color literal or an animation');
  // It follows the IconBtn rules, so the IconBtn glyph keeps the accent on hover (same specificity, later rule).
  ok(css.indexOf('.sdx-btn-tinted { color')>css.indexOf('.sdx-icon-btn:hover:not(:disabled, [aria-disabled="true"]) { color: var(--sd-ink); }'),'the tinted rules come after the IconBtn hover color');
 }
 const css=readFileSync('ui/styles/console.css','utf8');
 ok(/\.sdx-section-head-lead \{ display: flex; flex: none; align-items: center; height: 32px; \}/.test(css),'the wrapper does not shrink and has the IconBtn height');
 ok(/\.sdx-section-head-lead \+ \.sdx-section-head-text \{ display: flex; flex-direction: column; justify-content: center; min-height: 32px; \}/.test(css),'the text next to it centres a one-line head on the control');
 const narrow=css.slice(css.indexOf('/* SectionHead: the actions wrap below the title. */'));
 ok(/\.sdx-section-head:not\(\.sdx-card-head\) > \.sdx-section-head-lead \+ \.sdx-section-head-text \{ flex-basis: 0; \}/.test(narrow.slice(0,narrow.indexOf('}\n}')+3)),'at 760px or narrower the control and the text keep the first line');
}

console.log(`PASS kit parts (${checks} checks): SettingsPage, CopyValue with copyText and its toasts, CommandBlock, Steps, Disclosure, DangerZone, PickList with PickRow and PickCheckRow (also blocked), the pressed Btn, the tinted Btn and IconBtn, the troubleshooting page on them, the Btn count badge, and SectionHead leading.`);
