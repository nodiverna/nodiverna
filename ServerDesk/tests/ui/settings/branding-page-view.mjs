// Settings › Branding (ui/settings/branding-page.tsx, ui/settings/branding-model.ts, docs/branding.md), rendered with
// stubbed state in English and German.
// The page: the first load and the load error (no preview then); the preview as the aside of the page and no wide
// content; the card order Logo and icon, Colors, Sign-in page, Console, Customer logos with their icon tiles and
// descriptions, and no card of the old structure.
// Logo and icon: three rows (light logo, dark logo, tab icon) with the frame of each appearance, what an empty slot
// shows in its place (the other logo, the Nodiverna mark, /favicon.svg), the state tag Default or Custom, the state
// line (the facts, or the sentence of the four empty cases), the limits line, Upload or Replace and Remove, the email
// notice for WebP and SVG only, and the error of a failed upload in the row of its slot.
// Colors: every state (no logo, reading, read failure, no distinct color, candidates as a named radiogroup with the
// captioned sample frames, the readability line and the adjusted lines), Apply blocked while applied, the in-use line
// with and without a stored scheme, Reset to default colors only with one, and the state tag in the title.
// Sign-in page and Console: the named tile radiogroup with manual activation, four tiles per row, the limits line,
// Own image without and with an upload, no miniature inside the cards, the state tag, the error of a failed upload,
// the fitting status line and its warning with Try again (only while an upload exists), and the own-off notice.
// Customer logos: hidden while Multiple customers is off, the table inside the card with its empty state, row menu and
// foot. Also the busy state, the removal fallbacks, the client size check, the versions of the tab icon and the brand
// stylesheet, the measurement model, the color selection model, and the nav node (Owner only, after Customers).
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
const {BrandingPageBody}=await import('../../../ui/settings/branding-page.tsx');
const model=await import('../../../ui/settings/branding-model.ts');
const {backdropScrims,fallbackBackdropMeasure}=await import('../../../lib/backdrop.ts');
const {brandingBackgrounds}=await import('../../../lib/branding.ts');
const navModel=await import('../../../ui/shell/nav-model.ts');

let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const asset=(slot,contentType='image/png',owner='portal')=>({url:`/api/branding/${owner}/${slot}?v=0123456789abcdef`,contentType,width:240,height:60,size:2048,updatedAt:1});
const noBackgrounds={signin:{choice:'none',upload:null},console:{choice:'none',upload:null,measured:false,scrim:null}};
const fallbackScrim=backdropScrims(fallbackBackdropMeasure,null);
const empty={portal:{light:null,dark:null,icon:null},multipleCustomers:false,customers:[],backgrounds:noBackgrounds,scheme:null};
const set={portal:{light:asset('light'),dark:asset('dark','image/svg+xml'),icon:asset('icon')},multipleCustomers:false,customers:[],backgrounds:noBackgrounds,scheme:null};
const idle={busy:null,onUpload:()=>{},onRemove:()=>{}};
const render=(state,locale='en',actions=idle)=>renderToStaticMarkup(React.createElement(LocaleProvider,{locale},React.createElement(BrandingPageBody,{state,actions,onRetry:()=>{}})));
const page=(view,extra={},locale='en',actions=idle)=>render({view,loadError:'',loading:false,...extra},locale,actions);
const textOf=html=>html.replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ');
/** The markup of one card: from its heading id to the next card (or the end). */
const card=(html,id)=>{const start=html.indexOf(`aria-labelledby="${id}"`);assert.ok(start>0,`card ${id}`);const end=html.indexOf('<section class="sdx-card',start);return html.slice(start,end<0?html.length:end);};
/** The rows of the card Logo and icon. */
const rows=html=>card(html,'sdx-branding-portal').split('<li class="sdx-brand-row">').slice(1);
const tagOf=html=>/<span class="sdx-tag sdx-tag-sm( sdx-tag-changed)? sdx-branding-fade">([^<]+)<\/span>/.exec(html);

// ---- Loading and load error ----
const loading=render({view:null,loadError:'',loading:true});
ok(loading.includes('sdx-skeleton')&&!loading.includes('sdx-settings-page-split')&&!loading.includes('sdx-branding-preview'),'the first load shows the Skeleton and no preview');
const failed=render({view:null,loadError:'The settings could not be loaded.',loading:false});
ok(failed.includes('The settings could not be loaded.')&&textOf(failed).includes('Try again')&&!failed.includes('sdx-settings-page-split'),'a load error shows LoadFailed with Try again and no preview');

// ---- Page frame: the preview is the aside, the cards follow in the order of what they affect ----
for(const locale of ['en','de']){
 const t={en:{titles:['Preview','Logo and icon','Colors','Sign-in page','Console'],customers:'Customer logos',old:['Portal logo','Sign-in background','Console background','Color scheme'],
   descriptions:['Your logo replaces the Nodiverna logo in the top bar, on the sign-in page and in emails. The icon shows in browser tabs and bookmarks. The name Nodiverna stays in the browser tab and on the sign-in page.',
    'Buttons, links and highlights take a color from your logo. Accounts that chose their own color scheme in My account keep it.','Choose a picture that shows behind the sign-in card.',
    'Choose a picture that shows softly blurred behind the whole console. Everything stays easy to read. Each account can turn it off in My account.']},
  de:{titles:['Vorschau','Logo und Symbol','Farben','Anmeldeseite','Konsole'],customers:'Kundenlogos',old:['Portal-Logo','Hintergrund der Anmeldeseite','Hintergrund der Konsole','Farbschema entfernen'],
   descriptions:['Dein Logo ersetzt das Nodiverna-Logo in der oberen Leiste, auf der Anmeldeseite und in E-Mails. Das Symbol erscheint in Browser-Tabs und Lesezeichen. Der Name Nodiverna bleibt im Browser-Tab und auf der Anmeldeseite.',
    'Schaltflächen, Links und Hervorhebungen übernehmen eine Farbe aus deinem Logo. Konten, die unter Mein Konto ein eigenes Farbschema gewählt haben, behalten es.','Wähle ein Bild, das hinter der Anmeldekarte erscheint.',
    'Wähle ein Bild, das weichgezeichnet hinter der ganzen Konsole erscheint. Alles bleibt gut lesbar. Jedes Konto kann es unter Mein Konto ausschalten.']}}[locale];
 const html=page(set,{colors:{status:'done',candidates:['#1e5adc']}},locale);
 ok(/^(?:<link [^>]*\/>)*<div class="sdx-settings-page sdx-settings-page-split"><div class="sdx-settings-split"><div class="sdx-settings-aside">/.test(html)&&!html.includes('sdx-settings-wide'),`${locale}: the preview is the aside of the page; no wide content`);
 const ids=['sdx-branding-preview','sdx-branding-portal','sdx-branding-scheme','sdx-branding-signin','sdx-branding-console'];
 const order=ids.map(id=>html.indexOf(`<h2 id="${id}">`));
 ok(order.every(at=>at>0)&&order.every((at,index)=>index===0||at>order[index-1]),`${locale}: Preview, Logo and icon, Colors, Sign-in page, Console`);
 ok(html.indexOf('<div class="sdx-settings">')>order[0]&&html.indexOf('<div class="sdx-settings">')<order[1],`${locale}: the preview comes before the card column`);
 check(ids.map(id=>/<h2 id="[^"]+">(?:<span class="sdx-icon-tile[^>]*>.*?<\/span>)?([^<]+)/.exec(card(html,id))[1]),t.titles,`${locale}: the card titles`);
 for(const [index,id] of ids.slice(1).entries())ok(textOf(card(html,id)).includes(t.descriptions[index]),`${locale}: the description of ${id}`);
 for(const [id,icon] of [['sdx-branding-preview','eye'],['sdx-branding-portal','image'],['sdx-branding-scheme','swatch-book'],['sdx-branding-signin','log-in'],['sdx-branding-console','panels-top-left']])ok(new RegExp(`<h2 id="${id}"><span class="sdx-icon-tile sdx-icon-tile-accent[^"]*" aria-hidden="true"><svg[^>]*lucide-${icon}[ "]`).test(html),`${locale}: ${id} has the ${icon} icon tile`);
 for(const part of ['id="sdx-branding-icon"','sdx-bg-preview'])ok(!html.includes(part),`${locale}: no ${part}`);
 const plain=textOf(html);
 for(const title of t.old)ok(!plain.includes(title),`${locale}: no "${title}" of the old structure`);
 ok(!plain.includes(t.customers),`${locale}: the customer card is hidden while Multiple customers is off`);
 const withCustomers=page({...set,multipleCustomers:true},{},locale);
 ok(withCustomers.indexOf('<h2 id="sdx-branding-console">')<withCustomers.indexOf('<h2 id="sdx-branding-customers">'),`${locale}: Customer logos stays last`);
}
const pageSource=fs.readFileSync('ui/settings/branding-page.tsx','utf8');
ok(pageSource.includes('<EntranceList id="settings-branding" className="sdx-branding-cards">')&&pageSource.includes('<EntranceList id="settings-branding-preview">')&&pageSource.includes('entranceId="settings-branding-customers"'),'the preview, the cards and the customer rows rise once');

