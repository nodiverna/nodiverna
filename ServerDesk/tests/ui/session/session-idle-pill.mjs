// The idle countdown as a top bar pill: SessionGate provides the idle clock through a context,
// the Topbar shows "Sign-out in m:ss" in place of the freshness text only inside the urgent window, and
// the floating notice is gone. React SSR with the real Topbar; no browser, no server.
import {mock} from '../../support/register.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import * as radix from 'radix-ui';
import {renderToStaticMarkup} from 'react-dom/server';
const inline=({children})=>children;
mock('radix-ui',{...radix,DropdownMenu:{...radix.DropdownMenu,Portal:inline}});
const h=React.createElement;
const shell=await import('../../../ui/shell/shell.tsx');
const {SessionIdleContext,createIdleClock}=await import('../../../ui/session/session-idle.tsx');
const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
let checks=0;
const ok=(value,label)=>{assert.ok(value,label);checks++;};

const hour=3600000,viewer={id:'u1',label:'ada@example.test',username:'ada',displayName:'Ada Lovelace',permissions:[]};
const status={authenticated:true,sessionId:'s1',lastActivityAt:0,verifiedUntil:hour,idleExpiresAt:hour,sessionExpiresAt:24*hour,idleTimeoutMs:hour};
let now=0;const clock=createIdleClock(()=>now);
const topbar=(freshness,value={status,clock},locale='en',demo=false)=>{
 const bar=h(shell.Topbar,{viewer,saving:false,navigatorOpen:false,canToggleNavigator:false,onToggleNavigator(){},onSearch(){},onRefresh(){},loading:false,status:freshness,onHelp(){},onAccount(){},onSignOut(){},demo,onEndDemo(){}});
 return renderToStaticMarkup(h(LocaleProvider,{locale},value?h(SessionIdleContext.Provider,{value},bar):bar));
};
const pillOf=html=>html.match(/<span[^>]*role="timer"[^>]*>[\s\S]*?<\/span><\/span>/)?.[0]??null;

// Before the urgent window (and without any idle context) the freshness text shows.
now=hour-400000;clock.tick();
let html=topbar('Updated 10:00');
ok(html.includes('class="sdx-freshness"')&&html.includes('Updated 10:00'),'outside the urgent window the freshness text shows');
ok(pillOf(html)===null&&!html.includes('role="timer"'),'no pill outside the urgent window');
ok(topbar('Updated 10:00',null).includes('Updated 10:00'),'without SessionGate (no context) the freshness text shows');

// Inside the window: the pill replaces the freshness and the demo freshness.
now=hour-125000;clock.tick();
html=topbar('Updated 10:00');
const pill=pillOf(html);
ok(pill,'the urgent countdown renders the pill');
ok(/role="timer"/.test(pill)&&/aria-label="Automatic sign-out after inactivity"/.test(pill),'role timer with the accessible name');
ok(pill.includes('Sign-out in <b>2:05</b>'),'the pill says Sign-out in 2:05');
ok(/class="sdx-pill sdx-pill-warning sdx-idle-pill"/.test(pill),'a warning StatusPill look');
ok(/<svg[^>]*lucide-clock/.test(pill),'with the clock icon');
const describedBy=pill.match(/aria-describedby="([^"]+)"/)[1];
ok(html.includes(`id="${describedBy}" class="sr-only">You will be signed out soon. Move the pointer or press a key to stay signed in.</span>`),'the hint is its description');
ok(!html.includes('Updated 10:00')&&!html.includes('sdx-freshness'),'the freshness text is not rendered');
ok(!topbar('Sample devices').includes('Sample devices'),'the demo freshness text is not rendered either');
ok(!/<button[^>]*role="timer"/.test(html),'the pill is no button');
ok(topbar('Vor 1 Min.',{status,clock},'de').includes('Abmeldung in <b>2:05</b>'),'German: Abmeldung in 2:05');

// Demo mode (slice 14): inside the urgent window the idle pill replaces the demo pill.
html=topbar('',{status,clock},'en',true);
ok(pillOf(html)&&!html.includes('sdx-demo-pill')&&!html.includes('End sample devices'),'demo mode in the urgent window: the idle pill, no demo pill');

// Activity resets the countdown and removes the pill.
clock.interact();
ok(!topbar('Updated 10:00').includes('role="timer"'),'activity removes the pill');
ok(topbar('Updated 10:00').includes('Updated 10:00'),'and the freshness text is back');
// After the window the demo pill returns.
html=topbar('',{status,clock},'en',true);
ok(!html.includes('role="timer"')&&html.includes('class="sdx-pill sdx-pill-accent sdx-demo-pill"')&&!html.includes('sdx-freshness'),'after the window the demo pill is back');
// A signed-out status shows no pill.
now=hour-125000+60000;clock.tick();
ok(!topbar('x',{status:{...status,authenticated:false},clock}).includes('role="timer"'),'no pill without an authenticated session');

// The floating notice is gone; SessionGate provides the idle context around the console.
ok(!fs.existsSync('app/session-idle-notice.tsx'),'app/session-idle-notice.tsx is deleted');
const gate=fs.readFileSync('ui/session/session-gate.tsx','utf8');
ok(!/SessionIdleNotice|session-idle-notice/.test(gate),'SessionGate renders no floating notice');
ok(gate.includes('<SessionIdleProvider status={status!}>{children}</SessionIdleProvider>'),'SessionGate wraps the console in the idle provider');
const provider=fs.readFileSync('ui/session/session-idle.tsx','utf8');
ok(provider.includes('watchPortalActivity(window')&&provider.includes('setInterval(()=>{if(visible())clock.tick();},1000)'),'activity watching and the 1 s tick live in the provider');
ok(provider.includes('useSyncExternalStore'),'the tick reaches only the pill (external store), not the whole console');
for(const file of ['ui/session/session.css','ui/styles/console.css','ui/styles/motion.css'])ok(!fs.readFileSync(file,'utf8').includes('sd-session-idle-notice'),file+' has no .sd-session-idle-notice CSS');

// Motion: the pill fades in with the shared keyframes and the duration token, numbers without layout shift.
const css=fs.readFileSync('ui/styles/console.css','utf8');
const rule=css.match(/\.sdx-idle-pill \{[^}]*\}/)[0];
ok(/animation: sdx-fade var\(--sd-dur\) var\(--sd-ease-out\)/.test(rule),'the pill fades in with sdx-fade and --sd-dur');
ok(/font-variant-numeric: tabular-nums/.test(rule),'its time uses tabular figures');
ok(!/@keyframes/.test(css),'no new @keyframes next to the component');
const reduced=fs.readFileSync('ui/styles/motion.css','utf8').match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\}/)[0];
ok(reduced.includes('.sdx-idle-pill'),'reduced motion turns the fade off');
// At 900px or narrower the freshness text hides; the pill stays.
const narrow=[...css.matchAll(/@media \(max-width: \d+px\) \{[\s\S]*?\n\}/g)].map(match=>match[0]);
ok(narrow.some(block=>block.includes('.sdx-freshness { display: none; }'))&&!narrow.some(block=>block.includes('sdx-idle-pill')),'the pill also shows at 900px or narrower');

console.log(`PASS session idle pill (${checks} checks): the top bar shows the countdown pill only in the urgent window in place of the freshness, activity removes it, and the floating notice is gone.`);
