// BrandLogo (ui/kit/brand-logo.tsx, docs/branding.md): both variants as decorative images with their size, one
// variant as one image, nothing without a variant, and the stylesheet ui/kit/brand-logo.css that picks the variant of
// the resolved appearance without a script (data-theme light and dark, system through prefers-color-scheme).
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const {BrandLogo}=await import('../../../ui/kit/brand-logo.tsx');

const asset=(slot,width=120,height=32)=>({url:`/api/branding/portal/${slot}?v=0123456789abcdef`,contentType:'image/png',width,height,size:100,updatedAt:1});
const render=props=>renderToStaticMarkup(React.createElement(BrandLogo,props));

const both=render({light:asset('light'),dark:asset('dark',200,40),size:'topbar'});
assert.equal(both.match(/<img /g).length,2,'two images');
assert.ok(both.includes('<img class="sdx-brand-logo-light" src="/api/branding/portal/light?v=0123456789abcdef" alt="" decoding="async" width="120" height="32"/>'),both);
assert.ok(both.includes('<img class="sdx-brand-logo-dark" src="/api/branding/portal/dark?v=0123456789abcdef" alt="" decoding="async" width="200" height="40"/>'),both);
assert.ok(both.includes('<span class="sdx-brand-logo sdx-brand-logo-size-topbar">'),'the size variant');
const one=render({light:null,dark:asset('dark'),size:'session'});
assert.equal(one.match(/<img /g).length,1,'one variant: one image');
assert.ok(!one.includes('sdx-brand-logo-dark')&&one.includes('sdx-brand-logo-size-session'),'it shows in both appearances');
assert.equal(render({light:null,dark:null,size:'topbar'}),'','nothing without a variant');
assert.doesNotMatch(readFileSync('ui/kit/brand-logo.tsx','utf8'),/useState|useEffect|matchMedia/,'no script and no state for the choice');

const css=readFileSync('ui/kit/brand-logo.css','utf8').replace(/\s+/g,' ');
for(const rule of [
 ':root[data-theme="light"] .sdx-brand-logo-dark, :root[data-theme="dark"] .sdx-brand-logo-light { display: none; }',
 ':root[data-theme="system"] .sdx-brand-logo-dark { display: none; }',
 '@media (prefers-color-scheme: dark) { :root[data-theme="system"] .sdx-brand-logo-light { display: none; } :root[data-theme="system"] .sdx-brand-logo-dark { display: block; } }',
 '.sdx-brand-logo-size-topbar img { height: 24px; max-width: 160px; }',
 '@media (max-width: 760px) { .sdx-brand-logo-size-topbar img { max-width: 112px; } }',
 '.sdx-brand-logo-size-session img { height: 40px; max-width: 200px; }',
 'object-fit: contain;',
])assert.ok(css.includes(rule),`the stylesheet has ${rule}`);
console.log('PASS BrandLogo: both variants, one variant, none, and the appearance rules of its stylesheet.');
