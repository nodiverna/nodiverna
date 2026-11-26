// The kit ConfirmDialog (ui/kit/confirm-dialog.tsx), rendered with React SSR: the question
// title, the Facts lines, the body paragraphs and the children, Cancel on the leading side and the
// confirm verb on the trailing side, the kit danger or primary Btn (never the shadcn button or its
// destructive variant), .sdx-layer on the portal parts, busy and blocked, the first focus and the
// handlers. Then confirmedView with confirmLabel, lines and tone, the console wiring and the CSS. Last, the Drawer
// focus after "Discard changes?" → Discard (drawerReturnTarget, closeFocus with `to`, each start of the question) and
// the firstFocusable comment. No browser, no server.
import {mock} from '../../support/register.mjs';
// Loaded before the hooks of register.mjs, so this is the real package. The mock hands it on
// unchanged, except that the alert dialog renders in place: React's static renderer leaves portals empty.
import * as radix from 'radix-ui';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {buttons} from '../../support/blocked-buttons.mjs';
import {panelHarness} from '../../support/panel-harness.mjs';
mock('radix-ui',{...radix,AlertDialog:{...radix.AlertDialog,Portal:({children})=>children},Dialog:{...radix.Dialog,Portal:({children})=>children}});
const h=React.createElement;
const {ConfirmDialog}=await import('../../../ui/kit/confirm-dialog.tsx');
const {confirmedView}=await import('../../../ui/base/confirmation.ts');
const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const render=(element,locale='en')=>renderToStaticMarkup(h(LocaleProvider,{locale},element));
const read=file=>readFileSync(file,'utf8');
const text=html=>html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
const noop=()=>{};
const tree=(props,locale='en')=>{let built;renderToStaticMarkup(h(LocaleProvider,{locale},h(()=>{built=ConfirmDialog(props);return null;})));return built;};
const walk=node=>!node||typeof node!=='object'?[]:Array.isArray(node)?node.flatMap(walk):[node,...Object.values(node.props??{}).flatMap(value=>typeof value==='object'?walk(value):[])];
const base={open:true,onOpenChange:noop,title:'Remove SRV-01 from the portal?',lines:[{label:'Device',value:'SRV-01'}],body:'Agent access is blocked at once.\n\nTo connect the device again, register it again.',confirmLabel:'Remove device',tone:'danger',onConfirm:noop};