// ---- Logo and icon: rows, empty and set ----
for(const locale of ['en','de']){
 const t={en:{labels:['Logo for the light appearance','Logo for the dark appearance','Browser tab icon'],upload:['Upload light logo…','Upload dark logo…','Upload icon…'],replace:['Replace light logo…','Replace dark logo…','Replace icon…'],remove:['Remove light logo…','Remove dark logo…','Remove icon…'],
   tags:['Default','Custom'],shows:{product:'Not uploaded. The Nodiverna logo shows.',light:'Not uploaded. The logo for the light appearance shows here too.',dark:'Not uploaded. The logo for the dark appearance shows here too.',icon:'Not uploaded. The Nodiverna icon shows.'},
   rules:['PNG, WebP, JPEG or SVG, up to 2 MiB. Emails use this logo.','PNG, WebP, JPEG or SVG, up to 2 MiB.','A square PNG, WebP, JPEG or SVG image, 32 to 1024 px per side, up to 256 KiB.'],facts:['PNG · 240 × 60 px · 2 KiB','SVG · scalable · 2 KiB','PNG · 240 × 60 px · 2 KiB']},
  de:{labels:['Logo für die helle Darstellung','Logo für die dunkle Darstellung','Symbol im Browser-Tab'],upload:['Helles Logo hochladen…','Dunkles Logo hochladen…','Symbol hochladen…'],replace:['Helles Logo ersetzen…','Dunkles Logo ersetzen…','Symbol ersetzen…'],remove:['Helles Logo entfernen…','Dunkles Logo entfernen…','Symbol entfernen…'],
   tags:['Standard','Angepasst'],shows:{product:'Nicht hochgeladen. Es erscheint das Nodiverna-Logo.',light:'Nicht hochgeladen. Hier erscheint auch das Logo für die helle Darstellung.',dark:'Nicht hochgeladen. Hier erscheint auch das Logo für die dunkle Darstellung.',icon:'Nicht hochgeladen. Es erscheint das Nodiverna-Symbol.'},
   rules:['PNG, WebP, JPEG oder SVG, bis 2 MiB. E-Mails verwenden dieses Logo.','PNG, WebP, JPEG oder SVG, bis 2 MiB.','Ein quadratisches PNG-, WebP-, JPEG- oder SVG-Bild, 32 bis 1024 px pro Seite, bis 256 KiB.'],facts:['PNG · 240 × 60 px · 2 KiB','SVG · skalierbar · 2 KiB','PNG · 240 × 60 px · 2 KiB']}}[locale];
 const none=rows(page(empty,{},locale));
 check(none.length,3,`${locale}: three rows`);
 for(const [index,row] of none.entries()){
  const plain=textOf(row);
  ok(new RegExp(`<h3 id="sdx-branding-portal-${['light','dark','icon'][index]}" class="sdx-brand-label">${t.labels[index]}</h3>`).test(row),`${locale}: row ${index} has its label`);
  check([tagOf(row)[1],tagOf(row)[2]],[undefined,t.tags[0]],`${locale}: an empty row is Default, in the plain tag`);
  ok(plain.includes(index===2?t.shows.icon:t.shows.product),`${locale}: an empty row says what shows in its place`);
  ok(row.includes('<p class="sdx-brand-rules">')&&plain.includes(t.rules[index]),`${locale}: the limits line of row ${index}`);
  ok(plain.includes(t.upload[index])&&!plain.includes(t.replace[index])&&!plain.includes(t.remove[index]),`${locale}: an empty row offers Upload only`);
 }
 ok(none[0].startsWith('<div class="sdx-branding-frame sdx-branding-frame-light" aria-hidden="true"><span class="sdx-branding-placeholder sdx-branding-fade">')&&none[1].startsWith('<div class="sdx-branding-frame sdx-branding-frame-dark" aria-hidden="true"><span class="sdx-branding-placeholder sdx-branding-fade">')&&textOf(none[0].split('sdx-brand-row-main')[0]).includes('Nodiverna'),`${locale}: empty logo frames show the Nodiverna mark and name on a light and a dark surface`);
 ok(/^<div class="sdx-branding-frame sdx-branding-frame-icon" aria-hidden="true"><img class="sdx-branding-fade sdx-branding-icon-32" src="\/favicon\.svg"[^>]*\/><img class="sdx-branding-fade sdx-branding-icon-16" src="\/favicon\.svg"/.test(none[2]),`${locale}: the empty icon frame shows the Nodiverna icon at 32 and 16 px`);
 const full=rows(page(set,{},locale));
 for(const [index,row] of full.entries()){
  const plain=textOf(row);
  check([tagOf(row)[1],tagOf(row)[2]],[' sdx-tag-changed',t.tags[1]],`${locale}: a set row is Custom, in the changed tag`);
  ok(row.includes('<p class="sdx-branding-facts sdx-branding-fade">')&&plain.includes(t.facts[index]),`${locale}: the facts line of row ${index}`);
  ok(plain.includes(t.replace[index])&&plain.includes(t.remove[index])&&!plain.includes(t.upload[index]),`${locale}: a set row offers Replace and Remove`);
  ok(row.includes(`src="/api/branding/portal/${['light','dark','icon'][index]}?v=0123456789abcdef"`),`${locale}: the frame of row ${index} shows its image`);
  ok(!row.includes('sdx-field-error'),`${locale}: no error without a failed upload`);
 }
 ok(full[2].includes('sdx-branding-icon-32')&&full[2].includes('sdx-branding-icon-16'),`${locale}: the icon at 32 and 16 px`);
 // One appearance only: the empty slot shows the other logo and says so.
 const lightOnly=rows(page({...empty,portal:{...empty.portal,light:asset('light')}},{},locale));
 ok(lightOnly[1].startsWith('<div class="sdx-branding-frame sdx-branding-frame-dark" aria-hidden="true"><img class="sdx-branding-fade sdx-branding-frame-logo" src="/api/branding/portal/light?v=0123456789abcdef"')&&textOf(lightOnly[1]).includes(t.shows.light)&&tagOf(lightOnly[1])[2]===t.tags[0],`${locale}: without a dark logo, the dark frame shows the light logo, the row says so and stays Default`);
 const darkOnly=rows(page({...empty,portal:{...empty.portal,dark:asset('dark')}},{},locale));
 ok(darkOnly[0].includes('src="/api/branding/portal/dark?v=0123456789abcdef"')&&textOf(darkOnly[0]).includes(t.shows.dark),`${locale}: without a light logo, the light frame shows the dark logo and the row says so`);
 // A failed upload says why in the row of its slot.
 const broken=rows(page(set,{uploadError:{key:'portal:dark',message:'The logo file is larger than 2 MiB. Choose a smaller file.'}},locale));
 ok(broken[1].includes('<p class="sdx-field-error" role="alert">The logo file is larger than 2 MiB. Choose a smaller file.</p>')&&!broken[0].includes('sdx-field-error')&&!broken[2].includes('sdx-field-error'),`${locale}: the upload error shows in the row of its slot only`);
}
check([model.emptySlotKey({light:null,dark:null},'light'),model.emptySlotKey({light:null,dark:asset('dark')},'light'),model.emptySlotKey({light:asset('light'),dark:null},'dark'),model.emptySlotKey({light:asset('light'),dark:null},'icon')],
 ['branding.logo.showsProduct','branding.logo.showsDark','branding.logo.showsLight','branding.icon.showsProduct'],'the sentence of an empty slot, four cases');
