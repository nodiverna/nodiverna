// Customer avatars in the navigator (ui/devices/fleet/customer-avatar-model.ts, customer-avatar.tsx, the BrandLogo size
// "avatar" in ui/kit/brand-logo.tsx): the initials (two words, separators, graphemes kept whole, locale upper case, '#'
// without letters or digits), the ratio rule for a logo (0.5 to 2 for every present variant), and the render: the logo
// through BrandLogo size="avatar", the initials tile, aria-hidden, and the kit styles of the avatar size.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const h=React.createElement;
const {customerInitials,customerAvatarLogo,customerAvatarRatio}=await import('../../../ui/devices/fleet/customer-avatar-model.ts');
const {CustomerAvatar}=await import('../../../ui/devices/fleet/customer-avatar.tsx');
const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};

// ---- initials ----
for(const [name,expected,locale='en'] of [
 ['Contoso','C'],['Fabrikam Holding','FH'],['ölwerke nord','ÖN','de'],['Ölwerke Nord','ÖN','de'],['a&b','AB'],['---','#'],
 ['Alpha Beta Gamma','AB'],['  northwind   traders ','NT'],['müller_bau.gmbh','MB','de'],['web/ops','WO'],['4Sight Labs','4L'],
 ['(Contoso) Group','CG'],['+++ Dev','D'],['','#'],['𝐀lpha Omega','𝐀O'],['Ölwerke','Ö'],['istanbul','İ','tr'],
])check(customerInitials(name,locale),expected,`${JSON.stringify(name)} → ${expected}`);
check([...customerInitials('𝐀lpha','en')].length,1,'a surrogate pair stays one grapheme');

// ---- ratio rule ----
const asset=(width,height)=>({url:'/api/branding/asset/x',contentType:'image/png',width,height,size:1,updatedAt:1});
check(customerAvatarRatio,{min:0.5,max:2},'0.5 to 2');
const square={light:asset(64,64),dark:null},wide2={light:asset(128,64),dark:asset(64,128)};
check(customerAvatarLogo(square),square,'1:1 gives the logo');
check(customerAvatarLogo(wide2),wide2,'2:1 and 1:2 give the logo');
check(customerAvatarLogo({light:asset(192,64),dark:null}),null,'3:1 gives null');
check(customerAvatarLogo({light:asset(64,64),dark:asset(400,64)}),null,'one wide variant gives null');
check(customerAvatarLogo({light:null,dark:asset(64,192)}),null,'1:3 gives null');
check([customerAvatarLogo({light:null,dark:null}),customerAvatarLogo(undefined),customerAvatarLogo(null)],[null,null,null],'no logo gives null');

// ---- render ----
const render=(element,locale='en')=>renderToStaticMarkup(h(LocaleProvider,{locale},element));
// React adds an image preload link in front of the markup; the avatar follows it.
const withLogo=render(h(CustomerAvatar,{name:'Contoso',logo:{light:asset(64,64),dark:asset(64,64)}})).replace(/^(?:<link [^>]*>)+/,'');
ok(/^<span class="sdx-customer-avatar sdx-customer-avatar-logo" aria-hidden="true"><span class="sdx-brand-logo sdx-brand-logo-size-avatar">/.test(withLogo),'a square logo: BrandLogo size="avatar", aria-hidden');
ok((withLogo.match(/<img /g)??[]).length===2&&/sdx-brand-logo-light/.test(withLogo)&&/sdx-brand-logo-dark/.test(withLogo)&&/alt=""/.test(withLogo),'both variants, decorative');
ok(!withLogo.includes('>C<'),'no initials next to a logo');
const initials=render(h(CustomerAvatar,{name:'ölwerke nord',logo:{light:asset(400,64),dark:null}}),'de');
check(initials,'<span class="sdx-customer-avatar" aria-hidden="true">ÖN</span>','a wide logo: the initials tile');
check(render(h(CustomerAvatar,{name:'Fabrikam Holding'})),'<span class="sdx-customer-avatar" aria-hidden="true">FH</span>','no logo: the initials tile');

// ---- styles ----
const avatarCss=readFileSync('ui/devices/fleet/customer-avatar.css','utf8'),logoCss=readFileSync('ui/kit/brand-logo.css','utf8');
const rule=(css,selector)=>css.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+' \\{([^}]*)\\}'))?.[1]??'';
const tile=rule(avatarCss,'.sdx-customer-avatar');
ok(/width: 20px; height: 20px/.test(tile)&&/border-radius: var\(--sd-radius-sm\)/.test(tile),'a 20×20 tile with --sd-radius-sm');
ok(/color: var\(--sd-accent-strong\)/.test(tile)&&/background: var\(--sd-accent-soft\)/.test(tile)&&/font-size: 10px/.test(tile)&&/font-weight: 700/.test(tile),'the initials in 10px/700 accent-strong on accent-soft');
const size=rule(logoCss,'.sdx-brand-logo-size-avatar');
ok(/width: 20px; height: 20px/.test(size)&&/background: var\(--sd-panel\)/.test(size)&&/border-radius: var\(--sd-radius-sm\)/.test(size),'the avatar size: 20×20 on --sd-panel');
ok(/box-shadow: inset 0 0 0 1px var\(--sdx-edge\)/.test(rule(logoCss,'.sdx-brand-logo-size-avatar::after')),'an inset --sdx-edge ring');
ok(/object-fit: contain/.test(rule(logoCss,'.sdx-brand-logo-size-avatar img')),'the image is contained');

console.log(`PASS customer avatar (${checks} checks): initials, the ratio rule, the logo and initials renders and the styles.`);
