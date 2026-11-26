// The standalone /remote-desktop page while Remote Desktop is paused (REMOTE_DESKTOP_AVAILABLE false): kit markup only.
// A .sdx wrapper with one kit card that holds the kit Empty (the MonitorPause icon, the title rdp.paused.title as the
// focal point, the sentence rdp.paused.notice, no action), the kit stylesheet imported by the page, and no classic
// .panel, .panel-heading or .sd-rdp-paused* class. Rendered with React SSR in English and German.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

const h=React.createElement;
const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
const {translate}=await import('../../../lib/i18n/translate.ts');
const {default:RemoteDesktopPaused}=await import('../../../ui/devices/remote/remote-desktop-paused.tsx');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};

for(const locale of ['en','de']){
 const html=renderToStaticMarkup(h(LocaleProvider,{locale},h(RemoteDesktopPaused)));
 check(/^<main class="sdx sdx-standalone"><div class="sdx-card"><div class="sdx-empty"><span class="sdx-empty-icon"><svg [^>]*class="lucide lucide-monitor-pause[^"]*"/.test(html),true,`${locale}: .sdx wrapper, kit card, kit Empty with the MonitorPause icon`);
 check(html.includes(`<strong>${translate(locale,'rdp.paused.title')}</strong><p>${translate(locale,'rdp.paused.notice')}</p></div></div></main>`),true,`${locale}: the title, then the one sentence, and no action`);
 check(/class="[^"]*\b(?:panel|panel-heading|sd-rdp-paused[\w-]*)\b/.test(html),false,`${locale}: no classic class`);
 check(/<button\b|<a\b/.test(html),false,`${locale}: no action`);
}
check([translate('en','rdp.paused.title'),translate('de','rdp.paused.title')],['Remote Desktop is paused','Remote Desktop ist pausiert'],'the reused title');

// The page renders it while Remote Desktop is paused and imports the kit stylesheet through it.
const page=fs.readFileSync('app/remote-desktop/page.tsx','utf8'),paused=fs.readFileSync('ui/devices/remote/remote-desktop-paused.tsx','utf8');
check(page.includes("if(!REMOTE_DESKTOP_AVAILABLE)return <RemoteDesktopPaused/>;"),true,'the page shows the paused view while Remote Desktop is not available');
check(paused.includes("import '@/ui/styles/console.css';")&&paused.includes("import {Empty} from '@/ui/kit/kit';"),true,'the kit stylesheet and the kit Empty');
check(fs.existsSync('app/rdp-paused.tsx'),false,'the classic RdpPaused panel is deleted');
// The standalone frame: the .sdx grid without the top bar row, centred on the page background, the card at most 520px wide.
const css=fs.readFileSync('ui/styles/console.css','utf8');
check(css.includes('.sdx.sdx-standalone { grid-template-rows: minmax(0, 1fr); place-items: center; padding: var(--sd-space-5); background: var(--sd-bg); }'),true,'the standalone frame rule');
check(css.includes('.sdx-standalone > .sdx-card { width: min(100%, 520px); padding: var(--sd-space-4); }'),true,'the card width');
check(/\.sd-rdp-paused/.test(fs.readFileSync('ui/devices/remote/rdp.css','utf8')),false,'rdp.css has no paused rules');
console.log(`PASS remote desktop paused page (${checks} checks): kit Empty in a kit card on the .sdx frame, the two catalog texts, no action and no classic class.`);
