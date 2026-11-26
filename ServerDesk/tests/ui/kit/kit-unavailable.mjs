// The concrete reason of a blocked panel (ui/devices/device/device-unavailable.ts) and the kit Unavailable
// (ui/kit/kit.tsx), rendered with React SSR: the reason order, the info Notice with one icon
// and a full sentence per reason in both languages, children and action. Then a source scan of the
// Diagnostics and Remote panels (no CapabilityNote, ErrorNote, LoadingSkeleton, shadcn controls,
// DetailDrawer or autoConnect) and of diagnostics-workspace.css. No browser, no server.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {postcss} from '../../support/theme-colors.mjs';
const h=React.createElement;
const {unavailableReason}=await import('../../../ui/devices/device/device-unavailable.ts');
const {Unavailable}=await import('../../../ui/kit/kit.tsx');
const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
const en=(await import('../../../lib/i18n/messages/en.ts')).default;
const de=(await import('../../../lib/i18n/messages/de.ts')).default;
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const render=(element,locale='en')=>renderToStaticMarkup(h(LocaleProvider,{locale},element));
const read=file=>readFileSync(file,'utf8');

// ---- unavailableReason: every reason and the order ----
const open={demo:false,revoked:false,permitted:true,reported:true,supported:true};
check(unavailableReason(open),null,'nothing blocks: null');
check(unavailableReason({...open,management:true,online:true}),null,'Management on and online: null');
check(unavailableReason({...open,demo:true}),'demo','a sample device');
check(unavailableReason({...open,revoked:true}),'revoked','a revoked agent');
check(unavailableReason({...open,permitted:false}),'right','a missing right');
check(unavailableReason({...open,reported:false}),'unreported','no snapshot yet');
check(unavailableReason({...open,supported:false}),'agent','an agent that cannot do it');
check(unavailableReason({...open,management:false}),'mode','Management mode off');
check(unavailableReason({...open,online:false}),'offline','offline');
check(unavailableReason({demo:true,revoked:true,permitted:false,reported:false,supported:false,management:false,online:false}),'demo','demo wins over everything');
check(unavailableReason({...open,demo:true,permitted:false}),'demo','demo wins over a missing right');
check(unavailableReason({...open,revoked:true,permitted:false}),'revoked','revoked comes before the right');
check(unavailableReason({...open,permitted:false,reported:false}),'right','a missing right wins over not reported');
check(unavailableReason({...open,reported:false,supported:false}),'unreported','not reported wins over the agent version');
check(unavailableReason({...open,supported:false,management:false}),'agent','the agent version wins over the mode');
check(unavailableReason({...open,management:false,online:false}),'mode','the mode wins over offline');
check(unavailableReason({...open,management:undefined,online:undefined}),null,'management and online are ignored when undefined');