check([model.shownLogo({light:asset('light'),dark:asset('dark')},'dark').url,model.shownLogo({light:asset('light'),dark:null},'dark').url,model.shownLogo({light:null,dark:null},'light')],['/api/branding/portal/dark?v=0123456789abcdef','/api/branding/portal/light?v=0123456789abcdef',null],'the logo an appearance shows');
check([model.stateKey(true),model.stateKey(false),model.backgroundCustom({choice:'none'}),model.backgroundCustom({choice:'mist'}),model.backgroundCustom({choice:'upload'})],['branding.state.custom','branding.state.default',false,true,true],'the state of a setting');
const allText=textOf(page({...set,multipleCustomers:true}))+textOf(page(empty,{},'de'));
ok(!/cleaned|bereinigt/.test(allText),'no limits line says that SVG files are cleaned');

// ---- Email notice ----
const notice=(light,locale='en')=>textOf(page({...empty,portal:{...empty.portal,light}},{},locale));
ok(notice(asset('light','image/webp')).includes('because the light logo is a WebP file'),'WebP: the notice');
ok(notice(asset('light','image/svg+xml')).includes('because the light logo is a SVG file'),'SVG: the notice');
for(const type of ['image/png','image/jpeg'])ok(!notice(asset('light',type)).includes('Emails show no logo'),`${type}: no notice`);
ok(!notice(null).includes('Emails show no logo'),'no light logo: no notice');
ok(notice(asset('light','image/webp'),'de').includes('weil das helle Logo eine WebP-Datei ist'),'the German notice');

// ---- Customer logos: the table inside its card ----
const noCustomers=page({...empty,multipleCustomers:true}),customerCard=card(noCustomers,'sdx-branding-customers');
ok(/^aria-labelledby="sdx-branding-customers"/.test(customerCard)&&noCustomers.includes('<section class="sdx-card sdx-card-flush')&&customerCard.includes('sdx-table-wrap sdx-table-wrap-flush')&&!noCustomers.includes('sdx-settings-wide'),'the table sits inside the flush card, not below the page');
for(const part of ['Customer logos','A customer logo replaces your logo in the top bar while you work in that customer, and for the accounts of that customer. A logo that is about square also marks the customer in the navigator.','PNG, WebP, JPEG or SVG, up to 2 MiB.','No customers yet','Create a customer, then upload its logo here.','Open customers'])ok(textOf(customerCard).includes(part),`the customer card: ${part}`);
ok(!textOf(customerCard).includes('Emails use this logo'),'the customer limits line has no email sentence');
const customers=[{id:'c1',name:'Contoso',status:'active',light:asset('light','image/png','customer/c1'),dark:null},{id:'c2',name:'Fabrikam',status:'disabled',light:null,dark:null}];
const table=card(page({...empty,multipleCustomers:true,customers}),'sdx-branding-customers'),tableText=textOf(table);
ok(tableText.includes('Contoso')&&tableText.includes('Fabrikam')&&tableText.includes('Deactivated'),'names and the deactivated state');
ok(table.includes('src="/api/branding/customer/c1/light?v=0123456789abcdef"')&&tableText.includes('Portal logo'),'a thumbnail or "Portal logo"');
ok(tableText.includes('2 customers'),'the foot');
ok(table.includes('aria-label="Actions for Contoso"'),'the row menu label');
const menu=(customer,busy=false,locale='en')=>model.customerMenuItems(customer,busy,locale).map(item=>'separator' in item?'—':[item.label,item.danger,item.blocked??null]);
check(menu(customers[0]),[['Replace light logo…',false,null],['Upload dark logo…',false,null],'—',['Remove light logo…',true,null],['Remove dark logo…',true,'No logo uploaded yet.']],'the row menu: blocked removal of an empty slot');
check(menu(customers[1],true),[['Upload light logo…',false,'Another upload or removal is still running.'],['Upload dark logo…',false,'Another upload or removal is still running.'],'—',['Remove light logo…',true,'No logo uploaded yet.'],['Remove dark logo…',true,'No logo uploaded yet.']],'busy: every entry waits');
check(menu(customers[1],false,'de')[3],['Helles Logo entfernen…',true,'Noch kein Logo hochgeladen.'],'German');
check([model.customerRulesText('en'),model.brandingRulesText('light','en'),model.brandingRulesText('icon','de')].map(text=>text.replace(/\s+/g,' ')),['PNG, WebP, JPEG or SVG, up to 2 MiB.','PNG, WebP, JPEG or SVG, up to 2 MiB. Emails use this logo.','Ein quadratisches PNG-, WebP-, JPEG- oder SVG-Bild, 32 bis 1024 px pro Seite, bis 256 KiB.'],'the limits lines come from the byte limits');

