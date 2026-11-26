// The Preferences card of My account: five kit Selects with the current values (Density after the console background
// switch and before Language, applied at once through applyDensity without a toast), the scheme list of
// the effective mode with its hint, changes that apply at once through the shared setters (only the
// start page toasts), no Save button, and the command palette items unchanged. Panel harness, no browser.
// The brand colors lead the scheme list only while the portal has a brand scheme. The switch Console background:
// checked and blocked states, the promise keeps the state and a rejection rolls back with a toast, and the palette
// action with the same effect.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {panelHarness} from '../../support/panel-harness.mjs';
import {schemesFor} from '../../../lib/color-schemes.ts';
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};

const state={theme:'dark',mode:'dark',choice:{light:'aurora',dark:'aurora'},start:'devices',density:'comfortable'},calls=[];
const harness=panelHarness({hooked:['ui/account/account-preferences.tsx'],locale:'en',stubs:{
 '@/ui/shell/theme':api=>({...api.load('ui/shell/theme.tsx'),useTheme:()=>[state.theme,value=>calls.push(['applyTheme',value])]}),
 '@/ui/shell/color-scheme':api=>({...api.load('ui/shell/color-scheme.tsx'),useEffectiveMode:()=>state.mode,useSchemeChoice:()=>state.choice}),
 '@/ui/shell/start-page':api=>({...api.load('ui/shell/start-page.tsx'),useStartPage:()=>state.start}),
 '@/ui/shell/density':api=>({...api.load('ui/shell/density.tsx'),useDensity:()=>[state.density,value=>calls.push(['applyDensity',value])]}),
}});
const {PreferencesCard}=harness.load('ui/account/account-preferences.tsx');
const props={setDensity:value=>calls.push(['density',value]),setTheme:value=>calls.push(['theme',value]),setScheme:(id,mode)=>calls.push(['scheme',id,mode]),setLocale:value=>calls.push(['locale',value]),setStartPage:value=>calls.push(['start',value])};
const selected=(html,id)=>{const select=html.match(new RegExp(`<select[^>]*id="${id}"[^>]*>([\\s\\S]*?)</select>`));return select&&[...select[1].matchAll(/<option[^>]*value="([^"]*)"[^>]*selected=""/g)].map(match=>match[1]);};
const options=(html,id)=>[...html.match(new RegExp(`<select[^>]*id="${id}"[^>]*>([\\s\\S]*?)</select>`))[1].matchAll(/<option([^>]*)>([^<]*)<\/option>/g)].map(match=>[match[1].match(/value="([^"]*)"/)[1],match[2],match[1].match(/lang="([^"]*)"/)?.[1]??null]);

harness.reset();
let html=harness.html(PreferencesCard,props);
ok(/<h2[^>]*>.*Preferences/.test(html),'the card Preferences with its title');
{
 const head=html.match(/<header class="sdx-section-head sdx-card-head">([\s\S]*?)<\/header>/)?.[1]??'';
 ok(head&&!/<p[ >]/.test(head),'the card head has no description paragraph (the filler line "Changes apply at once." is gone)');
 ok(!html.includes('Changes apply at once.')&&!html.includes('Änderungen gelten sofort.'),'no "Changes apply at once." in either language');
}
ok(/sdx-icon-tile sdx-icon-tile-accent[\s\S]*?lucide-sliders-horizontal/.test(html),'the SlidersHorizontal icon tile');
check((html.match(/<select/g)??[]).length,5,'five Selects');
for(const [id,label] of [['account-pref-theme','Appearance'],['account-pref-scheme','Color scheme'],['account-pref-density','Density'],['account-pref-language','Language'],['account-pref-start','Start page']])ok(new RegExp(`<label class="sdx-field-label" for="${id}">${label}</label>`).test(html),`Field ${label} is bound to its Select`);
check(options(html,'account-pref-theme').map(([value,text])=>[value,text]),[['light','Light'],['dark','Dark'],['system','Match system']],'Appearance: Light, Dark, Match system');
check(options(html,'account-pref-density').map(([value,text])=>[value,text]),[['comfortable','Comfortable'],['compact','Compact']],'Density: Comfortable, Compact');
ok(html.includes('Compact fits more rows on the screen, except on touch screens and in narrow windows.'),'the density hint');
ok(html.indexOf('account-pref-scheme')<html.indexOf('account-pref-density')&&html.indexOf('account-pref-density')<html.indexOf('account-pref-language'),'Density after the scheme and before Language');
{
 const german=panelHarness({hooked:['ui/account/account-preferences.tsx'],stubs:{
  '@/ui/shell/theme':api=>({...api.load('ui/shell/theme.tsx'),useTheme:()=>[state.theme,()=>{}]}),
  '@/ui/shell/color-scheme':api=>({...api.load('ui/shell/color-scheme.tsx'),useEffectiveMode:()=>state.mode,useSchemeChoice:()=>state.choice}),
  '@/ui/shell/start-page':api=>({...api.load('ui/shell/start-page.tsx'),useStartPage:()=>state.start}),
  '@/ui/shell/density':api=>({...api.load('ui/shell/density.tsx'),useDensity:()=>[state.density,()=>{}]}),
 }});
 german.reset();
 const germanHtml=german.html(german.load('ui/account/account-preferences.tsx').PreferencesCard,props);
 check(options(germanHtml,'account-pref-density').map(([,text])=>text),['Komfortabel','Kompakt'],'German options');
 ok(germanHtml.includes('Darstellungsdichte'),'German label');
}
check(options(html,'account-pref-language'),[['en','English','en'],['de','Deutsch','de']],'Language: each option in its own language with lang');
check(options(html,'account-pref-start').map(([value,text])=>[value,text]),[['dashboard','Dashboard'],['devices','All devices'],['alarms','Alarms']],'Start page: Dashboard, All devices, Alarms');
ok(html.includes('This page opens when you sign in or open Nodiverna without a link.'),'the start page hint');
check(options(html,'account-pref-scheme').map(([value])=>value),schemesFor('dark',{brand:false}).map(scheme=>scheme.id),'the schemes of the effective (dark) mode, without brand while the portal has no brand scheme');
ok(!html.includes('role="switch"'),'no console background switch without its props');
ok(html.includes('For the dark appearance')&&/data-scheme-swatch="aurora"/.test(html),'the dark hint with the swatch of the active scheme');
check([selected(html,'account-pref-theme'),selected(html,'account-pref-language'),selected(html,'account-pref-start'),selected(html,'account-pref-scheme'),selected(html,'account-pref-density')],[['dark'],['en'],['devices'],['aurora'],['comfortable']],'each Select shows the current value');
ok(!/>Save<|>Speichern</.test(html)&&!/type="submit"/.test(html),'no Save button');

// The scheme list follows the effective mode (useEffectiveMode) without a reload.
state.mode='light';state.theme='system';state.choice={light:schemesFor('light').at(-1).id,dark:'aurora'};
html=harness.html(PreferencesCard,props);
check(options(html,'account-pref-scheme').map(([value])=>value),schemesFor('light',{brand:false}).map(scheme=>scheme.id),'light mode: the light schemes');
ok(html.includes('For the light appearance'),'light hint');
check([selected(html,'account-pref-theme'),selected(html,'account-pref-scheme')],[['system'],[state.choice.light]],'system appearance and the light scheme are shown');

// Changes apply at once; only the start page toasts.
const tree=harness.tree(PreferencesCard,props);
const select=id=>harness.find(tree,node=>node.props?.id===id);
select('account-pref-theme').props.onChange({target:{value:'dark'}});
const other=schemesFor('light',{brand:false}).find(scheme=>scheme.id!==state.choice.light).id;
select('account-pref-scheme').props.onChange({target:{value:other}});
select('account-pref-scheme').props.onChange({target:{value:'not-a-scheme'}});
select('account-pref-language').props.onChange({target:{value:'de'}});
select('account-pref-density').props.onChange({target:{value:'compact'}});
select('account-pref-density').props.onChange({target:{value:'dense'}});
check(harness.toasts,[],'appearance, scheme, language and density show their effect without a toast');
select('account-pref-start').props.onChange({target:{value:'alarms'}});
select('account-pref-start').props.onChange({target:{value:'devices'}});
check(calls.splice(0),[['theme','dark'],['scheme',other,'light'],['locale','de'],['density','compact'],['density','comfortable'],['start','alarms']],'applyTheme, selectScheme, the locale setter, applyDensity (an unknown value is comfortable) and saveStartPage run at once; an unknown or unchanged scheme or start page changes nothing');
// Without a setter the card applies the density through useDensity (applyDensity).
harness.find(harness.tree(PreferencesCard,{...props,setDensity:undefined}),node=>node.props?.id==='account-pref-density').props.onChange({target:{value:'compact'}});
check(calls.splice(0),[['applyDensity','compact']],'the default setter is applyDensity');
state.density='compact';
check(selected(harness.html(PreferencesCard,props),'account-pref-density'),['compact'],'the stored density is selected');
check(harness.toasts,['Start page saved.'],'only the start page change toasts');

// The brand colors: the default "brand" shows as Aurora (default) without a brand scheme, and leads with one.
state.mode='dark';state.choice={light:'brand',dark:'brand'};
html=harness.html(PreferencesCard,props);
check([selected(html,'account-pref-scheme'),options(html,'account-pref-scheme')[0].slice(0,2)],[['aurora'],['aurora','Aurora (default)']],'no brand scheme: brand shows as Aurora (default)');
ok(/data-scheme-swatch="aurora"/.test(html),'and its swatch');
html=harness.html(PreferencesCard,{...props,brandScheme:true});
check([selected(html,'account-pref-scheme'),options(html,'account-pref-scheme').slice(0,2).map(([value,text])=>[value,text])],[['brand'],[['brand','Brand colors (default)'],['aurora','Aurora']]],'a brand scheme: Brand colors (default) first and selected, then Aurora');

// The switch Console background: after the scheme field, checked as stored, blocked without a portal background.
const switchOf=html=>html.match(/<input id="account-pref-console-background"[^>]*>/)?.[0]??'';
const saved=[];let settle=null;
const consoleBackground=(available,checked)=>({available,checked,onChange:next=>{saved.push(next);return new Promise((resolve,reject)=>{settle={resolve,reject};});}});
html=harness.html(PreferencesCard,{...props,consoleBackground:consoleBackground(true,true)});
ok(/role="switch"/.test(switchOf(html))&&/checked=""/.test(switchOf(html))&&!/aria-disabled/.test(switchOf(html)),'the switch is on and usable');
ok(html.indexOf('account-pref-scheme')<html.indexOf('account-pref-console-background')&&html.indexOf('account-pref-console-background')<html.indexOf('account-pref-language'),'after the scheme field');
ok(html.includes('Console background')&&html.includes('The background image of the portal shows behind the whole console.'),'label and hint');
html=harness.html(PreferencesCard,{...props,consoleBackground:consoleBackground(true,false)});
ok(!/checked=""/.test(switchOf(html)),'off as stored');
html=harness.html(PreferencesCard,{...props,consoleBackground:consoleBackground(false,true)});
ok(/aria-disabled="true"/.test(switchOf(html))&&html.includes('This portal has no console background. You add one in Settings → Branding.'),'blocked with its reason while the portal has none');
{
 // The card hands the Switch the setter as is: its promise keeps the new state, a rejection rolls back (kit Switch).
 const card=harness.tree(PreferencesCard,{...props,consoleBackground:consoleBackground(true,true)});
 const field=harness.find(card,node=>node.props?.id==='account-pref-console-background');
 const result=field.props.onChange(false);
 check(saved.splice(0),[false],'a change sends the new value');
 ok(result instanceof Promise,'the Switch gets the promise of the setter');
 settle.resolve(false);await result;
}
const fieldSource=fs.readFileSync('ui/kit/field.tsx','utf8');
ok(/const previous=shownValue,result=onChange\(next\);/.test(fieldSource)&&/toast\.error\(message\(end\.error,locale\)\)/.test(fieldSource),'the kit Switch keeps a resolved state and rolls back a rejection with toast.error');
const consoleText=fs.readFileSync('ui/shell/console.tsx','utf8');
ok(consoleText.includes('consoleBackground:{available:!!data?.branding?.consoleBackground,checked:consoleBackgroundOn,onChange:changeConsoleBackground}')&&consoleText.includes('brandScheme:data?.branding?.scheme!=null'),'the console passes the portal state and the setter');
ok(/catch\(failure\)\{setBackdropPreference\(null\);throw failure;\}/.test(consoleText),'the console drops its kept value on a failure, so the switch rolls back');
// The palette action: offered while a console background is set, named for the current state, same setter.
ok(consoleText.includes("if(data?.branding?.consoleBackground)items.push({id:'action-console-background'")&&consoleText.includes("label:t(consoleBackgroundOn?'palette.action.consoleBackgroundOff':'palette.action.consoleBackgroundOn')")&&consoleText.includes('run:()=>{void changeConsoleBackground(!consoleBackgroundOn)'),'the palette action Turn off / Turn on console background');

// Without setters the card uses the real ones.

const source=fs.readFileSync('ui/account/account-preferences.tsx','utf8');
ok(/setScheme=selectScheme/.test(source)&&/setStartPage=saveStartPage/.test(source)&&/\[theme,applyTheme\]=useTheme\(\)/.test(source)&&/\[locale,applyLocale\]=useLocale\(\)/.test(source),'the defaults are selectScheme, saveStartPage, applyTheme and the locale setter');

// The command palette keeps its theme, scheme, language and start page actions.
const consoleSource=fs.readFileSync('ui/shell/console.tsx','utf8');
ok(consoleSource.replace(/\n\s*/g,'').includes('...themePaletteItems(applyTheme,locale),...schemePaletteItems(effectiveMode(currentTheme()),locale,undefined,data?.branding?.scheme!=null),...languagePaletteItems(locale,setLocale),...startPagePaletteItems(locale,()=>toast.success(t(\'startPage.saved\')))'),'the palette items stay');
ok(consoleSource.includes('...densityPaletteItems(currentDensity(),applyDensity,locale),'),'the palette offers the other density');
{
 const density=harness.load('ui/shell/density.tsx');
 const ran=[];
 check(density.densityPaletteItems('comfortable',value=>ran.push(value),'en').map(item=>[item.id,item.label]),[['action-density-compact','Use compact density']],'comfortable: one action, Use compact density');
 check(density.densityPaletteItems('compact',value=>ran.push(value),'de').map(item=>item.label),['Komfortable Darstellung verwenden'],'compact: Use comfortable density (German)');
 density.densityPaletteItems('comfortable',value=>ran.push(value),'en')[0].run();
 check(ran,['compact'],'the action applies the other density');
 const doc={documentElement:{dataset:{}},cookie:''};
 density.applyDensity('compact',{document:doc,location:{protocol:'https:'}});
 check([doc.documentElement.dataset.density,doc.cookie],['compact','serverdesk-density=compact; Path=/; Max-Age=31536000; SameSite=Lax; Secure'],'applyDensity writes data-density and the cookie');
 check(density.currentDensity({document:doc}),'compact','currentDensity reads data-density');
 check(density.densityOptions.map(option=>option.density),['comfortable','compact'],'densityOptions in order');
}
for(const [file,name] of [['ui/shell/theme.tsx','themePaletteItems'],['ui/shell/density.tsx','densityPaletteItems'],['ui/shell/color-scheme.tsx','schemePaletteItems'],['ui/base/locale.tsx','languagePaletteItems'],['ui/shell/start-page.tsx','startPagePaletteItems']])ok(new RegExp(`export function ${name}\\(`).test(fs.readFileSync(file,'utf8')),name+' is exported');

console.log(`PASS account preferences (${checks} checks): five Selects with current values, the density field, the scheme list of the effective mode, changes at once, only the start page toasts, no Save, palette items unchanged.`);
