// The scope header lines: a group description is its own line, the subtitle holds the
// counts only, and console.tsx renders them through PageHeader description and subtitle.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import '../../support/register.mjs';
const {fleetHeaderLines}=await import('../../../ui/devices/fleet/fleet-header.ts');
const {PageHeader}=await import('../../../ui/shell/shell.tsx');
const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};

// A group with a description: two lines, never joined.
const group=fleetHeaderLines({description:'  Domain controllers and file servers in Berlin  ',count:4,online:3,flagged:1},'de');
check(group,{description:'Domain controllers and file servers in Berlin',subtitle:'4 Geräte · 3 online · 1 mit Hinweisen'},'group with a description: the trimmed description and the counts apart');
ok(!group.subtitle.includes('Berlin'),'the subtitle holds the counts only');
const english=fleetHeaderLines({description:'Branch office',count:1,online:1,flagged:0},'en');
check(english,{description:'Branch office',subtitle:'1 device · 1 online'},'English, no flagged devices');
check(fleetHeaderLines({count:5,online:4,flagged:2},'en').subtitle,'5 devices · 4 online · 2 with issues','English names flagged devices "with issues"; German keeps "mit Hinweisen"');

// Views with only the counts line: a group without a description, All devices, Ungrouped and a customer.
for(const [name,description] of [['group without a description',undefined],['group with a blank description','   '],['All devices',null],['Ungrouped',undefined],['customer',undefined]]){
 const lines=fleetHeaderLines({description,count:12,online:10,flagged:0},'de');
 check(lines,{description:null,subtitle:'12 Geräte · 10 online'},`${name}: only the counts line`);
}

// The header renders the description as its own paragraph above the counts.
const html=renderToStaticMarkup(React.createElement(LocaleProvider,{locale:'de'},React.createElement(PageHeader,{title:'Berlin',description:React.createElement('p',{className:'sdx-page-description'},group.description),subtitle:group.subtitle})));
ok(html.includes('<p class="sdx-page-description">Domain controllers and file servers in Berlin</p>'),'PageHeader renders the description paragraph');
ok(html.includes('4 Geräte · 3 online · 1 mit Hinweisen')&&!html.includes('Berlin · 4'),'and the counts on their own, with no " · " join to the description');

// console.tsx uses the helper and no longer joins the description into the subtitle.
const consoleSource=fs.readFileSync('ui/shell/console.tsx','utf8');
ok(/const fleetLines=fleetHeaderLines\(\{description:currentGroup\?\.description,count:scoped\.length,online,flagged\},locale\);/.test(consoleSource),'console.tsx builds the header lines with fleetHeaderLines');
ok(/description=\{fleetLines\.description\?<p className="sdx-page-description">\{fleetLines\.description\}<\/p>:undefined\}/.test(consoleSource)&&consoleSource.includes('subtitle={fleetLines.subtitle}'),'the description goes into PageHeader description, the counts into subtitle');
ok(!/currentGroup\?\.description,[^\n]*\.join\(' · '\)/.test(consoleSource),'no " · " join of description and counts');
const css=fs.readFileSync('ui/styles/console.css','utf8');
ok(/\.sdx-page-copy p\.sdx-page-description \{[^}]*color: var\(--sd-ink\);[^}]*overflow-wrap: anywhere;/.test(css),'the description is ink and wraps (390px: no sideways scroll)');

console.log(`PASS fleet header (${checks} checks): a group description as its own line, the counts-only subtitle in German and English, the counts-only views, the PageHeader markup and the console wiring.`);
