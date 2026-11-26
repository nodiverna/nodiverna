// The kit form parts of ui/kit/field.tsx, rendered with React SSR in English: Select inside Field
// (label, hint and error bound, sm size, wide and fit, blocked focusable with its reason as description, no change),
// Switch (role="switch", hint and blocked reason named by aria-describedby, the real state while
// blocked), the switch logic (switchToggle, switchSettle) and a Switch on hook cells
// (tests/support/panel-harness.mjs) through resolve, resolve false, reject and a second click, the
// rejection toast in the console locale (useLocale, not the document language), and the FormActions
// matrix with the Discard reason kit.changeSaving while busy or loading. No browser, no server.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {buttons} from '../../support/blocked-buttons.mjs';
import {panelHarness} from '../../support/panel-harness.mjs';
const h=React.createElement;
const {Field,Select,Switch,FormActions,switchToggle,switchSettle}=await import('../../../ui/kit/field.tsx');
const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
const {translate}=await import('../../../lib/i18n/translate.ts');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const render=element=>renderToStaticMarkup(h(LocaleProvider,{locale:'en'},element));
const t=(key,params)=>translate('en',key,params);
const attr=(tag,name)=>tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1]??null;
const textOf=(html,id)=>html.match(new RegExp(`id="${id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}"[^>]*>([^<]*)<`))?.[1]??null;
const noop=()=>{};
const options=[h('option',{key:'a',value:'a'},'Alpha'),h('option',{key:'b',value:'b'},'Beta')];

