// Settings › Branding, the card Preview (ui/settings/branding-preview.tsx, ui/settings/branding.css, docs/branding.md),
// rendered with stubbed state in English and German: the two switches (shown page, appearance) with their pressed
// items, the window as one named image in the fixed appearance of its switch and with data-scheme-swatch="brand", the
// tab strip (the uploaded icon or /favicon.svg, the page title), the sign-in page (background, the logo of the
// appearance with its fallback, the Nodiverna mark, the primary button) and the console (top bar, rail, navigator,
// workspace, the blurred background with the scrim values of the choice), the colors of an unapplied pick as inline
// --brand-* values with the status line, the captions, and the page defaults (sign-in page first, the appearance of
// the console). Also the preview rules of the stylesheet: scheme variables instead of color values, sizes that follow
// the window, the dark filter, and the fading classes in the reduced-motion list.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
const {BrandingPreview}=await import('../../../ui/settings/branding-preview.tsx');
const {BrandingPageBody}=await import('../../../ui/settings/branding-page.tsx');
const model=await import('../../../ui/settings/branding-model.ts');
const {backdropScrims}=await import('../../../lib/backdrop.ts');
const {brandingBackgrounds}=await import('../../../lib/branding.ts');

let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const asset=slot=>({url:`/api/branding/portal/${slot}?v=0123456789abcdef`,contentType:'image/png',width:240,height:60,size:2048,updatedAt:1});
const noBackgrounds={signin:{choice:'none',upload:null},console:{choice:'none',upload:null,measured:false,scrim:null}};
const empty={portal:{light:null,dark:null,icon:null},multipleCustomers:false,customers:[],backgrounds:noBackgrounds,scheme:null};
const full={...empty,portal:{light:asset('light'),dark:asset('dark'),icon:asset('icon')}};
const render=(props,locale='en')=>renderToStaticMarkup(React.createElement(LocaleProvider,{locale},React.createElement(BrandingPreview,{surface:'signin',appearance:'light',onSurface:()=>{},onAppearance:()=>{},...props})));
const textOf=html=>html.replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();
const windowOf=html=>/<div class="(sdx-stage-window [^"]*)" data-scheme-swatch="brand"(?: style="([^"]*)")? role="img" aria-label="([^"]*)">/.exec(html);
const pressed=(html,label)=>{const group=new RegExp(`<div class="sdx-segmented[^"]*" role="group" aria-label="${label}">(.*?)</div>`).exec(html);assert.ok(group,`group ${label}`);return [...group[1].matchAll(/<button type="button" aria-pressed="(true|false)"(?: aria-label="([^"]*)")?[^>]*>(?:<svg[\s\S]*?<\/svg>)?(?:<span>([^<]*)<\/span>)?/g)].map(match=>[match[2]??match[3],match[1]==='true']);};

// ---- The card, the switches, the window ----
for(const locale of ['en','de']){
 const t={en:{title:'Preview',surface:'Shown page',pages:['Sign-in page','Console'],appearance:'Appearance',modes:['Light','Dark'],names:['Preview of the sign-in page','Preview of the console'],tab:'Nodiverna | Windows Management',
   captions:['Everyone sees this page before they sign in.','Accounts see the console like this after they sign in. Each account can choose its own color scheme and turn the background off in My account.'],pending:'These colors are not applied yet.'},
  de:{title:'Vorschau',surface:'Gezeigte Seite',pages:['Anmeldeseite','Konsole'],appearance:'Darstellung',modes:['Hell','Dunkel'],names:['Vorschau der Anmeldeseite','Vorschau der Konsole'],tab:'Nodiverna | Windows-Verwaltung',
   captions:['Diese Seite sieht jeder vor der Anmeldung.','So sehen Konten die Konsole nach der Anmeldung. Jedes Konto kann unter Mein Konto ein eigenes Farbschema wählen und den Hintergrund ausschalten.'],pending:'Diese Farben sind noch nicht übernommen.'}}[locale];
 const signin=render({view:empty},locale);
 ok(new RegExp(`^(?:<link [^>]*/>)*<section class="sdx-card" aria-labelledby="sdx-branding-preview"><header[^>]*><div class="sdx-section-head-text"><h2 id="sdx-branding-preview"><span class="sdx-icon-tile sdx-icon-tile-accent[^"]*" aria-hidden="true"><svg[^>]*lucide-eye[ "][\\s\\S]*?</span>${t.title}</h2>`).test(signin),`${locale}: the card Preview with its accent icon tile`);
 check(pressed(signin,t.surface),[[t.pages[0],true],[t.pages[1],false]],`${locale}: the page switch, Sign-in page pressed`);
 check(pressed(signin,t.appearance),[[t.modes[0],true],[t.modes[1],false]],`${locale}: the appearance switch, icon only with its names, Light pressed`);
 ok(signin.includes(`sdx-segmented sdx-segmented-sm" role="group" aria-label="${t.surface}"`)&&signin.includes(`sdx-segmented sdx-segmented-sm sdx-segmented-icons" role="group" aria-label="${t.appearance}"`),`${locale}: two small Segmented controls`);
 check([windowOf(signin)[1],windowOf(signin)[2],windowOf(signin)[3]],['sdx-stage-window sdx-branding-frame-light',undefined,t.names[0]],`${locale}: the window is one image, light, with no inline color`);
 ok(signin.includes(`<div class="sdx-stage-tabstrip" aria-hidden="true"><span class="sdx-stage-tab"><img class="sdx-branding-fade" src="/favicon.svg" alt="" decoding="async" width="16" height="16"/><span>${t.tab}</span></span></div><div class="sdx-stage-screen" aria-hidden="true">`),`${locale}: the tab strip with the Nodiverna icon and the page title; the content is hidden from assistive technology`);
 ok(textOf(signin).endsWith(t.captions[0])&&!textOf(signin).includes(t.pending),`${locale}: the caption of the sign-in page, no pending note`);
 const consoleHtml=render({view:empty,surface:'console',appearance:'dark'},locale);
 check(pressed(consoleHtml,t.surface),[[t.pages[0],false],[t.pages[1],true]],`${locale}: Console pressed`);
 check(pressed(consoleHtml,t.appearance),[[t.modes[0],false],[t.modes[1],true]],`${locale}: Dark pressed`);
 check([windowOf(consoleHtml)[1],windowOf(consoleHtml)[3]],['sdx-stage-window sdx-branding-frame-dark',t.names[1]],`${locale}: the window in the dark appearance, named for the console`);
 ok(textOf(consoleHtml).endsWith(t.captions[1]),`${locale}: the caption of the console`);
 // An unapplied pick: the derived values of both appearances on the window, and the status line.
 const fresh=model.schemeSelection(['#ffd400','#1e5adc'],null,null),picked=model.schemeSelection(['#ffd400','#1e5adc'],model.schemePick(fresh,1),null);
 ok(windowOf(render({view:full,selection:fresh},locale))[2]===undefined&&!textOf(render({view:full,selection:fresh},locale)).includes(t.pending),`${locale}: the preselected candidate is no preview`);
 const pending=render({view:full,selection:picked},locale),style=windowOf(pending)[2];
 ok(/--brand-light-accent:#[0-9a-f]{6}/.test(style)&&/--brand-light-from:#[0-9a-f]{6}/.test(style)&&/--brand-dark-accent:#[0-9a-f]{6}/.test(style)&&/--brand-dark-panel:#[0-9a-f]{6}/.test(style),`${locale}: a pick sets the derived --brand-* values of both appearances on the window`);
 ok(pending.includes(`<p class="sdx-stage-pending sdx-branding-fade" role="status"><i aria-hidden="true"></i>${t.pending}</p><p class="sdx-stage-caption">`),`${locale}: the status line of an unapplied pick, before the caption`);
 const stored={primary:'#1e5adc',secondary:'#ffd400'},applied=render({view:{...full,scheme:stored},selection:model.schemeSelection(['#ffd400','#1e5adc'],null,stored)},locale);
 ok(windowOf(applied)[2]===undefined&&!textOf(applied).includes(t.pending),`${locale}: the stored scheme needs no inline value (the brand stylesheet has it)`);
}

// ---- Tab icon and logo ----
{
 const html=render({view:full});
 ok(html.includes('<span class="sdx-stage-tab"><img class="sdx-branding-fade" src="/api/branding/portal/icon?v=0123456789abcdef"'),'the tab strip shows the uploaded icon');
 check([model.previewIconUrl(asset('icon')),model.previewIconUrl(null)],['/api/branding/portal/icon?v=0123456789abcdef','/favicon.svg'],'the tab icon, or the Nodiverna icon');
 const brand=source=>/<span class="sdx-stage-brand">(.*?)<\/span><b class="sdx-stage-heading">/.exec(source)?.[1];
 ok(brand(html).startsWith('<img class="sdx-branding-fade sdx-stage-logo" src="/api/branding/portal/light?v=0123456789abcdef"')&&brand(html).endsWith('<i></i><span class="sdx-stage-name">Nodiverna</span>'),'sign-in, light: the light logo, a hairline and the product name');
 ok(brand(render({view:full,appearance:'dark'})).includes('src="/api/branding/portal/dark?v=0123456789abcdef"'),'sign-in, dark: the dark logo');
 ok(brand(render({view:{...full,portal:{...full.portal,dark:null}},appearance:'dark'})).includes('src="/api/branding/portal/light?v=0123456789abcdef"'),'sign-in, dark without a dark logo: the light logo');
 ok(brand(render({view:{...full,portal:{...full.portal,light:null}}})).includes('src="/api/branding/portal/dark?v=0123456789abcdef"'),'sign-in, light without a light logo: the dark logo');
 ok(/^<span class="sdx-branding-fade sdx-stage-mark"><svg[\s\S]*?<\/svg><\/span><strong>Nodiverna<\/strong>$/.test(brand(render({view:empty}))),'sign-in without a logo: the Nodiverna mark and the product name');
 const signinCard=/<span class="sdx-stage-signin-card">(.*)<\/span><\/div><\/div><\/div>/.exec(render({view:empty}))[1];
 ok(signinCard.endsWith('<b class="sdx-stage-heading"></b><b class="sdx-stage-field"></b><b class="sdx-stage-field"></b><em class="sdx-stage-primary"></em>'),'the sign-in card: a heading, two fields and one primary button');
 const topbar=source=>/<span class="sdx-stage-topbar">(.*?)<i class="sdx-stage-search">/.exec(source)?.[1];
 ok(/^<img class="sdx-branding-fade sdx-stage-logo" src="\/api\/branding\/portal\/dark\?v=0123456789abcdef"[^>]*\/>$/.test(topbar(render({view:full,surface:'console',appearance:'dark'}))),'console, dark: the top bar shows the dark logo alone');
 ok(/^<span class="sdx-stage-brand"><span class="sdx-branding-fade sdx-stage-mark">[\s\S]*<\/span><strong>Nodiverna<\/strong><\/span>$/.test(topbar(render({view:empty,surface:'console'}))),'console without a logo: the mark and the product name');
}

// ---- Sign-in background ----
{
 const plain=render({view:empty});
 ok(plain.includes('<div class="sdx-branding-fade sdx-stage-signin"><span class="sdx-stage-signin-card">'),'no background: the plain surface with the card');
 const dusk=render({view:{...empty,backgrounds:{...noBackgrounds,signin:{choice:'dusk',upload:null}}}});
 ok(dusk.includes('<div class="sdx-branding-fade sdx-stage-signin is-image"><img class="sdx-branding-fade sdx-stage-image" src="/backgrounds/dusk.svg" alt="" decoding="async"/><span class="sdx-stage-signin-card">'),'a bundled background: the cover image behind the card');
 const own={url:'/api/branding/portal/signin?v=0123456789abcdef',contentType:'image/jpeg',width:2560,height:1440,size:1,updatedAt:1};
 ok(render({view:{...empty,backgrounds:{...noBackgrounds,signin:{choice:'upload',upload:own}}}}).includes('class="sdx-branding-fade sdx-stage-image" src="/api/branding/portal/signin?v=0123456789abcdef"'),'the own image');
 ok(!render({view:{...empty,backgrounds:{...noBackgrounds,signin:{choice:'mist',upload:own}}}}).includes('/api/branding/portal/signin'),'a stored upload that is not the choice does not show');
}

// ---- Console: regions and background ----
{
 const plain=render({view:empty,surface:'console'});
 const order=['sdx-stage-topbar','sdx-stage-rail','sdx-stage-navigator','sdx-stage-workspace'].map(name=>plain.indexOf(`class="${name}"`));
 ok(order.every(at=>at>0)&&order.every((at,index)=>index===0||at>order[index-1]),'top bar, rail, navigator and workspace');
 ok(plain.includes('<div class="sdx-branding-fade sdx-stage-console"><span class="sdx-stage-topbar">')&&!/sdx-stage-wallpaper|--sdx-scrim-|sdx-backdrop-scrims/.test(plain),'without a background the miniature stays plain');
 ok(plain.includes('<span class="sdx-stage-rail"><i class="is-active"></i><i></i><i></i></span><span class="sdx-stage-navigator"><b class="is-selected"></b><b></b><b></b><b></b></span><span class="sdx-stage-workspace"><b class="sdx-stage-heading"></b><em class="sdx-stage-primary"></em><b class="sdx-stage-panel"></b><b class="sdx-stage-panel"></b></span>'),'one active rail item, one selected navigator row, a heading, a primary button and two cards');
 const dusk=brandingBackgrounds.find(background=>background.id==='dusk'),scrim=backdropScrims(dusk.measure,null);
 const image=render({view:{...empty,backgrounds:{...noBackgrounds,console:{choice:'dusk',upload:null,measured:false,scrim}}},surface:'console'});
 const miniature=/<div class="([^"]*sdx-stage-console[^"]*)" style="([^"]*)">/.exec(image);
 check(miniature[1].split(' '),['sdx-branding-fade','sdx-stage-console','is-image','sdx-backdrop-scrims'],'with a background the miniature reads the console scrims');
 for(const region of ['bars','navigator','workspace'])for(const mode of ['light','dark'])ok(miniature[2].includes(`--sdx-scrim-${region}-${mode}:${scrim[mode][region]}%`),`the miniature has --sdx-scrim-${region}-${mode} of the choice`);
 ok(image.includes('<span class="sdx-stage-wallpaper"><img class="sdx-branding-fade sdx-stage-image" src="/backgrounds/dusk.svg" alt="" decoding="async"/></span><span class="sdx-stage-topbar">'),'the keyed image sits behind the whole miniature, before the top bar');
 ok(!/sdx-stage-wallpaper|--sdx-scrim-/.test(render({view:{...empty,backgrounds:{...noBackgrounds,console:{choice:'upload',upload:null,measured:false,scrim:null}}},surface:'console'})),'an upload choice without its image shows no background');
 ok(!render({view:{...empty,backgrounds:{...noBackgrounds,console:{choice:'dusk',upload:null,measured:false,scrim}}}}).includes('/backgrounds/dusk.svg'),'the console background does not show on the sign-in page');
}

// ---- The page: defaults and one shared state ----
{
 const page=(state,locale='en')=>renderToStaticMarkup(React.createElement(LocaleProvider,{locale},React.createElement(BrandingPageBody,{state:{loadError:'',loading:false,...state},actions:{busy:null,onUpload:()=>{},onRemove:()=>{}},onRetry:()=>{}})));
 const html=page({view:{...full,backgrounds:{...noBackgrounds,signin:{choice:'tide',upload:null}}},colors:{status:'done',candidates:['#ffd400','#1e5adc']}});
 const preview=html.slice(html.indexOf('aria-labelledby="sdx-branding-preview"'),html.indexOf('<div class="sdx-settings">'));
 check(pressed(preview,'Shown page'),[['Sign-in page',true],['Console',false]],'the page opens with the sign-in page');
 check(pressed(preview,'Appearance'),[['Light',true],['Dark',false]],'and with the appearance of the console (light on the server)');
 check([windowOf(preview)[1],windowOf(preview)[2]],['sdx-stage-window sdx-branding-frame-light',undefined],'the preselected candidate does not color the preview');
 ok(preview.includes('src="/backgrounds/tide.svg"')&&preview.includes('src="/api/branding/portal/light?v=0123456789abcdef"')&&preview.includes('src="/api/branding/portal/icon?v=0123456789abcdef"'),'the preview renders from the state of the cards: background, logo and icon');
 const source=fs.readFileSync('ui/settings/branding-page.tsx','utf8');
 ok(source.includes("const [surface,setSurface]=useState<PreviewSurface>('signin'),[chosenAppearance,setAppearance]=useState<PreviewAppearance|null>(null),[pick,setPick]=useState<SchemePick>(null);")&&source.includes('appearance={chosenAppearance??mode}')&&source.includes('mode=useEffectiveMode()'),'the appearance follows the console until the Owner switches it');
 ok(source.includes('<BrandSchemeCard colors={colors} scheme={view.scheme} selection={selection} onPick={index=>setPick(schemePick(selection,index))}')&&source.includes('selection={selection}/></div>'),'the card Colors and the preview share one selection');
 ok(source.includes('aside={preview}')&&source.includes('const preview=view&&<EntranceList id="settings-branding-preview">'),'the preview is the aside, only with a loaded view');
}

// ---- Styles of the preview ----
{
 const css=fs.readFileSync('ui/settings/branding.css','utf8'),stage=css.slice(css.indexOf('/* ---- Preview'));
 ok(stage.length>2000&&!/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(css),'no color value in the stylesheet');
 ok(!/@keyframes|color-scheme\s*:/.test(css),'no keyframes and no color-scheme rule in the page stylesheet');
 for(const name of ['bg','panel','accent','on-accent','soft','glow','grad'])ok(new RegExp(`\\n  --sdx-pv-${name}: [^;]*--scheme-(?:light|dark)-`).test(stage),`--sdx-pv-${name} reads the scheme variables of the window`);
 ok(/\.sdx-stage-window \{[^}]*container-type: inline-size;/.test(stage)&&/\.sdx-stage-screen \{[^}]*aspect-ratio: 16 \/ 10;/.test(stage),'the miniature keeps its proportions and sizes its parts from the window width');
 ok(stage.includes('.sdx-stage-primary { height: clamp(12px, 4.4cqi, 24px); border-radius: var(--sd-radius-sm); background: var(--sdx-pv-grad); }')&&stage.includes('.sdx-stage-rail > i.is-active { background: var(--sdx-pv-accent); }')&&stage.includes('.sdx-stage-navigator > b.is-selected { background: var(--sdx-pv-soft); box-shadow: inset 2px 0 0 var(--sdx-pv-accent); }'),'the primary button, the active rail item and the selected row take the previewed colors');
 ok(stage.includes('.sdx-stage-wallpaper .sdx-stage-image { z-index: auto; filter: blur(3.3cqi) saturate(1.4); transform: scale(1.15); }')&&stage.includes('.sdx-branding-frame-dark .sdx-stage-wallpaper .sdx-stage-image { filter: blur(3.3cqi) saturate(1.2) brightness(.9); }'),'the console blur at the scale of the miniature, with the dark filter in the dark appearance');
 ok(stage.includes('.sdx-stage-console.is-image :is(.sdx-stage-topbar, .sdx-stage-rail) { background: linear-gradient(var(--sd-glass), var(--sd-glass)), var(--sdx-backdrop-bars); }')&&stage.includes('.sdx-stage-console.is-image .sdx-stage-navigator { background: linear-gradient(var(--sd-glass-strong), var(--sd-glass-strong)), var(--sdx-backdrop-navigator); }')&&stage.includes('.sdx-stage-console.is-image .sdx-stage-workspace { background: var(--sdx-backdrop-workspace); }'),'each region dims the image with the scrim of the console');
 ok(stage.includes('.sdx-stage-signin.is-image::after { content: ""; position: absolute; inset: 0; z-index: -1; background: color-mix(in srgb, var(--sdx-pv-bg) 24%, transparent); }'),'the sign-in image sits under the light scrim of the sign-in page');
 const motion=fs.readFileSync('ui/styles/motion.css','utf8'),reduced=motion.slice(motion.indexOf('prefers-reduced-motion'));
 for(const name of ['.sdx-branding-fade','.sdx-bg-tile-check','.sdx-bg-measuring'])ok(reduced.includes(`${name},`),`${name} stops under reduced motion`);
 const animated=[...css.matchAll(/\n([^\n{]+) \{[^}]*animation:/g)].map(match=>match[1].trim());
 check(animated,['.sdx-bg-tile-check','.sdx-bg-measuring'],'every other fade of the page is the shared .sdx-branding-fade class');
 const globals=fs.readFileSync('app/globals.css','utf8');
 ok(globals.includes('.sdx-branding-frame-light { color-scheme: light; }')&&globals.includes('.sdx-branding-frame-dark { color-scheme: dark; }')&&/\[data-scheme-swatch="brand"\] \{\s*--scheme-light-surface: var\(--brand-light-surface,/.test(globals),'the window uses the two fixed-scheme rules and the brand swatch block of globals.css');
}
console.log(`PASS branding preview (${checks} checks): switches, window, tab strip, logo per appearance, sign-in and console backgrounds, unapplied colors, page defaults and the preview styles.`);