// ---- Danger ----
let html=render(h(ConfirmDialog,base,h('div',{className:'switch-row'},'Uninstall the agent')));
ok(/<div[^>]*class="sdx-layer sdx-confirm-scrim"/.test(html),'the overlay carries .sdx-layer');
ok(/role="alertdialog"[^>]*class="sdx-layer sdx-confirm-dialog sdx-confirm-danger"|class="sdx-layer sdx-confirm-dialog sdx-confirm-danger"[^>]*role="alertdialog"/.test(html),'the content is the alert dialog and carries .sdx-layer');
const order=['Remove SRV-01 from the portal?','<dl class="sdx-facts sdx-confirm-lines">','Agent access is blocked at once.','To connect the device again','switch-row','<footer class="sdx-confirm-foot">'].map(part=>html.indexOf(part));
ok(order.every((index,position)=>index>=0&&(!position||index>order[position-1])),'title, Facts lines, body, children, then the footer');
ok(/<h2[^>]*class="sdx-confirm-title"[^>]*>Remove SRV-01 from the portal\?<\/h2>/.test(html),'the title as AlertDialog.Title');
ok(html.includes('<dt>Device</dt><dd><div class="sdx-confirm-value" tabindex="0" role="group" aria-label="SRV-01">SRV-01</div></dd>'),'the line as a fact; its scroll box is reachable before measurement');
ok(/<div class="sdx-confirm-body"[^>]*><p>Agent access is blocked at once\.<\/p><p>To connect the device again, register it again\.<\/p><\/div>/.test(html),'a blank line splits the body into paragraphs');
// radix links aria-labelledby and aria-describedby after mount; SSR shows the ids it gives Title and Description.
ok(/<h2 id="radix-[^"]+" class="sdx-confirm-title">/.test(html)&&/<div class="sdx-confirm-body" id="radix-[^"]+">/.test(html),'the title is the AlertDialog.Title and the body the AlertDialog.Description');
const footer=buttons(html.slice(html.indexOf('<footer')));
check(footer.map(button=>text(button.inner)),['Cancel','Remove device'],'Cancel first, the confirm verb trailing');
ok(/class="sdx-btn sdx-btn-danger"/.test(footer[1].attributes)&&/class="sdx-btn sdx-btn-secondary"/.test(footer[0].attributes),'the kit danger Btn and a secondary Cancel');
ok(!html.includes('data-slot="button"')&&!html.includes('destructive')&&!html.includes('alert-dialog-action'),'no shadcn button and no destructive variant');
html=render(h(ConfirmDialog,{...base,lines:undefined,body:undefined,cancelLabel:'Keep'}));
ok(!html.includes('sdx-facts')&&!html.includes('sdx-confirm-body')&&!/aria-describedby="radix/.test(html)&&text(html).includes('Keep'),'without lines and body: neither renders, no dangling description, cancelLabel replaces Cancel');
ok(text(render(h(ConfirmDialog,base),'de')).includes('Abbrechen'),'Cancel is common.cancel');

// ---- Default tone, busy, blocked ----
html=render(h(ConfirmDialog,{...base,tone:'default',confirmLabel:'Refresh inventory'}));
ok(/class="sdx-btn sdx-btn-primary"[^>]*>(?:(?!<\/button>).)*Refresh inventory/.test(html)&&!html.includes('sdx-btn-danger'),'tone default: the primary Btn');
html=render(h(ConfirmDialog,{...base,busy:true}));
let [cancel,confirm]=buttons(html.slice(html.indexOf('<footer')));
ok(/aria-busy="true"/.test(confirm.attributes)&&confirm.inner.includes('sdx-spin'),'busy: the confirm button shows its spinner');
ok(!cancel.disabled&&!cancel.blocked,'busy: Cancel stays usable');
html=render(h(ConfirmDialog,{...base,blocked:'Not available for sample devices'}));
[cancel,confirm]=buttons(html.slice(html.indexOf('<footer')));
check([confirm.blocked,confirm.disabled,confirm.description],[true,false,'Not available for sample devices'],'blocked: focusable, aria-disabled, the reason as its description');

// ---- Handlers and focus ----
{
 let confirmed=0;const changes=[];
 const nodes=walk(tree({...base,onConfirm:()=>confirmed++,onOpenChange:open=>changes.push(open)}));
 const root=nodes.find(node=>node.type===radix.AlertDialog.Root),content=nodes.find(node=>node.type===radix.AlertDialog.Content);
 const cancelButton=nodes.find(node=>node.type===radix.AlertDialog.Cancel).props.children,confirmButton=nodes.find(node=>node.props?.variant==='danger');
 cancelButton.props.onClick?.({preventDefault:noop});
 check(confirmed,0,'Cancel does not confirm');
 confirmButton.props.onClick({preventDefault:noop});
 check(confirmed,1,'the confirm button calls onConfirm');
 root.props.onOpenChange(false);
 check(changes,[false],'Esc and Cancel close through onOpenChange (radix), without onConfirm');check(confirmed,1,'still one confirm');
 ok(typeof content.props.onOpenAutoFocus==='function'&&typeof content.props.onCloseAutoFocus==='function','the content handles the open and the close focus');
 ok(read('ui/kit/confirm-dialog.tsx').includes("onOpenAutoFocus={event=>openFocus(event,returner,tone==='danger'?null:confirmRef.current)}"),'danger passes no confirm button, so radix keeps the first focus on Cancel');
}

// ---- Focus returns to the trigger: the console opens the dialog from state, without a radix Trigger ----
{
 const {openFocus,closeFocus}=await import('../../../ui/kit/confirm-dialog.tsx');
 const {focusReturn}=await import('../../../ui/kit/focus-return.ts');
 const focused=[];
 const body={tag:'body'},doc={body};
 const element=(name,extra={})=>({name,isConnected:true,ownerDocument:doc,focus:options=>focused.push([name,options?.preventScroll??false]),...extra});
 const main=element('main'),header=element('remove-device-button'),menuButton=element('row-menu-button'),cancel=element('cancel');
 const content={contains:node=>node===cancel};
 const event=()=>{const state={prevented:false,preventDefault:()=>{state.prevented=true;}};return state;};
 const saved=globalThis.document;
 globalThis.document={body,activeElement:header,querySelector:selector=>selector==='main[tabindex]'?main:null,querySelectorAll:()=>[]};
 try{
  // Device header: the button has focus when the dialog opens; Esc or Cancel give it back.
  let returner=focusReturn(),opened=event(),closed=event();
  openFocus(opened,returner,null);
  check([opened.prevented,returner.current()?.name],[false,'remove-device-button'],'danger: radix keeps Cancel as first focus, the trigger is remembered');
  globalThis.document.activeElement=cancel;
  closeFocus(closed,returner);
  check([closed.prevented,focused.at(-1)],[true,['remove-device-button',false]],'on close the trigger gets focus back (radix default prevented)');
  // Default tone: the confirm button takes the first focus, the trigger is still the return target.
  returner=focusReturn();opened=event();const confirm=element('confirm');
  globalThis.document.activeElement=header;openFocus(opened,returner,confirm);
  check([opened.prevented,focused.at(-1),returner.current()?.name],[true,['confirm',false],'remove-device-button'],'default: the confirm button is focused first');
  // Row menu: the item is gone when the dialog opens (focus on body); the menu gives focus back to its button afterwards.
  returner=focusReturn();globalThis.document.activeElement=body;
  openFocus(event(),returner,null);
  check(returner.current(),null,'the body is never a return target');
  returner.remember(cancel,content);check(returner.current(),null,'focus inside the dialog is ignored');
  returner.remember(menuButton,content);
  closed=event();closeFocus(closed,returner);
  check([closed.prevented,focused.at(-1)],[true,['row-menu-button',false]],'the row menu button gets focus back');
  // Row menu, in the order the browser runs it: the "…" button is focused, the menu opens and its
 // entry takes focus, choosing "Remove device" opens the dialog while the entry still has focus,
 // then the menu unmounts (the entry is gone) and focus moves into the dialog. Esc or Cancel must
 // land on the "…" button, never on the gone entry or the main fallback.
 {
  const rowButton=element('row-menu-trigger',{id:'radix-menu-trigger-7'});
  const menu={getAttribute:name=>name==='aria-labelledby'?'radix-menu-trigger-7':null};
  const entry=element('remove-entry',{closest:selector=>selector==='[role="menu"]'?menu:null});
  doc.getElementById=id=>id===rowButton.id?rowButton:null;
  globalThis.document.activeElement=rowButton; // 1. the "…" button
  globalThis.document.activeElement=entry; // 2. the menu opened, its entry has focus
  const returner=focusReturn();
  openFocus(event(),returner,null); // 3. the dialog opens from the entry
  check(returner.current()?.name,'row-menu-trigger','a menu entry stands for its menu trigger');
  entry.isConnected=false; // 4. the menu unmounts
  returner.remember(cancel,content); // 5. focus moves into the dialog (ignored)
  returner.remember(entry,content); // a late focusin of the gone entry still resolves to the button
  globalThis.document.activeElement=cancel;
  const closed=event();closeFocus(closed,returner);
  check([closed.prevented,focused.at(-1)],[true,['row-menu-trigger',false]],'Esc or Cancel from the row menu lands on the "…" button');
  // Without aria-labelledby the open menu button (aria-haspopup="menu", aria-expanded="true") stands in.
  const bare=element('bare-entry',{closest:()=>({getAttribute:()=>null})});
  doc.getElementById=()=>null;doc.querySelector=selector=>selector==='[aria-haspopup="menu"][aria-expanded="true"]'?rowButton:null;
  const other=focusReturn();other.remember(bare,content);
  check(other.current()?.name,'row-menu-trigger','fallback: the expanded menu button');
  doc.querySelector=()=>null;
  const none=focusReturn();none.remember(bare,content);
  check(none.current(),null,'a menu entry without a findable trigger is not kept (the gone entry would only fall back to main)');
  delete doc.getElementById;delete doc.querySelector;
 }
 // The trigger is gone (the row was removed): the console's main region takes focus.
  returner=focusReturn();globalThis.document.activeElement=header;openFocus(event(),returner,null);
  header.isConnected=false;
  closed=event();closeFocus(closed,returner);
  check([closed.prevented,focused.at(-1)],[true,['main',true]],'fallback: main[tabindex] without scrolling');
  // Nothing at all: radix keeps its default.
  globalThis.document.querySelector=()=>null;
  returner=focusReturn();closed=event();closeFocus(closed,returner);
  check(closed.prevented,false,'without a target and a fallback the radix default stays');
  // A step-up Dialog over an open Drawer: the submit button that opened it was busy (disabled), so
  // nothing was remembered. Cancel gives focus to the Drawer's first field, not to main behind it.
  const nameField=element('drawer-name-input'),drawerClose=element('drawer-close');
  const drawer={querySelector:selector=>selector.startsWith(':is(input, select, textarea)')?nameField:drawerClose};
  const layerSelectors=[];
  globalThis.document.querySelector=selector=>selector==='main[tabindex]'?main:null;
  globalThis.document.querySelectorAll=selector=>{layerSelectors.push(selector);return [drawer];};
  returner=focusReturn();globalThis.document.activeElement=body;openFocus(event(),returner,null);
  closed=event();closeFocus(closed,returner);
  check([closed.prevented,focused.at(-1)],[true,['drawer-name-input',true]],'nothing remembered under an open Drawer: its first field takes focus, not main');
  check(layerSelectors.at(-1),'.sdx-layer:is([role="dialog"], [role="alertdialog"])[data-state="open"]:not(.sdx-drawer-nonmodal)','the open modal kit layers (drawers and dialogs, not the non-modal drawer) are the candidates');
  const lower={querySelector:()=>null,name:'lower'},upper={querySelector:selector=>selector.startsWith(':is(input, select, textarea)')?null:drawerClose};
  globalThis.document.querySelectorAll=()=>[lower,upper];
  returner=focusReturn();closed=event();closeFocus(closed,returner);
  check(focused.at(-1),['drawer-close',true],'the topmost open layer wins (the last one in document order); without a field its first button');
  const gone=element('gone-trigger');returner=focusReturn();returner.remember(gone);gone.isConnected=false;
  globalThis.document.querySelectorAll=()=>[drawer];closed=event();closeFocus(closed,returner);
  check(focused.at(-1),['drawer-name-input',true],'a remembered trigger that is gone also gives way to the open layer');
  const live=element('live-trigger');returner=focusReturn();returner.remember(live);closed=event();closeFocus(closed,returner);
  check(focused.at(-1),['live-trigger',false],'a remembered trigger that is still there keeps priority over the layer');
  globalThis.document.querySelectorAll=()=>[];returner=focusReturn();closed=event();closeFocus(closed,returner);
  check(focused.at(-1),['main',true],'no open layer: main as before');
  // The non-modal drawer (assistant, Help) stays open beside the page. It matches the layer roles and
  // data-state="open", so the fake answers the selector like a browser: it drops the drawer only when the
  // selector excludes .sdx-drawer-nonmodal. A page dialog closing with its trigger gone lands on main, not in it.
  const {openLayer}=await import('../../../ui/kit/confirm-dialog.tsx');
  const layer=(name,classes,first)=>({name,classes,querySelector:selector=>selector.startsWith(':is(input, select, textarea)')?first:null});
  const assistantField=element('assistant-input'),modalField=element('modal-drawer-input');
  const assistant=layer('assistant',['sdx-layer','sdx-drawer','sdx-drawer-nonmodal'],assistantField),modalDrawer=layer('modal-drawer',['sdx-layer','sdx-drawer'],modalField);
  const browser=open=>selector=>open.filter(item=>!(selector.includes(':not(.sdx-drawer-nonmodal)')&&item.classes.includes('sdx-drawer-nonmodal')));
  globalThis.document.querySelectorAll=browser([assistant]);
  check(openLayer(),null,'openLayer: with only the non-modal drawer open there is no layer');
  returner=focusReturn();closed=event();closeFocus(closed,returner);
  check([closed.prevented,focused.at(-1)],[true,['main',true]],'nothing remembered, only the non-modal drawer open: main takes focus, not the assistant');
  const away=element('away-trigger');returner=focusReturn();returner.remember(away);away.isConnected=false;closed=event();closeFocus(closed,returner);
  check(focused.at(-1),['main',true],'a remembered trigger that is gone: main as well, never the assistant field');
  for(const open of [[assistant,modalDrawer],[modalDrawer,assistant]]){
   globalThis.document.querySelectorAll=browser(open);
   check(openLayer()?.name,'modal-drawer',`openLayer: a modal drawer beside the non-modal one is the layer (${open.map(item=>item.name).join(' then ')})`);
   returner=focusReturn();closed=event();closeFocus(closed,returner);
   check(focused.at(-1),['modal-drawer-input',true],`the modal layer below still takes focus (${open.map(item=>item.name).join(' then ')})`);
  }
  const dialogLayer=layer('dialog',['sdx-layer'],null);
  globalThis.document.querySelectorAll=browser([assistant,dialogLayer]);
  check(openLayer()?.name,'dialog','openLayer: an open dialog beside the non-modal drawer is the layer');
  globalThis.document.querySelectorAll=()=>[];
 }finally{globalThis.document=saved;}
 const source=read('ui/kit/confirm-dialog.tsx');
 ok(/document\.addEventListener\('focusin',remember,true\)/.test(source)&&/returner\.remember\(event\.target,contentRef\.current\)/.test(source),'while open, focus that lands outside the dialog (the menu button) becomes the return target');
 ok(source.includes('ref={contentRef}')&&source.includes('onCloseAutoFocus={event=>closeFocus(event,returner)}'),'the content is wired to the helpers');
}

// ---- confirmedView ----
{
 const removal={title:'Remove SRV-01?',description:'D',confirmLabel:'Remove device',tone:'danger',lines:[{label:'Device',value:'SRV-01'}],payload:{action:'remove-server',id:'s1',confirm:true},uninstall:{available:true,checked:true,hint:'H',title:'Uninstall and remove SRV-01?',description:'U',confirmLabel:'Uninstall and remove'}};
 check(confirmedView(removal,false),{title:'Remove SRV-01?',description:'D',confirmLabel:'Remove device',lines:removal.lines,tone:'danger',payload:{...removal.payload,uninstall:false}},'switch off: the plain verb, lines and tone');
 check(confirmedView(removal,true).confirmLabel,'Uninstall and remove','switch on: the uninstall label');
 check(confirmedView({...removal,uninstall:{...removal.uninstall,available:false}},true).confirmLabel,'Remove device','an unavailable switch keeps the plain verb');
 const plain={title:'Cancel the job?',description:'D',payload:{action:'cancel-job',id:'j'}};
 check([confirmedView(plain,false).confirmLabel,confirmedView(plain,false).tone,confirmedView(plain,false).payload],[undefined,undefined,plain.payload],'a confirmation without a verb: the console falls back to common.confirm');
}

// ---- Console wiring and CSS ----
{
 const consoleSource=read('ui/shell/console.tsx');
 ok(!consoleSource.includes('@/components/ui/alert-dialog')&&!/<AlertDialog\b/.test(consoleSource),'console.tsx no longer uses the shadcn AlertDialog');
 ok(consoleSource.includes("confirmLabel={confirmed?.confirmLabel??''}")&&!consoleSource.includes("t('common.confirm')"),'every Confirmation names its verb: no fallback to common.confirm');
 ok(/export type Confirmation=\{[^}]*\bconfirmLabel:string;/.test(readFileSync('ui/base/confirmation.ts','utf8')),'Confirmation.confirmLabel is required, so tsc checks every caller');
 ok(consoleSource.includes("tone={confirmed?.tone??(removalPending?'danger':'default')}")&&consoleSource.includes('removalPending=isDeviceRemovalAction(confirmation?.payload.action)'),'danger for removals unless the confirmation names a tone');
 ok(consoleSource.includes("blocked={demo?t('kit.unavailable.demo'):removalPending&&!canOffboard?t('console.removal.ownerOnly'):undefined}")&&consoleSource.includes('busy={saving}'),'blocked in demo mode and without the Owner right, busy while saving');
 ok(consoleSource.includes('<ConfirmDialog open={!!confirmation&&!mfaOpen}'),'the step-up dialog hides it');
 const css=read('ui/styles/console.css'),rule=css.match(/\.sdx-confirm-dialog \{[^}]+\}/)[0];
 for(const part of ['width: min(480px, calc(100vw - 32px))','max-height: calc(100dvh - 32px)','border-radius: var(--sd-radius-lg)','background: var(--sd-glass-strong)','box-shadow: var(--sd-shadow-lg)','animation: sdx-rise var(--sd-dur) var(--sd-ease-out)'])ok(rule.includes(part),`.sdx-confirm-dialog: ${part}`);
 ok(/\.sdx-confirm-foot \{ display: flex; flex-wrap: wrap-reverse; justify-content: flex-end;/.test(css),'the footer buttons stack with the confirm button on top when they do not fit');
 ok(/\.sdx-confirm-value \{ max-height: 160px; overflow-y: auto;/.test(css),'a long device list scrolls inside its 160px box');
}

// ---- Dialog: the plain centred base ----
{
 const {Dialog}=await import('../../../ui/kit/confirm-dialog.tsx');
 let html=render(h(Dialog,{open:true,onOpenChange:noop,title:'Confirm your identity',description:'Enter the code from your authenticator.',className:'sdx-stepup',footer:h('button',{type:'button'},'Cancel')},h('p',{className:'body'},'Code field')));
 ok(/<div[^>]*class="sdx-layer sdx-confirm-scrim"/.test(html),'the scrim of ConfirmDialog');
 const content=html.match(/<div[^>]*role="dialog"[^>]*>/)?.[0]??'';
 ok(/class="sdx-layer sdx-confirm-dialog sdx-stepup"/.test(content),'role="dialog" with the glass surface and className');
 ok(/<h2 id="radix-[^"]+" class="sdx-confirm-title">Confirm your identity<\/h2><p id="radix-[^"]+" class="sdx-confirm-body">Enter the code from your authenticator\.<\/p><p class="body">Code field<\/p><footer class="sdx-confirm-foot"><button type="button">Cancel<\/button><\/footer>/.test(html),'title, description, children, then the footer');
 html=render(h(Dialog,{open:true,onOpenChange:noop,title:'Only a title'}));
 ok(!html.includes('sdx-confirm-body')&&!/aria-describedby="radix/.test(html)&&!html.includes('<footer'),'without description: no description and no dangling aria-describedby; no footer');
 let built;renderToStaticMarkup(h(LocaleProvider,{locale:'en'},h(()=>{built=Dialog({open:true,onOpenChange:value=>changes.push(value),title:'T'});return null;})));
 const changes=[];const nodes=walk(built);
 nodes.find(node=>node.type===radix.Dialog.Root).props.onOpenChange(false);
 check(changes,[false],'Esc and the scrim close through onOpenChange (radix)');
 const dialogContent=nodes.find(node=>node.type===radix.Dialog.Content);
 ok(typeof dialogContent.props.onOpenAutoFocus==='function'&&typeof dialogContent.props.onCloseAutoFocus==='function'&&read('ui/kit/confirm-dialog.tsx').includes('onOpenAutoFocus={event=>openFocus(event,returner,null)} onCloseAutoFocus={event=>closeFocus(event,returner)}'),'focus goes back to the element that had it (openFocus/closeFocus with focusReturn)');
 const mfa=read('ui/session/mfa-step-up.tsx');
 ok(!/function StepUpDialog/.test(mfa)&&/<Dialog open=\{open\}/.test(mfa)&&mfa.includes('className="sdx-stepup"'),'MfaStepUp uses the kit Dialog, no local StepUpDialog');
}

// ---- Dialog variant="search" with a hidden title (the command palette frame, slice 14) ----
{
 const {Dialog}=await import('../../../ui/kit/confirm-dialog.tsx');
 const html=render(h(Dialog,{open:true,onOpenChange:noop,title:'Search and jump',hideTitle:true,variant:'search'},h('div',{className:'sd-palette'},'Field')));
 const content=html.match(/<div[^>]*role="dialog"[^>]*>/)?.[0]??'';
 ok(/class="sdx-layer sdx-confirm-dialog sdx-dialog-search"/.test(content),'the search variant adds sdx-dialog-search to the kit surface');
 ok(/<h2 id="radix-[^"]+" class="sr-only">Search and jump<\/h2><div class="sd-palette">Field<\/div>/.test(html),'the hidden title is still the Dialog.Title (it names the dialog), then the children; no foot');
 ok(/class="sdx-layer sdx-confirm-dialog"/.test(render(h(Dialog,{open:true,onOpenChange:noop,title:'T'})).match(/<div[^>]*role="dialog"[^>]*>/)[0])&&render(h(Dialog,{open:true,onOpenChange:noop,title:'T'})).includes('class="sdx-confirm-title">T</h2>'),'the default variant and a shown title stay as before');
 const css=read('ui/styles/console.css'),rule=css.match(/\.sdx-confirm-dialog\.sdx-dialog-search \{[^}]+\}/)?.[0]??'';
 // Edge to edge: no gap, and no padding beyond the 1px edge. The edge is drawn by the glass layer (::before), so the
 // surface has no border and a 1px padding in its place: the content sits exactly inside the edge, as with padding 0 and a 1px border.
 for(const part of ['gap: 0','width: min(640px, calc(100vw - 24px))','margin: min(14vh, 120px) auto auto','padding: 1px; border: 0;'])ok(rule.includes(part),`the search variant: ${part}`);
 const palette=read('ui/shell/command-palette.css');
 ok(!/\.sdx-confirm-dialog|\.sd-palette \{[^}]*(position|top|width|border|background|shadow|animation)/.test(palette),'the palette CSS does not restyle the dialog surface');
 // Focus returns through openFocus/closeFocus like every kit Dialog (checked above for the plain base).
 ok(read('ui/kit/confirm-dialog.tsx').includes("className={hideTitle?'sr-only':'sdx-confirm-title'}"),'hideTitle keeps the title as sr-only text');
}

// ---- Drawer: dirty asks before a user close; DrawerCancel; modal={false} ----
{
 const harness=panelHarness({hooked:['ui/kit/kit.tsx'],locale:'en'});
 const kit=harness.load('ui/kit/kit.tsx');
 const closes=[];
 const props=extra=>({open:true,onClose:()=>closes.push('close'),title:'Create group',children:'Body',...extra});
 const root=tree=>harness.find(tree,node=>node.props&&'modal' in node.props&&typeof node.props.onOpenChange==='function'&&node.props.open!==undefined&&!('confirmLabel' in node.props));
 const question=tree=>harness.find(tree,node=>'confirmLabel' in node.props&&'cancelLabel' in node.props);
 // Without dirty, a close runs at once.
 harness.reset();closes.length=0;
 let tree=harness.tree(kit.Drawer,props());
 root(tree).props.onOpenChange(false);
 check(closes,['close'],'without dirty: Esc, the scrim and the close button close at once');
 // With dirty: the question first.
 harness.reset();closes.length=0;
 tree=harness.tree(kit.Drawer,props({dirty:true}));
 check(question(tree).props.open,false,'dirty: no question before a close');
 root(tree).props.onOpenChange(false);
 tree=harness.tree(kit.Drawer,props({dirty:true}));
 const asked=question(tree).props;
 check([closes,asked.open,asked.tone,asked.title,asked.body,asked.confirmLabel,asked.cancelLabel],[[],true,'danger','Discard changes?','Nodiverna does not save what you entered in this form.','Discard','Keep editing'],'dirty: onClose waits; the danger question kit.discard.* with Discard and Keep editing');
 asked.onOpenChange(false);tree=harness.tree(kit.Drawer,props({dirty:true}));
 check([closes,question(tree).props.open],[[],false],'Keep editing: the drawer and its input stay');
 root(tree).props.onOpenChange(false);tree=harness.tree(kit.Drawer,props({dirty:true}));
 question(tree).props.onConfirm();tree=harness.tree(kit.Drawer,props({dirty:true}));
 check([closes,question(tree).props.open],[['close'],false],'Discard: onClose');
 // DrawerCancel and the head close button take the same guarded path (the provider's value).
 harness.reset();closes.length=0;
 tree=harness.tree(kit.Drawer,props({dirty:true}));
 const provider=harness.find(tree,node=>typeof node.props?.value==='function');
 provider.props.value();tree=harness.tree(kit.Drawer,props({dirty:true}));
 check([closes,question(tree).props.open],[[],true],'DrawerCancel (the guarded close of the provider) asks too');
 // The caller closes after a successful submit: no question.
 tree=harness.tree(kit.Drawer,props({dirty:true,open:false}));
 check([question(tree).props.open,closes],[false,[]],'open={false} from the caller closes without the question');
 const source=read('ui/kit/kit.tsx');
 ok(source.includes('<DialogPrimitive.Root open={open} onOpenChange={next=>{if(!next)request();}} modal={modal}>')&&source.includes('<DialogPrimitive.Close asChild>'),'Esc, the scrim and the head close button go through request()');
 // DrawerCancel rendered inside a Drawer: a secondary Btn labelled common.cancel, usable while busy.
 const {Drawer,DrawerCancel}=await import('../../../ui/kit/kit.tsx');
 let html=render(h(Drawer,{open:true,onClose:noop,title:'Add mapping',footer:h(React.Fragment,null,h(DrawerCancel),h(DrawerCancel,{label:'Close'}))},'Body'));
 const foot=buttons(html.slice(html.indexOf('<footer class="sdx-drawer-foot">')));
 check(foot.map(button=>[text(button.inner),/sdx-btn-secondary/.test(button.attributes),button.blocked,button.disabled]),[['Cancel',true,false,false],['Close',true,false,false]],'DrawerCancel: secondary, common.cancel (or its label), never blocked');
 ok(!/busy/.test(source.slice(source.indexOf('export function DrawerCancel'),source.indexOf('// ---- Settings page'))),'DrawerCancel takes no busy prop');
 ok(/<div[^>]*class="sdx-layer sdx-drawer-scrim"/.test(html),'modal by default: the scrim');
 // modal={false}: no scrim, outside clicks do not close, Esc only with focus inside.
 html=render(h(Drawer,{open:true,onClose:noop,title:'Help',modal:false},'Body'));
 ok(!html.includes('sdx-drawer-scrim')&&/class="sdx-layer sdx-drawer sdx-drawer-nonmodal"/.test(html),'modal={false}: no .sdx-drawer-scrim');
 harness.reset();
 tree=harness.tree(kit.Drawer,props({modal:false}));
 check(root(tree).props.modal,false,'the radix dialog is not modal: no focus trap, the page stays usable');
 const content=harness.find(tree,node=>typeof node.props?.onInteractOutside==='function');
 const outside={prevented:false,preventDefault(){outside.prevented=true;}};content.props.onInteractOutside(outside);
 ok(outside.prevented,'an outside click does not close it');
 const saved=globalThis.document;
 try{
  const away={};
  globalThis.document={activeElement:away};
  const escape=()=>{const event={prevented:false,preventDefault(){event.prevented=true;}};content.props.onEscapeKeyDown(event);return event.prevented;};
  check(escape(),true,'Esc with focus outside the drawer does not close it');
  // On close: focus that moved on into the page (or into the next drawer) stays; else it goes to returnFocus (slice 14).
  const returned=[],opener={isConnected:true,focus:()=>returned.push('opener')};
  harness.reset();
  const closing=harness.find(harness.tree(kit.Drawer,props({modal:false,returnFocus:{current:opener}})),node=>typeof node.props?.onCloseAutoFocus==='function');
  const body={},closeEvent=()=>{const event={prevented:false,preventDefault(){event.prevented=true;}};return event;};
  globalThis.document={activeElement:away,body};
  let event=closeEvent();closing.props.onCloseAutoFocus(event);
  check([event.prevented,returned],[true,[]],'focus in the page next to the closed drawer stays there');
  globalThis.document={activeElement:body,body};
  event=closeEvent();closing.props.onCloseAutoFocus(event);
  check([event.prevented,returned],[true,['opener']],'focus that was inside goes back to returnFocus');
  ok(read('ui/kit/kit.tsx').includes('const target=drawerReturnTarget(returnFocus?.current,opener.current);')&&/useLayoutEffect\(\(\)=>\{\s*if\(!open\|\|typeof document==='undefined'\)return;\s*const active=document\.activeElement/.test(read('ui/kit/kit.tsx')),'without returnFocus the element focused when the drawer opened (Help after F1 or its button) gets focus back');
 }finally{globalThis.document=saved;}
 // Keep editing returns focus into the drawer, also after a scrim click took it away (focusWithin).
 ok(source.includes('focusWithin={open?content:undefined}'),'the discard question keeps the return focus inside the open drawer');
 {
  const {closeFocus,firstFocusable}=await import('../../../ui/kit/confirm-dialog.tsx');
  const {focusReturn}=await import('../../../ui/kit/focus-return.ts');
  const focused=[];
  const control=(name,inside)=>({name,inside,isConnected:true,focus:()=>focused.push(name)});
  const field=control('name-input',true),closeButton=control('head-close',true),main=control('main',false);
  const drawer={name:'drawer',focus:()=>focused.push('drawer'),contains:node=>!!node?.inside,querySelector:selector=>selector.startsWith(':is(input, select, textarea)')?field:closeButton};
  const event=()=>{const value={prevented:false,preventDefault(){value.prevented=true;}};return value;};
  const savedDocument=globalThis.document;
  globalThis.document={body:{},querySelector:()=>main,querySelectorAll:()=>[]};
  try{
   let returner=focusReturn(),closed=event();
   closeFocus(closed,returner,drawer);
   check([closed.prevented,focused.at(-1)],[true,'name-input'],'scrim click (nothing remembered): focus goes to the first field of the drawer, not main');
   returner=focusReturn();returner.remember(main);closed=event();closeFocus(closed,returner,drawer);
   check([closed.prevented,focused.at(-1),returner.current()],[true,'name-input',null],'a remembered element outside the drawer gives way to the drawer');
   returner=focusReturn();returner.remember(closeButton);closed=event();closeFocus(closed,returner,drawer);
   check([closed.prevented,focused.at(-1)],[true,'head-close'],'Esc or the close button: focus goes back to that control inside the drawer');
   returner=focusReturn();closed=event();closeFocus(closed,returner,null);
   check([closed.prevented,focused.at(-1)],[true,'main'],'without a container: the console main region as before');
   const empty={querySelector:()=>null};
   check(firstFocusable(empty),empty,'a container without controls takes the focus itself');
  }finally{globalThis.document=savedDocument;}
 }
 ok(source.includes("onEscapeKeyDown:(event:Event)=>{if(!content.current?.contains(document.activeElement))event.preventDefault();}")&&source.includes('onCloseAutoFocus={closeFocus}'),'Esc closes while focus is inside; focus goes back to returnFocus on close');
}

// ---- firstFocusable keeps aria-disabled controls on purpose ----
{
 const source=read('ui/kit/confirm-dialog.tsx');
 const comment=source.slice(source.lastIndexOf('/**',source.indexOf('export function firstFocusable')),source.indexOf('export function firstFocusable'));
 ok(/native disabled/.test(comment)&&/aria-disabled/.test(comment)&&/on purpose/.test(comment),'the comment above firstFocusable: only native disabled is skipped, aria-disabled (blocked) controls are kept on purpose');
}

// ---- Focus after "Discard changes?" → Discard closes a dirty Drawer ----
{
 const {closeFocus,drawerReturnTarget}=await import('../../../ui/kit/confirm-dialog.tsx');
 const {focusReturn}=await import('../../../ui/kit/focus-return.ts');
 const focused=[];
 const body={name:'body',focus:()=>focused.push('body')};
 const doc={body,getElementById:id=>id==='tree-menu-trigger'?menuButton:null,querySelector:()=>null};
 const element=(name,extra={})=>({name,isConnected:true,ownerDocument:doc,closest:()=>null,focus:()=>focused.push(name),...extra});
 const main=element('main'),opener=element('create-group-button'),returnButton=element('return-focus'),menuButton=element('tree-menu-trigger');
 const menuEntry=element('create-group-entry',{closest:selector=>selector==='[role="menu"]'?{getAttribute:name=>name==='aria-labelledby'?'tree-menu-trigger':null}:null});
 const layerField=element('layer-field'),layer={name:'lower-drawer',querySelector:selector=>selector.startsWith(':is(input, select, textarea)')?layerField:null};
 const inside=element('drawer-name-input');
 const event=()=>{const value={prevented:false,preventDefault(){value.prevented=true;}};return value;};
 const savedDocument=globalThis.document;
 let layers=[];
 const fakeDocument=active=>({body,activeElement:active,querySelector:selector=>selector==='main[tabindex]'?main:null,querySelectorAll:()=>layers});
 globalThis.document=fakeDocument(body);
 try{
  // The pure return target: returnFocus, else the opener, while connected; else the top open layer; else main; never the body.
  check(drawerReturnTarget(returnButton,opener)?.name,'return-focus','returnFocus first');
  check(drawerReturnTarget(null,opener)?.name,'create-group-button','else the element that had focus when the drawer opened');
  check(drawerReturnTarget({...returnButton,isConnected:false},opener)?.name,'create-group-button','a removed returnFocus gives way to the opener');
  const gone={...opener,isConnected:false};
  layers=[layer];check(drawerReturnTarget(null,gone)?.name,'layer-field','a removed opener: the first control of the top open layer (openLayer)');
  layers=[];check(drawerReturnTarget(null,gone)?.name,'main','no open layer: main[tabindex]');
  check(drawerReturnTarget(null,null)?.name,'main','nothing remembered: main[tabindex], never the body');
  // closeFocus with `to` (the question closed with its drawer): to wins over the remembered control inside the drawer.
  let returner=focusReturn();returner.remember(inside);let closed=event();
  closeFocus(closed,returner,null,opener);
  check([closed.prevented,focused.at(-1),returner.current()],[true,'create-group-button',null],'Discard: the question hands focus to the drawer target, not to the control of the closing drawer');
  // With within (the drawer is still open: Keep editing), within wins and to is ignored.
  const drawer={contains:node=>node===inside,focus:()=>focused.push('drawer'),querySelector:()=>inside};
  returner=focusReturn();returner.remember(inside);closed=event();
  closeFocus(closed,returner,drawer,opener);
  check([closed.prevented,focused.at(-1)],[true,'drawer-name-input'],'Keep editing: focus goes back into the drawer as before');

  // The kit Drawer on hook cells, for each start of the question: the close button, Esc and a scrim click (radix
  // onOpenChange(false)) and DrawerCancel (the provider's guarded close).
  const harness=panelHarness({hooked:['ui/kit/kit.tsx'],locale:'en',layoutEffects:true});
  const kit=harness.load('ui/kit/kit.tsx');
  const root=tree=>harness.find(tree,node=>node.props&&'modal' in node.props&&typeof node.props.onOpenChange==='function'&&node.props.open!==undefined&&!('confirmLabel' in node.props));
  const question=tree=>harness.find(tree,node=>'confirmLabel' in node.props&&'cancelLabel' in node.props);
  const content=tree=>harness.find(tree,node=>typeof node.props?.onCloseAutoFocus==='function'&&!('confirmLabel' in node.props));
  const starts={
   'close button':tree=>root(tree).props.onOpenChange(false),
   Esc:tree=>root(tree).props.onOpenChange(false),
   'scrim click':tree=>root(tree).props.onOpenChange(false),
   DrawerCancel:tree=>harness.find(tree,node=>typeof node.props?.value==='function').props.value(),
  };
  const run=async(start,openerElement,extra={})=>{
   harness.reset();let open=true;
   const props=()=>({open,onClose:()=>{open=false;},title:'Create group',dirty:true,children:'Body',...extra});
   globalThis.document=fakeDocument(openerElement);
   let tree=harness.tree(kit.Drawer,props());await harness.flush();
   globalThis.document=fakeDocument(inside);
   starts[start](tree);tree=harness.tree(kit.Drawer,props());
   check(question(tree).props.open,true,`${start}: the question opens`);
   question(tree).props.onConfirm();tree=harness.tree(kit.Drawer,props());
   check([open,question(tree).props.open,question(tree).props.focusWithin],[false,false,undefined],`${start}: Discard closes the question and the drawer in one render`);
   // The question closes first: its control inside the drawer is about to be removed with the drawer.
   const confirmClosed=event(),returnerOfQuestion=focusReturn();returnerOfQuestion.remember(inside);
   closeFocus(confirmClosed,returnerOfQuestion,question(tree).props.focusWithin?.current,question(tree).props.closeFocusTo());
   const afterQuestion=focused.at(-1);
   // Then the drawer content unmounts: focus is where the question put it (outside the drawer), so the drawer keeps it.
   globalThis.document=fakeDocument(afterQuestion==='body'?body:[opener,menuButton,returnButton,layerField,main].find(item=>item.name===afterQuestion));
   const drawerClosed=event();content(tree).props.onCloseAutoFocus(drawerClosed);
   return [afterQuestion,drawerClosed.prevented];
  };
  for(const start of Object.keys(starts)){
   check(await run(start,opener),['create-group-button',true],`${start} → Discard: focus goes to the element that opened the drawer`);
   check(await run(start,menuEntry),['tree-menu-trigger',true],`${start} → Discard, opened from a menu entry ("Create group", "Create subgroup"): focus goes to the menu's trigger`);
   check(await run(start,opener,{returnFocus:{current:returnButton}}),['return-focus',true],`${start} → Discard: returnFocus wins`);
   opener.isConnected=false;
   layers=[layer];check(await run(start,opener),['layer-field',true],`${start} → Discard, opener gone: the top open layer's first control`);
   layers=[];check(await run(start,opener),['main',true],`${start} → Discard, opener gone and no layer: main[tabindex]`);
   opener.isConnected=true;
  }
  ok(!focused.includes('body'),'the focus is never on the body');
  // Without the question (no Discard), the closing drawer itself falls back the same way when its opener is gone.
  harness.reset();
  globalThis.document=fakeDocument({...opener,isConnected:false,closest:()=>null});
  let tree=harness.tree(kit.Drawer,{open:true,onClose:noop,title:'Create group',children:'Body'});await harness.flush();
  tree=harness.tree(kit.Drawer,{open:false,onClose:noop,title:'Create group',children:'Body'});
  globalThis.document=fakeDocument(body);closed=event();content(tree).props.onCloseAutoFocus(closed);
  check([closed.prevented,focused.at(-1)],[true,'main'],'a plain close with the opener gone: main[tabindex], not the body');
  const source=read('ui/kit/kit.tsx');
  ok(source.includes("closeFocusTo={()=>discarded.current?drawerReturnTarget(returnFocus?.current,opener.current):null}")&&source.includes('onConfirm={()=>{discarded.current=true;setAsking(false);onClose();}}'),'the kit Drawer wires Discard to the return target (every dirty drawer gains from it)');
  ok(read('ui/kit/confirm-dialog.tsx').includes('onCloseAutoFocus={event=>closeFocus(event,returner,focusWithin?.current,closeFocusTo?.())}'),'ConfirmDialog passes closeFocusTo to closeFocus');
 }finally{globalThis.document=savedDocument;}
}

console.log(`PASS kit confirm dialog (${checks} checks): question, Facts lines, body paragraphs, children, Cancel then the kit danger or primary verb, .sdx-layer, busy, blocked, handlers and first focus, confirmedView, the console wiring and the glass CSS; the plain Dialog base; the Drawer discard question when dirty, DrawerCancel and modal={false}; the focus after Discard (opener, menu trigger, open layer, main, never the body).`);