// ---- Select in Field ----
{
 const html=render(h(Field,{label:'Parent group',hint:'Up to four levels.',error:'Choose a group.'},h(Select,{value:'a',onChange:noop},options)));
 const select=html.match(/<select[^>]*>/)[0],label=html.match(/<label class="sdx-field-label" for="([^"]+)">Parent group<\/label>/);
 ok(label&&attr(select,'id')===label[1],'the Field label is bound to the select (for/id)');
 const described=attr(select,'aria-describedby').split(' ');
 check(described.map(id=>textOf(html,id)),['Up to four levels.','Choose a group.'],'aria-describedby names the hint and the error');
 check([attr(select,'aria-invalid'),attr(select,'class')],['true','sdx-select'],'aria-invalid with the error; the kit class (md)');
 ok(!/\sdisabled=""/.test(select)&&attr(select,'aria-disabled')===null,'an available select has no blocked attributes');
 ok(/class="sdx-select sdx-select-sm"/.test(render(h(Select,{size:'sm',value:'a',onChange:noop},options))),'size="sm" sets the toolbar class');
 ok(/\.sdx-select-sm \{ height: 30px; min-height: 30px;/.test((await import('node:fs')).readFileSync('ui/styles/console.css','utf8')),'sm is 30px, the height of small toolbar buttons');
 ok(/class="sdx-select sdx-select-sm sdx-select-wide"/.test(render(h(Select,{size:'sm',wide:true,value:'a',onChange:noop},options)))&&!/sdx-select-wide/.test(render(h(Select,{size:'sm',value:'a',onChange:noop},options))),'wide sets the wide class, only when asked');
 {const css=(await import('node:fs')).readFileSync('ui/styles/console.css','utf8');
  ok(/:is\(\.sdx, \.sdx-layer\) \.sdx-toolbar \.sdx-select-wide \{ max-width: 320px; \}/.test(css)&&css.indexOf('.sdx-toolbar .sdx-select-wide { max-width: 320px; }')>css.indexOf('.sdx-toolbar .sdx-select { max-width: 168px; }'),'a wide toolbar select keeps up to 320px instead of the 168px cap (same specificity, later rule)');
  ok(/@media \(max-width: 760px\) \{\s*\.sdx-toolbar-filters:has\(> \.sdx-select-wide\) \{ flex: 1 1 100%; \}\s*:is\(\.sdx, \.sdx-layer\) \.sdx-toolbar \.sdx-select-wide \{ flex: 1 1 auto; max-width: none; \}/.test(css),'at 760px or narrower a wide select takes the whole filter row');}
 // fit: as wide as the longest option, never wider than the container, also inside a Field (whose rule sets width 100%).
 {const fitted=render(h(Field,{label:'Sign out after'},h(Select,{fit:true,value:'a',onChange:noop},options))).match(/<select[^>]*>/)[0];
  check([attr(fitted,'class'),attr(render(h(Select,{value:'a',onChange:noop},options)).match(/<select[^>]*>/)[0],'class')],['sdx-select sdx-select-fit','sdx-select'],'fit adds the fit class, only when asked');
  const css=(await import('node:fs')).readFileSync('ui/styles/console.css','utf8');
  ok(css.includes(':is(.sdx, .sdx-layer) select.sdx-select-fit, :is(.sdx, .sdx-layer) .sdx-field select.sdx-select-fit { width: auto; max-width: 100%; justify-self: start; }'),'the fit rule: content width, capped by the container, more specific than the Field rule');}
 const css=(await import('node:fs')).readFileSync('ui/styles/console.css','utf8');
 ok(/select\.sdx-select:not\(\[multiple\]\)::picker-icon \{ margin-left: auto;/.test(css),'the chevron sits at the right edge (customizable selects)');
}
// ---- Blocked Select ----
{
 const changes=[];
 const html=render(h(Field,{label:'Role'},h(Select,{value:'a',blocked:'Not available for sample devices.',onChange:event=>changes.push(event.target.value)},options)));
 const select=html.match(/<select[^>]*>/)[0];
 ok(attr(select,'aria-disabled')==='true'&&!/\sdisabled=""/.test(select)&&/sdx-select-blocked/.test(attr(select,'class')),'blocked: aria-disabled, no native disabled, stays focusable');
 const ids=attr(select,'aria-describedby').split(' ');
 ok(ids.map(id=>textOf(html,id)).includes('Not available for sample devices.'),'the reason is the description of the select');
 ok(/<option value="a" selected="">Alpha<\/option>/.test(html),'it shows the controlled value');
 // The element tree: the change handler of a blocked select does not call onChange.
 let built;renderToStaticMarkup(h(LocaleProvider,{locale:'en'},h(()=>{built=Select.render({value:'a',blocked:'Locked.',onChange:event=>changes.push(event.target.value)},null);return null;})));
 const walk=node=>!node||typeof node!=='object'?[]:Array.isArray(node)?node.flatMap(walk):[node,...Object.values(node.props??{}).flatMap(value=>typeof value==='object'?walk(value):[])];
 const element=walk(built).find(node=>node.type==='select');
 let prevented=0;const event={target:{value:'b'},key:'ArrowDown',pointerType:'mouse',preventDefault(){prevented++;}};
 element.props.onChange(event);element.props.onKeyDown(event);element.props.onMouseDown(event);
 check([changes,prevented],[[],3],'a change, arrow keys and the mouse do nothing; onChange is not called');
 ok(walk(built).some(node=>node.props?.content==='Locked.'),'the reason is in the Tooltip');
}

// ---- Switch markup ----
{
 const html=render(h(Switch,{label:'Enable sign-in with Microsoft',hint:'Accounts sign in with Entra ID.',checked:true,onChange:noop}));
 const input=html.match(/<input[^>]*>/)[0];
 ok(/^<input type="checkbox" role="switch"[^>]*checked=""/.test(input),'an input type="checkbox" role="switch", checked');
 ok(/<label><input[^>]*\/><span>Enable sign-in with Microsoft<\/span><\/label><small id="[^"]+">Accounts sign in with Entra ID\.<\/small>/.test(html),'the label on one line, the hint below it');
 check(attr(input,'aria-describedby').split(' ').map(id=>textOf(html,id)),['Accounts sign in with Entra ID.'],'aria-describedby points to the hint');
 const blocked=render(h(Switch,{label:'Send usage data',hint:'Once a day.',checked:false,blocked:'No license server is set up, so nothing is sent.',onChange:noop}));
 const blockedInput=blocked.match(/<input[^>]*>/)[0];
 ok(attr(blockedInput,'aria-disabled')==='true'&&!/\sdisabled=""/.test(blockedInput)&&!/checked=""/.test(blockedInput),'blocked: focusable, aria-disabled, shows its real state (off)');
 check(attr(blockedInput,'aria-describedby').split(' ').map(id=>textOf(blocked,id)),['Once a day.','No license server is set up, so nothing is sent.'],'the hint and the visible reason are named');
 ok(/<small id="[^"]+" class="sdx-switch-reason">No license server/.test(blocked),'the reason is visible below the label');
 ok(/checked=""/.test(render(h(Switch,{label:'On',checked:true,blocked:'Locked.',onChange:noop}))),'blocked and on: it stays on');
}

// ---- Switch logic ----
{
 check([switchToggle({checked:false,blocked:false,busy:false}),switchToggle({checked:true,blocked:false,busy:false}),switchToggle({checked:false,blocked:true,busy:false}),switchToggle({checked:false,blocked:false,busy:true})],[true,false,null,null],'a click: the next value; nothing while blocked or busy');
 check(switchSettle(false,true,{status:'fulfilled',value:undefined}),{checked:true,report:false},'resolves (anything but false): keeps next');
 check(switchSettle(false,true,{status:'fulfilled',value:{ok:true}}),{checked:true,report:false},'resolves with a value: keeps next');
 check(switchSettle(false,true,{status:'fulfilled',value:false}),{checked:false,report:false},'resolves false: back, no report');
 const failure=new Error('The request failed.');
 check(switchSettle(true,false,{status:'rejected',reason:failure}),{checked:true,report:true,error:failure},'rejects: back, and the error is reported');
}
// ---- A Switch on hook cells: moves at once, aria-busy, end state, toast, second click ----
{
 const harness=panelHarness({hooked:['ui/kit/field.tsx'],locale:'en'});
 const {Switch:Live}=harness.load('ui/kit/field.tsx');
 const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
 let pending,calls=[];
 const props=checked=>({label:'Enable',checked,onChange:next=>{calls.push(next);pending=deferred();return pending.promise;}});
 const input=tree=>harness.find(tree,node=>node.type==='input');
 for(const [outcome,expected,toasts] of [['resolve',true,[]],['false',false,[]],['reject',false,['error:Refused.']]]){
  harness.reset();calls=[];
  let tree=harness.tree(Live,props(false));await harness.flush();
  input(tree).props.onChange();tree=harness.tree(Live,props(false));
  check([input(tree).props.checked,input(tree).props['aria-busy']],[true,true],`${outcome}: the switch shows next at once, aria-busy while open`);
  input(tree).props.onChange();
  check(calls,[true],`${outcome}: a second click while open does nothing`);
  if(outcome==='resolve')pending.resolve({ok:true});else if(outcome==='false')pending.resolve(false);else pending.reject(new Error('Refused.'));
  await harness.settle();tree=harness.tree(Live,props(false));
  check([input(tree).props.checked,input(tree).props['aria-busy'],harness.toasts],[expected,undefined,toasts],`${outcome}: the end state and the report`);
 }
 // A blocked switch: a click calls nothing.
 harness.reset();calls=[];
 const blocked=harness.tree(Live,{...props(false),blocked:'Locked.'});
 input(blocked).props.onChange();check(calls,[],'blocked: a click does nothing');
}

// ---- FormActions ----
{
 const row=props=>{const html=render(h('form',null,h(FormActions,props)));return buttons(html).map(button=>({text:button.inner.match(/<span>([^<]+)<\/span>/)?.[1],variant:attr(button.attributes,'class').replace('sdx-btn ','').replace(' sdx-form-save',''),submit:/type="submit"/.test(button.attributes),blocked:button.blocked,reason:button.description}));};
 check(row({dirty:false,onDiscard:noop}),[{text:'Save',variant:'sdx-btn-secondary',submit:true,blocked:true,reason:t('common.noChanges')}],'not dirty: no Discard, Save a blocked secondary with "No changes"');
 check(row({dirty:true,onDiscard:noop}),[{text:'Discard',variant:'sdx-btn-ghost',submit:false,blocked:false,reason:null},{text:'Save',variant:'sdx-btn-primary',submit:true,blocked:false,reason:null}],'dirty: Discard (ghost), then Save as the primary');
 check(row({dirty:true,onDiscard:noop,blocked:'Enter a name.'}).at(-1),{text:'Save',variant:'sdx-btn-secondary',submit:true,blocked:true,reason:'Enter a name.'},'dirty + blocked: the given reason');
 check(row({dirty:false,blocked:'Not available for sample devices.'}).at(-1).reason,'Not available for sample devices.','the given reason wins over "No changes"');
 check(row({dirty:true,quiet:true,onDiscard:noop}).at(-1).variant,'sdx-btn-secondary','quiet: Save stays secondary while dirty');
 check(row({dirty:true,onDiscard:noop,saveLabel:'Save app'}).map(button=>button.text),['Discard','Save app'],'the Save label can be replaced');
 const html=render(h(FormActions,{dirty:true,onDiscard:noop,extra:h('button',{type:'button'},h('span',null,'Test connection'))}));
 check(buttons(html).map(button=>button.inner.match(/<span>([^<]+)<\/span>/)?.[1]),['Test connection','Discard','Save'],'extra comes first, then Discard and Save');
 ok(/^<div class="sdx-form-actions">/.test(html),'the row is .sdx-form-actions');
 ok(/aria-busy="true"/.test(render(h(FormActions,{dirty:true,loading:true,onDiscard:noop}))),'loading: Save shows its spinner');
 // Discard while the form's own Save (loading) or another request of the form (busy) runs: the neutral
 // kit.changeSaving, true for both, not kit.busy ("Another change …"), which keeps its text for the other callers.
 for(const locale of ['en','de'])for(const state of ['busy','loading']){
  const html=renderToStaticMarkup(h(LocaleProvider,{locale},h(FormActions,{dirty:true,[state]:true,onDiscard:noop})));
  const discard=buttons(html).find(button=>button.inner.includes(`<span>${translate(locale,'common.discard')}</span>`));
  ok(discard.blocked&&!discard.disabled&&discard.description===translate(locale,'kit.changeSaving')&&discard.description!==translate(locale,'kit.busy'),`${locale} ${state}: Discard stays focusable (aria-disabled, no native disabled), blocked with kit.changeSaving`);
 }
 check([t('kit.changeSaving'),translate('de','kit.changeSaving'),t('kit.busy')],['Wait until the change is saved.','Warte, bis die Änderung gespeichert ist.','Wait until the other change is saved.'],'the new reason in both catalogs; kit.busy keeps its text');
}

// ---- The Switch report reads the console locale, not the document language ----
{
 // A German console (useLocale 'de') on a page whose document language is English (the real
 // documentLocale falls back to English without a document): the rejection toast is German.
 const realLocale=await import('../../../lib/i18n/locale.ts');
 const {ApiError}=await import('../../../ui/base/http.ts');
 ok(realLocale.documentLocale()==='en','the document language here is English');
 const harness=panelHarness({hooked:['ui/kit/field.tsx'],stubs:{'@/lib/i18n/locale':realLocale}});
 const {Switch:Live}=harness.load('ui/kit/field.tsx');
 let reject;
 const props={label:'Ein',checked:false,onChange:()=>new Promise((_yes,no)=>{reject=no;})};
 let tree=harness.tree(Live,props);await harness.flush();
 harness.find(tree,node=>node.type==='input').props.onChange();tree=harness.tree(Live,props);
 reject(new ApiError('Network error','503','agent.functionUnavailable','apiError.agent.functionUnavailable'));
 await harness.settle();
 check(harness.toasts,['error:'+translate('de','apiError.agent.functionUnavailable')],'the rejection toast is message(error, locale) in the console language (German)');
 ok(translate('de','apiError.agent.functionUnavailable')!==translate('en','apiError.agent.functionUnavailable'),'self-check: the key differs between the languages');
 const source=(await import('node:fs')).readFileSync('ui/kit/field.tsx','utf8');
 ok(/\[locale\]=useLocale\(\)/.test(source)&&source.includes('toast.error(message(end.error,locale))'),'Switch reads useLocale() and calls message(end.error,locale)');
}

console.log(`PASS kit forms (${checks} checks): Select in Field (bound label, hint and error, sm, blocked with its reason and no change), Switch (markup, blocked real state, optimistic change with resolve, false, reject and a second click, the report in the console locale) and the FormActions matrix with kit.changeSaving.`);