// ---- Busy state ----
const busy=textOf(page(set,{},'en',{...idle,busy:{key:'portal:light',kind:'upload'}}));
ok(busy.includes('Another upload or removal is still running.'),'the other actions are blocked with branding.busy');

// ---- Removal fallback ----
const view=(portal,list=[])=>({portal:{light:null,dark:null,icon:null,...portal},customers:list});
const fallback=(state,target,locale='en')=>model.removalFallback(state,target,locale);
check(fallback(view({light:asset('light'),dark:asset('dark')}),{customerId:null,slot:'light'}),'The logo of the dark appearance appears in its place.','portal light with a dark logo');
check(fallback(view({light:asset('light'),dark:asset('dark')}),{customerId:null,slot:'dark'},'de'),'An seiner Stelle erscheint das Logo der hellen Darstellung.','portal dark with a light logo, German');
check(fallback(view({light:asset('light')}),{customerId:null,slot:'light'}),'The Nodiverna logo appears in its place.','the last portal logo');
check(fallback(view({light:asset('light')},[{id:'c1',light:asset('light'),dark:null}]),{customerId:'c1',slot:'light'}),'The portal logo appears in its place.','a customer logo with a portal logo');
check(fallback(view({},[{id:'c1',light:asset('light'),dark:asset('dark')}]),{customerId:'c1',slot:'dark'}),'The logo of the light appearance appears in its place.','a customer logo with its other appearance');
check(fallback(view({},[{id:'c1',light:asset('light'),dark:null}]),{customerId:'c1',slot:'light'}),'The Nodiverna logo appears in its place.','a customer logo without any other logo');
check(fallback(view({icon:asset('icon')}),{customerId:null,slot:'icon'}),'Browser tabs show the Nodiverna icon again.','the icon');

// ---- Client size check and tab icon ----
check(model.brandingFileProblem('light',2*1024*1024,'en'),null,'2 MiB fits a logo');
check(model.brandingFileProblem('light',2*1024*1024+1,'en'),'The logo file is larger than 2 MiB. Choose a smaller file.','2 MiB + 1');
check(model.brandingFileProblem('icon',256*1024+1,'de'),'Die Symboldatei ist größer als 256 KiB. Wähle eine kleinere Datei.','an icon over 256 KiB, German');
check(model.faviconHref(asset('icon'),5),'/api/branding/favicon?v=0123456789abcdef','after an upload: the hash');
check(model.faviconHref(null,5),'/api/branding/favicon?v=5','after a removal: the time');

// ---- Upload errors in place ----
ok(/const failInPlace=\(target:BrandingTarget\)=>\(text:string\)=>\{if\(mounted\.current\)setUploadError\(\{key:targetKey\(target\),message:text\}\);\};/.test(pageSource),'a failed portal upload keeps its message with the key of its target');
ok(pageSource.includes("if(problem){if(target.customerId===null)failInPlace(target)(problem);else toast.error(problem);return;}"),'the client size check shows in place for a portal slot and as a toast for a customer logo');
ok(pageSource.includes("portal&&kind==='upload'?failInPlace(target):undefined")&&pageSource.includes('if(portal&&!running.current)setUploadError(null);'),'an error answer of a portal upload shows in place; the next portal upload or removal clears the message');
ok(pageSource.includes('onFailure:(text:string)=>void=text=>{toast.error(text);}'),'every other failed request stays a toast');