// ---- Unavailable: info Notice, one icon, the sentence of each reason ----
const reasons=['demo','revoked','right','unreported','agent','mode','offline'];
const icons={demo:'flask-conical',revoked:'ban',right:'lock',unreported:'clock-3',agent:'circle-arrow-up',mode:'shield-check',offline:'wifi-off'};
const sentences={
 en:{demo:'Not available for sample devices.',revoked:'This device can no longer connect to Nodiverna because its agent access was revoked. Register the device again to use this.',right:'You don\'t have permission for this on this device.',unreported:'This is available after the agent on this device reports for the first time.',agent:'The agent on this device is too old for this. Update the agent to use it.',mode:'Turn on Management mode on the device itself to use this.',offline:'This is available again when the device is online.'},
 de:{demo:'Bei Beispielgeräten nicht möglich.',revoked:'Dieses Gerät kann sich nicht mehr mit Nodiverna verbinden, weil sein Agentzugriff widerrufen wurde. Registriere das Gerät neu, um das zu nutzen.',right:'Dir fehlt auf diesem Gerät die Berechtigung dafür.',unreported:'Das ist verfügbar, sobald der Agent auf diesem Gerät zum ersten Mal gemeldet hat.',agent:'Der Agent auf diesem Gerät ist dafür zu alt. Aktualisiere den Agent, um es zu nutzen.',mode:'Schalte direkt auf dem Gerät den Verwaltungsmodus ein, um das zu nutzen.',offline:'Das ist wieder verfügbar, sobald das Gerät online ist.'},
};
const decode=text=>text.replace(/&#x27;/g,"'").replace(/&quot;/g,'"').replace(/&amp;/g,'&');
for(const reason of reasons){
 check([en['kit.unavailable.'+reason],de['kit.unavailable.'+reason]],[sentences.en[reason],sentences.de[reason]],reason+': the sentence in both catalogs');
 for(const locale of ['en','de']){
  const html=render(h(Unavailable,{reason}),locale);
  ok(html.startsWith('<div class="sdx-notice sdx-notice-info" role="status">'),`${reason} (${locale}): an info Notice with role="status"`);
  check((html.match(/<svg/g)??[]).length,1,`${reason} (${locale}): one icon`);
  ok(html.includes(`lucide-${icons[reason]}`),`${reason} (${locale}): the ${icons[reason]} icon`);
  ok(decode(html).includes(`<div>${sentences[locale][reason]}</div>`),`${reason} (${locale}): the full sentence`);
 }
}
let html=render(h(Unavailable,{reason:'right'},'You don\'t have permission to run diagnostics on this device.'));
ok(decode(html).includes('<div>You don\'t have permission to run diagnostics on this device.</div>')&&!decode(html).includes(sentences.en.right),'children replace the default sentence');
html=render(h(Unavailable,{reason:'offline',action:h('button',{type:'button'},'Try again')}));
ok(/<\/div><button type="button">Try again<\/button><\/div>$/.test(html),'the action renders after the sentence');
const kit=read('ui/kit/kit.tsx');
const component=kit.slice(kit.indexOf('const unavailableIcons'),kit.indexOf('/** Relative time for timestamps'));
ok(component.includes('export function Unavailable')&&!component.includes('{feature}')&&!/\bfeature\??:/.test(component),'no sentence is built from a feature fragment');
for(const key of reasons.map(reason=>'kit.unavailable.'+reason))ok(!en[key].includes('{')&&!de[key].includes('{'),key+' has no parameter');

// ---- Source scan: the Diagnostics and Remote panels ----
for(const file of ['ui/devices/diagnostics/diagnostics-panels.tsx','ui/devices/remote/file-panel.tsx','ui/devices/remote/file-browser.tsx','ui/devices/remote/terminal-panel.tsx']){
 const source=read(file);
 for(const removed of ['CapabilityNote','ErrorNote','LoadingSkeleton'])ok(!source.includes(removed),`${file} has no ${removed}`);
 ok(source.includes('unavailableReason(')&&source.includes('<Unavailable'),`${file} names the concrete reason through unavailableReason and Unavailable`);
}
for(const file of ['ui/devices/diagnostics/diagnostics-panels.tsx','ui/devices/remote/terminal-panel.tsx'])ok(!read(file).includes('@/components/ui/'),`${file} imports nothing from @/components/ui/`);
ok(!read('ui/devices/diagnostics/diagnostics-panels.tsx').includes('DetailDrawer'),'diagnostics-panels.tsx uses the kit Drawer, no DetailDrawer');
ok(!read('ui/devices/device/device.tsx').includes('autoConnect')&&!read('ui/devices/remote/terminal-panel.tsx').includes('autoConnect'),'no autoConnect in device.tsx or the terminal');
ok(!read('ui/base/api.tsx').includes('CapabilityNote'),'CapabilityNote is gone from ui/base/api.tsx');
ok(!read('ui/devices/remote/rdp-panel.tsx').includes('ErrorNote')&&read('ui/devices/remote/rdp-panel.tsx').includes('<LoadFailed text={error} loading={checking} onRetry={()=>void discover()}/>'),'rdp-panel.tsx shows its error as a kit danger Notice, no ErrorNote');
ok(!/'common\.capability\./.test(read('lib/i18n/messages/en.ts')+read('lib/i18n/messages/de.ts')),'the CapabilityNote keys are gone');

// ---- diagnostics-workspace.css ----
ok(!existsSync('app/diagnostics-loading.css'),'diagnostics-loading.css is gone');
const css=read('ui/devices/diagnostics/diagnostics-workspace.css'),tree=postcss.parse(css);
ok(!/#[0-9a-f]{3,8}\b/i.test(css.replace(/\/\*[\s\S]*?\*\//g,''))&&!css.includes('rgba('),'no hex or rgba( values');
let keyframes=0;const small=[],removed=[],radius=[];
tree.walkAtRules('keyframes',()=>{keyframes++;});
tree.walkDecls('font-size',decl=>{const px=decl.value.match(/^([\d.]+)px$/);if(px&&Number(px[1])<12)small.push(decl.toString());});
tree.walkDecls('font',decl=>{const px=decl.value.match(/(?:^|\s)([\d.]+)px/);if(px&&Number(px[1])<12)small.push(decl.toString());});
tree.walkDecls('border-radius',decl=>{if(!/^(var\(--sd-radius(?:-sm|-lg)?\)|99px|0)$/.test(decl.value))radius.push(decl.toString());});
tree.walkRules(rule=>{for(const selector of ['.sd-dx-chips','.sd-dx-sort','.sd-dx-pagination','.sd-event-item','.sd-event-list','.sd-event-exportbar','.sd-event-empty','.sd-diagnosis-loading'])if(rule.selector.includes(selector))removed.push(rule.selector);});
check(keyframes,0,'no @keyframes');
check(small,[],'no font size below 12px');
check(radius,[],'radii are tokens or 99px');
check(removed,[],'the removed selectors are gone');
ok(!read('ui/styles/motion.css').includes('sd-diagnosis-loading'),'motion.css no longer names the diagnosis spinner');

console.log(`PASS kit unavailable (${checks} checks): reason order, the info Notice with one icon and a full sentence per reason in en and de, children and action, no feature fragments, the panel source scan and the diagnostics CSS.`);