// ---- Colors ----
const candidates=['#ffd400','#1e5adc','#28aa46'];
for(const locale of ['en','de']){
 const colorCard=(colors,state=set,actions=idle)=>card(page(state,{colors},locale,actions),'sdx-branding-scheme');
 const t={en:{noLogo:['No logo to take colors from','Upload a logo, then choose a color from it.','Upload light logo…'],reading:'Reading the logo colors…',failed:['The colors of the logo could not be read.','Try again'],noColor:['The logo has no distinct color','Logos in black, white or gray give no suggestion. Upload a logo in color to get one.','Replace light logo…'],
   lead:'Main color',captions:['Light appearance','Dark appearance'],apply:'Apply colors',contrast:/Text stays easy to read in these colors\. Contrast: buttons \d+\.\d:1, links \d+\.\d:1, icons \d+\.\d:1\./,adjusted:'In the light appearance, the color is',remove:'Reset to default colors…',
   inUse:['The default colors (Aurora) are in use.','Your colors are in use.'],already:'These colors are already applied.',tags:['Default','Custom'],waiting:'Another upload or removal is still running.'},
  de:{noLogo:['Kein Logo für Farben vorhanden','Lade ein Logo hoch und wähle dann eine Farbe daraus.','Helles Logo hochladen…'],reading:'Logofarben werden gelesen…',failed:['Die Farben des Logos konnten nicht gelesen werden.','Erneut versuchen'],noColor:['Das Logo hat keine deutliche Farbe','Logos in Schwarz, Weiß oder Grau ergeben keinen Vorschlag. Lade ein farbiges Logo hoch, um einen zu erhalten.','Helles Logo ersetzen…'],
   lead:'Hauptfarbe',captions:['Helle Darstellung','Dunkle Darstellung'],apply:'Farben übernehmen',contrast:/Texte bleiben in diesen Farben gut lesbar\. Kontrast: Schaltflächen \d+,\d:1, Links \d+,\d:1, Symbole \d+,\d:1\./,adjusted:'In der hellen Darstellung ist die Farbe um',remove:'Auf Standardfarben zurücksetzen…',
   inUse:['Die Standardfarben (Aurora) werden verwendet.','Deine Farben werden verwendet.'],already:'Diese Farben sind bereits übernommen.',tags:['Standard','Angepasst'],waiting:'Ein anderes Hochladen oder Entfernen läuft noch.'}}[locale];
 const none=textOf(colorCard({status:'none'},empty));
 for(const part of [...t.noLogo,t.inUse[0]])ok(none.includes(part),`${locale}: no logo: ${part}`);
 const reading=colorCard({status:'reading'});
 ok(reading.includes(`aria-label="${t.reading}"`)&&textOf(reading).includes(t.inUse[0]),`${locale}: reading: the Skeleton with its label, and the in-use line`);
 const failedText=textOf(colorCard({status:'failed'}));
 for(const part of t.failed)ok(failedText.includes(part),`${locale}: read failure: ${part}`);
 const noColor=textOf(colorCard({status:'done',candidates:[]}));
 for(const part of t.noColor)ok(noColor.includes(part),`${locale}: no candidate: ${part}`);
 ok(!noColor.includes(t.apply)&&!noColor.includes(t.remove),`${locale}: no Apply and no Reset without a candidate and a scheme`);
 const html=colorCard({status:'done',candidates}),plain=textOf(html);
 ok(html.includes(`<h3 id="sdx-branding-scheme-lead" class="sdx-brand-label">${t.lead}</h3><div class="sdx-brand-leads" role="radiogroup" aria-labelledby="sdx-branding-scheme-lead">`),`${locale}: the visible label names the radiogroup`);
 const radios=[...html.matchAll(/<button [^>]*role="radio"[^>]*class="sdx-brand-lead"[^>]*>/g)].map(match=>match[0]);
 check(radios.length,3,`${locale}: one radio per candidate`);
 ok(radios[0].includes('aria-checked="true"')&&radios[0].includes('tabindex="0"')&&radios.slice(1).every(radio=>radio.includes('aria-checked="false"')&&radio.includes('tabindex="-1"')),`${locale}: the first is selected and the only Tab stop`);
 ok(radios[1].includes(locale==='en'?'aria-label="Color 2: #1e5adc"':'aria-label="Farbe 2: #1e5adc"'),`${locale}: the radio names`);
 const samples=[...html.matchAll(/<div class="sdx-brand-sample"><p>([^<]+)<\/p><div class="sdx-branding-frame sdx-branding-frame-(light|dark) sdx-brand-preview sdx-branding-fade" style="([^"]*)" aria-hidden="true">/g)];
 check(samples.map(match=>[match[1],match[2]]),[[t.captions[0],'light'],[t.captions[1],'dark']],`${locale}: a light and a dark sample frame, each under its caption`);
 ok(/--brand-light-accent:#[0-9a-f]{6}/.test(samples[0][3])&&!samples[0][3].includes('--brand-dark-')&&/--brand-dark-panel:#[0-9a-f]{6}/.test(samples[1][3])&&!samples[1][3].includes('--brand-light-'),`${locale}: each frame carries only its own --brand-<mode>-* values`);
 ok(t.contrast.test(plain),`${locale}: the readability line with the three ratios`);
 ok(plain.includes(t.adjusted),`${locale}: yellow is adjusted in the light appearance`);
 ok(plain.includes(t.apply)&&!plain.includes(t.remove)&&plain.includes(t.inUse[0])&&!plain.includes(t.inUse[1]),`${locale}: Apply, the default in-use line, no Reset without a stored scheme`);
 check([tagOf(html)[1],tagOf(html)[2]],[undefined,t.tags[0]],`${locale}: Colors is Default without a stored scheme`);
 ok(new RegExp(`<h2 id="sdx-branding-scheme">.*?<span class="sdx-tag sdx-tag-sm sdx-branding-fade">${t.tags[0]}</span></h2>`).test(html),`${locale}: the tag sits in the card title`);
 const applied=colorCard({status:'done',candidates},{...set,scheme:{primary:'#1e5adc',secondary:'#ffd400'}});
 const appliedRadios=[...applied.matchAll(/<button [^>]*role="radio"[^>]*class="sdx-brand-lead"[^>]*>/g)].map(match=>match[0]);
 ok(appliedRadios[1].includes('aria-checked="true"'),`${locale}: the applied primary is preselected`);
 ok(textOf(applied).includes(t.inUse[1])&&!textOf(applied).includes(t.inUse[0])&&textOf(applied).includes(t.remove)&&applied.includes('<span class="sdx-brand-applied-swatches" aria-hidden="true"><span style="background:#1e5adc"></span><span style="background:#ffd400"></span></span>'),`${locale}: the stored swatches, the custom in-use line and Reset to default colors…`);
 check([tagOf(applied)[1],tagOf(applied)[2]],[' sdx-tag-changed',t.tags[1]],`${locale}: Colors is Custom with a stored scheme`);
 ok(new RegExp(`aria-disabled="true"[^>]*>[\\s\\S]*?${t.apply}`).test(applied)&&textOf(applied).includes(t.already),`${locale}: Apply is blocked while the selection is applied`);
 ok(textOf(colorCard({status:'none'},{...empty,scheme:{primary:'#1e5adc',secondary:'#ffd400'}})).includes(t.remove),`${locale}: Reset stays while a scheme is stored, also without a logo`);
 ok(textOf(colorCard({status:'done',candidates},set,{...idle,busy:{key:'portal:light',kind:'upload'}})).includes(t.waiting),`${locale}: Apply waits for another request`);
}
const schemeSource=fs.readFileSync('ui/settings/brand-scheme-card.tsx','utf8');
ok(!/#[0-9a-f]{6}\b/i.test(schemeSource),'no color literal in the card source');
ok(/<ConfirmDialog open=\{schemeRemoval\} onOpenChange=\{[^}]*\{[^}]*\}\}\s*title=\{t\('branding\.confirm\.removeSchemeTitle'\)\} body=\{t\('branding\.confirm\.schemeText'\)\}\s*confirmLabel=\{t\('branding\.confirm\.removeScheme'\)\} onConfirm=\{confirmSchemeRemoval\}\/>/.test(pageSource),'Reset asks in the default tone, with its title, text and verb');
ok(pageSource.includes("postJson({action:'clearScheme'}),'branding.scheme.removed',refreshSchemeStylesheet")&&pageSource.includes("postJson({action:'setScheme',...colors}),'branding.scheme.applied',refreshSchemeStylesheet"),'Reset and Apply send the actions of the API and repaint the page');
{
 const {default:en}=await import('../../../lib/i18n/messages/en.ts'),{default:de}=await import('../../../lib/i18n/messages/de.ts');
 check([en['branding.confirm.removeSchemeTitle'],en['branding.confirm.schemeText'],en['branding.confirm.removeScheme'],en['branding.scheme.removed'],en['branding.scheme.applied']],
  ['Reset to default colors?','Accounts that have not chosen a color scheme see the default colors (Aurora) again.','Reset to default colors','Colors reset to the default.','Colors applied.'],'the reset dialog and the color toasts');
 check([de['branding.confirm.removeSchemeTitle'],de['branding.confirm.schemeText'],de['branding.confirm.removeScheme'],de['branding.scheme.removed'],de['branding.scheme.applied']],
  ['Auf Standardfarben zurücksetzen?','Konten, die kein Farbschema gewählt haben, sehen wieder die Standardfarben (Aurora).','Auf Standardfarben zurücksetzen','Farben auf den Standard zurückgesetzt.','Farben übernommen.'],'German');
 // The keys that no reader is left for are gone from both catalogs; the audit display keeps its target label.
 for(const key of ['branding.slot.lightHint','branding.slot.darkHint','branding.slot.empty','branding.icon.description','branding.icon.empty','branding.scheme.appliedLabel','branding.signin.title','branding.console.title','branding.background.noneShown'])ok(!(key in en)&&!(key in de),`${key} is removed`);
 check([en['branding.scheme.title'],de['branding.scheme.title']],['Color scheme','Farbschema'],'the audit target label stays');
 check([en['help.branding.tip1'],de['help.branding.tip1']],['The preview shows the sign-in page and the console with your choices. Switch between the two pages, and between the light and the dark appearance.','Die Vorschau zeigt die Anmeldeseite und die Konsole mit deiner Auswahl. Wechsle zwischen den beiden Seiten und zwischen der hellen und der dunklen Darstellung.'],'the help topic leads with the preview');
 const {default:enServer}=await import('../../../lib/i18n/messages/en-server.ts'),{default:deServer}=await import('../../../lib/i18n/messages/de-server.ts');
 check([enServer['apiError.branding.svgInvalid'],enServer['apiError.branding.svgEmpty'],enServer['apiError.branding.defaultCustomer']],
  ['This SVG file cannot be used, because it is damaged or contains a DOCTYPE. Export it again as plain SVG.','Nothing is left of this SVG file after Nodiverna removed scripts and embedded content. Export it as plain SVG with shapes or text.','The default customer uses the portal logo. Upload it under Logo and icon.'],'the plain server texts');
 check([deServer['apiError.branding.svgInvalid'],deServer['apiError.branding.svgEmpty'],deServer['apiError.branding.defaultCustomer']],
  ['Diese SVG-Datei lässt sich nicht verwenden, weil sie beschädigt ist oder eine DOCTYPE-Angabe enthält. Exportiere sie erneut als einfaches SVG.','Von dieser SVG-Datei bleibt nichts übrig, nachdem Nodiverna Skripte und eingebettete Inhalte entfernt hat. Exportiere sie als einfaches SVG mit Formen oder Text.','Der Standardkunde verwendet das Portal-Logo. Lade es unter Logo und Symbol hoch.'],'German');
}
check([model.schemeApplied({primary:'#111111',secondary:'#222222'},{primary:'#111111',secondary:'#222222'}),model.schemeApplied({primary:'#111111',secondary:'#333333'},{primary:'#111111',secondary:'#222222'}),model.schemeApplied(null,null)],[true,false,false],'schemeApplied');
check([model.preselectedCandidate(['#a','#b'],{primary:'#b',secondary:'#a'}),model.preselectedCandidate(['#a','#b'],{primary:'#c',secondary:'#a'}),model.preselectedCandidate(['#a'],null)],[1,0,0],'the preselected candidate');
check(model.schemeStylesheetHref(42),'/api/branding/scheme?v=42','the stylesheet link version');
{
 // The color selection of the page: the preselection is no preview; a pick is, until it is applied or the list changes.
 const stored={primary:'#1e5adc',secondary:'#ffd400'};
 const fresh=model.schemeSelection(candidates,null,null);
 check([fresh.selected,fresh.suggestion,fresh.result.ok,fresh.applied,fresh.pending],[0,{primary:'#ffd400',secondary:'#1e5adc'},true,false,false],'without a pick: the first candidate, not applied, and no preview');
 const picked=model.schemeSelection(candidates,model.schemePick(fresh,1),null);
 check([picked.selected,picked.suggestion,picked.applied,picked.pending],[1,stored,false,true],'a pick is selected and shows in the preview before Apply');
 const afterApply=model.schemeSelection(candidates,model.schemePick(fresh,1),stored);
 check([afterApply.selected,afterApply.applied,afterApply.pending],[1,true,false],'after Apply the stored primary is selected, and nothing is pending');
 const afterReset=model.schemeSelection(candidates,model.schemePick(afterApply,2),null);
 check([afterReset.selected,afterReset.pending],[0,false],'a pick made for a stored scheme lapses after Reset');
 check(model.schemeSelection(['#28aa46'],model.schemePick(fresh,1),null).selected,0,'a pick lapses with a new candidate list');
 check([model.schemeSelection([],null,stored).suggestion,model.schemeSelection([],null,stored).pending],[null,false],'no candidates: no selection');
 check(model.pendingSchemeProperties(fresh),undefined,'no preview values without a pick');
 const properties=model.pendingSchemeProperties(picked);
 ok(Object.keys(properties).every(name=>/^--brand-(?:light|dark)-[a-z-]+$/.test(name))&&/^#[0-9a-f]{6}$/.test(properties['--brand-light-accent'])&&/^#[0-9a-f]{6}$/.test(properties['--brand-dark-panel'])&&!('--brand-light-panel' in properties),'a pick gives the --brand-* values of both appearances');
 check(model.pendingSchemeProperties(afterApply),undefined,'no preview values once applied');
 check(model.pendingSchemeProperties(null),undefined,'no selection');
}

// ---- Sign-in page and Console ----
const upload=(slot)=>({...asset(slot,'image/jpeg'),width:2560,height:1440,size:3*1024*1024});
for(const locale of ['en','de']){
 const t={en:{label:'Background',none:'None',own:'Own image',upload:'Upload image…',replace:'Replace image…',remove:'Remove image…',rules:'Own image: PNG, WebP, JPEG or SVG, up to 8 MiB, 320 to 7680 px per side.',ownOff:'You turned the console background off for your account. Turn it on in My account to see it.',open:'Open My account',labels:['Mist','Dusk','Tide','Dune','Slate','Bloom'],tags:['Default','Custom']},
  de:{label:'Hintergrund',none:'Keiner',own:'Eigenes Bild',upload:'Bild hochladen…',replace:'Bild ersetzen…',remove:'Bild entfernen…',rules:'Eigenes Bild: PNG, WebP, JPEG oder SVG, bis 8 MiB, 320 bis 7680 px pro Seite.',ownOff:'Du hast den Hintergrund der Konsole für dein Konto ausgeschaltet. Schalte ihn unter Mein Konto ein, um ihn zu sehen.',open:'Mein Konto öffnen',labels:['Nebel','Dämmerung','Gezeiten','Düne','Schiefer','Blüte'],tags:['Standard','Angepasst']}}[locale];
 const html=page(set,{},locale);
 for(const area of ['signin','console']){
  const area_card=card(html,`sdx-branding-${area}`),plain=textOf(area_card);
  ok(area_card.includes(`<h3 id="sdx-branding-${area}-background" class="sdx-brand-label">${t.label}</h3><div class="sdx-bg-tiles" role="radiogroup" aria-labelledby="sdx-branding-${area}-background">`),`${locale}: ${area}: the visible label names the tile radiogroup`);
  const tiles=[...area_card.matchAll(/<button [^>]*role="radio"[^>]*>/g)].map(match=>match[0]);
  check(tiles.length,8,`${locale}: ${area}: None, six bundled backgrounds and Own image`);
  check(tiles.map(tile=>/aria-label="([^"]*)"/.exec(tile)[1]),[t.none,...t.labels,`${t.own}: ${t.upload}`],`${locale}: ${area}: the tile names`);
  ok(tiles[0].includes('aria-checked="true"')&&tiles[0].includes('tabindex="0"')&&tiles.slice(1).every(tile=>tile.includes('tabindex="-1"')),`${locale}: ${area}: None is chosen and the one Tab stop`);
  ok(area_card.includes('src="/backgrounds/mist.svg"')&&area_card.includes('src="/backgrounds/bloom.svg"'),`${locale}: ${area}: bundled thumbnails`);
  ok(area_card.includes('<p class="sdx-brand-rules">')&&plain.includes(t.rules),`${locale}: ${area}: the limits line`);
  ok(!plain.includes(t.replace)&&!plain.includes(t.remove),`${locale}: ${area}: no Replace or Remove without an upload`);
  ok(!/sdx-stage|role="img"|sdx-backdrop-scrims/.test(area_card),`${locale}: ${area}: the card holds no miniature`);
  check([tagOf(area_card)[1],tagOf(area_card)[2]],[undefined,t.tags[0]],`${locale}: ${area}: Default while the choice is None`);
  ok(!area_card.includes('sdx-field-error'),`${locale}: ${area}: no error without a failed upload`);
 }
 const chosen=page({...set,backgrounds:{signin:{choice:'dusk',upload:upload('signin')},console:{choice:'upload',upload:upload('console'),measured:false,scrim:fallbackScrim}}},{consoleBackgroundOn:false},locale);
 const signin=card(chosen,'sdx-branding-signin'),consoleCard=card(chosen,'sdx-branding-console');
 for(const area_card of [signin,consoleCard]){
  check([tagOf(area_card)[1],tagOf(area_card)[2]],[' sdx-tag-changed',t.tags[1]],`${locale}: an area with a background is Custom`);
  ok(textOf(area_card).includes(t.replace)&&textOf(area_card).includes(t.remove)&&textOf(area_card).includes('JPEG · 2560 × 1440 px · 3 MiB'),`${locale}: the facts line of the upload with Replace and Remove`);
 }
 const tilesOf=area_card=>[...area_card.matchAll(/<button [^>]*role="radio"[^>]*class="sdx-bg-tile[^"]*"[^>]*>/g)].map(match=>match[0]);
 ok(tilesOf(signin)[2].includes('aria-checked="true"')&&tilesOf(signin)[7].includes(`aria-label="${t.own}"`)&&tilesOf(consoleCard)[7].includes('aria-checked="true"'),`${locale}: Dusk and Own image are chosen; Own image with an upload has its plain name`);
 ok(textOf(consoleCard).includes(t.ownOff)&&textOf(consoleCard).includes(t.open)&&!textOf(signin).includes(t.ownOff),`${locale}: the own-off notice with Open My account, in the card Console`);
 ok(!textOf(page({...set,backgrounds:{signin:noBackgrounds.signin,console:{choice:'tide',upload:null,measured:false,scrim:fallbackScrim}}},{consoleBackgroundOn:true},locale)).includes(t.ownOff),`${locale}: no notice while the own preference is on`);
 ok(!textOf(page(set,{consoleBackgroundOn:false},locale)).includes(t.ownOff),`${locale}: no notice without a console background`);
 const waiting=page(set,{},locale,{...idle,busy:{key:'portal:light',kind:'upload'}});
 ok(/class="sdx-bg-tile[^"]*" aria-disabled="true"/.test(waiting)&&waiting.includes('class="sdx-bg-waiting"'),`${locale}: tiles wait with branding.busy while another request runs`);
 const running=page(set,{},locale,{...idle,busy:{key:'background:signin:tide',kind:'choice'}});
 ok(/sdx-bg-tile-spinner/.test(card(running,'sdx-branding-signin'))&&!/sdx-bg-tile-spinner/.test(card(running,'sdx-branding-console')),`${locale}: the chosen tile shows the spinner while its request runs`);
 const broken=page(set,{uploadError:{key:'portal:console',message:'The image must have 320 to 7680 pixels per side. Resize it and upload it again.'}},locale);
 ok(card(broken,'sdx-branding-console').includes('<p class="sdx-field-error" role="alert">The image must have 320 to 7680 pixels per side. Resize it and upload it again.</p>')&&!card(broken,'sdx-branding-signin').includes('sdx-field-error')&&!card(broken,'sdx-branding-portal').includes('sdx-field-error'),`${locale}: the upload error shows in the card of its area only`);
}
const css=fs.readFileSync('ui/settings/branding.css','utf8');
ok(css.includes('.sdx-bg-tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr));')&&(css.match(/\.sdx-bg-tiles \{/g)??[]).length===1,'four tiles per row at every width');
ok(css.includes('.sdx-branding-cards { display: grid; gap: var(--sd-space-4); min-width: 0; container-type: inline-size; }')&&!/@media/.test(css)&&/@container \(max-width: 480px\)/.test(css),'the card internals follow the card width (a container query), never a viewport breakpoint');
check(model.tileFocusStep('ArrowRight',7,8),0,'arrows wrap');
check([model.tileFocusStep('ArrowLeft',0,8),model.tileFocusStep('Home',5,8),model.tileFocusStep('End',1,8),model.tileFocusStep('Enter',1,8),model.tileFocusStep(' ',1,8)],[7,0,7,null,null],'arrows, Home and End move focus only; Enter and Space are no focus move (manual activation)');
const pickerSource=fs.readFileSync('ui/settings/branding-backgrounds.tsx','utf8');
ok(pickerSource.includes('event.preventDefault();setFocus(next);refs.current[next]?.focus();')&&!/onKeyDown=\{[^}]*onChoose/.test(pickerSource),'a key moves focus and never saves; a click (Enter or Space on the button) selects');
check([model.tileAction({choice:'none',upload:null},'upload'),model.tileAction({choice:'none',upload:upload('signin')},'upload'),model.tileAction({choice:'mist',upload:null},'mist'),model.tileAction({choice:'mist',upload:null},'none')],['upload','select','none','select'],'Own image without an upload opens the file picker');
check([model.backgroundChangedKey('none'),model.backgroundChangedKey('dune')],['branding.background.turnedOff','branding.background.changed'],'the toast keys');
check(model.removalFallback({...view({}),backgrounds:{signin:{choice:'upload',upload:upload('signin')},console:noBackgrounds.console}},{customerId:null,slot:'signin'}),'This image is shown now. After the removal, no background is shown.','removing a shown upload');
check(model.removalFallback({...view({}),backgrounds:{signin:{choice:'mist',upload:upload('signin')},console:noBackgrounds.console}},{customerId:null,slot:'signin'},'de'),'Dieses Bild wird gerade nicht angezeigt. Die aktuelle Auswahl bleibt.','removing a stored upload, German');
check(model.brandingFileProblem('console',8*1024*1024,'en'),null,'8 MiB fits a background');
check(model.brandingFileProblem('signin',8*1024*1024+1,'en'),'The image file is larger than 8 MiB. Choose a smaller file.','8 MiB + 1');
check(model.consoleOwnOff({backgrounds:{signin:noBackgrounds.signin,console:{choice:'upload',upload:null,measured:false,scrim:null}}},false),false,'an upload choice without its image shows nothing, so no notice');
// A background change shows its page in the preview before the request starts; logos, the icon and colors keep the page.
check([model.previewSurfaceFor('signin'),model.previewSurfaceFor('console'),model.previewSurfaceFor('light'),model.previewSurfaceFor('dark'),model.previewSurfaceFor('icon')],['signin','console',null,null,null],'the page a change of a slot belongs to');
ok(pageSource.includes('onChoose:(area:BrandingBackgroundSlot,choice:BrandingBackgroundChoice)=>{setSurface(area);(actions.onChoose??noop)(area,choice);}')&&pageSource.includes('onUpload:(target:BrandingTarget)=>{showPage(target);actions.onUpload(target);}')&&pageSource.includes('onRemove:(target:BrandingTarget)=>{showPage(target);actions.onRemove(target);}'),'a choice, an upload and a removal of a background card switch the preview first');
ok(pageSource.includes('const showPage=(target:BrandingTarget)=>{const next=target.customerId===null?previewSurfaceFor(target.slot):null;if(next)setSurface(next);};')&&/<PortalRow [^>]*actions=\{actions\}/.test(pageSource),'the rows of Logo and icon use the plain actions, so they keep the shown page');

// ---- Console: the fitting feedback ----
const dusk=brandingBackgrounds.find(background=>background.id==='dusk'),duskScrim=backdropScrims(dusk.measure,null);
for(const locale of ['en','de']){
 const t={en:{measuring:'Fitting this image to the console…',failed:'Nodiverna could not fit this image to the console, so the image shows fainter than it could. Try again to show more of it.',retry:'Try again'},
  de:{measuring:'Dieses Bild wird an die Konsole angepasst…',failed:'Nodiverna konnte dieses Bild nicht an die Konsole anpassen. Darum erscheint es blasser als möglich. Versuche es erneut, um mehr davon zu zeigen.',retry:'Erneut versuchen'}}[locale];
 const consoleCard=(state,extra)=>card(page(state,extra,locale),'sdx-branding-console');
 const withUpload={...set,backgrounds:{signin:noBackgrounds.signin,console:{choice:'upload',upload:upload('console'),measured:false,scrim:fallbackScrim}}};
 const running=consoleCard(withUpload,{measurement:{version:'0123456789abcdef',status:'running'}});
 ok(new RegExp(`<p class="sdx-bg-measuring" role="status">.*${t.measuring}</p>`).test(running),`${locale}: the fitting status line`);
 ok(!running.includes('sdx-notice-warning'),`${locale}: no warning while it runs`);
 const failedMeasure=consoleCard(withUpload,{measurement:{version:'0123456789abcdef',status:'failed'}});
 ok(/sdx-notice[^"]*warning/.test(failedMeasure)&&textOf(failedMeasure).includes(t.failed)&&textOf(failedMeasure).includes(t.retry),`${locale}: the warning Notice with Try again`);
 ok(!textOf(failedMeasure).includes(t.measuring),`${locale}: no status line after a failure`);
 const noUpload=consoleCard({...set,backgrounds:{signin:noBackgrounds.signin,console:{choice:'dusk',upload:null,measured:false,scrim:duskScrim}}},{measurement:{version:'0123456789abcdef',status:'failed'}});
 ok(!textOf(noUpload).includes(t.failed)&&!textOf(noUpload).includes(t.measuring),`${locale}: no fitting feedback without an upload`);
 ok(!/sdx-bg-measuring|sdx-notice[^"]*warning/.test(consoleCard(withUpload,{measurement:null})),`${locale}: success shows nothing extra`);
}
check(model.assetVersion(upload('console')),'0123456789abcdef','the version of an upload');
check(model.pendingMeasurement({upload:upload('console'),measured:false}),{url:'/api/branding/portal/console?v=0123456789abcdef',width:2560,height:1440,version:'0123456789abcdef'},'an unmeasured upload is pending');
check([model.pendingMeasurement({upload:upload('console'),measured:true}),model.pendingMeasurement({upload:null,measured:false})],[null,null],'nothing to measure once measured or without an upload');
check(model.measureBody('0123456789abcdef',fallbackBackdropMeasure),{action:'measureBackground',version:'0123456789abcdef',measure:fallbackBackdropMeasure},'the POST body');
{
 // A newer upload while the image is read: the result of the older upload is not sent.
 let latest='aaaaaaaaaaaaaaaa';const sent=[];
 let finishRead;const reading=new Promise(resolve=>{finishRead=resolve;});
 const run=model.runMeasurement({version:'aaaaaaaaaaaaaaaa',current:version=>version===latest,read:()=>reading,send:async measure=>{sent.push(measure);return 'view';}});
 latest='bbbbbbbbbbbbbbbb';finishRead(fallbackBackdropMeasure);
 check(await run,{status:'stale'},'a stale measurement is dropped');
 check(sent,[],'and not sent');
 const fresh=await model.runMeasurement({version:'bbbbbbbbbbbbbbbb',current:version=>version===latest,read:async()=>fallbackBackdropMeasure,send:async measure=>{sent.push(measure);return 'view';}});
 check([fresh,sent.length],[{status:'sent',result:'view'},1],'the current measurement is sent once');
 await assert.rejects(model.runMeasurement({version:'bbbbbbbbbbbbbbbb',current:()=>true,read:async()=>{throw new Error('load');},send:async()=>'view'}),/load/,'a failed read rejects (the card shows the warning)');checks++;
}
ok(pageSource.includes('current:()=>live')&&pageSource.includes('return ()=>{live=false;};'),'a newer upload (a new version) or closing the page ends the running measurement');
ok(/export function readBackdropMeasure[\s\S]*fitInto\([^)]*backdropMeasureSide\)[\s\S]*measureBackdrop\(context\.getImageData\(/.test(pickerSource),'the browser draws the image at most 320 px long and measures its pixels');
// The requests keep their routes, methods and bodies.
ok(pageSource.includes("const route='/api/branding/manage';")&&pageSource.includes("credentialFetch(targetPath(target),{method:'PUT',headers:{'Content-Type':file.type||'application/octet-stream'},body:file,cache:'no-store'})")&&pageSource.includes("credentialFetch(targetPath(target),{method:'DELETE',cache:'no-store'})")&&pageSource.includes("postJson({action:'setBackground',area,choice})"),'upload, removal and choice send what they sent before');
check([model.targetPath({customerId:null,slot:'icon'}),model.targetPath({customerId:'c 1',slot:'dark'})],['/api/branding/portal/icon','/api/branding/customer/c%201/dark'],'the image routes');

// ---- Navigation ----
const ids=viewer=>navModel.navigatorPages('settings',{viewer}).map(node=>node.id);
const owner=ids({permissions:['*']});
check(owner.slice(owner.indexOf('settings.customers'),owner.indexOf('settings.customers')+2),['settings.customers','settings.branding'],'Branding follows Customers');
ok(!ids({permissions:['portal.users.manage','portal.roles.manage','portal.notifications.manage']}).includes('settings.branding'),'a non-Owner does not see it');
const node=navModel.navNode('settings.branding');
check([node.palette.id,node.palette.keywordsKey,node.help,node.icon,node.placement.group],['page-settings-branding','branding.paletteKeywords','branding','Palette','nav.settings.groupOrganization'],'palette entry, help topic, icon and group');
console.log(`PASS branding page view (${checks} checks): page frame and card order, Logo and icon rows with states, limits and errors, Colors, Sign-in page and Console, the customer table in its card, removal fallbacks, size check, the selection and measurement models, navigation.`);
